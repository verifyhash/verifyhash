# CORRECTNESS — how this validator is proven, and what "proven" means

This document states plainly how the correctness of `einvoice`'s implemented
business rules is established, what a buyer can rely on, and — just as
importantly — what is **not** yet proven.

The validator has **two distinct layers with separate coverage claims**:

1. **EN 16931 core** — 108 of the ~200 EU-core business rules
   (`einvoice/rules.py`), proven against the official CEN Schematron (§2);
2. **XRechnung national CIUS (BR-DE-\*)** — all 32 German national asserts of
   the official KoSIT XRechnung 3.0.2 UBL Schematron
   (`einvoice/rules_xrechnung.py`), proven against that artifact (§2a). The
   layer is opt-in via `--profile=xrechnung` and runs ON TOP of the core.

Read this as the honest technical warranty. If a claim here is stronger than
the evidence, that is a bug in this document; report it.

---

## 1. What each rule is

Every rule is a **pure Python function**: the 108 core rules over a parsed
invoice model (`einvoice/rules.py`, one function per rule, listed in
`ALL_RULES`), the 32 BR-DE rules over the parsed UBL root element
(`einvoice/rules_xrechnung.py` — the national rules address parts of the
document the flat core model deliberately does not carry). A rule returns a
`Violation` when it fires and `None` when it holds. There is no network call,
no Java, no external Schematron engine in the validation path — the whole
validator is standard-library Python.

BR-DE violations carry the official severity (`fatal`, `warning`,
`information` — the Schematron `flag`): only **fatal** violations make a
document invalid / exit 1; warnings and information are reported but do not
block, exactly like the KoSIT reference validator. One CORE rule carries a
non-fatal flag too: BR-51 (card primary account number) is `warning` in the
official CEN artifact, and our violation mirrors that.

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
3. For **every invoice** and **every one of our 108 rule IDs** the harness asks
   both engines the same yes/no question — *"does rule R fire on this
   invoice?"* — and records agreement. A disagreement is, by definition, our
   bug: either a **false positive** (we fire, the law does not → we over-reject)
   or a **miss** (the law fires, we do not → we under-reject).

Where our reading of a rule ever diverged from the Schematron, the Schematron
won and our code was corrected — never the reverse.

### Corpus

**1085 real UBL `Invoice` documents**, assembled from:

- CEN `ubl/examples` real-world sample invoices;
- our own `corpus/vendored/valid` + `vendored/invalid` fixtures;
- 90 real German-CIUS invoices from the KoSIT `xrechnung-testsuite`;
- every `<test>` case from the 206 CEN `Invoice-unit-UBL` unit-test files,
  split out into standalone invoices;
- one generated mutation per rule (where the rule guards a single field),
  each breaking exactly that field off a known-clean invoice — so every such
  rule is exercised in the failing direction.

That is **117,180 rule-vs-law comparisons** (1085 invoices × 108 rules).

### Result of this run

```
TOTAL AGREEMENT: 117,180 / 117,180 = 100.0000%
divergences: 0 false-positives + 0 misses
```

**All 108 implemented rules agree with the official EN16931-UBL Schematron on
every one of the 1085 invoices**, with zero false positives and zero misses.

