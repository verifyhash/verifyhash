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

  // -------------------------------------------------------------------------
  // T-28.1: POST /api/inspect — the read-only per-file diagnostic over the door.
  // It reuses ingest.diagnoseSource VERBATIM (parse-WITH-report, never fail-closed)
  // and exposes a column-map escape hatch, so a broker whose export has a renamed
  // column can self-diagnose AND fix it without touching the strict reconcile path.
  // -------------------------------------------------------------------------

  // The rent roll's tenant column renamed to a header NO alias matches, so the
  // required `tenant` field is unmatched until the broker supplies a columnMap.
  const RENT_RENAMED = RENT.replace("Tenant", "Occupant");

  it("POST /api/inspect on a CLEAN fixture => 200 with header/mapped/okCount and EMPTY requiredMissing", async function () {
    const cwdBefore = fs.readdirSync(process.cwd()).sort();
    const res = await post(port, "/api/inspect", {
      source: "rentroll",
      text: RENT,
    });
    expect(res.status).to.equal(200);
    const d = res.json;
    // The exact diagnose report keys (and nothing thrown).
    expect(d).to.have.all.keys(
      "source",
      "format",
      "header",
      "mapped",
      "requiredMissing",
      "rowCount",
      "okCount",
      "sample",
      "errors"
    );
    expect(d.source).to.equal("rent_roll");
    expect(d.format).to.equal("csv");
    expect(d.header).to.include("Tenant");
    expect(d.mapped.tenant).to.equal("Tenant");
    expect(d.mapped.date).to.equal("Date");
    expect(d.requiredMissing).to.deep.equal([]);
    expect(d.okCount).to.equal(d.rowCount);
    expect(d.okCount).to.be.greaterThan(0);
    expect(d.errors).to.deep.equal([]);
    // diagnose is pure: the door wrote NOTHING to cwd.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });

  it("POST /api/inspect on a RENAMED-header file => 200 with that field in requiredMissing (not a 400)", async function () {
    const res = await post(port, "/api/inspect", {
      source: "rentroll",
      text: RENT_RENAMED,
    });
    // A well-formed file with an unmatched column is a self-service FINDING (200),
    // never a server error: the UI renders requiredMissing.
    expect(res.status).to.equal(200);
    const d = res.json;
    expect(d.requiredMissing).to.include("tenant");
    expect(d.mapped.tenant).to.equal(null);
    expect(d.header).to.include("Occupant");
  });

  it("POST /api/inspect with a columnMap override => 200 with requiredMissing EMPTY and mapped naming the override", async function () {
    const res = await post(port, "/api/inspect", {
      source: "rentroll",
      text: RENT_RENAMED,
      columnMap: { tenant: "Occupant" },
    });
    expect(res.status).to.equal(200);
    const d = res.json;
    // The escape hatch works end-to-end over HTTP: the override binds the field.
    expect(d.requiredMissing).to.deep.equal([]);
    expect(d.mapped.tenant).to.equal("Occupant");
    expect(d.okCount).to.be.greaterThan(0);
    expect(d.errors).to.deep.equal([]);
  });

  it("POST /api/inspect accepts the `quickbooks` source synonym (=> the ledger SOURCE)", async function () {
    const res = await post(port, "/api/inspect", {
      source: "quickbooks",
      text: BOOK,
    });
    expect(res.status).to.equal(200);
    expect(res.json.source).to.equal("quickbooks");
    expect(res.json.requiredMissing).to.deep.equal([]);
  });

  it("POST /api/inspect with an UNKNOWN source => HTTP 400 named unknown_source", async function () {
    const res = await post(port, "/api/inspect", {
      source: "payroll",
      text: BANK,
    });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal("unknown_source");
    expect(res.json.message).to.match(/bank|ledger|rentroll/);
    // Never a stack trace in the body.
    expect(res.text).to.not.contain("at Object.");
  });

  it("POST /api/inspect with a MISSING text => HTTP 400 named missing_text", async function () {
    const res = await post(port, "/api/inspect", { source: "bank" });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal("missing_text");
    expect(res.json.message).to.match(/text/);
  });

  it("POST /api/inspect with a non-string text is rejected, not coerced", async function () {
    const res = await post(port, "/api/inspect", { source: "bank", text: 42 });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal("missing_text");
  });

  it("POST /api/inspect with a malformed columnMap (unknown logical key) => named 400", async function () {
    const res = await post(port, "/api/inspect", {
      source: "rentroll",
      text: RENT,
      columnMap: { bogus: "Tenant" },
    });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal("ingest_error");
    // The SAME message the strict parser/indexHeader gives.
    expect(res.json.message).to.match(/unknown logical field "bogus"/);
  });

  it("POST /api/inspect with a malformed columnMap (header absent from file) => named 400", async function () {
    const res = await post(port, "/api/inspect", {
      source: "rentroll",
      text: RENT_RENAMED,
      columnMap: { tenant: "NoSuchColumn" },
    });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal("ingest_error");
    expect(res.json.message).to.match(/not in the file/);
  });

  it("POST /api/inspect with a non-object columnMap => named 400 invalid_column_map", async function () {
    const res = await post(port, "/api/inspect", {
      source: "rentroll",
      text: RENT,
      columnMap: "Tenant",
    });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal("invalid_column_map");
  });
});
