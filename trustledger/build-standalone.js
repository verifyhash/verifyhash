#!/usr/bin/env node
"use strict";

// trustledger/build-standalone.js — the DETERMINISTIC, OFFLINE, zero-third-party-dependency bundler
// that inlines the in-tree TrustLedger engine + web-door core into ONE self-contained HTML file:
//
//   trustledger/dist/trustledger-standalone.html          (the single-file OFFLINE app, FREE tier)
//   trustledger/dist/trustledger-standalone.html.sha256   (the published `sha256sum -c` sidecar)
//   trustledger/dist/BUILD-PROVENANCE.json                (source->bundle provenance, verifier schema)
//
// It mirrors verifier/build-standalone.js's PROVEN technique exactly:
//   * an EXPLICIT, FIXED module list (never a filesystem walk), inlined VERBATIM;
//   * ONLY require() specifiers are rewritten, to a memoizing __require(id) CommonJS shim;
//   * NO timestamp, NO randomness — the emitted bytes are a pure function of the committed sources,
//     so two builds are BYTE-IDENTICAL and `--check` re-compiles everything from source and compares
//     against the committed dist files (a stale bundle is a named MISMATCH, red in CI).
//
// WHY THIS EXISTS (T-65.2 / EPIC-65)
//   The pilot-critical objection is DATA SENSITIVITY: a property-management broker will not upload
//   real trust-account exports to someone's server. This file removes that objection completely: the
//   human emails ONE .html file; the design partner double-clicks it, drags their three real exports
//   in, and reads the SAME tie-out packet — with NO install and NO network. The privacy claim is not
//   prose, it is checkable: the emitted file contains NO network API token at all (no fetch(, no
//   XMLHttpRequest, no WebSocket, no EventSource, no sendBeacon, no dynamic import( — pinned by
//   test/trustledger.standalone.test.js), so the browser devtools Network tab stays empty.
//
// WHAT THE EMITTED FILE CONTAINS
//   (a) a DOM-FREE engine <script> between recognizable markers (__TRUSTLEDGER_ENGINE_BEGIN__ /
//       __TRUSTLEDGER_ENGINE_END__): the __modules registry inlining ingest, match, reconcile, the
//       policy pure path (its fs-backed bundled-policy loader swapped for the fixture JSON inlined
//       at build time), close, report, the vendored pure-JS sha256, and the web door's payload core
//       (door-core.js) VERBATIM. No document/window reference — a Node test extracts this block and
//       evaluates it in `vm`, then drives the SAME payloads the server tests use to byte-identity.
//   (b) the EXISTING drag-drop UI from trustledger/public/index.html, with its marked transport
//       seams (the two fetch calls + two server-transport prose notes) swapped for direct in-page
//       calls into the SAME door core the HTTP server routes to — the two surfaces cannot drift.
//   (c) the T-29.3 license-gate MAPPING inlined VERBATIM (door-core.js is not re-implemented): a
//       paid surface (per-state policy / seal) yields the SAME named license_required refusal the
//       web door gives. The license VERIFIER is swapped for a FAIL-CLOSED shim (the offline app is
//       the FREE tier and cannot verify a license), so a supplied license is REFUSED (named
//       license_invalid pointing at the installed product) — the gate is never weakened, and no
//       paid surface can ever be granted offline.
//
// OFFLINE + READ-ONLY: this builder reads the committed source files and writes ONLY under
// trustledger/dist/. It opens NO socket and makes NO network call.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TL_DIR = __dirname;
const DIST_DIR = path.join(TL_DIR, "dist");
const OUT_PATH = path.join(DIST_DIR, "trustledger-standalone.html");
const SHA256_PATH = OUT_PATH + ".sha256";
const SHA256_BASENAME = path.basename(OUT_PATH);
const PROVENANCE_PATH = path.join(DIST_DIR, "BUILD-PROVENANCE.json");
const PROVENANCE_BASENAME = path.basename(PROVENANCE_PATH);
// The SAME version-free schema tag verifier/dist/BUILD-PROVENANCE.json uses.
const PROVENANCE_SCHEMA = "verifyhash/build-provenance@1";

// The drag-drop UI page whose marked transport seams this build swaps.
const PAGE_FILE = "public/index.html";
// The bundled per-state policy fixtures inlined (as JSON) into the policy-loader shim.
const POLICY_FIXTURES_DIR = path.join(TL_DIR, "fixtures", "policy");

// ---------------------------------------------------------------------------
// Deterministic file reading + hashing (same discipline as the verifier builder).
// ---------------------------------------------------------------------------

