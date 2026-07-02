#!/usr/bin/env node
"use strict";

// verifier/build-standalone-html.js — the DETERMINISTIC, OFFLINE, zero-third-party-dependency bundler
// that inlines the T-66.1 PURE verify engine (the marked block of verifier/verify-vh.js) + the verifier
// libs into ONE self-contained, fully OFFLINE HTML page:
//
//   verifier/dist/verify-vh-standalone.html          (the single-file OFFLINE verify page, FREE tier)
//   verifier/dist/verify-vh-standalone.html.sha256   (the published `sha256sum -c` sidecar)
//   verifier/dist/BUILD-PROVENANCE.json              (the shared manifest — this build ADDS its target)
//
// It mirrors verifier/build-standalone.js's + trustledger/build-standalone.js's PROVEN technique:
//   * an EXPLICIT, FIXED module list (never a filesystem walk), inlined VERBATIM;
//   * ONLY require() specifiers are rewritten, to a memoizing __require(id) CommonJS shim;
//   * NO timestamp, NO randomness — the emitted bytes are a pure function of the committed sources, so
//     two builds are BYTE-IDENTICAL and `--check` re-compiles everything from source and compares against
//     the committed dist files (a stale bundle is a named MISMATCH, red in CI).
//
// WHY THIS EXISTS (T-66.2 / EPIC-66)
//   The cold-prospect 60-second challenge was Node-gated ("you need node >= 18 on your PATH"). This file
//   removes that gate: the human sends ONE link/file; the prospect opens it IN A BROWSER, clicks the
//   built-in sample packet, watches ACCEPT, changes ONE byte of a sample file IN THE PAGE, and watches
//   REJECT name that file — then drags their OWN sealed packet in. NO Node, no install, no network, no
//   trust in us. The privacy/no-network claim is not prose, it is checkable: the emitted file contains NO
//   network API token at all (no fetch(, no XMLHttpRequest, no WebSocket, no EventSource, no sendBeacon,
//   no dynamic import( — pinned by test/verifier.standalone-html.test.js), so the browser devtools
//   Network tab stays empty.
//
// WHAT THE EMITTED FILE CONTAINS
//   (a) a DOM-FREE engine <script> between recognizable markers (__VERIFY_VH_ENGINE_BEGIN__ /
//       __VERIFY_VH_ENGINE_END__): the __modules registry inlining keccak256-vendored, merkle, canonical,
//       secp256k1-recover, revocation-core VERBATIM, plus (i) a tiny pure-JS `Buffer` subset shim (the
//       ONE Node global those libs use; the shim implements exactly the surface they call), (ii) the
//       T-66.1 PURE ENGINE SLICE of verify-vh.js — the exact bytes between its BEGIN/END engine markers,
//       wrapped in a build-generated module preamble that binds merkle/canonical/recoverPersonalSignAddress
//       /revocation through __require — and (iii) the embedded demo fixture + a 60-second-challenge
//       runner. No document/window reference — a Node test extracts this block, evaluates it in a BARE
//       `vm` context, and asserts its verdict objects are BYTE-IDENTICAL to the in-tree
//       verifyArtifactFromBytes across the whole verdict matrix.
//   (b) the page UI (drag-and-drop / file picker / folder picker, optional vendor pin, optional
//       revocations drop, the editable built-in sample) — plain DOM script, OUTSIDE the engine markers.
//   (c) the HONEST BOUNDARY, verbatim and visible: ACCEPT is tamper-evidence that these exact bytes match
//       the seal — NOT a trusted timestamp and NOT proof of WHEN; for CI/production gating use the node
//       standalone (verify-vh-standalone.js).
//
// OFFLINE + READ-ONLY: this builder reads the committed source files and writes ONLY under
// verifier/dist/. It opens NO socket and makes NO network call. It never require()s verify-vh.js (or
// anything that pulls js-sha3) — the demo fixture is extracted TEXTUALLY from the committed source and
// evaluated in a bare `vm` context, so a copied verifier/ tree with no node_modules can still `--check`.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");

const VERIFIER_DIR = __dirname;
const DIST_DIR = path.join(VERIFIER_DIR, "dist");
const OUT_PATH = path.join(DIST_DIR, "verify-vh-standalone.html");
const SHA256_PATH = OUT_PATH + ".sha256";
const SHA256_BASENAME = path.basename(OUT_PATH);
const PROVENANCE_PATH = path.join(DIST_DIR, "BUILD-PROVENANCE.json");
// The SAME version-free schema tag the shared manifest uses.
const PROVENANCE_SCHEMA = "verifyhash/build-provenance@1";
// The html target's key in the shared BUILD-PROVENANCE.json `targets` map.
const HTML_TARGET_NAME = "verify-html";

// The T-66.1 engine markers in verifier/verify-vh.js — the extraction seam this build slices.
const VV_ENGINE_BEGIN =
  "// ============================ BEGIN VERIFY-VH PURE ENGINE (T-66.1) ============================";
const VV_ENGINE_END =
  "// ============================= END VERIFY-VH PURE ENGINE (T-66.1) =============================";

// The recognizable engine-block markers a Node test extracts + vm-evaluates the emitted block by.
const ENGINE_BEGIN_MARKER = "// __VERIFY_VH_ENGINE_BEGIN__";
const ENGINE_END_MARKER = "// __VERIFY_VH_ENGINE_END__";

// ---------------------------------------------------------------------------
// Deterministic file reading + hashing (same discipline as the sibling builders).
// ---------------------------------------------------------------------------

