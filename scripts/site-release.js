#!/usr/bin/env node
"use strict";

// =================================================================================================
// scripts/site-release.js — the DETERMINISTIC verifyhash.com SITE-RELEASE ASSEMBLER (T-67.1).
//
// WHY THIS EXISTS
//   The public site's webroot used to be an UNTRACKED, hand-assembled `public/` staging dir: nothing
//   pinned what it contained, nothing said whether it still matched the committed sources, and the
//   runbook's "must NEVER be served" table was prose, not structure. This script applies the byte-pin
//   discipline the dist bundles already have (verifier/build-standalone.js --check) to the WHOLE site:
//
//     site/publish-set.json   the committed ALLOWLIST: published webroot path -> committed source path.
//                             The webroot is assembled from EXACTLY this mapping — nothing else can
//                             enter it, so the forbidden set (.git*, .env*, keys, internal ops docs)
//                             is excluded STRUCTURALLY, and defense-in-depth rules below refuse any
//                             allowlist entry that even names a forbidden file.
//     public/                 the assembled webroot (untracked staging; regenerate anytime).
//     RELEASE-MANIFEST.json   sorted relPaths, per-file sha256 + source path, total bytes — written
//                             into public/ (ships with the upload) AND as the committed twin
//                             site/RELEASE-MANIFEST.json (the drift pin).
//     site/DEPLOYED.json      the committed snapshot of what is believed LIVE (per-file sha256) —
//                             read by `--diff`, rewritten ONLY by `--mark-deployed` (T-67.2).
//
// USAGE
//   node scripts/site-release.js                  # assemble public/ deterministically + write both manifests;
//                                                 #   ALSO (T-74.3) GENERATES the `published SHA-256 of \`<file>\``
//                                                 #   digest lines in site/llms.txt from the release manifest —
//                                                 #   the ONE canonical published checksum; never hand-edit them
//   node scripts/site-release.js --check          # WRITE NOTHING; exit 1 naming every offender when public/,
//                                                 #   a source, or the committed manifest drifts from a fresh
//                                                 #   assembly, a NON-allowlisted file appears in public/, or
//                                                 #   the landing page's advertised "Published SHA-256:" no
//                                                 #   longer equals the shipped verify-vh-standalone.js/sidecar,
//                                                 #   or site/llms.txt's generated digest lines drift (LLMS DRIFT)
//   node scripts/site-release.js --diff           # WRITE NOTHING; compare site/DEPLOYED.json (what is believed
//                                                 #   LIVE) against a fresh assembly and print a per-file
//                                                 #   ADDED/CHANGED/REMOVED/UNCHANGED table + a one-line verdict.
//                                                 #   Staleness is a HUMAN decision signal, NOT a CI failure:
//                                                 #   exit 0 whether stale or clean; exit 3 (named error) ONLY
//                                                 #   on a malformed/missing snapshot.
//   node scripts/site-release.js --mark-deployed  # the ONE command the human runs AFTER uploading public/ to
//                                                 #   the live host: rewrite site/DEPLOYED.json to the current
//                                                 #   manifest + an ISO date note, so the next --diff is truthful.
//
// EXIT CODES: 0 ok/clean/stale-signal · 1 check RED or fatal · 2 usage · 3 malformed/missing DEPLOYED snapshot.
//
// GUARDRAILS: node-core only (fs/path/crypto). NO network, NO key, NO child process. The CLI writes
//   ONLY <repo>/public, <repo>/site/RELEASE-MANIFEST.json, the GENERATED digest lines of
//   <repo>/site/llms.txt, and (via --mark-deployed) <repo>/site/DEPLOYED.json — never outside the
//   repo. BOUNDARY (verbatim): the loop assembles and diffs INSIDE the repo only; uploading to the
//   live host is the human-owned P-11 step — never auto-executed.
//
// ONE CANONICAL PUBLISHED CHECKSUM (T-74.3)
//   Every surface that publishes the verifier bundle's sha256 — site/llms.txt, site/index.html, the
//   .sha256 sidecar, site/RELEASE-MANIFEST.json — must carry the IDENTICAL digest. site/index.html and
//   the sidecar were already cross-asserted; site/llms.txt used to be HAND-maintained and drifted
//   (the 2026-07-05 c73f795… incident: llms.txt published a checksum matching NOTHING, a trust-killer
//   on the exact page that tells agents to "cross-check your download"). Now the digest lines in
//   site/llms.txt are GENERATED by the no-flag run from the same fresh assembly the manifest records,
//   and `--check` goes RED (LLMS DRIFT) on any mismatch — the value can never hand-drift again.
//
//   NOTE — the LIVE site serves a PINNED bundle: verifyhash.com serves whatever release generation was
//   last uploaded; rebuilding verifier/dist/ in the repo changes NOTHING live. Redeploy is a
//   needs-human step (the P-11 flow, docs/DEPLOY-PUBLIC-SITE.md §3c). Until a human re-uploads,
//   site/DEPLOYED.json truthfully records the OLDER live generation and `--diff` reports it stale —
//   in-repo surfaces must still agree with each other at all times.
// =================================================================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO_ROOT = path.resolve(__dirname, "..");

const PUBLISH_SET_REL = "site/publish-set.json";
const MANIFEST_REL = "site/RELEASE-MANIFEST.json";
const DEPLOYED_REL = "site/DEPLOYED.json";
const WEBROOT_REL = "public";
const MANIFEST_NAME = "RELEASE-MANIFEST.json";

// The landing-page cross-assertion coordinates: when the webroot ships the offline verifier bundle,
// the landing page's advertised "Published SHA-256:" AND the bundle's own .sha256 sidecar MUST equal
// the sha256 of the shipped bundle. This closes the drift class where the producer rebuilds the bundle
// but forgets to update the buyer-facing hash on the page that tells buyers to "compare it yourself".
const LANDING_HTML_PATH = "index.html";
const VERIFY_BUNDLE_PATH = "verify-vh-standalone.js";
const VERIFY_SIDECAR_PATH = "verify-vh-standalone.js.sha256";

