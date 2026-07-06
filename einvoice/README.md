# einvoice

A zero-dependency, embeddable, self-hostable conformance validator for
**EN 16931** electronic invoices, targeting the German **XRechnung** CIUS
(UBL 2.1 `Invoice` syntax).

- **Zero dependency.** Python 3 standard library only. No lxml, no Java, no
  Schematron toolchain, no network calls. `python3 einvoice.py validate x.xml`
  is the whole install.
- **Embeddable.** The validator is a small pure-Python package
  (`einvoice/parser.py`, `einvoice/rules.py`, `einvoice/validate.py`); rules
  are plain functions over a parsed model, so an ERP or billing system can
  import it in-process instead of shelling out to a validator service.
- **Self-hostable.** Everything runs offline. The rule corpus and test
  fixtures are vendored in-repo (`corpus/`), so the thing you validate against
  is auditable and pinned — no dependency on a third-party validation API.

This is an **early slice**, not a product. Read §2 before trusting it with
anything. It currently implements 43 of the roughly 200 EN 16931 business
rules and none of the XRechnung-specific `BR-DE-*` rules.

**How correctness is proven:** all 43 rules are differential-tested against the
**official, normative EN16931-UBL Schematron** (the legal ruleset) and agree
with it on **1028 real invoices with zero divergences** — see
[`CORRECTNESS.md`](CORRECTNESS.md) for the full method, corpus, and the honest
limits of that claim.

---

## 1. Why this exists: the legal forcing function

Structured e-invoicing is stopping being optional in the EU. If you issue or
receive B2B invoices there, a conformance validator moves from "nice tooling"
to "the thing that decides whether your invoice legally exists."

- **Germany (2025–2028).** Since 1 January 2025 every German business must be
  able to **receive** EN 16931-conformant e-invoices (XRechnung or ZUGFeRD);
  the obligation to **issue** them phases in through 2027–2028 depending on
  turnover, as legislated in the Wachstumschancengesetz. Public-sector
  suppliers have been required to send XRechnung since 2020.
- **France (2026–2027).** Reception of structured e-invoices becomes
  mandatory for all VAT-registered businesses in **September 2026**; the
  obligation to issue phases in September 2026 (large/mid-size) through
  **September 2027** (SMEs), via the PDP/e-reporting reform. The French
  formats (Factur-X, UBL, CII) are all EN 16931 profiles.
- **EU ViDA.** The "VAT in the Digital Age" package (adopted 2025) makes
  structured e-invoicing the default for intra-EU B2B and adds digital
  reporting requirements on a ~2030 horizon — again on the EN 16931 core.

Dates above reflect the legislation as understood at time of writing
(mid-2026); phase-ins shift, so verify against current law before relying on
them. The direction, however, is one-way: every invoice will need to pass
machine-checkable conformance rules, and the party that fails them eats the
rejection, the payment delay, or the VAT problem. Buyers on a deadline need a
validator they can run themselves, embed in their pipeline, and audit — not a
black-box web form.

---

## 2. HONEST coverage — read this before using it

**Profile:** XRechnung 3.x (the German CIUS of EN 16931-1:2017),
**UBL 2.1 `Invoice` syntax only.**

### Implemented (exactly these 43 rules)

| Family | Rule IDs |
|---|---|
| Header existence/cardinality | BR-01, BR-02, BR-03, BR-04, BR-05, BR-06, BR-07, BR-08 |
| Invoice-line cardinality | BR-16, BR-21, BR-22, BR-24, BR-26 |
| Code list | BR-CL-01 (UNTDID 1001 invoice type code) |
| Arithmetic co-constraints | BR-CO-10, BR-CO-13, BR-CO-14, BR-CO-15, BR-CO-16, BR-CO-17 |
| VAT breakdown presence | BR-CO-18 |
| VAT-category consistency | BR-S-01, BR-Z-01, BR-AE-01, BR-E-01, BR-G-01, BR-IC-01, BR-O-01 |
| Decimal precision (max 2 places) | BR-DEC-01, BR-DEC-02, BR-DEC-05, BR-DEC-06, BR-DEC-09, BR-DEC-10, BR-DEC-11, BR-DEC-12, BR-DEC-14, BR-DEC-16, BR-DEC-17, BR-DEC-18, BR-DEC-19, BR-DEC-20, BR-DEC-23 |

