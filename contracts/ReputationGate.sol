// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {ReputationSBT} from "./ReputationSBT.sol";

/// @title  ReputationGate
/// @notice REFERENCE CONSUMER for the EPIC-3 soulbound reputation layer — the smallest, copyable base a
///         paying verification / evidence integration inherits to GATE (or fast-track) a business action
///         on PROVEN contribution history. This is exactly the buyer use case
///         docs/REPUTATION-SBT-DESIGN.md §5 names: "only auto-honor a claimed contribution when the
///         claiming address holds >= N proven, front-running-resistant (`authorBound`) contributions —
///         route everything below the threshold to manual review." Without a shared consumer, every
///         integration re-reads `points` and re-implements the threshold plus its semantics; here the
///         whole decision is a single O(1) call to the pinned `ReputationSBT.meetsThreshold`, so the
///         predicate the layer defines is the predicate every consumer enforces — it cannot drift.
/// @notice WHAT THIS IS NOT. It SELLS NOTHING and HOLDS NO FUNDS: every function is non-payable, there is
///         no receive/fallback, and it moves no value. The reputation layer is infrastructure the income
///         products CONSUME, not a thing that is sold (revenue stays with evidence / licensing /
///         verification per the project's REVENUE INTEGRITY rule); this contract demonstrates that
///         composition, it is not a token and grants no tradeable right.
/// @notice HONEST BOUNDARY (docs/REPUTATION-SBT-DESIGN.md §2, inherited verbatim from the SBT): a passing
///         gate means the account provably made at least `minPoints` front-running-resistant claims — a
///         floor of verifiable activity, NEVER a proof of merit, and NOT sybil-proof (a determined actor
///         can still commit-reveal N junk hashes from N addresses, paying gas each time). A consumer for
///         whom sybil resistance is load-bearing MUST weight the decision by inspecting the backing
///         records, never by trusting the bare gate. This reference deliberately FAILS CLOSED: below the
///         threshold `requireReputation` / `autoHonor` REVERT so the caller routes to manual review; they
///         never silently allow.
/// @dev    Attack-surface notes an audit should hold this to:
///         - The pinned `ReputationSBT` is fixed at construction and identity-probed via `REPUTATION_ID`
///           (the EPIC-11 pinning rule), so the gate cannot be wired over an arbitrary / lying contract
///           by accident. The probe proves interface identity only — the DEPLOYER must still verify the
///           SBT's bytecode + chainId + address, and the gate is only as meaningful as the pinned SBT.
///         - The reputation read is a `view` staticcall on the construction-verified SBT (itself a view
///           over its own storage) — no reentrancy surface, no external write path.
///         - `minPoints` is immutable: the bar a caller must clear cannot be moved after deployment, and
///           there is no owner / admin / pause / upgrade key that could change it or the pinned SBT.
contract ReputationGate {
    /// @notice The pinned soulbound reputation layer this gate reads, fixed forever at construction.
    ReputationSBT public immutable reputation;

    /// @notice The INCLUSIVE minimum proven-contribution points an account must hold to clear this gate.
    ///         `0` admits everyone (a floor of zero). Immutable — the bar cannot be moved after deploy.
    uint256 public immutable minPoints;

    /// @dev The zero address was passed as the reputation layer to pin.
    error ZeroReputation();
    /// @dev The pinned candidate failed the `ReputationSBT` identity probe (wrong / absent
    ///      `REPUTATION_ID`). A candidate with no readable `REPUTATION_ID()` at all (EOA / unrelated
    ///      contract) reverts on the probe call itself instead.
    error NotAReputationSBT(address candidate);
    /// @dev `account` holds fewer than `required` points — the gated action is refused so the caller can
    ///      route the claim to manual review (fail closed). `have` is the account's current balance.
    error InsufficientReputation(address account, uint256 have, uint256 required);

    /// @notice The exact SBT identity this gate's constructor demands: keccak256 of the SAME documented
    ///         preimage (`verifyhash.ReputationSBT.v1`) that backs `ReputationSBT.REPUTATION_ID`,
    ///         recomputed here at compile time (Solidity cannot read another contract's constant
    ///         cross-type at compile time). A test pins runtime equality of the two so they cannot drift.
    /// @dev    FROZEN VALUE: 0xecbbfdea57ced2f80c720d372fa881fd59bfbe31d186a8d493fb8a9177a71623.
    bytes32 public constant EXPECTED_REPUTATION_ID =
        keccak256("verifyhash.ReputationSBT.v1");

    /// @notice DEMONSTRATION signal — stands in for whatever privileged effect the integrator's real
    ///         action would have (unlock a license fast-track, mark a claim auto-approved, etc.). This
    ///         reference performs no such effect and holds no funds; it only proves the gate composes.
    /// @param  account the caller that cleared the gate.
    /// @param  ref     an opaque reference to the honored claim (this contract never interprets it).
    event Honored(address indexed account, bytes32 indexed ref);

    /// @param reputation_ the `ReputationSBT` to pin (immutable; identity-probed).
    /// @param minPoints_  the inclusive point threshold this gate enforces (`0` admits everyone).
    constructor(ReputationSBT reputation_, uint256 minPoints_) {
        if (address(reputation_) == address(0)) revert ZeroReputation();
        // EPIC-11 pinning rule: identity-probe the candidate BEFORE trusting any reputation it reports,
        // so this gate cannot be constructed over an arbitrary or lying contract by accident. A candidate
        // with no REPUTATION_ID() at all reverts on the probe call itself (EOA / unrelated contract).
        if (reputation_.REPUTATION_ID() != EXPECTED_REPUTATION_ID) {
            revert NotAReputationSBT(address(reputation_));
        }
        reputation = reputation_;
        minPoints = minPoints_;
    }

    /// @notice The composable predicate a consumer branches on: does `account` clear this gate's
    ///         threshold? ONE O(1) read of the pinned SBT — no paging, no re-deriving the semantics.
    ///         This is the whole point of the layer: the decision is a single shared call.
    /// @param  account the address to test.
    /// @return allowed whether `account` holds at least `minPoints` proven-contribution points.
    function isAllowed(address account) public view returns (bool allowed) {
        return reputation.meetsThreshold(account, minPoints);
    }

    /// @notice Fail-closed guard: revert `InsufficientReputation` unless `account` clears the threshold.
    ///         A consumer wraps its business action in this (or the `gated` modifier) so below-threshold
    ///         callers are routed to manual review instead of auto-honored. Reverting carries the
    ///         account's current balance and the required bar so an off-chain caller can explain the
    ///         refusal without a second read.
    /// @param  account the address whose standing is required to clear the gate.
    function requireReputation(address account) public view {
        uint256 have = reputation.points(account);
        if (have < minPoints) {
            revert InsufficientReputation(account, have, minPoints);
        }
    }

    /// @dev Reusable guard: gate any state-changing consumer action on `account`'s proven-contribution
    ///      standing. Fails CLOSED (reverts below the threshold). An integrator writes
    ///      `function myAction(...) external gated(msg.sender) { ... }`.
    modifier gated(address account) {
        requireReputation(account);
        _;
    }

    /// @notice DEMONSTRATION of the buyer pattern end-to-end: auto-honor `ref` ONLY when the CALLER
    ///         clears the gate; below the threshold this reverts (fail closed) and the caller routes the
    ///         claim to manual review. Gating on `msg.sender` mirrors the §5 use case ("the CLAIMING
    ///         address holds >= N"): because the SBT credits every point to the backing record's own
    ///         contributor — NEVER to whoever paid gas to mint it — a stranger cannot buy their way past
    ///         this gate; only the address that provably made the contributions can clear it.
    /// @param  ref an opaque reference to the claim being honored (never interpreted on-chain).
    /// @return honored always `true` on success (the call reverts otherwise).
    function autoHonor(bytes32 ref) external gated(msg.sender) returns (bool honored) {
        emit Honored(msg.sender, ref);
        return true;
    }
}
