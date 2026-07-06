# CORRECTNESS — how this validator is proven, and what "proven" means

This document states plainly how the correctness of `einvoice`'s 43 implemented
business rules is established, what a buyer can rely on, and — just as
importantly — what is **not** yet proven.

Read it as the honest technical warranty. If a claim here is stronger than the
evidence, that is a bug in this document; report it.

---

## 1. What each rule is

Every rule is a **pure Python function** over a parsed invoice model
(`einvoice/rules.py`, one function per rule, listed in `ALL_RULES`). A rule
returns a `Violation` when it fires and `None` when it holds. There is no
network call, no Java, no external Schematron engine in the validation path —
the whole validator is standard-library Python.

The arithmetic rules (BR-CO-10/13/14/15/16/17) use `decimal.Decimal`, not
binary floats, so monetary equality is exact and reproducible. The newer rules
(BR-CO-16/17) transcribe the official rounding idiom `round(x*100) div 100`
with **XPath fn:round() semantics** — halves toward +infinity, which differs
from half-up on negative halves — because that is what the legal artifact
computes. The BR-DEC-* decimal rules count the characters after the decimal
point of the **literal string value** (`substring-after(., '.')`, whitespace
included), exactly like the official XPath, rather than inspecting a parsed
number.

## 2. How correctness is established: differential testing against the LEGAL artifact

Correctness is **not** established by our own opinion of what a rule means. It
is established by **differential testing against the official, normative CEN
artifact**: the compiled EN16931-UBL Schematron
(`corpus/cen-en16931/ubl/xslt/EN16931-UBL-validation.xslt`), which is the legal
ruleset that real trading partners and tax authorities validate against.

The harness is `differential.py`:

1. **Ground truth = the official Schematron.** Each invoice is run through the
   normative XSLT with Saxon; the emitted SVRL report is parsed and every fired
   assertion `@id` is collected. This is the legal verdict, computed by the
   legal artifact — not a re-implementation.
2. **Our side = the `einvoice/` package**, run in-process.
3. For **every invoice** and **every one of our 43 rule IDs** the harness asks
   both engines the same yes/no question — *"does rule R fire on this
   invoice?"* — and records agreement. A disagreement is, by definition, our
   bug: either a **false positive** (we fire, the law does not → we over-reject)
   or a **miss** (the law fires, we do not → we under-reject).

Where our reading of a rule ever diverged from the Schematron, the Schematron
won and our code was corrected — never the reverse.

### Corpus

**1028 real UBL `Invoice` documents**, assembled from:

- CEN `ubl/examples` real-world sample invoices;
- our own `corpus/vendored/valid` + `vendored/invalid` fixtures;
- 90 real German-CIUS invoices from the KoSIT `xrechnung-testsuite`;
- every `<test>` case from the 206 CEN `Invoice-unit-UBL` unit-test files,
  split out into standalone invoices;
- 43 generated mutations — one per rule, each breaking exactly the field that
  rule guards, off a known-clean invoice — so every rule is exercised in the
  failing direction.

That is **44,204 rule-vs-law comparisons** (1028 invoices × 43 rules).

### Result of this run

```
TOTAL AGREEMENT: 44,204 / 44,204 = 100.0000%
divergences: 0 false-positives + 0 misses
```

**All 43 implemented rules agree with the official EN16931-UBL Schematron on
every one of the 1028 invoices**, with zero false positives and zero misses.

| Rule family | Rule IDs | Agreement |
|---|---|---|
| Header existence/cardinality | BR-01, BR-02, BR-03, BR-04, BR-05, BR-06, BR-07, BR-08 | 1028/1028 each |
| Invoice-line cardinality | BR-16, BR-21, BR-22, BR-24, BR-26 | 1028/1028 each |
| Code list (UNTDID 1001) | BR-CL-01 | 1028/1028 |
| Arithmetic co-constraints | BR-CO-10, BR-CO-13, BR-CO-14, BR-CO-15, BR-CO-16, BR-CO-17 | 1028/1028 each |
| VAT breakdown presence | BR-CO-18 | 1028/1028 |
| VAT-category consistency | BR-S-01, BR-Z-01, BR-AE-01, BR-E-01, BR-G-01, BR-IC-01, BR-O-01 | 1028/1028 each |
| Decimal precision (max 2 places) | BR-DEC-01, BR-DEC-02, BR-DEC-05, BR-DEC-06, BR-DEC-09, BR-DEC-10, BR-DEC-11, BR-DEC-12, BR-DEC-14, BR-DEC-16, BR-DEC-17, BR-DEC-18, BR-DEC-19, BR-DEC-20, BR-DEC-23 | 1028/1028 each |

Reproduce it:

```
export PYTHONPATH="$HOME/.local/lib/python3.10/site-packages:$PYTHONPATH"
python3 differential.py            # needs saxonche importable
```

## 3. Divergences that were found and fixed

An earlier run of the same harness surfaced 434 divergences concentrated in six
rules. Each was a genuine interpretation bug — our code disagreeing with the
legal text — and each was corrected to match the Schematron:

1. **Arithmetic rules skipped when a monetary operand was absent
   (BR-CO-10/13/14/15).** The normative XPath casts a missing operand to the
   empty sequence, and any equation touching it is false, so the assert
   **fires**. Our code was returning `None` ("skip") instead. Fixed: the rules
   now fire when a required total (BT-106/109/110/112) or its component is
   absent, keyed on the presence of the rule's *context node*
   (`LegalMonetaryTotal` for BR-CO-10/13, each top-level `TaxTotal` for
   BR-CO-14, the `Invoice` for BR-CO-15) — matching the Schematron exactly.
