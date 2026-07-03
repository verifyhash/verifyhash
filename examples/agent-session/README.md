# AgentTrace worked example — a real third-party transcript, mapped and sealed

This directory proves the AgentTrace adoption claim with committed, runnable files: **adopting
`vh agent` is a ~20-line mapping over the session log you already have, not a platform migration.**

- [`transcript.openai.jsonl`](transcript.openai.jsonl) — a realistic session transcript in a **common
  third-party shape**: an OpenAI-chat-completions-style JSONL export, one `messages[]`-style object per
  line (`role` system/user/assistant/tool, `content`, assistant `tool_calls`, tool `tool_call_id`) — a
  support agent looking up an order and issuing a refund, tool results carrying real-looking PII
  (a customer email + shipping address) so the redaction step below is the honest, motivated one.
- [`map-transcript.js`](map-transcript.js) — a tiny, **dependency-free** (Node core `fs`/`path` only)
  mapper into the canonical `vh agent` event schema. The entire mapping lives between its
  `MAPPING BEGIN`/`MAPPING END` markers — about twenty lines, and a test pins that size so the claim
  cannot rot.

## The end-to-end flow (map → seal → redact → verify → prove)

From a repo checkout (`npm install` once); every artifact goes to an explicit path you choose:

```bash
W=$(mktemp -d)   # a scratch workspace — nothing here writes to the repo or cwd

# 1. MAP the third-party transcript into canonical events (the only integration step you own):
node examples/agent-session/map-transcript.js --out "$W/events.jsonl"

# 2. SEAL the ordered event log into ONE tamper-evident packet (free, offline):
node cli/vh.js agent seal "$W/events.jsonl" --out "$W/session.vhagent.json"

# 3. REDACT the PII-bearing tool result (seq 3: the customer email + address) — the payload is
#    withheld behind its hash commitment; head and leaves are UNCHANGED:
node cli/vh.js agent redact "$W/session.vhagent.json" --seq 3 --out "$W/session.redacted.vhagent.json"

# 4. VERIFY the redacted copy — ACCEPTED, withheld seqs listed (redaction is not tamper):
node cli/vh.js agent verify "$W/session.redacted.vhagent.json"

# 5. PROVE one event (the final completion, seq 8) and check the disclosure offline:
node cli/vh.js agent prove "$W/session.redacted.vhagent.json" --seq 8 --out "$W/event-8.proof.json"
node cli/vh.js agent verify-proof "$W/event-8.proof.json" --root <head-root-from-step-2>
```

A counterparty needs none of this producer stack: the FREE independent verifier accepts the same
packet (`node verifier/verify-vh.js "$W/session.vhagent.json"`, or the zero-install
`verifier/dist/verify-vh-standalone.js` / browser page `verifier/dist/verify-vh-standalone.html`).

**The honest boundary** (in-band in every packet; full statement in
[`../../docs/AGENTTRACE.md`](../../docs/AGENTTRACE.md)): the packet proves the LOG is unaltered since
seal, any disclosed event verbatim as recorded, append-only growth across checkpoints, and that
redaction can only withhold — never silently alter. It does NOT prove the log faithfully records what
the agent actually did (garbage-in is out of scope), `ts` fields are self-asserted, and it is NOT a
trusted timestamp without the human-owned P-3 trust-root.

This flow is test-gated end to end by
[`test/cli.agent.docs.test.js`](../../test/cli.agent.docs.test.js), so it cannot silently rot.

## Binding the session to a git commit (map → commit-claim → seal → redact-all-but-claim → verify-commit)

[`commit-bound-session.js`](commit-bound-session.js) scripts the commit-binding flow end-to-end —
Node core + git + the shipped CLI only, offline, against a git checkout YOU name:

```bash
W=$(mktemp -d)   # a scratch workspace — nothing here writes to the repo or cwd
node examples/agent-session/commit-bound-session.js --repo /path/to/your/git/checkout --workdir "$W"
```

1. **MAP** the committed transcript into canonical events (`events.jsonl`);
2. **`vh agent commit-claim --repo <repo> --seq <next>`** — derive the commit **oid** + the
   `vh hash --git` **tracked-set root** from YOUR checkout and append the ONE canonical claim event
   line (`session.jsonl`);
3. **`vh agent seal`** the claim-bearing log (`session.vhagent.json`);
4. **`vh agent redact`** EVERY event EXCEPT the claim (`session.redacted.vhagent.json`) — leaves and
   head UNCHANGED, the claim stays disclosed;
5. **`vh agent verify-commit`** the redacted packet against the checkout — the auditor leg: FULL
   packet verification FIRST, then oid + root re-derived from the clone; ACCEPTED only if the
   disclosed claim matches.

Exit 0 on ACCEPT (one JSON summary line on stdout); 3 when `verify-commit` REJECTs (the named reason
— `packet-invalid` / `no-disclosed-claim` / `oid-mismatch` / `root-mismatch` — is printed); 2 usage;
1 any other step failure. Every artifact lands under `--workdir` (or a fresh temp dir, printed on
stderr) — never the current directory.

**Honest boundary — containment, NOT causation:** the sealed packet proves the unaltered log CONTAINS
a claim to exactly that commit oid + tracked-set root — it does NOT prove the session's events
produced the commit. And the auditor leg needs git + a clone: the zero-install page verifies the
PACKET; `vh agent verify-commit` is the auditor tool for the commit-fact leg. Full boundary:
[`../../docs/AGENTTRACE.md`](../../docs/AGENTTRACE.md) › *Binding a session to a git commit*.

This scripted flow (plus its tamper/dirty-checkout negatives) is test-gated end to end by
[`test/cli.agent.commit.docs.test.js`](../../test/cli.agent.commit.docs.test.js).
