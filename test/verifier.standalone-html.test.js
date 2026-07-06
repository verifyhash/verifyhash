"use strict";

// test/verifier.standalone-html.test.js — T-66.2: PROVE the single-file OFFLINE verify PAGE with the
// 60-second challenge built in (verifier/dist/verify-vh-standalone.html).
//
// The page is the LINK-SHAPED first contact for the evidence vertical: the human sends ONE file; the
// prospect opens it in a browser, clicks the built-in sample packet (ACCEPT), changes one byte in the
// page (REJECT naming the file), then drags their OWN packet in — no Node, no install, no network. This
// suite makes the task's five acceptance criteria TRUE in code:
//
//   (1) DETERMINISTIC + ANTI-ROT — two builds are BYTE-IDENTICAL; the committed dist (page + .sha256
//       sidecar + the shared BUILD-PROVENANCE.json) equals a fresh rebuild byte-for-byte (a stale or
//       tampered committed bundle FAILS here — the same pin discipline as the existing dist pins);
//       `--check` is green on the real tree and RED (exit 1, named MISMATCH) on a copied tree with a
//       one-byte-corrupted bundle/sidecar/source.
//   (2) the marked engine block is DOM-FREE — extracted between __VERIFY_VH_ENGINE_BEGIN__/END__ markers
//       and evaluated in a BARE `vm` context (no document, no window, no Buffer, no require), it answers
//       BYTE-IDENTICALLY to the in-tree T-66.1 bytes path (verifyArtifactFromBytes) for: demo-packet
//       ACCEPT, one-byte-tamper REJECT naming the file, signed ACCEPT with the correct vendor,
//       wrong-vendor REJECT, missing-file REJECT, and extra-file (doctored-seal) REJECT.
//   (3) NO NETWORK — the WHOLE emitted file contains none of the six network-API tokens: fetch( /
//       XMLHttpRequest / WebSocket / EventSource / sendBeacon / dynamic import(.
//   (4) BUILD-PROVENANCE.json gains the html target (bundle sha256 + ordered per-module source sha256s)
//       and `node verifier/build-standalone.js --check` still pins EVERY target green.
//   (5) NO change to the existing JS-bundle builds: the committed verify/seal bundles still byte-match
//       their fresh rebuilds (verify-vh.js CLI output parity is pinned by the unedited T-35.2 suite).
//
// Every write lands under a throwaway temp dir cleaned in afterEach; cwd is asserted untouched.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");
const { spawnSync } = require("child_process");

const htmlBuilder = require("../verifier/build-standalone-html");
const jsBuilder = require("../verifier/build-standalone");
// The in-tree verifier — the ORACLE the vm-evaluated engine must match byte-for-byte, and the owner of
// the shipped demo fixture the page inlines.
const verifyvh = require("../verifier/verify-vh");

const REPO = path.join(__dirname, "..");
const VERIFIER_DIR = path.join(REPO, "verifier");
const DIST_HTML = htmlBuilder.OUT_PATH;
const DIST_SHA256 = htmlBuilder.SHA256_PATH;
const DIST_PROVENANCE = htmlBuilder.PROVENANCE_PATH;

// The six network-API tokens the emitted file must not contain ANYWHERE (acceptance 3).
const NETWORK_TOKENS = ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "import("];

// The demo-packet scenario texts (the SAME shapes test/verifier.browser-core.test.js uses).
const SIGNED_TEXT = JSON.stringify(verifyvh.DEMO_CONTAINER);
const UNSIGNED_TEXT = verifyvh.DEMO_CONTAINER.attestation;
const WRONG_VENDOR = "0x" + "11".repeat(20);

