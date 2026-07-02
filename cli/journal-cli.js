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
const journalLog = require("./journal-log");

// The shared verify exit-code contract (0 ok / 3 drift / 2 usage / 1 IO). Re-declared from the SAME values
// evidence.EXIT / the CLI verbs use so a test can assert parity rather than trusting a comment.
const JOURNAL_EXIT = Object.freeze({ OK: 0, IO: 1, USAGE: 2, DRIFT: 3 });

// ---------------------------------------------------------------------------------------------------
// T-63.2 — the transparency-log surface over the T-63.1 ordered Merkle-log core (cli/journal-log.js).
// Four STRICTLY-ADDITIVE, VERIFY-ONLY subcommands: tree-head / prove-inclusion / prove-consistency /
// check-proof. All four are read-only (the ONLY write is the --out proof artifact the caller names),
// hold NO key, and bind NO network. `check-proof` is the OFFLINE third-party AUDITOR path: it reads
// ONLY the proof artifact — NEVER the journal — so an auditor can confirm inclusion/append-only-ness
// without ever holding the log (a test runs it with NO journal present under an fs+network guard).
// ---------------------------------------------------------------------------------------------------

// The self-describing proof-artifact kinds (documented schema; T-64.2's witness path consumes these).
const JOURNAL_INCLUSION_PROOF_KIND = "vh-journal-inclusion";
const JOURNAL_CONSISTENCY_PROOF_KIND = "vh-journal-consistency";

// The SAME honesty boundary the journal already carries, applied to the tree head: the head is the log
// holder's OWN commitment. It proves ordering + append-only-ness only RELATIVE to itself; it does NOT
// prove "existed at / unaltered since date T" until a P-3 trust-root signs/timestamps the 32-byte head.
const SELF_ASSERTED_HEAD_NOTE =
  "this tree head is SELF-ASSERTED (the log holder's own commitment to its journal as it stands now); " +
  'it does NOT by itself prove "existed at / unaltered since date T" until a trust-root signs/timestamps the head (P-3)';

// What a check-proof ACCEPT does — and does NOT — mean: the proof verifies RELATIVE to the head embedded
// in the artifact. The auditor must compare that head against one they trust (e.g. a published/signed
// tree head) before relying on it; check-proof itself never sees the journal.
const CHECK_PROOF_NOTE =
  "ACCEPTED means the proof verifies against the head EMBEDDED in the artifact; compare that head " +
  "(size + root) against a tree head you trust (e.g. one the operator published/signed) before relying on it";
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
// Transparency-log helpers (T-63.2): the ordered LEAVES the Merkle log commits to are the journal's
// entry hashes IN FILE ORDER, and every log-shaped command refuses to operate over a broken chain —
// a head/proof over a tampered journal would be a false attestation, so it fails CLOSED on exit 3.
// ---------------------------------------------------------------------------------------------------

/** The ordered Merkle-log leaves of a parsed journal: its entry hashes, in file order. */
function entryLeaves(entries) {
  return entries.map((e) => e.entryHash);
}

// Load + chain-verify a journal for the tree-head/prove-* commands.
// Returns { ok:true, entries } or { ok:false, code, io?, reason, brokenAt } — the caller formats output.
function loadIntactEntries(journalPath) {
  const abs = path.resolve(journalPath);
  if (!fs.existsSync(abs)) {
    return { ok: false, code: JOURNAL_EXIT.IO, io: true, reason: `journal ${journalPath} does not exist` };
  }
  let entries;
  try {
    entries = readJournalFile(journalPath);
  } catch (e) {
    // A non-JSON line means a past line was hand-edited — a tamper, on the shared drift exit (3).
    return { ok: false, code: JOURNAL_EXIT.DRIFT, reason: e.message, brokenAt: null };
  }
  const result = verifyJournal(entries);
  if (!result.ok) {
    return { ok: false, code: JOURNAL_EXIT.DRIFT, reason: result.reason, brokenAt: result.brokenAt };
  }
  return { ok: true, entries };
}

