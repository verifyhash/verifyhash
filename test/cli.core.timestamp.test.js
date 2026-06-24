"use strict";

// test/cli.core.timestamp.test.js — the detached RFC-3161 TIMESTAMP container engine (T-20.2, EPIC-20) +
// the `vh dataset/parcel timestamp-request` / `timestamp-wrap` commands.
//
// WHY THIS SUITE EXISTS
//   cli/core/timestamp.js is the wrap-don't-edit CONTAINER for an INDEPENDENT RFC-3161 timestamp over a
//   product's canonical UNSIGNED attestation. We must prove it WITHOUT a real TSA and WITHOUT a network. So
//   this file carries a TEST-ONLY DER token minter (the timestamp analogue of Wallet.createRandom(): NO real
//   TSA, NO real key, NO funds, NO network) that stamps a chosen SHA-256 digest. The minter is the SAME
//   shape as the one in cli.core.rfc3161.test.js — defined HERE on the test surface, never on the command
//   path, so nothing ships a token forger.
//
//   Coverage:
//     * the engine builds + validates a container from a MINTED token bound to the canonical sha256 digest;
//     * `timestamp-request` over a built manifest emits a digest that EQUALS sha256 of the canonical
//       attestation bytes (and equals the engine's own digest);
//     * the validator REJECTS a container whose token binds a DIFFERENT digest, whose embedded attestation
//       was EDITED (wrap-don't-edit), and whose `digest` != sha256(bytes);
//     * `--json` round-trips for both commands;
//     * the commands LEAD with the inherited TRUST_NOTE + the timestamp-specific caveat;
//     * a typo'd flag hard-errors (parser parity);
//     * side effects land ONLY at the caller's --out path; every test isolates to a throwaway temp dir and
//       self-cleans, pass or fail (no leaked receipts/artifacts in the working tree).

const { expect } = require("chai");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const coreTimestamp = require("../cli/core/timestamp");
const rfc3161 = require("../cli/core/rfc3161");
const { OID } = rfc3161;

const {
  runDatasetBuild,
  readManifest,
  buildAttestation,
  serializeAttestation,
  TRUST_NOTE,
  TIMESTAMPED_ATTESTATION_KIND,
  TIMESTAMPED_ATTESTATION_TRUST_NOTE,
  buildTimestampedAttestation,
  validateTimestampedAttestation,
  serializeTimestampedAttestation,
  readTimestampedAttestation,
  runDatasetTimestampRequest,
  runDatasetTimestampWrap,
} = require("../cli/dataset");
const {
  runParcelBuild,
  readParcelManifest,
  buildParcelAttestation,
  serializeParcelAttestation,
  TIMESTAMPED_PARCEL_ATTESTATION_KIND,
  buildTimestampedParcelAttestation,
  validateTimestampedParcelAttestation,
  runParcelTimestampRequest,
  runParcelTimestampWrap,
} = require("../cli/parcel");
const { main } = require("../cli/vh");

