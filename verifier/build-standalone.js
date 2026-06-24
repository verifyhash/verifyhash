#!/usr/bin/env node
"use strict";

// verifier/build-standalone.js — the DETERMINISTIC, OFFLINE, zero-third-party-dependency bundler that
// inlines the in-tree verifier (verifier/verify-vh.js + verifier/lib/*) into ONE self-contained file,
// verifier/dist/verify-vh-standalone.js (T-35.2).
//
// WHY THIS EXISTS
//   The free verifier is the FUNNEL: every counterparty who runs it on a partner's seal is a warm lead
//   for the paid seal. But today a third party who received ONE sealed packet must clone this repo (or be
//   handed the verifier/ tree) and `npm install` — which still pulls a runtime dependency (`js-sha3`, via
//   verifier/lib/keccak.js). This bundler removes that last friction: it emits a SINGLE file a skeptic can
//   save with no clone, no `npm install`, no `node_modules`, no `package.json`, and run with `node` —
//   and audit in one sitting. It is the strongest possible form of "don't trust us, check it yourself."
//
// WHAT IT GUARANTEES (proven by test/verifier.standalone.test.js)
//   * DETERMINISTIC — running it twice yields BYTE-IDENTICAL output. There is no timestamp, no randomness,
//     no filesystem-order dependence: the module set + order are an EXPLICIT, fixed list below, and the
//     emitted bytes are a pure function of the (committed) source files. The test rebuilds in a temp dir
//     and asserts the committed dist file matches byte-for-byte (a stale committed bundle FAILS CI).
//   * ZERO third-party / relative deps — the keccak256 module is swapped for the PURE-JS vendored
//     implementation (verifier/lib/keccak256-vendored.js), so the bundle `require`s NOTHING but Node core
//     (it does not even need Buffer-only Node — it uses Buffer, which is Node core). A grep over the
//     emitted file finds no `require('js-sha3')`, no `require('./lib/...')`, no `../`, no bare 3rd-party
//     name (only `require("fs")` / `require("path")`, which are Node core).
//   * SAME VERDICTS — the inlined verify-vh.js is the EXACT in-tree source (the in-tree file is UNCHANGED);
//     only the keccak provider is swapped for a byte-identical vendored one (cross-checked against js-sha3
//     AND ethers by test/verifier.keccak-vendored.test.js). So the standalone produces the identical
//     verdict text + exit code as the in-tree verifier across the whole artifact/verdict matrix.
//
// HOW IT WORKS — a tiny CommonJS shim
//   The bundle embeds a `__modules` registry of factory functions keyed by a canonical module id, plus a
//   memoizing `__require(id)`. Each source file is inlined VERBATIM as a factory body, with ONLY its
//   require() specifiers rewritten to `__require("<canonical id>")`. The keccak module's body is replaced
//   with a vendored-backed shim (returns a Buffer to match keccak.js's contract). NOTHING else is
//   transformed, so the inlined logic is the audited in-tree logic, line for line.
//
// OFFLINE + READ-ONLY: this builder reads the committed source files and WRITES one output file under
//   verifier/dist/. It opens NO socket and makes NO network call. The produced file is an ARTIFACT — the
//   loop never executes it against any network.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VERIFIER_DIR = __dirname;
const DIST_DIR = path.join(VERIFIER_DIR, "dist");
const OUT_PATH = path.join(DIST_DIR, "verify-vh-standalone.js");
// The PUBLISHED checksum sidecar (T-35.3): the SHA-256 of the committed bundle, in the standard
// `sha256sum`/`shasum -a 256` line format (`<hex>␠␠<basename>\n`) so a counterparty can run
// `sha256sum -c verify-vh-standalone.js.sha256` after a one-line `curl`/save, BEFORE running the file.
// It is a pure function of the (deterministic) bundle bytes, so it never rots: the build re-emits it and
// the test asserts it equals sha256(committed bundle).
const SHA256_PATH = OUT_PATH + ".sha256";
const SHA256_BASENAME = path.basename(OUT_PATH);

// The exact textual contents of the `.sha256` sidecar for a given bundle text. One canonical line, the
// standard two-space `sha256sum` separator, a trailing newline. Pure function -> deterministic.
function sha256Sidecar(bundleText) {
  const hex = crypto.createHash("sha256").update(Buffer.from(bundleText, "utf8")).digest("hex");
  return `${hex}  ${SHA256_BASENAME}\n`;
}

// ---------------------------------------------------------------------------
// The EXPLICIT, FIXED module list. Order is deterministic by construction (it is hand-listed, not derived
// from a filesystem walk). Each entry:
//   id     — the canonical module id used inside the bundle's __require() graph.
//   file   — the source file under verifier/ to inline (relative to VERIFIER_DIR).
//   rewrite— map of the EXACT require() specifier as written in that file -> the canonical id it resolves
//            to inside the bundle. Every relative require in a file MUST appear here (the build asserts it).
//   body   — (optional) when present, REPLACES the file's body entirely (used to swap the keccak provider
//            for the vendored pure-JS one). When absent, the file's source is inlined with rewrites applied.
//
// The entrypoint (verify-vh.js) is inlined LAST and is the module the bundle boots.
// ---------------------------------------------------------------------------

