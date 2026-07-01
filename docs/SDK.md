# verifyhash SDK — the stable, semver-guarded public API

`require("verifyhash")` gives a downstream program the **exact same** functions the `vh` CLI runs — no
fork, no second implementation. `index.js` is a *thin, identity re-export* of the already-built,
already-tested core (proven by `test/sdk.index.test.js`): every symbol below is the same function object
the corresponding `cli/…` module exports, so a seal built with `sdk.buildSeal(...)` verifies (`ACCEPTED`)
with `sdk.verifySeal(...)` and a one-byte tamper is `REJECTED` — identical to `vh evidence seal` /
`vh evidence verify`.

This file is the **canonical reference for the SDK's public surface**, and it is machine-checked: the
[machine-checked surface descriptor](#machine-checked-surface-semver--abi-contract) below is *generated*
from the live `index.js` exports by [`scripts/gen-sdk-surface.cjs`](../scripts/gen-sdk-surface.cjs) and
byte-matched against them by [`test/sdk.contract.test.js`](../test/sdk.contract.test.js), so it cannot
silently drift from the code.

---

## Stability & semver policy

The **ABI** re-exported from `index.js` **is** the package's stability contract. The guard pins the
contract a downstream program *actually integrates against* — not just symbol names, but the three things
whose silent drift would break a consumer without a loud rename:

- **Anything listed below is PUBLIC.** Removing it, renaming it, or moving it between namespaces is a
  **breaking change** and requires a **semver-major** version bump. So is changing its *kind*
  (e.g. a `function` becoming a `string`).
- **Function arity is pinned** (`name : function/<arity>`). Adding a *required* parameter to an exported
  function — e.g. `verifySeal(seal, entries)` → `verifySeal(seal, entries, opts)` — changes its **call
  signature** and is a breaking change, even though the name and kind are unchanged.
- **Frozen wire values are pinned** (`name : string="…"` / `number=…`). The seal **kind tag**
  (`seal.KIND`), the **schema versions** (`seal.SCHEMA_VERSION`, `receipts.SCHEMA_VERSION`), the receipt
  kind tags, and the `TRUST_NOTE` are constants a consumer hard-codes or branches on; bumping one is a
  wire-format change, so the pin catches it. (A schema bump 1→2 keeps `number` as the kind — a name-only
  guard would miss it; this one does not.)
- **The `verifySeal` result shape is pinned** (`#verifySeal.result : <sorted keys>`). A consumer
  destructures `{ verdict, accepted, changed, … }`; dropping or renaming a result key is a breaking
  change to the return contract, and the descriptor's behavioral tail catches it.
- **Adding a new symbol** is a minor (backward-compatible) change.
- A **patch/minor** release may freely change a symbol's *behavior-preserving internals* or bump the
  version string. The version is the **one** value intentionally left un-pinned: `apiVersion` is rendered
  by *kind only* (`string`, never its value), so a version bump alone never trips the guard.
- **`apiVersion`** mirrors `package.json`'s `version` field and is the single source of truth for the
  surface's semver number. It is a `string`.
- **Deep `cli/*` internals are NOT part of the stable surface.** Only what `index.js` re-exports (and what
  the `exports` map in `package.json` resolves) is guaranteed. Reaching into `verifyhash/cli/...` is
  reaching into unstable, internal code that may change in any release without a major bump — the
  `exports` map deliberately blocks importing those subpaths by name.

### Changing the surface (one command)

The machine-checked descriptor is **generated, never hand-edited**. When you deliberately change the
surface:

```sh
npm run sdk:surface -- --write   # regenerate the descriptor block in this file from index.js
npm run sdk:surface -- --check   # CI drift gate: exit 1 if this doc has drifted from the exports
npm run sdk:surface              # print the current descriptor to stdout
```

Then paste the regenerated block into the `EXPECTED_SURFACE` pin in
[`test/sdk.contract.test.js`](../test/sdk.contract.test.js) in the **same commit**. The contract test
fails loudly if this document, that pin, and the live `index.js` exports ever disagree — keeping doc ==
pin == code.

---

## The public surface

Grouped for humans. Every function is the **identity** re-export of its `cli/…` source; the flat
top-level names (`buildSeal`, `verifySeal`, …) are the same objects as the grouped ones (`seal.buildSeal`,
`seal.verifySeal`, …), provided for convenience.

### Top level

| Symbol | Kind | Meaning |
| --- | --- | --- |
| `apiVersion` | string | Semver version of this public surface; mirrors `package.json` `version`. |
| `seal` | namespace | The evidence-seal SDK (see below). |
| `receipts` | namespace | The anchor/claim receipt codec + manifest diff (see below). |
| `hashing` | namespace | The keccak/Merkle hashing primitives (see below). |

The flat convenience re-exports at the top level are exactly the members of the three namespaces:
`buildSeal`, `validateSeal`, `serializeSeal`, `readSeal`, `verifySeal`, `PacketSealError` (from `seal`);
`buildReceipt`, `buildAnchorReceipt`, `writeReceipt`, `readReceipt`, `diffManifest` (from `receipts`);
`hashBytes`, `hashFile`, `hashEntries`, `hashDir`, `hashPath`, `buildTree` (from `hashing`).

### `seal` — build / verify a tamper-evident evidence seal

| Symbol | Kind | Meaning |
| --- | --- | --- |
| `seal.KIND` | string | The seal document kind tag. |
| `seal.SCHEMA_VERSION` | number | The seal schema version. |
| `seal.TRUST_NOTE` | string | The one-line trust-boundary note carried in every seal. |
| `seal.buildSeal` | function | `buildSeal(entries)` → seal object, from a flat `{ relPath, bytes }` list. |
| `seal.validateSeal` | function | `validateSeal(seal)` → throws on structural / root-mismatch problems. |
| `seal.serializeSeal` | function | `serializeSeal(seal)` → canonical, byte-deterministic JSON. |
| `seal.readSeal` | function | `readSeal(jsonOrObject)` → parsed + strictly validated seal. |
| `seal.verifySeal` | function | `verifySeal(seal, entries)` → `{ verdict, accepted, … }`; RE-DERIVES the root. |
| `seal.PacketSealError` | function | The error class the generic seal core throws (advanced / custom products). |

### `receipts` — anchor/claim receipt codec + path-bound manifest diff

| Symbol | Kind | Meaning |
| --- | --- | --- |
| `receipts.SCHEMA_VERSION` | number | The receipt schema version. |
| `receipts.CLAIM_RECEIPT_KIND` | string | Kind tag for a commit–reveal claim receipt. |
| `receipts.ANCHOR_RECEIPT_KIND` | string | Kind tag for a one-shot anchor receipt. |
| `receipts.buildReceipt` | function | Build a claim receipt. |
| `receipts.buildAnchorReceipt` | function | Build an anchor receipt. |
| `receipts.writeReceipt` | function | Serialize a receipt to disk (canonical form). |
| `receipts.readReceipt` | function | Read + strictly validate a receipt. |
| `receipts.diffManifest` | function | Path-bound diff of two manifests (ADDED / REMOVED / CHANGED). |

### `hashing` — the keccak / Merkle primitives every seal + receipt is built on

| Symbol | Kind | Meaning |
| --- | --- | --- |
| `hashing.hashBytes` | function | Hash a byte buffer. |
| `hashing.hashFile` | function | Hash a file on disk. |
| `hashing.hashEntries` | function | Hash a list of `{ relPath, bytes }` entries. |
| `hashing.hashDir` | function | Hash a directory tree. |
| `hashing.hashPath` | function | Hash a file-or-directory path. |
| `hashing.buildTree` | function | Build the Merkle tree over leaves. |

---

## Machine-checked surface (semver / ABI contract)

The block below is the **canonical ABI descriptor** of the entire exported surface — one `path : abi` line
per symbol, where `abi` is:

- `function/<arity>` for a function (the trailing number is its **parameter count** — part of the call
  signature);
- `<kind>=<value>` for a frozen constant (`string="…"`, `number=…`) — the exact **wire value** a consumer
  hard-codes (`apiVersion` is the sole exception: rendered `string`, value un-pinned, so a version bump is
  free);
- `namespace` for a grouped object; and a trailing `#verifySeal.result : <sorted keys>` line pinning the
  **result shape** a consumer destructures from `verifySeal`.

[`scripts/gen-sdk-surface.cjs`](../scripts/gen-sdk-surface.cjs) generates this exact block from the live
`index.js` exports (`npm run sdk:surface -- --write`), and [`test/sdk.contract.test.js`](../test/sdk.contract.test.js)
asserts it BYTE-MATCHES both this document and the frozen pin in the test. If you change the surface, the
test prints the drifted line so you can regenerate this block and update the pin together.

<!-- SDK-SURFACE:BEGIN (generated by scripts/gen-sdk-surface.cjs — run `npm run sdk:surface -- --write`) -->
```text
PacketSealError : function/1
apiVersion : string
buildAnchorReceipt : function/1
buildReceipt : function/1
buildSeal : function/1
buildTree : function/1
diffManifest : function/2
hashBytes : function/1
hashDir : function/1
hashEntries : function/1
hashFile : function/1
hashPath : function/1
hashing : namespace
hashing.buildTree : function/1
hashing.hashBytes : function/1
hashing.hashDir : function/1
hashing.hashEntries : function/1
hashing.hashFile : function/1
hashing.hashPath : function/1
readReceipt : function/1
readSeal : function/1
receipts : namespace
receipts.ANCHOR_RECEIPT_KIND : string="verifyhash.anchor-receipt"
receipts.CLAIM_RECEIPT_KIND : string="verifyhash.claim-receipt"
receipts.SCHEMA_VERSION : number=4
receipts.buildAnchorReceipt : function/1
receipts.buildReceipt : function/1
receipts.diffManifest : function/2
receipts.readReceipt : function/1
receipts.writeReceipt : function/2
seal : namespace
seal.KIND : string="vh.evidence-seal"
seal.PacketSealError : function/1
seal.SCHEMA_VERSION : number=1
seal.TRUST_NOTE : string="This evidence seal is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp. Its Merkle `root` commits to the full set of (relPath, content) pairs in the directory: any edit, rename, add, or remove changes the root, and verify RE-DERIVES the root from the bytes you hold and LOCALIZES the change to the exact file (MATCH / CHANGED / MISSING / UNEXPECTED). It does NOT prove WHEN the sealing happened (\"sealed at T\" rides the human-owned signing/timestamp trust-root, STRATEGY.md P-3) and it is NOT a legal opinion. The packet is an UNTRUSTED transport container: verify never trusts the packet's own stored hashes."
seal.buildSeal : function/1
seal.readSeal : function/1
seal.serializeSeal : function/1
seal.validateSeal : function/1
seal.verifySeal : function/2
serializeSeal : function/1
validateSeal : function/1
verifySeal : function/2
writeReceipt : function/2
#verifySeal.result : accepted,changed,counts,matched,missing,recomputedRoot,rootMatches,sealedRoot,unexpected,verdict
```
<!-- SDK-SURFACE:END -->

---

## Trust boundary (unchanged from the CLI — the SDK adds nothing)

A seal proves **tamper-evidence + offline re-compute** ("these exact bytes are what was sealed"), NOT a
trusted timestamp and NOT who authored the bytes. `verifySeal` re-derives the Merkle root from the bytes
**you** supply — never the seal's own stored hashes. See [docs/TRUST-BOUNDARIES.md](./TRUST-BOUNDARIES.md).
