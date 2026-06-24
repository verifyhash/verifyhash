"use strict";

// TrustLedger — report.js
//
// T-22.4: the audit-ready reconciliation PACKET.
//
// This is the demoable core value of the whole product: a broker hands the tool
// their three real monthly files and watches the three numbers that must legally
// agree tie out (or not), then files the dated packet this module emits as the
// evidence of the reconciliation.
//
// This module is the PRESENTATION layer over the deterministic pipeline:
//
//   ingest.js  ->  parse the three files into NormalizedRecord[]
//   match.js   ->  pair bank<->book lines (exact + fuzzy + split)
//   reconcile.js -> the THREE-balance check + classified exception list
//   report.js  ->  render it all into a dated, audit-ready packet
//
// We emit the packet as **HTML + CSV**:
//   * HTML  — a single self-contained, print-to-PDF-ready document a broker can
//             open in any browser and "Print -> Save as PDF" to file with their
//             records. No binary PDF/xlsx library is pulled in (those heavy deps
//             are explicitly deferred to v2): HTML prints to PDF and CSV opens in
//             any spreadsheet, with zero new dependencies and zero install risk.
//   * CSV   — the exception list as a spreadsheet, so a bookkeeper can work the
//             findings line by line.
//
// DETERMINISTIC. Given the same inputs (and an explicit report date) this module
// returns byte-identical output. It takes NO clock of its own — the caller MUST
// pass `reportDate` (a "YYYY-MM-DD" string). A reconciliation a broker signs and
// an auditor reads must be reproducible to the byte; a hidden `new Date()` would
// make the same inputs produce a different file every run, which is the opposite
// of audit-defensible. The CLI passes today's date explicitly so the human sees
// a dated packet while the function itself stays pure.
//
// HONEST POSTURE: the packet leads with a prominent disclaimer that the tool
// AIDS reconciliation but the broker remains the responsible custodian. It does
// not, and cannot, replace the broker's legal duty or a CPA's review.

const ingest = require("./ingest");
const match = require("./match");
const reconcile = require("./reconcile");
const policyMod = require("./policy");
const close = require("./close");

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class ReportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReportError";
  }
}

// ---------------------------------------------------------------------------
// Money formatting (integer cents -> "$1,234.56", signed)
// ---------------------------------------------------------------------------

function fmtCents(cents) {
  if (!Number.isInteger(cents)) {
    throw new ReportError("fmtCents requires integer cents");
  }
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  // Group the integer dollars with commas, deterministically.
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = `$${grouped}.${String(rem).padStart(2, "0")}`;
  return neg ? `-${body}` : body;
}