| Rule family | Rule IDs | Agreement |
|---|---|---|
| Header existence/cardinality | BR-01, BR-02, BR-03, BR-04, BR-05, BR-06, BR-07, BR-08 | 1085/1085 each |
| Seller/Buyer postal address | BR-09, BR-10, BR-11 | 1085/1085 each |
| Payee & Seller tax representative (BG-10/11/12) | BR-17, BR-18, BR-19, BR-20 | 1085/1085 each |
| Payment instructions (BG-16/17/18) | BR-49, BR-50, BR-51 (warning), BR-61 | 1085/1085 each |
| References, deliver-to & electronic addresses | BR-55, BR-57, BR-62, BR-63 | 1085/1085 each |
| Document totals presence | BR-12, BR-13, BR-14, BR-15 | 1085/1085 each |
| Invoice-line cardinality | BR-16, BR-21, BR-22, BR-24, BR-26 | 1085/1085 each |
| Invoice-line content (BG-25/26/14) | BR-25, BR-27, BR-28, BR-29, BR-30, BR-CO-04 | 1085/1085 each |
| Code list (UNTDID 1001) | BR-CL-01 | 1085/1085 |
| Arithmetic co-constraints | BR-CO-10, BR-CO-13, BR-CO-14, BR-CO-15, BR-CO-16, BR-CO-17 | 1085/1085 each |
| VAT breakdown presence | BR-CO-18 | 1085/1085 |
| VAT breakdown group (BG-23) | BR-45, BR-46, BR-47, BR-48 | 1085/1085 each |
| VAT-category consistency | BR-S-01, BR-Z-01, BR-AE-01, BR-E-01, BR-G-01, BR-IC-01, BR-O-01 | 1085/1085 each |
| Standard-rated (S) category | BR-S-02, BR-S-03, BR-S-04, BR-S-05, BR-S-06, BR-S-07, BR-S-09, BR-S-10 | 1085/1085 each |
| Zero-rated (Z) category | BR-Z-02, BR-Z-03, BR-Z-04, BR-Z-05, BR-Z-06, BR-Z-07, BR-Z-08, BR-Z-09, BR-Z-10 | 1085/1085 each |
| Exempt (E) category | BR-E-02, BR-E-03, BR-E-04, BR-E-05, BR-E-06, BR-E-07, BR-E-08, BR-E-09, BR-E-10 | 1085/1085 each |
| Decimal precision (max 2 places) | BR-DEC-01, BR-DEC-02, BR-DEC-05, BR-DEC-06, BR-DEC-09, BR-DEC-10, BR-DEC-11, BR-DEC-12, BR-DEC-14, BR-DEC-16, BR-DEC-17, BR-DEC-18, BR-DEC-19, BR-DEC-20, BR-DEC-23 | 1085/1085 each |

Reproduce it:

```
export PYTHONPATH="$HOME/.local/lib/python3.10/site-packages:$PYTHONPATH"
python3 differential.py            # needs saxonche importable; runs BOTH legs
python3 differential.py en         # EN 16931 core leg only
```

## 2a. The XRechnung CIUS layer (BR-DE-*), proven the same way

Germany's XRechnung is a CIUS of EN 16931: for German B2G invoices every core
rule applies **plus** the national `BR-DE-*` rules. Our layer implements
**every BR-DE assert in the official UBL artifact** — the KoSIT *XRechnung
Schematron v2.5.0 (XRechnung 3.0.2)*, vendored at
`corpus/xrechnung-schematron/` — 32 assert ids in total (28 numbered rules;
BR-DE-23/24/25 are split by KoSIT into `-a`/`-b` parts, and BR-DE-TMP-32 is
the delivery-date recommendation). The official numbering itself has gaps
(there is no BR-DE-12/13/29 in the 3.0.2 UBL artifact); we implement exactly
what the artifact contains, nothing invented.

Ground truth is the **compiled official XSLT**
(`corpus/xrechnung-schematron/schematron/ubl/XRechnung-UBL-validation.xsl`),
wired into `differential.py` as a second leg with the same yes/no protocol as
§2. Each Python rule transcribes the official **XPath** (untrimmed
string-value comparisons, `normalize-space` predicates, the exact
`following-sibling` node sets, the official IBAN mod-97 digitization —
including its non-standard handling of lowercase letters — and the Skonto
grammar regex with its newline-terminator conjunct), not the prose rule text.

### Corpus and result of this run

**1016 graded UBL `Invoice` documents** (same real corpus as §2 — including
all 45+ KoSIT `xrechnung-testsuite` UBL invoices and every split CEN unit
case — plus 31 BR-DE-targeted mutations off a clean XRechnung testsuite
invoice, so every BR-DE rule is exercised in the **firing** direction; two
`hold`-direction mutations pin the tricky Skonto and delivery-date cases):

