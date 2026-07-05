#!/usr/bin/env node
"use strict";

// cli/agent-hook.js — `vh-agent-hook` (T-73.4): ZERO-CONFIG SessionEnd transcript sealing for
// Claude Code, over the shipped FREE `vh agent seal` path.
//
// WHAT THIS IS
//   A Claude Code `SessionEnd` hook. The host writes ONE JSON hook event to stdin
//   ({ transcript_path, session_id, cwd, ... }); this bin maps the session's transcript JSONL into
//   the canonical agent-session event schema (the examples/agent-session/map-transcript.js
//   approach — a tiny mapping between the MAPPING BEGIN/END markers below), seals it UNSIGNED via
//   the SHIPPED packet builder (cli/agent.js buildPacket/serializePacket — the exact free
//   `vh agent seal` path over cli/core/agent-session.js; NO re-implemented crypto), and writes
//     <outDir>/<session_id>.vhagent.json
//   where <outDir> is $VH_HOOK_OUT (resolved against the event's cwd) or `.vh-sessions/` under the
//   event's cwd by default. The `vh agent verify` one-liner is printed on stderr. That converts the
//   agent-evidence lane's ~20-line adoption cost to ~0: install the package, register the hook, done.
//
// POSTURE (all load-bearing):
//   * FREE tier only: UNSIGNED seal — no key, no license, no network, ever.
//   * The hook's own code is Node-core only (fs/path) + the shipped seal modules; no new dependency.
//   * DRIFT-TOLERANT mapping: an unknown/extra JSONL line kind, an unknown content-block kind, or a
//     malformed (e.g. crash-truncated) line is SKIPPED-AND-COUNTED, never fatal — a host upgrade
//     must not silently kill sealing.
//   * NAMED exits, and a top-level catch so this bin can NEVER crash the host's session end:
//       0 OK                    sealed + written
//       2 BAD_HOOK_EVENT        malformed stdin (not JSON / not an object / bad session_id)
//       3 TRANSCRIPT_UNREADABLE transcript_path missing from the event, or unreadable/oversized
//       4 EMPTY_TRANSCRIPT      the transcript exists but yields ZERO mappable events
//       5 SEAL_FAILED           the shipped core refused the mapped events (named reason relayed)
//       6 WRITE_FAILED          cannot create <outDir> or write the packet
//       7 INTERNAL              the top-level catch (a bug — named, never an unhandled throw)
//     Every failure writes NOTHING (the packet is written last, in one shot).
//   * Deterministic: the same transcript + session_id re-seals to BYTE-IDENTICAL packet bytes, so a
//     repeat run for the same session_id deterministically overwrites.
//
// TRUST BOUNDARY (pinned VERBATIM here, in docs/AGENT-HOOK.md, and in the test):
//   The seal proves the log is INTACT since seal, NOT that the agent behaved well. NOT a trusted
//   timestamp — ts fields are self-asserted. And payloads embed VERBATIM — redact before sharing.

const fs = require("fs");
const path = require("path");

// The SHIPPED free unsigned seal (cli/agent.js is the `vh agent seal` surface over the pure
// cli/core/agent-session.js core). Reused VERBATIM — this file contains zero crypto.
const { buildPacket, serializePacket, MAX_INPUT_BYTES } = require("./agent");

// ---------------------------------------------------------------------------------------------------
// The NAMED exit contract (this bin's own — documented in docs/AGENT-HOOK.md).
// ---------------------------------------------------------------------------------------------------

const EXIT = Object.freeze({
  OK: 0,
  BAD_HOOK_EVENT: 2,
  TRANSCRIPT_UNREADABLE: 3,
  EMPTY_TRANSCRIPT: 4,
  SEAL_FAILED: 5,
  WRITE_FAILED: 6,
  INTERNAL: 7,
});

// Reverse map for the named stderr prefix (`vh-agent-hook: TRANSCRIPT_UNREADABLE: ...`).
const EXIT_NAME = Object.freeze(
  Object.fromEntries(Object.entries(EXIT).map(([name, code]) => [code, name]))
);

