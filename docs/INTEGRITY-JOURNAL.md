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

## Transparency-log proofs (publish a tree head; auditors verify offline)

The chain above answers *"is my copy of the whole log intact?"* — but the checker must hold (and re-walk)
the **entire** journal. The transparency-log surface adds the second half a real transparency log needs: an
**RFC-6962 / Certificate-Transparency-style ordered Merkle tree** over the journal's entry hashes — the same
lineage as CT's certificate logs and Sigstore's **Rekor** — so that:

- a single **tree head** `{ size, root }` (one 32-byte root + a count) commits to the **whole ordered log**;
- **inclusion** of any one entry under that head is provable with an O(log n) path — the auditor never needs
  the log;
- **consistency** between an old head (size *m*) and a new head (size *n*) is provable with an O(log n)
  path — proving the size-*n* log is an **append-only extension** of the size-*m* log, i.e. **no history was
  rewritten** between the two heads. A hash-chain alone cannot prove that compactly.

**This is a deliberately different tree from the file-set tree in `cli/hash.js`.** The seal tree is a
*sorted-leaf, sorted-pair* Merkle root: it commits to a **SET** of files and is intentionally
order-independent. A journal is the opposite — **order is meaning** — so the log tree is
**position-preserving**: leaves stay at their `seq`, interior nodes fold their children in tree order
(never min/max-sorted), with RFC-6962 domain separation (`leaf = keccak256(0x00 ‖ entryHash)`,
`node = keccak256(0x01 ‖ left ‖ right)`). Only a position-binding tree can prove
inclusion-at-a-position or append-only consistency. Same `keccak256` primitive as everything else here —
**no new crypto**; the core is the pure [`cli/journal-log.js`](../cli/journal-log.js) (no fs, no socket,
no key, no clock).

### The four commands

```bash
vh journal tree-head <journalfile> [--json]                                 # print the publishable head { size, root }
vh journal prove-inclusion <journalfile> --seq <i> [--out <f>] [--json]     # emit an inclusion-proof artifact
vh journal prove-consistency <journalfile> --from <m> [--out <f>] [--json]  # emit a consistency-proof artifact
vh journal check-proof <prooffile> [--json]                                 # OFFLINE auditor: ACCEPTED / REJECTED
```

All four are **read-only** and **verify-only** (the only write is the `--out` proof artifact you name); they
hold **no key** and bind **no network**. `tree-head` / `prove-*` first re-verify the hash chain and **refuse**
(exit 3, `BROKEN`) to emit anything over a tampered journal. `check-proof` is the **third-party AUDITOR**
command: it reads **only** the proof artifact — never the journal, never a key, never a socket — so you can
hand an auditor a published tree head plus a proof file and they confirm inclusion / append-only-ness
**without ever holding your log**.

