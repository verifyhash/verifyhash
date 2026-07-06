"use strict";

// T-62.2 — `vh fulfill-webhook`: a tiny, dependency-free (Node-core `http` ONLY) LOOPBACK-only HTTP
// FULFILLMENT webhook that wires the pure intake core (T-62.1) to the shipped evidence license fulfiller.
// It is the DROP-IN that removes the human's last CODE step: a signed billing event in, a delivered license
// out. These tests drive the REAL http.Server end-to-end over `http` on 127.0.0.1 and prove the acceptance:
//
//   (1) a correctly-signed POST carrying a Stripe-shaped paid event delivers a signed *.vhlicense.json to
//       --out that PASSES the existing free-vs-paid gate (evidence.verifyLicense AND a real
//       `vh evidence seal --sign --license <delivered> --vendor <addr>` run) for the plan the --binding maps
//       the price to, responding 200 { delivered, licenseId };
//   (2) an UNSIGNED / FORGED / STALE POST responds 4xx with the localized reason and delivers NOTHING
//       (fail-closed);
//   (3) an OVERSIZED body (> --max-body) and a MALFORMED / UNKNOWN-type body are NAMED-rejected without
//       fulfilling;
//   (4) re-POSTing the SAME event returns the SAME licenseId (idempotent — no duplicate license);
//   (5) guardrails — the server binds loopback by default, makes no outbound request, and the vendor
//       key/secret come only from the injected wallet/secret and are NEVER written to disk or logs.
//
// Every signing key is an EPHEMERAL in-process `Wallet.createRandom()` (TEST-ONLY, never a real key / real
// funds); the signing secret is a SYNTHETIC "whsec_TEST_..." string; the wall clock is INJECTED so the whole
// run is deterministic. Every filesystem effect is isolated to a throwaway temp dir and the working tree
// (cwd) is asserted UNTOUCHED, pass or fail.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Wallet } = require("ethers");

const evidence = require("../cli/evidence");
const evidencePlans = require("../cli/core/evidence-plans");
const intake = require("../cli/core/fulfill-intake");
const fw = require("../cli/fulfill-webhook-http");
const vh = require("../cli/vh");

const { EXIT } = evidence;

// ---------------------------------------------------------------------------
// Fixtures — the bundled DRAFT evidence catalog + a price binding onto its two plans. The TEST does the I/O.
// ---------------------------------------------------------------------------
const BASELINE_TEXT = fs.readFileSync(evidence.BUNDLED_EVIDENCE_CATALOG, "utf8");

// A SYNTHETIC signing secret — never a real Stripe secret.
const SECRET = "whsec_TEST_0123456789abcdef0123456789abcdef";

// Pinned, injected clock (ms). 2026-06-01 is between issue and periodEnd.
const NOW_MS = Date.parse("2026-06-01T00:00:00.000Z");
const NOW_SEC = Math.floor(NOW_MS / 1000);
const IN_WINDOW = new Date("2026-07-01T00:00:00.000Z"); // between issuedAt and periodEnd, for the seal gate

// 1798761600 == 2027-01-01T00:00:00.000Z as a UNIX epoch in SECONDS.
const PERIOD_END_EPOCH = 1798761600;

function catalog() {
  return evidencePlans.validateEvidencePlanCatalog(JSON.parse(BASELINE_TEXT));
}
function bindingObj() {
  return {
    kind: intake.EVIDENCE_PRICE_BINDING_KIND,
    schemaVersion: 1,
    mappings: [
      { provider: "stripe", priceId: "price_evidence_pro_annual", planId: "evidence-pro-annual" },
      { provider: "stripe", priceId: "price_evidence_signed_monthly", planId: "evidence-signed-monthly" },
    ],
  };
}
function binding() {
  return intake.validateEvidencePriceBinding(bindingObj(), catalog());
}

