"use strict";

// verifier/lib/seal-cli.js — the FREE, ZERO-INSTALL "seal your own folder" PRODUCER, inlined verbatim into
// verifier/dist/seal-vh-standalone.js by verifier/build-standalone.js (T-36.2).
//
// WHY THIS EXISTS
//   EPIC-35 made the FREE VERIFY side zero-install: a counterparty handed ONE sealed packet saves a single
//   file (verify-vh-standalone.js) and runs it — no clone, no `npm install`. The symmetric gap was the FREE
//   PRODUCE side: a stranger who wants to SEAL up to 25 of their OWN files (the free tier) still had to clone
//   the repo and `npm install` the heavy ethers/hardhat stack, because `vh evidence seal` routes through
//   cli/evidence.js -> cli/core/packetseal.js -> cli/hash.js, and cli/hash.js pulls keccak256 from `ethers`.
//   This module is the LAST piece that closes the loop: a from-scratch sealer that `require`s NOTHING but
//   Node core (fs/path) and the verifier's OWN merkle lib (which itself is zero-third-party in the bundle —
//   keccak256 comes from the inlined pure-JS vendored implementation). The emitted bundle lets a prospect
//   PRODUCE a free `vh.evidence-seal` of up to 25 files with NO install, hand it to a counterparty, and have
//   THEM verify it with NO install — the whole organic adoption loop, self-service, before any sales call.
//
// FREE-TIER BOUNDARY (enforced here, not advisory)
//   The free tier is an UNSIGNED seal of up to SAMPLE_LIMIT (25) files. This sealer:
//     * HARD-ERRORS (exit 2) on a folder of MORE than 25 files, naming the paid `evidence_unlimited`
//       entitlement + the full `vh evidence seal` command that unlocks it. It never silently truncates.
//     * has NO `--sign` / `--license` / `--key` flag AT ALL — signing (`evidence_signed`) is the PAID
//       surface and lives only in the full CLI. There is no way to produce a signed packet from this file.
//   So the standalone is strictly the FREE half of the product: a try-before-you-buy producer whose output
//   the paid signed wrap is layered on top of (the bytes this emits are the exact canonical bytes the paid
//   `vh evidence seal --sign` would wrap, so an upgrade re-uses, never re-does, the free seal).
//
// BYTE-FOR-BYTE COMPATIBLE with the producer
//   The seal this emits is BYTE-IDENTICAL to cli/evidence.js#serializeSeal over the same directory: the same
//   `kind`, `schemaVersion`, `note`, `root`, `fileCount`, and per-file { relPath, contentHash, leaf } in the
//   same canonical key order, terminated with one "\n". That is WHY the standalone-produced seal is accepted
//   verbatim by verify-vh-standalone.js (and the in-tree verifier) — the free PRODUCE and free VERIFY halves
//   interoperate with zero install on either side. The merkle convention (pathLeaf / leafHash / nodeHash /
//   sorted-leaf tree) is the verifier's own ./merkle lib, the SAME math the verifier re-derives on the other
//   side, so a seal this builds always re-derives to the same root the verifier recomputes from the bytes.
//
// HONEST POSTURE + I/O DISCIPLINE
//   The seal is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp (the load-bearing `note` is
//   stated once, below, byte-identical to the producer's). This file reads the named folder and writes ONLY
//   the single output file the user names with `-o`/`--out` (or prints to stdout) — it NEVER writes cwd
//   otherwise, opens NO socket, and uses NO key. Same inputs -> byte-identical bytes.

const fs = require("fs");
const path = require("path");

// The verifier's INDEPENDENT merkle convention (pathLeaf / hashBytes / rootFromFlat). In the bundle this is
// the inlined verifier/lib/merkle.js, whose keccak256 is the inlined pure-JS vendored implementation — so the
// whole sealer is zero-third-party. Out of the bundle (direct `node verifier/lib/seal-cli.js`) it resolves to
// the same in-tree merkle lib, which uses js-sha3; either way the math is byte-identical.
const merkle = require("./merkle");

