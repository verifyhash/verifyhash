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
bank_book_mismatch    continuity_break
```

`continuity_break` is raised only when a run chains from a prior period's close
(`--prior-close`) and this period's opening does not roll forward penny-exact from
that prior period's signed ending. Its default severity is `error` (a broken
roll-forward means the books do not actually continue from the signed prior
period), and — like every other type — a per-state policy MAY re-grade it (e.g. a
state that treats a documented timing roll-forward difference as a `warning`).

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

## Period-close continuity (chaining one month to the next)

A three-way trust reconciliation is a **monthly** ritual. Each month's reconciled **ending** balances
become the **next** month's **opening** balances — the *roll-forward*. If May closes at a bank balance of
$3,300.00, June **must** open at exactly $3,300.00; any other opening means a period was skipped, edited,
or re-keyed, and the chain of custody over the trust money is broken. A fat-fingered opening silently
shifts every balance and can flip PASS↔FAIL — so the tool makes the roll-forward an explicit,
machine-checked artifact.

Two flags drive the chain:

- **`--emit-close <file>`** — at the end of a run, write a small JSON **close artifact** that records this
  period's ending balances (plus enough context to chain and detect tampering).
- **`--prior-close <file>`** — at the start of the next run, read the prior period's close artifact, **seed
  this run's opening** from its ending, and run a **continuity check** that the roll-forward is
  penny-exact.

Both are **additive**: with neither flag the engine behaves byte-for-byte as before (no `continuity`
metadata, no `continuity_break` exception — see **Additivity** below).

### The close-artifact schema

A close artifact is a single JSON object (`trustledger/close.js` is the single source of truth: pure
`buildClose` / `readClose` / `validateClose`). Every field:

| Field | Type | What it is | Trust class |
| --- | --- | --- | --- |
| `schemaVersion` | string `"trustledger.period-close/v1"` | Pins the artifact shape. **Any other value is a hard, named `CloseError`** — a close from a future/older tool is never silently coerced. | mechanical |
| `period` | string \| null | The human period label this close came from (e.g. `"2026-05"`), or `null` if the run carried no `--period`. | **hint / label** |
| `reportDate` | string `"YYYY-MM-DD"` | The report date of the run that emitted the close. | **hint / label** |
| `opening` | `{ bank, book }` integer cents | The opening balances **that run** used. | **hint** (asserted) |
| `ending` | `{ bank, book }` integer cents | The **closing** bank/book balances — the numbers the next period must open at. The roll-forward is checked against these. | **hint** (asserted) |
| `subledger` | integer cents | The sub-ledger total at close. | **hint** (asserted) |
| `tiesOut` | boolean | Whether the emitting run's three balances tied out. | **hint** (asserted verdict) |
| `pass` | boolean | The emitting run's PASS/FAIL verdict (tiesOut AND zero error-severity findings). | **hint** (asserted verdict) |
| `inputs` | `{ bankRecords, bookRecords, rentrollRecords }` non-negative integers | The input record counts the emitting run saw — context, and part of the digest. | **hint** |
| `inputsDigest` | 64-char lowercase hex | A **SHA-256 digest** over a canonical, order-stable projection of the fields above (via Node's built-in `crypto`, **no new dependency**). It **binds** the close to the summary it carries, so a hand-edited field is detectable. | **digest** |

Every value-bearing field is an **asserted hint** (a convenience the next run re-derives), `schemaVersion`
is **mechanical**, and `inputsDigest` is a **convenience integrity tag** over the *summary the close
carries* — **not** a cryptographic proof of the underlying source files (those are the authoritative
inputs and are re-read on the next reconciliation), and **not** a signature. All money is **integer cents**
(no floats); a non-integer-cents balance is a hard `CloseError`. The shipped artifact carries no clock or
randomness beyond the explicit `reportDate`, so `buildClose` is byte-deterministic for a given model.

### The `--prior-close` / `--emit-close` flow

```
month 1:  vh trust reconcile bank1 ledger1 rent1 --period 2026-05 --emit-close month1.json
              -> reconciles month 1, writes month1.json (ending bank/book/sub recorded)

