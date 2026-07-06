"use strict";

// test/docs-paved-road.test.js — the OFFLINE docs lint for the copy-paste front door
// (T-73.1: fenced `vh …` lines; T-74.2: fenced `npx …` lines + README publish-state consistency;
//  T-74.5: deploy-state consistency — the mainnet claim vs the stale not-deployed phrase).
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

// The public landing page is the OTHER copy-paste front door a stranger meets first (verifyhash.com,
// card 03). We lint the COMMITTED source `site/index.html`; scripts/site-release.js assembles public/
// from it and its own --check guarantees public/ matches byte-for-byte, so the source is the twin to
// pin. This closes the exact drift the 2026-07-05 audit found: the README was fixed but the identical
// broken `npx verifyhash` survived on the live front door, invisible to a markdown-only lint.
const LANDING_PAGES = [["site/index.html", path.join(REPO, "site", "index.html")]];

// ---------------------------------------------------------------------------------------------------
// 1. Extraction — every fenced `vh …` line, comment-stripped, continuation-joined, bracket-normalized
// ---------------------------------------------------------------------------------------------------

// extractFencedInvocations(markdown, docName, cmdWord) -> [{ doc, line, raw, rest }] for every line
// inside a ``` / ~~~ fence that (after joining trailing-`\` continuations and stripping `# …` comments)
// invokes `<cmdWord> …` (an optional leading `$ ` prompt is tolerated).
function extractFencedInvocations(markdown, docName, cmdWord) {
  const out = [];
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let pending = null; // accumulates `\`-continued lines
  const invokeRe = new RegExp("^\\s*(?:\\$\\s+)?" + cmdWord + "\\s+(.*)$");
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
    const m = text.match(invokeRe);
    if (!m) continue;
    out.push({ doc: docName, line: n + 1, raw: line.trim(), rest: m[1] });
  }
  return out;
}

function extractFencedVhInvocations(markdown, docName) {
  return extractFencedInvocations(markdown, docName, "vh");
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

// ---------------------------------------------------------------------------------------------------
// 4. npx front door (T-74.2) — every fenced `npx <pkg> …` must name a runnable bin, OFFLINE
//
//    History: the README's install block advertised `npx verifyhash --help`. The `verifyhash` package
//    ships TWO bins (`vh`, `vh-agent-hook`) and none named `verifyhash`, so npx errors with "could not
//    determine executable to run" — a broken command at the exact moment of highest stranger intent.
//    The rule npm itself applies: `npx <pkg>` resolves only when the package has exactly ONE bin or a
//    bin named after the (unscoped) package; `npx -p <pkg> <cmd>` runs <cmd>, which must be one of the
//    package's bin names. This lint applies the same rule to every fenced `npx …` doc line, resolving
//    each package's bin map OFFLINE (this repo's own package.json files + node_modules — no network).
// ---------------------------------------------------------------------------------------------------

// Packages whose package.json lives in THIS repo (not under node_modules).
const LOCAL_PKG_JSON = new Map([
  ["verifyhash", path.join(REPO, "package.json")],
  ["verify-vh", path.join(REPO, "verifier", "package.json")],
]);

// "@scope/name@^1.2.3" -> "@scope/name"; "name@1.2.3" -> "name".
function pkgNameOf(spec) {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at === -1 ? spec : spec.slice(0, at);
}

function unscopedNameOf(name) {
  const slash = name.lastIndexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

// binMapOf(name) -> { binName: relPath, … } | null when the package can't be resolved offline.
// A string `bin` means one bin named after the unscoped package name (npm's own rule).
function binMapOf(name) {
  let file = LOCAL_PKG_JSON.get(name);
  if (!file) {
    const inNodeModules = path.join(REPO, "node_modules", ...name.split("/"), "package.json");
    if (fs.existsSync(inNodeModules)) file = inNodeModules;
  }
  if (!file) return null;
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof pkg.bin === "string") return { [unscopedNameOf(pkg.name || name)]: pkg.bin };
  return pkg.bin || {};
}

// parseNpxInvocation("--yes -p verifyhash vh --help") -> { packages: ["verifyhash"], target: "vh" }.
// `packages` are the -p/--package specs; `target` is the first non-flag token — the PACKAGE in the
// plain `npx <pkg> …` form, or the COMMAND in the `npx -p <pkg> <cmd> …` form.
const NPX_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call", "--node-arg", "-n"]);
function parseNpxInvocation(rest) {
  const tokens = rest.split(/\s+/).filter((t) => t.length > 0);
  const packages = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") {
      i++;
      break;
    }
    const eq = t.match(/^(--[A-Za-z][A-Za-z0-9-]*)=(.*)$/);
    if (eq) {
      if (eq[1] === "--package") packages.push(eq[2]);
      continue;
    }
    if (t.startsWith("-")) {
      if (NPX_VALUE_FLAGS.has(t)) {
        const v = tokens[++i];
        if ((t === "-p" || t === "--package") && v) packages.push(v);
      }
      continue;
    }
    break; // first non-flag token
  }
  return { packages, target: i < tokens.length ? tokens[i] : null };
}

