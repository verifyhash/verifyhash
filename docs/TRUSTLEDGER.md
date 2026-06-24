# TrustLedger — automated three-way trust-account reconciliation

TrustLedger takes the three files a small US residential property-management firm already has every
month — the **bank statement**, the **QuickBooks ledger** (the "book"), and the **rent roll**
(per-tenant sub-ledger) — and runs the whole reconciliation end to end in one command: it parses each
file, matches bank lines to book lines, computes the **three balances that must legally agree**, flags
every exception, and writes a **dated, audit-ready reconciliation packet** (HTML + CSV) you can file as
evidence of the reconciliation.

```
vh trust reconcile <bank> <ledger> <rentroll> [--out <dir>]
```

The whole pipeline is a **deterministic parser / matcher / reporter**: integer-cents arithmetic
throughout (no floating-point drift), an injected report date (no hidden clock), and byte-reproducible
output. Given the same three files and the same date, it produces the same packet every run — which is
exactly what a reconciliation a broker signs and an auditor reads must be.

> **Read this first — what this tool is, and is NOT.** TrustLedger is a **tool that AIDS
> reconciliation**. The broker remains the legal trust-account custodian and is solely responsible for
> the accuracy and completeness of the trust-account records and for compliance with all applicable
> state trust-fund rules. TrustLedger reconciles the files it is given; it cannot see transactions
> absent from those files, cannot judge whether a transaction is itself proper, and does not constitute
> legal, accounting, or audit advice. **A PASS does not certify legal compliance.** Have a qualified CPA
> or your state regulator review the packet — including the disclaimer wording and the
> exception-severity classification — before relying on it. This same disclaimer leads every packet the
> tool emits (`trustledger/report.js` › `DISCLAIMER_LINES`, the single source of truth), and the
> classification rules below are **state- and CPA-dependent** policy that is pending human review
> (STRATEGY.md › Proposals › P-5).

---

## Who buys this, and why

The buyer is the **broker of record** at a small residential property-management firm (~50–500 doors)
that runs on QuickBooks + a bank CSV + a rent ledger — not on AppFolio or Buildium, which already do
this. In most US states the broker is the **legal custodian of the trust account** that holds other
people's money (tenant rent, owner funds, security deposits) and carries **personal license risk** if
that account goes out of trust. The three-way reconciliation is a **legally-forced, recurring monthly
chore**, so willingness-to-pay is high and externally imposed.

This is a *different* paying buyer than DataLedger's data-provenance reviewer or ProofParcel's data
vendor — a focused income bet, reachable purely through high-intent SEO/ads and NARPM forums, with no
insider network required.

---

## The three balances (what "ties out" means)

A trust account is **in trust** when three independently-derived numbers agree:

| Balance | What it is | Source file |
| --- | --- | --- |
| **Adjusted bank** | the bank statement balance, corrected for outstanding/in-transit items (deposits in transit, uncleared checks) | bank statement |
| **Book** | the opening balance plus the ledger's recorded activity | QuickBooks ledger |
| **Sub-ledger total** | the sum of every per-beneficiary (per-tenant/owner) balance | rent roll |

Two equalities must hold: **adjusted bank == book** (the bank and the books agree once timing items are
accounted for) and **book == sub-ledger total** (the money in the account is fully accounted for to its
beneficiaries — nothing is commingled or missing). When both hold, the reconciliation **ties out**.

The **security-deposit segregation** check intentionally counts deposit coverage from **one** source so
it cannot silently clear an un-segregated deposit by netting it against another figure
(`trustledger/reconcile.js`).

---

## PASS / FAIL and the exit-code contract

The command prints a one-line verdict and exits with a **stable, CI-gateable** code:

| Exit | Meaning |
| --- | --- |
| `0` | **PASS** — the three balances tie out AND there is no error-severity finding |
| `3` | **FAIL** — the balances do not tie out, OR an out-of-trust (error-severity) finding exists |
| `2` | usage error (missing/extra arguments, bad flag) |
| `1` | input/IO error (a file is unreadable or malformed) |

**PASS requires BOTH that the arithmetic ties out AND that there is zero error-severity finding.** An
out-of-trust account therefore **FAILs even when the totals happen to net to zero** — the gate protects
the beneficiaries, not just the column sums (`trustledger/report.js`).

You can wire this directly into CI / a monthly automation: a non-zero exit blocks the close.

---