2. **BR-CO-15 ignored `currencyID` scoping.** The official rule quantifies over
   `DocumentCurrencyCode` and uses only the VAT total whose `@currencyID`
   equals the document currency (and requires exactly one). Our code summed
   tax amounts across all currencies, over-rejecting mixed-currency samples.
   Fixed: currency-scoped, and vacuously clear when BT-5 is absent (that is
   BR-05's job).
3. **BR-22 (and siblings BR-24/26) conflated present-but-empty with absent.**
   The official test is a pure `exists(...)` existence check, so an empty
   element (`<cbc:InvoicedQuantity/>`) satisfies it. Our code treated an empty
   value as missing. Fixed: presence-only, matching `exists(...)`.
4. **BR-S-01 was one-directional.** The official rule is bidirectional — it
   also fires on an orphan Standard-rated VAT breakdown with no corresponding
   Standard-rated line/allowance/charge. Fixed to the full XOR semantics.

After these fixes, agreement is 100% (§2).

The 23 rules added in the second batch (BR-CO-16/17/18, BR-AE/E/G/IC/O-01,
BR-DEC-*) were written **Schematron-first**: each function transcribes the
official compiled XPath (its presence-keyed disjunctions, fn:round() rounding,
string-level decimal counting, VAT-scheme filters and the exact node sets —
e.g. the `//cac:TaxCategory` "anywhere" set that includes the breakdown's own
rows) rather than the prose rule text. That batch reached 0 divergences on its
first full differential run. Two traps the official XPath forced us to model,
which a prose reading would have missed: BR-CO-16 compares payable-vs-total
with **no rounding at all** when neither BT-113 nor BT-114 is present, and
BR-CO-17 is a **±1 tolerance band**, not an equality.

## 4. Second, independent check: the conformance harness

`conformance.py` is a separate proof over the curated `corpus/vendored/`
corpus. It drives the **real CLI** end-to-end as a subprocess and asserts, at
the level of individual Difi `<testSet>` assertions:

```
VALID-vector pass rate ............. 12/12   100.0%   (a miss = FALSE POSITIVE)
COVERED-INVALID detection rate ..... 28/28   100.0%   (correct rule id fired)
<error>   fragments: 76 total -> 76 detected, 0 missed, 0 wrong-id
<success> fragments: 91 total -> 91 clean,    0 FALSE POSITIVE
HARD FAILS: 0   -> PASS
```

So the implemented rules are also green against 167 hand-labelled pass/fail
assertions (CEN's own per-rule unit vectors, vendored per rule where CEN ships
them), with the *correct* rule ID fired every time (not merely "some failure").

## 5. The honest remaining gap — what is NOT proven

The 100% figure is **100% agreement on the 43 rules we implement, over this
1028-invoice corpus.** It is not a claim of EN 16931 or XRechnung conformance.
Specifically:

- **Only 43 of ~200 EN 16931 business rules are implemented.** Still missing:
  the header/party existence rules beyond BR-01..08 (BR-09..15, BR-25, BR-27..
  BR-67 ranges), the rest of the `BR-CO-*` arithmetic (BR-CO-03/04/09/11/12/
  25/26 …), the deeper VAT-category matrices (`BR-S/Z/AE/E/G/IC/O-02..10`:
  seller-VAT-ID requirements, per-category taxable/tax sums, exemption-reason
  rules), the remaining `BR-DEC-*` (BT-136/137/141/142 line allowance/charge
  amounts), and the `BR-CL-*` code lists beyond BR-CL-01. A `valid: true`
  result means "none of our 43 rules fired", not "this invoice is legally
  conformant". (BR-IG-*/BR-IP-* do not exist in the vendored CEN artifact and
  therefore cannot be differential-proven; they are out of scope.)
- **No XRechnung `BR-DE-*` / `BR-DEX-*` rules at all** — including
  mandatory-for-Germany fields (BuyerReference, Leitweg routing ID, seller
  contact). This is therefore **not** a complete XRechnung compliance check.
- **No XSD structural validation**, no CII syntax, no UBL `CreditNote`, no
  ZUGFeRD/Factur-X PDF containers, no signatures.
- **Corpus, not universe.** 1028 real invoices is broad and adversarial but
  finite; agreement on it is strong evidence, not a formal proof over all
  possible inputs.
- **The XSLT is the *compiled* Schematron**, which is the normative technical
  artifact CEN publishes and everyone validates against — but the ultimate
  legal text is the EN 16931 standard itself plus each national CIUS
  (e.g. XRechnung, Factur-X). The Schematron is the faithful machine encoding
  of that text; it is the right ground truth for a validator, and it is what we
  prove against, but it is one layer below the prose standard.

**Bottom line a buyer can rely on:** for the 43 rules listed in §2, this
validator returns the same verdict as the official EN16931-UBL Schematron on
every invoice in a 1028-document real-world corpus — zero false positives, zero
misses — and is re-checkable at any time with `python3 differential.py`. Within
that explicitly-scoped 43-rule slice it is provably faithful to the legal
ruleset; outside it, it makes no claim.
