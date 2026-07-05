"use strict";

// test/docs-paved-road.test.js — the OFFLINE docs-flag lint for the copy-paste front door (T-73.1).
//
// WHY THIS TEST EXISTS
//   The paved road IS the product surface a stranger meets first: fenced `vh …` lines in README.md and
//   docs/ADOPT.md that they copy-paste verbatim. History shows this surface rots silently — a broken
//   `--registry` flag shipped on the front door (fixed in ce4f35b) because NOTHING machine-checked the
//   docs' invocations against the CLI that has to accept them. This suite closes that class:
//
//     1. It EXTRACTS every fenced `vh …` invocation from README.md and docs/ADOPT.md (joining `\`
//        continuations, stripping `# …` comments and usage-brackets like `[--git [--ref r]]`).
//     2. It resolves each invocation's SUBCOMMAND PATH against the CLI's own `vh --help` output (the
//        real usage() text, captured by actually running cli/vh.js — offline, no network): a command
//        family that requires a subcommand (e.g. `vh dataset …`) must be followed by one the help
//        actually offers.
//     3. It asserts every `--flag` used is ACCEPTED by the REAL parser: each unique (subcommand, flag)
//        pair is probed through cli/vh.js's exported main() in ONE throwaway subprocess (env scrubbed of
//        VH_*/key vars; no positionals supplied, so every command fail-fasts at parse/validation — no
//        file writes, no key, no network). A probe whose output names `unknown flag/option: --x` is a
//        REJECTED flag and fails this suite, pointing at the exact doc line.
//     4. EXTRACTOR-ROT GUARD: zero extracted invocations from either doc FAILS the suite — an extractor
//        that silently stops matching would otherwise "pass" forever.
//     5. NEGATIVE SELF-TEST: a synthetic doc with a known-bad flag (`--registry`, the historical bug),
//        a known-bad top-level command, and a known-bad nested subcommand must each be DETECTED, and a
//        known-good line must pass — proving the checker itself has teeth.
//
//   Everything is offline and dependency-free: node core + chai, spawning only THIS repo's cli/vh.js.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const VH_CLI = path.join(REPO, "cli", "vh.js");
const DOCS = [
  ["README.md", path.join(REPO, "README.md")],
  ["docs/ADOPT.md", path.join(REPO, "docs", "ADOPT.md")],
];

// ---------------------------------------------------------------------------------------------------
// 1. Extraction — every fenced `vh …` line, comment-stripped, continuation-joined, bracket-normalized
// ---------------------------------------------------------------------------------------------------

// extractFencedVhInvocations(markdown, docName) -> [{ doc, line, raw, rest }] for every line inside a
// ``` / ~~~ fence that (after joining trailing-`\` continuations and stripping `# …` comments) invokes
// `vh …` (an optional leading `$ ` prompt is tolerated).
function extractFencedVhInvocations(markdown, docName) {
  const out = [];
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let pending = null; // accumulates `\`-continued lines
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      pending = null;
      continue;
    }
    if (!inFence) continue;
    let text = pending === null ? line : pending + " " + line.trim();
    pending = null;
    if (/\\\s*$/.test(text)) {
      pending = text.replace(/\\\s*$/, "").trimEnd();
      continue;
    }
    text = text.replace(/(^|\s)#.*$/, "$1"); // strip a shell comment
    const m = text.match(/^\s*(?:\$\s+)?vh\s+(.*)$/);
    if (!m) continue;
    out.push({ doc: docName, line: n + 1, raw: line.trim(), rest: m[1] });
  }
  return out;
}

