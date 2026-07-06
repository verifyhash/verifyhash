"use strict";

// ---------------------------------------------------------------------------------------------------
// T-73.2 — the npm tarball is SELF-CONTAINED, and the internal-telemetry exclusion is PINNED.
//
// Two failure modes this file makes impossible to regress silently:
//
//   1. LEAKING THE LOOP. package.json `files` ships docs/ with a NEGATION denylist
//      (docs/METRICS.jsonl, docs/DECIDE.md, …the internal build-loop's telemetry). A negation list is
//      fragile — reordering `files`, or an npm behavior change, would re-leak internals into every
//      `npm publish`. So we assert, from `npm pack --dry-run --json` (the EXACT file list npm would
//      publish), that every denylisted path is ABSENT and the user-facing docs (TRUST-BOUNDARIES,
//      EVIDENCE, ADOPT, AGENTTRACE) are PRESENT — dropping docs/ wholesale to "fix" a leak is a FAIL.
//
//      A hand-maintained blocklist checked against another hand-maintained blocklist is NOT a leak
//      guarantee — it only re-checks what the author remembered, and the two copies drift (that is
//      exactly how docs/DEPLOY-PUBLIC-SITE.md + docs/AUDIT.md once shipped to npm while the test stayed
//      green). So the load-bearing gate DERIVES the docs never-publish set from the project's single
//      source of truth — scripts/site-release.js `classifyForbidden` (its INTERNAL_FILES). npm is a
//      STRICTLY MORE public channel than the website, so anything site-release forbids from the public
//      webroot must be absent from the tarball; a NEW internal doc added to site-release then fails
//      this test automatically until package.json `files` also negates it — the property this file
//      header claims but a static list alone does not deliver.
//
//   2. A DEMO THAT ONLY WORKS FROM A CLONE. README/ADOPT tell a prospect to run `node examples/run.js`
//      and the verifier quickstart (`node verifier/verify-vh.js demo`, the same tool behind
//      `npx --yes verify-vh demo`). Those paths must resolve from an INSTALLED package, not only from
//      a git checkout. We pin the manifest (every file examples/run.js reads, enumerated from disk so
//      the sample tree cannot drift out of the tarball), then we pack FOR REAL into an OS temp dir
//      OUTSIDE the repo, extract, and run the documented quickstart from the EXTRACTED tree:
//      genuine → VERIFIED/ACCEPT (exit 0), one-byte tamper → REJECTED (exit 3).
//
// OFFLINE by construction: `npm pack` reads only the working tree (npm_config_offline is forced on
// anyway), the verifier's single bare dependency (js-sha3) — and, for the examples pipeline, ethers —
// resolve from THIS repo's already-installed node_modules via NODE_PATH. No registry, no network,
// no new dependency. Every write goes to an OS temp dir cleaned in after().
// ---------------------------------------------------------------------------------------------------

const { expect } = require("chai");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const NODE = process.execPath;
const MAX_BUF = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------
// The pinned lists.
// ---------------------------------------------------------------------------------------------------

// The internal-loop denylist: package.json `files` negations that must NEVER reach a published tarball.
const INTERNAL_DENYLIST_EXACT = [
  "docs/METRICS.jsonl",
  "docs/USAGE-BUDGET.json",
  "docs/ENGINE-LEDGER.json",
  "docs/LOOP-HARDENING-PLAN.md",
  "docs/SUPERVISOR-RUNBOOK.md",
  "docs/DECISIONS-PENDING.md",
  "docs/STRATEGY-ARCHIVE.md",
  "docs/MORNING.md",
  "docs/ADOPTION.json",
  "docs/DECIDE.md",
  // Also on scripts/site-release.js's canonical INTERNAL_FILES never-publish list — forbidden from the
  // public *website*, so a fortiori forbidden from npm (a strictly more public channel). These two once
  // leaked to the tarball while this list stayed silent; the DE-DRIFT gate below now derives them from
  // classifyForbidden so the coupling can't rot, but they are pinned here explicitly too.
  "docs/DEPLOY-PUBLIC-SITE.md",
  "docs/AUDIT.md",
];
// Dated loop-audit snapshots: deny by prefix so a new date never slips through.
const INTERNAL_DENYLIST_PREFIXES = ["docs/LOOP-AUDIT-"];

