"use strict";

// TrustLedger — cli.js
//
// T-22.4: `vh trust reconcile <bank> <ledger> <rentroll> [--out <dir>]`.
//
// T-27.3: `vh trust serve [--port <n>] [--host <h>]` launches the LOCAL web
// front-door (trustledger/server.js) over this same engine so a non-technical
// broker can drop the three files in a browser. Files are processed in-memory;
// nothing is persisted server-side. Exposing it (nginx/Cloudflare on the broker's
// own domain) is a HUMAN deploy step — it is never auto-deployed.
//
// T-26.2: `vh trust reconcile ... --out <dir> --seal [<file>]` additionally emits a
// TAMPER-EVIDENT reconciliation seal AFTER the packet (binding the 3 source inputs +
// every emitted packet file, and the emitted close when --emit-close is used). The CLI
// does all the file READING and hands seal.js already-loaded { relPath, bytes } entries
// (seal.js stays pure). `--seal` REQUIRES `--out` (no emitted packet, nothing to seal).
// `vh trust verify-seal <sealfile> [--dir <d>] [--json]` independently RE-DERIVES each
// sealed file from disk OFFLINE (no key, no network) and prints ACCEPTED (0) only when
// EVERY file matches, else REJECTED (3) with the per-file CHANGED/MISSING/UNEXPECTED list.
//
// The one command a broker runs: hand it the three files they already have every
// month and it runs the WHOLE pipeline end to end —
//
//   ingest (parse the bank statement, the QuickBooks ledger, the rent roll)
//     -> match (pair bank<->book lines)
//     -> reconcile (the three-balance check + classified exceptions)
//     -> report (a DATED, deterministic, audit-ready HTML + CSV packet)
//
// and prints a single PASS/FAIL line with a CI-gateable exit code.
//
// PER-STATE POLICY (T-23.2): pass `--state <code>` to score under a bundled
// per-state trust-rule policy, or `--policy <file>` for an explicit one. The
// policy overrides exception severities (e.g. a state that makes an NSF reversal
// a hard ERROR) BEFORE the PASS/FAIL verdict and exit code are computed, so the
// gate reflects the REVIEWED severities. With neither flag the built-in baseline
// is used (byte-for-byte unchanged). Supplying both, or an unknown `--state`, is
// a usage error (exit 2). The packet names which policy governed the run and
// surfaces each override's citation; the policy itself is still a DRAFT a CPA/
// counsel must review (it is NOT legal advice).
//
// FILESYSTEM HYGIENE: side-effect files (the packet) are written ONLY to the
// caller-chosen --out directory — never silently to cwd. Without --out the
// command prints the summary + the report to stdout and writes NOTHING, so it is
// safe to run anywhere (and trivially CI-pipeable). The exit code is a stable,
// documented contract: 0 = PASS (ties out, no error-severity finding),
// 3 = FAIL (does not tie out, or an out-of-trust finding), 2 = usage error,
// 1 = an input/IO error (e.g. an unreadable or malformed file).

const fs = require("fs");
const path = require("path");

const ingest = require("./ingest");
const report = require("./report");
const policy = require("./policy");
const close = require("./close");
const seal = require("./seal");
const server = require("./server");
const license = require("./license");
const plans = require("./plans");

// The three reconcile sources, keyed by the broker-facing label used on the
// command line (`--map <source>:<logical>=<header>` and the --map-file top-level
// keys). Shared with inspect's --as so the two commands name sources identically.
const MAP_SOURCES = Object.freeze(["bank", "ledger", "rentroll"]);

// Parse ONE `--map` value into { source?, logical, header }. Accepts either
//   "<logical>=<header>"            (inspect: the source is implied by --as), or
//   "<source>:<logical>=<header>"   (reconcile: which of the three files).
// Malformed syntax (no "=", an empty logical/header, or an unknown source
// prefix) is a USAGE error (exit 2) — a bad flag value, surfaced clearly.
function parseMapArg(raw, { requireSource } = {}) {
  const s = String(raw == null ? "" : raw);
  const eq = s.indexOf("=");
  if (eq === -1) {
    const e = new Error(
      `--map must be <logical>=<header>${
        requireSource ? " (prefixed <source>:<logical>=<header>)" : ""
      } (got "${raw}")`
    );
    e.usage = true;
    throw e;
  }
  let lhs = s.slice(0, eq).trim();
  const header = s.slice(eq + 1); // header kept verbatim (may contain spaces)
  let source;
  const colon = lhs.indexOf(":");
  if (colon !== -1) {
    source = lhs.slice(0, colon).trim().toLowerCase();
    lhs = lhs.slice(colon + 1).trim();
    if (!MAP_SOURCES.includes(source)) {
      const e = new Error(
        `--map source must be one of ${MAP_SOURCES.join("|")} (got "${source}")`
      );
      e.usage = true;
      throw e;
    }
  }
  if (requireSource && source === undefined) {
    const e = new Error(
      `--map for reconcile must be <source>:<logical>=<header> ` +
        `(source one of ${MAP_SOURCES.join("|")}) (got "${raw}")`
    );
    e.usage = true;
    throw e;
  }
  const logical = lhs;
  if (logical === "" || String(header).trim() === "") {
    const e = new Error(
      `--map must be <logical>=<header> with both sides non-empty (got "${raw}")`
    );
    e.usage = true;
    throw e;
  }
  return { source, logical, header };
}

// Read + parse a `--map-file <json>`: a `{ bank|ledger|rentroll: { <logical>:
// <header> } }` per-source mapping. An unreadable file or malformed JSON, a
// non-object body, an unknown top-level source key, or a non-string mapping
// value is a USAGE error (exit 2). Returns { bank?, ledger?, rentroll? } where
// each value is a plain `{ <logical>: <header> }` columnMap.
function readMapFile(file) {
  let text;
  try {
    text = fs.readFileSync(path.resolve(file), "utf8");
  } catch (e) {
    const err = new Error(`cannot read --map-file ${file}: ${e.message}`);
    err.usage = true;
    throw err;
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    const err = new Error(`invalid JSON in --map-file ${file}: ${e.message}`);
    err.usage = true;
    throw err;
  }
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    const err = new Error(
      `--map-file ${file} must be a JSON object of { bank|ledger|rentroll: {logical: header} }`
    );
    err.usage = true;
    throw err;
  }
  const out = {};
  for (const [src, map] of Object.entries(obj)) {
    if (!MAP_SOURCES.includes(src)) {
      const err = new Error(
        `--map-file ${file}: unknown source key "${src}" (expected one of ${MAP_SOURCES.join(
          ", "
        )})`
      );
      err.usage = true;
      throw err;
    }
    if (map == null || typeof map !== "object" || Array.isArray(map)) {
      const err = new Error(
        `--map-file ${file}: "${src}" must map to an object of {logical: header}`
      );
      err.usage = true;
      throw err;
    }
    const cm = {};
    for (const [logical, header] of Object.entries(map)) {
      if (typeof header !== "string" || header.trim() === "") {
        const err = new Error(
          `--map-file ${file}: ${src}.${logical} must be a non-empty header string`
        );
        err.usage = true;
        throw err;
      }
      cm[logical] = header;
    }
    out[src] = cm;
  }
  return out;
}

// Merge per-source maps: --map-file provides the base, individual --map entries
// OVERRIDE it (last-write-wins for a repeated logical). Returns { <source>:
// columnMap } using only sources that have at least one mapping. PURE.
function buildSourceMaps(mapFileMaps, mapArgs) {
  const out = {};
  for (const src of MAP_SOURCES) {
    if (mapFileMaps && mapFileMaps[src]) out[src] = { ...mapFileMaps[src] };
  }
  for (const { source, logical, header } of mapArgs) {
    if (!out[source]) out[source] = {};
    out[source][logical] = header;
  }
  return out;
}

// Exit codes — shared, documented contract (mirrors the dataset/parcel gates:
// 0 PASS, 3 data/gate FAIL, 2 usage, 1 IO/input error).
const EXIT = Object.freeze({ PASS: 0, IO: 1, USAGE: 2, FAIL: 3 });

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

// Parse `reconcile` argv into options. Three positional files (bank, ledger,
// rentroll) in order, plus flags. Unknown flags and missing positionals are
// reported by the caller as usage errors.
function parseReconcileArgs(argv) {
  const opts = {
    bank: undefined,
    ledger: undefined,
    rentroll: undefined,
    out: undefined,
    json: false,
    date: undefined, // override the report date (default: today); MUST be YYYY-MM-DD
    period: undefined, // optional human label for the statement period
    openingBank: 0,
    openingBook: 0,
    toleranceCents: 0,
    bankFormat: undefined, // force "csv" | "ofx" for the bank file
    policyFile: undefined, // explicit per-state policy file (--policy <file>)
    state: undefined, // bundled per-state policy by its state code (--state <code>)
    priorClose: undefined, // prior period's close.json to roll forward FROM (--prior-close <file>)
    emitClose: undefined, // path to write THIS run's close.json TO (--emit-close <file>)
    seal: false, // --seal [<file>] given at all (T-26.2): emit a reconciliation seal
    sealFile: undefined, // caller-named seal path; undefined => default name under --out
    license: undefined, // path to a signed *.vhlicense.json that UNLOCKS the paid surfaces (T-29.2)
    vendor: undefined, // 0x-address the license issuer is pinned to (T-29.2)
    mapArgs: [], // repeatable --map <source>:<logical>=<header> (T-25.3)
    mapFile: undefined, // --map-file <json> per-source column maps (T-25.3)
    _positionals: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--out":
        opts.out = argv[++i];
        break;
      case "--json":
        opts.json = true;
        break;
      case "--date":
        opts.date = argv[++i];
        break;
      case "--period":
        opts.period = argv[++i];
        break;
      case "--opening-bank":
        opts.openingBank = parseCentsArg(argv[++i], "--opening-bank");
        opts.openingBankSet = true;
        break;
      case "--opening-book":
        opts.openingBook = parseCentsArg(argv[++i], "--opening-book");
        opts.openingBookSet = true;
        break;
      case "--tolerance-cents":
        opts.toleranceCents = parseIntArg(argv[++i], "--tolerance-cents");
        break;
      case "--bank-format":
        opts.bankFormat = argv[++i];
        break;
      case "--policy":
        opts.policyFile = argv[++i];
        break;
      case "--state":
        opts.state = argv[++i];
        break;
      case "--license":
        opts.license = argv[++i];
        break;
      case "--vendor":
        opts.vendor = argv[++i];
        break;
      case "--prior-close":
        opts.priorClose = argv[++i];
        break;
      case "--emit-close":
        opts.emitClose = argv[++i];
        break;
      case "--seal": {
        // --seal takes an OPTIONAL <file>. Peek the next token: consume it as the
        // caller-named seal path ONLY when it exists and is not another flag. The
        // three positional files conventionally precede the flags, so this does not
        // swallow them; without a value the seal lands at a default name under --out.
        opts.seal = true;
        const next = argv[i + 1];
        if (next !== undefined && !String(next).startsWith("--")) {
          opts.sealFile = next;
          i++;
        }
        break;
      }
      case "--map":
        // reconcile: source is REQUIRED (three files), so <source>:<logical>=<header>.
        opts.mapArgs.push(parseMapArg(argv[++i], { requireSource: true }));
        break;
      case "--map-file":
        opts.mapFile = argv[++i];
        break;
      default:
        if (a && a.startsWith("--")) {
          const e = new Error(`unknown option: ${a}`);
          e.usage = true;
          throw e;
        }
        opts._positionals.push(a);
    }
  }
  [opts.bank, opts.ledger, opts.rentroll] = opts._positionals;
  return opts;
}

