"use strict";

// test/verify-service.example.test.js — the CI-INTEGRATION acceptance suite that makes the `vh serve-verify`
// endpoint a DROP-IN dependency (T-59.3).
//
// WHAT THIS PROVES (each acceptance clause is a describe/it below)
//   (1) THE CLIENT RUNS AS A CI INTEGRATOR WOULD: `node examples/verify-service-client.js` in a CHILD
//       PROCESS exits 0 and prints an ACCEPT (clean seal, HTTP 200) then a REJECT (one-byte tamper, HTTP 422).
//   (2) THE CLIENT STANDS ALONE: a source-level grep asserts it imports ONLY `require("verifyhash")`, the
//       `vh` COMMAND (spawned, not required), Node built-ins, and relative files — NO deep `require(".../cli/…")`
//       and NO third-party dependency.
//   (3) THE GENERIC CI SCRIPT IS REAL + WORKS: it is `bash -n` syntactically valid and, driven against a
//       REAL booted `vh serve-verify` server, EXITS NON-ZERO (3) on a tampered seal and ZERO on a clean one.
//   (4) THE DOC BYTE-MATCHES THE CORE (no drift): docs/VERIFY-SERVICE.md documents the schema + status
//       mapping + trust boundary, and its documented request `kind`s + response fields byte-match the live
//       `cli/serve-verify.js › verifyRequest` core's constants (a doc that drifts from the code fails here).
//   (5) STRATEGY.md P-9 gains the verify-service sub-note AND still carries its 3 human steps unchanged.
//
// PURE / OFFLINE — no chain, no provider, no network beyond loopback, no REAL key. Seals are built PURELY
// IN MEMORY. All servers bind an EPHEMERAL loopback port and are torn down (pass or fail).

const { expect } = require("chai");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const vh = require("verifyhash");
const serveVerify = require("../cli/serve-verify");

const REPO = path.resolve(__dirname, "..");
const EXAMPLE = path.join(REPO, "examples", "verify-service-client.js");
const EXAMPLE_README = path.join(REPO, "examples", "README.md");
const GENERIC_SH = path.join(REPO, "verifier", "ci", "verify-service.generic.sh");
const GHA_YML = path.join(REPO, "verifier", "ci", "verify-service.github-actions.yml");
const DOC = path.join(REPO, "docs", "VERIFY-SERVICE.md");
const SDK_DOC = path.join(REPO, "docs", "SDK.md");
const STRATEGY = path.join(REPO, "STRATEGY.md");
const VH_BIN = path.join(REPO, "cli", "vh.js");

// ---------------------------------------------------------------------------------------------------
// Helpers: boot a real `vh serve-verify` on an ephemeral loopback port; POST; tear down.
// ---------------------------------------------------------------------------------------------------

// Boot `vh serve-verify --port 0 --host 127.0.0.1` and resolve { child, port } once it announces listening.
function bootServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [VH_BIN, "serve-verify", "--port", "0", "--host", "127.0.0.1"], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let banner = "";
    let settled = false;
    child.stdout.on("data", (chunk) => {
      banner += chunk.toString("utf8");
      const m = banner.match(/listening on http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m && !settled) {
        settled = true;
        resolve({ child, port: Number(m[1]) });
      }
    });
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`server exited before listening (code ${code}):\n${banner}`));
      }
    });
  });
}

function killServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    // Safety: never hang the suite if SIGTERM is somehow missed.
    setTimeout(() => resolve(), 2000).unref?.();
  });
}

// A tiny in-memory file set + the transport wire shape the service expects.
const ENTRIES = [
  { relPath: "dist/app.js", bytes: Buffer.from("console.log('build 1');\n") },
  { relPath: "README.md", bytes: Buffer.from("# release\n") },
];
function wireEntries(entries) {
  return entries.map((e) => ({
    relPath: e.relPath,
    content: Buffer.from(e.bytes).toString("base64"),
    encoding: "base64",
  }));
}

