# einvoice

A zero-dependency, embeddable, self-hostable conformance validator for
**EN 16931** electronic invoices, targeting the German **XRechnung** CIUS
(UBL 2.1 `Invoice` syntax).

- **Zero dependency.** Python 3 (>=3.8) standard library only. No lxml, no
  Java, no Schematron toolchain, no network calls. `python3 einvoice.py
  validate x.xml` from a checkout is the whole install; `pip install .` adds
  an `einvoice` console script (`pyproject.toml` pins `dependencies = []` —
  a tested contract, see `test_packaging.py`).
- **Embeddable.** The validator is a small pure-Python package
  (`einvoice/parser.py`, `einvoice/rules.py`, `einvoice/validate.py`,
  `einvoice/cli.py`); rules are plain functions over a parsed model, so an
  ERP or billing system can import it in-process instead of shelling out to
  a validator service — copying the bare `einvoice/` package directory into
  your tree is a supported (and tested) install method.
- **Self-hostable.** Everything runs offline. The rule corpus and test
  fixtures are vendored in-repo (`corpus/`), so the thing you validate against
  is auditable and pinned — no dependency on a third-party validation API.
- **CI-gateable.** `ci/` ships a copy-paste build gate (POSIX sh + GitHub
  Actions / GitLab CI recipes) that fails a build on any non-conformant
  invoice, naming the violated rule ID. See [§4](#4-ci-conformance-gate).

This is an **early slice**, not a product. Read §2 before trusting it with
anything. It currently implements 50 of the roughly 200 EN 16931 core business
rules, plus — with `--profile=xrechnung` — **all 32 XRechnung-specific
`BR-DE-*` asserts** of the official KoSIT UBL artifact (the German national
CIUS layer: BuyerReference, seller contact, payment-means grouping, Skonto
grammar, IBAN checks, …).

**How correctness is proven:** all 50 core rules are differential-tested
against the **official, normative EN16931-UBL Schematron** (the legal ruleset)
and agree with it on **1035 real invoices with zero divergences**; all 32
`BR-DE-*` rules are differential-tested against the **official KoSIT
XRechnung-UBL Schematron 2.5.0** and agree with it on **1014 invoices with
zero divergences** — see [`CORRECTNESS.md`](CORRECTNESS.md) for the full
method, corpora, and the honest limits of those claims.

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

### Implemented — EN 16931 core (exactly these 50 rules)

| Family | Rule IDs |
|---|---|
| Header existence/cardinality | BR-01, BR-02, BR-03, BR-04, BR-05, BR-06, BR-07, BR-08 |
| Seller/Buyer postal address | BR-09 (seller country code), BR-10 (buyer postal address), BR-11 (buyer country code) |
| Document totals presence | BR-12 (Σ line net), BR-13 (total w/o VAT), BR-14 (total with VAT), BR-15 (amount due) |
| Invoice-line cardinality | BR-16, BR-21, BR-22, BR-24, BR-26 |
| Code list | BR-CL-01 (UNTDID 1001 invoice type code) |
| Arithmetic co-constraints | BR-CO-10, BR-CO-13, BR-CO-14, BR-CO-15, BR-CO-16, BR-CO-17 |
| VAT breakdown presence | BR-CO-18 |
| VAT-category consistency | BR-S-01, BR-Z-01, BR-AE-01, BR-E-01, BR-G-01, BR-IC-01, BR-O-01 |
| Decimal precision (max 2 places) | BR-DEC-01, BR-DEC-02, BR-DEC-05, BR-DEC-06, BR-DEC-09, BR-DEC-10, BR-DEC-11, BR-DEC-12, BR-DEC-14, BR-DEC-16, BR-DEC-17, BR-DEC-18, BR-DEC-19, BR-DEC-20, BR-DEC-23 |

Plus two structural checks: S-WF (well-formed XML) and S-ROOT (UBL Invoice-2
root). Rule wording follows the vendored EN 16931 Schematron
(`corpus/cen-en16931/ubl/schematron/abstract/EN16931-model.sch`) verbatim.

### Implemented — XRechnung CIUS layer (`--profile=xrechnung`, all 32 BR-DE asserts)

| Family | Rule IDs |
|---|---|
| Mandatory German fields | BR-DE-1 (payment instructions), BR-DE-15 (BuyerReference), BR-DE-2/5/6/7 (seller contact + name/phone/email), BR-DE-3/4 (seller city/post code), BR-DE-8/9 (buyer city/post code), BR-DE-10/11 (deliver-to city/post code), BR-DE-14 (VAT rate per breakdown) |
| Seller VAT identification | BR-DE-16 |
| Type-code / spec-id restrictions | BR-DE-17, BR-DE-21, BR-DE-26 |
| Payment-means grouping | BR-DE-23-a/-b (credit transfer), BR-DE-24-a/-b (card), BR-DE-25-a/-b (direct debit), BR-DE-30, BR-DE-31 (SEPA mandate fields) |
| Content quality (warnings) | BR-DE-19, BR-DE-20 (IBAN mod-97), BR-DE-27 (phone), BR-DE-28 (email), BR-DE-18 (Skonto grammar, fatal) |
| Delivery-date recommendation | BR-DE-TMP-32 (information) |

That is every `BR-DE-*` assert in the official KoSIT XRechnung 3.0.2 UBL
Schematron (the numbering has official gaps: no BR-DE-12/13/29 exist there).
Severities mirror the official flags — only **fatal** rules affect the exit
code; warnings/information are reported in `--json`. NOT implemented:
`BR-DEX-*` (extension profile), `BR-DE-CVD-*` (Clean Vehicle Directive
profile), `BR-TMP-2`, and the `PEPPOL-EN16931-*` rules in the same artifact.

### Differential result vs. the OFFICIAL Schematron (this run)

The strongest correctness evidence: `differential.py` runs each invoice through
the **official, normative** compiled EN16931-UBL Schematron (Saxon → SVRL) and
through our validator, then compares — for every invoice and every one of our
50 rule IDs — whether each engine fires. The Schematron is the legal artifact;
any disagreement is our bug.

```
corpus ............... 1035 real UBL Invoice documents
comparisons .......... 51,750  (1035 invoices x 50 rules)
TOTAL AGREEMENT ...... 51,750 / 51,750 = 100.0000%
divergences .......... 0 false-positives + 0 misses
```

The **XRechnung leg** of the same harness compares our 32 `BR-DE-*` rules
against the official **KoSIT XRechnung-UBL Schematron 2.5.0** (vendored at
`corpus/xrechnung-schematron/`):

```
corpus ............... 1014 graded UBL Invoice documents (incl. the full
                       KoSIT xrechnung-testsuite + 31 BR-DE-targeted mutations)
comparisons .......... 32,448  (1014 invoices x 32 rules)
TOTAL AGREEMENT ...... 32,448 / 32,448 = 100.0000%
divergences .......... 0 false-positives + 0 misses
```

All implemented rules agree with their official Schematron on every graded
invoice. Reproduce it (needs `saxonche` importable): `python3 differential.py`
(or `... en` / `... xrechnung` for one leg). Method, corpus breakdown, the
divergences that were found and fixed, and the honest scope limits are
documented in [`CORRECTNESS.md`](CORRECTNESS.md). This proves faithfulness
**only for these 50+32 rules** — not EN 16931 or XRechnung as a whole (see §2
"NOT covered").

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

- **No `BR-DEX-*` (XRechnung extension) or `BR-DE-CVD-*` (Clean Vehicle
  Directive) rules** — the `BR-DE-*` CIUS core is complete (see above), but
  those two ADDITIONAL German profiles are not, and `BR-TMP-2` /
  `PEPPOL-EN16931-*` from the same KoSIT artifact are also out of scope.
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
- **The 100% figures are agreement/pass rates for our 50+32 rules only** — the
  40-vector `conformance.py` corpus and the 1035/1014-invoice
  `differential.py` corpora. They are 100% of a limited, honest scope, **not**
  100% of the ~200-rule standard. Broader KoSIT/CEN fixtures under `corpus/`
  are used as differential input but the unimplemented rules are still
  unchecked.

See `SPEC.md` §6 for the full deferred list.

---

## 3. Install / embed / usage

Three ways in, one code path (`einvoice/cli.py` — proven identical by
`test_packaging.py`):

```sh
# a) straight from a checkout — nothing to install
python3 einvoice.py validate <invoice.xml> [--json] [--profile=en16931|xrechnung]
python3 -m einvoice   validate <invoice.xml> [--json] [--profile=en16931|xrechnung]

# b) pip-install (from a checkout/vendored copy — NOT on PyPI yet, on purpose)
python3 -m pip install /path/to/einvoice     # zero runtime dependencies
einvoice validate <invoice.xml> [--json] [--profile=en16931|xrechnung]
```

**c) embed in-process** — vendor the bare `einvoice/` package directory (the
pure-Python package alone, no corpus needed at runtime) or pip-install it,
then:

```python
from einvoice import validate_file, NotWellFormed

result = validate_file("invoice.xml", profile="xrechnung")
if not result.ok:
    for v in result.violations:          # each: rule_id, message, element
        print(v.rule_id, v.message)      # e.g. "BR-DE-15 The element ..."
```

`--profile=xrechnung` layers the 32 German `BR-DE-*` rules on top of the core
(default profile: core only).

Exit codes (stable contract):

| Code | Meaning |
|---|---|
| 0 | passes every implemented **fatal** rule (warnings may still be reported) |
| 1 | at least one implemented fatal rule failed |
| 2 | usage error (bad args, missing file, unknown profile) |
| 3 | input is not well-formed XML |

Default output on failure is the **first** fatal violated rule, human message,
and offending element. `--json` emits the full machine-readable result:

```json
{
  "source": "invoice.xml",
  "valid": false,
  "violation_count": 2,
  "violations": [
    {"rule": "BR-06", "message": "...", "element": "...", "severity": "fatal"}
  ]
}
```

A `valid: true` result means "no implemented fatal rule fired" — given §2, it
does **not** yet mean "legally conformant XRechnung."

---

## 4. CI conformance gate

The distribution artifact an ERP/billing vendor actually wants: a build gate
that makes "a non-conformant invoice reached the repo" a **red build**, with
the violated rule ID named in the job log. Everything lives in
[`ci/`](ci/README.md):

