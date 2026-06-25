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

The **security-deposit segregation** check is deliberately hard to fool. It guards against **two**
distinct ways an un-segregated deposit could *silently* clear — neither of which it allows
(`trustledger/reconcile.js`). See **Security-deposit segregation: per-beneficiary, single-source**
below for the full rule.

---

## Security-deposit segregation: per-beneficiary, single-source

The flagship out-of-trust finding (`security_deposit_segregation`, an **ERROR** that FAILs the gate) is
the one a broker most needs to be **un-foolable**: a security deposit the broker received but never moved
to a segregated account is exactly the commingling state regulators sanction for. A naïve "did the
deposits add up to the transfers?" total has **two** silent-false-pass holes, and TrustLedger closes
**both**. A segregation transfer's coverage is therefore counted **(1) from a single source** and
**(2) matched per beneficiary** before any deposit is considered covered.

### Mechanism 1 — single-source counting (one source, not two)

A single real segregation transfer is recorded **twice**: once in the QuickBooks **book** and once on the
**bank** statement — it is the *same* money movement seen from two sources, and `match.js` pairs the two
copies. Summing coverage across **both** sources would count one $X transfer as **$2X** of coverage,
which can silently clear a genuinely un-segregated deposit — a false negative on the very finding the
product exists to catch. So coverage is counted from **one** authoritative source (**the book**); the
bank-side copy is the mirror of the same movement and **adds no new segregation**, so it adds no coverage
(`trustledger/reconcile.js` — the bank list is intentionally unused for the segregation sum). This is the
"one source" rule: it cannot silently clear an un-segregated deposit by **double-counting one transfer**.

### Mechanism 2 — per-beneficiary matching (no spill between tenants)

Trust law requires **each** tenant's deposit be held **separately**, so coverage is matched **per
beneficiary** — never from a single pooled total (T-40.1). A transfer attributed to tenant **X** covers
**only X's** deposits; its excess does **not** spill onto another tenant **Y's** un-segregated deposit.
A pooled total hides a real shortage whenever one tenant is **over-segregated** and another is
**under-segregated** by the same amount: the totals net to zero and the naïve check **PASSes**, even
though tenant Y's deposit is sitting un-segregated. Per-beneficiary matching pins each tenant's surplus
to **that tenant**, so Y's deposit is correctly **FLAGGED** and the at-risk beneficiary is **named** in
the finding (T-40.2). A transfer that names **no** recognizable beneficiary stays a **generic residual
pool** that can clear at most a still-uncovered deposit — it can never silently absorb one tenant's
shortage into another's surplus. This is the per-beneficiary rule: it cannot silently clear an
un-segregated deposit by **netting one tenant's shortage against another tenant's surplus**.

Together the two mechanisms make the segregation check **strictly non-looser** than a naïve total: each
can only **ADD or RE-ATTRIBUTE** a finding, never **remove** a real one. Both are pure, deterministic
free-text/structured classification in `trustledger/reconcile.js` (`classifySecurityDeposits` /
`attributeSegregation`): no clock, no I/O, byte-reproducible.

> **DRAFT / NOT LEGAL ADVICE.** The policies that SHIP with TrustLedger
> (`trustledger/fixtures/policy/*.json`) are **DRAFT skeletons**, not legal advice and **not a claim of
> regulatory compliance**. The baseline reproduces the built-in defaults verbatim; the example state
> file carries a **PLACEHOLDER** citation. A qualified **CPA and/or counsel must review and SIGN** the
> per-state severity mapping and its statute citations for the actual jurisdiction before the gate is
> relied on. Selecting a policy does **not** make a packet legal advice and does **not** discharge the
> broker's duty as the responsible legal custodian of trust funds. (STRATEGY.md › P-5 #1/#2.)