month 2:  vh trust reconcile bank2 ledger2 rent2 --period 2026-06 --prior-close month1.json --emit-close month2.json
              -> seeds opening from month1.json's ending, checks the roll-forward,
                 reconciles month 2, writes month2.json (so month 3 can chain in turn)
```

On a `--prior-close` run:

1. The prior close is **read and strictly validated** (`close.readClose`). A malformed or
   structurally-invalid close, or a missing file, is a **usage error (exit `2`)** — a bad flag value, not
   a data-file IO error. (`error: invalid --prior-close …` / `error: cannot read --prior-close …`.)
2. This run's **opening is seeded** from the prior close's `ending` (bank ← `ending.bank`, book ←
   `ending.book`), **unless** you also pass an explicit `--opening-bank` / `--opening-book`. An explicit
   opening that **disagrees** with the prior ending is **honored and noted on stderr** (`note: --opening-bank
   … overrides the prior close's ending bank balance …`) — and the continuity check below then flags the
   resulting gap, so a chain-breaking override surfaces as a `CONTINUITY_BREAK` rather than silently. An
   explicit opening that **agrees** seeds cleanly with no note.
3. The **continuity check** (`close.checkContinuity`) compares the **opening actually used** against the
   prior `ending`, **penny-exact, with zero tolerance** (a roll-forward must be exact — a one-cent drift is
   a real gap, not noise). It returns `{ ok, bankGap, bookGap }` where `bankGap = opening.bank −
   priorEnding.bank` (signed; positive means this period opened **higher** than the prior closed).

### The continuity check and `CONTINUITY_BREAK`

When the check is not clean (`bankGap` or `bookGap` ≠ 0), the run raises a **`continuity_break`**
exception. Its default severity is **`error`** (a broken roll-forward means the books do not actually
continue from the signed prior period), so it **FAILs the gate (exit `3`)** even if the period's own three
balances otherwise tie out. The exception **names the gap** (signed integer cents) and the **prior period**
it chained from, and it flows through the rendered packet: the HTML shows a **"Period continuity
(roll-forward)"** table (Prior ending → This opening → Gap) and, on a break, a **"Roll-forward break:"**
callout; the balances CSV carries `continuity,prior_period` / `continuity,bank_gap` rows and the exceptions
CSV carries the `continuity_break` row.

Like every other exception type, `continuity_break` is a **legal exception type** a per-state policy MAY
**re-grade** — e.g. a state that treats a documented timing roll-forward difference as a `warning` (with a
citation) rather than an out-of-trust ERROR. Re-grading it to `warning` removes it from the error count, so
the verdict no longer FAILs on the break alone. (See **The per-state policy layer** above; the bundled list
of legal types includes `continuity_break`.)

### A close is an UNTRUSTED hint — re-derived, not signed

