# AgentTrace — tamper-evident, selectively-redactable agent-session evidence (`vh agent`)

AgentTrace turns an **ordered log of AI-agent session events** — prompts, completions, tool calls,
tool results, notes — into **one** tamper-evident, selectively-redactable, independently-verifiable
packet: `*.vhagent.json`. It is the agent-evidence vertical on the same provenance core as every other
verifyhash product, for the buyer who has to *keep* and *show* agent records (compliance/record-keeping,
incident forensics, audit, disputes) and cannot rely on operator-editable observability traces.

This page is the buyer-facing spec: exactly what a packet **proves**, what it does **not** prove, what
is **free vs. paid**, **where a counterparty independently verifies** it, and a committed, test-gated
**worked example** showing that adoption is a ~20-line mapping over the log you already have.

---

## What a `*.vhagent.json` packet PROVES

The packet carries an RFC-6962-style ordered Merkle `head` `{ size, root }` over **redaction-safe**
per-event leaves (each event's payload participates only via its keccak-256 hash commitment). From
that, `vh agent verify` — and the independent verifier, which shares no code with the producer stack —
re-derive everything from the bytes you hold. A green verdict proves, offline:

1. **The log is unaltered since it was sealed.** Every event leaf and the root re-derive from the
   events in the packet; editing, reordering, inserting, or dropping any event is a REJECT that names
   the first offending event `seq`.
2. **Any disclosed event is verbatim as recorded.** A full event's payload hash commitment is
   recomputed from the payload bytes — a one-byte payload edit is a REJECT naming the seq. A
   single-event disclosure (`vh agent prove` → `verify-proof`) binds the event to its exact position
   under the head, so a quoted transcript line can be checked without the rest of the session.
3. **Append-only growth between a checkpoint and the final head.** `vh agent checkpoint` commits the
   session so far; `vh agent verify-growth` proves a later packet extends that checkpoint append-only —
   a rewritten, reordered, dropped, or inserted past is a REJECT. That is the anti-retroactive-edit
   property: the operator cannot quietly rewrite history between checkpoints.
4. **Redaction can only withhold — it can never silently alter.** `vh agent redact` withholds chosen
   payloads behind their hash commitments; leaves and root are UNCHANGED, so the redacted copy still
   verifies (and one head signature stays valid across every redacted copy). A **forged** commitment on
   a redacted event is a REJECT naming the seq. What you cannot see is *declared* withheld — never
   silently substituted.

## What it does NOT prove (read this before relying on a packet)

- **It does NOT prove the log faithfully records what the agent ACTUALLY did — garbage-in is out of
  scope.** The head proves the LOG is intact and append-only since seal. If the software that wrote the
  log lied, omitted events, or was compromised *before sealing*, the packet faithfully preserves that
  lie. Sealing early (checkpoint as the session runs) narrows this window; it never closes it.
- **Event `ts` fields are self-asserted metadata.** They are recorded and bound verbatim, never
  verified against any clock. Order is proven by tree position (`seq`), not by `ts`.
- **NOT a trusted timestamp.** There is no "this session existed at time T" claim without the
  human-owned **P-3** trust-root ([Human-owned steps](TRUST-BOUNDARIES.md#p-3-trust-root), needs-human: a
  provisioned signing key, an RFC-3161 TSA, or an on-chain anchor). A signed head proves *who vouched*
  for the session head, not *when*.
- **NOT a legal opinion**, and not a claim the agent behaved well, safely, or compliantly.

**The same wording rides in-band.** Per the family's trust-note discipline, every packet, checkpoint,
and proof artifact carries this boundary as its `note` field — and `vh agent verify` refuses a packet
whose note has drifted — so the caveat travels with the evidence instead of living only in a doc. The
standing in-band note, verbatim:

> This agent-session packet is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp and NOT a claim the agent behaved well. Its ordered Merkle `head` {size, root} (RFC-6962-style, position-bound) commits to every event: verify RE-DERIVES each event leaf — recomputing the payload hash commitment for a FULL event, checking the carried commitment for a REDACTED one — and the root from the events you hold, and a REJECT names the first offending event seq. Redaction WITHHOLDS a payload behind its hash commitment without changing any leaf or the root: it can hide, never silently alter. Event `ts` fields are SELF-ASSERTED metadata (recorded, never verified against any clock); "sealed at time T" rides the human-owned signing/timestamp trust-root (STRATEGY.md P-3). Garbage-in is out of scope: the head proves the LOG is intact and append-only, not that the log faithfully records what the agent actually did. The packet is an UNTRUSTED transport container: verify never trusts the packet's own stored hashes.

---

## The command surface

```
vh agent seal <session.jsonl> [--out <p>] [--sign (--key-env <VAR>|--key-file <p>) --license <f>] [--json]
vh agent verify <packet> [--vendor <0xaddr>] [--json]          # exit 0 ACCEPTED / 3 named REJECT (+ offending seq)
vh agent redact <packet> --seq <list> [--out <p>] [--json]     # withhold payloads; head UNCHANGED, still verifies
vh agent prove <packet> --seq <n> [--out <p>] [--json]         # disclose ONE event + its inclusion proof
vh agent verify-proof <proof> [--root <hex>] [--json]          # check a disclosure offline against a head you trust
vh agent checkpoint <session.jsonl> [--out <p>] [--json]       # commit the head so far (mid-session)
vh agent verify-growth <earlier-head-or-packet> <later-packet> [--json]  # append-only extension or REJECT
vh agent commit-claim --repo <dir> [--ref <ref=HEAD>] --seq <n> [--ts <iso>] [--actor <s>] [--out <p>] [--json]
                                                               # bind the session to a git commit (FREE, key-less)
vh agent verify-commit <packet> --repo <dir> [--ref <ref>] [--vendor <0xaddr>] [--json]
                                                               # auditor re-derives oid + root from THEIR OWN clone
vh agent coverage --repo <dir> --range <rev-range> --packets <dir> [--deep] [--require-all] [--require-since <oid>] [--out <report>] [--json]
                                                               # the fleet gate: which commits carry a verifiable claim (FREE)
```

The input is JSONL (or a JSON array) of canonical events — a **closed** five-type schema:
`{ seq, ts, actor, type: prompt|completion|tool_call|tool_result|note, payload | payloadHash, redacted?, meta? }`
with `seq` contiguous from 0 (the tree position). Exit codes are the family contract: 0 ok/ACCEPTED,
3 named REJECT or gate-fail, 2 usage, 1 IO/invalid artifact. Artifacts are written only to an explicit
`--out` path, never implicitly to the working directory.

## Free vs. paid (no surprises)

- **FREE — the whole read/verify surface, forever:** unsigned `seal`, `verify`, `redact`, `prove`,
  `verify-proof`, `checkpoint`, and `verify-growth`, plus every independent-verifier path below. Any
  third party can check a packet without paying anyone; redaction and single-event disclosure are free
  because withholding must never cost the *counterparty* anything to check.
- **PAID — `--sign`:** wrapping the packet's head in a detached EIP-191 attestation ("this key vouches
  for THIS session head"), so a recipient can pin YOUR published address with `--vendor`. Because
  leaves are redaction-safe, ONE signature stays valid for every redacted copy. `--sign` is gated
  OFFLINE behind a valid `--license <f>` carrying the DRAFT **`agent_signed`**
  capability — the SAME fail-closed license mechanism as `vh evidence seal --sign` (`vh-evidence-license`
  kind; a missing/invalid/under-entitled license is a named refusal, never a silent downgrade). The
  license is verified against the CANONICAL vendor identity (T-75.3; `cli/core/vendor-identity.js`) —
  a caller `--vendor` must EQUAL it and can NOT re-pin the gate (self-hosters set their own identity;
  see `docs/LICENSING.md`).

The `agent_signed` capability is DRAFT and priceless in the bundled catalog: the vendor key, the price,
and the sale remain the standing human-owned go-live steps of the evidence vertical (P-7/P-8 in
[Human-owned steps](TRUST-BOUNDARIES.md#human-owned-steps), one flip in [`GO-LIVE.md`](GO-LIVE.md)) — this vertical adds **no new
human gate**, and revenue is a license for delivered software value, never a token or tradeable asset.

## Where the buyer independently verifies (no producer stack)

A counterparty handed a `*.vhagent.json` never has to trust the producer's tooling — the packet is
self-contained (no sibling files), and the independent [`verifier/`](../verifier/) tree re-implements
verification against its own keccak with **zero** imports from the producer stack:

```bash
node verifier/verify-vh.js session.vhagent.json                      # unsigned packet — free, offline
node verifier/verify-vh.js session.vhagent.json --vendor 0xPRODUCER  # signed packet, signer PINNED
```

- **Zero-install CLI:** the single self-contained file
  [`verifier/dist/verify-vh-standalone.js`](../verifier/dist/verify-vh-standalone.js) (Node core only)
  gives the same verdict with no clone and no `npm install`.
- **No terminal at all:** the offline browser page
  [`verifier/dist/verify-vh-standalone.html`](../verifier/dist/verify-vh-standalone.html) has a
  built-in agent-session demo (a sample packet with one payload already redacted — verify it, tamper
  one byte on the page, watch the REJECT name the seq) and accepts a dropped real packet; it contains
  no network API at all, so the transcript never leaves the machine.

Exit 0 = ACCEPTED, 3 = REJECTED naming the reason (and the offending event seq when event-local); a
`--vendor` pin on an unsigned packet is a clean REJECT, so a stripped signature never passes a pinned
verify. Details: [`verifier/README.md`](../verifier/README.md) §2c.

---

## Binding a session to a git commit (`commit-claim` / `verify-commit`)

The first question the AI-code-governance / IP-provenance / audit buyer asks of an agent-session
record is: *which code change does this session correspond to — and can I check the record wasn't
doctored?* The commit-binding verbs answer it with machinery the family already ships. A
**commit-claim** is an ORDINARY `note` event whose payload is a canonical claim string naming exactly
ONE git **commit oid** plus that commit's **tracked-set root** — the same clone-reproducible Merkle
root `vh hash <repo> --git` computes over the files git tracks. Appended to the session log *before*
`vh agent seal`, the claim becomes one more redaction-safe leaf under the same head: no new packet
kind, no new crypto, no new dependency.

```bash
# producer (FREE, key-less): derive oid + tracked-set root from YOUR repo, emit ONE JSONL claim event
vh agent commit-claim --repo . --seq <next-seq> >> session.jsonl    # then: vh agent seal session.jsonl …

# auditor (FREE, key-less): re-derive BOTH facts from THEIR OWN clone and check the sealed claim
vh agent verify-commit session.vhagent.json --repo /their/clone     # exit 0 ACCEPTED / 3 named REJECT
```

### What a commit-bound packet PROVES

- **The sealed, unaltered log contains a claim to exactly commit oid X with tracked-set root R at
  position k.** The claim is an ordinary event leaf under the same head: editing, moving, or dropping
  it — or doctoring any event around it — is the same named REJECT as any other tamper, and `k` (the
  claim's `seq`) is bound by tree position, not by self-asserted metadata.
- **Anyone with a clean checkout of X re-derives R via the shipped `vh hash <repo> --git` machinery.**
  `vh agent verify-commit` FIRST re-runs the full packet verification (a tampered or forged packet —
  including a failed `--vendor` pin — never reaches the claim check), THEN re-resolves the oid and
  RECOMPUTES the tracked-set root from the auditor's OWN clone; it never trusts the packet's stored
  facts. A REJECT names the failed check: `packet-invalid` / `no-disclosed-claim` / `oid-mismatch` /
  `root-mismatch`. Because `hashGit` reads work-tree bytes, a dirty checkout of the right commit is an
  HONEST `root-mismatch` (the named fix: check out the claimed commit in a CLEAN tree), never a false
  ACCEPT.
- **Redaction of any other payload leaves the claim checkable.** Leaves are redaction-safe, so the
  producer can withhold every prompt/completion/tool payload and hand over a packet that still proves
  the commit binding; redacting the CLAIM itself is, by definition, `no-disclosed-claim` — a withheld
  claim is committed-to but not disclosable.

### What it does NOT prove

- **Containment, NOT causation — it does NOT prove the session's events produced the commit.** The
  packet proves the sealed log CONTAINS the claim at position k; whether the recorded session actually
  authored commit X is a real-world fact no hash can witness.
- **Not faithful recording.** The boundary above is unchanged: garbage-in is out of scope — if the
  software that wrote the log lied before sealing, the packet faithfully preserves the lie, claim
  included.
- **The claim's `ts` is self-asserted**, like every event `ts`: recorded verbatim, never verified
  against any clock.
- **NOT a trusted timestamp.** "This session (or claim) existed at time T" still rides the human-owned
  **P-3** trust-root ([Human-owned steps](TRUST-BOUNDARIES.md#p-3-trust-root), needs-human); a signed head proves
  *who vouched* for the head, not *when*.

**The same wording rides in-band**: every `commit-claim` emission and every `verify-commit` verdict
carries this boundary as its `note`. Verbatim:

> A commit-claim is an ORDINARY session event binding a claim to EXACTLY one git commit oid and its tracked-set root (the `vh hash --git` work-tree root over the files git tracks at that commit). Sealed into a packet it proves CONTAINMENT, NOT CAUSATION: the unaltered log CONTAINS this claim — it does NOT prove the session's events PRODUCED that commit. The auditor re-derives BOTH facts from THEIR OWN clone via `vh agent verify-commit` (free, read-only, key-less); because hashGit reads WORK-TREE bytes, a dirty checkout is an HONEST root mismatch, never a false ACCEPT. `scope` is an UNVERIFIED hint; `ts` is SELF-ASSERTED metadata like every event ts. Every caveat of the agent-session packet applies (see `vh agent verify`).

### Free vs. paid, and where each leg verifies

`commit-claim` and `verify-commit` are **FREE**, read-only, and key-less end-to-end — the whole
commit-binding surface joins the free verify tier above. **`--sign` is unchanged behind the existing
gate** (the DRAFT `agent_signed` capability, same fail-closed license mechanism as above): commit
binding adds no new paid surface and no new human gate.

**The standalone-page boundary, honestly:** the zero-install page verifies the PACKET — seal, leaves,
head, signature, and the disclosed claim bytes; re-deriving the COMMIT facts requires git + a clone,
i.e. the CLI (`vh agent verify-commit`) is the auditor tool for that leg. A counterparty without git
can still check the packet is unaltered and read the claim; only the re-derivation leg needs a
checkout.

The scripted worked flow — map → `commit-claim` → seal → redact-all-but-claim → `verify-commit` — is
committed at
[`examples/agent-session/commit-bound-session.js`](../examples/agent-session/commit-bound-session.js)
and driven end-to-end (plus the tamper/dirty-checkout negatives) by
[`test/cli.agent.commit.docs.test.js`](../test/cli.agent.commit.docs.test.js), so it cannot rot.

---

## Coverage: prove it fleet-wide (`vh agent coverage`)

The commit-binding verbs answer the question for ONE packet. The fleet question — the one the
AI-code-governance / audit buyer actually gates a pipeline on — is: *across this commit range, WHICH
changes carry a verifiable agent-session record — and fail my build when one doesn't?* `vh agent
coverage` answers it with machinery this page already documented: it enumerates the range's commits
oldest-first (`git rev-list --reverse`), FULLY re-verifies every `*.vhagent.json` under `--packets`
through the same shipped `vh agent verify` path FIRST, extracts each VERIFIED packet's disclosed
commit-claims verbatim, and gives every commit a status from a CLOSED vocabulary:
`covered-verified` / `covered-oid-only` / `claim-unverified-packet` / `claim-root-mismatch` /
`uncovered`.

```bash
vh agent coverage --repo . --range origin/main..HEAD --packets ./packets --require-all   # the CI gate: exit 3 on any gap
vh agent coverage --repo . --range HEAD~10..HEAD --packets ./packets --deep --out coverage-report.json --json
```

### What a coverage report PROVES

- **For each covered commit, an UNALTERED sealed session contains a disclosed claim to exactly that
  oid.** Every packet goes through the FULL shipped verify path BEFORE its claims count; a packet
  that does not verify proves nothing, so its claims count ONLY as `claim-unverified-packet` (never
  coverage) and the packet is NAMED in the report.
- **Under `--deep`, to exactly that re-derived tracked-set root.** Each claimed in-range commit's
  `vh hash --git` root is RE-DERIVED with the shipped engine inside a throwaway LOCAL clone (fully
  offline — a local-path clone opens no network; the clone is removed on every exit path), and a
  mismatch is the NAMED `claim-root-mismatch` discrepancy — never coverage. Without `--deep` a
  verified claim is `covered-oid-only` at best, and the human-readable output SAYS
  root-not-re-derived.
- **The report is deterministic and sealable with the existing `vh evidence seal`.** `--out <report>`
  writes the canonical sorted-key `vh-agent-coverage@1` bytes — byte-diffable across runs, round-tripping
  through the strict parser — and the report file is an ordinary artifact the existing
  `vh evidence seal` seals like any other (no new seal code, no new packet kind).

### What it does NOT prove

- **Containment, NOT causation — per commit.** A covered commit means the UNALTERED sealed log
  CONTAINS a disclosed claim naming exactly that commit; it does NOT prove the session's events produced the commit.
- **An uncovered commit proves NOTHING about how it was authored: coverage is an INVENTORY control, not an authorship detector.**
  An uncovered commit is a gap in your record-keeping — it is NOT evidence the change was
  hand-written, agent-written, or anything else.
- **A redacted claim is not disclosable.** A withheld claim is committed-to but cannot be read, so
  it can never count toward coverage — redact everything BUT the claim and coverage still works.
- **The claim's `ts` is self-asserted**, like every event `ts`: recorded verbatim, never verified
  against any clock — and the report is **NOT a trusted timestamp** without the human-owned **P-3**
  trust-root ([Human-owned steps](TRUST-BOUNDARIES.md#p-3-trust-root), needs-human).

**The same wording rides in-band**: every `vh agent coverage` verdict — human-readable and `--json`
— leads with this boundary as its `note`. Verbatim:

> A coverage report is an INVENTORY control, NOT an authorship detector: a covered commit means an UNALTERED sealed session packet CONTAINS a disclosed claim naming exactly that commit oid (containment, NOT causation — it does not prove the session's events PRODUCED the commit), and an uncovered commit proves NOTHING about how it was authored. Every packet is FIRST re-verified through the FULL shipped `vh agent verify` path; a packet that does not verify proves nothing, so its claims count ONLY as claim-unverified-packet (never coverage). Without --deep a claim's tracked-set root is NOT re-derived (covered-oid-only); --deep re-derives it with the shipped `vh hash --git` engine in a throwaway LOCAL clone (offline; removed on every exit path) and a mismatch is the NAMED claim-root-mismatch discrepancy (never coverage). Event `ts` fields are SELF-ASSERTED; nothing here is a trusted timestamp (P-3). Every caveat of the agent-session packet applies (see `vh agent verify`).

### Free vs. paid, and the CI gate

**Coverage and the CI gate are FREE** — read-only, key-less end-to-end, on the same free verify tier
as everything above. **`--sign` is unchanged behind the existing gate** (the DRAFT `agent_signed`
capability, the same fail-closed license mechanism documented above): coverage adds no new paid
surface and no new human gate.

Gating a pipeline is the exit-code contract: report-only (no policy flag) ALWAYS exits 0;
`--require-all` / `--require-since <oid>` gate exit 3 when a policed commit lacks a verifiable claim
(2 usage / 1 IO — the family contract). The committed CI recipes —
[`verifier/ci/agent-coverage.generic.sh`](../verifier/ci/agent-coverage.generic.sh) (any CI, an
env-var contract) and
[`verifier/ci/agent-coverage.github-actions.yml`](../verifier/ci/agent-coverage.github-actions.yml)
(a workflow example; the loop never runs it) — fail the build when a commit in the pushed range
lacks a verifiable claim.

The scripted worked fleet flow — fixture repo → two sessions → claims → seal → coverage
(`--require-all` FAILING on the uncovered commit, then PASSING once its session is sealed, plus
`--deep` root re-derivation and the sealable `--out` report) — is committed at
[`examples/agent-session/fleet-coverage.js`](../examples/agent-session/fleet-coverage.js) and driven
end-to-end by [`test/cli.agent.coverage.docs.test.js`](../test/cli.agent.coverage.docs.test.js), so
it cannot rot.

---

## Adoption is a ~20-line mapping, not a platform migration (the worked example)

Your agent framework already writes a session log. The only integration you own is mapping its shape
into the canonical five-type event schema — and the committed, test-gated example
[`examples/agent-session/`](../examples/agent-session/) shows exactly that on a **realistic
third-party transcript**:

- [`examples/agent-session/transcript.openai.jsonl`](../examples/agent-session/transcript.openai.jsonl)
  — an OpenAI-chat-completions-style `messages[]` + tool-calls JSONL export (system/user/assistant
  roles, assistant `tool_calls`, `role:"tool"` results carrying PII worth redacting).
- [`examples/agent-session/map-transcript.js`](../examples/agent-session/map-transcript.js) — the
  dependency-free mapper; the whole mapping sits between its `MAPPING BEGIN`/`MAPPING END` markers,
  about twenty lines, with the size pinned by test.

The end-to-end flow (each command from the example's README, driven verbatim by
[`test/cli.agent.docs.test.js`](../test/cli.agent.docs.test.js) so it cannot rot):

```bash
node examples/agent-session/map-transcript.js --out $W/events.jsonl        # 1. MAP    (your 20 lines)
node cli/vh.js agent seal $W/events.jsonl --out $W/session.vhagent.json    # 2. SEAL   (free)
node cli/vh.js agent redact $W/session.vhagent.json --seq 3 \
    --out $W/session.redacted.vhagent.json                                 # 3. REDACT the PII tool result
node cli/vh.js agent verify $W/session.redacted.vhagent.json              # 4. VERIFY — ACCEPTED, seq 3 withheld
node cli/vh.js agent prove $W/session.redacted.vhagent.json --seq 8 \
    --out $W/event-8.proof.json                                            # 5. PROVE the final completion…
node cli/vh.js agent verify-proof $W/event-8.proof.json                    #    …and check it offline
```

The redacted copy verifies with the **identical head** as the full one; the withheld PII stays
checkable ("something was here, committed to, and withheld") without being disclosed.

---

## How it relates to the rest of the family

Same core, different artifact: the leaf/root/proof math is the shipped RFC-6962 ordered-log core
([`cli/journal-log.js`](../cli/journal-log.js), the transparency-log engine in
[`INTEGRITY-JOURNAL.md`](INTEGRITY-JOURNAL.md)); the packet/trust-note/license disciplines are the
evidence family's ([`EVIDENCE.md`](EVIDENCE.md)); signing reuses the shared attestation envelope; and a
`vh.agent-session-packet` is kind-disjoint from every other artifact, so nothing cross-verifies as
something it is not. Boundary language across the family lives in
[`TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md).