// HTML-escape a string for safe interpolation into the document body.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// CSV-escape one field per RFC-4180: wrap in quotes and double any quote when
// the field contains a comma, quote, CR, or LF. Deterministic.
function csvField(s) {
  const v = String(s == null ? "" : s);
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

// A short, human label for an amount sign direction.
function direction(cents) {
  if (cents > 0) return "in";
  if (cents < 0) return "out";
  return "zero";
}

// ---------------------------------------------------------------------------
// The disclaimer (single source of truth, reused in HTML + CSV).
// ---------------------------------------------------------------------------

const DISCLAIMER_LINES = Object.freeze([
  "This reconciliation packet is a TOOL THAT AIDS reconciliation. The broker " +
    "remains the legal trust-account custodian and is solely responsible for " +
    "the accuracy and completeness of the trust-account records and for " +
    "compliance with all applicable state trust-fund rules.",
  "TrustLedger reconciles the files it is given; it cannot see transactions " +
    "absent from those files, cannot judge whether a transaction is itself " +
    "proper, and does not constitute legal, accounting, or audit advice.",
  "Review every exception below and have a qualified CPA or your state " +
    "regulator review this packet before relying on it.",
]);

const DISCLAIMER_TEXT = DISCLAIMER_LINES.join(" ");

// An EXTRA disclaimer sentence appended ONLY when a per-state policy governed the
// run. It states plainly that the PASS/FAIL verdict reflects the SELECTED policy's
// reviewed severities — and that the policy itself is still NOT legal advice and
// must be reviewed by a CPA/counsel (cross-references the P-5 #1/#2 disclaimers).
// Templated with the governing policy's state label so the packet names WHAT
// governed it.
function policyDisclaimerLine(stateLabel) {
  return (
    `This run's PASS/FAIL verdict reflects the SELECTED trust-rule policy ` +
    `"${stateLabel}", which overrides the built-in baseline severities. ` +
    "Selecting a policy does NOT make this packet legal advice: the policy " +
    "itself — its per-state severities and statute citations — is a DRAFT that " +
    "a qualified CPA or legal counsel must review and adopt for your " +
    "jurisdiction before you rely on this verdict."
  );
}

// ---------------------------------------------------------------------------
// Build the deterministic packet MODEL from the three normalized record sets.
//
// This is the pure heart: ingest is done by the caller (so the caller controls
// file I/O), and this runs match + reconcile and assembles every number/row the
// renderers print. Returned model is JSON-serializable and order-stable.
// ---------------------------------------------------------------------------

// `priorClose` (optional): a validated period-close artifact (close.js) this run
// chains FORWARD from. When present, buildPacket runs close.checkContinuity over
// the prior ending vs. THIS period's opening and, on a non-zero gap, raises a
// CONTINUITY_BREAK exception that flows through the SAME applyPolicy / counts /
// verdict / report path as every other exception (and is policy-overridable).
// `emitClosePath` (optional): the caller-named path the emitted close was/will be
// written to, referenced in the output so the artifact is traceable. Neither is
// supplied unless `--prior-close`/`--emit-close` is used; without `priorClose` no
// continuity exception is ever raised and the model is byte-for-byte unchanged.
function buildPacket({
  bank,
  book,
  rentroll,
  reportDate,
  period,
  opening,
  toleranceCents,
  policy,
  priorClose,
  emitClosePath,
}) {
  if (!Array.isArray(bank)) throw new ReportError("bank must be a NormalizedRecord[]");
  if (!Array.isArray(book)) throw new ReportError("book must be a NormalizedRecord[]");
  if (!Array.isArray(rentroll)) throw new ReportError("rentroll must be a NormalizedRecord[]");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(reportDate || ""))) {
    throw new ReportError('reportDate must be a "YYYY-MM-DD" string');
  }

  // 1) Pair bank<->book lines.
  const matchResult = match.reconcile(bank, book);

  // Resolve the reconcile tolerance. A per-state policy MAY declare its own
  // `toleranceCents` (some statutes permit a de-minimis rounding band; most
  // require an exact tie, i.e. 0). PRECEDENCE: a policy's toleranceCents, when
  // present, OVERRIDES the CLI/default tolerance — the broker's reviewed
  // jurisdiction rule, not an ad-hoc command-line value, governs how close the
  // three balances must come. This matters because the tolerance feeds tiesOut
  // and the bank/book + book/sub mismatch exceptions, which in turn drive the
  // PASS/FAIL verdict; computing them under a tolerance DIFFERENT from the
  // policy the packet names would be a silent discrepancy. Without a policy
  // toleranceCents the CLI/default value is used unchanged (byte-for-byte the
  // prior behaviour).
  const cliTolerance = Number.isInteger(toleranceCents) ? toleranceCents : 0;
  const effectiveTolerance =
    policy && Number.isInteger(policy.toleranceCents)
      ? policy.toleranceCents
      : cliTolerance;

  // Normalize the opening this run actually used (integer cents both legs), so it
  // is the SAME value fed to reconcile AND checked for continuity against the
  // prior close — no chance of checking a different opening than was computed on.
  const usedOpening = {
    bank: opening && Number.isInteger(opening.bank) ? opening.bank : 0,
    book: opening && Number.isInteger(opening.book) ? opening.book : 0,
  };

  // 2) The three-balance check + classified exceptions.
  const rawRec = reconcile.reconcile(bank, book, rentroll, {
    matchResult,
    opening: usedOpening,
    toleranceCents: effectiveTolerance,
  });

  // 2a) Roll-forward continuity. When this run chains from a prior period's close,
  //     CHECK that this period's opening equals the prior period's signed ending,
  //     penny-exact. A non-zero gap is a CONTINUITY_BREAK exception INJECTED into
  //     the reconcile result BEFORE the policy is applied, so it flows through the
  //     SAME severity override, counts, verdict, exit code, and report path as
  //     every native exception. Without a priorClose this is skipped entirely and
  //     the result is byte-for-byte unchanged. The prior close is a validated
  //     close artifact (the CLI reads it via close.readClose); we re-validate here
  //     so buildPacket is safe to call directly.
  let continuity = null;
  let priorMeta = null;
  if (priorClose != null) {
    const prior = close.readClose(priorClose);
    priorMeta = {
      period: prior.period,
      reportDate: prior.reportDate,
      ending: { bank: prior.ending.bank, book: prior.ending.book },
    };
    const cont = close.checkContinuity(prior, usedOpening);
    continuity = {
      checked: true,
      ok: cont.ok === true,
      bankGap: Number.isInteger(cont.bankGap) ? cont.bankGap : 0,
      bookGap: Number.isInteger(cont.bookGap) ? cont.bookGap : 0,
      priorPeriod: prior.period,
      priorReportDate: prior.reportDate,
      priorEnding: { bank: prior.ending.bank, book: prior.ending.book },
      thisOpening: { bank: usedOpening.bank, book: usedOpening.book },
    };
    const contEx = reconcile.buildContinuityException(cont, prior.period);
    if (contEx) {
      rawRec.exceptions.push(contEx);
      // Re-sort so the freshly-injected exception lands in the canonical
      // severity-first order, exactly as a natively-detected one would. (When a
      // policy is present, applyPolicy re-sorts again under the overridden
      // severities; this keeps the no-policy path correctly ordered too.)
      rawRec.exceptions.sort(reconcile.compareExceptions);
    }
  }

  // 2b) Apply the reviewed per-state policy (if any) over the reconcile result
  //     BEFORE anything reads severities. applyPolicy is PURE and, with no
  //     policy, returns the SAME object reference — so the no-policy path is
  //     byte-for-byte the built-in baseline. With a policy, the overridden
  //     severities (and citations) flow into the counts, the PASS/FAIL verdict,
  //     the exit code, and the rendered report uniformly.
  const rec = policyMod.applyPolicy(rawRec, policy || null);
  const policyMeta = policy
    ? {
        state: policy.state,
        // The reconcile tolerance this policy imposed, when it declared one (else
        // null — the CLI/default tolerance governed). Surfaced so the packet
        // names the actual band the verdict was computed under, never implying a
        // stricter/looser tie than was applied.
        toleranceCents: Number.isInteger(policy.toleranceCents)
          ? policy.toleranceCents
          : null,
        // Surface only the overrides that actually changed a present exception,
        // each with its citation when the policy supplies one, so the report can
        // ground the verdict in the rule it rests on.
        overrides: Object.keys(policy.severities)
          .sort()
          .map((type) => ({
            type,
            severity: policy.severities[type],
            citation:
              policy.citations && policy.citations[type] != null
                ? policy.citations[type]
                : null,
          })),
      }
    : null;

  // 3) Per-beneficiary sub-ledger balances (sorted by party for stable output).
  const subBalances = reconcile.tenantBalances(rentroll);
  const beneficiaries = Object.keys(subBalances)
    .sort()
    .map((party) => ({ party, balance: subBalances[party] }));

  // 4) Exception rows flattened for the CSV/table (records summarized, not raw).
  const exceptions = rec.exceptions.map((e) => ({
    type: e.type,
    severity: e.severity,
    // A policy override may attach a statute/rule citation to the exception; the
    // renderers surface it so the verdict is grounded in the rule. null when the
    // governing policy (or the baseline) supplies none.
    citation: e.citation != null ? e.citation : null,
    amount: e.amount,
    direction: direction(e.amount),
    label: e.label,
    detail: e.detail,
    recordCount: e.records.length,
    records: e.records.map((r) => ({
      date: r.date,
      amount: r.amount,
      memo: r.memo || "",
      party: r.party || "",
      source: r.source || "",
    })),
  }));

  // A small severity roll-up so the summary line / header can show counts.
  const counts = { error: 0, warning: 0, info: 0 };
  for (const e of exceptions) {
    if (counts[e.severity] === undefined) counts[e.severity] = 0;
    counts[e.severity] += 1;
  }

  const matchSummary = {
    matched: matchResult.matched.length,
    unmatchedBank: matchResult.unmatchedA.length,
    unmatchedBook: matchResult.unmatchedB.length,
  };

  // PASS only when the three balances tie out AND there is no ERROR-severity
  // exception. An out-of-trust finding (commingling, unsegregated deposit) is a
  // FAIL even if the arithmetic happens to net to zero — the gate must protect
  // the beneficiaries, not just the totals.
  const pass = rec.tiesOut && counts.error === 0;

  // Disclaimer: the three baseline lines verbatim (so the no-policy packet is
  // byte-for-byte unchanged), plus ONE extra line naming the governing policy
  // whenever one was selected.
  const disclaimer = DISCLAIMER_LINES.slice();
  if (policyMeta) disclaimer.push(policyDisclaimerLine(policyMeta.state));

  // The opening balances this period rolled FORWARD from (the prior period's
  // asserted ending, or 0/0 for the first period). Surfaced on the model so the
  // period-close artifact (close.js) can derive a continuity-checkable opening
  // PURELY from the packet, and so the packet is self-describing about what it
  // started from. Same untrusted-hint posture as every other input.
  const openingBalances = {
    bank: opening && Number.isInteger(opening.bank) ? opening.bank : 0,
    book: opening && Number.isInteger(opening.book) ? opening.book : 0,
  };

  return {
    schema: "trustledger.reconciliation-packet/v1",
    reportDate,
    period: period || null,
    opening: openingBalances,
    // The prior period this run chained from + the roll-forward check (null when
    // no --prior-close was supplied). Names the prior period and shows the
    // roll-forward (prior ending -> this opening) so an auditor sees the chain.
    continuity,
    priorClose: priorMeta,
    // The caller-named path THIS run's close was/will be emitted to (null when no
    // --emit-close). Referenced so the emitted artifact is traceable from the
    // packet; the actual write happens in the CLI, only to this caller-named path.
    emitClose: emitClosePath == null ? null : String(emitClosePath),
    // The policy (state label + the applied overrides/citations) that governed
    // this run, or null for the built-in baseline. Names WHICH policy decided the
    // verdict so the report and --json are self-describing.
    policy: policyMeta,
    disclaimer,
    pass,
    tiesOut: rec.tiesOut,
    balances: rec.balances,
    counts,
    matchSummary,
    beneficiaries,
    exceptions,
    inputs: {
      bankRecords: bank.length,
      bookRecords: book.length,
      rentrollRecords: rentroll.length,
    },
  };
}