// Real-shaped Stripe `invoice.paid` body -> price_evidence_pro_annual by default.
function invoicePaidBody(over = {}) {
  return JSON.stringify({
    id: "evt_invoice_1",
    object: "event",
    type: "invoice.paid",
    data: {
      object: {
        id: "in_123",
        object: "invoice",
        customer: over.customer || "cus_ACME",
        lines: {
          object: "list",
          data: [
            {
              id: "il_1",
              price: { id: over.priceId || "price_evidence_pro_annual", object: "price" },
              period: { start: 1735689600, end: over.periodEnd || PERIOD_END_EPOCH },
            },
          ],
        },
      },
    },
  });
}

// Real-shaped Stripe `checkout.session.completed` body (subscription EXPANDED) -> price_evidence_signed_monthly.
function checkoutCompletedBody(over = {}) {
  return JSON.stringify({
    id: "evt_checkout_1",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_123",
        object: "checkout.session",
        customer: over.customer || "cus_BETA",
        mode: "subscription",
        subscription: {
          id: "sub_123",
          object: "subscription",
          current_period_end: over.periodEnd || PERIOD_END_EPOCH,
          items: {
            object: "list",
            data: [{ id: "si_1", price: { id: over.priceId || "price_evidence_signed_monthly", object: "price" } }],
          },
        },
      },
    },
  });
}