// T-74.3 — the machine-readable agent page also publishes the canonical checksum(s). Its digest lines
// are GENERATED (see syncLlms / llmsDigestProblems below), never hand-maintained. The browser bundle's
// digest is published too whenever the release ships it ("and .html if published").
const LLMS_PATH = "llms.txt";
const VERIFY_HTML_PATH = "verify-vh-standalone.html";
// A digest ANCHOR is a line like:  … published SHA-256 of `verify-vh-standalone.js`: …
// The owned 64-hex digest token sits after the anchor on the SAME line or on the NEXT line.
const LLMS_DIGEST_ANCHOR_RE = /published\s+SHA-?256\s+of\s+`([^`]+)`/i;

const PUBLISH_SET_SCHEMA = "vh-site-publish-set@1";
const MANIFEST_SCHEMA = "vh-site-release-manifest@1";

// ---------------------------------------------------------------------------------------------
// The FORBIDDEN set — defense-in-depth on top of allowlist-only assembly. Every rule names its
// reason so a violation is a NAMED failure, never a silent skip. Applied to BOTH sides of every
// publish-set entry (the published relPath AND the repo source path).
// ---------------------------------------------------------------------------------------------

const INTERNAL_FILES = new Set([
  "docs/DEPLOY-PUBLIC-SITE.md", // the deploy runbook — internal ops, explicitly never served
  "docs/USAGE-BUDGET.json", // loop spend telemetry
  "docs/METRICS.jsonl", // loop run telemetry
  "docs/MORNING.md", // internal ops briefing
  "docs/AUDIT.md", // internal audit notes
  "docs/VENDOR-PROVENANCE.md", // vendor-ops doc; its lead command is a maintainer script (scripts/), never shipped
  "docs/STRATEGY-ARCHIVE.md", // internal roadmap history
  "docs/DECISIONS-ARCHIVE.md", // internal decision history (curated out of STRATEGY.md)
  "STRATEGY.md",
  "BACKLOG.md",
  "HANDOFF.md",
  "AGENT_TEAM.md",
  "team.json",
  "build-loop.workflow.js",
  "build-loop.prev.js",
  "hardhat.config.js",
  ".scope-baseline.json",
]);

const INTERNAL_TREES = new Set([
  ".git",
  ".claude",
  "node_modules",
  "artifacts",
  "cache",
  "coverage",
  "typechain-types",
  "test", // committed hardhat dev keys live in test files — never near the webroot
  "scripts", // build internals (incl. this file)
]);

// NESTED internal trees: subtrees that live UNDER an otherwise-published top-level dir, so the
// top-level INTERNAL_TREES check (split("/")[0]) can't reach them. Each is forbidden as a whole,
// prefix-matched. docs/ is published, but docs/engine-archive/ holds md5-addressed rotating copies
// of the internal build-loop ORCHESTRATION ENGINE (the loop's brain) — never publish anywhere. The
// content-addressed filenames rotate, so we forbid the SUBTREE, not enumerable names.
const INTERNAL_TREE_PREFIXES = ["docs/engine-archive"];

const FORBIDDEN_RULES = [
  {
    reason: "hidden/dot path (.git*, .env*, .claude*, ...) — never published",
    test: (p) => p.split("/").some((seg) => seg.startsWith(".")),
  },
  {
    reason: "internal ops/roadmap file — never published",
    test: (p) => INTERNAL_FILES.has(p),
  },
  {
    reason: "internal tree (never a publish source or target)",
    test: (p) => INTERNAL_TREES.has(p.split("/")[0]),
  },
  {
    reason: "internal engine-archive subtree (rotating build-loop engine copies) — never published",
    test: (p) => INTERNAL_TREE_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/")),
  },
  {
    reason: "key/credential/env-shaped filename — never published",
    test: (p) => {
      const base = p.split("/").pop() || "";
      return (
        /\.(pem|key|p12|pfx|keystore|jks)$/i.test(base) ||
        /^id_(rsa|dsa|ecdsa|ed25519)/i.test(base) ||
        /\.vhclaim\.json$/i.test(base) ||
        /^\.?env(\..+)?$/i.test(base) ||
        /credential/i.test(base) ||
        /secret/i.test(base)
      );
    },
  },
];

// classifyForbidden(relPath) -> the named reason this path may NEVER be published, or null if clean.
function classifyForbidden(relPath) {
  for (const rule of FORBIDDEN_RULES) if (rule.test(relPath)) return rule.reason;
  return null;
}

// isSafeRelPath(p) -> true iff p is a plain, forward-slash, relative path with no traversal, no
// absolute root, no backslash, no empty/./.. segment, and only conservative filename characters.
function isSafeRelPath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 512) return false;
  if (p.includes("\\") || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  const segs = p.split("/");
  return segs.every((seg) => seg.length > 0 && seg !== "." && seg !== ".." && /^[A-Za-z0-9._@-]+$/.test(seg));
}

// ---------------------------------------------------------------------------------------------
// Publish-set loading + validation
// ---------------------------------------------------------------------------------------------

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// validatePublishSet(json, repoRoot) -> array of problem strings (empty = valid). Every problem
// NAMES the offending entry and the violated rule.
function validatePublishSet(json, repoRoot) {
  const problems = [];
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return [`${PUBLISH_SET_REL}: not a JSON object`];
  }
  if (json.schema !== PUBLISH_SET_SCHEMA) {
    problems.push(`${PUBLISH_SET_REL}: "schema" must be "${PUBLISH_SET_SCHEMA}" (got ${JSON.stringify(json.schema)})`);
  }
  const publish = json.publish;
  if (publish === null || typeof publish !== "object" || Array.isArray(publish) || Object.keys(publish).length === 0) {
    problems.push(`${PUBLISH_SET_REL}: "publish" must be a non-empty object mapping published relPath -> repo source path`);
    return problems;
  }
  for (const [pub, src] of Object.entries(publish)) {
    if (!isSafeRelPath(pub)) {
      problems.push(`${PUBLISH_SET_REL}: unsafe published path ${JSON.stringify(pub)} (must be a plain relative path, no "..", no "/" prefix, no "\\")`);
      continue;
    }
    if (pub === MANIFEST_NAME) {
      problems.push(`${PUBLISH_SET_REL}: published path "${pub}" is reserved for the generated manifest`);
    }
    const pubWhy = classifyForbidden(pub);
    if (pubWhy) problems.push(`${PUBLISH_SET_REL}: FORBIDDEN published path "${pub}" — ${pubWhy}`);
    if (!isSafeRelPath(src)) {
      problems.push(`${PUBLISH_SET_REL}: unsafe source path ${JSON.stringify(src)} for "${pub}" (must be a plain repo-relative path, no "..", no "/" prefix, no "\\")`);
      continue;
    }
    const srcWhy = classifyForbidden(src);
    if (srcWhy) problems.push(`${PUBLISH_SET_REL}: FORBIDDEN source "${src}" (for "${pub}") — ${srcWhy}`);
    if (!pubWhy && !srcWhy) {
      const abs = path.join(repoRoot, src);
      let st = null;
      try {
        st = fs.statSync(abs);
      } catch (_) {
        /* missing */
      }
      if (!st || !st.isFile()) {
        problems.push(`${PUBLISH_SET_REL}: source "${src}" (for "${pub}") does not exist as a regular file`);
      }
    }
  }
  return problems;
}

// loadPublishSet(repoRoot) -> { schema, publish } (validated). Throws, naming every offender, if
// the committed allowlist is missing, malformed, forbidden, or points at missing sources.
function loadPublishSet(repoRoot) {
  const abs = path.join(repoRoot, PUBLISH_SET_REL);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`${PUBLISH_SET_REL}: cannot read/parse (${err.message})`);
  }
  const problems = validatePublishSet(json, repoRoot);
  if (problems.length) throw new Error(`invalid publish set:\n  - ${problems.join("\n  - ")}`);
  return json;
}

// ---------------------------------------------------------------------------------------------
// Deterministic assembly (pure w.r.t. the filesystem: same committed sources -> same bytes)
// ---------------------------------------------------------------------------------------------

// assemble(repoRoot) -> { entries, manifest, manifestJson }. entries are sorted by published path;
// each is { path, source, bytes, sha256, content(Buffer) }. manifestJson is the exact, deterministic
// byte content of RELEASE-MANIFEST.json (no timestamps — two assemblies of the same tree are
// byte-identical by construction).
function assemble(repoRoot) {
  const set = loadPublishSet(repoRoot);
  const entries = Object.keys(set.publish)
    .sort()
    .map((pub) => {
      const source = set.publish[pub];
      const content = fs.readFileSync(path.join(repoRoot, source));
      return { path: pub, source, bytes: content.length, sha256: sha256Hex(content), content };
    });
  const manifest = {
    schema: MANIFEST_SCHEMA,
    publishSet: PUBLISH_SET_REL,
    fileCount: entries.length,
    totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
    files: entries.map((e) => ({ path: e.path, source: e.source, bytes: e.bytes, sha256: e.sha256 })),
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  return { entries, manifest, manifestJson };
}

// ---------------------------------------------------------------------------------------------
// Landing-page cross-assertion (honest-posture guard)
//   The site's whole pitch is "don't trust us — download the bundle and compare its hash yourself".
//   That only holds if the hash the page ADVERTISES equals the hash of the bundle the SAME release
//   ships. A silent producer-side drift (rebuild the bundle, forget the page) publishes a webroot
//   that fails its own cross-check — a false "tampered?" signal on the very product that sells hash
//   integrity. The file-by-file manifest is blind to this (it checks bytes==source, not the page's
//   embedded hash), so we assert the coupling explicitly at BOTH the assemble gate and --check.
// ---------------------------------------------------------------------------------------------

// extractPublishedHash(html) -> the 64-hex sha256 the landing page advertises right after its
// "Published SHA-256:" label, or null if the page carries no such advertised hash.
function extractPublishedHash(html) {
  if (typeof html !== "string") return null;
  const at = html.search(/Published\s+SHA-?256/i);
  if (at === -1) return null;
  const m = html.slice(at).match(/\b[0-9a-f]{64}\b/);
  return m ? m[0] : null;
}

// parseSidecarHash(text) -> the first 64-hex sha256 token in a `sha256sum`-style sidecar, or null.
function parseSidecarHash(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/\b[0-9a-f]{64}\b/);
  return m ? m[0] : null;
}

// landingConsistencyProblems(assembly) -> array of NAMED problems (empty = consistent). Only applies
// when the webroot actually ships the verifier bundle; then the page's advertised hash and the
// bundle's .sha256 sidecar must BOTH equal the shipped bundle's sha256.
function landingConsistencyProblems(assembly) {
  const byPath = new Map(assembly.entries.map((e) => [e.path, e]));
  const bundle = byPath.get(VERIFY_BUNDLE_PATH);
  if (!bundle) return []; // this webroot does not ship the verifier — nothing to cross-check
  const problems = [];

  const sidecar = byPath.get(VERIFY_SIDECAR_PATH);
  if (sidecar) {
    const sh = parseSidecarHash(sidecar.content.toString("utf8"));
    if (sh !== bundle.sha256) {
      problems.push(
        `LANDING/SIDECAR DRIFT: "${VERIFY_SIDECAR_PATH}" pins ${sh || "(no 64-hex hash)"} but the shipped "${VERIFY_BUNDLE_PATH}" is ${bundle.sha256} — regenerate the dist sidecar`
      );
    }
  }

  const landing = byPath.get(LANDING_HTML_PATH);
  if (landing) {
    const advertised = extractPublishedHash(landing.content.toString("utf8"));
    if (advertised === null) {
      problems.push(
        `LANDING PAGE DRIFT: "${LANDING_HTML_PATH}" ships "${VERIFY_BUNDLE_PATH}" but advertises no "Published SHA-256:" hash to cross-check — publish the shipped bundle's sha256 (${bundle.sha256}) on the page`
      );
    } else if (advertised !== bundle.sha256) {
      problems.push(
        `LANDING PAGE DRIFT: "${LANDING_HTML_PATH}" advertises Published SHA-256 ${advertised} but the shipped "${VERIFY_BUNDLE_PATH}" is ${bundle.sha256} — update site/index.html's Published SHA-256, then re-run \`node scripts/site-release.js\``
      );
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------
// llms.txt published-checksum ownership (T-74.3)
//   site/llms.txt tells AI agents to "cross-check your download" against a published SHA-256. That
//   value used to be HAND-maintained — and drifted (2026-07-05: it published c73f795…, matching no
//   shipped bundle; the supervisor hot-fixed the live value to 6de719e… and redeployed). This section
//   makes the fix STRUCTURAL: the digest lines are GENERATED from the same fresh assembly the release
//   manifest records (one canonical checksum), and any mismatch is a NAMED `--check` failure.
// ---------------------------------------------------------------------------------------------

// parseLlmsDigestAnchors(text) -> [{ file, digest|null, line, digestLine|null, digestIndex|null }].
// An anchor is a line matching LLMS_DIGEST_ANCHOR_RE; its owned digest is the first 64-hex token after
// the anchor on the same line, else the first 64-hex token on the next line (digest === null if none).
function parseLlmsDigestAnchors(text) {
  const lines = String(text).split("\n");
  const anchors = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LLMS_DIGEST_ANCHOR_RE);
    if (!m) continue;
    const afterAnchor = m.index + m[0].length;
    let tok = lines[i].slice(afterAnchor).match(/\b[0-9a-f]{64}\b/);
    let digestLine = i;
    let digestIndex = tok ? afterAnchor + tok.index : null;
    if (!tok && i + 1 < lines.length) {
      tok = lines[i + 1].match(/\b[0-9a-f]{64}\b/);
      if (tok) {
        digestLine = i + 1;
        digestIndex = tok.index;
      }
    }
    anchors.push({
      file: m[1],
      digest: tok ? tok[0] : null,
      line: i,
      digestLine: tok ? digestLine : null,
      digestIndex: tok ? digestIndex : null,
    });
  }
  return anchors;
}