// Read a source file deterministically, normalizing line endings to "\n" (so a checkout with CRLF
// cannot change the emitted bytes) and stripping a leading shebang line.
function readSource(rel) {
  let s = fs.readFileSync(path.join(TL_DIR, rel), "utf8");
  s = s.replace(/\r\n/g, "\n");
  s = s.replace(/^#![^\n]*\n/, "");
  return s;
}

// sha256 hex of a utf8 string (the canonical hash unit for the bundle and its inlined sources).
function sha256HexOf(text) {
  return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

// The exact textual contents of the `.sha256` sidecar: one canonical line in the standard
// `sha256sum`/`shasum -a 256` format (`<hex>␠␠<basename>\n`) so a recipient can run
// `sha256sum -c trustledger-standalone.html.sha256` BEFORE opening the file.
function sha256SidecarFor(bundleText, basename) {
  return `${sha256HexOf(bundleText)}  ${basename}\n`;
}

// ---------------------------------------------------------------------------
// require() rewriting — identical technique to the verifier builder, but STRICTER: the engine block
// runs in a BROWSER <script>, so NO require may survive verbatim (there is no Node core in a page).
// Every specifier must be in the module's rewrite map; anything else is a hard build error.
// ---------------------------------------------------------------------------

function requireSpecifiers(src) {
  return [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
}

function rewriteRequires(src, rewrite, idForError) {
  for (const spec of requireSpecifiers(src)) {
    if (!Object.prototype.hasOwnProperty.call(rewrite, spec)) {
      throw new Error(
        `build-standalone: module "${idForError}" has an un-inlined require(${JSON.stringify(spec)}). ` +
          "The browser bundle can require NOTHING — add it to the module's rewrite map (and inline its target)."
      );
    }
  }
  return src.replace(/require\(\s*["']([^"']+)["']\s*\)/g, (_full, spec) => {
    return `__require(${JSON.stringify(rewrite[spec])})`;
  });
}

// ---------------------------------------------------------------------------
// SYNTHETIC module bodies (the ONLY two swapped bodies; everything else is inlined verbatim).
// ---------------------------------------------------------------------------

// (1) The bundled-policy loader shim: the SAME { BUNDLED_DIR, listBundledPolicyNames,
// readBundledPolicyFile } surface as trustledger/lib/policy-bundled-loader.js (the module's SOLE
// impure seam, isolated by T-65.1 precisely so this build could swap it), backed by the committed
// per-state policy fixture JSON inlined below at build time. Deterministic: filenames sorted; the
// object's key order is that sorted order. policy.js keeps ALL validation/sorting/PolicyError logic.
function policyLoaderShimBody() {
  const names = fs
    .readdirSync(POLICY_FIXTURES_DIR)
    .filter((n) => n.endsWith(".json"))
    .sort();
  const bundled = {};
  for (const n of names) {
    bundled[n] = fs.readFileSync(path.join(POLICY_FIXTURES_DIR, n), "utf8").replace(/\r\n/g, "\n");
  }
  return [
    '"use strict";',
    "// Inlined bundled-policy provider for the standalone app: the SAME surface as",
    "// trustledger/lib/policy-bundled-loader.js (the policy module's isolated fs seam, T-65.1),",
    "// backed by the committed trustledger/fixtures/policy/*.json inlined verbatim at build time.",
    "// No fs, no path — browser-safe. policy.js keeps every validation/ordering/PolicyError rule.",
    `var BUNDLED = ${JSON.stringify(bundled)};`,
    'var BUNDLED_DIR = "(bundled policies inlined from trustledger/fixtures/policy)";',
    "function listBundledPolicyNames() {",
    "  return Object.keys(BUNDLED);",
    "}",
    "function readBundledPolicyFile(name) {",
    "  if (!Object.prototype.hasOwnProperty.call(BUNDLED, name)) {",
    '    throw new Error("no bundled policy named " + name);',
    "  }",
    '  return { full: BUNDLED_DIR + "/" + name, text: BUNDLED[name] };',
    "}",
    "module.exports = {",
    "  BUNDLED_DIR: BUNDLED_DIR,",
    "  listBundledPolicyNames: listBundledPolicyNames,",
    "  readBundledPolicyFile: readBundledPolicyFile,",
    "};",
  ].join("\n");
}

// (2) The FAIL-CLOSED offline license shim, replacing trustledger/license.js in the bundle. The
// offline app is the FREE tier: license verification (and every paid surface it unlocks) runs in
// the installed TrustLedger product. door-core.js's gate is inlined VERBATIM above this shim, so:
//   * a paid request with NO license  -> the gate's own named license_required refusal, byte-for-
//     byte the SAME as the web door's (the gate never reaches this shim on that path);
//   * a paid request WITH a license   -> readLicense throws here, which the verbatim gate wraps in
//     its named license_invalid refusal pointing at the installed product. NOTHING here can return
//     a valid verdict, so the offline app can NEVER grant a paid surface — fail closed, gate REUSED
//     and never weakened.
const LICENSE_SHIM_BODY = [
  '"use strict";',
  "// OFFLINE license shim (see trustledger/build-standalone.js): the free-tier standalone app",
  "// cannot verify a license — paid surfaces run in the installed TrustLedger product. Fail closed.",
  "var OFFLINE_REASON =",
  '  "license verification runs in the installed TrustLedger product; this offline app is the " +',
  '  "free tier (baseline reconcile + file inspect only)";',
  "function readLicense() {",
  "  throw new Error(OFFLINE_REASON);",
  "}",
  "function verifyLicense() {",
  '  return { valid: false, reason: "offline_free_tier", entitlements: [] };',
  "}",
  "function hasEntitlement() {",
  "  return false;",
  "}",
  "module.exports = {",
  "  readLicense: readLicense,",
  "  verifyLicense: verifyLicense,",
  "  hasEntitlement: hasEntitlement,",
  "};",
].join("\n");

// ---------------------------------------------------------------------------
// The EXPLICIT, FIXED engine module list. Order is deterministic by construction (hand-listed).
// Each entry mirrors the verifier builder: { id, file, rewrite, body?, entry? } — `body` (a string
// or a zero-arg function returning one) REPLACES the file's source (the two synthetic shims above);
// otherwise the file is inlined VERBATIM with only its require() specifiers rewritten.
// ---------------------------------------------------------------------------

const ENGINE_MODULES = [
  // The vendored pure-JS sha256 (T-65.1) — requires nothing.
  { id: "sha256-vendored", file: "lib/sha256-vendored.js", rewrite: {} },
  // The policy module's isolated fs seam — body SWAPPED for the inlined-fixture shim.
  {
    id: "policy-bundled-loader",
    file: "lib/policy-bundled-loader.js",
    rewrite: {},
    body: policyLoaderShimBody,
  },
  // The pure pipeline, inlined verbatim.
  { id: "reconcile", file: "reconcile.js", rewrite: {} },
  {
    id: "policy",
    file: "policy.js",
    rewrite: { "./reconcile": "reconcile", "./lib/policy-bundled-loader": "policy-bundled-loader" },
  },
  { id: "match", file: "match.js", rewrite: {} },
  { id: "ingest", file: "ingest.js", rewrite: {} },
  { id: "close", file: "close.js", rewrite: { "./lib/sha256-vendored": "sha256-vendored" } },
  {
    id: "report",
    file: "report.js",
    rewrite: {
      "./ingest": "ingest",
      "./match": "match",
      "./reconcile": "reconcile",
      "./policy": "policy",
      "./close": "close",
    },
  },
  // The license module — body SWAPPED for the fail-closed offline shim (free tier only).
  { id: "license", file: "license.js", rewrite: {}, body: LICENSE_SHIM_BODY },
  // The web door's payload core, inlined VERBATIM and LAST — the entry the page calls.
  {
    id: "door-core",
    file: "door-core.js",
    rewrite: {
      "./ingest": "ingest",
      "./report": "report",
      "./policy": "policy",
      "./close": "close",
      "./license": "license",
    },
    entry: true,
  },
];

// Resolve a module's inlined body text (synthetic body, or verbatim source with rewrites).
function bodyOf(m) {
  if (m.body != null) {
    return typeof m.body === "function" ? m.body() : m.body;
  }
  return rewriteRequires(readSource(m.file), m.rewrite, m.id);
}

// The tiny CommonJS shim the engine block embeds (byte-identical to the verifier builder's).
const COMMONJS_SHIM = [
  "// ---- minimal CommonJS module shim (so the inlined modules keep their require() structure) --------",
  "var __modules = Object.create(null);",
  "var __cache = Object.create(null);",
  "function __require(id) {",
  "  if (id in __cache) return __cache[id].exports;",
  "  var factory = __modules[id];",
  "  if (!factory) throw new Error('standalone bundle: unknown module: ' + id);",
  "  var module = { exports: {} };",
  "  __cache[id] = module;",
  "  factory(module, module.exports, __require);",
  "  return module.exports;",
  "}",
];

// The recognizable engine-block markers a Node test extracts + vm-evaluates the block by.
const ENGINE_BEGIN_MARKER = "// __TRUSTLEDGER_ENGINE_BEGIN__";
const ENGINE_END_MARKER = "// __TRUSTLEDGER_ENGINE_END__";

// Build the DOM-free engine <script> block. Everything between the markers is plain computation —
// no DOM, no network, no clock — so `vm.runInNewContext` proves it needs nothing a browser page
// would provide. The block defines ONE global, TrustLedgerStandalone: { door, engine }.
function engineScriptText() {
  const parts = [];
  parts.push("<script>");
  parts.push(ENGINE_BEGIN_MARKER);
  parts.push('"use strict";');
  parts.push("var TrustLedgerStandalone = (function () {");
  parts.push(COMMONJS_SHIM.join("\n"));
  parts.push("");

  let entryId = null;
  for (const m of ENGINE_MODULES) {
    if (m.entry) entryId = m.id;
    parts.push(`// ===== module: ${m.id}  (from trustledger/${m.file}) =====`);
    parts.push(`__modules[${JSON.stringify(m.id)}] = function (module, exports, __require) {`);
    parts.push(bodyOf(m));
    parts.push("};");
    parts.push("");
  }
  if (!entryId) throw new Error("build-standalone: no entry module declared");

  parts.push("return {");
  parts.push(`  door: __require(${JSON.stringify(entryId)}),`);
  parts.push("  engine: {");
  parts.push('    ingest: __require("ingest"),');
  parts.push('    match: __require("match"),');
  parts.push('    reconcile: __require("reconcile"),');
  parts.push('    policy: __require("policy"),');
  parts.push('    close: __require("close"),');
  parts.push('    report: __require("report"),');
  parts.push('    sha256: __require("sha256-vendored"),');
  parts.push("  },");
  parts.push("};");
  parts.push("})();");
  parts.push(ENGINE_END_MARKER);
  parts.push("</scr" + "ipt>");
  return parts.join("\n");
}

// The offline UI glue <script>: the bridge between the page's transport seams and the in-page door.
// It mirrors server.js EXACTLY — sendError's { error, message } envelope for a named HttpError, the
// generic internal_error otherwise (never a stack trace), and the same UTC YYYY-MM-DD todayISO()
// computes — wrapped in a resolved Promise so the UI's .then/.catch chains behave exactly as they
// did over the network door.
function glueScriptText() {
  return [
    "<script>",
    "// ---- OFFLINE GLUE (build-generated; T-65.2): routes the page's transport seams into the",
    "// in-page engine above. Mirrors trustledger/server.js: the { error, message } envelope of",
    "// sendError for a named HttpError, internal_error otherwise, and todayISO()'s UTC date.",
    '"use strict";',
    "function __tlOfflineApi(fn) {",
    "  return Promise.resolve().then(function () {",
    "    try {",
    "      return { ok: true, data: fn(TrustLedgerStandalone.door, __tlTodayISO) };",
    "    } catch (err) {",
    "      if (err instanceof TrustLedgerStandalone.door.HttpError) {",
    "        return { ok: false, data: { error: err.code, message: err.message } };",
    "      }",
    '      return { ok: false, data: { error: "internal_error", message: "an internal error occurred" } };',
    "    }",
    "  });",
    "}",
    "function __tlTodayISO() {",
    "  var d = new Date();",
    '  var pad = function (n) { return String(n).padStart(2, "0"); };',
    '  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());',
    "}",
    "</scr" + "ipt>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The marked transport seams in public/index.html and their OFFLINE replacements.
// Each seam is a contiguous region between `__TL_TRANSPORT_SEAM:<NAME>:BEGIN__` and
// `...:END__` marker lines; the replacement swaps the WHOLE region (markers included), so no
// marker token — and no `fetch(` token — survives into the emitted file.
// ---------------------------------------------------------------------------

const SEAM_REPLACEMENTS = [
  {
    name: "NOTE",
    replacement: [
      '<p class="note">Drop your three monthly files. Everything runs INSIDE this one',
      "file: your browser reads the files and the reconciliation executes right here on",
      "this page. No server is contacted — this file contains no network API at all",
      "(check your browser devtools Network tab yourself) — so your trust-account data",
      "never leaves this machine. The result, including the downloadable HTML and CSV",
      "audit packet, renders below.</p>",
    ].join("\n"),
  },
  {
    name: "LICENSE_NOTE",
    replacement: [
      '    <p class="note">Per-state policy packs and the tamper-evident seal are paid',
      "    features that run in the INSTALLED TrustLedger product. This offline app is the",
      "    free tier — the baseline reconcile and file inspection need no license — and it",
      "    cannot verify a license, so requesting a paid feature here is refused with the",
      "    same named notice the web door gives.</p>",
    ].join("\n"),
  },
  {
    name: "INSPECT",
    replacement: [
      "    // OFFLINE build (T-65.2): no network transport — call the SAME door core",
      "    // (trustledger/door-core.js, inlined in the engine block above) directly.",
      "    return __tlOfflineApi(function (door, today) { return door.inspectPayload(body); });",
    ].join("\n"),
  },
  {
    name: "RECONCILE",
    replacement: [
      "      // OFFLINE build (T-65.2): no network transport — call the SAME door core",
      "      // (trustledger/door-core.js, inlined in the engine block above) directly.",
      "      return __tlOfflineApi(function (door, today) { return door.reconcilePayload(body, today()); });",
    ].join("\n"),
  },
];

// Replace ONE marked seam region (marker lines included) with its replacement text. STRICT: each
// marker must appear exactly once, BEGIN before END — a moved/removed marker is a hard build error,
// never a silently-unswapped transport.
function replaceSeam(pageText, name, replacement) {
  const begin = `__TL_TRANSPORT_SEAM:${name}:BEGIN__`;
  const end = `__TL_TRANSPORT_SEAM:${name}:END__`;
  for (const marker of [begin, end]) {
    const first = pageText.indexOf(marker);
    if (first === -1) {
      throw new Error(`build-standalone: seam marker ${marker} not found in ${PAGE_FILE}`);
    }
    if (pageText.indexOf(marker, first + marker.length) !== -1) {
      throw new Error(`build-standalone: seam marker ${marker} appears more than once in ${PAGE_FILE}`);
    }
  }
  const beginAt = pageText.indexOf(begin);
  const endAt = pageText.indexOf(end);
  if (endAt < beginAt) {
    throw new Error(`build-standalone: seam ${name} END marker precedes BEGIN in ${PAGE_FILE}`);
  }
  // The region spans from the START of the line carrying BEGIN to the END of the line carrying END.
  const regionStart = pageText.lastIndexOf("\n", beginAt) + 1;
  const lineEnd = pageText.indexOf("\n", endAt);
  const regionEnd = lineEnd === -1 ? pageText.length : lineEnd + 1;
  return pageText.slice(0, regionStart) + replacement + "\n" + pageText.slice(regionEnd);
}

// The fixed generated-file banner (NO timestamp -> deterministic), inserted right after <!doctype>.
const GENERATED_BANNER = [
  "<!--",
  "  trustledger-standalone.html — the SINGLE-FILE, OFFLINE TrustLedger app (FREE tier).",
  "",
  "  GENERATED by trustledger/build-standalone.js from the in-tree engine — DO NOT EDIT BY HAND.",
  "  Re-generate with: node trustledger/build-standalone.js   (deterministic; `--check` attests the",
  "  committed file reproduces byte-for-byte from source, see trustledger/dist/BUILD-PROVENANCE.json).",
  "",
  "  HOW TO USE IT (no install, no account, no server): save this ONE file, double-click it, drag",
  "  your bank statement, ledger, and rent-roll exports in. Everything runs inside the page: the",
  "  file contains NO network API, so your trust-account data never leaves this machine (verify in",
  "  your browser devtools Network tab).",
  "",
  "  FREE TIER + HONEST POSTURE: the baseline three-way reconcile and file inspection only.",
  "  Per-state policy packs, the tamper-evident seal, and license verification run in the installed",
  "  TrustLedger product; requesting them here is refused with the same named notice the web door",
  "  gives. This tool AIDS reconciliation — the broker remains the legal trust-account custodian,",
  "  and a CPA's review still governs.",
  "-->",
].join("\n");

// ---------------------------------------------------------------------------
// Build the FULL standalone HTML text. Pure function of the committed sources -> deterministic.
// ---------------------------------------------------------------------------

function buildHtml() {
  let page = readSource(PAGE_FILE);

  // (1) Swap each marked transport seam for its offline replacement (markers removed).
  for (const seam of SEAM_REPLACEMENTS) {
    page = replaceSeam(page, seam.name, seam.replacement);
  }

  // (2) Insert the generated-file banner right after the doctype line.
  const doctype = "<!doctype html>\n";
  if (!page.startsWith(doctype)) {
    throw new Error(`build-standalone: ${PAGE_FILE} must start with "<!doctype html>"`);
  }
  page = doctype + GENERATED_BANNER + "\n" + page.slice(doctype.length);

  // (3) Insert the engine block + offline glue immediately BEFORE the page's own UI <script>, so
  //     the UI's swapped seams find TrustLedgerStandalone / __tlOfflineApi already defined.
  const uiScriptAnchor = "<script>\n(function () {";
  const anchorAt = page.indexOf(uiScriptAnchor);
  if (anchorAt === -1 || page.indexOf(uiScriptAnchor, anchorAt + 1) !== -1) {
    throw new Error(`build-standalone: expected exactly one UI script anchor in ${PAGE_FILE}`);
  }
  page =
    page.slice(0, anchorAt) +
    engineScriptText() +
    "\n" +
    glueScriptText() +
    "\n" +
    page.slice(anchorAt);

  return page;
}

// ---------------------------------------------------------------------------
// Build provenance — the SAME schema (verifyhash/build-provenance@1) and module-record shape as
// verifier/dist/BUILD-PROVENANCE.json, so a reviewer reads both manifests the same way. Each inlined
// module is pinned by the sha256 of its NORMALIZED source (the exact bytes the build reads) AND of
// the post-rewrite text actually placed in the bundle; the two synthetic shim bodies are marked
// `synthetic` with their inlined hash (their logic lives in THIS builder, not a source file). The
// UI page the seams are swapped into is pinned separately under `page`.
// ---------------------------------------------------------------------------

function moduleProvenance(m) {
  if (m.body != null) {
    const body = typeof m.body === "function" ? m.body() : m.body;
    return {
      id: m.id,
      synthetic: true,
      sourceFile: null,
      sourceSha256: null,
      inlinedSha256: sha256HexOf(body),
      note:
        m.id === "policy-bundled-loader"
          ? "swapped body (bundled-policy loader shim; inlines trustledger/fixtures/policy/*.json) — defined in build-standalone.js, not a source file"
          : "swapped body (fail-closed offline license shim) — defined in build-standalone.js, not a source file",
    };
  }
  const src = readSource(m.file);
  return {
    id: m.id,
    synthetic: false,
    sourceFile: `trustledger/${m.file}`,
    sourceSha256: sha256HexOf(src),
    inlinedSha256: sha256HexOf(rewriteRequires(src, m.rewrite, m.id)),
    entry: m.entry === true,
  };
}

function buildProvenanceObject() {
  const bundleText = buildHtml();
  return {
    schema: PROVENANCE_SCHEMA,
    description:
      "Maps the published TrustLedger standalone offline app's sha256 to the ordered, individually-hashed " +
      "in-tree source files it inlines. Reproduce + attest the whole chain offline with: " +
      "node trustledger/build-standalone.js --check",
    targets: {
      "trustledger-standalone": {
        bundle: SHA256_BASENAME,
        sidecar: path.basename(SHA256_PATH),
        bundleBytes: Buffer.byteLength(bundleText, "utf8"),
        bundleSha256: sha256HexOf(bundleText),
        sidecarLine: sha256SidecarFor(bundleText, SHA256_BASENAME).trim(),
        // The UI page whose marked transport seams the build swaps (pinned like any other source).
        page: {
          sourceFile: `trustledger/${PAGE_FILE}`,
          sourceSha256: sha256HexOf(readSource(PAGE_FILE)),
        },
        // The ORDERED inlined engine modules — the exact composition a skeptic re-hashes source against.
        modules: ENGINE_MODULES.map(moduleProvenance),
      },
    },
  };
}

function buildProvenanceText() {
  return JSON.stringify(buildProvenanceObject(), null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function writeAll() {
  const html = buildHtml();
  const sidecar = sha256SidecarFor(html, SHA256_BASENAME);
  const provenance = buildProvenanceText();
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, html);
  fs.writeFileSync(SHA256_PATH, sidecar);
  fs.writeFileSync(PROVENANCE_PATH, provenance);
  return { html, sidecar, provenance };
}

// ---------------------------------------------------------------------------
// REPRODUCE-AND-ATTEST (`--check`) — same posture as verifier/build-standalone.js --check: re-compile
// the bundle from the in-tree source a skeptic can READ, recompute the published checksum + the
// provenance manifest, and assert the COMMITTED files are byte-for-byte what that source compiles to.
// Read-only; writes NOTHING; a stale/tampered dist is a named MISMATCH (exit 1), never a crash.
// ---------------------------------------------------------------------------

function checkBundle() {
  const rel = (p) => path.relative(TL_DIR, p);
  const result = {
    bundlePath: rel(OUT_PATH),
    sha256Path: rel(SHA256_PATH),
    expectedHex: null,
    bundle: { ok: false, reason: "" },
    sidecar: { ok: false, reason: "" },
    sources: { ok: true, reason: "", offenders: [] },
  };

  // Source-presence FIRST, so a missing inlined source is a named MISMATCH, not a build crash.
  const sourceFiles = [PAGE_FILE, ...ENGINE_MODULES.filter((m) => m.body == null).map((m) => m.file)];
  for (const f of sourceFiles) {
    if (!fs.existsSync(path.join(TL_DIR, f))) {
      result.sources.ok = false;
      result.sources.offenders.push({ sourceFile: `trustledger/${f}`, reason: "MISSING" });
    }
  }
  result.sources.reason = result.sources.offenders.length
    ? `inlined source(s) MISSING: ${result.sources.offenders.map((o) => o.sourceFile).join(", ")}`
    : `all ${sourceFiles.length} inlined source files present`;

  let expectedHtml, expectedBuf, expectedSidecar;
  try {
    expectedHtml = buildHtml();
    expectedBuf = Buffer.from(expectedHtml, "utf8");
    result.expectedHex = sha256HexOf(expectedHtml);
    expectedSidecar = sha256SidecarFor(expectedHtml, SHA256_BASENAME);
  } catch (e) {
    const why = `cannot recompile ${result.bundlePath} from source: ${e && e.message ? e.message : e}`;
    result.bundle.reason = why;
    result.sidecar.reason = why;
    result.ok = false;
    return result;
  }

  if (!fs.existsSync(OUT_PATH)) {
    result.bundle.reason = `committed bundle ${result.bundlePath} is MISSING`;
  } else {
    const committed = fs.readFileSync(OUT_PATH);
    if (committed.equals(expectedBuf)) {
      result.bundle.ok = true;
      result.bundle.reason = `recomputed bytes == committed bytes (sha256 ${result.expectedHex})`;
    } else {
      const committedHex = crypto.createHash("sha256").update(committed).digest("hex");
      result.bundle.reason =
        `committed bundle does NOT reproduce from source ` +
        `(committed sha256 ${committedHex} != recomputed ${result.expectedHex})`;
    }
  }

  if (!fs.existsSync(SHA256_PATH)) {
    result.sidecar.reason = `committed sidecar ${result.sha256Path} is MISSING`;
  } else {
    const committedSidecar = fs.readFileSync(SHA256_PATH, "utf8");
    if (committedSidecar === expectedSidecar) {
      result.sidecar.ok = true;
      result.sidecar.reason = `published hex == recomputed hex (${result.expectedHex})`;
    } else {
      result.sidecar.reason =
        `committed sidecar does NOT match the recomputed published line ` +
        `(expected "${expectedSidecar.trim()}", got "${committedSidecar.trim()}")`;
    }
  }

  result.ok = result.bundle.ok && result.sidecar.ok && result.sources.ok;
  return result;
}

// Reproduce the manifest from source AND cross-check every source hash the COMMITTED manifest pins
// (page + every non-synthetic module) against the file on disk — a one-byte change to ANY inlined
// source is named precisely by its own filename against the published pin.
function checkProvenance() {
  const rel = (p) => path.relative(TL_DIR, p);
  const result = {
    manifestPath: rel(PROVENANCE_PATH),
    manifest: { ok: false, reason: "" },
    chain: { ok: true, reason: "", offenders: [] },
  };

  let expectedText = null;
  let expectedObj = { targets: {} };
  try {
    expectedText = buildProvenanceText();
    expectedObj = buildProvenanceObject();
  } catch (e) {
    result.manifest.reason = `cannot recompute ${result.manifestPath} from source: ${
      e && e.message ? e.message : e
    }`;
  }

  let committedObj = null;
  if (!fs.existsSync(PROVENANCE_PATH)) {
    result.manifest.reason = `committed manifest ${result.manifestPath} is MISSING`;
  } else {
    const committed = fs.readFileSync(PROVENANCE_PATH, "utf8");
    try {
      committedObj = JSON.parse(committed);
    } catch (_) {
      committedObj = null;
    }
    if (expectedText === null) {
      // recompute failed; reason already set — the chain below still pins from the committed copy.
    } else if (committed === expectedText) {
      result.manifest.ok = true;
      result.manifest.reason = `recomputed manifest == committed manifest (sha256 ${sha256HexOf(expectedText)})`;
    } else {
      result.manifest.reason =
        `committed manifest does NOT reproduce from source ` +
        `(committed sha256 ${sha256HexOf(committed)} != recomputed ${sha256HexOf(expectedText)})`;
    }
  }

  // Pin against the COMMITTED manifest (what was published); fall back to the recomputed one.
  const pinSource = committedObj && committedObj.targets ? committedObj : expectedObj;
  const pinned = new Map();
  for (const target of Object.values(pinSource.targets || {})) {
    if (target.page && target.page.sourceFile) {
      pinned.set(target.page.sourceFile, { id: "ui-page", sha256: target.page.sourceSha256 });
    }
    for (const mod of target.modules || []) {
      if (mod.synthetic || !mod.sourceFile) continue;
      if (!pinned.has(mod.sourceFile)) pinned.set(mod.sourceFile, { id: mod.id, sha256: mod.sourceSha256 });
    }
  }
  for (const [sourceFile, pin] of pinned) {
    const relFile = sourceFile.replace(/^trustledger\//, "");
    const abs = path.join(TL_DIR, relFile);
    const onDisk = fs.existsSync(abs) ? sha256HexOf(readSource(relFile)) : null;
    if (onDisk !== pin.sha256) {
      result.chain.offenders.push({
        id: pin.id,
        sourceFile,
        expected: pin.sha256,
        got: onDisk === null ? "MISSING" : onDisk,
      });
      result.chain.ok = false;
    }
  }
  result.chain.reason = result.chain.offenders.length
    ? `source(s) do NOT match the manifest's pinned sha256: ` +
      result.chain.offenders
        .map(
          (o) =>
            `${o.sourceFile} (pinned ${String(o.expected).slice(0, 12)}…, got ${
              o.got === "MISSING" ? "MISSING" : o.got.slice(0, 12) + "…"
            })`
        )
        .join("; ")
    : "every inlined source file hashes to its manifest-pinned sha256";

  result.ok = result.manifest.ok && result.chain.ok;
  return result;
}

function runCheck(io) {
  const out = (io && io.write) || ((s) => process.stdout.write(s));
  const err = (io && io.writeErr) || ((s) => process.stderr.write(s));

  out("trustledger standalone REPRODUCE-AND-ATTEST (--check): re-compiling the offline app from in-tree\n");
  out("source, recomputing its published checksum + build-provenance manifest, and comparing all against\n");
  out("the committed files. No network; no writes.\n\n");

  let allOk = true;

  const b = checkBundle();
  out(`[${b.bundle.ok ? "MATCH" : "MISMATCH"}] bundle  ${b.bundlePath}: ${b.bundle.reason}\n`);
  out(`[${b.sidecar.ok ? "MATCH" : "MISMATCH"}] sidecar ${b.sha256Path}: ${b.sidecar.reason}\n`);
  out(`[${b.sources.ok ? "MATCH" : "MISMATCH"}] sources ${b.bundlePath}: ${b.sources.reason}\n`);
  if (!b.ok) allOk = false;

  const p = checkProvenance();
  out(`[${p.manifest.ok ? "MATCH" : "MISMATCH"}] manifest ${p.manifestPath}: ${p.manifest.reason}\n`);
  out(`[${p.chain.ok ? "MATCH" : "MISMATCH"}] sources->manifest: ${p.chain.reason}\n`);
  if (!p.ok) allOk = false;

  if (allOk) {
    out("\nALL MATCH — the committed offline app, its sidecar AND the build-provenance manifest reproduce\n");
    out("byte-for-byte from the in-tree source, and every inlined source file hashes to its pinned sha256.\n");
    return 0;
  }
  err("\nMISMATCH — at least one committed file does NOT reproduce from source (see above). Re-run\n");
  err("`node trustledger/build-standalone.js` (no flag) to regenerate, or distrust this checkout.\n");
  return 1;
}

if (require.main === module) {
  if (process.argv.slice(2).includes("--check")) {
    process.exit(runCheck());
  }
  const { html, sidecar, provenance } = writeAll();
  process.stdout.write(`wrote ${path.relative(TL_DIR, OUT_PATH)} (${Buffer.byteLength(html)} bytes)\n`);
  process.stdout.write(`wrote ${path.relative(TL_DIR, SHA256_PATH)} (${sidecar.trim()})\n`);
  process.stdout.write(
    `wrote ${path.relative(TL_DIR, PROVENANCE_PATH)} (${Buffer.byteLength(provenance)} bytes)\n`
  );
}

module.exports = {
  buildHtml,
  buildProvenanceObject,
  buildProvenanceText,
  moduleProvenance,
  engineScriptText,
  glueScriptText,
  policyLoaderShimBody,
  LICENSE_SHIM_BODY,
  SEAM_REPLACEMENTS,
  replaceSeam,
  sha256HexOf,
  sha256SidecarFor,
  writeAll,
  checkBundle,
  checkProvenance,
  runCheck,
  ENGINE_MODULES,
  ENGINE_BEGIN_MARKER,
  ENGINE_END_MARKER,
  OUT_PATH,
  SHA256_PATH,
  SHA256_BASENAME,
  PROVENANCE_PATH,
  PROVENANCE_BASENAME,
  PROVENANCE_SCHEMA,
  DIST_DIR,
  TL_DIR,
  PAGE_FILE,
};