// The vendored keccak provider, inlined as the body of the "keccak" module so that merkle/secp256k1 — which
// `require("./keccak")` — transparently use the pure-JS implementation with NO js-sha3 dependency. It
// exposes the SAME surface keccak.js exposes (`keccak256(bytes) -> Buffer`); merkle.js/secp256k1-recover.js
// rely on a Buffer return (`.slice(...).toString("hex")`, `Buffer.concat([...])`), so we wrap the vendored
// Uint8Array result in a Buffer. The vendored source is itself inlined as a private module the shim pulls.
const KECCAK_SHIM_BODY = [
  '"use strict";',
  "// Inlined keccak provider for the standalone bundle: the SAME `keccak256(bytes) -> Buffer` surface as",
  "// verifier/lib/keccak.js, but backed by the PURE-JS, zero-dependency vendored implementation",
  "// (verifier/lib/keccak256-vendored.js) instead of js-sha3 — so the bundle requires nothing external.",
  'var vendored = __require("keccak256-vendored");',
  "function keccak256(bytes) {",
  "  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {",
  '    throw new TypeError("keccak256 requires a Buffer/Uint8Array of input bytes");',
  "  }",
  "  // The vendored routine returns a Uint8Array; wrap it as a Buffer so downstream `.slice(...).toString",
  '  // ("hex")` and `Buffer.concat([...])` callers behave exactly as they do with the js-sha3-backed shim.',
  "  return Buffer.from(vendored.keccak256(bytes));",
  "}",
  "module.exports = { keccak256 };",
].join("\n");

const MODULES = [
  // The pure-JS keccak256 — inlined VERBATIM from the committed vendored source (it already `require`s
  // nothing, so there is no rewrite to apply). The keccak shim below pulls it via __require.
  { id: "keccak256-vendored", file: "lib/keccak256-vendored.js", rewrite: {} },
  // The keccak provider the rest of the verifier requires as "./keccak" — body SWAPPED to the vendored shim.
  { id: "keccak", file: "lib/keccak.js", rewrite: {}, body: KECCAK_SHIM_BODY },
  // The independent merkle / canonical / secp256k1 libs, inlined verbatim with their relative requires
  // rewritten to canonical ids.
  { id: "merkle", file: "lib/merkle.js", rewrite: { "./keccak": "keccak" } },
  { id: "canonical", file: "lib/canonical.js", rewrite: {} },
  { id: "secp256k1-recover", file: "lib/secp256k1-recover.js", rewrite: { "./keccak": "keccak" } },
  // The entrypoint, inlined LAST. Its relative requires resolve to the canonical ids above.
  {
    id: "verify-vh",
    file: "verify-vh.js",
    rewrite: {
      "./lib/merkle": "merkle",
      "./lib/canonical": "canonical",
      "./lib/secp256k1-recover": "secp256k1-recover",
    },
    entry: true,
  },
];

// The require() specifiers a bundled module is ALLOWED to keep verbatim — Node core modules the standalone
// genuinely uses. Anything else (a bare third-party name, an unlisted relative path) is a build error: the
// bundle must never silently carry an external dependency.
const ALLOWED_CORE = new Set(["fs", "path", "node:fs", "node:path"]);

