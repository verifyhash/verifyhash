"use strict";

// test/verifier.browser-core.test.js — T-66.1: the verifier gains an IN-MEMORY file-source seam
// (`verifyArtifactFromBytes`) with ZERO behavior change.
//
// WHAT THIS SUITE PROVES (the four acceptance criteria):
//   (1) DISK == BYTES: the SAME packet driven through the disk path (`verifyArtifact`) and the bytes path
//       (`verifyArtifactFromBytes`) yields DEEP-EQUAL structured results + identical exit codes for:
//       ACCEPT (unsigned evidence seal), ACCEPT (signed seal + correct `--vendor` pin), REJECT
//       content-mismatch naming the exact file, REJECT missing-file, REJECT extra-file (a file the
//       doctored seal no longer commits to -> root_mismatch: the sealed root binds the FULL set), REJECT
//       wrong-vendor, REJECT tampered-signature, and a revocations-list REJECT (key_revoked_as_of) — plus
//       a path-escape REJECT and a later-revoked ACCEPT for good measure.
//   (2) STATIC PURITY (grep/module-scope discipline, the test/trustledger.browser-core.test.js style):
//       the whole pure engine sits between two unique BEGIN/END markers in verifier/verify-vh.js; the
//       comment- and string-stripped block contains NO `require(` and NO fs/os/path/process/child_process
//       token; its `revocation.*` member uses are ONLY the pure decision functions, whose implementations
//       PROVABLY live in verifier/lib/revocation-core.js (function identity); and the require graph walked
//       from the engine's pure dependency modules (merkle/canonical/secp256k1-recover/revocation-core)
//       reaches NO builtin at all (js-sha3, from keccak.js, is the single allowed leaf dependency) and
//       never reaches the fs-backed lib/revocation.js wrapper.
//   (3) HOSTILE INPUTS are NAMED-rejected, never thrown: non-JSON artifact text, oversized / absolute /
//       `..` map keys, non-bytes map values, malformed vendor/asOf, non-JSON revocations input — each
//       returns a structured { error: { name, code, message } } naming the defect; absolute/`..` relPaths
//       INSIDE the artifact produce the same named path_escape REJECT verdict the disk path produces.
//   (4) DYNAMIC PROOF of (2): a child Node process returns a POISON PROXY for every fs/os/path/
//       child_process require (any property USE throws) and still loads verify-vh.js and drives the whole
//       bytes-path verdict matrix to the right answers — while the DISK path in the same child trips the
//       poison, proving the guard is not a no-op.
//
// HONESTY: no existing test expectation is edited — this suite only ADDS pins. The disk path's behavior
// is byte-identical (its own suites pass unedited); the bytes path is proven equal to it, not vice versa.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { Wallet } = require("ethers");

// The verifier under test (the disk entrypoint, the bytes entrypoint, and the shipped demo fixture —
// a REAL signed evidence packet, reused here so the scenarios exercise genuine producer-shaped bytes).
const verifyvh = require("../verifier/verify-vh");
// The REAL producer revocation core — the oracle-side minting path for the revocations scenario.
const coreRevocation = require("../cli/core/revocation");
// The verifier's revocation wrapper + its pure core, for the module-scope-discipline identity checks.
const vrev = require("../verifier/lib/revocation");
const vrevCore = require("../verifier/lib/revocation-core");

const REPO = path.join(__dirname, "..");
const VERIFIER_DIR = path.join(REPO, "verifier");
const ENTRY = path.join(VERIFIER_DIR, "verify-vh.js");

// The engine markers verify-vh.js pins (also the vm/browser extraction seam for EPIC-66).
const BEGIN_MARKER =
  "// ============================ BEGIN VERIFY-VH PURE ENGINE (T-66.1) ============================";
const END_MARKER =
  "// ============================= END VERIFY-VH PURE ENGINE (T-66.1) =============================";

// The fixed TEST-ONLY key behind the shipped demo packet's signer (standard hardhat account #1 —
// published, never a real key / real funds). Needed ONLY to mint a genuine self-signed revocation for
// the demo signer; asserted below to actually control verifyvh.DEMO_SIGNER.
const HARDHAT1_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// Deterministic as-of pivot for the revocation scenarios.
const AS_OF = "2026-06-15T00:00:00.000Z";
const REVOKED_BEFORE = "2026-06-10T00:00:00.000Z"; // < AS_OF -> applies -> REVOKED
const REVOKED_AFTER = "2026-06-20T00:00:00.000Z"; // > AS_OF -> later -> ACCEPTED + note