function parseCentsArg(raw, flag) {
  // Reuse ingest's exact dollar->cents parser so --opening-bank "1,234.56" works
  // identically to a file amount (no float drift).
  try {
    return ingest.parseCents(raw, flag);
  } catch (e) {
    const err = new Error(`${flag}: ${e.message}`);
    err.usage = true;
    throw err;
  }
}

function parseIntArg(raw, flag) {
  if (!/^\d+$/.test(String(raw || ""))) {
    const err = new Error(`${flag} must be a non-negative integer (cents)`);
    err.usage = true;
    throw err;
  }
  return Number(raw);
}

// ---------------------------------------------------------------------------
// The license GATE for the paid reconcile surfaces (T-29.2).
//
// Maps each requested PAID flag to the entitlement it needs, then — only when at
// least one paid surface is requested — REQUIRES a valid, vendor-pinned license
// carrying every needed entitlement. Pure of I/O except a single offline read of
// the caller-chosen license file; holds NO signing key (verify is key-free), no
// network. Returns { code } — EXIT.PASS to proceed, EXIT.USAGE to refuse — and
// writes the precise, ACTIONABLE reason to writeErr. Never throws on an ordinary
// refusal (a malformed flag is the only caller error, surfaced as a usage line).
//
// The reason is reported EXACTLY as `verifyLicense` returns it (wrong_issuer /
// expired / not_yet_valid / bad_signature / malformed) so a refusal is never
// ambiguous, and a wrong/expired license NEVER silently downgrades to a free run.
// ---------------------------------------------------------------------------

// Which entitlement each paid reconcile surface requires. The ONLY place the
// flag->entitlement mapping lives, so the gate and the help can never drift.
const PAID_FEATURE_ENTITLEMENTS = Object.freeze([
  {
    requested: (o) => o.state != null || o.policyFile != null,
    entitlement: "multi_state_policy",
    label: "multi-state policy packs (--state/--policy)",
  },
  {
    requested: (o) => o.seal === true,
    entitlement: "seal",
    label: "the tamper-evident reconciliation seal (--seal)",
  },
]);

function gateReconcile(opts, reportDate, writeErr) {
  // Which paid features were requested in THIS run?
  const needed = PAID_FEATURE_ENTITLEMENTS.filter((f) => f.requested(opts));
  if (needed.length === 0) {
    // FREE TIER. No paid surface requested: proceed UNCHANGED. (A stray --license/
    // --vendor with no paid feature is simply ignored — it costs nothing and keeps
    // the free path byte-for-byte identical.)
    return { code: EXIT.PASS };
  }

  const featureList = needed.map((f) => f.label).join(" and ");
  const hasLicense = opts.license != null;
  const hasVendor = opts.vendor != null;

  // Both license sources must be present together — a license file is worthless
  // without the vendor key to PIN it to, and a vendor with no file is nothing to
  // verify. Either alone is a usage error (parser parity with --key-env/--key-file).
  if (!hasLicense && !hasVendor) {
    writeErr(
      `error: ${featureList} ${needed.length > 1 ? "are" : "is"} a PAID feature and ` +
        "requires a license; pass --license <file> --vendor <0xaddr> " +
        "(mint one with `vh trust license issue`, verify it with `vh trust license verify`). " +
        "The FREE tier — baseline-policy reconcile + `vh trust inspect` — needs no license.\n"
    );
    return { code: EXIT.USAGE };
  }
  if (!hasLicense || !hasVendor) {
    writeErr(
      "error: --license and --vendor must be supplied together (a license file is " +
        "verified by pinning it to the vendor key); pass BOTH --license <file> --vendor <0xaddr>\n"
    );
    return { code: EXIT.USAGE };
  }

  // Read the license file OFFLINE (the only I/O). An unreadable/garbled file is a
  // usage error with a key-free message (there is no key in a license anyway).
  let container;
  try {
    const text = fs.readFileSync(path.resolve(opts.license), "utf8");
    container = license.readLicense(text);
  } catch (e) {
    writeErr(`error: cannot read --license file ${opts.license}: ${e.message}\n`);
    return { code: EXIT.USAGE };
  }

  // Verify OFFLINE against the pinned vendor, dated at the run's reportDate. A
  // malformed --vendor is a caller error thrown by verifyLicense — surface it as a
  // usage line, never as a crash, and never echoing anything sensitive.
  let verdict;
  try {
    verdict = license.verifyLicense(container, { now: reportDate, vendorAddress: opts.vendor });
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return { code: EXIT.USAGE };
  }

  if (!verdict.valid) {
    // Report the precise reason verifyLicense returned — never silently downgrade.
    writeErr(
      `error: ${featureList} requires a VALID license, but the supplied license is ` +
        `INVALID (reason: ${verdict.reason}). It does NOT unlock the paid surface; ` +
        "the FREE baseline reconcile remains available without --state/--policy/--seal.\n"
    );
    return { code: EXIT.USAGE };
  }

  // Valid + in-window + correct issuer. Now require EACH requested feature's
  // entitlement to actually be granted. A valid license that does not carry the
  // entitlement still REFUSES (it never grants a feature it was not sold).
  for (const f of needed) {
    if (!license.hasEntitlement(verdict, f.entitlement)) {
      writeErr(
        `error: the supplied license is valid but does NOT include the "${f.entitlement}" ` +
          `entitlement needed for ${f.label}; this license grants only ` +
          `[${verdict.entitlements.join(", ")}]. The FREE baseline reconcile remains available.\n`
      );
      return { code: EXIT.USAGE };
    }
  }

  return { code: EXIT.PASS };
}

// ---------------------------------------------------------------------------
// The pipeline runner (pure of argv; takes resolved options + an injectable
// today() so the CLI passes a real date while tests pass a fixed one).
// ---------------------------------------------------------------------------

