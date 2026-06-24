"use strict";

// test/freeseal.parity.test.js — the FREE-TIER seal core parity + acceptance suite (T-36.1).
//
// WHAT THIS PROVES
//   verifier/lib/seal-evidence.js is a PURE, dependency-free `buildEvidenceSeal({ entries })` whose canonical
//   JSON is BYTE-IDENTICAL to what the PAID cli/evidence.js seal path produces for the same { relPath, bytes }
//   set, AND whose output is ACCEPTED by the in-tree verifier/verify-vh.js (exit 0 untouched; exit 3 after a
//   one-byte tamper or a deletion). It also pins the no-drift contract: the free core's framing constants
//   equal the producer's, the module's require-graph touches NO ethers / js-sha3 / parent-dir / cli, and the
//   module exposes NO signing path.
//
// HOW PARITY IS DRIVEN (not asserted against a frozen string)
//   For each randomized folder we drive the REAL paid seal code IN-PROCESS (cli/evidence.js#buildSeal +
//   serializeSeal — the exact functions `vh evidence seal` runs) to get the reference bytes, then compare the
//   free core's bytes to it. So a future change to the producer's canonical shape would break this test, not
//   silently diverge.
//
// FILESYSTEM HYGIENE
//   Every on-disk effect lands in a throwaway temp dir, cleaned up pass-or-fail; the working tree (cwd) is
//   asserted byte-for-byte untouched in afterEach.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { expect } = require("chai");

// The FREE core under test (loaded by relative path; its require-graph is asserted independent below).
const freeseal = require("../verifier/lib/seal-evidence");

// The REAL paid producer — the exact seal path `vh evidence seal` runs in-process (the reference).
const evidence = require("../cli/evidence");

// The in-tree standalone verifier a counterparty runs (read-only; same exit contract 0/3).
const verifyvh = require("../verifier/verify-vh");

// ---------------------------------------------------------------------------
// A tiny seeded PRNG (mulberry32) so the randomized corpus is DETERMINISTIC: a failure reproduces exactly,
// and the suite never flakes. ≥200 folders are generated from a fixed seed.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A pool of name fragments incl. unicode + URL/space-bearing pieces, to stress relPath encoding.
// INCLUDING a literal-backslash base name ("back\\slash"): on POSIX that backslash is a CONTENT byte of
// the file NAME (not a path separator), and the canonical form keeps it verbatim — so the corpus now
// exercises the exact byte class that the original generator (which joined on "/" only) could never reach
// and that the rework flagged as a silent producer-vs-verifier divergence. The free core and the paid
// producer must agree byte-for-byte on it.
const NAME_FRAGMENTS = [
  "a", "b", "file", "data", "report", "README", "x1", "z_9",
  "файл", "ünïcode", "日本語", "café", "naïve", "emoji-😀", "with space", "dash-ed", "dot.name",
  "back\\slash", "tab\\sep",
];
const EXTS = ["", ".txt", ".bin", ".csv", ".json", ".md", ".dat"];
const DIR_FRAGMENTS = ["", "sub", "deep/nest", "a/b/c", "ünï/dir", "with space", "."];

// Build ONE randomized { relPath, bytes } entry set: 1..25 files, varied names/sizes (incl. empty files),
// nested relPaths, unicode names. relPaths are de-duplicated (a duplicate path is a build error in BOTH
// cores, which is its own test below — the corpus exercises the success path).
function randomEntries(rnd) {
  const count = 1 + Math.floor(rnd() * 25); // 1..25
  const entries = [];
  const seen = new Set();
  let guard = 0;
  while (entries.length < count && guard < count * 50) {
    guard++;
    const nDirs = Math.floor(rnd() * 3); // 0..2 nesting segments
    const segs = [];
    for (let i = 0; i < nDirs; i++) {
      const frag = DIR_FRAGMENTS[Math.floor(rnd() * DIR_FRAGMENTS.length)];
      if (frag && frag !== ".") segs.push(frag);
    }
    const base =
      NAME_FRAGMENTS[Math.floor(rnd() * NAME_FRAGMENTS.length)] +
      EXTS[Math.floor(rnd() * EXTS.length)];
    let relPath = [...segs, base].join("/").replace(/\/+/g, "/").replace(/^\.\//, "");
    if (!relPath || relPath.endsWith("/")) continue;
    if (seen.has(relPath)) continue;
    seen.add(relPath);

    // Varied sizes incl. empty (size 0), small, and a few hundred bytes of arbitrary (incl. non-UTF8) bytes.
    const sizeClass = Math.floor(rnd() * 4);
    let size;
    if (sizeClass === 0) size = 0; // empty file
    else if (sizeClass === 1) size = 1 + Math.floor(rnd() * 16);
    else if (sizeClass === 2) size = 1 + Math.floor(rnd() * 200);
    else size = Math.floor(rnd() * 8);
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i++) bytes[i] = Math.floor(rnd() * 256);
    entries.push({ relPath, bytes });
  }
  return entries;
}

