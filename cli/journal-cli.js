"use strict";

// cli/journal-cli.js — the DISK-BACKED, verb-shaped surface over the pure INTEGRITY-JOURNAL CORE (T-60.2).
//
// WHY THIS IS A SEPARATE FILE FROM cli/journal.js
//   cli/journal.js is the PURE core (T-60.1): no I/O, no key, no network. That purity is a hard acceptance
//   criterion a STATIC grep in test/journal.core.test.js enforces on the WHOLE core file — it must not even
//   `require("fs")`. This module is where the filesystem/CLI wiring lives so the core stays provably pure:
//   it reads the fs and runs the EXISTING composed verify path, but still holds NO signing material and
//   opens NO socket (append/verify are pure-local file ops).
//
// THE ON-DISK JOURNAL FORMAT — newline-delimited JSON (JSONL)
//   One entry per line, appended in order. JSONL is chosen precisely because an APPEND is STRICTLY ADDITIVE:
//   `fs.appendFileSync` writes exactly the new line's bytes and never rewrites a prior line, so the
//   pre-existing bytes are preserved verbatim (a test asserts prefix-preservation byte-for-byte). A hand-edit
//   to any past line changes that entry's stored fields, so `computeEntryHash` no longer re-derives its
//   `entryHash` and `verifyJournal` LOCALIZES the break at that line's `seq`.
//
// THE EXIT-CODE CONTRACT (shared with `vh verify` / `vh evidence verify`)
//   0 = journal OK / verify ACCEPTED, 3 = drift / broken chain, 2 = usage error, 1 = IO error. This is the
//   SAME 0/3 CI contract the composed verify path uses; a test asserts parity against it (evidence.EXIT).

const fs = require("fs");
const path = require("path");
const evidence = require("./evidence");
const { verifyRequest, VERDICT } = require("./serve-verify");
const {
  appendEntry,
  verifyJournal,
  canonicalize,
  JournalError,
} = require("./journal");

// The shared verify exit-code contract (0 ok / 3 drift / 2 usage / 1 IO). Re-declared from the SAME values
// evidence.EXIT / the CLI verbs use so a test can assert parity rather than trusting a comment.
const JOURNAL_EXIT = Object.freeze({ OK: 0, IO: 1, USAGE: 2, DRIFT: 3 });
// ---------------------------------------------------------------------------------------------------
// buildVerifyBodyFromSeal — read an evidence-seal packet file from disk, load the bytes it REFERENCES,
// and construct the `verifyRequest` transport body. REUSES the existing evidence readers verbatim; the
// composed verdict comes from `verifyRequest` unchanged. Throws a JournalError on an unreadable/invalid
// packet (a caller/IO error), never a silent bad verdict.
// ---------------------------------------------------------------------------------------------------

/**
 * @param {string} artifactPath path to a *.vhevidence.json (unsigned seal) or *.vhevidence.json signed
 *                              container. Resolved; the files it references resolve next to it (or --dir).
 * @param {string|null} dir     optional base dir for the referenced files (default: the packet's dir).
 * @returns {{ body: object }}  a `verifyRequest`-shaped body (kind verify-seal | verify-signed-seal).
 */
