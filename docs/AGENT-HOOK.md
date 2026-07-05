# `vh-agent-hook` — zero-config session sealing for Claude Code

`vh-agent-hook` is a [Claude Code `SessionEnd` hook](https://docs.anthropic.com/en/docs/claude-code/hooks):
when a session ends, the host pipes one JSON hook event (`{ transcript_path, session_id, cwd, ... }`)
to the hook's stdin, and `vh-agent-hook` maps the session's transcript JSONL into the canonical
agent-session event schema and seals it — **UNSIGNED, on the FREE tier: no key, no license, no
network** — into one tamper-evident packet:

```
<outDir>/<session_id>.vhagent.json
```

`<outDir>` defaults to **`.vh-sessions/`** under the hook event's `cwd`; set the environment
variable **`VH_HOOK_OUT`** to choose another directory (a relative value resolves against the
event's `cwd`). The sealing itself is the shipped free `vh agent seal` path over
`cli/core/agent-session.js` — the hook re-implements no crypto; it is only the transcript mapper
plus filesystem plumbing. Anyone can then check the packet offline with `vh agent verify` (or the
zero-install independent verifier — see [AGENTTRACE.md](AGENTTRACE.md)).

### Your working tree stays clean automatically

A packet embeds your prompts, code, and tool output **verbatim** (see the boundary below), so the
zero-config default dir is made **self-ignoring**: the first seal drops a `.gitignore` (containing
`*`) inside `.vh-sessions/`, so a routine `git add -A` / `git commit` — or a public repo, like this
one — can **never** silently commit a secret-bearing packet, and `git status` stays clean. You don't
have to add anything to your own `.gitignore`.

Prefer to keep packets out of the repo entirely? Point **`VH_HOOK_OUT` at a directory outside your
working tree** (e.g. `VH_HOOK_OUT=~/.vh-sessions`). If instead you point `VH_HOOK_OUT` at a path
**inside** the tree, add that directory to your `.gitignore` yourself — the automatic self-ignore is
written only for the default `.vh-sessions/`. Packets accumulate one-per-session with no rotation, so
prune the directory when you no longer need the older sealed sessions.

## The 3-line install

```bash
npm install -g verifyhash    # 1. installs the `vh` and `vh-agent-hook` bins
echo '{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"vh-agent-hook"}]}]}}' > .claude/settings.json    # 2. register the hook (merge the "hooks" key if the file already exists)
vh agent verify .vh-sessions/<session_id>.vhagent.json    # 3. after any session ends: verify the sealed packet
```

That is the entire integration: every session end now writes one verifiable
`.vh-sessions/<session_id>.vhagent.json`, and the hook prints the exact `vh agent verify` one-liner
on stderr each time it seals.

## The honest boundary (pinned — read before you rely on a packet)

- **The seal proves the log is INTACT since seal, NOT that the agent behaved well.** Garbage-in is
  out of scope: the packet's Merkle head proves the transcript events are unaltered since sealing
  and any disclosed event is verbatim as recorded — it does not prove the transcript faithfully
  records what the agent actually did, and it is not a claim the work was correct or safe.
- **NOT a trusted timestamp — ts fields are self-asserted.** Event `ts` values are carried verbatim
  from the transcript and are never verified against any clock; "sealed at time T" needs the
  human-owned signing/timestamp trust root (see [TRUST-BOUNDARIES.md](TRUST-BOUNDARIES.md)).
- **Payloads embed VERBATIM (prompts, code, tool output): run `vh agent redact` before sharing a
  packet.** A sealed packet contains your full prompts, file contents, and tool output. Redaction
  withholds any payload behind its hash commitment WITHOUT changing a single leaf or the root, so
  the redacted copy still verifies: `vh agent redact <packet> --seq <list> --out <redacted>`.

## What the hook writes, and when it refuses

The packet is written **last, in one shot** — every failure path writes NOTHING. The mapping is
**drift-tolerant**: unknown/extra transcript line kinds (`summary`, `file-history-snapshot`, future
kinds), unknown content-block kinds, and malformed (e.g. crash-truncated) lines are
**skipped-and-counted** on stderr, never fatal. Sealing is **deterministic**: re-running the hook
for the same `session_id` and transcript overwrites the packet with byte-identical content.

Named exit codes (the hook has a top-level catch, so it can never crash the host's session end):

| exit | name                    | meaning                                                          |
| ---- | ----------------------- | ---------------------------------------------------------------- |
| 0    | `OK`                    | sealed and written; verify one-liner printed on stderr           |
| 2    | `BAD_HOOK_EVENT`        | stdin is not valid hook-event JSON, or `session_id` is missing/not filename-safe |
| 3    | `TRANSCRIPT_UNREADABLE` | the event carries no `transcript_path`, or the file is missing/unreadable/oversized |
| 4    | `EMPTY_TRANSCRIPT`      | the transcript yields zero mappable events — nothing to seal     |
| 5    | `SEAL_FAILED`           | the shipped seal core refused the mapped events (reason relayed) |
| 6    | `WRITE_FAILED`          | cannot create the out directory or write the packet              |
| 7    | `INTERNAL`              | the top-level catch — a bug, reported by name, never a crash     |

(Exit `1` is deliberately reserved for a generic Node crash and is never used by the hook.)

### Testing the install by hand

The hook reads its event from **stdin**, so running `vh-agent-hook` in a terminal would otherwise
just wait. Run **`vh-agent-hook --help`** for usage, or pipe a hook event in yourself:

```bash
printf '{"session_id":"s1","transcript_path":"./session.jsonl","cwd":"."}' | vh-agent-hook
```

If stdin is an interactive terminal (no event piped), the hook exits `BAD_HOOK_EVENT` with a hint
rather than hanging; a never-closing stdin is bounded by an idle timeout
(**`VH_HOOK_STDIN_TIMEOUT_MS`**, default `60000`; `0` disables).

## What lands in the packet

Claude Code transcript lines map to canonical events the way
[`examples/agent-session/map-transcript.js`](../examples/agent-session/map-transcript.js) maps
OpenAI-style exports (see the committed Claude Code fixture
[`examples/agent-session/transcript.claude-code.jsonl`](../examples/agent-session/transcript.claude-code.jsonl)):

- a `user` message (string content or `text` blocks) → `prompt` events (actor `user`);
- an `assistant` `text` block → a `completion` event (actor `agent:assistant`);
- an `assistant` `tool_use` block → a `tool_call` event (payload `{ id, name, input }`);
- a `user` `tool_result` block → a `tool_result` event (actor `tool:<tool_use_id>`, the
  `tool_use_id` carried in `meta`);
- everything else is skipped-and-counted.

The full packet semantics — redaction, single-event proofs, checkpoints, append-only growth, and
the paid signed-head surface — are documented in [AGENTTRACE.md](AGENTTRACE.md). This hook stays
entirely on the free tier.