describe("free-tier seal core: byte-identical parity with the paid CLI (T-36.1)", function () {
  let tmpDirs;
  let cwdBefore;

  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing the test wrote leaked into the working tree.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });

  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "freeseal-"));
    tmpDirs.push(d);
    return d;
  }

  function cap() {
    let out = "";
    let err = "";
    return {
      io: { write: (s) => (out += s), writeErr: (s) => (err += s) },
      out: () => out,
      err: () => err,
    };
  }

  // -------------------------------------------------------------------------
  // 1) BYTE-IDENTICAL parity over ≥200 randomized folders. For each, drive BOTH cores in-process and assert
  //    the canonical seal bytes are byte-for-byte equal. The input array order is SHUFFLED before the free
  //    core sees it (a separate copy) so we also prove order-independence of the emitted bytes.
  // -------------------------------------------------------------------------

  it("emits canonical seal bytes byte-identical to the paid cli/evidence.js for ≥200 randomized folders", function () {
    const rnd = mulberry32(0xC0FFEE);
    const N = 240; // > 200
    let nonEmptyFileSeen = false;
    let emptyFileSeen = false;
    let unicodeSeen = false;
    let nestedSeen = false;
    let backslashSeen = false;

    for (let k = 0; k < N; k++) {
      const entries = randomEntries(rnd);
      expect(entries.length, `folder ${k} should have 1..25 files`).to.be.within(1, 25);

      for (const e of entries) {
        if (e.bytes.length === 0) emptyFileSeen = true;
        else nonEmptyFileSeen = true;
        if (e.relPath.includes("/")) nestedSeen = true;
        if (e.relPath.includes("\\")) backslashSeen = true;
        // eslint-disable-next-line no-control-regex
        if (/[^\x00-\x7F]/.test(e.relPath)) unicodeSeen = true;
      }

      // PAID reference (the exact functions `vh evidence seal` runs).
      const paidSeal = evidence.buildSeal(entries);
      const paidBytes = evidence.serializeSeal(paidSeal);

      // FREE core, fed a SHUFFLED copy to prove order-independence of the emitted bytes.
      const shuffled = entries
        .map((e) => ({ e, k: rnd() }))
        .sort((a, b) => a.k - b.k)
        .map((x) => ({ relPath: x.e.relPath, bytes: Buffer.from(x.e.bytes) }));
      const freeSeal = freeseal.buildEvidenceSeal({ entries: shuffled });
      const freeBytes = freeseal.serializeEvidenceSeal(freeSeal);

      expect(freeBytes, `seal bytes diverge for randomized folder #${k}`).to.equal(paidBytes);
      // The object the free core returns is itself structurally equal to the paid seal object.
      expect(freeSeal).to.deep.equal(paidSeal);
      // The seal is a NEWLINE-terminated single line (no insignificant whitespace).
      expect(freeBytes.endsWith("\n")).to.equal(true);
      expect(freeBytes.indexOf("\n")).to.equal(freeBytes.length - 1);
    }

    // The corpus actually exercised the varied shapes the acceptance calls out.
    expect(emptyFileSeen, "corpus must include at least one empty file").to.equal(true);
    expect(nonEmptyFileSeen, "corpus must include non-empty files").to.equal(true);
    expect(unicodeSeen, "corpus must include unicode relPaths").to.equal(true);
    expect(nestedSeen, "corpus must include nested relPaths").to.equal(true);
    expect(backslashSeen, "corpus must include a literal-backslash relPath (the rework's blind spot)").to.equal(true);
  });

  // -------------------------------------------------------------------------
  // 1b) THE RELPATH BOUNDARY the original corpus could never reach (the rework's core defect class). The
  //     corpus generator strips leading "./" and joins on "/", so it NEVER produces a literal backslash or a
  //     surviving "./". Those are exactly the inputs where the free core's normalization and the paid
  //     producer's could diverge — so we pin the contract on them DIRECTLY:
  //       * a literal-backslash relPath (legal byte on POSIX) is now a CONTENT byte on BOTH sides, so the
  //         free seal is BYTE-IDENTICAL to the paid producer (the verifier no longer collapses "\\"->"/");
  //       * a leading-"./" relPath is NON-canonical: the free core REJECTS it with a named FreeSealError
  //         (fail-closed), and the paid producer ALSO refuses to mint it — neither path silently produces a
  //         non-reproducible seal for the same logical directory.
  // -------------------------------------------------------------------------

  it("backslash relPaths (legal POSIX bytes) seal BYTE-IDENTICALLY to the paid CLI", function () {
    // A backslash is a literal filename byte on POSIX; the producer keeps it (cli/hash.js#toPosixRel splits
    // on path.sep === "/" there), and the verifier's merkle.toPosixRel now keeps it too. So these byte-match.
    const cases = [
      [{ relPath: "dir\\a.txt", bytes: Buffer.from("hi") }],
      [{ relPath: "weird\\name.txt", bytes: Buffer.alloc(0) }],
      // "a\\b" and "a/b" are DISTINCT files on POSIX (one name has a backslash byte, the other a separator):
      // both cores treat them as two leaves and agree on the root.
      [
        { relPath: "a\\b", bytes: Buffer.from("one") },
        { relPath: "a/b", bytes: Buffer.from("two") },
      ],
    ];
    for (const entries of cases) {
      const freeBytes = freeseal.serializeEvidenceSeal(freeseal.buildEvidenceSeal({ entries }));
      const paidBytes = evidence.serializeSeal(evidence.buildSeal(entries));
      expect(freeBytes, `backslash relPath set ${JSON.stringify(entries.map((e) => e.relPath))} must byte-match the paid seal`).to.equal(
        paidBytes
      );
    }
  });

  it("NON-canonical relPaths (leading ./, backslash-as-separator intent) are FAIL-CLOSED, never silently re-normalized", function () {
    const E = freeseal.FreeSealError;
    // Leading "./" is non-canonical (toPosixRel would strip it): the free core REFUSES it...
    expect(() =>
      freeseal.buildEvidenceSeal({ entries: [{ relPath: "./x", bytes: Buffer.from("hi") }] })
    ).to.throw(E, /canonical POSIX form/);
    // ...and the paid producer also REFUSES to mint it (it does not silently accept "./x" either): so the
    // two paths are SYMMETRIC — neither emits a surprising, non-reproducible seal for "./x".
    expect(() => evidence.buildSeal([{ relPath: "./x", bytes: Buffer.from("hi") }])).to.throw();

    // "./x" + "x" is the SAME logical file twice. Free rejects on the non-canonical "./x" BEFORE dedup; the
    // paid producer rejects it as a duplicate after its own normalization. Both refuse — neither mints a
    // 2-file seal that disagrees on the file set.
    expect(() =>
      freeseal.buildEvidenceSeal({
        entries: [
          { relPath: "./x", bytes: Buffer.from("a") },
          { relPath: "x", bytes: Buffer.from("b") },
        ],
      })
    ).to.throw(E, /canonical POSIX form/);
    expect(() =>
      evidence.buildSeal([
        { relPath: "./x", bytes: Buffer.from("a") },
        { relPath: "x", bytes: Buffer.from("b") },
      ])
    ).to.throw();

    // The rejection message names the canonical form it expected, so a caller can fix the input mechanically.
    let msg = "";
    try {
      freeseal.buildEvidenceSeal({ entries: [{ relPath: "./deep/y", bytes: Buffer.from("z") }] });
    } catch (err) {
      msg = err.message;
    }
    expect(msg).to.contain('"deep/y"'); // the expected canonical form is surfaced
  });

  // -------------------------------------------------------------------------
  // 2) The produced seal is ACCEPTED by the in-tree verifier/verify-vh.js: exit 0 on the untouched copy,
  //    exit 3 after a one-byte tamper of a sealed file, and exit 3 after a deletion. Run over a handful of
  //    randomized folders materialized on disk.
  // -------------------------------------------------------------------------

  it("produces seals verify-vh accepts (exit 0), and rejects after a one-byte tamper or a deletion (exit 3)", function () {
    const rnd = mulberry32(0x5EA1);
    for (let k = 0; k < 12; k++) {
      const entries = randomEntries(rnd);
      const dir = mkTmp();

      // Materialize the folder on disk.
      for (const e of entries) {
        const abs = path.join(dir, e.relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, e.bytes);
      }

      // Mint the FREE seal and write it next to the folder.
      const seal = freeseal.buildEvidenceSeal({ entries });
      const sealPath = path.join(dir, "evidence.vhevidence.json");
      fs.writeFileSync(sealPath, freeseal.serializeEvidenceSeal(seal));

      // (a) untouched -> exit 0
      let c = cap();
      let code = verifyvh.run([sealPath, "--dir", dir, "--json"], c.io);
      expect(code, `folder ${k} untouched should verify OK\n${c.err()}`).to.equal(verifyvh.EXIT.OK);

      // (b) one-byte tamper of the FIRST sealed file -> exit 3
      const target = entries[0];
      const targetAbs = path.join(dir, target.relPath);
      const orig = fs.readFileSync(targetAbs);
      const tampered = Buffer.from(orig);
      if (tampered.length === 0) {
        // An empty file: a one-byte ADD is still a tamper (the content hash changes).
        fs.writeFileSync(targetAbs, Buffer.from([0x01]));
      } else {
        tampered[0] = tampered[0] ^ 0x01; // flip one bit of one byte
        fs.writeFileSync(targetAbs, tampered);
      }
      c = cap();
      code = verifyvh.run([sealPath, "--dir", dir, "--json"], c.io);
      expect(code, `folder ${k} one-byte tamper should REJECT`).to.equal(verifyvh.EXIT.REJECTED);

      // restore the tampered file, then (c) DELETE it -> exit 3
      fs.writeFileSync(targetAbs, orig);
      c = cap();
      code = verifyvh.run([sealPath, "--dir", dir, "--json"], c.io);
      expect(code, `folder ${k} restored should verify OK again`).to.equal(verifyvh.EXIT.OK);

      fs.rmSync(targetAbs);
      c = cap();
      code = verifyvh.run([sealPath, "--dir", dir, "--json"], c.io);
      expect(code, `folder ${k} deletion should REJECT`).to.equal(verifyvh.EXIT.REJECTED);
    }
  });

  // -------------------------------------------------------------------------
  // 3) NO-DRIFT contract: the free core's framing constants equal the paid producer's exported constants, so
  //    the seal `kind` / `note` / `schemaVersion` / SAMPLE_LIMIT can never silently diverge from the paid path.
  // -------------------------------------------------------------------------

  it("pins the framing constants to the paid producer (no drift)", function () {
    expect(freeseal.SEAL_KIND).to.equal(evidence.SEAL_KIND);
    expect(freeseal.SEAL_SCHEMA_VERSION).to.equal(evidence.SEAL_SCHEMA_VERSION);
    expect(freeseal.EVIDENCE_TRUST_NOTE).to.equal(evidence.EVIDENCE_TRUST_NOTE);
    expect(freeseal.SAMPLE_LIMIT).to.equal(evidence.SAMPLE_LIMIT);
  });

  // -------------------------------------------------------------------------
  // 4) The free core enforces the SAME structural strictness as the paid core and the free-tier file cap.
  //    Each rejection is a NAMED FreeSealError, never a silent coercion.
  // -------------------------------------------------------------------------

  it("rejects malformed entry sets with a named FreeSealError (empty, duplicate, non-buffer, bad relPath)", function () {
    const E = freeseal.FreeSealError;
    expect(() => freeseal.buildEvidenceSeal({ entries: [] })).to.throw(E, /non-empty/);
    expect(() => freeseal.buildEvidenceSeal({})).to.throw(E, /array/);
    expect(() => freeseal.buildEvidenceSeal(null)).to.throw(E, /entries/);
    expect(() =>
      freeseal.buildEvidenceSeal({ entries: [{ relPath: "", bytes: Buffer.from("x") }] })
    ).to.throw(E, /non-empty string/);
    expect(() =>
      freeseal.buildEvidenceSeal({
        entries: [
          { relPath: "a", bytes: Buffer.from("x") },
          { relPath: "a", bytes: Buffer.from("y") },
        ],
      })
    ).to.throw(E, /duplicate relPath/);
    expect(() =>
      freeseal.buildEvidenceSeal({ entries: [{ relPath: "a", bytes: "not-a-buffer" }] })
    ).to.throw(E, /Buffer\/Uint8Array/);
  });

  it("refuses to seal MORE than the free SAMPLE_LIMIT files (the paid `evidence_unlimited` surface)", function () {
    const n = freeseal.SAMPLE_LIMIT + 1;
    const entries = [];
    for (let i = 0; i < n; i++) entries.push({ relPath: `f${i}.txt`, bytes: Buffer.from(String(i)) });
    expect(() => freeseal.buildEvidenceSeal({ entries })).to.throw(
      freeseal.FreeSealError,
      /limited to 25 files/
    );
    // Exactly at the cap is fine, and still byte-identical to the paid path.
    const atCap = entries.slice(0, freeseal.SAMPLE_LIMIT);
    const freeBytes = freeseal.serializeEvidenceSeal(freeseal.buildEvidenceSeal({ entries: atCap }));
    const paidBytes = evidence.serializeSeal(evidence.buildSeal(atCap));
    expect(freeBytes).to.equal(paidBytes);
  });

  it("accepts a Uint8Array (not just a Buffer) as entry bytes, byte-identically", function () {
    const u8 = new Uint8Array([104, 105]); // "hi"
    const freeBytes = freeseal.serializeEvidenceSeal(
      freeseal.buildEvidenceSeal({ entries: [{ relPath: "hi.txt", bytes: u8 }] })
    );
    const paidBytes = evidence.serializeSeal(
      evidence.buildSeal([{ relPath: "hi.txt", bytes: u8 }])
    );
    expect(freeBytes).to.equal(paidBytes);
  });

  // -------------------------------------------------------------------------
  // 5) MODULE INDEPENDENCE: the free core's require-graph touches NONE of ethers / js-sha3 (except through
  //    the already-vendored ./keccak shim) / a parent-dir traversal into cli/ — and exposes NO signing path.
  //    (The "no third-party / no ../" greps over the source file itself are an acceptance criterion; this
  //    asserts the live module-graph + source content as a belt-and-suspenders guard.)
  // -------------------------------------------------------------------------

  it("source has no forbidden require (ethers / js-sha3 / parent-dir / bare third-party) and no signing path", function () {
    const src = fs.readFileSync(require.resolve("../verifier/lib/seal-evidence"), "utf8");
    // Strip block of leading-`//` comment lines so the greps test CODE, not the prose that names the bans.
    const code = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    expect(/require\((['"])ethers\1\)/.test(code), "must not require ethers").to.equal(false);
    expect(/require\((['"])js-sha3\1\)/.test(code), "must not require js-sha3").to.equal(false);
    expect(/require\((['"])\.\.\//.test(code), "must not require via ../").to.equal(false);
    // Every require must be a LOCAL ./ path (no bare third-party module name).
    const reqRe = /require\((['"])([^'"]+)\1\)/g;
    let m;
    while ((m = reqRe.exec(code)) !== null) {
      expect(m[2].startsWith("./"), `require("${m[2]}") must be a local ./ path`).to.equal(true);
    }
    // NO signing surface is exported (the free tier mints only the UNSIGNED baseline seal).
    for (const k of Object.keys(freeseal)) {
      expect(/sign/i.test(k), `free core must not export a signing symbol (${k})`).to.equal(false);
    }
  });

  it("the free core's transitive require-graph never loads ethers", function () {
    // Resolve the module graph reachable from seal-evidence.js and assert no `ethers` (or hardhat) entry.
    const seen = new Set();
    function walk(file) {
      const resolved = require.resolve(file);
      if (seen.has(resolved)) return;
      seen.add(resolved);
      const mod = require.cache[resolved];
      if (!mod) {
        require(resolved);
      }
      const cached = require.cache[require.resolve(file)];
      if (cached) {
        for (const child of cached.children) walk(child.id);
      }
    }
    walk("../verifier/lib/seal-evidence");
    const offenders = [...seen].filter((p) => /[\\/]node_modules[\\/](ethers|hardhat)[\\/]/.test(p));
    expect(offenders, "free core must not pull ethers/hardhat").to.deep.equal([]);
  });
});
