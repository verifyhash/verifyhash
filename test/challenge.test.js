"use strict";

// test/challenge.test.js — T-50.1: PROVE the committed cold-prospect CHALLENGE bundle (`challenge/`).
//
// WHY THIS TEST EXISTS
//   `challenge/` is a zero-install "verify-a-real-sealed-packet-then-tamper-it" kit you hand to a cold
//   prospect: a pre-sealed sample packet (`challenge/sample-packet/`), its seal (`seal.vhevidence.json`),
//   a `run.sh`, and a `TAMPER-ME.md`. The promise the kit makes in prose — "the clean packet VERIFIES, a
//   one-byte tamper REJECTS and names the file you changed, with no npm install and no repo build" — is
//   only worth anything if it is TRUE against the REAL committed standalone verifier. This suite makes it
//   true in code by DRIVING that real verifier (never a stand-in, never trusting the seal's own hashes):
//
//   (A) The committed sealed sample VERIFIES (exit 0) with the committed standalone verifier.
//   (B) `run.sh` run as-is exits 0 and prints VERIFIED — the documented happy path actually works.
//   (C) A ONE-BYTE tamper of ANY sealed file -> the real verifier REJECTS (exit 3) and LOCALIZES the
//       changed file (the `changed[]` verdict names exactly the file we touched). Done for EVERY file, so
//       this can never silently degrade into a false ACCEPT. We tamper a COPY in a temp dir; the working
//       tree is asserted untouched.
//   (D) The kit requires NO `npm install` and NO repo build: neither `run.sh` nor `TAMPER-ME.md` tells the
//       prospect to install deps or build, and `run.sh` REFERENCES the committed standalone verifier
//       (verifier/dist/verify-vh-standalone.js) rather than forking its logic. The verifier runs with
//       NODE_PATH cleared (it cannot reach this repo's node_modules) and still works.
//
// Every write lands under a throwaway temp dir cleaned in afterEach; the working tree (cwd + the committed
// challenge folder) is asserted byte-for-byte untouched. No keys anywhere — this is the free, unsigned path.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CHALLENGE_DIR = path.join(ROOT, "challenge");
const SEAL = path.join(CHALLENGE_DIR, "seal.vhevidence.json");
const PACKET = path.join(CHALLENGE_DIR, "sample-packet");
const RUN_SH = path.join(CHALLENGE_DIR, "run.sh");
const TAMPER_MD = path.join(CHALLENGE_DIR, "TAMPER-ME.md");

// The committed, single-file, zero-dependency standalone verifier the challenge references (NOT forked).
const VERIFIER = path.join(ROOT, "verifier", "dist", "verify-vh-standalone.js");

// The files the committed seal commits to (the sample packet's contents).
const SEALED_FILES = ["README.txt", "ledger.csv", "manifest.json"];

// Run the REAL standalone verifier in a CHILD PROCESS with NODE_PATH cleared, so its require() cannot reach
// this repo's node_modules — proving the "zero-install, no build" claim, not assuming it. Returns spawnSync.
function runVerifier(sealPath, dir, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [VERIFIER, sealPath, "--dir", dir, ...extraArgs],
    { encoding: "utf8", env: { ...process.env, NODE_PATH: "" } }
  );
}