```
TOTAL AGREEMENT: 32,512 / 32,512 = 100.0000%   (1016 invoices x 32 rules)
divergences: 0 false-positives + 0 misses
```

Every rule has non-zero `both-fire` **and** `both-clear` coverage. This was a
first-run 100% — the layer was written Schematron-first, like the second core
batch (§3). Two corpus entries are excluded and reported as skips: on the CEN
`BR-CL-23` unit fragments the *official* KoSIT XSLT itself raises a dynamic
error (`Cannot convert string "" to xs:decimal`), so there is no official
verdict to compare against.

Reproduce it:

```
export PYTHONPATH="$HOME/.local/lib/python3.10/site-packages:$PYTHONPATH"
python3 differential.py xrechnung
```

The saxon-free pin of this behaviour is `test_xrechnung.py` (39 unit tests,
run by the repo's mechanical gate via `test/einvoice.test.js`).

### What the XRechnung layer does NOT cover

- ~~`BR-DEX-*` / `BR-DE-CVD-*` / `BR-TMP-2`~~ — since implemented: the
  extension profile, the Clean-Vehicle-Directive profile (each gated on its
  own CustomizationID, inert on plain CIUS invoices), `BR-TMP-2` and the
  CII-only `BR-TMP-3` are all shipped and differential-proven (see
  `COVERAGE.md`); the **`PEPPOL-EN16931-*`** rules KoSIT ships in the same
  artifact live in their own module (KoSIT-vendored subset only);
- **CII syntax and UBL `CreditNote`** documents (our validator is UBL
  `Invoice` only; the official artifact also validates CreditNotes);
- a `--profile=xrechnung` PASS still only means "none of our implemented
  rules fired": the ~157 unimplemented EN core rules (§5) apply to XRechnung
  invoices too.

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

The third batch (BR-45/46/47/48 VAT-breakdown existence/rate + BR-S-02..07/09/10
Standard-rate) was written the same Schematron-first way. The differential
surfaced **one** interpretation trap, which was fixed to match the artifact:
**BR-S-02's two S-line node sets differ.** Its first disjunct requires an S
`ClassifiedTaxCategory` *with a VAT TaxScheme*, but its last disjunct
`not(exists(//cac:ClassifiedTaxCategory[normalize-space(cbc:ID)='S']))` is
**scheme-agnostic** — no `TaxScheme` predicate. So an S item category carrying
no `TaxScheme`, on an invoice with no Seller VAT identifier, **fires** BR-S-02
even though no S+VAT line exists. We model the exact
`C and not(A and SELLER_ID)` firing condition (A = S+VAT line, C = S line any
scheme). Two other transcription points the official XPath pins down: the
BR-S-02/03/04 *seller* identifier test is **scheme-agnostic** (any
`PartyTaxScheme/CompanyID` satisfies it, only the tax-representative disjunct
requires VAT), and BR-S-09 is the same **±1 tolerance band** as BR-CO-17 but
scoped to top-level `/*/cac:TaxTotal` S breakdowns. This batch, too, reached 0
divergences once the BR-S-02 node-set quirk was modelled.

The fourth batch (the invoice-line rules BR-25, BR-27, BR-28, BR-29, BR-30 and
BR-CO-04) was likewise written Schematron-first and reached 0 divergences on
its first full run. The transcription points the official XPath pins down:
**BR-27 is NOT presence-gated** — its general comparison
`(cac:Price/cbc:PriceAmount) >= 0` is false over the empty sequence, so a
price-less line fires BR-27 *alongside* BR-26 (BR-28, by contrast, carries an
explicit `not(exists(...))` disjunct and holds when no gross price is given);
BR-25 is `normalize-space(...) != ''`, so a whitespace-only Item name fires it
(not a pure existence test); BR-CO-04 requires the line's
`ClassifiedTaxCategory` to have a **VAT-scheme** TaxScheme *and* a `cbc:ID`
element (existence — present-but-empty satisfies it); and the shared
BR-29/BR-30 period test lives in ONE Schematron pattern where the line-period
rule appears first, so a line-level `cac:InvoicePeriod` is matched by BR-30
only and never by BR-29 (first matching rule wins within a pattern).

The fifth batch (payee/tax-representative/payment-instruction rules BR-17,
BR-18/19/20, BR-49/50/51/61, BR-55, BR-57, BR-62/63) was likewise written
Schematron-first and reached 0 divergences on its first full run. The
transcription points the official XPath pins down, which a prose reading
would get wrong:

- **BR-17 also fires on a payee that DUPLICATES the seller.** The prose says
  "the payee name shall be provided if the payee differs from the seller", but
  the official test is `exists(name) and not(name = seller-names) and
  not(id = seller-ids)` — general comparisons over **raw string values** (no
  normalize-space) against the seller's `PartyName/Name` and
  `PartyIdentification/ID` node sets via the parent axis. A `cac:PayeeParty`
  whose name or identifier equals the seller's therefore fires the assert,
  exactly like a name-less one.
- **BR-50 and BR-61 read the payment-means code DIFFERENTLY.** BR-50's context
  predicate `[cbc:PaymentMeansCode='30' or ...='58']` compares the RAW string
  value (a padded `" 58 "` never matches), while BR-61 normalize-spaces the
  code (so `" 58 "` DOES trigger it). Their account tests differ the same way:
  BR-61 is `exists(cac:PayeeFinancialAccount/cbc:ID)` (a present-but-empty ID
  satisfies it), BR-50 is `normalize-space(cbc:ID) != ''` per
  `PayeeFinancialAccount` (an empty/whitespace-only ID fires).
- **BR-57 is a pure `exists()`** — a present-but-EMPTY deliver-to
  `IdentificationCode` satisfies it, unlike the `normalize-space(...) != ''`
  country tests of BR-09/BR-11/BR-20. Its pattern context also matches
  line-level `cac:Delivery` groups (as BR-55's matches line-level
  `cac:BillingReference`s), so ours does too.
- **BR-62/BR-63 test attribute EXISTENCE** (`exists(@schemeID)`): an empty
  `schemeID=""` satisfies them.
- **BR-51 is flagged `warning`** in the official artifact — the only non-fatal
  core rule we implement; the violation carries that severity and does not
  block validity, mirroring the SVRL.

## 4. Second, independent check: the conformance harness

`conformance.py` is a separate proof over the curated `corpus/vendored/`
corpus. It drives the **real CLI** end-to-end as a subprocess and asserts, at
the level of individual Difi `<testSet>` assertions:

```
VALID-vector pass rate ............. 14/14   100.0%   (a miss = FALSE POSITIVE)
COVERED-INVALID detection rate ..... 52/52   100.0%   (correct rule id fired)
<error>   fragments: 140 total -> 140 detected, 0 missed, 0 wrong-id
<success> fragments: 144 total -> 144 clean,  0 FALSE POSITIVE
HARD FAILS: 0   -> PASS
```

So the implemented rules are also green against 284 hand-labelled pass/fail
assertions (CEN's own per-rule unit vectors, vendored per rule where CEN ships
them), with the *correct* rule ID fired every time (not merely "some failure").

## 4a. Third check: classifying KoSIT's own official test documents

The differential proof (§2/§2a) shows *engine == Schematron on given inputs*.
The conformance harness (§4) shows the rules are green on CEN's per-rule unit
vectors. This third check answers a distinct, end-to-end question a buyer
actually asks:

> **Does the engine classify KoSIT's *own* official XRechnung test documents
> the way the suite labels them?**

`gen_testsuite_conformance.py` enumerates every `*.xml` under
`corpus/xrechnung-testsuite/src/test/**` — the KoSIT `itplr-kosit/xrechnung-testsuite`
corpus (Apache-2.0), vendored and version-pinned in this repo (XRechnung 3.0.x;
see [`PROVENANCE.md`](PROVENANCE.md) and [`COVERAGE.md`](COVERAGE.md)). The
suite's own `README.md` and `src/doc/test-overview.md` state that **every**
document under `src/test/**` is a **positive reference instance**, so the
expected label of each applicable document is *valid*. The generator classifies
each document end-to-end through the shipped engine that owns its syntax: UBL
documents through the public entry point
(`einvoice.validate_file(path, profile="xrechnung")`); CII (UN/CEFACT,
`*_uncefact.xml`) documents through the same shipped CII path the
golden-snapshot and PDF-container tests exercise —
`report._report_from_invoice_bytes`, which dispatches a `CrossIndustryInvoice`
root to `parser_cii.build_model` + the syntax-agnostic `rules.ALL_RULES` core +
`rules_xrechnung.evaluate_cii` (German CIUS). No rule logic is re-implemented.
It writes the full per-document table plus summary counts to
[`testsuite_conformance.json`](testsuite_conformance.json).

**Headline (measured, not asserted) — stated separately per syntax binding:**

> **UBL:** **39 of 39** in-scope official KoSIT XRechnung test-suite documents
> in UBL syntax are classified exactly as the suite labels them — accepted as
> **valid**.
>
> **CII (UN/CEFACT):** **39 of 39** in-scope `*_uncefact.xml` documents, routed
> through the shipped CII engine, are classified exactly as the suite labels
> them — accepted as **valid**.

"In scope" is stated honestly and narrowly: the engine targets the **plain
EN 16931 / XRechnung-standard CIUS** (CustomizationID ending in
`…#urn:xeinkauf.de:kosit:xrechnung_3.0`) in **both** the UBL and the CII
bindings. Of the suite's 86 documents, 78 are in that scope (39 UBL + 39 CII)
and **all 78** classify as valid. The other 8 are **not hidden** — they are
machine-listed in `testsuite_conformance.json`, each with the exact reason it is
out of scope:

- **6 XRechnung EXTENSION-guideline documents** (CustomizationID contains
  `:extension:`) — a different guideline (sub-invoice-line / construction /
  third-party-payment extension) than the plain CIUS. 4 of them (all UBL) happen
  to still validate; the UBL `05.01a` fails `BR-CO-16` and the CII
  `04.05a_uncefact` fails `BR-CL-21`. They are excluded from the headline
  regardless, because the engine does not claim the extension.
- **2 XRechnung CVD-monitoring-guideline documents** (`02.01a-cvd`,
  CustomizationID contains `xrechnung:cvd`) — a specialised profile the engine
  does not implement; the UBL doc fails `BR-CL-13`, the CII
  `02.01a-cvd_uncefact` likewise fails `BR-CL-13`.

The number is measured, never inflated: no positive document's label is bent
and no rule is fabricated to force a pass. If a genuinely in-scope plain-CIUS
positive document were ever rejected on a rule we *do* claim to cover, it would
be recorded in `testsuite_conformance.json` as an honest divergence (scope class
`in-scope-divergence`) with its firing rule id, and the measured headline would
drop accordingly — a correctness fix would then be tracked separately, not
smuggled into this measurement. Today there are **zero** such in-scope
divergences.

`test_testsuite_conformance.py` re-enumerates and re-classifies the corpus live
on every run and asserts the committed counts match the fresh recompute (so the
headline can never silently drift), and asserts that **every** non-accepted
document carries a non-empty machine-readable reason — silence is the only
forbidden outcome.

## 5. The honest remaining gap — what is NOT proven

The 100% figure is **100% agreement on the 108 rules we implement, over this
1085-invoice corpus.** It is not a claim of EN 16931 or XRechnung conformance.
Specifically:

- **Only 108 of ~200 EN 16931 business rules are implemented.** Still missing:
  BR-23 (quantity unit-of-measure code) and the rest of the BR-49..BR-67
  range (BR-52/53/54 supporting documents, BR-56 tax-representative VAT id,
  BR-58..60/64..67 identifier-scheme and item rules — BR-17..20, BR-49/50/51,
  BR-55, BR-57 and BR-61/62/63 ARE now covered),
  the rest of the `BR-CO-*` arithmetic
  (BR-CO-03/09/11/12/25/26 …), and the deeper VAT-category matrices for the
  **remaining** categories (`BR-AE/G/IC/O-02..10`: their seller-VAT-ID,
  taxable/tax-sum and exemption-reason rules — of AE/G/IC/O only the `-01`
  is implemented). The Standard-rated (S), Zero-rated (Z) and Exempt (E)
  families ARE now fully covered (BR-S-01..07/09/10, BR-Z-01..10,
  BR-E-01..10), with one deliberate exception: **BR-S-08 is deferred** —
  see the note below. Also missing: the remaining `BR-DEC-*` (BT-136/137/141/142
  line allowance/charge amounts) and the `BR-CL-*` code lists beyond BR-CL-01. A
  `valid: true` result means "none of our 108 rules fired", not "this invoice is
  legally conformant". (BR-IG-*/BR-IP-* do not exist in the vendored CEN
  artifact and therefore cannot be differential-proven; they are out of scope.)