## Exceptions and their severities

Every difference the pipeline finds is emitted as a classified exception. The severities are:

- **INFO** — a benign, self-clearing reconciling item (deposit in transit, outstanding check, generic
  timing). Expected; does not fail the gate on its own.
- **WARNING** — needs a human eye but may be legitimate (an NSF reversal, an owner draw, an
  unreconciled bank/book line).
- **ERROR** — the trust account is **out of trust**: a real finding that FAILs the gate (an
  un-segregated security deposit, the sub-ledger out of balance vs. the book, adjusted bank ≠ book).

> **The severity mapping is policy, not law.** The built-in baseline (security-deposit-not-segregated =
> ERROR, NSF reversal = WARNING, owner draw = WARNING, …) is a sensible starting point but is
> **state- and CPA-dependent**. It is the default *when you select no policy*; a reviewed per-state
> policy file overrides it (see **The per-state policy layer** below). The shipped policies are
> **DRAFTS, not legal advice** — a CPA/counsel must review and sign the per-state mapping before you
> rely on it (STRATEGY.md › P-5 #1/#2). Treat any classification as a draft control, not a settled
> legal determination.

---

## The per-state policy layer

What counts as **out of trust** (an ERROR that FAILs the gate) versus **needs a human eye** (a WARNING)
is not a universal fact — it is a function of the **state's trust-account statute**. One state makes an
owner draw against tenant money a per-se ERROR; another treats an NSF reversal as a mere WARNING until
the deposit is cured. So TrustLedger does not bake one severity table in as if it were law. The baseline
is a **default**, and a **per-state policy file** overrides it.

A policy is **data, not code**: a small, versioned, strictly-validated JSON file. The engine consumes it
unchanged — so producing a defensible per-state control is a **fill-in-the-table** task for a qualified
human, not a from-scratch engineering job.

> **DRAFT / NOT LEGAL ADVICE.** The policies that SHIP with TrustLedger
> (`trustledger/fixtures/policy/*.json`) are **DRAFT skeletons**, not legal advice and **not a claim of
> regulatory compliance**. The baseline reproduces the built-in defaults verbatim; the example state
> file carries a **PLACEHOLDER** citation. A qualified **CPA and/or counsel must review and SIGN** the
> per-state severity mapping and its statute citations for the actual jurisdiction before the gate is
> relied on. Selecting a policy does **not** make a packet legal advice and does **not** discharge the
> broker's duty as the responsible legal custodian of trust funds. (STRATEGY.md › P-5 #1/#2.)

### The policy file schema

A policy file is a single JSON object. Every field:

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | **yes** | integer | Must equal the build's supported version (currently **1**). Any other value is a hard, named error — never silently accepted. Bumped only on an incompatible change. |
| `state` | **yes** | non-empty string | A **human label** for the jurisdiction/policy (e.g. `"California"`). Carried into the packet so it names which policy governed the run. Also one of the two keys `--state <code>` resolves against. |
| `severities` | **yes** | object map | The override table: `exceptionType -> severity`. Each **key** must be a legal exception type and each **value** one of `"info"`, `"warning"`, `"error"`. An unknown type or a bad severity is a hard error. A type **absent** from the map keeps its baseline severity. |
| `citations` | no | object map | `exceptionType -> statute/rule string` (a **citation/label**, free text). Carried into the packet next to each overridden row so the control is grounded in the rule it rests on. You may cite **only** a type you also override in `severities`; citing a rule you do not apply is rejected as misleading in an audit. |
| `toleranceCents` | no | non-negative integer | The tie-out tolerance, in **integer cents**, this policy imposes. When present it **takes precedence** over the CLI `--tolerance-cents` / the default `0` (a policy that names an exact-tie rule should not be silently loosened by a CLI flag). |

`severities` keys and `citations` keys are **citations/labels of policy** — the legal content a human
fills in and a CPA signs. `state` is a **label**. `schemaVersion`/`toleranceCents` are mechanical. The
shipped fixtures additionally carry a `_DISCLAIMER` string; it is ignored by the engine (any extra
top-level key is) and exists only to keep the DRAFT posture attached to the file itself.

The **legal exception types** (the allowed `severities`/`citations` keys) are not re-declared in the
policy module — they are derived from the engine's own `EXCEPTION` enum, so a typo'd type is a
validation error rather than a silently-ignored key. They are:

```
outstanding_deposit   outstanding_check   timing
nsf_reversal          owner_draw          security_deposit_segregation
unreconciled_bank     unreconciled_book   subledger_out_of_balance
bank_book_mismatch
```

### Selecting a policy: `--state` vs `--policy`

Exactly one selection mechanism, or none:

| You pass | What happens |
| --- | --- |
| *(neither flag)* | The run uses the **built-in baseline** severities (no policy). This path is **byte-for-byte** today's behaviour — same verdict, same packet. |
| `--state <code>` | Resolve a **bundled** draft policy (`trustledger/fixtures/policy/<code>.json`) by its filename code **or** its `state` label (case-/punctuation-insensitive). An unknown code is a **usage error** (exit `2`) that lists the bundled codes. |
| `--policy <file>` | Read an **explicit** policy file from a path you supply. A malformed or unreadable file is a **usage error** (exit `2`) — a bad flag value, not a data-file IO error. |
| **both** `--state` and `--policy` | Ambiguous → **usage error** (exit `2`). They are mutually exclusive. |

The bundled policies that ship today (`vh trust reconcile --state <code>`):

| Code | `state` label | What it does |
| --- | --- | --- |
| `baseline` | `BASELINE (built-in defaults)` | Reproduces the built-in defaults verbatim — selecting it is identical to selecting nothing. A reference skeleton to copy. |
| `ca-example` | `EXAMPLE-STATE (illustrative override)` | **ILLUSTRATIVE ONLY.** Escalates `nsf_reversal` from the baseline WARNING to ERROR, with a **PLACEHOLDER** citation, to demonstrate the override mechanism. Not a real jurisdiction. |

### How PASS now depends on the selected policy

PASS is decided as **`tiesOut && error-count == 0`**. Because the policy supplies the severities, **the
selected policy is part of the PASS decision**: escalating a finding to ERROR can flip a PASS to a FAIL,
and de-escalating an ERROR can flip a FAIL to a PASS, on the *same* three files. The packet always names
the governing policy and appends an extra disclaimer line stating that the verdict reflects that
selected (still-DRAFT) policy. With no policy selected, PASS depends only on the built-in baseline,
exactly as before.

### Worked example: the verdict flips under a state override

Take a month whose files **tie out** and contain one `nsf_reversal`. Under the **baseline**, that NSF is
a WARNING, so the gate **PASSes**:

```
$ vh trust reconcile bank.csv ledger.csv rentroll.csv; echo "exit=$?"
PASS: three-way reconciliation tie out (...); 1 exception(s) [0 error, 1 warning, 0 info]
exit=0
```

Now select a state whose statute makes that NSF reversal a hard, out-of-trust finding. The
`ca-example` draft escalates `nsf_reversal` to ERROR, so on the **identical files** the verdict **flips
to FAIL** and the exit code becomes `3`:

```
$ vh trust reconcile bank.csv ledger.csv rentroll.csv --state ca-example; echo "exit=$?"
FAIL: ... ; 1 exception(s) [1 error, 0 warning, 0 info]
exit=3
```

Same input, different verdict — *because the policy changed, not the numbers.* The packet for the second
run names `EXAMPLE-STATE (illustrative override)` as the governing policy and shows the escalated row's
citation, so an auditor can see **which rule** drove the FAIL. (`--policy ./my-state.json` does the same
with an explicit file.) This is exactly why the per-state mapping must be **reviewed and signed by a
CPA/counsel** before it gates a real broker's close: the policy *is* the legal determination the verdict
rests on.

---

## The packet: HTML + CSV (print-to-PDF ready)

With `--out <dir>`, the command writes a **dated** packet into that directory (created if absent):

- **HTML** — a single self-contained document. Open it in any browser and **Print → Save as PDF** to
  file the reconciliation with your records.
- **CSV** — the exception list as a spreadsheet, so a bookkeeper can work the findings line by line.

Binary PDF/xlsx generation is **deferred to v2** on purpose: HTML prints to PDF and CSV opens in any
spreadsheet, so the packet needs **zero new heavy dependencies** and carries zero install risk. The
packet leads with the disclaimer above and is byte-reproducible for a given report date.

### Filesystem hygiene

Side-effect files are written **only** to the caller-chosen `--out` directory — **never** silently to
the current working directory. Without `--out`, the command prints the summary plus the HTML report to
stdout and **writes nothing**, so it is safe to run anywhere and trivially pipeable in CI.

---

## Usage

```
vh trust reconcile <bank> <ledger> <rentroll> [options]

Positional (in order):
  <bank>                 bank statement (CSV or OFX)
  <ledger>               QuickBooks ledger export (CSV) — the "book"
  <rentroll>             rent roll (CSV) — the per-tenant sub-ledger

Options:
  --out <dir>            write the HTML + CSV packet into <dir> (created if absent);
                         without --out, print the summary + HTML to stdout, write nothing
  --json                 emit the full model + exit-code contract as JSON
  --date <YYYY-MM-DD>    pin the report date (default: today, UTC) — keeps output reproducible
  --period <label>       optional human label for the statement period
  --state <code>         score under a bundled per-state DRAFT policy by its code/label
                         (trustledger/fixtures/policy/<code>.json); mutually exclusive with --policy
  --policy <file>        score under an explicit per-state policy file you supply
  --opening-bank <amt>   opening bank balance (e.g. "12,345.67"); default 0
  --opening-book <amt>   opening book balance; default 0
  --tolerance-cents <n>  tie-out tolerance in integer cents; default 0
  --bank-format csv|ofx  force the bank-file format instead of auto-detecting
```

### Example

```
$ vh trust reconcile bank-2026-05.csv ledger-2026-05.csv rentroll-2026-05.csv --out ./packets/may
PASS: three-way reconciliation tie out (bank-adjusted $128,400.00, book $128,400.00, sub-ledger $128,400.00); 1 exception(s) [0 error, 0 warning, 1 info]
wrote ./packets/may/trust-reconciliation-2026-05-30.html
wrote ./packets/may/trust-reconciliation-2026-05-30.csv
```

A FAIL still writes the packet (so you can review every exception) and exits `3`:

```
$ vh trust reconcile bank.csv ledger.csv short-rentroll.csv --out ./packets/may; echo "exit=$?"
FAIL: three-way reconciliation DO NOT tie out (bank-adjusted $128,400.00, book $128,400.00, sub-ledger $127,900.00); 2 exception(s) [1 error, 0 warning, 1 info]
...
exit=3
```

---

## How it works (the pipeline)

```
ingest.js     parse bank statement (CSV/OFX) + QuickBooks ledger + rent roll
              into NormalizedRecord[] (integer cents, no float drift)
   |
match.js      pair bank <-> book lines (exact + fuzzy + split)
   |
reconcile.js  the three-balance check + the classified exception list
   |
report.js     render a DATED, deterministic, audit-ready packet (HTML + CSV)
   |
cli.js        `vh trust reconcile` — one-line PASS/FAIL + CI-gateable exit code
```

Each stage is a pure, deterministic module under `trustledger/`. `report.buildPacket(...)` is the pure
heart: it takes the three normalized record sets and an explicit `reportDate`, runs match + reconcile,
and returns a JSON-serializable, order-stable model that the HTML/CSV renderers turn into the packet.
There is no hidden clock and no network.

---

## What stays a human step

TrustLedger BUILDS and locally TESTS the reconciliation engine. The steps that turn a correct engine
into a sellable, compliant product are **human-owned** and tracked in STRATEGY.md (Proposals › **P-5**):

- **CPA / counsel sign-off** on the disclaimer wording and on the explicit statement that a PASS does
  not imply legal compliance (P-5 #1).
- **Fill in + have counsel sign the per-state policy TABLE.** The engine **already consumes** a
  reviewed policy as data (see **The per-state policy layer** above) — the human task is now narrow:
  fill in `trustledger/fixtures/policy/<state>.json` in the shipped, validated format (the
  `severities` overrides + their statute `citations`) and have a CPA/counsel sign that mapping for the
  jurisdiction. No engine change is needed; the bundled `baseline.json` / `ca-example.json` are the
  DRAFT skeletons to copy (P-5 #2).
- **1–2 design-partner brokers** (e.g. via NARPM) to run their real files and confirm the three
  numbers tie out.

Hosting, billing (a SaaS subscription), and pricing are likewise human steps. Income comes from selling
the product to paying customers — **never** from a token, coin, sale, or yield scheme.

---

## See also

- [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md) — the project-wide trust posture.
- [`docs/DATALEDGER.md`](DATALEDGER.md) and [`docs/PROOFPARCEL.md`](PROOFPARCEL.md) — the sibling
  products on the shared provenance core.