- [`ci/validate-invoices.sh`](ci/validate-invoices.sh) — the gate. POSIX sh,
  zero deps beyond python3. Exit `0` = all conformant; exit `1` = at least one
  invoice failed (rule IDs printed); exit `2` = the gate itself is
  misconfigured — including **finding no invoices at all** (an empty gate is a
  broken gate, opt out with `EINVOICE_ALLOW_EMPTY=1`).
- [`ci/github-actions.yml`](ci/github-actions.yml) — copy to
  `.github/workflows/invoice-conformance.yml`.
- [`ci/gitlab-ci.yml`](ci/gitlab-ci.yml) — merge into your `.gitlab-ci.yml`.

The 60-second version (any CI system):

```sh
python3 -m pip install ./third_party/einvoice        # vendored copy; zero deps
sh third_party/einvoice/ci/validate-invoices.sh invoices/
```

and a failure looks like:

```
FAIL: invoices/2026-04-017.xml
  BR-DE-15: The element 'Buyer reference' (BT-10) must be transmitted.
  offending element: cbc:BuyerReference
conformance gate: 1/12 invoice(s) NON-CONFORMANT (profile=xrechnung) — FAIL
```

Same honest scope as §2: the gate proves your invoices pass the
**implemented** 50+32 rules, not the full standard. The gate's behaviour
(fails naming the rule ID, passes conformant sets, refuses empty input) is
itself under test in `test_packaging.py`.

## 5. Intended revenue model

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

## 6. KILL / CONTINUE metric

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

Current status against this metric: 50 core rules + all 32 XRechnung
`BR-DE-*` asserts shipped (each batch differential-proven at 100% against its
official Schematron), 0 vendors contacted. Metric #2's rule-count/`BR-DE`
half is met on the UBL side; "passing the full KoSIT test suite" still
requires the unimplemented core rules and CII.

---

## Sources / licenses

- EN 16931 corpus & Schematron: `github.com/ConnectingEurope/eInvoicing-EN16931` (EUPL-1.2), vendored under `corpus/cen-en16931/`.
- XRechnung test suite: `github.com/itplr-kosit/xrechnung-testsuite` (Apache-2.0), vendored under `corpus/xrechnung-testsuite/`.
- XRechnung Schematron v2.5.0 (XRechnung 3.0.2): `github.com/itplr-kosit/xrechnung-schematron` (Apache-2.0), vendored under `corpus/xrechnung-schematron/` (see its `VENDORED.md`).
- Rule text quoted verbatim from the vendored `EN16931-model.sch` / `EN16931-syntax.sch` / `XRechnung-UBL-validation.sch`.