// The project's SINGLE SOURCE OF TRUTH for "this file must never be published anywhere" —
// scripts/site-release.js's `classifyForbidden` (backed by its INTERNAL_FILES/INTERNAL_TREES). The
// de-drift gate derives the docs never-publish set from it at test time instead of trusting the
// hand-maintained list above to stay in sync.
const { classifyForbidden } = require("../scripts/site-release");

// forbiddenDocsOnDisk() -> every committed docs/* path the site-release source of truth forbids from
// the public webroot. npm is strictly more public, so each of these MUST be absent from the tarball.
function forbiddenDocsOnDisk() {
  return walk("docs").filter((p) => classifyForbidden(p) !== null);
}

// The user-facing docs allowlist: excluding internals by dropping docs/ WHOLESALE would break every
// README/ADOPT deep link a prospect follows from the installed package — so their presence is a gate.
const USER_DOCS_ALLOWLIST = [
  "docs/TRUST-BOUNDARIES.md",
  "docs/EVIDENCE.md",
  "docs/ADOPT.md",
  "docs/AGENTTRACE.md",
];

// Every path the README quickstart demo (`node examples/run.js`) actually reads, ENUMERATED from
// examples/run.js — the script itself, the two cli modules it requires, and the committed sample
// inputs (SAMPLE_DATASET, SAMPLE_DATASET_HINTS, POLICY_LENIENT, POLICY_STRICT, SAMPLE_PARCEL).
const RUN_JS_FIXED_PATHS = [
  "examples/run.js",
  "examples/sample-dataset.hints.json",
  "examples/policy.lenient.json",
  "examples/policy.strict.json",
  "cli/dataset.js",
  "cli/parcel.js",
];
// The two sample DIRECTORIES run.js hashes are enumerated from disk (see walk()) so the tarball is
// pinned to the committed sample tree itself — run.js asserts fileCount 5 (dataset) and 3 (parcel),
// so a missing sample file inside the tarball would flip the installed-package demo to FAIL.
const RUN_JS_SAMPLE_DIRS = ["examples/sample-dataset", "examples/sample-parcel"];

// The independent-verifier quickstart README/ADOPT point recipients at (`verify-vh demo`, the CI
// action, the browser page): the split tree + the committed standalone bundles it documents.
const VERIFIER_ALLOWLIST = [
  "verifier/verify-vh.js",
  "verifier/package.json",
  "verifier/README.md",
  "verifier/lib/keccak.js",
  "verifier/lib/secp256k1-recover.js",
  "verifier/action/action.yml",
  "verifier/dist/verify-vh-standalone.js",
  "verifier/dist/verify-vh-standalone.html",
];

// T-77.2 — the 4-language independent-verifier suite docs/INDEPENDENT-VERIFICATION.md §6 sells:
// an npm installer must actually GET the alternate implementations + the frozen conformance
// vectors, or the "verify with up to FOUR independent implementations" pitch is a clone-only claim.
// (This also EXECUTES T-76.2's ship decision: verifier-py/verify_vh.py + SPEC.md + DEPENDENCIES.md
// must be PRESENT in every published tarball — while the internal-loop negation set above still
// holds — so a counterparty really can run the SECOND implementation from an npm install.)
const ALT_IMPL_ALLOWLIST = [
  // Python — one stdlib-only file + the extracted format spec an auditor writes a 5th impl from.
  "verifier-py/verify_vh.py",
  "verifier-py/SPEC.md",
  "verifier-py/DEPENDENCIES.md",
  "verifier-py/README.md",
  // Go — every .go source + go.mod (required for `go run .` / `go build .`).
  "verifier-go/go.mod",
  "verifier-go/main.go",
  "verifier-go/verify.go",
  "verifier-go/merkle.go",
  "verifier-go/keccak.go",
  "verifier-go/secp256k1.go",
  // Rust — src/ + Cargo.toml (+ Cargo.lock: its 1-package emptiness IS the supply-chain claim).
  "verifier-rs/Cargo.toml",
  "verifier-rs/Cargo.lock",
  "verifier-rs/src/main.rs",
  "verifier-rs/src/keccak.rs",
  "verifier-rs/src/secp256k1.rs",
  "verifier-rs/src/field.rs",
  "verifier-rs/src/merkle.rs",
  "verifier-rs/src/json.rs",
  // The frozen vector suite + the runnable 4-way harness.
  "verify-vectors/vectors.json",
  "verify-vectors/SHA256SUMS",
  "verify-vectors/README.md",
  "verify-vectors/conformance-4way.py",
];