// The PINNED boundary lines — docs/AGENT-HOOK.md and the test carry these VERBATIM (anti-drift:
// the doc quotes the exact wording the code prints).
const BOUNDARY_INTACT_LINE =
  "The seal proves the log is INTACT since seal, NOT that the agent behaved well.";
const BOUNDARY_TIMESTAMP_LINE = "NOT a trusted timestamp — ts fields are self-asserted.";
const BOUNDARY_REDACT_LINE =
  "Payloads embed VERBATIM (prompts, code, tool output): run `vh agent redact` before sharing a packet.";

// Cap on the stdin hook event — a hook event is a few hundred bytes; a runaway stream is hostile.
const MAX_STDIN_BYTES = 1024 * 1024; // 1 MiB

// Stdin idle timeout: the host pipes the hook event instantly, so if nothing arrives we must fail
// with a hint rather than hang the host's session end. $VH_HOOK_STDIN_TIMEOUT_MS overrides; 0 disables.
const DEFAULT_STDIN_TIMEOUT_MS = 60000; // 60s — generous vs the host's own hook-timeout

// The default out directory, under the hook event's cwd (overridable via $VH_HOOK_OUT).
const DEFAULT_OUT_DIR = ".vh-sessions";

// A packet embeds prompts / code / tool output VERBATIM, so the zero-config default dir SELF-IGNORES:
// the first seal drops this `.gitignore` (an all-globbing `*`, which git also applies to the file
// itself) inside it, so a routine `git add -A` / `git commit` — or a public repo — can never silently
// commit a secret-bearing packet. Best-effort and only for the default dir; a custom VH_HOOK_OUT is
// the operator's to manage (see docs/AGENT-HOOK.md).
const OUT_DIR_GITIGNORE =
  "# Written by vh-agent-hook. These *.vhagent.json packets embed prompts, code, and tool output\n" +
  "# VERBATIM — do NOT commit them (run `vh agent redact` before sharing). This ignores the whole dir.\n" +
  "*\n";

// Printed by `--help` / `-h` (and, verbatim-ish, when stdin is an interactive terminal): this is a
// HOOK, not an interactive command, so an operator testing the install gets guidance, not a hang.
const USAGE = [
  "vh-agent-hook — zero-config Claude Code SessionEnd transcript sealing (FREE, unsigned).",
  "",
  "This is a Claude Code SessionEnd HOOK, not an interactive command. The host pipes ONE hook-event",
  "JSON ({ transcript_path, session_id, cwd }) to stdin; this bin seals the transcript into",
  "  <outDir>/<session_id>.vhagent.json   (outDir = $VH_HOOK_OUT, else .vh-sessions/ under the event cwd)",
  "and prints the `vh agent verify` one-liner on stderr. See docs/AGENT-HOOK.md for the 3-line install.",
  "",
  "Env:",
  "  VH_HOOK_OUT=<dir>              override the out dir (a relative value resolves against the event cwd)",
  "  VH_HOOK_STDIN_TIMEOUT_MS=<n>   stdin idle timeout in ms (default 60000; 0 disables)",
  "",
  "Testing the install by hand? It waits for a hook event on stdin — pipe one in, e.g.:",
  "  printf '{\"session_id\":\"s1\",\"transcript_path\":\"./t.jsonl\",\"cwd\":\".\"}' | vh-agent-hook",
].join("\n");

