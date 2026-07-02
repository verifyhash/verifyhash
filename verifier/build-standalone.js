#!/usr/bin/env node
"use strict";

// verifier/build-standalone.js — the DETERMINISTIC, OFFLINE, zero-third-party-dependency bundler that
// inlines the in-tree verifier/sealer (verifier/verify-vh.js / verifier/lib/seal-cli.js + verifier/lib/*)
// into self-contained single files under verifier/dist/ (T-35.2 verify bundle; T-36.2 SEAL bundle).
//
// IT EMITS TWO TARGETS (both deterministic, both zero-third-party):
//   * verify-vh-standalone.js — the free VERIFY half (T-35.2): a counterparty handed ONE sealed packet
//     saves this and runs it. (Bytes UNCHANGED by T-36.2 — the verify target list/order is untouched.)
//   * seal-vh-standalone.js   — the free PRODUCE half (T-36.2): a stranger SEALS up to 25 of their OWN
//     files into a `vh.evidence-seal` the verify bundle then accepts. Together the two close the organic
//     adoption loop with ZERO install on EITHER side.
//
// WHY THIS EXISTS
//   The free verifier is the FUNNEL: every counterparty who runs it on a partner's seal is a warm lead
//   for the paid seal. But today a third party who received ONE sealed packet must clone this repo (or be
//   handed the verifier/ tree) and `npm install` — which still pulls a runtime dependency (`js-sha3`, via
//   verifier/lib/keccak.js). This bundler removes that last friction: it emits a SINGLE file a skeptic can
//   save with no clone, no `npm install`, no `node_modules`, no `package.json`, and run with `node` —
//   and audit in one sitting. It is the strongest possible form of "don't trust us, check it yourself."
//   T-36.2 applies the SAME bundling discipline to the PRODUCE side so a prospect can both make AND check
//   a free seal with no install anywhere.
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
const SEAL_OUT_PATH = path.join(DIST_DIR, "seal-vh-standalone.js");
// The PUBLISHED checksum sidecar (T-35.3): the SHA-256 of the committed bundle, in the standard
// `sha256sum`/`shasum -a 256` line format (`<hex>␠␠<basename>\n`) so a counterparty can run
// `sha256sum -c <bundle>.sha256` after a one-line `curl`/save, BEFORE running the file. It is a pure
// function of the (deterministic) bundle bytes, so it never rots: the build re-emits it and the test
// asserts it equals sha256(committed bundle).
const SHA256_PATH = OUT_PATH + ".sha256";
const SEAL_SHA256_PATH = SEAL_OUT_PATH + ".sha256";
const SHA256_BASENAME = path.basename(OUT_PATH);
const SEAL_SHA256_BASENAME = path.basename(SEAL_OUT_PATH);

// The PUBLISHED build-provenance manifest (T-54.2): a single committed, deterministic JSON file that maps
// each published bundle's sha256 back to the ORDERED list of in-tree source files it inlines, EACH pinned by
// its own sha256. It is the bridge that lets trust root in READING SOURCE, not in trusting our published hex:
// a skeptic hashes the `lib/*.js` files they just audited, finds those exact hashes in this manifest, and sees
// they compose (in this exact order) the bundle whose hash is published in the `.sha256` sidecar. `--check`
// recomputes the WHOLE manifest from source and asserts the committed one matches byte-for-byte, so it can
// never drift from the bundles it describes. Pure function of the (committed) sources -> deterministic.
const PROVENANCE_PATH = path.join(DIST_DIR, "BUILD-PROVENANCE.json");
const PROVENANCE_BASENAME = path.basename(PROVENANCE_PATH);
// A version-free schema tag so a consumer can pin the shape without a timestamp leaking into the bytes.
const PROVENANCE_SCHEMA = "verifyhash/build-provenance@1";

