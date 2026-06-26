"use strict";

// test/challenge.corpus.test.js — T-52.1: PROVE the versioned tamper-class taxonomy + the
// poisoned-corpus generator (challenge/corpus/).
//
// WHY THIS TEST EXISTS
//   The 60-second challenge (challenge/) proves a verifier catches ONE byte-edit on ONE packet.
//   This corpus raises that to the buyer's real question — "does your verifier catch the OTHER
//   ways an artifact gets poisoned, across the kinds of packets MY business seals?" — by committing
//   a versioned RED-TEAM kit: one CLEAN business packet per vertical, one POISONED packet per tamper
//   class (clean + EXACTLY ONE documented mutation), a deterministic generator that re-emits it all
//   byte-for-byte, and a manifest that publishes the taxonomy. This suite makes every promise the
//   corpus makes TRUE in code, by DRIVING the REAL committed standalone verifier (never a stand-in,
//   never trusting the seal's own stored hashes):
//
//   (A) The generator is DETERMINISTIC: regenerating into a temp tree reproduces the committed
//       clean/, poisoned/ and manifest.json byte-for-byte — NO drift.
//   (B) The manifest enumerates >= 9 distinct tamper classes spanning >= 3 verticals, each with a
//       unique id, a referenced clean fixture, and an expectedExit in {2, 3}.
//   (C) Every CLEAN fixture VERIFIES (exit 0) with the real standalone verifier BEFORE mutation —
//       the corpus is HONEST: the poison, not a broken fixture, is what each verifier catches.
//   (D) Every POISONED packet differs from its clean source in EXACTLY the documented way (asserted
//       against the on-disk bytes), and the real verifier trips EXACTLY the documented exit
//       (2 or 3) — never a false ACCEPT.
//
// Everything that writes lands under a throwaway temp dir cleaned in afterEach; the committed
// corpus tree is asserted byte-for-byte untouched. No keys anywhere — the free, unsigned path.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CORPUS_DIR = path.join(ROOT, "challenge", "corpus");
const GENERATOR = path.join(CORPUS_DIR, "generate.js");
const MANIFEST_PATH = path.join(CORPUS_DIR, "manifest.json");
const CLEAN_DIR = path.join(CORPUS_DIR, "clean");
const POISONED_DIR = path.join(CORPUS_DIR, "poisoned");

// The committed, single-file, zero-dependency standalone verifier the challenge ships (NOT forked).
const VERIFIER = path.join(ROOT, "verifier", "dist", "verify-vh-standalone.js");

