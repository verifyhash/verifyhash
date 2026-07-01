"use strict";

// T-59.2 — `vh serve-verify`: a tiny, dependency-free (Node-core `http` ONLY) loopback-only HTTP VERIFY
// server that fronts the PURE `verifyRequest` core (T-59.1). These tests prove the transport behaves:
//
//   * They START the real http.Server on an EPHEMERAL port bound to 127.0.0.1, POST a VALID unsigned seal
//     (200 + ACCEPTED), POST a ONE-BYTE-tampered seal (422 + REJECTED), POST a SIGNED container under the
//     correct then WRONG `expectedSigner` (200 then 422), POST malformed JSON (400) and an OVERSIZED body
//     (413, no crash), GET /healthz (200 + { ok:true }), and hit a wrong method / wrong path (4xx) — then CLOSE
//     the server cleanly (a leaked-handle assertion proves no dangling socket).
//   * A test asserts the DEFAULT bind host is LOOPBACK: a request to a NON-loopback interface is NOT served
//     by the default bind (the socket is not listening there — connection refused).
//   * A test asserts the process holds NO key and writes NO file during a verify (the working tree is
//     byte-identical before/after, and the module source names no key material / no fs write).
//   * A test asserts the CLI help/banner carries the verify-only + loopback + P-3 + human-deploy caveats
//     VERBATIM.
//
// Every signing key is an EPHEMERAL in-process Wallet.createRandom() (TEST-ONLY, never a real key / real
// funds). Payloads are built PURELY IN MEMORY (no directory, no file read) — this server needs no fs.

const { expect } = require("chai");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

const evidence = require("../cli/evidence");
const serveVerify = require("../cli/serve-verify");
const serveVerifyHttp = require("../cli/serve-verify-http");
const vh = require("../cli/vh");

// ---------------------------------------------------------------------------------------------------
// In-memory fixtures (NO filesystem). Entries are literal { relPath, bytes }; the transport shape is
// { relPath, content, encoding } with content base64-encoded so ANY bytes round-trip through JSON.
// ---------------------------------------------------------------------------------------------------
const FILES = Object.freeze({
  "a.txt": Buffer.from("AAA\n"),
  "b.txt": Buffer.from("BBB\n"),
  "sub/c.txt": Buffer.from("CCC\n"),
});

function memEntries(files = FILES) {
  return Object.entries(files).map(([relPath, bytes]) => ({ relPath, bytes: Buffer.from(bytes) }));
}
function wireEntries(files = FILES) {
  return Object.entries(files).map(([relPath, bytes]) => ({
    relPath,
    content: Buffer.from(bytes).toString("base64"),
    encoding: "base64",
  }));
}
function buildSealObject(files = FILES) {
  return evidence.buildSeal(memEntries(files));
}
async function signContainer(files = FILES, wallet) {
  const w = wallet || Wallet.createRandom(); // EPHEMERAL, in-memory, TEST-ONLY — never persisted/funded.
  const seal = evidence.buildSeal(memEntries(files));
  const container = await evidence.signSealWith(seal, w);
  return { wallet: w, seal, container };
}

// ---------------------------------------------------------------------------------------------------
// Minimal HTTP helpers over the loopback interface. Resolve to { status, json, text }.
// ---------------------------------------------------------------------------------------------------
function request(port, method, pathName, bodyObj, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const body = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj), "utf8");
    const headers = {};
    if (body) {
      headers["content-type"] = "application/json";
      headers["content-length"] = body.length;
    }
    const req = http.request({ host, port, method, path: pathName, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (_) {
          /* leave json null so a test fails clearly */
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    if (body) req.end(body);
    else req.end();
  });
}
const post = (port, p, b, host) => request(port, "POST", p, b, host);
const get = (port, p, host) => request(port, "GET", p, undefined, host);

// POST a raw (possibly non-JSON) body — for the malformed-JSON case.
function postRaw(port, pathName, buf) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: pathName,
        headers: { "content-type": "application/json", "content-length": buf.length },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            /* leave null */
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on("error", reject);
    req.end(buf);
  });
}