- **BR-S-08 (not implemented — an honest scope decision, not a parser limit).**
  BR-S-08 requires, *for each distinct Standard VAT rate*, that the VAT
  breakdown taxable amount (BT-116) equal Σ S-rated line net amounts (BT-131)
  plus Σ S-rated document charge amounts (BT-99) minus Σ S-rated document
  allowance amounts (BT-92) **restricted to lines/charges/allowances whose own
  VAT rate equals that breakdown rate** (a per-rate `group-by` aggregation with
  a ±1 tolerance band, and a parallel CreditNote arm). The parser now exposes
  the per-line and per-allowance/charge category *rates*, so it is modelable;
  it is deferred to its own batch so the multi-rate grouping and the CreditNote
  path can be transcribed and differential-proven with the same rigour rather
  than rushed in alongside the simpler S rules here. Until then it simply does
  not fire, and the differential grades only the 108 rules we do implement.
- **The XRechnung `BR-DE-*` CIUS layer is complete** for the UBL-Invoice
  artifact (all 32 asserts, §2a); the extension (`BR-DEX-*`) and CVD/TMP
  (`BR-DE-CVD-*`/`BR-TMP-*`) profiles have since been implemented too (see
  `COVERAGE.md`) — but at the time of this snapshot the EN core was
  only 108/~200 rules, so `--profile=xrechnung` was **not** a complete
  XRechnung compliance check either.
