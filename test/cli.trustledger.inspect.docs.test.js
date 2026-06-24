"use strict";

// ---------------------------------------------------------------------------
// T-25.4 docs-rot guard for `vh trust inspect` + the column-mapping escape hatch.
//
// Pure (no chain, no CLI run): asserts docs/TRUSTLEDGER.md + STRATEGY.md document the onboarding
// layer (T-25.1 diagnoseSource, T-25.2 `vh trust inspect`, T-25.3 --map/--map-file + widened
// alias/date coverage) the way the code actually behaves, so the buyer-/handoff-facing prose can't
// silently drift from trustledger/ingest.js (diagnoseSource/aliasesFor/columnMap) + the inspect CLI.
//
// Load-bearing properties under test:
//   * docs/TRUSTLEDGER.md has an "## Onboarding: inspect before you reconcile" section that documents
//     what inspect reports, that it WRITES NOTHING and checks only PARSING, the exit codes (0 clean /
//     3 not-clean / 2 usage / 1 IO), the --map/--map-file override syntax (inspect vs reconcile), a
//     worked "header isn't recognized -> inspect -> --map -> it loads" example, and the widened
//     alias/date coverage, reusing the standing custodian/CPA caveats so they stay consistent;
//   * STRATEGY.md's P-5 #3 is SHARPENED so the design-partner script LEADS with `vh trust inspect`
//     (confirm each file parses, fix a miss with --map) THEN runs the two-month reconcile.
// The guard imports the live modules so it fails loudly if the surface is ever removed — an otherwise-
// hollow docs guard. It pins the documented exit-code class, the inspect caveat/scope strings, and the
// actual alias coverage against the live code.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// Run a CLI command with stdout/stderr captured (no chain, no real fs writes
// from the command under test — inspect is read-only; reconcile here only
// pre-flights the map and exits before writing). Returns { code, out, err }.
function runCli(fn, argv) {
  let out = "";
  let err = "";
  const io = {
    write: (s) => {
      out += s;
    },
    writeErr: (s) => {
      err += s;
    },
  };
  const code = fn(argv, io);
  return { code, out, err };
}

const ingest = require("../trustledger/ingest");
const cli = require("../trustledger/cli");

