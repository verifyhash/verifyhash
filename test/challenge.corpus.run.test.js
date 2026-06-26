"use strict";

// test/challenge.corpus.run.test.js — T-52.2: PROVE the self-auditing CONFORMANCE RUNNER
// (challenge/corpus/run-corpus.js).
//
// WHY THIS TEST EXISTS
//   T-52.1 committed the AMMUNITION (one poisoned packet per tamper class) and proved each is honest.
//   THIS suite proves the GUN — the runner that drives EVERY shipped verifier (the producer's own
//   `vh evidence verify` AND the two INDEPENDENT offline verifiers) against EVERY poisoned artifact —
//   actually enforces the ONE load-bearing safety invariant the whole product rests on:
//
//        NO verifier EVER returns ACCEPT (exit 0) on a poisoned input.
//
//   It asserts, against the REAL committed runner driving the REAL committed verifiers:
//
//   (A) `node run-corpus.js` exits 0 with an aggregate PASS over the committed corpus, printing a
//       per-class ✓ for EVERY tamper class, and every poisoned artifact is REJECTED by EACH applicable
//       verifier (never exit 0).
//   (B) `--json` emits a stable, machine-readable result (two runs byte-identical), whose structured
//       fields agree with the human report (ok, no false accepts, a row per class x verifier).
//   (C) THE GATE HAS TEETH: forcing ONE verifier to (incorrectly) ACCEPT a poisoned input drives the
//       runner to exit 1, NAMING the offending class + verifier. A gate that cannot fail proves nothing.
//   (D) A verifier that rejects but with an OUT-OF-CONTRACT exit (a wrong failure mode, not a false
//       accept) is ALSO flagged — the runner checks HOW each verifier rejects, not just THAT it did.
//   (E) The programmatic API (runCorpus/runOne) is honest, and a missing/broken corpus is a FAIL
//       (a gate that cannot run must never look like a PASS).
//
// Synthetic verifiers are injected via the runner's VH_RUN_VERIFIERS hook (a CJS module exporting a
// verifier-descriptor array) — NEVER by editing a shipped verifier. Everything that writes lands under
// a throwaway temp dir cleaned in afterEach; the committed corpus tree is asserted byte-for-byte
// untouched. No keys anywhere — the free, unsigned path.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CORPUS_DIR = path.join(ROOT, "challenge", "corpus");
const RUNNER = path.join(CORPUS_DIR, "run-corpus.js");
const MANIFEST_PATH = path.join(CORPUS_DIR, "manifest.json");

// Run the REAL runner in a CHILD PROCESS with NODE_PATH cleared (mirroring the runner's own posture).
function runRunner(args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "", ...extraEnv },
  });
}

// Snapshot relPath -> bytes(hex) under a directory (deterministic, sorted), or {} if absent.
function snapshotDir(absDir, prefix) {
  const snap = {};
  const walk = (abs, rel) => {
    if (!fs.existsSync(abs)) return;
    for (const name of fs.readdirSync(abs).sort()) {
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(a);
      if (st.isDirectory()) walk(a, r);
      else snap[r] = fs.readFileSync(a).toString("hex");
    }
  };
  walk(absDir, prefix);
  return snap;
}

// A full snapshot of the committed corpus OUTPUTS (clean/, poisoned/, manifest.json). The runner and
// generator sources are excluded (producers, not outputs).
function snapshotCorpus(baseDir) {
  const snap = {
    ...snapshotDir(path.join(baseDir, "clean"), "clean"),
    ...snapshotDir(path.join(baseDir, "poisoned"), "poisoned"),
  };
  const m = path.join(baseDir, "manifest.json");
  if (fs.existsSync(m)) snap["manifest.json"] = fs.readFileSync(m).toString("hex");
  return snap;
}