// session_id becomes a FILENAME component: strict allowlist (Claude Code ids are UUIDs), no leading
// dot, no path separators — a traversal-shaped id is a BAD_HOOK_EVENT, never a write outside outDir.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------------------------------
// MAPPING BEGIN — ONE Claude Code transcript JSONL line -> canonical `vh agent` events.
// Claude Code shapes (v1.x): message lines are { type: "user"|"assistant", message: { role,
// content }, timestamp, ... } where content is a string or an array of blocks ({ type: "text" },
// { type: "tool_use", id, name, input }, { type: "tool_result", tool_use_id, content, is_error? }).
// Everything else (summary / system / file-history-snapshot / future kinds) is skipped-and-counted.
// ---------------------------------------------------------------------------------------------------
function mapLine(line, skipped) {
  if (!isPlainObject(line) || (line.type !== "user" && line.type !== "assistant") || !isPlainObject(line.message)) {
    skipped.lines++; // non-message or unknown line kind — tolerated drift, never fatal
    return [];
  }
  const ts = typeof line.timestamp === "string" ? line.timestamp : ""; // self-asserted; may be absent
  const actor = line.type === "user" ? "user" : "agent:assistant";
  const textType = line.type === "user" ? "prompt" : "completion";
  const content = line.message.content;
  if (typeof content === "string") return [{ ts, actor, type: textType, payload: content }];
  if (!Array.isArray(content)) {
    skipped.lines++; // a message whose content shape we do not know — skip the line, count it
    return [];
  }
  const out = [];
  for (const b of content) {
    if (isPlainObject(b) && b.type === "text" && typeof b.text === "string") {
      out.push({ ts, actor, type: textType, payload: b.text });
    } else if (isPlainObject(b) && b.type === "tool_use" && line.type === "assistant") {
      out.push({ ts, actor, type: "tool_call",
        payload: JSON.stringify({ id: b.id, name: b.name, input: b.input === undefined ? null : b.input }) });
    } else if (isPlainObject(b) && b.type === "tool_result" && line.type === "user") {
      const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "unknown";
      const e = { ts, actor: "tool:" + id, type: "tool_result",
        payload: typeof b.content === "string" ? b.content : JSON.stringify(b.content === undefined ? null : b.content),
        meta: b.is_error === true ? { tool_use_id: id, is_error: true } : { tool_use_id: id } };
      out.push(e);
    } else {
      skipped.blocks++; // unknown/extra content-block kind (thinking, image, future) — counted
    }
  }
  return out;
}
// MAPPING END

/**
 * Map a whole Claude Code transcript JSONL text into the canonical, seq-contiguous event array.
 * PURE and TOTAL: a malformed line (e.g. crash-truncated tail) is skipped-and-counted, never a
 * throw — the hook must survive host drift.
 *
 * @param {string} text the raw transcript JSONL.
 * @returns {{ events: object[], skipped: { lines: number, blocks: number, malformed: number } }}
 */
function mapTranscriptText(text) {
  const skipped = { lines: 0, blocks: 0, malformed: 0 };
  const events = [];
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch (_) {
      skipped.malformed++; // tolerated: a truncated/garbled line never kills the seal
      continue;
    }
    for (const ev of mapLine(line, skipped)) events.push({ seq: events.length, ...ev });
  }
  return { events, skipped };
}

// ---------------------------------------------------------------------------------------------------
// I/O plumbing.
// ---------------------------------------------------------------------------------------------------

/**
 * Read all of stdin (size-capped, idle-timeout-guarded). Resolves the UTF-8 text; rejects on a
 * stream error, on exceeding the cap, or if `timeoutMs > 0` and no data arrives within that idle
 * window — so a misconfigured/never-closing stdin fails with a hint instead of hanging the host.
 */
function readStdin(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let timer = null;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      if (!timeoutMs || timeoutMs <= 0) return;
      clear();
      timer = setTimeout(() => {
        reject(
          new Error(
            `no hook event on stdin within ${timeoutMs}ms — this bin reads the SessionEnd hook-event ` +
              "JSON from stdin (run `vh-agent-hook --help`)"
          )
        );
        stream.destroy();
      }, timeoutMs);
      if (timer.unref) timer.unref(); // never keep the process alive just for this timer
    };
    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        clear();
        reject(new Error(`stdin exceeds the ${MAX_STDIN_BYTES}-byte hook-event cap`));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
      arm(); // idle window resets on every chunk
    });
    stream.on("end", () => {
      clear();
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    stream.on("error", (e) => {
      clear();
      reject(e);
    });
    arm();
  });
}

/** The stdin idle timeout in ms from $VH_HOOK_STDIN_TIMEOUT_MS (default 60000; 0 disables). */
function stdinTimeoutMs(env) {
  const raw = env.VH_HOOK_STDIN_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_STDIN_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_STDIN_TIMEOUT_MS;
}

/**
 * Best-effort: drop the self-ignoring `.gitignore` into the DEFAULT out dir so a routine `git add -A`
 * can never commit a secret-bearing packet. Never fails the seal; never clobbers an operator's own
 * `.gitignore`. Called ONLY after a successful packet write, and only for the default dir.
 */