// Shared failure emitter for the load-and-verify preamble of tree-head/prove-*: an absent journal is a
// plain IO error; a broken chain is a BROKEN verdict on exit 3 (JSON when asked) that REFUSES the verb.
function emitLoadFailure(verbLabel, journal, res, opts, io) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  if (res.io) {
    writeErr(`error: ${res.reason}\n`);
    return res.code;
  }
  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: false,
          verdict: "BROKEN",
          journal,
          brokenAt: res.brokenAt === undefined ? null : res.brokenAt,
          reason: `refusing to ${verbLabel} over a broken chain: ${res.reason}`,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    writeErr(
      `FAIL: journal ${journal} is BROKEN — refusing to ${verbLabel} over a broken chain (${res.reason})\n`
    );
  }
  return res.code;
}

// Write a proof artifact to a caller-named path (pretty JSON + trailing newline). Throws on IO failure.
function writeProofArtifact(artifact, outPath) {
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(artifact, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------------------------------
// runJournalTreeHead(opts, io) — print the publishable Signed-Tree-Head-SHAPED commitment { size, root }
// over the journal's ordered entry hashes. Read-only; carries the self-asserted-head honesty note.
// Exit 0 head printed / 3 broken chain / 2 usage / 1 IO.
// ---------------------------------------------------------------------------------------------------

/**
 * @param {object} opts { journal, json? }
 * @param {object} io   { write, writeErr }
 * @returns {number} exit code
 */
function runJournalTreeHead(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.journal) {
    writeErr("error: `vh journal tree-head` requires a <journalfile>\n");
    return JOURNAL_EXIT.USAGE;
  }
  const res = loadIntactEntries(opts.journal);
  if (!res.ok) return emitLoadFailure("compute a tree head", opts.journal, res, opts, io);

  const head = journalLog.treeHead(entryLeaves(res.entries));
  if (head.root === null) {
    // Unreachable over an intact chain (verifyJournal validated every entryHash), but fail CLOSED.
    writeErr(`error: journal ${opts.journal} yielded malformed entry hashes — no head computed\n`);
    return JOURNAL_EXIT.DRIFT;
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          verdict: "HEAD",
          journal: opts.journal,
          size: head.size,
          root: head.root,
          note: SELF_ASSERTED_HEAD_NOTE,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(
      `tree head of ${opts.journal}: { size: ${head.size}, root: ${head.root} }\n` +
        `NOTE: ${SELF_ASSERTED_HEAD_NOTE}\n`
    );
  }
  return JOURNAL_EXIT.OK;
}

// ---------------------------------------------------------------------------------------------------
// runJournalProveInclusion(opts, io) — emit a compact, SELF-CONTAINED inclusion-proof artifact
// { kind:"vh-journal-inclusion", leaf, seq, size, root, path[] } for the entry at --seq. Read-only
// except the --out file the caller names. Exit 0 proved / 3 broken chain / 2 usage / 1 IO.
// ---------------------------------------------------------------------------------------------------

/**
 * @param {object} opts { journal, seq, out?, json? }
 * @param {object} io   { write, writeErr }
 * @returns {number} exit code
 */
function runJournalProveInclusion(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.journal) {
    writeErr("error: `vh journal prove-inclusion` requires a <journalfile>\n");
    return JOURNAL_EXIT.USAGE;
  }
  if (opts.seq === undefined) {
    writeErr("error: `vh journal prove-inclusion` requires --seq <i> (the entry to prove)\n");
    return JOURNAL_EXIT.USAGE;
  }
  if (!/^\d+$/.test(String(opts.seq))) {
    writeErr(`error: --seq must be a non-negative integer, got ${JSON.stringify(opts.seq)}\n`);
    return JOURNAL_EXIT.USAGE;
  }
  const seq = Number(opts.seq);

  const res = loadIntactEntries(opts.journal);
  if (!res.ok) return emitLoadFailure("prove inclusion", opts.journal, res, opts, io);

  const leaves = entryLeaves(res.entries);
  if (leaves.length === 0) {
    writeErr(`error: journal ${opts.journal} has 0 entries — nothing to prove inclusion of\n`);
    return JOURNAL_EXIT.USAGE;
  }
  if (seq >= leaves.length) {
    writeErr(
      `error: --seq ${seq} is out of range — journal ${opts.journal} has ${leaves.length} ` +
        `entr${leaves.length === 1 ? "y" : "ies"} (valid seq: 0..${leaves.length - 1})\n`
    );
    return JOURNAL_EXIT.USAGE;
  }

  const head = journalLog.treeHead(leaves);
  const proof = journalLog.inclusionProof(leaves, seq);
  if (head.root === null || proof === null) {
    writeErr(`error: journal ${opts.journal} yielded malformed entry hashes — no proof emitted\n`);
    return JOURNAL_EXIT.DRIFT;
  }

  // The self-contained, documented artifact: everything check-proof needs, and NOTHING of the log itself.
  const artifact = {
    kind: JOURNAL_INCLUSION_PROOF_KIND,
    journal: opts.journal,
    leaf: proof.leaf,
    seq,
    size: head.size,
    root: head.root,
    path: proof.path,
    note: SELF_ASSERTED_HEAD_NOTE,
  };

  if (opts.out) {
    try {
      writeProofArtifact(artifact, opts.out);
    } catch (e) {
      writeErr(`error: cannot write proof to ${opts.out}: ${e.message}\n`);
      return JOURNAL_EXIT.IO;
    }
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          verdict: "PROVED",
          kind: JOURNAL_INCLUSION_PROOF_KIND,
          journal: opts.journal,
          seq,
          size: head.size,
          root: head.root,
          out: opts.out || null,
          artifact,
        },
        null,
        2
      ) + "\n"
    );
  } else if (opts.out) {
    write(
      `wrote inclusion proof for seq ${seq} of ${opts.journal} to ${opts.out}\n` +
        `  head { size: ${head.size}, root: ${head.root} }\n` +
        `  NOTE: ${SELF_ASSERTED_HEAD_NOTE}\n`
    );
  } else {
    write(JSON.stringify(artifact, null, 2) + "\n");
  }
  return JOURNAL_EXIT.OK;
}