// Compute the Stripe `t=..,v1=..` header the SAME way Stripe does, so acceptance is proven against an
// EXTERNAL construction (not the module's own signer).
function signHeader(rawBody, secret, t) {
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

// ---------------------------------------------------------------------------
// Minimal HTTP client over loopback. Resolves to { status, json, text }.
// ---------------------------------------------------------------------------
function request(port, method, pathName, rawBody, headers = {}, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const buf = rawBody == null ? null : Buffer.from(rawBody, "utf8");
    const h = Object.assign({}, headers);
    if (buf) h["content-length"] = buf.length;
    const req = http.request({ host, port, method, path: pathName, headers: h, timeout: 4000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (_) {
          /* leave null so a test fails clearly */
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timed out"));
    });
    if (buf) req.end(buf);
    else req.end();
  });
}
// POST a signed event: sign the exact body with SECRET at NOW_SEC and attach the header.
function postSigned(port, rawBody, { secret = SECRET, t = NOW_SEC, header } = {}) {
  const sig = header !== undefined ? header : signHeader(rawBody, secret, t);
  const headers = {};
  if (sig !== null) headers["stripe-signature"] = sig;
  return request(port, "POST", fw.FULFILL_PATH, rawBody, headers);
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

describe("cli/fulfill-webhook T-62.2: the loopback-only HTTP fulfillment webhook", function () {
  let server;
  let port;
  let wallet;
  let outDir;
  let tmpDirs;
  let cwdBefore;
  let bannerText;

  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "fw-"));
    tmpDirs.push(d);
    return d;
  }

  beforeEach(function (done) {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
    wallet = Wallet.createRandom(); // EPHEMERAL, TEST-ONLY — never a real key/funds.
    outDir = mkTmp();
    bannerText = "";
    server = fw.createServer({
      wallet,
      secret: SECRET,
      binding: binding(),
      catalog: catalog(),
      outDir,
      now: () => NOW_MS, // INJECTED clock: deterministic issuedAt + replay window.
    });
    server.listen(0, fw.DEFAULT_HOST, () => {
      port = server.address().port;
      done();
    });
  });

  afterEach(function (done) {
    const finish = () => {
      for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
      // FILESYSTEM HYGIENE: nothing leaked into the working tree.
      expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
      done();
    };
    if (server && server.listening) server.close(finish);
    else finish();
  });

  // -------------------------------------------------------------------------
  // (1) A correctly-signed paid event delivers a license the gate accepts.
  // -------------------------------------------------------------------------
  describe("(1) a signed paid event delivers a gate-passing license", function () {
    it("invoice.paid -> 200 { delivered, licenseId }; delivered file PASSES verifyLicense for the mapped plan", async function () {
      const body = invoicePaidBody(); // -> price_evidence_pro_annual
      const res = await postSigned(port, body);
      expect(res.status).to.equal(200);
      expect(res.json.delivered).to.equal(true);
      expect(res.json.idempotent).to.equal(false);
      expect(res.json.licenseId).to.be.a("string").and.to.have.length.above(0);
      expect(res.json.plan).to.equal("evidence-pro-annual");

      // EXACTLY one delivered file, named *.vhlicense.json.
      const files = fs.readdirSync(outDir);
      expect(files).to.have.length(1);
      expect(files[0]).to.match(/\.vhlicense\.json$/);

      // The delivered license PASSES the free-vs-paid gate for the mapped plan.
      const container = evidence.readLicense(fs.readFileSync(path.join(outDir, files[0]), "utf8"));
      const verdict = evidence.verifyLicense(container, { now: IN_WINDOW, vendorAddress: wallet.address });
      expect(verdict.valid).to.equal(true);
      // Entitlements are the RESOLVED plan's, verbatim (never re-typed).
      const plan = catalog().plansById["evidence-pro-annual"];
      expect(verdict.entitlements).to.deep.equal(plan.entitlements);
      for (const flag of plan.entitlements) expect(evidence.hasEntitlement(verdict, flag)).to.equal(true);
      // The payload window: issuedAt = injected now; expiresAt = periodEnd's canonical ISO.
      expect(JSON.parse(container.attestation).expiresAt).to.equal("2027-01-01T00:00:00.000Z");
    });

    it("checkout.session.completed maps to the OTHER plan the --binding routes its price to", async function () {
      const body = checkoutCompletedBody(); // -> price_evidence_signed_monthly
      const res = await postSigned(port, body);
      expect(res.status).to.equal(200);
      expect(res.json.plan).to.equal("evidence-signed-monthly");
      const files = fs.readdirSync(outDir);
      const container = evidence.readLicense(fs.readFileSync(path.join(outDir, files[0]), "utf8"));
      const verdict = evidence.verifyLicense(container, { now: IN_WINDOW, vendorAddress: wallet.address });
      expect(verdict.entitlements).to.deep.equal(catalog().plansById["evidence-signed-monthly"].entitlements);
    });

    it("END-TO-END: the delivered license UNLOCKS the real `vh evidence seal --sign` gate", async function () {
      const body = invoicePaidBody(); // evidence-pro-annual grants evidence_signed (what --sign needs)
      const res = await postSigned(port, body);
      expect(res.status).to.equal(200);
      const licenseFile = res.json.out;
      expect(fs.existsSync(licenseFile)).to.equal(true);

      // A directory to seal + sign, and a FRESH operator key (independent of the vendor key).
      const srcDir = path.join(mkTmp(), "src");
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, "a.txt"), "alpha");
      const signWallet = Wallet.createRandom();
      const signEnv = "VH_FW_TEST_SIGN_KEY";
      process.env[signEnv] = signWallet.privateKey;
      const out = [];
      const io = {
        write: (s) => out.push(s),
        writeErr: (s) => out.push(s),
        now: IN_WINDOW,
        // T-75.3: the ephemeral webhook vendor is THIS run's CANONICAL identity (programmatic seam).
        canonicalVendor: wallet.address,
      };
      let code;
      try {
        code = await evidence.cmdEvidence(
          ["seal", srcDir, "--sign", "--key-env", signEnv, "--license", licenseFile, "--vendor", wallet.address, "--json"],
          io
        );
      } finally {
        delete process.env[signEnv];
      }
      // Exit 0 proves the delivered license unlocked the PAID surface end-to-end.
      expect(code).to.equal(EXIT.OK);
      expect(JSON.parse(out.join("")).signed).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // (2) fail-closed: unsigned / forged / stale -> 4xx, delivers NOTHING.
  // -------------------------------------------------------------------------
  describe("(2) fail-closed: unsigned / forged / stale delivers NOTHING", function () {
    it("an UNSIGNED POST (no Stripe-Signature header) => 4xx signature_rejected, no file", async function () {
      const body = invoicePaidBody();
      const res = await postSigned(port, body, { header: null });
      expect(res.status).to.be.within(400, 499);
      expect(res.json.error).to.equal("signature_rejected");
      expect(res.json.message.toLowerCase()).to.match(/unsigned|delivering nothing/);
      expect(fs.readdirSync(outDir)).to.have.length(0);
    });

    it("a FORGED signature (wrong secret, same-length hex) => 401 signature_rejected, no file", async function () {
      const body = invoicePaidBody();
      const res = await postSigned(port, body, { secret: "whsec_TEST_WRONG_SECRET" });
      expect(res.status).to.equal(401);
      expect(res.json.error).to.equal("signature_rejected");
      expect(fs.readdirSync(outDir)).to.have.length(0);
    });

    it("a STALE timestamp (correctly signed but outside the replay window) => 401, no file", async function () {
      const body = invoicePaidBody();
      const res = await postSigned(port, body, { t: NOW_SEC - 10000 }); // far outside default 300s tolerance
      expect(res.status).to.equal(401);
      expect(res.json.error).to.equal("signature_rejected");
      expect(res.json.message.toLowerCase()).to.match(/stale|replay|window|tolerance/);
      expect(fs.readdirSync(outDir)).to.have.length(0);
    });

    it("a MALFORMED signature header (t but no v1) => 400 signature_rejected, no file", async function () {
      const body = invoicePaidBody();
      const res = await postSigned(port, body, { header: `t=${NOW_SEC}` });
      expect(res.status).to.equal(400);
      expect(res.json.error).to.equal("signature_rejected");
      expect(fs.readdirSync(outDir)).to.have.length(0);
    });

    it("a TAMPERED body under an otherwise-valid signature => 401, no file", async function () {
      const body = invoicePaidBody();
      const header = signHeader(body, SECRET, NOW_SEC);
      const tampered = body.replace("cus_ACME", "cus_ATTACKER");
      const res = await request(port, "POST", fw.FULFILL_PATH, tampered, { "stripe-signature": header });
      expect(res.status).to.equal(401);
      expect(res.json.error).to.equal("signature_rejected");
      expect(fs.readdirSync(outDir)).to.have.length(0);
    });
  });

  // -------------------------------------------------------------------------
  // (3) oversized + malformed/unknown-type are NAMED-rejected without fulfilling.
  // -------------------------------------------------------------------------
  describe("(3) oversized + malformed/unknown-type are NAMED-rejected", function () {
    it("an OVERSIZED body (> --max-body) => 413 payload_too_large, no file, server survives", async function () {
      // A dedicated server with a TINY cap so a modest body trips it.
      const dir = mkTmp();
      const small = fw.createServer({
        wallet,
        secret: SECRET,
        binding: binding(),
        catalog: catalog(),
        outDir: dir,
        maxBodyBytes: 256,
        now: () => NOW_MS,
      });
      await new Promise((r) => small.listen(0, "127.0.0.1", r));
      const smallPort = small.address().port;
      try {
        const big = invoicePaidBody({ customer: "cus_" + "x".repeat(4096) });
        const res = await postSigned(smallPort, big); // signed, but oversized
        expect(res.status).to.equal(413);
        expect(res.json.error).to.equal("payload_too_large");
        expect(fs.readdirSync(dir)).to.have.length(0);
        // The server survived: a well-formed small request still works.
        const ok = await request(smallPort, "GET", "/healthz", null);
        expect(ok.status).to.equal(200);
      } finally {
        await new Promise((r) => small.close(r));
      }
    });

    it("a MALFORMED JSON body (signed) => 400 invalid_event, no file", async function () {
      const bad = "{ not json ";
      const res = await request(port, "POST", fw.FULFILL_PATH, bad, {
        "stripe-signature": signHeader(bad, SECRET, NOW_SEC),
      });
      expect(res.status).to.equal(400);
      expect(res.json.error).to.equal("invalid_event");
      expect(fs.readdirSync(outDir)).to.have.length(0);
    });

    it("an UNKNOWN event type (signed) => 400 invalid_event naming it, no file", async function () {
      const body = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { customer: "cus_X" } } });
      const res = await request(port, "POST", fw.FULFILL_PATH, body, {
        "stripe-signature": signHeader(body, SECRET, NOW_SEC),
      });
      expect(res.status).to.equal(400);
      expect(res.json.error).to.equal("invalid_event");
      expect(res.json.message).to.match(/unsupported event type/);
      expect(fs.readdirSync(outDir)).to.have.length(0);
    });

    it("a DUPLICATE-key body (a JSON smuggling vector) => 400 invalid_event, no file", async function () {
      const smuggled =
        '{"type":"account.updated","type":"invoice.paid","data":{"object":{"customer":"cus_X"}}}';
      const res = await request(port, "POST", fw.FULFILL_PATH, smuggled, {
        "stripe-signature": signHeader(smuggled, SECRET, NOW_SEC),
      });
      expect(res.status).to.equal(400);
      expect(res.json.message).to.match(/duplicate object key/);
      expect(fs.readdirSync(outDir)).to.have.length(0);
    });

    it("an AUTHENTIC event whose price maps to NO plan => 422 unfulfillable, no file", async function () {
      const body = invoicePaidBody({ priceId: "price_not_in_binding" });
      const res = await postSigned(port, body);
      expect(res.status).to.equal(422);
      expect(res.json.error).to.equal("unfulfillable");
      expect(fs.readdirSync(outDir)).to.have.length(0);
    });
  });

  // -------------------------------------------------------------------------
  // (4) idempotent: re-POST the SAME event -> SAME licenseId, no duplicate.
  // -------------------------------------------------------------------------
  describe("(4) idempotent delivery", function () {
    it("re-POSTing the SAME event returns the SAME licenseId and writes NO duplicate", async function () {
      const body = invoicePaidBody();
      const a = await postSigned(port, body);
      expect(a.status).to.equal(200);
      expect(a.json.idempotent).to.equal(false);
      expect(fs.readdirSync(outDir)).to.have.length(1);

      // Re-deliver the SAME event (an at-least-once retry). Even signed at a DIFFERENT valid timestamp, the
      // dedup key is on the event content (not the clock), so it returns the SAME license.
      const b = await postSigned(port, body, { t: NOW_SEC + 5 });
      expect(b.status).to.equal(200);
      expect(b.json.delivered).to.equal(true);
      expect(b.json.idempotent).to.equal(true);
      expect(b.json.licenseId).to.equal(a.json.licenseId);
      // No second file.
      expect(fs.readdirSync(outDir)).to.have.length(1);
    });

    it("a DIFFERENT customer is a DISTINCT license (a second file, a different id)", async function () {
      const a = await postSigned(port, invoicePaidBody({ customer: "cus_ONE" }));
      const b = await postSigned(port, invoicePaidBody({ customer: "cus_TWO" }));
      expect(a.json.licenseId).to.not.equal(b.json.licenseId);
      expect(fs.readdirSync(outDir)).to.have.length(2);
    });
  });

  // -------------------------------------------------------------------------
  // (5) guardrails: loopback default, no outbound, key/secret never on disk or logs.
  // -------------------------------------------------------------------------
  describe("(5) guardrails: loopback, no-outbound, key/secret hygiene", function () {
    it("the default bind host constant is 127.0.0.1 (loopback)", function () {
      expect(fw.DEFAULT_HOST).to.equal("127.0.0.1");
    });

    it("a request to a NON-loopback interface is NOT served by the default bind (connection refused)", async function () {
      const nonLo = firstNonLoopbackIPv4();
      if (!nonLo) {
        this.skip();
        return;
      }
      const served = await new Promise((resolve) => {
        const req = http.request({ host: nonLo, port, method: "GET", path: "/healthz", timeout: 3000 }, (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve(true));
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });
      expect(served, `non-loopback ${nonLo} must NOT be served by the loopback-default bind`).to.equal(false);
    });

    it("the delivered license file contains NEITHER the vendor private key NOR the signing secret", async function () {
      const res = await postSigned(port, invoicePaidBody());
      const bytes = fs.readFileSync(res.json.out, "utf8");
      expect(bytes).to.not.include(wallet.privateKey);
      expect(bytes).to.not.include(SECRET);
      // What it DOES carry is the PUBLIC signer address.
      expect(bytes.toLowerCase()).to.include(wallet.address.toLowerCase());
    });

    it("the http module source makes NO outbound request and never touches a key/secret source (grep)", function () {
      const src = fs.readFileSync(path.join(__dirname, "..", "cli", "fulfill-webhook-http.js"), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const forbidden of [
        "http.request", // never calls out
        "http.get",
        "https", // no outbound TLS
        "net.connect",
        ".connect(",
        "dns",
        "fetch(",
        "process.env", // the transport never reads env — the CLI hands in wallet+secret
        "privateKey", // never reads a private key
        "createRandom", // never mints a key
        "loadSigningWallet", // key loading is the CLI layer's job
        "console.", // never logs
      ]) {
        expect(code, `forbidden token in fulfill-webhook-http.js: ${forbidden}`).to.not.include(forbidden);
      }
      // Its ONLY requires are Node-core http/fs/path and the shipped cores — ZERO new dependency.
      const requires = [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]).sort();
      expect(requires).to.deep.equal(["./core/evidence-plans", "./core/fulfill-intake", "./evidence", "fs", "http", "path"]);
    });

    it("closes the server CLEANLY with no leaked handle (a second listen on the freed port succeeds)", function (done) {
      const s1 = fw.createServer({ wallet, secret: SECRET, binding: binding(), catalog: catalog(), outDir, now: () => NOW_MS });
      s1.listen(0, "127.0.0.1", () => {
        const freed = s1.address().port;
        s1.close(() => {
          const s2 = fw.createServer({ wallet, secret: SECRET, binding: binding(), catalog: catalog(), outDir, now: () => NOW_MS });
          s2.once("error", (e) => done(e));
          s2.listen(freed, "127.0.0.1", () => {
            expect(s2.address().port).to.equal(freed);
            s2.close(done);
          });
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // Routing + method discipline.
  // -------------------------------------------------------------------------
  describe("routing", function () {
    it("GET /fulfill => 405 method_not_allowed", async function () {
      const res = await request(port, "GET", fw.FULFILL_PATH, null);
      expect(res.status).to.equal(405);
      expect(res.json.error).to.equal("method_not_allowed");
    });
    it("POST /nope => 404 not_found (JSON, not an HTML page)", async function () {
      const res = await request(port, "POST", "/nope", "{}", { "stripe-signature": "t=1,v1=deadbeef" });
      expect(res.status).to.equal(404);
      expect(res.json.error).to.equal("not_found");
      expect(res.text).to.not.match(/<html/i);
    });
    it("GET /healthz => 200 { ok:true } (+ honest metadata + caveats)", async function () {
      const res = await request(port, "GET", "/healthz", null);
      expect(res.status).to.equal(200);
      expect(res.json.ok).to.equal(true);
      expect(res.json.holdsKey).to.equal(true); // it signs — honest
      expect(res.json.writesKeyToDisk).to.equal(false);
      expect(res.json.makesOutboundRequest).to.equal(false);
      expect(res.json.caveats).to.deep.equal(fw.CAVEATS);
    });
  });
});

// ===========================================================================
// CLI plumbing: parse + config validation + bind, WITHOUT authoring a handler by hand.
// ===========================================================================
describe("T-62.2: `vh fulfill-webhook` CLI plumbing (parse + config + exit codes)", function () {
  let tmpDirs;
  let cwdBefore;
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "fw-cli-"));
    tmpDirs.push(d);
    return d;
  }
  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });

  it("parseFulfillWebhookArgs accepts the flags and rejects junk", function () {
    const parsed = vh.parseFulfillWebhookArgs([
      "--port", "0", "--host", "127.0.0.1", "--max-body", "1024", "--tolerance", "60",
      "--secret-env", "S", "--binding", "b.json", "--key-env", "K", "--out", "d", "--catalog", "c.json",
    ]);
    expect(parsed).to.deep.equal({
      port: 0, host: "127.0.0.1", maxBody: 1024, tolerance: 60,
      secretEnv: "S", binding: "b.json", keyEnv: "K", keyFile: undefined, out: "d", catalog: "c.json",
    });
    expect(() => vh.parseFulfillWebhookArgs(["--port", "70000"])).to.throw(/0\.\.65535/);
    expect(() => vh.parseFulfillWebhookArgs(["--max-body", "0"])).to.throw(/positive integer/);
    expect(() => vh.parseFulfillWebhookArgs(["--bogus"])).to.throw(/unknown flag/);
    expect(() => vh.parseFulfillWebhookArgs(["extra"])).to.throw(/no positionals/);
    expect(() => vh.parseFulfillWebhookArgs(["--secret-env"])).to.throw(/requires a value/);
  });

  // Write a valid binding file for the config-load tests.
  function writeBinding(dir) {
    const p = path.join(dir, "binding.json");
    fs.writeFileSync(p, JSON.stringify(bindingObj()));
    return p;
  }

  it("cmdFulfillWebhook on a bad flag exits 2 (usage) BEFORE ever binding a socket", async function () {
    let created = false;
    const code = await vh.cmdFulfillWebhook(["--port", "notaport"], {
      writeErr: () => {},
      createServer: () => {
        created = true;
        throw new Error("must not create a server on a usage error");
      },
    });
    expect(code).to.equal(2);
    expect(created).to.equal(false);
  });

  it("a MISSING --secret-env / --binding / --out is a usage error (exit 2), never binding", async function () {
    for (const argv of [
      ["--binding", "b.json", "--key-env", "K", "--out", "d"], // no --secret-env
      ["--secret-env", "S", "--key-env", "K", "--out", "d"], // no --binding
      ["--secret-env", "S", "--binding", "b.json", "--key-env", "K"], // no --out
    ]) {
      const err = [];
      let created = false;
      const code = await vh.cmdFulfillWebhook(argv, {
        writeErr: (s) => err.push(s),
        createServer: () => {
          created = true;
          throw new Error("must not bind");
        },
      });
      expect(code).to.equal(2);
      expect(created).to.equal(false);
    }
  });

  it("a MISSING signing secret env var exits 2, naming only the VAR (never the value)", async function () {
    const dir = mkTmp();
    const bindingFile = writeBinding(dir);
    const secretEnv = "VH_FW_TEST_MISSING_SECRET";
    delete process.env[secretEnv];
    const keyEnv = "VH_FW_TEST_KEY_A";
    process.env[keyEnv] = Wallet.createRandom().privateKey;
    const err = [];
    let code;
    try {
      const res = await vh.runFulfillWebhook(
        { secretEnv, binding: bindingFile, keyEnv, out: dir },
        { writeErr: (s) => err.push(s), write: () => {} }
      );
      code = res.code;
    } finally {
      delete process.env[keyEnv];
    }
    expect(code).to.equal(2);
    expect(err.join("")).to.include(secretEnv);
  });

  it("NEITHER / BOTH key sources exit 2 with a key-free message", async function () {
    const dir = mkTmp();
    const bindingFile = writeBinding(dir);
    const secretEnv = "VH_FW_TEST_SECRET_B";
    process.env[secretEnv] = SECRET;
    try {
      // neither
      const neither = await vh.runFulfillWebhook(
        { secretEnv, binding: bindingFile, out: dir },
        { writeErr: () => {}, write: () => {} }
      );
      expect(neither.code).to.equal(2);
      // both
      const keyEnv = "VH_FW_TEST_KEY_B";
      const w = Wallet.createRandom();
      process.env[keyEnv] = w.privateKey;
      const keyFile = path.join(dir, "k.key");
      fs.writeFileSync(keyFile, w.privateKey);
      const err = [];
      let both;
      try {
        both = await vh.runFulfillWebhook(
          { secretEnv, binding: bindingFile, keyEnv, keyFile, out: dir },
          { writeErr: (s) => err.push(s), write: () => {} }
        );
      } finally {
        delete process.env[keyEnv];
      }
      expect(both.code).to.equal(2);
      expect(err.join("")).to.match(/mutually exclusive|EXACTLY ONE/i);
      expect(err.join("")).to.not.include(w.privateKey);
    } finally {
      delete process.env[secretEnv];
    }
  });

  it("a NON-directory --out is a usage error (exit 2), never binding to cwd", async function () {
    const dir = mkTmp();
    const bindingFile = writeBinding(dir);
    const secretEnv = "VH_FW_TEST_SECRET_C";
    process.env[secretEnv] = SECRET;
    const keyEnv = "VH_FW_TEST_KEY_C";
    process.env[keyEnv] = Wallet.createRandom().privateKey;
    const err = [];
    let code;
    try {
      const res = await vh.runFulfillWebhook(
        { secretEnv, binding: bindingFile, keyEnv, out: path.join(dir, "does-not-exist") },
        { writeErr: (s) => err.push(s), write: () => {} }
      );
      code = res.code;
    } finally {
      delete process.env[secretEnv];
      delete process.env[keyEnv];
    }
    expect(code).to.equal(2);
    expect(err.join("")).to.match(/must be an existing directory/);
  });

  it("runFulfillWebhook binds the DEFAULT loopback host + real ephemeral port with valid config", async function () {
    const dir = mkTmp();
    const bindingFile = writeBinding(dir);
    const secretEnv = "VH_FW_TEST_SECRET_D";
    process.env[secretEnv] = SECRET;
    const keyEnv = "VH_FW_TEST_KEY_D";
    process.env[keyEnv] = Wallet.createRandom().privateKey;
    const out = [];
    let res;
    try {
      res = await vh.runFulfillWebhook(
        { port: 0, secretEnv, binding: bindingFile, keyEnv, out: dir },
        { write: (s) => out.push(s), writeErr: () => {}, now: () => NOW_MS }
      );
      const addr = res.server.address();
      expect(addr.address).to.equal("127.0.0.1"); // DEFAULT bind is loopback
      expect(res.code).to.equal(0);
      expect(out.join("")).to.include("vh fulfill-webhook listening on");
      // The banner does NOT leak the secret or the key.
      expect(out.join("")).to.not.include(SECRET);
      expect(out.join("")).to.not.include(process.env[keyEnv]);
    } finally {
      if (res && res.server) await new Promise((r) => res.server.close(r));
      delete process.env[secretEnv];
      delete process.env[keyEnv];
    }
  });
});

// ===========================================================================
// Banner + help caveats VERBATIM.
// ===========================================================================
describe("T-62.2: banner + help caveats (verbatim posture)", function () {
  it("the CAVEATS block names fail-closed, loopback, access-credential, and human-deploy", function () {
    const c = fw.CAVEATS;
    expect(c).to.be.an("array").with.length(5);
    expect(c.some((l) => l.includes("loopback by default") && l.includes("127.0.0.1"))).to.equal(true);
    expect(c.some((l) => l.includes("fail-closed") && l.includes("delivers NOTHING"))).to.equal(true);
    expect(
      c.some((l) => l.includes("ACCESS credential") && l.includes("NOT a token/coin/NFT"))
    ).to.equal(true);
    expect(c.some((l) => l.includes("HUMAN deploy step") && l.includes("never auto-deployed"))).to.equal(true);
  });

  it("the startup banner leads with the URL and prints every caveat line VERBATIM", function () {
    const banner = fw.banner("http://127.0.0.1:4190/", "127.0.0.1", "/tmp/out");
    expect(banner).to.contain("vh fulfill-webhook listening on http://127.0.0.1:4190/");
    expect(banner).to.contain("POST /fulfill");
    expect(banner).to.contain("GET  /healthz");
    for (const line of fw.CAVEATS) expect(banner, `banner must contain caveat verbatim: ${line}`).to.contain(line);
  });

  it("`vh --help` lists fulfill-webhook with the fail-closed + loopback + access-credential + human-deploy posture", function () {
    const u = vh.usage();
    expect(u).to.match(/vh fulfill-webhook /);
    expect(u).to.contain("--secret-env");
    expect(u).to.contain("--binding");
    expect(u).to.contain("--out");
    expect(u.toLowerCase()).to.contain("loopback");
    expect(u).to.contain("HUMAN deploy step");
    expect(u).to.contain("(P-3)");
  });
});