// =====================================================================================================
// TEST-ONLY DER token minter — NOT shipped on any command path. =======================================
// (Same minimal encoder as cli.core.rfc3161.test.js; stamps a chosen SHA-256 digest.) ================
// =====================================================================================================

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let x = n;
  while (x > 0) {
    bytes.unshift(x & 0xff);
    x = Math.floor(x / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), derLen(v.length), v]);
}
function derSequence(...parts) {
  return tlv(0x30, Buffer.concat(parts));
}
function derSet(...parts) {
  return tlv(0x31, Buffer.concat(parts));
}
function derOctetString(value) {
  return tlv(0x04, value);
}
function derContext0(value) {
  return tlv(0xa0, value);
}
function derInteger(value) {
  let big = typeof value === "bigint" ? value : BigInt(value);
  if (big < 0n) throw new Error("test minter only encodes non-negative integers");
  let hex = big.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let bytes = Buffer.from(hex, "hex");
  if (bytes.length === 0) bytes = Buffer.from([0x00]);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  return tlv(0x02, bytes);
}
function derOID(dotted) {
  const arcs = dotted.split(".").map((s) => parseInt(s, 10));
  const out = [40 * arcs[0] + arcs[1]];
  for (let i = 2; i < arcs.length; i++) {
    let v = arcs[i];
    const stack = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
function derGeneralizedTime(str) {
  return tlv(0x18, Buffer.from(str, "ascii"));
}

// mintTestToken — TEST-ONLY. DER-encode a minimal valid RFC-3161 TimeStampToken over `digestHex`.
function mintTestToken(opts = {}) {
  const digestHex = (opts.digestHex || "").replace(/^0x/i, "").toLowerCase();
  const hashOID = opts.hashOID || OID.sha256;
  const genTime = opts.genTime || "20260623120000Z";
  const serial = opts.serial !== undefined ? opts.serial : 42;
  const policyOID = opts.policyOID || "1.2.3.4.5";
  const eContentType = opts.eContentType || OID.tstInfo;
  const version = opts.version !== undefined ? opts.version : 1;

  const hashAlg = derSequence(derOID(hashOID), Buffer.from([0x05, 0x00]));
  const messageImprint = derSequence(hashAlg, derOctetString(Buffer.from(digestHex, "hex")));
  const tstInfo = derSequence(
    derInteger(version),
    derOID(policyOID),
    messageImprint,
    derInteger(serial),
    derGeneralizedTime(genTime)
  );
  const encap = derSequence(derOID(eContentType), derContext0(derOctetString(tstInfo)));
  const signedData = derSequence(
    derInteger(3),
    derSet(derSequence(derOID(hashOID), Buffer.from([0x05, 0x00]))),
    encap
  );
  return derSequence(derOID(OID.signedData), derContext0(signedData));
}

// =====================================================================================================

// --- temp-dir isolation: every test gets throwaway dirs, removed in afterEach (pass OR fail) ----------
let tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}
afterEach(function () {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

async function capture(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = (s) => {
    buf += s;
    return true;
  };
  try {
    const ret = await fn();
    return { ret, out: buf };
  } finally {
    process.stdout.write = orig;
  }
}

// Build a dataset manifest + its unsigned attestation + canonical bytes + sha256 digest, all offline.
function datasetFixture(files, prefix) {
  const dir = writeFiles(tmp((prefix || "ts") + "-tree-"), files);
  const manifestPath = path.join(tmp((prefix || "ts") + "-man-"), "manifest.json");
  runDatasetBuild({ dir, out: manifestPath, stdout: () => {} });
  const manifest = readManifest(manifestPath);
  const unsigned = buildAttestation(manifest);
  const canonical = serializeAttestation(unsigned);
  const digest = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
  return { dir, manifestPath, manifest, unsigned, canonical, digest };
}

describe("cli/core/timestamp: detached RFC-3161 timestamp container engine (T-20.2)", function () {
  describe("the engine builds + validates a container from a minted token bound to the digest", function () {
    it("builds a valid timestamped container over the canonical sha256 digest", function () {
      const f = datasetFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "eng-build");
      const token = mintTestToken({ digestHex: f.digest, genTime: "20260623120000Z" });
      const container = buildTimestampedAttestation({ attestation: f.unsigned, token });

      expect(container.kind).to.equal(TIMESTAMPED_ATTESTATION_KIND);
      expect(container.note).to.equal(TIMESTAMPED_ATTESTATION_TRUST_NOTE);
      // The embedded attestation is BYTE-IDENTICAL to serializeAttestation over the same manifest.
      expect(container.attestation).to.equal(f.canonical);
      expect(container.timestamp.scheme).to.equal("rfc3161");
      expect(container.timestamp.hashAlgorithm).to.equal("sha256");
      // The recorded digest IS sha256(canonical bytes) — NOT the keccak manifestDigest.
      expect(container.timestamp.digest).to.equal(f.digest);
      expect(container.timestamp.digest).to.not.equal(f.unsigned.manifestDigest);
      // The token binds that exact digest under SHA-256.
      expect(
        rfc3161.bindsDigest({
          token: container.timestamp.token,
          expectedDigestHex: f.digest,
          expectedHashOID: OID.sha256,
        })
      ).to.equal(true);
    });

    it("round-trips: build -> serialize -> read -> deep-equal", function () {
      const f = datasetFixture({ "x.txt": "X", "y.txt": "Y" }, "eng-rt");
      const token = mintTestToken({ digestHex: f.digest });
      const container = buildTimestampedAttestation({ attestation: f.unsigned, token });

      const bytes = serializeTimestampedAttestation(container);
      expect(bytes.endsWith("\n")).to.equal(true);
      expect(bytes.endsWith("\n\n")).to.equal(false); // exactly one trailing newline
      // No insignificant whitespace at the top level (canonical bytes).
      expect(JSON.stringify(JSON.parse(bytes))).to.equal(bytes.slice(0, -1));

      const outPath = path.join(tmp("eng-rt-out-"), "ts.json");
      fs.writeFileSync(outPath, bytes);
      const back = readTimestampedAttestation(outPath);
      expect(back).to.deep.equal(container);
      expect(serializeTimestampedAttestation(back)).to.equal(bytes);
    });

    it("the wrapped payload PRESERVES the UNSIGNED guarantee verbatim (signed:false/signature:null)", function () {
      const f = datasetFixture({ "a.txt": "AAA" }, "eng-preserve");
      const token = mintTestToken({ digestHex: f.digest });
      const container = buildTimestampedAttestation({ attestation: f.unsigned, token });
      const embedded = JSON.parse(container.attestation);
      expect(embedded.signed).to.equal(false);
      expect(embedded.signature).to.equal(null);
    });

    it("the note REUSES TRUST_NOTE verbatim + the timestamp-specific caveat (no overclaim)", function () {
      const f = datasetFixture({ "a.txt": "AAA" }, "eng-note");
      const token = mintTestToken({ digestHex: f.digest });
      const container = buildTimestampedAttestation({ attestation: f.unsigned, token });
      expect(container.note).to.contain(TRUST_NOTE);
      expect(container.note).to.contain("INDEPENDENT");
      expect(container.note).to.contain("does NOT validate the TSA");
      // It is explicit that the digest is SHA-256, not the internal keccak manifestDigest.
      expect(container.note).to.contain("NOT the project's internal keccak256 manifestDigest");
    });
  });

  describe("the validator REJECTS unsound containers (never half-accepts)", function () {
    it("REJECTS a container whose token binds a DIFFERENT digest", function () {
      const f = datasetFixture({ "a.txt": "AAA" }, "rej-diff");
      // Mint a token over an UNRELATED digest, then hand-build a container that records the REAL digest.
      const otherDigest = "f".repeat(64);
      const wrongToken = mintTestToken({ digestHex: otherDigest });
      const container = {
        kind: TIMESTAMPED_ATTESTATION_KIND,
        schemaVersion: 1,
        note: TIMESTAMPED_ATTESTATION_TRUST_NOTE,
        attestation: f.canonical,
        timestamp: {
          scheme: "rfc3161",
          hashAlgorithm: "sha256",
          digest: f.digest,
          token: wrongToken.toString("base64"),
        },
      };
      expect(() => validateTimestampedAttestation(container)).to.throw(/does NOT bind the digest/i);
    });

    it("REJECTS a container whose embedded attestation was EDITED (wrap-don't-edit)", function () {
      const f = datasetFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "rej-edit");
      const token = mintTestToken({ digestHex: f.digest });
      const container = buildTimestampedAttestation({ attestation: f.unsigned, token });
      // Tamper the embedded canonical bytes (bump fileCount) WITHOUT re-deriving the digest/token: the
      // embedded string is no longer canonical AND no longer matches the recorded digest.
      const edited = JSON.parse(JSON.stringify(container));
      const embedded = JSON.parse(edited.attestation);
      embedded.fileCount = embedded.fileCount + 1;
      edited.attestation = JSON.stringify(embedded) + "\n";
      // It fails on either the canonical-form check or the digest!=sha256 check — both are wrap-don't-edit.
      expect(() => validateTimestampedAttestation(edited)).to.throw();
    });

    it("REJECTS a container whose `digest` != sha256(canonical bytes)", function () {
      const f = datasetFixture({ "a.txt": "AAA" }, "rej-digest");
      const token = mintTestToken({ digestHex: f.digest });
      const container = buildTimestampedAttestation({ attestation: f.unsigned, token });
      const tampered = JSON.parse(JSON.stringify(container));
      // Flip the last hex char of the recorded digest so it no longer equals sha256(bytes).
      const last = tampered.timestamp.digest.slice(-1);
      tampered.timestamp.digest =
        tampered.timestamp.digest.slice(0, -1) + (last === "a" ? "b" : "a");
      expect(() => validateTimestampedAttestation(tampered)).to.throw(
        /sha256\(canonical attestation bytes\)|does NOT bind the digest/i
      );
    });

    it("REJECTS a token that is not a parseable RFC-3161 TimeStampToken", function () {
      const f = datasetFixture({ "a.txt": "AAA" }, "rej-garbage");
      const garbage = Buffer.from([0xff, 0x01, 0x02, 0x03]).toString("base64");
      const container = {
        kind: TIMESTAMPED_ATTESTATION_KIND,
        schemaVersion: 1,
        note: TIMESTAMPED_ATTESTATION_TRUST_NOTE,
        attestation: f.canonical,
        timestamp: { scheme: "rfc3161", hashAlgorithm: "sha256", digest: f.digest, token: garbage },
      };
      expect(() => validateTimestampedAttestation(container)).to.throw(/not a parseable RFC-3161/i);
    });

    it("REJECTS an unsupported timestamp hashAlgorithm (must be sha256, not keccak)", function () {
      const f = datasetFixture({ "a.txt": "AAA" }, "rej-alg");
      const token = mintTestToken({ digestHex: f.digest });
      const container = {
        kind: TIMESTAMPED_ATTESTATION_KIND,
        schemaVersion: 1,
        note: TIMESTAMPED_ATTESTATION_TRUST_NOTE,
        attestation: f.canonical,
        timestamp: {
          scheme: "rfc3161",
          hashAlgorithm: "keccak256",
          digest: f.digest,
          token: token.toString("base64"),
        },
      };
      expect(() => validateTimestampedAttestation(container)).to.throw(/hashAlgorithm/i);
    });

    it("buildTimestampedAttestation hard-errors when the token does not bind the digest", function () {
      const f = datasetFixture({ "a.txt": "AAA" }, "rej-build");
      const wrongToken = mintTestToken({ digestHex: "0".repeat(64) });
      expect(() =>
        buildTimestampedAttestation({ attestation: f.unsigned, token: wrongToken })
      ).to.throw(/does NOT bind the digest/i);
    });
  });
});

describe("vh dataset timestamp-request / timestamp-wrap (T-20.2)", function () {
  it("timestamp-request emits a digest that EQUALS sha256 of the canonical attestation bytes", async function () {
    const f = datasetFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "req");
    const { ret, out } = await capture(() =>
      Promise.resolve(runDatasetTimestampRequest({ manifest: f.manifestPath }))
    );
    expect(ret.hashAlgorithm).to.equal("sha256");
    expect(ret.digest).to.equal(f.digest);
    // The independent crypto recompute matches the engine's digest.
    const recomputed = crypto.createHash("sha256").update(ret.canonical, "utf8").digest("hex");
    expect(ret.digest).to.equal(recomputed);
    // The human output LEADS with the TRUST note and surfaces the digest + an openssl recipe.
    expect(out).to.contain("TRUST:");
    expect(out).to.contain(f.digest);
    expect(out).to.contain("openssl ts -query");
  });

  it("timestamp-request --json round-trips (and IS machine-readable)", async function () {
    const f = datasetFixture({ "x.txt": "X" }, "req-json");
    const { out } = await capture(() =>
      Promise.resolve(runDatasetTimestampRequest({ manifest: f.manifestPath, json: true }))
    );
    const obj = JSON.parse(out);
    expect(obj.hashAlgorithm).to.equal("sha256");
    expect(obj.digest).to.equal(f.digest);
    expect(obj.canonical).to.equal(f.canonical);
  });

  it("timestamp-wrap takes a minted token and writes a validated timestamped container", async function () {
    const f = datasetFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "wrap");
    const token = mintTestToken({ digestHex: f.digest, genTime: "20260623120000Z", serial: 7 });
    const tokenPath = path.join(tmp("wrap-tok-"), "token.der");
    fs.writeFileSync(tokenPath, token);
    const outPath = path.join(tmp("wrap-out-"), "ts.json");

    const { ret, out } = await capture(() =>
      Promise.resolve(
        runDatasetTimestampWrap({ manifest: f.manifestPath, token: tokenPath, out: outPath })
      )
    );
    expect(ret.digest).to.equal(f.digest);
    expect(ret.genTime).to.equal("2026-06-23T12:00:00Z");
    expect(ret.out).to.equal(outPath);
    // The written file is a VALIDATED container that reads back.
    const back = readTimestampedAttestation(outPath);
    expect(back.timestamp.digest).to.equal(f.digest);
    expect(out).to.contain("TRUST:");
    expect(out).to.contain("INDEPENDENT TSA");
  });

  it("timestamp-wrap accepts an INLINE base64 token (not just a file path)", async function () {
    const f = datasetFixture({ "a.txt": "AAA" }, "wrap-inline");
    const token = mintTestToken({ digestHex: f.digest });
    const outPath = path.join(tmp("wrap-inline-out-"), "ts.json");
    const { ret } = await capture(() =>
      Promise.resolve(
        runDatasetTimestampWrap({
          manifest: f.manifestPath,
          token: token.toString("base64"),
          out: outPath,
        })
      )
    );
    expect(ret.digest).to.equal(f.digest);
    expect(readTimestampedAttestation(outPath).timestamp.digest).to.equal(f.digest);
  });

  it("timestamp-wrap --json round-trips and carries the container when there is no --out", async function () {
    const f = datasetFixture({ "a.txt": "AAA" }, "wrap-json");
    const token = mintTestToken({ digestHex: f.digest });
    const { out } = await capture(() =>
      Promise.resolve(
        runDatasetTimestampWrap({
          manifest: f.manifestPath,
          token: token.toString("base64"),
          json: true,
        })
      )
    );
    const obj = JSON.parse(out);
    expect(obj.kind).to.equal(TIMESTAMPED_ATTESTATION_KIND);
    expect(obj.digest).to.equal(f.digest);
    expect(obj.out).to.equal(null);
    // With no --out, the canonical bytes are carried so --json never drops the artifact.
    expect(typeof obj.container).to.equal("string");
    const parsed = JSON.parse(obj.container);
    expect(parsed.timestamp.digest).to.equal(f.digest);
  });

  it("timestamp-wrap ERRORS CLEARLY when the token binds a different digest (exit 1 via main)", async function () {
    const f = datasetFixture({ "a.txt": "AAA" }, "wrap-bad");
    const wrongToken = mintTestToken({ digestHex: "c".repeat(64) });
    const tokenPath = path.join(tmp("wrap-bad-tok-"), "token.der");
    fs.writeFileSync(tokenPath, wrongToken);
    const origErr = process.stderr.write.bind(process.stderr);
    let err = "";
    process.stderr.write = (s) => {
      err += s;
      return true;
    };
    let code;
    try {
      await capture(async () => {
        code = await main(["dataset", "timestamp-wrap", f.manifestPath, "--token", tokenPath]);
      });
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).to.equal(1);
    expect(err).to.match(/does NOT bind the digest/i);
  });

  it("a typo'd flag hard-errors with usage (exit 2; parser parity)", async function () {
    const f = datasetFixture({ "a.txt": "AAA" }, "req-typo");
    const origErr = process.stderr.write.bind(process.stderr);
    let err = "";
    process.stderr.write = (s) => {
      err += s;
      return true;
    };
    let code;
    try {
      await capture(async () => {
        code = await main(["dataset", "timestamp-request", f.manifestPath, "--nope"]);
      });
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).to.equal(2);
    expect(err).to.match(/unknown flag: --nope/);
  });

  it("timestamp-wrap requires --token (exit 2)", async function () {
    const f = datasetFixture({ "a.txt": "AAA" }, "wrap-no-token");
    const origErr = process.stderr.write.bind(process.stderr);
    let err = "";
    process.stderr.write = (s) => {
      err += s;
      return true;
    };
    let code;
    try {
      await capture(async () => {
        code = await main(["dataset", "timestamp-wrap", f.manifestPath]);
      });
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).to.equal(2);
    expect(err).to.match(/requires --token/);
  });
});

