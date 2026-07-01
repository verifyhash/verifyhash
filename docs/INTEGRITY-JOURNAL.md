# The integrity journal — tamper-evident verification OVER TIME (`vh journal`)

Every other verifyhash surface — `vh verify`, `vh evidence verify`, `vh serve-verify`, the SDK, the GitHub
Action — answers one question: **"do these exact bytes match this seal RIGHT NOW?"** and then exits. The
**integrity journal** is the structurally-new capability: an **append-only, hash-chained log of verify
verdicts**. Each run appends one entry; the log is **itself tamper-evident**, so a deleted / edited /
reordered / inserted past entry **breaks the chain** and `vh journal verify` **localizes the first break**.

That is the *"verified **continuously** from run A to run B, and here is the exact entry where one drifted"*
artifact a one-shot verify cannot produce — a standing record a recipient **re-runs**, not a one-time event.

It reuses the **same** hash-chain shape the project already trusts for seals (keccak256 over canonical bytes)
— **no new crypto** is introduced. The core (`cli/journal.js`) is **pure**: no disk I/O, no socket, no key.

---

## The command

```bash
# Record ONE new verdict as a hash-chained line (strictly additive; prior lines are never rewritten):
vh journal append <artifact> --to <journalfile> [--dir <d>] [--ts <ISO>] [--json]

# Walk the whole on-disk chain and report PASS / BROKEN / DRIFTED:
vh journal verify <journalfile> [--json]
```

- `append` **verifies** `<artifact>` (a `*.vhevidence.json` seal / signed container) through the **existing**
  composed verify path and records the resulting verdict as one new line. **Recording a `REJECTED` verdict is
  a successful append** (exit 0) — the journal's job is to faithfully record what it saw; the drift surfaces
  at `verify` time.
- `verify` re-derives every entry hash and walks the chain from genesis to head.

The on-disk format is **newline-delimited JSON (JSONL)** — one entry per line — chosen precisely because an
append is **strictly additive**: `fs.appendFileSync` writes only the new line's bytes and never rewrites a
prior line, so the pre-existing bytes are preserved byte-for-byte.

---

## The entry schema

Each line is one entry:

```json
{ "seq": 0,
  "prevHash": "0x…(32 bytes)",
  "ts": "2026-07-01T00:00:00.000Z",
  "artifact": "dist/release.vhevidence.json",
  "verdict": { "verdict": "ACCEPTED", "…": "the full composed verify envelope, VERBATIM" },
  "entryHash": "0x…(32 bytes)" }
```

| field       | meaning |
|-------------|---------|
| `seq`       | 0-based position in the journal (a genesis append is `seq` 0). Must equal the line's index. |
| `prevHash`  | the **prior** entry's `entryHash`, or the genesis constant for `seq` 0. |
| `ts`        | a **self-asserted** wall-clock instant the caller supplies (see the honesty boundary below). |
| `artifact`  | a caller-supplied label for **what** was observed (a path / id). Stored verbatim. |
| `verdict`   | the verify verdict recorded, stored **verbatim** (deep-equal to the composed verify output). |
| `entryHash` | `keccak256(canonical({ schema, seq, prevHash, ts, artifact, verdict }))` — the chain link. |

Constants (stable; a schema bump requires a breaking-change version):

- **schema tag** folded into every `entryHash`: `vh.integrity-journal/v1`
- **genesis domain** (the `seq` 0 `prevHash` is `keccak256` of this fixed string): `vh.integrity-journal/v1:genesis`

The preimage is serialized with a **recursive, key-sorted, deterministic** JSON encoder, so two logically
identical observations hash identically regardless of key insertion order, while remaining a total, injective
encoding of the value.

---

## The chain guarantee

Because each `entryHash` folds in `prevHash`, **every `entryHash` commits to the entire prefix before it**.
Therefore:

- **Editing any past field** (a `verdict`, `ts`, `artifact`, `seq`, or `prevHash`) makes that entry's
  `entryHash` no longer re-derive from its contents → **break localized at that `seq`**.
- **Deleting / reordering / inserting** an entry shifts a `seq` or a `prevHash` → **break localized** at the
  first offending index.
- A **hand-edit into non-JSON** on a line is caught as a malformed entry → **BROKEN**.

`vh journal verify` **never returns a false PASS**: any deviation yields a non-zero exit naming the drifted
artifact + the `seq` where it drifted + `brokenAt` (the index). A false positive is treated as a security bug.

Two distinct failure modes, both non-zero (exit 3):

- **BROKEN** — the hash-chain itself was tampered (a deleted / reordered / inserted / hand-edited past line).
  A broken chain means **none** of the recorded verdicts can be trusted; this takes precedence.
- **DRIFTED** — the chain is **intact** (every recorded observation is authentic + in order) but some
  recorded observation's verdict was **not `ACCEPTED`**. This is the "integrity over time" signal: the
  artifact was recorded continuously and one observation FAILED. A one-shot verify cannot produce this.