describe("self-auditing CONFORMANCE runner: every verifier REJECTS every poisoned input (T-52.2)", function () {
  // Child spawns of three verifiers x 11 classes are slower than a unit test; give headroom.
  this.timeout(180000);

  let manifest;
  let committedBefore;
  let tmpDirs;

  before(function () {
    expect(fs.existsSync(RUNNER), "challenge/corpus/run-corpus.js must exist").to.equal(true);
    expect(fs.existsSync(MANIFEST_PATH), "challenge/corpus/manifest.json must exist").to.equal(true);
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  });

  beforeEach(function () {
    tmpDirs = [];
    committedBefore = snapshotCorpus(CORPUS_DIR);
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: the runner is READ-ONLY — the committed corpus outputs are untouched.
    expect(snapshotCorpus(CORPUS_DIR), "the committed challenge/corpus/ outputs were mutated").to.deep.equal(
      committedBefore
    );
  });

  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-run-corpus-"));
    tmpDirs.push(d);
    return d;
  }

  // Write a synthetic-verifier-set module + the synthetic verifier scripts it references into a temp
  // dir, and return the module path (for VH_RUN_VERIFIERS). `entries` describe the synthetic verifiers.
  function writeVerifierSet(entries) {
    const dir = mkTmp();
    const descriptors = entries.map((e, i) => {
      const scriptPath = path.join(dir, `verifier-${i}.js`);
      fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n${e.body}\n`);
      return { id: e.id, tier: e.tier || "independent", scriptPath, rejectExits: e.rejectExits };
    });
    const modPath = path.join(dir, "verifier-set.js");
    // The module re-derives the REAL standalone verifier from REPO_ROOT (so at least one honest
    // verifier participates) and appends the synthetic ones.
    const synthLiteral = JSON.stringify(descriptors);
    fs.writeFileSync(
      modPath,
      [
        'const path = require("path");',
        `const SYNTH = ${synthLiteral};`,
        "module.exports = function ({ REPO_ROOT }) {",
        "  const real = {",
        '    id: "independent-standalone", tier: "independent", label: "real standalone",',
        '    script: path.join(REPO_ROOT, "verifier", "dist", "verify-vh-standalone.js"),',
        '    argv(s, d) { return [this.script, s, "--dir", d]; },',
        '    rejectExits(op) { return op === "edit-seal-kind" ? [2] : [3]; },',
        "  };",
        "  const synth = SYNTH.map((e) => ({",
        "    id: e.id, tier: e.tier, label: e.id, script: e.scriptPath,",
        '    argv(s, d) { return [this.script, s, "--dir", d]; },',
        "    rejectExits() { return e.rejectExits; },",
        "  }));",
        "  return [real, ...synth];",
        "};",
      ].join("\n")
    );
    return modPath;
  }

  // ==========================================================================================
  // (A) The real runner: exit 0 PASS, per-class ✓ for every class, NO false accept.
  // ==========================================================================================
  describe("(A) the real runner passes over the committed corpus (no false accept)", function () {
    it("`node run-corpus.js` exits 0 with an aggregate PASS and a ✓ per tamper class", function () {
      const r = runRunner();
      expect(r.status, `runner exit 0 (stderr: ${r.stderr})`).to.equal(0);
      expect(r.stdout).to.match(/PASS — all \d+ checks REJECTED/);
      // A ✓ line for EVERY class id in the manifest (the per-class report the acceptance demands).
      for (const c of manifest.classes) {
        const re = new RegExp(`✓ ${c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        expect(r.stdout, `expected a ✓ for class ${c.id}`).to.match(re);
      }
      // It names BOTH tiers — producer AND independent are driven.
      expect(r.stdout).to.match(/\[producer\]/);
      expect(r.stdout).to.match(/\[independent\]/);
    });

    it("drives BOTH the producer and the independent verifiers (>= 2 tiers, >= 3 verifiers)", function () {
      const r = runRunner(["--json"]);
      expect(r.status, `--json exit 0 (stderr: ${r.stderr})`).to.equal(0);
      const out = JSON.parse(r.stdout);
      const tiers = new Set(out.verifiers.map((v) => v.tier));
      expect(tiers.has("producer"), "the producer's own verifier must be driven").to.equal(true);
      expect(tiers.has("independent"), "the independent verifier(s) must be driven").to.equal(true);
      expect(out.verifierCount, "at least the producer + 2 independent verifiers").to.be.at.least(3);
      expect(out.checkCount, "checkCount == classes x verifiers").to.equal(
        out.classCount * out.verifierCount
      );
    });

    it("EVERY poisoned input is REJECTED by EVERY applicable verifier — never exit 0 (no false accept)", function () {
      const r = runRunner(["--json"]);
      expect(r.status).to.equal(0);
      const out = JSON.parse(r.stdout);
      expect(out.ok, "aggregate ok").to.equal(true);
      expect(out.falseAcceptCount, "zero false accepts").to.equal(0);
      expect(out.failureCount, "zero failures").to.equal(0);
      // No single result is an exit 0, and every result is a pass.
      for (const res of out.results) {
        expect(res.exit, `${res.classId}/${res.verifier} must NOT be a false ACCEPT (exit 0)`).to.not.equal(0);
        expect(res.pass, `${res.classId}/${res.verifier} must REJECT within contract`).to.equal(true);
      }
      // Every class rolled up to pass.
      for (const c of out.classes) {
        expect(c.pass, `class ${c.classId} must pass on every verifier`).to.equal(true);
      }
    });

    it("the seal-internal classes reject with the verifier-specific failure mode (root/kind contract)", function () {
      // A focused spot-check that the runner respects EACH verifier's own contract, not a single
      // global exit: the independent verifiers re-derive (3) / flag unrecognized kind (2); the producer
      // structurally validates first and surfaces both as a validation error (1). All non-zero.
      const r = runRunner(["--json"]);
      const out = JSON.parse(r.stdout);
      const find = (cls, vid) => out.results.find((x) => x.classId === cls && x.verifier === vid);

      const rootStandalone = find("seal-root-forged", "independent-standalone");
      const rootProducer = find("seal-root-forged", "producer");
      expect(rootStandalone.exit, "standalone re-derives a forged root -> 3").to.equal(3);
      expect(rootProducer.exit, "producer validates a forged root structurally -> 1").to.equal(1);
      expect(rootStandalone.pass && rootProducer.pass).to.equal(true);

      const kindStandalone = find("seal-kind-corrupted", "independent-standalone");
      const kindProducer = find("seal-kind-corrupted", "producer");
      expect(kindStandalone.exit, "standalone: unrecognized kind -> 2 (usage)").to.equal(2);
      expect(kindProducer.exit, "producer: wrong kind -> 1 (validation)").to.equal(1);
      expect(kindStandalone.pass && kindProducer.pass).to.equal(true);
    });
  });

  // ==========================================================================================
  // (B) `--json` is stable and machine-readable.
  // ==========================================================================================
  describe("(B) `--json` emits a stable, machine-readable result", function () {
    it("is valid JSON with the documented top-level shape", function () {
      const r = runRunner(["--json"]);
      expect(r.status).to.equal(0);
      const out = JSON.parse(r.stdout);
      expect(out.kind).to.equal("vh.corpus-run-result");
      expect(out).to.have.all.keys(
        "kind",
        "corpusVersion",
        "ok",
        "classCount",
        "verifierCount",
        "checkCount",
        "falseAcceptCount",
        "failureCount",
        "verifiers",
        "classes",
        "failures",
        "results"
      );
      expect(out.classes).to.be.an("array").with.length(manifest.classes.length);
      expect(out.failures).to.deep.equal([]);
    });

    it("two runs are byte-identical (stable output, safe to diff in CI)", function () {
      const a = runRunner(["--json"]);
      const b = runRunner(["--json"]);
      expect(a.status).to.equal(0);
      expect(b.status).to.equal(0);
      expect(a.stdout, "the --json output must be deterministic").to.equal(b.stdout);
    });
  });

  // ==========================================================================================
  // (C) THE GATE HAS TEETH — a synthetic verifier that wrongly ACCEPTS drives exit 1, naming the
  //     offending class + verifier.
  // ==========================================================================================
  describe("(C) the gate has teeth: a forced false-ACCEPT fails the runner LOUD", function () {
    it("ONE synthetic verifier that accepts a poisoned input -> exit 1, naming the class + verifier", function () {
      // A synthetic verifier that exits 0 ONLY for the targeted class (otherwise rejects with 3), so the
      // failure is attributable to exactly one (class, verifier) — proving the runner pinpoints, not just
      // 'something failed'. The targeting keys off the seal path the runner passes as argv[2].
      const target = "finance-amount-edited";
      const modPath = writeVerifierSet([
        {
          id: "SYNTH-accepts-finance",
          tier: "independent",
          rejectExits: [3],
          body: [
            'const sealPath = process.argv[2] || "";',
            // Accept (exit 0) for the targeted poisoned class; reject (exit 3) for all others.
            `if (sealPath.includes(${JSON.stringify("/" + target + "/")})) process.exit(0);`,
            "process.exit(3);",
          ].join("\n"),
        },
      ]);

      const r = runRunner([], { VH_RUN_VERIFIERS: modPath });
      expect(r.status, "a false ACCEPT must drive the runner to exit 1").to.equal(1);
      expect(r.stdout, "FAIL banner").to.match(/FAIL —/);
      // It must NAME the offending class AND the offending verifier.
      const offending = new RegExp(
        `class=${target}\\b.*verifier=independent/SYNTH-accepts-finance`
      );
      expect(r.stdout, "must name the offending class + verifier").to.match(offending);
      expect(r.stdout, "must call it a FALSE-ACCEPT").to.match(/FALSE-ACCEPT/);

      // And ONLY that one check failed: the honest standalone still rejected every class, and the
      // synthetic verifier rejected the OTHER 10 classes — so exactly one false accept.
      const rj = runRunner(["--json"], { VH_RUN_VERIFIERS: modPath });
      expect(rj.status).to.equal(1);
      const out = JSON.parse(rj.stdout);
      expect(out.ok).to.equal(false);
      expect(out.falseAcceptCount, "exactly one false accept").to.equal(1);
      expect(out.failures, "exactly one failure, attributed precisely").to.deep.equal([
        {
          classId: target,
          verifier: "SYNTH-accepts-finance",
          tier: "independent",
          exit: 0,
          reason: "FALSE-ACCEPT (verifier returned exit 0 / VERIFIED on a poisoned input)",
        },
      ]);
    });

    it("a verifier that accepts ALL poisoned inputs fails every class (the broad teeth case)", function () {
      const modPath = writeVerifierSet([
        {
          id: "SYNTH-accepts-all",
          tier: "independent",
          rejectExits: [3],
          body: "process.exit(0); // wrongly VERIFIED on every input",
        },
      ]);
      const r = runRunner(["--json"], { VH_RUN_VERIFIERS: modPath });
      expect(r.status, "exit 1").to.equal(1);
      const out = JSON.parse(r.stdout);
      expect(out.ok).to.equal(false);
      // One false accept per class, all attributed to the synthetic verifier.
      expect(out.falseAcceptCount).to.equal(manifest.classes.length);
      for (const f of out.failures) {
        expect(f.verifier).to.equal("SYNTH-accepts-all");
        expect(f.exit).to.equal(0);
      }
    });
  });

  // ==========================================================================================
  // (D) Out-of-contract rejects are ALSO flagged (the runner checks HOW a verifier rejects).
  // ==========================================================================================
  describe("(D) a reject with the WRONG failure mode is flagged (not silently passed)", function () {
    it("a verifier that rejects with an out-of-contract exit -> exit 1, but NOT a false accept", function () {
      // Synthetic verifier rejects with exit 7 (non-zero, so not a false accept) — but 7 is outside its
      // declared contract {3}. The runner must FAIL it (contract drift) yet NOT count it as a false accept.
      const modPath = writeVerifierSet([
        {
          id: "SYNTH-wrong-exit",
          tier: "independent",
          rejectExits: [3],
          body: "process.exit(7); // rejects, but with an undocumented failure mode",
        },
      ]);
      const r = runRunner(["--json"], { VH_RUN_VERIFIERS: modPath });
      expect(r.status, "exit 1 — out-of-contract reject is still a FAIL").to.equal(1);
      const out = JSON.parse(r.stdout);
      expect(out.ok).to.equal(false);
      expect(out.falseAcceptCount, "exit 7 is NOT a false accept (it is non-zero)").to.equal(0);
      expect(out.failureCount, "every class fails contract for this verifier").to.equal(
        manifest.classes.length
      );
      for (const f of out.failures) {
        expect(f.verifier).to.equal("SYNTH-wrong-exit");
        expect(f.reason, "names it OUT-OF-CONTRACT").to.match(/OUT-OF-CONTRACT/);
        expect(f.exit).to.equal(7);
      }
    });
  });

  // ==========================================================================================
  // (E) The programmatic API + a broken corpus is a FAIL (a gate that cannot run is never a PASS).
  // ==========================================================================================
  describe("(E) the programmatic API is honest, and an unrunnable corpus FAILS", function () {
    it("runCorpus()/runOne() return the same verdicts the CLI prints", function () {
      // Require the runner as a module (it does NOT auto-run when required) and drive it in-process.
      delete require.cache[require.resolve(path.join(CORPUS_DIR, "run-corpus.js"))];
      const mod = require(path.join(CORPUS_DIR, "run-corpus.js"));
      expect(mod.runCorpus).to.be.a("function");
      expect(mod.runOne).to.be.a("function");
      expect(mod.DEFAULT_VERIFIERS).to.be.an("array").with.length.of.at.least(3);

      const out = mod.runCorpus();
      expect(out.ok, "the real corpus passes via the API too").to.equal(true);
      expect(out.falseAcceptCount).to.equal(0);
      expect(out.checkCount).to.equal(out.classCount * out.verifierCount);

      // runOne on one (verifier, class) pair matches the aggregate result for that pair.
      const v = mod.DEFAULT_VERIFIERS[0];
      const cls = manifest.classes[0];
      const one = mod.runOne(v, cls);
      expect(one.pass).to.equal(true);
      expect(one.falseAccept).to.equal(false);
      expect(one.exit).to.not.equal(0);
    });

    it("a missing/broken corpus is reported as a FAIL with exit 1 (never a silent PASS)", function () {
      // Point the runner at an EMPTY temp dir (no manifest.json): a gate that cannot run must FAIL.
      const empty = mkTmp();
      const r = runRunner(["--json"], { VH_CORPUS_DIR: empty });
      expect(r.status, "an unrunnable corpus must exit 1").to.equal(1);
      const out = JSON.parse(r.stdout);
      expect(out.ok).to.equal(false);
      expect(out.error, "the error is surfaced").to.be.a("string").and.match(/manifest/i);
    });
  });
});