// runReconcile reads the three files, runs the pipeline, optionally writes the
// packet, and returns { code, model, summary, written, render }.
//   opts: { bank, ledger, rentroll, out, json, date, period,
//           openingBank, openingBook, toleranceCents, bankFormat }
//   io:   { write, writeErr, today } injectable; defaults to process + a real
//         "YYYY-MM-DD" today only when no explicit --date was given.
function runReconcile(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.bank || !opts.ledger || !opts.rentroll) {
    writeErr(
      "error: `vh trust reconcile` requires three files: <bank> <ledger> <rentroll>\n"
    );
    return { code: EXIT.USAGE };
  }

  // `--seal` seals the EMITTED packet, so there must be a packet on disk to seal.
  // Without --out the command writes NOTHING (it streams to stdout), so --seal has
  // nothing to bind — that is a usage error, surfaced with the fix, not silently
  // ignored (parser parity with --out's other dependents).
  if (opts.seal && !opts.out) {
    writeErr(
      "error: --seal requires --out (there is no emitted packet to seal without a " +
        "--out <dir>); pass --out <dir> [--seal [<file>]]\n"
    );
    return { code: EXIT.USAGE };
  }

  // Report date: explicit --date wins (keeps output reproducible); else today.
  // The function never calls `new Date()` itself when a date is provided, so a
  // test can pin it; the CLI supplies today via io.today.
  let reportDate = opts.date;
  if (reportDate == null) {
    reportDate = (io.today || todayISO)();
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(reportDate || ""))) {
    writeErr(`error: --date must be "YYYY-MM-DD" (got "${reportDate}")\n`);
    return { code: EXIT.USAGE };
  }

  // -- LICENSE GATE (T-29.2). Decide BEFORE any data work. -------------------
  // The FREE tier — baseline-policy reconcile (no --state/--policy), no --seal —
  // needs NO license and behaves byte-for-byte as before so a broker can evaluate
  // the product before buying. The moment a PAID surface is requested
  // (multi-state policy via --state/--policy, or the tamper-evident --seal), a
  // VALID, in-window, vendor-pinned license carrying the matching entitlement is
  // REQUIRED. A missing/expired/wrong-issuer/under-entitled license REFUSES with
  // the precise reason (exit 2, a clear gate) and never silently downgrades to a
  // free result. `now` is the resolved reportDate (the SAME injectable clock the
  // packet is dated under) so verification is offline + deterministic; this path
  // is read-only, holds NO key, and touches NO network.
  const gate = gateReconcile(opts, reportDate, writeErr);
  if (gate.code !== EXIT.PASS) return { code: gate.code };

  // -- Resolve the per-state trust-rule policy (if any). ---------------------
  // `--policy <file>` reads an explicit file; `--state <code>` resolves a bundled
  // fixture by its state code. Supplying BOTH is ambiguous, and an unknown
  // `--state` is unactionable — both are USAGE errors (exit 2), as is a malformed
  // or unreadable policy file (a bad flag value, not a data-file IO error). With
  // neither flag the run uses the built-in baseline severities (policy = null),
  // which is byte-for-byte today's behaviour.
  let activePolicy = null;
  if (opts.policyFile != null && opts.state != null) {
    writeErr(
      "error: --policy and --state are mutually exclusive (choose an explicit " +
        "policy file OR a bundled state code, not both)\n"
    );
    return { code: EXIT.USAGE };
  }
  if (opts.state != null) {
    try {
      activePolicy = policy.resolveState(opts.state);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return { code: EXIT.USAGE };
    }
  } else if (opts.policyFile != null) {
    let policyText;
    try {
      policyText = fs.readFileSync(path.resolve(opts.policyFile), "utf8");
    } catch (e) {
      writeErr(`error: cannot read --policy file ${opts.policyFile}: ${e.message}\n`);
      return { code: EXIT.USAGE };
    }
    try {
      activePolicy = policy.readPolicy(policyText);
    } catch (e) {
      writeErr(`error: invalid --policy file ${opts.policyFile}: ${e.message}\n`);
      return { code: EXIT.USAGE };
    }
  }

  // -- Resolve the prior period's close (--prior-close), if any. -------------
  // Mirrors how --policy is handled: a malformed/unreadable close is a USAGE
  // error (exit 2) — a BAD FLAG VALUE, not a data-file IO error.
  //
  // SEED-then-OVERRIDE. When present, the prior close's `ending` SEEDS this run's
  // opening balances. An explicit --opening-bank/--opening-book then acts as an
  // explicit OVERRIDE of that seed. BUILDER'S CHOICE (documented): a disagreeing
  // override is HONORED but NOTED — we let the broker open where they say (e.g. a
  // documented mid-period adjustment), AND we surface the disagreement on stderr,
  // AND — crucially — the continuity check then compares the OPENING actually used
  // against the prior ending, so a disagreeing override that breaks the chain
  // SHOWS UP as a CONTINUITY_BREAK in the packet (flipping the verdict) rather than
  // being silently swallowed. This is strictly safer than honoring it invisibly:
  // the gap is recorded in the signed packet, not hidden behind a one-line warning.
  let priorClose = null;
  let openingNotes = [];
  if (opts.priorClose != null) {
    let closeText;
    try {
      closeText = fs.readFileSync(path.resolve(opts.priorClose), "utf8");
    } catch (e) {
      writeErr(
        `error: cannot read --prior-close file ${opts.priorClose}: ${e.message}\n`
      );
      return { code: EXIT.USAGE };
    }
    try {
      priorClose = close.readClose(closeText);
    } catch (e) {
      writeErr(
        `error: invalid --prior-close file ${opts.priorClose}: ${e.message}\n`
      );
      return { code: EXIT.USAGE };
    }

    // Seed each leg from the prior ending UNLESS the broker explicitly overrode it.
    if (!opts.openingBankSet) {
      opts.openingBank = priorClose.ending.bank;
    } else if (opts.openingBank !== priorClose.ending.bank) {
      openingNotes.push(
        `note: --opening-bank ${opts.openingBank} overrides the prior close's ` +
          `ending bank balance ${priorClose.ending.bank}; the roll-forward ` +
          "continuity check below will flag the resulting gap"
      );
    }
    if (!opts.openingBookSet) {
      opts.openingBook = priorClose.ending.book;
    } else if (opts.openingBook !== priorClose.ending.book) {
      openingNotes.push(
        `note: --opening-book ${opts.openingBook} overrides the prior close's ` +
          `ending book balance ${priorClose.ending.book}; the roll-forward ` +
          "continuity check below will flag the resulting gap"
      );
    }
  }
  for (const n of openingNotes) writeErr(`${n}\n`);

  // -- Read the three files (IO errors are exit 1, not a crash). -------------
  let bankText;
  let ledgerText;
  let rentText;
  try {
    bankText = fs.readFileSync(path.resolve(opts.bank), "utf8");
  } catch (e) {
    writeErr(`error: cannot read bank file ${opts.bank}: ${e.message}\n`);
    return { code: EXIT.IO };
  }
  try {
    ledgerText = fs.readFileSync(path.resolve(opts.ledger), "utf8");
  } catch (e) {
    writeErr(`error: cannot read ledger file ${opts.ledger}: ${e.message}\n`);
    return { code: EXIT.IO };
  }
  try {
    rentText = fs.readFileSync(path.resolve(opts.rentroll), "utf8");
  } catch (e) {
    writeErr(`error: cannot read rent-roll file ${opts.rentroll}: ${e.message}\n`);
    return { code: EXIT.IO };
  }

  // -- Resolve the per-source column maps (--map-file + --map). --------------
  // A malformed --map-file (unreadable, bad JSON, unknown source key) is a USAGE
  // error (a bad flag value, exit 2) — same class as a bad --policy file. The
  // individual --map flags were already syntax-validated in the arg parser.
  let sourceMaps;
  try {
    const mapFileMaps = opts.mapFile != null ? readMapFile(opts.mapFile) : null;
    sourceMaps = buildSourceMaps(mapFileMaps, opts.mapArgs || []);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return { code: EXIT.USAGE };
  }

  // -- Validate the resolved column maps up front (USAGE, not IO). -----------
  // A STRUCTURALLY-INVALID column map (an unknown logical key, OR a mapped-to
  // header absent from the file) is a BAD FLAG VALUE — the same error class as a
  // malformed --map-file (readMapFile, exit 2) and as inspect's preview. Without
  // this pre-flight the IDENTICAL mistake routed through an inline --map would
  // fall through to the strict-ingest try/catch below and exit 1 (IO), splitting
  // one broker mistake across exit 1/2/3 by flag form. We validate here, BEFORE
  // any row parsing, reusing the SAME parseCSV + schema + validateColumnMap the
  // strict parser uses, so a bad map exits 2 regardless of which flag carried it.
  // The message (already naming the available headers/fields) is unchanged.
  try {
    ingest.validateColumnMapForSource(ingest.SOURCE.BANK, bankText, sourceMaps.bank, {
      format: opts.bankFormat,
    });
    ingest.validateColumnMapForSource(
      ingest.SOURCE.QUICKBOOKS,
      ledgerText,
      sourceMaps.ledger
    );
    ingest.validateColumnMapForSource(
      ingest.SOURCE.RENT_ROLL,
      rentText,
      sourceMaps.rentroll
    );
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return { code: EXIT.USAGE };
  }

  // -- Ingest (a malformed row is a clear, located error -> exit 1). ---------
  // The resolved column maps thread into BOTH the bank/QB/rent parsers, so a
  // file whose headers no alias matches still loads under an explicit map. A
  // structurally-invalid map was already rejected (USAGE) by the pre-flight
  // above; any IngestError reaching this catch is a genuine data/row problem.
  let bank;
  let book;
  let rentroll;
  try {
    bank = ingest.parseBankStatement(bankText, {
      format: opts.bankFormat,
      columnMap: sourceMaps.bank,
    });
    book = ingest.parseQuickBooksCSV(ledgerText, { columnMap: sourceMaps.ledger });
    rentroll = ingest.parseRentRollCSV(rentText, {
      columnMap: sourceMaps.rentroll,
    });
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return { code: EXIT.IO };
  }

  // -- Build the packet model (match + reconcile inside). --------------------
  let model;
  try {
    model = report.buildPacket({
      bank,
      book,
      rentroll,
      reportDate,
      period: opts.period,
      opening: { bank: opts.openingBank || 0, book: opts.openingBook || 0 },
      toleranceCents: opts.toleranceCents || 0,
      policy: activePolicy,
      priorClose,
      emitClosePath: opts.emitClose != null ? path.resolve(opts.emitClose) : null,
    });
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return { code: EXIT.IO };
  }

  const summary = report.summaryLine(model);
  // T-43.2: the ROOT-CAUSE triage headline, printed as a SECOND human line AFTER
  // the verdict summary (which stays byte-for-byte the existing first line). It
  // names the make-or-break distinction at first contact — a genuine OUT-OF-TRUST
  // finding vs. a data-shape gap to fix and re-run vs. nothing to fix. It is
  // PURELY additive: it never changes the PASS/FAIL verdict or the exit code.
  const triageLine = report.triageHeadline(model);
  const render = report.renderPacket(model);
  const code = model.pass ? EXIT.PASS : EXIT.FAIL;

  // -- Emit THIS run's period close (--emit-close), if requested. ------------
  // Built PURELY from the packet model (close.buildClose) and written ONLY to the
  // caller-named path — never silently to cwd, exactly like the packet. The close
  // round-trips through close.readClose so the next month's --prior-close consumes
  // it. This run's verdict/exit code is unaffected by emitting it.
  let closeWritten = null;
  if (opts.emitClose != null) {
    const closePath = path.resolve(opts.emitClose);
    let closeArtifact;
    try {
      closeArtifact = close.buildClose(model);
    } catch (e) {
      writeErr(`error: cannot build --emit-close artifact: ${e.message}\n`);
      return { code: EXIT.IO };
    }
    try {
      const parent = path.dirname(closePath);
      fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(closePath, JSON.stringify(closeArtifact, null, 2) + "\n");
    } catch (e) {
      writeErr(
        `error: cannot write --emit-close file ${opts.emitClose}: ${e.message}\n`
      );
      return { code: EXIT.IO };
    }
    closeWritten = closePath;
  }

  // -- Output. ---------------------------------------------------------------
  let written = [];
  let sealWritten = null;
  if (opts.out) {
    // Write the packet ONLY into the caller-chosen directory. Create it if
    // missing (recursively), but never write outside it and never to cwd.
    const outDir = path.resolve(opts.out);
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (e) {
      writeErr(`error: cannot create --out directory ${opts.out}: ${e.message}\n`);
      return { code: EXIT.IO };
    }
    try {
      for (const name of Object.keys(render).sort()) {
        const p = path.join(outDir, name);
        fs.writeFileSync(p, render[name]);
        written.push(p);
      }
    } catch (e) {
      writeErr(`error: cannot write packet into ${opts.out}: ${e.message}\n`);
      return { code: EXIT.IO };
    }

    // -- Emit the reconciliation seal (--seal), AFTER every packet file (and the
    //    emitted close, if any) is on disk. The CLI does ALL the file READING here
    //    and hands seal.js already-loaded { relPath, bytes } entries — seal.js stays
    //    PURE. The seal binds the 3 SOURCE inputs (by their logical role) + every
    //    emitted packet file (+ the emitted close, if --emit-close) into ONE
    //    content-addressed root.
    //
    //    PORTABLE relPaths (REWORK Finding 1). The deliverable is "the packet a broker
    //    hands a state examiner months later." For that handoff to verify, the sealed
    //    relPaths must NOT depend on the producing machine's on-disk layout:
    //      * OUTPUTS live in the out dir, so they are sealed by their BASENAME
    //        (path.relative(sealDir, abs) is already the basename when the seal sits in
    //        the same dir — the common case; a caller-named seal elsewhere still resolves).
    //      * INPUTS are the 3 ORIGINAL sources, which may live ANYWHERE (a month folder,
    //        a sibling tree, an absolute path). Sealing them by a seal-dir-relative path
    //        would (a) escape the packet dir as `../bank.csv` so shipping ONLY the out/
    //        folder reports them MISSING, and (b) leak the producing machine's absolute
    //        home path when the sources live outside the out tree — and make the root
    //        depend on that layout, breaking "same inputs => same root." So inputs are
    //        sealed by their BASENAME: the broker ships each source NEXT TO the seal and
    //        `vh trust verify-seal` finds it with no machine-specific offset. (Inputs may
    //        be located elsewhere at verify time via `verify-seal --inputs <dir>`.)
    if (opts.seal) {
      const sealPath = opts.sealFile
        ? path.resolve(opts.sealFile)
        : path.join(outDir, `reconciliation-${reportDate}-seal.json`);
      const sealDir = path.dirname(sealPath);

      // The seal can never seal ITSELF (it does not exist yet, and its bytes depend
      // on the very set being hashed). A caller-named seal path landing inside the
      // packet dir is fine — it is simply not one of the sealed entries.
      const relTo = (abs) => path.relative(sealDir, abs);

      // Inputs: the 3 ORIGINAL sources, read from their original location, tagged
      // with the seal's logical roles (bank / book / rentroll). ledger -> "book".
      // Sealed by BASENAME so the binding travels with the packet (see header note).
      const inputSpecs = [
        { role: "bank", abs: path.resolve(opts.bank) },
        { role: "book", abs: path.resolve(opts.ledger) },
        { role: "rentroll", abs: path.resolve(opts.rentroll) },
      ];
      // Outputs: every emitted packet file, PLUS the emitted close if --emit-close
      // was used (so the seal binds the WHOLE emitted artifact set).
      const outputAbs = [...written];
      if (closeWritten) outputAbs.push(closeWritten);

      // Guard the basename-flattening: if two inputs (or an input and an output) would
      // collide on the same name once flattened, the partition becomes ambiguous and
      // seal.buildSeal would (correctly) reject a duplicate relPath. Surface it here as
      // an actionable IO error naming the colliding name rather than a generic build error.
      const inputRel = inputSpecs.map((s) => ({ ...s, relPath: path.basename(s.abs) }));
      const outputRel = outputAbs.map((abs) => ({ abs, relPath: relTo(abs) }));
      const seenName = new Map();
      for (const r of [...inputRel, ...outputRel]) {
        if (seenName.has(r.relPath)) {
          writeErr(
            `error: cannot build seal: two sealed files flatten to the same name ` +
              `${JSON.stringify(r.relPath)} (rename a source so the bank/book/rentroll ` +
              `inputs and the packet files each have a distinct filename)\n`
          );
          return { code: EXIT.IO };
        }
        seenName.set(r.relPath, true);
      }

      let files;
      try {
        files = {
          inputs: inputRel.map((s) => ({
            role: s.role,
            relPath: s.relPath,
            bytes: fs.readFileSync(s.abs),
          })),
          outputs: outputRel.map((o) => ({
            relPath: o.relPath,
            bytes: fs.readFileSync(o.abs),
          })),
        };
      } catch (e) {
        writeErr(`error: cannot read a file to seal: ${e.message}\n`);
        return { code: EXIT.IO };
      }

      let sealObj;
      try {
        sealObj = seal.buildSeal({
          files,
          verdict: {
            pass: model.pass,
            reportDate: model.reportDate,
            period: model.period == null ? null : model.period,
          },
        });
      } catch (e) {
        writeErr(`error: cannot build seal: ${e.message}\n`);
        return { code: EXIT.IO };
      }

      try {
        fs.mkdirSync(sealDir, { recursive: true });
        fs.writeFileSync(sealPath, seal.serializeSeal(sealObj));
      } catch (e) {
        writeErr(`error: cannot write seal file ${sealPath}: ${e.message}\n`);
        return { code: EXIT.IO };
      }
      sealWritten = sealPath;
    }

    if (opts.json) {
      write(
        JSON.stringify(
          { ...model, summary, written, outDir, closeWritten, sealWritten },
          null,
          2
        ) + "\n"
      );
    } else {
      write(`${summary}\n`);
      write(`${triageLine}\n`);
      for (const p of written) write(`wrote ${p}\n`);
      if (closeWritten) write(`wrote close ${closeWritten}\n`);
      if (sealWritten) write(`wrote seal ${sealWritten}\n`);
    }
  } else {
    // No --out: print the summary + the HTML report to stdout, write NOTHING
    // (except the explicitly caller-named --emit-close file, already written).
    if (opts.json) {
      write(JSON.stringify({ ...model, summary, closeWritten }, null, 2) + "\n");
    } else {
      write(`${summary}\n`);
      write(`${triageLine}\n`);
      if (closeWritten) write(`wrote close ${closeWritten}\n`);
      const htmlName = report.packetFilenames(reportDate).html;
      write("\n");
      write(render[htmlName]);
    }
  }

  return { code, model, summary, written, render, closeWritten, sealWritten };
}