describe("T-25.4 docs: `vh trust inspect` + column-mapping escape hatch (docs/TRUSTLEDGER.md + STRATEGY.md)", function () {
  let doc, docLower, strategy;

  before(function () {
    doc = read("docs/TRUSTLEDGER.md");
    docLower = doc.toLowerCase();
    strategy = read("STRATEGY.md");
  });

  it("trustledger/ingest.js + cli.js still export the surface this guard pins against", function () {
    // Tripwire: if these vanish, the doc assertions below would be meaningless.
    expect(ingest.diagnoseSource, "diagnoseSource").to.be.a("function");
    expect(ingest.aliasesFor, "aliasesFor").to.be.a("function");
    expect(ingest.validateColumnMap, "validateColumnMap").to.be.a("function");
    expect(cli.cmdInspect, "cmdInspect").to.be.a("function");
    expect(cli.cmdTrust, "cmdTrust").to.be.a("function");
    // The documented exit-code contract is the live one.
    expect(cli.EXIT).to.include({ PASS: 0, IO: 1, USAGE: 2, FAIL: 3 });
  });

  describe("docs/TRUSTLEDGER.md: '## Onboarding: inspect before you reconcile' section", function () {
    let section, sectionLower;
    before(function () {
      const start = docLower.indexOf("## onboarding: inspect before you reconcile");
      expect(start, "onboarding section present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      const end = rest.indexOf("\n## ", 3);
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
    });

    it("documents the command + that it runs over ONE file with --as", function () {
      expect(section).to.include("vh trust inspect");
      expect(section).to.match(/--as <bank\|ledger\|rentroll>|--as bank\|ledger\|rentroll/);
    });

    it("documents WHAT inspect reports (format, header map, count, every failing row, hint)", function () {
      expect(sectionLower).to.match(/detected format/);
      expect(sectionLower).to.match(/logical[- ]?field.*header|logical field/);
      expect(sectionLower).to.match(/\(not found\) \[required\]/);
      expect(sectionLower).to.match(/parsed:/);
      expect(sectionLower).to.match(/sample/);
      // EVERY failing row, not just the first.
      expect(sectionLower).to.match(/every.*failing row|every.*row/);
      expect(sectionLower).to.match(/how to fix/);
    });

    it("states inspect WRITES NOTHING and checks only PARSING (does not reconcile/attest)", function () {
      expect(sectionLower).to.match(/writes nothing|write nothing/);
      expect(sectionLower).to.match(/checks only parsing|only parsing|only checks.*pars/);
      expect(sectionLower).to.match(/does\s*\*?\*?not\*?\*?\s*reconcile/);
      expect(sectionLower).to.match(/attest/);
    });

    it("reuses the standing custodian/CPA caveats (verbatim inspect caveat + scope)", function () {
      // The exact caveat string the command leads with must appear in the doc.
      expect(section).to.include(
        "TrustLedger AIDS reconciliation; the broker remains the responsible custodian."
      );
      expect(sectionLower).to.match(/custodian/);
      expect(sectionLower).to.match(/cpa/);
      // A clean inspect is explicitly NOT a PASS / not a compliance statement.
      expect(sectionLower).to.match(/not a pass|is not a pass/);
    });

    it("documents the exit codes (0 clean / 3 not-clean / 2 usage / 1 IO), incl. the reconcile contrast", function () {
      expect(sectionLower).to.match(/exit code/);
      // Each documented code with its meaning.
      expect(section).to.match(/`0`/);
      expect(section).to.match(/`3`/);
      expect(section).to.match(/`2`/);
      expect(section).to.match(/`1`/);
      expect(sectionLower).to.match(/clean/);
      expect(sectionLower).to.match(/usage error/);
      // The load-bearing contrast: a malformed file is exit 1 for reconcile but exit 3 for inspect.
      expect(sectionLower).to.match(/exit `?1`?[\s\S]{0,80}exit `?3`?|exit `?3`?[\s\S]{0,120}exit `?1`?/);
    });

    it("documents --map / --map-file override syntax (inspect vs reconcile forms)", function () {
      expect(section).to.include("--map");
      expect(section).to.include("--map-file");
      // The two distinct forms.
      expect(section).to.match(/--map <logical>=<header>/);
      expect(section).to.match(/--map <source>:<logical>=<header>/);
      // It is an override of the alias auto-detect, repeatable, and a bad value is a usage error (exit 2).
      expect(sectionLower).to.match(/override/);
      expect(sectionLower).to.match(/repeatable/);
      expect(section).to.match(/exit `?2`?|usage error/);
    });

    it("shows the worked 'header isn't recognized -> inspect -> --map -> it loads' example", function () {
      // The example uses a no-alias header set and ends in a clean load.
      expect(section).to.include("vh trust inspect");
      expect(section).to.match(/not found\) \[required\]/i);
      expect(section).to.match(/--map date=/i);
      expect(section).to.match(/parsed: 4 OK of 4|parsed:.*OK of/);
      expect(section).to.match(/exit=3/);
      expect(section).to.match(/exit=0/);
      // The "their file loads or the tool tells them how" framing.
      expect(sectionLower).to.match(/their file loads|loads, or the tool tells/);
    });

    it("documents the widened alias + date coverage against the live aliases", function () {
      // Pin a couple of real aliases the doc claims are accepted against the live config.
      const bankDate = ingest.aliasesFor("bank", "date").map((a) => a.toLowerCase());
      expect(bankDate, "live bank date aliases").to.include("posting date");
      expect(bankDate).to.include("transaction date");
      // The doc names them.
      expect(sectionLower).to.match(/posting date/);
      // The new textual date forms are documented AND actually parse.
      expect(sectionLower).to.match(/jan 5, 2024|mon dd, yyyy/);
      expect(sectionLower).to.match(/dd-mon-yyyy|5-jan-2024/);
      expect(ingest.parseDate("Jan 5, 2024")).to.equal("2024-01-05");
      expect(ingest.parseDate("5-Jan-2024")).to.equal("2024-01-05");
      // Still calendar-validated / named-error on a bad textual date.
      expect(sectionLower).to.match(/calendar-validated|named error/);
      expect(() => ingest.parseDate("Feb 30, 2024")).to.throw();
    });

    it("the rent-roll tenant aliases it names are LIVE, and it does NOT claim `Tenant Name` loads with no map", function () {
      // The single-word tenant headers the doc lists as no-map aliases are the live ones.
      const tenant = ingest.aliasesFor("rent_roll", "tenant").map((a) => a.toLowerCase());
      for (const a of ["tenant", "resident", "lessee", "lease", "name"]) {
        expect(tenant, `live tenant alias ${a}`).to.include(a);
      }
      // The two-word `Tenant Name` is NOT a live alias — so the doc must not list it among the
      // no-map headers. It is allowed to appear ONLY as the --map example header.
      expect(tenant).to.not.include("tenant name");
      // In the "loads with NO map" coverage section, `Tenant Name` must not be presented as accepted.
      // It may appear, but only flagged as not-itself-an-alias / the thing --map maps.
      if (/tenant name/i.test(section)) {
        expect(section).to.match(/tenant name[^.\n]*\bnot\b[^.\n]*alias|not\b[^.\n]*\btenant name/i);
      }
    });
  });

  describe("docs/TRUSTLEDGER.md: Usage + pipeline + human-step sections updated", function () {
    it("the reconcile Usage options block lists --map and --map-file", function () {
      const start = docLower.indexOf("## usage");
      expect(start, "usage section present").to.be.greaterThan(-1);
      const usage = doc.slice(start, docLower.indexOf("## onboarding", start));
      expect(usage).to.match(/--map /);
      expect(usage).to.match(/--map-file /);
    });

    it("the pipeline diagram names `vh trust inspect`", function () {
      const start = docLower.indexOf("## how it works");
      expect(start, "pipeline section present").to.be.greaterThan(-1);
      const pipe = doc.slice(start, start + 1200);
      expect(pipe).to.include("vh trust inspect");
    });

    it("the 'What stays a human step' P-5 #3 bullet LEADS with the BROWSER inspect/map UI, THEN the two-month reconcile", function () {
      const start = docLower.indexOf("## what stays a human step");
      expect(start, "human-step section present").to.be.greaterThan(-1);
      const human = doc.slice(start);
      const humanLower = human.toLowerCase();
      // FIRST step is now the BROWSER (vh trust serve), not a terminal command (T-28.3).
      expect(humanLower).to.match(/first[\s\S]{0,260}browser/);
      expect(humanLower).to.match(/first[\s\S]{0,260}vh trust serve/);
      expect(humanLower).to.match(/in-browser inspect\/map ui|in-browser inspect ?\/ ?map/);
      // The CLI inspect/map path is still named as the equivalent for technical users.
      expect(human).to.include("vh trust inspect <eachFile> --as <type>");
      expect(humanLower).to.match(/--map/);
      // It explicitly closes the terminal gap.
      expect(humanLower).to.match(/no terminal|never use a terminal|without.*terminal/);
      // THEN the two-month reconcile.
      expect(humanLower).to.match(/then[\s\S]{0,400}--emit-close\s+month1\.json/);
      expect(human).to.match(/--prior-close month1\.json/);
      // The de-risk + WTP framing is preserved.
      expect(humanLower).to.match(/loads, or the tool tells|self-service fix|dead end/);
      expect(humanLower).to.match(/willingness-to-pay|wtp/);
    });
  });

  describe("docs/TRUSTLEDGER.md: '## The web front-door' documents the in-browser inspect/map flow (T-28.3)", function () {
    let section, sectionLower;
    before(function () {
      const start = docLower.indexOf("## the web front-door");
      expect(start, "web front-door section present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      const end = rest.indexOf("\n## ", 3);
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
    });

    it("has a dedicated in-browser inspect/map onboarding subsection", function () {
      expect(sectionLower).to.match(/in-browser onboarding/);
      // The non-technical onboarding path: drop a file, see columns, map, reconcile.
      expect(sectionLower).to.match(/drop a file|drop each file|drop the/);
      expect(sectionLower).to.match(/detected header|header columns|its columns/);
      expect(sectionLower).to.match(/dropdown/);
      expect(sectionLower).to.match(/map/);
      expect(sectionLower).to.match(/reconcile/);
    });

    it("states it is the SAME diagnoseSource fix as the CLI, but with no terminal", function () {
      expect(sectionLower).to.match(/diagnosesource/);
      // The companion CLI command is named.
      expect(section).to.match(/vh trust inspect/);
      expect(section).to.match(/--map <logical>=<header>|--map/);
      // No terminal required — the gap this closes.
      expect(sectionLower).to.match(/no terminal|never (open|use) a terminal|without.*terminal|not a command line|not a terminal/);
    });

    it("documents the /api/inspect endpoint as read-only / writes nothing server-side", function () {
      expect(section).to.match(/\/api\/inspect/);
      expect(sectionLower).to.match(/writes nothing|nothing.*server-side|read-only/);
    });

    it("reuses the standing custodian/CPA caveat so the posture stays consistent", function () {
      // A clean in-browser inspect is NOT a PASS / not a compliance statement.
      expect(sectionLower).to.match(/loads.*not that the books are right|not that the books|loads.*not.*right/);
      expect(sectionLower).to.match(/cpa/);
      expect(sectionLower).to.match(/disclaimer/);
    });

    it("the live web surface this prose pins against still exists (server endpoint + UI map control)", function () {
      // Tripwire: the documented browser fix must actually be in the shipped code.
      const server = read("trustledger/server.js");
      expect(server).to.match(/\/api\/inspect/);
      expect(server).to.match(/inspectPayload/);
      expect(server).to.match(/diagnoseSource/);
      const page = read("trustledger/public/index.html");
      expect(page).to.contain('fetch("/api/inspect"');
      expect(page).to.match(/class='mapsel'|class="mapsel"/);
      expect(page).to.contain("Confirm mapping");
    });
  });

  describe("STRATEGY.md: P-5 item #3 SHARPENED to LEAD with `vh trust inspect`", function () {
    let item3;
    before(function () {
      const p5 = strategy.indexOf("P-5 (2026-06-24)");
      expect(p5, "P-5 proposal present").to.be.greaterThan(-1);
      const tail = strategy.slice(p5);
      const start = tail.indexOf("\n  3. ");
      expect(start, "P-5 item 3 present").to.be.greaterThan(-1);
      const rest = tail.slice(start);
      const end = rest.indexOf("\n  Hosting");
      item3 = (end === -1 ? rest : rest.slice(0, end)).toLowerCase();
    });

    it("LEADS with the BROWSER onboarding step: FIRST `vh trust serve` in the browser, the in-browser inspect/map UI", function () {
      // T-28.3: the FIRST step is now the browser, not a terminal command.
      expect(item3).to.match(/first[\s\S]{0,260}browser/);
      expect(item3).to.match(/first[\s\S]{0,260}vh trust serve/);
      expect(item3).to.match(/in-browser inspect\/map ui|in-browser inspect ?\/ ?map/);
      // The CLI inspect/map path is still named as the same fix for technical users.
      expect(item3).to.include("vh trust inspect <eachfile> --as <type>");
      // Fix a header miss with --map.
      expect(item3).to.match(/--map <logical>=<header>|--map/);
      // inspect writes nothing / checks only PARSING.
      expect(item3).to.match(/writes nothing|checks only parsing/);
      // It explicitly closes the "never use a terminal" gap.
      expect(item3).to.match(/no terminal|never (open|use|touch).{0,20}terminal|without.{0,20}terminal/);
    });

    it("THEN runs the two-month reconcile script (emit-close month1 -> prior-close month1)", function () {
      expect(item3).to.match(/then[\s\S]{0,200}--emit-close month1\.json/);
      expect(item3).to.include("--prior-close month1.json");
      expect(item3).to.match(/both months/);
      expect(item3).to.match(/continuity_break/);
    });

    it("keeps the WTP framing + the de-risk wording, and anchors to the shipped mechanism + doc", function () {
      expect(item3).to.match(/is the wtp validation|two-month run is the wtp/);
      expect(item3).to.match(/past month one/);
      expect(item3).to.match(/hope their file matches our fixtures|the tool tells them how/);
      // Anchored to the shipped EPIC-25 surface + the doc (not a rewrite).
      expect(item3).to.match(/epic-25|t-25\.1|inspect/);
      expect(item3).to.match(/no engine change|no engine-change/);
      expect(item3).to.match(/docs\/trustledger\.md/);
    });
  });

  // -------------------------------------------------------------------------
  // Behavioral pin: the documented inspect-vs-reconcile exit SPLIT is the live
  // one. A previous doc rev claimed a semantic map error (unknown logical field
  // or a mapped-to header absent from the file) is exit 2 for BOTH commands;
  // it is exit 2 for reconcile (pre-flight) but exit 3 for inspect (it routes
  // through the diagnostic parse). This block exercises the real CLI over a
  // filesystem-isolated temp fixture so the prose cannot drift from the code.
  // -------------------------------------------------------------------------
  describe("live exit-split: semantic map errors are exit 3 for inspect, exit 2 for reconcile", function () {
    let dir, rr, bank, ledger;
    before(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-mapexit-"));
      rr = path.join(dir, "rentroll.csv");
      bank = path.join(dir, "bank.csv");
      ledger = path.join(dir, "ledger.csv");
      fs.writeFileSync(rr, "Date,Tenant,Amount Paid\n2024-01-05,Alice,100.00\n");
      fs.writeFileSync(
        bank,
        "Date,Description,Debit,Credit,Type\n2024-01-05,Rent,,100.00,deposit\n"
      );
      fs.writeFileSync(
        ledger,
        "Date,Description,Debit,Credit,Name\n2024-01-05,Rent,,100.00,Alice\n"
      );
    });
    after(function () {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("inspect: a mapped-to header absent from the file -> EXIT 3 (not 2)", function () {
      const { code } = runCli(cli.cmdInspect, [
        rr,
        "--as",
        "rentroll",
        "--map",
        "date=NoSuchColumn",
      ]);
      expect(code).to.equal(cli.EXIT.FAIL); // 3
    });

    it("inspect: an unknown logical field -> EXIT 3 (not 2)", function () {
      const { code } = runCli(cli.cmdInspect, [
        rr,
        "--as",
        "rentroll",
        "--map",
        "bogusfield=Date",
      ]);
      expect(code).to.equal(cli.EXIT.FAIL); // 3
    });

    it("inspect: a STRUCTURAL bad --map (no '=') is still EXIT 2 (usage)", function () {
      const { code } = runCli(cli.cmdInspect, [
        rr,
        "--as",
        "rentroll",
        "--map",
        "nofield",
      ]);
      expect(code).to.equal(cli.EXIT.USAGE); // 2
    });

    it("reconcile: the SAME semantic map errors pre-flight to EXIT 2 (usage)", function () {
      const absent = runCli(cli.cmdReconcile, [
        bank,
        ledger,
        rr,
        "--map",
        "bank:date=NoSuchColumn",
      ]);
      expect(absent.code).to.equal(cli.EXIT.USAGE); // 2

      const unknown = runCli(cli.cmdReconcile, [
        bank,
        ledger,
        rr,
        "--map",
        "bank:bogus=Date",
      ]);
      expect(unknown.code).to.equal(cli.EXIT.USAGE); // 2
    });

    it("rent-roll loads with NO map when tenant uses a LIVE alias, but NOT with `Tenant Name`", function () {
      // `Tenant` (a live alias) -> clean parse, no map.
      const live = runCli(cli.cmdInspect, [rr, "--as", "rentroll"]);
      expect(live.code).to.equal(cli.EXIT.PASS); // 0

      // `Tenant Name` (NOT a live alias) -> required tenant column not found, exit 3.
      const tn = path.join(dir, "rr-tenantname.csv");
      fs.writeFileSync(tn, "Date,Tenant Name,Amount Paid\n2024-01-05,Alice,100.00\n");
      const miss = runCli(cli.cmdInspect, [tn, "--as", "rentroll"]);
      expect(miss.code).to.equal(cli.EXIT.FAIL); // 3
    });
  });
});
