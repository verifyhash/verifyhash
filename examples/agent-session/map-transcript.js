#!/usr/bin/env node
"use strict";

// examples/agent-session/map-transcript.js — the WHOLE AgentTrace adoption surface, worked (T-68.4).
//
// Takes a session transcript in a COMMON THIRD-PARTY shape — an OpenAI-chat-completions-style JSONL
// export, one `messages[]`-style object per line ({ role, content, tool_calls?, tool_call_id?,
// name?, ts? }) — and maps it into the canonical `vh agent` event schema (one JSON event per line:
// { seq, ts, actor, type, payload, meta? }; types prompt/completion/tool_call/tool_result/note).
// The point this file exists to prove: ADOPTING AgentTrace is a ~20-line mapping over the log you
// already have (the block between the MAPPING BEGIN/END markers — a test pins its size), not a
// platform migration. Pipe the output straight into `vh agent seal`.
//
// DEPENDENCY-FREE by design (a test greps this): Node core `fs`/`path` only — no ethers, no hashing,
// no producer-stack import. Mapping does not need crypto; sealing does, and that is `vh agent seal`'s
// job. HONESTY: `ts` is carried VERBATIM as self-asserted metadata (many exports have none — an empty
// string is fine); the sealed packet proves the LOG is unaltered since seal, never what the agent
// actually did, and never a trusted wall-clock time (that rides the human P-3 trust-root).
//
// Usage:
//   node examples/agent-session/map-transcript.js [transcript.jsonl] [--out <events.jsonl>]
// With no positional the COMMITTED sample transcript next to this script is used. Events print to
// stdout as JSONL; --out writes them to the EXPLICIT caller-chosen path instead (never cwd
// implicitly). Exit: 0 ok / 1 unreadable or unmappable input (naming the 1-based line) / 2 usage.

const fs = require("fs");
const path = require("path");

// MAPPING BEGIN — the entire adoption surface: ONE third-party message -> canonical vh agent events.
function mapMessage(m) {
  const ts = typeof m.ts === "string" ? m.ts : ""; // self-asserted; absent in many exports
  if (m.role === "system" || m.role === "user") {
    return [{ ts, actor: m.role, type: "prompt", payload: String(m.content) }];
  }
  if (m.role === "assistant") {
    const out = [];
    for (const c of m.tool_calls || [])
      out.push({ ts, actor: "agent:assistant", type: "tool_call",
        payload: JSON.stringify({ id: c.id, name: c.function.name, arguments: c.function.arguments }) });
    if (typeof m.content === "string" && m.content.length > 0)
      out.push({ ts, actor: "agent:assistant", type: "completion", payload: m.content });
    return out;
  }
  if (m.role === "tool") {
    const e = { ts, actor: "tool:" + (m.name || m.tool_call_id || "unknown"), type: "tool_result", payload: String(m.content) };
    if (typeof m.tool_call_id === "string") e.meta = { tool_call_id: m.tool_call_id };
    return [e];
  }
  throw new Error("unmappable transcript role: " + JSON.stringify(m.role));
}
// MAPPING END

/**
 * Map a whole JSONL transcript text into the canonical, seq-contiguous event array.
 * Pure; throws a named Error carrying the 1-based transcript line on the first bad line.
 */
function mapTranscript(text) {
  const events = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    let msg;
    try {
      msg = JSON.parse(lines[i]);
    } catch (e) {
      throw new Error(`transcript line ${i + 1} is not valid JSON: ${e.message}`);
    }
    let mapped;
    try {
      mapped = mapMessage(msg);
    } catch (e) {
      throw new Error(`transcript line ${i + 1}: ${e.message}`);
    }
    for (const ev of mapped) events.push({ seq: events.length, ...ev });
  }
  return events;
}

function main(argv) {
  let input = null;
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      out = argv[++i];
      if (out === undefined) {
        process.stderr.write("error: --out requires a value\n");
        return 2;
      }
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "usage: node map-transcript.js [transcript.jsonl] [--out <events.jsonl>]\n" +
          "Maps an OpenAI-chat-completions-style JSONL transcript into canonical `vh agent` events.\n"
      );
      return 0;
    } else if (a.startsWith("--")) {
      process.stderr.write(`error: unknown flag: ${a}\n`);
      return 2;
    } else if (input === null) {
      input = a;
    } else {
      process.stderr.write(`error: unexpected extra argument: ${a}\n`);
      return 2;
    }
  }
  const inputPath = path.resolve(input || path.join(__dirname, "transcript.openai.jsonl"));
  let text;
  try {
    text = fs.readFileSync(inputPath, "utf8");
  } catch (e) {
    process.stderr.write(`error: cannot read transcript ${inputPath}: ${e.message}\n`);
    return 1;
  }
  let events;
  try {
    events = mapTranscript(text);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
  if (out) {
    const outAbs = path.resolve(out);
    try {
      fs.writeFileSync(outAbs, jsonl);
    } catch (e) {
      process.stderr.write(`error: cannot write --out file ${out}: ${e.message}\n`);
      return 1;
    }
    process.stderr.write(`mapped ${events.length} events -> ${outAbs}\n`);
  } else {
    process.stdout.write(jsonl);
    process.stderr.write(`mapped ${events.length} events (JSONL on stdout — pipe into \`vh agent seal\`)\n`);
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { mapMessage, mapTranscript, main };