// ---------------------------------------------------------------------------------------------------
// runJournalProveConsistency(opts, io) — emit a SELF-CONTAINED consistency-proof artifact
// { kind:"vh-journal-consistency", first:{size:m,root}, second:{size:n,root}, proof[] } proving the
// current size-n log is an APPEND-ONLY extension of its size---from prefix. Read-only except --out.
// Exit 0 proved / 3 broken chain / 2 usage / 1 IO.
// ---------------------------------------------------------------------------------------------------

/**
 * @param {object} opts { journal, from, out?, json? }
 * @param {object} io   { write, writeErr }
 * @returns {number} exit code
 */
function runJournalProveConsistency(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.journal) {
    writeErr("error: `vh journal prove-consistency` requires a <journalfile>\n");
    return JOURNAL_EXIT.USAGE;
  }
  if (opts.from === undefined) {
    writeErr("error: `vh journal prove-consistency` requires --from <oldSize> (the older tree size)\n");
    return JOURNAL_EXIT.USAGE;
  }
  if (!/^\d+$/.test(String(opts.from)) || Number(opts.from) < 1) {
    writeErr(`error: --from must be an integer >= 1, got ${JSON.stringify(opts.from)}\n`);
    return JOURNAL_EXIT.USAGE;
  }
  const m = Number(opts.from);

  const res = loadIntactEntries(opts.journal);
  if (!res.ok) return emitLoadFailure("prove consistency", opts.journal, res, opts, io);

  const leaves = entryLeaves(res.entries);
  const n = leaves.length;
  if (m > n) {
    writeErr(
      `error: --from ${m} is out of range — journal ${opts.journal} has ${n} ` +
        `entr${n === 1 ? "y" : "ies"} (valid --from: 1..${n})\n`
    );
    return JOURNAL_EXIT.USAGE;
  }

  const firstHead = journalLog.treeHead(leaves.slice(0, m));
  const secondHead = journalLog.treeHead(leaves);
  const proof = journalLog.consistencyProof(leaves, m, n);
  if (firstHead.root === null || secondHead.root === null || proof === null) {
    writeErr(`error: journal ${opts.journal} yielded malformed entry hashes — no proof emitted\n`);
    return JOURNAL_EXIT.DRIFT;
  }

  const artifact = {
    kind: JOURNAL_CONSISTENCY_PROOF_KIND,
    journal: opts.journal,
    first: { size: m, root: firstHead.root },
    second: { size: n, root: secondHead.root },
    proof: proof.path,
    note: SELF_ASSERTED_HEAD_NOTE,
  };

  if (opts.out) {
    try {
      writeProofArtifact(artifact, opts.out);
    } catch (e) {
      writeErr(`error: cannot write proof to ${opts.out}: ${e.message}\n`);
      return JOURNAL_EXIT.IO;
    }
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          verdict: "PROVED",
          kind: JOURNAL_CONSISTENCY_PROOF_KIND,
          journal: opts.journal,
          first: artifact.first,
          second: artifact.second,
          out: opts.out || null,
          artifact,
        },
        null,
        2
      ) + "\n"
    );
  } else if (opts.out) {
    write(
      `wrote consistency proof for ${opts.journal} to ${opts.out}\n` +
        `  first  { size: ${m}, root: ${firstHead.root} }\n` +
        `  second { size: ${n}, root: ${secondHead.root} }\n` +
        `  NOTE: ${SELF_ASSERTED_HEAD_NOTE}\n`
    );
  } else {
    write(JSON.stringify(artifact, null, 2) + "\n");
  }
  return JOURNAL_EXIT.OK;
}

