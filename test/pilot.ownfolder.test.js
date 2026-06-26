"use strict";

// ---------------------------------------------------------------------------
// T-34.1 — the pilot kit's EVIDENCE vertical run against a PARTNER-SUPPLIED folder.
//
// What these prove (the "does it work on MY files?" de-risk of P-8 step 4):
//   * `--evidence-dir <path>` / `PILOT_EVIDENCE_DIR=<path>` makes the evidence vertical seal the
//     partner's OWN folder instead of pilot/sample-evidence/, and the run is still an all-PASS verdict
//     (license-gated --sign refused without a license / allowed with one; independent verify-vh ACCEPTS
//     the untampered packet exit 0; TAMPER mutates the WORKSPACE COPY and verify-vh REJECTS exit 3).
//   * The partner's ORIGINAL files are READ-ONLY: their bytes AND mtimes are unchanged after a run — the
//     kit copies the folder and operates only on the copy (it never writes/renames/deletes an original).
//   * A missing / empty / unreadable folder HARD-ERRORS before any sealing (a clean usage exit), never a
//     misleading PASS.
//   * The unset/default run is unchanged (the canned sample, all prior assertions still hold).
//
// Fully OFFLINE / no-key / no-network: every filesystem effect is isolated to throwaway temp dirs.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const RUN_JS = path.join(REPO, "pilot", "run-pilot.js");
const pilot = require("../pilot/run-pilot");