This is load-bearing and consistent with the project-wide trust posture
([`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md)): **the close artifact is an UNTRUSTED CONVENIENCE
HINT, not an authority.** It carries the prior period's **asserted** ending so the next run can seed and
check the opening — but the **authoritative** numbers are always the **freshly recomputed** reconciliation,
never the values written in the close. A broker who hand-edits the close file changes a *hint*, not the
truth: the next reconciliation **re-derives** the three balances from the source files, and the continuity
check merely reports whether the asserted roll-forward matched. The close is **NOT signed and NOT
timestamped**; like every other artifact in this repo it rides the human trust-root — the broker remains
the legal custodian and a CPA review still governs.

> **The close artifact is a convenience for chaining periods — NOT a legal record.** It exists to seed and
> check the next month's opening; it does not attest to anything, does not certify the prior period, and is
> not evidence of compliance. The audit-ready evidence is the dated **packet** (HTML + CSV) each run emits,
> read against the broker's actual books by a qualified CPA — exactly as for a single-period run. Emitting
> or chaining a close changes none of the honest-posture disclaimer at the top of this document.

### Worked example: month 1 → month 2 → break

Run **month 1** with `--emit-close`. It reconciles and writes the close artifact:

```
$ vh trust reconcile bank-2026-05.csv ledger-2026-05.csv rentroll-2026-05.csv \
    --period 2026-05 --date 2026-05-31 --emit-close month1.json
PASS: three-way reconciliation tie out (...); 1 exception(s) [0 error, 0 warning, 1 info]
wrote close month1.json
```

`month1.json` records the period's ending (say bank $3,300.00 / book $3,300.00) plus its `inputsDigest`.

Now run **month 2** with `--prior-close month1.json`. The opening is **seeded** from month 1's ending and
the roll-forward is checked. When month 2's data continues cleanly, **continuity holds** — no break, the
three balances tie out, and the gate PASSes:

```
$ vh trust reconcile bank-2026-06.csv ledger-2026-06.csv rentroll-2026-06.csv \
    --period 2026-06 --date 2026-06-30 --prior-close month1.json --emit-close month2.json; echo "exit=$?"
PASS: three-way reconciliation tie out (...); 1 exception(s) [0 error, 0 warning, 1 info]
wrote close month2.json
exit=0
```

Now **break a balance**: re-run month 2 but force an opening that does **not** roll forward from the prior
close (here the bank opening is $100 below the prior ending — a skipped/edited/re-keyed period, the exact
footgun this guard exists for). The override is honored-and-noted, the continuity check flags the gap, and
the **`CONTINUITY_BREAK` FAILs** the gate (exit `3`):

```
$ vh trust reconcile bank-2026-06.csv ledger-2026-06.csv rentroll-2026-06.csv \
    --period 2026-06 --date 2026-06-30 --prior-close month1.json --opening-bank 3,200.00; echo "exit=$?"
note: --opening-bank 320000 overrides the prior close's ending bank balance 330000; the roll-forward continuity check below will flag the resulting gap
FAIL: ... ; N exception(s) [1 error, ...]
exit=3
```

The packet names the prior period (`2026-05`), shows the roll-forward break (`bankGap = -10000`, i.e.
−$100.00), and the `continuity_break` row is ERROR — so the FAIL is *because the chain broke*, not because
the month's own numbers disagreed. That is the continuity layer doing its job: a silently-shifted opening
becomes a visible, gating finding.

### Additivity (no close flags == today's behaviour)

With **neither** `--prior-close` nor `--emit-close`, the run is **byte-for-byte** the prior behaviour:
`model.continuity` and `model.priorClose` are `null`, no `continuity_break` is ever raised, nothing extra
is written, and the verdict depends only on the period's own three balances (and any selected policy). The
continuity layer only engages when you opt in by chaining a close.

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

## The web front-door: `vh trust serve`

A property-management broker will never use a terminal. `vh trust serve` launches a small **local web
front-door** over the exact same engine so a broker can open a browser, drag the three monthly files
in, and watch the balances tie out — no command line required.

```
vh trust serve [--port <n>] [--host <h>]
```

| Option        | Default          | Meaning                                                       |
| ------------- | ---------------- | ------------------------------------------------------------- |
| `--port <n>`  | `4173`           | TCP port to listen on (`0` = let the OS pick a free port)     |
| `--host <h>`  | `127.0.0.1`      | interface to bind (localhost by default — see deploy posture) |

It prints the URL and then stays running until you stop it (Ctrl-C):

```
$ vh trust serve
TrustLedger web door listening on http://127.0.0.1:4173/
  Files are processed IN MEMORY; nothing is written to disk server-side.
  This binds to localhost — to expose it, put it behind YOUR nginx/Cloudflare
  on YOUR own domain with TLS (a human deploy step; it is never auto-deployed).
  Press Ctrl-C to stop.
```

Open `http://127.0.0.1:4173/`, drop the **bank statement**, the **QuickBooks ledger**, and the **rent
roll**, and the page shows the PASS/FAIL verdict, the three balances, the exception list, and the same
audit-ready HTML packet the CLI produces — all rendered from the engine's response.

If the port cannot be bound (already in use, a privileged port without permission, or a bad `--host`
interface), `serve` prints `error: cannot start TrustLedger web door: …` to stderr and **exits `1`**
(the IO class) — it never exits `0` on a failed bind. That makes `vh trust serve || alert` safe to wire
into a supervisor, systemd unit, or CI healthcheck: a non-zero exit means the door is genuinely down.

### How a broker runs it locally

1. Install the tool (`npm install -g .` from a checkout, or `npm link` — see the README install note).
2. Run `vh trust serve` (optionally `--port <n>` to choose a port).
3. Open the printed URL in a browser on the **same machine** and reconcile.

That is the whole local workflow: one command, one browser tab, no terminal interaction with the files
themselves.

### File privacy posture (this is the point of `serve`)

- The browser reads the three files **locally** (via the browser's `FileReader`) and POSTs their text
  contents to the server. The server runs the pipeline **purely in memory** and returns the verdict,
  balances, exception list, and rendered packet in the HTTP response.
- **Nothing is persisted server-side.** `serve` has **no** `--out` flag — a long-lived server must never
  silently accumulate a broker's trust-account files on disk. (The path that *writes* a packet is the
  CLI `vh trust reconcile --out <dir>`, and only to the directory you name; see "Filesystem hygiene".)
- A malformed file comes back as a **named JSON error** (HTTP 400) with the same located reason the CLI
  prints — never a stack trace. An oversized upload is rejected (HTTP 413) before it is fully buffered,
  so a hostile client cannot exhaust the process.
- The returned packet carries the **same custodian disclaimer** the CLI packet does: the tool *aids*
  reconciliation; the broker remains the responsible trust-account custodian.

### Deploying it (a HUMAN step — never auto-deployed)

By default `serve` binds **localhost** (`127.0.0.1`), so it is reachable only from the machine it runs
on. To make it reachable to others, **you** put it behind a reverse proxy you control:

> **HUMAN deploy step.** Run `vh trust serve` on your own host and terminate TLS in front of it with
> **nginx** or **Cloudflare** on **your own domain** (e.g. proxy `https://reconcile.yourbrokerage.com`
> → `http://127.0.0.1:4173/`). Add whatever access control your trust-account data requires (basic
> auth, an allow-list, SSO). The loop **never** deploys this for you, never exposes it to a public
> network, and never binds anything but localhost by default. Hosting, TLS, the domain, and access
> control are all yours to own.

Because the server persists nothing, a single instance is stateless and safe to restart at any time.

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
  --prior-close <file>   roll forward FROM a prior period's close artifact: seed this
                         run's opening from it and check the roll-forward (see
                         "Period-close continuity" below)
  --emit-close <file>    write THIS run's close artifact to <file> so next month can
                         consume it as --prior-close
  --opening-bank <amt>   opening bank balance (e.g. "12,345.67"); default 0
  --opening-book <amt>   opening book balance; default 0
  --tolerance-cents <n>  tie-out tolerance in integer cents; default 0
  --bank-format csv|ofx  force the bank-file format instead of auto-detecting
  --map <src>:<lf>=<hdr> bind a logical field to an EXACT column header when the
                         alias auto-detect misses it; <src> is bank|ledger|rentroll
                         (repeatable). See "Onboarding: inspect before you reconcile"
  --map-file <json>      a { bank|ledger|rentroll: { <logical>: <header> } } file of
                         the same per-source overrides (an inline --map wins on a clash)

vh trust serve [--port <n>] [--host <h>]   # the local web front-door (see above)
  --port <n>             listen port (default 4173; 0 = OS-chosen free port)
  --host <h>             bind interface (default 127.0.0.1 / localhost)
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

## Onboarding: inspect before you reconcile

`reconcile` is **strict on purpose** — it parses each of your three files **fail-closed**: a missing
required column or the **first** malformed cell aborts the whole run with a single located error
(`error: missing required column "date" in header` / `error: … line N …`, exit `1`), because a trust
reconciliation must **never silently partial-parse**. That strictness is correct for the audit, but on
**file one** of a real broker's export it can read as "the tool is broken" with no way to see what the
file *does* contain. `vh trust inspect` is the read-only companion that turns that dead end into a
self-service fix.

```
vh trust inspect <file> --as <bank|ledger|rentroll> [--map <lf>=<hdr>] [--map-file <json>]
                        [--bank-format csv|ofx] [--sample <n>] [--json]
```

`inspect` runs the **same parse primitives** `reconcile` uses, but on **one file**, **without failing
closed**. It reports, for that file:

- the **detected format** (CSV vs OFX/QFX) and the **detected header columns** (or the OFX tags it read);
- a **logical-field → header** map showing exactly which of your columns each required field bound to,
  with any unmapped **required** field flagged `(not found) [REQUIRED]`;
- the **parse count** (`parsed: K OK of N data row(s)`) and a **sample** of the normalized records;
- **EVERY** failing row (not just the first), each by data-row number with its reason; and
- a **`how to fix:`** hint that, for each miss, names both the accepted column aliases **and** the
  `--map` override that loads the file as-is.

`inspect` **writes nothing** and **checks only PARSING** — it does **not** reconcile, match, compute the
three balances, or attest anything. Its own output leads by saying so:

> `TrustLedger AIDS reconciliation; the broker remains the responsible custodian.`
> ``inspect`` only checks that this file PARSES into the normalized model — it does NOT reconcile or
> attest anything. To reconcile, run ``vh trust reconcile``.

That is the same honest posture as the disclaimer at the top of this document: a clean `inspect` means
the file **loads**, not that the books are **right** — the three-way reconciliation, and a qualified
CPA's review of the packet, still govern.

### Exit codes (`vh trust inspect`)

| Exit | Meaning |
| --- | --- |
| `0` | **clean** — the file parses end to end: every required column found and every data row normalized |
| `3` | **not clean** — a required column is missing OR at least one row failed to parse (the report still prints the header map, the good-row sample, and the `how to fix:` hint) |
| `2` | usage error (missing `<file>`, missing/bad `--as`, bad `--map`/`--bank-format`, unknown flag, extra positional) |
| `1` | IO error (the file is unreadable) |

Note the contrast with `reconcile`: a **malformed data file** makes `reconcile` exit `1`, but it makes
`inspect` exit `3` — because for `inspect` a malformed file is the **expected** thing it was run to
diagnose, not an IO failure. `--json` round-trips the full diagnostic report (header, `mapped`,
`requiredMissing`, `rowCount`, `okCount`, `records`, `errors`, `sample`, plus `clean`/`code`/`hint`/
`caveat`/`scope`), so onboarding can be scripted.

### The column-mapping escape hatch: `--map` / `--map-file`

When a real export's header matches **none** of the built-in aliases (a bank column labelled
`MoneyOut`, a rent-roll `Tenant Name`), you do **not** have to edit the source file. Point the parser at
the right columns with an explicit map. The map **overrides** the alias auto-detect for the fields it
names and leaves the rest to auto-detect — so a **one-field** map fixes a single stray header.

