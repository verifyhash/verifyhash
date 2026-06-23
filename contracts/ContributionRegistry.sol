// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  ContributionRegistry
/// @notice Tamper-evident, permissionless, immutable registry of code-contribution hashes.
/// @notice TRUST BOUNDARIES (read before relying on any field):
///         - `contributor` means different things depending on HOW the record was written:
///             * via `anchor()` (one-shot): the first broadcaster, NOT a proven author. Anyone who
///               learns a `contentHash` (e.g. from the mempool) can `anchor` it first. Treat
///               `contributor` as "first anchorer" only — never as authorship.
///             * via `commit()` + `reveal()` (two-step): a FRONT-RUNNING-RESISTANT claim. The
///               committer is bound into the commitment hash before the `contentHash` is ever
///               public, so a copier who lifts the revealed value from the mempool cannot redirect
///               attribution to themselves. For these records `contributor` is the proven first
///               *claimant* of the content. Read `authorBound` to tell the two apart.
///         - `uri` is an UNTRUSTED, unauthenticated hint. The contract never fetches, validates,
///           or derives it. To trust a record, a consumer must independently fetch the content,
///           RE-DERIVE its hash with the same scheme (`vh hash`), and check that the recomputed
///           hash equals the anchored `contentHash`. A matching `contentHash` is the only proof of
///           integrity; the `uri` string itself proves nothing and may point anywhere (or nowhere).
///         - `timestamp`/`blockNumber` prove ON-CHAIN ORDERING and an UPPER BOUND on existence time
///           ("this content existed no later than this block"). They do NOT prove authorship time,
///           when the content was actually created, or a lower bound — and `block.timestamp` is set
///           by the block proposer (validator-influenced, ~seconds of slack), so it is not a
///           trustworthy wall clock. Use it for ordering and "existed by N", not as precise time.
/// @dev    Design choices that the security audit should hold us to:
///         - No owner, no admin, no pause, no upgrade path. There is no privileged key to
///           compromise and nothing to centralize. This is deliberate for a "decentralized
///           organization" — code, not a person, is the authority.
///         - No funds are ever held. `anchor` is non-payable, so any ETH sent to it reverts.
///         - Each content hash can be anchored exactly once (first-writer-wins). A record can
///           never be altered or deleted after it is written. That immutability *is* the product.
///         - Enumeration is index-based (mapping, not array) so no function ever loops over an
///           unbounded set — there is no griefable gas-DoS surface.
contract ContributionRegistry {
    /// @dev Immutable record written by `anchor`. See the contract-level "TRUST BOUNDARIES" notice
    ///      for what each field does and does NOT prove.
    struct Record {
        // The address recorded for this hash. If `authorBound` is false this is just the first
        // broadcaster (anyone who saw the contentHash could have anchored it). If `authorBound` is
        // true it is the proven first *claimant* via commit+reveal — front-running cannot redirect
        // it. See the contract-level "TRUST BOUNDARIES" notice.
        address contributor;
        // True iff this record was written via commit()+reveal(), i.e. the contributor is bound to
        // the content by a prior, sender-committed commitment and is NOT front-runnable. False for
        // one-shot anchor() records, where contributor is merely "first anchorer".
        bool authorBound;
        // block.timestamp at anchor time. Proves an upper bound on existence time ("existed by
        // here") + ordering relative to other records — NOT authorship time, and validator-set
        // within consensus slack, so not a trustworthy wall clock.
        uint64 timestamp;
        // block.number at anchor time. Proves on-chain ordering / "anchored no later than this
        // block". Monotonic and harder to game than timestamp; still not an authorship time.
        uint64 blockNumber;
        // UNTRUSTED off-chain pointer hint (IPFS CID, commit URL, etc.). May be empty. The contract
        // never fetches/validates it; consumers must re-fetch + re-hash and compare to contentHash.
        string uri;
    }

    /// @dev A pending commitment in the commit-reveal attribution flow. Keyed by the commitment
    ///      hash = keccak256(abi.encode(contentHash, committer, salt)). Binding the committer into
    ///      the hash is what defeats front-running: a copier cannot recompute a valid commitment for
    ///      themselves without the salt, and the salt is only revealed in the second transaction —
    ///      by which point the legitimate reveal can land first.
    struct Commitment {
        // The address that registered this commitment. reveal() requires msg.sender == committer.
        address committer;
        // block.number at commit time, used to enforce MIN_REVEAL_DELAY (a reveal cannot occur in
        // the same block as, or too soon after, its commit) so the commitment is firmly buried in
        // history before its preimage is exposed.
        uint64 blockNumber;
    }

    /// @dev contentHash => immutable Record. A zero `contributor` means "not anchored".
    mapping(bytes32 => Record) private _records;
    /// @dev insertion index => contentHash, for enumeration without unbounded storage scans.
    mapping(uint256 => bytes32) private _hashByIndex;
    /// @dev commitment hash => pending Commitment for the commit-reveal attribution flow. Cleared on
    ///      a successful reveal so a commitment is single-use.
    mapping(bytes32 => Commitment) private _commitments;

    /// @notice Total number of distinct content hashes anchored.
    uint256 public total;

    /// @notice Minimum number of blocks that must pass between commit() and reveal(). A reveal is
    ///         only accepted once `block.number > commit.blockNumber + MIN_REVEAL_DELAY`, i.e. the
    ///         commitment is buried by at least this many blocks before its preimage is exposed.
    ///         This guarantees the sender-bound commitment is already in the chain's history before
    ///         the contentHash becomes public, so it cannot be raced by a same-block copier.
    uint64 public constant MIN_REVEAL_DELAY = 1;

    /// @notice Emitted once per successful anchor. Mirrors the stored Record; same trust caveats.
    /// @param  contentHash the 32-byte digest that was anchored.
    /// @param  contributor the FIRST anchorer (msg.sender), NOT a proven author.
    /// @param  index       insertion index assigned to this hash.
    /// @param  timestamp   block.timestamp at anchor time: upper bound on existence time + ordering,
    ///                     NOT authorship time and validator-influenced (not a trustworthy clock).
    /// @param  uri         UNTRUSTED off-chain pointer hint; never validated. Re-fetch + re-hash.
    event Anchored(
        bytes32 indexed contentHash,
        address indexed contributor,
        uint256 indexed index,
        uint64 timestamp,
        string uri
    );

    /// @notice Emitted by commit() when a front-running-resistant commitment is registered.
    /// @param  commitment  keccak256(abi.encode(contentHash, committer, salt)). Reveals nothing about
    ///                     the contentHash being claimed (it is blinded by committer + salt).
    /// @param  committer   the address bound into the commitment; only it may reveal.
    /// @param  blockNumber block.number at commit time (start of the MIN_REVEAL_DELAY window).
    event Committed(bytes32 indexed commitment, address indexed committer, uint64 blockNumber);

    /// @notice Emitted by reveal() when a committed contentHash is anchored with bound attribution.
    ///         Distinguished from Anchored so indexers can tell a front-running-resistant claim
    ///         (authorBound = true) from a one-shot anchor.
    /// @param  contentHash the digest that was claimed.
    /// @param  contributor the proven first claimant (== the committer). NOT front-runnable.
    /// @param  index       insertion index assigned to this hash.
    /// @param  commitment  the commitment hash that was opened to produce this record.
    /// @param  timestamp   block.timestamp at reveal time (see Anchored caveats).
    /// @param  uri         UNTRUSTED off-chain pointer hint; never validated. Re-fetch + re-hash.
    event Revealed(
        bytes32 indexed contentHash,
        address indexed contributor,
        uint256 indexed index,
        bytes32 commitment,
        uint64 timestamp,
        string uri
    );

    error ZeroHash();
    error AlreadyAnchored(bytes32 contentHash, address contributor);
    error NotAnchored(bytes32 contentHash);
    error IndexOutOfRange(uint256 index, uint256 total);
    error ZeroCommitment();
    error CommitmentExists(bytes32 commitment, address committer);
    error NoSuchCommitment(bytes32 commitment);
    error RevealTooSoon(uint64 commitBlock, uint64 currentBlock, uint64 minDelay);

    /// @notice One-shot anchor of a contribution's content hash. First writer wins; immutable after.
    /// @dev    FRONT-RUNNABLE BY DESIGN. Because `contentHash` is sent in the clear, anyone watching
    ///         the mempool can copy it and `anchor` it first, becoming the recorded `contributor`.
    ///         The resulting record therefore has `authorBound = false`: `contributor` is only the
    ///         "first anchorer", never a proven author. Use this when you just need a cheap,
    ///         single-transaction timestamp / existence proof and DO NOT care who is attributed.
    ///         To make a front-running-resistant authorship claim, use `commit()` then `reveal()`.
    ///         `uri` is stored verbatim and is an UNTRUSTED hint (never fetched/validated/hashed);
    ///         the only integrity guarantee is `contentHash` itself — consumers re-derive and
    ///         re-hash the content and compare. See the contract-level "TRUST BOUNDARIES" notice.
    /// @param  contentHash keccak256 (or any 32-byte digest) of the contribution's content.
    /// @param  uri optional, UNTRUSTED off-chain pointer hint (IPFS CID, commit URL, etc.). May be
    ///         empty. Stored as-is; proves nothing on its own. To trust a record, fetch the content
    ///         this uri claims to point at, re-derive its hash, and require it to equal contentHash.
    /// @return index the insertion index assigned to this hash.
    function anchor(bytes32 contentHash, string calldata uri) external returns (uint256 index) {
        return _record(contentHash, msg.sender, uri, false);
    }

    /// @notice Step 1 of the front-running-resistant attribution flow: register a blinded commitment
    ///         to a contentHash you intend to claim, WITHOUT revealing the contentHash itself.
    /// @dev    Off-chain, the claimer picks a random 32-byte `salt`, keeps it secret, and computes
    ///         `commitment = commitmentOf(contentHash, msg.sender, salt)`. Only this opaque hash goes
    ///         on-chain. A mempool watcher sees a commitment that is blinded by both the committer's
    ///         address and the secret salt: it leaks nothing about the contentHash, and it is bound
    ///         to THIS sender, so the watcher cannot reuse it to attribute the content to themselves.
    ///         After at least `MIN_REVEAL_DELAY` blocks, the committer calls `reveal()`.
    ///         A given commitment hash can be registered only once until it is opened by `reveal()`.
    /// @param  commitment keccak256(abi.encode(contentHash, committer, salt)); see `commitmentOf`.
    function commit(bytes32 commitment) external {
        if (commitment == bytes32(0)) revert ZeroCommitment();
        Commitment storage existing = _commitments[commitment];
        if (existing.committer != address(0)) {
            revert CommitmentExists(commitment, existing.committer);
        }
        _commitments[commitment] = Commitment({
            committer: msg.sender,
            blockNumber: uint64(block.number)
        });
        emit Committed(commitment, msg.sender, uint64(block.number));
    }

    /// @notice Step 2 of the front-running-resistant attribution flow: open a prior commitment and
    ///         anchor the contentHash with `contributor == msg.sender` and `authorBound == true`.
    /// @dev    SECURITY — why a front-runner cannot steal attribution here:
    ///         The commitment opened is recomputed from `(contentHash, msg.sender, salt)`. An
    ///         attacker who copies this reveal transaction out of the mempool and resubmits it as
    ///         their own would recompute `keccak256(abi.encode(contentHash, ATTACKER, salt))`, which
    ///         is a DIFFERENT commitment hash that the attacker never registered — so `reveal` fails
    ///         with `NoSuchCommitment`. The attacker also cannot register that attacker-bound
    ///         commitment now and reveal it later to beat the victim, because `MIN_REVEAL_DELAY`
    ///         forces any commitment to age at least one block before it can be opened, and the
    ///         victim's reveal (whose commitment is already buried) lands first and takes the
    ///         contentHash under first-writer-wins. Thus the recorded `contributor` is the original
    ///         committer, not the copier.
    /// @param  contentHash the digest being claimed (must be non-zero and not already anchored).
    /// @param  salt        the secret 32-byte value used to build the commitment.
    /// @param  uri         optional, UNTRUSTED off-chain pointer hint (same caveats as `anchor`).
    /// @return index the insertion index assigned to this hash.
    function reveal(bytes32 contentHash, bytes32 salt, string calldata uri)
        external
        returns (uint256 index)
    {
        if (contentHash == bytes32(0)) revert ZeroHash();

        bytes32 commitment = commitmentOf(contentHash, msg.sender, salt);
        Commitment storage c = _commitments[commitment];
        // A zero committer means either no such commitment was ever made by this sender for this
        // (contentHash, salt), or it was already opened. Either way there is nothing to reveal.
        if (c.committer == address(0)) revert NoSuchCommitment(commitment);

        // Enforce the maturation window: the commitment must have aged in the chain before its
        // preimage is exposed, so it cannot be raced within the same/adjacent block.
        uint64 current = uint64(block.number);
        if (current <= c.blockNumber + MIN_REVEAL_DELAY) {
            revert RevealTooSoon(c.blockNumber, current, MIN_REVEAL_DELAY);
        }

        // Single-use: clear the commitment before writing the record (also frees the storage slot).
        delete _commitments[commitment];

        index = _record(contentHash, msg.sender, uri, true);
        emit Revealed(contentHash, msg.sender, index, commitment, uint64(block.timestamp), uri);
    }

    /// @notice The commitment hash for the commit-reveal flow. Pure helper so off-chain code and the
    ///         contract agree byte-for-byte on the construction.
    /// @dev    Uses `abi.encode` (fixed 32-byte fields, no packing ambiguity) over the tuple
    ///         (contentHash, committer, salt). Binding `committer` is what makes a stolen reveal
    ///         resolve to a different, never-registered commitment.
    /// @param  contentHash the digest to be claimed.
    /// @param  committer   the address that will reveal (must equal the eventual msg.sender).
    /// @param  salt        a secret random 32-byte value kept off-chain until reveal.
    function commitmentOf(bytes32 contentHash, address committer, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(contentHash, committer, salt));
    }

    /// @dev Shared writer for both `anchor` (authorBound=false) and `reveal` (authorBound=true).
    ///      Enforces non-zero hash + first-writer-wins, appends to the index, and emits Anchored.
    function _record(bytes32 contentHash, address contributor, string calldata uri, bool authorBound)
        private
        returns (uint256 index)
    {
        if (contentHash == bytes32(0)) revert ZeroHash();

        Record storage existing = _records[contentHash];
        if (existing.contributor != address(0)) {
            revert AlreadyAnchored(contentHash, existing.contributor);
        }

        index = total;
        _records[contentHash] = Record({
            contributor: contributor,
            authorBound: authorBound,
            timestamp: uint64(block.timestamp),
            blockNumber: uint64(block.number),
            uri: uri
        });
        _hashByIndex[index] = contentHash;
        unchecked {
            // `total` is bounded by the number of transactions ever sent; it cannot overflow.
            total = index + 1;
        }

        emit Anchored(contentHash, contributor, index, uint64(block.timestamp), uri);
    }

    /// @notice True iff `contentHash` has been anchored.
    function isAnchored(bytes32 contentHash) external view returns (bool) {
        return _records[contentHash].contributor != address(0);
    }

    /// @notice Fetch the immutable record for `contentHash`. Reverts if it was never anchored.
    /// @dev    The returned `uri` is an UNTRUSTED hint and `timestamp`/`blockNumber` are an upper
    ///         bound on existence time + on-chain ordering, NOT authorship time (see "TRUST
    ///         BOUNDARIES"). The record only attests that the EXACT `contentHash` you queried was
    ///         anchored; to bind it to real content, the caller must re-derive and re-hash that
    ///         content and confirm it equals `contentHash`.
    function getRecord(bytes32 contentHash) external view returns (Record memory) {
        Record memory r = _records[contentHash];
        if (r.contributor == address(0)) revert NotAnchored(contentHash);
        return r;
    }

    /// @notice The content hash anchored at a given insertion `index`.
    function hashAtIndex(uint256 index) external view returns (bytes32) {
        if (index >= total) revert IndexOutOfRange(index, total);
        return _hashByIndex[index];
    }

    /// @notice Inspect a pending commitment. Returns a zero `committer` if the commitment was never
    ///         registered or has already been opened by `reveal()`.
    /// @param  commitment the commitment hash (see `commitmentOf`).
    /// @return committer   the address that registered it (zero if none/opened).
    /// @return blockNumber block.number at commit time (zero if none/opened).
    function getCommitment(bytes32 commitment)
        external
        view
        returns (address committer, uint64 blockNumber)
    {
        Commitment memory c = _commitments[commitment];
        return (c.committer, c.blockNumber);
    }

    // ---------------------------------------------------------------------------------------------
    // Domain-separated Merkle verification.
    //
    // SECURITY (second-preimage resistance). A naive Merkle scheme where a leaf is just
    // keccak256(content) and an internal node is just keccak256(childA ++ childB) is forgeable:
    // every value on the tree — leaf or interior — is "some 32 bytes", and a folding verifier that
    // accepts an arbitrary 32-byte `leaf` argument cannot tell which layer that value belongs to.
    // An attacker who knows two sibling leaves can compute their parent interior node N and submit
    // it as if it were a leaf, with a *shorter* proof; the fold reaches the root and the forged
    // "membership" of N (which is NOT any real file) is accepted. See the second-preimage forgery
    // test in test/ for a concrete exploit of exactly that bug.
    //
    // The fix here is RFC 6962 / OpenZeppelin-style domain separation enforced *by the verifier*:
    //   * leaves are tagged:  leafHash(c) = keccak256(LEAF_TAG ++ c)
    //   * interior nodes are tagged differently: nodeHash(a,b) = keccak256(NODE_TAG ++ min ++ max)
    // and, crucially, `verifyLeaf` itself applies LEAF_TAG to the value it is asked to verify. The
    // caller passes the raw per-file content digest c = keccak256(file bytes); it can never inject a
    // value that is already at the "tagged leaf" layer, and it can never replay an interior node as
    // a leaf — re-tagging an interior node N as keccak256(LEAF_TAG ++ N) != N, so the fold misses
    // the root. Forging membership now requires a preimage/collision on keccak256.
    //
    // The off-chain CLI (cli/hash.js) builds trees with the identical leafHash/nodeHash convention,
    // so a root produced by `vh hash <dir>` is exactly the root this verifier reconstructs.
    // ---------------------------------------------------------------------------------------------

    /// @dev Distinct one-byte domain tags so a leaf hash can never equal an interior-node hash, and
    ///      neither can equal a bare content digest. (RFC 6962 uses 0x00 for leaves, 0x01 for nodes.)
    bytes1 internal constant LEAF_TAG = 0x00;
    bytes1 internal constant NODE_TAG = 0x01;

    /// @notice Domain-separated leaf hash for a per-file content digest.
    /// @param  contentHash keccak256(file bytes) — the same digest `anchor` stores for a single file.
    /// @return the tagged leaf value used at the bottom layer of the Merkle tree.
    function leafHash(bytes32 contentHash) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(LEAF_TAG, contentHash));
    }

    /// @notice Domain-separated, order-independent interior-node hash of two children.
    /// @dev    Sorted-pair (min ++ max) so the tree is independent of left/right child order, then
    ///         tagged with NODE_TAG so an interior node can never collide with a leaf.
    function nodeHash(bytes32 a, bytes32 b) public pure returns (bytes32) {
        return a <= b
            ? keccak256(abi.encodePacked(NODE_TAG, a, b))
            : keccak256(abi.encodePacked(NODE_TAG, b, a));
    }

    /// @notice Verify that `contentHash` is a genuine leaf of the Merkle tree whose root is `root`.
    /// @dev    Lets a whole tree (e.g. an entire repository) be anchored by its root via
    ///         `anchor(root, ...)`, then individual files proven against it later without storing
    ///         every leaf on-chain. The verifier applies LEAF_TAG to `contentHash` itself, so an
    ///         interior node cannot be passed off as a leaf (second-preimage resistant). `proof` is
    ///         the list of sibling node values from the leaf up to the root.
    /// @param  root        the anchored Merkle root.
    /// @param  contentHash the raw per-file content digest = keccak256(file bytes) (NOT pre-tagged).
    /// @param  proof       sibling hashes from leaf to root.
    /// @return true iff folding the tagged leaf up through `proof` reproduces `root`.
    function verifyLeaf(bytes32 root, bytes32 contentHash, bytes32[] calldata proof)
        external
        pure
        returns (bool)
    {
        // Apply the leaf domain tag *inside* the verifier: the caller can only ever supply a value
        // at the pre-leaf (content-digest) layer, never an already-tagged leaf or interior node.
        bytes32 computed = leafHash(contentHash);
        for (uint256 i = 0; i < proof.length; i++) {
            computed = nodeHash(computed, proof[i]);
        }
        return computed == root;
    }
}