const SIGNED_TEXT = JSON.stringify(verifyvh.DEMO_CONTAINER);
const UNSIGNED_TEXT = verifyvh.DEMO_CONTAINER.attestation; // the exact embedded UNSIGNED evidence seal
const ZERO32 = "0x" + "00".repeat(32);

// ---------------------------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------------------------

// String contents -> the bytes map the in-memory path takes.
function toBytesMap(files) {
  const m = {};
  for (const [rel, content] of Object.entries(files)) m[rel] = Buffer.from(content, "utf8");
  return m;
}

// Mint a GENUINE signed revocation (the demo key revokes ITSELF) via the REAL producer core.
async function mintDemoRevocationText(revokedAt) {
  const wallet = new Wallet(HARDHAT1_KEY);
  expect(wallet.address.toLowerCase(), "hardhat #1 controls the demo signer").to.equal(
    verifyvh.DEMO_SIGNER
  );
  const container = await coreRevocation.buildRevocation(
    { vendorAddress: wallet.address, reason: "compromised", revokedAt },
    wallet
  );
  return coreRevocation.serializeSignedRevocation(container);
}

// Flip one hex nibble mid-signature -> a tampered signature that no longer recovers to the claimed signer.
function tamperSignature(containerText) {
  const c = JSON.parse(containerText);
  const sig = c.signature.signature;
  const i = 20; // inside r — well past the 0x prefix
  const flipped = sig[i] === "a" ? "b" : "a";
  c.signature = { ...c.signature, signature: sig.slice(0, i) + flipped + sig.slice(i + 1) };
  return JSON.stringify(c);
}

// A seal DOCTORED to drop one committed file entry while keeping the original root — the "extra file"
// shape: the bytes on disk / in the map include a file the (tampered) seal no longer names, and the kept
// root can no longer be re-derived from the remaining set.
function doctoredExtraFileText() {
  const seal = JSON.parse(UNSIGNED_TEXT);
  seal.files = seal.files.filter((f) => f.relPath !== "weights.txt");
  return JSON.stringify(seal);
}

// A hostile seal whose relPaths probe OUTSIDE the packet (absolute + `..` traversal).
function escapeSealText() {
  return JSON.stringify({
    kind: "vh.evidence-seal",
    files: [
      { relPath: "/etc/hostname", contentHash: ZERO32, leaf: ZERO32 },
      { relPath: "../escape.txt", contentHash: ZERO32, leaf: ZERO32 },
    ],
    root: ZERO32,
  });
}

