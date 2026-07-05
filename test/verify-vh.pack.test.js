"use strict";

// ---------------------------------------------------------------------------------------------------
// T-73.3 — verify-vh PUBLISH-READINESS GATE: the standalone front-door package must work from its OWN
// packed tarball, provisioned exactly the way a stranger's `npm install` / `npx --yes verify-vh` would
// provision it — BEFORE the human ever runs `npm publish` (docs/PUBLISH-VERIFY-VH.md).
//
// WHY THIS TEST EXISTS
//   docs/ADOPT.md's front-door line — `npx --yes verify-vh demo` — 404s until the human publishes the
//   `verify-vh` package from verifier/. Every in-repo test so far ran verifier/verify-vh.js from the
//   CLONE, where Node's upward node_modules walk quietly reaches the repo's own installed tree. That
//   masking is exactly how a published package breaks for the FIRST STRANGER while staying green for
//   us: a file missing from verifier/package.json `files`, or an undeclared dependency, is invisible
//   from a checkout. This suite removes the mask:
//
//     1. `npm pack` runs ON verifier/ (cwd = verifier/, the exact directory the human publishes from),
//        OFFLINE, writing the tarball into an fs.mkdtempSync dir OUTSIDE the repo tree, then extracts it.
//     2. NEGATIVE CONTROL — the extracted tree is first proven UNABLE to run at all (`Cannot find
//        module 'js-sha3'`): Node resolution genuinely cannot fall back to the repo (NODE_PATH is
//        scrubbed; no ancestor node_modules reaches it). Only then is the ONE declared dependency
//        (js-sha3) copied from the repo's node_modules into <extracted>/node_modules — a faithful
//        stand-in for `npm install` (js-sha3 itself declares zero dependencies, asserted below).
//     3. The documented quickstart then runs from the EXTRACTED TREE ALONE, cwd outside the repo:
//        `demo` → exit 0 with an ACCEPT transcript NAMING the recovered signer (the fixed TEST-ONLY
//        hardhat #1 address); `demo <dir>` → materialize the keepable packet; flip ONE byte of a
//        REFERENCED file (never the packet JSON); re-verify with --vendor <recovered signer> → exit 3
//        with a REJECT line naming the changed file.
//
//   Net effect: any file `demo`/verify needs that is missing from verifier/package.json `files`, and
//   any dependency beyond js-sha3, fails THIS suite instead of the first stranger's `npx` run.
//
// OFFLINE by construction: `npm pack` reads only the working tree (npm_config_offline forced on
// anyway); js-sha3 is copied from THIS repo's node_modules, never installed from a registry. No new
// dependency. Every write goes to the OS temp dir, cleaned in after().
// ---------------------------------------------------------------------------------------------------

const { expect } = require("chai");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const VERIFIER_DIR = path.join(REPO, "verifier");
const NODE = process.execPath;
const MAX_BUF = 64 * 1024 * 1024;

// The fixed TEST-ONLY demo signer (hardhat account #1 — published in verify-vh.js precisely so it can
// never be mistaken for a real key). The ACCEPT transcript must NAME it, recovered from the bytes.
const DEMO_SIGNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

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

// Child env for every run from the EXTRACTED tree: NODE_PATH is scrubbed so module resolution can
// NEVER silently fall back to the repo's node_modules (the negative control in before() proves the
// isolation actually holds — a green run here is meaningful only because the bare tree FAILS first).
function extractedEnv() {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return env;
}

function runNode(args, opts) {
  return spawnSync(NODE, args, { encoding: "utf8", maxBuffer: MAX_BUF, ...opts });
}

