"use strict";

// test/journal.example.test.js — the CONTINUOUS-INTEGRITY drop-in acceptance suite that makes the
// `vh journal` append-only, hash-chained integrity journal a DROP-IN CI check, and documents it honestly (T-60.3).
//
// WHAT THIS PROVES (each acceptance clause is a describe/it below)
//   (1) THE EXAMPLE RUNS AS A CI INTEGRATOR WOULD: `node examples/journal-ci.js` in a CHILD PROCESS exits 0,
//       APPENDS an entry (in fact two hash-chained entries), and reports an UNBROKEN chain.
//   (2) THE EXAMPLE STANDS ALONE: a source-level grep asserts it imports ONLY `require("verifyhash")`, the
//       `vh` COMMAND (spawned, not required), Node built-ins, and relative files — NO deep `require(".../cli/…")`
//       (not even the pure journal core) and NO third-party dependency.
//   (3) THE GENERIC CI SCRIPT IS REAL + WORKS: it is `bash -n` syntactically valid and, driven against the
//       REAL `vh journal` command, EXITS ZERO on an unbroken chain and NON-ZERO (3) after a tampered artifact
//       appends a REJECT.
//   (4) THE DOC IS HONEST: docs/INTEGRITY-JOURNAL.md documents the schema + chain guarantee + the 0/3 contract,
//       CARRIES the SELF-ASSERTED-`ts` / not-a-timestamp honesty boundary sentence, and NEVER claims
//       "unaltered since date T" without the P-3 qualification.
//   (5) STRATEGY.md P-9 gains the journal sub-note AND still carries P-9's 3 human steps + P-3's human steps unchanged.
//
// PURE / OFFLINE — no chain, no provider, no network, no REAL key. Seals are built PURELY IN MEMORY with the
// PUBLIC SDK; every write lands under a throwaway temp dir and is cleaned up (pass or fail).

const { expect } = require("chai");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const vh = require("verifyhash");
const journalCore = require("../cli/journal");
const journalCli = require("../cli/journal-cli");

const REPO = path.resolve(__dirname, "..");
const EXAMPLE = path.join(REPO, "examples", "journal-ci.js");
const EXAMPLE_README = path.join(REPO, "examples", "README.md");
const GENERIC_SH = path.join(REPO, "verifier", "ci", "journal.generic.sh");
const GHA_YML = path.join(REPO, "verifier", "ci", "journal.github-actions.yml");
const DOC = path.join(REPO, "docs", "INTEGRITY-JOURNAL.md");
const SDK_DOC = path.join(REPO, "docs", "SDK.md");
const README = path.join(REPO, "README.md");
const STRATEGY = path.join(REPO, "STRATEGY.md");
const VH_BIN = path.join(REPO, "cli", "vh.js");

// A tiny in-memory file set — the shape buildSeal accepts.
const ENTRIES = [
  { relPath: "dist/app.js", bytes: Buffer.from("console.log('build 1');\n") },
  { relPath: "README.md", bytes: Buffer.from("# release\n") },
];

