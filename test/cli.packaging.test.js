const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const Module = require("module");

// ---------------------------------------------------------------------------
// T-21.1 packaging-integrity gate (pure: no chain, no network, no fs side effects).
//
// `vh` must be a REAL installable command: `npm link` / `npm install -g .` has to
// produce a working `vh` on PATH, and a clean install (the `files` allowlist only,
// with ONLY `dependencies` present — no hardhat, no artifacts/) must RUN on-chain-free
// commands like `vh hash` and `vh dataset build` instead of CRASHING on a missing
// module.
//
// This file freezes that contract so it can never silently regress:
//   * bin.vh points at the shebanged, existing entrypoint;
//   * ethers + js-sha3 are REAL dependencies (not only devDependencies);
//   * hardhat/toolbox stay devDependencies (never shipped to a CLI consumer);
//   * a `files` allowlist exists, ships cli/, and excludes test/ + contracts/;
//   * engines.node is declared;
//   * EVERY bare-module require() in cli/*.js + cli/core/*.js is a declared
//     `dependencies` entry — so a future undeclared dependency fails the build.
//
// It reads files only; it spawns nothing and writes nothing.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(__dirname, "..");
const PKG_PATH = path.join(REPO_ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));

describe("T-21.1 packaging integrity: `vh` is a real installable, runnable package", function () {
  describe("bin entrypoint", function () {
    it("declares bin.vh pointing at an existing file", function () {
      expect(pkg.bin, "package.json must declare a `bin` map").to.be.an("object");
      expect(pkg.bin.vh, "package.json must declare bin.vh").to.be.a("string");

      const normalized = pkg.bin.vh.replace(/^\.\//, "");
      expect(normalized, "bin.vh should point at the cli entrypoint").to.equal("cli/vh.js");

      const binPath = path.join(REPO_ROOT, normalized);
      expect(fs.existsSync(binPath), `bin.vh target must exist: ${binPath}`).to.equal(true);
    });

    it("the bin entrypoint keeps its `#!/usr/bin/env node` shebang", function () {
      const binPath = path.join(REPO_ROOT, pkg.bin.vh.replace(/^\.\//, ""));
      const firstLine = fs.readFileSync(binPath, "utf8").split("\n", 1)[0];
      expect(firstLine, "cli/vh.js must start with a node shebang").to.equal("#!/usr/bin/env node");
    });

    it("the bin entrypoint is committed executable (mode +x)", function () {
      const binPath = path.join(REPO_ROOT, pkg.bin.vh.replace(/^\.\//, ""));
      const mode = fs.statSync(binPath).mode;
      // owner-execute bit must be set so a global install yields an executable `vh`.
      expect((mode & 0o100) !== 0, "cli/vh.js must be executable (chmod +x)").to.equal(true);
    });
  });

  describe("dependencies vs devDependencies", function () {
    const deps = pkg.dependencies || {};
    const devDeps = pkg.devDependencies || {};

    it("ethers is a REAL dependency (not only a devDependency)", function () {
      expect(deps.ethers, "ethers must be a declared runtime dependency").to.be.a("string");
    });

    it("js-sha3 is a REAL dependency (used by cli/hash.js)", function () {
      expect(deps["js-sha3"], "js-sha3 must be a declared runtime dependency").to.be.a("string");
    });

    it("the declared ethers range matches the installed major version", function () {
      // Confirm the pin tracks the major the code is actually written against.
      let installedMajor;
      try {
        installedMajor = require("ethers/package.json").version.split(".")[0];
      } catch (_e) {
        installedMajor = null;
      }
      if (installedMajor) {
        expect(
          deps.ethers,
          `declared ethers range "${deps.ethers}" should cover installed major ${installedMajor}`
        ).to.contain(installedMajor);
      }
    });

    it("hardhat and @nomicfoundation/hardhat-toolbox are NOT runtime dependencies", function () {
      expect(deps.hardhat, "hardhat must stay a devDependency").to.equal(undefined);
      expect(
        deps["@nomicfoundation/hardhat-toolbox"],
        "hardhat-toolbox must stay a devDependency"
      ).to.equal(undefined);
      // sanity: they really are declared as dev deps.
      expect(devDeps.hardhat, "hardhat should be a devDependency").to.be.a("string");
      expect(
        devDeps["@nomicfoundation/hardhat-toolbox"],
        "hardhat-toolbox should be a devDependency"
      ).to.be.a("string");
    });
  });

  describe("files allowlist", function () {
    it("declares a `files` allowlist that ships cli and excludes test/contracts", function () {
      expect(pkg.files, "package.json must declare a `files` allowlist").to.be.an("array");

      const shipsCli = pkg.files.some((f) => {
        const n = f.replace(/^\.\//, "");
        return n === "cli" || n === "cli/" || n === "cli/**" || n.startsWith("cli/**");
      });
      expect(shipsCli, `files must ship cli/ — got ${JSON.stringify(pkg.files)}`).to.equal(true);

      const includesForbidden = pkg.files.some((f) => {
        const n = f.replace(/^\.\//, "").replace(/\/$/, "");
        return n === "test" || n === "contracts" || n === "scripts";
      });
      expect(
        includesForbidden,
        `files must NOT ship test/contracts/scripts — got ${JSON.stringify(pkg.files)}`
      ).to.equal(false);
    });
  });

  describe("engines", function () {
    it("declares engines.node", function () {
      expect(pkg.engines, "package.json must declare `engines`").to.be.an("object");
      expect(pkg.engines.node, "engines.node must be declared").to.be.a("string");
    });
  });

  describe("test command is unchanged", function () {
    it('the `test` script stays `hardhat test`', function () {
      expect(pkg.scripts.test).to.equal("hardhat test");
    });
  });

  describe("every bare-module require is a declared dependency", function () {
    // Collect all `require("<spec>")` specifiers across the shipped CLI source.
    function cliSourceFiles() {
      const files = [];
      const cliDir = path.join(REPO_ROOT, "cli");
      const coreDir = path.join(cliDir, "core");
      for (const dir of [cliDir, coreDir]) {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith(".js")) files.push(path.join(dir, f));
        }
      }
      return files;
    }

    function bareRequiresIn(file) {
      const src = fs.readFileSync(file, "utf8");
      const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
      const bare = new Set();
      let m;
      while ((m = re.exec(src)) !== null) {
        const spec = m[1];
        // relative requires are local files, not packages.
        if (spec.startsWith(".") || spec.startsWith("/")) continue;
        // a bare module spec's package name is the first path segment
        // (or the scope + first segment for @scoped packages).
        const parts = spec.split("/");
        const name = spec.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
        bare.add(name);
      }
      return bare;
    }

    // node:18+ exposes Module.isBuiltin; fall back to builtinModules for safety.
    const isBuiltin =
      typeof Module.isBuiltin === "function"
        ? (name) => Module.isBuiltin(name)
        : (name) => Module.builtinModules.includes(name.replace(/^node:/, ""));

    it("each non-builtin bare require resolves to a `dependencies` entry", function () {
      const deps = pkg.dependencies || {};
      const offenders = [];
      const seen = new Set();

      for (const file of cliSourceFiles()) {
        for (const name of bareRequiresIn(file)) {
          if (isBuiltin(name)) continue;
          if (deps[name]) continue;
          seen.add(`${name} (in ${path.relative(REPO_ROOT, file)})`);
          offenders.push(name);
        }
      }

      expect(
        offenders,
        `undeclared runtime dependencies found: ${[...seen].join(", ")}`
      ).to.deep.equal([]);
    });

    it("sanity: ethers and js-sha3 are actually required by the CLI", function () {
      const all = new Set();
      for (const file of cliSourceFiles()) {
        for (const name of bareRequiresIn(file)) all.add(name);
      }
      expect(all.has("ethers"), "ethers should be required by the CLI").to.equal(true);
      expect(all.has("js-sha3"), "js-sha3 should be required by the CLI").to.equal(true);
    });
  });

  describe("every relative require reachable from bin resolves to a SHIPPED path", function () {
    // The bare-require gate above proves every PACKAGE the CLI imports is a declared
    // dependency. This gate proves the complementary half: every LOCAL (relative)
    // module the shipped `bin` transitively requires resolves to a file that the
    // `files` allowlist actually ships. Otherwise `npm install verifyhash && vh ...`
    // crashes with `Cannot find module '...'` on first use — the exact regression
    // that shipped when `trustledger/cli` was required from cli/vh.js but the
    // package did not include `trustledger/`. Walking from the real entrypoint makes
    // that class of defect impossible to reintroduce silently.

    // Resolve a relative require specifier from `fromFile` to an absolute file path,
    // trying the standard Node resolution order (exact, +.js, /index.js, +.json).
    function resolveRelative(fromFile, spec) {
      const base = path.resolve(path.dirname(fromFile), spec);
      const candidates = [
        base,
        `${base}.js`,
        path.join(base, "index.js"),
        `${base}.json`,
      ];
      for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      }
      return null;
    }

    // Every relative require specifier in a file.
    function relativeRequiresIn(file) {
      const src = fs.readFileSync(file, "utf8");
      const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
      const out = [];
      let m;
      while ((m = re.exec(src)) !== null) {
        const spec = m[1];
        if (spec.startsWith(".") || spec.startsWith("/")) out.push(spec);
      }
      return out;
    }

    // Is a repo-relative path covered by the `files` allowlist? An allowlist entry
    // that is a directory (ends in `/` or names an existing dir) covers everything
    // under it; otherwise it must match the file exactly.
    function isShipped(relPath, files) {
      const norm = relPath.split(path.sep).join("/");
      for (const raw of files) {
        const entry = raw.replace(/^\.\//, "");
        const asDir = entry.replace(/\/$/, "");
        // exact file match
        if (norm === asDir) return true;
        // directory prefix match (the allowlist ships the whole subtree)
        if (norm.startsWith(`${asDir}/`)) return true;
      }
      return false;
    }

    it("walks relative requires from cli/vh.js; every resolved file is in `files`", function () {
      const files = pkg.files || [];
      const entry = path.join(REPO_ROOT, pkg.bin.vh.replace(/^\.\//, ""));

      const visited = new Set();
      const queue = [entry];
      const unresolved = [];
      const notShipped = [];

      while (queue.length) {
        const file = queue.shift();
        if (visited.has(file)) continue;
        visited.add(file);

        const rel = path.relative(REPO_ROOT, file);
        // The entrypoint and every file it pulls in must itself be shipped.
        if (!isShipped(rel, files)) {
          notShipped.push(rel.split(path.sep).join("/"));
        }

        for (const spec of relativeRequiresIn(file)) {
          const resolved = resolveRelative(file, spec);
          if (!resolved) {
            unresolved.push(`${spec} (from ${rel})`);
            continue;
          }
          if (!visited.has(resolved)) queue.push(resolved);
        }
      }

      expect(
        unresolved,
        `relative require(s) that do not resolve to a file: ${unresolved.join(", ")}`
      ).to.deep.equal([]);

      expect(
        notShipped,
        "file(s) reachable from the shipped bin that the `files` allowlist does " +
          `NOT ship (npm install would crash on require): ${notShipped.join(", ")}`
      ).to.deep.equal([]);
    });

    it("sanity: the walk actually reaches the trustledger pipeline", function () {
      // Guard the gate itself — prove the walk crosses the cli/ -> trustledger/
      // boundary, so a future refactor that drops the require can't make this test
      // silently pass by reaching nothing.
      const entry = path.join(REPO_ROOT, pkg.bin.vh.replace(/^\.\//, ""));
      const visited = new Set();
      const queue = [entry];
      while (queue.length) {
        const file = queue.shift();
        if (visited.has(file)) continue;
        visited.add(file);
        for (const spec of relativeRequiresIn(file)) {
          const resolved = resolveRelative(file, spec);
          if (resolved && !visited.has(resolved)) queue.push(resolved);
        }
      }
      const reached = [...visited].map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/"));
      expect(
        reached.some((p) => p.startsWith("trustledger/")),
        "the require walk from cli/vh.js should reach trustledger/* modules"
      ).to.equal(true);
    });
  });

  describe("the shipped package is self-contained (no hardhat artifacts at runtime)", function () {
    it("the registry ABI loads from the bundled cli/abi copy, not artifacts/", function () {
      // The on-chain subcommands load the ABI via cli/core/registryArtifact.js, which
      // prefers the committed cli/abi/ copy. That bundled copy must exist and carry an
      // ABI array, so a clean install (no artifacts/) does not crash on require.
      const bundled = path.join(REPO_ROOT, "cli", "abi", "ContributionRegistry.json");
      expect(fs.existsSync(bundled), `bundled ABI must ship: ${bundled}`).to.equal(true);
      const json = JSON.parse(fs.readFileSync(bundled, "utf8"));
      expect(json.abi, "bundled ABI file must contain an `abi` array").to.be.an("array");
      expect(json.abi.length, "bundled ABI must be non-empty").to.be.greaterThan(0);

      // loading the resolver must succeed and yield the same ABI shape.
      const resolved = require("../cli/core/registryArtifact");
      expect(resolved.abi, "registryArtifact must expose an abi array").to.be.an("array");
    });

    it("the bundled ABI matches the freshly compiled hardhat artifact when present", function () {
      // In a dev checkout (after `hardhat compile`) the bundled copy must not drift from
      // the source of truth. In a clean install the artifact is absent and this is skipped.
      const artifactPath = path.join(
        REPO_ROOT,
        "artifacts",
        "contracts",
        "ContributionRegistry.sol",
        "ContributionRegistry.json"
      );
      if (!fs.existsSync(artifactPath)) {
        this.skip();
        return;
      }
      const bundled = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, "cli", "abi", "ContributionRegistry.json"), "utf8")
      );
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      expect(
        JSON.stringify(bundled.abi),
        "cli/abi/ContributionRegistry.json is STALE — re-export it from the hardhat artifact"
      ).to.equal(JSON.stringify(artifact.abi));
    });
  });
});