describe("verify-service CI integration — the drop-in verify endpoint (T-59.3)", function () {
  // Booting a child node process + HTTP round-trips is a touch slow; give generous but bounded headroom.
  this.timeout(60000);

  let tmpDirs;
  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-vs-"));
    tmpDirs.push(d);
    return d;
  }

  // ===============================================================================================
  // (1) THE CLIENT RUNS AS A CI INTEGRATOR WOULD — child process, exit 0, ACCEPT then REJECT.
  // ===============================================================================================
  describe("examples/verify-service-client.js runs in a child process (exit 0, ACCEPT then REJECT)", function () {
    let stdout;

    before(function () {
      // Run EXACTLY as a developer would: `node examples/verify-service-client.js`. execFileSync throws on a
      // non-zero exit, so a clean return already asserts exit 0. We capture stdout to assert the sequence.
      stdout = execFileSync("node", [EXAMPLE], { cwd: REPO, encoding: "utf8" });
    });

    it("exits 0 (execFileSync returned without throwing)", function () {
      expect(stdout).to.be.a("string").and.not.equal("");
    });

    it("prints an ACCEPT (clean seal verified over HTTP 200)", function () {
      expect(stdout).to.match(/HTTP 200 ACCEPTED/);
      expect(stdout).to.match(/\bACCEPT\b/);
    });

    it("prints a REJECT (one-byte tamper caught over HTTP 422)", function () {
      expect(stdout).to.match(/HTTP 422 REJECTED/);
      expect(stdout).to.match(/\bREJECT\b/);
    });

    it("the ACCEPT precedes the REJECT (the sequence is in order)", function () {
      const acceptIdx = stdout.indexOf("ACCEPT");
      const rejectIdx = stdout.indexOf("REJECT");
      expect(acceptIdx, "ACCEPT not printed").to.be.greaterThan(-1);
      expect(rejectIdx, "REJECT not printed").to.be.greaterThan(-1);
      expect(acceptIdx).to.be.lessThan(rejectIdx);
    });

    it("ends with a PASS summary that names the ACCEPT-then-REJECT gate", function () {
      expect(stdout).to.match(/RESULT: PASS/);
    });

    it("importable runExample returns the ACCEPT(200) then REJECT(422) verdicts (asserted on DATA)", async function () {
      const { runExample } = require("../examples/verify-service-client");
      const result = await runExample(() => {}); // silent sink — assert on the returned structure
      expect(result.acceptStatus).to.equal(200);
      expect(result.acceptVerdict).to.equal("ACCEPTED");
      expect(result.rejectStatus).to.equal(422);
      expect(result.rejectVerdict).to.equal("REJECTED");
      expect(result.apiVersion).to.equal(require("../package.json").version);
    });
  });

  // ===============================================================================================
  // (2) THE CLIENT STANDS ALONE — grep the source: ONLY require("verifyhash") / the command / relative
  //     files / Node built-ins. NO deep require(".../cli/…") and NO third-party dependency.
  // ===============================================================================================
  describe("public surface stands alone — source grep of the client's imports", function () {
    let src; // comment-stripped source: we grep CODE, not prose (comments legitimately name anti-patterns)
    let requireArgs;

    before(function () {
      const rawSrc = fs.readFileSync(EXAMPLE, "utf8");
      src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      requireArgs = [];
      const re = /require\(\s*(["'])([^"']+)\1\s*\)/g;
      let m;
      while ((m = re.exec(src)) !== null) requireArgs.push(m[2]);
    });

    it("imports the package BY NAME through its public entrypoint (require(\"verifyhash\"))", function () {
      expect(requireArgs, "client must require the public package by name").to.include("verifyhash");
    });

    it("does NOT deep-import ANY cli/* internal (only the public surface + relative files + built-ins)", function () {
      // The load-bearing check: NO deep `require(".../cli/…")` reach-in anywhere in the CODE.
      expect(src, "client must not deep-import cli/*").to.not.match(/require\([^)]*\/cli\//);
      const KNOWN_BUILTINS = new Set([
        "fs", "path", "os", "http", "https", "child_process", "url", "util", "crypto", "process", "assert",
      ]);
      for (const arg of requireArgs) {
        const isPackageByName = arg === "verifyhash";
        const isRelative = arg.startsWith("./") || arg.startsWith("../");
        const isBuiltin = KNOWN_BUILTINS.has(arg) || arg.startsWith("node:");
        expect(
          isPackageByName || isRelative || isBuiltin,
          `client require("${arg}") is not the public package, a Node built-in, or a relative file`
        ).to.equal(true);
        // A relative require must NOT reach up into cli/* (that would be a deep internal by the back door).
        if (isRelative) {
          expect(arg, `relative require("${arg}") reaches into cli/*`).to.not.match(/(^|\/)cli\//);
        }
        // And explicitly: no cli/ segment in ANY specifier.
        expect(arg, `require("${arg}") reaches into cli/`).to.not.match(/(^|\/)cli\//);
      }
    });

    it("uses NO third-party dependency (not even ethers) — only the package + Node built-ins", function () {
      const KNOWN_BUILTINS = new Set([
        "fs", "path", "os", "http", "https", "child_process", "url", "util", "crypto", "process", "assert",
      ]);
      for (const arg of requireArgs) {
        if (arg === "verifyhash") continue; // the public package by name
        if (arg.startsWith(".")) continue; // relative file
        expect(
          KNOWN_BUILTINS.has(arg) || arg.startsWith("node:"),
          `client require("${arg}") is a third-party dependency`
        ).to.equal(true);
        // Belt-and-braces: it must NOT pull ethers (a heavyweight third-party dep the client does not need).
        expect(arg, "client must not require ethers").to.not.equal("ethers");
      }
    });

    it("boots the vh COMMAND (spawn), not by requiring a cli module", function () {
      // It reaches the server via the `vh` bin (a spawned COMMAND), never by importing a cli/* module.
      expect(src).to.match(/spawn\(/);
      expect(src).to.match(/serve-verify/);
    });

    it("README documents the client + names its test (so the doc cannot silently rot)", function () {
      const readme = fs.readFileSync(EXAMPLE_README, "utf8");
      expect(readme).to.include("node examples/verify-service-client.js");
      expect(readme).to.include("test/verify-service.example.test.js");
    });
  });

  // ===============================================================================================
  // (3) THE GENERIC CI SCRIPT — bash -n valid, and driven against a REAL booted server: non-zero on a
  //     tampered seal, zero on a clean one.
  // ===============================================================================================
  describe("verifier/ci/verify-service.generic.sh (the shipped shell gate, run against a real server)", function () {
    let server;

    before(async function () {
      server = await bootServer();
    });
    after(async function () {
      await killServer(server && server.child);
    });

    // Run the shell gate with env overrides; capture exit code + stdio (never throwing on non-zero).
    function runGate(env) {
      try {
        const stdout = execFileSync("bash", [GENERIC_SH], {
          env: { ...process.env, ...env },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, stdout, stderr: "" };
      } catch (e) {
        return {
          code: typeof e.status === "number" ? e.status : 1,
          stdout: e.stdout ? e.stdout.toString() : "",
          stderr: e.stderr ? e.stderr.toString() : "",
        };
      }
    }

    // Write a verify request-body JSON file (built with the PUBLIC SDK) for the gate to POST.
    function writeRequest(entries) {
      const dir = mkTmp();
      const sealJson = vh.serializeSeal(vh.buildSeal(ENTRIES));
      const body = { kind: "verify-seal", seal: sealJson, entries: wireEntries(entries) };
      const p = path.join(dir, "verify-request.json");
      fs.writeFileSync(p, JSON.stringify(body));
      return p;
    }

    it("is shipped, a real bash script, and `bash -n` syntactically valid", function () {
      expect(fs.existsSync(GENERIC_SH), "generic.sh must be shipped").to.equal(true);
      const srcSh = fs.readFileSync(GENERIC_SH, "utf8");
      expect(srcSh).to.match(/^#!.*\bbash\b/m);
      expect(srcSh).to.match(/set -euo pipefail/);
      // `bash -n` parses the script WITHOUT executing it — a syntax error exits non-zero and this throws.
      execFileSync("bash", ["-n", GENERIC_SH], { stdio: ["ignore", "pipe", "pipe"] });
    });

    it("EXITS 0 on a CLEAN seal (the service ACCEPTs -> merge allowed)", function () {
      const req = writeRequest(ENTRIES);
      const r = runGate({ VH_VERIFY_URL: `http://127.0.0.1:${server.port}`, VH_REQUEST: req });
      expect(r.code, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).to.equal(0);
      expect(r.stdout).to.match(/HTTP 200/);
      expect(r.stdout).to.match(/ACCEPTED/);
    });

    it("EXITS NON-ZERO (3) on a TAMPERED seal (the service REJECTs -> merge blocked)", function () {
      // Same seal, one byte of one file flipped -> the service RE-DERIVES the root and REJECTs.
      const tampered = ENTRIES.map((e) =>
        e.relPath === "dist/app.js" ? { relPath: e.relPath, bytes: Buffer.from("console.log('build 2');\n") } : e
      );
      const req = writeRequest(tampered);
      const r = runGate({ VH_VERIFY_URL: `http://127.0.0.1:${server.port}`, VH_REQUEST: req });
      expect(r.code, `stdout: ${r.stdout}`).to.not.equal(0);
      expect(r.code).to.equal(3);
      expect(r.stdout).to.match(/HTTP 422/);
      expect(r.stderr).to.match(/blocking the merge/);
    });

    it("a missing VH_REQUEST is a usage error (exit 2) — never a silent pass", function () {
      const r = runGate({ VH_VERIFY_URL: `http://127.0.0.1:${server.port}` });
      expect(r.code).to.equal(2);
      expect(r.stderr).to.match(/set VH_REQUEST/);
    });

    it("an unreachable service is an IO error (exit 1) — never a silent pass", function () {
      // Point at a port nothing is listening on. curl fails to connect -> the gate exits 1 (IO), not 0.
      const req = writeRequest(ENTRIES);
      const r = runGate({ VH_VERIFY_URL: "http://127.0.0.1:1", VH_REQUEST: req });
      expect(r.code).to.equal(1);
      expect(r.stderr).to.match(/could not reach/);
    });
  });

  // ===============================================================================================
  // (3b) THE GITHUB ACTIONS YAML — a shipped example that boots the service then gates by HTTP status.
  // ===============================================================================================
  describe("verifier/ci/verify-service.github-actions.yml (the shipped GH Actions example)", function () {
    it("is a shipped workflow that triggers on push/pull_request and boots + gates the service", function () {
      expect(fs.existsSync(GHA_YML)).to.equal(true);
      const yml = fs.readFileSync(GHA_YML, "utf8");
      expect(yml).to.match(/^on:/m);
      expect(yml).to.match(/pull_request:/);
      expect(yml).to.match(/jobs:/);
      expect(yml).to.match(/verify-service:/);
      // It boots the service, waits for /healthz, and gates on the /verify HTTP status.
      expect(yml).to.match(/vh serve-verify/);
      expect(yml).to.contain("/healthz");
      expect(yml).to.contain("/verify");
      expect(yml).to.match(/http_code/);
      // A green build requires HTTP 200 exactly.
      expect(yml).to.match(/"200"/);
    });
  });

  // ===============================================================================================
  // (4) docs/VERIFY-SERVICE.md documents the schema + status mapping + trust boundary, and its documented
  //     request kinds + response fields BYTE-MATCH the live verifyRequest core (no doc/code drift).
  // ===============================================================================================
  describe("docs/VERIFY-SERVICE.md byte-matches the verifyRequest core (no drift)", function () {
    let doc;

    before(function () {
      doc = fs.readFileSync(DOC, "utf8");
    });

    it("documents the schema envelope constant + the service name VERBATIM from the core", function () {
      expect(doc).to.contain(serveVerify.VERIFY_REQUEST_SCHEMA); // "vh.verify-request/1"
      expect(doc).to.contain(serveVerify.SERVICE_NAME); // "vh-serve-verify"
    });

    it("documents EVERY request kind the core dispatches on (byte-match, and no extras)", function () {
      // The core is the source of truth: SUPPORTED_KINDS. Each must appear in the doc, quoted verbatim.
      for (const kind of serveVerify.SUPPORTED_KINDS) {
        expect(doc, `doc must document request kind "${kind}"`).to.contain(`"${kind}"`);
      }
      // And the doc must not INVENT a request kind the core does not support. Extract every `kind: "..."`
      // (and `"kind": "..."`) the doc names and require it to be a real supported kind.
      const kindRe = /["']?kind["']?\s*:\s*"([a-z-]+)"/g;
      let m;
      const documentedKinds = new Set();
      while ((m = kindRe.exec(doc)) !== null) documentedKinds.add(m[1]);
      for (const k of documentedKinds) {
        expect(
          serveVerify.SUPPORTED_KINDS.includes(k),
          `doc names request kind "${k}" that the core does not support`
        ).to.equal(true);
      }
      // The doc actually documented BOTH kinds (not zero).
      expect(documentedKinds.size).to.be.greaterThan(0);
      for (const kind of serveVerify.SUPPORTED_KINDS) {
        expect(documentedKinds.has(kind), `doc did not actually document kind "${kind}"`).to.equal(true);
      }
    });

    it("documents the OK response fields, byte-matching the core's real OK envelope keys", function () {
      // Build a REAL OK verdict from the live core and require the doc to name EVERY top-level field.
      const seal = vh.buildSeal(ENTRIES);
      const okVerdict = serveVerify.verifyRequest({
        kind: "verify-seal",
        seal: vh.serializeSeal(seal),
        entries: wireEntries(ENTRIES),
      });
      expect(okVerdict.verdict).to.equal("ACCEPTED");
      const okKeys = Object.keys(okVerdict); // schema, service, verdict, kind, detail
      for (const key of okKeys) {
        expect(doc, `doc must document the OK response field \`${key}\``).to.match(
          new RegExp(`\\b${key}\\b`)
        );
      }
      // The doc must specifically name the load-bearing ones.
      expect(okKeys).to.include.members(["schema", "service", "verdict", "kind", "detail"]);
    });

    it("documents the ERROR response fields + the stable error codes, byte-matching the core", function () {
      // A REAL error verdict from the core (unknown kind) -> its keys must all be documented.
      const errVerdict = serveVerify.verifyRequest({ kind: "not-a-real-kind" });
      expect(errVerdict.verdict).to.equal(serveVerify.VERDICT.ERROR);
      for (const key of Object.keys(errVerdict)) {
        expect(doc, `doc must document the ERROR response field \`${key}\``).to.match(
          new RegExp(`\\b${key}\\b`)
        );
      }
      // Every stable machine-readable error code the core can return must be documented verbatim.
      for (const code of Object.values(serveVerify.ERR)) {
        expect(doc, `doc must document the error code ${code}`).to.contain(code);
      }
    });

    it("documents the three top-level verdicts VERBATIM from the core", function () {
      for (const v of Object.values(serveVerify.VERDICT)) {
        expect(doc, `doc must document the verdict ${v}`).to.contain(v);
      }
    });

    it("documents the supported entry encodings VERBATIM from the core", function () {
      for (const enc of serveVerify.SUPPORTED_ENTRY_ENCODINGS) {
        expect(doc, `doc must document the entry encoding ${enc}`).to.contain(enc);
      }
    });

    it("documents the STATUS MAPPING (200/422/400/413) so a CI gate can key on the code", function () {
      expect(doc).to.match(/\b200\b/);
      expect(doc).to.match(/\b422\b/);
      expect(doc).to.match(/\b400\b/);
      expect(doc).to.match(/\b413\b/);
      expect(doc.toUpperCase()).to.match(/ACCEPTED/);
      expect(doc.toUpperCase()).to.match(/REJECTED/);
    });

    it("documents the TRUST BOUNDARY (tamper-evidence, not a timestamp / not a legal opinion; verify-only, loopback)", function () {
      expect(doc.toLowerCase()).to.match(/tamper-evidence/);
      expect(doc.toLowerCase()).to.match(/trusted timestamp/);
      expect(doc.toLowerCase()).to.match(/legal opinion/);
      expect(doc.toLowerCase()).to.match(/verify-only/);
      expect(doc.toLowerCase()).to.match(/loopback/);
      expect(doc).to.match(/P-3/);
    });

    it("SDK.md links the verify-service doc + the client example (the SDK surface points at the service)", function () {
      const sdk = fs.readFileSync(SDK_DOC, "utf8");
      expect(sdk).to.contain("VERIFY-SERVICE.md");
      expect(sdk).to.contain("examples/verify-service-client.js");
      expect(sdk).to.match(/serve-verify/);
    });
  });

  // ===============================================================================================
  // (5) STRATEGY.md P-9 gains the verify-service sub-note AND still carries its 3 human steps unchanged.
  // ===============================================================================================
  describe("STRATEGY.md P-9 — verify-service sub-note added, 3 human steps intact", function () {
    let strat;
    let p9Block;

    before(function () {
      strat = fs.readFileSync(STRATEGY, "utf8");
      // Isolate the P-9 block: from the "P-9 (…) — EMBEDDABLE SDK" heading to end-of-file (P-9 is last).
      const start = strat.indexOf("P-9 (2026-07-01) — EMBEDDABLE SDK distribution");
      expect(start, "P-9 block not found").to.be.greaterThan(-1);
      p9Block = strat.slice(start);
    });

    it("still carries its THREE human steps, in order, unchanged", function () {
      const step1 = p9Block.indexOf("1. **Decide whether/how to PUBLISH.**");
      const step2 = p9Block.indexOf("2. **Pick the embed/usage PRICE");
      const step3 = p9Block.indexOf("3. **Offer + support the SDK to embedders.**");
      expect(step1, "P-9 step 1 (PUBLISH) missing").to.be.greaterThan(-1);
      expect(step2, "P-9 step 2 (PRICE) missing").to.be.greaterThan(-1);
      expect(step3, "P-9 step 3 (Offer + support) missing").to.be.greaterThan(-1);
      // In order.
      expect(step1).to.be.lessThan(step2);
      expect(step2).to.be.lessThan(step3);
    });

    it("gains the verify-service sub-note that names the endpoint + the shipped artifacts", function () {
      expect(p9Block).to.match(/Verify-service sub-note/);
      expect(p9Block).to.match(/T-59\.3/);
      expect(p9Block).to.match(/serve-verify/);
      expect(p9Block).to.contain("examples/verify-service-client.js");
      expect(p9Block).to.contain("docs/VERIFY-SERVICE.md");
    });

    it("the sub-note asserts it is IN-GUARDRAILS (verify-only, loopback, no token, no new gate)", function () {
      const note = p9Block.slice(p9Block.indexOf("Verify-service sub-note"));
      expect(note.toLowerCase()).to.match(/verify-only/);
      expect(note.toLowerCase()).to.match(/loopback/);
      expect(note).to.match(/NOT a token/i);
      // Explicitly promises it adds NO new gate and relaxes none (the 3 steps are unchanged).
      expect(note).to.match(/NO new gate/i);
    });
  });
});