The **logical fields** you may map are the parser's own field names; an unknown key, or a header the
file does not actually contain, is a **named error** that lists the valid options (never a silent
mis-map):

- **bank / ledger:** `date`, `memo`, `type`, and **either** a signed `amount` **or** a `debit`/`credit`
  pair (`party`/`payee` on the ledger).
- **rentroll:** `date`, `tenant`, and **either** `amount` **or** a `payment`/`charge` pair.

**Syntax differs by command**, because `reconcile` handles three files at once and `inspect` handles
one:

| Command | `--map` form | `--map-file` shape |
| --- | --- | --- |
| `vh trust inspect` | `--map <logical>=<header>` (the source is `--as`) | `{ "<that --as source>": { "<logical>": "<header>" } }` |
| `vh trust reconcile` | `--map <source>:<logical>=<header>` (`source` = `bank`\|`ledger`\|`rentroll`) | `{ "bank": { … }, "ledger": { … }, "rentroll": { … } }` |

Both flags are **repeatable**; a `--map-file` supplies the base and an inline `--map` overrides it on a
clash. **How a bad map is reported splits two ways, and it differs between the commands:**

- A **structural** flag error — a malformed `--map` (no `=`, an empty side), an unreadable or invalid
  `--map-file`, an unknown source key — is a **usage error (exit `2`)** for **both** commands. It is a
  bad flag value caught before any file is parsed, the same exit class whether it arrives by inline
  `--map` or by `--map-file`, so CI can tell "fix your flags" from a real IO error.