- **No XSD structural validation**, no CII syntax, no UBL `CreditNote`, no
  ZUGFeRD/Factur-X PDF containers, no signatures.
- **Corpus, not universe.** 1085 real invoices is broad and adversarial but
  finite; agreement on it is strong evidence, not a formal proof over all
  possible inputs.
- **The XSLT is the *compiled* Schematron**, which is the normative technical
  artifact CEN publishes and everyone validates against — but the ultimate
  legal text is the EN 16931 standard itself plus each national CIUS
  (e.g. XRechnung, Factur-X). The Schematron is the faithful machine encoding
  of that text; it is the right ground truth for a validator, and it is what we
  prove against, but it is one layer below the prose standard.

**Bottom line a buyer can rely on:** for the 108 core rules listed in §2, this
validator returns the same verdict as the official EN16931-UBL Schematron on
every invoice in a 1085-document real-world corpus, and for the 32 XRechnung
`BR-DE-*` rules listed in §2a it returns the same verdict as the official
KoSIT XRechnung-UBL Schematron 2.5.0 on a 1016-document corpus — zero false
positives, zero misses on both legs — re-checkable at any time with
`python3 differential.py`. Within those explicitly-scoped 108+32 rule slices it
is provably faithful to the legal rulesets; outside them, it makes no claim.