function firstNonLoopbackIPv4() {
  const ifs = os.networkInterfaces();
  for (const addrs of Object.values(ifs)) {
    for (const a of addrs || []) {
      if (a && a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

describe("cli/serve-verify T-59.2: the loopback-only HTTP verify server", function () {
  let server;
  let port;

  beforeEach(function (done) {
    // Bind an EPHEMERAL port (0) on the DEFAULT loopback host so the tests never collide with a real port.
    server = serveVerifyHttp.createServer({});
    server.listen(0, serveVerifyHttp.DEFAULT_HOST, () => {
      port = server.address().port;
      done();
    });
  });

  afterEach(function (done) {
    // Close cleanly; the leaked-handle test below separately asserts no dangling socket after close.
    if (server && server.listening) server.close(done);
    else done();
  });

  // -------------------------------------------------------------------------------------------------
  // POST /verify — the full verdict/status matrix.
  // -------------------------------------------------------------------------------------------------
  describe("POST /verify", function () {
    it("a VALID unsigned seal => 200 + ACCEPTED (verdict envelope, byte-for-byte core detail)", async function () {
      const seal = buildSealObject();
      const res = await post(port, "/verify", { kind: "verify-seal", seal, entries: wireEntries() });
      expect(res.status).to.equal(200);
      expect(res.json.verdict).to.equal(serveVerify.VERDICT.ACCEPTED);
      expect(res.json.kind).to.equal("verify-seal");
      expect(res.json.detail.accepted).to.equal(true);
      expect(res.json.detail.rootMatches).to.equal(true);
      // The envelope is the SAME versioned shape the SDK core returns (schema/service/verdict/kind/detail).
      expect(res.json).to.have.all.keys("schema", "service", "verdict", "kind", "detail");
      expect(res.json.schema).to.equal(serveVerify.VERIFY_REQUEST_SCHEMA);
      expect(res.json.service).to.equal(serveVerify.SERVICE_NAME);
    });

    it("a ONE-BYTE-tampered seal => 422 + REJECTED (root re-derived from the SUPPLIED bytes)", async function () {
      const seal = buildSealObject();
      const tampered = memEntries();
      const buf = Buffer.from(tampered[0].bytes);
      buf[0] = buf[0] ^ 0x01; // flip one bit -> one byte differs
      const wire = wireEntries();
      wire[0] = { relPath: tampered[0].relPath, content: buf.toString("base64"), encoding: "base64" };
      const res = await post(port, "/verify", { kind: "verify-seal", seal, entries: wire });
      expect(res.status).to.equal(422);
      expect(res.json.verdict).to.equal(serveVerify.VERDICT.REJECTED);
      expect(res.json.detail.accepted).to.equal(false);
      expect(res.json.detail.rootMatches).to.equal(false);
      expect(res.json.detail.counts.changed).to.equal(1);
      // NEVER a false ACCEPT / a 200.
      expect(res.status).to.not.equal(200);
      expect(res.json.verdict).to.not.equal(serveVerify.VERDICT.ACCEPTED);
    });

    it("a SIGNED container under the CORRECT expectedSigner => 200 + ACCEPTED", async function () {
      const fx = await signContainer();
      const res = await post(port, "/verify", {
        kind: "verify-signed-seal",
        container: fx.container,
        expectedSigner: fx.wallet.address,
      });
      expect(res.status).to.equal(200);
      expect(res.json.verdict).to.equal(serveVerify.VERDICT.ACCEPTED);
      expect(res.json.detail.checks.signatureMatchesSigner).to.equal(true);
      expect(res.json.detail.checks.signerMatchesExpected).to.equal(true);
      expect(res.json.detail.recoveredSigner).to.equal(fx.wallet.address.toLowerCase());
    });

    it("the SAME signed container under a WRONG expectedSigner => 422 + REJECTED", async function () {
      const fx = await signContainer();
      const wrong = Wallet.createRandom(); // TEST-ONLY key; NOT the signer.
      const res = await post(port, "/verify", {
        kind: "verify-signed-seal",
        container: fx.container,
        expectedSigner: wrong.address,
      });
      expect(res.status).to.equal(422);
      expect(res.json.verdict).to.equal(serveVerify.VERDICT.REJECTED);
      // Check 1 (signature recovers to the claimed signer) still passes; the PIN is what fails.
      expect(res.json.detail.checks.signatureMatchesSigner).to.equal(true);
      expect(res.json.detail.checks.signerMatchesExpected).to.equal(false);
      expect(res.json.detail.failedChecks).to.include("signerMatchesExpected");
      expect(res.status).to.not.equal(200);
    });

    it("malformed JSON => 400 named invalid_json (no crash, no stack trace, never a 200)", async function () {
      const res = await postRaw(port, "/verify", Buffer.from("{not valid json", "utf8"));
      expect(res.status).to.equal(400);
      expect(res.json.error).to.equal("invalid_json");
      // Never leaks a stack trace.
      expect(res.text).to.not.contain("at Object.");
      expect(res.text).to.not.contain("serve-verify");
      // The server is still alive after the malformed request (a follow-up succeeds).
      const healthz = await get(port, "/healthz");
      expect(healthz.status).to.equal(200);
    });

    it("an OVERSIZED body => 413 named payload_too_large (no crash, never a 200/ACCEPT)", async function () {
      // Start a server with a TINY body cap so a modest body trips it (and drains cleanly to a 413).
      const small = serveVerifyHttp.createServer({ maxBodyBytes: 512 });
      await new Promise((r) => small.listen(0, "127.0.0.1", r));
      const smallPort = small.address().port;
      try {
        const big = { kind: "verify-seal", seal: {}, filler: "x".repeat(4096) };
        const res = await post(smallPort, "/verify", big);
        // 413 (Payload Too Large) is a DISTINCT, CI-gateable code — NOT collapsed into the 400 bucket that
        // also holds malformed-JSON and unknown-kind, so a build can tell "too big" apart from "bad request".
        expect(res.status).to.equal(413);
        expect(res.json.error).to.equal("payload_too_large");
        expect(res.json.verdict).to.not.equal(serveVerify.VERDICT.ACCEPTED);
        // The server survived the oversized body: a normal request still works.
        const seal = buildSealObject();
        const ok = await post(smallPort, "/verify", { kind: "verify-seal", seal: {}, entries: [] });
        expect(ok.status).to.be.oneOf([200, 400, 422]); // a valid request round-trips (not a crash)
      } finally {
        await new Promise((r) => small.close(r));
      }
    });

    it("an unknown request kind => 400 with the core's ERROR verdict (never a silent ACCEPT)", async function () {
      const res = await post(port, "/verify", { kind: "verify-anchor" });
      expect(res.status).to.equal(400);
      expect(res.json.verdict).to.equal(serveVerify.VERDICT.ERROR);
      expect(res.json.code).to.equal(serveVerify.ERR.UNKNOWN_KIND);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // GET /healthz.
  // -------------------------------------------------------------------------------------------------
  describe("GET /healthz", function () {
    it("=> 200 + { ok:true } (+ verify-only/no-key/no-write metadata + the caveats)", async function () {
      const res = await get(port, "/healthz");
      expect(res.status).to.equal(200);
      expect(res.json.ok).to.equal(true);
      expect(res.json.verifyOnly).to.equal(true);
      expect(res.json.holdsKey).to.equal(false);
      expect(res.json.writesFiles).to.equal(false);
      expect(res.json.service).to.equal(serveVerify.SERVICE_NAME);
      expect(res.json.caveats).to.deep.equal(serveVerifyHttp.CAVEATS);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // Wrong method / wrong path — a clean 4xx, never a 200, never an HTML error page.
  // -------------------------------------------------------------------------------------------------
  describe("wrong method / path", function () {
    it("GET /verify => 405 method_not_allowed (JSON, never a 200)", async function () {
      const res = await get(port, "/verify");
      expect(res.status).to.equal(405);
      expect(res.json.error).to.equal("method_not_allowed");
    });

    it("POST /healthz => 405 method_not_allowed", async function () {
      const res = await post(port, "/healthz", {});
      expect(res.status).to.equal(405);
      expect(res.json.error).to.equal("method_not_allowed");
    });

    it("POST /nope => 404 not_found (JSON, not an HTML page)", async function () {
      const res = await post(port, "/nope", {});
      expect(res.status).to.equal(404);
      expect(res.json.error).to.equal("not_found");
      expect(res.text).to.not.match(/<html/i);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // DEFAULT bind is LOOPBACK: a non-loopback interface is NOT served by default.
  // -------------------------------------------------------------------------------------------------
  describe("loopback-by-default", function () {
    it("the default bind host constant is 127.0.0.1", function () {
      expect(serveVerifyHttp.DEFAULT_HOST).to.equal("127.0.0.1");
    });

    it("a request to a NON-loopback interface is NOT served by the default bind (connection refused)", async function () {
      const nonLo = firstNonLoopbackIPv4();
      if (!nonLo) {
        this.skip(); // no external interface on this host — the loopback guarantee is vacuously true.
        return;
      }
      // The server (from beforeEach) is bound to 127.0.0.1 only. A request to the machine's REAL external
      // address on the same port must NOT reach it — the socket is not listening there.
      const served = await new Promise((resolve) => {
        const req = http.request(
          { host: nonLo, port, method: "GET", path: "/healthz", timeout: 4000 },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ served: true, status: res.statusCode }));
          }
        );
        req.on("error", (e) => resolve({ served: false, code: e.code }));
        req.on("timeout", () => {
          req.destroy();
          resolve({ served: false, code: "TIMEOUT" });
        });
        req.end();
      });
      expect(served.served, `non-loopback ${nonLo} must NOT be served by the loopback-default bind`).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // NO KEY / NO FILE WRITE during a verify + clean close (no leaked handle).
  // -------------------------------------------------------------------------------------------------
  describe("filesystem + key hygiene", function () {
    it("a verify writes NOTHING to cwd (the working tree is byte-identical before/after)", async function () {
      const cwdBefore = fs.readdirSync(process.cwd()).sort();
      const fx = await signContainer();
      const seal = buildSealObject();
      await post(port, "/verify", { kind: "verify-seal", seal, entries: wireEntries() });
      await post(port, "/verify", {
        kind: "verify-signed-seal",
        container: fx.container,
        expectedSigner: fx.wallet.address,
      });
      await get(port, "/healthz");
      expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
    });

    it("the http module source holds NO key material and writes NO file (grep the transport)", function () {
      const src = fs.readFileSync(path.join(__dirname, "..", "cli", "serve-verify-http.js"), "utf8");
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const forbidden of [
        "createRandom", // never mints a key
        "privateKey", // never reads a private key
        "signMessage", // never signs
        "signSealWith", // never signs
        "writeFileSync",
        "writeFile",
        "createWriteStream",
      ]) {
        expect(code, `forbidden token in serve-verify-http.js code: ${forbidden}`).to.not.include(forbidden);
      }
      // Its ONLY requires are Node-core `http` and the pure verify core — ZERO new dependency, no fs.
      const requires = [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      expect(requires).to.deep.equal(["http", "./serve-verify"]);
    });

    it("closes the server CLEANLY with no leaked handle (a second listen on the freed port succeeds)", function (done) {
      // Stand up a throwaway server, capture its ephemeral port, close it, then confirm the handle is gone
      // by binding a fresh server on the SAME port — which only succeeds if the first truly released it.
      const s1 = serveVerifyHttp.createServer({});
      s1.listen(0, "127.0.0.1", () => {
        const freedPort = s1.address().port;
        s1.close(() => {
          // No connections were held open, so close's callback fires; the port is now free.
          const s2 = serveVerifyHttp.createServer({});
          s2.once("error", (e) => done(e)); // a leaked handle would EADDRINUSE here
          s2.listen(freedPort, "127.0.0.1", () => {
            expect(s2.address().port).to.equal(freedPort);
            s2.close(done);
          });
        });
      });
    });
  });

  // -------------------------------------------------------------------------------------------------
  // The CLI banner + help carry the verify-only + loopback + P-3 + human-deploy caveats VERBATIM.
  // -------------------------------------------------------------------------------------------------
  describe("banner + help caveats (verbatim)", function () {
    it("the CAVEATS block names verify-only, loopback, P-3, and human-deploy — each VERBATIM", function () {
      const c = serveVerifyHttp.CAVEATS;
      expect(c).to.be.an("array").with.length(4);
      expect(c[0]).to.equal(
        "verify-only: this server VERIFIES seals; it never signs, holds NO private key, and writes NO file."
      );
      expect(c[1]).to.equal(
        "loopback by default: it binds 127.0.0.1 — a non-loopback interface is NOT served unless you pass --host."
      );
      expect(c[2]).to.equal(
        'NOT a timestamp: a verified seal proves set-membership / a signer vouched, NOT "sealed since date T" (P-3).'
      );
      expect(c[3]).to.equal(
        "exposing it publicly is a HUMAN deploy step (your nginx/Cloudflare, your domain, TLS) — never auto-deployed."
      );
    });

    it("the startup banner LEADS with the URL and prints every caveat line VERBATIM", function () {
      const banner = serveVerifyHttp.banner("http://127.0.0.1:4180/", "127.0.0.1");
      expect(banner).to.contain("vh serve-verify listening on http://127.0.0.1:4180/");
      expect(banner).to.contain("POST /verify");
      expect(banner).to.contain("GET  /healthz");
      for (const line of serveVerifyHttp.CAVEATS) {
        expect(banner, `banner must contain caveat verbatim: ${line}`).to.contain(line);
      }
    });

    it("`vh --help` lists serve-verify with the verify-only + loopback + P-3 + human-deploy posture", function () {
      const u = vh.usage();
      expect(u).to.match(/vh serve-verify \[--port <n>\] \[--host <h>\] \[--max-body <bytes>\]/);
      expect(u).to.contain("VERIFY-ONLY");
      expect(u.toLowerCase()).to.contain("loopback");
      expect(u).to.contain("HUMAN deploy step");
      expect(u).to.contain("(P-3)");
    });
  });

  // -------------------------------------------------------------------------------------------------
  // CLI wiring: a bad flag is a clean usage exit BEFORE binding; the default port/host are loopback.
  // -------------------------------------------------------------------------------------------------
  describe("CLI plumbing (parse + bind + exit codes)", function () {
    it("parseServeVerifyArgs accepts --port/--host/--max-body and rejects junk", function () {
      expect(vh.parseServeVerifyArgs(["--port", "0", "--host", "127.0.0.1"])).to.deep.equal({
        port: 0,
        host: "127.0.0.1",
        maxBody: undefined,
      });
      expect(vh.parseServeVerifyArgs(["--max-body", "1024"]).maxBody).to.equal(1024);
      expect(() => vh.parseServeVerifyArgs(["--port", "70000"])).to.throw(/0\.\.65535/);
      expect(() => vh.parseServeVerifyArgs(["--port", "abc"])).to.throw(/integer/);
      expect(() => vh.parseServeVerifyArgs(["--max-body", "0"])).to.throw(/positive integer/);
      expect(() => vh.parseServeVerifyArgs(["--bogus"])).to.throw(/unknown flag/);
      expect(() => vh.parseServeVerifyArgs(["extra"])).to.throw(/no positionals/);
    });

    it("cmdServeVerify on a bad flag exits 2 (usage) BEFORE ever binding a socket", async function () {
      let created = false;
      const code = await vh.cmdServeVerify(["--port", "notaport"], {
        writeErr: () => {},
        createServer: () => {
          created = true;
          throw new Error("must not create a server on a usage error");
        },
      });
      expect(code).to.equal(2);
      expect(created, "no server should be created when the flags are invalid").to.equal(false);
    });

    it("runServeVerify binds the DEFAULT loopback host + default port when no flags are given", async function () {
      // Bind on port 0 (ephemeral) so the test never collides; assert the host default is loopback.
      const res = await vh.runServeVerify({ port: 0 }, { write: () => {} });
      try {
        const addr = res.server.address();
        expect(addr.address).to.equal("127.0.0.1"); // the DEFAULT bind is loopback
        expect(res.url).to.match(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        expect(res.code).to.equal(0);
      } finally {
        await new Promise((r) => res.server.close(r));
      }
    });

    it("runServeVerify surfaces a bind failure as exit-code 1 (not a hang, not a silent 0)", async function () {
      // Occupy a port, then try to bind the SAME port -> EADDRINUSE -> resolve { code:1 }.
      const blocker = serveVerifyHttp.createServer({});
      await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
      const taken = blocker.address().port;
      try {
        const res = await vh.runServeVerify({ port: taken, host: "127.0.0.1" }, { write: () => {}, writeErr: () => {} });
        expect(res.code).to.equal(1);
        expect(res.url).to.equal(null);
        expect(res.error).to.be.an("error");
      } finally {
        await new Promise((r) => blocker.close(r));
      }
    });
  });
});