// Real "today" as a UTC YYYY-MM-DD. The ONLY impure call in this module, isolated
// here and injectable so the pipeline itself stays deterministic.
function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// `vh trust inspect` (T-25.2) — read-only file validator / preview
// ---------------------------------------------------------------------------
//
// The onboarding companion to `reconcile`. `reconcile` fails CLOSED (the first
// malformed row aborts the whole file) because a trust reconciliation must never
// silently partial-parse. That is correct for the gate, but it is a DEAD END
// when a broker first feeds the tool a real export: they get one error and no
// path forward. `inspect` turns that dead end into a self-service fix.
//
// It runs `diagnoseSource` over ONE file and prints, for that file: the detected
// header; the logical->header column map (or "(not found)"); the OK/total parse
// count; a small SAMPLE of normalized records; and EVERY failing row (number +
// reason). When a required column is missing OR any row failed it prints an
// ACTIONABLE hint and exits 3 (the data-gate FAIL code); a fully-clean file
// exits 0. It is STRICTLY read-only: it writes NOTHING anywhere — no packet, no
// receipt, not even with a path flag. It does NOT reconcile or attest; it only
// checks that the file PARSES into the normalized model.

// Map the broker-facing `--as` value to the ingest SOURCE. The three logical
// kinds a reconcile consumes: a bank statement, a QuickBooks ledger, a rent roll.
const INSPECT_AS = Object.freeze({
  bank: ingest.SOURCE.BANK,
  ledger: ingest.SOURCE.QUICKBOOKS,
  rentroll: ingest.SOURCE.RENT_ROLL,
});

// Parse `inspect` argv: one positional <file>, plus flags. Unknown flags and a
// missing/duplicate positional are USAGE errors (parser parity with reconcile —
// a typo never silently returns a wrong view). `--as` is REQUIRED and validated.
function parseInspectArgs(argv) {
  const opts = {
    file: undefined,
    as: undefined,
    bankFormat: undefined,
    json: false,
    sample: undefined, // sample size (default applied by the runner)
    mapArgs: [], // repeatable --map <logical>=<header> (source = --as) (T-25.3)
    mapFile: undefined, // --map-file <json> per-source column maps (T-25.3)
    _positionals: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--as":
        opts.as = argv[++i];
        if (opts.as === undefined) {
          const e = new Error("--as requires a value");
          e.usage = true;
          throw e;
        }
        break;
      case "--bank-format":
        opts.bankFormat = argv[++i];
        if (opts.bankFormat === undefined) {
          const e = new Error("--bank-format requires a value");
          e.usage = true;
          throw e;
        }
        break;
      case "--json":
        opts.json = true;
        break;
      case "--sample":
        opts.sample = parseIntArg(argv[++i], "--sample");
        break;
      case "--map":
        // inspect: a single file, so the source is implied by --as; an optional
        // <source>: prefix is still accepted (and must agree with --as later).
        opts.mapArgs.push(parseMapArg(argv[++i], { requireSource: false }));
        break;
      case "--map-file":
        opts.mapFile = argv[++i];
        break;
      default:
        if (a && a.startsWith("--")) {
          const e = new Error(`unknown option: ${a}`);
          e.usage = true;
          throw e;
        }
        opts._positionals.push(a);
    }
  }
  if (opts._positionals.length > 1) {
    const e = new Error(
      `unexpected extra argument: ${opts._positionals[1]} ` +
        "(inspect takes exactly one <file>)"
    );
    e.usage = true;
    throw e;
  }
  opts.file = opts._positionals[0];
  return opts;
}

// Pretty-print signed integer cents as a signed dollar string (e.g. -75000 ->
// "-750.00"). Pure; used only for the human SAMPLE table.
function fmtCents(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// The standing TrustLedger caveat the output LEADS with, and the inspect-specific
// scope note. Centralized so the human and (commented) JSON paths agree.
const INSPECT_CAVEAT =
  "TrustLedger AIDS reconciliation; the broker remains the responsible custodian.";
const INSPECT_SCOPE =
  "`inspect` only checks that this file PARSES into the normalized model — it does " +
  "NOT reconcile or attest anything. To reconcile, run `vh trust reconcile`.";

// Render the diagnostic report as the human inspect view. Pure: takes the
// report + resolved opts, returns a string. Leads with the caveat + scope, then
// the header, the logical->header map, the OK/total count, the sample, every
// failing row, and (when anything is wrong) the actionable hint.
function renderInspect(report, opts) {
  const L = [];
  L.push(`# vh trust inspect — ${opts.as} (${opts.file})`);
  L.push(INSPECT_CAVEAT);
  L.push(INSPECT_SCOPE);
  L.push("");

  // Detected format (CSV vs OFX/QFX) — honest about which path ran, so an OFX
  // bank export is recognized rather than mis-read as a one-column CSV.
  if (report.format) {
    L.push(`detected format: ${report.format}`);
  }

  // Detected header columns (CSV header row, or the OFX tags we read).
  L.push(
    `${report.format === "ofx" ? "OFX tags" : "header columns"} ` +
      `(${report.header.length}): ` +
      (report.header.length ? report.header.join(", ") : "(none)")
  );
  L.push("");

  // Logical field -> header it mapped to (or "(not found)").
  L.push("logical field -> header column:");
  for (const logical of Object.keys(report.mapped)) {
    const mapped = report.mapped[logical];
    const req = report.requiredMissing.includes(logical) ? " [REQUIRED]" : "";
    L.push(`  ${logical}: ${mapped == null ? "(not found)" : mapped}${req}`);
  }
  L.push("");

  // Parse count.
  L.push(`parsed: ${report.okCount} OK of ${report.rowCount} data row(s)`);

  // Sample of normalized records (date / signed-cents / kind / party / memo).
  L.push("");
  if (report.sample.length) {
    L.push(`sample (first ${report.sample.length} normalized record(s)):`);
    for (const r of report.sample) {
      L.push(
        `  ${r.date}  ${fmtCents(r.amount).padStart(12)}  ${r.kind}  ` +
          `${r.party || "(no party)"}  | ${r.memo || ""}`.trimEnd()
      );
    }
  } else {
    L.push("sample: (no rows parsed)");
  }

  // Every failing row with its number + reason.
  L.push("");
  if (report.errors.length) {
    L.push(`failures (${report.errors.length}):`);
    for (const e of report.errors) {
      const where = e.row == null ? "file" : `row ${e.row}`;
      L.push(`  ${where}: ${e.message}`);
    }
  } else {
    L.push("failures: none");
  }

  // Actionable hint when a required column is missing OR any row failed.
  const hint = inspectHint(report);
  if (hint.length) {
    L.push("");
    L.push("how to fix:");
    for (const h of hint) L.push(`  - ${h}`);
  }

  L.push("");
  return L.join("\n");
}

// Build the actionable hint lines: for each missing required column, name the
// accepted aliases the broker can rename/add a column to. A row-level failure
// (with all required columns present) gets a generic "fix the cells" line.
// Returns [] when the file is fully clean.
//
// T-25.3: the no-edit column-mapping override now EXISTS, so each missing-column
// hint also names the WORKING `--map <logical>=<header>` escape hatch — a broker
// whose header no alias matches can map it WITHOUT editing the export. The hint
// only ever advertises what the tool can actually do today, and following it
// (rename/add a column OR pass --map) succeeds — never a dead end.
function inspectHint(report) {
  const out = [];
  for (const logical of report.requiredMissing) {
    const aliases = ingest.aliasesFor(report.source, logical);
    out.push(
      `the "${logical}" column was not found — rename your column to (or add) ` +
        `one named one of [${aliases.join(", ")}], OR map your existing header ` +
        `with --map ${logical}=<your header>`
    );
  }
  // The amount group (signed amount OR a split pair) is reported as a file-level
  // error rather than a missing single column; surface its own add-a-column hint.
  for (const e of report.errors) {
    if (e.row == null && /needs an "amount" column|debit\/credit|payment\/charge/.test(e.message)) {
      out.push(
        `${e.message} — rename/add one of those columns, OR map your existing ` +
          `header(s) with --map <logical>=<your header>`
      );
    }
  }
  // Row-level failures with the header otherwise intact: a per-row data problem.
  const rowFails = report.errors.filter((e) => e.row != null);
  if (rowFails.length) {
    out.push(
      `${rowFails.length} row(s) above failed to parse — fix the listed cells, ` +
        "then re-run `vh trust inspect` until 0 failures before `vh trust reconcile`"
    );
  }
  return out;
}

// runInspect: read the one file, run diagnoseSource, render, and return
// { code, report, render }. Read-only — writes NOTHING. Exit contract:
//   0 = clean (every required column present AND every row parsed),
//   3 = data-gate FAIL (a required/amount column missing OR any row failed),
//   2 = usage error (bad --as), 1 = IO error (unreadable file) — consistent
//   with `reconcile`.
function runInspect(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.file) {
    writeErr("error: `vh trust inspect` requires a <file>\n");
    return { code: EXIT.USAGE };
  }
  if (opts.as == null) {
    writeErr(
      "error: `vh trust inspect` requires --as <bank|ledger|rentroll>\n"
    );
    return { code: EXIT.USAGE };
  }
  const source = INSPECT_AS[opts.as];
  if (!source) {
    writeErr(
      `error: --as must be one of bank|ledger|rentroll (got "${opts.as}")\n`
    );
    return { code: EXIT.USAGE };
  }
  if (
    opts.bankFormat != null &&
    opts.bankFormat !== "csv" &&
    opts.bankFormat !== "ofx"
  ) {
    writeErr(
      `error: --bank-format must be "csv" or "ofx" (got "${opts.bankFormat}")\n`
    );
    return { code: EXIT.USAGE };
  }

  // Resolve the column map for THIS file (the source is `--as`). --map-file may
  // carry per-source maps; only the entry for this --as applies. A bare --map
  // (no <source>: prefix) targets this --as; a prefixed --map MUST agree with it.
  // Malformed --map-file is a USAGE error, mirroring reconcile.
  let columnMap;
  try {
    const mapFileMaps = opts.mapFile != null ? readMapFile(opts.mapFile) : null;
    // Re-scope each --map onto this --as: a bare --map targets it; a prefixed
    // --map MUST agree with it (a plain loop, not a throwing filter callback).
    const scoped = [];
    for (const m of opts.mapArgs || []) {
      if (m.source !== undefined && m.source !== opts.as) {
        const e = new Error(
          `--map source "${m.source}" does not match --as ${opts.as}`
        );
        e.usage = true;
        throw e;
      }
      scoped.push({ ...m, source: opts.as });
    }
    const merged = buildSourceMaps(mapFileMaps, scoped);
    columnMap = merged[opts.as];
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return { code: EXIT.USAGE };
  }

  // Read the file (an unreadable file is exit 1, not a crash) — read-only.
  let text;
  try {
    text = fs.readFileSync(path.resolve(opts.file), "utf8");
  } catch (e) {
    writeErr(`error: cannot read file ${opts.file}: ${e.message}\n`);
    return { code: EXIT.IO };
  }

  // Run the diagnostic core. It is PURE and side-effect-free.
  let report;
  try {
    report = ingest.diagnoseSource(source, text, {
      sampleSize: opts.sample == null ? 5 : opts.sample,
      // Honour --bank-format (csv|ofx) for --as bank; undefined => auto-detect.
      // Only meaningful for the bank source, ignored by diagnoseSource otherwise.
      format: opts.bankFormat,
      // The SAME map the reconcile run would use, so inspect previews identically.
      columnMap,
    });
  } catch (e) {
    // diagnoseSource only throws on an unknown source (already guarded above) or
    // a genuine (non-ingest) bug; treat as an input error rather than crashing.
    writeErr(`error: ${e.message}\n`);
    return { code: EXIT.IO };
  }

  // Verdict: clean iff every required column is present AND every row parsed.
  const clean = report.requiredMissing.length === 0 && report.errors.length === 0;
  const code = clean ? EXIT.PASS : EXIT.FAIL;

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ...report,
          file: opts.file,
          as: opts.as,
          clean,
          code,
          hint: inspectHint(report),
          caveat: INSPECT_CAVEAT,
          scope: INSPECT_SCOPE,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(renderInspect(report, opts));
  }

  return { code, report, render: undefined };
}