// Collect every require("…") specifier in a source string.
function requireSpecifiers(src) {
  return [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
}

// Rewrite a module's source: every require("<spec>") is either (a) rewritten to __require("<canonical>")
// when <spec> is in the module's rewrite map, or (b) left verbatim when <spec> is an allowed Node-core
// module. Any other specifier is a hard build error (an un-inlined dependency would break the zero-dep
// guarantee). Returns the rewritten source.
function rewriteRequires(src, rewrite, idForError) {
  // Assert up front that every relative require is covered by the rewrite map (so an added dependency in a
  // source file can never slip into the bundle un-inlined).
  for (const spec of requireSpecifiers(src)) {
    const isCore = ALLOWED_CORE.has(spec);
    const isMapped = Object.prototype.hasOwnProperty.call(rewrite, spec);
    if (!isCore && !isMapped) {
      throw new Error(
        `build-standalone: module "${idForError}" has an un-inlined require(${JSON.stringify(spec)}). ` +
          "Add it to the module's rewrite map (and inline its target) or it would break the zero-dependency bundle."
      );
    }
  }
  return src.replace(/require\(\s*["']([^"']+)["']\s*\)/g, (full, spec) => {
    if (Object.prototype.hasOwnProperty.call(rewrite, spec)) {
      return `__require(${JSON.stringify(rewrite[spec])})`;
    }
    return full; // an allowed Node-core require, kept verbatim
  });
}

// Read a source file deterministically, normalizing line endings to "\n" (so a checkout with CRLF cannot
// change the emitted bytes) and stripping a leading shebang line (the bundle has its own).
function readSource(rel) {
  let s = fs.readFileSync(path.join(VERIFIER_DIR, rel), "utf8");
  s = s.replace(/\r\n/g, "\n");
  s = s.replace(/^#![^\n]*\n/, "");
  return s;
}

// Build the standalone bundle TEXT deterministically. Pure function of the committed source files.
function buildBundle() {
  const parts = [];

  // --- header: shebang + a fixed, version-free banner (NO timestamp -> deterministic) ---
  parts.push("#!/usr/bin/env node");
  parts.push('"use strict";');
  parts.push("");
  parts.push(
    [
      "// verify-vh-standalone.js — the SINGLE-FILE, ZERO-DEPENDENCY, OFFLINE verifyhash verifier.",
      "//",
      "// GENERATED by verifier/build-standalone.js from the in-tree verifier — DO NOT EDIT BY HAND.",
      "// Re-generate with: node verifier/build-standalone.js   (the build is deterministic; see that file.)",
      "//",
      "// HOW TO USE IT (no clone, no `npm install`, no node_modules, no package.json):",
      "//   1. Save THIS one file somewhere next to the sealed artifact you were handed.",
      "//   2. Run:  node verify-vh-standalone.js <artifact> [--vendor <0xaddr>] [--dir <d>] [--json]",
      "//   Exit codes: 0 ok / 3 rejected / 2 usage / 1 IO.   It is READ-ONLY and opens NO network.",
      "//",
      "// It RE-DERIVES the keccak Merkle root from the bytes YOU hold and recovers the signer with a",
      "// pure-JS secp256k1 routine — it never trusts the artifact's own stored hashes, and it requires",
      "// NOTHING outside Node core. This is the in-tree verifier inlined verbatim, with keccak256 swapped",
      "// for a byte-identical pure-JS implementation (cross-checked against js-sha3 AND ethers).",
    ].join("\n")
  );
  parts.push("");

  // --- the tiny CommonJS shim: a module registry + a memoizing __require. ---
  parts.push(
    [
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
    ].join("\n")
  );
  parts.push("");

  let entryId = null;

  // --- inline each module as a factory in the fixed list order. ---
  for (const m of MODULES) {
    let body;
    if (typeof m.body === "string") {
      // The body is supplied verbatim (the keccak shim). It may itself call __require (e.g. for the
      // vendored keccak) — that is the bundle's own shim, not an external dependency, so it is allowed.
      body = m.body;
    } else {
      const src = readSource(m.file);
      body = rewriteRequires(src, m.rewrite, m.id);
    }
    if (m.entry) entryId = m.id;

    parts.push(`// ===== module: ${m.id}  (from verifier/${m.file}) =====`);
    parts.push(`__modules[${JSON.stringify(m.id)}] = function (module, exports, __require) {`);
    parts.push(body);
    parts.push("};");
    parts.push("");
  }

  if (!entryId) throw new Error("build-standalone: no entry module declared");

  // --- boot the entrypoint exactly as verify-vh.js does at the bottom of its own file. ---
  // The inlined verify-vh.js sets `module.exports = { ..., run }` and has a `require.main === module` CLI
  // shim that does NOT fire inside the bundle's factory (its `module` is the shim's, not Node's), so we
  // drive the CLI explicitly here: load the entry module and run it with process.argv, exiting on its code.
  parts.push("// ---- boot: run the inlined verifier CLI with this process's argv. ----");
  parts.push(`var __entry = __require(${JSON.stringify(entryId)});`);
  parts.push("if (require.main === module) {");
  parts.push("  process.exit(__entry.run(process.argv.slice(2)));");
  parts.push("}");
  parts.push("module.exports = __entry;");
  parts.push(""); // single trailing newline

  return parts.join("\n");
}

// Write the bundle to disk (used by the CLI invocation), AND its published `.sha256` checksum sidecar.
// Creates verifier/dist/ if absent. Returns the emitted text so callers can compare without a re-read.
function writeBundle() {
  const text = buildBundle();
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, text);
  // Re-emit the published checksum so the sidecar can never drift from the bundle it pins.
  fs.writeFileSync(SHA256_PATH, sha256Sidecar(text));
  return text;
}

if (require.main === module) {
  const text = writeBundle();
  process.stdout.write(`wrote ${path.relative(VERIFIER_DIR, OUT_PATH)} (${Buffer.byteLength(text)} bytes)\n`);
  process.stdout.write(`wrote ${path.relative(VERIFIER_DIR, SHA256_PATH)} (${sha256Sidecar(text).trim()})\n`);
}

module.exports = {
  buildBundle,
  writeBundle,
  sha256Sidecar,
  OUT_PATH,
  SHA256_PATH,
  SHA256_BASENAME,
  DIST_DIR,
  VERIFIER_DIR,
  MODULES,
};