// The exact textual contents of the `.sha256` sidecar for a given bundle text + basename. One canonical
// line, the standard two-space `sha256sum` separator, a trailing newline. Pure function -> deterministic.
function sha256SidecarFor(bundleText, basename) {
  const hex = crypto.createHash("sha256").update(Buffer.from(bundleText, "utf8")).digest("hex");
  return `${hex}  ${basename}\n`;
}
// Back-compat alias: the verify bundle's sidecar (the original single-target signature T-35.3 tests call).
function sha256Sidecar(bundleText) {
  return sha256SidecarFor(bundleText, SHA256_BASENAME);
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

// The shared vendored-keccak modules every target inlines first: the pure-JS keccak256 and the "./keccak"
// shim swapped to use it. Both bundles share these byte-identical entries.
const SHARED_KECCAK_MODULES = [
  // The pure-JS keccak256 — inlined VERBATIM from the committed vendored source (it already `require`s
  // nothing, so there is no rewrite to apply). The keccak shim below pulls it via __require.
  { id: "keccak256-vendored", file: "lib/keccak256-vendored.js", rewrite: {} },
  // The keccak provider the rest of the verifier/sealer requires as "./keccak" — body SWAPPED to the shim.
  { id: "keccak", file: "lib/keccak.js", rewrite: {}, body: KECCAK_SHIM_BODY },
];

// --- TARGET 1: the VERIFY bundle (verify-vh-standalone.js). Module list/order UNCHANGED by T-36.2 so the
//     committed verify bundle stays byte-identical. ---
const VERIFY_MODULES = [
  ...SHARED_KECCAK_MODULES,
  // The independent merkle / canonical / secp256k1 libs, inlined verbatim with their relative requires
  // rewritten to canonical ids.
  { id: "merkle", file: "lib/merkle.js", rewrite: { "./keccak": "keccak" } },
  { id: "canonical", file: "lib/canonical.js", rewrite: {} },
  { id: "secp256k1-recover", file: "lib/secp256k1-recover.js", rewrite: { "./keccak": "keccak" } },
  // The stack-free recipient-side revocation decision (T-51.4), split by T-66.1 into the PURE core
  // (revocation-core: validation/recovery/as-of decision; require()s only ./secp256k1-recover) and the
  // thin fs-backed reader wrapper (revocation: readRevocationsFromPath/loadAndApply; Node core fs/path
  // kept verbatim, both allowed-core).
  { id: "revocation-core", file: "lib/revocation-core.js", rewrite: { "./secp256k1-recover": "secp256k1-recover" } },
  { id: "revocation", file: "lib/revocation.js", rewrite: { "./revocation-core": "revocation-core" } },
  // The entrypoint, inlined LAST. Its relative requires resolve to the canonical ids above.
  {
    id: "verify-vh",
    file: "verify-vh.js",
    rewrite: {
      "./lib/merkle": "merkle",
      "./lib/canonical": "canonical",
      "./lib/secp256k1-recover": "secp256k1-recover",
      "./lib/revocation": "revocation",
    },
    entry: true,
  },
];

// Back-compat alias for the original single-target name (some tests reference builder.MODULES).
const MODULES = VERIFY_MODULES;

// --- TARGET 2: the SEAL bundle (seal-vh-standalone.js). The free PRODUCE half (T-36.2). It needs ONLY the
//     keccak shim + the merkle convention + the sealer CLI — NO secp256k1 (signing is the paid surface, so
//     the standalone sealer has no key path at all) and NO canonical (the seal is plain JSON.stringify). ---
const SEAL_MODULES = [
  ...SHARED_KECCAK_MODULES,
  // The independent merkle convention (the SAME the verifier re-derives), so a seal this builds re-derives
  // to the same root the verify bundle recomputes from the bytes.
  { id: "merkle", file: "lib/merkle.js", rewrite: { "./keccak": "keccak" } },
  // The sealer CLI, inlined LAST. Its only relative require ("./merkle") resolves to the canonical id above.
  {
    id: "seal-cli",
    file: "lib/seal-cli.js",
    rewrite: { "./merkle": "merkle" },
    entry: true,
  },
];

// The require() specifiers a bundled module is ALLOWED to keep verbatim — Node core modules the standalone
// genuinely uses. Anything else (a bare third-party name, an unlisted relative path) is a build error: the
// bundle must never silently carry an external dependency. `crypto` is Node core too (used by the embedded
// `--self-attest` boot code that hashes the bundle's own bytes) — all install-free.
// `os` is Node core too (the T-55.2 `demo` quickstart uses `os.tmpdir()` for its throwaway working dir) —
// all install-free.
const ALLOWED_CORE = new Set([
  "fs",
  "path",
  "crypto",
  "os",
  "node:fs",
  "node:path",
  "node:crypto",
  "node:os",
]);

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

// sha256 hex of a utf8 string (the canonical hash unit for both bundles and their inlined sources).
function sha256HexOf(text) {
  return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

// The provenance record for ONE inlined module. There are two honest kinds:
//   * a SOURCE module — inlined verbatim (with require()s rewritten) from a committed `verifier/<file>`. We
//     pin it by `sourceFile` + the sha256 of its NORMALIZED source (the exact bytes the build reads), so a
//     skeptic can `sha256` the file they audited and find that hash here. We also pin `inlinedSha256` — the
//     hash of the post-rewrite text actually placed in the bundle — so the rewrite step is itself attested.
//   * a SYNTHETIC module — the keccak "./keccak" shim, whose body is a constant in THIS builder (not a file).
//     It has no `sourceFile`; we pin `inlinedSha256` of its body and mark `synthetic: true` so the chain is
//     complete and honest (nothing inlined is left unaccounted for).
function moduleProvenance(m) {
  if (typeof m.body === "string") {
    return {
      id: m.id,
      synthetic: true,
      sourceFile: null,
      sourceSha256: null,
      inlinedSha256: sha256HexOf(m.body),
      note: "swapped body (keccak provider shim) — defined in build-standalone.js, not a source file",
    };
  }
  const src = readSource(m.file);
  const inlined = rewriteRequires(src, m.rewrite, m.id);
  return {
    id: m.id,
    synthetic: false,
    sourceFile: `verifier/${m.file}`,
    sourceSha256: sha256HexOf(src),
    inlinedSha256: sha256HexOf(inlined),
    entry: m.entry === true,
  };
}

// The provenance record for ONE target: the bundle's published basename/sidecar/size/sha256 + the ORDERED,
// individually-hashed source modules that compose it. This is the SINGLE source of truth shared verbatim by
// (a) the committed BUILD-PROVENANCE.json manifest and (b) the copy EMBEDDED inside the bundle itself
// (T-54.2 rework) — so the artifact a counterparty holds carries its OWN provenance, and `--check` proves the
// embedded copy equals the manifest's. `bundleSha256` is passed in (the build resolves the self-hash chicken-
// and-egg via a placeholder, see buildTarget) so this stays a pure function of its inputs -> deterministic.
function targetProvenance(target, bundleText, bundleSha256) {
  return {
    bundle: target.sha256Basename, // the bundle's basename (also the sidecar's pinned name)
    sidecar: path.basename(target.sha256Path),
    bundleBytes: Buffer.byteLength(bundleText, "utf8"),
    bundleSha256,
    sidecarLine: sha256SidecarFor(bundleText, target.sha256Basename).trim(),
    // The ORDERED inlined modules — the exact composition a skeptic re-hashes the source against.
    modules: target.modules.map(moduleProvenance),
  };
}

// Build the FULL build-provenance object (the committed BUILD-PROVENANCE.json's content) from source. It maps
// each target's published bundle hash -> the ordered modules (each pinned by its own source hash) that compose
// it, plus the bundle's own size + the sidecar line that publishes its hash. Pure function of source + the
// (constant) target descriptors -> deterministic. The JSON text is the canonical 2-space pretty-print + a
// trailing newline so the committed file is stable and human-readable (and `git diff`-able across releases).
function buildProvenanceObject() {
  const targets = {};
  // Iterate the SAME fixed target order the build/--check use, so the manifest's key order is deterministic.
  for (const key of ["verify", "seal"]) {
    const target = TARGETS[key];
    const bundleText = buildTarget(target);
    targets[target.name] = targetProvenance(target, bundleText, sha256HexOf(bundleText));
  }
  return {
    schema: PROVENANCE_SCHEMA,
    description:
      "Maps each published verifyhash standalone bundle's sha256 to the ordered, individually-hashed in-tree " +
      "source files it inlines. Reproduce + attest the whole chain offline with: node verifier/build-standalone.js --check",
    targets,
  };
}

// The canonical TEXT of BUILD-PROVENANCE.json: stable 2-space JSON + trailing newline. Deterministic.
function buildProvenanceText() {
  return JSON.stringify(buildProvenanceObject(), null, 2) + "\n";
}

// The fixed, version-free banner (NO timestamp -> deterministic) for each target. Each is a function of
// nothing — a constant header array — so the emitted bytes stay a pure function of the source files.
const VERIFY_HEADER = [
  "// verify-vh-standalone.js — the SINGLE-FILE, ZERO-DEPENDENCY, OFFLINE verifyhash verifier.",
  "//",
  "// SPDX-License-Identifier: Apache-2.0",
  "// Copyright 2026 verifyhash.com — https://verifyhash.com",
  "//",
  "// GENERATED by verifier/build-standalone.js from the in-tree verifier — DO NOT EDIT BY HAND.",
  "// Re-generate with: node verifier/build-standalone.js   (the build is deterministic; see that file.)",
  "//",
  "// HOW TO USE IT (no clone, no `npm install`, no node_modules, no package.json):",
  "//   1. Save THIS one file somewhere next to the sealed artifact you were handed.",
  "//   2. Run:  node verify-vh-standalone.js <artifact> [--vendor <0xaddr>] [--dir <d>] [--json]",
  "//   Exit codes: 0 ok / 3 rejected / 2 usage / 1 IO.   It is READ-ONLY and opens NO network.",
  "//",
  "// SELF-DESCRIBING (needs NO second file): this bundle carries its OWN build-provenance.",
  "//   node verify-vh-standalone.js --self-attest   # confirm THIS file's bytes are intact (0 ok / 1 modified)",
  "//   node verify-vh-standalone.js --provenance    # print the ordered source modules + sha256 it was built from",
  "//",
  "// It RE-DERIVES the keccak Merkle root from the bytes YOU hold and recovers the signer with a",
  "// pure-JS secp256k1 routine — it never trusts the artifact's own stored hashes, and it requires",
  "// NOTHING outside Node core. This is the in-tree verifier inlined verbatim, with keccak256 swapped",
  "// for a byte-identical pure-JS implementation (cross-checked against js-sha3 AND ethers).",
];

const SEAL_HEADER = [
  "// seal-vh-standalone.js — the SINGLE-FILE, ZERO-DEPENDENCY, OFFLINE verifyhash SEALER (free tier).",
  "//",
  "// SPDX-License-Identifier: Apache-2.0",
  "// Copyright 2026 verifyhash.com — https://verifyhash.com",
  "//",
  "// GENERATED by verifier/build-standalone.js from the in-tree sealer — DO NOT EDIT BY HAND.",
  "// Re-generate with: node verifier/build-standalone.js   (the build is deterministic; see that file.)",
  "//",
  "// HOW TO USE IT (no clone, no `npm install`, no node_modules, no package.json, no account):",
  "//   1. Save THIS one file somewhere.",
  "//   2. Run:  node seal-vh-standalone.js <folder> -o out.vhevidence.json",
  "//   3. Hand `out.vhevidence.json` (+ your folder) to anyone; they verify it with verify-vh-standalone.js",
  "//      — also zero-install. Exit codes: 0 sealed / 1 IO / 2 usage (incl. >25 files) / 3 seal-build error.",
  "//",
  "// SELF-DESCRIBING (needs NO second file): this bundle carries its OWN build-provenance.",
  "//   node seal-vh-standalone.js --self-attest   # confirm THIS file's bytes are intact (0 ok / 1 modified)",
  "//   node seal-vh-standalone.js --provenance    # print the ordered source modules + sha256 it was built from",
  "//",
  "// FREE TIER: an UNSIGNED seal of up to 25 files. Sealing MORE files (`evidence_unlimited`) or a SIGNED",
  "// wrap (`evidence_signed`) is the PAID surface via `vh evidence seal` — this file has NO --sign/--license",
  "// /--key flag and uses NO key. It is READ-ONLY apart from the -o file you name, and opens NO network. The",
  "// seal is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp. keccak256 is the byte-identical",
  "// pure-JS implementation the verifier uses, so a seal this builds is accepted verbatim by the verifier.",
];

// The tiny CommonJS shim every target embeds: a module registry + a memoizing __require. Byte-identical
// across targets.
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

// The two build targets — each fully describes ONE deterministic bundle (its module list + banner + the
// human noun used in the boot comment). Both go through the SAME buildTarget() so the seal bundle inherits
// every zero-dependency / determinism property the verify bundle has.
const TARGETS = {
  verify: { name: "verify", modules: VERIFY_MODULES, header: VERIFY_HEADER, cliNoun: "verifier", outPath: OUT_PATH, sha256Path: SHA256_PATH, sha256Basename: SHA256_BASENAME },
  seal: { name: "seal", modules: SEAL_MODULES, header: SEAL_HEADER, cliNoun: "sealer", outPath: SEAL_OUT_PATH, sha256Path: SEAL_SHA256_PATH, sha256Basename: SEAL_SHA256_BASENAME },
};

// The fixed 64-char sentinel the bundle's EMBEDDED self-hash is computed against (and re-blanked to at
// runtime). The bundle can't embed sha256(itself) directly — that is a fixed point (writing the hash changes
// the bytes it hashes). Instead the bundle's `selfSha256` is DEFINED as sha256(bundle text with the selfSha256
// field set to this sentinel). `--self-attest` re-blanks its own selfSha256 line back to the sentinel and
// re-hashes, so it can confirm its bytes are intact from the SINGLE file alone — no repo, no network, no
// sidecar. (The published `.sha256` sidecar still pins sha256(final file) so `sha256sum -c` is unchanged.)
const SELF_SHA256_SENTINEL = "0".repeat(64);

// The provenance object EMBEDDED in a bundle so the single shipped file carries — and can self-attest — its
// own provenance. It lists the SAME ordered source modules the manifest records for this target (so `--check`
// proves the embedded copy == the manifest), PLUS a `selfSha256`. The selfSha256 value is supplied by the
// caller: during pass 1 of buildTarget it is the SENTINEL (the hash is not yet known); the real hash is
// substituted in pass 2. Pure function of its inputs -> deterministic.
function embeddedProvenanceObject(target, selfSha256) {
  return {
    schema: PROVENANCE_SCHEMA,
    target: target.name,
    note:
      "This bundle's OWN provenance, embedded so the single file is self-describing. Run " +
      "`node " + target.sha256Basename + " --self-attest` to recompute selfSha256 from these very bytes, or " +
      "`--provenance` to print the ordered source modules + hashes it was built from. Cross-check against " +
      "verifier/dist/BUILD-PROVENANCE.json (the same data) with: node verifier/build-standalone.js --check",
    selfSha256, // sha256 of THESE bytes with the selfSha256 field blanked to SELF_SHA256_SENTINEL
    modules: target.modules.map(moduleProvenance),
  };
}

// The boot-time handler embedded in every bundle: intercepts `--provenance` / `--self-attest` BEFORE the
// inlined CLI sees them (it would reject unknown flags). `--provenance` prints the embedded provenance JSON.
// `--self-attest` re-reads THIS file, blanks its own selfSha256 back to the sentinel, re-hashes, and prints
// MATCH/MISMATCH — proving (from the single file, no network) that its bytes are exactly what the build
// produced. Returns an exit code to use, or null to fall through to the normal CLI. Uses only Node core.
const PROVENANCE_BOOT = [
  "function __maybeProvenance(argv) {",
  "  var wantProv = argv.indexOf('--provenance') !== -1;",
  "  var wantAttest = argv.indexOf('--self-attest') !== -1;",
  "  if (!wantProv && !wantAttest) return null;",
  "  if (wantProv) { process.stdout.write(JSON.stringify(__PROVENANCE, null, 2) + '\\n'); }",
  "  if (wantAttest) {",
  "    var fs = require('fs');",
  "    var crypto = require('crypto');",
  "    var selfText;",
  "    try { selfText = fs.readFileSync(__filename, 'utf8'); }",
  "    catch (e) { process.stderr.write('self-attest: cannot read this file: ' + e.message + '\\n'); return 1; }",
  "    // Re-blank our own selfSha256 line back to the sentinel, then hash — reproducing the build's pass-1 hash.",
  "    var blanked = selfText.replace(",
  "      '\"selfSha256\": \"' + __PROVENANCE.selfSha256 + '\"',",
  "      '\"selfSha256\": \"' + __SELF_SHA256_SENTINEL + '\"'",
  "    );",
  "    var got = crypto.createHash('sha256').update(Buffer.from(blanked, 'utf8')).digest('hex');",
  "    if (got === __PROVENANCE.selfSha256) {",
  "      process.stdout.write('[MATCH] self-attest: this file is intact (selfSha256 ' + got + ').\\n');",
  "      return 0;",
  "    }",
  "    process.stderr.write('[MISMATCH] self-attest: this file has been MODIFIED ' +",
  "      '(embedded selfSha256 ' + __PROVENANCE.selfSha256 + ' != recomputed ' + got + ').\\n');",
  "    return 1;",
  "  }",
  "  return 0;",
  "}",
];

// Build a target's bundle TEXT deterministically. Pure function of the committed source files + the target
// descriptor (a constant). Same target -> byte-identical output.
function buildTarget(target) {
  const parts = [];

  // --- header: shebang + a fixed, version-free banner (NO timestamp -> deterministic) ---
  parts.push("#!/usr/bin/env node");
  parts.push('"use strict";');
  parts.push("");
  parts.push(target.header.join("\n"));
  parts.push("");

  // --- the tiny CommonJS shim: a module registry + a memoizing __require. ---
  parts.push(COMMONJS_SHIM.join("\n"));
  parts.push("");

  let entryId = null;

  // --- inline each module as a factory in the fixed list order. ---
  for (const m of target.modules) {
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

  // --- EMBEDDED self-attesting provenance (T-54.2 rework): the bundle carries its OWN provenance so a
  //     counterparty handed JUST this one file can (a) `--provenance` to see the ordered source modules +
  //     hashes it was built from, and (b) `--self-attest` to confirm its own bytes are intact — from the
  //     single file, no repo / network / sidecar. The selfSha256 is computed below via the sentinel trick. ---
  parts.push(
    "// ---- embedded build-provenance (this file's own): see `--provenance` / `--self-attest` below. ----"
  );
  parts.push(`var __SELF_SHA256_SENTINEL = ${JSON.stringify(SELF_SHA256_SENTINEL)};`);
  // Placeholder object emitted with the sentinel; the real selfSha256 is substituted after the full text is
  // assembled and hashed (see the substitution at the end of this function).
  parts.push("var __PROVENANCE = __SELF_SHA256_PLACEHOLDER__;");
  parts.push(PROVENANCE_BOOT.join("\n"));
  parts.push("");

  // --- boot the entrypoint exactly as the inlined CLI does at the bottom of its own file. ---
  // The inlined entry module sets `module.exports = { ..., run }` and has a `require.main === module` CLI
  // shim that does NOT fire inside the bundle's factory (its `module` is the shim's, not Node's), so we
  // drive the CLI explicitly here: load the entry module and run it with process.argv, exiting on its code.
  // The embedded-provenance flags (`--provenance` / `--self-attest`) are handled FIRST so they never reach
  // the inlined CLI (which would reject them as unknown). All other argv passes through unchanged.
  parts.push(`// ---- boot: run the inlined ${target.cliNoun} CLI with this process's argv. ----`);
  parts.push(`var __entry = __require(${JSON.stringify(entryId)});`);
  parts.push("if (require.main === module) {");
  parts.push("  var __code = __maybeProvenance(process.argv.slice(2));");
  parts.push("  if (__code !== null) process.exit(__code);");
  parts.push("  process.exit(__entry.run(process.argv.slice(2)));");
  parts.push("}");
  parts.push("module.exports = __entry;");
  parts.push(""); // single trailing newline

  // Assemble with a sentinel selfSha256, hash, then substitute the real self-hash in. Two passes resolve the
  // self-reference: pass 1 computes sha256 over the bytes WITH the sentinel; pass 2 writes that hash in. The
  // runtime `--self-attest` re-blanks selfSha256 back to the sentinel before re-hashing, so it reproduces the
  // pass-1 hash exactly. Deterministic: the sentinel + module list are constants.
  const provWithSentinel = embeddedProvenanceObject(target, SELF_SHA256_SENTINEL);
  const textWithSentinel = parts
    .join("\n")
    .replace("__SELF_SHA256_PLACEHOLDER__", JSON.stringify(provWithSentinel, null, 2));
  const selfSha256 = sha256HexOf(textWithSentinel);
  // Substitute the real self-hash for the sentinel selfSha256 (a unique, fixed-length token swap).
  return textWithSentinel.replace(
    `"selfSha256": ${JSON.stringify(SELF_SHA256_SENTINEL)}`,
    `"selfSha256": ${JSON.stringify(selfSha256)}`
  );
}

// Compute the EXPECTED embedded provenance object for a target (with its REAL, two-pass-resolved selfSha256),
// straight from source. This is the canonical "what the bundle's __PROVENANCE should be" the `--check` path
// compares the committed bundle's embedded copy against. Pure function of source -> deterministic.
function expectedEmbeddedProvenance(target) {
  const provWithSentinel = embeddedProvenanceObject(target, SELF_SHA256_SENTINEL);
  const textWithSentinel = buildTarget(target).replace(
    new RegExp(`"selfSha256": "[0-9a-f]{64}"`),
    `"selfSha256": ${JSON.stringify(SELF_SHA256_SENTINEL)}`
  );
  const selfSha256 = sha256HexOf(textWithSentinel);
  return embeddedProvenanceObject(target, selfSha256);
  // (provWithSentinel is the same shape; we recompute selfSha256 honestly here so this helper is standalone.)
}

// Extract the embedded __PROVENANCE object from a built/committed bundle's TEXT, so `--check` can read what the
// SHIPPED file actually carries (not just what we recompute). The bundle assigns `var __PROVENANCE = { ... };`
// as a pretty-printed JSON literal; we slice that literal out and JSON.parse it. Returns the object, or null if
// the bundle has no embedded provenance (e.g. a stale/foreign file) so the caller reports a clean MISMATCH.
function extractEmbeddedProvenance(bundleText) {
  const marker = "var __PROVENANCE = ";
  const start = bundleText.indexOf(marker);
  if (start === -1) return null;
  // The literal runs from the first "{" after the marker to its matching "}" (brace-balanced; the JSON has no
  // braces inside string values that aren't balanced, but we scan with a tiny string-aware matcher to be safe).
  let i = bundleText.indexOf("{", start);
  if (i === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (; i < bundleText.length; i++) {
    const c = bundleText[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(bundleText.slice(bundleText.indexOf("{", start), end));
  } catch (_) {
    return null;
  }
}

// Build the VERIFY bundle TEXT (the original single-target API; UNCHANGED bytes). Pure function of source.
function buildBundle() {
  return buildTarget(TARGETS.verify);
}

// Build the SEAL bundle TEXT. Pure function of source.
function buildSealBundle() {
  return buildTarget(TARGETS.seal);
}

// Write ONE target's bundle + its `.sha256` sidecar to disk. Creates verifier/dist/ if absent. Returns the
// emitted text so callers can compare without a re-read.
function writeTarget(target) {
  const text = buildTarget(target);
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(target.outPath, text);
  // Re-emit the published checksum so the sidecar can never drift from the bundle it pins.
  fs.writeFileSync(target.sha256Path, sha256SidecarFor(text, target.sha256Basename));
  return text;
}

// Write the VERIFY bundle (original single-target API name). Returns its text.
function writeBundle() {
  return writeTarget(TARGETS.verify);
}

// Write the build-provenance manifest. Spans BOTH targets, so it is written once (not per-target). Returns
// the emitted text. Creates verifier/dist/ if absent.
function writeProvenance() {
  const text = buildProvenanceText();
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(PROVENANCE_PATH, text);
  return text;
}

// Write BOTH targets AND the provenance manifest. Returns { verify, seal, provenance } texts.
function writeAll() {
  const verify = writeTarget(TARGETS.verify);
  const seal = writeTarget(TARGETS.seal);
  const provenance = writeProvenance();
  return { verify, seal, provenance };
}

// ---------------------------------------------------------------------------
// REPRODUCE-AND-ATTEST (`--check`) — the third-party-runnable answer to "who verifies the verifier?"
//
// WHY THIS EXISTS (T-54.1 / T-54.2)
//   The free standalone verifier is the FUNNEL: a cold prospect's security team is asked to RUN
//   `verify-vh-standalone.js` and trust its verdict (P-8 step 3a/3b). The bundle ships beside a `.sha256`
//   sidecar — but that sidecar comes FROM THE SAME PLACE as the bundle, so on its own it proves only that the
//   file survived transport, not that it is the audited in-tree source. `--check` closes that gap WITHOUT a
//   network, WITHOUT trusting us: it RE-COMPILES each bundle from the in-tree source the skeptic can READ,
//   recomputes the published checksum from those bytes, and asserts the COMMITTED bundle + sidecar are
//   byte-for-byte what that source compiles to. A skeptic clones the repo (or is handed the verifier/ tree),
//   reads the deterministic builder + the sources, runs `node verifier/build-standalone.js --check`, and gets
//   a per-target MATCH/MISMATCH verdict — purely from local files, writing NOTHING under the source tree.
//
//   The COMMITTED build-provenance manifest (verifier/dist/BUILD-PROVENANCE.json) is what raises this from "the
//   bundle reproduces" to "the EXACT source files I audited, each pinned by its own sha256, are what the
//   published bundle was built from." `--check` reproduces the whole manifest from source AND cross-checks every
//   inlined source file against the hash the COMMITTED manifest pins for it — so a one-byte change to ANY single
//   source file (not just the bundle) is named precisely, by its own filename, against the published pin. That
//   is the table-stakes attestation a procurement/security reviewer needs: "the file I read is the file that
//   shipped." A reviewer can also pin/track each source hash across releases straight from this human-readable
//   JSON, with no tooling.
//
//   It is the strongest honest claim we can make: "don't trust our binary or our checksum — reproduce both, and
//   every source file that composes them, from the source you just read." It opens NO socket and (unlike the
//   default build) writes NOTHING.

// Reproduce ONE target in memory and compare against the committed on-disk bundle + sidecar. Pure read-only:
// it rebuilds the bundle text from source (no write), recomputes the sidecar text, then reads the two
// committed files and compares. Returns a structured result with a per-file (bundle, sidecar) verdict; the
// `ok` flag is true only when BOTH the bundle bytes AND the sidecar bytes reproduce exactly.
function checkTarget(target) {
  const rel = (p) => path.relative(VERIFIER_DIR, p);

  const result = {
    name: target.name,
    bundlePath: rel(target.outPath),
    sha256Path: rel(target.sha256Path),
    expectedHex: null,
    bundle: { ok: false, reason: "" },
    sidecar: { ok: false, reason: "" },
    sources: { ok: true, reason: "", offenders: [] },
    embedded: { ok: false, reason: "" },
  };

  // --- the SOURCE PRESENCE check runs FIRST, BEFORE recompiling — so a MISSING inlined source yields a clean
  //     MISMATCH verdict naming that file, never an uncaught build crash. Recording the offending SOURCE FILE
  //     by name turns "the bundle changed" into "THIS audited file is gone/changed", the actionable verdict a
  //     security reviewer wants. (Synthetic modules — the keccak shim — live in THIS builder, not a file, so
  //     they cannot be tampered independently and are reported as such, never as a missing source.) ---
  for (const m of target.modules) {
    if (typeof m.body === "string") continue; // synthetic body (keccak shim) — no on-disk source to attest
    const abs = path.join(VERIFIER_DIR, m.file);
    if (!fs.existsSync(abs)) {
      result.sources.ok = false;
      result.sources.offenders.push({ id: m.id, sourceFile: `verifier/${m.file}`, reason: "MISSING" });
    }
  }
  if (result.sources.offenders.length) {
    result.sources.reason =
      `inlined source(s) MISSING: ` + result.sources.offenders.map((o) => o.sourceFile).join(", ");
  } else {
    result.sources.reason = `all ${target.modules.filter((m) => typeof m.body !== "string").length} inlined source files present`;
  }

  // Recompute from source — exactly the bytes a fresh build would emit, but held in memory. Wrapped so that a
  // build failure (a missing/unreadable inlined source) becomes a clean MISMATCH verdict, not a stack trace:
  // a third-party reproduce tool must always report, never crash.
  let expectedBundle, expectedBundleBuf, expectedHex, expectedSidecar;
  try {
    expectedBundle = buildTarget(target); // utf8 text
    expectedBundleBuf = Buffer.from(expectedBundle, "utf8");
    expectedHex = crypto.createHash("sha256").update(expectedBundleBuf).digest("hex");
    expectedSidecar = sha256SidecarFor(expectedBundle, target.sha256Basename); // utf8 text
    result.expectedHex = expectedHex;
  } catch (e) {
    const why = `cannot recompile ${result.bundlePath} from source: ${e && e.message ? e.message : e}`;
    result.bundle.reason = why;
    result.sidecar.reason = why;
    result.ok = false;
    return result;
  }

  // --- the BUNDLE: recomputed bytes must equal the committed bytes EXACTLY. ---
  if (!fs.existsSync(target.outPath)) {
    result.bundle.reason = `committed bundle ${result.bundlePath} is MISSING`;
  } else {
    const committedBundle = fs.readFileSync(target.outPath); // raw bytes, as shipped
    if (committedBundle.equals(expectedBundleBuf)) {
      result.bundle.ok = true;
      result.bundle.reason = `recomputed bytes == committed bytes (sha256 ${expectedHex})`;
    } else {
      const committedHex = crypto.createHash("sha256").update(committedBundle).digest("hex");
      result.bundle.reason =
        `committed bundle does NOT reproduce from source ` +
        `(committed sha256 ${committedHex} != recomputed ${expectedHex})`;
    }
  }

  // --- the SIDECAR: recomputed published-hex line must equal the committed sidecar EXACTLY (and the hex it
  //     publishes must be the hex of the recomputed bundle, not whatever a tampered file claims). ---
  if (!fs.existsSync(target.sha256Path)) {
    result.sidecar.reason = `committed sidecar ${result.sha256Path} is MISSING`;
  } else {
    const committedSidecar = fs.readFileSync(target.sha256Path, "utf8");
    if (committedSidecar === expectedSidecar) {
      result.sidecar.ok = true;
      result.sidecar.reason = `published hex == recomputed hex (${expectedHex})`;
    } else {
      result.sidecar.reason =
        `committed sidecar does NOT match the recomputed published line ` +
        `(expected "${expectedSidecar.trim()}", got "${committedSidecar.trim()}")`;
    }
  }

  // --- the EMBEDDED provenance (T-54.2 rework): the committed bundle carries its OWN __PROVENANCE so a holder
  //     of just the single file can `--provenance` / `--self-attest` it. We assert that embedded copy is
  //     (a) extractable, (b) IDENTICAL to what the build expects (same ordered modules + selfSha256), so it can
  //     never silently drift from the source-of-truth it claims to mirror. (When the bundle bytes already
  //     reproduce, this is implied — but naming it as its own verdict makes the customer-facing self-attest
  //     surface an explicit, separately-attested guarantee.) ---
  const expectedEmbedded = expectedEmbeddedProvenance(target);
  if (!fs.existsSync(target.outPath)) {
    result.embedded.reason = `committed bundle ${result.bundlePath} is MISSING (no embedded provenance to read)`;
  } else {
    const committedText = fs.readFileSync(target.outPath, "utf8");
    const got = extractEmbeddedProvenance(committedText);
    if (!got) {
      result.embedded.reason = `committed bundle carries NO readable embedded __PROVENANCE`;
    } else if (JSON.stringify(got) !== JSON.stringify(expectedEmbedded)) {
      result.embedded.reason =
        `embedded __PROVENANCE does NOT match what the build expects ` +
        `(embedded selfSha256 ${got.selfSha256 || "?"} vs expected ${expectedEmbedded.selfSha256})`;
    } else {
      result.embedded.ok = true;
      result.embedded.reason = `embedded __PROVENANCE == expected (selfSha256 ${expectedEmbedded.selfSha256})`;
    }
  }

  result.ok = result.bundle.ok && result.sidecar.ok && result.sources.ok && result.embedded.ok;
  return result;
}

// Reproduce the build-provenance MANIFEST from source and compare against the committed BUILD-PROVENANCE.json,
// AND cross-check every per-module source hash IN that manifest against the file on disk — so a one-byte change
// to ANY inlined source is named precisely (by its `sourceFile`), not just surfaced as an opaque bundle drift.
// Pure read-only. Returns { ok, manifestPath, manifest: {ok, reason}, chain: {ok, reason, offenders} }.
function checkProvenance() {
  const rel = (p) => path.relative(VERIFIER_DIR, p);

  const result = {
    manifestPath: rel(PROVENANCE_PATH),
    manifest: { ok: false, reason: "" },
    chain: { ok: true, reason: "", offenders: [] },
  };

  // Recompute the manifest from source. Wrapped so a missing/unreadable source becomes a clean MISMATCH (the
  // chain check below still names the offending file from the COMMITTED manifest's pins) rather than a crash.
  let expectedText, expectedObj;
  try {
    expectedText = buildProvenanceText();
    expectedObj = buildProvenanceObject();
  } catch (e) {
    result.manifest.reason =
      `cannot recompute ${result.manifestPath} from source: ${e && e.message ? e.message : e}`;
    expectedText = null;
    expectedObj = { targets: {} };
  }

  // (a) the committed manifest must reproduce byte-for-byte from source (so it can never drift from the
  //     bundles it describes — a stale or hand-edited manifest is a MISMATCH).
  let committedObj = null;
  if (!fs.existsSync(PROVENANCE_PATH)) {
    result.manifest.reason = `committed manifest ${result.manifestPath} is MISSING`;
  } else {
    const committed = fs.readFileSync(PROVENANCE_PATH, "utf8");
    try {
      committedObj = JSON.parse(committed);
    } catch (_) {
      committedObj = null; // unparseable committed manifest -> the chain check below falls back to source
    }
    if (expectedText === null) {
      // The recompute already failed (a source is missing/unreadable); result.manifest.reason is set above.
      // Leave manifest.ok=false so the manifest line MISMATCHes — the chain below still names the offender.
    } else if (committed === expectedText) {
      result.manifest.ok = true;
      result.manifest.reason = `recomputed manifest == committed manifest (sha256 ${sha256HexOf(expectedText)})`;
    } else {
      result.manifest.reason =
        `committed manifest does NOT reproduce from source ` +
        `(committed sha256 ${sha256HexOf(committed)} != recomputed ${sha256HexOf(expectedText)})`;
    }
  }

  // (b) the CHAIN — the load-bearing attestation: every NON-synthetic source file must hash to exactly the
  //     sha256 the COMMITTED manifest PINS for it. This is precisely "the file I audited is the file the
  //     published bundle was built from" — pinned by an artifact that ships WITH the bundles, not recomputed
  //     on the fly. A one-byte change to ANY inlined source is named HERE by its own filename (with the pinned
  //     vs. on-disk hash), even though it ALSO perturbs the bundle hash. We pin against the COMMITTED manifest
  //     (not the freshly recomputed one) so the check is anchored to what was published; if the committed
  //     manifest is missing/unparseable we fall back to the recomputed pins so the chain is still attested.
  const pinSource = committedObj && committedObj.targets ? committedObj : expectedObj;
  // Gather the canonical {sourceFile -> pinned sha256} from whichever manifest we are pinning against, de-duped
  // across the verify+seal targets (which share modules like merkle / keccak-vendored source).
  const pinned = new Map();
  for (const target of Object.values(pinSource.targets)) {
    for (const mod of target.modules || []) {
      if (mod.synthetic || !mod.sourceFile) continue;
      if (!pinned.has(mod.sourceFile)) pinned.set(mod.sourceFile, { id: mod.id, sha256: mod.sourceSha256 });
    }
  }
  for (const [sourceFile, pin] of pinned) {
    const relFile = sourceFile.replace(/^verifier\//, "");
    const abs = path.join(VERIFIER_DIR, relFile);
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
  if (result.chain.offenders.length) {
    result.chain.reason =
      `source(s) do NOT match the manifest's pinned sha256: ` +
      result.chain.offenders.map((o) => `${o.sourceFile} (pinned ${String(o.expected).slice(0, 12)}…, got ${o.got === "MISSING" ? "MISSING" : o.got.slice(0, 12) + "…"})`).join("; ");
  } else {
    result.chain.reason = "every inlined source file hashes to its manifest-pinned sha256";
  }

  result.ok = result.manifest.ok && result.chain.ok;
  return result;
}

// Drive `--check` across BOTH targets. Writes a per-file MATCH/MISMATCH report to the supplied io (defaults
// to process stdout/stderr) and returns the process exit code: 0 iff EVERY bundle AND EVERY sidecar
// reproduced byte-for-byte from source, else 1. Read-only: it writes NOTHING under the source tree.
function runCheck(io) {
  const out = (io && io.write) || ((s) => process.stdout.write(s));
  const err = (io && io.writeErr) || ((s) => process.stderr.write(s));

  out("verifyhash standalone REPRODUCE-AND-ATTEST (--check): re-compiling each bundle from in-tree source,\n");
  out("recomputing its published checksum + build-provenance manifest, and comparing all against the committed\n");
  out("files. No network; no writes.\n\n");

  let allOk = true;
  for (const target of [TARGETS.verify, TARGETS.seal]) {
    const r = checkTarget(target);
    const bundleTag = r.bundle.ok ? "MATCH" : "MISMATCH";
    const sidecarTag = r.sidecar.ok ? "MATCH" : "MISMATCH";
    const sourcesTag = r.sources.ok ? "MATCH" : "MISMATCH";
    const embeddedTag = r.embedded.ok ? "MATCH" : "MISMATCH";
    out(`[${bundleTag}] bundle  ${r.bundlePath}: ${r.bundle.reason}\n`);
    out(`[${sidecarTag}] sidecar ${r.sha256Path}: ${r.sidecar.reason}\n`);
    out(`[${sourcesTag}] sources ${r.bundlePath}: ${r.sources.reason}\n`);
    // The bundle's OWN embedded provenance / self-attest record — the customer-facing trust surface that
    // travels WITH the single file (see `node <bundle> --self-attest` / `--provenance`).
    out(`[${embeddedTag}] embedded ${r.bundlePath}: ${r.embedded.reason}\n`);
    if (!r.ok) allOk = false;
  }

  // The build-provenance manifest + the source->hash chain it pins. This is what lets trust root in READING
  // SOURCE: a corrupted inlined source file is named HERE by its own filename, with the manifest-pinned hash.
  const prov = checkProvenance();
  const manifestTag = prov.manifest.ok ? "MATCH" : "MISMATCH";
  const chainTag = prov.chain.ok ? "MATCH" : "MISMATCH";
  out(`[${manifestTag}] manifest ${prov.manifestPath}: ${prov.manifest.reason}\n`);
  out(`[${chainTag}] sources->manifest: ${prov.chain.reason}\n`);
  if (!prov.ok) allOk = false;

  if (allOk) {
    out("\nALL MATCH — every committed bundle, sidecar AND the build-provenance manifest reproduces byte-for-byte\n");
    out("from the in-tree source, and every inlined source file hashes to its manifest-pinned sha256.\n");
    return 0;
  }
  err("\nMISMATCH — at least one committed bundle/sidecar does NOT reproduce from source (see above). Re-run\n");
  err("`node verifier/build-standalone.js` (no flag) to regenerate, or distrust this checkout.\n");
  return 1;
}

if (require.main === module) {
  // `--check` is the read-only REPRODUCE-AND-ATTEST mode: it writes NOTHING, only compares. The default
  // (no-flag) invocation is the deterministic build that (re-)emits the four files.
  if (process.argv.slice(2).includes("--check")) {
    process.exit(runCheck());
  }
  for (const target of [TARGETS.verify, TARGETS.seal]) {
    const text = writeTarget(target);
    process.stdout.write(
      `wrote ${path.relative(VERIFIER_DIR, target.outPath)} (${Buffer.byteLength(text)} bytes)\n`
    );
    process.stdout.write(
      `wrote ${path.relative(VERIFIER_DIR, target.sha256Path)} (${sha256SidecarFor(text, target.sha256Basename).trim()})\n`
    );
  }
  // The build-provenance manifest (spans both targets) — written once, after both bundles.
  const provText = writeProvenance();
  process.stdout.write(
    `wrote ${path.relative(VERIFIER_DIR, PROVENANCE_PATH)} (${Buffer.byteLength(provText)} bytes)\n`
  );
}

module.exports = {
  buildBundle,
  buildSealBundle,
  buildTarget,
  buildProvenanceObject,
  buildProvenanceText,
  moduleProvenance,
  sha256HexOf,
  writeBundle,
  writeAll,
  writeTarget,
  writeProvenance,
  checkTarget,
  checkProvenance,
  runCheck,
  sha256Sidecar,
  sha256SidecarFor,
  OUT_PATH,
  SHA256_PATH,
  SHA256_BASENAME,
  SEAL_OUT_PATH,
  SEAL_SHA256_PATH,
  SEAL_SHA256_BASENAME,
  PROVENANCE_PATH,
  PROVENANCE_BASENAME,
  PROVENANCE_SCHEMA,
  DIST_DIR,
  VERIFIER_DIR,
  MODULES,
  VERIFY_MODULES,
  SEAL_MODULES,
  TARGETS,
};
