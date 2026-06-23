const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  SCHEMA_VERSION,
  RECEIPT_KIND,
  buildReceipt,
  writeReceipt,
  readReceipt,
  defaultReceiptPath,
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
