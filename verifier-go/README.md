# verify-vh (Go) — third, independent evidence-seal verifier

A clean-room re-implementation of the verifyhash **evidence-seal** verifier in pure Go.
It shares **zero code, zero hash library, zero EC library** with the shipped JS verifier
(`verifier/verify-vh.js`) and the Python verifier (`verifier-py/verify_vh.py`). It was
written from `../verifier-py/SPEC.md` (the extracted format spec) plus black-box runs of the
reference CLI — not translated from either codebase.

- **Zero dependencies.** `go.mod` has no `require` block at all. keccak256 (the
  Ethereum/original-Keccak `0x01` padding, NOT NIST SHA3-256) is implemented in-tree
  from the Keccak-f[1600] permutation spec (`keccak.go`); secp256k1 ECDSA public-key
  recovery (SEC 1 v2.0 §4.1.6) is implemented over `math/big` (`secp256k1.go`).
  Standard library only — a build with `GOPROXY=off` succeeds, which *proves* no
  module is ever fetched.
- **~1,150 lines total** across 5 files: `main.go` (CLI + human rendering),
  `verify.go` (verdict engine), `merkle.go` (path-bound leaves + sorted-pair root),
  `keccak.go`, `secp256k1.go`. Small enough for an auditor to read in one sitting.

## CLI + exit contract (identical to the JS and Python verifiers)

```
verify-vh <packet> [--vendor <0xaddr>] [--dir <files>] [--exact-dir] [--json]
```

| exit | meaning |
|------|---------|
| `0`  | ACCEPT — every sealed file re-derives, the recomputed Merkle root equals the sealed root, and (if signed + `--vendor` pinned) the EIP-191-recovered signer equals the pinned vendor |
| `3`  | REJECT — `CHANGED` / `MISSING` / `path_escape` / `root_mismatch` / `bad_signature` / `wrong_issuer` / `unsigned_cannot_pin_vendor` |
| `2`  | usage — bad flags, malformed `--vendor`, unrecognized artifact kind |
| `1`  | IO — unreadable artifact, invalid JSON, structurally malformed seal |

`--json` emits the same result-object shape as the JS verifier (`verdict`, `reason`,
`accepted`, `recoveredSigner`, `counts{matched,changed,missing,escaped,unexpected}`, …),
so verdicts are byte-comparable across implementations.

## Building with the pinned toolchain

`go.mod` pins the language level (`go 1.22`). These sources were built and
conformance-tested with **go1.22.5 linux/amd64**. Hermetic build — no network, no module
proxy, reproducible output:

```sh
export GOROOT=/path/to/go1.22.5          # pinned toolchain
export PATH="$GOROOT/bin:$PATH"
cd verifier-go
GOPROXY=off GOFLAGS=-mod=mod CGO_ENABLED=0 go build -trimpath -o verify-vh .
```

`GOPROXY=off` makes any dependency fetch a hard build error (there are none);
`CGO_ENABLED=0 -trimpath` gives a static, path-independent binary. Any Go ≥ 1.22
reproduces the build; pin the exact toolchain (e.g. go1.22.5 + its published SHA-256)
when the binary itself must be attestable.

## Conformance (frozen vectors: `../verify-vectors/`)

The canonical harness is now `../verify-vectors/conformance-4way.py` (JS, Python, Go,
Rust — every implementation present on the machine), and the repo's CI runs the same
matrix on every test run (`../test/conformance-multilang.test.js`). The table below
records the ORIGINAL 3-way (JS/Python/Go) run this implementation landed with — it
required byte-identical verdict + exit across all three AND agreement with the
vector's frozen expected outcome, and came back **5/6 conformant** — the failure
being the interesting part (since CLOSED; see below).

```
CASE             | EXPECTED  | JS        | PY        | GO        | STATUS
genuine-single   | ACCEPT/0  | ACCEPT/0  | ACCEPT/0  | ACCEPT/0  | OK
genuine-multi    | ACCEPT/0  | ACCEPT/0  | ACCEPT/0  | ACCEPT/0  | OK
tampered-file    | REJECT/3  | REJECT/3  | REJECT/3  | REJECT/3  | OK
wrong-vendor     | REJECT/3  | REJECT/3  | REJECT/3  | REJECT/3  | OK
missing-file     | REJECT/3  | REJECT/3  | REJECT/3  | REJECT/3  | OK
extra-file       | REJECT/3  | ACCEPT/0  | ACCEPT/0  | ACCEPT/0  | **DIVERGE**
```

**Cross-language conformance is clean:** JS ≡ PY ≡ GO on raw verdict string, exit
code, recomputed root, and counts on *every* case — the three implementations never
disagree with each other. The single failure is a **shared blind spot against the
spec**: `extra-file` injects `UNEXPECTED-injected.txt` that the seal never committed.
The `--dir` mode all three standalone verifiers expose re-derives only the
packet-**named** files (4 matched, `unexpected: 0`) and ACCEPTs — but the frozen
vector (and the canonical `vh evidence verify-signed` gate, which rebinds against a
FULL directory scan) requires REJECT (`failedCheck: manifestBindsAttestation`).

**CLOSED (T-75.5 + T-77.1):** all four verifiers now expose `--exact-dir`, which
scans the ENTIRE directory and REJECTs (reason `UNEXPECTED`, exit 3) any on-disk
file the seal never named — under it, `extra-file` goes GREEN (REJECT/3, matching
the vector) in every implementation. The default `--dir` mode keeps the seal's
honest named-file-set semantics (the table above records the pre-fix run). The
harness catching a real, latent, implementation-wide divergence is precisely what
the vectors exist for.

## Honest scope

- Covers the **evidence-seal path only**: `vh.evidence-seal` and
  `vh.evidence-seal-signed`. Other artifact kinds (trust seal, dataset attestation,
  proof bundle, agent packet, anchored receipt) are out of scope.
- **Same trust boundary** as the JS verifier: it re-derives the keccak root from the
  bytes you hold and recovers the signer with no producer stack. It proves
  tamper-evidence + who vouched — **NOT a trusted timestamp** and not a legal
  opinion. A third implementation removes *implementation* trust (no single codebase
  to trust or backdoor); it adds no new trust root beyond the vendor key you pin.