function cmdInspect(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  let opts;
  try {
    opts = parseInspectArgs(argv);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }
  return runInspect(opts, io).code;
}

// ---------------------------------------------------------------------------
// `vh trust verify-seal <sealfile>` (T-26.2) — read-only, OFFLINE seal verify
// ---------------------------------------------------------------------------
//
// The independent companion to `reconcile --seal`. Given ONLY the seal file (+
// the files it names), re-derive each listed file's content hash and the manifest
// root from the bytes on disk and compare against the seal's stored expectation.
// It needs NO key, NO network, NO contract — purely the seal core's `verifySeal`.
//
// Files are resolved RELATIVE TO the seal file's directory by default (the seal
// stores relPaths relative to where it was written), or relative to --dir. Prints
// ACCEPTED only when EVERY sealed file MATCHes (no CHANGED/MISSING/UNEXPECTED, no
// role swap, AND the root re-derives); otherwise REJECTED with the precise per-file
// list and a non-zero exit. Exit contract mirrors the rest of the family:
//   0 ACCEPTED, 3 REJECTED, 2 usage (bad flag), 1 IO (unreadable/missing seal).
//
// The output LEADS with the standing custodian/trust caveat + the seal posture
// (tamper-evidence, NOT a trusted timestamp; the CPA review still governs).

// The caveat the verify-seal output LEADS with — the custodian responsibility +
// the honest seal posture. Stated here so the human + JSON paths agree.
const VERIFY_SEAL_CAVEAT =
  "The broker remains the responsible trust-account custodian. A seal is TAMPER-EVIDENT, " +
  "NOT a trusted timestamp (a matching seal proves the bytes are byte-for-byte what was " +
  "sealed, NOT when the sealing happened) and NOT a legal opinion (the CPA review still " +
  "governs). verify-seal RE-DERIVES the root from the files on disk — it never trusts the " +
  "seal's own stored hashes.";

// Parse `verify-seal` argv: one positional <sealfile>, plus --dir / --json. Unknown
// flags and a missing/duplicate positional are USAGE errors (parser parity with
// reconcile/inspect — a typo never silently changes what is verified).
function parseVerifySealArgs(argv) {
  const opts = { sealfile: undefined, dir: undefined, inputsDir: undefined, json: false, _positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dir":
        opts.dir = argv[++i];
        if (opts.dir === undefined) {
          const e = new Error("--dir requires a value");
          e.usage = true;
          throw e;
        }
        break;
      case "--inputs":
        // Locate the SOURCE inputs (bank/book/rentroll) in a dir distinct from the
        // packet outputs. Default: the same base dir as the outputs (the portable
        // handoff ships the sources NEXT TO the seal). Useful when the examiner keeps
        // the originals in a separate folder from the emitted packet.
        opts.inputsDir = argv[++i];
        if (opts.inputsDir === undefined) {
          const e = new Error("--inputs requires a value");
          e.usage = true;
          throw e;
        }
        break;
      case "--json":
        opts.json = true;
        break;
      default:
        if (a && a.startsWith("--")) {
          const e = new Error(`unknown option: ${a}`);
          e.usage = true;
          throw e;
        }
        opts._positionals.push(a);
    }
  }
  if (opts._positionals.length > 1) {
    const e = new Error(
      `unexpected extra argument: ${opts._positionals[1]} ` +
        "(verify-seal takes exactly one <sealfile>)"
    );
    e.usage = true;
    throw e;
  }
  opts.sealfile = opts._positionals[0];
  return opts;
}

// Render the human verify-seal report. PURE: takes the verifySeal result + context,
// returns a string. Leads with the caveat, then the verdict + the precise per-file
// CHANGED/MISSING/UNEXPECTED/role lists.
function renderVerifySeal(result, ctx) {
  const L = [];
  L.push(`# vh trust verify-seal — ${ctx.sealfile}`);
  L.push(VERIFY_SEAL_CAVEAT);
  L.push("");
  L.push(`sealed root:     ${result.sealedRoot}`);
  L.push(`recomputed root: ${result.recomputedRoot}`);
  L.push(`root matches:    ${result.rootMatches ? "yes" : "NO"}`);
  L.push(
    `sealed verdict:  ${ctx.verdict.pass ? "PASS" : "FAIL"} ` +
      `(reportDate ${ctx.verdict.reportDate}` +
      `${ctx.verdict.period ? `, period ${ctx.verdict.period}` : ""})`
  );
  L.push(
    `files: ${result.counts.matched} matched, ${result.counts.changed} changed, ` +
      `${result.counts.missing} missing, ${result.counts.unexpected} unexpected, ` +
      `${result.counts.roleMismatched} role-mismatched`
  );
  L.push("");
  if (result.accepted) {
    L.push("ACCEPTED — every sealed file re-derives byte-for-byte and the root matches.");
  } else {
    L.push("REJECTED — the files on disk do NOT match the seal:");
    for (const c of result.changed) {
      L.push(
        `  CHANGED    ${c.relPath}${c.role ? ` (${c.role})` : ""}: ` +
          `sealed ${c.expectedContentHash} != on-disk ${c.actualContentHash}`
      );
    }
    for (const m of result.missing) {
      L.push(`  MISSING    ${m.relPath}${m.role ? ` (${m.role})` : ""}: sealed but not found on disk`);
    }
    for (const u of result.unexpected) {
      L.push(`  UNEXPECTED ${u.relPath}: on disk but not named in the seal`);
    }
    for (const r of result.roleMismatches) {
      L.push(
        `  ROLE       ${r.relPath}: sealed as ${r.sealedRole} but supplied as ${r.suppliedRole}`
      );
    }
    if (!result.rootMatches && result.changed.length === 0 && result.missing.length === 0 &&
        result.unexpected.length === 0 && result.roleMismatches.length === 0) {
      L.push("  ROOT       the recomputed root does not equal the sealed root");
    }
  }
  L.push("");
  return L.join("\n");
}

