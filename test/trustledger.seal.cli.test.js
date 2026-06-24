"use strict";

// TrustLedger — `vh trust reconcile --seal` + `vh trust verify-seal` CLI wiring
// tests (T-26.2, incl. the operability REWORK).
//
// Proves the seal round-trips end to end through the PUBLIC `vh trust` dispatch,
// OFFLINE (no key, no network), with every filesystem effect isolated to a
// throwaway temp dir (the working tree stays clean, pass or fail):
//
//   * `reconcile <bank> <ledger> <rentroll> --out tmp --seal` writes the seal
//     AFTER the packet, and the seal lists the 3 inputs + every packet file;
//   * the 3 SOURCE inputs are sealed by BASENAME (PORTABLE handoff — REWORK 1):
//     no `../` escape, no absolute machine path leaks into the seal;
//   * `verify-seal <seal>` ACCEPTS (exit 0) when the sources sit next to the seal;
//     `--inputs <d>` locates the sources in a separate folder;
//   * editing one packet file then `verify-seal` REJECTS (exit 3) and NAMES it;
//   * deleting a sealed file -> MISSING / REJECT;
//   * shipping ONLY the out/ folder (sources absent) REJECTS, reports the absent
//     SOURCES as MISSING, and does NOT mislabel the present packet files (REWORK 2);
//   * `--seal` WITHOUT `--out` hard-errors (exit 2) with an actionable message;
//   * `--json` round-trips; a malformed seal file hard-errors (exit 1) BEFORE any
//     sealed file is read; the output LEADS with the custodian/trust caveat;
//   * --emit-close is sealed too; unknown flags hard-error with usage.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { cmdTrust, runReconcile, EXIT } = require("../trustledger/cli");
const sealMod = require("../trustledger/seal");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures", "e2e");
const BANK = path.join(FIX, "bank.csv");
const BOOK = path.join(FIX, "quickbooks.csv");
const RENT = path.join(FIX, "rentroll.csv");

const DATE = "2026-06-24"; // pinned so packet/seal filenames are deterministic
const SEAL_NAME = `reconciliation-${DATE}-seal.json`;