describe("integrity-journal CI drop-in — the continuous-integrity check (T-60.3)", function () {
  // Booting child node processes is a touch slow; give generous but bounded headroom.
  this.timeout(60000);

  let tmpDirs;
  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp(prefix = "vh-jx-") {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  }

  // Materialize a payload dir + a seal packet over it (built with the PUBLIC SDK). Returns { dir, packet }.
  function mkSealed(entries = ENTRIES) {
    const dir = mkTmp();
    for (const e of entries) {
      const abs = path.join(dir, e.relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, e.bytes);
    }
    const packet = path.join(dir, "release.vhevidence.json");
    fs.writeFileSync(packet, vh.serializeSeal(vh.buildSeal(entries)));
    return { dir, packet };
  }

  // Write an executable `vh` wrapper (exec node cli/vh.js "$@") into a temp dir and return its path — so the
  // shell gate runs the REAL command exactly as a user with `vh` on PATH would.
  function mkVhWrapper() {
    const dir = mkTmp("vh-bin-");
    const p = path.join(dir, "vh");
    fs.writeFileSync(p, `#!/usr/bin/env bash\nexec node ${JSON.stringify(VH_BIN)} "$@"\n`);
    fs.chmodSync(p, 0o755);
    return p;
  }

  // ===============================================================================================
  // (1) THE EXAMPLE RUNS AS A CI INTEGRATOR WOULD — child process, exit 0, appends an entry, unbroken chain.
  // ===============================================================================================
  describe("examples/journal-ci.js runs in a child process (exit 0, appends, unbroken chain)", function () {
    let stdout;

    before(function () {
      // Run EXACTLY as a developer would: `node examples/journal-ci.js`. execFileSync throws on a non-zero
      // exit, so a clean return already asserts exit 0. We capture stdout to assert the sequence.
      stdout = execFileSync("node", [EXAMPLE], { cwd: REPO, encoding: "utf8" });
    });

    it("exits 0 (execFileSync returned without throwing)", function () {
      expect(stdout).to.be.a("string").and.not.equal("");
    });

    it("APPENDS an entry (records a genesis seq 0 entry)", function () {
      expect(stdout).to.match(/appended seq 0/);
    });

    it("reports an UNBROKEN chain (verify PASS)", function () {
      expect(stdout).to.match(/PASS/);
      expect(stdout.toLowerCase()).to.match(/unbroken/);
    });

    it("leads with the SELF-ASSERTED-ts / not-a-timestamp trust note", function () {
      expect(stdout).to.match(/SELF-ASSERTED/);
      expect(stdout.toLowerCase()).to.match(/not\s*\n?\s*a trusted timestamp/i);
    });

    it("ends with a PASS summary naming the unbroken chain", function () {
      expect(stdout).to.match(/RESULT: PASS/);
    });

    it("importable runExample returns 2 appended entries + verifyExit 0 (asserted on DATA)", function () {
      const { runExample } = require("../examples/journal-ci");
      const result = runExample(() => {}); // silent sink — assert on the returned structure
      expect(result.entryCount).to.equal(2);
      expect(result.verifyExit).to.equal(0);
      expect(result.appendExit).to.equal(0);
      expect(result.apiVersion).to.equal(require("../package.json").version);
      expect(result.verifyStdout.toLowerCase()).to.match(/unbroken/);
    });
  });

  // ===============================================================================================
  // (2) THE EXAMPLE STANDS ALONE — grep the source: ONLY require("verifyhash") / the command / relative
  //     files / Node built-ins. NO deep require(".../cli/…") and NO third-party dependency.
  // ===============================================================================================
  describe("public surface stands alone — source grep of the example's imports", function () {
    let src; // comment-stripped source: we grep CODE, not prose (comments legitimately name anti-patterns)
    let requireArgs;

    before(function () {
      const rawSrc = fs.readFileSync(EXAMPLE, "utf8");
      src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      requireArgs = [];
      const re = /require\(\s*(["'])([^"']+)\1\s*\)/g;
      let m;
      while ((m = re.exec(src)) !== null) requireArgs.push(m[2]);
    });

    it("imports the package BY NAME through its public entrypoint (require(\"verifyhash\"))", function () {
      expect(requireArgs, "example must require the public package by name").to.include("verifyhash");
    });

    it("does NOT deep-import ANY cli/* internal (not even the pure journal core)", function () {
      // The load-bearing check: NO deep `require(".../cli/…")` reach-in anywhere in the CODE.
      expect(src, "example must not deep-import cli/*").to.not.match(/require\([^)]*\/cli\//);
      // Belt-and-braces: it must not import the pure journal core by any relative path either.
      expect(src, "example must not import the pure journal core").to.not.match(/require\([^)]*journal/);
      const KNOWN_BUILTINS = new Set([
        "fs", "path", "os", "http", "https", "child_process", "url", "util", "crypto", "process", "assert",
      ]);
      for (const arg of requireArgs) {
        const isPackageByName = arg === "verifyhash";
        const isRelative = arg.startsWith("./") || arg.startsWith("../");
        const isBuiltin = KNOWN_BUILTINS.has(arg) || arg.startsWith("node:");
        expect(
          isPackageByName || isRelative || isBuiltin,
          `example require("${arg}") is not the public package, a Node built-in, or a relative file`
        ).to.equal(true);
        if (isRelative) {
          expect(arg, `relative require("${arg}") reaches into cli/*`).to.not.match(/(^|\/)cli\//);
        }
        expect(arg, `require("${arg}") reaches into cli/`).to.not.match(/(^|\/)cli\//);
      }
    });

    it("uses NO third-party dependency (not even ethers) — only the package + Node built-ins", function () {
      const KNOWN_BUILTINS = new Set([
        "fs", "path", "os", "http", "https", "child_process", "url", "util", "crypto", "process", "assert",
      ]);
      for (const arg of requireArgs) {
        if (arg === "verifyhash") continue; // the public package by name
        if (arg.startsWith(".")) continue; // relative file
        expect(
          KNOWN_BUILTINS.has(arg) || arg.startsWith("node:"),
          `example require("${arg}") is a third-party dependency`
        ).to.equal(true);
        expect(arg, "example must not require ethers").to.not.equal("ethers");
      }
    });

    it("reaches the journal via the vh COMMAND (spawn), not by requiring a cli module", function () {
      expect(src).to.match(/spawnSync\(/);
      expect(src).to.match(/journal/);
    });

    it("examples/README.md documents the example + names its test (so the doc cannot silently rot)", function () {
      const readme = fs.readFileSync(EXAMPLE_README, "utf8");
      expect(readme).to.include("node examples/journal-ci.js");
      expect(readme).to.include("test/journal.example.test.js");
    });
  });

  // ===============================================================================================
  // (3) THE GENERIC CI SCRIPT — bash -n valid, and driven against the REAL command: zero on an unbroken
  //     chain, non-zero (3) after a tampered artifact appends a REJECT.
  // ===============================================================================================
  describe("verifier/ci/journal.generic.sh (the shipped shell gate, run against the real command)", function () {
    // Run the shell gate with env overrides; capture exit code + stdio (never throwing on non-zero).
    function runGate(env) {
      try {
        const stdout = execFileSync("bash", [GENERIC_SH], {
          env: { ...process.env, ...env },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, stdout, stderr: "" };
      } catch (e) {
        return {
          code: typeof e.status === "number" ? e.status : 1,
          stdout: e.stdout ? e.stdout.toString() : "",
          stderr: e.stderr ? e.stderr.toString() : "",
        };
      }
    }

    it("is shipped, a real bash script, and `bash -n` syntactically valid", function () {
      expect(fs.existsSync(GENERIC_SH), "journal.generic.sh must be shipped").to.equal(true);
      const srcSh = fs.readFileSync(GENERIC_SH, "utf8");
      expect(srcSh).to.match(/^#!.*\bbash\b/m);
      expect(srcSh).to.match(/set -euo pipefail/);
      // `bash -n` parses WITHOUT executing — a syntax error exits non-zero and this throws.
      execFileSync("bash", ["-n", GENERIC_SH], { stdio: ["ignore", "pipe", "pipe"] });
    });

    it("EXITS 0 on an UNBROKEN chain (clean artifact appends ACCEPTED -> verify PASS)", function () {
      const { dir, packet } = mkSealed();
      const journal = path.join(dir, "integrity.jsonl");
      const r = runGate({
        VH_BIN: mkVhWrapper(),
        VH_JOURNAL: journal,
        VH_ARTIFACT: packet,
        VH_DIR: dir,
        VH_TS: "2026-07-01T00:00:00.000Z",
      });
      expect(r.code, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).to.equal(0);
      expect(r.stdout).to.match(/PASS/);
      expect(r.stdout).to.match(/ACCEPTED/);
      // The chain really has one entry now.
      expect(fs.existsSync(journal)).to.equal(true);
    });

    it("EXITS NON-ZERO (3) after a TAMPERED artifact appends a REJECT (continuous-integrity fail)", function () {
      const { dir, packet } = mkSealed();
      const journal = path.join(dir, "integrity.jsonl");
      const vhBin = mkVhWrapper();

      // First run: clean -> exit 0, one ACCEPTED entry.
      const clean = runGate({ VH_BIN: vhBin, VH_JOURNAL: journal, VH_ARTIFACT: packet, VH_DIR: dir, VH_TS: "T0" });
      expect(clean.code, `clean run should pass; stderr: ${clean.stderr}`).to.equal(0);

      // Tamper one byte of one sealed file, then re-run the gate: append records a REJECT (exit 0), verify
      // then reports the chain as DRIFTED -> the gate exits 3.
      fs.writeFileSync(path.join(dir, "dist/app.js"), Buffer.from("console.log('build 2');\n"));
      const bad = runGate({ VH_BIN: vhBin, VH_JOURNAL: journal, VH_ARTIFACT: packet, VH_DIR: dir, VH_TS: "T1" });
      expect(bad.code, `stdout: ${bad.stdout}\nstderr: ${bad.stderr}`).to.equal(3);
      expect(bad.stdout + bad.stderr).to.match(/REJECT/i);
      expect(bad.stderr).to.match(/blocking the merge/);

      // The recorded REJECT is a faithful, chain-intact entry (a REJECT append is a SUCCESSFUL append). Prove
      // the chain itself is INTACT (BROKEN would mean tamper of the log; here only an observation FAILED).
      const entries = fs
        .readFileSync(journal, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l));
      expect(entries.length).to.equal(2);
      expect(journalCore.verifyJournal(entries).ok, "the log chain must still be intact").to.equal(true);
      expect(entries[1].verdict.verdict).to.equal("REJECTED");
    });

    it("a missing VH_JOURNAL is a usage error (exit 2) — never a silent pass", function () {
      const r = runGate({ VH_BIN: mkVhWrapper() });
      expect(r.code).to.equal(2);
      expect(r.stderr).to.match(/set VH_JOURNAL/);
    });

    it("passes through the SHARED 0/3 exit contract (parity with journal-cli JOURNAL_EXIT)", function () {
      // The gate keys on 0 PASS / 3 broken-or-drifted / 2 usage / 1 IO — the SAME values the CLI uses.
      expect(journalCli.JOURNAL_EXIT).to.deep.equal({ OK: 0, IO: 1, USAGE: 2, DRIFT: 3 });
    });

    it("is HONEST about dependencies — discloses ethers is installed (the gate runs the producer package)", function () {
      // The review panel caught a copy-pasted overclaim ("no ethers") — the `vh journal` gate runs the PRODUCER
      // package, and `npm i verifyhash` installs ethers as a runtime dep (cli/journal.js requires it). The doc
      // must say so honestly, and must disclose the standalone-independence scope gap.
      const srcSh = fs.readFileSync(GENERIC_SH, "utf8");
      expect(srcSh, "must disclose ethers is a runtime dependency the gate installs").to.match(/brings in ethers/i);
      expect(srcSh.toLowerCase(), "must disclose the standalone-independence scope gap").to.match(/independence/);
    });
  });

  // ===============================================================================================
  // (3b) THE GITHUB ACTIONS YAML — a shipped example that appends then verifies the standing chain.
  // ===============================================================================================
  describe("verifier/ci/journal.github-actions.yml (the shipped GH Actions example)", function () {
    it("is a shipped workflow that triggers on push/pull_request and runs append + verify", function () {
      expect(fs.existsSync(GHA_YML)).to.equal(true);
      const yml = fs.readFileSync(GHA_YML, "utf8");
      expect(yml).to.match(/^on:/m);
      expect(yml).to.match(/pull_request:/);
      expect(yml).to.match(/jobs:/);
      expect(yml).to.match(/integrity-journal:/);
      // It runs the append-then-verify gate.
      expect(yml).to.match(/vh journal append/);
      expect(yml).to.match(/vh journal verify/);
      // It PERSISTS the journal across runs (where the continuous value lives).
      expect(yml.toLowerCase()).to.match(/persist|cache/);
      // It carries the honesty boundary.
      expect(yml).to.match(/SELF-ASSERTED/);
      expect(yml).to.match(/P-3/);
    });

    it("persists via a ROLLING cache key (run_id) + restore-keys — NOT a static key that would freeze the chain", function () {
      // REGRESSION GUARD for the medium defect the review panel caught: a STATIC actions/cache key HITs every
      // run after the first and (GitHub caches being immutable) SKIPS the post-job save, so the journal
      // silently never grows past one entry while the job stays green — defeating the whole feature.
      const yml = fs.readFileSync(GHA_YML, "utf8");
      expect(yml, "must persist with actions/cache").to.match(/uses:\s*actions\/cache/);
      // The cache `key` must ROTATE per run (embed github.run_id) so every run is a MISS -> a SAVE.
      const keyLine = yml.split("\n").find((l) => /^\s*key:\s*vh-integrity-journal/.test(l));
      expect(keyLine, "a `key:` line for the integrity journal cache must be present").to.be.a("string");
      expect(keyLine, "cache key must rotate per run (embed github.run_id), never a STATIC key").to.match(/github\.run_id/);
      // ...and restore-keys must provide the prefix fallback that restores the most-recent prior journal.
      expect(yml, "must declare restore-keys as the prefix fallback so the chain accumulates").to.match(/restore-keys:/);
    });
  });

  // ===============================================================================================
  // (4) docs/INTEGRITY-JOURNAL.md — schema + chain guarantee + 0/3 contract + the honesty boundary, and it
  //     NEVER claims "unaltered since date T" without the P-3 qualification.
  // ===============================================================================================
  describe("docs/INTEGRITY-JOURNAL.md documents schema + chain guarantee + 0/3 + the honesty boundary", function () {
    let doc;

    before(function () {
      doc = fs.readFileSync(DOC, "utf8");
    });

    it("documents the entry SCHEMA (every field) + the stable schema/genesis constants VERBATIM", function () {
      for (const field of ["seq", "prevHash", "ts", "artifact", "verdict", "entryHash"]) {
        expect(doc, `doc must document the schema field \`${field}\``).to.match(new RegExp(`\\b${field}\\b`));
      }
      // Byte-match the core's constants (a doc that drifts from the code fails here).
      expect(doc, "doc must document the schema tag").to.contain(journalCore.JOURNAL_SCHEMA); // vh.integrity-journal/v1
      expect(doc, "doc must document the genesis domain").to.contain(journalCore.GENESIS_DOMAIN);
    });

    it("documents the CHAIN GUARANTEE (hash-chained, tamper-evident, localizes the first break)", function () {
      expect(doc.toLowerCase()).to.match(/hash-chain/);
      expect(doc.toLowerCase()).to.match(/tamper-evident/);
      expect(doc.toLowerCase()).to.match(/breaks the chain/);
      expect(doc.toLowerCase()).to.match(/localiz/);
      // Both distinct non-zero failure modes are named.
      expect(doc).to.match(/BROKEN/);
      expect(doc).to.match(/DRIFTED/);
      expect(doc).to.match(/PASS/);
    });

    it("documents the 0/3 exit-code contract", function () {
      expect(doc).to.match(/\b0\b/);
      expect(doc).to.match(/\b3\b/);
      expect(doc.toLowerCase()).to.match(/exit/);
      // The 0/3 contract is the SHARED verify contract.
      expect(doc.toLowerCase()).to.match(/contract/);
    });

    it("CARRIES the SELF-ASSERTED-ts / not-a-timestamp honesty boundary sentence", function () {
      expect(doc, "boundary: ts is SELF-ASSERTED").to.match(/SELF-ASSERTED/);
      expect(doc.toLowerCase(), "boundary: ts is NOT a trusted timestamp").to.match(/not a trusted timestamp/);
      // The exact boundary the journal draws.
      expect(doc.toLowerCase()).to.match(/verifier's own wall clock/);
    });

    it("NEVER claims \"unaltered since date T\" without the P-3 qualification", function () {
      const phrase = "unaltered since date T";
      // The doc SHOULD discuss the phrase (to draw the boundary) — but EVERY occurrence must be qualified by
      // a nearby P-3 reference. We scan each occurrence and require "P-3" within a 400-char window.
      let idx = doc.indexOf(phrase);
      expect(idx, "doc should discuss the 'unaltered since date T' boundary").to.be.greaterThan(-1);
      while (idx !== -1) {
        const windowStart = Math.max(0, idx - 400);
        const windowEnd = Math.min(doc.length, idx + phrase.length + 400);
        const window = doc.slice(windowStart, windowEnd);
        expect(
          window,
          `an "unaltered since date T" claim near index ${idx} is not qualified with P-3`
        ).to.match(/P-3/);
        idx = doc.indexOf(phrase, idx + 1);
      }
    });

    it("discloses the INDEPENDENCE SCOPE — journal verify needs the producer package, not (yet) the standalone verifier", function () {
      // The review panel flagged an undisclosed break of the verifier/ tree's independence promise: a seal is
      // re-verifiable offline with the zero-dependency standalone bundle, but a journal (today) requires the
      // producer package (ethers included). The doc must disclose this honestly.
      expect(doc, "doc must carry an Independence scope disclosure").to.match(/Independence scope/i);
      expect(doc.toLowerCase(), "must name the standalone verifier it is NOT yet in").to.match(/standalone/);
      expect(doc.toLowerCase(), "must state journal verify needs the producer package").to.match(/producer package/);
    });

    it("SDK.md + README.md link the journal doc + the example (the surface points at the journal)", function () {
      const sdk = fs.readFileSync(SDK_DOC, "utf8");
      expect(sdk).to.contain("INTEGRITY-JOURNAL.md");
      expect(sdk).to.contain("examples/journal-ci.js");
      expect(sdk).to.match(/vh journal/);
      const readme = fs.readFileSync(README, "utf8");
      expect(readme).to.contain("INTEGRITY-JOURNAL.md");
      expect(readme).to.match(/vh journal/);
    });
  });

  // ===============================================================================================
  // (5) STRATEGY.md P-9 gains the journal sub-note AND still carries P-9's 3 human steps + P-3's steps unchanged.
  // ===============================================================================================
  describe("STRATEGY.md P-9 — journal sub-note added; P-9 + P-3 human steps intact", function () {
    let strat;
    let p9Block;

    before(function () {
      strat = fs.readFileSync(STRATEGY, "utf8");
      const start = strat.indexOf("P-9 (2026-07-01) — EMBEDDABLE SDK distribution");
      expect(start, "P-9 block not found").to.be.greaterThan(-1);
      p9Block = strat.slice(start);
    });

    it("P-9 still carries its THREE human steps, in order, unchanged", function () {
      const step1 = p9Block.indexOf("1. **Decide whether/how to PUBLISH.**");
      const step2 = p9Block.indexOf("2. **Pick the embed/usage PRICE");
      const step3 = p9Block.indexOf("3. **Offer + support the SDK to embedders.**");
      expect(step1, "P-9 step 1 (PUBLISH) missing").to.be.greaterThan(-1);
      expect(step2, "P-9 step 2 (PRICE) missing").to.be.greaterThan(-1);
      expect(step3, "P-9 step 3 (Offer + support) missing").to.be.greaterThan(-1);
      expect(step1).to.be.lessThan(step2);
      expect(step2).to.be.lessThan(step3);
    });

    it("P-3's human handoff steps are still present, unchanged", function () {
      // P-3 owns signing/timestamping the ts. Its collapsed human handoff (Option A) must still be present.
      expect(strat).to.contain("(1) pick A/B/C");
      expect(strat).to.contain("PROVISION a real signing key OUTSIDE the");
      expect(strat).to.match(/run `vh dataset sign/);
    });

    it("gains the integrity-journal sub-note that names the command + the shipped artifacts", function () {
      expect(p9Block).to.match(/Integrity-journal sub-note/);
      expect(p9Block).to.match(/T-60\.3/);
      expect(p9Block).to.match(/vh journal/);
      expect(p9Block).to.contain("examples/journal-ci.js");
      expect(p9Block).to.contain("docs/INTEGRITY-JOURNAL.md");
    });

    it("the sub-note asserts IN-GUARDRAILS (verify-only, no key, NOT a token, NO new gate) + the P-3 boundary", function () {
      const note = p9Block.slice(p9Block.indexOf("Integrity-journal sub-note"));
      expect(note.toLowerCase()).to.match(/verify-only/);
      expect(note.toLowerCase()).to.match(/holds no key/);
      expect(note).to.match(/NOT a token/i);
      expect(note).to.match(/NO new gate/i);
      // The honesty boundary: ts SELF-ASSERTED, NOT a timestamp, and signing/timestamping stays the P-3 human step.
      expect(note).to.match(/SELF-ASSERTED/);
      expect(note).to.match(/P-3/);
      // Explicitly relaxes NONE of P-9's or P-3's human steps.
      expect(note).to.match(/RELAXES none/i);
    });
  });
});