// renderLlmsDigests(text, digestByPath) -> { text, problems, updated }. PURE: rewrites every anchored
// digest token to digestByPath.get(file) (64 hex chars replaced in place — layout untouched). problems
// (all NAMED) are the non-generatable shapes: an anchor naming a file the publish set does not ship,
// an anchor with no digest token to own, or a MISSING required anchor — the canonical checksum of
// verify-vh-standalone.js (and of verify-vh-standalone.html if published) MUST be published.
function renderLlmsDigests(text, digestByPath) {
  const problems = [];
  const updated = [];
  const lines = String(text).split("\n");
  const anchors = parseLlmsDigestAnchors(text);
  for (const a of anchors) {
    if (!digestByPath.has(a.file)) {
      problems.push(`${LLMS_PATH} digest anchor names "${a.file}", which the publish set does not ship — fix the anchor or the publish set`);
      continue;
    }
    if (a.digest === null) {
      problems.push(`${LLMS_PATH} digest anchor for "${a.file}" has no 64-hex digest token (same or next line) to own — restore the digest line`);
      continue;
    }
    const want = digestByPath.get(a.file);
    if (a.digest !== want) {
      const ln = lines[a.digestLine];
      lines[a.digestLine] = ln.slice(0, a.digestIndex) + want + ln.slice(a.digestIndex + 64);
      updated.push({ file: a.file, from: a.digest, to: want });
    }
  }
  const anchored = new Set(anchors.map((a) => a.file));
  for (const req of [VERIFY_BUNDLE_PATH, VERIFY_HTML_PATH]) {
    if (digestByPath.has(req) && !anchored.has(req)) {
      problems.push(
        `${LLMS_PATH} must publish the sha256 of "${req}" (the release ships it) — add a line like \`published SHA-256 of \`${req}\`:\` followed by the digest, then re-run \`node scripts/site-release.js\``
      );
    }
  }
  return { text: lines.join("\n"), problems, updated };
}

