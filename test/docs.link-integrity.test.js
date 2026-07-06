"use strict";

// ---------------------------------------------------------------------------------------------------
// T-78.3 — tracked-markdown LINK INTEGRITY: the 73ec697 breakage class is a RED BUILD forever.
//
// 73ec697 untracked the loop's internal files (STRATEGY.md, BACKLOG.md, docs/MORNING.md, …) from the
// public repo while PUBLIC, tracked docs still LINKED them — so the public front door 404'd on its own
// links and nobody noticed until a Strategist archaeology pass (T-78.1/T-78.2 repaired the instances).
// This file makes the CLASS structurally impossible to regress silently:
//
//   (1) LINK INTEGRITY over every git-TRACKED .md file: extract each relative markdown link target
//       (inline `[t](x)`, images, and reference definitions `[l]: x`; code fences and inline code
//       spans are stripped so example snippets don't count), skip http(s)/mailto/data/any-scheme URIs
//       and pure #fragment links, strip #fragments + querystrings from kept targets, resolve against
//       the linking file's dir (or the repo root for /rooted targets), and FAIL naming
//       file:line -> target for any target that does NOT exist on disk OR exists but is NOT itself
//       git-tracked — the exact "public doc links an internal/gitignored file" class.
//
//   (2) DENYLIST, independent of check (1)'s parser: no site publish-set SOURCE file and no
//       tarball-shipped .md may contain a markdown link (or, for HTML sources, an href/src) whose
//       target is STRATEGY.md, docs/MORNING.md, docs/DECIDE.md, or BACKLOG.md. This is a raw-content
//       scan with its OWN regex — no fence-stripping, no existence/resolution logic — so a bug in the
//       main extractor can never mask a re-link of the four known-internal names.
//
//   (3) The T-78.1 structural invariant is PINNED here too: every source path in
//       site/publish-set.json is a git-tracked file (docs/DECIDE.md was the one untracked source).
//
// OFFLINE + DETERMINISTIC: git enumeration is `git ls-files` via child_process (local index only);
// the tarball .md set comes from `npm pack --dry-run --json` with npm_config_offline forced (reads
// only the working tree — same hardening as test/npm-tarball.test.js). No network, no writes.
// Suites that need git probe for a checkout first and skip VISIBLY outside one (extracted tarball).
// ---------------------------------------------------------------------------------------------------

const { expect } = require("chai");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const MAX_BUF = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------
// git enumeration (local-only): the tracked-file universe and the tracked-.md scan set.
// ---------------------------------------------------------------------------------------------------