// Exit contract — the SAME as cli/evidence.js's EXIT: 0 ok / 1 IO / 2 usage / 3 gate-fail. The free-tier
// >25-files boundary is a USAGE error (2): the invocation asked for a paid surface the free sealer cannot do.
const EXIT = Object.freeze({ OK: 0, IO: 1, USAGE: 2, FAIL: 3 });

// The free SAMPLE size, byte-identical to cli/evidence.js SAMPLE_LIMIT (25). Sealing MORE requires the paid
// `evidence_unlimited` entitlement via the full `vh evidence seal` command — this free sealer hard-errors.
const SAMPLE_LIMIT = 25;

const SEAL_KIND = "vh.evidence-seal";
const SEAL_SCHEMA_VERSION = 1;

// The TRUST-BOUNDARIES one-liner — BYTE-IDENTICAL to cli/evidence.js EVIDENCE_TRUST_NOTE. The seal's `note`
// field MUST equal this verbatim or the verifier's strict structural check (note must not drift) rejects the
// packet. Stated once here so the standalone can never silently soften the caveat.
const EVIDENCE_TRUST_NOTE =
  "This evidence seal is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp. Its Merkle " +
  "`root` commits to the full set of (relPath, content) pairs in the directory: any edit, rename, add, " +
  "or remove changes the root, and verify RE-DERIVES the root from the bytes you hold and LOCALIZES the " +
  "change to the exact file (MATCH / CHANGED / MISSING / UNEXPECTED). It does NOT prove WHEN the sealing " +
  'happened ("sealed at T" rides the human-owned signing/timestamp trust-root, STRATEGY.md P-3) and it ' +
  "is NOT a legal opinion. The packet is an UNTRUSTED transport container: verify never trusts the " +
  "packet's own stored hashes.";

// ---------------------------------------------------------------------------
// FILESYSTEM WALK — recursively collect every regular file under dirAbs (skipping sockets/fifos/symlinks,
// exactly as cli/hash.js#listFiles does — they have no stable content hash). Returns absolute paths.
// ---------------------------------------------------------------------------
function listFiles(dirAbs) {
  const out = [];
  const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
    // sockets/fifos/symlinks are intentionally skipped (no stable content hash) — same as cli/hash.js.
  }
  return out;
}

// Load a directory into a sorted [{ relPath, bytes }] list. relPath is POSIX-normalized + relative to dirAbs,
// matching cli/evidence.js#loadDirEntries EXACTLY (split on path.sep, join "/"), so the standalone seal
// travels with the directory identically to a producer-built one. Sorted by relPath for determinism.
function loadDirEntries(dirAbs) {
  const files = listFiles(dirAbs);
  const entries = files.map((abs) => {
    const rel = path.relative(dirAbs, abs).split(path.sep).join("/");
    return { relPath: rel, bytes: fs.readFileSync(abs) };
  });
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return entries;
}

// ---------------------------------------------------------------------------
// PURE SEAL BUILD — over the verifier's own merkle convention. Mirrors cli/core/packetseal.js#buildSeal +
// cli/evidence.js#serializeSeal so the emitted bytes are byte-identical to the producer's. Throws a plain
// Error (named in the message) on a structural problem (e.g. a duplicate relPath) — the CLI maps it to exit 3.
// ---------------------------------------------------------------------------

function buildSeal(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("cannot build an evidence seal from zero files");
  }
  // Per-file (relPath, contentHash, leaf), de-duplicated on relPath (a duplicate is a hard error — every
  // entry must occupy a distinct path, matching the producer core's invariant).
  const seen = new Set();
  const files = entries.map((e) => {
    if (typeof e.relPath !== "string" || e.relPath.length === 0) {
      throw new Error("evidence seal entry relPath must be a non-empty string");
    }
    if (seen.has(e.relPath)) {
      throw new Error(`evidence seal has a duplicate relPath across the file set: ${JSON.stringify(e.relPath)}`);
    }
    seen.add(e.relPath);
    const contentHash = merkle.hashBytes(e.bytes);
    const leaf = merkle.pathLeaf(e.relPath, contentHash);
    return { relPath: e.relPath, contentHash, leaf };
  });
  // Emit per-file leaves sorted by relPath so the seal bytes are deterministic regardless of input order
  // (the producer core does the same), then re-derive the root over the SAME convention the verifier uses.
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const root = merkle.rootFromFlat(files.map((f) => ({ relPath: f.relPath, contentHash: f.contentHash })));
  return {
    kind: SEAL_KIND,
    schemaVersion: SEAL_SCHEMA_VERSION,
    note: EVIDENCE_TRUST_NOTE,
    root,
    fileCount: files.length,
    files,
  };
}