// The scratch-era Python differential harness is NOT shipped: it hard-codes internal absolute
// paths (/home/loopdev/…, the operator self-license + vendor-key file locations) — exactly the
// internal-operational-surface class the denylist exists to keep out of a customer install.
const ALT_IMPL_DENYLIST = ["verifier-py/conformance.py"];

// npm tarballs cannot carry symlinks (npm-packlist silently drops them). The symlinked-artifact
// vector's `alias.json` IS a symlink, so it is expected ABSENT from the pack — and docs/
// INDEPENDENT-VERIFICATION.md §6 documents the one-line `ln -s` restore. Pinned here so an npm
// behavior change (symlinks suddenly shipping, or — worse — shipping as a file COPY that would
// silently defeat the vector's symlink-vs-lexical point) is caught, not discovered by a customer.
const VECTOR_SYMLINK_TARBALL_PATH = "verify-vectors/cases/symlinked-artifact/files/alias.json";

// Repo-internal trees that must never ship at all (the loop's build surface, not the product's).
const FORBIDDEN_ROOT_PREFIXES = ["test/", "scripts/", "site/", "artifacts/", "cache/", "contracts/"];

// ---------------------------------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------------------------------

// npm env hardened for determinism + offline: no update pings, no audit/fund chatter. `pack` reads
// only the working tree, but force offline mode anyway so a regression can never phone home in CI.
function npmEnv() {
  return {
    ...process.env,
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_offline: "true",
    npm_config_loglevel: "error",
  };
}

// npm prefixes --json output with nothing on stdout in current versions, but slice defensively from
// the first JSON bracket so a stray notice line can never break parsing.
function parseNpmJson(stdout) {
  const start = stdout.indexOf("[");
  expect(start, `npm --json output contained no JSON array:\n${stdout.slice(0, 500)}`).to.be.at.least(0);
  return JSON.parse(stdout.slice(start));
}

function npmPack(args, opts = {}) {
  const res = spawnSync("npm", ["pack", "--json", ...args], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: MAX_BUF,
    env: npmEnv(),
    ...opts,
  });
  expect(res.error, `npm pack failed to spawn: ${res.error && res.error.message}`).to.equal(undefined);
  expect(res.status, `npm pack exited ${res.status}:\n${res.stderr}`).to.equal(0);
  return parseNpmJson(res.stdout);
}