function gitLsFiles(extraArgs) {
  const res = spawnSync("git", ["ls-files", "-z"].concat(extraArgs || []), {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: MAX_BUF,
  });
  if (res.error || res.status !== 0) return null; // not a git checkout (or no git binary)
  return res.stdout.split("\0").filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------------------------------
// The markdown link extractor for check (1).
// ---------------------------------------------------------------------------------------------------

// Any URI scheme (http:, https:, mailto:, data:, ipfs:, …) — never a repo-relative file target.
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

// Remove inline code spans (`…`, ``…``) so `[example](not/a/real/link)` inside code doesn't count.
function stripCodeSpans(line) {
  return line.replace(/(`+)[\s\S]*?\1/g, " ");
}

// An inline destination may be <bracketed> and/or carry a "title" — keep only the path part.
function parseDestination(raw) {
  let t = raw.trim();
  if (t.startsWith("<")) {
    const end = t.indexOf(">");
    return end === -1 ? t.slice(1) : t.slice(1, end);
  }
  return t.split(/\s/)[0];
}

// extractTargets(content) -> [{ line, target }] for every markdown link destination in `content`,
// with fenced code blocks skipped and inline code spans stripped. Covers inline links `[t](x)`,
// images `![a](x)`, and reference definitions `[label]: x`.
function extractTargets(content) {
  const out = [];
  const lines = content.split("\n");
  let fence = null; // the opening fence string while inside a fenced code block
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const fenceMatch = rawLine.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      // close only on a fence of the SAME character, at least as long (CommonMark)
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    const line = stripCodeSpans(rawLine);
    // inline links + images: `](destination)` — destination may contain one level of balanced parens
    const inline = /\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
    let m;
    while ((m = inline.exec(line)) !== null) out.push({ line: i + 1, target: parseDestination(m[1]) });
    // reference-style definitions: `[label]: destination`
    const ref = line.match(/^ {0,3}\[[^\]]+\]:\s+(\S+)/);
    if (ref) out.push({ line: i + 1, target: parseDestination(ref[1]) });
  }
  return out;
}

// classifyTarget(mdFile, target, tracked) -> null when the link is fine (external / pure-fragment /
// resolves to a tracked file or a directory with tracked content), else a short reason string.
function classifyTarget(mdFile, target, tracked) {
  if (!target || SCHEME_RE.test(target) || target.startsWith("//")) return null; // external URI
  if (target.startsWith("#")) return null; // pure in-page fragment
  let pathPart = target.split("#")[0].split("?")[0]; // strip fragment + querystring
  if (!pathPart) return null;
  try {
    pathPart = decodeURIComponent(pathPart);
  } catch (_) {
    /* keep the raw path — a malformed escape still names a real-ish target */
  }
  const abs = pathPart.startsWith("/")
    ? path.resolve(REPO, "." + pathPart) // /rooted -> repo root
    : path.resolve(path.dirname(path.join(REPO, mdFile)), pathPart); // relative -> the file's dir
  const rel = path.relative(REPO, abs).split(path.sep).join("/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) return "escapes the repo (can never be tracked)";
  if (!fs.existsSync(abs)) return "does not exist on disk";
  if (fs.statSync(abs).isDirectory()) {
    const prefix = rel === "" ? "" : rel + "/";
    for (const t of tracked) if (t.startsWith(prefix)) return null;
    return "directory contains no git-tracked file";
  }
  if (!tracked.has(rel)) return "exists on disk but is NOT git-tracked (internal/gitignored)";
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Check (2)'s independent raw scanner + the four denied internal names.
// ---------------------------------------------------------------------------------------------------

// The internal files 73ec697 untracked that public surfaces once linked. Denied by basename so a
// re-link under ANY relative spelling (../STRATEGY.md, ./docs/MORNING.md, /BACKLOG.md#x) is caught.
const DENIED_BASENAMES = ["STRATEGY.md", "MORNING.md", "DECIDE.md", "BACKLOG.md"];

function deniedName(dest) {
  const clean = dest.trim().replace(/^</, "").split(/[>#?\s]/)[0];
  if (SCHEME_RE.test(clean)) {
    // absolute URLs to our own site can 404 exactly the same way — still denied
    if (!/^https?:\/\/(www\.)?verifyhash\.com\//i.test(clean)) return null;
  }
  const base = clean.split("/").pop();
  return DENIED_BASENAMES.includes(base) ? base : null;
}

// Raw scan: markdown `](dest)` + reference definitions in ANY file, plus href/src attributes so the
// HTML publish sources (site/index.html) are covered by the same denylist.
function scanForDeniedLinks(relFile) {
  const abs = path.join(REPO, relFile);
  const content = fs.readFileSync(abs, "utf8");
  const hits = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const patterns = [
      /\]\(([^)]+)\)/g, // markdown inline link/image
      /^ {0,3}\[[^\]]+\]:\s+(\S+)/g, // markdown reference definition
      /(?:href|src)\s*=\s*["']([^"']+)["']/gi, // HTML publish sources
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(line)) !== null) {
        const name = deniedName(m[1]);
        if (name) hits.push(`${relFile}:${i + 1} -> ${m[1].trim()} (links denied internal file ${name})`);
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------------
// The tarball .md set for check (2): what `npm publish` would actually ship, from npm itself.
// Offline-hardened exactly like test/npm-tarball.test.js.
// ---------------------------------------------------------------------------------------------------

function tarballMdFiles() {
  const res = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: MAX_BUF,
    env: {
      ...process.env,
      npm_config_update_notifier: "false",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_loglevel: "error",
    },
  });
  expect(res.error, `npm pack failed to spawn: ${res.error && res.error.message}`).to.equal(undefined);
  expect(res.status, `npm pack --dry-run exited ${res.status}:\n${res.stderr}`).to.equal(0);
  const start = res.stdout.indexOf("[");
  expect(start, `npm pack --json output contained no JSON array:\n${res.stdout.slice(0, 500)}`).to.be.at.least(0);
  const report = JSON.parse(res.stdout.slice(start));
  expect(report, "npm pack --json must report exactly one package").to.have.length(1);
  return report[0].files.map((f) => f.path).filter((p) => p.toLowerCase().endsWith(".md"));
}

// ---------------------------------------------------------------------------------------------------
// (1) Link integrity over every tracked .md.
// ---------------------------------------------------------------------------------------------------

describe("T-78.3 (1): every relative link in every git-tracked .md resolves to a git-tracked path", function () {
  this.timeout(120000);

  it("no tracked .md links a missing or untracked file (violations named file:line -> target)", function () {
    const tracked = gitLsFiles();
    if (tracked === null) return this.skip(); // not a git checkout (e.g. extracted tarball)
    const trackedSet = new Set(tracked);
    const mdFiles = gitLsFiles(["--", "*.md"]);
    expect(mdFiles, "git ls-files '*.md' must enumerate the tracked docs").to.have.length.greaterThan(20);

    const violations = [];
    let scannedTargets = 0;
    for (const mdFile of mdFiles) {
      const abs = path.join(REPO, mdFile);
      if (!fs.existsSync(abs)) {
        violations.push(`${mdFile}:0 -> (tracked file missing from the working tree)`);
        continue;
      }
      for (const { line, target } of extractTargets(fs.readFileSync(abs, "utf8"))) {
        scannedTargets++;
        const reason = classifyTarget(mdFile, target, trackedSet);
        if (reason) violations.push(`${mdFile}:${line} -> ${target} (${reason})`);
      }
    }

    // The scan must have real coverage — an extractor regression that finds no links would
    // otherwise turn this whole guard into a silent no-op.
    expect(scannedTargets, "extractor found implausibly few link targets — extractor regression?").to.be.greaterThan(100);

    expect(
      violations,
      `broken/untracked markdown link target(s) — the 73ec697 breakage class:\n  ${violations.join("\n  ")}\n`
    ).to.deep.equal([]);
  });

  // The extractor itself is load-bearing: pin its behavior on the exact cases the main scan relies
  // on, so a future "simplification" can't quietly stop extracting (or start over-extracting).
  describe("extractor unit pins", function () {
    it("extracts inline links, images, and reference definitions with 1-based line numbers", function () {
      const md = "intro [a](docs/a.md) and ![img](img/x.png)\n\n[ref]: ../up.md\n[b](<sp aced.md> \"title\")";
      const got = extractTargets(md);
      expect(got).to.deep.equal([
        { line: 1, target: "docs/a.md" },
        { line: 1, target: "img/x.png" },
        { line: 3, target: "../up.md" },
        { line: 4, target: "sp aced.md" },
      ]);
    });

    it("skips fenced code blocks and inline code spans; scheme/fragment targets are classified as fine", function () {
      const md = "```md\n[fenced](not/real.md)\n```\nsee `[span](also/not/real.md)` ok\n[live](README.md)";
      const got = extractTargets(md);
      expect(got).to.deep.equal([{ line: 5, target: "README.md" }]);
      const tracked = new Set(["README.md"]);
      expect(classifyTarget("README.md", "https://example.com/x.md", tracked)).to.equal(null);
      expect(classifyTarget("README.md", "mailto:x@y.z", tracked)).to.equal(null);
      expect(classifyTarget("README.md", "data:text/plain;base64,aGk=", tracked)).to.equal(null);
      expect(classifyTarget("README.md", "#just-a-fragment", tracked)).to.equal(null);
      // fragment + querystring are STRIPPED from kept targets (README.md#x resolves to README.md)
      expect(classifyTarget("docs/ADOPT.md", "../README.md#quickstart?utm=1", tracked)).to.equal(null);
    });

    it("flags the two 73ec697 failure modes: not-on-disk and on-disk-but-untracked", function () {
      const tracked = new Set(["README.md"]);
      expect(classifyTarget("README.md", "docs/NO-SUCH-FILE-73ec697.md", tracked)).to.match(/does not exist/);
      // STRATEGY.md exists on THIS disk but is gitignored — the exact internal-file class
      if (fs.existsSync(path.join(REPO, "STRATEGY.md"))) {
        expect(classifyTarget("README.md", "STRATEGY.md", tracked)).to.match(/NOT git-tracked/);
      }
      expect(classifyTarget("README.md", "../outside.md", tracked)).to.match(/escapes the repo/);
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// (2) Denylist: publish-set sources + tarball-shipped .md never LINK the four internal names.
// ---------------------------------------------------------------------------------------------------

describe("T-78.3 (2): no publish-set source and no tarball-shipped .md links STRATEGY.md / docs/MORNING.md / docs/DECIDE.md / BACKLOG.md", function () {
  this.timeout(120000);

  it("every site/publish-set.json SOURCE file is free of links to the denied internal names", function () {
    const publishSet = JSON.parse(fs.readFileSync(path.join(REPO, "site", "publish-set.json"), "utf8"));
    const sources = Object.values(publishSet.publish);
    expect(sources, "publish set must not be empty").to.have.length.greaterThan(10);
    const hits = [];
    for (const src of sources) {
      expect(fs.existsSync(path.join(REPO, src)), `publish-set source missing on disk: ${src}`).to.equal(true);
      hits.push(...scanForDeniedLinks(src));
    }
    expect(hits, `publish-set source links a denied internal file:\n  ${hits.join("\n  ")}\n`).to.deep.equal([]);
  });

  it("every .md file npm would publish (`npm pack --dry-run --json`, offline) is free of such links", function () {
    const mds = tarballMdFiles();
    // README + user docs must actually be in the tarball, or this scan is vacuous.
    expect(mds).to.include("README.md");
    expect(mds).to.include("docs/TRUST-BOUNDARIES.md");
    const hits = [];
    for (const rel of mds) hits.push(...scanForDeniedLinks(rel));
    expect(hits, `tarball-shipped .md links a denied internal file:\n  ${hits.join("\n  ")}\n`).to.deep.equal([]);
  });

  it("denylist scanner unit pins: catches every spelling; is independent of fences (raw scan)", function () {
    expect(deniedName("STRATEGY.md")).to.equal("STRATEGY.md");
    expect(deniedName("../STRATEGY.md#p-3")).to.equal("STRATEGY.md");
    expect(deniedName("./docs/MORNING.md")).to.equal("MORNING.md");
    expect(deniedName("/docs/DECIDE.md?x=1")).to.equal("DECIDE.md");
    expect(deniedName("<BACKLOG.md>")).to.equal("BACKLOG.md");
    expect(deniedName("https://verifyhash.com/docs/DECIDE.md")).to.equal("DECIDE.md"); // our own site 404s too
    expect(deniedName("https://example.com/DECIDE.md")).to.equal(null); // third-party URL: not ours to deny
    expect(deniedName("docs/STRATEGY-ARCHIVE.md")).to.equal(null); // exact basenames only
    expect(deniedName("docs/ADOPT.md")).to.equal(null);
  });
});

// ---------------------------------------------------------------------------------------------------
// (3) The T-78.1 publish-set invariant, pinned in this guard too.
// ---------------------------------------------------------------------------------------------------

describe("T-78.3 (3): every source path in site/publish-set.json is git-tracked (T-78.1 invariant pinned)", function () {
  this.timeout(60000);

  it("no publish-set source is untracked (docs/DECIDE.md was the one — never again)", function () {
    const tracked = gitLsFiles();
    if (tracked === null) return this.skip(); // not a git checkout
    const trackedSet = new Set(tracked);
    const publishSet = JSON.parse(fs.readFileSync(path.join(REPO, "site", "publish-set.json"), "utf8"));
    const untrackedSources = Object.values(publishSet.publish).filter((src) => !trackedSet.has(src));
    expect(
      untrackedSources,
      `publish-set source(s) not git-tracked: ${untrackedSources.join(", ")}`
    ).to.deep.equal([]);
  });
});