// runVerifySeal: load the seal, resolve + read every listed file, recompute via
// verifySeal, print the verdict, return { code, result }. Read-only — writes NOTHING.
function runVerifySeal(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.sealfile) {
    writeErr("error: `vh trust verify-seal` requires a <sealfile>\n");
    return { code: EXIT.USAGE };
  }

  // Load + STRICT-validate the seal BEFORE any sealed file is read — a malformed or
  // missing seal hard-errors loudly (exit 1), never half-accepted nor treated as
  // "everything changed".
  const sealPath = path.resolve(opts.sealfile);
  let sealText;
  try {
    sealText = fs.readFileSync(sealPath, "utf8");
  } catch (e) {
    writeErr(`error: cannot read seal file ${opts.sealfile}: ${e.message}\n`);
    return { code: EXIT.IO };
  }
  let sealObj;
  try {
    sealObj = seal.readSeal(sealText);
  } catch (e) {
    writeErr(`error: invalid seal file ${opts.sealfile}: ${e.message}\n`);
    return { code: EXIT.IO };
  }

  // Resolve OUTPUT files relative to --dir (if given) else the seal file's own
  // directory — the seal stored output relPaths relative to where it was written.
  // INPUT files (the bank/book/rentroll sources, sealed by basename) resolve relative
  // to --inputs (if given) else the SAME base dir as the outputs — the portable
  // handoff ships the sources next to the seal, so the default just works.
  const baseDir = opts.dir != null ? path.resolve(opts.dir) : path.dirname(sealPath);
  const inputsDir = opts.inputsDir != null ? path.resolve(opts.inputsDir) : baseDir;

  // Read every sealed entry's bytes from disk. A file the seal NAMES but that is
  // absent must NOT abort — it is a MISSING finding the verify localizes. So we
  // skip unreadable sealed files here (omitting them from the supplied set makes
  // verifySeal report them MISSING); a present file's broken read surfaces the same
  // way. Only the SEAL itself being unreadable is the IO hard-error above. verifySeal
  // tolerates a PARTIAL supplied set, so even an all-absent set routes through it and
  // is localized honestly (present files are recomputed; only genuinely-absent ones
  // are MISSING) — no synthesized "everything missing" shortcut that would mislabel a
  // co-located packet file as MISSING (REWORK Finding 2).
  const files = { inputs: [], outputs: [] };
  for (const e of sealObj.inputs) {
    const abs = path.resolve(inputsDir, e.relPath);
    let bytes;
    try {
      bytes = fs.readFileSync(abs);
    } catch (_) {
      continue; // absent -> verifySeal reports MISSING
    }
    files.inputs.push({ role: e.role, relPath: e.relPath, bytes });
  }
  for (const e of sealObj.outputs) {
    const abs = path.resolve(baseDir, e.relPath);
    let bytes;
    try {
      bytes = fs.readFileSync(abs);
    } catch (_) {
      continue; // absent -> verifySeal reports MISSING
    }
    files.outputs.push({ relPath: e.relPath, bytes });
  }

  let result;
  try {
    result = seal.verifySeal(sealObj, files);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return { code: EXIT.IO };
  }

  const code = result.accepted ? EXIT.PASS : EXIT.FAIL;

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ...result,
          sealfile: opts.sealfile,
          dir: baseDir,
          inputsDir,
          verdictSealed: sealObj.verdict,
          caveat: VERIFY_SEAL_CAVEAT,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(renderVerifySeal(result, { sealfile: opts.sealfile, verdict: sealObj.verdict }));
  }

  return { code, result };
}

function cmdVerifySeal(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  let opts;
  try {
    opts = parseVerifySealArgs(argv);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }
  return runVerifySeal(opts, io).code;
}

// ---------------------------------------------------------------------------
// `vh trust serve [--port <n>] [--host <h>] [--out <dir>]` (T-27.3)
// ---------------------------------------------------------------------------
//
// Launch the local web front-door over the engine — the broker-facing door so a
// non-technical custodian can open a browser, drop their three monthly files, and
// watch the balances tie out WITHOUT a terminal. It REUSES `server.js` VERBATIM:
// this is only the CLI plumbing that parses the port/host, binds the http.Server,
// and prints the URL. The pipeline itself is unchanged.
//
// FILE PRIVACY POSTURE (stated in-band + in docs): the server processes the three
// uploaded files PURELY in memory and persists NOTHING server-side. There is no
// `--out` for serve — a long-lived public server must never silently accumulate a
// broker's trust-account files on its disk. (The CLI `vh trust reconcile --out` is
// the path that WRITES a packet, and only to a caller-chosen dir.)
//
// HUMAN DEPLOY STEP (never auto-deployed): this binds to LOCALHOST by default and
// is meant to be run locally or behind the broker's OWN nginx/Cloudflare on their
// OWN domain with TLS. The loop NEVER deploys it to a public network.
//
// Exit contract: this command does not "complete" — it LISTENS until killed. The
// runner returns { code, server, url } so a test can start it, hit it, and close
// it; `code` is only meaningful for the early-exit USAGE error (a bad --port).

const SERVE_DEFAULT_PORT = 4173;
const SERVE_DEFAULT_HOST = "127.0.0.1";

// Parse `serve` argv into options. Flags only (no positionals). An unknown flag or
// a positional is a USAGE error, matching the rest of the family.
function parseServeArgs(argv) {
  const opts = { port: undefined, host: undefined, _positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--port":
        opts.port = parsePortArg(argv[++i]);
        break;
      case "--host":
        opts.host = argv[++i];
        if (opts.host === undefined) {
          const e = new Error("--host requires a value");
          e.usage = true;
          throw e;
        }
        break;
      default:
        if (a && a.startsWith("--")) {
          const e = new Error(`unknown option: ${a}`);
          e.usage = true;
          throw e;
        }
        opts._positionals.push(a);
    }
  }
  if (opts._positionals.length > 0) {
    const e = new Error(
      `unexpected argument: ${opts._positionals[0]} (serve takes no positionals)`
    );
    e.usage = true;
    throw e;
  }
  return opts;
}

// A --port must be an integer in the valid TCP range (1..65535) OR 0 (bind an
// EPHEMERAL port — useful for tests and for "pick any free port"). A bad value is
// a USAGE error (exit 2), never silently coerced.
function parsePortArg(raw) {
  const s = String(raw == null ? "" : raw);
  if (!/^\d+$/.test(s)) {
    const e = new Error(`--port must be a non-negative integer (got "${raw}")`);
    e.usage = true;
    throw e;
  }
  const n = Number(s);
  if (n > 65535) {
    const e = new Error(`--port must be in 0..65535 (got "${raw}")`);
    e.usage = true;
    throw e;
  }
  return n;
}

// runServe binds the server and prints the URL. It does NOT block; it returns
// { code, server, url } once listening (or { code: USAGE } on a bad flag without
// ever binding). `io.listen` is injectable so a test can confirm the wiring without
// the runner picking a port itself; the default builds + listens on a real socket.
function runServe(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  const port = opts.port == null ? SERVE_DEFAULT_PORT : opts.port;
  const host = opts.host == null ? SERVE_DEFAULT_HOST : opts.host;

  const srv = (io.createServer || server.createServer)({ today: io.today });

  return new Promise((resolve) => {
    // Guard against resolving twice: a bind failure fires 'error' and the listen
    // callback never runs, but a defensive flag keeps the two paths exclusive.
    let settled = false;

    // Surface a bind failure (e.g. EADDRINUSE, EACCES on a privileged port, a bad
    // --host interface) as a clear IO error AND resolve the Promise with EXIT.IO so
    // the failure propagates to the process exit code. Without this resolve the
    // Promise would hang forever; on the real CLI path the failed server holds no
    // event-loop handles, so Node would exit ON ITS OWN with code 0 — collapsing
    // the IO(1) failure class into PASS(0). A supervisor / systemd / CI healthcheck
    // running `vh trust serve || alert` must see a non-zero code when the door
    // failed to bind.
    srv.on("error", (e) => {
      if (settled) return;
      settled = true;
      writeErr(`error: cannot start TrustLedger web door: ${e.message}\n`);
      resolve({ code: EXIT.IO, server: srv, url: null, error: e });
    });

    srv.listen(port, host, () => {
      if (settled) return;
      settled = true;
      // When --port 0 was given the OS chose the actual port; report the real one.
      const bound = srv.address();
      const realPort = bound && typeof bound === "object" ? bound.port : port;
      const url = `http://${host}:${realPort}/`;
      // 0.0.0.0 (or ::) is a bind target, not a browsable address; tell an operator
      // who bound all interfaces to reach it via their machine's real address.
      const browseHint =
        host === "0.0.0.0" || host === "::"
          ? "  (0.0.0.0 binds ALL interfaces — browse via your machine's own address.)\n"
          : "";
      write(
        `TrustLedger web door listening on ${url}\n` +
          browseHint +
          "  Files are processed IN MEMORY; nothing is written to disk server-side.\n" +
          "  This binds to localhost — to expose it, put it behind YOUR nginx/Cloudflare\n" +
          "  on YOUR own domain with TLS (a human deploy step; it is never auto-deployed).\n" +
          "  Press Ctrl-C to stop.\n"
      );
      resolve({ code: EXIT.PASS, server: srv, url });
    });
  });
}

// cmdServe: parse argv, then bind + print. The dispatcher (`vh trust`) awaits a
// PLAIN exit code, so this resolves to a NUMBER:
//   * a bad flag resolves immediately to EXIT.USAGE (2) and the process exits, OR
//   * a BIND FAILURE (EADDRINUSE / EACCES / bad --host) resolves to EXIT.IO (1) so
//     the failed door propagates a non-zero exit instead of letting Node exit 0, OR
//   * on success it binds, prints the URL, and returns a Promise that NEVER
//     resolves — the open socket keeps the event loop alive so the door stays up
//     until the operator kills it (Ctrl-C), exactly like a normal server process.
// Tests call `runServe` directly (which resolves with the live { server } handle)
// for the success path so they can hit it and close it; the bind-failure path is
// exercised through cmdServe to assert the EXIT.IO exit code.
function cmdServe(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  let opts;
  try {
    opts = parseServeArgs(argv);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return Promise.resolve(EXIT.USAGE);
  }
  return runServe(opts, io).then((res) => {
    // A non-PASS resolved code (a bind failure => EXIT.IO) maps STRAIGHT to that
    // number so the process exits non-zero. Only the listening (PASS) case holds
    // the process open forever on the live socket.
    if (res.code !== EXIT.PASS) return res.code;
    return new Promise(() => {});
  });
}

// ---------------------------------------------------------------------------
// `vh trust license issue | verify` (T-29.2) — mint + OFFLINE-verify a product
// license. `issue` reads a HUMAN-supplied key (EXACTLY ONE of --key-env/--key-file,
// reused-then-discarded, NEVER written/logged/echoed — the exact key-handling
// posture of `vh dataset sign`), signs a license via the shared license core, and
// prints ONLY the PUBLIC vendor address + the license summary + the path. `verify`
// is read-only, OFFLINE, key-free: it prints VALID/INVALID + the precise reason +
// entitlements + expiry, exiting 0 (valid) / 3 (invalid) just like verifyLicense.
// ---------------------------------------------------------------------------

const coreAttestation = require("../cli/core/attestation");

// Parse `license issue` argv. EXACTLY-ONE-of key sources is enforced downstream by
// loadSigningWallet (so neither/both error key-free); the parser only collects flags.
function parseLicenseIssueArgs(argv) {
  const opts = {
    customer: undefined,
    plan: undefined,
    entitlements: undefined, // comma-separated -> array
    expires: undefined, // ISO instant
    issued: undefined, // OPTIONAL ISO instant; default "now" supplied by the command
    licenseId: undefined, // OPTIONAL; defaulted by the command when omitted
    keyEnv: undefined,
    keyFile: undefined,
    out: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined || String(v).startsWith("--")) {
        const e = new Error(`${a} requires a value`);
        e.usage = true;
        throw e;
      }
      return v;
    };
    switch (a) {
      case "--customer": opts.customer = need(); break;
      case "--plan": opts.plan = need(); break;
      case "--entitlements": opts.entitlements = need(); break;
      case "--expires": opts.expires = need(); break;
      case "--issued": opts.issued = need(); break;
      case "--license-id": opts.licenseId = need(); break;
      case "--key-env": opts.keyEnv = need(); break;
      case "--key-file": opts.keyFile = need(); break;
      case "--out": opts.out = need(); break;
      case "--json": opts.json = true; break;
      default: {
        const e = new Error(`unknown option: ${a}`);
        e.usage = true;
        throw e;
      }
    }
  }
  return opts;
}