Plus two structural checks: S-WF (well-formed XML) and S-ROOT (UBL Invoice-2
root). Rule wording follows the vendored EN 16931 Schematron
(`corpus/cen-en16931/ubl/schematron/abstract/EN16931-model.sch`) verbatim.

### Differential result vs. the OFFICIAL Schematron (this run)

The strongest correctness evidence: `differential.py` runs each invoice through
the **official, normative** compiled EN16931-UBL Schematron (Saxon → SVRL) and
through our validator, then compares — for every invoice and every one of our
43 rule IDs — whether each engine fires. The Schematron is the legal artifact;
any disagreement is our bug.

```
corpus ............... 1028 real UBL Invoice documents
comparisons .......... 44,204  (1028 invoices x 43 rules)
TOTAL AGREEMENT ...... 44,204 / 44,204 = 100.0000%
divergences .......... 0 false-positives + 0 misses
```

All 43 implemented rules agree with the official Schematron on every invoice in
the corpus. Reproduce it (needs `saxonche` importable):
`python3 differential.py`. Method, corpus breakdown, the divergences that were
found and fixed, and the honest scope limits are documented in
[`CORRECTNESS.md`](CORRECTNESS.md). This proves faithfulness **only for these
43 rules** — not EN 16931 or XRechnung as a whole (see §2 "NOT covered").

### Conformance result (this run)

`conformance.py` drives the real CLI as a subprocess over every vector in
`corpus/vendored/` (12 valid + 28 invalid). The invalid vectors are Difi
`<testSet>` files, so the harness extracts every embedded `<Invoice>`
fragment and checks each `<error>`/`<success>` assertion individually —
167 embedded assertions in total.

```
total vendored vectors ............. 40  (12 valid + 28 invalid)

VALID-vector pass rate ............. 12/12   100.0%   (miss = FALSE POSITIVE)
COVERED-INVALID detection rate ..... 28/28   100.0%   (correct rule id fired)
OUT-OF-SCOPE invalid vectors ....... 0

embedded-block detail (Difi assertions):
  <error>   fragments: 76 total -> 76 detected, 0 missed, 0 wrong-id, 0 oos
  <success> fragments: 91 total -> 91 clean,    0 FALSE POSITIVE,   0 oos

HARD FAILS: 0   -> RESULT: PASS
```

Every covered invalid vector is detected with the **correct labeled rule ID**
across all 76 error fragments; every valid vector and all 91 must-pass
fragments come back clean — zero false positives on this corpus.

The harness itself was mutation-tested (then the code restored
byte-identical): neutering `br_06` produced 4 `WRONG RULE ID` hard fails;
forcing `br_01` to always fire produced 13 `FALSE POSITIVE` hard fails;
removing `BR-Z-01` was correctly reported as out-of-scope, not silently
passed. A green run means something because the harness demonstrably goes red.

Reproduce it: `cd einvoice && python3 conformance.py` (exit 0 = pass; exit 1
prints the offending file, block, and expected vs. actual rule IDs).

### NOT covered yet (deliberate first-slice cuts — do not rely on these)

- **No XRechnung `BR-DE-*` / `BR-DEX-*` rules at all.** That includes
  mandatory-for-Germany fields like `BuyerReference` (BT-10), seller contact,
  and the Leitweg routing ID. A validator without these is **not** a complete
  XRechnung compliance check. Highest-priority next slice.
