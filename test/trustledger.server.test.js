"use strict";

// TrustLedger — server.js tests (T-27.1).
//
// EPIC-27 is the web front-door over the (complete) CLI engine. These tests prove
// the door behaves: they START the real http.Server on an EPHEMERAL port, POST the
// SAME e2e fixture CONTENTS the CLI tests use, and assert the engine answer comes
// back over HTTP byte-for-byte (tiesOut + the three balances), that a short rent
// roll comes back OUT OF TRUST, and that a malformed file is a NAMED 400 (never a
// stack trace). Then they CLOSE the server. Full filesystem isolation: the server
// writes NOTHING to disk, so the test also asserts the working tree is untouched.

const { expect } = require("chai");
const fs = require("fs");
const http = require("http");
const path = require("path");

const { createServer } = require("../trustledger/server");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures", "e2e");
const BANK = fs.readFileSync(path.join(FIX, "bank.csv"), "utf8");
const BOOK = fs.readFileSync(path.join(FIX, "quickbooks.csv"), "utf8");
const RENT = fs.readFileSync(path.join(FIX, "rentroll.csv"), "utf8");
const RENT_SHORT = fs.readFileSync(path.join(FIX, "rentroll.short.csv"), "utf8");

const DATE = "2026-06-24"; // pinned so the server core stays deterministic

// Minimal POST helper over the loopback interface. Resolves to { status, json }.
function post(port, pathName, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(bodyObj), "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: pathName,
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
        },
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
            /* leave json null so a test can fail clearly */
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

function get(port, pathName) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: pathName },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            type: res.headers["content-type"],
            text: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("trustledger server: a stdlib HTTP door over the engine", function () {
  let server;
  let port;

  beforeEach(function (done) {
    // today() is injected so the in-memory reconcile stays deterministic.
    server = createServer({ today: () => DATE });
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port; // EPHEMERAL port
      done();
    });
  });

  afterEach(function (done) {
    server.close(done);
  });

  it("GET / serves the static upload page (no framework, with the disclaimer)", async function () {
    const res = await get(port, "/");
    expect(res.status).to.equal(200);
    expect(res.type).to.match(/text\/html/);
    expect(res.text).to.match(/^<!doctype html>/i);
    expect(res.text).to.contain("TrustLedger");
    expect(res.text).to.contain("/api/reconcile");
    expect(res.text.toLowerCase()).to.contain("disclaimer");
    // The page is self-contained: no external script/style CDN.
    expect(res.text).to.not.match(/https?:\/\/[^"']+\.(js|css)/);
  });

  it("POST /api/reconcile on the clean fixtures ties out: the three balances + tiesOut", async function () {
    const cwdBefore = fs.readdirSync(process.cwd()).sort();
    const res = await post(port, "/api/reconcile", {
      bank: BANK,
      ledger: BOOK,
      rentroll: RENT,
    });
    expect(res.status).to.equal(200);
    const d = res.json;
    expect(d.tiesOut).to.equal(true);
    expect(d.pass).to.equal(true);
    // The three numbers a broker watches, identical to the CLI e2e assertions.
    expect(d.balances.bank).to.equal(330000);
    expect(d.balances.adjustedBank).to.equal(300000);
    expect(d.balances.book).to.equal(300000);
    expect(d.balances.subledger).to.equal(300000);
    expect(d.balances.reconciled).to.equal(300000);
    // The rendered packet rides back over HTTP, with the custodian disclaimer.
    expect(d.reportHtml).to.match(/^<!doctype html>/i);
    expect(d.reportHtml).to.contain("PASS — three-way reconciliation ties out");
    expect(d.reportHtml).to.contain("broker remains the legal trust-account custodian");
    expect(d.reportCsv).to.contain("severity,type,label,amount_cents");
    expect(d.summary).to.match(/^PASS:/);

    // The server wrote NOTHING to cwd.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });

  it("POST /api/reconcile with a short rent roll is OUT OF TRUST (tiesOut:false, FAIL)", async function () {
    const res = await post(port, "/api/reconcile", {
      bank: BANK,
      ledger: BOOK,
      rentroll: RENT_SHORT,
    });
    expect(res.status).to.equal(200);
    const d = res.json;
    expect(d.tiesOut).to.equal(false);
    expect(d.pass).to.equal(false);
    expect(d.balances.book).to.equal(300000);
    expect(d.balances.subledger).to.equal(250000); // missing the $500 owner row
    expect(d.balances.reconciled).to.equal(null);
    const types = d.exceptions.map((e) => e.type);
    expect(types).to.include("subledger_out_of_balance");
    expect(d.summary).to.match(/^FAIL:/);
  });

  it("POST a malformed bank file => HTTP 400 with a named JSON error (no stack trace)", async function () {
    const res = await post(port, "/api/reconcile", {
      bank: "date,amount\n2026-06-01,10.005\n", // over-precise amount: rejected, not rounded
      ledger: BOOK,
      rentroll: RENT,
    });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal("ingest_error");
    expect(res.json.message).to.match(/malformed amount/i);
    // Never a stack trace in the body.
    expect(res.text).to.not.contain("at Object.");
    expect(res.text).to.not.contain("server.js:");
  });

  it("a missing file field => HTTP 400 named missing_file", async function () {
    const res = await post(port, "/api/reconcile", { bank: BANK, ledger: BOOK });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal("missing_file");
    expect(res.json.message).to.match(/rentroll/);
  });

  it("a non-string file field is rejected, not coerced", async function () {
    const res = await post(port, "/api/reconcile", {
      bank: 12345,
      ledger: BOOK,
      rentroll: RENT,
    });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal("missing_file");
    expect(res.json.message).to.match(/bank/);
  });

  it("an unknown --state code => HTTP 400 named policy_error", async function () {
    const res = await post(port, "/api/reconcile", {
      bank: BANK,
      ledger: BOOK,
      rentroll: RENT,
      state: "ZZ",
    });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal("policy_error");
  });

  it("a malformed prior-close => HTTP 400 named close_error", async function () {
    const res = await post(port, "/api/reconcile", {
      bank: BANK,
      ledger: BOOK,
      rentroll: RENT,
      priorClose: "{not valid json",
    });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal("close_error");
  });

  it("invalid JSON body => HTTP 400 named invalid_json (never a stack trace)", function (done) {
    const bad = Buffer.from("{not json", "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/reconcile",
        headers: { "content-type": "application/json", "content-length": bad.length },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          expect(res.statusCode).to.equal(400);
          expect(json.error).to.equal("invalid_json");
          done();
        });
      }
    );
    req.on("error", done);
    req.end(bad);
  });

  it("an unknown route => HTTP 404 named not_found (JSON, not an HTML page)", async function () {
    const res = await post(port, "/api/nope", { bank: BANK });
    expect(res.status).to.equal(404);
    expect(res.json.error).to.equal("not_found");
  });
});