// Run the REAL standalone verifier in a CHILD PROCESS with NODE_PATH cleared, so its require() cannot
// reach this repo's node_modules — proving the zero-install claim, not assuming it.
function runVerifier(sealPath, dir, extraArgs = []) {
  return spawnSync(process.execPath, [VERIFIER, sealPath, "--dir", dir, ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "" },
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

// A full snapshot of the committed corpus OUTPUTS (clean/, poisoned/, manifest.json) — what the
// generator re-emits. The generator source itself is excluded (it is the producer, not the output).
function snapshotCorpus(baseDir) {
  const snap = {
    ...snapshotDir(path.join(baseDir, "clean"), "clean"),
    ...snapshotDir(path.join(baseDir, "poisoned"), "poisoned"),
  };
  const m = path.join(baseDir, "manifest.json");
  if (fs.existsSync(m)) snap["manifest.json"] = fs.readFileSync(m).toString("hex");
  return snap;
}

describe("adversarial CONFORMANCE corpus: tamper-class taxonomy + deterministic generator (T-52.1)", function () {
  // Child spawns of the bundled verifier/sealer are slower than a unit test; give headroom.
  this.timeout(120000);

  let manifest;
  let committedBefore;
  let tmpDirs;

  before(function () {
    expect(fs.existsSync(GENERATOR), "challenge/corpus/generate.js must exist").to.equal(true);
    expect(fs.existsSync(MANIFEST_PATH), "challenge/corpus/manifest.json must exist").to.equal(true);
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  });

  beforeEach(function () {
    tmpDirs = [];
    committedBefore = snapshotCorpus(CORPUS_DIR);
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing in this suite mutated the committed corpus outputs.
    expect(snapshotCorpus(CORPUS_DIR), "the committed challenge/corpus/ outputs were mutated").to.deep.equal(
      committedBefore
    );
  });

  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-corpus-"));
    tmpDirs.push(d);
    return d;
  }

  // ==========================================================================================
  // (A) The generator is DETERMINISTIC — re-emits the committed corpus byte-for-byte (no drift).
  // ==========================================================================================
  describe("(A) the generator re-emits the committed corpus byte-for-byte (deterministic)", function () {
    it("regenerating into a fresh temp tree reproduces clean/, poisoned/ and manifest.json with NO drift", function () {
      // Run the COMMITTED generator with VH_CORPUS_OUT pointed at an empty temp dir, so it writes a
      // from-scratch corpus there (resolving the real sealer relative to its own committed location).
      // Its output must equal the committed bytes exactly — proving a re-run never drifts, WITHOUT
      // touching the committed tree (the afterEach hygiene assertion re-confirms it stayed pristine).
      const tmp = mkTmp();
      const r = spawnSync(process.execPath, [GENERATOR], {
        encoding: "utf8",
        env: { ...process.env, VH_CORPUS_OUT: tmp, NODE_PATH: "" },
      });
      expect(r.status, `generator exit 0 (stderr: ${r.stderr})`).to.equal(0);

      const regenerated = snapshotCorpus(tmp);
      expect(regenerated, "a fresh regeneration must match the committed corpus byte-for-byte").to.deep.equal(
        committedBefore
      );
    });

    it("running the generator a SECOND time over the committed tree changes nothing (idempotent)", function () {
      // Run the committed generator's --check (a no-mutation drift gate it ships). It regenerates in
      // place and confirms the bytes are unchanged, then leaves the tree identical (idempotent), which
      // the afterEach hygiene assertion independently re-confirms.
      const r = spawnSync(process.execPath, [GENERATOR, "--check"], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
      });
      expect(r.status, `--check exit 0 / NO DRIFT (stdout: ${r.stdout}\nstderr: ${r.stderr})`).to.equal(0);
      expect(r.stdout).to.match(/NO DRIFT/);
    });
  });

  // ==========================================================================================
  // (B) The manifest IS the taxonomy: >= 9 classes, >= 3 verticals, unique ids, exit in {2,3}.
  // ==========================================================================================
  describe("(B) the manifest enumerates a well-formed tamper-class taxonomy", function () {
    it("declares kind vh.challenge-corpus, a corpusVersion, and a classes[] matching classCount", function () {
      expect(manifest.kind).to.equal("vh.challenge-corpus");
      expect(manifest.corpusVersion, "corpusVersion must be a positive integer").to.be.a("number");
      expect(Number.isInteger(manifest.corpusVersion) && manifest.corpusVersion >= 1).to.equal(true);
      expect(manifest.classes).to.be.an("array");
      expect(manifest.classCount, "classCount must equal classes.length").to.equal(manifest.classes.length);
    });

    it(">= 9 distinct tamper classes, each with a UNIQUE id", function () {
      expect(manifest.classes.length, "need at least 9 tamper classes").to.be.at.least(9);
      const ids = manifest.classes.map((c) => c.id);
      expect(new Set(ids).size, "every class id must be unique").to.equal(ids.length);
      for (const id of ids) {
        expect(id, "class id must be a non-empty string").to.be.a("string").and.not.equal("");
      }
    });

    it("spans >= 3 distinct verticals, and manifest.verticals matches the classes' verticals", function () {
      const verticalsInClasses = [...new Set(manifest.classes.map((c) => c.vertical))].sort();
      expect(verticalsInClasses.length, "need at least 3 distinct verticals").to.be.at.least(3);
      expect(manifest.verticals.slice().sort(), "manifest.verticals must match the classes").to.deep.equal(
        verticalsInClasses
      );
    });

    it("every class references an existing clean fixture and an existing poisoned packet + seal", function () {
      for (const c of manifest.classes) {
        const cleanAbs = path.join(ROOT, "challenge", "corpus", c.cleanFixture);
        expect(fs.existsSync(cleanAbs), `clean fixture missing for ${c.id}: ${c.cleanFixture}`).to.equal(true);
        expect(fs.statSync(cleanAbs).isDirectory(), `cleanFixture must be a directory for ${c.id}`).to.equal(true);

        const pktAbs = path.join(ROOT, "challenge", "corpus", c.poisonedPacket);
        expect(fs.existsSync(pktAbs), `poisoned packet missing for ${c.id}: ${c.poisonedPacket}`).to.equal(true);

        const sealAbs = path.join(ROOT, "challenge", "corpus", c.seal);
        expect(fs.existsSync(sealAbs), `seal missing for ${c.id}: ${c.seal}`).to.equal(true);
      }
    });

    it("every class has an expectedExit in {2, 3} (a verifier's REJECT contract, never accept)", function () {
      for (const c of manifest.classes) {
        expect([2, 3], `expectedExit for ${c.id} must be 2 or 3, got ${c.expectedExit}`).to.include(
          c.expectedExit
        );
      }
    });
  });

  // ==========================================================================================
  // (C) Every CLEAN fixture verifies CLEAN (exit 0) BEFORE mutation — the corpus is honest.
  //     We re-seal each clean fixture into a temp dir with the committed standalone SEALER and
  //     verify it with the standalone VERIFIER — proving the fixture itself is sound, so what the
  //     poisoned variant trips is the POISON, not a pre-broken fixture.
  // ==========================================================================================
  describe("(C) every clean fixture VERIFIES (exit 0) before mutation (honest corpus)", function () {
    const SEALER = path.join(ROOT, "verifier", "dist", "seal-vh-standalone.js");

    // Distinct clean fixtures referenced by the taxonomy (a vertical may back several classes).
    function distinctFixtures() {
      return [...new Set(manifest.classes.map((c) => c.cleanFixture))].sort();
    }

    it("the committed standalone sealer is present (the corpus seals with the REAL free-tier tool)", function () {
      expect(fs.existsSync(SEALER), "verifier/dist/seal-vh-standalone.js").to.equal(true);
    });

    for (const fixtureRel of [
      "clean/ai-data",
      "clean/finance",
      "clean/legal",
      "clean/software",
    ]) {
      it(`${fixtureRel} re-seals + VERIFIES clean (exit 0, root matches, nothing changed/missing)`, function () {
        const fixtureAbs = path.join(ROOT, "challenge", "corpus", fixtureRel);
        if (!fs.existsSync(fixtureAbs)) this.skip();

        const tmp = mkTmp();
        const sealPath = path.join(tmp, "seal.vhevidence.json");
        const seal = spawnSync(process.execPath, [SEALER, fixtureAbs, "-o", sealPath], {
          encoding: "utf8",
          env: { ...process.env, NODE_PATH: "" },
        });
        expect(seal.status, `seal exit 0 (stderr: ${seal.stderr})`).to.equal(0);

        const r = runVerifier(sealPath, fixtureAbs, ["--json"]);
        expect(r.status, `clean fixture ${fixtureRel} verifies exit 0 (stderr: ${r.stderr})`).to.equal(0);
        const v = JSON.parse(r.stdout);
        expect(v.verdict).to.equal("OK");
        expect(v.accepted).to.equal(true);
        expect(v.rootMatches).to.equal(true);
        expect(v.counts).to.include({ changed: 0, missing: 0 });
      });
    }

    it("EVERY distinct clean fixture referenced by the taxonomy is one of the asserted-clean dirs", function () {
      // Guard: no class may point at a clean fixture we did not prove clean above.
      const proven = new Set(["clean/ai-data", "clean/finance", "clean/legal", "clean/software"]);
      for (const f of distinctFixtures()) {
        expect(proven.has(f), `class clean fixture ${f} is not covered by a clean-verify assertion`).to.equal(
          true
        );
      }
    });
  });

  // ==========================================================================================
  // (D) Every POISONED packet differs from its clean source in EXACTLY the documented way AND the
  //     real verifier trips EXACTLY the documented exit (2 or 3) — never a false ACCEPT.
  // ==========================================================================================
  describe("(D) every poisoned packet differs in EXACTLY the documented way and trips its exit", function () {
    // The committed poisoned packet's seal verdict, captured for the on-disk artifact.
    function verifyPoisoned(c) {
      const sealAbs = path.join(ROOT, "challenge", "corpus", c.seal);
      const pktAbs = path.join(ROOT, "challenge", "corpus", c.poisonedPacket);
      return runVerifier(sealAbs, pktAbs, ["--json"]);
    }

    for (const c of [
      "finance-amount-edited",
      "finance-tie-out-dropped",
      "ai-data-sample-swapped",
      "ai-data-license-stripped",
      "ai-data-file-renamed",
      "software-sbom-injected",
      "software-checksum-edited",
      "legal-clause-altered",
      "legal-signature-page-dropped",
      "seal-root-forged",
      "seal-kind-corrupted",
    ]) {
      it(`${c}: poisoned packet trips its documented exit (no false ACCEPT)`, function () {
        const cls = manifest.classes.find((x) => x.id === c);
        if (!cls) this.skip();
        const r = verifyPoisoned(cls);
        expect(r.status, `${c} -> exit ${cls.expectedExit} (stdout:${r.stdout}\nstderr:${r.stderr})`).to.equal(
          cls.expectedExit
        );
        // A poisoned packet must NEVER verify (exit 0) — the whole point of the corpus.
        expect(r.status, `${c} must NOT be a false ACCEPT`).to.not.equal(0);
        // For an exit-3 tamper the JSON verdict is REJECTED; for exit 2 the verifier errors before a verdict.
        if (cls.expectedExit === 3) {
          const v = JSON.parse(r.stdout);
          expect(v.verdict, `${c} verdict must be REJECTED`).to.equal("REJECTED");
          expect(v.accepted).to.equal(false);
        }
      });
    }

    // Cross-check "differs in EXACTLY the documented way" against the on-disk bytes: for each class,
    // diff the poisoned packet against its clean fixture and the poisoned seal against a fresh clean
    // seal, and assert the difference is precisely the documented mutationOp/target.
    for (const c of [
      "finance-amount-edited",
      "finance-tie-out-dropped",
      "ai-data-sample-swapped",
      "ai-data-license-stripped",
      "ai-data-file-renamed",
      "software-sbom-injected",
      "software-checksum-edited",
      "legal-clause-altered",
      "legal-signature-page-dropped",
      "seal-root-forged",
      "seal-kind-corrupted",
    ]) {
      it(`${c}: differs from its clean source in EXACTLY the one documented way`, function () {
        const cls = manifest.classes.find((x) => x.id === c);
        if (!cls) this.skip();

        const cleanAbs = path.join(ROOT, "challenge", "corpus", cls.cleanFixture);
        const pktAbs = path.join(ROOT, "challenge", "corpus", cls.poisonedPacket);

        const cleanSnap = snapshotDir(cleanAbs, "");
        const pktSnap = snapshotDir(pktAbs, "");

        const op = cls.mutationOp;
        if (op === "edit-content" || op === "truncate-file") {
          // Exactly one file changed in place; all other paths byte-identical to clean.
          const cleanKeys = Object.keys(cleanSnap).sort();
          const pktKeys = Object.keys(pktSnap).sort();
          expect(pktKeys, `${c}: no files added/removed for a content edit`).to.deep.equal(cleanKeys);
          const differing = cleanKeys.filter((k) => cleanSnap[k] !== pktSnap[k]);
          expect(differing, `${c}: exactly one file differs`).to.deep.equal([cls.mutationTarget]);
          if (op === "truncate-file") {
            expect(pktSnap[cls.mutationTarget], `${c}: target truncated to empty`).to.equal("");
          } else {
            expect(pktSnap[cls.mutationTarget], `${c}: target must actually differ`).to.not.equal(
              cleanSnap[cls.mutationTarget]
            );
          }
        } else if (op === "delete-file") {
          // The poisoned packet is the clean set minus exactly the target; all survivors byte-identical.
          expect(pktSnap[cls.mutationTarget], `${c}: target must be gone`).to.equal(undefined);
          const expectedKeys = Object.keys(cleanSnap)
            .filter((k) => k !== cls.mutationTarget)
            .sort();
          expect(Object.keys(pktSnap).sort(), `${c}: only the target was removed`).to.deep.equal(expectedKeys);
          for (const k of expectedKeys) {
            expect(pktSnap[k], `${c}: survivor ${k} byte-identical to clean`).to.equal(cleanSnap[k]);
          }
        } else if (op === "rename-file") {
          // The target is gone; renamedTo is present with the target's clean bytes; nothing else moved.
          expect(pktSnap[cls.mutationTarget], `${c}: original path gone`).to.equal(undefined);
          expect(pktSnap[cls.renamedTo], `${c}: renamedTo present`).to.not.equal(undefined);
          expect(pktSnap[cls.renamedTo], `${c}: renamed file keeps the clean bytes`).to.equal(
            cleanSnap[cls.mutationTarget]
          );
          const expectedKeys = Object.keys(cleanSnap)
            .filter((k) => k !== cls.mutationTarget)
            .concat([cls.renamedTo])
            .sort();
          expect(Object.keys(pktSnap).sort(), `${c}: exactly one rename, nothing else`).to.deep.equal(
            expectedKeys
          );
        } else if (op === "edit-seal-root" || op === "edit-seal-kind") {
          // SEAL tamper: the PACKET bytes are byte-identical to clean (no file touched) ...
          expect(pktSnap, `${c}: packet bytes untouched for a seal tamper`).to.deep.equal(cleanSnap);
          // ... and the committed seal differs from a clean re-seal in EXACTLY the named field.
          const SEALER = path.join(ROOT, "verifier", "dist", "seal-vh-standalone.js");
          const tmp = mkTmp();
          const cleanSealPath = path.join(tmp, "clean-seal.json");
          const seal = spawnSync(process.execPath, [SEALER, cleanAbs, "-o", cleanSealPath], {
            encoding: "utf8",
            env: { ...process.env, NODE_PATH: "" },
          });
          expect(seal.status, `${c}: re-seal exit 0 (stderr: ${seal.stderr})`).to.equal(0);
          const cleanSeal = JSON.parse(fs.readFileSync(cleanSealPath, "utf8"));
          const poisonedSeal = JSON.parse(
            fs.readFileSync(path.join(ROOT, "challenge", "corpus", cls.seal), "utf8")
          );

          const field = op === "edit-seal-root" ? "root" : "kind";
          // Exactly the named field differs; every other top-level key is byte-equal (deep-equal).
          for (const k of new Set([...Object.keys(cleanSeal), ...Object.keys(poisonedSeal)])) {
            if (k === field) {
              expect(poisonedSeal[k], `${c}: ${field} must be forged/altered`).to.not.deep.equal(cleanSeal[k]);
            } else {
              expect(poisonedSeal[k], `${c}: non-${field} key ${k} must be untouched`).to.deep.equal(
                cleanSeal[k]
              );
            }
          }
        } else {
          throw new Error(`${c}: unknown mutationOp "${op}" — taxonomy/test out of sync`);
        }
      });
    }

    it("NO poisoned packet is a false ACCEPT (aggregate gate over the whole corpus)", function () {
      // The single load-bearing safety property: across EVERY class, the real verifier rejects. If any
      // class ever silently flips to exit 0, this fails loud.
      const accepted = [];
      for (const c of manifest.classes) {
        const r = verifyPoisoned(c);
        if (r.status === 0) accepted.push(c.id);
      }
      expect(accepted, `these poisoned classes wrongly VERIFIED (false accept): ${accepted.join(", ")}`).to.deep.equal(
        []
      );
    });
  });
});