- A **semantic** map error — an **unknown logical field**, or a **mapped-to header that is absent from
  the file** — is where the two commands diverge. `reconcile` **pre-flights** every source's map
  (`validateColumnMapForSource`) and rejects these as a **usage error (exit `2`)** before reconciling.
  `inspect`, by contrast, feeds the map straight into the same `diagnoseSource` parse it is built to
  diagnose, so an unknown field or absent header surfaces as a **parse failure in the report and exits
  `3` (not clean)** — not `2`. That is deliberate: for `inspect` a map that does not line up with the
  file is exactly the kind of "this file does not parse as mapped" finding the command exists to show
  you, alongside the `how to fix:` hint, rather than a flag-usage abort.

### Worked example: "my header isn't recognized → inspect → --map → it loads"

A broker's bank export uses house column names no alias matches (`When`, `Narrative`, `MoneyOut`,
`MoneyIn`, `Kategorie`). Running `reconcile` on it dead-ends on the first required column it cannot find.
**First, `inspect` to see what the file actually contains:**

```
$ vh trust inspect bank.csv --as bank; echo "exit=$?"
# vh trust inspect — bank (bank.csv)
TrustLedger AIDS reconciliation; the broker remains the responsible custodian.
`inspect` only checks that this file PARSES into the normalized model — it does NOT reconcile or attest anything. To reconcile, run `vh trust reconcile`.

detected format: csv
header columns (5): When, Narrative, MoneyOut, MoneyIn, Kategorie

logical field -> header column:
  date: (not found) [REQUIRED]
  ...

how to fix:
  - the "date" column was not found — rename your column to (or add) one named one of [date, posted, posting date, transaction date, trans date], OR map your existing header with --map date=<your header>
exit=3
```