**PASS** requires **both**: the chain is unbroken **and** every recorded observation was `ACCEPTED`.

---

## The 0/3 exit-code contract

`vh journal` uses the **same** `0` / `3` CI-exit contract as `vh verify` / `vh evidence verify`, so it drops
into an existing pipeline unchanged:

| exit | name | meaning |
|------|------|---------|
| `0`  | PASS | `verify`: unbroken chain, every observation `ACCEPTED`. `append`: recorded cleanly (of any verdict). |
| `3`  | BROKEN / DRIFTED | `verify`: the chain was tampered **or** a recorded observation was `REJECTED`. Block the merge. |
| `2`  | USAGE | misconfiguration (missing argument / bad flag). Never a silent pass. |
| `1`  | IO | a file could not be read/written. Never a silent pass. |

A green pipeline therefore MEANS "the artifact has verified continuously across every recorded run, and the
record itself is tamper-evident."

---

## Honesty boundary — the `ts` is SELF-ASSERTED, and is NOT a timestamp

The journal proves **ordering + continuity of the verifier's OWN observations** and the **tamper-evidence of
the record**. It does **not** prove *when* an observation happened: **the `ts` is SELF-ASSERTED — the
verifier's own wall clock — and is NOT a trusted timestamp.** A caller can supply any `ts`; the journal only
commits to whatever value it was given, in order.

Consequently **the journal NEVER claims "unaltered since date T" on its own.** That claim requires a
**trust-root** that independently signs and/or timestamps the `ts` — the human-owned step in **STRATEGY.md
P-3** (a self-managed signing key, an RFC-3161 timestamp authority, or an on-chain anchor). Until that
trust-root is applied, the honest reading is: *"these observations occurred in this order and the record has
not been tampered with"*, **not** *"unaltered since date T"*.

To upgrade to a stronger claim, sign/timestamp the journal head (or the individual `entryHash`es) with your
provisioned P-3 trust-root; the journal's ordering guarantee then rides on top of an independent "existed by
date T" attestation. That provisioning is a **human** step (the loop never holds a real key), documented in
STRATEGY.md **P-3**.

This is the same trust boundary the rest of the toolkit carries: a seal proves **tamper-evidence**, a
signature proves **who vouched**, and **neither is a trusted timestamp** without P-3. See
[docs/TRUST-BOUNDARIES.md](./TRUST-BOUNDARIES.md).

---

## Independence scope — journal verification currently needs the producer package

A **seal** is independently re-verifiable **offline** with the **zero-dependency standalone verifier**
([`verifier/verify-vh.js`](../verifier/verify-vh.js) + its vendored keccak) — no ethers, no hardhat, no
producer stack; that is the "check it yourself" promise of the [`verifier/`](../verifier/) tree.

**A journal does not yet inherit that.** The `vh journal append` / `vh journal verify` commands live in the
**producer package** (`cli/journal.js`), and `npm i verifyhash` installs **ethers** as a runtime dependency.
So today a recipient who **re-runs** a journal is running the **producer's** package, **not** the buyer-
installable standalone verifier — the standalone tree has **no journal capability yet**. Be honest about this
when you hand a journal to a counterparty: *the chain is verifiable, but with the producer package, not (yet)
with the independent offline bundle a seal enjoys.*

The chain is plain `keccak256` over canonical bytes — both of which the standalone tree **already vendors** —
so this gap is closeable: a follow-up adding `verify-vh journal verify` to the standalone tree would give the
journal the same offline, no-ethers independence as seals. Until then, treat "re-runs the journal" as
"re-runs it with `verifyhash` installed."

---

## Drop it into CI

The journal is a **continuous-integrity** gate: each run appends this build's verdict, then verifies the
whole chain, and fails the build on a broken chain or a recorded drift.

- a dependency-free runnable step — [`examples/journal-ci.js`](../examples/journal-ci.js)
  (appends two hash-chained entries, verifies an unbroken chain, exits 0);
- a shell CI gate — [`verifier/ci/journal.generic.sh`](../verifier/ci/journal.generic.sh)
  (`bash -n` valid; exits 0 on an unbroken chain, non-zero (3) after a tampered artifact appends a REJECT);
- a GitHub Actions gate — [`verifier/ci/journal.github-actions.yml`](../verifier/ci/journal.github-actions.yml)
  (persists the journal across runs via a **rolling** `actions/cache` key + `restore-keys` fallback, so the
  chain genuinely accumulates — a **static** cache key would freeze the journal at one entry, because GitHub
  caches are immutable and a same-key hit skips the post-job save).

**Persist the journal file between runs** (a cache, a committed file, or a stored build artifact) so the
chain accumulates — a fresh journal each run only ever proves a single observation.

The whole surface is test-gated by [`test/journal.example.test.js`](../test/journal.example.test.js) and
[`test/cli.journal.test.js`](../test/cli.journal.test.js) on every `npx hardhat test`, so it can never rot.