describe("verifier in-memory file-source seam (T-66.1)", function () {
  this.timeout(120000);

  let tmpDirs;
  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-bytes-seam-"));
    tmpDirs.push(d);
    return d;
  }

  // Materialize a scenario on disk: the artifact text + its sibling files.
  function writeScenario(artifactText, files) {
    const dir = mkTmp();
    const packetPath = path.join(dir, "packet.vhevidence.json");
    fs.writeFileSync(packetPath, artifactText);
    for (const [rel, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, rel), content);
    }
    return { dir, packetPath };
  }

  // THE EQUIVALENCE ORACLE: run the SAME scenario through the disk path and the bytes path and assert
  // the structured results are DEEP-EQUAL (and the exit codes identical). Returns the shared verdict.
  function assertPathsAgree({ artifactText, files, vendor, revocationsText, asOf }) {
    const { dir, packetPath } = writeScenario(artifactText, files);
    const diskOpts = { artifact: packetPath, dir, vendor };
    if (revocationsText !== undefined) {
      const revDir = mkTmp();
      const revFile = path.join(revDir, "key.vhrevocation.json");
      fs.writeFileSync(revFile, revocationsText);
      diskOpts.revocations = revFile;
      diskOpts.asOf = asOf;
    }
    const disk = verifyvh.verifyArtifact(diskOpts);

    const bytes = verifyvh.verifyArtifactFromBytes({
      artifactText,
      files: toBytesMap(files),
      vendor,
      revocationsText,
      asOf,
      artifactName: packetPath, // same label so the two results are FULLY deep-equal, artifact field included
    });

    expect(bytes.error, "bytes path returned a verdict, not an input error").to.equal(null);
    expect(bytes.code, "exit codes agree").to.equal(disk.code);
    expect(bytes.result, "structured results are DEEP-EQUAL").to.deep.equal(disk.result);
    expect(bytes.ok).to.equal(disk.result.accepted);
    return { result: disk.result, code: disk.code };
  }

  // ============================================================================================
  // (1) DISK == BYTES across the whole verdict matrix.
  // ============================================================================================
  describe("(1) the same packet through disk and bytes paths is DEEP-EQUAL", function () {
    it("ACCEPT: an UNSIGNED evidence seal over its exact bytes (exit 0)", function () {
      const { result, code } = assertPathsAgree({
        artifactText: UNSIGNED_TEXT,
        files: verifyvh.DEMO_FILES,
      });
      expect(code).to.equal(verifyvh.EXIT.OK);
      expect(result.verdict).to.equal("OK");
      expect(result.reason).to.equal("OK");
      expect(result.signed).to.equal(false);
      expect(result.rootMatches).to.equal(true);
      expect(result.counts.matched).to.equal(2);
    });

    it("ACCEPT: the SIGNED seal with the correct --vendor pin (signer genuinely recovered; exit 0)", function () {
      const { result, code } = assertPathsAgree({
        artifactText: SIGNED_TEXT,
        files: verifyvh.DEMO_FILES,
        vendor: verifyvh.DEMO_SIGNER,
      });
      expect(code).to.equal(verifyvh.EXIT.OK);
      expect(result.verdict).to.equal("OK");
      expect(result.signed).to.equal(true);
      expect(result.signatureOk).to.equal(true);
      expect(result.recoveredSigner).to.equal(verifyvh.DEMO_SIGNER);
      expect(result.signerMatchesVendor).to.equal(true);
    });

    it("REJECT content-mismatch: one tampered byte is caught and the EXACT file is named (exit 3)", function () {
      const tampered = {
        ...verifyvh.DEMO_FILES,
        "model-card.md": verifyvh.DEMO_FILES["model-card.md"] + "X",
      };
      const { result, code } = assertPathsAgree({
        artifactText: SIGNED_TEXT,
        files: tampered,
        vendor: verifyvh.DEMO_SIGNER,
      });
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(result.reason).to.equal("CHANGED");
      expect(result.changed).to.have.length(1);
      expect(result.changed[0].relPath).to.equal("model-card.md");
      expect(result.counts.matched).to.equal(1); // weights.txt still matches
    });

    it("REJECT missing-file: a referenced file absent from the dir / the map (exit 3)", function () {
      const partial = { "model-card.md": verifyvh.DEMO_FILES["model-card.md"] };
      const { result, code } = assertPathsAgree({
        artifactText: SIGNED_TEXT,
        files: partial,
        vendor: verifyvh.DEMO_SIGNER,
      });
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(result.reason).to.equal("MISSING");
      expect(result.missing).to.deep.equal([{ relPath: "weights.txt" }]);
    });

    it("REJECT extra-file: a present file the (doctored) seal no longer commits to -> root_mismatch (exit 3)", function () {
      // The standalone verifier reads exactly what the artifact references — an extra file is caught
      // STRUCTURALLY: the sealed root commits to the FULL file set, so a seal edited to omit the file
      // cannot keep its root (and a SIGNED seal edited that way breaks its signature outright).
      const { result, code } = assertPathsAgree({
        artifactText: doctoredExtraFileText(),
        files: verifyvh.DEMO_FILES, // both files present; weights.txt is now the uncommitted EXTRA
      });
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(result.reason).to.equal("root_mismatch");
      expect(result.rootMatches).to.equal(false);
      expect(result.recomputedRoot).to.not.equal(result.sealedRoot);
    });

    it("REJECT wrong-vendor: a sound signature pinned to the WRONG address -> wrong_issuer (exit 3)", function () {
      const wrongVendor = "0x" + "11".repeat(20);
      const { result, code } = assertPathsAgree({
        artifactText: SIGNED_TEXT,
        files: verifyvh.DEMO_FILES,
        vendor: wrongVendor,
      });
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(result.reason).to.equal("wrong_issuer");
      expect(result.signatureOk).to.equal(true);
      expect(result.signerMatchesVendor).to.equal(false);
      expect(result.pinnedVendor).to.equal(wrongVendor);
    });

    it("REJECT tampered-signature: one flipped nibble -> bad_signature (exit 3)", function () {
      const { result, code } = assertPathsAgree({
        artifactText: tamperSignature(SIGNED_TEXT),
        files: verifyvh.DEMO_FILES,
        vendor: verifyvh.DEMO_SIGNER,
      });
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(result.reason).to.equal("bad_signature");
      expect(result.signatureOk).to.equal(false);
    });

    it("REJECT via revocations list: a genuine revoked-BEFORE-as-of key downgrades BOTH paths to REVOKED (exit 3)", async function () {
      const revocationsText = await mintDemoRevocationText(REVOKED_BEFORE);
      const { result, code } = assertPathsAgree({
        artifactText: SIGNED_TEXT,
        files: verifyvh.DEMO_FILES,
        vendor: verifyvh.DEMO_SIGNER,
        revocationsText,
        asOf: AS_OF,
      });
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(result.verdict).to.equal("REVOKED");
      expect(result.reason).to.equal("key_revoked_as_of");
      expect(result.trustAsOf.governing.vendorAddress).to.equal(verifyvh.DEMO_SIGNER);
      expect(result.trustAsOf.governing.revokedAt).to.equal(REVOKED_BEFORE);
      expect(result.trustAsOfDefaulted).to.equal(false);
    });

    it("ACCEPT with a LATER-dated revocation: both paths keep the informational note (exit 0)", async function () {
      const revocationsText = await mintDemoRevocationText(REVOKED_AFTER);
      const { result, code } = assertPathsAgree({
        artifactText: SIGNED_TEXT,
        files: verifyvh.DEMO_FILES,
        vendor: verifyvh.DEMO_SIGNER,
        revocationsText,
        asOf: AS_OF,
      });
      expect(code).to.equal(verifyvh.EXIT.OK);
      expect(result.verdict).to.equal("OK");
      expect(result.trustAsOf.laterRevoked.revokedAt).to.equal(REVOKED_AFTER);
    });

    it("REJECT path_escape: absolute + `..` relPaths in the ARTIFACT are named-rejected on BOTH paths (exit 3, never thrown)", function () {
      const { result, code } = assertPathsAgree({
        artifactText: escapeSealText(),
        files: verifyvh.DEMO_FILES,
      });
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(result.reason).to.equal("path_escape");
      expect(result.escaped).to.deep.equal([{ relPath: "/etc/hostname" }, { relPath: "../escape.txt" }]);
      expect(result.counts.escaped).to.equal(2);
    });
  });

  // ============================================================================================
  // (2) STATIC PURITY: no fs/os/path/process/child_process reachable from the bytes entry.
  // ============================================================================================
  describe("(2) static purity guard over the marked engine block + its pure module graph", function () {
    const src = fs.readFileSync(ENTRY, "utf8");

    function extractEngineBlock() {
      const begin = src.indexOf(BEGIN_MARKER);
      const end = src.indexOf(END_MARKER);
      expect(begin, "BEGIN engine marker present").to.be.greaterThan(-1);
      expect(end, "END engine marker present").to.be.greaterThan(begin);
      expect(src.indexOf(BEGIN_MARKER, begin + 1), "BEGIN marker unique").to.equal(-1);
      expect(src.indexOf(END_MARKER, end + 1), "END marker unique").to.equal(-1);
      return src.slice(begin + BEGIN_MARKER.length, end);
    }

    function stripComments(text) {
      return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    }
    function stripStrings(text) {
      return text
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    }

    const FORBIDDEN_TOKEN = /\b(fs|os|path|process|child_process)\b/;

    it("the engine block defines the whole bytes path (entry + shared cores + map source)", function () {
      const block = extractEngineBlock();
      for (const needle of [
        "function verifyArtifactFromBytes",
        "function verifyParsedArtifact",
        "function classifyFilesWith",
        "function verifyEvidenceSealWith",
        "function verifyTrustSealWith",
        "function verifyDatasetAttestation",
        "function verifyProofBundle",
        "function decodeSigned",
        "function makeMapReadEntry",
        "function validateFilesMap",
      ]) {
        expect(block, `engine block contains \`${needle}\``).to.include(needle);
      }
      // The impure halves live OUTSIDE the block (the disk source, the demo, the CLI, the fs reader) —
      // the engine CODE (comments stripped; prose may name them as non-examples) never references them.
      const code = stripComments(block);
      for (const outside of ["makeDiskReadEntry", "readRevocationsFromPath", "loadAndApply", "mkdtempSync"]) {
        expect(code, `engine block must NOT reference ${outside}`).to.not.include(outside);
      }
      expect(typeof verifyvh.verifyArtifactFromBytes).to.equal("function");
    });

    it("the comment- and string-stripped engine block has NO require( and NO fs/os/path/process/child_process token", function () {
      const block = extractEngineBlock();
      const noComments = stripComments(block);
      // Template-literal INTERPOLATIONS are real code — check them BEFORE strings are blanked, so a
      // hypothetical `${...}` smuggling an impure call cannot hide inside a stripped literal.
      for (const m of noComments.matchAll(/\$\{([^}]*)\}/g)) {
        expect(m[1], `template interpolation is pure: \${${m[1]}}`).to.not.match(FORBIDDEN_TOKEN);
        expect(m[1], "no require() inside an interpolation").to.not.match(/\brequire\s*\(/);
      }
      const code = stripStrings(noComments);
      expect(code, "engine block never require()s anything").to.not.match(/\brequire\s*\(/);
      expect(code, "engine block never names an impure builtin").to.not.match(FORBIDDEN_TOKEN);
    });

    it("the engine's `revocation.*` uses are ONLY the pure decision surface (never the fs reader)", function () {
      const block = stripComments(extractEngineBlock());
      const used = new Set();
      for (const m of block.matchAll(/\brevocation\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) used.add(m[1]);
      const allowed = ["ISO_INSTANT_RE", "applyToVerifyResult", "normalizeRevocationsInput", "resolveAsOf"];
      expect([...used].sort()).to.deep.equal(
        [...used].filter((u) => allowed.includes(u)).sort(),
        `engine may only touch the pure revocation surface, got: ${[...used].join(", ")}`
      );
      // The graph is real: the revocation fold is actually wired through those functions.
      expect(used.has("applyToVerifyResult"), "engine applies the revocation decision").to.equal(true);
      expect(used.has("readRevocationsFromPath")).to.equal(false);
      expect(used.has("loadAndApply")).to.equal(false);
    });

    it("the pure revocation functions the engine calls are IMPLEMENTED in lib/revocation-core.js (function identity)", function () {
      // The wrapper (lib/revocation.js, which binds fs/path for its file reader) re-exports the very same
      // function OBJECTS the pure core defines — so no function the bytes path calls lives in a module
      // whose scope the engine depends on for behavior.
      for (const name of [
        "resolveAsOf",
        "normalizeRevocationsInput",
        "applyToVerifyResult",
        "evaluateTrustAsOf",
        "verifyRevocation",
        "validateSignedRevocation",
        "classifyRevocation",
        "serializeRevocation",
        "parseCanonicalInstant",
        "renderTrustAsOf",
      ]) {
        expect(vrev[name], `revocation.${name} === revocation-core.${name}`).to.equal(vrevCore[name]);
      }
      expect(vrev.ISO_INSTANT_RE).to.equal(vrevCore.ISO_INSTANT_RE);
      // And the wrapper's ONLY additions are the two fs-backed conveniences.
      const extras = Object.keys(vrev).filter((k) => !(k in vrevCore));
      expect(extras.sort()).to.deep.equal(["loadAndApply", "readRevocationsFromPath"]);
    });

    // ------------------------------------------------------------------------------------------
    // Require-graph walk (the trustledger.browser-core.test.js scanner, applied to the engine's pure
    // dependency modules): NOTHING on this graph requires a builtin — not even fs/path behind a lazy
    // loader. js-sha3 (from keccak.js) is the single allowed bare leaf dependency.
    // ------------------------------------------------------------------------------------------
    function requireSpecifiers(file) {
      const text = stripComments(fs.readFileSync(file, "utf8"));
      const specs = [];
      const re = /\brequire\s*\(/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const rest = text.slice(m.index + m[0].length);
        const lit = rest.match(/^\s*["']([^"']+)["']\s*\)/);
        // A require whose argument is NOT a string literal would be a hole in this static guarantee.
        expect(lit, `${path.relative(REPO, file)} has a non-literal require()`).to.not.equal(null);
        specs.push(lit[1]);
      }
      return specs;
    }
    function resolveRelative(fromFile, spec) {
      const base = path.resolve(path.dirname(fromFile), spec);
      for (const cand of [base, `${base}.js`, path.join(base, "index.js")]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
      }
      throw new Error(`cannot resolve ${spec} from ${fromFile}`);
    }
    function walkRequireGraph(entries) {
      const files = new Set();
      const bare = new Map();
      const queue = [...entries];
      while (queue.length > 0) {
        const file = queue.pop();
        if (files.has(file)) continue;
        files.add(file);
        for (const spec of requireSpecifiers(file)) {
          if (spec.startsWith(".")) {
            queue.push(resolveRelative(file, spec));
          } else {
            if (!bare.has(file)) bare.set(file, []);
            bare.get(file).push(spec.replace(/^node:/, ""));
          }
        }
      }
      return { files, bare };
    }

    const PURE_ENTRIES = [
      path.join(VERIFIER_DIR, "lib", "merkle.js"),
      path.join(VERIFIER_DIR, "lib", "canonical.js"),
      path.join(VERIFIER_DIR, "lib", "secp256k1-recover.js"),
      path.join(VERIFIER_DIR, "lib", "revocation-core.js"),
    ];
    const KECCAK = path.join(VERIFIER_DIR, "lib", "keccak.js");
    const FS_WRAPPER = path.join(VERIFIER_DIR, "lib", "revocation.js");

    it("the engine's pure dependency graph reaches NO builtin (js-sha3 from keccak.js is the sole bare leaf)", function () {
      const { files, bare } = walkRequireGraph(PURE_ENTRIES);
      for (const entry of PURE_ENTRIES) expect(files.has(entry), entry).to.equal(true);
      expect(files.has(KECCAK), "keccak reached via merkle/secp256k1").to.equal(true);
      expect(files.has(FS_WRAPPER), "the fs-backed revocation wrapper is NOT on the pure graph").to.equal(false);
      for (const [file, specs] of bare) {
        if (file === KECCAK) {
          expect(specs).to.deep.equal(["js-sha3"]);
          continue;
        }
        expect(
          specs,
          `${path.relative(REPO, file)} must not require bare/builtin modules (got: ${specs.join(", ")})`
        ).to.deep.equal([]);
      }
    });

    it("verify-vh.js module scope binds ONLY the pinned require set (no new specifier smuggled in for the seam)", function () {
      const specs = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      expect([...new Set(specs)].sort()).to.deep.equal(
        // T-70.4 adds Node-core `crypto` (sha256 for the anchored-receipt attestation digest legs) —
        // bound at module scope OUTSIDE the engine block; the block-level purity checks above still hold.
        ["./lib/canonical", "./lib/merkle", "./lib/revocation", "./lib/secp256k1-recover", "crypto", "fs", "os", "path"].sort()
      );
    });
  });

  // ============================================================================================
  // (3) HOSTILE INPUTS are NAMED-rejected, never thrown.
  // ============================================================================================
  describe("(3) hostile inputs: named structured rejections, never throws", function () {
    const goodFiles = () => toBytesMap(verifyvh.DEMO_FILES);

    function expectNamedError(params, code, name, msgRe) {
      let out;
      expect(() => {
        out = verifyvh.verifyArtifactFromBytes(params);
      }, "verifyArtifactFromBytes never throws").to.not.throw();
      expect(out.ok).to.equal(false);
      expect(out.result).to.equal(null);
      expect(out.code, `exit-contract code (${out.error && out.error.message})`).to.equal(code);
      expect(out.error.name).to.equal(name);
      expect(out.error.code).to.equal(code);
      expect(out.error.message, "the defect is NAMED").to.match(msgRe);
      return out;
    }

    it("non-JSON artifact text -> named IO rejection", function () {
      expectNamedError(
        { artifactText: "this is not json {", files: goodFiles() },
        verifyvh.EXIT.IO,
        "IOError",
        /is not valid JSON/
      );
    });

    it("JSON-but-not-an-object artifact text -> named IO rejection", function () {
      expectNamedError({ artifactText: "[1,2,3]", files: goodFiles() }, verifyvh.EXIT.IO, "IOError", /must be a JSON object/);
      expectNamedError({ artifactText: "null", files: goodFiles() }, verifyvh.EXIT.IO, "IOError", /must be a JSON object/);
    });

    it("unrecognized artifact kind -> named usage rejection", function () {
      expectNamedError(
        { artifactText: JSON.stringify({ kind: "not-a-vh-artifact" }), files: goodFiles() },
        verifyvh.EXIT.USAGE,
        "UsageError",
        /unrecognized artifact kind/
      );
    });

    it("OVERSIZED map key -> named usage rejection (limit stated; key excerpted, not echoed whole)", function () {
      const files = goodFiles();
      files["k".repeat(verifyvh.MAX_RELPATH_CHARS + 1)] = Buffer.from("x");
      const out = expectNamedError(
        { artifactText: UNSIGNED_TEXT, files },
        verifyvh.EXIT.USAGE,
        "UsageError",
        /oversized relPath/
      );
      expect(out.error.message).to.include(String(verifyvh.MAX_RELPATH_CHARS));
      expect(out.error.message.length, "hostile key not echoed in full").to.be.lessThan(400);
    });

    it("ABSOLUTE map key -> named usage rejection", function () {
      const files = goodFiles();
      files["/etc/passwd"] = Buffer.from("x");
      expectNamedError(
        { artifactText: UNSIGNED_TEXT, files },
        verifyvh.EXIT.USAGE,
        "UsageError",
        /not a confined relative path.*\/etc\/passwd/
      );
    });

    it("`..` traversal map key -> named usage rejection", function () {
      const files = goodFiles();
      files["../up/one.txt"] = Buffer.from("x");
      expectNamedError(
        { artifactText: UNSIGNED_TEXT, files },
        verifyvh.EXIT.USAGE,
        "UsageError",
        /not a confined relative path/
      );
    });

    it("non-bytes map value -> named usage rejection", function () {
      const files = goodFiles();
      files["weights.txt"] = "0.10 0.20 0.30\n"; // a string, not bytes
      expectNamedError(
        { artifactText: UNSIGNED_TEXT, files },
        verifyvh.EXIT.USAGE,
        "UsageError",
        /must be a Uint8Array\/Buffer/
      );
    });

    it("files not a plain object map -> named usage rejection", function () {
      for (const bad of [null, undefined, [], "files", 7]) {
        expectNamedError(
          { artifactText: UNSIGNED_TEXT, files: bad },
          verifyvh.EXIT.USAGE,
          "UsageError",
          /plain \{ relPath: Uint8Array\|Buffer \} object map/
        );
      }
    });

    it("artifactText not a string / missing params -> named usage rejections", function () {
      expectNamedError({ artifactText: 42, files: goodFiles() }, verifyvh.EXIT.USAGE, "UsageError", /artifactText/);
      expectNamedError(undefined, verifyvh.EXIT.USAGE, "UsageError", /requires a params object/);
    });

    it("malformed vendor pin -> named usage rejection", function () {
      expectNamedError(
        { artifactText: SIGNED_TEXT, files: goodFiles(), vendor: "0x1234" },
        verifyvh.EXIT.USAGE,
        "UsageError",
        /--vendor must be a 0x-prefixed 20-byte hex address/
      );
    });

    it("asOf without revocations / malformed asOf -> named usage rejections (the CLI's flag-shape gate)", async function () {
      expectNamedError(
        { artifactText: SIGNED_TEXT, files: goodFiles(), asOf: AS_OF },
        verifyvh.EXIT.USAGE,
        "UsageError",
        /asOf requires revocationsText/
      );
      const revocationsText = await mintDemoRevocationText(REVOKED_BEFORE);
      expectNamedError(
        { artifactText: SIGNED_TEXT, files: goodFiles(), revocationsText, asOf: "2026-13-99T99:99:99.000Z" },
        verifyvh.EXIT.USAGE,
        "UsageError",
        /invalid asOf/
      );
    });

    it("non-JSON revocations input -> named IO rejection (never a silently-skipped downgrade)", function () {
      expectNamedError(
        { artifactText: SIGNED_TEXT, files: goodFiles(), vendor: verifyvh.DEMO_SIGNER, revocationsText: "not json {" },
        verifyvh.EXIT.IO,
        "IOError",
        /cannot evaluate revocations.*not valid JSON/
      );
    });

    it("hostile relPaths INSIDE the artifact are a NAMED path_escape verdict (exit 3), not a throw", function () {
      let out;
      expect(() => {
        out = verifyvh.verifyArtifactFromBytes({ artifactText: escapeSealText(), files: goodFiles() });
      }).to.not.throw();
      expect(out.error).to.equal(null);
      expect(out.code).to.equal(verifyvh.EXIT.REJECTED);
      expect(out.result.reason).to.equal("path_escape");
      expect(out.result.escaped.map((e) => e.relPath)).to.deep.equal(["/etc/hostname", "../escape.txt"]);
    });
  });

  // ============================================================================================
  // (4) DYNAMIC PROOF: the whole bytes path runs with fs/os/path/child_process USE poisoned.
  // ============================================================================================
  describe("(4) dynamic proof: bytes path verdicts with impure builtin USE poisoned", function () {
    it("a child with poison-proxied fs/os/path/child_process drives the full bytes matrix; the disk path trips the poison", async function () {
      const revocationsText = await mintDemoRevocationText(REVOKED_BEFORE);
      const filesHex = {};
      for (const [rel, content] of Object.entries(verifyvh.DEMO_FILES)) {
        filesHex[rel] = Buffer.from(content, "utf8").toString("hex");
      }
      const fixture = {
        vvPath: ENTRY,
        signer: verifyvh.DEMO_SIGNER,
        wrongVendor: "0x" + "11".repeat(20),
        signedText: SIGNED_TEXT,
        unsignedText: UNSIGNED_TEXT,
        badSigText: tamperSignature(SIGNED_TEXT),
        doctoredText: doctoredExtraFileText(),
        escapeText: escapeSealText(),
        revocationsText,
        asOf: AS_OF,
        filesHex,
      };

      const script = `
        "use strict";
        const Module = require("module");
        const BLOCKED = new Set(["fs", "os", "path", "child_process"]);
        const origLoad = Module._load;
        Module._load = function (request) {
          const bare = String(request).replace(/^node:/, "");
          if (BLOCKED.has(bare)) {
            // A POISON module: loading it is fine (module-scope bindings only), but ANY use throws.
            return new Proxy({}, {
              get(_, prop) { throw new Error("BLOCKED impure builtin use: " + bare + "." + String(prop)); },
            });
          }
          return origLoad.apply(this, arguments);
        };

        const fixture = JSON.parse(process.env.VH_BYTES_FIXTURE);
        const vv = require(fixture.vvPath); // module load itself must not USE any blocked builtin
        const files = {};
        for (const k of Object.keys(fixture.filesHex)) files[k] = Buffer.from(fixture.filesHex[k], "hex");

        const out = {};
        function run(name, params) {
          const r = vv.verifyArtifactFromBytes(params);
          out[name] = {
            ok: r.ok,
            code: r.code,
            reason: r.result ? r.result.reason : null,
            errorName: r.error ? r.error.name : null,
          };
        }
        run("unsigned_accept", { artifactText: fixture.unsignedText, files });
        run("signed_accept", { artifactText: fixture.signedText, files, vendor: fixture.signer });
        const tampered = Object.assign({}, files, {
          "model-card.md": Buffer.concat([files["model-card.md"], Buffer.from("X")]),
        });
        run("changed", { artifactText: fixture.signedText, files: tampered, vendor: fixture.signer });
        const missing = Object.assign({}, files);
        delete missing["weights.txt"];
        run("missing", { artifactText: fixture.signedText, files: missing, vendor: fixture.signer });
        run("extra_root_mismatch", { artifactText: fixture.doctoredText, files });
        run("wrong_issuer", { artifactText: fixture.signedText, files, vendor: fixture.wrongVendor });
        run("bad_signature", { artifactText: fixture.badSigText, files, vendor: fixture.signer });
        run("revoked", {
          artifactText: fixture.signedText, files, vendor: fixture.signer,
          revocationsText: fixture.revocationsText, asOf: fixture.asOf, nowISO: fixture.asOf,
        });
        run("hostile_nonjson", { artifactText: "nope {", files });
        const oversized = Object.assign({}, files);
        oversized["k".repeat(5000)] = Buffer.from("x");
        run("hostile_oversized_key", { artifactText: fixture.unsignedText, files: oversized });
        run("hostile_escape", { artifactText: fixture.escapeText, files });

        // CONTROL: the DISK entrypoint must trip the poison immediately (proving the guard is not a no-op).
        let diskBlocked = false;
        try { vv.verifyArtifact({ artifact: "does-not-matter.json" }); }
        catch (e) { diskBlocked = /BLOCKED impure builtin use/.test(String(e && e.message)); }
        out.diskBlocked = diskBlocked;

        process.stdout.write(JSON.stringify(out));
      `;

      const stdout = execFileSync(process.execPath, ["-e", script], {
        env: Object.assign({}, process.env, { VH_BYTES_FIXTURE: JSON.stringify(fixture) }),
        encoding: "utf8",
      });
      const res = JSON.parse(stdout);

      expect(res.unsigned_accept).to.deep.equal({ ok: true, code: 0, reason: "OK", errorName: null });
      expect(res.signed_accept).to.deep.equal({ ok: true, code: 0, reason: "OK", errorName: null });
      expect(res.changed).to.deep.equal({ ok: false, code: 3, reason: "CHANGED", errorName: null });
      expect(res.missing).to.deep.equal({ ok: false, code: 3, reason: "MISSING", errorName: null });
      expect(res.extra_root_mismatch).to.deep.equal({ ok: false, code: 3, reason: "root_mismatch", errorName: null });
      expect(res.wrong_issuer).to.deep.equal({ ok: false, code: 3, reason: "wrong_issuer", errorName: null });
      expect(res.bad_signature).to.deep.equal({ ok: false, code: 3, reason: "bad_signature", errorName: null });
      expect(res.revoked).to.deep.equal({ ok: false, code: 3, reason: "key_revoked_as_of", errorName: null });
      expect(res.hostile_nonjson).to.deep.equal({ ok: false, code: 1, reason: null, errorName: "IOError" });
      expect(res.hostile_oversized_key).to.deep.equal({ ok: false, code: 2, reason: null, errorName: "UsageError" });
      expect(res.hostile_escape).to.deep.equal({ ok: false, code: 3, reason: "path_escape", errorName: null });
      // The poison genuinely bites: the DISK path could not take a single step.
      expect(res.diskBlocked).to.equal(true);
    });
  });
});