// A seal DOCTORED to drop one committed file entry while keeping the original root — the "extra file"
// shape (the held bytes include a file the doctored seal no longer names; the kept root cannot be
// re-derived from the remaining set -> root_mismatch).
function doctoredExtraFileText() {
  const seal = JSON.parse(UNSIGNED_TEXT);
  seal.files = seal.files.filter((f) => f.relPath !== "weights.txt");
  return JSON.stringify(seal);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Extract the marked engine block from the emitted HTML. Asserts each marker appears EXACTLY once.
function extractEngineBlock(html) {
  for (const marker of [htmlBuilder.ENGINE_BEGIN_MARKER, htmlBuilder.ENGINE_END_MARKER]) {
    const first = html.indexOf(marker);
    expect(first, `engine marker ${marker} present`).to.be.greaterThan(-1);
    expect(html.indexOf(marker, first + marker.length), `engine marker ${marker} unique`).to.equal(-1);
  }
  const begin = html.indexOf(htmlBuilder.ENGINE_BEGIN_MARKER);
  const end = html.indexOf(htmlBuilder.ENGINE_END_MARKER);
  expect(end, "END marker after BEGIN").to.be.greaterThan(begin);
  return html.slice(begin, end);
}

// Evaluate the engine block in a BARE vm context: no document, no window, no navigator, no Buffer, no
// TextEncoder, no Node require — nothing but the JS language. Returns the contextified sandbox.
function loadEngineContext(html) {
  const code = extractEngineBlock(html);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInNewContext(code, ctx, { filename: "verify-vh-standalone-engine.js" });
  const S = ctx.VerifyVhStandalone;
  expect(S, "engine block defines VerifyVhStandalone").to.be.an("object");
  expect(S.engine.verifyArtifactFromBytes).to.be.a("function");
  expect(S.challenge.runChallenge).to.be.a("function");
  return ctx;
}

// An in-vm driver: builds the { relPath: Uint8Array } map with the VM'S OWN intrinsics (a cross-realm
// Uint8Array would rightly fail the engine's instanceof gate) and returns the verdict JSON-STRINGIFIED
// INSIDE the vm — so the byte-identity comparison below is over the exact serialized verdict bytes.
const VM_DRIVER = `(function (paramsJson) {
  var p = JSON.parse(paramsJson);
  var files = {};
  Object.keys(p.filesHex).forEach(function (k) {
    var hx = p.filesHex[k];
    var u = new Uint8Array(hx.length / 2);
    for (var i = 0; i < u.length; i++) u[i] = parseInt(hx.substr(i * 2, 2), 16);
    files[k] = u;
  });
  return JSON.stringify(VerifyVhStandalone.engine.verifyArtifactFromBytes({
    artifactText: p.artifactText,
    files: files,
    vendor: p.vendor,
    artifactName: p.artifactName,
  }));
})`;

// Strip JS comments / string literals (so prose can never mask or fake a token) — the same approach the
// T-66.1 browser-core suite uses.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
function stripStrings(src) {
  return src
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

describe("verifier standalone HTML: single-file OFFLINE page + built-in 60-second challenge (T-66.2)", function () {
  this.timeout(120000);

  let tmpDirs;
  let cwdBefore;

  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });

  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-standalone-html-"));
    tmpDirs.push(d);
    return d;
  }

  // Copy the whole verifier/ tree (sources + dist + BOTH builders) into a temp dir so corruption tests
  // never touch the working tree. The builders resolve everything from their own __dirname.
  function copyVerifierTree() {
    const dst = path.join(mkTmp(), "verifier");
    fs.cpSync(VERIFIER_DIR, dst, { recursive: true });
    return dst;
  }

  // Run `<verifierDir>/build-standalone-html.js --check` in a CHILD process (the way a skeptic runs it).
  function runHtmlCheck(verifierDir) {
    return spawnSync(process.execPath, [path.join(verifierDir, "build-standalone-html.js"), "--check"], {
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
    });
  }

  const committedHtml = () => fs.readFileSync(DIST_HTML, "utf8");

  // ============================================================================================
  // (1) DETERMINISTIC BUILD + ANTI-ROT (`--check` green; stale/tampered committed bundle RED)
  // ============================================================================================
  describe("(1) deterministic build + anti-rot", function () {
    it("two fresh builds are BYTE-IDENTICAL (no timestamp / randomness / fs-order dependence)", function () {
      const a = htmlBuilder.buildHtml();
      const b = htmlBuilder.buildHtml();
      expect(a).to.equal(b);
      expect(Buffer.byteLength(a)).to.be.greaterThan(50000);
      // The shared provenance manifest (which embeds this target) is deterministic too.
      expect(jsBuilder.buildProvenanceText()).to.equal(jsBuilder.buildProvenanceText());
    });

    it("the COMMITTED dist files match a fresh rebuild byte-for-byte (a stale/tampered bundle FAILS here)", function () {
      const stale = " is STALE — re-run `node verifier/build-standalone-html.js` and commit it";
      expect(committedHtml(), "verifier/dist/verify-vh-standalone.html" + stale).to.equal(
        htmlBuilder.buildHtml()
      );
      expect(
        fs.readFileSync(DIST_SHA256, "utf8"),
        "verifier/dist/verify-vh-standalone.html.sha256" + stale
      ).to.equal(htmlBuilder.sha256SidecarFor(htmlBuilder.buildHtml(), htmlBuilder.SHA256_BASENAME));
      expect(fs.readFileSync(DIST_PROVENANCE, "utf8"), "verifier/dist/BUILD-PROVENANCE.json" + stale).to.equal(
        jsBuilder.buildProvenanceText()
      );
    });

    it("the .sha256 sidecar is the standard `sha256sum -c` line over the committed bundle", function () {
      const sidecar = fs.readFileSync(DIST_SHA256, "utf8");
      expect(sidecar).to.match(/^[0-9a-f]{64} {2}verify-vh-standalone\.html\n$/);
      expect(sidecar).to.equal(`${sha256Hex(fs.readFileSync(DIST_HTML))}  verify-vh-standalone.html\n`);
    });

    it("`--check` on the real committed tree exits 0 with all MATCH and no MISMATCH", function () {
      const res = runHtmlCheck(VERIFIER_DIR);
      expect(res.error, "no spawn error").to.equal(undefined);
      expect(res.status, res.stdout + res.stderr).to.equal(0);
      expect(res.stdout).to.not.match(/MISMATCH/);
      expect(res.stdout).to.match(/\[MATCH\] bundle {2}dist\/verify-vh-standalone\.html/);
      expect(res.stdout).to.match(/\[MATCH\] sidecar dist\/verify-vh-standalone\.html\.sha256/);
      expect(res.stdout).to.match(/\[MATCH\] manifest dist\/BUILD-PROVENANCE\.json/);
      expect(res.stdout).to.match(/\[MATCH\] sources->manifest/);
      expect(res.stdout).to.match(/ALL MATCH/);
    });

    it("a ONE-BYTE-corrupted copied bundle makes `--check` exit 1 with a MISMATCH naming the bundle", function () {
      const vdir = copyVerifierTree();
      const p = path.join(vdir, "dist", "verify-vh-standalone.html");
      const bytes = fs.readFileSync(p);
      bytes[bytes.length - 10] ^= 0x01; // flip one bit near the end
      fs.writeFileSync(p, bytes);
      const res = runHtmlCheck(vdir);
      expect(res.status).to.equal(1);
      const all = res.stdout + res.stderr;
      expect(all).to.match(/\[MISMATCH\] bundle {2}dist\/verify-vh-standalone\.html: .*does NOT reproduce/);
      expect(all).to.match(/MISMATCH — at least one committed file does NOT reproduce/);
    });

    it("a corrupted copied sidecar makes `--check` exit 1 with a MISMATCH naming the sidecar", function () {
      const vdir = copyVerifierTree();
      fs.writeFileSync(
        path.join(vdir, "dist", "verify-vh-standalone.html.sha256"),
        "0".repeat(64) + "  verify-vh-standalone.html\n"
      );
      const res = runHtmlCheck(vdir);
      expect(res.status).to.equal(1);
      expect(res.stdout + res.stderr).to.match(/\[MISMATCH\] sidecar dist\/verify-vh-standalone\.html\.sha256:/);
    });

    it("a corrupted copied verify-vh.js is named against the manifest pin — even when the edit sits OUTSIDE the inlined engine slice", function () {
      const vdir = copyVerifierTree();
      // Append AFTER the engine markers: the emitted page's bytes are untouched (the slice is verbatim),
      // but the manifest pins the WHOLE audited file — so the chain still names it precisely.
      fs.appendFileSync(path.join(vdir, "verify-vh.js"), "\n// tampered\n");
      const res = runHtmlCheck(vdir);
      expect(res.status).to.equal(1);
      const all = res.stdout + res.stderr;
      expect(all).to.match(/\[MISMATCH\] sources->manifest: .*verifier\/verify-vh\.js \(pinned [0-9a-f]+…, got [0-9a-f]+…\)/);
    });

    it("a corrupted copied SOURCE file inlined into the page (lib/merkle.js) is a bundle MISMATCH and named in the chain", function () {
      const vdir = copyVerifierTree();
      const src = path.join(vdir, "lib", "merkle.js");
      const bytes = fs.readFileSync(src);
      bytes[100] ^= 0x01; // ONE byte of an audited, inlined source file
      fs.writeFileSync(src, bytes);
      const res = runHtmlCheck(vdir);
      expect(res.status).to.equal(1);
      const all = res.stdout + res.stderr;
      // The page no longer reproduces AND the chain names the exact offending source file.
      expect(all).to.match(/\[MISMATCH\] bundle {2}dist\/verify-vh-standalone\.html:/);
      expect(all).to.match(/\[MISMATCH\] sources->manifest: .*verifier\/lib\/merkle\.js \(pinned [0-9a-f]+…, got [0-9a-f]+…\)/);
    });

    it("`--check` writes NOTHING (the copied tree is byte-identical before and after)", function () {
      const vdir = copyVerifierTree();
      const snapshot = (root) => {
        const out = {};
        (function walk(dir) {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) walk(full);
            else out[path.relative(root, full)] = sha256Hex(fs.readFileSync(full));
          }
        })(root);
        return out;
      };
      const before = snapshot(vdir);
      const res = runHtmlCheck(vdir);
      expect(res.status, res.stdout + res.stderr).to.equal(0);
      expect(snapshot(vdir)).to.deep.equal(before);
    });
  });

  // ============================================================================================
  // (2) The DOM-free engine block: vm-evaluated in a BARE context, verdicts BYTE-IDENTICAL to the
  //     in-tree T-66.1 bytes path across the required matrix.
  // ============================================================================================
  describe("(2) engine block: bare-vm evaluation, byte-identical verdicts", function () {
    let ctx; // the bare vm context holding the COMMITTED page's engine
    let drive; // (params) -> verdict JSON string, computed inside the vm
    before(function () {
      ctx = loadEngineContext(fs.readFileSync(DIST_HTML, "utf8"));
      const fn = vm.runInContext(VM_DRIVER, ctx);
      drive = (params) => fn(JSON.stringify(params));
    });

    it("the block (comments+strings stripped) references NO DOM global, NO bare require(), NO impure builtin token", function () {
      const noComments = stripComments(extractEngineBlock(committedHtml()));
      expect(noComments).to.not.match(/\bdocument\s*[.[(]/);
      expect(noComments).to.not.match(/\bwindow\s*[.[(]/);
      expect(noComments).to.not.match(/\bnavigator\s*[.[(]/);
      expect(noComments).to.not.match(/\balert\s*\(/);
      // The browser-only helpers live in the UI script OUTSIDE the markers, never in the engine block.
      expect(noComments).to.not.match(/\bFileReader\b|\bTextEncoder\b|\bTextDecoder\b/);
      const code = stripStrings(noComments);
      // Every require was rewritten to the internal __require(id) shim — no Node require survives.
      expect(code).to.not.match(/(^|[^A-Za-z0-9_$])require\(/);
      // No impure Node builtin is even NAMED by the engine code (fs/os/path/process/child_process).
      expect(code).to.not.match(/\b(fs|os|child_process)\b/);
      expect(code).to.not.match(/\bprocess\s*[.[]/);
      // And the real proof is loadEngineContext() itself: the block evaluated in a BARE vm context (no
      // document/window/Buffer/require) in before() without throwing.
    });

    // THE EQUIVALENCE ORACLE: the same scenario through the vm engine and the in-tree bytes path must
    // serialize to the EXACT SAME BYTES. Returns the shared parsed verdict for scenario assertions.
    function assertByteIdentical(label, { artifactText, files, vendor }) {
      const filesHex = {};
      const oracleFiles = {};
      for (const [rel, content] of Object.entries(files)) {
        const buf = Buffer.from(content, "utf8");
        filesHex[rel] = buf.toString("hex");
        oracleFiles[rel] = buf;
      }
      const artifactName = "packet.vhevidence.json";
      const got = drive({ artifactText, filesHex, vendor, artifactName });
      const want = JSON.stringify(
        verifyvh.verifyArtifactFromBytes({ artifactText, files: oracleFiles, vendor, artifactName })
      );
      expect(got, `${label}: vm verdict bytes == in-tree verifyArtifactFromBytes bytes`).to.equal(want);
      return JSON.parse(got);
    }

    it("demo-packet ACCEPT: the UNSIGNED embedded seal over its exact bytes (exit 0)", function () {
      const out = assertByteIdentical("unsigned accept", {
        artifactText: UNSIGNED_TEXT,
        files: verifyvh.DEMO_FILES,
      });
      expect(out.ok).to.equal(true);
      expect(out.code).to.equal(verifyvh.EXIT.OK);
      expect(out.result.reason).to.equal("OK");
      expect(out.result.rootMatches).to.equal(true);
    });

    it("signed ACCEPT with the correct vendor: signer genuinely recovered and pinned (exit 0)", function () {
      const out = assertByteIdentical("signed accept", {
        artifactText: SIGNED_TEXT,
        files: verifyvh.DEMO_FILES,
        vendor: verifyvh.DEMO_SIGNER,
      });
      expect(out.ok).to.equal(true);
      expect(out.result.signed).to.equal(true);
      expect(out.result.signatureOk).to.equal(true);
      expect(out.result.recoveredSigner).to.equal(verifyvh.DEMO_SIGNER);
      expect(out.result.signerMatchesVendor).to.equal(true);
    });

    it("one-byte-tamper REJECT naming the file (exit 3, CHANGED model-card.md)", function () {
      const tampered = {
        ...verifyvh.DEMO_FILES,
        "model-card.md": verifyvh.DEMO_FILES["model-card.md"] + "X",
      };
      const out = assertByteIdentical("tamper reject", {
        artifactText: SIGNED_TEXT,
        files: tampered,
        vendor: verifyvh.DEMO_SIGNER,
      });
      expect(out.ok).to.equal(false);
      expect(out.code).to.equal(verifyvh.EXIT.REJECTED);
      expect(out.result.reason).to.equal("CHANGED");
      expect(out.result.changed).to.have.length(1);
      expect(out.result.changed[0].relPath).to.equal("model-card.md");
    });

    it("wrong-vendor REJECT: a sound signature pinned to the WRONG address (exit 3, wrong_issuer)", function () {
      const out = assertByteIdentical("wrong vendor", {
        artifactText: SIGNED_TEXT,
        files: verifyvh.DEMO_FILES,
        vendor: WRONG_VENDOR,
      });
      expect(out.ok).to.equal(false);
      expect(out.result.reason).to.equal("wrong_issuer");
      expect(out.result.signatureOk).to.equal(true);
      expect(out.result.signerMatchesVendor).to.equal(false);
    });

    it("missing-file REJECT: a referenced file absent from the map (exit 3, MISSING)", function () {
      const out = assertByteIdentical("missing", {
        artifactText: SIGNED_TEXT,
        files: { "model-card.md": verifyvh.DEMO_FILES["model-card.md"] },
        vendor: verifyvh.DEMO_SIGNER,
      });
      expect(out.ok).to.equal(false);
      expect(out.result.reason).to.equal("MISSING");
      expect(out.result.missing).to.deep.equal([{ relPath: "weights.txt" }]);
    });

    it("extra-file REJECT: a held file the doctored seal no longer commits to (exit 3, root_mismatch)", function () {
      const out = assertByteIdentical("extra/doctored", {
        artifactText: doctoredExtraFileText(),
        files: verifyvh.DEMO_FILES, // both files held; weights.txt is now the uncommitted EXTRA
      });
      expect(out.ok).to.equal(false);
      expect(out.result.reason).to.equal("root_mismatch");
      expect(out.result.rootMatches).to.equal(false);
    });

    it("the BUILT-IN 60-second challenge: genuine ACCEPT (byte-identical to the in-tree path) then a one-byte tamper REJECT naming the file", function () {
      const ch = vm.runInContext("JSON.stringify(VerifyVhStandalone.challenge.runChallenge())", ctx);
      const parsed = JSON.parse(ch);
      // Genuine: ACCEPT, byte-identical to the in-tree bytes path over the SAME shipped demo packet.
      const want = JSON.stringify(
        verifyvh.verifyArtifactFromBytes({
          artifactText: SIGNED_TEXT,
          files: Object.fromEntries(
            Object.entries(verifyvh.DEMO_FILES).map(([k, v]) => [k, Buffer.from(v, "utf8")])
          ),
          vendor: verifyvh.DEMO_SIGNER,
          artifactName: verifyvh.DEMO_PACKET_NAME,
        })
      );
      expect(JSON.stringify(parsed.genuine)).to.equal(want);
      expect(parsed.genuine.ok).to.equal(true);
      expect(parsed.genuine.result.recoveredSigner).to.equal(verifyvh.DEMO_SIGNER);
      // Tampered: a clean REJECT that NAMES the tampered file.
      expect(parsed.tampered.ok).to.equal(false);
      expect(parsed.tampered.code).to.equal(verifyvh.EXIT.REJECTED);
      expect(parsed.tampered.result.reason).to.equal("CHANGED");
      expect(parsed.tampered.result.changed.map((c) => c.relPath)).to.deep.equal(["model-card.md"]);
      expect(parsed.tamperedFile).to.equal("model-card.md");
      expect(parsed.signer).to.equal(verifyvh.DEMO_SIGNER);
    });

    it("the embedded fixture IS the verifier's shipped demo packet, verbatim (anti-drift pin for the textual extraction)", function () {
      const fx = JSON.parse(
        vm.runInContext("JSON.stringify(VerifyVhStandalone.challenge.fixture)", ctx)
      );
      expect(fx.SIGNER).to.equal(verifyvh.DEMO_SIGNER);
      expect(fx.PACKET_NAME).to.equal(verifyvh.DEMO_PACKET_NAME);
      expect(fx.CONTAINER_TEXT).to.equal(JSON.stringify(verifyvh.DEMO_CONTAINER));
      expect(fx.FILES).to.deep.equal(verifyvh.DEMO_FILES);
      // And the builder's extractor agrees (the build never re-authors the sample).
      const demo = htmlBuilder.extractDemoFixture();
      expect(demo.signer).to.equal(verifyvh.DEMO_SIGNER);
      expect(demo.files).to.deep.equal(verifyvh.DEMO_FILES);
      expect(JSON.stringify(demo.container)).to.equal(SIGNED_TEXT);
      expect(demo.packetName).to.equal(verifyvh.DEMO_PACKET_NAME);
    });

    it("hostile input stays NAMED-rejected inside the vm too (non-JSON artifact; absolute map key)", function () {
      const nonJson = JSON.parse(
        drive({ artifactText: "not json {", filesHex: {}, artifactName: "p" })
      );
      expect(nonJson.ok).to.equal(false);
      expect(nonJson.code).to.equal(verifyvh.EXIT.IO);
      expect(nonJson.error.name).to.equal("IOError");
      const escaped = JSON.parse(
        drive({
          artifactText: JSON.stringify({
            kind: "vh.evidence-seal",
            files: [{ relPath: "/etc/hostname", contentHash: "0x" + "00".repeat(32), leaf: "0x" + "00".repeat(32) }],
            root: "0x" + "00".repeat(32),
          }),
          filesHex: {},
          artifactName: "p",
        })
      );
      expect(escaped.code).to.equal(verifyvh.EXIT.REJECTED);
      expect(escaped.result.reason).to.equal("path_escape");
    });
  });

  // ============================================================================================
  // (3) NO NETWORK: the six-token test over the WHOLE emitted file
  // ============================================================================================
  describe("(3) six-token no-network test over the whole emitted file", function () {
    it("contains NONE of: fetch( / XMLHttpRequest / WebSocket / EventSource / sendBeacon / import(", function () {
      const html = committedHtml();
      for (const tok of NETWORK_TOKENS) {
        expect(html.includes(tok), `forbidden token ${JSON.stringify(tok)}`).to.equal(false);
      }
      // A fresh build is equally clean (the guarantee is the builder's, not one artifact's).
      const fresh = htmlBuilder.buildHtml();
      for (const tok of NETWORK_TOKENS) {
        expect(fresh.includes(tok), `forbidden token ${JSON.stringify(tok)} (fresh build)`).to.equal(false);
      }
    });

    it("carries the page surfaces the funnel needs: sample controls, drag-drop, folder picker, vendor pin, the honest boundary", function () {
      const html = committedHtml();
      // The built-in 60-second challenge controls.
      expect(html).to.contain('id="load-sample"');
      expect(html).to.contain('id="sample-editor"');
      expect(html).to.contain('id="sample-tamper"');
      expect(html).to.contain('id="sample-restore"');
      // The real-packet verify surface: drop zone, file + FOLDER pickers, vendor pin, revocations drop.
      expect(html).to.contain('id="drop-zone"');
      expect(html).to.contain("webkitdirectory");
      expect(html).to.contain('id="vendor-input"');
      expect(html).to.contain('id="revocations-input"');
      expect(html).to.contain("FileReader");
      // The honest boundary, verbatim and visible on the page (and in the generated banner).
      expect(html).to.contain("NOT");
      expect(html).to.contain("a trusted timestamp and NOT proof of WHEN");
      expect(html).to.contain("verify-vh-standalone.js");
      expect(html).to.contain("GENERATED by verifier/build-standalone-html.js");
      // The no-network claim is stated where a prospect will read it.
      expect(html).to.contain("devtools Network tab");
    });
  });

  // ============================================================================================
  // (4) BUILD-PROVENANCE.json gains the html target; every target still pins green
  // ============================================================================================
  describe("(4) the shared BUILD-PROVENANCE.json gains the html target", function () {
    it("the committed manifest carries verify + seal + verify-html, and the html record pins the real bytes", function () {
      const prov = JSON.parse(fs.readFileSync(DIST_PROVENANCE, "utf8"));
      expect(prov.schema).to.equal(jsBuilder.PROVENANCE_SCHEMA);
      expect(Object.keys(prov.targets)).to.deep.equal(["verify", "seal", htmlBuilder.HTML_TARGET_NAME]);
      const target = prov.targets[htmlBuilder.HTML_TARGET_NAME];
      expect(target.bundle).to.equal("verify-vh-standalone.html");
      expect(target.sidecar).to.equal("verify-vh-standalone.html.sha256");
      expect(target.bundleSha256).to.equal(sha256Hex(fs.readFileSync(DIST_HTML)));
      expect(target.bundleBytes).to.equal(fs.readFileSync(DIST_HTML).length);
      expect(target.sidecarLine).to.equal(fs.readFileSync(DIST_SHA256, "utf8").trim());
    });

    it("the html target lists the exact fixed module composition, in order, each source pinned by its REAL sha256", function () {
      const prov = JSON.parse(fs.readFileSync(DIST_PROVENANCE, "utf8"));
      const target = prov.targets[htmlBuilder.HTML_TARGET_NAME];
      expect(target.modules.map((m) => m.id)).to.deep.equal([
        "vh-buffer",
        "keccak256-vendored",
        "keccak",
        "merkle",
        "canonical",
        "secp256k1-recover",
        "revocation-core",
        "verify-vh-engine",
        "challenge-fixture",
        "challenge",
      ]);
      expect(target.modules.filter((m) => m.entry).map((m) => m.id)).to.deep.equal(["verify-vh-engine"]);
      // The build-generated bodies are the ONLY synthetic modules; each is honestly flagged.
      expect(target.modules.filter((m) => m.synthetic).map((m) => m.id)).to.deep.equal([
        "vh-buffer",
        "keccak",
        "challenge-fixture",
        "challenge",
      ]);
      const normalize = (s) => s.replace(/\r\n/g, "\n").replace(/^#![^\n]*\n/, "");
      for (const m of target.modules) {
        if (m.synthetic) {
          expect(m.sourceFile, `${m.id} synthetic has no sourceFile`).to.equal(null);
          expect(m.sourceSha256, `${m.id} synthetic has no sourceSha256`).to.equal(null);
          continue;
        }
        const real = sha256Hex(
          Buffer.from(normalize(fs.readFileSync(path.join(REPO, m.sourceFile), "utf8")), "utf8")
        );
        expect(m.sourceSha256, `${m.sourceFile} pinned hash is its real sha256`).to.equal(real);
      }
      // The engine slice is pinned against the WHOLE verify-vh.js source (the file a reviewer audits).
      const engineMod = target.modules.find((m) => m.id === "verify-vh-engine");
      expect(engineMod.sourceFile).to.equal("verifier/verify-vh.js");
    });

    it("`node verifier/build-standalone.js --check` (the shared manifest owner) still pins EVERY target green", function () {
      const res = spawnSync(process.execPath, [path.join(VERIFIER_DIR, "build-standalone.js"), "--check"], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
      });
      expect(res.status, res.stdout + res.stderr).to.equal(0);
      expect(res.stdout).to.not.match(/MISMATCH/);
      expect(res.stdout).to.match(/ALL MATCH/);
    });

    it("a manifest whose html pin was flipped is caught by BOTH builders' --check (copied tree)", function () {
      const vdir = copyVerifierTree();
      const manifestPath = path.join(vdir, "dist", "BUILD-PROVENANCE.json");
      const obj = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const pin = obj.targets[htmlBuilder.HTML_TARGET_NAME].bundleSha256;
      const flipped = (pin[0] === "0" ? "1" : "0") + pin.slice(1);
      fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, "utf8").split(pin).join(flipped));
      const htmlRes = runHtmlCheck(vdir);
      expect(htmlRes.status, "html --check flags the doctored manifest").to.equal(1);
      expect(htmlRes.stdout + htmlRes.stderr).to.match(/\[MISMATCH\] manifest dist\/BUILD-PROVENANCE\.json:/);
      const jsRes = spawnSync(process.execPath, [path.join(vdir, "build-standalone.js"), "--check"], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
      });
      expect(jsRes.status, "js --check flags the doctored manifest").to.equal(1);
      expect(jsRes.stdout + jsRes.stderr).to.match(/\[MISMATCH\] manifest dist\/BUILD-PROVENANCE\.json:/);
    });
  });

  // ============================================================================================
  // (T-74.4) FIRST-SCREEN LEGIBILITY: plain lede first, agent demo collapsed AFTER the verify
  // section, plain-language boundary, offline proof a layperson can run, verifier one click from
  // the landing hero. Pinned on the COMMITTED page (byte-equal to a fresh build per (1)).
  // ============================================================================================
  describe("(T-74.4) first-screen legibility: lede, collapsed agent demo, plain boundary, landing wiring", function () {
    // The exact plain-English lede (one contiguous line in the emitted page).
    const LEDE =
      "Check whether a file someone handed you is byte-for-byte what they signed — and who signed it. " +
      "Everything runs on this computer; nothing is uploaded.";
    const TOGGLE = "▸ Show the advanced agent-session demo";

    it("the plain-English lede is on the page, ABOVE the technical note (fresh build too)", function () {
      for (const [label, html] of [["committed", committedHtml()], ["fresh", htmlBuilder.buildHtml()]]) {
        const ledeAt = html.indexOf(LEDE);
        const noteAt = html.indexOf("An INDEPENDENT, read-only, fully OFFLINE verifier");
        expect(ledeAt, `${label}: lede present verbatim`).to.be.greaterThan(-1);
        expect(noteAt, `${label}: technical note still present`).to.be.greaterThan(-1);
        expect(ledeAt, `${label}: lede sits ABOVE the technical note`).to.be.lessThan(noteAt);
      }
    });

    it("the boundary speaks plain language: 'without a separate trusted timestamp', never 'P-3 trust-root'", function () {
      const html = committedHtml();
      expect(html).to.contain("NOT proof of WHEN without a separate trusted timestamp");
      expect(html.includes("P-3 trust-root"), "internal proposal jargon must be gone from the page").to.equal(false);
    });

    it("the devtools reassurance carries the offline proof a layperson can run: 'disconnect from the internet first — it still works'", function () {
      expect(committedHtml()).to.contain("disconnect from the internet first — it still works");
    });

    it("the agent-session demo is COLLAPSED behind the ▸ toggle (a real <details>, controls inside it)", function () {
      const html = committedHtml();
      expect(html).to.contain(`<summary id="agent-toggle">${TOGGLE}</summary>`);
      const detailsAt = html.indexOf('<details id="agent-details"');
      expect(detailsAt, "a native <details> element wraps the demo").to.be.greaterThan(-1);
      // <details> is collapsed by default — the markup must NOT force it open.
      expect(/<details id="agent-details"[^>]*\bopen\b/.test(html), "details must not carry the open attribute").to.equal(false);
      const detailsEnd = html.indexOf("</details>", detailsAt);
      expect(detailsEnd).to.be.greaterThan(detailsAt);
      // every agent-demo control sits INSIDE the collapsed details block
      for (const id of ["load-agent-sample", "agent-editor", "agent-verify", "agent-tamper", "agent-restore", "agent-verdict"]) {
        const at = html.indexOf(`id="${id}"`);
        expect(at, `${id} present`).to.be.greaterThan(-1);
        expect(at > detailsAt && at < detailsEnd, `${id} sits inside the collapsed <details>`).to.equal(true);
      }
      // …and the summary toggle sits before them, inside the same details.
      const summaryAt = html.indexOf('id="agent-toggle"');
      expect(summaryAt > detailsAt && summaryAt < html.indexOf('id="load-agent-sample"')).to.equal(true);
    });

    it("the collapsed agent demo sits AFTER the 'Verify a packet YOU were handed' section, with a one-sentence plain intro", function () {
      const html = committedHtml();
      const challengeAt = html.indexOf('id="challenge-section"');
      const verifyAt = html.indexOf('id="verify-section"');
      const agentAt = html.indexOf('id="agent-section"');
      expect(challengeAt).to.be.greaterThan(-1);
      expect(verifyAt, "verify section after the challenge").to.be.greaterThan(challengeAt);
      expect(agentAt, "agent section positioned AFTER the verify section").to.be.greaterThan(verifyAt);
      // the plain one-sentence intro precedes the toggle
      const intro = "The same offline check also works on AI-agent session logs";
      const introAt = html.indexOf(intro);
      expect(introAt, "plain intro present").to.be.greaterThan(agentAt);
      expect(introAt, "plain intro precedes the toggle").to.be.lessThan(html.indexOf('id="agent-toggle"'));
    });

    it("landing page: the hero CTA opens /verify-vh-standalone.html and card 01 has the built-in-sample clause + a real 'Open the verifier' button", function () {
      const landing = fs.readFileSync(path.join(REPO, "site", "index.html"), "utf8");
      // hero CTA (the primary button inside .hero-cta) points at the verifier page
      const heroCta = landing.match(/<div class="hero-cta[^"]*">([\s\S]*?)<\/div>/);
      expect(heroCta, "hero-cta block exists").to.not.equal(null);
      expect(heroCta[1]).to.match(/<a class="btn btn-primary" href="\/verify-vh-standalone\.html"/);
      // card 01: the built-in-sample clause…
      expect(landing.replace(/\s+/g, " ")).to.match(/built-in sample packet/);
      // …and a REAL button (styled anchor) labelled exactly "Open the verifier", linking the page
      expect(landing).to.match(
        /<a class="btn btn-primary" href="\/verify-vh-standalone\.html">Open the verifier<\/a>/
      );
    });
  });

  // ============================================================================================
  // (5) NO change to the existing JS-bundle builds (regression pin)
  // ============================================================================================
  describe("(5) the existing JS-bundle builds are unchanged", function () {
    it("the committed verify/seal JS bundles still byte-match their fresh rebuilds", function () {
      expect(fs.readFileSync(jsBuilder.OUT_PATH, "utf8"), "verify bundle unchanged").to.equal(
        jsBuilder.buildBundle()
      );
      expect(fs.readFileSync(jsBuilder.SEAL_OUT_PATH, "utf8"), "seal bundle unchanged").to.equal(
        jsBuilder.buildSealBundle()
      );
    });

    it("the html builder writes ONLY the html pair + the shared manifest (never the JS bundles)", function () {
      const vdir = copyVerifierTree();
      const jsBundleBefore = fs.readFileSync(path.join(vdir, "dist", "verify-vh-standalone.js"));
      const sealBundleBefore = fs.readFileSync(path.join(vdir, "dist", "seal-vh-standalone.js"));
      const res = spawnSync(process.execPath, [path.join(vdir, "build-standalone-html.js")], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
      });
      expect(res.status, res.stdout + res.stderr).to.equal(0);
      expect(fs.readFileSync(path.join(vdir, "dist", "verify-vh-standalone.js"))).to.deep.equal(jsBundleBefore);
      expect(fs.readFileSync(path.join(vdir, "dist", "seal-vh-standalone.js"))).to.deep.equal(sealBundleBefore);
      // And what it DID write is byte-identical to the committed dist (the no-flag build is deterministic).
      expect(fs.readFileSync(path.join(vdir, "dist", "verify-vh-standalone.html"))).to.deep.equal(
        fs.readFileSync(DIST_HTML)
      );
      expect(fs.readFileSync(path.join(vdir, "dist", "BUILD-PROVENANCE.json"))).to.deep.equal(
        fs.readFileSync(DIST_PROVENANCE)
      );
    });
  });
});