describe("T-73.3 verify-vh publish-readiness: `npm pack` verifier/ → the tarball works ALONE", function () {
  this.timeout(180000);

  let tmpRoot; // fs.mkdtempSync dir OUTSIDE the repo: tarball, extraction, and every scratch write
  let pkgDir; // <tmpRoot>/package — the extracted tarball root
  let script; // <pkgDir>/verify-vh.js — the bin the published package would expose as `verify-vh`

  before(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-vh-pack-"));
    // The whole point is "works for a stranger, not from our clone": the workspace must sit OUTSIDE
    // the repo tree, or Node's upward node_modules walk could silently resolve into the repo.
    expect(
      (tmpRoot + path.sep).startsWith(REPO + path.sep),
      `temp workspace must live OUTSIDE the repo (got ${tmpRoot})`
    ).to.equal(false);

    // (1) `npm pack` ON verifier/ — cwd is the EXACT directory docs/PUBLISH-VERIFY-VH.md has the
    //     human publish from, so this tarball is byte-for-byte what `npm publish` would upload.
    const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", tmpRoot], {
      cwd: VERIFIER_DIR,
      encoding: "utf8",
      maxBuffer: MAX_BUF,
      env: npmEnv(),
    });
    expect(packed.error, `npm pack failed to spawn: ${packed.error && packed.error.message}`).to.equal(undefined);
    expect(packed.status, `npm pack exited ${packed.status}:\n${packed.stderr}`).to.equal(0);
    // Slice defensively from the first JSON bracket so a stray notice line can never break parsing.
    const jsonStart = packed.stdout.indexOf("[");
    expect(jsonStart, `npm pack --json printed no JSON array:\n${packed.stdout.slice(0, 500)}`).to.be.at.least(0);
    const report = JSON.parse(packed.stdout.slice(jsonStart));
    expect(report, "npm pack --json must report exactly one package").to.have.length(1);
    expect(report[0].name, "the packed package must be the front-door `verify-vh`").to.equal("verify-vh");

    const tarball = path.join(tmpRoot, report[0].filename.replace(/^.*\//, ""));
    expect(fs.existsSync(tarball), `npm pack did not write the tarball: ${tarball}`).to.equal(true);

    // Extract with the system tar (npm tarballs are plain gzipped tar with a "package/" root).
    const tar = spawnSync("tar", ["-xzf", tarball, "-C", tmpRoot], { encoding: "utf8" });
    expect(tar.status, `tar -xzf failed:\n${tar.stderr}`).to.equal(0);
    pkgDir = path.join(tmpRoot, "package");
    script = path.join(pkgDir, "verify-vh.js");
    expect(fs.existsSync(path.join(pkgDir, "package.json")), "extraction produced no package/").to.equal(true);
    expect(fs.existsSync(script), "the tarball must ship verify-vh.js (the bin)").to.equal(true);

    // (2) NEGATIVE CONTROL — before its dependency is provided, the extracted tree must FAIL to run.
    //     This proves the workspace genuinely cannot resolve modules from the repo (no NODE_PATH, no
    //     ancestor node_modules): without it, every green run below could be a silent repo fallback.
    const bare = runNode([script, "demo"], { cwd: tmpRoot, env: extractedEnv() });
    expect(
      bare.status,
      `the un-provisioned extracted tree unexpectedly RAN — module isolation is broken, this suite ` +
        `proves nothing:\n${bare.stdout}\n${bare.stderr}`
    ).to.not.equal(0);
    expect(bare.stderr, "the bare tree must fail on the declared dependency").to.include("Cannot find module");
    expect(bare.stderr, "the missing module must be js-sha3 (the ONE declared dep)").to.include("js-sha3");

    // Provide that one dependency the way `npm install` would: copy js-sha3 from the repo's already-
    // installed node_modules into <extracted>/node_modules. Nothing else is provided — so any file
    // missing from verifier/package.json `files`, or any undeclared require, fails the tests below.
    fs.cpSync(path.join(REPO, "node_modules", "js-sha3"), path.join(pkgDir, "node_modules", "js-sha3"), {
      recursive: true,
    });
  });

  after(function () {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("the shipped manifest is install-complete: bin → verify-vh.js; js-sha3 is the ONLY dep and itself needs nothing", function () {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    // `npx --yes verify-vh demo` resolves the bin by THIS mapping — the front-door line depends on it.
    expect(pkg.bin, "package.json must expose the verify-vh bin").to.have.property("verify-vh", "verify-vh.js");
    // Copying js-sha3 alone is a faithful `npm install` ONLY while it is the sole declared dependency…
    expect(Object.keys(pkg.dependencies || {}), "verify-vh must declare exactly [js-sha3]").to.deep.equal([
      "js-sha3",
    ]);
    // …and while js-sha3 itself is leaf-level (zero transitive deps). Both pinned here so the suite's
    // provisioning step can never quietly under-model a real install.
    const dep = JSON.parse(fs.readFileSync(path.join(pkgDir, "node_modules", "js-sha3", "package.json"), "utf8"));
    expect(Object.keys(dep.dependencies || {}), "js-sha3 must have zero transitive dependencies").to.deep.equal([]);
  });

  it("`node <extracted>/verify-vh.js demo` (cwd outside the repo): exit 0, ACCEPT transcript NAMES the recovered signer", function () {
    const res = runNode([script, "demo"], { cwd: tmpRoot, env: extractedEnv() });
    expect(res.status, `demo exited ${res.status}:\n${res.stdout}\n${res.stderr}`).to.equal(0);

    // The genuine packet is ACCEPTED and the transcript NAMES the signer — recovered from the bytes
    // by the vendored secp256k1 path, not echoed from the fixture — as the exact TEST-ONLY address.
    const acceptLine = `ACCEPT — the artifact verifies. signer: ${DEMO_SIGNER}`;
    const acceptAt = res.stdout.indexOf(acceptLine);
    expect(acceptAt, `demo transcript lacks the ACCEPT line naming ${DEMO_SIGNER}:\n${res.stdout}`).to.be.at.least(0);

    // …and the same transcript then REJECTs the one-byte-tampered copy, localized to the file.
    const rejectAt = res.stdout.indexOf("REJECT (");
    expect(rejectAt, `demo transcript lacks the tampered-REJECT step:\n${res.stdout}`).to.be.greaterThan(acceptAt);
    expect(res.stdout, "the REJECT must localize the tampered file").to.include("CHANGED  model-card.md");
  });

  it("`demo <dir>` → flip ONE byte of a REFERENCED file → --vendor re-verify: exit 3, REJECT names the file", function () {
    // Materialize the keepable packet from the extracted tree (still cwd outside the repo).
    const keepDir = path.join(tmpRoot, "vh-demo");
    const scaffold = runNode([script, "demo", keepDir], { cwd: tmpRoot, env: extractedEnv() });
    expect(scaffold.status, `demo <dir> exited ${scaffold.status}:\n${scaffold.stdout}\n${scaffold.stderr}`).to.equal(0);

    const packet = path.join(keepDir, "demo-packet.vhevidence.json");
    const victim = path.join(keepDir, "weights.txt"); // a REFERENCED file — never the packet JSON
    expect(fs.existsSync(packet), "demo <dir> did not write the packet").to.equal(true);
    expect(fs.existsSync(victim), "demo <dir> did not write the referenced weights.txt").to.equal(true);

    // Pin the signer the scaffold genuinely RECOVERED from the bytes (what a counterparty pastes).
    const m = scaffold.stdout.match(/signer \(recovered from the bytes\): (0x[0-9a-fA-F]{40})/);
    expect(m, `scaffold transcript names no recovered signer:\n${scaffold.stdout}`).to.not.equal(null);
    const vendor = m[1];
    expect(vendor, "the recovered signer must be the fixed TEST-ONLY demo key").to.equal(DEMO_SIGNER);

    // Genuine bytes through the REAL (non-canned) verify path: exit 0, verified.
    const good = runNode([script, packet, "--vendor", vendor], { cwd: tmpRoot, env: extractedEnv() });
    expect(good.status, `genuine verify exited ${good.status}:\n${good.stdout}\n${good.stderr}`).to.equal(0);
    expect(good.stdout, "the genuine packet must verify").to.include("OK — the artifact verifies.");

    // Flip ONE byte of the referenced file — same length, exactly one byte differs — and prove both
    // halves of the claim: one byte changed in weights.txt, zero bytes changed in the packet JSON.
    const packetBefore = fs.readFileSync(packet);
    const original = fs.readFileSync(victim);
    const tampered = Buffer.from(original);
    tampered[0] ^= 0x01; // flip one bit → one changed byte, no length change
    fs.writeFileSync(victim, tampered);

    const now = fs.readFileSync(victim);
    expect(now.length, "the flip must not change the file length").to.equal(original.length);
    let diff = 0;
    for (let i = 0; i < now.length; i++) if (now[i] !== original[i]) diff++;
    expect(diff, "exactly ONE byte of the referenced file must differ").to.equal(1);
    expect(fs.readFileSync(packet).equals(packetBefore), "the packet JSON must be untouched").to.equal(true);

    // The SAME --vendor command now REJECTs with exit 3, and the REJECT line NAMES the changed file.
    const bad = runNode([script, packet, "--vendor", vendor], { cwd: tmpRoot, env: extractedEnv() });
    expect(bad.status, `tampered verify exited ${bad.status} (want 3):\n${bad.stdout}\n${bad.stderr}`).to.equal(3);
    expect(bad.stdout, "the verdict must be a REJECT").to.match(/REJECTED \(/);
    expect(bad.stdout, "the REJECT must name the changed file").to.match(/CHANGED\s+weights\.txt/);
    expect(bad.stdout, "a rejected run must not also claim OK").to.not.include("OK — the artifact verifies.");
  });

  // =================================================================================================
  // T-74.1 — CHANNEL-AWARE COPY-PASTE COMMANDS, proven the hard way: lay the packed tarball out exactly
  // as `npm install` would (node_modules/verify-vh + the node_modules/.bin/verify-vh shim), invoke the
  // demo THROUGH THE BIN with a real `npx --yes verify-vh demo` (resolved OFFLINE from the local .bin —
  // npx never needs the registry when the bin already exists), then EXECUTE every command line the demo
  // output prints, VERBATIM, in printed order: ACCEPT exit 0 → tamper → REJECT exit 3 → restore →
  // ACCEPT exit 0. A bin-invoked demo must never print `node verify-vh…`: the npx/global-install user
  // holds no such file, so that line is a crash at the moment of highest intent — the exact
  // cold-stranger failure the 2026-07-05 DX audit caught.
  // =================================================================================================
  describe("T-74.1 bin channel: bin-invoked demo prints npx-form commands and EVERY printed line runs verbatim", function () {
    let proj; // the npm-install-shaped project: <proj>/node_modules/{verify-vh/, .bin/verify-vh}
    let bareOut; // stdout of the bin-invoked bare demo (`npx --yes verify-vh demo`)
    let scaffoldOut; // stdout of the bare demo's own TRY IT line, executed verbatim (the `demo <dir>` transcript)

    // Env for bin-channel runs: repo-isolated like extractedEnv(), plus npm forced OFFLINE so a
    // regression could never make `npx` phone home (the bin must resolve from the LOCAL node_modules/.bin).
    function binEnv() {
      return {
        ...extractedEnv(),
        npm_config_offline: "true",
        npm_config_update_notifier: "false",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_loglevel: "error",
      };
    }

    // Execute ONE printed line VERBATIM — exactly as the user would: pasted into a POSIX shell in the
    // directory they ran the demo from. (Trailing `# …` annotations are ordinary shell comments.)
    function shVerbatim(line) {
      return spawnSync("sh", ["-c", line], { cwd: proj, encoding: "utf8", maxBuffer: MAX_BUF, env: binEnv() });
    }

    // The transcript's EXECUTABLE command lines, in printed order: the two-space-indented npx/printf
    // copy-paste surface, minus `<placeholder>` templates (instructions for later, not runnable now).
    function commandLines(transcript) {
      return transcript
        .split("\n")
        .filter((l) => /^ {2}(npx --yes verify-vh|printf )/.test(l) && !l.includes("<"));
    }

    before(function () {
      // Provision <proj> exactly as `npm install <tarball>` lays it out: the extracted package under
      // node_modules/verify-vh (its js-sha3 dep already provisioned inside by the outer before()), plus
      // the executable .bin shim npm creates for package.json's `"bin": {"verify-vh": "verify-vh.js"}`.
      proj = path.join(tmpRoot, "npx-proj");
      fs.mkdirSync(path.join(proj, "node_modules", ".bin"), { recursive: true });
      fs.cpSync(pkgDir, path.join(proj, "node_modules", "verify-vh"), { recursive: true });
      fs.chmodSync(path.join(proj, "node_modules", "verify-vh", "verify-vh.js"), 0o755);
      fs.symlinkSync(
        path.join("..", "verify-vh", "verify-vh.js"),
        path.join(proj, "node_modules", ".bin", "verify-vh")
      );

      // The BIN-INVOKED bare demo — a real `npx --yes verify-vh demo`, resolved offline from ./node_modules/.bin.
      const bare = spawnSync("npx", ["--yes", "verify-vh", "demo"], {
        cwd: proj,
        encoding: "utf8",
        maxBuffer: MAX_BUF,
        env: binEnv(),
      });
      expect(bare.error, `npx failed to spawn: ${bare.error && bare.error.message}`).to.equal(undefined);
      expect(bare.status, `bin-invoked demo exited ${bare.status}:\n${bare.stdout}\n${bare.stderr}`).to.equal(0);
      bareOut = bare.stdout;

      // The bare demo's ONE executable next step is the npx-form TRY IT line; run it VERBATIM to
      // materialize the keepable scaffold (./vh-demo under the project dir).
      const tryIt = commandLines(bareOut);
      expect(tryIt, `the bare demo must print exactly one executable next step:\n${bareOut}`).to.deep.equal([
        "  npx --yes verify-vh demo ./vh-demo",
      ]);
      const scaffold = shVerbatim(tryIt[0]);
      expect(
        scaffold.status,
        `the printed TRY IT line exited ${scaffold.status}:\n${scaffold.stdout}\n${scaffold.stderr}`
      ).to.equal(0);
      scaffoldOut = scaffold.stdout;
    });

    it("NO printed line contains `node verify-vh` when invoked via the bin (bare demo AND demo <dir>)", function () {
      for (const [name, out] of [["bare demo", bareOut], ["demo <dir>", scaffoldOut]]) {
        expect(out, `${name}: a bin-invoked transcript advised \`node verify-vh…\` — that file does not exist ` +
            `for an npx/global-install user:\n${out}`).to.not.include("node verify-vh");
        expect(out, `${name}: the self-command must be the npx form`).to.include("npx --yes verify-vh");
      }
    });

    it("the producer-side §0a pointer is a REACHABLE URL, not a local file the npx user does not have", function () {
      expect(scaffoldOut, "must link the hosted verifier README").to.include(
        "https://verifyhash.com/docs/verifier-README.md"
      );
      expect(scaffoldOut, "the dangling local-path pointer is gone").to.not.include("see verifier/README.md");
    });

    it("EVERY printed command line runs VERBATIM, in order: ACCEPT 0 → tamper → REJECT 3 → restore → ACCEPT 0", function () {
      const lines = commandLines(scaffoldOut);
      // Shape pin: verify / tamper / verify / restore / verify — exactly these, in exactly this order.
      expect(
        lines.map((l) => (/^ {2}npx --yes verify-vh /.test(l) ? "verify" : "printf")),
        `unexpected executable-line shape in the scaffold transcript:\n${scaffoldOut}`
      ).to.deep.equal(["verify", "printf", "verify", "printf", "verify"]);

      const card = path.join(proj, "vh-demo", "model-card.md");
      const originalBytes = fs.readFileSync(card);

      const expected = [0, 0, 3, 0, 0];
      const results = lines.map((l) => shVerbatim(l));
      results.forEach((r, i) => {
        expect(
          r.status,
          `printed line ${i + 1} exited ${r.status} (want ${expected[i]}): ${lines[i]}\n${r.stdout}\n${r.stderr}`
        ).to.equal(expected[i]);
      });

      // The verdicts behind those exit codes are the real ones: ACCEPT, then a REJECT NAMING the file,
      // then ACCEPT again — and the printed restore command restored the EXACT original bytes.
      expect(results[0].stdout, "genuine bytes must verify").to.include("OK — the artifact verifies.");
      expect(results[2].stdout, "the tampered copy must be REJECTED").to.match(/REJECTED \(/);
      expect(results[2].stdout, "the REJECT must name the changed file").to.match(/CHANGED\s+model-card\.md/);
      expect(results[4].stdout, "the restored bytes must verify again").to.include("OK — the artifact verifies.");
      expect(
        fs.readFileSync(card).equals(originalBytes),
        "the printed restore command must reproduce the original file byte-for-byte"
      ).to.equal(true);
    });
  });
});