// Serialize a built seal to canonical, byte-deterministic bytes — BYTE-IDENTICAL to cli/evidence.js#
// serializeSeal: an EXPLICIT key order, no insignificant whitespace, one trailing "\n". The producer builds
// the same ordered object literal and JSON.stringify(...)+"\n"; reproducing that literal here yields the
// identical bytes the verifier (and `sha256sum`) expect.
function serializeSeal(seal) {
  const canonical = {
    kind: seal.kind,
    schemaVersion: seal.schemaVersion,
    note: seal.note,
    root: seal.root,
    fileCount: seal.fileCount,
    files: seal.files.map((e) => ({
      relPath: e.relPath,
      contentHash: e.contentHash,
      leaf: e.leaf,
    })),
  };
  return JSON.stringify(canonical) + "\n";
}

// ---------------------------------------------------------------------------
// CLI — `seal-vh-standalone.js <folder> [-o <out>] [--json]`.
//   Walks <folder>, enforces the free-tier boundary, builds the UNSIGNED seal, and writes it to -o/--out
//   (caller-named; NEVER cwd) or prints it. There is DELIBERATELY no --sign/--license/--key flag: signing is
//   the paid surface. Exit: 0 ok / 1 IO / 2 usage (incl. the >25-files paid boundary) / 3 seal-build error.
// ---------------------------------------------------------------------------