// Recursively list every regular file under dir, as tarball-style paths relative to the repo root.
function walk(relDir) {
  const out = [];
  const abs = path.join(REPO, relDir);
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

function runNode(args, opts) {
  return spawnSync(NODE, args, { encoding: "utf8", maxBuffer: MAX_BUF, ...opts });
}

// ---------------------------------------------------------------------------------------------------
// Part 1 — the manifest gate: `npm pack --dry-run --json` (what npm WOULD publish).
// ---------------------------------------------------------------------------------------------------

describe("T-73.2 npm tarball: manifest gate (`npm pack --dry-run --json`, offline)", function () {
  this.timeout(120000);

  let shipped; // Set of tarball-relative paths, e.g. "docs/ADOPT.md"

  before(function () {
    const report = npmPack(["--dry-run"]);
    expect(report, "npm pack --json must report exactly one package").to.have.length(1);
    shipped = new Set(report[0].files.map((f) => f.path));
    expect(shipped.size, "the tarball file list must not be empty").to.be.greaterThan(0);
  });

  it("ships NONE of the internal-loop denylist (the `files[]` negations hold)", function () {
    for (const p of INTERNAL_DENYLIST_EXACT) {
      expect(shipped.has(p), `INTERNAL FILE LEAKED into the tarball: ${p}`).to.equal(false);
    }
    for (const prefix of INTERNAL_DENYLIST_PREFIXES) {
      const leaked = [...shipped].filter((p) => p.startsWith(prefix));
      expect(leaked, `INTERNAL FILES LEAKED into the tarball (prefix ${prefix}*): ${leaked.join(", ")}`)
        .to.have.length(0);
    }
  });

  it("ships NO archived engine copy (docs/engine-archive/* — the internal build-loop brain, md5-addressed and rotating)", function () {
    // The pre-run-gate archives up to ARCHIVE_KEEP=10 md5-content-addressed copies of the internal
    // build-loop ORCHESTRATION ENGINE (build-loop.workflow.js / build-loop.prev.js) under
    // docs/engine-archive/. The filenames are content hashes that ROTATE, so we pin the SUBTREE
    // PREFIX (not enumerable names): ANY docs/engine-archive/* re-entering the pack is a leak — the
    // exact "internal operational surface in a paying customer's install" class that once shipped in
    // verifyhash@0.1.0. package.json negates it AND site-release forbids the subtree (see DE-DRIFT).
    const leaked = [...shipped].filter((p) => p.startsWith("docs/engine-archive/"));
    expect(
      leaked,
      `ARCHIVED ENGINE LEAKED into the tarball (docs/engine-archive/* — internal build-loop source): ${leaked.join(", ")}`
    ).to.have.length(0);
  });

  it("still ships the user-facing docs (dropping docs/ wholesale is a FAIL, not a fix)", function () {
    for (const p of USER_DOCS_ALLOWLIST) {
      expect(shipped.has(p), `user-facing doc MISSING from the tarball: ${p}`).to.equal(true);
    }
  });

  it("DE-DRIFT: ships NO docs/ file site-release.js forbids (derived source of truth, not a memory aid)", function () {
    const forbidden = forbiddenDocsOnDisk();
    // Sanity: the source of truth must actually flag something — incl. the two internal-ops docs the
    // review caught leaking — so this gate can never pass green by silently deriving an EMPTY set.
    expect(forbidden, "classifyForbidden flagged no docs/* file — the source-of-truth wiring is broken")
      .to.include("docs/DEPLOY-PUBLIC-SITE.md");
    expect(forbidden, "classifyForbidden must flag docs/AUDIT.md as internal").to.include("docs/AUDIT.md");
    // The load-bearing assertion: every docs file site-release forbids from the (less-public) website
    // is ABSENT from the (more-public) npm tarball. A future internal doc added to site-release's
    // INTERNAL_FILES fails HERE until package.json `files` also negates it — no silent regression.
    for (const p of forbidden) {
      expect(
        shipped.has(p),
        `INTERNAL doc LEAKED into the tarball — scripts/site-release.js forbids it from the public site, ` +
          `npm is strictly more public: ${p} (add "!${p}" to package.json "files")`
      ).to.equal(false);
    }
  });

  it("ships every file the README demo (`node examples/run.js`) reads — enumerated, not guessed", function () {
    for (const p of RUN_JS_FIXED_PATHS) {
      expect(shipped.has(p), `examples/run.js input MISSING from the tarball: ${p}`).to.equal(true);
    }
    // The committed sample trees ship COMPLETELY: run.js checks fileCount === 5 (dataset) and
    // === 3 (parcel), so one missing sample file breaks the demo for every npm installer.
    for (const dir of RUN_JS_SAMPLE_DIRS) {
      const onDisk = walk(dir);
      expect(onDisk.length, `committed sample tree ${dir} unexpectedly empty on disk`).to.be.greaterThan(0);
      for (const p of onDisk) {
        expect(shipped.has(p), `sample file MISSING from the tarball: ${p}`).to.equal(true);
      }
    }
  });

  it("ships the independent verifier tree README/ADOPT point recipients at", function () {
    for (const p of VERIFIER_ALLOWLIST) {
      expect(shipped.has(p), `verifier file MISSING from the tarball: ${p}`).to.equal(true);
    }
  });

  it("T-77.2: ships the 4-language suite — every Python/Go/Rust source + the frozen vectors", function () {
    for (const p of ALT_IMPL_ALLOWLIST) {
      expect(shipped.has(p), `alternate-implementation source MISSING from the tarball: ${p}`).to.equal(true);
    }
    // The vector CASES ship COMPLETELY (enumerated from disk, so the frozen tree cannot drift out
    // of the tarball) — except symlinks, which npm cannot carry (asserted separately below).
    const onDisk = walk("verify-vectors").filter(
      (p) => !fs.lstatSync(path.join(REPO, p)).isSymbolicLink()
    );
    expect(onDisk.length, "verify-vectors/ unexpectedly empty on disk").to.be.greaterThan(0);
    for (const p of onDisk) {
      expect(shipped.has(p), `frozen conformance-vector file MISSING from the tarball: ${p}`).to.equal(true);
    }
  });

  it("T-77.2: ships NO scratch-era harness with internal absolute paths (verifier-py/conformance.py)", function () {
    for (const p of ALT_IMPL_DENYLIST) {
      expect(shipped.has(p), `INTERNAL scratch harness LEAKED into the tarball: ${p}`).to.equal(false);
    }
  });

  it("T-77.2: the symlinked vector entry stays OUT of the pack (npm cannot ship symlinks — the documented `ln -s` restore covers it)", function () {
    // Sanity: the symlink really exists on disk (the in-repo vector suite is complete) …
    const abs = path.join(REPO, VECTOR_SYMLINK_TARBALL_PATH);
    expect(fs.lstatSync(abs).isSymbolicLink(), `${VECTOR_SYMLINK_TARBALL_PATH} must be a symlink on disk`).to.equal(true);
    // … and npm drops it. If this ever flips, re-decide DELIBERATELY: a symlink shipped as a plain
    // COPY would silently defeat the vector's lexical-vs-resolving point.
    expect(
      shipped.has(VECTOR_SYMLINK_TARBALL_PATH),
      `npm now packs the vector symlink (${VECTOR_SYMLINK_TARBALL_PATH}) — update docs/INDEPENDENT-VERIFICATION.md §6's restore note AND check it ships as a real symlink, not a copy`
    ).to.equal(false);
  });

  it("ships no repo-internal trees (test/, scripts/, site/, artifacts/, cache/, contracts/)", function () {
    for (const prefix of FORBIDDEN_ROOT_PREFIXES) {
      const leaked = [...shipped].filter((p) => p.startsWith(prefix));
      expect(leaked, `repo-internal tree leaked into the tarball: ${leaked.slice(0, 5).join(", ")}`)
        .to.have.length(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Part 2 — the REAL tarball: pack into an OS temp dir OUTSIDE the repo, extract, and run the
// documented quickstart from the EXTRACTED tree. No registry install, no network: js-sha3 (and, for
// the examples pipeline, ethers) resolve from THIS repo's node_modules via NODE_PATH.
// ---------------------------------------------------------------------------------------------------

describe("T-73.2 npm tarball: pack → extract OUTSIDE the repo → the documented quickstart runs", function () {
  this.timeout(180000);

  let tmpRoot; // OS temp dir (outside the repo) holding the tarball + extraction
  let pkgDir; // <tmpRoot>/package — the extracted tarball root

  // The extracted tree has no node_modules; the verifier's ONE bare dependency (js-sha3) — and ethers
  // for the examples pipeline — must resolve from the repo's node_modules via NODE_PATH.
  function extractedEnv() {
    return { ...process.env, NODE_PATH: path.join(REPO, "node_modules") };
  }

  before(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vh-npm-tarball-"));
    // The whole point is "works from an INSTALL, not a clone": the workspace must be OUTSIDE the repo.
    expect(
      (tmpRoot + path.sep).startsWith(REPO + path.sep),
      `temp workspace must live OUTSIDE the repo (got ${tmpRoot})`
    ).to.equal(false);

    // Pack FOR REAL (writes <name>-<version>.tgz into tmpRoot; still offline — it reads the worktree).
    const report = npmPack(["--pack-destination", tmpRoot]);
    const tarball = path.join(tmpRoot, report[0].filename.replace(/^.*\//, ""));
    expect(fs.existsSync(tarball), `npm pack did not write the tarball: ${tarball}`).to.equal(true);

    // Extract with the system tar (npm tarballs are plain gzipped tar with a "package/" root).
    const tar = spawnSync("tar", ["-xzf", tarball, "-C", tmpRoot], { encoding: "utf8" });
    expect(tar.status, `tar -xzf failed:\n${tar.stderr}`).to.equal(0);
    pkgDir = path.join(tmpRoot, "package");
    expect(fs.existsSync(path.join(pkgDir, "package.json")), "extraction produced no package/").to.equal(true);
  });

  after(function () {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("the REAL tarball also contains no internal-loop file (not just the dry-run's claim)", function () {
    for (const p of INTERNAL_DENYLIST_EXACT) {
      expect(fs.existsSync(path.join(pkgDir, p)), `INTERNAL FILE extracted from the tarball: ${p}`).to.equal(false);
    }
    // Same DE-DRIFT gate, against the REAL extracted tree: nothing site-release forbids may be present.
    for (const p of forbiddenDocsOnDisk()) {
      expect(fs.existsSync(path.join(pkgDir, p)), `INTERNAL doc extracted from the tarball (site-release forbids it): ${p}`).to.equal(false);
    }
    const docsDir = path.join(pkgDir, "docs");
    const audits = fs.readdirSync(docsDir).filter((f) => f.startsWith("LOOP-AUDIT-"));
    expect(audits, `LOOP-AUDIT snapshots extracted from the tarball: ${audits.join(", ")}`).to.have.length(0);
    // The rotating internal build-loop engine archive must not materialize on disk from an install.
    const archiveDir = path.join(docsDir, "engine-archive");
    const archived = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [];
    expect(archived, `docs/engine-archive/ extracted from the tarball (internal build-loop copies): ${archived.join(", ")}`).to.have.length(0);
    for (const p of USER_DOCS_ALLOWLIST) {
      expect(fs.existsSync(path.join(pkgDir, p)), `user-facing doc missing after extraction: ${p}`).to.equal(true);
    }
  });

  it("T-77.2: the 4-language suite really extracts, and carries NO internal-loop path (string-scanned, not just filename-listed)", function () {
    for (const p of ALT_IMPL_ALLOWLIST) {
      expect(fs.existsSync(path.join(pkgDir, p)), `alternate-implementation source missing after extraction: ${p}`).to.equal(true);
    }
    for (const p of ALT_IMPL_DENYLIST) {
      expect(fs.existsSync(path.join(pkgDir, p)), `INTERNAL scratch harness extracted from the tarball: ${p}`).to.equal(false);
    }
    // Filename gates catch a leaked FILE; this catches leaked CONTENT: no shipped byte of the new
    // trees may reference the loop's home or its key/license file locations (the exact strings the
    // excluded scratch harness contains — the class that once shipped in verifyhash@0.1.0).
    const FORBIDDEN_STRINGS = ["/home/loopdev", ".verifyhash-selflicense", ".verifyhash-vendor-key", ".verifyhash-deploy-key"];
    const scanRoots = ["verifier-py", "verifier-go", "verifier-rs", "verify-vectors"];
    for (const root of scanRoots) {
      const stack = [path.join(pkgDir, root)];
      while (stack.length) {
        const dir = stack.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(abs);
            continue;
          }
          const text = fs.readFileSync(abs, "utf8");
          for (const s of FORBIDDEN_STRINGS) {
            expect(
              text.includes(s),
              `INTERNAL-loop string "${s}" leaked into the shipped file ${path.relative(pkgDir, abs)}`
            ).to.equal(false);
          }
        }
      }
    }
  });

  it("T-77.2: the documented one-line symlink restore makes the extracted frozen vectors BYTE-COMPLETE (SHA256SUMS verifies in full)", function () {
    const vecDir = path.join(pkgDir, "verify-vectors");
    const aliasAbs = path.join(vecDir, "cases", "symlinked-artifact", "files", "alias.json");
    // npm dropped the symlink (pinned in Part 1); restore it EXACTLY as §6 documents:
    //   ln -s packet.vhevidence.json verify-vectors/cases/symlinked-artifact/files/alias.json
    expect(fs.existsSync(aliasAbs), "alias.json must be absent from the extracted tarball before the restore").to.equal(false);
    fs.symlinkSync("packet.vhevidence.json", aliasAbs);
    expect(fs.lstatSync(aliasAbs).isSymbolicLink()).to.equal(true);

    // Now EVERY line of the frozen SHA256SUMS must verify against the extracted bytes — the same
    // property `sha256sum -c SHA256SUMS` checks, computed here directly so the gate needs no
    // external binary. One missing or drifted byte in the shipped vector suite fails HERE.
    const crypto = require("crypto");
    const lines = fs
      .readFileSync(path.join(vecDir, "SHA256SUMS"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines.length, "SHA256SUMS unexpectedly empty").to.be.greaterThan(0);
    for (const line of lines) {
      const m = /^([0-9a-f]{64})[ *]+(.+)$/.exec(line.trim());
      expect(m, `unparseable SHA256SUMS line: ${line}`).to.not.equal(null);
      const [, want, rel] = m;
      const bytes = fs.readFileSync(path.join(vecDir, rel)); // follows the restored symlink
      const got = crypto.createHash("sha256").update(bytes).digest("hex");
      expect(got, `extracted vector file drifted from the frozen SHA256SUMS pin: ${rel}`).to.equal(want);
    }
  });

  it("T-77.2: the SECOND implementation runs from the EXTRACTED tree — Python ACCEPTs the genuine vector (0) and REJECTs the tampered one (3)", function () {
    // The pitch is "an npm installer GETS a working alternate implementation" — prove it on the
    // shipped frozen vectors with the shipped Python verifier, zero setup. Skip (visibly) only
    // when the machine has no python3 — same probe contract as test/conformance-multilang.test.js.
    const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      this.skip(); // no python3 on this machine — the Go/Rust/JS legs are covered elsewhere
      return;
    }
    const vecDir = path.join(pkgDir, "verify-vectors");
    const vendor = "0x7cb4d3dc6c52996b6386473bfb32f898263412f7"; // vectors.json issuerUnderTest (a PUBLIC address)
    const py = (caseName) =>
      spawnSync(
        "python3",
        [
          path.join(pkgDir, "verifier-py", "verify_vh.py"),
          `cases/${caseName}/packet.vhevidence.json`,
          "--vendor",
          vendor,
          "--dir",
          `cases/${caseName}/files`,
        ],
        { cwd: vecDir, encoding: "utf8", maxBuffer: MAX_BUF }
      );

    const good = py("genuine-single");
    expect(good.status, `python3 verify_vh.py (genuine) exited ${good.status}:\n${good.stdout}\n${good.stderr}`).to.equal(0);
    expect(good.stdout, "the genuine vector must ACCEPT").to.include("OK — the artifact verifies.");

    const bad = py("tampered-file");
    expect(bad.status, `python3 verify_vh.py (tampered) exited ${bad.status} (want 3):\n${bad.stdout}\n${bad.stderr}`).to.equal(3);
    expect(bad.stdout, "the tampered vector must REJECT, localized").to.include("REJECTED");
    expect(bad.stdout, "the REJECT must localize the tampered file").to.include("data/records.csv");
  });

  it("T-77.2: the shipped 4-way conformance harness PASSES from the EXTRACTED tree (post-restore) — exit 0, present impls agree", function () {
    this.timeout(300000);
    const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      this.skip(); // the harness itself is Python
      return;
    }
    // Prerequisite: the symlink-restore test above has run (mocha runs its in declaration order).
    const aliasAbs = path.join(pkgDir, "verify-vectors", "cases", "symlinked-artifact", "files", "alias.json");
    expect(fs.lstatSync(aliasAbs).isSymbolicLink(), "restore-symlink test must run first").to.equal(true);
    // The harness resolves the repo root from __file__, so from the extracted package it uses the
    // SHIPPED JS + Python verifiers (Go/Rust legs skip when no toolchain). js-sha3 for the JS leg
    // resolves from THIS repo's node_modules via NODE_PATH; node itself is pinned via VH_NODE_BIN.
    const res = spawnSync(
      "python3",
      [path.join(pkgDir, "verify-vectors", "conformance-4way.py")],
      {
        cwd: pkgDir,
        encoding: "utf8",
        maxBuffer: MAX_BUF,
        env: { ...extractedEnv(), VH_NODE_BIN: NODE },
      }
    );
    expect(
      res.status,
      `conformance-4way.py exited ${res.status} from the extracted tree:\n${res.stdout}\n${res.stderr}`
    ).to.equal(0);
    expect(res.stdout, "the harness must report an explicit PASS").to.include("VERDICT: PASS");
  });

  it("ADOPT quickstart from the EXTRACTED tree: `verify-vh demo` exits 0 — genuine ACCEPT, tampered REJECT", function () {
    // docs/ADOPT.md §1 / verifier/README.md §0z: the split-tree form of `npx --yes verify-vh demo`.
    const res = runNode(["verifier/verify-vh.js", "demo"], { cwd: pkgDir, env: extractedEnv() });
    expect(res.status, `demo exited ${res.status}:\n${res.stdout}\n${res.stderr}`).to.equal(0);

    // The GENUINE packet verifies and its signer is NAMED (recovered from the bytes, not echoed) …
    const acceptAt = res.stdout.indexOf("ACCEPT — the artifact verifies. signer: 0x");
    expect(acceptAt, `demo output lacks the genuine-ACCEPT verdict:\n${res.stdout}`).to.be.at.least(0);
    expect(res.stdout).to.match(/signer: 0x[0-9a-fA-F]{40}/);

    // … THEN the one-byte-tampered copy is REJECTED, localized to the changed file.
    const rejectAt = res.stdout.indexOf("REJECT (");
    expect(rejectAt, `demo output lacks the tampered-REJECT verdict:\n${res.stdout}`).to.be.greaterThan(acceptAt);
    expect(res.stdout, "the REJECT must localize the tampered file").to.include("CHANGED  model-card.md");
  });

  it("the REAL verify path from the EXTRACTED tree: genuine → exit 0 VERIFIED, one-byte tamper → exit 3 REJECTED", function () {
    // The documented `demo <dir>` scaffold: materialize the genuine signed packet somewhere we keep …
    const keepDir = path.join(tmpRoot, "vh-demo");
    const scaffold = runNode(["verifier/verify-vh.js", "demo", keepDir], { cwd: pkgDir, env: extractedEnv() });
    expect(scaffold.status, `demo <dir> exited ${scaffold.status}:\n${scaffold.stderr}`).to.equal(0);
    const packet = path.join(keepDir, "demo-packet.vhevidence.json");
    expect(fs.existsSync(packet), "demo <dir> did not write the packet").to.equal(true);

    // … pin the signer the demo genuinely RECOVERED (what a real counterparty pastes as --vendor) …
    const m = scaffold.stdout.match(/--vendor (0x[0-9a-fA-F]{40})/);
    expect(m, `scaffold output printed no --vendor command:\n${scaffold.stdout}`).to.not.equal(null);
    const vendor = m[1];

    // … genuine bytes: the REAL (non-canned) verify path VERIFIES them — exit 0.
    const good = runNode(["verifier/verify-vh.js", packet, "--vendor", vendor], {
      cwd: pkgDir,
      env: extractedEnv(),
    });
    expect(good.status, `genuine verify exited ${good.status}:\n${good.stdout}\n${good.stderr}`).to.equal(0);
    expect(good.stdout, "genuine packet must be verified").to.include("OK — the artifact verifies.");

    // … tamper ONE byte of a sealed file: the SAME command now REJECTS with exit 3, naming the file.
    fs.appendFileSync(path.join(keepDir, "model-card.md"), "X");
    const bad = runNode(["verifier/verify-vh.js", packet, "--vendor", vendor], {
      cwd: pkgDir,
      env: extractedEnv(),
    });
    expect(bad.status, `tampered verify exited ${bad.status} (want 3):\n${bad.stdout}`).to.equal(3);
    expect(bad.stdout, "tampered packet must be REJECTED").to.include("REJECTED (");
    expect(bad.stdout, "the REJECT must localize the tampered file").to.include("model-card.md");
  });

  it("README quickstart from the EXTRACTED tree: `node examples/run.js` passes end-to-end (exit 0)", function () {
    // Proves the installed package is SELF-CONTAINED for the front-page demo: every sample file and
    // cli module it reads came out of the tarball. Its own checks include a dataset/parcel MATCH on
    // genuine bytes and a caught MISMATCH on a one-byte tamper — all offline, artifacts to OUR temp.
    const outDir = path.join(tmpRoot, "example-out");
    const res = runNode(["examples/run.js"], {
      cwd: pkgDir,
      env: { ...extractedEnv(), VH_EXAMPLE_OUT: outDir },
    });
    expect(res.status, `examples/run.js exited ${res.status}:\n${res.stdout}\n${res.stderr}`).to.equal(0);
    expect(res.stdout).to.match(/RESULT: PASS — all \d+ pipeline checks passed\./);
    expect(res.stdout, "the demo must catch the deliberate tamper").to.include("TAMPER");
  });
});
