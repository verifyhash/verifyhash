// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  ContributionRegistry
/// @notice Tamper-evident, permissionless, immutable registry of code-contribution hashes.
/// @notice TRUST BOUNDARIES (read before relying on any field):
///         - `contributor` is the address that FIRST anchored the hash — the first broadcaster,
///           NOT a proven author. Anyone who learns a `contentHash` (e.g. from the mempool) can
///           anchor it first. Do not treat `contributor` as authorship without an out-of-band proof.
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
        // The first address to anchor this hash (first broadcaster). NOT a proven author: anyone
        // who sees the contentHash can anchor it first. Treat as "first anchorer", not authorship.
        address contributor;
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

    /// @dev contentHash => immutable Record. A zero `contributor` means "not anchored".
    mapping(bytes32 => Record) private _records;
    /// @dev insertion index => contentHash, for enumeration without unbounded storage scans.
    mapping(uint256 => bytes32) private _hashByIndex;

    /// @notice Total number of distinct content hashes anchored.
    uint256 public total;

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

    error ZeroHash();
    error AlreadyAnchored(bytes32 contentHash, address contributor);
    error NotAnchored(bytes32 contentHash);
    error IndexOutOfRange(uint256 index, uint256 total);

    /// @notice Anchor a contribution's content hash on-chain. First writer wins; immutable after.
    /// @dev    `uri` is stored verbatim and is an UNTRUSTED hint: it is never fetched, validated, or
    ///         hashed by the contract, and the recorded `contributor`/`timestamp` describe the
    ///         anchoring transaction, not authorship of the content. See the contract-level
    ///         "TRUST BOUNDARIES" notice. The only integrity guarantee is `contentHash` itself:
    ///         consumers re-derive and re-hash the content and compare.
    /// @param  contentHash keccak256 (or any 32-byte digest) of the contribution's content.
    /// @param  uri optional, UNTRUSTED off-chain pointer hint (IPFS CID, commit URL, etc.). May be
    ///         empty. Stored as-is; proves nothing on its own. To trust a record, fetch the content
    ///         this uri claims to point at, re-derive its hash, and require it to equal contentHash.
    /// @return index the insertion index assigned to this hash.
    function anchor(bytes32 contentHash, string calldata uri) external returns (uint256 index) {
        if (contentHash == bytes32(0)) revert ZeroHash();

        Record storage existing = _records[contentHash];
        if (existing.contributor != address(0)) {
            revert AlreadyAnchored(contentHash, existing.contributor);
        }

        index = total;
        _records[contentHash] = Record({
            contributor: msg.sender,
            timestamp: uint64(block.timestamp),
            blockNumber: uint64(block.number),
            uri: uri
        });
        _hashByIndex[index] = contentHash;
        unchecked {
            // `total` is bounded by the number of transactions ever sent; it cannot overflow.
            total = index + 1;
        }

        emit Anchored(contentHash, msg.sender, index, uint64(block.timestamp), uri);
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