function buildVerifyBodyFromSeal(artifactPath, dir) {
  const packetPath = path.resolve(artifactPath);
  let text;
  try {
    text = fs.readFileSync(packetPath, "utf8");
  } catch (e) {
    throw new JournalError(`cannot read artifact ${artifactPath}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new JournalError(`artifact ${artifactPath} is not valid JSON: ${e.message}`);
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new JournalError(`artifact ${artifactPath} must be an evidence-seal packet object`);
  }

  const signed = obj.kind === evidence.SIGNED_SEAL_KIND;
  // For a signed container the sealed file list lives inside the embedded attestation; for an unsigned
  // seal it is the top-level packet. readSeal STRICT-validates either shape (throws on a foreign/edited/
  // wrong-kind packet), so we surface that as a clean JournalError rather than a bad verdict.
  let seal;
  try {
    seal = signed ? evidence.readSeal(obj.attestation) : evidence.readSeal(obj);
  } catch (e) {
    throw new JournalError(`invalid evidence packet ${artifactPath}: ${e.message}`);
  }

  const baseDir = dir != null ? path.resolve(dir) : path.dirname(packetPath);
  const entries = [];
  for (const f of seal.files) {
    const abs = path.resolve(baseDir, f.relPath);
    let bytes;
    try {
      bytes = fs.readFileSync(abs);
    } catch (_) {
      // Absent -> the verify core reports MISSING (a REJECTED content verdict), never an abort. We simply
      // do not supply that entry; verifyRequest/verifySeal localizes it.
      continue;
    }
    entries.push({ relPath: f.relPath, content: bytes.toString("base64"), encoding: "base64" });
  }

  if (signed) {
    // Bind the signed payload to OUR bytes: supplying `entries` makes verifyRequest recompute the canonical
    // seal from them and require a byte-identical match to the signed payload (a drifted file is REJECTED).
    return { body: { kind: "verify-signed-seal", container: obj, entries } };
  }
  return { body: { kind: "verify-seal", seal: obj, entries } };
}

// ---------------------------------------------------------------------------------------------------
// readJournalFile / lastEntry — parse a JSONL journal off disk into the entry array the pure core walks.
// A malformed line is surfaced as a JournalError naming the 1-based line number (never a silent skip).
// ---------------------------------------------------------------------------------------------------

/**
 * Read + parse a JSONL journal file into an ordered entry array. A missing file is treated as an EMPTY
 * journal (the first `append` creates it) — NOT an error. A present-but-unparseable line throws.
 * @param {string} journalPath
 * @returns {object[]} the parsed entries in file order (may be empty).
 */
function readJournalFile(journalPath) {
  const abs = path.resolve(journalPath);
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return []; // absent = empty journal
    throw new JournalError(`cannot read journal ${journalPath}: ${e.message}`);
  }
  const entries = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue; // tolerate a trailing newline / blank lines
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new JournalError(`journal ${journalPath} line ${i + 1} is not valid JSON: ${e.message}`);
    }
    entries.push(obj);
  }
  return entries;
}

/** The last entry of a parsed journal, or null when empty (so appendEntry starts a genesis chain). */
function lastEntry(entries) {
  return entries.length === 0 ? null : entries[entries.length - 1];
}

// ---------------------------------------------------------------------------------------------------
// runJournalAppend(opts, io) — verify <artifact> through the composed path, then append ONE entry line
// to the journal file STRICTLY ADDITIVELY. Exit 0 on a clean append (regardless of the recorded verdict —
// recording a REJECT is a successful append), 2 usage, 1 IO.
//
// NOTE ON the drift case: appending an observation whose verdict is REJECTED is itself a SUCCESSFUL append
// (exit 0) — the journal's job is to RECORD what it saw, tamper-evidently. The drift shows up later at
// `vh journal verify` time only if a PAST line was edited; a recorded REJECT is a faithful entry, not a
// broken chain. The `--json` verdict makes the recorded ACCEPTED/REJECTED machine-readable.
// ---------------------------------------------------------------------------------------------------

/**
 * @param {object} opts { artifact, to, dir?, vendor?, ts?, json? }
 *   - artifact (required) the seal packet to verify + record.
 *   - to       (required) the journal file to append to (created if absent).
 *   - dir      (optional) base dir for the seal's referenced files.
 *   - ts       (optional) a SELF-ASSERTED timestamp to stamp the entry with (default: now, ISO).
 *   - json     (optional) emit the machine verdict envelope to stdout.
 * @param {object} io { write, writeErr }
 * @returns {number} exit code (0 ok / 2 usage / 1 IO)
 */
function runJournalAppend(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.artifact) {
    writeErr("error: `vh journal append` requires an <artifact> (a *.vhevidence.json seal)\n");
    return JOURNAL_EXIT.USAGE;
  }
  if (!opts.to) {
    writeErr("error: `vh journal append` requires --to <journalfile>\n");
    return JOURNAL_EXIT.USAGE;
  }

  // 1) Verify the artifact through the EXISTING composed verify path — the recorded verdict is byte-for-byte
  //    whatever verifyRequest returns (never re-derived here).
  let body;
  try {
    ({ body } = buildVerifyBodyFromSeal(opts.artifact, opts.dir != null ? opts.dir : null));
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return JOURNAL_EXIT.IO;
  }
  const verdict = verifyRequest(body);

  // 2) Read the current journal (absent = empty), chain onto its last entry.
  let existing;
  try {
    existing = readJournalFile(opts.to);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return JOURNAL_EXIT.IO;
  }
  // Guard: never append onto an ALREADY-broken chain (that would bury the break under a new line and make
  // it look sound from the head). A broken existing journal is a clean IO/usage refusal, not an append.
  if (existing.length > 0) {
    const pre = verifyJournal(existing);
    if (!pre.ok) {
      writeErr(
        `error: refusing to append — existing journal ${opts.to} is already broken at seq ${pre.brokenAt}: ${pre.reason}\n`
      );
      return JOURNAL_EXIT.IO;
    }
  }

  const ts = opts.ts !== undefined && opts.ts !== null ? opts.ts : new Date().toISOString();
  let entry;
  try {
    entry = appendEntry(lastEntry(existing), {
      verdict,
      artifact: opts.artifact,
      ts,
    });
  } catch (e) {
    writeErr(`error: could not build journal entry: ${e.message}\n`);
    return JOURNAL_EXIT.IO;
  }

  // 3) Append STRICTLY ADDITIVELY — one canonical JSON line, prior bytes untouched. We serialize the entry
  //    with the SAME recursive key-sorted encoder used for the hash, so the on-disk line re-parses to a
  //    value whose entryHash re-derives identically.
  const line = canonicalize(entry) + "\n";
  try {
    fs.appendFileSync(path.resolve(opts.to), line, "utf8");
  } catch (e) {
    writeErr(`error: cannot append to journal ${opts.to}: ${e.message}\n`);
    return JOURNAL_EXIT.IO;
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          appended: true,
          journal: opts.to,
          seq: entry.seq,
          entryHash: entry.entryHash,
          prevHash: entry.prevHash,
          ts: entry.ts,
          artifact: entry.artifact,
          verdict: verdict.verdict, // ACCEPTED | REJECTED | ERROR — the recorded top-level answer
          recorded: verdict, // the full composed verdict envelope, VERBATIM
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(
      `appended seq ${entry.seq} to ${opts.to} — recorded verdict ${verdict.verdict} for ${opts.artifact}\n` +
        `  entryHash ${entry.entryHash}\n`
    );
  }
  return JOURNAL_EXIT.OK;
}

// ---------------------------------------------------------------------------------------------------
// runJournalVerify(opts, io) — walk the on-disk chain through the pure core. Exit 0 on a sound chain
// (PASS), 3 on a broken chain (naming the drifted artifact + the seq where it drifted, and `brokenAt`),
// 2 usage, 1 IO. This is the SHARED 0/3 verify contract.
// ---------------------------------------------------------------------------------------------------

/**
 * @param {object} opts { journal, json? }
 * @param {object} io   { write, writeErr }
 * @returns {number} exit code (0 PASS / 3 broken / 2 usage / 1 IO)
 */
function runJournalVerify(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.journal) {
    writeErr("error: `vh journal verify` requires a <journalfile>\n");
    return JOURNAL_EXIT.USAGE;
  }

  // A missing journal file is an IO error here (verify was asked to check a file that isn't there) — as
  // opposed to append, where absent means "start a new one".
  const abs = path.resolve(opts.journal);
  if (!fs.existsSync(abs)) {
    writeErr(`error: journal ${opts.journal} does not exist\n`);
    return JOURNAL_EXIT.IO;
  }

  let entries;
  try {
    entries = readJournalFile(opts.journal);
  } catch (e) {
    // A malformed line means SOME past line was hand-edited into non-JSON — that is a tamper, reported on
    // the shared drift exit (3) with a broken-chain verdict rather than a silent IO failure.
    const verdict = { ok: false, brokenAt: null, reason: e.message, journal: opts.journal };
    if (opts.json) {
      write(JSON.stringify({ ...verdict, verdict: "BROKEN" }, null, 2) + "\n");
    } else {
      writeErr(`FAIL: journal ${opts.journal} is BROKEN — ${e.message}\n`);
    }
    return JOURNAL_EXIT.DRIFT;
  }

  const result = verifyJournal(entries);

  // FAILURE MODE 1 — the hash-CHAIN itself is broken (a deleted / reordered / inserted / hand-edited past
  // line). This takes precedence over content drift: a broken chain means we can no longer trust ANY of the
  // recorded verdicts. Report the drifted artifact + the seq where it drifted, plus brokenAt (the index).
  if (!result.ok) {
    const brokenEntry = Number.isInteger(result.brokenAt) ? entries[result.brokenAt] : undefined;
    const driftedArtifact =
      brokenEntry && typeof brokenEntry === "object" && "artifact" in brokenEntry
        ? brokenEntry.artifact
        : null;
    const driftedSeq =
      brokenEntry && typeof brokenEntry === "object" && Number.isInteger(brokenEntry.seq)
        ? brokenEntry.seq
        : result.brokenAt;

    if (opts.json) {
      write(
        JSON.stringify(
          {
            ok: false,
            verdict: "BROKEN",
            journal: opts.journal,
            brokenAt: result.brokenAt,
            seq: driftedSeq,
            artifact: driftedArtifact,
            reason: result.reason,
          },
          null,
          2
        ) + "\n"
      );
    } else {
      writeErr(
        `FAIL: journal ${opts.journal} is BROKEN at seq ${driftedSeq}` +
          (driftedArtifact != null ? ` (artifact ${JSON.stringify(driftedArtifact)})` : "") +
          ` — ${result.reason}\n` +
          `  brokenAt index ${result.brokenAt}\n`
      );
    }
    return JOURNAL_EXIT.DRIFT;
  }

  // FAILURE MODE 2 — the chain is INTACT (every recorded observation is authentic + in order) but SOME
  // recorded observation is itself a DRIFT: its verdict is not ACCEPTED. This is the "integrity OVER TIME"
  // signal — the artifact was verified continuously and one observation FAILED. We report the FIRST such
  // entry: the drifted artifact + the seq where it drifted. A one-shot verify cannot produce this; the
  // journal can, because it recorded every observation tamper-evidently.
  const drift = firstRecordedDrift(entries);
  if (drift) {
    if (opts.json) {
      write(
        JSON.stringify(
          {
            ok: false,
            verdict: "DRIFTED",
            journal: opts.journal,
            count: result.count,
            head: result.head,
            // The chain is sound, so brokenAt is null — nothing was TAMPERED; an observation just FAILED.
            brokenAt: null,
            seq: drift.seq,
            artifact: drift.artifact,
            recordedVerdict: drift.verdict,
            reason: `entry seq ${drift.seq} recorded a ${drift.verdict} verdict for ${JSON.stringify(drift.artifact)}`,
          },
          null,
          2
        ) + "\n"
      );
    } else {
      writeErr(
        `FAIL: journal ${opts.journal} recorded DRIFT at seq ${drift.seq}` +
          (drift.artifact != null ? ` (artifact ${JSON.stringify(drift.artifact)})` : "") +
          ` — recorded verdict ${drift.verdict} (the chain is intact; an observation FAILED)\n`
      );
    }
    return JOURNAL_EXIT.DRIFT;
  }

  // PASS — the chain is unbroken AND every recorded observation was ACCEPTED: continuous integrity from the
  // first entry to the head.
  if (opts.json) {
    write(
      JSON.stringify(
        { ok: true, verdict: "PASS", journal: opts.journal, count: result.count, head: result.head },
        null,
        2
      ) + "\n"
    );
  } else {
    write(
      `PASS: journal ${opts.journal} is unbroken — ${result.count} ` +
        `entr${result.count === 1 ? "y" : "ies"} chain to head ${result.head}, every observation ACCEPTED\n`
    );
  }
  return JOURNAL_EXIT.OK;
}

// Scan an INTACT (already chain-verified) journal for the FIRST entry whose recorded verdict is not
// ACCEPTED. Returns { seq, artifact, verdict } for that entry, or null when every observation was ACCEPTED.
// The recorded verdict lives at `entry.verdict.verdict` (the composed envelope's top-level answer); a
// missing/mis-shaped verdict envelope is itself treated as a drift (fail closed — never a silent PASS).
function firstRecordedDrift(entries) {
  for (const e of entries) {
    const v = e && typeof e === "object" ? e.verdict : undefined;
    const answer = v && typeof v === "object" ? v.verdict : undefined;
    if (answer !== VERDICT.ACCEPTED) {
      return { seq: e.seq, artifact: e.artifact === undefined ? null : e.artifact, verdict: answer === undefined ? "MALFORMED" : answer };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Argument parsing + the `vh journal` dispatcher.
// ---------------------------------------------------------------------------------------------------

/** Parse `journal append` argv into { artifact, to, dir, vendor, ts, json }. Throws on a bad flag. */
function parseAppendArgs(argv) {
  const opts = { artifact: undefined, to: undefined, dir: undefined, vendor: undefined, ts: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--to":
        opts.to = argv[++i];
        if (opts.to === undefined) throw new Error("--to requires a value");
        break;
      case "--dir":
        opts.dir = argv[++i];
        if (opts.dir === undefined) throw new Error("--dir requires a value");
        break;
      case "--vendor":
        opts.vendor = argv[++i];
        if (opts.vendor === undefined) throw new Error("--vendor requires a value");
        break;
      case "--ts":
        opts.ts = argv[++i];
        if (opts.ts === undefined) throw new Error("--ts requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.artifact !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.artifact = a;
    }
  }
  return opts;
}

/** Parse `journal verify` argv into { journal, json }. Throws on a bad flag. */
function parseJournalVerifyArgs(argv) {
  const opts = { journal: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.journal !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.journal = a;
    }
  }
  return opts;
}

function journalUsage() {
  return [
    "vh journal — an APPEND-ONLY, HASH-CHAINED integrity journal of verify verdicts (integrity OVER TIME)",
    "",
    "Usage:",
    "  vh journal append <artifact> --to <journalfile> [--dir <d>] [--ts <ISO>] [--json]",
    "  vh journal verify <journalfile> [--json]",
    "",
    "append VERIFIES <artifact> (a *.vhevidence.json seal / signed container) through the EXISTING composed",
    "  verify path and records the verdict as ONE new, hash-chained line — STRICTLY ADDITIVELY (prior lines",
    "  are never rewritten). Recording a REJECTED verdict is a successful append; the journal's job is to",
    "  faithfully record what it saw. Exit: 0 appended / 2 usage / 1 IO.",
    "verify walks the on-disk chain: a deleted / reordered / inserted / hand-edited past line BREAKS the chain",
    "  and it LOCALIZES the first break — naming the drifted artifact + the seq where it drifted + brokenAt.",
    "  Exit: 0 PASS (unbroken) / 3 BROKEN / 2 usage / 1 IO — the SHARED 0/3 verify contract.",
    "The `ts` is SELF-ASSERTED (the verifier's own wall clock); the journal proves ORDERING + CONTINUITY of",
    "  its OWN observations, and never claims \"unaltered since date T\" until a trust-root signs/timestamps it.",
    "",
  ].join("\n");
}

/**
 * `vh journal <sub> ...` dispatcher. Mirrors the multi-level verb shape of `vh evidence`.
 * @param {string[]} argv the args AFTER "journal"
 * @param {object} io { write, writeErr }
 * @returns {number} exit code
 */
function cmdJournal(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const write = io.write || ((s) => process.stdout.write(s));
  const [sub, ...rest] = argv;

  if (sub === "append") {
    let opts;
    try {
      opts = parseAppendArgs(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return JOURNAL_EXIT.USAGE;
    }
    return runJournalAppend(opts, io);
  }
  if (sub === "verify") {
    let opts;
    try {
      opts = parseJournalVerifyArgs(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return JOURNAL_EXIT.USAGE;
    }
    return runJournalVerify(opts, io);
  }
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    write(journalUsage());
    return sub === undefined ? JOURNAL_EXIT.USAGE : JOURNAL_EXIT.OK;
  }
  writeErr(`error: unknown journal subcommand: ${sub} (expected: append, verify)\n`);
  return JOURNAL_EXIT.USAGE;
}

module.exports = {
  JOURNAL_EXIT,
  buildVerifyBodyFromSeal,
  readJournalFile,
  lastEntry,
  firstRecordedDrift,
  runJournalAppend,
  runJournalVerify,
  parseAppendArgs,
  parseJournalVerifyArgs,
  journalUsage,
  cmdJournal,
};
