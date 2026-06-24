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
        break;
      case "--opening-book":
        opts.openingBook = parseCentsArg(argv[++i], "--opening-book");
        break;
      case "--tolerance-cents":
        opts.toleranceCents = parseIntArg(argv[++i], "--tolerance-cents");
        break;
      case "--bank-format":
        opts.bankFormat = argv[++i];
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
    });
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return { code: EXIT.IO };
  }

  const summary = report.summaryLine(model);
  const render = report.renderPacket(model);
  const code = model.pass ? EXIT.PASS : EXIT.FAIL;

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
          { ...model, summary, written, outDir },
          null,
          2
        ) + "\n"
      );
    } else {
      write(`${summary}\n`);
      for (const p of written) write(`wrote ${p}\n`);
    }
  } else {
    // No --out: print the summary + the HTML report to stdout, write NOTHING.
    if (opts.json) {
      write(JSON.stringify({ ...model, summary }, null, 2) + "\n");
    } else {
      write(`${summary}\n`);
      const htmlName = report.packetFilenames(reportDate).html;
      write("\n");
      write(render[htmlName]);
    }
  }

  return { code, model, summary, written, render };
}

// Real "today" as a UTC YYYY-MM-DD. The ONLY impure call in this module, isolated
// here and injectable so the pipeline itself stays deterministic.
function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
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
  writeErr(
    `error: unknown trust subcommand: ${sub === undefined ? "(none)" : sub} ` +
      `(expected: reconcile)\n`
  );
  return EXIT.USAGE;
}

module.exports = {
  EXIT,
  parseReconcileArgs,
  runReconcile,
  cmdReconcile,
  cmdTrust,
  todayISO,
};
