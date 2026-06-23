const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-8.3 docs-rot guard for git-scoped, reproducible anchoring.
//
// Pure (no chain, no fixtures): asserts that README.md, docs/MERKLE-LEAVES.md, and docs/RECEIPTS.md
// keep documenting the `--git` scope the way the code (cli/git.js, cli/receipt.js, cli/vh.js) actually
// behaves, so the prose can't silently drift from the implementation shipped in T-8.1 / T-8.2:
//   * README's CLI block names `vh hash/anchor/verify --git [--ref]` and states plainly that the
//     git-scoped root anchors EXACTLY the git-tracked files at the commit (reproducible from a clone,
//     never `.git`/secrets/build output);
//   * docs/MERKLE-LEAVES.md carries the "git scope" note (same leaf formula, only the file SET differs);
//   * docs/RECEIPTS.md documents the `git` block ({ commit, scope }) as an UNTRUSTED hint;
//   * the caveats reuse the existing TRUST-BOUNDARIES wording so they stay consistent.
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// Tripwire imports: if the git helpers or the receipt schema knobs that back this feature are ever
// removed/renamed, this suite fails loudly instead of guarding docs for code that no longer exists.
const git = require("../cli/git");
const { SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS } = require("../cli/receipt");

describe("T-8.3 docs: README + MERKLE-LEAVES + RECEIPTS document git-scoped, reproducible anchoring", function () {
  const readme = read("README.md");
  const readmeLower = readme.toLowerCase();
  const merkle = read("docs/MERKLE-LEAVES.md");
  const merkleLower = merkle.toLowerCase();
  const receipts = read("docs/RECEIPTS.md");
  const receiptsLower = receipts.toLowerCase();

  it("the cli/git.js helpers this feature is built on still exist (tripwire)", function () {
    for (const fn of ["repoRoot", "resolveCommit", "listTrackedFiles", "gitProvenance"]) {
      expect(git[fn], `cli/git.js export ${fn}`).to.be.a("function");
    }
    // The git block first appears at schemaVersion 3; if the writer version regresses below it, the
    // RECEIPTS git-block prose would be describing an unreachable code path.
    expect(SCHEMA_VERSION).to.be.greaterThanOrEqual(3);
    expect(SUPPORTED_SCHEMA_VERSIONS).to.include(SCHEMA_VERSION);
  });

  describe("README CLI block documents `vh hash/anchor/verify --git [--ref]`", function () {
    // The fenced block that holds the command list (the same one the read-side guard keys off).
    const block = readme.split("```").find((b) => b.includes("vh hash") && b.includes("vh verify"));

    it("the CLI fenced block exists and advertises --git on hash/anchor/verify", function () {
      expect(block, "CLI fenced block").to.be.a("string");
      const hashLine = block.split("\n").find((l) => l.includes("vh hash"));
      const anchorLine = block.split("\n").find((l) => l.includes("vh anchor"));
      const verifyLine = block.split("\n").find((l) => l.includes("vh verify"));
      expect(hashLine, "vh hash line mentions --git").to.match(/--git/);
      expect(anchorLine, "vh anchor line mentions --git").to.match(/--git/);
      expect(verifyLine, "vh verify line mentions --git").to.match(/--git/);
    });

    it("documents the optional --ref selector for --git", function () {
      // --ref selects which commit's tracked set; it is only meaningful with --git (parser enforces it).
      expect(readme).to.match(/--ref/);
      expect(readmeLower).to.match(/--ref[\s\S]{0,80}(default\s+head|head)/);
    });

    it("states plainly that --git anchors EXACTLY the files git tracks at the commit", function () {
      expect(readmeLower).to.match(/exactly[\s\S]{0,60}git tracks|files git tracks/);
      expect(readmeLower).to.include("commit");
    });

    it("states the git-scoped root is reproducible from a clone", function () {
      expect(readmeLower).to.match(/reproducib/);
      expect(readmeLower).to.match(/clone/);
    });

    it("states it never includes .git / secrets / build output", function () {
      // The privacy + determinism promise: the exclusions are explicit, not implied.
      expect(readme).to.include(".git");
      expect(readmeLower).to.match(/secret|\.env/);
      expect(readmeLower).to.match(/build (artifact|output)|node_modules/);
      // And that the exclusion is phrased as a hard "never includes ... untracked".
      expect(readmeLower).to.match(/never[\s\S]{0,80}(include|untracked)|untracked/);
    });
  });

  describe("docs/MERKLE-LEAVES.md carries the git-scope note (same leaf formula, different file SET)", function () {
    it("mentions --git and git-tracked enumeration", function () {
      expect(merkle).to.include("--git");
      expect(merkleLower).to.match(/files git tracks|git tracks/);
    });

    it("states the leaf/tree formula is UNCHANGED — only the file SET differs", function () {
      // The crux of T-8.3: --git reuses the exact pathLeaf/leaf/node convention; nothing about the
      // hashing changed, so the existing MERKLE-LEAVES spec still fully applies.
      expect(merkleLower).to.match(/unchanged|same.{0,40}(convention|formula|machinery)/);
      expect(merkleLower).to.match(/file set|set\b/);
      // It must still name the shared leaf machinery so the "unchanged formula" claim is concrete.
      expect(merkle).to.match(/pathLeaf|DIR_LEAF_DOMAIN|leafHash|nodeHash/);
    });

    it("states the --git root is reproducible across clones / ignores untracked files", function () {
      expect(merkleLower).to.match(/reproducib/);
      expect(merkleLower).to.match(/untracked/);
    });
  });

  describe("docs/RECEIPTS.md documents the `git` block ({ commit, scope }) as an UNTRUSTED hint", function () {
    it("documents the git block and both of its fields", function () {
      expect(receipts).to.include("git");
      expect(receipts).to.include("commit");
      expect(receipts).to.include("scope");
    });

    it("marks the git block as an untrusted hint, consistent with TRUST-BOUNDARIES", function () {
      expect(receiptsLower).to.include("untrusted");
      // The git block must not be sold as proof: the chain attests only to contentHash, and the
      // git.commit is never re-checked against the chain.
      expect(receiptsLower).to.match(/never re-?check|not.{0,40}re-?check|chain attests only/);
      expect(receipts).to.include("contentHash");
    });

    it("ties the git block to the same git-tracked, reproducible enumeration", function () {
      expect(receipts).to.include("--git");
      expect(receiptsLower).to.match(/files git tracks|git tracks|reproducib/);
    });

    it("documents that the git block first appears at the schema version that introduced it", function () {
      // The schema-version gate (v3) must be documented so an older receipt reader isn't surprised.
      expect(receipts).to.include(String(SCHEMA_VERSION));
    });
  });

  describe("cross-doc consistency", function () {
    it("all three docs reuse the TRUST-BOUNDARIES caveat by linking to it", function () {
      for (const [name, doc] of [
        ["README", readme],
        ["MERKLE-LEAVES", merkle],
        ["RECEIPTS", receipts],
      ]) {
        expect(doc, `${name} links TRUST-BOUNDARIES`).to.include("TRUST-BOUNDARIES.md");
      }
    });

    it("README cross-links the git-scope section to MERKLE-LEAVES and RECEIPTS", function () {
      expect(readme).to.include("docs/MERKLE-LEAVES.md");
      expect(readme).to.include("docs/RECEIPTS.md");
    });
  });
});
