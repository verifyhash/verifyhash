# verifyhash — runnable end-to-end example

One command, zero setup, fully offline:

```bash
node examples/run.js
```

This drives the **real** DataLedger + ProofParcel buyer pipeline against the tiny committed sample data
in this directory, using the **same module entrypoints the `vh` CLI dispatches to** (`cli/dataset.js`,
`cli/parcel.js`) — it is not a brittle shell pipeline of string parsing. It prints a clear **PASS/FAIL**
summary with the produced artifact paths.

## What it runs

- **DataLedger:** `dataset build` → `check --policy` (a PASS against a lenient policy **and** a FAIL
  against a strict one) → `verify` (a MATCH against the untouched sample **and** a MISMATCH after a
  one-byte tamper) → `report` (one filed evidence document) → `attest` (the canonical UNSIGNED bytes).
- **ProofParcel:** `parcel build` → `verify` (MATCH **and** a tamper MISMATCH) → `attest`.

The sample contains **deliberate** problems so the gates have something real to catch:

- `vendored/gpl-snippet.txt` carries a `GPL-3.0` license hint → flagged by `denyLicenses`.
- `data/unlabeled.txt` carries no license hint → flagged by `requireLicense`.

## Where it writes

The committed sample under `examples/` is **read-only** to the script. Everything it produces (manifests,
the report, the unsigned attestation bytes, and the working copies it deliberately tampers) goes to a
fresh **OS temp dir**. Override the location with `VH_EXAMPLE_OUT=/some/path`; keep the artifacts for
inspection with `VH_EXAMPLE_KEEP=1`. **Nothing is ever scattered into the repo working tree.**

## Trust posture (read this — the script will not let you forget it)

The example proves **tamper-evidence** (any edit, rename, add, or remove flips the Merkle root) and emits
the canonical **UNSIGNED** attestation bytes a trust-root would sign. It does **not**, and cannot, prove
*"unaltered since date T"*: that standing claim rides the **human-owned** signing / timestamp / anchor
trust-root (`needs-human`, P-3 in [`STRATEGY.md`](../STRATEGY.md)). The script **references but never
executes** those `sign` / `timestamp` / anchor steps, and says exactly where the human handoff is. See
[`docs/TRUST-BOUNDARIES.md`](../docs/TRUST-BOUNDARIES.md), [`docs/DATALEDGER.md`](../docs/DATALEDGER.md),
and [`docs/PROOFPARCEL.md`](../docs/PROOFPARCEL.md).

## It cannot rot

`test/cli.examples.test.js` runs this example end-to-end against the committed sample on every
`npx hardhat test`, asserting the pipeline completes, the policy violation is flagged, the tamper is
caught, and the run leaves the working tree clean.
