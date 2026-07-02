"use strict";

// test/site-release.test.js — acceptance suite for the DETERMINISTIC SITE-RELEASE assembler (T-67.1).
//
// WHAT THIS PROVES (mapped to the task's acceptance clauses)
//   (1) DETERMINISM + --check: two assemblies of the same tree are BYTE-IDENTICAL; `--check` is GREEN on
//       the committed tree, and RED — NAMING the file — when a staged file is tampered, when a source
//       drifts from the committed site/RELEASE-MANIFEST.json, or when a NON-allowlisted file appears in
//       public/. `--check` writes nothing.
//   (2) BYTE-EQUALITY: the assembled bundle bytes EQUAL the committed verifier/dist bytes, and EVERY
//       published doc EQUALS its committed source byte-for-byte (incl. the renames).
//   (3) STRUCTURAL EXCLUSION: the forbidden set can NEVER appear — no `.git*`, no
//       docs/DEPLOY-PUBLIC-SITE.md, no docs/USAGE-BUDGET.json, no docs/METRICS.jsonl, no key/env-shaped
//       file; an allowlist violation is a NAMED failure, and the real committed allowlist is clean.
//   (4) site/DEPLOYED.json exists, is schema-valid, and was captured from the PRE-regeneration staging
//       bytes (its verifier hash is the OLD published d4af1f53…, not today's committed dist).
//   (5) docs/DEPLOY-PUBLIC-SITE.md's upload step now says: run `node scripts/site-release.js`, upload
//       `public/`, verify against `RELEASE-MANIFEST.json` — and the safety rules were NOT relaxed.
//   (6) LANDING-PAGE CROSS-ASSERTION: the committed site/index.html advertises the SAME sha256 as the
//       shipped verify-vh-standalone.js AND its .sha256 sidecar; a producer-side bundle change not
//       mirrored on the page FAILS the gate (release() throws, --check goes RED naming LANDING PAGE
//       DRIFT) instead of publishing a webroot that fails its own "compare the hash yourself" check.
//
// POSTURE: no network, no keys; the only child processes are `node scripts/site-release.js` itself.
// RED-case surgery happens in throwaway FAKE repos under the OS temp dir (removed in after()); the one
// real-tree tamper test restores the webroot by re-running the assembler in a finally-style after().

const { expect } = require("chai");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "site-release.js");
const sr = require("../scripts/site-release.js");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function runCli(args) {
  const res = spawnSync(process.execPath, [SCRIPT].concat(args || []), { encoding: "utf8", cwd: REPO });
  return { status: res.status === null ? 1 : res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function walk(dir, prefix, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(abs).isDirectory()) walk(abs, rel, out);
    else out.push(rel);
  }
  return out;
}

// The EXACT publish set (sorted, as the manifest orders it). Changing what the site serves must be a
// deliberate edit here + in site/publish-set.json — never a silent addition.
const EXPECTED_PUBLISHED = [
  "LICENSE",
  "NOTICE",
  "build-provenance.json",
  "docs/ADOPT.md",
  "docs/CONFORMANCE.md",
  "docs/DATALEDGER.md",
  "docs/DECIDE.md",
  "docs/EVIDENCE.md",
  "docs/IDENTITY.md",
  "docs/INDEPENDENT-VERIFICATION.md",
  "docs/KEY-LIFECYCLE.md",
  "docs/LINEAGE.md",
  "docs/MERKLE-LEAVES.md",
  "docs/PILOT.md",
  "docs/PROOFPARCEL.md",
  "docs/PROOFS.md",
  "docs/RECEIPTS.md",
  "docs/REPUTATION.md",
  "docs/TAMPER-ME.md",
  "docs/TRUST-BOUNDARIES.md",
  "docs/TRUSTLEDGER.md",
  "docs/challenge-README.md",
  "docs/examples-README.md",
  "docs/overview.md",
  "docs/pilot-README.md",
  "docs/verifier-README.md",
  "index.html",
  "seal-vh-standalone.js",
  "seal-vh-standalone.js.sha256",
  "verify-vh-standalone.html",
  "verify-vh-standalone.html.sha256",
  "verify-vh-standalone.js",
  "verify-vh-standalone.js.sha256",
];