// syncLlms(repoRoot) -> { changed, sourceRel, updated }. The OWNERSHIP write (T-74.3): regenerates the
// digest lines of the llms.txt SOURCE (per the publish set) from the sha256 of every other publish-set
// source — exactly the values the release manifest records, so llms.txt can never hand-drift from it.
// No-op when the publish set does not publish llms.txt. Throws (naming every offender) on the
// non-generatable shapes. Called by release() BEFORE assembly so the assembled webroot + manifest pin
// the freshly generated bytes; `--check` never calls this (it writes nothing).
function syncLlms(repoRoot) {
  const set = loadPublishSet(repoRoot);
  if (!Object.prototype.hasOwnProperty.call(set.publish, LLMS_PATH)) {
    return { changed: false, sourceRel: null, updated: [] };
  }
  const sourceRel = set.publish[LLMS_PATH];
  const digestByPath = new Map();
  for (const [pub, src] of Object.entries(set.publish)) {
    if (pub === LLMS_PATH) continue; // self-referential — llms.txt never publishes its own digest
    digestByPath.set(pub, sha256Hex(fs.readFileSync(path.join(repoRoot, src))));
  }
  const abs = path.join(repoRoot, sourceRel);
  const before = fs.readFileSync(abs, "utf8");
  const rendered = renderLlmsDigests(before, digestByPath);
  if (rendered.problems.length) {
    throw new Error(`site-release: cannot generate the ${sourceRel} published checksums:\n  - ${rendered.problems.join("\n  - ")}`);
  }
  if (rendered.text !== before) {
    fs.writeFileSync(abs, rendered.text);
    return { changed: true, sourceRel, updated: rendered.updated };
  }
  return { changed: false, sourceRel, updated: [] };
}