// Read a source file deterministically, normalizing line endings to "\n" (so a checkout with CRLF cannot
// change the emitted bytes) and stripping a leading shebang line.
function readSource(rel) {
  let s = fs.readFileSync(path.join(VERIFIER_DIR, rel), "utf8");
  s = s.replace(/\r\n/g, "\n");
  s = s.replace(/^#![^\n]*\n/, "");
  return s;
}

// sha256 hex of a utf8 string (the canonical hash unit for the bundle and its inlined sources).
function sha256HexOf(text) {
  return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

// The exact textual contents of the `.sha256` sidecar: one canonical line in the standard
// `sha256sum`/`shasum -a 256` format (`<hex>␠␠<basename>\n`).
function sha256SidecarFor(bundleText, basename) {
  return `${sha256HexOf(bundleText)}  ${basename}\n`;
}

// ---------------------------------------------------------------------------
// require() rewriting — identical technique to the sibling builders, but STRICTER: the engine block runs
// in a BROWSER <script>, so NO require may survive verbatim (there is no Node core in a page). Every
// specifier must be in the module's rewrite map; anything else is a hard build error.
// ---------------------------------------------------------------------------

function requireSpecifiers(src) {
  return [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
}

function rewriteRequires(src, rewrite, idForError) {
  for (const spec of requireSpecifiers(src)) {
    if (!Object.prototype.hasOwnProperty.call(rewrite, spec)) {
      throw new Error(
        `build-standalone-html: module "${idForError}" has an un-inlined require(${JSON.stringify(spec)}). ` +
          "The browser bundle can require NOTHING — add it to the module's rewrite map (and inline its target)."
      );
    }
  }
  return src.replace(/require\(\s*["']([^"']+)["']\s*\)/g, (_full, spec) => {
    return `__require(${JSON.stringify(rewrite[spec])})`;
  });
}

// ---------------------------------------------------------------------------
// SYNTHETIC module bodies. Everything else is inlined verbatim (rewrites aside).
// ---------------------------------------------------------------------------

// (1) The pure-JS `Buffer` subset the inlined verifier libs (merkle / canonical / secp256k1-recover /
// the keccak shim) reference as a bare global. It implements EXACTLY the surface they use — from(array |
// utf8-string | hex-string | Uint8Array), alloc, concat, compare, isBuffer, toString("hex"), and the
// species-preserving slice/subarray a Uint8Array subclass inherits — and NOTHING else (any other
// encoding throws by name). UTF-8 encoding matches Node's (lone surrogates -> U+FFFD); hex decoding
// matches Node's (stop at the first non-hex pair; a trailing odd nibble is dropped).
const BUFFER_SHIM_BODY = [
  '"use strict";',
  "// Minimal PURE-JS Buffer subset for the browser/vm (see verifier/build-standalone-html.js). NOT a",
  "// general Node Buffer — exactly the calls the inlined verifier libs make, nothing more.",
  "var HEX_CHARS = \"0123456789abcdef\";",
  "function hexNibble(ch) {",
  "  var c = ch.charCodeAt(0);",
  "  if (c >= 48 && c <= 57) return c - 48; // 0-9",
  "  if (c >= 97 && c <= 102) return c - 87; // a-f",
  "  if (c >= 65 && c <= 70) return c - 55; // A-F",
  "  return -1;",
  "}",
  "function utf8Encode(str) {",
  "  var out = [];",
  "  for (var i = 0; i < str.length; i++) {",
  "    var c = str.codePointAt(i);",
  "    if (c > 0xffff) i++; // consumed a full surrogate pair",
  "    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate -> replacement char (Node semantics)",
  "    if (c < 0x80) out.push(c);",
  "    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));",
  "    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));",
  "    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));",
  "  }",
  "  return out;",
  "}",
  "function hexDecode(str) {",
  "  var out = [];",
  "  for (var i = 0; i + 1 < str.length; i += 2) {",
  "    var hi = hexNibble(str[i]);",
  "    var lo = hexNibble(str[i + 1]);",
  "    if (hi < 0 || lo < 0) break; // Node stops at the first invalid pair",
  "    out.push((hi << 4) | lo);",
  "  }",
  "  return out;",
  "}",
  "class VhBuffer extends Uint8Array {",
  "  toString(enc) {",
  '    if (enc !== "hex") {',
  "      throw new Error(\"vh-buffer supports only .toString('hex'), got: \" + String(enc));",
  "    }",
  '    var s = "";',
  "    for (var i = 0; i < this.length; i++) {",
  "      s += HEX_CHARS[this[i] >> 4] + HEX_CHARS[this[i] & 15];",
  "    }",
  "    return s;",
  "  }",
  "  static from(input, enc) {",
  '    if (typeof input === "string") {',
  '      if (enc === "hex") return new VhBuffer(hexDecode(input));',
  '      if (enc === undefined || enc === "utf8" || enc === "utf-8") return new VhBuffer(utf8Encode(input));',
  '      throw new Error("vh-buffer supports only utf8/hex string encodings, got: " + String(enc));',
  "    }",
  "    if (input instanceof Uint8Array || Array.isArray(input)) return new VhBuffer(input);",
  '    throw new TypeError("vh-buffer: Buffer.from requires a string, array, or Uint8Array");',
  "  }",
  "  static alloc(n) {",
  "    return new VhBuffer(n); // zero-filled, like Node's Buffer.alloc",
  "  }",
  "  static concat(list) {",
  "    var total = 0;",
  "    for (var i = 0; i < list.length; i++) total += list[i].length;",
  "    var out = new VhBuffer(total);",
  "    var off = 0;",
  "    for (var j = 0; j < list.length; j++) {",
  "      out.set(list[j], off);",
  "      off += list[j].length;",
  "    }",
  "    return out;",
  "  }",
  "  static compare(a, b) {",
  "    var n = Math.min(a.length, b.length);",
  "    for (var i = 0; i < n; i++) {",
  "      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;",
  "    }",
  "    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;",
  "  }",
  "  static isBuffer(x) {",
  "    return x instanceof VhBuffer;",
  "  }",
  "}",
  "module.exports = { Buffer: VhBuffer };",
].join("\n");

// (2) The keccak provider the inlined libs require as "./keccak" — body SWAPPED (exactly like the JS
// bundles' shim) to be backed by the vendored pure-JS keccak256, returning the bundle's pure-JS Buffer so
// downstream `.slice(...).toString("hex")` / `Buffer.concat([...])` callers behave exactly as in Node.
const KECCAK_SHIM_BODY = [
  '"use strict";',
  "// Inlined keccak provider for the standalone HTML page: the SAME `keccak256(bytes) -> Buffer` surface",
  "// as verifier/lib/keccak.js, but backed by the PURE-JS vendored implementation",
  "// (verifier/lib/keccak256-vendored.js) and returning the bundle's pure-JS Buffer (vh-buffer).",
  'var vendored = __require("keccak256-vendored");',
  "function keccak256(bytes) {",
  "  if (!(bytes instanceof Uint8Array)) {",
  '    throw new TypeError("keccak256 requires a Buffer/Uint8Array of input bytes");',
  "  }",
  "  return Buffer.from(vendored.keccak256(bytes));",
  "}",
  "module.exports = { keccak256: keccak256 };",
].join("\n");

// ---------------------------------------------------------------------------
// The T-66.1 ENGINE SLICE: the exact bytes of verifier/verify-vh.js between its BEGIN/END engine markers
// (the block test/verifier.browser-core.test.js proves is pure of fs/os/path/process and require()-free),
// wrapped in a build-generated preamble that binds its four module-scope names through __require, plus a
// build-generated exports postamble. NOTHING inside the slice is transformed.
// ---------------------------------------------------------------------------

function extractEngineSlice() {
  const src = readSource("verify-vh.js");
  const begin = src.indexOf(VV_ENGINE_BEGIN);
  const end = src.indexOf(VV_ENGINE_END);
  if (begin === -1 || end === -1 || end <= begin) {
    throw new Error("build-standalone-html: verify-vh.js engine markers not found (or out of order)");
  }
  if (src.indexOf(VV_ENGINE_BEGIN, begin + 1) !== -1 || src.indexOf(VV_ENGINE_END, end + 1) !== -1) {
    throw new Error("build-standalone-html: verify-vh.js engine markers must be unique");
  }
  return src.slice(begin + VV_ENGINE_BEGIN.length, end);
}

function engineSliceBody() {
  const slice = extractEngineSlice();
  const preamble = [
    '"use strict";',
    "// BUILD-GENERATED PREAMBLE (verifier/build-standalone-html.js): the four module-scope bindings the",
    "// T-66.1 engine slice references, resolved through the bundle's own __require graph. `revocation`",
    "// binds the PURE decision core directly (verifier/lib/revocation-core.js) — the engine slice only",
    "// ever touches the pure surface (proven by test/verifier.browser-core.test.js), never the fs reader.",
    'var merkle = __require("merkle");',
    'var canonical = __require("canonical");',
    'var recoverPersonalSignAddress = __require("secp256k1-recover").recoverPersonalSignAddress;',
    'var revocation = __require("revocation-core");',
    "// ---- the verbatim T-66.1 engine slice of verifier/verify-vh.js follows. ----",
  ].join("\n");
  const postamble = [
    "// BUILD-GENERATED EXPORTS (verifier/build-standalone-html.js): the engine surface the page drives.",
    "module.exports = {",
    "  EXIT: EXIT,",
    "  KINDS: KINDS,",
    "  TRUST_NOTE: TRUST_NOTE,",
    "  UsageError: UsageError,",
    "  IOError: IOError,",
    "  MAX_RELPATH_CHARS: MAX_RELPATH_CHARS,",
    "  verifyArtifactFromBytes: verifyArtifactFromBytes,",
    "};",
  ].join("\n");
  return preamble + slice + postamble;
}

// ---------------------------------------------------------------------------
// The embedded DEMO FIXTURE — the verifier's OWN shipped, genuinely-signed demo packet (DEMO_SIGNER /
// DEMO_FILES / DEMO_CONTAINER / DEMO_PACKET_NAME in verify-vh.js), inlined VERBATIM (not re-authored).
// Extracted TEXTUALLY from the committed source and evaluated in a bare `vm` context (no requires, so a
// copied tree with no node_modules can still build/`--check`). Pure function of source -> deterministic.
// ---------------------------------------------------------------------------

function extractDemoFixture() {
  const src = readSource("verify-vh.js");
  const start = src.indexOf("const DEMO_SIGNER =");
  const nameAt = src.indexOf("const DEMO_PACKET_NAME =");
  if (start === -1 || nameAt === -1 || nameAt <= start) {
    throw new Error("build-standalone-html: verify-vh.js demo fixture anchors not found (or out of order)");
  }
  const declEnd = src.indexOf(";", nameAt);
  if (declEnd === -1) {
    throw new Error("build-standalone-html: verify-vh.js DEMO_PACKET_NAME declaration is unterminated");
  }
  // The slice holds ONLY const declarations (+ comments) — self-contained, no requires, no I/O.
  const decl = src.slice(start, declEnd + 1);
  const out = vm.runInNewContext(
    decl +
      "\n;({ signer: DEMO_SIGNER, files: DEMO_FILES, container: DEMO_CONTAINER, packetName: DEMO_PACKET_NAME });",
    {},
    { filename: "verify-vh-demo-fixture.js" }
  );
  // Shape sanity so a refactor of the fixture is a HARD build error, never a silently-broken sample.
  if (
    !out ||
    typeof out.signer !== "string" ||
    !/^0x[0-9a-f]{40}$/.test(out.signer) ||
    !out.files ||
    typeof out.files["model-card.md"] !== "string" ||
    !out.container ||
    out.container.kind !== "vh.evidence-seal-signed" ||
    typeof out.packetName !== "string"
  ) {
    throw new Error("build-standalone-html: extracted demo fixture has an unexpected shape");
  }
  return out;
}

// The file the built-in challenge tampers (one byte, in the page).
const TAMPER_FILE = "model-card.md";

// (3) The embedded demo-fixture module body.
function challengeFixtureBody() {
  const demo = extractDemoFixture();
  return [
    '"use strict";',
    "// The verifier's SHIPPED demo packet (verify-vh.js DEMO_SIGNER/DEMO_FILES/DEMO_CONTAINER), inlined",
    "// VERBATIM at build time — a REAL vh.evidence-seal-signed container signed by the fixed TEST-ONLY",
    "// key (hardhat account #1; never a real key / real funds). CONTAINER_TEXT is the exact JSON the",
    "// in-tree demo verifies, so the page's sample verdict is byte-identical to `verify-vh demo`'s.",
    `var SIGNER = ${JSON.stringify(demo.signer)};`,
    `var PACKET_NAME = ${JSON.stringify(demo.packetName)};`,
    `var CONTAINER_TEXT = ${JSON.stringify(JSON.stringify(demo.container))};`,
    `var FILES = ${JSON.stringify(demo.files)};`,
    `var TAMPER_FILE = ${JSON.stringify(TAMPER_FILE)};`,
    "module.exports = {",
    "  SIGNER: SIGNER,",
    "  PACKET_NAME: PACKET_NAME,",
    "  CONTAINER_TEXT: CONTAINER_TEXT,",
    "  FILES: FILES,",
    "  TAMPER_FILE: TAMPER_FILE,",
    "};",
  ].join("\n");
}

// (4) The 60-second-challenge runner: verify the genuine embedded packet (signer pinned), then a
// one-byte-tampered copy, through the SAME verifyArtifactFromBytes the page uses for real packets — no
// bespoke verify path, so the sample verdicts are exactly what a real packet would get.
const CHALLENGE_BODY = [
  '"use strict";',
  "// The built-in 60-SECOND CHALLENGE over the embedded demo fixture: genuine -> ACCEPT (signer pinned),",
  "// one tampered byte -> REJECT naming the file. Drives the REAL engine — no special-case verify path.",
  'var engine = __require("verify-vh-engine");',
  'var fixture = __require("challenge-fixture");',
  "function toFilesMap(contents) {",
  "  var m = {};",
  "  var keys = Object.keys(contents);",
  "  for (var i = 0; i < keys.length; i++) {",
  '    m[keys[i]] = Buffer.from(contents[keys[i]], "utf8");',
  "  }",
  "  return m;",
  "}",
  "function verifyContents(contents) {",
  "  return engine.verifyArtifactFromBytes({",
  "    artifactText: fixture.CONTAINER_TEXT,",
  "    files: toFilesMap(contents),",
  "    vendor: fixture.SIGNER,",
  "    artifactName: fixture.PACKET_NAME,",
  "  });",
  "}",
  "function runChallenge() {",
  "  var genuine = verifyContents(fixture.FILES);",
  "  var tamperedFiles = {};",
  "  var keys = Object.keys(fixture.FILES);",
  "  for (var i = 0; i < keys.length; i++) tamperedFiles[keys[i]] = fixture.FILES[keys[i]];",
  '  tamperedFiles[fixture.TAMPER_FILE] = fixture.FILES[fixture.TAMPER_FILE] + "X";',
  "  var tampered = verifyContents(tamperedFiles);",
  "  return {",
  "    genuine: genuine,",
  "    tampered: tampered,",
  "    signer: fixture.SIGNER,",
  "    tamperedFile: fixture.TAMPER_FILE,",
  "    packetName: fixture.PACKET_NAME,",
  "  };",
  "}",
  "module.exports = { runChallenge: runChallenge, verifyContents: verifyContents, fixture: fixture };",
].join("\n");

// ---------------------------------------------------------------------------
// The EXPLICIT, FIXED engine module list. Order is deterministic by construction (hand-listed).
// { id, file, rewrite } inlines the file VERBATIM (rewrites aside); { id, body } is a synthetic module
// whose logic lives in THIS builder; { id, file, slice: true } is the marked verify-vh.js engine slice.
// ---------------------------------------------------------------------------

const HTML_MODULES = [
  // The pure-JS Buffer subset every inlined lib references as a bare global (bound lexically below).
  { id: "vh-buffer", body: BUFFER_SHIM_BODY, note: "pure-JS browser Buffer subset shim — defined in build-standalone-html.js, not a source file" },
  // The pure-JS keccak256 — inlined VERBATIM (it requires nothing).
  { id: "keccak256-vendored", file: "lib/keccak256-vendored.js", rewrite: {} },
  // The keccak provider the libs require as "./keccak" — body SWAPPED for the vendored-backed shim.
  { id: "keccak", body: KECCAK_SHIM_BODY, note: "swapped body (keccak provider shim over the vendored pure-JS keccak256, returning vh-buffer Buffers) — defined in build-standalone-html.js, not a source file" },
  // The independent merkle / canonical / secp256k1 / pure-revocation libs, inlined verbatim.
  { id: "merkle", file: "lib/merkle.js", rewrite: { "./keccak": "keccak" } },
  { id: "canonical", file: "lib/canonical.js", rewrite: {} },
  { id: "secp256k1-recover", file: "lib/secp256k1-recover.js", rewrite: { "./keccak": "keccak" } },
  { id: "revocation-core", file: "lib/revocation-core.js", rewrite: { "./secp256k1-recover": "secp256k1-recover" } },
  // The T-66.1 pure engine slice of verify-vh.js — the entry surface the page drives.
  { id: "verify-vh-engine", file: "verify-vh.js", slice: true, entry: true, note: "the marked T-66.1 pure-engine slice of verifier/verify-vh.js (the bytes between its BEGIN/END engine markers), wrapped in a build-generated __require preamble + exports postamble; sourceSha256 pins the WHOLE verify-vh.js source file" },
  // The embedded demo fixture + the challenge runner (both build-generated; the fixture DATA is extracted
  // verbatim from verify-vh.js, which the engine-slice record above pins by sha256).
  { id: "challenge-fixture", body: challengeFixtureBody, note: "the verifier's shipped demo packet (DEMO_SIGNER/DEMO_FILES/DEMO_CONTAINER/DEMO_PACKET_NAME), extracted verbatim at build time from verifier/verify-vh.js (pinned by the verify-vh-engine record's sourceSha256) — defined in build-standalone-html.js" },
  { id: "challenge", body: CHALLENGE_BODY, note: "the built-in 60-second-challenge runner over the embedded demo fixture — defined in build-standalone-html.js, not a source file" },
];

// Resolve a module's inlined body text (synthetic body, engine slice, or verbatim source with rewrites).
function bodyOf(m) {
  if (m.slice) return engineSliceBody();
  if (m.body != null) return typeof m.body === "function" ? m.body() : m.body;
  return rewriteRequires(readSource(m.file), m.rewrite, m.id);
}

// The tiny CommonJS shim the engine block embeds (byte-identical to the sibling builders').
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

// Build the DOM-free engine <script> block. Everything between the markers is plain computation — no
// DOM, no network, no clock on the paths the page drives — so `vm.runInNewContext` in a BARE context
// proves it needs nothing a browser page would provide (not even Node's Buffer: the shim supplies it).
// The block defines ONE global, VerifyVhStandalone: { engine, challenge }.
function engineScriptText() {
  const parts = [];
  parts.push("<script>");
  parts.push(ENGINE_BEGIN_MARKER);
  parts.push('"use strict";');
  parts.push("var VerifyVhStandalone = (function () {");
  parts.push(COMMONJS_SHIM.join("\n"));
  parts.push("");

  let entryId = null;
  for (const m of HTML_MODULES) {
    if (m.entry) entryId = m.id;
    parts.push(`// ===== module: ${m.id}${m.file ? `  (from verifier/${m.file})` : "  (build-generated)"} =====`);
    parts.push(`__modules[${JSON.stringify(m.id)}] = function (module, exports, __require) {`);
    parts.push(bodyOf(m));
    parts.push("};");
    parts.push("");
    if (m.id === "vh-buffer") {
      // The lexical `Buffer` every inlined module body resolves as a free identifier — the pure-JS shim,
      // NOT Node's (a browser has none). Declared once, inside the IIFE, before any factory runs.
      parts.push("// The `Buffer` global the inlined verifier libs reference, satisfied by the pure-JS shim above.");
      parts.push('var Buffer = __require("vh-buffer").Buffer;');
      parts.push("");
    }
  }
  if (!entryId) throw new Error("build-standalone-html: no entry module declared");

  parts.push("return {");
  parts.push(`  engine: __require(${JSON.stringify(entryId)}),`);
  parts.push('  challenge: __require("challenge"),');
  parts.push("};");
  parts.push("})();");
  parts.push(ENGINE_END_MARKER);
  parts.push("</scr" + "ipt>");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// The PAGE — markup + styles + the DOM glue script (OUTSIDE the engine markers). All fixed strings, so
// the emitted bytes stay a pure function of the committed sources. Every user/artifact-controlled value
// is rendered via textContent (never innerHTML), so a hostile relPath cannot inject markup.
// ---------------------------------------------------------------------------

const GENERATED_BANNER = [
  "<!--",
  "  verify-vh-standalone.html — the SINGLE-FILE, FULLY OFFLINE verifyhash verify page.",
  "",
  "  SPDX-License-Identifier: Apache-2.0",
  "  Copyright 2026 verifyhash.com - https://verifyhash.com",
  "",
  "  GENERATED by verifier/build-standalone-html.js from the in-tree verifier - DO NOT EDIT BY HAND.",
  "  Re-generate with: node verifier/build-standalone-html.js   (deterministic; `--check` attests the",
  "  committed file reproduces byte-for-byte from source, see verifier/dist/BUILD-PROVENANCE.json).",
  "",
  "  HOW TO USE IT (no Node, no install, no account, no server): save this ONE file, open it in a",
  "  browser, click the built-in sample packet (ACCEPT), change one byte of a sample file in the page",
  "  (REJECT, naming the file) - then drag a real sealed packet + its files in. Everything runs inside",
  "  the page: the file contains NO network API, so the packet bytes never leave this machine (verify",
  "  in your browser devtools Network tab).",
  "",
  "  HONEST BOUNDARY: ACCEPT is tamper-evidence that these exact bytes match the seal - and, for a",
  "  signed seal, WHO vouched (signer recovery + optional vendor pin). It is NOT a trusted timestamp",
  "  and NOT proof of WHEN. For CI/production gating use the node standalone (verify-vh-standalone.js).",
  "-->",
].join("\n");

const PAGE_STYLE = [
  "<style>",
  ":root { color-scheme: light; }",
  "* { box-sizing: border-box; }",
  'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
  "  margin: 0; background: #f6f7f9; color: #1a1f24; line-height: 1.45; }",
  "main { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; }",
  "h1 { font-size: 1.5rem; margin: 0.2em 0; }",
  "h2 { font-size: 1.15rem; margin: 1.6em 0 0.4em; }",
  "p { margin: 0.5em 0; }",
  ".note { color: #444d56; font-size: 0.92rem; }",
  ".boundary { background: #fff8e6; border: 1px solid #e0c869; border-radius: 6px; padding: 10px 12px; font-size: 0.92rem; }",
  "section { background: #ffffff; border: 1px solid #d9dee3; border-radius: 8px; padding: 16px; margin-top: 16px; }",
  "button { font: inherit; padding: 7px 14px; border-radius: 6px; border: 1px solid #9aa4ad; background: #eef1f4; cursor: pointer; }",
  "button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }",
  "textarea, input[type=text] { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;",
  "  font-size: 0.85rem; width: 100%; border: 1px solid #c4ccd4; border-radius: 6px; padding: 8px; }",
  ".drop { border: 2px dashed #9aa4ad; border-radius: 8px; padding: 18px; text-align: center; color: #444d56; background: #fafbfc; }",
  ".drop.armed { border-color: #1f6feb; background: #eef4ff; }",
  ".mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem; overflow-wrap: anywhere; }",
  ".verdict { border-radius: 8px; padding: 12px 14px; margin-top: 12px; border: 1px solid; }",
  ".verdict.accept { background: #e9f7ec; border-color: #34a853; }",
  ".verdict.reject { background: #fdecec; border-color: #d93025; }",
  ".verdict-title { font-weight: 700; margin-bottom: 6px; }",
  ".kv { margin: 2px 0; }",
  ".kv b { display: inline-block; min-width: 12em; font-weight: 600; }",
  "ul.files { margin: 6px 0; padding-left: 1.2em; }",
  ".row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; }",
  "footer { margin-top: 28px; color: #444d56; font-size: 0.85rem; }",
  "</style>",
].join("\n");

// The honest boundary, verbatim on the page (T-66.2 acceptance d).
const BOUNDARY_HTML = [
  '<p class="boundary"><strong>Honest boundary:</strong> ACCEPT is tamper-evidence that these exact bytes',
  "match the seal — and, for a signed seal, WHO vouched (signer recovery + optional vendor pin). It is NOT",
  "a trusted timestamp and NOT proof of WHEN without the P-3 trust-root. For CI/production gating use the",
  "node standalone (<code>verify-vh-standalone.js</code>).</p>",
].join("\n");

function pageBodyText() {
  return [
    "<main>",
    "<header>",
    "<h1>verify-vh — offline verifier (in your browser)</h1>",
    '<p class="note">An INDEPENDENT, read-only, fully OFFLINE verifier for verifyhash evidence packets.',
    "It RE-DERIVES the keccak Merkle root from the bytes YOU drop in and recovers the signer with a",
    "pure-JS secp256k1 routine — it never trusts the artifact's own stored hashes. This one file contains",
    "NO network API at all: your packet bytes never leave this machine (check the devtools Network tab).</p>",
    BOUNDARY_HTML,
    "</header>",
    "",
    '<section id="challenge-section">',
    "<h2>1 — The 60-second challenge (built in)</h2>",
    '<p class="note">A real, genuinely-signed sample packet is embedded in this page (signed by a fixed,',
    "published TEST-ONLY key — never a real key). Load it, watch it ACCEPT, then change ONE byte of a",
    "sample file below and watch the verifier REJECT it and name the file you changed.</p>",
    '<div class="row">',
    '<button id="load-sample" class="primary" type="button">Load the sample packet &amp; verify</button>',
    "</div>",
    '<div id="sample-area" style="display:none">',
    '<p class="kv"><b>packet</b><span id="sample-name" class="mono"></span></p>',
    '<p class="kv"><b>pinned signer</b><span id="sample-signer" class="mono"></span></p>',
    '<p class="note">The editable bytes of <code>model-card.md</code> (one sealed file) — change ANY one',
    "character, then re-verify:</p>",
    '<textarea id="sample-editor" rows="4" spellcheck="false"></textarea>',
    '<div class="row">',
    '<button id="sample-verify" class="primary" type="button">Re-verify the sample packet</button>',
    '<button id="sample-tamper" type="button">Tamper one byte for me</button>',
    '<button id="sample-restore" type="button">Restore the original bytes</button>',
    "</div>",
    '<div id="sample-verdict"></div>',
    "</div>",
    "</section>",
    "",
    '<section id="verify-section">',
    "<h2>2 — Verify a packet YOU were handed</h2>",
    '<p class="note">Drop the sealed artifact (<code>*.vhevidence.json</code> / <code>*.vhseal</code> /',
    "attestation / proof bundle) together with the files it references — or pick them below (the folder",
    "picker keeps sub-directory paths). Nothing is uploaded; the page reads the bytes locally.</p>",
    '<div id="drop-zone" class="drop">Drag the packet + its files (or a whole folder) here</div>',
    '<div class="row">',
    '<label>Files: <input id="file-input" type="file" multiple></label>',
    '<label>Folder: <input id="dir-input" type="file" webkitdirectory multiple></label>',
    '<button id="clear-files" type="button">Clear</button>',
    "</div>",
    '<div id="held-files" class="mono"></div>',
    '<div class="row">',
    '<label style="flex:1">Artifact: <select id="artifact-select" style="max-width:100%"></select></label>',
    "</div>",
    '<div class="row">',
    '<label style="flex:1">Vendor pin (optional 0x address — REJECT wrong_issuer if the signer differs):',
    '<input id="vendor-input" type="text" placeholder="0x…" spellcheck="false"></label>',
    "</div>",
    '<div class="row">',
    '<label>Revocations file (optional): <input id="revocations-input" type="file"></label>',
    '<span id="revocations-name" class="mono"></span>',
    "</div>",
    '<div class="row"><button id="run-verify" class="primary" type="button">Verify offline, in this page</button></div>',
    '<div id="verify-verdict"></div>',
    "</section>",
    "",
    "<footer>",
    '<p id="trust-note" class="note"></p>',
    "<p>Who verifies the verifier? This file is reproducible from readable source: rebuild it with",
    "<code>node verifier/build-standalone-html.js --check</code> (offline, Node-core-only) and compare the",
    "published <code>verify-vh-standalone.html.sha256</code>. Per-source pins live in",
    "<code>verifier/dist/BUILD-PROVENANCE.json</code>.</p>",
    "</footer>",
    "</main>",
  ].join("\n");
}

// The DOM glue script (browser-only; OUTSIDE the vm-extractable engine block). Uses FileReader +
// TextEncoder/TextDecoder — reading, never any network API.
function uiScriptText() {
  return [
    "<script>",
    '"use strict";',
    "(function () {",
    "  var E = VerifyVhStandalone.engine;",
    "  var C = VerifyVhStandalone.challenge;",
    "  var enc = new TextEncoder();",
    "  var dec = new TextDecoder();",
    "",
    "  function $(id) { return document.getElementById(id); }",
    "  function el(tag, cls, text) {",
    "    var n = document.createElement(tag);",
    "    if (cls) n.className = cls;",
    "    if (text !== undefined) n.textContent = text;",
    "    return n;",
    "  }",
    "  function kv(label, value) {",
    '    var p = el("div", "kv");',
    '    p.appendChild(el("b", null, label));',
    '    var v = el("span", "mono", value);',
    "    p.appendChild(v);",
    "    return p;",
    "  }",
    "",
    '  $("trust-note").textContent = E.TRUST_NOTE;',
    "",
    "  // ---------- shared verdict rendering (textContent only — hostile relPaths cannot inject) ----------",
    "  function renderVerdict(container, out) {",
    '    container.textContent = "";',
    "    if (out.error) {",
    '      var eb = el("div", "verdict reject");',
    '      eb.appendChild(el("div", "verdict-title", "CANNOT VERIFY (" + out.error.name + ", exit " + out.error.code + ")"));',
    '      eb.appendChild(el("div", "mono", out.error.message));',
    "      container.appendChild(eb);",
    "      return;",
    "    }",
    "    var r = out.result;",
    '    var box = el("div", "verdict " + (r.accepted ? "accept" : "reject"));',
    "    var title = r.accepted",
    '      ? "ACCEPT — the artifact verifies."',
    '      : (r.verdict === "REVOKED" ? "REVOKED" : "REJECTED") + " (" + r.reason + ")";',
    '    box.appendChild(el("div", "verdict-title", title));',
    '    box.appendChild(kv("artifact", String(r.artifact)));',
    '    box.appendChild(kv("kind", r.kind + (r.payloadKind !== r.kind ? "  (embeds " + r.payloadKind + ")" : "")));',
    '    box.appendChild(kv("signed", r.signed ? "yes" : "no"));',
    "    if (r.signed) {",
    '      box.appendChild(kv("recovered signer", r.recoveredSigner || "(unrecoverable)"));',
    '      if (r.pinnedVendor != null) {',
    '        box.appendChild(kv("pinned vendor", r.pinnedVendor));',
    '        box.appendChild(kv("signer matches vendor", r.signerMatchesVendor ? "yes" : "NO"));',
    "      }",
    "    }",
    '    if (r.sealedRoot != null) box.appendChild(kv("sealed root", r.sealedRoot));',
    '    if (r.recomputedRoot != null) box.appendChild(kv("recomputed root", r.recomputedRoot));',
    '    if (r.rootMatches != null) box.appendChild(kv("root matches", r.rootMatches ? "yes" : "NO"));',
    '    box.appendChild(kv("files", r.counts.matched + " matched, " + r.counts.changed + " changed, " +',
    '      r.counts.missing + " missing, " + (r.counts.escaped || 0) + " rejected"));',
    "    if (!r.accepted) {",
    '      var ul = el("ul", "files");',
    "      r.changed.forEach(function (c) {",
    '        ul.appendChild(el("li", "mono", "CHANGED " + c.relPath + ": sealed " + c.expectedContentHash + " != held " + c.actualContentHash));',
    "      });",
    "      r.missing.forEach(function (m) {",
    '        ul.appendChild(el("li", "mono", "MISSING " + m.relPath + ": referenced but not among the dropped files"));',
    "      });",
    "      (r.escaped || []).forEach(function (x) {",
    '        ul.appendChild(el("li", "mono", "REJECTED " + x.relPath + ": path escapes the packet (refused to read; no hash computed)"));',
    "      });",
    "      if (ul.childNodes.length) box.appendChild(ul);",
    "      if (r.trustAsOf && r.trustAsOf.governing) {",
    '        box.appendChild(el("div", "mono", "key_revoked_as_of: signing key " + r.trustAsOf.governing.vendorAddress +',
    '          " was REVOKED as of " + r.trustAsOf.governing.revokedAt + " (reason: " + r.trustAsOf.governing.reason + ")"));',
    "      }",
    "    }",
    "    container.appendChild(box);",
    "  }",
    "",
    "  // ---------- section 1: the built-in 60-second challenge ----------",
    "  function runSampleVerify() {",
    "    var contents = {};",
    "    Object.keys(C.fixture.FILES).forEach(function (k) { contents[k] = C.fixture.FILES[k]; });",
    '    contents[C.fixture.TAMPER_FILE] = $("sample-editor").value;',
    "    var out = C.verifyContents(contents);",
    '    renderVerdict($("sample-verdict"), out);',
    "  }",
    '  $("load-sample").onclick = function () {',
    '    $("sample-area").style.display = "";',
    '    $("sample-name").textContent = C.fixture.PACKET_NAME;',
    '    $("sample-signer").textContent = C.fixture.SIGNER + "  (fixed TEST-ONLY key — hardhat account #1)";',
    '    $("sample-editor").value = C.fixture.FILES[C.fixture.TAMPER_FILE];',
    "    runSampleVerify();",
    "  };",
    '  $("sample-verify").onclick = runSampleVerify;',
    '  $("sample-tamper").onclick = function () {',
    '    $("sample-editor").value = $("sample-editor").value + "X";',
    "    runSampleVerify();",
    "  };",
    '  $("sample-restore").onclick = function () {',
    '    $("sample-editor").value = C.fixture.FILES[C.fixture.TAMPER_FILE];',
    "    runSampleVerify();",
    "  };",
    "",
    "  // ---------- section 2: verify a real packet ----------",
    "  var held = {}; // relPath -> Uint8Array",
    "  var revocationsText = null;",
    "",
    "  function refreshHeld() {",
    '    var list = $("held-files");',
    '    list.textContent = "";',
    "    var keys = Object.keys(held).sort();",
    '    if (keys.length === 0) { list.textContent = "(no files held yet)"; return refreshArtifactSelect(); }',
    "    keys.forEach(function (k) {",
    '      list.appendChild(el("div", null, k + "  (" + held[k].length + " bytes)"));',
    "    });",
    "    refreshArtifactSelect();",
    "  }",
    "  function artifactCandidates() {",
    "    var kinds = Object.keys(E.KINDS).map(function (k) { return E.KINDS[k]; });",
    "    return Object.keys(held).sort().filter(function (k) {",
    "      if (held[k].length > 8 * 1024 * 1024) return false;",
    "      try {",
    "        var obj = JSON.parse(dec.decode(held[k]));",
    '        return !!obj && typeof obj === "object" && kinds.indexOf(obj.kind) !== -1;',
    "      } catch (e) { return false; }",
    "    });",
    "  }",
    "  function refreshArtifactSelect() {",
    '    var sel = $("artifact-select");',
    '    sel.textContent = "";',
    "    var cands = artifactCandidates();",
    "    if (cands.length === 0) {",
    '      var opt = el("option", null, "(drop a *.vhevidence.json / *.vhseal / attestation / proof first)");',
    '      opt.value = "";',
    "      sel.appendChild(opt);",
    "      return;",
    "    }",
    "    cands.forEach(function (k) {",
    '      var opt = el("option", null, k);',
    "      opt.value = k;",
    "      sel.appendChild(opt);",
    "    });",
    "  }",
    "  function addHeld(relPath, bytes) {",
    '    var key = String(relPath).replace(/\\\\/g, "/").replace(/^\\.\\//, "");',
    "    held[key] = bytes;",
    "  }",
    "  function readFileInto(relPath, file, done) {",
    "    var r = new FileReader();",
    "    r.onload = function () { addHeld(relPath, new Uint8Array(r.result)); done(); };",
    '    r.onerror = function () { done("cannot read " + relPath); };',
    "    r.readAsArrayBuffer(file);",
    "  }",
    "  // Strip the top-level picked/dropped folder name so keys are relative to the packet's own dir,",
    "  // exactly like the CLI's `--dir <folder>` resolution.",
    "  function innerPath(p) {",
    '    var parts = String(p).split("/").filter(function (s) { return s.length > 0; });',
    "    return parts.length > 1 ? parts.slice(1).join(\"/\") : parts.join(\"/\");",
    "  }",
    "  function afterBatch(pending) {",
    "    if (pending.n === 0) refreshHeld();",
    "  }",
    "  function ingestFileList(fileList, useRelative) {",
    "    var files = Array.prototype.slice.call(fileList);",
    "    var pending = { n: files.length };",
    "    if (files.length === 0) return;",
    "    files.forEach(function (f) {",
    "      var rel = useRelative && f.webkitRelativePath ? innerPath(f.webkitRelativePath) : f.name;",
    "      readFileInto(rel, f, function () { pending.n--; afterBatch(pending); });",
    "    });",
    "  }",
    "  function walkEntry(entry, prefix, pending) {",
    "    if (entry.isFile) {",
    "      pending.n++;",
    "      entry.file(function (f) {",
    "        readFileInto(prefix + entry.name, f, function () { pending.n--; afterBatch(pending); });",
    "      }, function () { pending.n--; afterBatch(pending); });",
    "    } else if (entry.isDirectory) {",
    "      var reader = entry.createReader();",
    "      var readMore = function () {",
    "        pending.n++;",
    "        reader.readEntries(function (entries) {",
    "          entries.forEach(function (e) { walkEntry(e, prefix + entry.name + \"/\", pending); });",
    "          pending.n--;",
    "          if (entries.length > 0) readMore();",
    "          else afterBatch(pending);",
    "        }, function () { pending.n--; afterBatch(pending); });",
    "      };",
    "      readMore();",
    "    }",
    "  }",
    '  var drop = $("drop-zone");',
    '  drop.addEventListener("dragover", function (ev) { ev.preventDefault(); drop.classList.add("armed"); });',
    '  drop.addEventListener("dragleave", function () { drop.classList.remove("armed"); });',
    '  drop.addEventListener("drop", function (ev) {',
    "    ev.preventDefault();",
    '    drop.classList.remove("armed");',
    "    var items = ev.dataTransfer && ev.dataTransfer.items;",
    "    var usedEntries = false;",
    "    if (items) {",
    "      var pending = { n: 0 };",
    "      for (var i = 0; i < items.length; i++) {",
    "        var entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();",
    "        if (entry) {",
    "          usedEntries = true;",
    "          if (entry.isDirectory) {",
    "            // Paths inside a dropped folder are taken relative to THAT folder (like --dir).",
    "            var reader = entry.createReader();",
    "            (function (rd) {",
    "              var readMore = function () {",
    "                pending.n++;",
    "                rd.readEntries(function (entries) {",
    '                  entries.forEach(function (e) { walkEntry(e, "", pending); });',
    "                  pending.n--;",
    "                  if (entries.length > 0) readMore();",
    "                  else afterBatch(pending);",
    "                }, function () { pending.n--; afterBatch(pending); });",
    "              };",
    "              readMore();",
    "            })(reader);",
    "          } else {",
    '            walkEntry(entry, "", pending);',
    "          }",
    "        }",
    "      }",
    "    }",
    "    if (!usedEntries && ev.dataTransfer && ev.dataTransfer.files) {",
    "      ingestFileList(ev.dataTransfer.files, false);",
    "    }",
    "  });",
    '  $("file-input").addEventListener("change", function () { ingestFileList(this.files, false); });',
    '  $("dir-input").addEventListener("change", function () { ingestFileList(this.files, true); });',
    '  $("clear-files").onclick = function () {',
    "    held = {};",
    "    revocationsText = null;",
    '    $("revocations-name").textContent = "";',
    '    $("revocations-input").value = "";',
    '    $("verify-verdict").textContent = "";',
    "    refreshHeld();",
    "  };",
    '  $("revocations-input").addEventListener("change", function () {',
    "    var f = this.files && this.files[0];",
    "    if (!f) { revocationsText = null; return; }",
    "    var r = new FileReader();",
    "    r.onload = function () {",
    "      revocationsText = String(r.result);",
    '      $("revocations-name").textContent = f.name + " (applies the same revoked-key downgrade the CLI does)";',
    "    };",
    "    r.readAsText(f);",
    "  });",
    '  $("run-verify").onclick = function () {',
    '    var out = $("verify-verdict");',
    '    var artifactKey = $("artifact-select").value;',
    "    if (!artifactKey || !held[artifactKey]) {",
    '      out.textContent = "";',
    '      var eb = el("div", "verdict reject");',
    '      eb.appendChild(el("div", "verdict-title", "No artifact selected"));',
    '      eb.appendChild(el("div", null, "Drop the sealed artifact JSON together with the files it references, then pick it above."));',
    "      out.appendChild(eb);",
    "      return;",
    "    }",
    "    var files = {};",
    "    Object.keys(held).forEach(function (k) { if (k !== artifactKey) files[k] = held[k]; });",
    '    var vendor = $("vendor-input").value.trim();',
    "    var params = {",
    "      artifactText: dec.decode(held[artifactKey]),",
    "      files: files,",
    "      artifactName: artifactKey,",
    "    };",
    "    if (vendor) params.vendor = vendor;",
    "    if (revocationsText != null) params.revocationsText = revocationsText;",
    "    renderVerdict(out, E.verifyArtifactFromBytes(params));",
    "  };",
    "  refreshHeld();",
    "})();",
    "</scr" + "ipt>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Build the FULL standalone HTML text. Pure function of the committed sources -> deterministic.
// ---------------------------------------------------------------------------

function buildHtml() {
  const parts = [];
  parts.push("<!doctype html>");
  parts.push(GENERATED_BANNER);
  parts.push('<html lang="en">');
  parts.push("<head>");
  parts.push('<meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  parts.push("<title>verify-vh — offline verifier (verifyhash)</title>");
  parts.push(PAGE_STYLE);
  parts.push("</head>");
  parts.push("<body>");
  parts.push(pageBodyText());
  parts.push(engineScriptText());
  parts.push(uiScriptText());
  parts.push("</body>");
  parts.push("</html>");
  parts.push(""); // single trailing newline
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Build provenance — the SAME schema + module-record shape the shared manifest uses, so a reviewer reads
// every target the same way. This builder does NOT own BUILD-PROVENANCE.json: verifier/build-standalone.js
// composes the WHOLE manifest (verify + seal + this html target) so the committed file has ONE writer
// shape; this module only supplies its own target record.
// ---------------------------------------------------------------------------

function moduleProvenance(m) {
  if (m.slice) {
    return {
      id: m.id,
      synthetic: false,
      sourceFile: `verifier/${m.file}`,
      sourceSha256: sha256HexOf(readSource(m.file)),
      inlinedSha256: sha256HexOf(bodyOf(m)),
      entry: m.entry === true,
      note: m.note,
    };
  }
  if (m.body != null) {
    return {
      id: m.id,
      synthetic: true,
      sourceFile: null,
      sourceSha256: null,
      inlinedSha256: sha256HexOf(bodyOf(m)),
      note: m.note,
    };
  }
  const src = readSource(m.file);
  return {
    id: m.id,
    synthetic: false,
    sourceFile: `verifier/${m.file}`,
    sourceSha256: sha256HexOf(src),
    inlinedSha256: sha256HexOf(rewriteRequires(src, m.rewrite, m.id)),
    entry: m.entry === true,
  };
}

// The html target's record for the shared BUILD-PROVENANCE.json (bundle sha256 + ordered per-module
// source sha256s). Pure function of the committed sources -> deterministic.
function htmlTargetProvenance() {
  const bundleText = buildHtml();
  return {
    bundle: SHA256_BASENAME,
    sidecar: path.basename(SHA256_PATH),
    bundleBytes: Buffer.byteLength(bundleText, "utf8"),
    bundleSha256: sha256HexOf(bundleText),
    sidecarLine: sha256SidecarFor(bundleText, SHA256_BASENAME).trim(),
    modules: HTML_MODULES.map(moduleProvenance),
  };
}

// Lazily require the sibling builder (the manifest's single owner). Lazy on BOTH sides so neither module
// observes the other's exports mid-load, whichever is the process entrypoint.
function jsBuilder() {
  return require("./build-standalone");
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function writeAll() {
  const html = buildHtml();
  const sidecar = sha256SidecarFor(html, SHA256_BASENAME);
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, html);
  fs.writeFileSync(SHA256_PATH, sidecar);
  // Re-emit the SHARED manifest through its single owner (which composes verify + seal + this target),
  // so the committed BUILD-PROVENANCE.json can never fork between the two builders.
  const provenance = jsBuilder().writeProvenance();
  return { html, sidecar, provenance };
}

// ---------------------------------------------------------------------------
// REPRODUCE-AND-ATTEST (`--check`) — same posture as the sibling builders: re-compile the page from the
// in-tree source a skeptic can READ, recompute the published checksum + the shared provenance manifest,
// and assert the COMMITTED files are byte-for-byte what that source compiles to. Read-only; writes
// NOTHING; a stale/tampered dist is a named MISMATCH (exit 1), never a crash.
// ---------------------------------------------------------------------------

function checkHtml() {
  const rel = (p) => path.relative(VERIFIER_DIR, p);
  const result = {
    bundlePath: rel(OUT_PATH),
    sha256Path: rel(SHA256_PATH),
    expectedHex: null,
    bundle: { ok: false, reason: "" },
    sidecar: { ok: false, reason: "" },
    sources: { ok: true, reason: "", offenders: [] },
  };

  // Source-presence FIRST, so a missing inlined source is a named MISMATCH, not a build crash.
  const sourceFiles = [...new Set(HTML_MODULES.filter((m) => m.file).map((m) => m.file))];
  for (const f of sourceFiles) {
    if (!fs.existsSync(path.join(VERIFIER_DIR, f))) {
      result.sources.ok = false;
      result.sources.offenders.push({ sourceFile: `verifier/${f}`, reason: "MISSING" });
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

function runCheck(io) {
  const out = (io && io.write) || ((s) => process.stdout.write(s));
  const err = (io && io.writeErr) || ((s) => process.stderr.write(s));

  out("verifyhash standalone HTML REPRODUCE-AND-ATTEST (--check): re-compiling the offline page from\n");
  out("in-tree source, recomputing its published checksum + the shared build-provenance manifest, and\n");
  out("comparing all against the committed files. No network; no writes.\n\n");

  let allOk = true;

  const b = checkHtml();
  out(`[${b.bundle.ok ? "MATCH" : "MISMATCH"}] bundle  ${b.bundlePath}: ${b.bundle.reason}\n`);
  out(`[${b.sidecar.ok ? "MATCH" : "MISMATCH"}] sidecar ${b.sha256Path}: ${b.sidecar.reason}\n`);
  out(`[${b.sources.ok ? "MATCH" : "MISMATCH"}] sources ${b.bundlePath}: ${b.sources.reason}\n`);
  if (!b.ok) allOk = false;

  // The SHARED manifest + source->hash chain (spans verify + seal + this html target) — attested through
  // its single owner so the two builders can never disagree about what the committed manifest should be.
  const p = jsBuilder().checkProvenance();
  out(`[${p.manifest.ok ? "MATCH" : "MISMATCH"}] manifest ${p.manifestPath}: ${p.manifest.reason}\n`);
  out(`[${p.chain.ok ? "MATCH" : "MISMATCH"}] sources->manifest: ${p.chain.reason}\n`);
  if (!p.ok) allOk = false;

  if (allOk) {
    out("\nALL MATCH — the committed offline page, its sidecar AND the shared build-provenance manifest\n");
    out("reproduce byte-for-byte from the in-tree source, and every inlined source file hashes to its\n");
    out("manifest-pinned sha256.\n");
    return 0;
  }
  err("\nMISMATCH — at least one committed file does NOT reproduce from source (see above). Re-run\n");
  err("`node verifier/build-standalone-html.js` (no flag) to regenerate, or distrust this checkout.\n");
  return 1;
}

// Exports are assigned BEFORE the CLI main block below: the no-flag build calls writeAll(), which asks
// the sibling builder to re-emit the SHARED manifest, which requires THIS module back (a benign cycle) —
// assigning exports first guarantees the sibling always sees the complete surface.
module.exports = {
  buildHtml,
  engineScriptText,
  engineSliceBody,
  extractDemoFixture,
  htmlTargetProvenance,
  moduleProvenance,
  writeAll,
  checkHtml,
  runCheck,
  sha256HexOf,
  sha256SidecarFor,
  BUFFER_SHIM_BODY,
  KECCAK_SHIM_BODY,
  CHALLENGE_BODY,
  HTML_MODULES,
  HTML_TARGET_NAME,
  ENGINE_BEGIN_MARKER,
  ENGINE_END_MARKER,
  VV_ENGINE_BEGIN,
  VV_ENGINE_END,
  TAMPER_FILE,
  OUT_PATH,
  SHA256_PATH,
  SHA256_BASENAME,
  PROVENANCE_PATH,
  PROVENANCE_SCHEMA,
  DIST_DIR,
  VERIFIER_DIR,
};

if (require.main === module) {
  if (process.argv.slice(2).includes("--check")) {
    process.exit(runCheck());
  }
  const { html, sidecar, provenance } = writeAll();
  process.stdout.write(`wrote ${path.relative(VERIFIER_DIR, OUT_PATH)} (${Buffer.byteLength(html)} bytes)\n`);
  process.stdout.write(`wrote ${path.relative(VERIFIER_DIR, SHA256_PATH)} (${sidecar.trim()})\n`);
  process.stdout.write(
    `wrote ${path.relative(VERIFIER_DIR, PROVENANCE_PATH)} (${Buffer.byteLength(provenance)} bytes)\n`
  );
}