// The landing page tucks its copy-paste commands inside <pre><code> blocks with <span> markup and a
// few HTML entities, and (card 03) hides an ALTERNATIVE invocation inside a shell comment
// (`# or, no install: npx …`). So — UNLIKE the markdown extractor — we must NOT strip `# …` comments
// here (the npx lives inside one) and we must strip the span tags + decode entities first. We then
// match `npx …` ANYWHERE on a code line. Same downstream rule (lintNpxInvocations) as the markdown
// front door, so the two surfaces are held to ONE standard and can't drift apart again.
function decodeHtmlEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&"); // last, so a literal `&amp;lt;` is not double-decoded
}

// extractLandingNpxInvocations(html, docName) -> [{ doc, line, raw, rest }] for every `npx …` line
// inside a <pre><code> … </code></pre> block (tags stripped, entities decoded, comments PRESERVED).
function extractLandingNpxInvocations(html, docName) {
  const out = [];
  const blockRe = /<pre><code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/g;
  let bm;
  while ((bm = blockRe.exec(html)) !== null) {
    const blockStartLine = html.slice(0, bm.index).split(/\r?\n/).length;
    const innerLines = bm[1].split(/\r?\n/);
    for (let i = 0; i < innerLines.length; i++) {
      const text = decodeHtmlEntities(innerLines[i].replace(/<[^>]+>/g, "")).trim();
      const m = text.match(/(?:^|\s)npx\s+(.+)$/);
      if (!m) continue;
      out.push({ doc: docName, line: blockStartLine + i, raw: text, rest: m[1].trim() });
    }
  }
  return out;
}