// llmsDigestProblems(assembly) -> array of NAMED problems (empty = consistent). The read-only twin of
// syncLlms for check()/release()/markDeployed(): when the webroot ships llms.txt, every digest it
// advertises must equal the sha256 of the shipped file it names, and the required anchors (the js
// bundle; the html bundle if published) must exist. Mirrors landingConsistencyProblems' posture.
function llmsDigestProblems(assembly) {
  const byPath = new Map(assembly.entries.map((e) => [e.path, e]));
  const llms = byPath.get(LLMS_PATH);
  if (!llms) return []; // this webroot does not ship llms.txt — nothing to cross-check
  const problems = [];
  const anchors = parseLlmsDigestAnchors(llms.content.toString("utf8"));
  for (const a of anchors) {
    const target = byPath.get(a.file);
    if (!target) {
      problems.push(`LLMS DRIFT: "${LLMS_PATH}" publishes a SHA-256 for "${a.file}" but this release does not ship it — fix the anchor or the publish set`);
      continue;
    }
    if (a.digest === null) {
      problems.push(`LLMS DRIFT: "${LLMS_PATH}" has a published-SHA-256 anchor for "${a.file}" but no 64-hex digest — re-run \`node scripts/site-release.js\` (it generates the value)`);
      continue;
    }
    if (a.digest !== target.sha256) {
      problems.push(
        `LLMS DRIFT: "${LLMS_PATH}" publishes SHA-256 ${a.digest} for "${a.file}" but the shipped file is ${target.sha256} — re-run \`node scripts/site-release.js\` (the digest is GENERATED from the release manifest; never hand-edit it)`
      );
    }
  }
  const anchored = new Set(anchors.map((a) => a.file));
  for (const req of [VERIFY_BUNDLE_PATH, VERIFY_HTML_PATH]) {
    if (byPath.has(req) && !anchored.has(req)) {
      problems.push(
        `LLMS DRIFT: "${LLMS_PATH}" ships alongside "${req}" but publishes no SHA-256 for it — the canonical checksum must be published (add the \`published SHA-256 of \`${req}\`:\` anchor, then re-run \`node scripts/site-release.js\`)`
      );
    }
  }
  return problems;
}

// writeAssembly(outDir, assembly) -> REPLACE-writes the assembled webroot into outDir (the publish
// set's files + RELEASE-MANIFEST.json, nothing else). Refuses to wipe a directory that does not look
// like an assembled webroot, so a mistyped path cannot delete unrelated work.
function writeAssembly(outDir, assembly) {
  let st = null;
  try {
    st = fs.statSync(outDir);
  } catch (_) {
    /* absent is fine */
  }
  if (st) {
    if (!st.isDirectory()) throw new Error(`site-release: "${outDir}" exists and is not a directory`);
    const names = fs.readdirSync(outDir);
    const looksLikeWebroot = names.length === 0 || names.includes("index.html") || names.includes(MANIFEST_NAME);
    if (!looksLikeWebroot) {
      throw new Error(`site-release: refusing to wipe "${outDir}" — no index.html/${MANIFEST_NAME}, does not look like an assembled webroot`);
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const e of assembly.entries) {
    const abs = path.join(outDir, e.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, e.content);
  }
  fs.writeFileSync(path.join(outDir, MANIFEST_NAME), assembly.manifestJson);
}

// release(repoRoot) -> assemble + write <repo>/public AND the committed twin site/RELEASE-MANIFEST.json.
// FIRST regenerates llms.txt's published digest lines (T-74.3 — the one canonical checksum), THEN
// REFUSES to write a self-contradicting webroot (page/llms hash != shipped bundle) so drift cannot ship.
function release(repoRoot) {
  const llmsSync = syncLlms(repoRoot); // GENERATE the published checksums before assembling
  const assembly = assemble(repoRoot); // the assembly (and manifest) pins the freshly generated bytes
  const drift = landingConsistencyProblems(assembly).concat(llmsDigestProblems(assembly));
  if (drift.length) {
    throw new Error(`site-release: refusing to assemble a self-contradicting webroot:\n  - ${drift.join("\n  - ")}`);
  }
  writeAssembly(path.join(repoRoot, WEBROOT_REL), assembly);
  fs.writeFileSync(path.join(repoRoot, MANIFEST_REL), assembly.manifestJson);
  assembly.llmsSync = llmsSync;
  return assembly;
}

// ---------------------------------------------------------------------------------------------
// --check: writes NOTHING; every drift/tamper/stowaway is a named problem
// ---------------------------------------------------------------------------------------------

function walkFiles(dir, prefix, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(abs).isDirectory()) walkFiles(abs, rel, out);
    else out.push(rel);
  }
  return out;
}