// ---------------------------------------------------------------------------------------------------
// runJournalCheckProof(opts, io) — the OFFLINE third-party AUDITOR command. Reads ONLY the proof
// artifact (NO journal, NO key, NO network) and calls verifyInclusion / verifyConsistency for the
// artifact's kind. ACCEPTED (exit 0) iff the proof verifies; REJECTED (exit 3) on ANY tamper, forge,
// unknown kind, or malformed artifact — fail CLOSED, never a silent pass. 2 usage / 1 IO.
// ---------------------------------------------------------------------------------------------------

/**
 * @param {object} opts { proof, json? }
 * @param {object} io   { write, writeErr }
 * @returns {number} exit code (0 ACCEPTED / 3 REJECTED / 2 usage / 1 IO)
 */
function runJournalCheckProof(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.proof) {
    writeErr("error: `vh journal check-proof` requires a <prooffile>\n");
    return JOURNAL_EXIT.USAGE;
  }

  // NOTE this function touches EXACTLY ONE file: the proof artifact. It never opens the journal (it has
  // no idea where the journal is) and never opens a socket — a test runs it with NO journal present
  // under a guard that trips on any journal/fs-path or network access.
  let text;
  try {
    text = fs.readFileSync(path.resolve(opts.proof), "utf8");
  } catch (e) {
    writeErr(`error: cannot read proof ${opts.proof}: ${e.message}\n`);
    return JOURNAL_EXIT.IO;
  }

  const reject = (reason, extra = {}) => {
    if (opts.json) {
      write(
        JSON.stringify({ ok: false, verdict: "REJECTED", proof: opts.proof, reason, ...extra }, null, 2) + "\n"
      );
    } else {
      writeErr(`REJECTED: proof ${opts.proof} — ${reason}\n`);
    }
    return JOURNAL_EXIT.DRIFT;
  };
  const accept = (summary, extra = {}) => {
    if (opts.json) {
      write(
        JSON.stringify(
          { ok: true, verdict: "ACCEPTED", proof: opts.proof, ...extra, note: CHECK_PROOF_NOTE },
          null,
          2
        ) + "\n"
      );
    } else {
      write(`ACCEPTED: ${summary}\n  NOTE: ${CHECK_PROOF_NOTE}\n`);
    }
    return JOURNAL_EXIT.OK;
  };

  let artifact;
  try {
    artifact = JSON.parse(text);
  } catch (e) {
    // A proof file that does not even parse is a tampered/foreign artifact — REJECTED, never an accept.
    return reject(`not valid JSON: ${e.message}`);
  }
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
    return reject("proof artifact must be a JSON object");
  }

  if (artifact.kind === JOURNAL_INCLUSION_PROOF_KIND) {
    // Rebuild the exact core-shaped proof + head from the self-contained artifact. verifyInclusion is
    // TOTAL on hostile input (returns false, never throws), so a mangled field is a clean REJECT.
    const ok = journalLog.verifyInclusion(
      { leaf: artifact.leaf, leafIndex: artifact.seq, treeSize: artifact.size, path: artifact.path },
      { size: artifact.size, root: artifact.root }
    );
    const detail = { kind: artifact.kind, leaf: artifact.leaf, seq: artifact.seq, size: artifact.size, root: artifact.root };
    if (!ok) {
      return reject(
        "inclusion proof does NOT verify against its own head — a byte of leaf/root/path/seq/size was edited, or the proof is forged",
        detail
      );
    }
    return accept(
      `inclusion proof verifies — leaf ${artifact.leaf} is entry seq ${artifact.seq} under head { size: ${artifact.size}, root: ${artifact.root} }`,
      detail
    );
  }

  if (artifact.kind === JOURNAL_CONSISTENCY_PROOF_KIND) {
    const first = artifact.first;
    const second = artifact.second;
    const ok = journalLog.verifyConsistency(
      {
        firstSize: first !== null && typeof first === "object" ? first.size : undefined,
        secondSize: second !== null && typeof second === "object" ? second.size : undefined,
        path: artifact.proof,
      },
      first,
      second
    );
    const detail = { kind: artifact.kind, first, second };
    if (!ok) {
      return reject(
        "consistency proof does NOT verify — the second head is NOT an append-only extension of the first (a past entry was rewritten, or the proof was edited/forged)",
        detail
      );
    }
    return accept(
      `consistency proof verifies — head { size: ${second && second.size}, root: ${second && second.root} } is an append-only extension of head { size: ${first && first.size}, root: ${first && first.root} }`,
      detail
    );
  }

  return reject(
    `unknown proof kind ${JSON.stringify(artifact.kind)} (expected ${JSON.stringify(JOURNAL_INCLUSION_PROOF_KIND)} or ${JSON.stringify(JOURNAL_CONSISTENCY_PROOF_KIND)})`,
    { kind: artifact.kind === undefined ? null : artifact.kind }
  );
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