// lintNpxInvocations(invocations) -> [problem strings] (empty = every fenced npx line could really run).
function lintNpxInvocations(invocations) {
  const problems = [];
  for (const inv of invocations) {
    const loc = `${inv.doc}:${inv.line}`;
    const { packages, target } = parseNpxInvocation(inv.rest);
    if (packages.length > 0) {
      // `npx -p <pkg> <cmd> …` — <cmd> must be a bin NAME in (one of) the named package(s).
      if (!target) {
        problems.push(`${loc}: \`npx -p …\` with no command to run — raw: ${inv.raw}`);
        continue;
      }
      const bins = new Set();
      let unresolved = null;
      for (const spec of packages) {
        const name = pkgNameOf(spec);
        const binMap = binMapOf(name);
        if (binMap === null) {
          unresolved = name;
          break;
        }
        for (const b of Object.keys(binMap)) bins.add(b);
      }
      if (unresolved) {
        problems.push(`${loc}: cannot resolve package \`${unresolved}\` offline to check its bin map — raw: ${inv.raw}`);
      } else if (!bins.has(target)) {
        problems.push(
          `${loc}: \`${target}\` is NOT a bin of ${packages.join(", ")} (bins: ${[...bins].sort().join(", ") || "none"}) — raw: ${inv.raw}`
        );
      }
      continue;
    }
    if (!target) {
      problems.push(`${loc}: bare \`npx\` with no package — raw: ${inv.raw}`);
      continue;
    }
    // Plain `npx <pkg> …` — npm runs it only if the package has ONE bin or a bin named after the package.
    const name = pkgNameOf(target);
    const binMap = binMapOf(name);
    if (binMap === null) {
      problems.push(`${loc}: cannot resolve package \`${name}\` offline to check its bin map — raw: ${inv.raw}`);
      continue;
    }
    const binNames = Object.keys(binMap);
    if (binNames.length !== 1 && !binNames.includes(unscopedNameOf(name))) {
      problems.push(
        `${loc}: \`npx ${name}\` cannot resolve an executable — package \`${name}\` has bins [${binNames.sort().join(", ")}] and none is named \`${unscopedNameOf(name)}\`; write \`npx --yes -p ${name} <bin> …\` instead — raw: ${inv.raw}`
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------
// 5. Publish-state consistency (T-74.2) — the README must never claim published AND not-published
//    (the exact contradiction the 2026-07-05 cold-stranger audit found: "# published on npm" in the
//    install block vs "intentionally not performed … until then, use the local install path" below it).
// ---------------------------------------------------------------------------------------------------

const PUBLISHED_CLAIM = /\bpublished on npm\b|npmjs\.com\/package\/verifyhash|\bis published\b/i;
const NOT_PUBLISHED_CLAIMS = [
  /\bnot (?:yet )?published\b/i,
  /\bintentionally not performed\b/i,
  /\buntil then, use the local\b/i,
  /\bnot (?:yet )?on (?:the )?(?:public )?npm\b/i,
];

function publicationClaims(text) {
  // Normalize the way a reader does: blockquote markers drop, line wraps become spaces — so a phrase
  // that happens to wrap across lines ("… is intentionally\n> not performed …") still matches.
  const t = text.replace(/\n>\s*/g, " ").replace(/\s+/g, " ");
  const notPublishedMatches = NOT_PUBLISHED_CLAIMS.filter((re) => re.test(t)).map(String);
  return {
    published: PUBLISHED_CLAIM.test(t),
    notPublished: notPublishedMatches.length > 0,
    notPublishedMatches,
  };
}

// ---------------------------------------------------------------------------------------------------
// 6. Deploy-state consistency (T-74.5) — a doc that claims the LIVE Polygon mainnet registry
//    (0x77d8eF88…, human-deployed 2026-07-03) must never ALSO carry the stale not-deployed phrasing
//    ("… until a human deploys the registry …") in its own prose — the exact contradiction class the
//    publish-state check above closed for npm, relocated to the chain.
//
//    CARVE-OUT (deliberate, load-bearing): the in-band anchored-receipt trust note is FROZEN — it
//    rides verbatim in every receipt ever built, INCLUDING the real mainnet receipts under anchors/,
//    and an edited note is the named `bad-receipt` reject. A doc that quotes that note byte-for-byte
//    (docs/ANCHORING.md must, per test/anchoring.docs.test.js) is quoting an artifact, not making a
//    claim — so the frozen note (read from the committed fixture receipt, the same bytes
//    cli/core/anchor-binding.js ships) is stripped BEFORE the lint runs. Any OTHER occurrence of the
//    not-deployed phrase next to the mainnet claim is drift and fails, naming the doc.
// ---------------------------------------------------------------------------------------------------

const MAINNET_REGISTRY_ADDRESS = "0x77d8eF881D5aeEda64788968D13f9146fE1A609B";
const NOT_DEPLOYED_PHRASES = [
  /until a human deploys/i,
  /no receipt from this repo is worth anything publicly/i,
  /not (?:yet )?deployed to (?:a |any )?(?:real |public |main)/i,
];

// The frozen in-band trust note, read from the committed fixture receipt (byte-identical to the
// shipped ANCHOR_TRUST_NOTE constant — test/anchoring.docs.test.js pins that equality).
const FROZEN_ANCHOR_NOTE = JSON.parse(
  fs.readFileSync(path.join(REPO, "examples", "anchoring", "anchored-receipt.local.json"), "utf8")
).note;

// The doc surfaces a stranger meets that may carry the mainnet claim. BACKLOG/STRATEGY history and
// code/test constants are out of scope on purpose: they record the past, they are not the front door.
const DEPLOY_STATE_DOCS = [
  "README.md",
  "docs/ADOPT.md",
  "docs/ANCHORING.md",
  "docs/GO-LIVE.md",
  "docs/SUPERVISOR-RUNBOOK.md",
  "docs/TRUST-BOUNDARIES.md",
  "docs/VENDOR-PROVENANCE.md",
  "examples/anchoring/README.md",
  "site/index.html",
];

// deployStateProblems(name, text) -> { claimsMainnet, problems } after stripping the frozen note.
function deployStateProblems(name, text) {
  const scrubbed = text.split(FROZEN_ANCHOR_NOTE).join(" ");
  const claimsMainnet = scrubbed.toLowerCase().includes(MAINNET_REGISTRY_ADDRESS.toLowerCase());
  const problems = [];
  if (claimsMainnet) {
    const flat = scrubbed.replace(/\n>\s*/g, " ").replace(/\s+/g, " ");
    for (const re of NOT_DEPLOYED_PHRASES) {
      if (re.test(flat)) {
        problems.push(
          `${name}: claims the LIVE mainnet registry (${MAINNET_REGISTRY_ADDRESS}) AND still carries the stale not-deployed phrase ${re}`
        );
      }
    }
  }
  return { claimsMainnet, problems };
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

describe("docs paved road: every fenced `npx …` line names a runnable bin + the README's publish state is self-consistent (T-74.2)", function () {
  const npxByDoc = new Map();
  const landingNpxByDoc = new Map();
  let readmeText;

  before(function () {
    for (const [name, file] of DOCS) {
      const text = fs.readFileSync(file, "utf8");
      npxByDoc.set(name, extractFencedInvocations(text, name, "npx"));
      if (name === "README.md") readmeText = text;
    }
    for (const [name, file] of LANDING_PAGES) {
      landingNpxByDoc.set(name, extractLandingNpxInvocations(fs.readFileSync(file, "utf8"), name));
    }
  });

  it("EXTRACTOR-ROT GUARD: extracts at least one `npx …` invocation from EACH front-door surface (markdown docs AND the landing page)", function () {
    for (const [name] of DOCS) {
      const got = npxByDoc.get(name);
      expect(got.length, `${name} must yield at least one fenced \`npx …\` invocation (extractor rot?)`).to.be.greaterThan(0);
    }
    for (const [name] of LANDING_PAGES) {
      const got = landingNpxByDoc.get(name);
      expect(got.length, `${name} must yield at least one <pre><code> \`npx …\` invocation (extractor rot?)`).to.be.greaterThan(0);
    }
  });

  it("every `npx <pkg> …` invocation names a bin present in that package's bin map (markdown docs AND the landing page — npx could really run it)", function () {
    const all = [...npxByDoc.values(), ...landingNpxByDoc.values()].flat();
    const problems = lintNpxInvocations(all);
    expect(problems, `npx front-door drift:\n  - ${problems.join("\n  - ")}`).to.deep.equal([]);
  });

  it("NEGATIVE SELF-TEST: `npx verifyhash` (multi-bin package, no bin named `verifyhash`) is DETECTED; the corrected `-p verifyhash vh` form and single-bin `verify-vh` pass", function () {
    // Precondition of the whole check: the verifyhash package really has multiple bins, none named
    // `verifyhash` — the shape that makes plain `npx verifyhash` unrunnable.
    const vhBins = Object.keys(binMapOf("verifyhash"));
    expect(vhBins, "verifyhash's bin map must contain `vh`").to.include("vh");
    expect(vhBins.length, "verifyhash must have multiple bins (else `npx verifyhash` would work)").to.be.greaterThan(1);
    expect(vhBins, "no bin is named after the package").to.not.include("verifyhash");

    const synthetic = [
      "```bash",
      "npx verifyhash --help", // the historical front-door bug: npx cannot pick an executable
      "npx --yes -p verifyhash vh --help", // the corrected form: `vh` IS in verifyhash's bin map
      "npx --yes verify-vh demo", // single bin named after the package — resolvable as-is
      "npx -p verify-vh frobnicate", // planted: a -p command that is NOT a bin of verify-vh
      "```",
    ].join("\n");
    const invocations = extractFencedInvocations(synthetic, "synthetic", "npx");
    expect(invocations.length, "the synthetic doc must extract all four npx lines").to.equal(4);

    const problems = lintNpxInvocations(invocations);
    const text = problems.join("\n");
    expect(text, "the checker must detect that plain `npx verifyhash` cannot resolve an executable").to.match(
      /synthetic:2:.*npx verifyhash.*cannot resolve an executable/
    );
    expect(text, "the checker must detect the -p command that is not a bin").to.match(/synthetic:5:.*frobnicate.*NOT a bin/);
    expect(
      problems.filter((p) => p.startsWith("synthetic:3:") || p.startsWith("synthetic:4:")),
      "the corrected `-p verifyhash vh` form and the single-bin `verify-vh` form must NOT be flagged"
    ).to.deep.equal([]);
    expect(problems.length, "exactly the two planted defects must be detected").to.equal(2);
  });

  it("NEGATIVE SELF-TEST: the landing-page extractor catches a broken `# or: npx verifyhash` hidden inside a <pre><code> comment span (the exact card-03 shape) and passes the corrected `-p verifyhash vh` form", function () {
    // The card-03 bug the truth pass exists to kill: the broken npx lives INSIDE a shell-comment span,
    // so a markdown-style comment-stripping extractor would drop it entirely. The landing extractor must
    // still see it, strip the <span> markup, and the shared lint must reject it.
    const brokenCard =
      '<pre><code>npm i -g <span class="a">verifyhash</span>   <span class="c"># or: npx verifyhash</span>\nvh --help</code></pre>';
    const brokenInv = extractLandingNpxInvocations(brokenCard, "landing-synthetic");
    expect(brokenInv.length, "must extract the npx hiding inside the comment span").to.equal(1);
    expect(lintNpxInvocations(brokenInv).join("\n"), "plain `npx verifyhash` on the landing page must be DETECTED too").to.match(
      /landing-synthetic:.*npx verifyhash.*cannot resolve an executable/
    );

    const fixedCard =
      '<pre><code>npm i -g <span class="a">verifyhash</span>   <span class="c"># or, no install: npx --yes -p verifyhash vh</span>\nvh --help</code></pre>';
    const fixedInv = extractLandingNpxInvocations(fixedCard, "landing-synthetic");
    expect(fixedInv.length, "must extract the corrected npx line").to.equal(1);
    expect(lintNpxInvocations(fixedInv), "the corrected `-p verifyhash vh` form must NOT be flagged").to.deep.equal([]);
  });

  it("the README never simultaneously claims PUBLISHED and NOT-published (and it does claim published, agreeing with site card 03)", function () {
    const claims = publicationClaims(readmeText);
    expect(claims.published, "README must state that `verifyhash` IS published on npm (site card 03 says so)").to.equal(true);
    expect(
      claims.notPublished,
      `README claims published AND not-published at once — contradicting markers: ${claims.notPublishedMatches.join(" , ")}`
    ).to.equal(false);
  });

  it("NEGATIVE SELF-TEST: the publish-state detector catches the historical README contradiction", function () {
    const stale =
      "# published on npm — https://www.npmjs.com/package/verifyhash\n" +
      "> Publishing `verifyhash` to the public npm registry is a **human action** and is intentionally\n" +
      "> not performed by the build. Until then, use the local install path above.\n";
    // The planted text line-wraps between "intentionally" and "not performed" — the detector's own
    // normalization must still catch it.
    const claims = publicationClaims(stale);
    expect(claims.published, "the stale README claimed published (install block)").to.equal(true);
    expect(claims.notPublished, "the stale README ALSO claimed not-published (the caveat)").to.equal(true);

    const clean = publicationClaims("`verifyhash` **is published** on the public npm registry.");
    expect(clean.published).to.equal(true);
    expect(clean.notPublished, "a consistent README must not trip the not-published markers").to.equal(false);
  });
});

describe("docs lint: deploy-state consistency — the mainnet claim never rides with the stale not-deployed phrase (T-74.5)", function () {
  it("every front-door doc that names the live Polygon mainnet registry is free of the not-deployed phrase (frozen in-band note carved out)", function () {
    const problems = [];
    const claimants = [];
    for (const rel of DEPLOY_STATE_DOCS) {
      const text = fs.readFileSync(path.join(REPO, rel), "utf8");
      const r = deployStateProblems(rel, text);
      if (r.claimsMainnet) claimants.push(rel);
      problems.push(...r.problems);
    }
    expect(problems, `deploy-state drift:\n  - ${problems.join("\n  - ")}`).to.deep.equal([]);
    // Anti-rot: the check has something to bite on — the primary front doors DO claim the deploy.
    for (const mustClaim of ["README.md", "docs/ANCHORING.md", "site/index.html"]) {
      expect(claimants, `${mustClaim} must name the live mainnet registry (2026-07-03 deploy)`).to.include(mustClaim);
    }
  });

  it("the frozen in-band trust note really is the carved-out bytes (it still carries the pre-deploy clause, verbatim)", function () {
    // The carve-out only makes sense while the FROZEN note is the thing carrying the old wording:
    // receipts pin it verbatim (an edited note is the named bad-receipt), so docs must quote it
    // unchanged even though the registry is now live. If the note itself is ever versioned, this
    // pin — and the carve-out — should be revisited together.
    expect(FROZEN_ANCHOR_NOTE).to.contain("until a human deploys the registry (STRATEGY.md P-2)");
    expect(FROZEN_ANCHOR_NOTE).to.contain("proves MECHANISM only");
  });

  it("NEGATIVE SELF-TEST: the stale phrase NEXT TO the mainnet claim is DETECTED; the frozen note alone is carved out; no-claim docs are exempt", function () {
    // (a) the drift shape this lint exists to kill: live-address claim + stale prose.
    const drifted =
      `The registry is live at ${MAINNET_REGISTRY_ADDRESS}.\n` +
      "> A receipt is worth nothing publicly until a human\n> deploys the registry.\n";
    const a = deployStateProblems("synthetic", drifted);
    expect(a.claimsMainnet).to.equal(true);
    expect(a.problems.length, "the line-wrapped stale phrase beside the mainnet claim must be detected").to.be.greaterThan(0);

    // (b) the carve-out: the FROZEN in-band note (byte-for-byte) beside the mainnet claim is fine —
    // that is exactly what docs/ANCHORING.md must ship.
    const quoted = `The registry is live at ${MAINNET_REGISTRY_ADDRESS}.\n\n> ${FROZEN_ANCHOR_NOTE}\n`;
    const b = deployStateProblems("synthetic", quoted);
    expect(b.claimsMainnet).to.equal(true);
    expect(b.problems, "the frozen verbatim note must NOT be flagged (it is an artifact, not a claim)").to.deep.equal([]);

    // (c) a doc that never claims the deploy may keep historical phrasing (it contradicts nothing).
    const historical = "Until a human deploys the registry, a local receipt proves mechanism only.\n";
    const c = deployStateProblems("synthetic", historical);
    expect(c.claimsMainnet).to.equal(false);
    expect(c.problems).to.deep.equal([]);
  });
});