function writeSelfIgnore(outDir, writeErr) {
  const giPath = path.join(outDir, ".gitignore");
  try {
    if (!fs.existsSync(giPath)) fs.writeFileSync(giPath, OUT_DIR_GITIGNORE);
  } catch (e) {
    writeErr(
      `vh-agent-hook: note: could not self-ignore ${giPath} (${e.message}) — add '${DEFAULT_OUT_DIR}/' to .gitignore yourself\n`
    );
  }
}

function fail(writeErr, code, message) {
  writeErr(`vh-agent-hook: ${EXIT_NAME[code]}: ${message}\n`);
  return code;
}

/**
 * The whole hook, I/O injected for tests. NEVER throws (its own catch backs up the bin-level one).
 *
 * @param {object} io { stdinText?, argv?, stdinIsTTY?, env?, writeErr? }
 * @returns {Promise<number>} a named EXIT code.
 */
async function runHook(io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  try {
    const env = io.env || process.env;
    const argv = io.argv || process.argv.slice(2);

    // `--help`/`-h`: this is a HOOK, not an interactive command. Print usage on STDERR (stdout stays
    // clean, always) and exit OK, so an operator poking at the install gets guidance, not a hang.
    if (argv.includes("-h") || argv.includes("--help")) {
      writeErr(USAGE + "\n");
      return EXIT.OK;
    }

    // (1) The hook event from stdin — malformed stdin is BAD_HOOK_EVENT, nothing written.
    let stdinText;
    if (io.stdinText !== undefined) {
      stdinText = io.stdinText;
    } else {
      // Run by hand in a terminal (stdin is a TTY — no event piped)? Don't hang the operator; tell them.
      const isTTY = io.stdinIsTTY !== undefined ? io.stdinIsTTY : process.stdin.isTTY;
      if (isTTY) {
        return fail(
          writeErr,
          EXIT.BAD_HOOK_EVENT,
          "no hook event on stdin (stdin is a terminal). This is a Claude Code SessionEnd hook; it reads " +
            "the hook-event JSON from stdin — run `vh-agent-hook --help`."
        );
      }
      try {
        stdinText = await readStdin(process.stdin, stdinTimeoutMs(env));
      } catch (e) {
        return fail(writeErr, EXIT.BAD_HOOK_EVENT, `cannot read the hook event from stdin: ${e.message}`);
      }
    }
    let event;
    try {
      event = JSON.parse(stdinText);
    } catch (e) {
      return fail(writeErr, EXIT.BAD_HOOK_EVENT, `stdin is not valid hook-event JSON: ${e.message}`);
    }
    if (!isPlainObject(event)) {
      return fail(writeErr, EXIT.BAD_HOOK_EVENT, "the hook event must be a JSON object ({ transcript_path, session_id, cwd })");
    }
    const sessionId = event.session_id;
    if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
      return fail(
        writeErr,
        EXIT.BAD_HOOK_EVENT,
        `the hook event needs a filename-safe session_id (letters/digits/._- , no leading dot), got: ${JSON.stringify(sessionId)}`
      );
    }

    // (2) The transcript — a missing field, or an unreadable/oversized file, is TRANSCRIPT_UNREADABLE.
    if (typeof event.transcript_path !== "string" || event.transcript_path.length === 0) {
      return fail(writeErr, EXIT.TRANSCRIPT_UNREADABLE, "the hook event carries no transcript_path");
    }
    const eventCwd = typeof event.cwd === "string" && event.cwd.length > 0 ? event.cwd : process.cwd();
    const transcriptPath = path.resolve(eventCwd, event.transcript_path);
    let transcriptText;
    try {
      const stat = fs.statSync(transcriptPath);
      if (stat.size > MAX_INPUT_BYTES) {
        return fail(
          writeErr,
          EXIT.TRANSCRIPT_UNREADABLE,
          `transcript ${transcriptPath} is OVERSIZED (${stat.size} bytes > the ${MAX_INPUT_BYTES}-byte limit)`
        );
      }
      transcriptText = fs.readFileSync(transcriptPath, "utf8");
    } catch (e) {
      return fail(writeErr, EXIT.TRANSCRIPT_UNREADABLE, `cannot read transcript ${transcriptPath}: ${e.message}`);
    }

    // (3) Map (drift-tolerant: skips are COUNTED, never fatal) — zero events is EMPTY_TRANSCRIPT.
    const { events, skipped } = mapTranscriptText(transcriptText);
    const skippedNote = `skipped ${skipped.lines} non-message line(s), ${skipped.blocks} unmapped block(s), ${skipped.malformed} malformed line(s)`;
    if (events.length === 0) {
      return fail(
        writeErr,
        EXIT.EMPTY_TRANSCRIPT,
        `transcript ${transcriptPath} yields no mappable events (${skippedNote}) — nothing to seal`
      );
    }

    // (4) Seal UNSIGNED over the SHIPPED path (free tier: no key, no license, no network).
    const built = buildPacket(events);
    if (!built.ok) {
      const at = built.index !== undefined ? ` at event seq ${built.index}` : "";
      return fail(writeErr, EXIT.SEAL_FAILED, `the shipped seal core refused the mapped events: ${built.reason}${at}`);
    }
    const artifactStr = serializePacket(built.packet);

    // (5) Write <outDir>/<session_id>.vhagent.json — deterministic bytes, so a repeat run for the
    //     same session_id overwrites with the identical packet.
    const usingDefaultOut = !(typeof env.VH_HOOK_OUT === "string" && env.VH_HOOK_OUT.length > 0);
    const outDir = path.resolve(eventCwd, usingDefaultOut ? DEFAULT_OUT_DIR : env.VH_HOOK_OUT);
    const outPath = path.join(outDir, `${sessionId}.vhagent.json`);
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, artifactStr);
    } catch (e) {
      return fail(writeErr, EXIT.WRITE_FAILED, `cannot write packet ${outPath}: ${e.message}`);
    }
    // Keep the working tree CLEAN: the zero-config default dir self-ignores so a stray `git add -A`
    // can never commit these VERBATIM-payload packets. Best-effort — a failed self-ignore never fails
    // a good seal, and a custom VH_HOOK_OUT is the operator's to manage (point it outside the tree).
    if (usingDefaultOut) writeSelfIgnore(outDir, writeErr);

    // (6) The receipt + the verify one-liner + the pinned boundary, all on stderr (a SessionEnd hook
    //     should never pollute stdout).
    writeErr(
      `vh-agent-hook: sealed ${events.length} event(s) from ${transcriptPath} (${skippedNote}) -> ${outPath}\n`
    );
    writeErr(`vh-agent-hook: verify with: vh agent verify ${outPath}\n`);
    writeErr(`vh-agent-hook: ${BOUNDARY_INTACT_LINE} ${BOUNDARY_TIMESTAMP_LINE} ${BOUNDARY_REDACT_LINE}\n`);
    return EXIT.OK;
  } catch (e) {
    // The named backstop: a bug in this file must never crash the host's session end.
    return fail(writeErr, EXIT.INTERNAL, `unexpected failure: ${e && e.message ? e.message : String(e)}`);
  }
}

if (require.main === module) {
  // Top-level catch (bin level): whatever happens, exit with a NAMED code — never an unhandled throw.
  runHook().then(
    (code) => process.exit(code),
    (e) => {
      try {
        process.stderr.write(`vh-agent-hook: INTERNAL: ${e && e.message ? e.message : String(e)}\n`);
      } catch (_) {
        /* stderr gone — still exit named */
      }
      process.exit(EXIT.INTERNAL);
    }
  );
}

module.exports = {
  EXIT,
  EXIT_NAME,
  BOUNDARY_INTACT_LINE,
  BOUNDARY_TIMESTAMP_LINE,
  BOUNDARY_REDACT_LINE,
  DEFAULT_OUT_DIR,
  OUT_DIR_GITIGNORE,
  MAX_STDIN_BYTES,
  DEFAULT_STDIN_TIMEOUT_MS,
  USAGE,
  stdinTimeoutMs,
  mapLine,
  mapTranscriptText,
  runHook,
};