Whether a flagged un-segregated deposit is graded ERROR (the baseline) or re-graded by a state is a
**per-state CPA decision via the existing policy layer** — `security_deposit_segregation` is one of the
**legal exception types** a reviewed policy MAY re-grade, exactly like every other type, with **no engine
change** and **no new `needs-human` item** beyond the per-state policy sign-off P-5 #2 already tracks.

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
ambiguous_deposit     unreconciled_bank   unreconciled_book
subledger_out_of_balance  negative_tenant_ledger  bank_book_mismatch
continuity_break
```

`ambiguous_deposit` is raised for a book deposit whose beneficiary type cannot be
determined — a deposit-scale inflow that calls itself a "deposit" but carries no
recognizable keyword (not clearly rent, an owner contribution, or a labeled
security deposit) and is not an explicitly-labeled receipt. Its default severity
is `warning` (it MIGHT be an un-segregated security deposit hiding as a generic
deposit, so a human must look — but absent a security-deposit signal it is not
auto-escalated to the out-of-trust `error` a confirmed unsegregated deposit
gets); like every other type, a per-state policy MAY re-grade it. The
silent-false-pass hazard it exists to close, the WARNING default + the
explicit-label escape valve, and grading it to ERROR per state are documented in
**Why `ambiguous_deposit` exists: the silent-false-pass hazard** below.

`continuity_break` is raised only when a run chains from a prior period's close
(`--prior-close`) and this period's opening does not roll forward penny-exact from
that prior period's signed ending. Its default severity is `error` (a broken
roll-forward means the books do not actually continue from the signed prior
period), and — like every other type — a per-state policy MAY re-grade it (e.g. a
state that treats a documented timing roll-forward difference as a `warning`).

`negative_tenant_ledger` is raised when an **individual** beneficiary's own
sub-ledger balance is negative (beyond `toleranceCents`) — the broker is holding
*less than zero* in trust for that person, because their money was spent or used
to cover another beneficiary's shortfall. It is **orthogonal** to
`subledger_out_of_balance`: the pooled SUM of all sub-ledgers can tie perfectly to
the book while one tenant's surplus masks another tenant's deficit, so this check
fires per-beneficiary **independently of whether the SUM ties** (both can fire at
once). Control/sink accounts (an owner's-own-funds line, an
`escrow`/`segregated`/`trust` sink, an `operating`/`reserve`/`suspense` control
line) are excluded — their negative balance is structural, not a tenant shortage.
Its default severity is `error` (a negative individual ledger is out of trust on
its own); like every other type, a per-state policy MAY re-grade it.

**How a line is recognized as a control account (and its failure mode).** Two
signals exclude a negative line from `negative_tenant_ledger`, in priority order:

1. **A structured `controlAccount: true` marker on the sub-ledger row
   (authoritative).** Set it on the rent-roll row(s) for that party. This is a
   deliberate assertion by the producer of the data — it is preferred over any
   guess and excludes the line regardless of what its name reads like (the same
   way an explicit deposit label beats a free-text guess for `ambiguous_deposit`).
2. **A leading-token name heuristic (fallback, used only without a marker).** A
   line is treated as a control designation when the **first** whole-word token of
   its party name is `owner`/`owners`/`escrow`/`segregated`/`trust`/`operating`/
   `reserve`/`suspense` — i.e. the name leads with the account designation, like
   `Owner Acme` or `Escrow`. This is word-bounded, so an ordinary surname that
   merely contains a control token (`Owens`, `Crowell`) is **not** excluded.

**Failure mode you must know:** the name heuristic only looks at the **leading**
token, so a real beneficiary whose name contains a control word in a *non-leading*
position — `Smith (OWNER)`, `Jones Family Trust`, `Tenant 12 Reserve St` — IS
correctly flagged when negative (it is not treated as a control account). But the
heuristic **cannot** tell a genuine company beneficiary whose name *leads* with a
control word (e.g. `Operating Co LLC`) apart from an `Operating` control account,
so such a line is excluded by name alone and a negative balance on it would not
surface. To protect a beneficiary whose name leads with a control word — and to
mark any control account unambiguously rather than relying on its name — set the
structured `controlAccount` marker, which is authoritative over the name guess.
The precomputed `{ party: cents }` balance-map form has no per-key slot for the
marker, so a control account supplied that way must rely on the leading-token
name (or be supplied as rows).

### Why `ambiguous_deposit` exists: the silent-false-pass hazard

A keyword-only security-deposit detector has a quiet, dangerous failure mode. The
segregation check that produces the out-of-trust `security_deposit_segregation`
ERROR only fires when a book inflow **looks like** a security deposit — it matches
a `security deposit` / `damage deposit` / `deposit held` keyword. That keyword
match is the **only** signal. So a real, un-segregated security deposit that a
bookkeeper recorded as a bare **`Deposit - 12B Smith`** — no "security", no
"damage", just the generic word *deposit* and a tenant — **never trips the
detector**. It is not rent, not an owner contribution, not a labeled security
deposit; the keyword-only check simply says nothing, the three balances still tie
out (the money cleared and sits on the sub-ledger), and the gate **PASSes**. That
is a **silent false pass**: a possibly out-of-trust deposit slips through *because
it was mislabeled*, and a keyword-only detector cannot tell the difference between
"this is definitely fine" and "I could not classify this." The broker gets a green
PASS that does not mean what they think it means.

`ambiguous_deposit` closes that gap by making **"I could not classify this"** a
**LOUD, gradable finding** instead of silence. It is raised for a book deposit
whose beneficiary type cannot be determined — a deposit-scale inflow that calls
itself a "deposit" (the word, or `kind === "deposit"`), carries an attributed
party, but offers **no recognizable purpose keyword** (it is not clearly rent, an
owner contribution, a refund, a fee, a transfer, … — the closed
`RECOGNIZED_DEPOSIT_PURPOSE` allowlist) **and** is not an explicitly-labeled
receipt. The predicate is `trustledger/reconcile.js` › `isAmbiguousDeposit` (pure:
free-text classification only, no fs/http/clock). A row that already matches the
security-deposit keyword is handled by the segregation ERROR and is **not**
re-flagged here, so the same row is never double-counted.

**The WARNING default + the explicit-label escape valve.** The default severity is
`warning`, not `error`. The reasoning is deliberate: an ambiguous deposit *might*
be an un-segregated security deposit hiding as a generic deposit (so a human must
look — silence would be the false pass above), but absent any security-deposit
signal it is **not** auto-escalated to the out-of-trust `error` a *confirmed*
unsegregated deposit gets. A WARNING does not by itself FAIL the gate, so a firm
whose three balances tie out and whose only finding is one ambiguous deposit still
PASSes — it is **not over-FAILed** for a labeling gap. The escape valve is for the
producer who already knows what the row is: an **explicit per-record label**
suppresses the finding (`hasExplicitDepositLabel`). Any **one** of these markers
suffices — `kind: "rent"` (an explicit rent receipt), a non-empty `depositType`
(the beneficiary type was stated), `ambiguous: false` (the caller asserts it is
determined), or `expected: true` (a known/expected line). A marker is a
deliberate, structured assertion by whoever produced the row — distinct from the
engine *guessing* from free text — so it is authoritative and the deposit is no
longer flagged. This keeps a genuinely-unlabeled deposit LOUD while letting an
exporter that knows its own data turn the finding off cleanly, without weakening
the detector for everyone else.

**Grading it to ERROR is a per-state CPA decision, via the EXISTING policy layer.**
Whether an unclassifiable deposit should be a mere WARNING or a hard, out-of-trust
ERROR is **not** a universal fact — it depends on the state's trust-account
statute, exactly like every other severity. So TrustLedger does **not** bake the
escalation in. `ambiguous_deposit` is one of the **legal exception types** above, so
a per-state policy MAY re-grade it through the **same data-not-code** override
mechanism every other type uses: a reviewed policy with
`severities.ambiguous_deposit: "error"` flips the verdict on the *same* files (a
clean-tying account with one ambiguous deposit goes PASS → FAIL, exit `0` → `3`),
with its statute `citation` carried into the packet. The bundled
`ambiguous-deposit-example` draft (`vh trust reconcile --state ambiguous-deposit-example`)
demonstrates exactly this escalation with a **PLACEHOLDER** citation — illustrative
only, not a real jurisdiction. Because this rides the existing policy layer, the
**DRAFT / NOT LEGAL ADVICE** posture from that section applies **verbatim**:

> **DRAFT / NOT LEGAL ADVICE.** The policies that SHIP with TrustLedger
> (`trustledger/fixtures/policy/*.json`) are **DRAFT skeletons**, not legal advice and **not a claim of
> regulatory compliance**. The baseline reproduces the built-in defaults verbatim; the example state
> file carries a **PLACEHOLDER** citation. A qualified **CPA and/or counsel must review and SIGN** the
> per-state severity mapping and its statute citations for the actual jurisdiction before the gate is
> relied on. Selecting a policy does **not** make a packet legal advice and does **not** discharge the
> broker's duty as the responsible legal custodian of trust funds. (STRATEGY.md › P-5 #1/#2.)

So deciding that `ambiguous_deposit` should hard-FAIL in a given state is a
**fill-in-the-table** task for a qualified human (set `severities.ambiguous_deposit`
to `error` with the statute citation, have a CPA/counsel sign it) — **no engine
change**, and **no new `needs-human` item** beyond the per-state policy sign-off
P-5 #2 already tracks.

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
| `ambiguous-deposit-example` | `EXAMPLE-STATE (ambiguous-deposit hard-fail)` | **ILLUSTRATIVE ONLY.** Escalates `ambiguous_deposit` (a book deposit whose beneficiary type cannot be determined) from the baseline WARNING to ERROR, with a **PLACEHOLDER** citation, so an unclassifiable deposit becomes a hard FAIL until it is classified. Not a real jurisdiction. |
| `negative-tenant-ledger-example` | `EXAMPLE-STATE (negative-ledger re-grade)` | **ILLUSTRATIVE ONLY.** Re-grades `negative_tenant_ledger` (an individual beneficiary whose own trust sub-ledger is negative) from the baseline ERROR **down** to WARNING, with a **PLACEHOLDER** citation — showing the re-grade is possible by state with **no schema change** (one entry in the existing `severities` map). A negative individual ledger is out of trust in most jurisdictions, so the de-escalation is illustrative, **not** a recommendation. Not a real jurisdiction. |

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

## Sealing the packet: tamper-evident, independently verifiable

The audit packet a broker hands a state real-estate examiner months later is, by default, a **printout**:
nothing lets the examiner — or the broker defending themselves — prove "this is the **exact** packet
TrustLedger produced from these **exact** source files, byte-for-byte unaltered." A text editor can
silently rewrite a dollar figure and nothing detects it. The optional **seal** closes that evidentiary
gap. With `--seal`, `reconcile` (after writing the packet) emits a small JSON **seal** that binds the
**three source inputs**, **every emitted packet file**, **and** the run's **verdict** (PASS/FAIL,
`reportDate`, `period`) plus each input's **logical role** into **one content-addressed Merkle root**. The
read-only, offline `verify-seal` later **re-derives** that root from the bytes on disk and confirms — or
pinpoints exactly what changed.

The seal **reuses the project's proven provenance core verbatim** (`cli/core/manifest.js` /
`cli/hash.js` `hashEntries`/`pathLeaf`/`buildTree`, the same convention `vh hash <dir>` and the on-chain
`verifyLeaf` use). There is **no second hashing scheme**, no new dependency, no contract change, no
network, and no key. The seal module (`trustledger/seal.js`) is **pure / I-O-free / byte-deterministic**:
the CLI reads the files and hands it already-loaded `{ relPath, bytes }` entries; given the same inputs it
returns a byte-identical seal.

> **Read this too — what the seal IS, and is NOT.** A seal is **tamper-evidence**, **NOT a trusted
> timestamp** and **NOT a legal opinion**. It proves the inputs + packet are byte-for-byte what was
> sealed, and that the recorded verdict/date/period and each input's role are bound into the **same**
> root — but it does **NOT** prove **WHEN** the sealing happened. The `reportDate` is bound into the root
> so it cannot be edited undetected, yet a self-asserted date still rides the **human-owned trust-root**:
> standing up a real signing key or a trusted timestamp for "**sealed on date T**" is **P-3** (see
> [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md)) and is a **needs-human** step the loop never executes.
> The seal also does **NOT** validate whether the reconciliation is **correct** or **compliant** — the
> custodian/CPA posture at the top of this document is unchanged: TrustLedger **aids** reconciliation, the
> broker remains the responsible legal custodian, and a qualified CPA must still review the packet. The
> seal makes that review one of a **tamper-evident** packet, not an editable printout.

### The seal schema

A seal is a single JSON object (`trustledger/seal.js` is the single source of truth: pure `buildSeal` /
`validateSeal` / `readSeal` / `serializeSeal` / `verifySeal`). **Every field is UNTRUSTED transport** —
`verify-seal` re-derives the root from the supplied bytes and never trusts the seal's own stored hashes.
Every field:

| Field | Type | What it is |
| --- | --- | --- |
| `kind` | string `"trustledger.reconcile-seal"` | Identity, disjoint from the dataset/parcel manifests so a seal can never be confused for one of them. Any other value is a hard, named `SealError`. |
| `schemaVersion` | integer (currently **1**) | Pins the seal shape. Any unsupported version is a hard `SealError` — never silently coerced. |
| `note` | string | The standing in-band trust caveat (tamper-evidence, NOT a timestamp, NOT a legal opinion; verify re-derives). `validateSeal` REJECTS a seal whose `note` has drifted, so the caveat can never be quietly stripped. |
| `root` | 0x + 64-hex | The single content-addressed Merkle **root** over the **whole committed set**: the inputs + the outputs + a synthetic verdict/role **HEADER** leaf. This is the load-bearing field — `verify-seal` recomputes it from the bytes on disk. |
| `fileCount` | non-negative integer | The number of real files committed (inputs + outputs). The header leaf is re-derived, not listed, so it is not counted. Must match the entry total or it is a `SealError`. |
| `verdict` | `{ pass: boolean, reportDate: "YYYY-MM-DD", period: string \| null }` | The recorded reconcile **facts** — what the seal NAMES that it sealed. These are bound into the HEADER leaf (and thus the root), so editing any of them makes the root fail to re-derive. They are FACTS the seal carries, **not** proofs (a bound date is still not a trusted timestamp). |
| `inputs` | array of `{ role, relPath, contentHash, leaf }` | The three source files, each tagged with its logical **role** — one of `bank`, `book`, `rentroll` — used **at most once** (no duplicate/unknown role). `contentHash` is the SHA-256 of the file bytes; `leaf` is the path-bound `pathLeaf(relPath, contentHash)`. Sealed by **basename** so the binding travels next to the packet. |
| `outputs` | array of `{ relPath, contentHash, leaf }` | Every emitted packet file (the HTML + CSV, plus any `--emit-close` close artifact). No `role` (roles partition INPUTS only). |

The synthetic **HEADER leaf** is *not* a stored field — it is re-derived deterministically on
validate/verify from the seal's own `verdict` + the input role→relPath bindings, hashed and path-bound by
the **same** `pathLeaf` convention every real file uses. That is why the verdict and the role partition
are tamper-EVIDENT in the **same** root as the files, with **no second hashing scheme**: editing
`verdict.pass`, the `reportDate`, the `period`, OR swapping an input's role changes the header content →
its leaf → the root, which then no longer re-derives. `validateSeal` is **strict** — a wrong
`kind`/`schemaVersion`, a drifted `note`, a missing/garbled verdict, a missing/duplicate/unknown input
role, a malformed hex `contentHash`/`leaf`/`root`, a `leaf` inconsistent with its `(relPath,
contentHash)`, or a `root` that does not re-derive from the listed entries + the verdict/role header is a
named `SealError`, never half-accepted.

### The `--seal` write flow

```
vh trust reconcile <bank> <ledger> <rentroll> --out <dir> --seal [<file>]
```

- `--seal` **requires `--out`**: without `--out` the command writes **nothing** (it streams to stdout), so
  there is no emitted packet to seal — passing `--seal` alone is a **usage error (exit `2`)**.
- The seal is emitted **AFTER** every packet file (and after any `--emit-close` close), so it binds the
  **whole** emitted artifact set.
- Without a `<file>`, the seal lands at a default name **next to the packet**:
  `reconciliation-<reportDate>-seal.json` inside `--out`. A caller-named `--seal <file>` writes there
  instead.
- The three source **inputs** are sealed by their **basename** (e.g. `bank.csv`) so the portable handoff
  ships each source next to the seal; the packet **outputs** are sealed by their seal-dir-relative path
  (a basename when the seal sits in the `--out` dir, the common case). If two sealed files would flatten
  to the **same name**, that is a named IO error (exit `1`) telling you to rename a source — the partition
  must stay unambiguous.

### The offline `verify-seal` flow

```
vh trust verify-seal <sealfile> [--dir <d>] [--inputs <d>] [--json]
```

This is the **independent** companion: given **only** the seal file (and the files it names), it
re-derives each listed file's content hash and the manifest root **from the bytes on disk** and compares
against the seal's stored expectation. It needs **no key, no network, no contract** — purely the seal
core's `verifySeal`, and it **writes nothing**.

- The seal is **read and strictly validated first** (`readSeal`). A malformed or unreadable seal is an
  **IO error (exit `1`)** — it is never half-accepted nor treated as "everything changed".
- **Output files** resolve relative to `--dir` (if given) else the **seal file's own directory** (the seal
  stored output relPaths relative to where it was written). **Source inputs** (sealed by basename) resolve
  relative to `--inputs` (if given) else the **same base dir** — the portable handoff ships the sources
  next to the seal, so the default just works; `--inputs <d>` is for an examiner who keeps the originals in
  a separate folder.
- A sealed file that is **absent** on disk is **not** an abort — it is localized as **MISSING** (the verify
  tolerates a partial supplied set). The verdict is **ACCEPTED** only when **every** sealed file MATCHes,
  none is MISSING/UNEXPECTED, no role mismatched, AND the recomputed root equals the sealed root.

**Exit codes** (mirroring the rest of the family):

| Exit | Meaning |
| --- | --- |
| `0` | **ACCEPTED** — every sealed file re-derives byte-for-byte, no role swap, and the root matches |
| `3` | **REJECTED** — at least one CHANGED / MISSING / UNEXPECTED file, a role mismatch, or the root does not re-derive (the report lists exactly which) |
| `2` | usage error (missing `<sealfile>`, bad/unknown flag, extra positional) |
| `1` | IO error (the seal file is unreadable or not a valid seal) |

### Per-file CHANGED / MISSING / UNEXPECTED (the localization)

`verify-seal` is **authoritative by re-computing** from the supplied bytes, and it **localizes** every
change so no tampered file can verify clean. Each file lands in exactly one bucket:

- **MATCH** — present in both, recomputed `contentHash` equals the sealed one.
- **CHANGED** — present in both, recomputed `contentHash` **differs** (a tamper, localized to that exact
  file; the report prints the sealed vs on-disk hash).
- **MISSING** — sealed, but absent from the supplied set (a dropped/renamed file).
- **UNEXPECTED** — supplied, but **not** named in the seal (an added/renamed file).
- **ROLE** — a file present in both whose **supplied role differs from its sealed role** (a bank↔book
  swap), surfaced and localized rather than silently accepted.

Because the verdict and the role bindings are committed into the **same** root, editing the verdict
(PASS↔FAIL, the date, the period) or swapping a role makes the **recomputed root** differ — `rootMatches`
goes `false` and the run REJECTs — even when every file's own bytes are untouched. The header change is
reported against the seal HEADER (the root no longer re-derives), exactly as a file change is reported
against its path.

### The seal MAY be signed (the shared attestation envelope)

A seal is, by itself, **unsigned**. It MAY be **wrapped** by the project's existing signed-attestation
envelope (`cli/core/attestation.js`) so a human can vouch for it via the **same** shared signing path —
the seal's canonical bytes (`serializeSeal`) become the attestation payload; `signSealWith` /
`verifySignedSeal` round-trip it. That signature proves **WHO** vouched for the sealed packet — still
**not** a trusted timestamp ("sealed since date T" remains the human trust-root, **P-3**) and still not a
legal opinion (the CPA review governs). Provisioning a real signing key is a **needs-human** step the loop
never performs.

### Worked example: reconcile `--seal` → hand over → `verify-seal`

Reconcile a month and seal the packet:

```
$ vh trust reconcile bank-2026-05.csv ledger-2026-05.csv rentroll-2026-05.csv \
    --period 2026-05 --date 2026-05-31 --out ./packets/may --seal
PASS: three-way reconciliation tie out (...); 1 exception(s) [0 error, 0 warning, 1 info]
wrote ./packets/may/reconciliation-2026-05-31-balances.csv
wrote ./packets/may/reconciliation-2026-05-31-exceptions.csv
wrote ./packets/may/reconciliation-2026-05-31.html
wrote seal ./packets/may/reconciliation-2026-05-31-seal.json
```

The packet is **three** files — the HTML report plus the **balances** and **exceptions**
CSVs — so the seal binds **6** files: the **3** source inputs (bank / book / rentroll) plus
those **3** emitted outputs.

**Hand over** the `--out` directory **plus** the three source files (copied next to the seal) and the seal
itself. Months later, an examiner verifies it offline — no key, no network:

```
$ vh trust verify-seal ./packets/may/reconciliation-2026-05-31-seal.json; echo "exit=$?"
# vh trust verify-seal — ./packets/may/reconciliation-2026-05-31-seal.json
The broker remains the responsible trust-account custodian. A seal is TAMPER-EVIDENT, NOT a trusted timestamp ... verify-seal RE-DERIVES the root from the files on disk ...
sealed root:     0x...
recomputed root: 0x...
root matches:    yes
sealed verdict:  PASS (reportDate 2026-05-31, period 2026-05)
files: 6 matched, 0 changed, 0 missing, 0 unexpected, 0 role-mismatched

ACCEPTED — every sealed file re-derives byte-for-byte and the root matches.
exit=0
```

Now **tamper** with one packet file — edit a dollar figure in the HTML — and re-verify. The change is
**localized** and the run REJECTs:

```
$ vh trust verify-seal ./packets/may/reconciliation-2026-05-31-seal.json; echo "exit=$?"
...
root matches:    NO
files: 5 matched, 1 changed, 0 missing, 0 unexpected, 0 role-mismatched

REJECTED — the files on disk do NOT match the seal:
  CHANGED    reconciliation-2026-05-31.html: sealed 0x... != on-disk 0x...
exit=3
```

The same REJECT-and-localize happens if you **drop** a sealed file (`MISSING`), **add** one (`UNEXPECTED`),
**rename** one (a `MISSING` + an `UNEXPECTED`), **swap** the bank and book inputs (`ROLE`), or edit the
**verdict/date/period** (the root no longer re-derives). No tampered file can verify clean.

---

## The packet: HTML + balances/exceptions CSV (print-to-PDF ready)

With `--out <dir>`, the command writes a **dated** packet into that directory (created if absent):

- **HTML** (`reconciliation-<date>.html`) — a single self-contained document. Open it in any browser
  and **Print → Save as PDF** to file the reconciliation with your records.
- **balances CSV** (`reconciliation-<date>-balances.csv`) — the three-way balance lines as a
  spreadsheet, so the tie-out arithmetic is re-checkable column by column.
- **exceptions CSV** (`reconciliation-<date>-exceptions.csv`) — the exception list as a spreadsheet,
  so a bookkeeper can work the findings line by line.

That is **three** files per run; `--seal` binds all three (plus the three source inputs) into one root.

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

### In-browser onboarding: inspect & map a file that won't load (no terminal)

A non-technical broker's **first** contact with the tool is "does my real export load?" — and a real
bank/QuickBooks/rent-roll export routinely has a header no built-in alias matches. On the CLI that is
the `vh trust inspect` / `--map` self-service fix (see **Onboarding: inspect before you reconcile**
above). The web door exposes the **same** fix **in the browser**, so the buyer who will never open a
terminal can do it too — the onboarding step is the **page**, not a command line.

1. **Drop a file.** If it does not parse cleanly, the page does **not** dead-end on a raw error. It
   shows the file's **detected header columns**, a **logical-field → matched-column** table (the same
   `diagnoseSource` report the CLI prints), the **parse tally**, a **sample**, and **every** failing
   row — never a stack trace.
2. **Map a missing field.** For each **required** field the auto-detect could not bind, the page shows a
   **dropdown of the file's actual header columns**. Pick the column that holds that field and press
   **Confirm mapping**; the page re-checks the file under your map and clears the miss when it lines up
   (or shows what is still missing).
3. **Reconcile.** The map you confirmed is **threaded into the real reconcile run** for that file (under
   the same `bank`/`ledger`/`rentroll` key the engine uses), so the fix applies to the actual three-way
   reconciliation — not just the preview. Drop all three files and watch the balances tie out.

This is the **browser equivalent** of the CLI `vh trust inspect <file> --as <type> --map <logical>=<header>`
loop: it runs the **same** `diagnoseSource` parse primitives (via the read-only `POST /api/inspect`
endpoint, which writes nothing server-side, exactly like `/api/reconcile`), and it accepts the **same**
`{ <logicalField>: <headerName> }` column-map override. A clean in-browser inspect means the file
**loads**, **not** that the books are **right** — the three-way reconciliation, and a qualified CPA's
review of the packet, still govern, exactly as the disclaimer at the top of this document states.

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

## Entitlements & licensing

TrustLedger is **free to try** and **licensed for the paid surface**. The baseline three-way reconcile
and the file inspector are open to anyone — a broker can prove the tool ties out their own files before
paying a cent. The **paid features** (per-state policy packs, the tamper-evident seal) are gated behind a
**signed, offline-verifiable license** the vendor issues to each paying customer.

A license is just one more product on the project's shared signed-attestation envelope (the same one the
[seal](#sealing-the-packet-tamper-evident-independently-verifiable) uses): an **unsigned payload**, signed
with the vendor's offline key, and verified locally by **re-deriving** the signer and pinning it to a
**vendor address** the customer already trusts. There is **no license server**, **no network call**, and
**no key on the customer's machine** — verification is pure and offline.

### The free-vs-paid surface

| Surface | Tier | Entitlement required |
| --- | --- | --- |
| `vh trust reconcile` (baseline severities) | **Free** | — |
| `vh trust inspect` / web "Check this file" | **Free** | — |
| Web baseline reconcile (`POST /api/reconcile`, no `state`/`policy`/`seal`) | **Free** | — |
| `--state` / `--policy` per-state policy packs (CLI **and** web) | **Paid** | `multi_state_policy` |
| `--seal` tamper-evident reconciliation seal | **Paid** | `seal` |
| Unlimited reconcile runs (no per-period cap) | **Paid** | `unlimited_reconcile` |

With **no** license the free paths behave **byte-for-byte** as they always did; only the paid surfaces are
gated. A wrong, expired, or under-entitled license is a **named refusal** — it never silently downgrades to
a free run.

### The license payload schema

`vh trust license issue` mints a signed `*.vhlicense.json` whose **canonical payload** carries exactly these
fields (every field is part of the signed bytes — editing any of them breaks the signature):

| Field | Type | Trusted vs hint |
| --- | --- | --- |
| `kind` | `"trustledger-license"` | **Structural** — fixes the artifact type; a wrong `kind` is rejected. |
| `schemaVersion` | integer (`1`) | **Structural** — an unsupported version is rejected, never guessed. |
| `note` | string | **Structural** — the standing trust caveat; `validateLicense` rejects a license whose note has drifted, so the caveat can never be quietly stripped. |
| `licenseId` | non-empty string | **Hint** — the vendor's own identifier for this license (for the vendor's records; not interpreted by the gate). |
| `customer` | non-empty string | **Hint** — who the license was issued to (self-asserted by the vendor; shown, not enforced). |
| `plan` | non-empty string | **Hint** — the plan label the vendor sold (informational). |
| `entitlements` | non-empty array of known flags | **Trusted** — the closed set of paid features this license unlocks. Drawn ONLY from the `ENTITLEMENTS` table below; an unknown flag is a hard error. This is what the gate consults. |
| `issuedAt` | canonical ISO-8601 UTC instant | **Trusted-but-self-asserted** — the window start. The gate compares `now` against it, but it is the vendor's own clock (a self-asserted date, NOT a trusted timestamp — see TRUST-BOUNDARIES). |
| `expiresAt` | canonical ISO-8601 UTC instant (strictly after `issuedAt`) | **Trusted-but-self-asserted** — the window end; same caveat. |

The **closed entitlement table** (the only place a paid feature enters the system) is:

| Entitlement flag | Unlocks |
| --- | --- |
| `multi_state_policy` | Multi-state trust-accounting policy packs (`--state` / `--policy`). |
| `seal` | The tamper-evident reconciliation seal (`--seal` / `verify-seal`). |
| `unlimited_reconcile` | Unlimited reconciliation runs (no per-period cap). |

A typo'd or forged entitlement can never grant a feature: it is not in the table, so `validateLicense`
rejects it. To add a paid feature, a flag is added to the `ENTITLEMENTS` table — there is no other channel.

### The license is an UNTRUSTED container — verification re-derives

Exactly like the close artifact and the seal (and per
[`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md)): **the license is an UNTRUSTED transport container.**
`verifyLicense` never trusts the file's own claims. It **re-derives** the signer from the exact embedded
bytes (EIP-191 recovery) and **pins** that recovered address to the `vendorAddress` the customer supplies.
A license that merely *says* it was signed by the vendor but recovers to a different key is `wrong_issuer`,
not trusted. Only when the signature re-derives to the pinned vendor key **and** `now` is within
`[issuedAt, expiresAt]` is the verdict `valid`; only then do its entitlements mean anything.

The verify is **pure and offline**, taking `now` as an explicit argument (it never reads the system clock),
so the same container + same `now` + same `vendorAddress` always yields a byte-identical verdict. The
localized reject reasons are `malformed` / `bad_signature` / `wrong_issuer` / `not_yet_valid` / `expired`.

### How a customer's tool verifies a license OFFLINE

Both the CLI and the web door run the **same** gate. The customer needs only (1) the signed
`*.vhlicense.json` the vendor delivered and (2) the **vendor address** the vendor published — no key, no
network:

```
vh trust license verify customer.vhlicense.json --vendor 0xVENDOR…
# VALID  -> exit 0 ; INVALID (wrong_issuer / expired / …) -> exit 3
```

On the **web door**, `POST /api/reconcile` accepts an optional `{ license, vendorAddress }` in the JSON body
and threads the identical gate. A gated request (`state` / `policy` / `seal`) **without** a valid license is
a **named 4xx**: `license_required` (402) when no license was supplied, or `license_invalid` (403) with the
precise reason when one was. The page shows a clear *"this feature requires a license"* notice rather than a
raw error. The server holds **no key** and verifies **offline** against the supplied `vendorAddress`.

### Worked example: issue → verify → reconcile `--license`

The **vendor** (offline, with their own key) mints a license for a paying customer:

```
$ vh trust license issue \
    --customer "Acme Realty LLC" --plan pro-annual \
    --entitlements multi_state_policy,seal \
    --expires 2027-01-01T00:00:00.000Z \
    --key-env VENDOR_KEY --out acme.vhlicense.json
# prints ONLY the PUBLIC vendor address + a summary + the path — the key is never echoed
vendor: 0xVENDOR…
wrote acme.vhlicense.json  (customer "Acme Realty LLC", plan pro-annual, entitlements [multi_state_policy, seal])
```

The **customer** verifies it offline against the published vendor address, then runs the paid surface:

```
$ vh trust license verify acme.vhlicense.json --vendor 0xVENDOR…
VALID — signed by the vendor, in-window; entitlements [multi_state_policy, seal]

$ vh trust reconcile bank.csv quickbooks.csv rentroll.csv \
    --state ca-example --out ./packets/may --seal \
    --license acme.vhlicense.json --vendor 0xVENDOR…
# the per-state policy AND the seal are unlocked; the packet names the governing policy
```

Without `--license`/`--vendor`, the same `--state`/`--seal` run is refused with an actionable message and the
free baseline reconcile remains available. The web door behaves identically: paste the license + vendor
address into the License fieldset, select the state, and reconcile.

---

## Plan catalog & fulfillment

Issuing a license **by hand** for every sale does not scale: a human at a terminal had to remember the
**exact** entitlement flags a tier grants and **hand-compute** the expiry (`--entitlements multi_state_policy,seal
--expires 2027-01-01T00:00:00.000Z`). That is error-prone — a typo grants the wrong tier, a mis-keyed expiry
drifts — and **un-automatable**: a billing provider's *payment-succeeded* event carries a **`planId`** and a
**paid-through date**, not a comma-list of entitlement flags. The **plan catalog** + **`vh trust license
fulfill`** close that gap: they turn "issue the right license" into **one deterministic command** a webhook can
call, with **no hand-authored entitlement list**.

> **Boundary (VERBATIM — read this first).** The loop ships **ONLY** the catalog **schema** + the order→license
> **mapping** + **ephemeral test keys**. It **NEVER** sets a price, holds a real key, runs a payment processor,
> or takes a real payment. **Provisioning the vendor key, setting the PRICE/term column in the catalog, and
> wiring the actual webhook/billing remain HUMAN-owned outward steps** (STRATEGY.md › P-6 step (3)). A plan is an
> **access description** for delivered software value — which paid features a subscription unlocks and for how
> long — **NOT a token, NOT tradeable, NOT an appreciating asset**, and the catalog makes **no claim of
> regulatory compliance**.

### The catalog schema

A plan catalog is a single, **versioned, strictly-validated** JSON file (`trustledger/plans.js` is the source of
truth: pure `validatePlanCatalog` / `getPlan`, no I/O). It is the **one** machine-readable mapping `planId →
{ entitlements, term, displayName }` over the **CLOSED** `ENTITLEMENTS` table — so an unknown entitlement or a
duplicate plan is a **hard build error**, never a silent mis-grant. Every field:

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `kind` | **yes** | string `"trustledger-plan-catalog"` | Fixes the artifact type, disjoint from a license/seal. A wrong/missing `kind` is a hard `PlanCatalogError`. |
| `schemaVersion` | **yes** | integer (currently **1**) | Pins the catalog shape. Any unsupported version is a hard error — never coerced. |
| `plans` | **yes** | non-empty array | The plan list. Emitted in `planId`-sorted order, deterministically. |
| `plans[].planId` | **yes** | non-empty string | The plan id a billing `planId` resolves against. **Duplicate ids are rejected.** |
| `plans[].displayName` | **yes** | non-empty string | A human label for the tier (shown, not enforced). |
| `plans[].entitlements` | **yes** | non-empty array of **known** flags | The paid features this plan unlocks — drawn **ONLY** from the closed `ENTITLEMENTS` table (`multi_state_policy`, `seal`, `unlimited_reconcile`). An unknown or duplicate flag is a hard error. This is what `fulfill` copies into the license **verbatim**. |
| `plans[].termDays` | **yes** | **positive integer** | The subscription term in days. When an order omits an explicit `--paid-through`, `expiresAt = issuedAt + termDays` days. A non-integer or non-positive term is rejected (never rounded/coerced). |

> **The PRICE/term column is the HUMAN fill-in.** The bundled catalog is a **DRAFT skeleton**: it ships the
> `planId → entitlements/term/displayName` mapping, but **the price and your real term are YOURS to set**.
> Editing the catalog (a data file in this validated schema) is exactly the narrow human step P-6 names — no
> engine change is needed. The shipped `_DISCLAIMER` string is ignored by the engine and exists only to keep the
> access-description posture attached to the file itself.

### The bundled draft skeleton

The catalog `fulfill` resolves against when you pass **no** `--catalog` is the bundled draft
(`trustledger/fixtures/plans/baseline.json`), read from **this package's own** fixtures dir — never the caller's
cwd. Its draft plans:

| `planId` | `displayName` | entitlements | `termDays` |
| --- | --- | --- | --- |
| `solo-monthly` | Solo (monthly) | `seal` | `30` |
| `pro-annual` | Pro (annual) | `seal`, `multi_state_policy` | `365` |
| `firm-annual` | Firm (annual) | `seal`, `multi_state_policy`, `unlimited_reconcile` | `365` |

These are a **skeleton to copy**: keep/rename the plans, set **your** `termDays`, and attach **your** price
out-of-band. Point `--catalog <file>` at your own catalog to override the bundle entirely.

### `vh trust license fulfill` (the one-command shape)

```
vh trust license fulfill --plan <planId> --customer <name> [--paid-through <ISO>] [--catalog <file>]
                         (--key-env <VAR> | --key-file <path>)
                         [--issued <ISO>] [--license-id <id>] [--out <file>] [--json]
```

`fulfill` looks the `planId` up in the catalog, copies that plan's **entitlements VERBATIM** (never re-typed),
derives the window (`--paid-through`, else `issuedAt + termDays`), and emits the **SAME** signed
`*.vhlicense.json` the existing `vh trust license verify` / `reconcile --license` gate already accept
byte-for-byte. The order→license mapping (`license.fulfillOrder`) is **pure + deterministic**: the same
`{ plan, customer, paidThrough, issuedAt }` + the same catalog yields **byte-identical** license fields.

- The vendor key is read **EXACTLY ONE** of `--key-env <VAR>` / `--key-file <path>` and is
  **read-used-discarded** — the **same** posture as `license issue` / `vh dataset sign`. The loop **never holds**
  a key; **only the PUBLIC vendor address is echoed**, never the key. Neither/both/missing/malformed key sources
  hard-error (exit `2`) with a **key-free** message.
- An **unknown plan**, a `--paid-through` **at or before** `issuedAt`, or a **malformed** `--issued`/`--paid-through`
  is a **usage error (exit `2`)** — a named reject, never a silent mis-grant.
- With `--out <file>` the signed container is written to **that** path (and **only** there — never cwd); without
  `--out` it streams to stdout. `--json` round-trips the public summary (`vendor`, `entitlements`, `issuedAt`,
  `expiresAt`, …) so a webhook handler can script it.

### From a billing event to a license: the webhook adapter

The catch the hand-wave above buries: a billing provider's webhook does **NOT** fire with **OUR** vocabulary.
A real Stripe `invoice.paid` / `checkout.session.completed` (or a Paddle) event carries the **provider's own
price/product id** (e.g. `price_...`) — **NOT** our `planId` — a `customer` reference, and a **period-end as a
UNIX epoch in SECONDS** (`current_period_end`) — **NOT** the canonical ISO `fulfillOrder` strictly requires. And
it is delivered **at-least-once**, so the *same* event can arrive twice. Two pure seams close that gap so the
event→license path is a **real, deterministic pipeline**, not glue.

**(1) The `price→plan` binding (`trustledger/plans.js`).** A versioned, strictly-validated JSON file — the
**one** machine-readable routing table mapping each `(provider, priceId)` onto one of **THIS** catalog's
`planId`s. `validatePriceBinding(obj, catalog)` checks it **against the catalog** (every `planId` it points at
must exist), so a price can **never** point at a non-existent plan, and an **unmapped** `(provider, priceId)` is a
**named reject** — never a silent mis-grant of the wrong *plan* (the same class the catalog closed for
entitlements, one level up). Every field:

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `kind` | **yes** | string `"trustledger-price-binding"` | Fixes the artifact type, disjoint from a license/seal/catalog. A wrong/missing `kind` is a hard `PriceBindingError`. |
| `schemaVersion` | **yes** | integer (currently **1**) | Pins the binding shape. Any unsupported version is a hard error — never coerced. |
| `mappings` | **yes** | non-empty array | The routing rows. Emitted in `(provider, priceId)`-sorted order, deterministically. |
| `mappings[].provider` | **yes** | non-empty string (no NUL) | The billing provider id the event came from (e.g. `"stripe"`, `"paddle"`). |
| `mappings[].priceId` | **yes** | non-empty string (no NUL) | The **provider's own** price/product id the event carries (e.g. a Stripe `price_...`). A **duplicate** `(provider, priceId)` is rejected. |
| `mappings[].planId` | **yes** | non-empty string | One of **this catalog's** `planId`s. A `planId` **absent** from the supplied catalog is a hard error — so the binding can never route a paid event at a plan that does not exist. |

A bundled draft binding (`trustledger/fixtures/plans/price-binding.example.json`) shows the shape:
`(stripe, price_pro_annual_usd) → pro-annual`, etc. Like the catalog, the **price-ids are YOURS to fill in** —
the loop ships the **schema + the mapping**, not your real price-ids. Its `_DISCLAIMER` field is ignored by the
engine.

**(2) The two-line pipeline: `normalizeEvent(rawEvent, binding) → fulfillOrder(order, catalog)`.** `normalizeEvent`
is the **pure seam** that maps a normalized provider event envelope `{ provider, priceId, customer, periodEnd,
issuedAt? }` onto the **exact** `{ plan, customer, paidThrough, issuedAt }` order `fulfillOrder` already consumes:
it resolves `priceId → planId` via the binding (`plans.resolvePlanId`), converts the period-end **epoch seconds →
canonical ISO `paidThrough`** (a non-integer / negative / out-of-range epoch is a named reject, never coerced),
carries the `customer` (a missing/blank one is a named reject — a license with no holder is never minted), and
takes `issuedAt` **only** from the caller (no hidden clock read, so the module stays pure/testable). So the whole
event→license path is two composed, deterministic calls:

```js
// your webhook handler, AFTER it has authenticated the provider's signature (see below):
const order   = normalizeEvent(rawEvent, binding);  // provider event  -> { plan, customer, paidThrough, issuedAt }
const license = fulfillOrder(order, catalog);        // order           -> the SAME signed-license params the gate accepts
```

Both calls are **pure + deterministic**: the same `rawEvent` + binding + catalog yields a **byte-identical**
license every time, so `fulfillOrder(normalizeEvent(ev, binding), catalog)` is reproducible end-to-end (the
`vh trust license fulfill` command is exactly this pipeline plus reading the vendor key and signing).

**(3) The idempotency rule: `orderKey(order)`.** Providers **retry** (Stripe documents at-least-once delivery), so
the *same* event can arrive twice. `orderKey(order)` returns the **deterministic** seed **`LIC-<issuedAt>-<plan>`**
— the **same** value `fulfillOrder` defaults the `licenseId` to. The rule: an idempotent handler **dedupes on
`orderKey(order)`** — if a license already exists under that key, a retried delivery resolves to the **same** order
→ the **same** key → the handler returns the **already-minted, byte-identical** license rather than minting a
second/different one. Because the key derives only from the order's own fields, a retried event is a no-op, not a
double-grant or a double-delivery.

> **The ONE remaining HUMAN step: verify the provider's webhook SECRET.** `normalizeEvent` maps an
> **already-authenticated** event — it does not call a provider API and it does not trust an unauthenticated
> payload on its own. **Verifying the inbound webhook's signature against the provider's signing SECRET** (e.g.
> `stripe.webhooks.constructEvent(body, sig, endpointSecret)`) is the integrator's job, done with the provider's
> own SDK **BEFORE** `normalizeEvent` runs — and it needs the **provider's real signing secret**, which the loop
> **never holds**. The loop ships the **binding + the normalizer + the idempotency key + ephemeral test keys**;
> **verifying the provider's webhook secret, provisioning the vendor key, setting the price/term column in the
> catalog, and wiring the actual webhook/billing remain HUMAN-owned outward steps** (STRATEGY.md › P-6 step (3)).

### The worked flow: `payment-succeeded` webhook → `fulfill` → deliver `*.vhlicense.json`

A billing provider's *payment-succeeded / renewed* webhook fires with the **provider's** `priceId` and a
period-end **epoch**. The handler authenticates it (the webhook-secret human step above), then runs the two-line
`normalizeEvent → fulfillOrder` pipeline — equivalently, **one** `vh trust license fulfill` call — and delivers
the file:

```
# (your webhook handler, on an AUTHENTICATED Stripe/Paddle "payment_succeeded" event)
#   const order = normalizeEvent(rawEvent, binding);   // { provider, priceId, customer, periodEnd } -> { plan, customer, paidThrough, issuedAt }
#   const lic   = fulfillOrder(order, catalog);         // -> the same signed-license params the gate accepts
#   // dedupe on orderKey(order) === `LIC-<issuedAt>-<plan>`: a RETRIED event re-mints the BYTE-IDENTICAL license

$ vh trust license fulfill \
    --plan pro-annual --customer "Acme Realty LLC" \
    --paid-through 2027-01-01T00:00:00.000Z \
    --key-env VENDOR_KEY --out acme.vhlicense.json
fulfilled TrustLedger license for plan pro-annual by vendor 0xVENDOR…
  entitlements: seal, multi_state_policy
  expiresAt:    2027-01-01T00:00:00.000Z
  written:      /…/acme.vhlicense.json
```

Then **deliver** `acme.vhlicense.json` to the paying customer (email/download). They verify it offline against
your published vendor address and run the paid surface — exactly the
[issue → verify → reconcile `--license`](#worked-example-issue--verify--reconcile---license) flow above, but the
license is now **minted with no terminal step per sale**:

```
$ vh trust license verify acme.vhlicense.json --vendor 0xVENDOR…
VALID — signed by the vendor, in-window; entitlements [seal, multi_state_policy]
```

So the per-sale human work collapses to **EXACTLY**: (1) fill in **YOUR** price/term per `planId` in the catalog
(the value column) and **YOUR** real price-ids in the `price→plan` binding, and (2) **verify the provider's
webhook secret** with its SDK, then point your billing provider's *payment-succeeded / renewed* webhook at the
two-line `normalizeEvent → fulfillOrder` pipeline (or the equivalent `vh trust license fulfill` command).
The loop ships the catalog + the mapping (the `price→plan` binding + the `normalizeEvent` normalizer + the
`orderKey` idempotency key); **verifying the provider's webhook secret**, the **price/term column**, the
**vendor key**, and the **actual webhook/billing** stay **HUMAN** steps. This adds **no** new human gate — it
**sharpens** P-6 step (3).

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
  --seal [<file>]        after the packet (and any --emit-close) is written, emit a
                         TAMPER-EVIDENT reconciliation seal binding the 3 source inputs +
                         every packet file + the verdict/role header into ONE Merkle root;
                         REQUIRES --out. Default name: reconciliation-<date>-seal.json under
                         <dir>. Verify later, offline, with `vh trust verify-seal <sealfile>`
                         (see "Sealing the packet" above)
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

vh trust verify-seal <sealfile> [--dir <d>] [--inputs <d>] [--json]  # offline, read-only
  <sealfile>             the seal emitted by `reconcile --seal`
  --dir <d>              resolve OUTPUT files from <d> (default: the seal file's own dir)
  --inputs <d>           resolve the SOURCE inputs from <d> (default: same as --dir / seal dir)
  --json                 emit the full per-file verifySeal result as JSON
  # exit: 0 ACCEPTED, 3 REJECTED (per-file CHANGED/MISSING/UNEXPECTED/role), 2 usage, 1 IO

vh trust serve [--port <n>] [--host <h>]   # the local web front-door (see above)
  --port <n>             listen port (default 4173; 0 = OS-chosen free port)
  --host <h>             bind interface (default 127.0.0.1 / localhost)
```

### Example

```
$ vh trust reconcile bank-2026-05.csv ledger-2026-05.csv rentroll-2026-05.csv --date 2026-05-31 --out ./packets/may
PASS: three-way reconciliation tie out (bank-adjusted $128,400.00, book $128,400.00, sub-ledger $128,400.00); 1 exception(s) [0 error, 0 warning, 1 info]
wrote ./packets/may/reconciliation-2026-05-31-balances.csv
wrote ./packets/may/reconciliation-2026-05-31-exceptions.csv
wrote ./packets/may/reconciliation-2026-05-31.html
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
                                     (`--seal` emits a tamper-evident seal alongside the packet)
              `vh trust inspect`   — read-only parse diagnostic over ONE file
                                     (same parse primitives; never fails closed)
              `vh trust verify-seal` — read-only OFFLINE seal verify (re-derives the
                                     root; ACCEPTED/REJECTED + per-file localization)
   |
seal.js       pure, I/O-free, byte-deterministic seal over the inputs + packet + verdict/role
              header, REUSING cli/core/manifest.js + cli/hash.js verbatim (no new hashing scheme)
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
  not imply legal compliance (P-5 #1). The deliverable that review attaches to is now a **SEALED,
  independently-verifiable artifact**: `--seal` + `verify-seal` (see **Sealing the packet** above) make
  the audit packet tamper-evident, so the CPA/counsel reviews a packet an examiner can confirm
  byte-for-byte rather than an editable printout. The human trust-root for "**sealed on date T**"
  (a signing key and/or trusted timestamp) stays P-3 and is **needs-human** — the seal proves
  tamper-evidence only, never a timestamp or a legal opinion.
- **Fill in + have counsel sign the per-state policy TABLE.** The engine **already consumes** a
  reviewed policy as data (see **The per-state policy layer** above) — the human task is now narrow:
  fill in `trustledger/fixtures/policy/<state>.json` in the shipped, validated format (the
  `severities` overrides + their statute `citations`) and have a CPA/counsel sign that mapping for the
  jurisdiction. No engine change is needed; the bundled `baseline.json` / `ca-example.json` are the
  DRAFT skeletons to copy (P-5 #2).
- **Run the two-month design-partner script with 1–2 brokers** (e.g. via NARPM). The concrete,
  decision-ready validation is a script the engine already supports — and it now **leads with the
  de-risked onboarding step on the surface a non-technical broker actually uses, the BROWSER**, so a
  real export's first contact with the tool is "it loads, or the tool tells you how," not a dead-end
  parse error and not a terminal command the buyer will never run:
  1. **FIRST** have the partner open `vh trust serve` **in their browser** and **drop each real file**:
     if it does not load, the page shows that file's columns and lets the broker **map** the missing
     field from a dropdown of its actual headers, then re-checks it — the **in-browser inspect/map UI**
     (see **In-browser onboarding: inspect & map a file that won't load** above). This is the same
     `diagnoseSource` self-service fix as the CLI `vh trust inspect <eachFile> --as <type>` /
     `--map <logical>=<header>` (still available for technical users), but it requires **no terminal** —
     closing the gap between "the buyer who will never use a terminal" and an onboarding step that used
     to require one. It converts the single most likely pilot-killer — ingest choking on a real broker's
     export — from a dead end into a self-service fix **before** any reconciliation runs.
  2. **THEN** run the two-month reconcile script: have the partner run
     `vh trust reconcile … --state <code> --emit-close month1.json` on their **real month-1** files, then
     re-run on **month-2** files with `--prior-close month1.json`, and confirm (a) the three balances tie
     out both months, (b) the roll-forward is clean (no `CONTINUITY_BREAK`), and (c) the exceptions read
     correctly.

  That **two-month run IS the willingness-to-pay validation** — it shows the recurring monthly product
  working past month one, which a single-period demo cannot; leading with the **browser** inspect/map UI
  makes sure month one even gets that far **without the broker ever touching a terminal** (P-5 #3).

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
