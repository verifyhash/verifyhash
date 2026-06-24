"use strict";

// TrustLedger — public/index.html front-end contract tests (T-27.2).
//
// EPIC-27's web door is only sellable if the SINGLE PAGE a broker opens stays in
// lock-step with the /api/reconcile contract. This file is the CONTRACT TEST that
// pins the two halves together so they cannot silently drift:
//
//   (1) The exact JSON KEYS the page POSTs (bank / ledger / rentroll / state) are
//       precisely the keys the server's reconcilePayload READS — no more, no less.
//       Rename a key on either side and this test goes red.
//
//   (2) Every RESULT FIELD the page renders (pass, summary, the three+ balances,
//       each exception's type/severity/label/amount/detail, reportHtml, reportCsv)
//       actually EXISTS on the server's live response for the SAME e2e fixtures the
//       server tests use. Drop a field from the response and this test goes red.
//
// The page is the ONE self-contained trustledger/public/index.html; the server
// serves it verbatim (proven here), so testing the file IS testing what ships.
// Full filesystem isolation: the server writes NOTHING — asserted against cwd.

const { expect } = require("chai");
const fs = require("fs");
const http = require("http");
const path = require("path");

const server = require("../trustledger/server");
const { createServer } = server;

const PAGE = fs.readFileSync(server.PUBLIC_INDEX, "utf8");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures", "e2e");
const BANK = fs.readFileSync(path.join(FIX, "bank.csv"), "utf8");
const BOOK = fs.readFileSync(path.join(FIX, "quickbooks.csv"), "utf8");
const RENT = fs.readFileSync(path.join(FIX, "rentroll.csv"), "utf8");
const RENT_SHORT = fs.readFileSync(path.join(FIX, "rentroll.short.csv"), "utf8");

const DATE = "2026-06-24"; // pinned so the server core stays deterministic