// check(repoRoot) -> { ok, problems }. Green iff: the committed manifest equals a fresh assembly
// (no source drift), and public/ contains EXACTLY the publish set + RELEASE-MANIFEST.json with the
// assembled bytes (no tamper, no stowaway, nothing missing).
function check(repoRoot) {
  const problems = [];

  let assembly;
  try {
    assembly = assemble(repoRoot);
  } catch (err) {
    return { ok: false, problems: [err.message] };
  }
  const freshByPath = new Map(assembly.entries.map((e) => [e.path, e]));

  // (a) SOURCE DRIFT — the committed twin manifest must equal a fresh assembly of today's sources.
  const manifestAbs = path.join(repoRoot, MANIFEST_REL);
  if (!fs.existsSync(manifestAbs)) {
    problems.push(`${MANIFEST_REL}: missing — run \`node scripts/site-release.js\` and commit it`);
  } else {
    const committedRaw = fs.readFileSync(manifestAbs, "utf8");
    let committed = null;
    try {
      committed = JSON.parse(committedRaw);
    } catch (err) {
      problems.push(`${MANIFEST_REL}: unparseable (${err.message})`);
    }
    if (committed && Array.isArray(committed.files)) {
      const committedByPath = new Map(committed.files.map((f) => [f.path, f]));
      for (const [p, e] of freshByPath) {
        const c = committedByPath.get(p);
        if (!c) {
          problems.push(`SOURCE DRIFT: "${p}" (source ${e.source}) is in the publish set but NOT in the committed ${MANIFEST_REL} — re-run \`node scripts/site-release.js\``);
        } else if (c.sha256 !== e.sha256) {
          problems.push(`SOURCE DRIFT: "${p}" (source ${e.source}) no longer matches the committed ${MANIFEST_REL} — re-run \`node scripts/site-release.js\``);
        }
      }
      for (const p of committedByPath.keys()) {
        if (!freshByPath.has(p)) {
          problems.push(`SOURCE DRIFT: "${p}" is in the committed ${MANIFEST_REL} but no longer in the publish set — re-run \`node scripts/site-release.js\``);
        }
      }
      if (committedRaw !== assembly.manifestJson && problems.length === 0) {
        problems.push(`${MANIFEST_REL}: differs from a fresh assembly (metadata/format drift) — re-run \`node scripts/site-release.js\``);
      }
    } else if (committed) {
      problems.push(`${MANIFEST_REL}: malformed (missing "files" array) — re-run \`node scripts/site-release.js\``);
    }
  }

  // (b) STAGED WEBROOT — public/ must hold EXACTLY the assembled publish set, byte-for-byte.
  const webroot = path.join(repoRoot, WEBROOT_REL);
  if (!fs.existsSync(webroot) || !fs.statSync(webroot).isDirectory()) {
    problems.push(`${WEBROOT_REL}/: missing — run \`node scripts/site-release.js\` to assemble it`);
    return { ok: problems.length === 0, problems };
  }
  const staged = walkFiles(webroot, "", []);
  const stagedSet = new Set(staged);
  for (const rel of staged) {
    if (rel === MANIFEST_NAME) {
      const bytes = fs.readFileSync(path.join(webroot, rel), "utf8");
      if (bytes !== assembly.manifestJson) {
        problems.push(`TAMPERED: "${WEBROOT_REL}/${MANIFEST_NAME}" differs from a fresh assembly's manifest — re-run \`node scripts/site-release.js\``);
      }
      continue;
    }
    const e = freshByPath.get(rel);
    if (!e) {
      const why = classifyForbidden(rel);
      problems.push(
        `NOT ALLOWLISTED: "${WEBROOT_REL}/${rel}" is not in ${PUBLISH_SET_REL}${why ? ` (and matches the forbidden set: ${why})` : ""} — the webroot may contain ONLY the publish set`
      );
      continue;
    }
    const got = sha256Hex(fs.readFileSync(path.join(webroot, rel)));
    if (got !== e.sha256) {
      problems.push(`TAMPERED: "${WEBROOT_REL}/${rel}" differs from its committed source (${e.source}) — re-run \`node scripts/site-release.js\``);
    }
  }
  for (const [p] of freshByPath) {
    if (!stagedSet.has(p)) {
      problems.push(`MISSING: "${WEBROOT_REL}/${p}" is in the publish set but absent from the staged webroot — re-run \`node scripts/site-release.js\``);
    }
  }
  if (!stagedSet.has(MANIFEST_NAME)) {
    problems.push(`MISSING: "${WEBROOT_REL}/${MANIFEST_NAME}" — re-run \`node scripts/site-release.js\``);
  }

  // (c) LANDING-PAGE CROSS-ASSERTION — the page's advertised "Published SHA-256:" and the bundle's
  // .sha256 sidecar must equal the sha256 of the shipped verify-vh-standalone.js, so a bundle change
  // not mirrored on the buyer-facing page FAILS the gate instead of publishing a webroot that fails
  // its own "compare the hash yourself" cross-check.
  for (const p of landingConsistencyProblems(assembly)) problems.push(p);

  // (d) LLMS PUBLISHED-CHECKSUM OWNERSHIP (T-74.3) — every SHA-256 llms.txt publishes must equal the
  // sha256 of the shipped file it names (and the required anchors must exist). The values are
  // GENERATED by the no-flag run; a hand-edit — the exact 2026-07-05 c73f795… failure — goes RED here.
  for (const p of llmsDigestProblems(assembly)) problems.push(p);

  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------------------------
// site/DEPLOYED.json — the committed what-is-believed-live snapshot (consumed by T-67.2 --diff)
// ---------------------------------------------------------------------------------------------

// loadDeployedSnapshot(repoRoot) -> the parsed, schema-validated snapshot. Throws (naming the
// offending field/path) on any malformation.
function loadDeployedSnapshot(repoRoot) {
  const abs = path.join(repoRoot, DEPLOYED_REL);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`${DEPLOYED_REL}: cannot read/parse (${err.message})`);
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`${DEPLOYED_REL}: not a JSON object`);
  }
  for (const field of ["generatedFrom", "deployedAtNote"]) {
    if (typeof json[field] !== "string" || json[field].trim().length === 0) {
      throw new Error(`${DEPLOYED_REL}: "${field}" must be a non-empty string`);
    }
  }
  // optional — present iff the snapshot was written by --mark-deployed (the 2026-06-26 baseline predates it)
  if ("markedDeployedAt" in json && !isIsoUtc(json.markedDeployedAt)) {
    throw new Error(`${DEPLOYED_REL}: "markedDeployedAt" must be an ISO-8601 UTC timestamp (got ${JSON.stringify(json.markedDeployedAt)})`);
  }
  const files = json.files;
  if (files === null || typeof files !== "object" || Array.isArray(files) || Object.keys(files).length === 0) {
    throw new Error(`${DEPLOYED_REL}: "files" must be a non-empty object mapping relPath -> sha256`);
  }
  for (const [rel, hash] of Object.entries(files)) {
    if (!isSafeRelPath(rel)) throw new Error(`${DEPLOYED_REL}: unsafe relPath ${JSON.stringify(rel)} in "files"`);
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`${DEPLOYED_REL}: "files.${rel}" must be a lowercase 64-hex sha256 (got ${JSON.stringify(hash)})`);
    }
  }
  return json;
}

