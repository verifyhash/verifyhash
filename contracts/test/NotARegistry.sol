// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @title NotARegistry — a TEST-ONLY stub that is NOT a verifyhash ContributionRegistry.
/// @notice Used by test/cli.registry.test.js to prove the T-11.2 identity preflight rejects a
///         DEPLOYED-but-wrong contract. It deliberately:
///           - has NO `REGISTRY_ID()` / `REGISTRY_VERSION()` markers (so the identity probe reverts);
///           - exposes a `getRecord(bytes32)` that LIES (returns a plausible-looking record for ANY
///             hash) so that, WITHOUT the preflight, a read command would happily report garbage.
///         The whole point of T-11.2 is that `assertRegistry` refuses to trust this contract's records
///         BEFORE ever calling getRecord, so the lie is never surfaced.
/// @dev    This is in `contracts/test/` and is never deployed to any real network — local/in-memory
///         hardhat only. It adds NO surface to the real registry.
contract NotARegistry {
    // Mirror the real registry's Record struct shape closely enough that a naive caller could decode a
    // getRecord() return — proving the identity check, not the decode, is what saves us.
    struct Record {
        address contributor;
        bool authorBound;
        uint64 timestamp;
        uint64 blockNumber;
        string uri;
        bytes32 parent;
    }

    /// @notice A LYING getRecord: returns a fabricated record for ANY hash. A read command that did not
    ///         authenticate the contract first would report this fake contributor as truth.
    function getRecord(bytes32) external view returns (Record memory) {
        return Record({
            contributor: address(0xbadC0FFEE0dDF00dbADC0FfEe0DdF00DbAdC0FFE),
            authorBound: true,
            timestamp: uint64(block.timestamp),
            blockNumber: uint64(block.number),
            uri: "https://evil.example/lie",
            parent: bytes32(0)
        });
    }

    /// @notice Also lies that everything is anchored, so a verify-proof on-chain leg would falsely pass
    ///         too — again, only reachable if the identity preflight is (wrongly) skipped.
    function isAnchored(bytes32) external pure returns (bool) {
        return true;
    }

    function total() external pure returns (uint256) {
        return 1;
    }

    // NOTE: intentionally NO REGISTRY_ID(), NO REGISTRY_VERSION(), NO supportsInterface(). Calling those
    // on this contract reverts (no matching selector), which is exactly the clean "identity check
    // failed" negative assertRegistry turns into a hard error.
}

/// @title LyingRegistryId — a stub that DOES expose REGISTRY_ID/REGISTRY_VERSION but returns the WRONG
///        id, proving the preflight rejects a contract that *claims* to be a registry but isn't.
contract LyingRegistryId {
    /// @notice A bogus REGISTRY_ID that does NOT equal the documented verifyhash id.
    bytes32 public constant REGISTRY_ID =
        0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef;
    uint256 public constant REGISTRY_VERSION = 1;

    function getRecord(bytes32) external view returns (
        address contributor,
        bool authorBound,
        uint64 timestamp,
        uint64 blockNumber,
        string memory uri,
        bytes32 parent
    ) {
        return (address(0xDEAD), false, uint64(block.timestamp), uint64(block.number), "x", bytes32(0));
    }
}

/// @title LyingReputationId — a stub that DOES expose REPUTATION_ID (so the probe CALL succeeds) but
///        returns the WRONG id, proving ReputationGate's constructor rejects a contract that *claims* to
///        be a ReputationSBT but isn't (the NotAReputationSBT path, distinct from a missing-marker revert).
/// @dev   Also stubs the reputation reads the gate would use, so the only thing that saves a naive
///        consumer is the identity probe refusing this contract BEFORE trusting any number it reports.
contract LyingReputationId {
    /// @notice A bogus REPUTATION_ID that does NOT equal keccak256("verifyhash.ReputationSBT.v1").
    bytes32 public constant REPUTATION_ID =
        0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef;

    function points(address) external pure returns (uint256) {
        return 999; // would wave everyone through if the gate ever trusted it
    }

    function meetsThreshold(address, uint256) external pure returns (bool) {
        return true; // ...same lie via the gate predicate
    }
}