// Usage-notation brackets/alternation (`[--out <p>]`, `(--key-env <VAR>|--key-file <p>)`) are
// normalized to spaces so the flags inside them are still linted.
function tokenize(rest) {
  return rest
    .replace(/[[\]()|]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

const PLAIN_WORD = /^[a-z][a-z0-9-]*$/;

// The leading run of plain words is the candidate subcommand path ("evidence license fulfill" …);
// the first placeholder/flag/path token ends it.
function leadingWords(tokens) {
  const words = [];
  for (const t of tokens) {
    if (!PLAIN_WORD.test(t)) break;
    words.push(t);
  }
  return words;
}

function flagsOf(tokens) {
  const flags = [];
  for (const t of tokens) {
    const m = t.match(/^(--[A-Za-z][A-Za-z0-9-]*)/);
    if (m) flags.push(m[1]);
  }
  return [...new Set(flags)];
}

// ---------------------------------------------------------------------------------------------------
// 2. Subcommand model — derived from the CLI's OWN `vh --help` output
// ---------------------------------------------------------------------------------------------------

// A usage COMMAND line is an INDENTED line starting with "vh " (the un-indented "vh — verifyhash CLI"
// header is prose, not a usage entry).
function isUsageCmdLine(rawLine) {
  return /^[ \t]+vh /.test(rawLine);
}

function usageCmdLines(help) {
  return help.split(/\r?\n/).filter(isUsageCmdLine).map((l) => l.trim());
}

// Every `vh <word> <word>…` fragment mentioned ANYWHERE in the help — usage entries embed sibling
// verbs mid-line (e.g. the `vh agent redact` entry also documents `vh agent prove` / `vh agent
// verify-proof` / `vh agent checkpoint` / `vh agent verify-growth` on the same line).
function vhFragments(help) {
  const frags = [];
  const re = /(^|[\s(`"'.])vh((?: [a-z][a-z0-9-]+)+)/g;
  let m;
  while ((m = re.exec(help)) !== null) frags.push(m[2].trim().split(" "));
  return frags;
}

// The token immediately following "vh <path…>" on each LINE-START usage entry ("" = the entry IS
// exactly this path). This is the authoritative structure: if every next token is a plain word, the
// path is a command FAMILY that requires a subcommand.
function lineStartNextTokens(help, pathWords) {
  const prefix = "vh" + pathWords.map((w) => " " + w).join("");
  const set = new Set();
  for (const l of usageCmdLines(help)) {
    if (l === prefix) {
      set.add("");
      continue;
    }
    if (l.startsWith(prefix + " ")) {
      const restTokens = l.slice(prefix.length).trim().split(/\s+/);
      if (restTokens[0]) set.add(restTokens[0]);
    }
  }
  return set;
}

// All subcommand names the help offers under a path: line-start next tokens plus mid-line fragments.
function subcommandNames(help, pathWords, frags) {
  const names = new Set();
  for (const t of lineStartNextTokens(help, pathWords)) {
    if (t !== "" && PLAIN_WORD.test(t)) names.add(t);
  }
  for (const w of frags) {
    if (w.length > pathWords.length && pathWords.every((p, i) => w[i] === p)) names.add(w[pathWords.length]);
  }
  return names;
}

// resolveCommandPath(help, words, frags) -> { path, problem }: walk the invocation's leading words,
// requiring a help-offered subcommand at every level where the help's structure demands one, and
// stopping (positional mode) where a usage entry shows a placeholder/flag/opts instead.
function resolveCommandPath(help, words, frags) {
  const pathWords = [];
  for (let i = 0; i < words.length; i++) {
    const next = words[i];
    const lineStart = lineStartNextTokens(help, pathWords);
    const requiresSub = lineStart.size > 0 && [...lineStart].every((t) => t !== "" && PLAIN_WORD.test(t));
    if (!requiresSub) break;
    const names = subcommandNames(help, pathWords, frags);
    if (!names.has(next)) {
      return {
        path: pathWords,
        problem: `unknown ${pathWords.length ? "subcommand" : "command"} \`${next}\`${
          pathWords.length ? ` under \`vh ${pathWords.join(" ")}\`` : ""
        } (help offers: ${[...names].sort().join(", ")})`,
      };
    }
    pathWords.push(next);
  }
  return { path: pathWords, problem: null };
}

// ---------------------------------------------------------------------------------------------------
// 3. Flag probe — the REAL parser decides, in ONE offline subprocess
//    Each probe runs `main([...path, flag])` with env scrubbed and NO positionals: every command
//    fail-fasts at parse/validation (no key, no file writes, no network). The probe result is only
//    whether the CLI named the flag as `unknown flag/option: --x` — any other complaint (missing
//    positional, missing value, missing key/contract) means the flag itself IS accepted.
// ---------------------------------------------------------------------------------------------------

const PROBE_DRIVER =
  '"use strict";\n' +
  "const fs = require('fs');\n" +
  "const input = JSON.parse(fs.readFileSync(0, 'utf8'));\n" +
  "for (const k of ['VH_CONTRACT','VH_RPC_URL','AMOY_RPC_URL','PRIVATE_KEY']) delete process.env[k];\n" +
  "const { main } = require(input.vh);\n" +
  "(async () => {\n" +
  "  const results = [];\n" +
  "  const realErr = process.stderr.write.bind(process.stderr);\n" +
  "  const realOut = process.stdout.write.bind(process.stdout);\n" +
  "  for (const probe of input.probes) {\n" +
  "    let buf = '';\n" +
  "    const sink = (chunk) => { buf += String(chunk); return true; };\n" +
  "    process.stderr.write = sink;\n" +
  "    process.stdout.write = sink;\n" +
  "    let code = null;\n" +
  "    try { code = await main(probe.path.concat([probe.flag])); }\n" +
  "    catch (e) { buf += ' ' + String((e && e.message) || e); }\n" +
  "    process.stderr.write = realErr;\n" +
  "    process.stdout.write = realOut;\n" +
  "    const rejected = new RegExp('unknown (flag|option)[^\\\\n]*' + probe.flag + '(?![\\\\w-])').test(buf);\n" +
  "    results.push({ key: probe.key, rejected: rejected, code: code });\n" +
  "  }\n" +
  "  realOut(JSON.stringify(results));\n" +
  "})();\n";

// probeFlags(probes) -> Map key -> { rejected, code }. probes: [{ key, path:[…], flag:"--x" }].
function probeFlags(probes) {
  if (probes.length === 0) return new Map();
  for (const p of probes) {
    // The flag shape was already vetted by flagsOf(); assert it so the driver's regex needs no escaping.
    if (!/^--[A-Za-z][A-Za-z0-9-]*$/.test(p.flag)) throw new Error(`unsafe probe flag: ${p.flag}`);
  }
  const raw = execFileSync(process.execPath, ["-e", PROBE_DRIVER], {
    cwd: REPO,
    input: JSON.stringify({ vh: VH_CLI, probes }),
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return new Map(JSON.parse(raw).map((r) => [r.key, r]));
}

// ---------------------------------------------------------------------------------------------------
// The whole check: invocations -> [problem strings] (empty = every doc line is a real, accepted call)
// ---------------------------------------------------------------------------------------------------

function lintInvocations(help, frags, invocations) {
  const problems = [];
  const probeByKey = new Map();
  const perInvocation = [];
  for (const inv of invocations) {
    const tokens = tokenize(inv.rest);
    const words = leadingWords(tokens);
    const flags = flagsOf(tokens);
    if (words.length === 0) {
      // A flags-only invocation: only `vh --help` / `vh -h` are real (the same help this suite runs).
      for (const f of flags) {
        if (f !== "--help" && f !== "-h") problems.push(`${inv.doc}:${inv.line}: \`vh ${f}\` — no such top-level flag`);
      }
      if (flags.length === 0) problems.push(`${inv.doc}:${inv.line}: bare \`vh\` with no subcommand`);
      continue;
    }
    const { path: cmdPath, problem } = resolveCommandPath(help, words, frags);
    if (problem) {
      problems.push(`${inv.doc}:${inv.line}: ${problem} — raw: ${inv.raw}`);
      continue;
    }
    const pending = [];
    for (const f of flags) {
      const key = cmdPath.join(" ") + " " + f;
      if (!probeByKey.has(key)) probeByKey.set(key, { key, path: cmdPath, flag: f });
      pending.push({ key, flag: f });
    }
    perInvocation.push({ inv, cmdPath, pending });
  }
  const verdicts = probeFlags([...probeByKey.values()]);
  for (const { inv, cmdPath, pending } of perInvocation) {
    for (const { key, flag } of pending) {
      const v = verdicts.get(key);
      if (!v) {
        problems.push(`${inv.doc}:${inv.line}: internal error — no probe verdict for "${key}"`);
      } else if (v.rejected) {
        problems.push(
          `${inv.doc}:${inv.line}: \`vh ${cmdPath.join(" ")}\` REJECTS \`${flag}\` (unknown flag per the real parser) — raw: ${inv.raw}`
        );
      }
    }
  }
  return problems;
}