// Shared shape for the single-positional-plus-flags T-63.2 verbs. `positional` names the slot for error
// messages; `valueFlags` maps a flag (e.g. "--seq") to the opts key it fills. Throws on a bad flag.
function _parsePositionalWithFlags(argv, positional, valueFlags) {
  const opts = { [positional]: undefined, json: false };
  for (const key of Object.values(valueFlags)) opts[key] = undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(valueFlags, a)) {
      const key = valueFlags[a];
      opts[key] = argv[++i];
      if (opts[key] === undefined) throw new Error(`${a} requires a value`);
      continue;
    }
    if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    if (opts[positional] !== undefined) throw new Error(`unexpected extra argument: ${a}`);
    opts[positional] = a;
  }
  return opts;
}

/** Parse `journal tree-head` argv into { journal, json }. Throws on a bad flag. */
function parseTreeHeadArgs(argv) {
  return _parsePositionalWithFlags(argv, "journal", {});
}

/** Parse `journal prove-inclusion` argv into { journal, seq, out, json }. Throws on a bad flag. */
function parseProveInclusionArgs(argv) {
  return _parsePositionalWithFlags(argv, "journal", { "--seq": "seq", "--out": "out" });
}

/** Parse `journal prove-consistency` argv into { journal, from, out, json }. Throws on a bad flag. */
function parseProveConsistencyArgs(argv) {
  return _parsePositionalWithFlags(argv, "journal", { "--from": "from", "--out": "out" });
}

/** Parse `journal check-proof` argv into { proof, json }. Throws on a bad flag. */
function parseCheckProofArgs(argv) {
  return _parsePositionalWithFlags(argv, "proof", {});
}

