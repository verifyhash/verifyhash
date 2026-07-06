# verify-vh (Rust) — fourth, independent evidence-seal verifier

A clean-room re-implementation of the verifyhash **evidence-seal** verifier in pure
Rust. It shares **zero code, zero crates, zero hash library, zero EC library** with
the shipped JS verifier (`verifier/verify-vh.js`), the Python verifier
(`verifier-py/verify_vh.py`), and the Go verifier (`verifier-go/`). It was written
from `../SPEC.md` (the extracted format spec) plus black-box runs of the reference
CLI — not translated from any of the other three codebases.

- **ZERO external crates.** `Cargo.toml` has no `[dependencies]` section at all, and
  `Cargo.lock` contains exactly one package: this one. Everything below the CLI is
  hand-rolled in-tree:
  - `keccak.rs` — keccak256, the *Ethereum/original-Keccak* variant (`0x01`
    domain padding, NOT NIST SHA3-256's `0x06`), from the Keccak-f[1600]
    permutation spec.
  - `field.rs` — a hand-rolled 256-bit unsigned integer (`U256`, four `u64`
    limbs) with modular add/sub/mul/pow/inverse, used with both the secp256k1
    field prime `p` and the group order `n`. Rust's std has no bignum; this is it.
  - `secp256k1.rs` — ECDSA public-key recovery per SEC 1 v2.0 §4.1.6 over the
    `field.rs` arithmetic, affine coordinates, matching the reference math
    directly.
  - `json.rs` — a minimal recursive-descent JSON parser (std has no JSON either).
  - `merkle.rs` — path-bound leaves + sorted-pair root, identical semantics to the
    other three implementations.
  - `main.rs` — CLI, verdict engine, human + `--json` rendering.
- **~1,780 lines across 6 files**, no `unsafe` anywhere — small enough for an
  auditor to read in one sitting, in the language a security-conscious buyer is
  most likely to trust reading.

## CLI + exit contract (identical to the JS, Python, and Go verifiers)

```
verify-vh <artifact> [--vendor <0xaddr>] [--dir <files>] [--exact-dir] [--json]
```

| exit | meaning |
|------|---------|
| `0`  | ACCEPT — every sealed file re-derives, the recomputed Merkle root equals the sealed root, and (if signed + `--vendor` pinned) the EIP-191-recovered signer equals the pinned vendor |
| `3`  | REJECT — `CHANGED` / `MISSING` / `path_escape` / `root_mismatch` / `bad_signature` / `wrong_issuer` / `unsigned_cannot_pin_vendor` |
| `2`  | usage — bad flags, malformed `--vendor`, unrecognized artifact kind |
| `1`  | IO — unreadable artifact, invalid JSON, structurally malformed seal |

`--json` emits the same result-object shape as the other verifiers (`verdict`,
`reason`, `accepted`, `recoveredSigner`,
`counts{matched,changed,missing,escaped,unexpected}`, …), so verdicts are
byte-comparable across all four implementations.

## Building with the pinned offline toolchain

The binary here was built and conformance-tested with **rustc 1.79.0
(129f3b996 2024-06-10), x86_64-unknown-linux-gnu** — the pinned toolchain
installed under this scratchpad's `rustup`/`cargo` homes. The build is fully
offline; because there are zero dependencies, `--offline` succeeding *proves*
nothing is ever fetched:

```sh
export RUSTUP_HOME=/path/to/pinned/rustup     # scratchpad: ../../rustup
export CARGO_HOME=/path/to/pinned/cargo       # scratchpad: ../../cargo
export CARGO_NET_OFFLINE=true
export PATH="$CARGO_HOME/bin:$PATH"
cd verifier-rs
cargo build --release --offline
# -> target/release/verify-vh
```

Any Rust toolchain ≥ the 2021 edition reproduces the build; pin the exact
toolchain (rustc 1.79.0 + its published SHA-256) when the binary itself must be
attestable.

## 4-way conformance result (`../conformance-4way.py` over the frozen vectors)

The harness runs JS, Python, Go, and Rust against every frozen vector
(`../../go-verifier/vectors/`) and requires a byte-identical verdict + exit
across all four, reporting each against the vector's frozen expected outcome.
Both the Go and Rust release binaries were already present (the harness
self-builds them, offline, if missing). Current result: **PASS (harness exit 0)
— full 4-way agreement on all 6 cases.**

```
case             | JS         | PY         | GO         | RUST       | expected
-----------------+------------+------------+------------+------------+----------
genuine-single   | OK/0       | OK/0       | OK/0       | OK/0       | ACCEPT/0
genuine-multi    | OK/0       | OK/0       | OK/0       | OK/0       | ACCEPT/0
tampered-file    | REJECTED/3 | REJECTED/3 | REJECTED/3 | REJECTED/3 | REJECT/3
wrong-vendor     | REJECTED/3 | REJECTED/3 | REJECTED/3 | REJECTED/3 | REJECT/3
missing-file     | REJECTED/3 | REJECTED/3 | REJECTED/3 | REJECTED/3 | REJECT/3
extra-file       | OK/0       | OK/0       | OK/0       | OK/0       | REJECT/3   <== known-gap
```

- 5 of 6 cases match both each other AND the vector's expected verdict/exit.
- `extra-file` was the **known, documented shared spec gap** (not an
  inter-implementation divergence): all four AGREED (OK/exit 0), but the vector
  expects REJECT/3 because in default `--dir` mode every implementation
  re-derives only the packet-*named* files and accepts an unsealed extra file
  (the seal's by-design named-file-set boundary). **CLOSED (T-75.5 + T-77.1):**
  all four verifiers now expose `--exact-dir`, which scans the ENTIRE directory
  and REJECTs (reason `UNEXPECTED`, exit 3) any on-disk file the seal never
  named — under it, `extra-file` goes GREEN in every implementation. The
  harness would exit 1 with a loud DIVERGENCE banner if any implementation
  disagreed with the others, or if any case agreed-but-differed from spec.
  Neither fired.

**Four implementations, four languages (JS / Python / Go / Rust), zero shared
dependencies, one frozen vector suite — and they never disagree.** A customer's
own auditor can write a fifth against the vectors + SPEC and know it is a
verifyhash verifier the moment it passes every case.

## Why Rust, and a note on constant-time

Rust is the implementation a security-conscious buyer most respects: memory-safe
by construction, no `unsafe` in this codebase, no runtime, no GC, and — uniquely
credible here — a lockfile that demonstrably contains *nothing but this crate*.
"Zero crates" is a stronger supply-chain statement in Rust than in any of the
other three ecosystems, because crates.io compromise is the attack a Rust-fluent
auditor is primed to look for.

The hand-rolled field/EC arithmetic here is **deliberately NOT constant-time**
(branchy binary inversion, bit-scanned scalar multiplication) — and that is
correct for this tool. Verification touches only **PUBLIC data**: a published
artifact, the files you already hold, a public signature, and the vendor's
public address. There is no secret on this side of the protocol for a timing
side channel to leak. Constant-time discipline matters on the **SIGNING** side,
where a private key is in play — that is a separate concern, in a separate
codebase, and this verifier never handles key material of any kind.

## Honest scope

- Covers the **evidence-seal path only**: `vh.evidence-seal` and
  `vh.evidence-seal-signed`. Other artifact kinds (trust seal, dataset
  attestation, proof bundle, agent packet, anchored receipt) are out of scope.
- **Same trust boundary** as the other three: it re-derives the keccak root from
  the bytes you hold and recovers the signer with no producer stack. It proves
  tamper-evidence + who vouched — **NOT a trusted timestamp** and not a legal
  opinion. A fourth implementation removes *implementation* trust (no single
  codebase to trust or backdoor); it adds no new trust root beyond the vendor
  key you pin.
