"use strict";

// test/trustledger.standalone.test.js — T-65.2: PROVE the single-file OFFLINE TrustLedger app.
//
// `trustledger/dist/trustledger-standalone.html` is the zero-install pilot deliverable: the human
// emails ONE .html file, the design partner double-clicks it, drags their three REAL exports in,
// and reads the same tie-out packet — with NO install and NO network. This suite makes the task's
// five acceptance criteria TRUE in code:
//
//   (1) DETERMINISTIC + ANTI-ROT — building twice yields BYTE-IDENTICAL output; the committed dist
//       (bundle + .sha256 sidecar + BUILD-PROVENANCE.json) equals a fresh rebuild byte-for-byte (a
//       stale bundle FAILS here, i.e. in CI); `--check` is green on the real tree and RED (exit 1,
//       named MISMATCH) on a copied tree with a one-byte-corrupted bundle/sidecar/source.
//   (2) the marked engine block is DOM-FREE — extracted between __TRUSTLEDGER_ENGINE_BEGIN__/END__
//       markers and evaluated in a BARE `vm` context (no document, no window, no network API), it
//       answers the SAME payloads the server tests use BYTE-IDENTICALLY to the in-tree engine: the
//       real fixtures (bank.real.csv + quickbooks.real.csv + rentroll.real.csv), a malformed-file
//       NAMED reject, and a TWO-MONTH prior-close continuity tie-out (the exact clean roll-forward
//       recipe test/trustledger.close.cli.test.js pins for the CLI).
//   (3) NO NETWORK — the WHOLE emitted file contains none of the network-API tokens: fetch( /
//       XMLHttpRequest / WebSocket / EventSource / sendBeacon / dynamic import(.
//   (4) a PAID-surface payload (state policy / seal) gets the SAME named license_required refusal
//       the web door gives, byte-for-byte; a supplied license is REFUSED fail-closed (named
//       license_invalid pointing at the installed product) — the gate is REUSED, never weakened.
//   (5) the server.js refactor is verdict-neutral: server.js re-exports the IDENTICAL door-core
//       functions (same function objects), and the pre-existing server/UI suites run unedited.
//
// Every write lands under a throwaway temp dir cleaned in afterEach; cwd is asserted untouched.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");
const { spawnSync } = require("child_process");

const builder = require("../trustledger/build-standalone");
const verifierBuilder = require("../verifier/build-standalone");
const server = require("../trustledger/server");
const doorCore = require("../trustledger/door-core");

// The raw in-tree engine — the ORACLE the extracted block must match byte-for-byte.
const ingest = require("../trustledger/ingest");
const report = require("../trustledger/report");
const close = require("../trustledger/close");
const policyMod = require("../trustledger/policy");

const REPO = path.join(__dirname, "..");
const TL = path.join(REPO, "trustledger");
const DIST_HTML = builder.OUT_PATH;
const DIST_SHA256 = builder.SHA256_PATH;
const DIST_PROVENANCE = builder.PROVENANCE_PATH;

// The REAL-export fixtures (aliased headers, parsed with no map — pinned by trustledger.map.test.js).
const FIX = path.join(TL, "fixtures");
const BANK_REAL = fs.readFileSync(path.join(FIX, "bank.real.csv"), "utf8");
const BOOK_REAL = fs.readFileSync(path.join(FIX, "quickbooks.real.csv"), "utf8");
const RENT_REAL = fs.readFileSync(path.join(FIX, "rentroll.real.csv"), "utf8");

// The e2e fixtures the server tests use (month 1 of the two-month chain).
const E2E = path.join(FIX, "e2e");
const BANK_1 = fs.readFileSync(path.join(E2E, "bank.csv"), "utf8");
const BOOK_1 = fs.readFileSync(path.join(E2E, "quickbooks.csv"), "utf8");
const RENT_1 = fs.readFileSync(path.join(E2E, "rentroll.csv"), "utf8");