**Then follow the hint — map your existing headers, no source edit — and it loads:**

```
$ vh trust inspect bank.csv --as bank \
    --map date=When --map memo=Narrative --map debit=MoneyOut --map credit=MoneyIn --map type=Kategorie
... parsed: 4 OK of 4 data row(s)
... failures: none
exit=0
```

The **same map** then drives `reconcile` (here via a reusable `--map-file`, so the three files' overrides
live in one place):

```
$ cat maps.json
{ "bank": { "date":"When", "memo":"Narrative", "debit":"MoneyOut", "credit":"MoneyIn", "type":"Kategorie" } }

$ vh trust reconcile bank.csv ledger.csv rentroll.csv --map-file maps.json --out ./packets/may
PASS: three-way reconciliation tie out (...)
```

This turns "hope their file matches our fixtures" into **"their file loads, or the tool tells them
exactly how to make it load."**

### Widened alias + date coverage (so many real exports load with NO map)

The mapping escape hatch is the fallback; the common cases are covered by **wider built-in aliases**
drawn from the exports the target buyer actually uses, so a typical QuickBooks / bank / rent-roll export
parses with **no `--map` at all**:

- **bank:** `Withdrawal`/`Withdrawal Amt.`/`Debit Amount` and `Deposit`/`Deposit Amt.`/`Credit Amount`
  split columns, a `Posting Date`/`Transaction Date`, a `Check #`/`Ref`, and a running-`Balance` column
  the parser ignores.