describe("vh parcel timestamp-request / timestamp-wrap (T-20.2)", function () {
  // Build a parcel manifest + its unsigned attestation + canonical bytes + sha256 digest, all offline.
  function parcelFixture(files, prefix) {
    const dir = writeFiles(tmp((prefix || "pts") + "-tree-"), files);
    const manifestPath = path.join(tmp((prefix || "pts") + "-man-"), "manifest.json");
    runParcelBuild({ dir, out: manifestPath, stdout: () => {} });
    const manifest = readParcelManifest(manifestPath);
    const unsigned = buildParcelAttestation(manifest);
    const canonical = serializeParcelAttestation(unsigned);
    const digest = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
    return { dir, manifestPath, manifest, unsigned, canonical, digest };
  }

  it("parcel timestamp-request emits a digest = sha256 of the canonical parcel-attestation bytes", async function () {
    const f = parcelFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "preq");
    const { ret } = await capture(() =>
      Promise.resolve(runParcelTimestampRequest({ manifest: f.manifestPath }))
    );
    expect(ret.digest).to.equal(f.digest);
  });

  it("parcel timestamp-wrap builds + validates a container from a minted token", async function () {
    const f = parcelFixture({ "a.txt": "AAA" }, "pwrap");
    const token = mintTestToken({ digestHex: f.digest });
    const outPath = path.join(tmp("pwrap-out-"), "ts.json");
    const { ret } = await capture(() =>
      Promise.resolve(
        runParcelTimestampWrap({
          manifest: f.manifestPath,
          token: token.toString("base64"),
          out: outPath,
        })
      )
    );
    expect(ret.container.kind).to.equal(TIMESTAMPED_PARCEL_ATTESTATION_KIND);
    expect(ret.digest).to.equal(f.digest);
  });

  it("a DATASET timestamped container does NOT cross-validate as a parcel one", function () {
    // A parcel timestamped container minted from a parcel manifest; the dataset validator must reject it,
    // and vice-versa — distinct kinds, no cross-validation.
    const pf = parcelFixture({ "a.txt": "AAA" }, "pcross");
    const ptoken = mintTestToken({ digestHex: pf.digest });
    const pcontainer = buildTimestampedParcelAttestation({ attestation: pf.unsigned, token: ptoken });
    expect(() => validateTimestampedAttestation(pcontainer)).to.throw(/not a verifyhash/i);
  });
});