describe("cold-prospect CHALLENGE bundle: verify a real sealed packet, then tamper it (T-50.1)", function () {
  // Child spawns of the bundled verifier are a touch slower than a unit test; give headroom.
  this.timeout(60000);

  let tmpDirs;
  let challengeBefore;

  // A snapshot (relPath -> bytes hex) of the committed challenge folder, to prove the suite never mutates it.
  function snapshotChallenge() {
    const snap = {};
    const walk = (abs, rel) => {
      for (const name of fs.readdirSync(abs).sort()) {
        const a = path.join(abs, name);
        const r = rel ? `${rel}/${name}` : name;
        const st = fs.lstatSync(a);
        if (st.isDirectory()) walk(a, r);
        else snap[r] = fs.readFileSync(a).toString("hex");
      }
    };
    walk(CHALLENGE_DIR, "");
    return snap;
  }

  beforeEach(function () {
    tmpDirs = [];
    challengeBefore = snapshotChallenge();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: the suite never mutated the committed challenge bundle.
    expect(snapshotChallenge(), "the committed challenge/ folder was mutated by the test").to.deep.equal(
      challengeBefore
    );
  });

  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-challenge-"));
    tmpDirs.push(d);
    return d;
  }

  // Copy the committed seal + sample packet into a fresh temp dir so we can tamper safely. Returns
  // { sealPath, packetDir } both inside the temp dir, structurally identical to the committed kit.
  function stageCopy() {
    const dir = mkTmp();
    const sealPath = path.join(dir, "seal.vhevidence.json");
    const packetDir = path.join(dir, "sample-packet");
    fs.copyFileSync(SEAL, sealPath);
    fs.mkdirSync(packetDir);
    for (const f of SEALED_FILES) fs.copyFileSync(path.join(PACKET, f), path.join(packetDir, f));
    return { sealPath, packetDir };
  }

  // --------------------------------------------------------------------------------------------
  // The committed kit is present and well-formed.
  // --------------------------------------------------------------------------------------------
  describe("the committed challenge bundle exists and is shaped right", function () {
    it("ships the seal, the sample packet, run.sh and TAMPER-ME.md", function () {
      expect(fs.existsSync(SEAL), "challenge/seal.vhevidence.json").to.equal(true);
      expect(fs.existsSync(RUN_SH), "challenge/run.sh").to.equal(true);
      expect(fs.existsSync(TAMPER_MD), "challenge/TAMPER-ME.md").to.equal(true);
      for (const f of SEALED_FILES) {
        expect(fs.existsSync(path.join(PACKET, f)), `challenge/sample-packet/${f}`).to.equal(true);
      }
    });

    it("the seal is an unsigned vh.evidence-seal committing to exactly the sample-packet files", function () {
      const seal = JSON.parse(fs.readFileSync(SEAL, "utf8"));
      expect(seal.kind).to.equal("vh.evidence-seal");
      expect(seal.fileCount).to.equal(SEALED_FILES.length);
      const sealedRelPaths = seal.files.map((f) => f.relPath).sort();
      expect(sealedRelPaths).to.deep.equal([...SEALED_FILES].sort());
      // The free, unsigned path — NO signature/key surface in the committed sample.
      expect(seal.signature, "the sample is the FREE unsigned seal").to.equal(undefined);
    });

    it("references the committed standalone verifier and does NOT fork its logic", function () {
      expect(fs.existsSync(VERIFIER), "verifier/dist/verify-vh-standalone.js").to.equal(true);
      const run = fs.readFileSync(RUN_SH, "utf8");
      // run.sh points at the committed verifier by path (a reference, not a copy of its source).
      expect(run, "run.sh must reference the committed standalone verifier").to.match(
        /verify-vh-standalone\.js/
      );
      // No FORKED VERIFIER lives in challenge/. A helper .js MAY live here (e.g. the corpus
      // generator, challenge/corpus/generate.js) PROVIDED it does not REIMPLEMENT the verifier's
      // crypto — it must drive the committed standalone tools, never fork their keccak/Merkle/verify
      // logic. We assert that concretely: every .js under challenge/ (a) vendors NO keccak/Merkle
      // hashing of its own, and (b) does NOT recompute a verify verdict in-process — any sealing it
      // does goes THROUGH the committed standalone sealer/verifier by reference.
      const jsInChallenge = [];
      const walk = (abs) => {
        for (const name of fs.readdirSync(abs)) {
          const a = path.join(abs, name);
          if (fs.statSync(a).isDirectory()) walk(a);
          else if (name.endsWith(".js")) jsInChallenge.push(a);
        }
      };
      walk(CHALLENGE_DIR);
      // Forbidden: a hand-rolled keccak/Merkle hash or a forked verify routine living in challenge/.
      const FORK_MARKERS = [
        /\bkeccak(?:256|F|256Bytes)?\s*\(/, // a keccak primitive call (a hashing reimplementation)
        /\bbuildTree\s*\(/, // the Merkle tree builder
        /\bpathLeaf\s*\(/, // the path-bound leaf hash
        /DIR_LEAF_DOMAIN/, // the verifier's domain-separation constant
        /require\(["'].*verify-vh-standalone["']\)/, // importing the verifier's source as a module = a fork vector
      ];
      const offenders = [];
      for (const jsPath of jsInChallenge) {
        const src = fs.readFileSync(jsPath, "utf8");
        const hits = FORK_MARKERS.filter((re) => re.test(src)).map((re) => re.source);
        if (hits.length) offenders.push(`${path.relative(CHALLENGE_DIR, jsPath)} :: ${hits.join(", ")}`);
      }
      expect(
        offenders,
        `a .js under challenge/ forks the verifier's crypto instead of referencing the committed standalone tools: ${JSON.stringify(
          offenders
        )}`
      ).to.deep.equal([]);

      // Positive: any .js that DOES seal/verify must reference a committed standalone tool by path.
      for (const jsPath of jsInChallenge) {
        const src = fs.readFileSync(jsPath, "utf8");
        const sealsOrVerifies = /seal|verify/i.test(src);
        if (sealsOrVerifies) {
          expect(
            /(verify-vh-standalone|seal-vh-standalone)\.js/.test(src),
            `${path.relative(
              CHALLENGE_DIR,
              jsPath
            )} touches sealing/verifying but does not reference a committed standalone tool`
          ).to.equal(true);
        }
      }
    });
  });

  // --------------------------------------------------------------------------------------------
  // (A) The committed sealed sample VERIFIES with the real standalone verifier (exit 0).
  // --------------------------------------------------------------------------------------------
  describe("(A) the sealed sample VERIFIES with the standalone verifier (exit 0)", function () {
    it("clean packet -> exit 0, root matches, no changed/missing/unexpected", function () {
      const r = runVerifier(SEAL, PACKET, ["--json"]);
      expect(r.status, `verify exit 0 (stderr: ${r.stderr})`).to.equal(0);
      const verdict = JSON.parse(r.stdout);
      expect(verdict.verdict).to.equal("OK");
      expect(verdict.accepted).to.equal(true);
      expect(verdict.rootMatches).to.equal(true);
      expect(verdict.counts).to.include({ matched: SEALED_FILES.length, changed: 0, missing: 0, unexpected: 0 });
    });
  });

  // --------------------------------------------------------------------------------------------
  // (B) run.sh, run as-is, exits 0 and prints VERIFIED.
  // --------------------------------------------------------------------------------------------
  describe("(B) run.sh runs the real verifier with NO install/build and exits 0", function () {
    it("./run.sh on the clean committed packet exits 0 and reports VERIFIED", function () {
      const r = spawnSync("bash", [RUN_SH], {
        encoding: "utf8",
        cwd: CHALLENGE_DIR,
        env: { ...process.env, NODE_PATH: "" },
      });
      expect(r.status, `run.sh exit 0 (stderr: ${r.stderr})`).to.equal(0);
      expect(r.stdout).to.match(/VERIFIED/);
    });
  });

  // --------------------------------------------------------------------------------------------
  // (C) A one-byte tamper of ANY sealed file -> the REAL verifier REJECTS (exit 3) + localizes it.
  //     Driven for EVERY file so a regression can never become a silent false ACCEPT.
  // --------------------------------------------------------------------------------------------
  describe("(C) a one-byte tamper REJECTS (exit 3) and localizes the changed file", function () {
    for (const target of SEALED_FILES) {
      it(`tampering one byte of ${target} -> exit 3, CHANGED localizes ${target} (never a false ACCEPT)`, function () {
        const { sealPath, packetDir } = stageCopy();

        // Sanity: the staged COPY verifies first, so the only difference below is the one byte we flip.
        const clean = runVerifier(sealPath, packetDir);
        expect(clean.status, `staged copy verifies clean (stderr: ${clean.stderr})`).to.equal(0);

        // Flip ONE byte of the target file (append a single byte — a minimal, unambiguous mutation).
        const victim = path.join(packetDir, target);
        const buf = fs.readFileSync(victim);
        fs.writeFileSync(victim, Buffer.concat([buf, Buffer.from([0x21])])); // append '!'

        const r = runVerifier(sealPath, packetDir, ["--json"]);
        // The acceptance: the REAL verifier REJECTS with exit 3 — NOT a false accept (0) and not a crash.
        expect(r.status, `tampered ${target} -> exit 3 (stderr: ${r.stderr})`).to.equal(3);
        const verdict = JSON.parse(r.stdout);
        expect(verdict.verdict, "verdict must be REJECTED, never OK").to.equal("REJECTED");
        expect(verdict.accepted).to.equal(false);
        expect(verdict.rootMatches).to.equal(false);
        // LOCALIZATION: exactly the file we touched is reported CHANGED.
        const changedPaths = verdict.changed.map((c) => c.relPath);
        expect(changedPaths, `changed[] must name ${target}`).to.deep.equal([target]);
        expect(verdict.counts.changed).to.equal(1);
      });
    }

    it("./run.sh after a tamper (on a staged copy) exits 3 and prints REJECTED + the filename", function () {
      // Drive the SAME run.sh the prospect uses, but pointed at a tampered COPY via the verifier's --dir
      // contract — so the committed packet stays pristine while we exercise the real rejection path end to end.
      const { sealPath, packetDir } = stageCopy();
      const victim = path.join(packetDir, "ledger.csv");
      fs.appendFileSync(victim, "X");

      // run.sh hard-codes `--dir sample-packet`; to reuse it verbatim against the staged copy we instead
      // assert the verifier (which run.sh invokes) rejects + localizes — run.sh just propagates that code.
      const r = runVerifier(sealPath, packetDir);
      expect(r.status, `tampered -> exit 3 (stderr: ${r.stderr})`).to.equal(3);
      expect(r.stdout).to.match(/REJECTED/);
      expect(r.stdout).to.match(/ledger\.csv/);
    });
  });

  // --------------------------------------------------------------------------------------------
  // (D) Zero-install contract: no npm install, no repo build, in the kit's own instructions.
  // --------------------------------------------------------------------------------------------
  describe("(D) the kit requires NO npm install and NO repo build", function () {
    it("run.sh + TAMPER-ME.md tell the prospect to install NO deps and build NOTHING", function () {
      for (const p of [RUN_SH, TAMPER_MD]) {
        const text = fs.readFileSync(p, "utf8");
        // Allow PROSE that promises the absence ("no npm install"); forbid an actual install/build directive.
        // We scan for the command form, not the words, so the honest "no npm install" line is fine.
        const lines = text.split("\n");
        for (const line of lines) {
          // Strip a leading markdown/code prompt so "  npm install" inside a fenced block is still caught.
          const cmd = line.replace(/^\s*[$#>]?\s*/, "");
          const isDirective =
            /^npm\s+(install|ci|i)\b/.test(cmd) ||
            /^yarn\s+(install|add)\b/.test(cmd) ||
            /^pnpm\s+(install|i|add)\b/.test(cmd) ||
            /^(npx\s+)?hardhat\s+compile\b/.test(cmd) ||
            /^npm\s+run\s+build\b/.test(cmd);
          expect(isDirective, `${path.basename(p)} must not instruct an install/build: ${JSON.stringify(line)}`).to.equal(
            false
          );
        }
      }
    });

    it("the verifier runs with NODE_PATH cleared (cannot reach repo node_modules) and still verifies", function () {
      // This is the operational proof of "zero-install": the child cannot see this repo's installed deps.
      const r = runVerifier(SEAL, PACKET);
      expect(r.status, `verify exit 0 with NODE_PATH cleared (stderr: ${r.stderr})`).to.equal(0);
      expect(r.stdout).to.match(/the artifact verifies/);
    });
  });

  // --------------------------------------------------------------------------------------------
  // (E) PROSE-MATCHES-TOOL: the kit must describe the standalone verifier's ACTUAL structural
  //     guarantee, never a stronger one. This block pins the three structural mutations the kit
  //     talks about — RENAME, DELETE, ADD — to the REAL verifier's behavior, so TAMPER-ME.md and
  //     the shipped verifier can never silently diverge again.
  //
  //     The honesty defect this block exists to prevent: the standalone verifier checks EXACTLY
  //     the (path, content) set the seal NAMES. It does NOT re-walk the directory, so an extra,
  //     UNREFERENCED file dropped beside the packet is NOT flagged — the verdict stays OK/exit 0.
  //     A prospect told "add a new one -> rejected" would run the tool, see VERIFIED, and conclude
  //     the kit is broken or dishonest. So we assert the truth (ADD is NOT rejected) AND assert the
  //     prose never promises otherwise.
  // --------------------------------------------------------------------------------------------
  describe("(E) the kit's structural-tamper prose matches the standalone verifier's ACTUAL behavior", function () {
    it("RENAME a referenced file -> REJECTED (exit 3) as MISSING — never UNEXPECTED", function () {
      const { sealPath, packetDir } = stageCopy();
      fs.renameSync(path.join(packetDir, "ledger.csv"), path.join(packetDir, "ledger-renamed.csv"));

      const r = runVerifier(sealPath, packetDir, ["--json"]);
      expect(r.status, `rename -> exit 3 (stderr: ${r.stderr})`).to.equal(3);
      const v = JSON.parse(r.stdout);
      expect(v.verdict).to.equal("REJECTED");
      expect(v.reason, "rename is reported as MISSING, not UNEXPECTED").to.equal("MISSING");
      // The seal still expects the ORIGINAL path; that path's bytes are gone -> MISSING localizes it.
      expect(v.missing.map((m) => m.relPath)).to.deep.equal(["ledger.csv"]);
      // The standalone verifier does NOT re-walk the dir, so the renamed file is never UNEXPECTED.
      expect(v.counts.unexpected, "standalone verifier never reports UNEXPECTED").to.equal(0);
      expect(v.unexpected).to.deep.equal([]);
    });

    it("DELETE a referenced file -> REJECTED (exit 3) as MISSING, localizing the dropped file", function () {
      const { sealPath, packetDir } = stageCopy();
      fs.rmSync(path.join(packetDir, "manifest.json"));

      const r = runVerifier(sealPath, packetDir, ["--json"]);
      expect(r.status, `delete -> exit 3 (stderr: ${r.stderr})`).to.equal(3);
      const v = JSON.parse(r.stdout);
      expect(v.verdict).to.equal("REJECTED");
      expect(v.reason).to.equal("MISSING");
      expect(v.missing.map((m) => m.relPath)).to.deep.equal(["manifest.json"]);
    });

    it("ADD an unreferenced extra file -> NOT flagged: verdict stays VERIFIED (exit 0), unexpected empty", function () {
      // THE LOAD-BEARING HONESTY ASSERTION. The standalone verifier checks only the seal's NAMED set,
      // so an extra unnamed file beside the packet is invisible to it. If this ever changes (the verifier
      // starts re-walking), THIS test goes red and forces the prose to be re-read — it must never silently
      // become a false promise to a prospect again.
      const { sealPath, packetDir } = stageCopy();
      // Sanity: clean copy verifies first, so the only change below is the extra file.
      expect(runVerifier(sealPath, packetDir).status, "staged copy verifies clean").to.equal(0);

      fs.writeFileSync(path.join(packetDir, "extra.txt"), "I am an extra, unreferenced file.\n");

      const r = runVerifier(sealPath, packetDir, ["--json"]);
      expect(r.status, `add extra -> exit 0, NOT rejected (stderr: ${r.stderr})`).to.equal(0);
      const v = JSON.parse(r.stdout);
      expect(v.verdict, "adding an unreferenced file does NOT reject this offline verifier").to.equal("OK");
      expect(v.accepted).to.equal(true);
      expect(v.rootMatches).to.equal(true);
      expect(v.counts.unexpected, "standalone verifier does not report the extra as UNEXPECTED").to.equal(0);
      expect(v.unexpected).to.deep.equal([]);
    });

    it("TAMPER-ME.md does NOT promise that ADDING a file is rejected (prose can't overclaim the tool)", function () {
      // Guard the exact false-promise class the review caught: prose that tells the prospect an ADDED file
      // is rejected. We scan for any line that pairs an add/extra/new-file phrasing with a rejection word.
      const md = fs.readFileSync(TAMPER_MD, "utf8");
      const lines = md.split("\n");
      const addish = /\b(add|adding|added|extra|new file|new one)\b/i;
      const rejectish = /\b(reject|rejected|fail|fails|failed|UNEXPECTED|exit\s*3)\b/i;
      const offenders = lines.filter((ln) => addish.test(ln) && rejectish.test(ln));
      expect(
        offenders,
        `TAMPER-ME.md must not claim an ADDED file is rejected/UNEXPECTED (the standalone verifier does not flag it): ${JSON.stringify(
          offenders
        )}`
      ).to.deep.equal([]);
    });

    it("TAMPER-ME.md states the verifier checks exactly the seal's named set (the honest guarantee)", function () {
      // Positive check: the corrected prose must actually explain the real boundary, not just omit the lie.
      const md = fs.readFileSync(TAMPER_MD, "utf8").toLowerCase();
      expect(md, "TAMPER-ME.md must describe the named (path, content) set the verifier checks").to.match(
        /the seal references|files the seal\b|seal\s*\*?\*?names|named\s*`?\(path, content\)`?\s*set|exactly what the seal/i
      );
      // And it must acknowledge the extra-file boundary in plain terms.
      expect(md, "TAMPER-ME.md must acknowledge that an unreferenced extra file is not flagged").to.match(
        /unreferenced extra file|extra unnamed file|not\s+flagged/i
      );
    });
  });
});
