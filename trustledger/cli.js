"use strict";

// TrustLedger — cli.js
//
// T-22.4: `vh trust reconcile <bank> <ledger> <rentroll> [--out <dir>]`.
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
      case "--prior-close":
        opts.priorClose = argv[++i];
        break;
      case "--emit-close":
        opts.emitClose = argv[++i];
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

  // -- Ingest (a malformed row is a clear, located error -> exit 1). ---------
  let bank;
  let book;
  let rentroll;
  try {
    bank = ingest.parseBankStatement(bankText, { format: opts.bankFormat });
    book = ingest.parseQuickBooksCSV(ledgerText);
    rentroll = ingest.parseRentRollCSV(rentText);
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

    if (opts.json) {
      write(
        JSON.stringify(
          { ...model, summary, written, outDir, closeWritten },
          null,
          2
        ) + "\n"
      );
    } else {
      write(`${summary}\n`);
      for (const p of written) write(`wrote ${p}\n`);
      if (closeWritten) write(`wrote close ${closeWritten}\n`);
    }
  } else {
    // No --out: print the summary + the HTML report to stdout, write NOTHING
    // (except the explicitly caller-named --emit-close file, already written).
    if (opts.json) {
      write(JSON.stringify({ ...model, summary, closeWritten }, null, 2) + "\n");
    } else {
      write(`${summary}\n`);
      if (closeWritten) write(`wrote close ${closeWritten}\n`);
      const htmlName = report.packetFilenames(reportDate).html;
      write("\n");
      write(render[htmlName]);
    }
  }

  return { code, model, summary, written, render, closeWritten };
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
// HONESTY: the hint promises ONLY what the tool can do TODAY — rename/add a
// column from the named aliases. It deliberately does NOT advertise a column-
// mapping override flag, because none exists yet (a no-edit `--map` override is
// the NEXT task, T-25.3); pointing a broker at a flag that hard-errors would
// re-introduce the exact dead end this command exists to remove. The header
// note tells them the override is coming without implying it works now.
function inspectHint(report) {
  const out = [];
  for (const logical of report.requiredMissing) {
    const aliases = ingest.aliasesFor(report.source, logical);
    out.push(
      `the "${logical}" column was not found — rename your column to (or add) ` +
        `one named one of [${aliases.join(", ")}]`
    );
  }
  // The amount group (signed amount OR a split pair) is reported as a file-level
  // error rather than a missing single column; surface its own add-a-column hint.
  for (const e of report.errors) {
    if (e.row == null && /needs an "amount" column|debit\/credit|payment\/charge/.test(e.message)) {
      out.push(`${e.message} — rename/add one of those columns`);
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
  writeErr(
    `error: unknown trust subcommand: ${sub === undefined ? "(none)" : sub} ` +
      `(expected: reconcile, inspect)\n`
  );
  return EXIT.USAGE;
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
  cmdTrust,
  todayISO,
};