- **QuickBooks ledger:** `Num`/`Clr`/`Split`/`Account` columns are tolerated, and the payee is read from
  `Name`/`Payee`.
- **rent roll:** `Tenant`/`Resident`/`Lessee`/`Lease` (and `Name`), and either `Amount Paid`/`Payment`
  (a credit) or `Amount Due`/`Charge` (a debit), with a `Balance` column ignored. Note a two-word
  `Tenant Name` is **not** itself an alias — it is exactly the header the `--map` example below maps;
  the no-map headers are the single-word forms above.

Dates now parse beyond ISO `YYYY-MM-DD`, `M/D/YYYY`, and OFX `YYYYMMDD`: the textual forms
`Mon DD, YYYY` (e.g. `Jan 5, 2024`, `September 5 2024`, `Sept. 30, 2024`) and `DD-Mon-YYYY` (e.g.
`5-Jan-2024`, `05-Jan-24`) are accepted. Every date is still **calendar-validated** — `Feb 30, 2024` or
an unknown month name is a **named error**, never coerced — keeping the parser strict even as it accepts
more shapes.

> **A clean `inspect` is not a PASS.** `inspect` only confirms a file **parses**; it makes no
> three-way, computes no balances, and attests nothing. The broker remains the legal trust-account
> custodian, and a qualified CPA must still review the reconciliation **packet** — exactly as stated in
> the disclaimer at the top of this document. `inspect`, `--map`, and the widened aliases change **how a
> file gets in**, never **what a PASS means**.

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
              `vh trust inspect`   — read-only parse diagnostic over ONE file
                                     (same parse primitives; never fails closed)
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
- **Run the two-month design-partner script with 1–2 brokers** (e.g. via NARPM). The concrete,
  decision-ready validation is a script the engine already supports — and it now **leads with the
  de-risked onboarding step** so a real export's first contact with the tool is "it loads, or the tool
  tells you how," not a dead-end parse error:
  1. **FIRST** have the partner run `vh trust inspect <eachFile> --as <type>` on their **real** files to
     confirm each **parses** (fixing any header miss with `--map <logical>=<header>` — see **Onboarding:
     inspect before you reconcile** above). This converts the single most likely pilot-killer — ingest
     choking on a real broker's export — from a dead end into a self-service fix **before** any
     reconciliation runs.
  2. **THEN** run the two-month reconcile script: have the partner run
     `vh trust reconcile … --state <code> --emit-close month1.json` on their **real month-1** files, then
     re-run on **month-2** files with `--prior-close month1.json`, and confirm (a) the three balances tie
     out both months, (b) the roll-forward is clean (no `CONTINUITY_BREAK`), and (c) the exceptions read
     correctly.

  That **two-month run IS the willingness-to-pay validation** — it shows the recurring monthly product
  working past month one, which a single-period demo cannot; leading with `inspect` makes sure month one
  even gets that far (P-5 #3).

- **Deploying the web front-door.** `vh trust serve` runs the broker-facing browser UI **locally**
  (localhost only by default). Exposing it to others — behind **your** nginx/Cloudflare on **your** own
  domain with TLS and access control — is a human deploy step (see **The web front-door** above). The
  loop never auto-deploys it and never binds anything but localhost by default.

Hosting, billing (a SaaS subscription), and pricing are likewise human steps. Income comes from selling
the product to paying customers — **never** from a token, coin, sale, or yield scheme.

---

## See also

- [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md) — the project-wide trust posture.
- [`docs/DATALEDGER.md`](DATALEDGER.md) and [`docs/PROOFPARCEL.md`](PROOFPARCEL.md) — the sibling
  products on the shared provenance core.
