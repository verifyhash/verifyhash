// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {ContributionRegistry} from "./ContributionRegistry.sol";

/// @title  ReputationSBT
/// @notice Soulbound (NON-TRANSFERABLE) contribution points, derived 1:1 from the pinned
///         ContributionRegistry's front-running-resistant records. One point = one registry record
///         with `authorBound == true` (a proven commit-reveal claim), credited to that record's own
///         `contributor` — NEVER to `msg.sender` — at most once per `contentHash`, globally, forever.
///         This is the EPIC-3 / T-3.2 layer specified by docs/REPUTATION-SBT-DESIGN.md; the pure
///         off-chain reference (conformance oracle) is cli/core/reputation-points.js, and this
///         contract's `points(addr)` must always equal that module's `pointsOf(records, addr)` for
///         the same records.
/// @notice HONEST BOUNDARY (docs/REPUTATION-SBT-DESIGN.md §2 — read before relying on any balance):
///         a point means: this address provably made this front-running-resistant (commit-reveal)
///         claim, exactly once per content — a floor of verifiable activity, NEVER a proof of merit,
///         content quality, or value. The defenses here (authorBound-only, one point per contentHash,
///         non-transferability, per-point auditability back to a registry record) raise the COST and
///         AUDITABILITY of inflation; they do not make raw point counts sybil-proof. A determined
///         actor can still commit-reveal N junk hashes from N addresses and mint N points, paying gas
///         each time. A consumer for whom sybil resistance is load-bearing MUST weight points by
///         inspecting the backing records (`getRecordsByContributor` on the registry / the PointMinted
///         event log), never by trusting the bare number.
/// @notice WHY NON-TRANSFERABLE (docs/REPUTATION-SBT-DESIGN.md §3): a point asserts a historical fact
///         about a specific address ("this address performed a proven commit-reveal claim for this
///         content"). A transferred attestation is a lie — facts about address A do not become true of
///         address B by payment, and the backing record would still name the original contributor,
///         contradicting the transferred point's own audit trail. Transferability would also create a
///         market in fake reputation (sybil farms selling consolidation) and re-open the securities
///         framing D-2 rejected. Non-transferability is therefore enforced by ABSENCE: this contract
///         has NO transfer, approval, or operator surface at all (no ERC-721/ERC-20 interface, no
///         tokenIds, nothing to move), and NO code path changes a balance other than mint-against-a-
///         record. Lock-signalling `Locked` events are emitted in the spirit of ERC-5192 (everything
///         is permanently locked from the moment it exists).
/// @dev    Design choices an audit should hold us to (mirrors the registry's own discipline):
///         - NO owner, NO admin, NO pause, NO upgrade path, NO revocation, NO burn. A point is exactly
///           as immutable as the registry record behind it. There is no privileged key to compromise.
///         - NO funds are ever held: every function is non-payable and there is no receive/fallback.
///         - Balances are MONOTONIC (append-only, like the registry): the only state-changing
///           operation is the permissionless mint, and it only ever increments.
///         - The ONE registry this layer reads is pinned immutably at construction and identity-probed
///           via `REGISTRY_ID` (the EPIC-11 pinning rule): reputation is only as meaningful as the
///           pinned registry. The registry's reads are `view` (staticcall) — no reentrancy surface.
///         - No function loops over an unbounded set: `mintBatch` is bounded by the CALLER-SUPPLIED
///           calldata array, never by registry size — no griefable gas-DoS surface.
contract ReputationSBT {
    // ---------------------------------------------------------------------------------------------
    // ON-CHAIN IDENTITY MARKER (same rule as ContributionRegistry.REGISTRY_ID): a cheap, ownerless
    // "am I pointed at the right interface" probe for off-chain readers. A fork can reuse the same
    // value — verify it alongside the deployed bytecode + chainId, never as the only check. It proves
    // interface identity only, never that any balance is meaningful (see the HONEST BOUNDARY notice).
    // ---------------------------------------------------------------------------------------------

    /// @notice Immutable, ownerless self-identification tag for this contract family. Interface
    ///         identity only — a positive match proves "this bytecode implements the documented
    ///         ReputationSBT surface", NOT that its balances are honest or canonical (a fork can
    ///         reuse the value; verify alongside bytecode + chainId).
    /// @dev    FROZEN VALUE: keccak256("verifyhash.ReputationSBT.v1") ==
    ///         0xecbbfdea57ced2f80c720d372fa881fd59bfbe31d186a8d493fb8a9177a71623, computed by the
    ///         compiler from the constant string literal below; the documented preimage is exactly the
    ///         ASCII string `verifyhash.ReputationSBT.v1`. `constant` — baked into bytecode, no
    ///         storage, no setter. test/ReputationSBT.test.js pins this exact expected hash.
    bytes32 public constant REPUTATION_ID = keccak256("verifyhash.ReputationSBT.v1");

    /// @notice The load-bearing, honest definition of a single point, byte-for-byte identical to the
    ///         `POINT_MEANING` string exported by the off-chain reference module
    ///         cli/core/reputation-points.js — the SINGLE SOURCE the design doc, the NatSpec, and both
    ///         implementations pin to, so none of them can silently drift (a docs-rot test asserts
    ///         on-chain == off-chain equality).
    /// @dev    `constant` (bytecode only, no storage). The em-dash makes this a `unicode` literal.
    string public constant POINT_MEANING =
        unicode"a point means: this address provably made this front-running-resistant (commit-reveal) claim, exactly once per content — a floor of verifiable activity, NEVER a proof of merit, content quality, or value";

    /// @notice The ONE pinned ContributionRegistry this layer reads, fixed forever at construction
    ///         (the EPIC-11 pinning rule). Every point is auditable back to a record in THIS registry:
    ///         read `registry.getRecord(contentHash)`, confirm `authorBound == true` and
    ///         `contributor == holder`, and (holding the content) re-derive the hash with `vh hash` /
    ///         `vh verify`. Reputation here is only as meaningful as this pinned registry.
    ContributionRegistry public immutable registry;

    /// @notice Whether `contentHash`'s registry record has already been converted into a point.
    ///         Enforces AT MOST ONE POINT PER contentHash, GLOBALLY, FOREVER — the same content can
    ///         never be counted twice, across addresses or across time. Once true, never unset (a
    ///         point is permanently locked; see the `Locked` event).
    mapping(bytes32 => bool) public minted;

    /// @notice Soulbound point balance per address. MONOTONICALLY NON-DECREASING: the only code path
    ///         that changes any balance is the permissionless mint, which only increments. There is no
    ///         transfer, approval, burn, or revocation path — non-transferability by ABSENCE.
    /// @notice TRUST BOUNDARY: this number is a floor of verifiable ACTIVITY (proven commit-reveal
    ///         claims), NEVER a proof of merit, and raw counts are NOT sybil-proof — a load-bearing
    ///         consumer must inspect the backing records. It can LAG the registry (records whose mint
    ///         nobody has paid gas for yet) but can never exceed the address's authorBound record
    ///         count; if the two views ever disagree, the registry's records are authoritative.
    mapping(address => uint256) public points;

    /// @notice Sum of all balances (one per minted contentHash), for cheap sanity reads. Equals the
    ///         off-chain oracle's `projectPoints(records).totalPoints` once every authorBound record
    ///         has been minted.
    uint256 public totalPoints;

    /// @notice Emitted once per successful mint — exactly one per (contentHash, point), forever.
    ///         Indexers can rebuild every balance, and audit every point back to its backing registry
    ///         record, from these logs alone.
    /// @param  contributor the address credited: the backing record's OWN `contributor` (the proven
    ///                     commit-reveal claimant), NEVER the caller who paid for the mint.
    /// @param  contentHash the registry record this point is bound to (the audit key).
    /// @param  newBalance  `points[contributor]` after this mint.
    /// @param  newTotalPoints `totalPoints` after this mint.
    event PointMinted(
        address indexed contributor,
        bytes32 indexed contentHash,
        uint256 newBalance,
        uint256 newTotalPoints
    );

    /// @notice Lock signal in the spirit of ERC-5192: every point is permanently locked (soulbound)
    ///         from the moment it is minted — there is no transfer surface it could ever move through,
    ///         and no unlock event exists. Emitted once per mint, alongside PointMinted.
    /// @param  contentHash the minted record's content hash (points have no tokenIds to signal on).
    event Locked(bytes32 indexed contentHash);

    /// @notice The exact registry identity this layer's constructor demands of the contract it pins:
    ///         keccak256 of the SAME documented preimage (`verifyhash.ContributionRegistry.v1`) that
    ///         backs ContributionRegistry.REGISTRY_ID, recomputed here at compile time from the
    ///         constant string literal (Solidity does not allow reading another contract's constant
    ///         cross-type at compile time). test/ReputationSBT.test.js pins runtime equality of the
    ///         two constants so they can never drift.
    /// @dev    FROZEN VALUE: 0x0395e2ec987e96e51cdf619980638100236c5fc7f7c3646f8b759f3cdceb2df3.
    bytes32 public constant EXPECTED_REGISTRY_ID =
        keccak256("verifyhash.ContributionRegistry.v1");

    /// @dev The zero address was passed as the registry to pin.
    error ZeroRegistry();
    /// @dev The pinned-registry candidate failed the REGISTRY_ID identity probe (wrong id). A
    ///      candidate with no readable REGISTRY_ID() at all (EOA / unrelated contract) reverts on the
    ///      probe call itself instead.
    error NotARegistry(address candidate);
    /// @dev This contentHash's record has already been converted into a point (one point per
    ///      contentHash, globally, forever).
    error AlreadyMinted(bytes32 contentHash);
    /// @dev The record exists but was written via the front-runnable one-shot `anchor()` path
    ///      (`authorBound == false`): it proves first-anchoring, not authorship, and mints NOTHING,
    ///      ever (docs/REPUTATION-SBT-DESIGN.md §1).
    error NotAuthorBound(bytes32 contentHash);

    /// @notice Pin the ONE ContributionRegistry this reputation layer reads, forever.
    /// @dev    Identity-probes the candidate (EPIC-11 pinning rule): it must self-identify with the
    ///         documented `REGISTRY_ID`, so this layer cannot be constructed over an arbitrary or
    ///         lying contract by accident. NOTE the probe proves interface identity only — a fork can
    ///         reuse the id; the DEPLOYER is still responsible for pinning the intended registry
    ///         (verify bytecode + chainId + address), and reputation is only as meaningful as the
    ///         registry pinned here.
    /// @param  registry_ the ContributionRegistry to pin (immutable after construction).
    constructor(ContributionRegistry registry_) {
        if (address(registry_) == address(0)) revert ZeroRegistry();
        // Compile-time expected id (recomputed from the SAME documented preimage as the registry's
        // frozen constant; a test pins the two equal) vs the candidate's runtime self-identification.
        if (registry_.REGISTRY_ID() != EXPECTED_REGISTRY_ID) {
            revert NotARegistry(address(registry_));
        }
        registry = registry_;
    }

    /// @notice Convert one registry record into one soulbound point. PERMISSIONLESS: anyone may call
    ///         this for any `contentHash` (the caller pays gas; keeper/indexer-friendly) — but the
    ///         point is ALWAYS credited to the backing record's own `contributor`, NEVER `msg.sender`.
    ///         Because the credited address comes from the immutable record, a mint cannot be
    ///         redirected, front-run for gain, or griefed: a third party "stealing" your mint merely
    ///         pays your gas for you.
    /// @dev    Requirements (each with its own error):
    ///           * the record exists in the pinned registry (else the registry's own
    ///             `NotAnchored(contentHash)` bubbles up — a point with no backing record is
    ///             unmintable by construction; the zero hash is unanchorable and so also reverts);
    ///           * `record.authorBound == true` (else `NotAuthorBound`): only proven,
    ///             front-running-resistant commit-reveal claims mint. `anchor()`-path records
    ///             (`authorBound == false`) mint nothing, ever — they prove first-anchoring, not
    ///             authorship, and counting them would import the registry's weakest signal;
    ///           * `minted[contentHash] == false` (else `AlreadyMinted`): one point per contentHash,
    ///             globally, forever.
    ///         The registry read is a `view` staticcall on the construction-verified pinned registry —
    ///         no reentrancy surface. Non-payable; no funds ever held.
    /// @param  contentHash the registry record to convert (also the point's permanent audit key).
    /// @return contributor the address that was credited (the record's proven claimant).
    function mint(bytes32 contentHash) external returns (address contributor) {
        return _mint(contentHash);
    }

    /// @notice Batched mint: many contentHashes, one transaction, IDENTICAL per-hash semantics to
    ///         `mint` (same checks, same credit-to-the-record, same events per hash).
    /// @dev    ATOMIC: if ANY hash fails its checks (unknown, not authorBound, already minted —
    ///         including a duplicate within this same batch) the WHOLE batch reverts and no state
    ///         changes. A keeper should pre-filter with the free `minted(hash)` /
    ///         `registry.getRecord(hash)` views to avoid wasting gas. The loop is bounded by the
    ///         CALLER-SUPPLIED array length (the caller pays gas proportional to what it sends),
    ///         never by registry size — no unbounded-loop gas-DoS surface. An empty batch is a no-op.
    /// @param  contentHashes the registry records to convert, in order.
    /// @return contributors the address credited for each hash, parallel to `contentHashes`.
    function mintBatch(bytes32[] calldata contentHashes)
        external
        returns (address[] memory contributors)
    {
        uint256 len = contentHashes.length;
        contributors = new address[](len);
        for (uint256 i = 0; i < len; i++) {
            contributors[i] = _mint(contentHashes[i]);
        }
    }

    /// @dev Shared mint logic for `mint` and `mintBatch` — the ONLY place any balance ever changes,
    ///      and it only ever increments (monotonic; non-transferability by absence of any other
    ///      mutator). Credits the record's own `contributor`, never `msg.sender`.
    function _mint(bytes32 contentHash) private returns (address contributor) {
        // One point per contentHash, globally, forever. Checked first: it is the cheapest gate and
        // makes double-mints fail before paying for the external registry read.
        if (minted[contentHash]) revert AlreadyMinted(contentHash);

        // Read the backing record from the pinned registry (view/staticcall). An unknown or zero
        // contentHash reverts with the registry's own NotAnchored — unmintable by construction.
        ContributionRegistry.Record memory record = registry.getRecord(contentHash);

        // Only proven, front-running-resistant commit-reveal claims mint. anchorOnly records prove
        // first-anchoring, not authorship: nothing, ever (design doc §1).
        if (!record.authorBound) revert NotAuthorBound(contentHash);

        // Credit the RECORD's contributor — never the caller. The caller only pays gas.
        contributor = record.contributor;
        minted[contentHash] = true;
        uint256 newBalance;
        unchecked {
            // Both sums are bounded by the number of registry records ever written (each mint
            // consumes a distinct anchored contentHash), which is bounded by the number of
            // transactions ever sent; they cannot overflow uint256.
            newBalance = points[contributor] + 1;
            points[contributor] = newBalance;
            totalPoints = totalPoints + 1;
        }

        emit PointMinted(contributor, contentHash, newBalance, totalPoints);
        // Permanently locked from the moment it exists (ERC-5192-spirit lock signal; soulbound).
        emit Locked(contentHash);
    }
}
