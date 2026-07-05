# verifier-py — an independent Python verifier for verifyhash evidence seals

## What this is

A second, **independent** implementation of the verifyhash evidence-seal verifier, in
Python, that cross-checks the JS verdict. `verify_vh.py` is a clean-room port written
against `../SPEC.md` (which was itself derived from `verifier/verify-vh.js` and its
libs, then confirmed by executing the real verifier). It does the same job as
`verify-vh`:

- re-derives the keccak256 Merkle root from the **bytes you actually hold** (it never
  trusts the hashes stored in the artifact),
- recovers the EIP-191 signer with its own secp256k1 public-key-recovery routine,
- pins the recovered signer against the `--vendor` address you supply out of band,
- prints a deterministic ACCEPT/REJECT verdict with the same exit-code contract as the
  JS verifier: `0 = ACCEPT`, `3 = REJECT`, `2 = usage error`, `1 = IO/structural error`.

**Zero dependencies.** keccak256 (Ethereum padding, domain byte `0x01` — not NIST
SHA-3's `0x06`) and secp256k1 recovery (SEC 1 §4.1.6) are both implemented in pure
Python in this one file, so the whole verifier is auditable and runs on a stock
CPython 3.10+ with nothing installed. See `DEPENDENCIES.md`.

Because it shares no code, no hash library, and no elliptic-curve library with the JS
verifier, an agreement between the two is meaningful: a bug or a backdoor would have to
be independently reproduced in both implementations to go unnoticed.

## How to run

Verify a packet (same flags as `verify-vh`):

```sh
python3 verify_vh.py <packet.vhevidence.json> --vendor 0xYourVendorAddr [--dir <files-dir>] [--json]
echo $?   # 0 = ACCEPT, 3 = REJECT
```

Run the differential conformance harness (needs `node` + the verifyhash repo, because
it seals a fresh genuine packet via `node cli/vh.js evidence seal` and then runs BOTH
verifiers on identical inputs):

```sh
python3 conformance.py
echo $?   # 0 = all cases agree AND match expectations; 1 = any divergence
```

The harness is self-contained: each run builds a fresh workspace under
`../conformance-ws/`, seals a genuine signed packet, derives the four cases from it,
runs both verifiers with `--json`, and compares (a) the ACCEPT/REJECT decision, (b) the
process exit code, and (c) the machine-readable `verdict` + `reason` strings. It writes
only under the `py-verifier/` tree and only reads/executes files from the repo.

## Conformance result: PASS — no divergence

| case | expected | JS (verify-vh.js) | PY (verify_vh.py) | reason | result |
|------|----------|-------------------|-------------------|--------|--------|
| genuine + correct vendor | ACCEPT/0 | ACCEPT/0 | ACCEPT/0 | OK | PASS |
| tampered file (1 byte flipped) | REJECT/3 | REJECT/3 | REJECT/3 | CHANGED | PASS |
| correct packet + WRONG vendor | REJECT/3 | REJECT/3 | REJECT/3 | wrong_issuer | PASS |
| missing referenced file | REJECT/3 | REJECT/3 | REJECT/3 | MISSING | PASS |

All 4 cases: the verifiers agree with each other AND match the expected verdict —
byte-identical ACCEPT/REJECT decision and exit code. The two `--json` payloads are also
structurally identical; the only raw-byte difference is the em-dash in the boilerplate
`note` field (JS emits `—` literally, Python escapes it as `—` — the same decoded
string, and not part of the verdict).

**Divergence surfacing was proven live**, not assumed: with the Python side swapped for
a stub that always returns ACCEPT/0, the harness caught it on all 3 REJECT cases,
printed the loud `!!! DIVERGENCE(S): THE TWO VERIFIERS DISAGREE !!!` banner naming each
case with both sides' exit/accepted/verdict/reason and stdout heads, and exited 1. A
real disagreement cannot pass silently.

## The FIPS angle

The current format hashes with Ethereum keccak256, which is **not** a FIPS-approved
algorithm. If a FIPS-friendly hash variant is ever added to the seal format, this
verifier is already positioned for it: Python's standard-library `hashlib` ships
FIPS-approved `sha256` and `sha3_256` (NIST SHA-3) out of the box, so a compliant
variant would need no new dependencies here — only the domain-separation constants and
a variant tag. (The pure-Python keccak in this file exists precisely because stdlib
SHA-3 is *not* Ethereum keccak; the two differ only in the padding domain byte.)

## Honest scope — what this does NOT prove

Same trust boundary as `verify-vh`, no more:

- **NOT a trusted timestamp.** An ACCEPT means "these exact bytes match the seal, and
  the seal was signed by the key behind the pinned vendor address." It says nothing
  about *when* the seal was created. Backdating claims are only constrained by an
  on-chain anchor of the root, which is a separate step this verifier does not check.
- **The vendor address is your responsibility.** You must obtain the `--vendor` address
  out of band (from the vendor's site, contract, or another channel you trust). Pinning
  an attacker-supplied address verifies the attacker.
- **Key compromise is out of scope.** If the vendor's signing key leaks, seals signed
  with it still ACCEPT.
- **It verifies the files the seal references.** Files outside the seal's file list are
  invisible to it.

What the second implementation adds is confidence in the *verifier logic itself*: the
verdict no longer rests on a single codebase, hash implementation, or EC library.