> **What "OFFLINE" means here (independence caveat — read this before selling `check-proof` as "independent").**
> `check-proof` — and `tree-head` / `prove-*` — run in the **producer package**
> (`cli/journal-cli.js` → [`cli/journal-log.js`](../cli/journal-log.js), which `require`s **ethers**), so
> `npm i verifyhash` pulls in the producer stack. "OFFLINE" here means **no network and no log** (the auditor
> holds only the proof artifact) — it does **NOT** mean "no producer stack." These self-contained proof
> artifacts are **not yet** checkable with the zero-dependency standalone [`verifier/`](../verifier/) bundle a
> **seal** enjoys, so a counterparty's security team cannot (today) verify a proof with a light/independent
> client the way a CT/Rekor client can. See the
> [**Independence scope**](#independence-scope--journal-verification-currently-needs-the-producer-package)
> section below.

All four ride the **same 0/3 exit contract** as the table above: `0` = head printed / proof emitted /
proof `ACCEPTED`; `3` = `BROKEN` chain or `REJECTED` proof (fail closed — a forged, edited, or unknown-kind
artifact is always `REJECTED`, never a silent pass); `2` = usage; `1` = IO.

### The proof-artifact schemas

`prove-inclusion` emits `kind: "vh-journal-inclusion"` — everything `check-proof` needs, and **nothing of
the log itself**:

```json
{ "kind": "vh-journal-inclusion",
  "journal": "journal.jsonl",
  "leaf": "0x…(the entryHash being proven)",
  "seq": 1,
  "size": 3,
  "root": "0x…(the head this proof verifies against)",
  "path": ["0x…", "0x…"],
  "note": "…the self-asserted-head note, verbatim…" }
```

`prove-consistency` emits `kind: "vh-journal-consistency"` — the two heads plus the RFC-6962 §2.1.2 proof
that the first is a prefix of the second:

```json
{ "kind": "vh-journal-consistency",
  "journal": "journal.jsonl",
  "first":  { "size": 3, "root": "0x…" },
  "second": { "size": 5, "root": "0x…" },
  "proof": ["0x…", "0x…", "0x…", "0x…"],
  "note": "…the self-asserted-head note, verbatim…" }
```

`check-proof` dispatches on `kind`, re-derives the root(s) from the artifact's own fields, and prints
`ACCEPTED` (exit 0) only when the proof verifies against the head **embedded in the artifact** — so the
auditor must compare that embedded head against a head they trust. Every accept carries this reminder,
verbatim:

> ACCEPTED means the proof verifies against the head EMBEDDED in the artifact; compare that head (size + root) against a tree head you trust (e.g. one the operator published/signed) before relying on it

### Worked example (copy-pasteable, end-to-end)

```bash
# 0) something to observe: seal a directory into an evidence packet (any *.vhevidence.json works)
mkdir -p bundle && printf 'hello\n' > bundle/a.txt && printf 'world\n' > bundle/b.txt
vh evidence seal ./bundle --out ./bundle/release.vhevidence.json

# 1) append THREE observations (three hash-chained verify verdicts)
vh journal append ./bundle/release.vhevidence.json --to journal.jsonl
vh journal append ./bundle/release.vhevidence.json --to journal.jsonl
vh journal append ./bundle/release.vhevidence.json --to journal.jsonl

# 2) publish the head — one { size, root } line commits to the whole ordered log
vh journal tree-head journal.jsonl
#   tree head of journal.jsonl: { size: 3, root: 0x49714d…e409d2 }

# 3) prove entry seq 1 is committed at that position under that head
vh journal prove-inclusion journal.jsonl --seq 1 --out seq1.inclusion.json

# 4) the AUDITOR checks it OFFLINE — the proof file is ALL they get (no journal, no key, no network;
#    "OFFLINE" = no network/log, still the PRODUCER package (installs ethers), NOT the standalone verifier/ —
#    see "Independence scope" below)
vh journal check-proof seq1.inclusion.json        # ACCEPTED (exit 0)

# 5) keep working: append TWO more observations (the log grows 3 → 5)
vh journal append ./bundle/release.vhevidence.json --to journal.jsonl
vh journal append ./bundle/release.vhevidence.json --to journal.jsonl

# 6) prove the size-5 log is an APPEND-ONLY extension of the size-3 log the auditor already saw
vh journal prove-consistency journal.jsonl --from 3 --out 3-to-5.consistency.json

# 7) the auditor checks THAT offline too — no history was rewritten between the two heads
vh journal check-proof 3-to-5.consistency.json    # ACCEPTED (exit 0)
```

(Your `root` values will differ from any printed here: every `entryHash` folds in the self-asserted `ts` of
that run. Tamper with any byte of a proof artifact — or hand `check-proof` a proof forged against a
different head — and it prints `REJECTED`, exit 3.)

### Honesty boundary — the head is SELF-ASSERTED (what these proofs do and do NOT mean)

- **Inclusion** proves an observation is **committed at a position (`seq`) under a given head** — nothing
  more.
- **Consistency** proves the log is **append-only between two heads** — the second head's log extends the
  first head's log without rewriting it.
- The **tree head itself is SELF-ASSERTED** — it is the verifier's (the log holder's) **own** commitment,
  exactly like the journal's `ts`. Every `tree-head` / `prove-*` output carries this note, verbatim:

> this tree head is SELF-ASSERTED (the log holder's own commitment to its journal as it stands now); it does NOT by itself prove "existed at / unaltered since date T" until a trust-root signs/timestamps the head (P-3)

So a tree head does **not** prove *"existed / unaltered since date T"* on its own — that claim still requires
the **STRATEGY.md P-3** signing/timestamp trust-root, exactly as for the journal's `ts` below. What the
tree head changes is **how little** P-3 has to sign: signing the head **is** the P-3 collapse of
"sign the whole log" down to "sign 32 bytes" — once a trust-root signs/timestamps one head, every inclusion
and consistency proof under it inherits that anchor. This is **NO new gate and NO relaxed gate**:
P-3's and P-9's human-owned steps are **unchanged**; the loop still never holds a real key.

The whole surface is test-gated by [`test/journal-log.core.test.js`](../test/journal-log.core.test.js),
[`test/cli.journal-log.test.js`](../test/cli.journal-log.test.js), and the docs-rot guard
[`test/journal-log.docs.test.js`](../test/journal-log.docs.test.js) on every `npx hardhat test`.

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

**A journal does not yet inherit that.** The `vh journal append` / `vh journal verify` commands — **and the
four transparency-log commands `tree-head` / `prove-inclusion` / `prove-consistency` / `check-proof`** — live
in the **producer package** (`cli/journal.js`, and `cli/journal-cli.js` →
[`cli/journal-log.js`](../cli/journal-log.js), which `require`s **ethers**), and `npm i verifyhash` installs
**ethers** as a runtime dependency. So today a recipient who **re-runs** a journal — **or an auditor who runs
`check-proof` on a self-contained proof artifact** — is running the **producer's** package, **not** the buyer-
installable standalone verifier — the standalone tree has **no journal or transparency-log capability yet**. In
particular `check-proof` is **OFFLINE** only in the sense of *no network and no log*, **not** in the sense of
*no producer stack*: the proof artifacts a seal's [`verifier/`](../verifier/) bundle would let a counterparty
check with **zero dependencies** are **not yet** checkable that way. Be honest about this when you hand a
journal — or a proof — to a counterparty: *the chain / proof is verifiable, but with the producer package, not
(yet) with the independent offline bundle a seal enjoys.*

The chain — and the RFC-6962 tree the proofs ride on — is plain `keccak256` over canonical bytes, both of
which the standalone tree **already vendors**, so this gap is closeable: a follow-up adding
`verify-vh journal verify` and a standalone `check-proof` to the [`verifier/`](../verifier/) tree would give
the journal and its transparency-log proofs the same offline, no-ethers independence as seals. Until then,
treat "re-runs the journal" and "checks a proof" as "does so with `verifyhash` installed."

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
