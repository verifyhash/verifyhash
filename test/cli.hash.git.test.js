const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const git = require("../cli/git");
const { hashGit, hashDir, hashEntries, hashBytes, pathLeaf } = require("../cli/hash");
const { parseHashArgs, cmdHash } = require("../cli/vh");

// --------------------------------------------------------------------------------------------------
// Helpers: build throwaway git repos in a temp dir, fully isolated from the host's global git config
// (so the suite is deterministic on any machine / CI). We pass identity + an empty config via -c so
// `git commit` never depends on a user.name/email being set.
// --------------------------------------------------------------------------------------------------

const GIT_ID = [
  "-c", "user.name=verifyhash-test",
  "-c", "user.email=test@verifyhash.invalid",
  "-c", "commit.gpgsign=false",
  "-c", "init.defaultBranch=main",
];

function runGit(cwd, args) {
  return execFileSync("git", [...GIT_ID, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// Run a synchronous CLI dispatcher (cmdHash) with BOTH process.stdout and process.stderr captured
// into buffers, restoring them in `finally` even if the call throws. cmdHash writes the usage block,
// `error:` lines, and a Merkle root + per-file leaves straight to the real streams; without this the
// suite would spew that output mid-run. Mirrors the convention in test/cli.show.test.js (save the
// original write, swap in a capture, restore in finally). Returns { code, stdout, stderr }.
function captureCmd(fn) {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = (s) => {
    stdout += s;
    return true;
  };
  process.stderr.write = (s) => {
    stderr += s;
    return true;
  };
  let code;
  try {
    code = fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { code, stdout, stderr };
}

describe("cli: vh hash --git (git-scoped enumeration)", function () {
  async function deploy() {
    const Factory = await ethers.getContractFactory("ContributionRegistry");
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    return { registry };
  }

  let tmpDirs = [];
  function tmp(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  }
  // A git repo with `files` committed. Returns the repo root (absolute, real path so macOS /tmp ->
  // /private/tmp symlinks don't break path comparisons against git rev-parse --show-toplevel).
  function makeRepo(prefix, files) {
    const dir = fs.realpathSync(tmp(prefix));
    runGit(dir, ["init", "-q"]);
    for (const [rel, content] of Object.entries(files)) writeFile(dir, rel, content);
    runGit(dir, ["add", "-A"]);
    runGit(dir, ["commit", "-q", "-m", "initial"]);
    return dir;
  }
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  const KNOWN = {
    "README.md": "# project\n",
    "src/index.js": "module.exports = 42;\n",
    "src/util/helper.js": "exports.h = () => 1;\n",
    "package.json": '{"name":"x"}\n',
  };

  // ------------------------------------------------------------------------------------------------
  // cli/git.js — round-trip unit tests against real temp repos.
  // ------------------------------------------------------------------------------------------------
  describe("cli/git.js helpers", function () {
    it("repoRoot resolves the top-level even from a nested subdirectory", function () {
      const dir = makeRepo("vh-git-root-", KNOWN);
      expect(git.repoRoot(dir)).to.equal(dir);
      // From a nested subdir, it still resolves to the repo top-level.
      expect(git.repoRoot(path.join(dir, "src", "util"))).to.equal(dir);
    });

    it("repoRoot errors clearly on a non-git directory (no silent success)", function () {
      const notRepo = tmp("vh-git-notrepo-");
      expect(() => git.repoRoot(notRepo)).to.throw(/not a git repos|not a git work tree/i);
    });

    it("resolveCommit returns a full 40-hex oid for HEAD and is stable", function () {
      const dir = makeRepo("vh-git-commit-", KNOWN);
      const oid = git.resolveCommit(dir, "HEAD");
      expect(oid).to.match(/^[0-9a-f]{40}$/);
      // Default ref is HEAD.
      expect(git.resolveCommit(dir)).to.equal(oid);
      // A short oid prefix resolves to the same full oid.
      expect(git.resolveCommit(dir, oid.slice(0, 8))).to.equal(oid);
      // The branch name resolves to the same commit.
      const branch = runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      expect(git.resolveCommit(dir, branch)).to.equal(oid);
    });

    it("resolveCommit errors clearly on an unknown ref", function () {
      const dir = makeRepo("vh-git-badref-", KNOWN);
      expect(() => git.resolveCommit(dir, "no-such-ref-xyz")).to.throw(/unknown git ref/i);
      // A ref-looking value that still doesn't exist (and one with a leading dash) also errors, not
      // mis-parsed as a flag (we pass --end-of-options).
      expect(() => git.resolveCommit(dir, "-deadbeef")).to.throw(/unknown git ref/i);
    });

    it("listTrackedFiles returns the sorted repo-relative POSIX paths, nested files included", function () {
      const dir = makeRepo("vh-git-list-", KNOWN);
      const files = git.listTrackedFiles(dir, "HEAD");
      expect(files).to.deep.equal(
        ["README.md", "package.json", "src/index.js", "src/util/helper.js"]
      );
      // Sorted ascending and POSIX-slashed.
      expect(files).to.deep.equal(files.slice().sort());
      for (const f of files) expect(f).to.not.include("\\");
    });

    it("listTrackedFiles ignores untracked files in the work tree", function () {
      const dir = makeRepo("vh-git-untracked-", KNOWN);
      // Drop untracked junk into the work tree AFTER the commit.
      writeFile(dir, "node_modules/dep/index.js", "junk");
      writeFile(dir, ".env", "SECRET=1");
      writeFile(dir, "scratch.tmp", "scratch");
      const files = git.listTrackedFiles(dir, "HEAD");
      expect(files).to.deep.equal(
        ["README.md", "package.json", "src/index.js", "src/util/helper.js"]
      );
    });

    it("listTrackedFiles handles paths with special characters deterministically (-z, not quoted)", function () {
      // A path containing a space and a unicode char would be C-quoted by git's default output; with
      // -z it comes back verbatim. This pins that the helper reads NUL-delimited output.
      const dir = makeRepo("vh-git-special-", {
        "normal.txt": "n",
        "a file with spaces.txt": "s",
        "weird-é-ünïcode.txt": "u",
      });
      const files = git.listTrackedFiles(dir, "HEAD");
      expect(files).to.include("a file with spaces.txt");
      expect(files).to.include("weird-é-ünïcode.txt");
      // No surrounding double-quotes (the tell-tale of git's default C-quoting of unusual paths).
      for (const f of files) expect(f.startsWith('"')).to.equal(false);
    });

    it("listTrackedFiles errors on an unknown ref (propagates resolveCommit's error)", function () {
      const dir = makeRepo("vh-git-list-badref-", KNOWN);
      expect(() => git.listTrackedFiles(dir, "nope")).to.throw(/unknown git ref/i);
    });

    it("runGit passes argv as literal elements — a ref with shell metacharacters cannot inject", function () {
      const dir = makeRepo("vh-git-inject-", KNOWN);
      // If this were built into a shell string, `; touch PWNED` would create a file. It must instead
      // be treated as one literal (nonexistent) ref and error.
      expect(() => git.resolveCommit(dir, "HEAD; touch PWNED")).to.throw(/unknown git ref/i);
      expect(fs.existsSync(path.join(dir, "PWNED"))).to.equal(false);
      // Same for command substitution.
      expect(() => git.resolveCommit(dir, "$(touch PWNED2)")).to.throw(/unknown git ref/i);
      expect(fs.existsSync(path.join(dir, "PWNED2"))).to.equal(false);
    });
  });

  // ------------------------------------------------------------------------------------------------
  // hashGit reuses the EXACT Merkle convention — proven by equality to a manual hashEntries/hashDir
  // over just-the-tracked-files, and by on-chain verifyLeaf accepting every per-file proof.
  // ------------------------------------------------------------------------------------------------
  describe("hashGit reuses the existing dir-hash Merkle convention", function () {
    it("--git root EQUALS a manual hash of just-the-tracked-files via hashEntries", function () {
      const dir = makeRepo("vh-git-equiv-", KNOWN);
      // Add untracked junk so a naive filesystem walk would diverge.
      writeFile(dir, "node_modules/x.js", "junk");
      writeFile(dir, ".env", "SECRET");

      const got = hashGit(dir, {});

      // Manually reconstruct the entry list from ONLY the tracked paths and feed the shared core.
      const tracked = git.listTrackedFiles(dir, "HEAD");
      const manual = hashEntries(
        tracked.map((rel) => ({ path: rel, content: fs.readFileSync(path.join(dir, rel)) }))
      );
      expect(got.root).to.equal(manual.root);
      // And each leaf is the path-bound leaf = pathLeaf(relPath, keccak256(bytes)) — the same
      // convention as hashDir, NOT a new scheme.
      for (const { path: p, leaf, contentHash } of got.leaves) {
        const c = hashBytes(fs.readFileSync(path.join(dir, p)));
        expect(contentHash).to.equal(c);
        expect(leaf).to.equal(pathLeaf(p, c));
      }
    });

    it("every per-file proof from --git verifies on-chain against the --git root", async function () {
      const { registry } = await loadFixture(deploy);
      const dir = makeRepo("vh-git-onchain-", KNOWN);
      writeFile(dir, "node_modules/x.js", "junk"); // untracked; must not affect the proofs

      const { root, leaves, proofFor } = hashGit(dir, {});
      expect(leaves.length).to.equal(4);
      for (const { path: p, leaf } of leaves) {
        expect(await registry.verifyLeaf(root, leaf, proofFor(p))).to.equal(
          true,
          `proof for ${p} should verify on-chain`
        );
      }
    });

    it("exposes the resolved commit oid alongside the root", function () {
      const dir = makeRepo("vh-git-commitfield-", KNOWN);
      const res = hashGit(dir, {});
      expect(res.commit).to.equal(git.resolveCommit(dir, "HEAD"));
    });
  });

  // ------------------------------------------------------------------------------------------------
  // THE reproducibility criterion: --git root is unchanged by untracked junk AND byte-identical to a
  // fresh checkout, whereas the plain (non-git) root DIFFERS because it includes the junk.
  // ------------------------------------------------------------------------------------------------
  describe("reproducibility: --git ignores untracked junk; plain walk does not", function () {
    it("--git root is unchanged by junk and equals a second fresh checkout; plain root differs", function () {
      const dir = makeRepo("vh-git-repro-", KNOWN);

      // Baseline --git root and plain (filesystem) root of the clean tree.
      const gitRootClean = hashGit(dir, {}).root;
      const plainRootClean = hashDir(dir).root;

      // Drop the exact untracked junk the acceptance calls for into the work tree.
      writeFile(dir, "node_modules/x", "a dependency we don't track");
      writeFile(dir, ".env", "PRIVATE_KEY=0xdeadbeef");
      writeFile(dir, "scratch-unstaged.txt", "work in progress, never added");

      const gitRootDirty = hashGit(dir, {}).root;
      const plainRootDirty = hashDir(dir).root;

      // (1) --git root is UNCHANGED by the untracked junk.
      expect(gitRootDirty).to.equal(gitRootClean);
      // (2) The plain filesystem walk DOES change — it swept in the junk.
      expect(plainRootDirty).to.not.equal(plainRootClean);

      // (3) Byte-identical to a SECOND fresh checkout of the same commit (a real `git clone`-style
      //     reproduction), proving the root is content-addressed to the tracked set, not the machine.
      const fresh = fs.realpathSync(tmp("vh-git-fresh-"));
      runGit(fresh, ["clone", "-q", dir, "."]);
      const gitRootFresh = hashGit(fresh, {}).root;
      expect(gitRootFresh).to.equal(gitRootClean);

      // Sanity: the fresh checkout's --git tracked set is exactly the KNOWN files (no junk leaked
      // across, and the .git internals a plain walk would sweep in are excluded) — i.e. --git on the
      // dirty repo reproduced exactly the clean tracked content.
      const freshPaths = hashGit(fresh, {}).leaves.map((l) => l.path).sort();
      expect(freshPaths).to.deep.equal(Object.keys(KNOWN).sort());
    });

    it("RENAMING a tracked file changes the --git root (path-bound leaves)", function () {
      const dir = makeRepo("vh-git-rename-", KNOWN);
      const before = hashGit(dir, {}).root;

      // Rename a tracked file (same bytes, new path) and commit it.
      runGit(dir, ["mv", "src/index.js", "src/main.js"]);
      runGit(dir, ["commit", "-q", "-m", "rename index -> main"]);

      const after = hashGit(dir, {}).root;
      expect(after).to.not.equal(before);
    });

    it("--ref hashes the tracked set AT THAT COMMIT, independent of later commits / work tree", function () {
      const dir = makeRepo("vh-git-ref-", KNOWN);
      const firstCommit = git.resolveCommit(dir, "HEAD");
      const rootAtFirst = hashGit(dir, {}).root;

      // Add a new tracked file in a second commit; HEAD's tracked set now differs.
      writeFile(dir, "NEW.md", "added later\n");
      runGit(dir, ["add", "-A"]);
      runGit(dir, ["commit", "-q", "-m", "add NEW.md"]);

      const rootAtHead = hashGit(dir, {}).root;
      expect(rootAtHead).to.not.equal(rootAtFirst);

      // Re-hashing at the FIRST commit reproduces the original root (the new file isn't in that tree),
      // even though it now sits in the work tree.
      expect(hashGit(dir, { ref: firstCommit }).root).to.equal(rootAtFirst);
    });
  });

  // ------------------------------------------------------------------------------------------------
  // Failure modes: explicit, no silent fallback.
  // ------------------------------------------------------------------------------------------------
  describe("failure modes are explicit (no silent fallback to the filesystem walk)", function () {
    it("--git on a non-git directory errors (does NOT walk the filesystem)", function () {
      const notRepo = tmp("vh-git-nonrepo-");
      writeFile(notRepo, "a.txt", "content"); // a plain hashDir WOULD succeed here
      expect(() => hashGit(notRepo, {})).to.throw(/not a git repos|not a git work tree/i);
    });

    it("--git with an unknown --ref errors", function () {
      const dir = makeRepo("vh-git-unknownref-", KNOWN);
      expect(() => hashGit(dir, { ref: "no-such-ref" })).to.throw(/unknown git ref/i);
    });

    it("--git on a repo with ZERO tracked files errors with an actionable message", function () {
      const dir = fs.realpathSync(tmp("vh-git-empty-"));
      runGit(dir, ["init", "-q"]);
      // Make an empty commit so HEAD exists but tracks nothing.
      runGit(dir, ["commit", "-q", "--allow-empty", "-m", "empty"]);
      expect(() => hashGit(dir, {})).to.throw(/zero files|cannot build a directory root from zero/i);
    });
  });

  // ------------------------------------------------------------------------------------------------
  // Parser parity: --ref without --git is a flag error; usage-grade exit codes match other commands.
  // ------------------------------------------------------------------------------------------------
  describe("parseHashArgs / cmdHash flag handling", function () {
    it("parses <path> --git --ref", function () {
      expect(parseHashArgs(["./x", "--git"])).to.deep.equal({ path: "./x", git: true, ref: undefined });
      expect(parseHashArgs(["./x", "--git", "--ref", "abc"])).to.deep.equal({
        path: "./x",
        git: true,
        ref: "abc",
      });
    });

    it("--ref without --git is a flag error (parser parity)", function () {
      expect(() => parseHashArgs(["./x", "--ref", "HEAD"])).to.throw(/--ref requires --git/i);
    });

    it("rejects unknown flags, a missing --ref value, and a duplicate path", function () {
      expect(() => parseHashArgs(["./x", "--bogus"])).to.throw(/unknown flag/i);
      expect(() => parseHashArgs(["./x", "--git", "--ref"])).to.throw(/--ref requires a value/i);
      expect(() => parseHashArgs(["./x", "./y"])).to.throw(/unexpected extra argument/i);
    });

    it("cmdHash exits 2 on a flag error (e.g. --ref without --git) and 0 on a successful --git run", function () {
      // Flag error -> usage-grade exit 2. Capture the streams so the usage block isn't spewed to the
      // test console; assert the error AND usage went to stderr (not stdout).
      const { code, stdout, stderr } = captureCmd(() => cmdHash(["./x", "--ref", "HEAD"]));
      expect(code).to.equal(2);
      expect(stderr).to.match(/--ref requires --git/i);
      expect(stderr).to.match(/Usage:/);
      expect(stdout).to.equal("");
    });

    it("cmdHash exits 1 (not a crash, not 0) on --git in a non-git directory", function () {
      const notRepo = tmp("vh-git-cmd-nonrepo-");
      writeFile(notRepo, "a.txt", "x");
      // Capture so the `error: not a git repository...` line isn't spewed to the test console.
      const { code, stdout, stderr } = captureCmd(() => cmdHash([notRepo, "--git"]));
      expect(code).to.equal(1);
      // The error explains it's not a git repo and goes to stderr only (no silent fallback to a walk).
      expect(stderr).to.match(/not a git repos|not a git work tree/i);
      expect(stdout).to.equal("");
    });

    it("cmdHash returns 0 for a valid --git run and surfaces the resolved commit oid", function () {
      const dir = makeRepo("vh-git-cmd-ok-", KNOWN);
      // Capture so the Merkle root + per-file leaf lines aren't spewed to the test console.
      const { code, stdout, stderr } = captureCmd(() => cmdHash([dir, "--git"]));
      expect(code).to.equal(0);
      expect(stderr).to.equal("");

      // The human shape: root on line 1, then a `# commit <oid>` comment (REWORK 2 — the snapshot is
      // self-describing), then the per-file `<leaf>  <path>` body.
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      const expected = hashGit(dir, {});
      expect(lines[0]).to.equal(expected.root);
      expect(lines[1]).to.equal(`# commit ${expected.commit}`);
      expect(expected.commit).to.match(/^[0-9a-f]{40}$/);
      // The commit line carries the SAME oid resolveCommit returns for HEAD.
      expect(expected.commit).to.equal(git.resolveCommit(dir, "HEAD"));
      // The remaining lines are the per-file leaves (one per tracked file), `<leaf>  <path>`.
      const body = lines.slice(2);
      expect(body.length).to.equal(expected.leaves.length);
      for (const ln of body) expect(ln).to.match(/^0x[0-9a-f]{64} {2}\S/);
    });
  });

  // ------------------------------------------------------------------------------------------------
  // No regression to the existing (non-git) hash behaviour.
  // ------------------------------------------------------------------------------------------------
  describe("no regression: plain hashDir still walks the filesystem", function () {
    it("plain hashDir includes files git would not track", function () {
      const dir = makeRepo("vh-git-noregress-", KNOWN);
      writeFile(dir, "untracked.txt", "swept in by the plain walk");
      const plain = hashDir(dir);
      const paths = plain.leaves.map((l) => l.path);
      expect(paths).to.include("untracked.txt");
      // ...while --git does not.
      const gitPaths = hashGit(dir, {}).leaves.map((l) => l.path);
      expect(gitPaths).to.not.include("untracked.txt");
    });
  });
});