// ---------------------------------------------------------------------------
// The one-line PASS/FAIL summary (used by the CLI for the human + as the basis
// of the exit code). Deterministic string for a given model.
// ---------------------------------------------------------------------------

function summaryLine(model) {
  const b = model.balances;
  const verdict = model.pass ? "PASS" : "FAIL";
  const tie = model.tiesOut ? "tie out" : "DO NOT tie out";
  return (
    `${verdict}: three-way reconciliation ${tie} ` +
    `(bank-adjusted ${fmtCents(b.adjustedBank)}, book ${fmtCents(b.book)}, ` +
    `sub-ledger ${fmtCents(b.subledger)}); ` +
    `${model.exceptions.length} exception(s) ` +
    `[${model.counts.error} error, ${model.counts.warning} warning, ${model.counts.info} info]`
  );
}

// ---------------------------------------------------------------------------
// HTML renderer — single self-contained, print-to-PDF-ready document.
// ---------------------------------------------------------------------------

function sevBadge(sev) {
  const color =
    sev === "error" ? "#b00020" : sev === "warning" ? "#8a6d00" : "#0a6b2f";
  return `<span class="sev sev-${esc(sev)}" style="color:${color}">${esc(sev.toUpperCase())}</span>`;
}

// The roll-forward continuity section: only rendered when this run chained from a
// prior period's close (--prior-close). Names the prior period and shows the
// roll-forward (prior ending -> this opening) for both the bank and book legs so
// an auditor can walk the chain. When the gap is non-zero the matching
// CONTINUITY_BREAK row appears in the Exceptions table; this section shows the
// arithmetic that produced it.
function renderContinuitySection(model) {
  const c = model.continuity;
  if (!c || !c.checked) return "";
  const priorName =
    c.priorPeriod == null ? c.priorReportDate : `${c.priorPeriod} (${c.priorReportDate})`;
  const okLine = c.ok
    ? `<p class="none">The roll-forward is clean: this period opened exactly where
the prior period closed.</p>`
    : `<p style="color:#b00020"><strong>Roll-forward break:</strong> the bank
opening differs from the prior ending by
<strong>${esc(fmtCents(c.bankGap))}</strong> and the book opening differs by
<strong>${esc(fmtCents(c.bookGap))}</strong>. See the CONTINUITY_BREAK exception
below.</p>`;
  const rows = [
    ["Bank", c.priorEnding.bank, c.thisOpening.bank, c.bankGap],
    ["Book", c.priorEnding.book, c.thisOpening.book, c.bookGap],
  ]
    .map(
      ([leg, end, open, gap]) =>
        `<tr><td>${esc(leg)}</td><td class="num">${esc(fmtCents(end))}</td>` +
        `<td class="num">${esc(fmtCents(open))}</td><td class="num">${esc(
          fmtCents(gap)
        )}</td></tr>`
    )
    .join("\n");
  const emitNote = model.emitClose
    ? `<p class="meta">This run's period close was written to
<strong>${esc(model.emitClose)}</strong>.</p>`
    : "";
  return `
<h2>Period continuity (roll-forward)</h2>
<p>This reconciliation chained forward from <strong>${esc(priorName)}</strong>.
The trust chain requires that this period's OPENING balances equal the prior
period's signed ENDING balances, to the penny.</p>
${okLine}
<table>
<thead><tr><th>Leg</th><th class="num">Prior ending</th><th class="num">This opening</th><th class="num">Gap</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
${emitNote}
`;
}