// What the 2026-06-26 deploy actually served (the site/DEPLOYED.json snapshot). The publish set has
// since GROWN (T-66.3 added the browser challenge page + sidecar), and the deployed snapshot
// legitimately LAGS the publish set until the human runs the upload flow — so the snapshot is pinned
// to its own frozen list, never to today's EXPECTED_PUBLISHED. This list changes ONLY via the T-67.2
// `--mark-deployed` flow.
const DEPLOYED_PUBLISHED = EXPECTED_PUBLISHED.filter(
  (p) => p !== "verify-vh-standalone.html" && p !== "verify-vh-standalone.html.sha256"
);

// The bundle entries that MUST come from the committed verifier/dist (acceptance clause 2).
const DIST_PINS = {
  "verify-vh-standalone.html": "verifier/dist/verify-vh-standalone.html",
  "verify-vh-standalone.html.sha256": "verifier/dist/verify-vh-standalone.html.sha256",
  "verify-vh-standalone.js": "verifier/dist/verify-vh-standalone.js",
  "verify-vh-standalone.js.sha256": "verifier/dist/verify-vh-standalone.js.sha256",
  "seal-vh-standalone.js": "verifier/dist/seal-vh-standalone.js",
  "seal-vh-standalone.js.sha256": "verifier/dist/seal-vh-standalone.js.sha256",
  "build-provenance.json": "verifier/dist/BUILD-PROVENANCE.json",
};

// PRE-regeneration pins for site/DEPLOYED.json (acceptance clause 4). d4af1f53… is the verifier hash the
// 2026-06-26 landing page PUBLISHED (the staging bundle as uploaded) — NOT today's committed dist. These
// frozen constants change ONLY via the T-67.2 `--mark-deployed` flow (which owns updating this test).
const DEPLOYED_VERIFIER_SHA = "d4af1f53100180ca56251c83f12b32858a754f08f4abd2fb8012a59a3a1a1cbd";
const DEPLOYED_INDEX_SHA = "eedc12e68d49be554adccb59ca32e3116c150782afc5c995d359d4f572e4f676";

// makeFakeRepo() — a tiny throwaway repo (publish set + sources) for RED-case surgery, so the real tree
// is never mutated by drift/tamper tests.
function makeFakeRepo(scratch, publishOverride) {
  const root = fs.mkdtempSync(path.join(scratch, "fake-repo-"));
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs-src"), { recursive: true });
  fs.mkdirSync(path.join(root, "site"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "a.txt"), "alpha\n");
  fs.writeFileSync(path.join(root, "docs-src", "b.md"), "# b\n");
  fs.writeFileSync(path.join(root, "site", "index.html"), "<html>hi</html>\n");
  const publish = publishOverride || {
    "a.txt": "assets/a.txt",
    "docs/b.md": "docs-src/b.md",
    "index.html": "site/index.html",
  };
  fs.writeFileSync(
    path.join(root, "site", "publish-set.json"),
    JSON.stringify({ schema: sr.PUBLISH_SET_SCHEMA, publish }, null, 2) + "\n"
  );
  return root;
}