// ---------------------------------------------------------------------------------------------
// --diff / --mark-deployed — make live-site DRIFT visible and the human refresh DECISION-READY.
//
//   The repo's ONLY deployed outward asset is verifyhash.com, and the repo cannot see it. What it
//   CAN see is the committed record of what was uploaded last (site/DEPLOYED.json) and what a fresh
//   release of today's sources would publish. `--diff` compares the two and prints a per-file
//   ADDED/CHANGED/REMOVED/UNCHANGED table + a one-line verdict — a HUMAN decision signal (exit 0
//   whether stale or clean; ONLY a malformed/missing snapshot is an error, exit 3). After the human
//   uploads (the P-11 step the loop must never take), `--mark-deployed` rewrites the snapshot to the
//   current manifest + an ISO date note so the next `--diff` is truthful.
//
//   BOUNDARY (verbatim): the loop assembles and diffs INSIDE the repo only; uploading to the live
//   host is the human-owned P-11 step — never auto-executed.
// ---------------------------------------------------------------------------------------------

function isIsoUtc(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s);
}

// diffDeployed(repoRoot) -> { rows, total, differing, stale, verdict }. rows are sorted by published
// path over the UNION of (fresh release manifest, deployed snapshot); each is { path, status, live,
// release } with status one of ADDED (published now, not on the live site yet) / CHANGED (both, hash
// differs) / REMOVED (still recorded live, no longer published) / UNCHANGED. Throws with
// err.snapshotError=true when site/DEPLOYED.json is missing/malformed (the CLI maps that to exit 3).
function diffDeployed(repoRoot) {
  let snapshot;
  try {
    snapshot = loadDeployedSnapshot(repoRoot);
  } catch (err) {
    err.snapshotError = true;
    throw err;
  }
  const assembly = assemble(repoRoot);
  const releaseByPath = new Map(assembly.manifest.files.map((f) => [f.path, f.sha256]));
  const paths = [...new Set([...releaseByPath.keys(), ...Object.keys(snapshot.files)])].sort();
  const rows = paths.map((p) => {
    const release = releaseByPath.has(p) ? releaseByPath.get(p) : null;
    const live = Object.prototype.hasOwnProperty.call(snapshot.files, p) ? snapshot.files[p] : null;
    const status = release === null ? "REMOVED" : live === null ? "ADDED" : live === release ? "UNCHANGED" : "CHANGED";
    return { path: p, status, live, release };
  });
  const differing = rows.filter((r) => r.status !== "UNCHANGED").length;
  const stale = differing > 0;
  const verdict = stale
    ? `live site is stale: ${differing} of ${rows.length} published files differ — refresh per P-11 (release → upload per docs/DEPLOY-PUBLIC-SITE.md → \`--mark-deployed\`)`
    : `live site matches the current release (${rows.length} published files, per ${DEPLOYED_REL})`;
  return { rows, total: rows.length, differing, stale, verdict };
}