function capture() {
  const out = [];
  const err = [];
  return {
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    today: () => DATE,
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("trustledger T-26.2: `vh trust reconcile --seal` + `verify-seal`", function () {
  let tmpDirs;
  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tl-seal-cli-"));
    tmpDirs.push(d);
    return d;
  }

  // Drive a `reconcile ... --out dir --seal` through the public dispatch.
  function reconcileSeal(dir, extra = []) {
    const io = capture();
    const code = cmdTrust(
      ["reconcile", BANK, BOOK, RENT, "--date", DATE, "--out", dir, "--seal", ...extra],
      io
    );
    return { code, io };
  }

  // Copy the 3 source inputs (by basename) NEXT TO the seal — the PORTABLE handoff
  // the broker ships. After this, `verify-seal <seal>` ACCEPTS with no --inputs.
  function shipSourcesInto(dir) {
    fs.copyFileSync(BANK, path.join(dir, path.basename(BANK)));
    fs.copyFileSync(BOOK, path.join(dir, path.basename(BOOK)));
    fs.copyFileSync(RENT, path.join(dir, path.basename(RENT)));
  }

  it("writes the seal AFTER the packet; lists the 3 inputs (by BASENAME) + every packet file", function () {
    const dir = mkTmp();
    const { code, io } = reconcileSeal(dir);
    expect(code).to.equal(EXIT.PASS);

    const sealPath = path.join(dir, SEAL_NAME);
    expect(fs.existsSync(sealPath), "seal file written under --out").to.equal(true);

    // The success output names the seal path.
    expect(io.out()).to.contain(`wrote seal ${sealPath}`);

    // The packet files all exist and the seal lists each of them as an output.
    const html = `reconciliation-${DATE}.html`;
    const exCsv = `reconciliation-${DATE}-exceptions.csv`;
    const balCsv = `reconciliation-${DATE}-balances.csv`;
    for (const f of [html, exCsv, balCsv]) {
      expect(fs.existsSync(path.join(dir, f)), `${f} exists`).to.equal(true);
    }

    const seal = sealMod.readSeal(fs.readFileSync(sealPath, "utf8"));
    // 3 inputs by role (bank / book / rentroll).
    expect(seal.inputs.map((i) => i.role).sort()).to.deep.equal(["bank", "book", "rentroll"]);
    // REWORK 1: the 3 source inputs are sealed by BASENAME — the binding TRAVELS with
    // the packet. NO relPath escapes the packet dir (`..`) and NONE is an absolute path
    // (which would leak the producing machine's home dir and bind the root to its layout).
    for (const i of seal.inputs) {
      expect(i.relPath, "input relPath is a bare basename").to.equal(path.basename(i.relPath));
      expect(i.relPath).to.not.contain("..");
      expect(path.isAbsolute(i.relPath), "input relPath is not absolute").to.equal(false);
    }
    expect(seal.inputs.map((i) => i.relPath).sort()).to.deep.equal(
      [path.basename(BANK), path.basename(BOOK), path.basename(RENT)].sort()
    );
    // Every emitted packet file is a sealed output (relPaths are basenames here).
    const outRel = seal.outputs.map((o) => o.relPath).sort();
    expect(outRel).to.deep.equal([balCsv, exCsv, html]);
    // fileCount = 3 inputs + 3 packet files.
    expect(seal.fileCount).to.equal(6);
    // The recorded verdict is the reconcile's PASS fact.
    expect(seal.verdict.pass).to.equal(true);
    expect(seal.verdict.reportDate).to.equal(DATE);

    // ONLY the packet + seal landed in the dir — nothing else.
    expect(fs.readdirSync(dir).sort()).to.deep.equal(
      [balCsv, exCsv, html, SEAL_NAME].sort()
    );
  });

  it("REWORK 1: a seal produced from a DIFFERENT working dir has the SAME root (byte-portable)", function () {
    // Two brokers seal byte-identical inputs from different on-disk layouts; the basename
    // binding makes the seal root depend ONLY on the bytes + names, not the machine path.
    const dirA = mkTmp();
    const dirB = mkTmp();
    expect(reconcileSeal(dirA).code).to.equal(EXIT.PASS);
    expect(reconcileSeal(dirB).code).to.equal(EXIT.PASS);
    const sealA = sealMod.readSeal(fs.readFileSync(path.join(dirA, SEAL_NAME), "utf8"));
    const sealB = sealMod.readSeal(fs.readFileSync(path.join(dirB, SEAL_NAME), "utf8"));
    expect(sealA.root).to.equal(sealB.root);
    // And the serialized seal bytes are identical (deterministic artifact).
    expect(fs.readFileSync(path.join(dirA, SEAL_NAME), "utf8")).to.equal(
      fs.readFileSync(path.join(dirB, SEAL_NAME), "utf8")
    );
  });

  it("verify-seal ACCEPTS the PORTABLE handoff (sources next to the seal) and LEADS with the trust caveat", function () {
    const dir = mkTmp();
    expect(reconcileSeal(dir).code).to.equal(EXIT.PASS);
    shipSourcesInto(dir); // ship the sources next to the seal — the realistic handoff

    const io = capture();
    const code = cmdTrust(["verify-seal", path.join(dir, SEAL_NAME)], io);
    expect(code).to.equal(EXIT.PASS);
    expect(io.out()).to.contain("ACCEPTED");
    // Custodian + tamper-evidence (NOT timestamp) caveat leads the output.
    expect(io.out()).to.match(/responsible trust-account custodian/);
    expect(io.out()).to.match(/TAMPER-EVIDENT/);
    expect(io.out()).to.match(/NOT a trusted timestamp/);
  });

  it("verify-seal --inputs locates the sources in a SEPARATE folder from the packet", function () {
    const dir = mkTmp();
    expect(reconcileSeal(dir).code).to.equal(EXIT.PASS);
    // Sources stay in the fixtures dir; point --inputs at it. Outputs default to the seal dir.
    const io = capture();
    const code = cmdTrust(["verify-seal", path.join(dir, SEAL_NAME), "--inputs", FIX], io);
    // The fixtures dir holds bank.csv/quickbooks.csv/rentroll.csv under those exact basenames.
    expect(code).to.equal(EXIT.PASS);
    expect(io.out()).to.contain("ACCEPTED");
  });

  it("editing ONE packet file makes verify-seal REJECT (exit 3) and NAME that file", function () {
    const dir = mkTmp();
    expect(reconcileSeal(dir).code).to.equal(EXIT.PASS);
    shipSourcesInto(dir);

    // Tamper with the balances CSV (any byte change flips the leaf -> root).
    const balCsv = `reconciliation-${DATE}-balances.csv`;
    const target = path.join(dir, balCsv);
    fs.writeFileSync(target, fs.readFileSync(target, "utf8") + "tampered\n");

    const io = capture();
    const code = cmdTrust(["verify-seal", path.join(dir, SEAL_NAME)], io);
    expect(code).to.equal(EXIT.FAIL);
    expect(io.out()).to.contain("REJECTED");
    expect(io.out()).to.contain("CHANGED");
    expect(io.out()).to.contain(balCsv);
  });

  it("deleting a sealed file makes verify-seal report MISSING and REJECT", function () {
    const dir = mkTmp();
    expect(reconcileSeal(dir).code).to.equal(EXIT.PASS);
    shipSourcesInto(dir);

    const html = `reconciliation-${DATE}.html`;
    fs.rmSync(path.join(dir, html));

    const io = capture();
    const code = cmdTrust(["verify-seal", path.join(dir, SEAL_NAME)], io);
    expect(code).to.equal(EXIT.FAIL);
    expect(io.out()).to.contain("REJECTED");
    expect(io.out()).to.contain("MISSING");
    expect(io.out()).to.contain(html);
  });

  it("REWORK 2: shipping ONLY the out/ folder reports the absent SOURCES as MISSING and does NOT mislabel the present packet files", function () {
    const dir = mkTmp();
    expect(reconcileSeal(dir).code).to.equal(EXIT.PASS);
    // Do NOT ship the sources — only the packet + seal are present (the out/-only handoff).

    const io = capture();
    const code = cmdTrust(["verify-seal", path.join(dir, SEAL_NAME)], io);
    expect(code).to.equal(EXIT.FAIL);
    expect(io.out()).to.contain("REJECTED");

    // The 3 SOURCE inputs (absent) are MISSING...
    for (const src of [BANK, BOOK, RENT]) {
      expect(io.out(), `${path.basename(src)} reported MISSING`).to.contain(
        `MISSING    ${path.basename(src)}`
      );
    }
    // ...but the present packet files are MATCHED, NOT falsely reported MISSING.
    const html = `reconciliation-${DATE}.html`;
    const balCsv = `reconciliation-${DATE}-balances.csv`;
    expect(io.out(), "present packet HTML not mislabeled MISSING").to.not.contain(
      `MISSING    ${html}`
    );
    expect(io.out(), "present packet balances not mislabeled MISSING").to.not.contain(
      `MISSING    ${balCsv}`
    );

    // The structured counts confirm it: exactly the 3 sources MISSING, the 3 packet files matched.
    const jio = capture();
    expect(cmdTrust(["verify-seal", path.join(dir, SEAL_NAME), "--json"], jio)).to.equal(EXIT.FAIL);
    const jobj = JSON.parse(jio.out());
    expect(jobj.counts.missing).to.equal(3);
    expect(jobj.counts.matched).to.equal(3);
    expect(jobj.counts.changed).to.equal(0);
    expect(jobj.counts.unexpected).to.equal(0);
    expect(jobj.missing.map((m) => m.relPath).sort()).to.deep.equal(
      [path.basename(BANK), path.basename(BOOK), path.basename(RENT)].sort()
    );
  });

  it("`--seal` WITHOUT `--out` hard-errors (exit 2) with an actionable message; writes nothing", function () {
    const io = capture();
    const code = cmdTrust(["reconcile", BANK, BOOK, RENT, "--date", DATE, "--seal"], io);
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/--seal requires --out/);
  });

  it("the caller can name the seal path; default name is NOT used", function () {
    const dir = mkTmp();
    const named = path.join(dir, "my-custom-seal.json");
    const io = capture();
    const code = cmdTrust(
      ["reconcile", BANK, BOOK, RENT, "--date", DATE, "--out", dir, "--seal", named],
      io
    );
    expect(code).to.equal(EXIT.PASS);
    expect(fs.existsSync(named)).to.equal(true);
    expect(fs.existsSync(path.join(dir, SEAL_NAME))).to.equal(false);

    // It still verifies (files resolve relative to the seal's own directory).
    shipSourcesInto(dir);
    expect(cmdTrust(["verify-seal", named], capture())).to.equal(EXIT.PASS);
  });

  it("--json round-trips: reconcile result carries the seal path; verify-seal --json carries the verdict", function () {
    const dir = mkTmp();
    const io = capture();
    const code = cmdTrust(
      ["reconcile", BANK, BOOK, RENT, "--date", DATE, "--out", dir, "--seal", "--json"],
      io
    );
    expect(code).to.equal(EXIT.PASS);
    const obj = JSON.parse(io.out());
    expect(obj.sealWritten).to.equal(path.join(dir, SEAL_NAME));

    shipSourcesInto(dir);
    const vio = capture();
    const vcode = cmdTrust(
      ["verify-seal", path.join(dir, SEAL_NAME), "--json"],
      vio
    );
    expect(vcode).to.equal(EXIT.PASS);
    const vobj = JSON.parse(vio.out());
    expect(vobj.verdict).to.equal("ACCEPTED");
    expect(vobj.accepted).to.equal(true);
    expect(vobj.verdictSealed.pass).to.equal(true);
    expect(vobj.caveat).to.match(/TAMPER-EVIDENT/);
  });

  it("a malformed seal file hard-errors (exit 1) BEFORE reading any sealed file", function () {
    const dir = mkTmp();
    const bad = path.join(dir, "bad-seal.json");
    fs.writeFileSync(bad, "{ not valid json");
    const io = capture();
    expect(cmdTrust(["verify-seal", bad], io)).to.equal(EXIT.IO);
    expect(io.err()).to.match(/invalid seal file|not valid JSON/);

    // A missing seal file is also an IO hard-error (exit 1).
    const io2 = capture();
    expect(cmdTrust(["verify-seal", path.join(dir, "nope.json")], io2)).to.equal(EXIT.IO);
    expect(io2.err()).to.match(/cannot read seal file/);
  });

  it("--emit-close is sealed too, and that seal ACCEPTS", function () {
    const dir = mkTmp();
    const closePath = path.join(dir, "close.json");
    const io = capture();
    const code = cmdTrust(
      [
        "reconcile", BANK, BOOK, RENT,
        "--date", DATE, "--out", dir,
        "--emit-close", closePath, "--seal",
      ],
      io
    );
    expect(code).to.equal(EXIT.PASS);

    const seal = sealMod.readSeal(fs.readFileSync(path.join(dir, SEAL_NAME), "utf8"));
    // The emitted close is one of the sealed outputs.
    expect(seal.outputs.map((o) => o.relPath)).to.include("close.json");

    shipSourcesInto(dir);
    expect(cmdTrust(["verify-seal", path.join(dir, SEAL_NAME)], capture())).to.equal(
      EXIT.PASS
    );
  });

  it("unknown flags hard-error with usage on BOTH commands; verify-seal routes through dispatch", function () {
    const dir = mkTmp();
    // reconcile rejects an unknown flag.
    expect(
      cmdTrust(["reconcile", BANK, BOOK, RENT, "--out", dir, "--bogus"], capture())
    ).to.equal(EXIT.USAGE);

    // verify-seal rejects an unknown flag with usage (parser parity).
    expect(reconcileSeal(dir).code).to.equal(EXIT.PASS);
    const io = capture();
    expect(
      cmdTrust(["verify-seal", path.join(dir, SEAL_NAME), "--bogus"], io)
    ).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/unknown option/);

    // --inputs without a value is a usage error (parser parity with --dir).
    const io3 = capture();
    expect(cmdTrust(["verify-seal", path.join(dir, SEAL_NAME), "--inputs"], io3)).to.equal(
      EXIT.USAGE
    );
    expect(io3.err()).to.match(/--inputs requires a value/);

    // An unknown trust subcommand names verify-seal in the expected set.
    const io2 = capture();
    expect(cmdTrust(["frobnicate"], io2)).to.equal(EXIT.USAGE);
    expect(io2.err()).to.match(/verify-seal/);
  });

  it("verify-seal requires a <sealfile> (usage error)", function () {
    const io = capture();
    expect(cmdTrust(["verify-seal"], io)).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/requires a <sealfile>/);
  });

  it("NO --seal => behaviour is exactly today's: packet written, NO seal file", function () {
    const dir = mkTmp();
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, out: dir },
      io
    );
    expect(res.code).to.equal(EXIT.PASS);
    expect(res.sealWritten == null).to.equal(true);
    // No seal landed; only the three packet files.
    expect(fs.readdirSync(dir).sort()).to.deep.equal([
      `reconciliation-${DATE}-balances.csv`,
      `reconciliation-${DATE}-exceptions.csv`,
      `reconciliation-${DATE}.html`,
    ]);
  });
});
