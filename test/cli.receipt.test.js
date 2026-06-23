const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  SCHEMA_VERSION,
  RECEIPT_KIND,
  ANCHOR_RECEIPT_KIND,
  buildReceipt,
  buildAnchorReceipt,
  writeReceipt,
  readReceipt,
  diffManifest,
  defaultReceiptPath,
  _normGit,
} = require("../cli/receipt");

// ---------------------------------------------------------------------------
// Fixtures: a well-formed set of receipt parts. Tests mutate copies of this.
// ---------------------------------------------------------------------------
const HASH = "0x" + "11".repeat(32);
const SALT = "0x" + "ab".repeat(32);
const COMMITMENT = "0x" + "cd".repeat(32);
const COMMITTER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const COMMIT_TX = "0x" + "ef".repeat(32);

function goodParts(over = {}) {
  return Object.assign(
    {
      contentHash: HASH,
      committer: COMMITTER,
      salt: SALT,
      commitment: COMMITMENT,
      contractAddress: CONTRACT,
      chainId: 31337,
      uri: "ipfs://cid",
      path: "/some/file.txt",
      kind: "file",
      commitTxHash: COMMIT_TX,
      commitBlockNumber: 42,
      minRevealDelay: 1,
    },
    over
  );
}

let tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-receipt-"));
  tmpDirs.push(d);
  return d;
}
after(function () {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe("cli/receipt: round-trip", function () {
  it("buildReceipt produces a validated, versioned, kind-tagged object", function () {
    const r = buildReceipt(goodParts());
    expect(r.kind).to.equal(RECEIPT_KIND);
    expect(r.schemaVersion).to.equal(SCHEMA_VERSION);
    expect(r.contentHash).to.equal(HASH);
    expect(r.salt).to.equal(SALT);
    expect(r.commitment).to.equal(COMMITMENT);
    expect(r.committer).to.equal(COMMITTER);
    expect(r.contractAddress).to.equal(CONTRACT);
    expect(r.chainId).to.equal(31337);
    expect(r.uri).to.equal("ipfs://cid");
    expect(r.commitTxHash).to.equal(COMMIT_TX);
    expect(r.commitBlockNumber).to.equal(42);
    expect(r.minRevealDelay).to.equal(1);
  });

  it("write then read returns an equivalent receipt (full round-trip)", function () {
    const p = path.join(tmp(), "claim.vhclaim.json");
    const written = writeReceipt(buildReceipt(goodParts()), p);
    const read = readReceipt(p);
    expect(read).to.deep.equal(written);
    // Sanity: it is real, re-parseable JSON with a trailing newline.
    const raw = fs.readFileSync(p, "utf8");
    expect(raw.endsWith("\n")).to.equal(true);
    expect(JSON.parse(raw).salt).to.equal(SALT);
  });

  it("normalizes chainId/blockNumber from bigint and string to integers", function () {
    const r = buildReceipt(goodParts({ chainId: 80002n, commitBlockNumber: "1000", minRevealDelay: 2n }));
    expect(r.chainId).to.equal(80002);
    expect(r.commitBlockNumber).to.equal(1000);
    expect(r.minRevealDelay).to.equal(2);
  });

  it("builds without optional fields (only the canonical required set)", function () {
    const r = buildReceipt({
      contentHash: HASH,
      committer: COMMITTER,
      salt: SALT,
      commitment: COMMITMENT,
      contractAddress: CONTRACT,
      chainId: 31337,
    });
    expect(r.uri).to.equal(""); // defaulted to empty string, never undefined
    expect(r).to.not.have.property("commitBlockNumber");
    const p = path.join(tmp(), "min.vhclaim.json");
    writeReceipt(r, p);
    expect(readReceipt(p)).to.deep.equal(r);
  });

  it("defaultReceiptPath derives ./<16 hex>.vhclaim.json from the contentHash", function () {
    expect(defaultReceiptPath(HASH)).to.equal("./1111111111111111.vhclaim.json");
    expect(() => defaultReceiptPath("not-a-hash")).to.throw();
  });
});

describe("cli/receipt: strict validation (rejects corrupt/partial receipts)", function () {
  function writeRaw(obj) {
    const p = path.join(tmp(), "bad.vhclaim.json");
    fs.writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  it("rejects a wrong schemaVersion", function () {
    const r = buildReceipt(goodParts());
    r.schemaVersion = SCHEMA_VERSION + 1;
    expect(() => readReceipt(writeRaw(r))).to.throw(/schemaVersion/);
  });

  it("rejects a wrong kind / a random JSON file", function () {
    expect(() => readReceipt(writeRaw({ schemaVersion: SCHEMA_VERSION, hello: "world" }))).to.throw(
      /claim receipt|kind/
    );
  });

  for (const field of ["salt", "commitment", "contentHash", "committer", "contractAddress", "chainId"]) {
    it(`rejects a receipt missing ${field}`, function () {
      const r = buildReceipt(goodParts());
      delete r[field];
      expect(() => readReceipt(writeRaw(r))).to.throw(new RegExp(field));
    });
  }

  it("rejects a malformed hex field (bad salt)", function () {
    const r = buildReceipt(goodParts());
    r.salt = "0xnothex";
    expect(() => readReceipt(writeRaw(r))).to.throw(/salt/);
  });

  it("rejects a salt of the wrong length (31 bytes)", function () {
    const r = buildReceipt(goodParts());
    r.salt = "0x" + "ab".repeat(31);
    expect(() => readReceipt(writeRaw(r))).to.throw(/salt/);
  });

  it("rejects a malformed committer address", function () {
    const r = buildReceipt(goodParts());
    r.committer = "0x1234"; // too short
    expect(() => readReceipt(writeRaw(r))).to.throw(/committer/);
  });

  it("rejects a malformed contractAddress", function () {
    const r = buildReceipt(goodParts());
    r.contractAddress = "not-an-address";
    expect(() => readReceipt(writeRaw(r))).to.throw(/contractAddress/);
  });

  it("rejects a non-integer / negative chainId", function () {
    const r = buildReceipt(goodParts());
    r.chainId = -1;
    expect(() => readReceipt(writeRaw(r))).to.throw(/chainId/);
  });

  it("rejects non-JSON content", function () {
    const p = path.join(tmp(), "garbage.vhclaim.json");
    fs.writeFileSync(p, "this is not json {");
    expect(() => readReceipt(p)).to.throw(/not valid JSON/);
  });

  it("rejects a missing file with a clear error", function () {
    expect(() => readReceipt(path.join(tmp(), "does-not-exist.json"))).to.throw(/cannot read receipt/);
  });

  it("buildReceipt itself rejects bad parts (never writes a partial receipt)", function () {
    expect(() => buildReceipt(goodParts({ salt: undefined }))).to.throw(/salt/);
    expect(() => buildReceipt(goodParts({ committer: "0xbad" }))).to.throw(/committer/);
    expect(() => buildReceipt(goodParts({ chainId: "not-a-number" }))).to.throw(/chainId/);
  });

  it("writeReceipt refuses to write an invalid object (validates before touching disk)", function () {
    const p = path.join(tmp(), "never-written.json");
    expect(() => writeReceipt({ kind: "wrong" }, p)).to.throw();
    expect(fs.existsSync(p)).to.equal(false);
  });
});

// ---------------------------------------------------------------------------
// Schema v2: the optional, additive `manifest` (directory anchor receipts) and
// the backward-compatible reader that still accepts v1 receipts (no manifest).
// ---------------------------------------------------------------------------
describe("cli/receipt: v2 manifest + anchor receipts (additive, back-compatible)", function () {
  const LEAF_A = "0x" + "a1".repeat(32);
  const LEAF_B = "0x" + "b2".repeat(32);
  const CH_A = "0x" + "01".repeat(32);
  const CH_B = "0x" + "02".repeat(32);

  function manifest() {
    return [
      { path: "src/b.js", contentHash: CH_B, leaf: LEAF_B },
      { path: "src/a.js", contentHash: CH_A, leaf: LEAF_A },
    ];
  }

  it("SCHEMA_VERSION is at least 2 (the manifest schema bump)", function () {
    expect(SCHEMA_VERSION).to.be.at.least(2);
  });

  it("buildReceipt records a manifest on a claim receipt and sorts it by leaf", function () {
    const r = buildReceipt(goodParts({ manifest: manifest(), kind: "dir" }));
    expect(r.schemaVersion).to.equal(SCHEMA_VERSION);
    expect(r.manifest).to.be.an("array").with.length(2);
    // Sorted ascending by leaf value: LEAF_A (a1..) < LEAF_B (b2..).
    expect(r.manifest[0].path).to.equal("src/a.js");
    expect(r.manifest[1].path).to.equal("src/b.js");
    expect(r.manifest[0].leaf).to.equal(LEAF_A);
  });

  it("buildAnchorReceipt produces an anchor-kind receipt with no salt/commitment but a manifest", function () {
    const r = buildAnchorReceipt({
      contentHash: HASH,
      contractAddress: CONTRACT,
      chainId: 31337,
      uri: "ipfs://cid",
      path: "/repo",
      kind: "dir",
      anchorTxHash: COMMIT_TX,
      anchorBlockNumber: 7,
      manifest: manifest(),
    });
    expect(r.kind).to.equal(ANCHOR_RECEIPT_KIND);
    expect(r).to.not.have.property("salt");
    expect(r).to.not.have.property("commitment");
    expect(r).to.not.have.property("committer");
    expect(r.anchorTxHash).to.equal(COMMIT_TX);
    expect(r.anchorBlockNumber).to.equal(7);
    expect(r.manifest).to.have.length(2);
  });

  it("write/read round-trips an anchor receipt with a manifest", function () {
    const p = path.join(tmp(), "anchor.vhclaim.json");
    const written = writeReceipt(
      buildAnchorReceipt({
        contentHash: HASH,
        contractAddress: CONTRACT,
        chainId: 31337,
        kind: "dir",
        manifest: manifest(),
      }),
      p
    );
    expect(readReceipt(p)).to.deep.equal(written);
  });

  it("READER ACCEPTS BOTH versions: a v1 receipt (no manifest) still validates", function () {
    // Construct a genuine v1 receipt on disk and read it back through the current reader.
    const v1 = buildReceipt(goodParts());
    v1.schemaVersion = 1;
    delete v1.manifest;
    const p = path.join(tmp(), "v1.vhclaim.json");
    fs.writeFileSync(p, JSON.stringify(v1));
    const read = readReceipt(p);
    expect(read.schemaVersion).to.equal(1);
    expect(read).to.not.have.property("manifest");
  });

  it("rejects a v1 receipt that smuggles in a manifest (version must not lie)", function () {
    const r = buildReceipt(goodParts({ manifest: manifest(), kind: "dir" }));
    r.schemaVersion = 1; // claim v1 while carrying a v2-only field
    const p = path.join(tmp(), "lying.vhclaim.json");
    fs.writeFileSync(p, JSON.stringify(r));
    expect(() => readReceipt(p)).to.throw(/manifest requires schemaVersion/);
  });

  it("rejects a malformed manifest entry (bad leaf)", function () {
    const bad = manifest();
    bad[0].leaf = "0xnothex";
    expect(() => buildReceipt(goodParts({ manifest: bad, kind: "dir" }))).to.throw(/manifest/);
  });

  it("rejects a manifest entry missing a path", function () {
    const bad = [{ contentHash: CH_A, leaf: LEAF_A }];
    expect(() => buildAnchorReceipt({
      contentHash: HASH,
      contractAddress: CONTRACT,
      chainId: 31337,
      manifest: bad,
    })).to.throw(/path/);
  });

  it("rejects an anchor receipt missing its contentHash / contractAddress", function () {
    expect(() => buildAnchorReceipt({ contractAddress: CONTRACT, chainId: 1 })).to.throw(/contentHash/);
    expect(() => buildAnchorReceipt({ contentHash: HASH, chainId: 1 })).to.throw(/contractAddress/);
  });
});

// ---------------------------------------------------------------------------
// Schema v3: the optional, additive `git` provenance block { commit, scope }
// (T-8.2). Carries the resolved commit oid + repo-relative scope used to
// enumerate the tracked files for a `--git` anchor/claim. An UNTRUSTED hint —
// validated for SHAPE only, never elevated to the authoritative verdict. The
// reader still accepts all prior versions (v1/v2 receipts have no git block).
// ---------------------------------------------------------------------------
describe("cli/receipt: v3 git provenance block (additive, back-compatible)", function () {
  const OID = "099438f796ab23b0f64805f1aca3da64e3b504bb"; // a real 40-hex commit oid
  const GIT = { commit: OID, scope: "." };

  const LEAF_A = "0x" + "a1".repeat(32);
  const CH_A = "0x" + "01".repeat(32);
  function manifest() {
    return [{ path: "src/a.js", contentHash: CH_A, leaf: LEAF_A }];
  }

  it("SCHEMA_VERSION is at least 3 (the git-block schema bump)", function () {
    expect(SCHEMA_VERSION).to.be.at.least(3);
  });

  it("buildAnchorReceipt records a git block (commit + scope) at schemaVersion >= 3", function () {
    const r = buildAnchorReceipt({
      contentHash: HASH,
      contractAddress: CONTRACT,
      chainId: 31337,
      kind: "dir",
      manifest: manifest(),
      git: GIT,
    });
    expect(r.schemaVersion).to.be.at.least(3);
    expect(r.git).to.deep.equal(GIT);
  });

  it("buildReceipt (claim) records a git block too", function () {
    const r = buildReceipt(goodParts({ git: GIT, kind: "dir", manifest: manifest() }));
    expect(r.git).to.deep.equal(GIT);
  });

  it("normalizes git.commit to lowercase and keeps a nested subdir scope verbatim", function () {
    const mixed = { commit: OID.toUpperCase(), scope: "packages/core" };
    const r = buildAnchorReceipt({
      contentHash: HASH,
      contractAddress: CONTRACT,
      chainId: 31337,
      git: mixed,
    });
    expect(r.git.commit).to.equal(OID); // lowercased
    expect(r.git.scope).to.equal("packages/core");
  });

  it("write/read round-trips a receipt WITH a git block (the new field survives disk)", function () {
    const p = path.join(tmp(), "git.vhclaim.json");
    const written = writeReceipt(
      buildAnchorReceipt({
        contentHash: HASH,
        contractAddress: CONTRACT,
        chainId: 31337,
        kind: "dir",
        manifest: manifest(),
        git: GIT,
      }),
      p
    );
    const read = readReceipt(p);
    expect(read).to.deep.equal(written);
    expect(read.git).to.deep.equal(GIT);
    // The git block is literally on disk as { commit, scope }.
    const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(onDisk.git).to.deep.equal(GIT);
  });

  it("READER ACCEPTS PRIOR VERSIONS: a v2 receipt (manifest, NO git block) still validates", function () {
    // A genuine v2 receipt: has a manifest, no git block.
    const v2 = buildAnchorReceipt({
      contentHash: HASH,
      contractAddress: CONTRACT,
      chainId: 31337,
      kind: "dir",
      manifest: manifest(),
    });
    v2.schemaVersion = 2;
    expect(v2).to.not.have.property("git");
    const p = path.join(tmp(), "v2-nogit.vhclaim.json");
    fs.writeFileSync(p, JSON.stringify(v2));
    const read = readReceipt(p);
    expect(read.schemaVersion).to.equal(2);
    expect(read).to.not.have.property("git");
  });

  it("READER ACCEPTS PRIOR VERSIONS: a v1 receipt (no manifest, no git block) still validates", function () {
    const v1 = buildReceipt(goodParts());
    v1.schemaVersion = 1;
    delete v1.manifest;
    delete v1.git;
    const p = path.join(tmp(), "v1-nogit.vhclaim.json");
    fs.writeFileSync(p, JSON.stringify(v1));
    const read = readReceipt(p);
    expect(read.schemaVersion).to.equal(1);
    expect(read).to.not.have.property("git");
  });

  it("rejects a v2 receipt that smuggles in a git block (version must not lie)", function () {
    const r = buildAnchorReceipt({
      contentHash: HASH,
      contractAddress: CONTRACT,
      chainId: 31337,
      git: GIT,
    });
    r.schemaVersion = 2; // claim v2 while carrying a v3-only field
    const p = path.join(tmp(), "lying-git.vhclaim.json");
    fs.writeFileSync(p, JSON.stringify(r));
    expect(() => readReceipt(p)).to.throw(/git block requires schemaVersion/);
  });

  it("rejects a malformed git.commit (not a 40-hex oid)", function () {
    expect(() => buildAnchorReceipt({
      contentHash: HASH,
      contractAddress: CONTRACT,
      chainId: 31337,
      git: { commit: "deadbeef", scope: "." }, // too short
    })).to.throw(/git\.commit/);
    // A 0x-prefixed value is also rejected (the block records the BARE git oid).
    expect(() => _normGit({ commit: "0x" + "a".repeat(40), scope: "." })).to.throw(/git\.commit/);
  });

  it("rejects a missing / empty git.scope", function () {
    expect(() => _normGit({ commit: OID })).to.throw(/git\.scope/);
    expect(() => _normGit({ commit: OID, scope: "" })).to.throw(/git\.scope/);
  });

  it("rejects a non-object git block", function () {
    expect(() => _normGit("not-an-object")).to.throw(/git block/);
    expect(() => _normGit([OID, "."])).to.throw(/git block/);
  });

  it("a receipt that fails git-block validation never lands on disk (validate-before-write)", function () {
    const p = path.join(tmp(), "never-git.json");
    const bad = buildAnchorReceipt({
      contentHash: HASH,
      contractAddress: CONTRACT,
      chainId: 31337,
    });
    bad.git = { commit: "nope", scope: "." }; // corrupt after build
    expect(() => writeReceipt(bad, p)).to.throw(/git\.commit/);
    expect(fs.existsSync(p)).to.equal(false);
  });
});

// ---------------------------------------------------------------------------
// diffManifest: the pure localizer used by `vh verify --receipt`.
// ---------------------------------------------------------------------------
describe("cli/receipt: diffManifest (pure file-level localizer)", function () {
  // A tiny helper that fabricates a stable (path -> leaf/contentHash) manifest. The exact hash
  // values are arbitrary here; diffManifest keys on path and compares leaf values.
  function entry(p, n) {
    const h = "0x" + String(n).padStart(2, "0").repeat(32);
    return { path: p, contentHash: h, leaf: h };
  }

  it("identical manifests diff to nothing (identical = true)", function () {
    const m = [entry("a", 1), entry("b", 2), entry("c", 3)];
    const d = diffManifest(m, m.map((e) => ({ ...e })));
    expect(d.identical).to.equal(true);
    expect(d.added).to.be.empty;
    expect(d.removed).to.be.empty;
    expect(d.changed).to.be.empty;
    expect(d.unchanged).to.have.length(3);
  });

  it("a single changed file is reported as exactly that CHANGED, old->new", function () {
    const recorded = [entry("a", 1), entry("b", 2), entry("c", 3)];
    const current = [entry("a", 1), entry("b", 9), entry("c", 3)]; // b changed
    const d = diffManifest(recorded, current);
    expect(d.identical).to.equal(false);
    expect(d.added).to.be.empty;
    expect(d.removed).to.be.empty;
    expect(d.changed).to.have.length(1);
    expect(d.changed[0].path).to.equal("b");
    expect(d.changed[0].oldContentHash).to.equal(entry("b", 2).contentHash);
    expect(d.changed[0].newContentHash).to.equal(entry("b", 9).contentHash);
  });

  it("an added and a removed file are reported as ADDED / REMOVED", function () {
    const recorded = [entry("a", 1), entry("b", 2)];
    const current = [entry("a", 1), entry("c", 3)]; // b removed, c added
    const d = diffManifest(recorded, current);
    expect(d.added.map((x) => x.path)).to.deep.equal(["c"]);
    expect(d.removed.map((x) => x.path)).to.deep.equal(["b"]);
    expect(d.changed).to.be.empty;
  });

  it("two unrelated manifests diff as fully divergent (all added + all removed, no overlap)", function () {
    const recorded = [entry("x", 1), entry("y", 2)];
    const current = [entry("p", 3), entry("q", 4)];
    const d = diffManifest(recorded, current);
    expect(d.added.map((x) => x.path)).to.deep.equal(["p", "q"]);
    expect(d.removed.map((x) => x.path)).to.deep.equal(["x", "y"]);
    expect(d.changed).to.be.empty;
    expect(d.identical).to.equal(false);
  });
});
