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

// T-28.2: an "aliased-miss" bank file — e2e/bank.csv with its `Date` column
// renamed to `TxnDate`, a header NO alias matches. The un-mapped run 400s
// (required column "date" missing); mapping date -> TxnDate clears the miss and,
// with the clean ledger + rent roll, the full three-way run ties out.
const BANK_ALIASED = fs.readFileSync(path.join(FIX, "bank.aliased.csv"), "utf8");

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

    it("has an inspect/fix affordance: a per-file 'Check this file' control + /api/inspect call", function () {
      // A per-file affordance (one Check button per source) OR an automatic
      // fallback — this page has BOTH; assert the explicit per-file control.
      expect(PAGE).to.match(/Check this file/);
      expect(PAGE).to.match(/data-source="bank"/);
      expect(PAGE).to.match(/data-source="ledger"/);
      expect(PAGE).to.match(/data-source="rentroll"/);
      expect(PAGE).to.contain('fetch("/api/inspect"');
    });

    it("renders the diagnose report fields by name (header, mapped, requiredMissing, rowCount/okCount, sample/errors)", function () {
      // The page reads each diagnose field the server returns — pin them so the
      // inspect renderer can't drift from /api/inspect's response shape.
      expect(PAGE).to.contain("rep.header");
      expect(PAGE).to.contain("rep.mapped");
      expect(PAGE).to.contain("rep.requiredMissing");
      expect(PAGE).to.contain("rep.rowCount");
      expect(PAGE).to.contain("rep.okCount");
      expect(PAGE).to.match(/rep\.sample/);
      expect(PAGE).to.match(/rep\.errors/);
    });

    it("offers a per-missing-field SELECT populated from the file header, then builds a columnMap", function () {
      // For a requiredMissing field the page emits a <select> over the header.
      expect(PAGE).to.match(/class='mapsel'/);
      expect(PAGE).to.match(/<select/);
      // The confirm action assembles a columnMap from the chosen columns.
      expect(PAGE).to.contain("columnMap");
      expect(PAGE).to.contain("Confirm mapping");
    });

    it("does NOT dump raw JSON or stack traces into the inspect view", function () {
      // No JSON.stringify of the whole report into the DOM, no <pre> dumps.
      expect(PAGE).to.not.match(/innerHTML\s*=\s*JSON\.stringify/);
    });

    it("threads confirmed maps into the reconcile body (pendingMaps -> body.maps)", function () {
      expect(PAGE).to.contain("pendingMaps");
      expect(PAGE).to.match(/body\.maps\s*=/);
    });

    it("escapeHtml escapes the single quote ' (uploaded headers land in single-quoted attributes)", function () {
      // FINDING 1: renderInspect interpolates the broker's uploaded column-header
      // strings into SINGLE-QUOTE-delimited attributes (value='...', data-field='...').
      // The browser escapeHtml MUST therefore escape ' as well as & < > " — otherwise a
      // header like  x' onmouseover='alert(1)  breaks out of value='...' and injects an
      // event handler on the same tag (live XSS). Pin the hardened escape map + regex.
      expect(PAGE).to.match(/replace\(\/\[&<>"'\]\/g/);
      expect(PAGE).to.contain('"\'": "&#39;"');
      // The inspect render uses single-quote attribute delimiters, so the contract is:
      // the option/select values run through escapeHtml(...).
      expect(PAGE).to.match(/value='" \+ escapeHtml\(h\)/);
      expect(PAGE).to.match(/data-field='" \+ escapeHtml\(field\)/);
    });
  });

  describe("escapeHtml behaviour (the actual function, pulled from the page source)", function () {
    // Pull the browser escapeHtml out of the page and exercise it directly, so the
    // XSS-hardening is proven on REAL bytes, not just a source-text grep.
    function loadEscapeHtml(page) {
      const m = page.match(/function escapeHtml\(s\) \{[\s\S]*?\n  \}/);
      expect(m, "page must define escapeHtml").to.not.equal(null);
      // eslint-disable-next-line no-new-func
      return new Function(m[0] + "\nreturn escapeHtml;")();
    }
    const escapeHtml = loadEscapeHtml(PAGE);

    it("neutralises a single-quote attribute breakout from a hostile column header", function () {
      const hostile = "x' onmouseover='alert(document.cookie)";
      const out = escapeHtml(hostile);
      expect(out).to.not.contain("'");
      expect(out).to.contain("&#39;");
      // Rebuilt into the exact single-quoted attribute the page emits: no breakout.
      const attr = "<option value='" + out + "'>";
      expect(attr).to.equal(
        "<option value='x&#39; onmouseover=&#39;alert(document.cookie)'>"
      );
    });

    it("still escapes & < > \" (no regression on the original set)", function () {
      expect(escapeHtml('&<>"')).to.equal("&amp;&lt;&gt;&quot;");
    });
  });

  describe("CONTRACT (1): the keys the page POSTs == the keys the server reads", function () {
    // The page builds the reconcile POST body literal
    // `{ bank: ..., ledger: ..., rentroll: ... }` plus optional `body.state = ...`
    // and (T-28.2) `body.maps = ...`. Extract those keys from the page source. The
    // literal is anchored on `bank:` so it can't accidentally match the SEPARATE
    // inspect body literal (`{ source, text }`).
    function reconcileKeys(page) {
      const keys = new Set();
      const m = page.match(/var body = \{[^}]*\bbank:[^}]*\}/);
      expect(m, "page must build a reconcile body object literal").to.not.equal(null);
      const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g;
      let g;
      while ((g = re.exec(m[0])) !== null) keys.add(g[1]);
      // Conditionally-added fields of the form `body.<key> = `.
      const re2 = /body\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=/g;
      while ((g = re2.exec(page)) !== null) keys.add(g[1]);
      return keys;
    }

    // The inspect POST body literal `{ source, text }` plus optional
    // `body.columnMap = ...`. Pinned so the page and /api/inspect can't drift.
    function inspectKeys(page) {
      const keys = new Set();
      const m = page.match(/var body = \{[^}]*\bsource:[^}]*\}/);
      expect(m, "page must build an inspect body object literal").to.not.equal(null);
      const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g;
      let g;
      while ((g = re.exec(m[0])) !== null) keys.add(g[1]);
      const re2 = /body\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=/g;
      while ((g = re2.exec(page)) !== null) keys.add(g[1]);
      return keys;
    }

    it("posts exactly bank, ledger, rentroll, state, maps — the fields reconcilePayload reads", function () {
      const keys = reconcileKeys(PAGE);
      // Both the reconcile and inspect bodies are named `body`, so the conditional
      // `body.<key> =` scan also sees the inspect-only `columnMap`; exclude it (it
      // is pinned by its own test) and assert the reconcile contract exactly.
      const reconcileOnly = Array.from(keys).filter(
        (k) => !["columnMap", "source", "text"].includes(k)
      );
      // Required trio + the optional state selector + the optional T-28.2 maps.
      expect(reconcileOnly.sort()).to.deep.equal(["bank", "ledger", "maps", "rentroll", "state"]);
    });

    it("references /api/inspect and posts exactly source, text, columnMap — the fields inspectPayload reads", function () {
      expect(PAGE).to.contain('fetch("/api/inspect"');
      const keys = inspectKeys(PAGE);
      // Note: inspectKeys also picks up the unrelated `body.maps =` from the
      // reconcile block (both use the name `body`); restrict to the inspect trio.
      const inspectOnly = Array.from(keys).filter((k) =>
        ["source", "text", "columnMap"].includes(k)
      );
      expect(inspectOnly.sort()).to.deep.equal(["columnMap", "source", "text"]);
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

        // `maps` is READ: a bad shape is a named 400 (not silently ignored).
        const badMaps = await post(port, "/api/reconcile", {
          bank: BANK,
          ledger: BOOK,
          rentroll: RENT,
          maps: [],
        });
        expect(badMaps.status).to.equal(400);
        expect(badMaps.json.error).to.equal("invalid_maps");
      } finally {
        await new Promise((r) => srv.close(r));
      }
    });

    it("an OMITTED maps (and an empty maps) leaves the run BYTE-FOR-BYTE the no-map result", async function () {
      // The happy path must not regress: with no maps the response is identical to
      // a run that never knew about maps. Prove it by comparing the full response.
      const srv = createServer({ today: () => DATE });
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      const port = srv.address().port;
      try {
        const noKey = await post(port, "/api/reconcile", { bank: BANK, ledger: BOOK, rentroll: RENT });
        const emptyMaps = await post(port, "/api/reconcile", {
          bank: BANK,
          ledger: BOOK,
          rentroll: RENT,
          maps: {},
        });
        expect(noKey.status).to.equal(200);
        expect(emptyMaps.status).to.equal(200);
        // Byte-identical JSON: no-map vs empty-map produce the same packet.
        expect(emptyMaps.text).to.equal(noKey.text);
      } finally {
        await new Promise((r) => srv.close(r));
      }
    });

    it("threads a per-file map into the REAL run: an aliased-miss file that 400s un-mapped TIES OUT mapped (inspect -> map -> reconcile)", async function () {
      const srv = createServer({ today: () => DATE });
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      const port = srv.address().port;
      try {
        // (a) UN-MAPPED reconcile of the aliased file 400s on ingest.
        const unmapped = await post(port, "/api/reconcile", {
          bank: BANK_ALIASED,
          ledger: BOOK,
          rentroll: RENT,
        });
        expect(unmapped.status).to.equal(400);
        expect(unmapped.json.error).to.equal("ingest_error");

        // (b) INSPECT the bank file: the page reads back header + a `date` miss.
        const diag = await post(port, "/api/inspect", {
          source: "bank",
          text: BANK_ALIASED,
        });
        expect(diag.status).to.equal(200);
        expect(diag.json).to.have.property("header");
        expect(diag.json.header).to.include("TxnDate");
        expect(diag.json.requiredMissing).to.include("date");

        // (c) MAP date -> the chosen header and re-inspect to CONFIRM the miss clears.
        const columnMap = { date: "TxnDate" };
        const confirm = await post(port, "/api/inspect", {
          source: "bank",
          text: BANK_ALIASED,
          columnMap,
        });
        expect(confirm.status).to.equal(200);
        expect(confirm.json.requiredMissing).to.deep.equal([]);

        // (d) RECONCILE with the assembled per-file map threaded in: it ties out.
        const mapped = await post(port, "/api/reconcile", {
          bank: BANK_ALIASED,
          ledger: BOOK,
          rentroll: RENT,
          maps: { bank: columnMap },
        });
        expect(mapped.status).to.equal(200);
        expect(mapped.json.pass).to.equal(true);
        expect(mapped.json.tiesOut).to.equal(true);
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

  describe("embedded fallback drift guard (the page served when public/index.html is absent)", function () {
    // FINDING 2: embeddedIndexHtml() is the byte-faithful fallback served only when
    // public/index.html cannot be read. It had SILENTLY diverged: the on-disk page
    // carries the un-weakened tamper-evidence disclaimer, but the embedded copy still
    // shipped the older, weaker "...does not constitute legal, accounting, or audit
    // advice." wording — so the fallback could ship a weaker legal claim with no guard.
    // Pin the embedded disclaimer to the same un-weakened wording, and pin its escape
    // map in lock-step with the on-disk page.
    const EMBED = server.embeddedIndexHtml();

    it("is a self-contained HTML document (no framework, no CDN)", function () {
      expect(EMBED).to.match(/^<!doctype html>/i);
      expect(EMBED).to.contain("</html>");
      expect(EMBED).to.not.match(/<script[^>]+src=/i);
    });

    it("carries the SAME un-weakened custodian + tamper-evidence disclaimer as the on-disk page", function () {
      expect(EMBED).to.contain("broker remains the legal trust-account custodian");
      expect(EMBED).to.match(/not.{0,40}trusted timestamp/i);
      expect(EMBED).to.match(/substitute for a CPA's review/i);
      // The old weaker wording must NOT survive (it never named CPA review / timestamp).
      expect(EMBED).to.not.match(/It does not constitute legal, accounting,\s*or audit advice\./);
    });

    it("escapes the single quote ' in its escapeHtml, in lock-step with the on-disk page", function () {
      expect(EMBED).to.match(/replace\(\/\[&<>"'\]\/g/);
      expect(EMBED).to.contain('"\'": "&#39;"');
    });
  });
});