describe("pilot/run-pilot.js T-34.1: evidence vertical on a PARTNER-SUPPLIED folder", function () {
  this.timeout(60000);

  let tmpDirs;
  let cwdBefore;
  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing the kit did leaked into the working tree.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-ownfolder-test-"));
    tmpDirs.push(d);
    return d;
  }

  // Build a realistic partner folder (a couple top-level files + a nested file, so we exercise the
  // recursive copy + the relPath the tamper localizes to). Returns the folder path.
  function makePartnerFolder() {
    const root = mkTmp();
    const folder = path.join(root, "partner-evidence");
    fs.mkdirSync(path.join(folder, "sub"), { recursive: true });
    fs.writeFileSync(path.join(folder, "audit.csv"), "id,amount\n1,100\n2,200\n");
    fs.writeFileSync(path.join(folder, "policy.md"), "# Policy\n\nour control narrative\n");
    fs.writeFileSync(path.join(folder, "sub", "nested.json"), '{"k":"v"}\n');
    return folder;
  }

  // Build a LARGE partner folder with MORE than the free SAMPLE_LIMIT (25) files. A real evidence/audit
  // folder routinely has dozens of files; sealing >25 requires the `evidence_unlimited` entitlement, so
  // this is the regression that proves the ephemeral pilot license grants it (else: a FALSE VERDICT: FAIL).
  function makeLargePartnerFolder(n) {
    const root = mkTmp();
    const folder = path.join(root, "partner-evidence-large");
    fs.mkdirSync(folder, { recursive: true });
    for (let i = 0; i < n; i++) {
      // Zero-pad so the FIRST-by-sorted-relPath tamper target is deterministic (evidence-000.csv).
      const name = `evidence-${String(i).padStart(3, "0")}.csv`;
      fs.writeFileSync(path.join(folder, name), `row,value\n${i},${i * 100}\n`);
    }
    return folder;
  }

  // Snapshot { relPath -> { hash, mtimeMs, size } } for every file under a folder (recursive). Used to
  // PROVE the partner's originals are byte- AND mtime-unchanged after a run.
  function snapshot(folder) {
    const crypto = require("crypto");
    const out = {};
    (function walk(dir, rel) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(abs, r);
        else if (e.isFile()) {
          const st = fs.statSync(abs);
          const buf = fs.readFileSync(abs);
          out[r] = {
            hash: crypto.createHash("sha256").update(buf).digest("hex"),
            mtimeMs: st.mtimeMs,
            size: st.size,
          };
        }
      }
    })(folder, "");
    return out;
  }

  it("parseArgs accepts --evidence-dir <path> and --evidence-dir=<path>, rejects a missing value", function () {
    expect(pilot.parseArgs(["--evidence-dir", "/a/b"]).evidenceDir).to.equal("/a/b");
    expect(pilot.parseArgs(["--evidence-dir=/c/d"]).evidenceDir).to.equal("/c/d");
    expect(pilot.parseArgs([]).evidenceDir).to.equal(undefined);
    expect(() => pilot.parseArgs(["--evidence-dir"])).to.throw(/requires a <path>/);
    expect(() => pilot.parseArgs(["--evidence-dir", "--other"])).to.throw(/requires a <path>/);
  });

  it("resolveEvidenceSource defaults to the canned sample, honors the flag, and validates partner input", function () {
    // Unset -> the committed sample, marked NOT a partner folder.
    const def = pilot.resolveEvidenceSource({});
    expect(def.source).to.equal(pilot.SAMPLE_EVIDENCE);
    expect(def.isPartner).to.equal(false);

    // A real folder -> resolved (absolute) + marked partner.
    const folder = makePartnerFolder();
    const r = pilot.resolveEvidenceSource({ evidenceDir: folder });
    expect(r.source).to.equal(path.resolve(folder));
    expect(r.isPartner).to.equal(true);

    // Missing / empty / not-a-dir all HARD-ERROR (a tagged user error) BEFORE any sealing.
    expect(() => pilot.resolveEvidenceSource({ evidenceDir: path.join(folder, "does-not-exist") }))
      .to.throw(/not found/);
    const empty = path.join(mkTmp(), "empty");
    fs.mkdirSync(empty);
    expect(() => pilot.resolveEvidenceSource({ evidenceDir: empty })).to.throw(/empty/);
    const aFile = path.join(folder, "audit.csv");
    expect(() => pilot.resolveEvidenceSource({ evidenceDir: aFile })).to.throw(/not a directory/);
  });

  it("runPilot(--evidence-dir) drives the FULL journey on the partner's folder to an all-PASS verdict", async function () {
    const folder = makePartnerFolder();
    const ws = mkTmp();
    const result = await pilot.runPilot(ws, { evidenceDir: folder });
    expect(result.ok).to.equal(true);
    expect(result.verdict).to.equal("PASS");

    // The packet was produced from the partner's data (a real signed evidence-seal container).
    const packet = JSON.parse(
      fs.readFileSync(path.join(ws, "evidence-packet.vhevidence.json"), "utf8")
    );
    expect(packet.kind).to.equal("vh.evidence-seal-signed");
    expect(packet.signature).to.have.property("signer");
  });

  it("a partner folder with MORE THAN 25 files (>SAMPLE_LIMIT) still drives an all-PASS verdict", async function () {
    // REGRESSION: sealing >25 files needs the `evidence_unlimited` entitlement. STEP 1 must mint the
    // ephemeral license with BOTH grants (signed + unlimited); otherwise the valid-license STEP 3 seal is
    // REJECTED for being over the free sample size and the kit prints a FALSE VERDICT: FAIL on a realistic
    // (dozens-of-files) partner folder — the exact partner this task targets. 30 > 25.
    const folder = makeLargePartnerFolder(30);
    const before = snapshot(folder);
    expect(Object.keys(before).length).to.be.greaterThan(25);

    const ws = mkTmp();
    const result = await pilot.runPilot(ws, { evidenceDir: folder });
    expect(result.ok, "30-file partner folder must reach an all-PASS verdict").to.equal(true);

    // A real signed packet was produced from the large folder…
    const packet = JSON.parse(
      fs.readFileSync(path.join(ws, "evidence-packet.vhevidence.json"), "utf8")
    );
    expect(packet.kind).to.equal("vh.evidence-seal-signed");

    // …and the partner's originals are still byte-identical (the copy-then-operate invariant holds at scale).
    const after = snapshot(folder);
    expect(Object.keys(after).sort()).to.deep.equal(Object.keys(before).sort());
    for (const r of Object.keys(before)) expect(after[r].hash, `${r}`).to.equal(before[r].hash);
  });

  it("the real script on a >25-file partner folder exits 0 with an all-PASS verdict (no false FAIL)", function () {
    const folder = makeLargePartnerFolder(30);
    const ws = mkTmp();
    const env = Object.assign({}, process.env, { PILOT_OUT: ws, VH_RPC_URL: "", VH_TSA_URL: "" });
    // execFileSync THROWS on a non-zero exit; a thrown error here is itself the regression (false FAIL = rc 1).
    const stdout = execFileSync("node", [RUN_JS, "--evidence-dir", folder], {
      cwd: REPO,
      env,
      encoding: "utf8",
    });
    expect(stdout).to.match(/VERDICT: PASS — (\d+)\/\1 checks passed/);
    expect(stdout).to.not.match(/\[FAIL\]/);
    expect(stdout).to.include("[PASS] valid-license `--sign` SUCCEEDS and writes a signed packet");
    // Tamper localizes to the first sorted file of the large folder.
    expect(stdout).to.match(/localizes the tamper to EXACTLY the changed file \(evidence-000\.csv\)/);
  });

  it("PILOT_EVIDENCE_DIR env is the SAME knob as --evidence-dir", async function () {
    const folder = makePartnerFolder();
    const ws = mkTmp();
    const PREV = process.env.PILOT_EVIDENCE_DIR;
    process.env.PILOT_EVIDENCE_DIR = folder;
    try {
      // opts has no evidenceDir -> the env supplies it.
      const r = pilot.resolveEvidenceSource({});
      expect(r.isPartner).to.equal(true);
      expect(r.source).to.equal(path.resolve(folder));
      const result = await pilot.runPilot(ws, {});
      expect(result.ok).to.equal(true);
    } finally {
      if (PREV === undefined) delete process.env.PILOT_EVIDENCE_DIR;
      else process.env.PILOT_EVIDENCE_DIR = PREV;
    }
  });

  it("the partner's ORIGINAL files are READ-ONLY: bytes AND mtimes unchanged after a run", async function () {
    const folder = makePartnerFolder();
    // Backdate the mtimes so a stray write/rename would visibly move them forward.
    const old = new Date("2020-01-01T00:00:00Z");
    for (const r of Object.keys(snapshot(folder))) {
      fs.utimesSync(path.join(folder, r), old, old);
    }
    const before = snapshot(folder);

    const ws = mkTmp();
    const result = await pilot.runPilot(ws, { evidenceDir: folder });
    expect(result.ok).to.equal(true);

    const after = snapshot(folder);
    // Same file SET (nothing added/renamed/deleted), and every file's bytes + mtime are identical.
    expect(Object.keys(after).sort()).to.deep.equal(Object.keys(before).sort());
    for (const r of Object.keys(before)) {
      expect(after[r].hash, `${r} bytes`).to.equal(before[r].hash);
      expect(after[r].size, `${r} size`).to.equal(before[r].size);
      expect(after[r].mtimeMs, `${r} mtime`).to.equal(before[r].mtimeMs);
    }
  });

  it("the TAMPER hits the WORKSPACE COPY (kept dir shows the mutated copy; original untouched)", async function () {
    const folder = makePartnerFolder();
    const before = snapshot(folder);

    const ws = mkTmp();
    const result = await pilot.runPilot(ws, { evidenceDir: folder });
    expect(result.ok).to.equal(true);

    // The working copy lives under <workspace>/evidence; exactly one of its files was tampered (so it
    // differs from the original), proving the mutation landed on the COPY, not the source.
    const copyDir = path.join(ws, "evidence");
    const copy = snapshot(copyDir);
    const changed = Object.keys(copy).filter((r) => !before[r] || copy[r].hash !== before[r].hash);
    expect(changed.length, "exactly one copied file was tampered").to.equal(1);
    // …and the original of that same file is byte-identical to before (untouched).
    const after = snapshot(folder);
    expect(after[changed[0]].hash).to.equal(before[changed[0]].hash);
  });

  it("the real script on a partner folder exits 0 OFFLINE with an all-PASS verdict, localized to a partner file", function () {
    const folder = makePartnerFolder();
    const ws = mkTmp();
    const env = Object.assign({}, process.env, { PILOT_OUT: ws, VH_RPC_URL: "", VH_TSA_URL: "" });
    const stdout = execFileSync("node", [RUN_JS, "--evidence-dir", folder], {
      cwd: REPO,
      env,
      encoding: "utf8",
    });
    expect(stdout).to.match(/VERDICT: PASS — (\d+)\/\1 checks passed/);
    expect(stdout).to.not.match(/\[FAIL\]/);
    expect(stdout).to.include("[PASS] independent verify-vh ACCEPTS the untampered packet (exit 0)");
    expect(stdout).to.include("[PASS] independent verify-vh REJECTS the tampered packet (exit 3)");
    // It localizes to a file that actually came from the PARTNER folder (audit.csv sorts first).
    expect(stdout).to.match(/localizes the tamper to EXACTLY the changed file \(audit\.csv\)/);
    // It announces it is running the partner's folder and copies it (the no-mutation promise, on screen).
    expect(stdout).to.include(folder);
    expect(stdout).to.match(/COPIES it into a throwaway workspace/);
    // Never echoes a private key.
    expect(stdout).to.not.match(/0x[0-9a-fA-F]{64}/);
  });

  it("a MISSING partner folder HARD-ERRORS before sealing (usage exit, clear message, never PASS)", function () {
    const ws = mkTmp();
    const missing = path.join(mkTmp(), "nope");
    const env = Object.assign({}, process.env, { PILOT_OUT: ws });
    let threw = false;
    try {
      execFileSync("node", [RUN_JS, "--evidence-dir", missing], { cwd: REPO, env, encoding: "utf8" });
    } catch (e) {
      threw = true;
      expect(e.status, "usage exit").to.equal(2);
      const msg = `${e.stdout || ""}${e.stderr || ""}`;
      expect(msg).to.match(/not found/);
      expect(msg).to.not.match(/VERDICT: PASS/); // never a misleading pass
    }
    expect(threw, "missing folder must hard-error").to.equal(true);
  });

  it("an EMPTY partner folder HARD-ERRORS before sealing (no false PASS over zero files)", function () {
    const ws = mkTmp();
    const empty = path.join(mkTmp(), "empty");
    fs.mkdirSync(empty);
    const env = Object.assign({}, process.env, { PILOT_OUT: ws });
    let threw = false;
    try {
      execFileSync("node", [RUN_JS, "--evidence-dir", empty], { cwd: REPO, env, encoding: "utf8" });
    } catch (e) {
      threw = true;
      expect(e.status).to.equal(2);
      const msg = `${e.stdout || ""}${e.stderr || ""}`;
      expect(msg).to.match(/empty/);
      expect(msg).to.not.match(/VERDICT: PASS/);
    }
    expect(threw, "empty folder must hard-error").to.equal(true);
    // And it sealed nothing into the workspace (no packet was emitted before the error).
    expect(fs.existsSync(path.join(ws, "evidence-packet.vhevidence.json"))).to.equal(false);
  });

  it("the UNSET default run is unchanged: the canned sample still drives an all-PASS verdict", async function () {
    // Belt-and-suspenders that the new knob didn't regress the default journey.
    const sampleBytes = fs
      .readdirSync(pilot.SAMPLE_EVIDENCE)
      .sort()
      .map((n) => fs.readFileSync(path.join(pilot.SAMPLE_EVIDENCE, n)).toString("hex"));
    const ws = mkTmp();
    const result = await pilot.runPilot(ws, {}); // unset -> canned sample
    expect(result.ok).to.equal(true);
    expect(result.evidenceSource).to.equal("canned");
    // The default run localizes to the historical canned file (access-log.csv) — byte-for-byte journey.
    // (We re-run via the script to assert the printed label is the historical one.)
    const env = Object.assign({}, process.env, { PILOT_OUT: mkTmp() });
    const stdout = execFileSync("node", [RUN_JS], { cwd: REPO, env, encoding: "utf8" });
    expect(stdout).to.match(/localizes the tamper to EXACTLY the changed file \(access-log\.csv\)/);
    // The committed sample is still byte-identical (the default path never mutates the fixture).
    const after = fs
      .readdirSync(pilot.SAMPLE_EVIDENCE)
      .sort()
      .map((n) => fs.readFileSync(path.join(pilot.SAMPLE_EVIDENCE, n)).toString("hex"));
    expect(after).to.deep.equal(sampleBytes);
  });
});