// Month 2 of the clean roll-forward — the EXACT dataset trustledger.close.cli.test.js pins: the
// $300 vendor check outstanding at month-1 close CLEARS the bank, the book has no new activity,
// and the rent roll restates the same per-tenant balances, so all three balances tie out at 300000.
const BANK_2 =
  "Date,Description,Debit,Credit,Type\n" + "2026-06-03,Vendor check 2051 cleared,300.00,,Check\n";
const BOOK_2 = "Date,Type,Name,Memo,Debit,Credit\n";
const RENT_2 =
  "Date,Tenant,Unit,Type,Memo,Payment,Charge\n" +
  "2026-06-01,Jones,101,Payment,carryover,1500.00,\n" +
  "2026-06-01,Doe,103,Payment,carryover,1300.00,\n" +
  "2026-06-01,Smith,OWNER,Payment,carryover,200.00,\n";

const DATE_1 = "2026-05-31";
const DATE_2 = "2026-06-30";
const DATE = "2026-06-24"; // the pinned date the server tests inject

// The six network-API tokens the emitted file must not contain ANYWHERE (acceptance 3).
const NETWORK_TOKENS = ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "import("];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

// Extract the marked engine block from the emitted HTML. Asserts each marker appears EXACTLY once.
function extractEngineBlock(html) {
  for (const marker of [builder.ENGINE_BEGIN_MARKER, builder.ENGINE_END_MARKER]) {
    const first = html.indexOf(marker);
    expect(first, `engine marker ${marker} present`).to.be.greaterThan(-1);
    expect(html.indexOf(marker, first + marker.length), `engine marker ${marker} unique`).to.equal(-1);
  }
  const begin = html.indexOf(builder.ENGINE_BEGIN_MARKER);
  const end = html.indexOf(builder.ENGINE_END_MARKER);
  expect(end, "END marker after BEGIN").to.be.greaterThan(begin);
  return html.slice(begin, end);
}

// Evaluate the engine block in a BARE vm context: no document, no window, no navigator, no fetch,
// no Node require — nothing but the JS language. Returns the block's single global.
function loadEngine(html) {
  const code = extractEngineBlock(html);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInNewContext(code, ctx, { filename: "trustledger-standalone-engine.js" });
  const TLS = ctx.TrustLedgerStandalone;
  expect(TLS, "engine block defines TrustLedgerStandalone").to.be.an("object");
  expect(TLS.door.reconcilePayload).to.be.a("function");
  expect(TLS.door.inspectPayload).to.be.a("function");
  expect(TLS.engine.report.buildPacket).to.be.a("function");
  return TLS;
}

// Strip JS comments (so prose can never mask or fake a token) — same approach as the T-65.1 suite.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// Capture a thrown HttpError's observable surface (never returns one on success).
function thrown(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return { name: e.name, status: e.status, code: e.code, message: e.message };
  }
}

// Run the trustledger builder as a CHILD process (the way a skeptic runs `--check`).
function runBuilderCheck(tlDir) {
  return spawnSync(process.execPath, [path.join(tlDir, "build-standalone.js"), "--check"], {
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "" },
  });
}