// makeFakeVerifierRepo({ pageHash, sidecarHash }) — a throwaway repo that ships a fake verifier bundle,
// its .sha256 sidecar, and a landing page advertising a "Published SHA-256:". Lets the landing-page
// cross-assertion RED cases run WITHOUT touching the real tree. pageHash / sidecarHash default to the
// real bundle hash (consistent); pass a wrong value to force drift. Returns { root, bundleHash }.
function makeFakeVerifierRepo(scratch, opts) {
  opts = opts || {};
  const root = fs.mkdtempSync(path.join(scratch, "fake-verifier-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "site"), { recursive: true });
  const bundle = "// fake verifier bundle\nconsole.log('verify');\n";
  const bundleHash = sha256(Buffer.from(bundle));
  const sidecarHash = opts.sidecarHash || bundleHash;
  const pageHash = "pageHash" in opts ? opts.pageHash : bundleHash;
  fs.writeFileSync(path.join(root, "dist", "verify-vh-standalone.js"), bundle);
  fs.writeFileSync(path.join(root, "dist", "verify-vh-standalone.js.sha256"), `${sidecarHash}  verify-vh-standalone.js\n`);
  const hashLine = pageHash === null ? "" : `<p>Published SHA-256:</p><p class="hash"><code>${pageHash}</code></p>\n`;
  fs.writeFileSync(path.join(root, "site", "index.html"), `<!doctype html><html><body>${hashLine}</body></html>\n`);
  fs.writeFileSync(
    path.join(root, "site", "publish-set.json"),
    JSON.stringify(
      {
        schema: sr.PUBLISH_SET_SCHEMA,
        publish: {
          "index.html": "site/index.html",
          "verify-vh-standalone.js": "dist/verify-vh-standalone.js",
          "verify-vh-standalone.js.sha256": "dist/verify-vh-standalone.js.sha256",
        },
      },
      null,
      2
    ) + "\n"
  );
  return { root, bundleHash };
}

describe("T-67.1: scripts/site-release.js — deterministic site-release assembler + tracked publish set", function () {
  this.timeout(120000);

  let scratch;
  before(function () {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vh-site-release-test-"));
    // Fresh-checkout self-heal: public/ is untracked staging; assemble it if absent so --check has a
    // webroot to compare (the designed remedy the runbook itself prescribes).
    if (!fs.existsSync(path.join(REPO, "public", "RELEASE-MANIFEST.json"))) {
      const res = runCli([]);
      expect(res.status, res.stderr).to.equal(0);
    }
  });
  after(function () {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  describe("script hygiene — node-core only, guarded main", function () {
    it("requires ONLY fs/path/crypto (no http/https/net/dns/tls/child_process)", function () {
      const src = fs.readFileSync(SCRIPT, "utf8");
      expect(src).to.not.match(/require\(\s*["'](node:)?(http|https|net|dns|tls|child_process)["']\s*\)/);
      const required = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      for (const mod of required) expect(["fs", "path", "crypto"]).to.include(mod);
    });

    it("requiring the module does not run main (require.main guard)", function () {
      expect(typeof sr.main).to.equal("function");
      expect(typeof sr.assemble).to.equal("function");
      expect(typeof sr.check).to.equal("function");
      expect(typeof sr.loadDeployedSnapshot).to.equal("function");
    });

    it("rejects unknown flags with usage (exit 2)", function () {
      const res = runCli(["--frobnicate"]);
      expect(res.status).to.equal(2);
      expect(res.stderr).to.include("usage:");
    });
  });

  describe("(1) determinism — two assemblies are byte-identical", function () {
    it("assemble() twice: identical manifest bytes and identical content buffers", function () {
      const a = sr.assemble(REPO);
      const b = sr.assemble(REPO);
      expect(a.manifestJson).to.equal(b.manifestJson);
      expect(a.entries.length).to.equal(b.entries.length);
      for (let i = 0; i < a.entries.length; i++) {
        expect(a.entries[i].path).to.equal(b.entries[i].path);
        expect(a.entries[i].content.equals(b.entries[i].content), `bytes differ: ${a.entries[i].path}`).to.equal(true);
      }
    });

    it("writeAssembly() to two directories: recursively byte-identical (incl. RELEASE-MANIFEST.json)", function () {
      const out1 = path.join(scratch, "assembly-1");
      const out2 = path.join(scratch, "assembly-2");
      sr.writeAssembly(out1, sr.assemble(REPO));
      sr.writeAssembly(out2, sr.assemble(REPO));
      const files1 = walk(out1, "", []);
      const files2 = walk(out2, "", []);
      expect(files1).to.deep.equal(files2);
      expect(files1.length).to.equal(EXPECTED_PUBLISHED.length + 1); // + RELEASE-MANIFEST.json
      for (const rel of files1) {
        const b1 = fs.readFileSync(path.join(out1, rel));
        const b2 = fs.readFileSync(path.join(out2, rel));
        expect(b1.equals(b2), `assemblies differ at ${rel}`).to.equal(true);
      }
    });

    it("the manifest carries NO timestamp/clock field (determinism by construction)", function () {
      const { manifest, manifestJson } = sr.assemble(REPO);
      expect(Object.keys(manifest)).to.deep.equal(["schema", "publishSet", "fileCount", "totalBytes", "files"]);
      expect(manifestJson).to.not.match(/timestamp|generatedAt|date/i);
    });
  });

  describe("(2) assembled bytes EQUAL the committed sources, byte-for-byte", function () {
    let outDir;
    before(function () {
      outDir = path.join(scratch, "assembly-bytes");
      sr.writeAssembly(outDir, sr.assemble(REPO));
    });

    it("the publish set is EXACTLY the expected 33 published paths", function () {
      const set = sr.loadPublishSet(REPO);
      expect(Object.keys(set.publish).sort()).to.deep.equal(EXPECTED_PUBLISHED);
    });

    it("the verifier/sealer bundles + sidecars + provenance manifest EQUAL the committed verifier/dist bytes", function () {
      const set = sr.loadPublishSet(REPO);
      for (const [pub, distSrc] of Object.entries(DIST_PINS)) {
        expect(set.publish[pub], `publish set must map ${pub} -> ${distSrc}`).to.equal(distSrc);
        const staged = fs.readFileSync(path.join(outDir, pub));
        const committed = fs.readFileSync(path.join(REPO, distSrc));
        expect(staged.equals(committed), `${pub} must be byte-identical to committed ${distSrc}`).to.equal(true);
      }
    });

    it("EVERY published file equals its committed source byte-for-byte (docs renames included)", function () {
      const set = sr.loadPublishSet(REPO);
      for (const [pub, src] of Object.entries(set.publish)) {
        const staged = fs.readFileSync(path.join(outDir, pub));
        const committed = fs.readFileSync(path.join(REPO, src));
        expect(staged.equals(committed), `${pub} must be byte-identical to committed ${src}`).to.equal(true);
      }
      // spot-check the load-bearing renames are mapped to the right sources
      expect(set.publish["docs/overview.md"]).to.equal("README.md");
      expect(set.publish["docs/challenge-README.md"]).to.equal("challenge/README.md");
      expect(set.publish["docs/TAMPER-ME.md"]).to.equal("challenge/TAMPER-ME.md");
      expect(set.publish["index.html"]).to.equal("site/index.html");
    });

    it("RELEASE-MANIFEST.json is truthful: per-file sha256 + bytes recompute, totalBytes is the sum", function () {
      const { manifest } = sr.assemble(REPO);
      let total = 0;
      for (const f of manifest.files) {
        const bytes = fs.readFileSync(path.join(outDir, f.path));
        expect(sha256(bytes), `manifest sha256 stale for ${f.path}`).to.equal(f.sha256);
        expect(bytes.length).to.equal(f.bytes);
        total += f.bytes;
      }
      expect(manifest.totalBytes).to.equal(total);
      expect(manifest.fileCount).to.equal(manifest.files.length);
      expect(manifest.files.map((f) => f.path)).to.deep.equal(EXPECTED_PUBLISHED); // sorted
      expect(manifest.schema).to.equal(sr.MANIFEST_SCHEMA);
    });

    it("the committed twin site/RELEASE-MANIFEST.json equals public/RELEASE-MANIFEST.json equals a fresh assembly", function () {
      const fresh = sr.assemble(REPO).manifestJson;
      const twin = fs.readFileSync(path.join(REPO, "site", "RELEASE-MANIFEST.json"), "utf8");
      const stagedCopy = fs.readFileSync(path.join(REPO, "public", "RELEASE-MANIFEST.json"), "utf8");
      expect(twin).to.equal(fresh);
      expect(stagedCopy).to.equal(fresh);
    });
  });

  describe("(1) --check — GREEN on the committed tree, RED naming the offender, writes nothing", function () {
    it("--check is GREEN on the committed tree", function () {
      const res = runCli(["--check"]);
      expect(res.status, res.stderr).to.equal(0);
      expect(res.stdout).to.include("site-release --check: OK");
    });

    it("--check writes NOTHING (public/ byte-identical before and after)", function () {
      const pub = path.join(REPO, "public");
      const before = walk(pub, "", []).map((rel) => rel + ":" + sha256(fs.readFileSync(path.join(pub, rel))));
      const res = runCli(["--check"]);
      expect(res.status).to.equal(0);
      const after = walk(pub, "", []).map((rel) => rel + ":" + sha256(fs.readFileSync(path.join(pub, rel))));
      expect(after).to.deep.equal(before);
    });

    describe("real-tree tamper (restored by re-assembly in after())", function () {
      after(function () {
        // the designed remedy: re-assemble, then re-prove green
        expect(runCli([]).status).to.equal(0);
        expect(runCli(["--check"]).status).to.equal(0);
      });

      it("appending one byte to a staged file turns --check RED, NAMING the file", function () {
        fs.appendFileSync(path.join(REPO, "public", "NOTICE"), "x");
        const res = runCli(["--check"]);
        expect(res.status).to.equal(1);
        expect(res.stderr).to.include('TAMPERED: "public/NOTICE"');
      });

      it("a stowaway file in public/ turns --check RED, NAMING it as not allowlisted", function () {
        fs.writeFileSync(path.join(REPO, "public", "stowaway.txt"), "evil\n");
        try {
          const res = runCli(["--check"]);
          expect(res.status).to.equal(1);
          expect(res.stderr).to.include('NOT ALLOWLISTED: "public/stowaway.txt"');
        } finally {
          fs.rmSync(path.join(REPO, "public", "stowaway.txt"), { force: true });
        }
      });
    });

    describe("fake-repo RED cases (check() as a library; the real tree is never touched)", function () {
      let fake;
      beforeEach(function () {
        fake = makeFakeRepo(scratch);
        sr.release(fake);
        const base = sr.check(fake);
        expect(base.problems).to.deep.equal([]);
        expect(base.ok).to.equal(true);
      });

      it("tampered STAGED file → RED naming public/<file>", function () {
        fs.appendFileSync(path.join(fake, "public", "a.txt"), "!");
        const res = sr.check(fake);
        expect(res.ok).to.equal(false);
        expect(res.problems.join("\n")).to.match(/TAMPERED: "public\/a\.txt"/);
      });

      it("SOURCE drifts from the committed manifest → RED naming the file and its source", function () {
        fs.writeFileSync(path.join(fake, "assets", "a.txt"), "alpha v2\n");
        const res = sr.check(fake);
        expect(res.ok).to.equal(false);
        const text = res.problems.join("\n");
        expect(text).to.match(/SOURCE DRIFT: "a\.txt" \(source assets\/a\.txt\)/);
        expect(text).to.include("re-run `node scripts/site-release.js`");
      });

      it("non-allowlisted files (incl. an env-shaped one) → RED naming each; forbidden reason attached", function () {
        fs.writeFileSync(path.join(fake, "public", "evil.txt"), "x\n");
        fs.writeFileSync(path.join(fake, "public", ".env"), "SECRET=1\n");
        const res = sr.check(fake);
        expect(res.ok).to.equal(false);
        const text = res.problems.join("\n");
        expect(text).to.match(/NOT ALLOWLISTED: "public\/evil\.txt"/);
        expect(text).to.match(/NOT ALLOWLISTED: "public\/\.env"/);
        expect(text).to.include("matches the forbidden set");
      });

      it("a MISSING staged file → RED naming it", function () {
        fs.rmSync(path.join(fake, "public", "docs", "b.md"));
        const res = sr.check(fake);
        expect(res.ok).to.equal(false);
        expect(res.problems.join("\n")).to.match(/MISSING: "public\/docs\/b\.md"/);
      });

      it("a tampered committed manifest (hash edited) → RED as source drift naming the file", function () {
        const mPath = path.join(fake, "site", "RELEASE-MANIFEST.json");
        const m = JSON.parse(fs.readFileSync(mPath, "utf8"));
        m.files[0].sha256 = "0".repeat(64);
        fs.writeFileSync(mPath, JSON.stringify(m, null, 2) + "\n");
        const res = sr.check(fake);
        expect(res.ok).to.equal(false);
        expect(res.problems.join("\n")).to.match(/SOURCE DRIFT: "a\.txt"/);
      });

      it("a MISSING committed manifest → RED telling you to run the assembler", function () {
        fs.rmSync(path.join(fake, "site", "RELEASE-MANIFEST.json"));
        const res = sr.check(fake);
        expect(res.ok).to.equal(false);
        expect(res.problems.join("\n")).to.include("site/RELEASE-MANIFEST.json: missing");
      });
    });
  });

  describe("(3) the FORBIDDEN set is structurally excluded (named failures)", function () {
    it("classifyForbidden names every forbidden shape", function () {
      const forbidden = [
        ".git/config",
        ".git/HEAD",
        ".env",
        ".env.production",
        ".claude/.credentials.json",
        "docs/DEPLOY-PUBLIC-SITE.md",
        "docs/USAGE-BUDGET.json",
        "docs/METRICS.jsonl",
        "docs/MORNING.md",
        "STRATEGY.md",
        "BACKLOG.md",
        "team.json",
        "build-loop.workflow.js",
        "secrets/server.key",
        "cert.pem",
        "id_rsa",
        "id_ed25519.pub",
        "foo.vhclaim.json",
        "aws-credentials.json",
        "node_modules/x/index.js",
        "test/cli.claim.test.js", // committed hardhat dev keys — never near the webroot
        "scripts/site-release.js",
        "hardhat.config.js",
      ];
      for (const p of forbidden) {
        expect(sr.classifyForbidden(p), `must be forbidden: ${p}`).to.be.a("string");
      }
      const clean = ["index.html", "LICENSE", "docs/PILOT.md", "verifier/dist/verify-vh-standalone.js", "site/index.html"];
      for (const p of clean) {
        expect(sr.classifyForbidden(p), `must be clean: ${p}`).to.equal(null);
      }
    });

    it("an allowlist entry naming a forbidden file is a NAMED validation failure (both sides)", function () {
      const cases = [
        { publish: { ".git/config": "assets/a.txt" }, mustName: ".git/config" },
        { publish: { "runbook.md": "docs/DEPLOY-PUBLIC-SITE.md" }, mustName: "docs/DEPLOY-PUBLIC-SITE.md" },
        { publish: { "budget.json": "docs/USAGE-BUDGET.json" }, mustName: "docs/USAGE-BUDGET.json" },
        { publish: { "metrics.jsonl": "docs/METRICS.jsonl" }, mustName: "docs/METRICS.jsonl" },
        { publish: { ".env": "assets/a.txt" }, mustName: ".env" },
        { publish: { "k.key": "secrets/server.key" }, mustName: "secrets/server.key" },
        { publish: { "strategy.md": "STRATEGY.md" }, mustName: "STRATEGY.md" },
      ];
      for (const c of cases) {
        const fake = makeFakeRepo(scratch, c.publish);
        expect(() => sr.loadPublishSet(fake), `must throw for ${c.mustName}`).to.throw(Error);
        try {
          sr.loadPublishSet(fake);
        } catch (err) {
          expect(err.message, `failure must NAME ${c.mustName}`).to.include(c.mustName);
          expect(err.message).to.match(/FORBIDDEN/);
        }
      }
    });

    it("path traversal / absolute paths / missing sources are NAMED validation failures", function () {
      const cases = [
        { publish: { "../evil.txt": "assets/a.txt" }, mustName: "../evil.txt", why: /unsafe published path/ },
        { publish: { "ok.txt": "../../etc/passwd" }, mustName: "../../etc/passwd", why: /unsafe source path/ },
        { publish: { "ok.txt": "/etc/passwd" }, mustName: "/etc/passwd", why: /unsafe source path/ },
        { publish: { "ok.txt": "assets/does-not-exist.txt" }, mustName: "assets/does-not-exist.txt", why: /does not exist/ },
        { publish: { "RELEASE-MANIFEST.json": "assets/a.txt" }, mustName: "RELEASE-MANIFEST.json", why: /reserved/ },
      ];
      for (const c of cases) {
        const fake = makeFakeRepo(scratch, c.publish);
        try {
          sr.loadPublishSet(fake);
          expect.fail(`must throw for ${c.mustName}`);
        } catch (err) {
          expect(err.message).to.include(c.mustName);
          expect(err.message).to.match(c.why);
        }
      }
    });

    it("the REAL committed allowlist is clean: no entry (either side) matches the forbidden set", function () {
      const set = sr.loadPublishSet(REPO); // throws if any entry is forbidden/unsafe/missing
      for (const [pub, src] of Object.entries(set.publish)) {
        expect(sr.classifyForbidden(pub), `published path forbidden: ${pub}`).to.equal(null);
        expect(sr.classifyForbidden(src), `source path forbidden: ${src}`).to.equal(null);
      }
      expect(sr.validatePublishSet(JSON.parse(fs.readFileSync(path.join(REPO, "site", "publish-set.json"), "utf8")), REPO)).to.deep.equal([]);
    });

    it("the assembled webroot contains NO dotfile, NO forbidden basename, NOTHING outside the allowlist", function () {
      const outDir = path.join(scratch, "assembly-forbidden-scan");
      sr.writeAssembly(outDir, sr.assemble(REPO));
      const staged = walk(outDir, "", []);
      for (const rel of staged) {
        expect(rel.split("/").some((seg) => seg.startsWith(".")), `dot path staged: ${rel}`).to.equal(false);
        const base = rel.split("/").pop();
        expect(["DEPLOY-PUBLIC-SITE.md", "USAGE-BUDGET.json", "METRICS.jsonl", "MORNING.md"], `forbidden doc staged: ${rel}`).to.not.include(base);
        expect(/\.(pem|key)$|\.env$/i.test(base), `key/env-shaped file staged: ${rel}`).to.equal(false);
        expect(EXPECTED_PUBLISHED.concat([sr.MANIFEST_NAME]), `outside allowlist: ${rel}`).to.include(rel);
      }
    });
  });

  describe("(4) site/DEPLOYED.json — the pre-regeneration deployment snapshot", function () {
    it("exists and is schema-valid ({generatedFrom, deployedAtNote, files:{relPath: sha256}})", function () {
      const snap = sr.loadDeployedSnapshot(REPO); // throws on any malformation
      expect(snap.generatedFrom).to.include("public/");
      expect(snap.deployedAtNote).to.include("2026-06-26");
      expect(Object.keys(snap.files).sort()).to.deep.equal(DEPLOYED_PUBLISHED);
      for (const [rel, hash] of Object.entries(snap.files)) {
        expect(hash, `bad sha256 for ${rel}`).to.match(/^[0-9a-f]{64}$/);
      }
    });

    it("was captured from the PRE-regeneration staging bytes (the OLD published verifier hash, not today's dist)", function () {
      const snap = sr.loadDeployedSnapshot(REPO);
      // d4af1f53… is the hash the deployed 2026-06-26 landing page itself published for the verifier.
      expect(snap.files["verify-vh-standalone.js"]).to.equal(DEPLOYED_VERIFIER_SHA);
      expect(snap.files["index.html"]).to.equal(DEPLOYED_INDEX_SHA);
      // …and the committed dist has since moved on: the snapshot is a real drift baseline, not a copy
      // of the fresh assembly.
      const currentDist = sha256(fs.readFileSync(path.join(REPO, "verifier", "dist", "verify-vh-standalone.js")));
      expect(snap.files["verify-vh-standalone.js"]).to.not.equal(currentDist);
    });

    it("a malformed snapshot is a NAMED failure (loadDeployedSnapshot throws)", function () {
      const fake = makeFakeRepo(scratch);
      fs.writeFileSync(
        path.join(fake, "site", "DEPLOYED.json"),
        JSON.stringify({ generatedFrom: "x", deployedAtNote: "y", files: { "a.txt": "not-a-sha" } }, null, 2)
      );
      try {
        sr.loadDeployedSnapshot(fake);
        expect.fail("must throw on a malformed sha256");
      } catch (err) {
        expect(err.message).to.include("files.a.txt");
        expect(err.message).to.include("sha256");
      }
    });
  });

  describe("(5) docs/DEPLOY-PUBLIC-SITE.md consumes the packet (and relaxes nothing)", function () {
    let doc, docFlat;
    before(function () {
      doc = fs.readFileSync(path.join(REPO, "docs", "DEPLOY-PUBLIC-SITE.md"), "utf8");
      docFlat = doc.replace(/\s+/g, " ");
    });

    it("the upload step says: run `node scripts/site-release.js`, upload `public/`, verify against `RELEASE-MANIFEST.json`", function () {
      expect(docFlat).to.include(
        "run `node scripts/site-release.js`, upload `public/`, verify against `RELEASE-MANIFEST.json`"
      );
      expect(doc).to.include('node "$REPO/scripts/site-release.js" --check'); // the pre-upload integrity gate
      expect(doc).to.include("site/publish-set.json");
      expect(doc).to.include("site/DEPLOYED.json");
      expect(doc).to.include("site/index.html");
    });

    it("the CRITICAL SAFETY RULES and the must-NEVER-be-served table were NOT relaxed", function () {
      expect(doc).to.include("CRITICAL SAFETY RULES");
      expect(doc).to.include("**Must NEVER be served:**");
      for (const row of [
        "/home/loopdev/.claude/.credentials.json",
        "`docs/USAGE-BUDGET.json`, `docs/METRICS.jsonl`",
        "`STRATEGY.md`, `BACKLOG.md`",
        "Deploy by copying real files — never symlink into the repo",
      ]) {
        expect(doc, `safety rule missing: ${row}`).to.include(row);
      }
    });

    it("the landing page is documented as version-controlled at site/index.html and is byte-identical when staged", function () {
      expect(doc).to.include("version-controlled at `site/index.html`");
      const committed = fs.readFileSync(path.join(REPO, "site", "index.html"));
      const staged = fs.readFileSync(path.join(REPO, "public", "index.html"));
      expect(staged.equals(committed)).to.equal(true);
    });

    it("§3b warns to update the page's `Published SHA-256:` when the bundle changes", function () {
      // the runbook must tell the operator that the page's advertised hash must track the shipped bundle
      expect(doc).to.match(/Published SHA-256/);
      expect(docFlat).to.match(/update the page.?s .{0,2}Published SHA-256.{0,2} to match/i);
      expect(doc).to.include("LANDING PAGE DRIFT");
    });
  });

  describe("(6) landing-page cross-assertion — advertised hash == shipped bundle == sidecar", function () {
    it("extractPublishedHash pulls the 64-hex hash after `Published SHA-256:` (and null when absent)", function () {
      const html = '<p>Published SHA-256:</p>\n<p class="hash"><code>' + "a".repeat(64) + "</code></p>";
      expect(sr.extractPublishedHash(html)).to.equal("a".repeat(64));
      expect(sr.extractPublishedHash("<p>no hash here</p>")).to.equal(null);
      // must not pick up an UNRELATED 64-hex string that appears BEFORE the label
      const before = "<code>" + "b".repeat(64) + "</code><p>Published SHA-256:</p><code>" + "c".repeat(64) + "</code>";
      expect(sr.extractPublishedHash(before)).to.equal("c".repeat(64));
    });

    it("parseSidecarHash pulls the leading 64-hex token of a sha256sum-style sidecar", function () {
      expect(sr.parseSidecarHash("d".repeat(64) + "  verify-vh-standalone.js\n")).to.equal("d".repeat(64));
      expect(sr.parseSidecarHash("not a hash")).to.equal(null);
    });

    it("REAL tree: the committed site/index.html advertises EXACTLY the shipped verify-vh-standalone.js hash + sidecar", function () {
      const bundle = fs.readFileSync(path.join(REPO, "verifier", "dist", "verify-vh-standalone.js"));
      const bundleHash = sha256(bundle);
      const pageHash = sr.extractPublishedHash(fs.readFileSync(path.join(REPO, "site", "index.html"), "utf8"));
      const sidecarHash = sr.parseSidecarHash(fs.readFileSync(path.join(REPO, "verifier", "dist", "verify-vh-standalone.js.sha256"), "utf8"));
      expect(pageHash, "landing page must advertise the shipped bundle's hash").to.equal(bundleHash);
      expect(sidecarHash, "sidecar must pin the shipped bundle's hash").to.equal(bundleHash);
      // and the assembly of the real tree is internally consistent (no drift problems)
      expect(sr.landingConsistencyProblems(sr.assemble(REPO))).to.deep.equal([]);
    });

    it("a CONSISTENT fake webroot (page == bundle == sidecar) assembles & checks GREEN", function () {
      const { root } = makeFakeVerifierRepo(scratch);
      sr.release(root); // must not throw
      const res = sr.check(root);
      expect(res.problems).to.deep.equal([]);
      expect(res.ok).to.equal(true);
    });

    it("page advertises the WRONG hash → release() THROWS and --check goes RED naming LANDING PAGE DRIFT", function () {
      const { root, bundleHash } = makeFakeVerifierRepo(scratch, { pageHash: "e".repeat(64) });
      expect(() => sr.release(root), "release must refuse a self-contradicting webroot").to.throw(/LANDING PAGE DRIFT/);
      // check() must also flag it (assemble a webroot first so the staged-webroot legs pass, then verify
      // the cross-assertion is what turns it RED). We stage via writeAssembly to bypass release()'s guard.
      sr.writeAssembly(path.join(root, "public"), sr.assemble(root));
      fs.writeFileSync(path.join(root, "site", "RELEASE-MANIFEST.json"), sr.assemble(root).manifestJson);
      const res = sr.check(root);
      expect(res.ok).to.equal(false);
      const text = res.problems.join("\n");
      expect(text).to.match(/LANDING PAGE DRIFT/);
      expect(text).to.include("e".repeat(64)); // the wrong advertised hash is named
      expect(text).to.include(bundleHash); // the correct shipped-bundle hash is named
    });

    it("page ships the verifier but advertises NO Published SHA-256 → RED naming LANDING PAGE DRIFT", function () {
      const { root } = makeFakeVerifierRepo(scratch, { pageHash: null });
      const probs = sr.landingConsistencyProblems(sr.assemble(root));
      expect(probs.join("\n")).to.match(/LANDING PAGE DRIFT/);
      expect(probs.join("\n")).to.match(/advertises no "Published SHA-256/);
    });

    it("the .sha256 sidecar disagreeing with the shipped bundle → RED naming LANDING/SIDECAR DRIFT", function () {
      const { root, bundleHash } = makeFakeVerifierRepo(scratch, { sidecarHash: "f".repeat(64) });
      const probs = sr.landingConsistencyProblems(sr.assemble(root));
      const text = probs.join("\n");
      expect(text).to.match(/LANDING\/SIDECAR DRIFT/);
      expect(text).to.include("f".repeat(64));
      expect(text).to.include(bundleHash);
    });

    it("a webroot that does NOT ship the verifier bundle is exempt (no false positives)", function () {
      // the default fake repo (a.txt, docs/b.md, index.html) ships no verifier → zero cross-check problems
      const fake = makeFakeRepo(scratch);
      expect(sr.landingConsistencyProblems(sr.assemble(fake))).to.deep.equal([]);
    });
  });
});