function journalUsage() {
  return [
    "vh journal — an APPEND-ONLY, HASH-CHAINED integrity journal of verify verdicts (integrity OVER TIME)",
    "",
    "Usage:",
    "  vh journal append <artifact> --to <journalfile> [--dir <d>] [--ts <ISO>] [--json]",
    "  vh journal verify <journalfile> [--json]",
    "  vh journal tree-head <journalfile> [--json]",
    "  vh journal prove-inclusion <journalfile> --seq <i> [--out <f>] [--json]",
    "  vh journal prove-consistency <journalfile> --from <oldSize> [--out <f>] [--json]",
    "  vh journal check-proof <prooffile> [--json]",
    "",
    "append VERIFIES <artifact> (a *.vhevidence.json seal / signed container) through the EXISTING composed",
    "  verify path and records the verdict as ONE new, hash-chained line — STRICTLY ADDITIVELY (prior lines",
    "  are never rewritten). Recording a REJECTED verdict is a successful append; the journal's job is to",
    "  faithfully record what it saw. Exit: 0 appended / 2 usage / 1 IO.",
    "verify walks the on-disk chain: a deleted / reordered / inserted / hand-edited past line BREAKS the chain",
    "  and it LOCALIZES the first break — naming the drifted artifact + the seq where it drifted + brokenAt.",
    "  Exit: 0 PASS (unbroken) / 3 BROKEN / 2 usage / 1 IO — the SHARED 0/3 verify contract.",
    "tree-head prints the publishable Signed-Tree-Head-SHAPED commitment { size, root } — the RFC-6962",
    "  ordered Merkle head over the journal's entry hashes. The head is SELF-ASSERTED until a trust-root",
    "  signs/timestamps it. Read-only. Exit: 0 head / 3 broken chain / 2 usage / 1 IO.",
    "prove-inclusion emits a compact, SELF-CONTAINED artifact { kind:\"vh-journal-inclusion\", leaf, seq,",
    "  size, root, path[] } proving entry --seq is committed under the current head. Read-only (only the",
    "  --out file is written). Exit: 0 proved / 3 broken chain / 2 usage / 1 IO.",
    "prove-consistency emits { kind:\"vh-journal-consistency\", first:{size,root}, second:{size,root},",
    "  proof[] } proving the current log is an APPEND-ONLY extension of its size---from prefix — the",
    "  \"no history was rewritten\" guarantee, compact. Exit: 0 proved / 3 broken chain / 2 usage / 1 IO.",
    "check-proof is the OFFLINE third-party AUDITOR command: it reads ONLY the proof artifact (NO journal,",
    "  NO key, NO network) and verifies it for its kind. Hand an auditor a tree head + a proof file and",
    "  they confirm inclusion/append-only-ness WITHOUT your log. ACCEPTED means the proof verifies against",
    "  the head EMBEDDED in the artifact — compare that head against one you trust before relying on it.",
    "  Exit: 0 ACCEPTED / 3 REJECTED / 2 usage / 1 IO — the SHARED 0/3 verify contract.",
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
  // The T-63.2 transparency-log verbs: same parse-then-run shape, same shared exit contract.
  const logVerbs = {
    "tree-head": [parseTreeHeadArgs, runJournalTreeHead],
    "prove-inclusion": [parseProveInclusionArgs, runJournalProveInclusion],
    "prove-consistency": [parseProveConsistencyArgs, runJournalProveConsistency],
    "check-proof": [parseCheckProofArgs, runJournalCheckProof],
  };
  if (Object.prototype.hasOwnProperty.call(logVerbs, sub)) {
    const [parse, run] = logVerbs[sub];
    let opts;
    try {
      opts = parse(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return JOURNAL_EXIT.USAGE;
    }
    return run(opts, io);
  }
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    write(journalUsage());
    return sub === undefined ? JOURNAL_EXIT.USAGE : JOURNAL_EXIT.OK;
  }
  writeErr(
    `error: unknown journal subcommand: ${sub} (expected: append, verify, tree-head, prove-inclusion, prove-consistency, check-proof)\n`
  );
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
  // T-63.2 — the transparency-log surface (tree-head / prove-inclusion / prove-consistency / check-proof).
  JOURNAL_INCLUSION_PROOF_KIND,
  JOURNAL_CONSISTENCY_PROOF_KIND,
  SELF_ASSERTED_HEAD_NOTE,
  CHECK_PROOF_NOTE,
  entryLeaves,
  runJournalTreeHead,
  runJournalProveInclusion,
  runJournalProveConsistency,
  runJournalCheckProof,
  parseTreeHeadArgs,
  parseProveInclusionArgs,
  parseProveConsistencyArgs,
  parseCheckProofArgs,
};