describe("trustledger standalone: single-file OFFLINE app (T-65.2)", function () {
  this.timeout(60000);

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
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tl-standalone-"));
    tmpDirs.push(d);
    return d;
  }

  // Copy the whole trustledger tree (sources + fixtures + dist) into a temp dir so corruption
  // tests never touch the working tree. The builder resolves everything from its own __dirname.
  function copyTree() {
    const dst = path.join(mkTmp(), "trustledger");
    fs.cpSync(TL, dst, { recursive: true });
    return dst;
  }

  const committedHtml = () => fs.readFileSync(DIST_HTML, "utf8");

  // ============================================================================================
  // (1) DETERMINISTIC BUILD + ANTI-ROT (`--check` green; stale bundle RED)
  // ============================================================================================
  describe("(1) deterministic build + anti-rot", function () {
    it("two fresh builds are BYTE-IDENTICAL (no timestamp / randomness / fs-order dependence)", function () {
      const a = builder.buildHtml();
      const b = builder.buildHtml();
      expect(a).to.equal(b);
      expect(Buffer.byteLength(a)).to.be.greaterThan(100000);
      // The provenance manifest is deterministic too.
      expect(builder.buildProvenanceText()).to.equal(builder.buildProvenanceText());
    });

    it("the COMMITTED dist files match a fresh rebuild byte-for-byte (a stale bundle FAILS here)", function () {
      const stale = " is STALE — re-run `node trustledger/build-standalone.js` and commit it";
      expect(committedHtml(), "trustledger/dist/trustledger-standalone.html" + stale).to.equal(
        builder.buildHtml()
      );
      expect(
        fs.readFileSync(DIST_SHA256, "utf8"),
        "trustledger/dist/trustledger-standalone.html.sha256" + stale
      ).to.equal(builder.sha256SidecarFor(builder.buildHtml(), builder.SHA256_BASENAME));
      expect(
        fs.readFileSync(DIST_PROVENANCE, "utf8"),
        "trustledger/dist/BUILD-PROVENANCE.json" + stale
      ).to.equal(builder.buildProvenanceText());
    });

    it("the .sha256 sidecar is the standard `sha256sum -c` line over the committed bundle", function () {
      const sidecar = fs.readFileSync(DIST_SHA256, "utf8");
      expect(sidecar).to.match(/^[0-9a-f]{64}  trustledger-standalone\.html\n$/);
      const hex = crypto.createHash("sha256").update(fs.readFileSync(DIST_HTML)).digest("hex");
      expect(sidecar).to.equal(`${hex}  trustledger-standalone.html\n`);
    });

    it("BUILD-PROVENANCE.json uses the verifier's schema and pins every inlined source by sha256", function () {
      const prov = JSON.parse(fs.readFileSync(DIST_PROVENANCE, "utf8"));
      // The SAME schema tag as verifier/dist/BUILD-PROVENANCE.json — one manifest language.
      expect(prov.schema).to.equal(verifierBuilder.PROVENANCE_SCHEMA);
      const target = prov.targets["trustledger-standalone"];
      expect(target, "trustledger-standalone target present").to.be.an("object");
      expect(target.bundle).to.equal("trustledger-standalone.html");
      expect(target.bundleSha256).to.equal(
        crypto.createHash("sha256").update(fs.readFileSync(DIST_HTML)).digest("hex")
      );
      expect(target.bundleBytes).to.equal(fs.readFileSync(DIST_HTML).length);
      // The exact fixed engine composition, in order, door-core the entry.
      expect(target.modules.map((m) => m.id)).to.deep.equal([
        "sha256-vendored",
        "policy-bundled-loader",
        "reconcile",
        "policy",
        "match",
        "ingest",
        "close",
        "report",
        "license",
        "door-core",
      ]);
      expect(target.modules.filter((m) => m.entry).map((m) => m.id)).to.deep.equal(["door-core"]);
      // The two swapped bodies — the policy-loader shim and the fail-closed license shim — are the
      // ONLY synthetic modules; everything else is pinned to its on-disk normalized source bytes.
      expect(target.modules.filter((m) => m.synthetic).map((m) => m.id)).to.deep.equal([
        "policy-bundled-loader",
        "license",
      ]);
      for (const m of target.modules) {
        if (m.synthetic) continue;
        const src = fs
          .readFileSync(path.join(REPO, m.sourceFile), "utf8")
          .replace(/\r\n/g, "\n")
          .replace(/^#![^\n]*\n/, "");
        expect(
          crypto.createHash("sha256").update(Buffer.from(src, "utf8")).digest("hex"),
          `${m.sourceFile} pinned hash`
        ).to.equal(m.sourceSha256);
      }
      // The UI page whose transport seams were swapped is pinned too.
      expect(target.page.sourceFile).to.equal("trustledger/public/index.html");
      const pageSrc = fs.readFileSync(path.join(TL, "public", "index.html"), "utf8").replace(/\r\n/g, "\n");
      expect(crypto.createHash("sha256").update(Buffer.from(pageSrc, "utf8")).digest("hex")).to.equal(
        target.page.sourceSha256
      );
    });

    it("`--check` on the real committed tree exits 0 with all MATCH and no MISMATCH", function () {
      const res = runBuilderCheck(TL);
      expect(res.status, res.stdout + res.stderr).to.equal(0);
      expect(res.stdout).to.not.match(/MISMATCH/);
      expect(res.stdout).to.match(/\[MATCH\] bundle {2}dist\/trustledger-standalone\.html/);
      expect(res.stdout).to.match(/\[MATCH\] sidecar dist\/trustledger-standalone\.html\.sha256/);
      expect(res.stdout).to.match(/\[MATCH\] manifest dist\/BUILD-PROVENANCE\.json/);
      expect(res.stdout).to.match(/\[MATCH\] sources->manifest/);
      expect(res.stdout).to.match(/ALL MATCH/);
    });

    it("a ONE-BYTE-corrupted copied bundle makes `--check` exit 1 with a MISMATCH naming the bundle (stale bundle RED)", function () {
      const tlCopy = copyTree();
      const p = path.join(tlCopy, "dist", "trustledger-standalone.html");
      const bytes = fs.readFileSync(p);
      bytes[bytes.length - 10] ^= 0x01; // flip one bit near the end
      fs.writeFileSync(p, bytes);
      const res = runBuilderCheck(tlCopy);
      expect(res.status).to.equal(1);
      const all = res.stdout + res.stderr;
      expect(all).to.match(/\[MISMATCH\] bundle {2}dist\/trustledger-standalone\.html: .*does NOT reproduce/);
      expect(all).to.match(/MISMATCH — at least one committed file does NOT reproduce/);
    });

    it("a corrupted copied sidecar makes `--check` exit 1 with a MISMATCH naming the sidecar", function () {
      const tlCopy = copyTree();
      const p = path.join(tlCopy, "dist", "trustledger-standalone.html.sha256");
      fs.writeFileSync(p, "0".repeat(64) + "  trustledger-standalone.html\n");
      const res = runBuilderCheck(tlCopy);
      expect(res.status).to.equal(1);
      expect(res.stdout + res.stderr).to.match(
        /\[MISMATCH\] sidecar dist\/trustledger-standalone\.html\.sha256:/
      );
    });

    it("a corrupted copied SOURCE file is named precisely against the manifest pin (chain MISMATCH)", function () {
      const tlCopy = copyTree();
      const p = path.join(tlCopy, "reconcile.js");
      fs.appendFileSync(p, "\n// tampered\n");
      const res = runBuilderCheck(tlCopy);
      expect(res.status).to.equal(1);
      expect(res.stdout + res.stderr).to.match(
        /\[MISMATCH\] sources->manifest: .*trustledger\/reconcile\.js \(pinned [0-9a-f]+…, got [0-9a-f]+…\)/
      );
    });
  });

  // ============================================================================================
  // (2) The DOM-free engine block: vm-evaluated, BYTE-IDENTICAL to the in-tree engine
  // ============================================================================================
  describe("(2) engine block: DOM-free vm evaluation, byte-identical verdicts", function () {
    let TLS; // the vm-loaded standalone engine (loaded once from the COMMITTED file)
    before(function () {
      TLS = loadEngine(fs.readFileSync(DIST_HTML, "utf8"));
    });

    it("the block (comments stripped) references NO DOM global and calls NO bare require()", function () {
      const stripped = stripComments(extractEngineBlock(committedHtml()));
      // No document/window/navigator/location *reference* (property access / call / index) anywhere.
      expect(stripped).to.not.match(/\bdocument\s*[.[(]/);
      expect(stripped).to.not.match(/\bwindow\s*[.[(]/);
      expect(stripped).to.not.match(/\bnavigator\s*[.[(]/);
      expect(stripped).to.not.match(/\balert\s*\(/);
      // Every require was rewritten to the internal __require(id) shim — no Node require survives.
      expect(stripped).to.not.match(/(^|[^A-Za-z0-9_$])require\(/);
      // And the real proof is loadEngine() itself: the block evaluated in a BARE vm context (no
      // document, no window, no fetch, no require) in before() without throwing.
    });

    it("REAL fixtures: verdict/balances/exceptions/reportHtml/reportCsv BYTE-IDENTICAL to the in-tree engine", function () {
      const payload = { bank: BANK_REAL, ledger: BOOK_REAL, rentroll: RENT_REAL };
      const out = TLS.door.reconcilePayload(payload, DATE);
      const oracle = server.reconcilePayload(payload, DATE);
      expect(JSON.stringify(out)).to.equal(JSON.stringify(oracle));

      // Anchor to the RAW engine too (not just the shared door core): the same reportHtml/reportCsv
      // must fall out of ingest -> buildPacket -> renderHTML run directly on the in-tree modules.
      const model = report.buildPacket({
        bank: ingest.parseBankStatement(BANK_REAL),
        book: ingest.parseQuickBooksCSV(BOOK_REAL),
        rentroll: ingest.parseRentRollCSV(RENT_REAL),
        reportDate: DATE,
        opening: { bank: 0, book: 0 },
        policy: null,
        priorClose: null,
      });
      expect(out.reportHtml).to.equal(report.renderHTML(model));
      expect(out.reportCsv).to.equal(report.renderExceptionsCSV(model));
      expect(out.summary).to.equal(report.summaryLine(model));
      expect(JSON.stringify(out.balances)).to.equal(JSON.stringify(model.balances));
      expect(JSON.stringify(out.exceptions)).to.equal(JSON.stringify(model.exceptions));
      expect(out.tiesOut).to.equal(model.tiesOut);
      // The packet is the real audit artifact, custodian disclaimer included.
      expect(out.reportHtml).to.match(/^<!doctype html>/i);
      expect(out.reportHtml).to.contain("broker remains the legal trust-account custodian");
      expect(out.reportCsv).to.contain("severity,type,label,amount_cents");
    });

    it("a MALFORMED file is the SAME named reject: HttpError 400 ingest_error, byte-identical message", function () {
      // The exact malformed case the server test POSTs (over-precise amount: rejected, not rounded).
      const payload = {
        bank: "date,amount\n2026-06-01,10.005\n",
        ledger: BOOK_1,
        rentroll: RENT_1,
      };
      const got = thrown(() => TLS.door.reconcilePayload(payload, DATE));
      const want = thrown(() => server.reconcilePayload(payload, DATE));
      expect(got, "the standalone rejects").to.not.equal(null);
      expect(want, "the web door rejects").to.not.equal(null);
      expect(got).to.deep.equal(want);
      expect(got.name).to.equal("HttpError");
      expect(got.status).to.equal(400);
      expect(got.code).to.equal("ingest_error");
      expect(got.message).to.match(/malformed amount/i);
    });

    it("TWO-MONTH prior-close continuity: month 1 closes, month 2 rolls forward and TIES OUT — byte-identical throughout", function () {
      // ---- month 1: the e2e clean fixtures (the same contents the server tests POST). ----
      const p1 = { bank: BANK_1, ledger: BOOK_1, rentroll: RENT_1 };
      const m1 = TLS.door.reconcilePayload(p1, DATE_1);
      expect(JSON.stringify(m1)).to.equal(JSON.stringify(server.reconcilePayload(p1, DATE_1)));
      expect(m1.tiesOut).to.equal(true);

      // The month-1 CLOSE artifact, built by the vm engine AND the in-tree engine — byte-identical
      // (this pins the vendored-sha256 inputsDigest inside the bundle too).
      const packetArgs = (eng) => ({
        bank: eng.ingest.parseBankStatement(BANK_1),
        book: eng.ingest.parseQuickBooksCSV(BOOK_1),
        rentroll: eng.ingest.parseRentRollCSV(RENT_1),
        reportDate: DATE_1,
        period: "2026-05",
        opening: { bank: 0, book: 0 },
        policy: null,
        priorClose: null,
      });
      const close1 = close.buildClose(report.buildPacket(packetArgs({ ingest, report })));
      const close1vm = TLS.engine.close.buildClose(TLS.engine.report.buildPacket(packetArgs(TLS.engine)));
      expect(JSON.stringify(close1vm)).to.equal(JSON.stringify(close1));
      // Month 1 ends with the $300 vendor check outstanding: bank 330000 / book 300000.
      expect(close1.ending).to.deep.equal({ bank: 330000, book: 300000 });

      // ---- month 2: prior-close threaded through the SAME payload field the web door reads. ----
      const p2 = { bank: BANK_2, ledger: BOOK_2, rentroll: RENT_2, priorClose: JSON.stringify(close1) };
      const m2 = TLS.door.reconcilePayload(p2, DATE_2);
      expect(JSON.stringify(m2)).to.equal(JSON.stringify(server.reconcilePayload(p2, DATE_2)));

      // The roll-forward TIES OUT: opening seeded from month 1's ending, the outstanding check
      // clears, and adjusted bank == book == sub-ledger == 300000 with NO continuity break.
      expect(m2.tiesOut).to.equal(true);
      expect(m2.pass).to.equal(true);
      expect(m2.balances.bank).to.equal(300000);
      expect(m2.balances.book).to.equal(300000);
      expect(m2.balances.subledger).to.equal(300000);
      expect(m2.balances.adjustedBank).to.equal(300000);
      expect(m2.balances.reconciled).to.equal(300000);
      expect(m2.exceptions.some((e) => e.type === "continuity_break")).to.equal(false);
      // The packet shows the roll-forward chain and names the prior period.
      expect(m2.reportHtml).to.match(/Period continuity/);
      expect(m2.reportHtml).to.contain("2026-05");
      expect(m2.summary).to.match(/^PASS:/);
    });

    it("a BROKEN roll-forward (opening != prior ending) raises the SAME continuity_break bytes as in-tree", function () {
      const close1 = close.buildClose(
        report.buildPacket({
          bank: ingest.parseBankStatement(BANK_1),
          book: ingest.parseQuickBooksCSV(BOOK_1),
          rentroll: ingest.parseRentRollCSV(RENT_1),
          reportDate: DATE_1,
          period: "2026-05",
          opening: { bank: 0, book: 0 },
          policy: null,
          priorClose: null,
        })
      );
      // Drive the RAW packet builder with an opening that does NOT roll forward (zero, vs the prior
      // ending) — reachable via the CLI's --opening override; the door itself always seeds exactly.
      const args = (eng) => ({
        bank: eng.ingest.parseBankStatement(BANK_2),
        book: eng.ingest.parseQuickBooksCSV(BOOK_2),
        rentroll: eng.ingest.parseRentRollCSV(RENT_2),
        reportDate: DATE_2,
        opening: { bank: 0, book: 0 },
        policy: null,
        priorClose: close1,
      });
      const intree = report.buildPacket(args({ ingest, report }));
      const invm = TLS.engine.report.buildPacket(args(TLS.engine));
      expect(JSON.stringify(invm.exceptions)).to.equal(JSON.stringify(intree.exceptions));
      expect(intree.exceptions.some((e) => e.type === "continuity_break")).to.equal(true);
      expect(TLS.engine.report.renderHTML(invm)).to.equal(report.renderHTML(intree));
    });

    it("inspectPayload parity: clean, renamed-header, and columnMap-override cases are byte-identical", function () {
      const RENT_RENAMED = RENT_1.replace("Tenant", "Occupant");
      const cases = [
        { source: "rentroll", text: RENT_1 },
        { source: "rentroll", text: RENT_RENAMED },
        { source: "rentroll", text: RENT_RENAMED, columnMap: { tenant: "Occupant" } },
        { source: "quickbooks", text: BOOK_1 },
        { source: "bank", text: BANK_REAL },
      ];
      for (const c of cases) {
        expect(
          JSON.stringify(TLS.door.inspectPayload(c)),
          `inspect(${c.source}${c.columnMap ? "+map" : ""})`
        ).to.equal(JSON.stringify(server.inspectPayload(c)));
      }
      // And the named refusals match too (unknown source / missing text).
      expect(thrown(() => TLS.door.inspectPayload({ source: "payroll", text: "x" }))).to.deep.equal(
        thrown(() => server.inspectPayload({ source: "payroll", text: "x" }))
      );
      expect(thrown(() => TLS.door.inspectPayload({ source: "bank" }))).to.deep.equal(
        thrown(() => server.inspectPayload({ source: "bank" }))
      );
    });

    it("the bundled default policies ride along as inlined JSON (same five, same resolution)", function () {
      const codes = TLS.engine.policy.bundledPolicies().map((e) => e.code);
      expect(codes).to.deep.equal(policyMod.bundledPolicies().map((e) => e.code));
      expect(codes).to.deep.equal([
        "ambiguous-deposit-example",
        "baseline",
        "ca-example",
        "negative-tenant-ledger-example",
        "owner-overdraw-example",
      ]);
      expect(JSON.stringify(TLS.engine.policy.resolveState("baseline"))).to.equal(
        JSON.stringify(policyMod.resolveState("baseline"))
      );
      expect(() => TLS.engine.policy.resolveState("no-such-state")).to.throw(/bundled states are:/);
    });
  });

  // ============================================================================================
  // (3) NO NETWORK: the token test over the WHOLE emitted file
  // ============================================================================================
  describe("(3) no-network token test over the whole emitted file", function () {
    it("contains NONE of: fetch( / XMLHttpRequest / WebSocket / EventSource / sendBeacon / import(", function () {
      const html = committedHtml();
      for (const tok of NETWORK_TOKENS) {
        expect(html.includes(tok), `forbidden token ${JSON.stringify(tok)}`).to.equal(false);
      }
      // A fresh build is equally clean (the guarantee is the builder's, not one artifact's).
      const fresh = builder.buildHtml();
      for (const tok of NETWORK_TOKENS) {
        expect(fresh.includes(tok), `forbidden token ${JSON.stringify(tok)} (fresh build)`).to.equal(false);
      }
    });

    it("every transport seam was swapped: no seam marker survives; the in-page door calls are present", function () {
      const html = committedHtml();
      expect(html).to.not.contain("__TL_TRANSPORT_SEAM");
      expect(html).to.contain("__tlOfflineApi(function (door, today) { return door.inspectPayload(body); });");
      expect(html).to.contain(
        "__tlOfflineApi(function (door, today) { return door.reconcilePayload(body, today()); });"
      );
      // The glue mirrors the server envelope: named HttpError -> { error, message }.
      expect(html).to.contain("err instanceof TrustLedgerStandalone.door.HttpError");
      expect(html).to.contain('{ error: "internal_error", message: "an internal error occurred" }');
    });

    it("keeps the EXISTING drag-drop UI and swaps the transport prose for the honest offline claim", function () {
      const html = committedHtml();
      // The same UI the web door serves: FileReader drag-drop, inspect/map affordance, downloads.
      expect(html).to.contain("FileReader");
      expect(html).to.contain("readAsText");
      expect(html).to.contain("pendingMaps");
      expect(html).to.contain("Confirm mapping");
      expect(html).to.contain("reportHtml");
      expect(html).to.contain("reportCsv");
      expect(html.toLowerCase()).to.contain("disclaimer");
      expect(html).to.contain("broker remains the legal trust-account custodian");
      // The honest offline claim replaced the server-transport claim.
      expect(html).to.contain("never leaves this machine");
      expect(html).to.not.contain("their contents to this server");
      expect(html).to.not.contain("server never holds a key");
      // The generated banner names the generator and the FREE-tier boundary.
      expect(html).to.contain("GENERATED by trustledger/build-standalone.js");
      expect(html).to.contain("FREE tier");
    });
  });

  // ============================================================================================
  // (4) PAID surface: the SAME named refusal as the web door; fail-closed with a license
  // ============================================================================================
  describe("(4) paid-surface payloads: the same named refusal as the web door", function () {
    let TLS;
    before(function () {
      TLS = loadEngine(fs.readFileSync(DIST_HTML, "utf8"));
    });

    it("a `state` request with NO license: HttpError 402 license_required, message BYTE-IDENTICAL to the web door's", function () {
      const payload = { bank: BANK_1, ledger: BOOK_1, rentroll: RENT_1, state: "ca-example" };
      const got = thrown(() => TLS.door.reconcilePayload(payload, DATE));
      const want = thrown(() => server.reconcilePayload(payload, DATE));
      expect(got, "the standalone refuses").to.not.equal(null);
      expect(got).to.deep.equal(want);
      expect(got.status).to.equal(402);
      expect(got.code).to.equal("license_required");
      expect(got.message).to.match(/multi-state policy/);
      expect(got.message).to.match(/free tier/i);
    });

    it("a `seal` request with NO license: the same named 402 license_required both sides", function () {
      const payload = { bank: BANK_1, ledger: BOOK_1, rentroll: RENT_1, seal: true };
      const got = thrown(() => TLS.door.reconcilePayload(payload, DATE));
      const want = thrown(() => server.reconcilePayload(payload, DATE));
      expect(got).to.deep.equal(want);
      expect(got.status).to.equal(402);
      expect(got.code).to.equal("license_required");
      expect(got.message).to.match(/seal/);
    });

    it("a paid request WITH a license is refused FAIL-CLOSED offline: named 403 license_invalid pointing at the installed product", function () {
      const payload = {
        bank: BANK_1,
        ledger: BOOK_1,
        rentroll: RENT_1,
        state: "ca-example",
        license: "{}",
        vendorAddress: "0x" + "ab".repeat(20),
      };
      const got = thrown(() => TLS.door.reconcilePayload(payload, DATE));
      expect(got, "never grants a paid surface offline").to.not.equal(null);
      expect(got.name).to.equal("HttpError");
      expect(got.status).to.equal(403);
      expect(got.code).to.equal("license_invalid");
      expect(got.message).to.match(/installed TrustLedger product/);
      // The gate mapping itself is the verbatim door-core one (not re-implemented): same
      // entitlement contract, exposed under the same export.
      expect(JSON.stringify(TLS.door.WEB_PAID_FEATURE_ENTITLEMENTS.map((f) => f.entitlement))).to.equal(
        JSON.stringify(doorCore.WEB_PAID_FEATURE_ENTITLEMENTS.map((f) => f.entitlement))
      );
    });

    it("the offline license shim can NEVER produce a valid verdict (fail closed by construction)", function () {
      // Belt and suspenders on the shim body the build inlines: no true `valid`, no entitlements.
      expect(builder.LICENSE_SHIM_BODY).to.contain('valid: false');
      expect(builder.LICENSE_SHIM_BODY).to.not.contain("valid: true");
      expect(builder.LICENSE_SHIM_BODY).to.contain("installed TrustLedger product");
    });
  });

  // ============================================================================================
  // (5) the server.js refactor is verdict-neutral: identical function objects re-exported
  // ============================================================================================
  describe("(5) server.js delegates to door-core (verdict-neutral refactor)", function () {
    it("server.js re-exports the IDENTICAL door-core functions (same objects, zero drift possible)", function () {
      expect(server.reconcilePayload).to.equal(doorCore.reconcilePayload);
      expect(server.inspectPayload).to.equal(doorCore.inspectPayload);
      expect(server.gatePayload).to.equal(doorCore.gatePayload);
      expect(server.HttpError).to.equal(doorCore.HttpError);
      expect(server.WEB_PAID_FEATURE_ENTITLEMENTS).to.equal(doorCore.WEB_PAID_FEATURE_ENTITLEMENTS);
    });

    it("door-core is pure of transport: it requires no http/fs/path and never touches the network", function () {
      const src = stripComments(fs.readFileSync(path.join(TL, "door-core.js"), "utf8"));
      const specs = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      expect(specs.sort()).to.deep.equal(["./close", "./ingest", "./license", "./policy", "./report"]);
      for (const tok of NETWORK_TOKENS) {
        expect(src.includes(tok), `door-core must not contain ${JSON.stringify(tok)}`).to.equal(false);
      }
    });
  });
});