- **~155 further EN 16931 `BR-*` rules unimplemented**: the remaining header/
  party/allowance-charge existence rules (BR-09..15, BR-25, BR-27..BR-67
  ranges), the rest of the `BR-CO-*` arithmetic (BR-CO-03/04/09/11/12/25/26 …),
  the deeper VAT matrices (`-02..-10` of every category family: seller-VAT-ID
  requirements, per-category taxable/tax sums, exemption reasons; the L/M
  families entirely), the line-level `BR-DEC-*` allowance/charge decimals
  (BT-136/137/141/142), and all `BR-CL-*` code lists except BR-CL-01.
- **No XSD (structural schema) validation.** Layer S-XSD is deferred; only
  well-formedness and the UBL root are checked structurally.
- **No CII syntax, no UBL `CreditNote`, no ZUGFeRD/Factur-X PDF containers,
  no signatures or attachments.**
- **The 100% figures are agreement/pass rates for our 43 rules only** — the
  40-vector `conformance.py` corpus and the 1028-invoice `differential.py`
  corpus. They are 100% of a limited, honest scope, **not** 100% of the
  ~200-rule standard. Broader KoSIT/CEN fixtures under `corpus/` are used as
  differential input but the unimplemented rules are still unchecked.

See `SPEC.md` §6 for the full deferred list.

---

## 3. Usage

```
python3 einvoice.py validate <invoice.xml> [--json]
```

Exit codes (stable contract):

| Code | Meaning |
|---|---|
| 0 | passes every implemented rule |
| 1 | at least one implemented rule failed |
| 2 | usage error (bad args, missing file) |
| 3 | input is not well-formed XML |

Default output on failure is the **first** violated rule, human message, and
offending element. `--json` emits the full machine-readable result:

```json
{
  "source": "invoice.xml",
  "valid": false,
  "violation_count": 2,
  "violations": [
    {"rule": "BR-06", "message": "...", "element": "..."}
  ]
}
```

A `valid: true` result means "no implemented rule fired" — given §2, it does
**not** yet mean "legally conformant XRechnung."

---

## 4. Intended revenue model

If this continues past the first slice, the model is boring on purpose:

- **Per-seat / per-embed license** for vendors (ERP, billing, e-invoicing
  platforms) who ship the validator inside their product, or
- **Metered self-host**: flat or volume-tiered pricing for running it inside
  your own infrastructure, with the rule corpus kept current.

Explicitly ruled out, permanently: **no token, no coin, no on-chain payment
instrument of any kind.** Nothing about invoice validation needs one, and
this project will never fund itself by selling one.

Nothing is for sale today. There is no license server, no pricing page, and
no customer. This section exists so the incentive structure is on the record
before the first conversation with a vendor, not after.

---

## 5. KILL / CONTINUE metric

A first slice earns further investment or it doesn't. The signal, timeboxed:

**CONTINUE** if, within **90 days** of this README, at least one of:

1. **One ERP/billing/e-invoicing vendor agrees in writing to pilot or embed**
   the validator (even unpaid) — evidence that "embeddable, zero-dependency,
   auditable" is a real wedge against the incumbent Java/Schematron stacks; or
2. The validator reaches **60+ implemented rules including the full
   `BR-DE-*` set, passing the full KoSIT XRechnung test suite** (not just the
   curated 32-vector corpus) with zero false positives — evidence the rule
   engine scales to real coverage without an architecture rewrite.

**KILL** if neither happens: write up what was learned, archive the repo, and
stop. The corpus and harness remain useful artifacts either way.

Current status against this metric: 43 rules shipped (first slice of 20 +
second batch of 23, all differential-proven), 0 vendors contacted.

---

## Sources / licenses

- EN 16931 corpus & Schematron: `github.com/ConnectingEurope/eInvoicing-EN16931` (EUPL-1.2), vendored under `corpus/cen-en16931/`.
- XRechnung test suite: `github.com/itplr-kosit/xrechnung-testsuite` (Apache-2.0), vendored under `corpus/xrechnung-testsuite/`.
- Rule text quoted verbatim from the vendored `EN16931-model.sch` / `EN16931-syntax.sch`.