function post(port, pathName, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(bodyObj), "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: pathName,
        headers: { "content-type": "application/json", "content-length": body.length },
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

describe("trustledger UI: public/index.html is a self-contained, contract-pinned page", function () {
  describe("the page is one self-contained file (no framework, no CDN)", function () {
    it("is a single HTML document starting with <!doctype html>", function () {
      expect(PAGE).to.match(/^<!doctype html>/i);
      expect(PAGE).to.contain("</html>");
    });

    it("loads no external script or stylesheet (fully self-contained)", function () {
      // No CDN .js/.css URLs, and no <link rel=stylesheet>/<script src=...> tags.
      expect(PAGE).to.not.match(/https?:\/\/[^"']+\.(js|css)/);
      expect(PAGE).to.not.match(/<script[^>]+src=/i);
      expect(PAGE).to.not.match(/<link[^>]+stylesheet/i);
    });

    it("has the three required file inputs and an optional state selector", function () {
      expect(PAGE).to.match(/<input[^>]+id="bank"[^>]+type="file"/);
      expect(PAGE).to.match(/<input[^>]+id="ledger"[^>]+type="file"/);
      expect(PAGE).to.match(/<input[^>]+id="rentroll"[^>]+type="file"/);
      expect(PAGE).to.match(/<select[^>]+id="state"/);
    });

    it("has a Reconcile button that POSTs to /api/reconcile", function () {
      expect(PAGE).to.match(/<button[^>]+id="go"[^>]+type="submit"/);
      expect(PAGE).to.contain(">Reconcile<");
      expect(PAGE).to.contain('fetch("/api/reconcile"');
      expect(PAGE).to.contain('method: "POST"');
    });

    it("reads the dropped files as text via FileReader (browser-side, no multipart)", function () {
      expect(PAGE).to.contain("FileReader");
      expect(PAGE).to.contain("readAsText");
    });

    it("carries the honest custodian + tamper-evidence disclaimer (never weakened)", function () {
      expect(PAGE.toLowerCase()).to.contain("disclaimer");
      expect(PAGE).to.contain("broker remains the legal trust-account custodian");
      expect(PAGE).to.match(/not.{0,40}trusted timestamp/i);
    });

    it("offers download links for BOTH the HTML and CSV packet", function () {
      expect(PAGE).to.contain("reportHtml");
      expect(PAGE).to.contain("reportCsv");
      expect(PAGE).to.match(/download/i);
    });
  });

  describe("CONTRACT (1): the keys the page POSTs == the keys the server reads", function () {
    // The page builds the POST body literal `{ bank: ..., ledger: ..., rentroll: ... }`
    // plus an optional `body.state = ...`. Extract those keys from the page source.
    function postedKeys(page) {
      const keys = new Set();
      // The object literal handed to JSON.stringify.
      const m = page.match(/var body = \{([^}]*)\}/);
      expect(m, "page must build a body object literal").to.not.equal(null);
      const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g;
      let g;
      while ((g = re.exec(m[1])) !== null) keys.add(g[1]);
      // Conditionally-added fields of the form `body.<key> = `.
      const re2 = /body\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=/g;
      while ((g = re2.exec(page)) !== null) keys.add(g[1]);
      return keys;
    }

    it("posts exactly bank, ledger, rentroll, state — the fields reconcilePayload reads", function () {
      const keys = postedKeys(PAGE);
      // Required trio + the optional state selector.
      expect(Array.from(keys).sort()).to.deep.equal(["bank", "ledger", "rentroll", "state"]);
    });

    it("the server treats each posted key as a known input (none is silently ignored)", async function () {
      // Prove the server READS each key by sending a body that exercises it and
      // observing the key-specific behavior, so a key the page posts can't be a
      // dead field the server never looks at.
      const srv = createServer({ today: () => DATE });
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      const port = srv.address().port;
      try {
        // Drop `rentroll` -> the server names that exact missing key (it reads it).
        const miss = await post(port, "/api/reconcile", { bank: BANK, ledger: BOOK });
        expect(miss.status).to.equal(400);
        expect(miss.json.error).to.equal("missing_file");
        expect(miss.json.message).to.match(/rentroll/);

        // A bad `state` -> policy_error (the server reads state).
        const badState = await post(port, "/api/reconcile", {
          bank: BANK,
          ledger: BOOK,
          rentroll: RENT,
          state: "ZZ",
        });
        expect(badState.status).to.equal(400);
        expect(badState.json.error).to.equal("policy_error");

        // `bank`/`ledger` are read: a clean post ties out.
        const ok = await post(port, "/api/reconcile", { bank: BANK, ledger: BOOK, rentroll: RENT });
        expect(ok.status).to.equal(200);
        expect(ok.json.pass).to.equal(true);
      } finally {
        await new Promise((r) => srv.close(r));
      }
    });
  });

  describe("CONTRACT (2): every result field the page renders exists on the response", function () {
    let srv;
    let port;
    beforeEach(function (done) {
      srv = createServer({ today: () => DATE });
      srv.listen(0, "127.0.0.1", () => {
        port = srv.address().port;
        done();
      });
    });
    afterEach(function (done) {
      srv.close(done);
    });

    it("GET / serves the SAME bytes as public/index.html (testing the file == testing what ships)", async function () {
      const res = await get(port, "/");
      expect(res.status).to.equal(200);
      expect(res.type).to.match(/text\/html/);
      expect(res.text).to.equal(PAGE);
    });

    it("a PASS response carries every field the page reads", async function () {
      const cwdBefore = fs.readdirSync(process.cwd()).sort();
      const res = await post(port, "/api/reconcile", { bank: BANK, ledger: BOOK, rentroll: RENT });
      expect(res.status).to.equal(200);
      const d = res.json;

      // Top-level fields the page's render() touches.
      expect(d).to.have.property("pass");
      expect(d).to.have.property("summary");
      expect(d).to.have.property("balances");
      expect(d).to.have.property("exceptions");
      expect(d).to.have.property("reportHtml");
      expect(d).to.have.property("reportCsv");

      // The page renders these balance lines by exact key.
      for (const key of ["bank", "adjustedBank", "book", "subledger", "reconciled"]) {
        expect(d.balances, "balances." + key).to.have.property(key);
      }

      // The packet artifacts the page wires into download links + the iframe.
      expect(d.reportHtml).to.match(/^<!doctype html>/i);
      expect(d.reportCsv).to.contain("severity,type,label,amount_cents");

      // The verdict + summary the page shows in the banner.
      expect(d.pass).to.equal(true);
      expect(d.summary).to.match(/^PASS:/);

      // The server wrote NOTHING to cwd.
      expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
    });

    it("a FAIL response's exception rows carry every column the page renders", async function () {
      const res = await post(port, "/api/reconcile", {
        bank: BANK,
        ledger: BOOK,
        rentroll: RENT_SHORT,
      });
      expect(res.status).to.equal(200);
      const d = res.json;
      expect(d.pass).to.equal(false);
      expect(d.summary).to.match(/^FAIL:/);
      expect(d.exceptions).to.be.an("array").with.length.greaterThan(0);

      // The page's renderExceptions() reads exactly these per-row fields.
      for (const e of d.exceptions) {
        expect(e).to.have.property("type");
        expect(e).to.have.property("severity");
        expect(e).to.have.property("label");
        expect(e).to.have.property("amount");
        expect(e).to.have.property("detail");
        // Severity is one of the three classes the page styles.
        expect(["error", "warning", "info"]).to.include(e.severity);
      }
    });

    it("an error response carries the { error, message } the page shows", async function () {
      const res = await post(port, "/api/reconcile", {
        bank: "date,amount\n2026-06-01,10.005\n",
        ledger: BOOK,
        rentroll: RENT,
      });
      expect(res.status).to.equal(400);
      expect(res.json).to.have.property("error");
      expect(res.json).to.have.property("message");
    });
  });
});