describe("docs paved road: every fenced `vh …` line in README/ADOPT is a real, accepted invocation (T-73.1)", function () {
  this.timeout(120000); // two short node subprocesses (help + probe driver); generous for slow CI boxes

  let help;
  let frags;
  const invocationsByDoc = new Map();

  before(function () {
    // The REAL help, from the REAL CLI entrypoint — offline, local, no network.
    help = execFileSync(process.execPath, [VH_CLI, "--help"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
    });
    frags = vhFragments(help);
    for (const [name, file] of DOCS) {
      invocationsByDoc.set(name, extractFencedVhInvocations(fs.readFileSync(file, "utf8"), name));
    }
  });

  it("EXTRACTOR-ROT GUARD: extracts at least one fenced `vh …` invocation from EACH front-door doc", function () {
    for (const [name] of DOCS) {
      const got = invocationsByDoc.get(name);
      expect(got.length, `${name} must yield at least one fenced \`vh …\` invocation (extractor rot?)`).to.be.greaterThan(0);
    }
  });

  it("every fenced invocation names a subcommand the CLI's own help offers, and every --flag is accepted by the REAL parser", function () {
    const all = [...invocationsByDoc.values()].flat();
    const problems = lintInvocations(help, frags, all);
    expect(problems, `front-door drift:\n  - ${problems.join("\n  - ")}`).to.deep.equal([]);
  });

  it("NEGATIVE SELF-TEST: a known-bad flag (--registry), a known-bad command, and a known-bad nested subcommand are each DETECTED (and a known-good line passes)", function () {
    const synthetic = [
      "```bash",
      "vh evidence seal ./dir --registry https://registry.example", // the historical front-door bug shape
      "vh frobnicate --json", // no such top-level command
      "vh dataset frobnicate ./x", // no such nested subcommand
      "vh hash ./f --git", // known-good: must NOT be flagged
      "```",
    ].join("\n");
    const invocations = extractFencedVhInvocations(synthetic, "synthetic");
    expect(invocations.length, "the synthetic doc must extract all four lines").to.equal(4);

    const problems = lintInvocations(help, frags, invocations);
    const text = problems.join("\n");
    expect(text, "the checker must detect the known-bad --registry flag").to.match(/synthetic:2:.*--registry/);
    expect(text, "the checker must detect the unknown top-level command").to.match(/synthetic:3:.*unknown command.*frobnicate/);
    expect(text, "the checker must detect the unknown nested subcommand").to.match(/synthetic:4:.*unknown subcommand.*frobnicate/);
    expect(
      problems.filter((p) => p.startsWith("synthetic:5:")),
      "the known-good `vh hash ./f --git` must NOT be flagged"
    ).to.deep.equal([]);
    expect(problems.length, "exactly the three planted defects must be detected").to.equal(3);
  });
});