function usage() {
  return [
    "seal-vh-standalone.js — FREE, zero-install evidence sealer (seal your own folder, hand it to anyone)",
    "",
    "Usage:",
    "  node seal-vh-standalone.js <folder> [-o <out.vhevidence.json>] [--json]",
    "",
    "Walks <folder> and binds every file into ONE tamper-evident `vh.evidence-seal` you can hand to a",
    "counterparty; they verify it with verify-vh-standalone.js — no clone, no `npm install`, on either side.",
    "",
    "FREE tier: an UNSIGNED seal of up to " + SAMPLE_LIMIT + " files. Sealing MORE files, or a SIGNED",
    "attestation wrap, is the PAID surface (`evidence_unlimited` / `evidence_signed`) via `vh evidence seal`.",
    "There is no --sign/--license/--key flag here: this file produces only the free, unsigned seal.",
    "",
    "Exit codes: 0 sealed / 1 IO error / 2 usage (incl. >" + SAMPLE_LIMIT + " files) / 3 seal-build error.",
    "It is READ-ONLY apart from the -o file you name, opens NO network, and uses NO key.",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const opts = { folder: undefined, out: undefined, json: false, _positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (flag) => {
      const v = argv[++i];
      if (v === undefined) {
        const e = new Error(`${flag} requires a value`);
        e.usage = true;
        throw e;
      }
      return v;
    };
    switch (a) {
      case "-o":
      case "--out":
        opts.out = need(a);
        break;
      case "--json":
        opts.json = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        if (a && a.startsWith("-")) {
          const e = new Error(`unknown flag: ${a}`);
          e.usage = true;
          throw e;
        }
        opts._positionals.push(a);
    }
  }
  if (opts._positionals.length > 1) {
    const e = new Error(
      `unexpected extra argument: ${opts._positionals[1]} (seal takes exactly one <folder>)`
    );
    e.usage = true;
    throw e;
  }
  opts.folder = opts._positionals[0];
  return opts;
}

// Run the sealer with an injectable io ({ write, writeErr }) so it is unit-testable without spawning a
// process. Returns the exit code. PURE except for the directory read + the single -o write.
function run(argv, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }
  if (opts.help) {
    write(usage());
    return EXIT.OK;
  }
  if (!opts.folder) {
    writeErr("error: seal-vh-standalone requires a <folder> to seal\n\n");
    writeErr(usage());
    return EXIT.USAGE;
  }

  // Walk the folder (the only read I/O). A missing/unreadable folder or a non-directory is an IO error.
  const dirAbs = path.resolve(opts.folder);
  let stat;
  try {
    stat = fs.statSync(dirAbs);
  } catch (e) {
    writeErr(`error: cannot read folder ${opts.folder}: ${e.message}\n`);
    return EXIT.IO;
  }
  if (!stat.isDirectory()) {
    writeErr(`error: ${opts.folder} is not a directory\n`);
    return EXIT.IO;
  }
  let entries;
  try {
    entries = loadDirEntries(dirAbs);
  } catch (e) {
    writeErr(`error: cannot read folder ${opts.folder}: ${e.message}\n`);
    return EXIT.IO;
  }
  if (entries.length === 0) {
    writeErr(`error: ${opts.folder} contains no files to seal\n`);
    return EXIT.FAIL;
  }

  // FREE-TIER BOUNDARY — hard-error (exit 2) on more than SAMPLE_LIMIT files, naming the paid entitlement +
  // the full command that unlocks it. The free sealer NEVER silently truncates or downgrades.
  if (entries.length > SAMPLE_LIMIT) {
    writeErr(
      `error: this folder has ${entries.length} files, but the FREE sealer seals at most ${SAMPLE_LIMIT}.\n` +
        `Sealing more than ${SAMPLE_LIMIT} files is the PAID "evidence_unlimited" entitlement — use the full ` +
        "command:\n" +
        "  vh evidence seal <folder> --license <file> --vendor <0xaddr>\n" +
        "(The free, zero-install sealer is strictly try-before-you-buy: up to " +
        SAMPLE_LIMIT +
        " files, unsigned.)\n"
    );
    return EXIT.USAGE;
  }

  // Build the UNSIGNED seal. A structural problem (e.g. a duplicate relPath) is a seal-build error (3).
  let seal;
  try {
    seal = buildSeal(entries);
  } catch (e) {
    writeErr(`error: cannot build evidence seal: ${e.message}\n`);
    return EXIT.FAIL;
  }
  const artifactStr = serializeSeal(seal);

  // Write to -o/--out (caller-chosen path; NEVER cwd) or print to stdout (writes nothing to disk).
  let outAbs = null;
  if (opts.out) {
    outAbs = path.resolve(opts.out);
    try {
      fs.writeFileSync(outAbs, artifactStr);
    } catch (e) {
      writeErr(`error: cannot write -o file ${opts.out}: ${e.message}\n`);
      return EXIT.IO;
    }
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          note: EVIDENCE_TRUST_NOTE,
          kind: SEAL_KIND,
          root: seal.root,
          fileCount: seal.fileCount,
          signed: false,
          out: outAbs,
          // With no -o the artifact rides in `artifact` so --json never drops it (parity with the producer).
          artifact: outAbs ? null : artifactStr,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(EVIDENCE_TRUST_NOTE + "\n\n");
    write(
      `sealed ${seal.fileCount} file${seal.fileCount === 1 ? "" : "s"} into an evidence packet — root ${seal.root}\n`
    );
    if (outAbs) {
      write(`  written:      ${outAbs}\n`);
      write(`  verify it:    node verify-vh-standalone.js ${path.basename(outAbs)} --dir <folder>\n`);
    } else {
      write(artifactStr);
    }
  }
  return EXIT.OK;
}

module.exports = {
  EXIT,
  SAMPLE_LIMIT,
  SEAL_KIND,
  SEAL_SCHEMA_VERSION,
  EVIDENCE_TRUST_NOTE,
  listFiles,
  loadDirEntries,
  buildSeal,
  serializeSeal,
  parseArgs,
  usage,
  run,
};

// CLI shim when this file is run directly (out of the bundle). Inside the bundle the boot wrapper drives run().
if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