function renderHTML(model) {
  const b = model.balances;
  const passClass = model.pass ? "pass" : "fail";
  const verdict = model.pass ? "PASS — three-way reconciliation ties out" : "FAIL — see exceptions";

  const balanceRows = [
    ["Bank balance (per statement)", b.bank],
    ["Outstanding / in-transit adjustments", b.adjustedBank - b.bank],
    ["Adjusted bank balance", b.adjustedBank],
    ["Book balance (per ledger)", b.book],
    ["Sub-ledger total (sum of beneficiaries)", b.subledger],
  ]
    .map(
      ([label, cents]) =>
        `<tr><td>${esc(label)}</td><td class="num">${esc(fmtCents(cents))}</td></tr>`
    )
    .join("\n");

  const benRows = model.beneficiaries
    .map(
      (x) =>
        `<tr><td>${esc(x.party)}</td><td class="num">${esc(fmtCents(x.balance))}</td></tr>`
    )
    .join("\n");

  const exRows = model.exceptions.length
    ? model.exceptions
        .map((e) => {
          const recs = e.records
            .map(
              (r) =>
                `<div class="rec">${esc(r.date)} &middot; ${esc(fmtCents(r.amount))} &middot; ` +
                `${esc(r.party || "—")} &middot; ${esc(r.memo || "—")} ` +
                `<span class="src">[${esc(r.source || "?")}]</span></div>`
            )
            .join("\n");
          const cite = e.citation
            ? `<div class="cite"><strong>Policy citation:</strong> ${esc(e.citation)}</div>`
            : "";
          return (
            `<tr>` +
            `<td>${sevBadge(e.severity)}</td>` +
            `<td>${esc(e.label)}</td>` +
            `<td class="num">${esc(fmtCents(e.amount))}</td>` +
            `<td>${esc(e.detail)}${cite}${recs ? `<div class="recs">${recs}</div>` : ""}</td>` +
            `</tr>`
          );
        })
        .join("\n")
    : `<tr><td colspan="4" class="none">No exceptions — every line reconciled.</td></tr>`;

  const disclaimerHTML = model.disclaimer
    .map((p) => `<p>${esc(p)}</p>`)
    .join("\n");

  // Governing-policy section: only rendered when a per-state policy was selected.
  // Names the policy and lists each severity override with its citation, so the
  // verdict is auditable back to the rule it rests on.
  let policySection = "";
  if (model.policy) {
    const ovRows = model.policy.overrides
      .map(
        (o) =>
          `<tr><td>${esc(o.type)}</td><td>${sevBadge(o.severity)}</td>` +
          `<td>${o.citation ? esc(o.citation) : '<span class="src">(no citation supplied)</span>'}</td></tr>`
      )
      .join("\n");
    const tolNote =
      model.policy.toleranceCents != null
        ? ` The three balances were reconciled under this policy's tolerance of
<strong>${esc(fmtCents(model.policy.toleranceCents))}</strong> (the band within
which the balances are treated as tying out).`
        : "";
    policySection = `
<h2>Governing policy</h2>
<p>This reconciliation was scored under the per-state trust-rule policy
<strong>${esc(model.policy.state)}</strong>, which overrides the built-in
baseline severities as follows. The PASS/FAIL verdict above reflects these
reviewed severities.${tolNote}</p>
<table>
<thead><tr><th>Exception type</th><th>Severity</th><th>Citation</th></tr></thead>
<tbody>
${ovRows || '<tr><td colspan="3" class="none">No overrides.</td></tr>'}
</tbody>
</table>
`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TrustLedger Reconciliation Packet — ${esc(model.reportDate)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.5 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
         color: #1a1a1a; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; border-bottom: 2px solid #eee; padding-bottom: .25rem; margin-top: 2rem; }
  .meta { color: #555; font-size: .9rem; }
  .verdict { display: inline-block; padding: .4rem .8rem; border-radius: 6px;
             font-weight: 700; margin: 1rem 0; }
  .verdict.pass { background: #e6f4ea; color: #0a6b2f; border: 1px solid #0a6b2f; }
  .verdict.fail { background: #fdeaea; color: #b00020; border: 1px solid #b00020; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #fafafa; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sev { font-weight: 700; font-size: .8rem; }
  .recs { margin-top: .35rem; }
  .rec { font-size: .82rem; color: #444; }
  .src { color: #999; }
  .cite { font-size: .82rem; color: #6b3a00; background: #fff7ea; border-left: 3px solid #e6b800;
          padding: .25rem .5rem; margin: .35rem 0; }
  .none { color: #0a6b2f; }
  .disclaimer { background: #fffbe6; border: 1px solid #e6d77a; border-radius: 6px;
                padding: .75rem 1rem; margin: 1rem 0; font-size: .9rem; }
  .disclaimer p { margin: .4rem 0; }
  footer { margin-top: 2rem; color: #888; font-size: .8rem; border-top: 1px solid #eee; padding-top: .5rem; }
  @media print { body { margin: 0; max-width: none; } h2 { page-break-after: avoid; } tr { page-break-inside: avoid; } }
</style>
</head>
<body>
<h1>TrustLedger — Three-Way Trust-Account Reconciliation</h1>
<p class="meta">Report date: <strong>${esc(model.reportDate)}</strong>${
    model.period ? ` &middot; Period: <strong>${esc(model.period)}</strong>` : ""
  } &middot; Policy: <strong>${esc(
    model.policy ? model.policy.state : "Built-in baseline severities"
  )}</strong></p>

<div class="verdict ${passClass}">${esc(verdict)}</div>

<div class="disclaimer">
<strong>Disclaimer.</strong>
${disclaimerHTML}
</div>
${policySection}
${renderContinuitySection(model)}
<h2>The three balances</h2>
<p>The trust account is in balance only when the adjusted bank balance, the book
balance, and the sum of the beneficiary sub-ledgers all agree.</p>
<table>
<thead><tr><th>Balance</th><th class="num">Amount</th></tr></thead>
<tbody>
${balanceRows}
</tbody>
</table>
<p>Reconciled balance:
<strong>${esc(b.reconciled == null ? "— (does not tie out)" : fmtCents(b.reconciled))}</strong>.</p>

<h2>Beneficiary sub-ledger</h2>
<table>
<thead><tr><th>Beneficiary</th><th class="num">Balance</th></tr></thead>
<tbody>
${benRows || '<tr><td colspan="2" class="none">No beneficiaries in the rent roll.</td></tr>'}
</tbody>
</table>

<h2>Exceptions (${model.exceptions.length})</h2>
<p>${model.counts.error} error &middot; ${model.counts.warning} warning &middot; ${model.counts.info} info.
Errors mean the trust account may be out of trust and must be resolved before signing.</p>
<table>
<thead><tr><th>Severity</th><th>Finding</th><th class="num">Amount</th><th>Detail</th></tr></thead>
<tbody>
${exRows}
</tbody>
</table>

<h2>Match summary</h2>
<table>
<tbody>
<tr><td>Bank/book lines matched</td><td class="num">${esc(String(model.matchSummary.matched))}</td></tr>
<tr><td>Unmatched bank lines</td><td class="num">${esc(String(model.matchSummary.unmatchedBank))}</td></tr>
<tr><td>Unmatched book lines</td><td class="num">${esc(String(model.matchSummary.unmatchedBook))}</td></tr>
<tr><td>Input records (bank / book / rent roll)</td><td class="num">${esc(
    String(model.inputs.bankRecords)
  )} / ${esc(String(model.inputs.bookRecords))} / ${esc(String(model.inputs.rentrollRecords))}</td></tr>
</tbody>
</table>

<footer>
Generated by TrustLedger ${esc(model.schema)}. Deterministic for the given inputs and report date.
To file as PDF, open this file in a browser and choose Print &rarr; Save as PDF.
</footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// CSV renderer — the exception list as a spreadsheet (one row per record, with
// summary rows above). Always ends with a trailing newline. Deterministic.
// ---------------------------------------------------------------------------

function renderExceptionsCSV(model) {
  const lines = [];
  const row = (...fields) => lines.push(fields.map(csvField).join(","));

  row(
    "severity",
    "type",
    "label",
    "amount_cents",
    "amount",
    "direction",
    "record_date",
    "record_amount",
    "record_party",
    "record_memo",
    "record_source",
    "detail",
    "policy_citation"
  );

  for (const e of model.exceptions) {
    const cite = e.citation || "";
    if (e.records.length === 0) {
      row(
        e.severity,
        e.type,
        e.label,
        String(e.amount),
        fmtCents(e.amount),
        e.direction,
        "",
        "",
        "",
        "",
        "",
        e.detail,
        cite
      );
      continue;
    }
    for (const r of e.records) {
      row(
        e.severity,
        e.type,
        e.label,
        String(e.amount),
        fmtCents(e.amount),
        e.direction,
        r.date,
        fmtCents(r.amount),
        r.party,
        r.memo,
        r.source,
        e.detail,
        cite
      );
    }
  }
  return lines.join("\n") + "\n";
}

// A second CSV: the three balances + beneficiary sub-ledger, so the broker can
// open the headline numbers in a spreadsheet too. Deterministic.
function renderBalancesCSV(model) {
  const b = model.balances;
  const lines = [];
  const row = (...fields) => lines.push(fields.map(csvField).join(","));
  row("section", "label", "amount_cents", "amount");
  // Name the governing policy so the spreadsheet is self-describing too.
  row(
    "policy",
    model.policy ? model.policy.state : "Built-in baseline severities",
    "",
    ""
  );
  row("balance", "bank", String(b.bank), fmtCents(b.bank));
  row("balance", "adjusted_bank", String(b.adjustedBank), fmtCents(b.adjustedBank));
  row("balance", "book", String(b.book), fmtCents(b.book));
  row("balance", "subledger", String(b.subledger), fmtCents(b.subledger));
  row(
    "balance",
    "reconciled",
    b.reconciled == null ? "" : String(b.reconciled),
    b.reconciled == null ? "" : fmtCents(b.reconciled)
  );
  for (const x of model.beneficiaries) {
    row("beneficiary", x.party, String(x.balance), fmtCents(x.balance));
  }
  // Roll-forward continuity rows (only when this run chained from a prior close),
  // so the spreadsheet names the prior period and shows the chain too.
  const c = model.continuity;
  if (c && c.checked) {
    const priorLabel =
      c.priorPeriod == null ? c.priorReportDate : `${c.priorPeriod} (${c.priorReportDate})`;
    row("continuity", "prior_period", "", priorLabel);
    row("continuity", "prior_ending_bank", String(c.priorEnding.bank), fmtCents(c.priorEnding.bank));
    row("continuity", "prior_ending_book", String(c.priorEnding.book), fmtCents(c.priorEnding.book));
    row("continuity", "this_opening_bank", String(c.thisOpening.bank), fmtCents(c.thisOpening.bank));
    row("continuity", "this_opening_book", String(c.thisOpening.book), fmtCents(c.thisOpening.book));
    row("continuity", "bank_gap", String(c.bankGap), fmtCents(c.bankGap));
    row("continuity", "book_gap", String(c.bookGap), fmtCents(c.bookGap));
    row("continuity", "roll_forward_ok", c.ok ? "1" : "0", c.ok ? "clean" : "BREAK");
  }
  if (model.emitClose) {
    row("close", "emitted_to", "", model.emitClose);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Filenames — DATED and deterministic. The packet writes a stable set of files
// into the caller-chosen directory; the names embed the report date so multiple
// months can coexist in one directory without collision.
// ---------------------------------------------------------------------------

function packetFilenames(reportDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(reportDate || ""))) {
    throw new ReportError('reportDate must be a "YYYY-MM-DD" string');
  }
  const stamp = reportDate; // already filesystem-safe (no slashes)
  return {
    html: `reconciliation-${stamp}.html`,
    exceptionsCsv: `reconciliation-${stamp}-exceptions.csv`,
    balancesCsv: `reconciliation-${stamp}-balances.csv`,
  };
}

// Render every artifact for a model. Returns { filename: contents } so the
// caller does the actual writes (keeping this module I/O-free and testable).
function renderPacket(model) {
  const names = packetFilenames(model.reportDate);
  return {
    [names.html]: renderHTML(model),
    [names.exceptionsCsv]: renderExceptionsCSV(model),
    [names.balancesCsv]: renderBalancesCSV(model),
  };
}

module.exports = {
  ReportError,
  DISCLAIMER_LINES,
  DISCLAIMER_TEXT,
  buildPacket,
  summaryLine,
  renderHTML,
  renderExceptionsCSV,
  renderBalancesCSV,
  renderPacket,
  packetFilenames,
  // small helpers exported for focused tests / reuse
  fmtCents,
  csvField,
  // re-export the pipeline pieces so a caller can ingest with one require
  ingest,
};
