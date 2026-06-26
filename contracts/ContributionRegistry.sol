// SPDX-License-Identifier: Apache-2.0
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
///         - `parent` is an OPTIONAL, immutable predecessor edge (bytes32(0) == "no predecessor /
///           root of a lineage"). It asserts ONLY that the author of THIS record CLAIMED the named
///           predecessor. It does NOT prove the predecessor's content is genuinely an ancestor of
///           this content — consumers must still independently re-derive BOTH contents and judge the
///           relationship themselves — and it does NOT transfer or imply the predecessor's
///           authorship/attribution to this record (each record's `contributor`/`authorBound` stand
///           alone). A non-zero parent is REQUIRED to be already anchored at write time, so the
///           lineage graph is ACYCLIC BY CONSTRUCTION (a DAG); see `anchorWithParent`.
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
    // ---------------------------------------------------------------------------------------------
    // ON-CHAIN IDENTITY MARKER (T-11.1).
    //
    // WHAT THIS PROVES: that the bytecode an off-chain caller is talking to genuinely implements THIS
    // documented ContributionRegistry interface (the anchor/commit/reveal/getRecord/verifyLeaf surface
    // above). It is the cheapest, most direct "am I pointed at the right contract" probe: a single
    // `pure`/`constant` read with no storage, no state, no owner, and no write surface — so an
    // off-chain verifier (cli/registry.js, planned T-11.2) can authenticate a real registry before
    // believing any record it returns, instead of blindly trusting whatever an untrusted (rpc, address)
    // pair returns.
    //
    // WHAT THIS DOES NOT PROVE — DO NOT TREAT THE MARKER AS A SOLE ROOT OF TRUST:
    //   * It does NOT make the RECORDS honest beyond what the contract's own rules already guarantee.
    //     Attribution honesty still comes ONLY from the immutable first-writer-wins + commit-reveal
    //     mechanics and the `authorBound` flag (see the contract-level "TRUST BOUNDARIES" notice); the
    //     `uri` is still an untrusted hint and timestamps are still only an existence upper bound.
    //   * A FORK or a copy-paste deployment can carry the SAME `REGISTRY_ID` — the constant is part of
    //     the source, so anyone may compile and deploy bytecode that returns this exact value. The ID
    //     is therefore a POSITIVE signal of "this is the right interface", NOT proof of "this is THE
    //     canonical registry". It must be verified ALONGSIDE the deployed bytecode and the chainId
    //     (i.e. confirm you are on the expected chain at the expected address with the expected code),
    //     never as the only check.
    // See the contract-level "TRUST BOUNDARIES" notice for the records' own trust model.
    // ---------------------------------------------------------------------------------------------

    /// @notice Immutable, ownerless self-identification tag for this contract family. An off-chain
    ///         verifier reads this to confirm the bytecode implements the documented registry
    ///         interface (a "right interface" signal), NOT to prove the records are honest and NOT as a
    ///         sole root of trust (a fork can reuse the same value — verify it alongside bytecode +
    ///         chainId). See the "ON-CHAIN IDENTITY MARKER" and contract-level "TRUST BOUNDARIES"
    ///         notices.
    /// @dev    FROZEN VALUE: keccak256("verifyhash.ContributionRegistry.v1") ==
    ///         0x0395e2ec987e96e51cdf619980638100236c5fc7f7c3646f8b759f3cdceb2df3, computed by the
    ///         compiler from the constant string literal below; the documented preimage is exactly the
    ///         ASCII string `verifyhash.ContributionRegistry.v1`. It is a `constant` (baked into
    ///         bytecode, no storage slot, no setter) so it can never change after deploy and adds no
    ///         admin/write surface. test/Identity.test.js pins this exact expected hash.
    bytes32 public constant REGISTRY_ID =
        keccak256("verifyhash.ContributionRegistry.v1");

    /// @notice Monotonic interface version of this registry, starting at 1. Bumped only if a future
    ///         contract makes a breaking change to the documented read/write interface, so an
    ///         off-chain verifier can refuse a registry whose version it does not understand.
    /// @dev    `constant` (no storage, no setter); immutable after deploy. Paired with `REGISTRY_ID`.
    uint256 public constant REGISTRY_VERSION = 1;

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
        // OPTIONAL, IMMUTABLE predecessor edge. bytes32(0) means "no predecessor / root of a
        // lineage". A non-zero `parent` is the contentHash of a record that was ALREADY anchored
        // when this record was written (enforced at write time), so the lineage graph is acyclic by
        // construction (see anchorWithParent / the contract-level "TRUST BOUNDARIES" notice).
        //
        // TRUST BOUNDARY for `parent`: this edge asserts only that the AUTHOR OF THIS RECORD CLAIMED
        // the named predecessor. It does NOT prove the predecessor's content is genuinely an ancestor
        // of this content (consumers must still independently re-derive BOTH contents and reason about
        // the relationship themselves), and it does NOT transfer or imply the predecessor's
        // authorship/attribution to this record. Each record's `contributor`/`authorBound` stand on
        // their own exactly as documented above; naming a parent grants this record nothing from it.
        bytes32 parent;
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

    // ---------------------------------------------------------------------------------------------
    // PER-CONTRIBUTOR INDEX (T-12.1). Purely ADDITIVE side state so an off-chain reputation/scoring
    // consumer can enumerate one address's records in O(that address's own records) instead of
    // scanning all N records (and doing N getRecord round-trips) just to find the few written by one
    // contributor.
    //
    // INVARIANTS / SAFETY:
    //   * APPEND-ONLY, insertion order preserved. `_record` pushes the new global insertion index
    //     onto `_contributorIndices[contributor]` and bumps `_contributorCount[contributor]` — one
    //     array push + one counter bump, NO loop, so every write stays O(1) and the "no function
    //     loops over an unbounded set / no gas-DoS on writes" invariant holds. The counter is a
    //     cheap, single-slot read that always equals the array's length (an explicit invariant the
    //     tests pin), so a consumer can size its pagination without paying to load the whole array.
    //   * COVERS EVERY WRITE PATH WITH NO PER-PATH SPECIAL-CASING. Both the legacy no-parent
    //     `anchor`/`reveal` and the `*WithParent` paths funnel through the SAME shared `_record`
    //     writer, which is the only place this index is touched.
    //   * READ-ONLY SIDE STATE. It NEVER changes a record's attribution or content: the `Record`
    //     struct, the existing events/errors, and the `_records`/`_hashByIndex`/`total` layout used
    //     by current reads are all untouched. Grouping by `contributor` is a RAW ENUMERATION, not an
    //     endorsement — see the contract-level "TRUST BOUNDARIES" notice and the read functions'
    //     NatSpec: an `authorBound == false` record grouped under an address is STILL only "first
    //     anchorer", never proven authorship.
    // ---------------------------------------------------------------------------------------------

    /// @dev contributor address => the GLOBAL insertion indices of the records written by (recorded
    ///      under) that address, in insertion order. Append-only; an entry is added by `_record` on
    ///      every write and never removed or reordered.
    mapping(address => uint256[]) private _contributorIndices;
    /// @dev contributor address => number of records recorded under that address. A cheap,
    ///      single-slot mirror of `_contributorIndices[a].length`, bumped in the same O(1) write so a
    ///      consumer can read a contributor's count without loading the whole index array.
    mapping(address => uint256) private _contributorCount;

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

    /// @notice Emitted (in ADDITION to Anchored/Revealed) whenever a record is written with a
    ///         non-zero predecessor `parent`, so off-chain indexers can reconstruct the FULL edge set
    ///         of the lineage graph purely from logs. Records written with no predecessor
    ///         (`parent == 0x0`, including every legacy `anchor`/`reveal` call) emit NO Linked event —
    ///         the absence of a Linked log for a child is exactly "this record is a lineage root".
    /// @dev    This is a PARALLEL event, deliberately separate from Anchored/Revealed: the legacy
    ///         Anchored/Revealed signatures are left byte-for-byte UNCHANGED so existing indexers and
    ///         the legacy zero-parent write paths keep emitting identical logs. Both `child` and
    ///         `parent` are indexed so an indexer can query "all edges into a node" or "all edges out
    ///         of a node" directly by topic.
    ///         TRUST BOUNDARY (same as the Record.parent field): this edge records only that the
    ///         author of `child` CLAIMED `parent` as a predecessor. It does NOT prove ancestry of the
    ///         underlying content and does NOT transfer the predecessor's authorship.
    /// @param  child  the contentHash of the record being written (the edge's tail).
    /// @param  parent the contentHash of the named, already-anchored predecessor (the edge's head).
    event Linked(bytes32 indexed child, bytes32 indexed parent);

    error ZeroHash();
    error AlreadyAnchored(bytes32 contentHash, address contributor);
    error NotAnchored(bytes32 contentHash);
    error IndexOutOfRange(uint256 index, uint256 total);
    error ZeroCommitment();
    error CommitmentExists(bytes32 commitment, address committer);
    error NoSuchCommitment(bytes32 commitment);
    error RevealTooSoon(uint64 commitBlock, uint64 currentBlock, uint64 minDelay);
    /// @dev A non-zero `parent` was named that has never been anchored. This is a DISTINCT
    ///      precondition from the child's own first-writer-wins check, so it gets its own error
    ///      (NOT NotAnchored, which is the read-side "this hash you queried was never anchored").
    error UnknownParent(bytes32 parent);
    /// @dev A record cannot name itself as its own predecessor (`parent == contentHash`); that would
    ///      be a self-loop. Caught explicitly so the failure is unambiguous rather than surfacing as
    ///      UnknownParent on a not-yet-written hash.
    error SelfParent(bytes32 contentHash);

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
        // Legacy no-predecessor path, kept byte-for-byte identical: delegates to the shared writer
        // with parent = bytes32(0) (a lineage root). Emits Anchored only (no Linked).
        return _record(contentHash, msg.sender, uri, false, bytes32(0));
    }

    /// @notice One-shot anchor that ADDITIONALLY records an immutable predecessor edge to `parent`.
    /// @dev    Identical to `anchor` (FRONT-RUNNABLE BY DESIGN, `authorBound = false`, first-writer-
    ///         wins, non-payable, immutable) but also stores the lineage edge child -> parent and
    ///         emits a `Linked(contentHash, parent)` log in addition to `Anchored`.
    ///
    ///         ACYCLIC BY CONSTRUCTION: a non-zero `parent` MUST already be anchored at the moment
    ///         this call executes, else it reverts with `UnknownParent(parent)`. Because a predecessor
    ///         must pre-exist (be earlier in insertion order) before it can be named, no edge can ever
    ///         point forward in time and no cycle can form — the lineage graph is a DAG by
    ///         construction. The check is O(1): a SINGLE mapping existence read, with NO loop and NO
    ///         walk of the chain, preserving the contract's "no function loops over an unbounded set /
    ///         no gas-DoS" invariant. Passing `parent == bytes32(0)` makes this record a lineage root
    ///         and behaves exactly like `anchor` (no edge, no Linked event).
    ///
    ///         TRUST BOUNDARY for the edge (see also the Record.parent field doc): naming a `parent`
    ///         asserts ONLY that the author of THIS record CLAIMED that predecessor. It does NOT prove
    ///         the parent's content is genuinely an ancestor of this content — consumers must still
    ///         independently re-derive BOTH contents and judge the relationship — and it does NOT
    ///         transfer or imply the parent's authorship/attribution to this record.
    /// @param  contentHash keccak256 (or any 32-byte digest) of this contribution's content.
    /// @param  uri optional, UNTRUSTED off-chain pointer hint (same caveats as `anchor`).
    /// @param  parent the contentHash of an already-anchored predecessor, or bytes32(0) for "no
    ///         predecessor / root of a lineage". A non-zero, never-anchored parent reverts
    ///         `UnknownParent`; `parent == contentHash` reverts `SelfParent`.
    /// @return index the insertion index assigned to this hash.
    function anchorWithParent(bytes32 contentHash, string calldata uri, bytes32 parent)
        external
        returns (uint256 index)
    {
        return _record(contentHash, msg.sender, uri, false, parent);
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
        // Legacy no-predecessor path, kept byte-for-byte identical: parent = bytes32(0). Emits
        // Revealed + Anchored only (no Linked).
        return _reveal(contentHash, salt, uri, bytes32(0));
    }

    /// @notice Step 2 of the front-running-resistant flow that ADDITIONALLY records an immutable
    ///         predecessor edge to `parent`.
    /// @dev    Identical to `reveal` (opens the sender-bound commitment, `authorBound = true`,
    ///         front-running-resistant, single-use commitment, immutable) but also stores the lineage
    ///         edge child -> parent and emits `Linked(contentHash, parent)` in addition to Revealed +
    ///         Anchored. The same ACYCLIC-BY-CONSTRUCTION and O(1)-check guarantees as
    ///         `anchorWithParent` apply: a non-zero `parent` must already be anchored or it reverts
    ///         `UnknownParent`; `parent == contentHash` reverts `SelfParent`; `parent == bytes32(0)`
    ///         makes this a lineage root and behaves exactly like `reveal`.
    ///
    ///         TRUST BOUNDARY for the edge: it asserts only that this record's author CLAIMED the
    ///         predecessor; it neither proves content ancestry nor transfers the parent's authorship.
    /// @param  contentHash the digest being claimed (must be non-zero and not already anchored).
    /// @param  salt        the secret 32-byte value used to build the commitment.
    /// @param  uri         optional, UNTRUSTED off-chain pointer hint (same caveats as `anchor`).
    /// @param  parent      an already-anchored predecessor's contentHash, or bytes32(0) for a root.
    /// @return index the insertion index assigned to this hash.
    function revealWithParent(bytes32 contentHash, bytes32 salt, string calldata uri, bytes32 parent)
        external
        returns (uint256 index)
    {
        return _reveal(contentHash, salt, uri, parent);
    }

    /// @dev Shared reveal logic for both `reveal` (parent = 0) and `revealWithParent`. Opens the
    ///      sender-bound commitment, enforces the maturation window, then writes the record (with the
    ///      optional parent edge) via `_record` and emits Revealed.
    function _reveal(bytes32 contentHash, bytes32 salt, string calldata uri, bytes32 parent)
        private
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

        index = _record(contentHash, msg.sender, uri, true, parent);
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

    /// @dev Shared writer for both the no-parent (`anchor`/`reveal`, parent = bytes32(0)) and the
    ///      with-parent (`anchorWithParent`/`revealWithParent`) paths, for authorBound=false (anchor)
    ///      and authorBound=true (reveal). Enforces non-zero hash + first-writer-wins, validates the
    ///      optional predecessor edge, appends to the index, and emits Anchored (+ Linked iff a
    ///      non-zero parent was given).
    ///
    ///      ACYCLIC BY CONSTRUCTION: a non-zero `parent` is required to ALREADY exist in `_records`,
    ///      so an edge can only ever point at an earlier (lower-index) record. A new record cannot be
    ///      named as anyone's parent until after it is itself written, so no forward edge and no cycle
    ///      can form. The parent check is O(1) — a single `_records[parent]` existence read, with NO
    ///      loop and NO walk of the ancestry chain — preserving the "no unbounded loop / no gas-DoS"
    ///      invariant. (`parent == bytes32(0)` is the root case: no check, no edge, no Linked event.)
    function _record(
        bytes32 contentHash,
        address contributor,
        string calldata uri,
        bool authorBound,
        bytes32 parent
    ) private returns (uint256 index) {
        if (contentHash == bytes32(0)) revert ZeroHash();

        Record storage existing = _records[contentHash];
        if (existing.contributor != address(0)) {
            revert AlreadyAnchored(contentHash, existing.contributor);
        }

        // Validate the optional predecessor edge. bytes32(0) == "no predecessor / lineage root":
        // skipped entirely. A non-zero parent is a distinct precondition from this record's own
        // first-writer-wins check, so it has its own dedicated errors.
        if (parent != bytes32(0)) {
            // Self-reference would be a self-loop; reject it explicitly (not via UnknownParent).
            if (parent == contentHash) revert SelfParent(contentHash);
            // The named predecessor must already be anchored (single O(1) existence read; no walk).
            // This is what makes the lineage graph acyclic by construction.
            if (_records[parent].contributor == address(0)) revert UnknownParent(parent);
        }

        index = total;
        _records[contentHash] = Record({
            contributor: contributor,
            authorBound: authorBound,
            timestamp: uint64(block.timestamp),
            blockNumber: uint64(block.number),
            uri: uri,
            parent: parent
        });
        _hashByIndex[index] = contentHash;
        unchecked {
            // `total` is bounded by the number of transactions ever sent; it cannot overflow.
            total = index + 1;
        }

        // PER-CONTRIBUTOR INDEX (T-12.1): append-only, O(1), and the SAME for every write path (this
        // is the only place it is touched, so the legacy no-parent `anchor`/`reveal` and the
        // `*WithParent` paths are all covered with no special-casing). One push + one counter bump,
        // NO loop. This is read-only side state: it records ONLY which global insertion index belongs
        // to `contributor`; it changes neither attribution nor content. For an `anchor()` record this
        // `contributor` is merely the "first anchorer" (authorBound == false) — grouping it under an
        // address is a raw enumeration, NOT an endorsement of authorship (see TRUST BOUNDARIES).
        _contributorIndices[contributor].push(index);
        unchecked {
            // Bounded by the number of writes ever made by this contributor; cannot overflow.
            _contributorCount[contributor] = _contributorCount[contributor] + 1;
        }

        emit Anchored(contentHash, contributor, index, uint64(block.timestamp), uri);
        // Emit the parallel edge log only when there IS an edge, so an indexer can reconstruct the
        // full edge set from Linked logs alone (a child with no Linked log is a lineage root).
        if (parent != bytes32(0)) {
            emit Linked(contentHash, parent);
        }
    }

    /// @notice True iff `contentHash` has been anchored.
    function isAnchored(bytes32 contentHash) external view returns (bool) {
        return _records[contentHash].contributor != address(0);
    }

    /// @notice Fetch the immutable record for `contentHash`. Reverts if it was never anchored.
    /// @dev    The returned `uri` is an UNTRUSTED hint and `timestamp`/`blockNumber` are an upper
    ///         bound on existence time + on-chain ordering, NOT authorship time (see "TRUST
    ///         BOUNDARIES"). The returned `parent` is the optional immutable predecessor edge
    ///         (bytes32(0) == lineage root); it is part of the struct, so callers walk a lineage
    ///         OFF-CHAIN by following `parent` from child to parent. Per TRUST BOUNDARIES the edge is
    ///         only a CLAIM by this record's author — it proves neither content ancestry nor any
    ///         transfer of the parent's authorship. The record only attests that the EXACT
    ///         `contentHash` you queried was anchored; to bind it to real content, the caller must
    ///         re-derive and re-hash that content and confirm it equals `contentHash`.
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

    /// @notice Fetch the immutable record at a given insertion `index` (its hash + the Record).
    /// @dev    Bounded, ownerless, side-effect-free read over the existing `_hashByIndex` / `_records`
    ///         mappings — adds no state and no write path. Reverts with the SAME `IndexOutOfRange`
    ///         error as `hashAtIndex` when `index >= total`.
    ///         TRUST BOUNDARIES (identical to `getRecord`): the returned `uri` is an UNTRUSTED hint the
    ///         contract never fetches/validates; `timestamp`/`blockNumber` are an UPPER BOUND on
    ///         existence time + on-chain ORDERING, NOT authorship time; and `authorBound`
    ///         distinguishes a proven first *claimant* (commit+reveal, true) from a mere "first
    ///         anchorer" (one-shot anchor, false). See the contract-level "TRUST BOUNDARIES" notice.
    /// @param  index       insertion index in `[0, total)`.
    /// @return contentHash the digest anchored at `index`.
    /// @return record      the immutable Record stored for that digest.
    function getRecordAtIndex(uint256 index)
        external
        view
        returns (bytes32 contentHash, Record memory record)
    {
        if (index >= total) revert IndexOutOfRange(index, total);
        contentHash = _hashByIndex[index];
        record = _records[contentHash];
    }

    /// @notice Paginated, forgiving batch read of records for the index window `[start, start+count)`.
    /// @dev    Returns two PARALLEL arrays: `contentHashes[i]` and `records[i]` describe the same
    ///         entry, for the i-th index in the (clamped) window. This is the read-side primitive an
    ///         off-chain enumerator/indexer uses to page through the registry in one batched
    ///         `eth_call` per page instead of `2*N` round-trips.
    ///
    ///         CLAMPING (pagination must be forgiving — it NEVER reverts on an out-of-range tail):
    ///           * if `start >= total`, both arrays are empty;
    ///           * the effective length is `min(count, total - start)`, so an over-long `count` (or a
    ///             window that runs off the end) returns only the entries that actually exist.
    ///         This means a caller can blindly walk `getRecords(0, page), getRecords(page, page), ...`
    ///         and simply stop when it gets a short/empty page, without ever needing to know `total`
    ///         up front or risking a revert at the boundary.
    ///
    ///         BOUNDEDNESS / no gas-DoS: the loop runs exactly `len <= count` iterations, i.e. it is
    ///         bounded by the CALLER-SUPPLIED page size, never by the unbounded registry size — the
    ///         contract's "no function loops over an unbounded set" invariant is preserved. These are
    ///         `view`/`eth_call` reads (no gas is paid by an EOA), so the CALLER is responsible for
    ///         choosing a sane `count`: an absurd page size can still exceed an RPC node's `eth_call`
    ///         gas/time budget. Page in modest chunks (e.g. 100-1000) and walk forward.
    ///
    ///         Ownerless, side-effect-free, additive: adds no state and no write path. Each returned
    ///         record carries the SAME TRUST BOUNDARIES as `getRecord` / `getRecordAtIndex` — `uri`
    ///         untrusted; `timestamp`/`blockNumber` an existence upper bound + ordering, not
    ///         authorship time; `authorBound` distinguishes a proven first claimant (true) from a mere
    ///         first anchorer (false). See the contract-level "TRUST BOUNDARIES" notice.
    /// @param  start the first insertion index to read (clamped: `start >= total` yields empty arrays).
    /// @param  count the maximum number of records to return (the realized length is clamped to what
    ///               actually exists; you are responsible for keeping this a sane page size).
    /// @return contentHashes the digests for the clamped window, in insertion order.
    /// @return records       the parallel immutable Records for those digests.
    function getRecords(uint256 start, uint256 count)
        external
        view
        returns (bytes32[] memory contentHashes, Record[] memory records)
    {
        uint256 t = total;
        // Forgiving clamp: nothing exists at or past `total`, so an out-of-range window is empty, not
        // a revert. `start >= t` short-circuits to `len = 0` and we never read past the end.
        uint256 len;
        if (start < t) {
            uint256 available = t - start;
            len = count < available ? count : available;
        }

        contentHashes = new bytes32[](len);
        records = new Record[](len);
        // Bounded by `len <= count` (the caller's page size), never by `total`.
        for (uint256 i = 0; i < len; i++) {
            bytes32 h = _hashByIndex[start + i];
            contentHashes[i] = h;
            records[i] = _records[h];
        }
    }

    /// @notice Number of records recorded under `contributor` (i.e. written by that address). This is
    ///         the cheap, single-`eth_call` length an off-chain scorer reads to size its pagination,
    ///         so enumerating one contributor is O(that contributor's own records), never O(total).
    /// @dev    Ownerless, side-effect-free read of the additive `_contributorCount` mirror; it always
    ///         equals `_contributorIndices[contributor].length`. Adds no state and no write path.
    ///
    ///         TRUST BOUNDARY — this count is a RAW ENUMERATION, NOT AN ENDORSEMENT. Grouping records
    ///         by `contributor` does NOT upgrade attribution: a record written via the front-runnable
    ///         `anchor()` is counted under its writer's address while still being `authorBound == false`
    ///         (i.e. only "first anchorer", never proven authorship — anyone who saw the contentHash
    ///         could have anchored it). A reputation consumer MUST inspect each record's `authorBound`
    ///         and weight it accordingly; this number says only "how many records carry this address",
    ///         not "how many this address provably authored". See the contract-level "TRUST
    ///         BOUNDARIES" notice.
    /// @param  contributor the address to count records for.
    /// @return count the number of records recorded under `contributor` (0 for an unknown address).
    function contributorRecordCount(address contributor) external view returns (uint256 count) {
        return _contributorCount[contributor];
    }

    /// @notice Paginated, forgiving batch read of the records recorded under a single `contributor`,
    ///         in insertion order — the per-contributor analogue of `getRecords`. Lets an off-chain
    ///         reputation/scoring consumer page through ONE address's contributions in
    ///         O(that contributor's own records) instead of scanning all `total` records.
    /// @dev    Returns two PARALLEL arrays: `contentHashes[i]` and `records[i]` describe the same
    ///         entry, the i-th of THIS contributor's records (skipping every record written by anyone
    ///         else) within the clamped window `[start, start+count)` over that contributor's own
    ///         sequence.
    ///
    ///         CLAMPING (identical to `getRecords` — forgiving, NEVER reverts on an out-of-range tail):
    ///           * if `start >= contributorRecordCount(contributor)`, both arrays are empty;
    ///           * the effective length is `min(count, owned - start)`, so an over-long `count` (or a
    ///             window that runs off the end) returns only the entries that actually exist.
    ///         A caller can blindly walk `getRecordsByContributor(a, 0, page), (a, page, page), ...`
    ///         and stop on a short/empty page, without knowing the count up front and without ever
    ///         risking a boundary revert.
    ///
    ///         BOUNDEDNESS / no gas-DoS: the loop runs exactly `len <= count` iterations — bounded by
    ///         the CALLER-SUPPLIED page size, never by the contributor's (or the registry's) size. As
    ///         with `getRecords` these are `view`/`eth_call` reads (no gas paid by an EOA), so the
    ///         CALLER chooses a sane page size: an absurd `count` can still exceed an RPC node's
    ///         `eth_call` budget. Page in modest chunks (e.g. 100-1000) and walk forward.
    ///
    ///         Ownerless, side-effect-free, additive: reads the `_contributorIndices` side index plus
    ///         the existing `_hashByIndex`/`_records`; adds no state and no write path, and NEVER
    ///         changes any record's attribution or content.
    ///
    ///         TRUST BOUNDARY — grouping by `contributor` is a RAW ENUMERATION, NOT AN ENDORSEMENT. It
    ///         does NOT upgrade a front-runnable `anchor()` record's attribution: an `authorBound ==
    ///         false` record returned under an address is STILL only "first anchorer" (anyone who saw
    ///         the contentHash could have anchored it), never proven authorship. A reputation consumer
    ///         MUST read each returned record's `authorBound` and weight it accordingly. Each record
    ///         also carries the SAME TRUST BOUNDARIES as `getRecord`/`getRecords`: `uri` is an
    ///         UNTRUSTED hint the contract never fetches/validates; `timestamp`/`blockNumber` are an
    ///         UPPER BOUND on existence time + on-chain ORDERING, not authorship time; `parent` is only
    ///         a CLAIMED predecessor edge. See the contract-level "TRUST BOUNDARIES" notice.
    /// @param  contributor the address whose own records to page through.
    /// @param  start the first index INTO THAT CONTRIBUTOR'S sequence to read (clamped:
    ///               `start >= contributorRecordCount(contributor)` yields empty arrays).
    /// @param  count the maximum number of records to return (the realized length is clamped to what
    ///               that contributor actually has; you are responsible for a sane page size).
    /// @return contentHashes the digests of this contributor's records for the clamped window, in
    ///                       insertion order.
    /// @return records       the parallel immutable Records for those digests.
    function getRecordsByContributor(address contributor, uint256 start, uint256 count)
        external
        view
        returns (bytes32[] memory contentHashes, Record[] memory records)
    {
        uint256[] storage idxs = _contributorIndices[contributor];
        uint256 owned = idxs.length;
        // Forgiving clamp over THIS contributor's own sequence: nothing exists at or past `owned`, so
        // an out-of-range window is empty, not a revert.
        uint256 len;
        if (start < owned) {
            uint256 available = owned - start;
            len = count < available ? count : available;
        }

        contentHashes = new bytes32[](len);
        records = new Record[](len);
        // Bounded by `len <= count` (the caller's page size), never by `owned` or `total`.
        for (uint256 i = 0; i < len; i++) {
            bytes32 h = _hashByIndex[idxs[start + i]];
            contentHashes[i] = h;
            records[i] = _records[h];
        }
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

    /// @notice ERC-165 interface id of this registry's CORE READ interface, as the XOR of the
    ///         function selectors `isAnchored(bytes32) ^ getRecord(bytes32) ^ total() ^
    ///         hashAtIndex(uint256) ^ verifyLeaf(bytes32,bytes32,bytes32[])`.
    /// @dev    FROZEN VALUE: 0xc5d8cdda. A SECONDARY identity probe alongside the primary `REGISTRY_ID`
    ///         constant (which does not depend on selector bookkeeping). Like `REGISTRY_ID` it proves
    ///         only "the right interface is present", not record honesty, and a fork can reuse it; see
    ///         the "ON-CHAIN IDENTITY MARKER" notice. `constant` — no storage, no setter, immutable.
    bytes4 public constant REGISTRY_INTERFACE_ID = 0xc5d8cdda;

    /// @notice ERC-165 (`0x01ffc9a7`) interface-detection probe. Returns true for ERC-165 itself and
    ///         for this registry's core read interface id (`REGISTRY_INTERFACE_ID` == 0xc5d8cdda), and
    ///         false for everything else — including the reserved invalid id `0xffffffff` (per the
    ///         ERC-165 spec) and any unrelated id.
    /// @dev    `pure` (no storage, no state, no owner) — a purely additive identity probe that changes
    ///         no existing function, event, error, struct, or storage layout. As with `REGISTRY_ID`,
    ///         a positive result proves "this bytecode exposes the documented read interface", NOT that
    ///         the records are honest and NOT that this is the canonical/only registry (a fork can
    ///         return the same id); verify it alongside the deployed bytecode + chainId. See the
    ///         "ON-CHAIN IDENTITY MARKER" notice and the contract-level "TRUST BOUNDARIES" notice.
    /// @param  interfaceId the 4-byte ERC-165 interface identifier to probe.
    /// @return true iff `interfaceId` is the ERC-165 id or this registry's core read interface id.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // 0xffffffff is the ERC-165 reserved id that MUST return false; the `!= 0xffffffff` guard makes
        // that explicit even though neither matched constant equals it.
        return interfaceId != 0xffffffff &&
            (interfaceId == 0x01ffc9a7 || interfaceId == REGISTRY_INTERFACE_ID);
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