// markDeployed(repoRoot, nowIso?) -> the snapshot it wrote to site/DEPLOYED.json: the current fresh
// assembly's per-file sha256 map + an ISO date note. The ONE command the human runs AFTER uploading
// public/ to the live host — it records, it does NOT upload. Refuses (like release()) to record a
// self-contradicting release (landing page hash != shipped bundle) as LIVE.
function markDeployed(repoRoot, nowIso) {
  const iso = nowIso === undefined ? new Date().toISOString() : nowIso;
  if (!isIsoUtc(iso)) throw new Error(`markDeployed: nowIso must be an ISO-8601 UTC timestamp (got ${JSON.stringify(iso)})`);
  const assembly = assemble(repoRoot);
  const drift = landingConsistencyProblems(assembly).concat(llmsDigestProblems(assembly));
  if (drift.length) {
    throw new Error(`site-release --mark-deployed: refusing to record a self-contradicting release as LIVE:\n  - ${drift.join("\n  - ")}`);
  }
  const files = {};
  for (const e of assembly.entries) files[e.path] = e.sha256;
  const snapshot = {
    generatedFrom: `public/ (assembled deterministically from ${PUBLISH_SET_REL}; recorded by \`node scripts/site-release.js --mark-deployed\`)`,
    deployedAtNote: `Operator ran --mark-deployed at ${iso} AFTER uploading the assembled public/ webroot to the live host per docs/DEPLOY-PUBLIC-SITE.md (the human-owned P-11 step — the loop never uploads). This snapshot is what --diff treats as LIVE until the next upload.`,
    markedDeployedAt: iso,
    files,
  };
  fs.writeFileSync(path.join(repoRoot, DEPLOYED_REL), JSON.stringify(snapshot, null, 2) + "\n");
  return snapshot;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `usage: node scripts/site-release.js [--check | --diff | --mark-deployed]
  (no flag)        assemble public/ deterministically from ${PUBLISH_SET_REL} and write
                   public/${MANIFEST_NAME} + the committed twin ${MANIFEST_REL}; ALSO
                   GENERATES site/${LLMS_PATH}'s "published SHA-256 of \`<file>\`" digest
                   lines from the release manifest (ONE canonical published checksum —
                   never hand-edit them). NOTE: the LIVE site serves a PINNED bundle;
                   redeploy is needs-human (P-11, docs/DEPLOY-PUBLIC-SITE.md §3c)
  --check          write NOTHING; exit 1 naming every offender if public/, a source, or the
                   committed manifest differs from a fresh assembly, a non-allowlisted
                   file appears in public/, or a published checksum drifts (LANDING PAGE
                   DRIFT / LLMS DRIFT)
  --diff           write NOTHING; compare ${DEPLOYED_REL} (what is believed LIVE) against a
                   fresh assembly and print a per-file ADDED/CHANGED/REMOVED/UNCHANGED table
                   + a one-line verdict. Staleness is a HUMAN decision signal, not a CI
                   failure: exit 0 whether stale or clean; exit 3 (named error) ONLY on a
                   malformed/missing snapshot
  --mark-deployed  AFTER you uploaded public/ per docs/DEPLOY-PUBLIC-SITE.md, rewrite
                   ${DEPLOYED_REL} to the current manifest + an ISO date note (then commit
                   it) so the next --diff is truthful. Records only — NEVER uploads:
                   the loop assembles and diffs INSIDE the repo only; uploading to the
                   live host is the human-owned P-11 step — never auto-executed`;

const CLI_FLAGS = new Set(["--check", "--diff", "--mark-deployed"]);

function main(argv, repoRootOverride) {
  const repoRoot = repoRootOverride === undefined ? REPO_ROOT : path.resolve(repoRootOverride);
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && !CLI_FLAGS.has(args[0]))) {
    process.stderr.write(USAGE + "\n");
    return 2;
  }

  if (args[0] === "--check") {
    const res = check(repoRoot);
    if (!res.ok) {
      process.stderr.write(`site-release --check: RED — ${res.problems.length} problem(s):\n`);
      for (const p of res.problems) process.stderr.write(`  - ${p}\n`);
      return 1;
    }
    const assembly = assemble(repoRoot);
    process.stdout.write(
      `site-release --check: OK — ${WEBROOT_REL}/ matches the committed publish set (${assembly.manifest.fileCount} files, ${assembly.manifest.totalBytes} bytes)\n`
    );
    return 0;
  }

  if (args[0] === "--diff") {
    let diff;
    try {
      diff = diffDeployed(repoRoot);
    } catch (err) {
      if (!err.snapshotError) throw err;
      process.stderr.write(`site-release --diff: SNAPSHOT ERROR — ${err.message}\n`);
      process.stderr.write(`site-release --diff: fix ${DEPLOYED_REL} (or restore it from git), then re-run\n`);
      return 3;
    }
    process.stdout.write(`site-release --diff: fresh release (from ${PUBLISH_SET_REL}) vs ${DEPLOYED_REL} (what is believed LIVE)\n`);
    const width = Math.max(...diff.rows.map((r) => r.path.length));
    for (const r of diff.rows) {
      const detail =
        r.status === "CHANGED"
          ? `live ${r.live.slice(0, 12)}… → release ${r.release.slice(0, 12)}…`
          : r.status === "ADDED"
            ? `not on the live site yet (release ${r.release.slice(0, 12)}…)`
            : r.status === "REMOVED"
              ? `still recorded live (${r.live.slice(0, 12)}…) but no longer in the publish set`
              : "";
      process.stdout.write(`  ${r.status.padEnd(9)}  ${r.path.padEnd(width)}  ${detail}\n`.replace(/ +\n$/, "\n"));
    }
    process.stdout.write(`site-release --diff: ${diff.verdict}\n`);
    return 0;
  }

  if (args[0] === "--mark-deployed") {
    const snap = markDeployed(repoRoot);
    process.stdout.write(
      `site-release --mark-deployed: wrote ${DEPLOYED_REL} — ${Object.keys(snap.files).length} files recorded as LIVE (at ${snap.markedDeployedAt})\n`
    );
    process.stdout.write(`site-release --mark-deployed: commit ${DEPLOYED_REL}; \`--diff\` should now print the clean verdict\n`);
    return 0;
  }

  const assembly = release(repoRoot);
  if (assembly.llmsSync && assembly.llmsSync.changed) {
    for (const u of assembly.llmsSync.updated) {
      process.stdout.write(`site-release: regenerated ${assembly.llmsSync.sourceRel} published SHA-256 of "${u.file}" (${u.from.slice(0, 12)}… → ${u.to.slice(0, 12)}…)\n`);
    }
  }
  process.stdout.write(
    `site-release: assembled ${WEBROOT_REL}/ from ${PUBLISH_SET_REL} — ${assembly.manifest.fileCount} files, ${assembly.manifest.totalBytes} bytes\n`
  );
  process.stdout.write(
    `site-release: wrote ${WEBROOT_REL}/${MANIFEST_NAME} + ${MANIFEST_REL} (manifest sha256 ${sha256Hex(Buffer.from(assembly.manifestJson))})\n`
  );
  process.stdout.write(`site-release: upload ${WEBROOT_REL}/ per docs/DEPLOY-PUBLIC-SITE.md, then verify against ${MANIFEST_NAME}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (err) {
    process.stderr.write(`site-release: FATAL — ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  REPO_ROOT,
  PUBLISH_SET_REL,
  MANIFEST_REL,
  DEPLOYED_REL,
  WEBROOT_REL,
  MANIFEST_NAME,
  LANDING_HTML_PATH,
  VERIFY_BUNDLE_PATH,
  VERIFY_SIDECAR_PATH,
  LLMS_PATH,
  VERIFY_HTML_PATH,
  PUBLISH_SET_SCHEMA,
  MANIFEST_SCHEMA,
  classifyForbidden,
  isSafeRelPath,
  validatePublishSet,
  loadPublishSet,
  assemble,
  extractPublishedHash,
  parseSidecarHash,
  landingConsistencyProblems,
  parseLlmsDigestAnchors,
  renderLlmsDigests,
  syncLlms,
  llmsDigestProblems,
  writeAssembly,
  release,
  check,
  loadDeployedSnapshot,
  isIsoUtc,
  diffDeployed,
  markDeployed,
  main,
};