async function cmdLicenseIssue(argv, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  let opts;
  try {
    opts = parseLicenseIssueArgs(argv);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // Required license fields (the key sources are validated by loadSigningWallet).
  for (const [flag, val] of [
    ["--customer", opts.customer],
    ["--plan", opts.plan],
    ["--entitlements", opts.entitlements],
    ["--expires", opts.expires],
  ]) {
    if (val == null) {
      writeErr(`error: \`vh trust license issue\` requires ${flag}\n`);
      return EXIT.USAGE;
    }
  }

  // Resolve the HUMAN-supplied key into an in-process Wallet FIRST, BEFORE building
  // anything — neither/both sources, a missing env var, an unreadable file, or a
  // malformed/zero key hard-errors here with a KEY-FREE message (the SAME core +
  // posture as `vh dataset sign`). The loop never holds a key.
  let wallet;
  try {
    ({ wallet } = coreAttestation.loadSigningWallet({ keyEnv: opts.keyEnv, keyFile: opts.keyFile }));
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // Assemble the license fields. issuedAt defaults to the injectable clock (a real
  // ISO instant at runtime; a pinned one in tests). entitlements is a comma list.
  const issuedAt = opts.issued != null ? opts.issued : (io.nowISO || nowISO)();
  const entitlements = String(opts.entitlements)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const licenseId =
    opts.licenseId != null && opts.licenseId !== ""
      ? opts.licenseId
      : `LIC-${issuedAt}-${opts.plan}`;

  let container;
  try {
    container = await license.buildLicense(
      {
        licenseId,
        customer: opts.customer,
        plan: opts.plan,
        entitlements,
        issuedAt,
        expiresAt: opts.expires,
      },
      wallet
    );
  } catch (e) {
    // A LicenseError (bad date, unknown entitlement, expiresAt<=issuedAt, …) is a
    // usage error — NEVER echo the key (a build error carries only the bad field).
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  const canonical = license.serializeSignedLicense(container);
  // The PUBLIC vendor address — recovered from the signature, never the key.
  const vendor = coreAttestation.recoverSigner(container);
  const payload = JSON.parse(container.attestation);

  let outAbs = null;
  if (opts.out) {
    outAbs = path.resolve(opts.out);
    try {
      fs.writeFileSync(outAbs, canonical);
    } catch (e) {
      writeErr(`error: cannot write --out license file ${opts.out}: ${e.message}\n`);
      return EXIT.IO;
    }
  }

  if (opts.json) {
    // ONLY public fields: vendor ADDRESS, the license summary, the path — NEVER the
    // key. With no --out the canonical bytes ride in `container` (artifact parity).
    write(
      JSON.stringify(
        {
          issued: true,
          vendor,
          licenseId: payload.licenseId,
          customer: payload.customer,
          plan: payload.plan,
          entitlements: payload.entitlements,
          issuedAt: payload.issuedAt,
          expiresAt: payload.expiresAt,
          out: outAbs,
          container: outAbs ? null : canonical,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(`issued TrustLedger license by vendor ${vendor}\n`);
    write(`  licenseId:    ${payload.licenseId}\n`);
    write(`  customer:     ${payload.customer}\n`);
    write(`  plan:         ${payload.plan}\n`);
    write(`  entitlements: ${payload.entitlements.join(", ")}\n`);
    write(`  issuedAt:     ${payload.issuedAt}\n`);
    write(`  expiresAt:    ${payload.expiresAt}\n`);
    if (outAbs) {
      write(`  written:      ${outAbs}\n`);
    } else {
      // No --out: emit the canonical signed bytes after the human header.
      write(canonical);
    }
  }
  return EXIT.PASS;
}

// ---------------------------------------------------------------------------
// `vh trust license fulfill` (T-37.2) — the order -> license mapping as a command.
//
// The self-serve fulfillment seam: given the planId a customer bought (+ their
// name, when the period is paid through), resolve it in the plan catalog, copy the
// plan's entitlements VERBATIM, derive the [issuedAt, expiresAt] window, and emit
// the SAME signed `*.vhlicense.json` the existing `verify` / reconcile gate already
// accept — so a billing webhook's fulfillment handler is ONE command per sale.
//
// The catalog is the BUNDLED baseline by default (the seller's reviewed price-list,
// shipped as a DRAFT skeleton — set YOUR price/term per planId), or an explicit
// `--catalog <file>`. The key is read the EXACT read-used-discarded way `license
// issue` / `vh dataset sign` read it (EXACTLY ONE of --key-env/--key-file; the loop
// NEVER holds the key, NEVER echoes it). Entitlements are NEVER hand-typed here —
// they come ONLY from the resolved plan, so a typo can never mis-entitle a sale.
// ---------------------------------------------------------------------------

// The bundled DRAFT plan catalog `fulfill` resolves a plan against when no
// --catalog is given. Read from THIS package's own fixtures dir — never a caller
// path — so the default resolution is deterministic and self-contained.
const BUNDLED_CATALOG = path.join(__dirname, "fixtures", "plans", "baseline.json");

// Parse `license fulfill` argv. EXACTLY-ONE-of key sources is enforced downstream
// by loadSigningWallet (so neither/both error key-free); the parser only collects.
function parseLicenseFulfillArgs(argv) {
  const opts = {
    plan: undefined, // a planId in the catalog
    customer: undefined,
    paidThrough: undefined, // OPTIONAL ISO instant; default = issuedAt + plan term
    issued: undefined, // OPTIONAL ISO instant; default "now" supplied by the command
    licenseId: undefined, // OPTIONAL; defaulted deterministically by fulfillOrder
    catalog: undefined, // OPTIONAL path to a plan catalog JSON; default = bundled baseline
    keyEnv: undefined,
    keyFile: undefined,
    out: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined || String(v).startsWith("--")) {
        const e = new Error(`${a} requires a value`);
        e.usage = true;
        throw e;
      }
      return v;
    };
    switch (a) {
      case "--plan": opts.plan = need(); break;
      case "--customer": opts.customer = need(); break;
      case "--paid-through": opts.paidThrough = need(); break;
      case "--issued": opts.issued = need(); break;
      case "--license-id": opts.licenseId = need(); break;
      case "--catalog": opts.catalog = need(); break;
      case "--key-env": opts.keyEnv = need(); break;
      case "--key-file": opts.keyFile = need(); break;
      case "--out": opts.out = need(); break;
      case "--json": opts.json = true; break;
      default: {
        const e = new Error(`unknown option: ${a}`);
        e.usage = true;
        throw e;
      }
    }
  }
  return opts;
}

async function cmdLicenseFulfill(argv, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  let opts;
  try {
    opts = parseLicenseFulfillArgs(argv);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // Required order fields (the key sources are validated by loadSigningWallet; the
  // plan is resolved against the catalog by fulfillOrder).
  for (const [flag, val] of [
    ["--plan", opts.plan],
    ["--customer", opts.customer],
  ]) {
    if (val == null) {
      writeErr(`error: \`vh trust license fulfill\` requires ${flag}\n`);
      return EXIT.USAGE;
    }
  }

  // Load + strictly validate the plan catalog (bundled baseline by default). A
  // malformed/unreadable catalog is a usage error (a bad data file, not an IO crash).
  const catalogPath = opts.catalog != null ? path.resolve(opts.catalog) : BUNDLED_CATALOG;
  let catalog;
  try {
    const text = fs.readFileSync(catalogPath, "utf8");
    catalog = plans.validatePlanCatalog(JSON.parse(text));
  } catch (e) {
    writeErr(`error: cannot load plan catalog ${catalogPath}: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // Resolve the HUMAN-supplied key into an in-process Wallet FIRST, BEFORE building
  // anything — neither/both sources, a missing env var, an unreadable file, or a
  // malformed/zero key hard-errors here with a KEY-FREE message (the SAME core +
  // posture as `license issue` / `vh dataset sign`). The loop never holds a key.
  let wallet;
  try {
    ({ wallet } = coreAttestation.loadSigningWallet({ keyEnv: opts.keyEnv, keyFile: opts.keyFile }));
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // issuedAt defaults to the injectable clock (a real ISO instant at runtime; a
  // pinned one in tests). The order -> license-params mapping is PURE + deterministic.
  const issuedAt = opts.issued != null ? opts.issued : (io.nowISO || nowISO)();
  let params;
  try {
    params = license.fulfillOrder(
      {
        plan: opts.plan,
        customer: opts.customer,
        issuedAt,
        paidThrough: opts.paidThrough != null ? opts.paidThrough : undefined,
        licenseId: opts.licenseId != null && opts.licenseId !== "" ? opts.licenseId : undefined,
      },
      catalog
    );
  } catch (e) {
    // An unknown plan / paidThrough<=issuedAt / malformed date is a usage error —
    // NEVER echo the key (a mapping error carries only the bad order field).
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // Sign the derived params into the SAME signed container `issue` mints — the
  // existing verify / gate accept it byte-for-byte. No key handling here; the key
  // lives only inside `wallet`.
  let container;
  try {
    container = await license.buildLicense(params, wallet);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  const canonical = license.serializeSignedLicense(container);
  // The PUBLIC vendor address — recovered from the signature, never the key.
  const vendor = coreAttestation.recoverSigner(container);
  const payload = JSON.parse(container.attestation);

  let outAbs = null;
  if (opts.out) {
    outAbs = path.resolve(opts.out);
    try {
      fs.writeFileSync(outAbs, canonical);
    } catch (e) {
      writeErr(`error: cannot write --out license file ${opts.out}: ${e.message}\n`);
      return EXIT.IO;
    }
  }

  if (opts.json) {
    // ONLY public fields: vendor ADDRESS, the license summary, the path — NEVER the
    // key. With no --out the canonical bytes ride in `container` (artifact parity).
    write(
      JSON.stringify(
        {
          fulfilled: true,
          vendor,
          licenseId: payload.licenseId,
          customer: payload.customer,
          plan: payload.plan,
          entitlements: payload.entitlements,
          issuedAt: payload.issuedAt,
          expiresAt: payload.expiresAt,
          out: outAbs,
          container: outAbs ? null : canonical,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(`fulfilled TrustLedger license for plan ${payload.plan} by vendor ${vendor}\n`);
    write(`  licenseId:    ${payload.licenseId}\n`);
    write(`  customer:     ${payload.customer}\n`);
    write(`  plan:         ${payload.plan}\n`);
    write(`  entitlements: ${payload.entitlements.join(", ")}\n`);
    write(`  issuedAt:     ${payload.issuedAt}\n`);
    write(`  expiresAt:    ${payload.expiresAt}\n`);
    if (outAbs) {
      write(`  written:      ${outAbs}\n`);
    } else {
      // No --out: emit the canonical signed bytes after the human header.
      write(canonical);
    }
  }
  return EXIT.PASS;
}

// Parse `license verify <file> --vendor <0xaddr> [--json] [--now <iso>]`.
function parseLicenseVerifyArgs(argv) {
  const opts = { file: undefined, vendor: undefined, json: false, now: undefined, _positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--vendor": opts.vendor = argv[++i]; break;
      case "--now": opts.now = argv[++i]; break;
      case "--json": opts.json = true; break;
      default:
        if (a && a.startsWith("--")) {
          const e = new Error(`unknown option: ${a}`);
          e.usage = true;
          throw e;
        }
        opts._positionals.push(a);
    }
  }
  opts.file = opts._positionals[0];
  return opts;
}

function cmdLicenseVerify(argv, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  let opts;
  try {
    opts = parseLicenseVerifyArgs(argv);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }
  if (!opts.file) {
    writeErr("error: `vh trust license verify` requires a <file>\n");
    return EXIT.USAGE;
  }
  if (opts.vendor == null) {
    writeErr("error: `vh trust license verify` requires --vendor <0xaddr> (the issuer to pin to)\n");
    return EXIT.USAGE;
  }

  let container;
  try {
    const text = fs.readFileSync(path.resolve(opts.file), "utf8");
    container = license.readLicense(text);
  } catch (e) {
    // A missing/garbled container is a malformed verdict (INVALID), not a crash, so
    // a scripted check sees the 3 exit + the reason — but we surface the IO cause.
    writeErr(`error: cannot read license file ${opts.file}: ${e.message}\n`);
    return EXIT.IO;
  }

  // `now` is the injectable clock (a pinned instant in tests); default real now.
  const now = opts.now != null ? opts.now : (io.nowISO || nowISO)();
  let verdict;
  try {
    verdict = license.verifyLicense(container, { now, vendorAddress: opts.vendor });
  } catch (e) {
    // A malformed --vendor (or bad --now) is a caller error — usage, key-free.
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // Read the embedded payload's expiry/entitlements for the report (present even on
  // an expired/wrong-issuer verdict, so the human sees WHAT was rejected).
  const payload = verdict.payload;
  if (opts.json) {
    write(
      JSON.stringify(
        {
          valid: verdict.valid,
          reason: verdict.reason, // EXACTLY as verifyLicense returns it
          vendor: verdict.vendorAddress,
          recoveredSigner: verdict.recoveredSigner,
          entitlements: payload ? payload.entitlements : [],
          issuedAt: payload ? payload.issuedAt : null,
          expiresAt: payload ? payload.expiresAt : null,
          now: verdict.now,
        },
        null,
        2
      ) + "\n"
    );
  } else if (verdict.valid) {
    write("VALID\n");
    write(`  vendor:       ${verdict.vendorAddress}\n`);
    write(`  customer:     ${payload.customer}\n`);
    write(`  plan:         ${payload.plan}\n`);
    write(`  entitlements: ${payload.entitlements.join(", ")}\n`);
    write(`  expiresAt:    ${payload.expiresAt}\n`);
  } else {
    write("INVALID\n");
    write(`  reason:       ${verdict.reason}\n`);
    if (payload) {
      write(`  entitlements: ${payload.entitlements.join(", ")}\n`);
      write(`  expiresAt:    ${payload.expiresAt}\n`);
    }
  }
  // 0 valid / 3 invalid — the SAME verdict semantics as verifyLicense / verify-seal.
  return verdict.valid ? EXIT.PASS : EXIT.FAIL;
}

// `vh trust license <issue|verify> ...` sub-dispatch.
function cmdLicense(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const [sub, ...rest] = argv;
  if (sub === "issue") return cmdLicenseIssue(rest, io);
  if (sub === "fulfill") return cmdLicenseFulfill(rest, io);
  if (sub === "verify") return cmdLicenseVerify(rest, io);
  if (sub === "help" || sub === "-h" || sub === "--help") {
    (io.write || ((s) => process.stdout.write(s)))(licenseHelp());
    return EXIT.PASS;
  }
  writeErr(
    `error: unknown license subcommand: ${sub === undefined ? "(none)" : sub} ` +
      "(expected: issue, fulfill, verify)\n" +
      licenseHelp()
  );
  return EXIT.USAGE;
}

function licenseHelp() {
  return [
    "vh trust license — issue + OFFLINE-verify a TrustLedger product license",
    "",
    "  issue --customer <name> --plan <plan> --entitlements <a,b,c> --expires <ISO>",
    "        (--key-env <VAR> | --key-file <path>) [--issued <ISO>] [--license-id <id>] [--out <file>] [--json]",
    "      Sign a license with a key YOU supply at runtime (read-used-discarded, NEVER",
    "      written/logged/echoed). Prints ONLY the public vendor address + the summary + path.",
    `      Entitlements (closed set): ${license.ENTITLEMENT_FLAGS.join(", ")}.`,
    "",
    "  fulfill --plan <id> --customer <name> [--paid-through <ISO>] [--catalog <file>]",
    "        (--key-env <VAR> | --key-file <path>) [--issued <ISO>] [--license-id <id>] [--out <file>] [--json]",
    "      The order -> license mapping: resolve <id> in the plan catalog (bundled DRAFT baseline",
    "      by default, or --catalog), copy that plan's entitlements VERBATIM, derive the window",
    "      (--paid-through, else issuedAt + the plan's term), and emit the SAME signed license",
    "      `verify` / the reconcile gate accept. Entitlements are NEVER hand-typed — a typo can't",
    "      mis-entitle a sale. Same key posture as `issue` (read-used-discarded, never echoed).",
    "",
    "  verify <file> --vendor <0xaddr> [--json] [--now <ISO>]",
    "      Read-only, OFFLINE, key-free. Prints VALID/INVALID + reason + entitlements + expiry.",
    "      Exit 0 valid / 3 invalid (reason: malformed|bad_signature|wrong_issuer|not_yet_valid|expired).",
    "",
    "A license GATES the paid reconcile surfaces (--state/--policy, --seal): pass",
    "`vh trust reconcile ... --license <file> --vendor <0xaddr>` to unlock them. The FREE",
    "tier (baseline reconcile + `vh trust inspect`) needs no license.",
    "",
  ].join("\n");
}

// Real "now" as a canonical ISO-8601 UTC instant — the issuer/verify default clock,
// isolated + injectable so the commands stay deterministic under test.
function nowISO() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// argv dispatch
// ---------------------------------------------------------------------------

function cmdReconcile(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  let opts;
  try {
    opts = parseReconcileArgs(argv);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }
  const res = runReconcile(opts, io);
  return res.code;
}

// `vh trust <sub> ...` dispatcher.
function cmdTrust(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const [sub, ...rest] = argv;
  if (sub === "reconcile") {
    return cmdReconcile(rest, io);
  }
  if (sub === "inspect") {
    return cmdInspect(rest, io);
  }
  if (sub === "verify-seal") {
    return cmdVerifySeal(rest, io);
  }
  if (sub === "serve") {
    return cmdServe(rest, io);
  }
  if (sub === "license") {
    return cmdLicense(rest, io);
  }
  if (sub === "help" || sub === "-h" || sub === "--help") {
    (io.write || ((s) => process.stdout.write(s)))(trustHelp());
    return EXIT.PASS;
  }
  writeErr(
    `error: unknown trust subcommand: ${sub === undefined ? "(none)" : sub} ` +
      `(expected: reconcile, inspect, verify-seal, serve, license)\n` +
      trustHelp()
  );
  return EXIT.USAGE;
}

// The in-band `vh trust` help — names the full command set (including the seal
// commands) so the seal posture is discoverable without external docs.
function trustHelp() {
  return [
    "vh trust — TrustLedger three-way trust-account reconciliation",
    "",
    "Subcommands:",
    "  reconcile <bank> <ledger> <rentroll> [--out <dir>] [--seal [<file>]] [--license <f> --vendor <0xaddr>]",
    "      run the whole pipeline -> a dated audit packet (HTML+CSV; PASS/FAIL exit).",
    "      FREE: baseline-policy reconcile needs no license. PAID (require --license + --vendor):",
    "      --state/--policy (multi-state policy packs) and --seal. Without a valid, vendor-pinned",
    "      license carrying the matching entitlement those flags hard-error (exit 2) — see `license`.",
    "      --seal [<file>] additionally writes a TAMPER-EVIDENT reconciliation seal AFTER",
    "      the packet (binding the 3 source inputs + every emitted packet file, and the",
    "      emitted close if --emit-close). --seal REQUIRES --out (no packet, nothing to seal).",
    "      The 3 source inputs are sealed by BASENAME so the binding TRAVELS with the packet:",
    "      ship each source NEXT TO the seal (same dir) and the handoff verifies anywhere.",
    "  license issue|verify ...",
    "      issue: mint a signed product license with a key YOU supply (read-used-discarded).",
    "      verify: read-only, OFFLINE check of a license against --vendor (VALID/INVALID, 0/3).",
    "      A valid license + matching --vendor unlocks reconcile's paid surfaces. `vh trust license -h`.",
    "  inspect <file> --as <bank|ledger|rentroll>",
    "      read-only validator/preview of ONE input file (writes nothing).",
    "  serve [--port <n>] [--host <h>]",
    "      launch the LOCAL web front-door (default http://127.0.0.1:4173/) so a broker can drop",
    "      the three files in a browser and watch the balances tie out. Files are processed IN",
    "      MEMORY; NOTHING is written to disk server-side. Binds to localhost — exposing it (behind",
    "      YOUR nginx/Cloudflare on YOUR domain with TLS) is a HUMAN deploy step, never auto-deployed.",
    "  verify-seal <sealfile> [--dir <d>] [--inputs <d>] [--json]",
    "      read-only, OFFLINE (NO key, NO network): re-derive each sealed file from disk and",
    "      print ACCEPTED (0) only when EVERY file matches; else REJECTED (3) with the precise",
    "      per-file CHANGED/MISSING/UNEXPECTED list. Output files resolve relative to the seal's",
    "      directory (or --dir); the source inputs resolve there too (or --inputs <d>) since they",
    "      are sealed by basename. A seal is TAMPER-EVIDENT, NOT a trusted timestamp; CPA review governs.",
    "",
    "Exit: 0 ok / 3 gate FAIL (does-not-tie-out or REJECTED) / 2 usage / 1 IO.",
    "",
  ].join("\n");
}

module.exports = {
  EXIT,
  parseReconcileArgs,
  runReconcile,
  cmdReconcile,
  parseInspectArgs,
  runInspect,
  cmdInspect,
  renderInspect,
  inspectHint,
  parseVerifySealArgs,
  runVerifySeal,
  cmdVerifySeal,
  renderVerifySeal,
  parseServeArgs,
  runServe,
  cmdServe,
  SERVE_DEFAULT_PORT,
  SERVE_DEFAULT_HOST,
  trustHelp,
  cmdTrust,
  parseLicenseIssueArgs,
  cmdLicenseIssue,
  parseLicenseFulfillArgs,
  cmdLicenseFulfill,
  parseLicenseVerifyArgs,
  cmdLicenseVerify,
  cmdLicense,
  licenseHelp,
  gateReconcile,
  PAID_FEATURE_ENTITLEMENTS,
  nowISO,
  todayISO,
};
