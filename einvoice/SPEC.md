# einvoice — SPEC (Phase 0: corpus + first-slice scope)

A conformance-driven validator for German **XRechnung** electronic invoices.
This document fixes the target profile, the UBL Invoice structure the validator
must understand, the concrete first-slice ruleset, and an honest map of what is
*not* yet covered. Every rule chosen for the first slice has at least one
failing fixture in the vendored corpus.

---

## 1. Target profile

- **Profile:** XRechnung 3.x — the German CIUS (Core Invoice Usage Specification)
  of **EN 16931-1:2017**.
- **Syntax:** **UBL 2.1 `Invoice`** and **UBL 2.1 `CreditNote`** (the latter
  routed through the same EN 16931 core engine, differentially proven at 0
  divergences — see COVERAGE.md), plus the UN/CEFACT **CII** syntax via
  `einvoice.report` (graded rule subsets).
  - `CustomizationID = urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`
  - The historical first-slice note (CII + CreditNote out of scope) has been
    superseded; see §6 for the current per-syntax proof status.
- **Rule stack the profile layers (outermost narrows innermost):**
  1. XML well-formedness
  2. UBL 2.1 XSD (`Invoice` schema) — structural validity
  3. EN 16931 core business rules (`BR-*`, `BR-CO-*`, `BR-CL-*`, `BR-S/Z/E/...-*`)
  4. XRechnung CIUS restrictions (`BR-DE-*`) and code-list variants (`BR-DEX-*`)
- **Authoritative references vendored in-repo:** the EN 16931 Schematron
  (`corpus/cen-en16931/ubl/schematron/`) and the KoSIT XRechnung test suite
  (`corpus/xrechnung-testsuite/`). Rule wording in §4 is quoted verbatim from
  `corpus/cen-en16931/ubl/schematron/abstract/EN16931-model.sch` /
  `EN16931-syntax.sch`.

---

## 2. UBL Invoice structure the validator must parse

An XRechnung UBL invoice is a single `<ubl:Invoice>` root in namespace
`urn:oasis:names:specification:ubl:schema:xsd:Invoice-2`, using two shared
component namespaces:

| Prefix | Namespace | Meaning |
|--------|-----------|---------|
| `cbc` | `urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2` | leaf/scalar fields (IDs, dates, amounts, codes) |
| `cac` | `urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2` | aggregate/nested groups (parties, lines, totals) |

Load-bearing paths for the first slice (EN 16931 Business Terms in parens):

- Header: `cbc:CustomizationID` (BT-24), `cbc:ID` (BT-1), `cbc:IssueDate` (BT-2),
  `cbc:InvoiceTypeCode` (BT-3), `cbc:DocumentCurrencyCode` (BT-5),
  `cbc:BuyerReference` (BT-10, required by XRechnung).
- Parties: `cac:AccountingSupplierParty/cac:Party` — seller name via
  `cac:PartyLegalEntity/cbc:RegistrationName` (BT-27) and postal address via
  `cac:PostalAddress` (BG-5); `cac:AccountingCustomerParty/cac:Party` — buyer
  name (BT-44).
- Totals: `cac:TaxTotal/cbc:TaxAmount` (BT-110) and per-category
  `cac:TaxSubtotal` (BG-23); `cac:LegalMonetaryTotal` with `cbc:LineExtensionAmount`
  (BT-106), `cbc:TaxExclusiveAmount` (BT-109), `cbc:TaxInclusiveAmount` (BT-112),
  `cbc:PayableAmount` (BT-115).
- Lines: `cac:InvoiceLine` (BG-25), each with `cbc:ID` (BT-126),
  `cbc:InvoicedQuantity` (BT-129), `cbc:LineExtensionAmount` (BT-131),
  `cac:Price/cbc:PriceAmount` (BT-146), `cac:Item/cbc:Name` (BT-153),
  `cac:Item/cac:ClassifiedTaxCategory` (BG-30).

Amounts carry a `currencyID` attribute; codes are drawn from UN/CEFACT and ISO
code lists (UNTDID 1001 for type codes, ISO 4217 for currencies, UNCL5305 for
VAT category codes).

---

## 3. First-slice validator layers

**Layer S — structural (all invoices):**
- `S-WF`  — document is well-formed XML.
- `S-ROOT`— root element is one the engine grades: `Invoice` in the UBL
  Invoice-2 namespace, `CreditNote` in the UBL CreditNote-2 namespace, or a
  `CrossIndustryInvoice` (CII, matched by local name). Anything else is fatal.
- `S-XSD` — document validates against the UBL 2.1 `Invoice` XSD
  (`corpus/cen-en16931/ubl/schema/`). Establishes that the paths in §2 exist and
  are correctly typed before business rules run.

**Layer B — business rules.** Each is a testable predicate over the parsed
tree. The FIRST SLICE was the 20 rules specified in §4; the ruleset has since
grown to **297 business rules**, 219 of them EN 16931 core `BR-*` asserts
(§6). `COVERAGE.md` is the generated per-rule inventory — it, not this
section, is the current list; `README.md` §2 and `CORRECTNESS.md` carry the
differential proof summaries. The early growth batches, kept as the record:
BR-CO-16/17/18, the BR-AE/E/G/IC/O-01 VAT families and 15 BR-DEC-* decimal
rules were added as a second batch, the BR-09/10/11 seller/buyer
postal-address country-code rules, BR-12..BR-15 document-total presence rules
and the BR-31..44 allowance/charge existence rules as a third, then the
BR-45..48 VAT-breakdown existence/rate rules and BR-S-02..07/09/10
Standard-rate rules as a fourth — all differential-proven.

---

## 4. First-slice business ruleset (the original 20 rules)

Every row: rule ID · verbatim EN 16931 meaning · the vendored fixture whose
`<error>` case triggers it. Fixtures live in
`corpus/vendored/invalid/<RULE>.xml` (Difi `testSet` format — each file holds a
labeled `<error>` invoice fragment for its own rule, plus `<success>` counter-examples).

### Existence / cardinality — document header
| Rule | Meaning | Fixture |
|------|---------|---------|
| BR-01 | An Invoice shall have a Specification identifier (BT-24). | invalid/BR-01.xml |
| BR-02 | An Invoice shall have an Invoice number (BT-1). | invalid/BR-02.xml |
| BR-03 | An Invoice shall have an Invoice issue date (BT-2). | invalid/BR-03.xml |
| BR-04 | An Invoice shall have an Invoice type code (BT-3). | invalid/BR-04.xml |
| BR-05 | An Invoice shall have an Invoice currency code (BT-5). | invalid/BR-05.xml |
| BR-06 | An Invoice shall contain the Seller name (BT-27). | invalid/BR-06.xml |
| BR-07 | An Invoice shall contain the Buyer name (BT-44). | invalid/BR-07.xml |
| BR-08 | An Invoice shall contain the Seller postal address (BG-5). | invalid/BR-08.xml |

### Cardinality — invoice lines
| Rule | Meaning | Fixture |
|------|---------|---------|
| BR-16 | An Invoice shall have at least one Invoice line (BG-25). | invalid/BR-16.xml |
| BR-21 | Each Invoice line shall have an Invoice line identifier (BT-126). | invalid/BR-21.xml |
| BR-22 | Each Invoice line shall have an Invoiced quantity (BT-129). | invalid/BR-22.xml |
| BR-24 | Each Invoice line shall have an Invoice line net amount (BT-131). | invalid/BR-24.xml |
| BR-26 | Each Invoice line shall contain the Item net price (BT-146). | invalid/BR-26.xml |

### Code list
| Rule | Meaning | Fixture |
|------|---------|---------|
| BR-CL-01 | The document type code (BT-3) MUST be coded per UNTDID 1001. | invalid/BR-CL-01.xml |

### Calculation / co-constraint (arithmetic integrity)
| Rule | Meaning | Fixture |
|------|---------|---------|
| BR-CO-10 | Sum of Invoice line net amount (BT-106) = Σ line net amount (BT-131). | invalid/BR-CO-10.xml |
| BR-CO-13 | Invoice total without VAT (BT-109) = Σ line net (BT-131) − doc allowances (BT-107) + doc charges (BT-108). | invalid/BR-CO-13.xml |
| BR-CO-14 | Invoice total VAT amount (BT-110) = Σ VAT category tax amount (BT-117). | invalid/BR-CO-14.xml |
| BR-CO-15 | Invoice total with VAT (BT-112) = total without VAT (BT-109) + total VAT (BT-110). | invalid/BR-CO-15.xml |

### VAT-category consistency
| Rule | Meaning | Fixture |
|------|---------|---------|
| BR-S-01 | If any line/allowance/charge is "Standard rated" (S), the VAT breakdown (BG-23) must contain ≥1 "Standard rated" category. | invalid/BR-S-01.xml |
| BR-Z-01 | If any line/allowance/charge is "Zero rated" (Z), the VAT breakdown must contain exactly one "Zero rated" category. | invalid/BR-Z-01.xml |

**Coverage guarantee:** every implemented rule with a CEN-shipped unit fixture
has a failing fixture vendored (28 invalid vectors); the 12 valid vectors in
`vendored/valid/` must pass ALL implemented rules (they are complete,
KoSIT-conformant XRechnung 3.0 / PEPPOL BIS 3.0 invoices). Rules without a CEN
unit fixture (the BR-DEC-* family) are exercised in the failing direction by
generated mutations in `differential.py`.

---

## 5. Corpus layout

```
corpus/
  cen-en16931/                       # full clone: ConnectingEurope/eInvoicing-EN16931 (EUPL-1.2)
    ubl/schema/                      #   UBL 2.1 XSD (structural validation)
    ubl/schematron/                  #   EN 16931 Schematron — authoritative rule source
      abstract/EN16931-model.sch     #     verbatim BR-* / BR-CO-* rule text
    test/Invoice-unit-UBL/*.xml      #   206 per-rule Difi testSet unit fixtures (195 carry <error>)
    ubl/examples/                    #   complete positive/negative example invoices
  xrechnung-testsuite/               # full clone: itplr-kosit/xrechnung-testsuite (Apache-2.0)
    src/test/business-cases/standard/   #   33 complete valid UBL invoices (*_ubl.xml) + CII twins
    src/test/technical-cases/cius/      #   CIUS comprehensive / minimal conformance invoices
  vendored/                          # curated FIRST-SLICE subset (stable, small)
    valid/    (12 vectors)           #   complete valid UBL invoices — must pass ALL implemented rules
    invalid/  (28 vectors)           #   one labeled testSet per covered rule (<error> case)
    MANIFEST.tsv                     #   path · expectation · rule_id · syntax · profile · source
```

**Fixture format note (invalid vectors):** the CEN unit files are Difi/VEFA
`<testSet>` documents. Each wraps one or more `<test>` blocks; a block asserts
either `<success>RULE</success>` (the embedded `<Invoice>` must pass RULE) or
`<error>RULE</error>` (it must fail RULE). These embedded invoices are
*minimal fragments* that isolate a single rule — they are intentionally not
full schema-complete invoices, so the first-slice validator must assert that the
**labeled** rule fires, not that it is the *only* rule that fires.

---

## 6. Honest NON-coverage (deferred)

Known gaps in this first slice — each is a deliberate cut, not an oversight:

1. **Syntax: SHIPPED** (no longer a gap). UBL `Invoice`, UBL `CreditNote`
   (root `CreditNote-2:CreditNote`, routed through the same EN 16931 core engine
   and differentially proven at 0 divergences over the vendored CreditNote
   corpus — see COVERAGE.md §"UBL CreditNote scope"), and UN/CEFACT **CII**
   (graded rule subsets via `einvoice.report`) are all validated. XML signature
   verification remains out of scope.
2. **XRechnung `BR-DE-*` rules: SHIPPED** (no longer a gap). All 32 `BR-DE-*`
   asserts of the official KoSIT XRechnung 3.0.2 UBL Schematron are
   implemented as a layered profile (`einvoice/rules_xrechnung.py`, enabled
   with `--profile=xrechnung`) and differential-proven at 100% against the
   vendored official artifact (`corpus/xrechnung-schematron/`, see
   `CORRECTNESS.md` §2a). The "failing fixture per rule" contract is honored
   via generated BR-DE-targeted mutations in `differential.py` plus the
   pinned unit vectors in `test_xrechnung.py`. The `BR-DEX-*` extension
   profile and the `BR-DE-CVD-*`/`BR-TMP-*` CVD/temporary family have since
   been implemented as well (see `COVERAGE.md`).
3. **EN 16931 breadth: SHIPPED** (no longer a gap). The engine asserts
   **297 business rules** — `python3 -m einvoice info --json` reports
   `rule_count` and `coverage.business_rules.total_asserted`, and
   `COVERAGE.md` is the per-rule inventory (id, syntax, severity, source
   artifact, verbatim rule text). Measured against each vendored CEN artifact
   the split is **219 implemented + 4 excluded + 0 missing = 223 official
   `BR-*` asserts**, identically in the `en16931-ubl` and the `en16931-cii`
   universe. So the families this document once listed as sampled are
   complete, not chosen: the `BR-CO-*` arithmetic, the VAT-category matrices
   (S/Z/E/AE/K/G/O/IC/IP/IG/L/M), and the allowance/charge rules
   `BR-31`…`BR-44` are all asserted. The **only** official ids the engine does
   not assert are the four `BR-CO-05`, `BR-CO-06`, `BR-CO-07`, `BR-CO-08`,
   which CEN ships as literal `test="true()"` tautologies in BOTH artifacts:
   they can never fire, so no implementation of them could ever be
   differentially proven, and they are permanently excluded with verbatim
   artifact evidence in `COVERAGE.md` §Exclusions. `test_coverage_gap.py`
   re-parses the `.sch` files on every run and fails if fireable-missing is
   ever nonzero, so this paragraph cannot silently go stale.
4. **Code lists: SHIPPED** (no longer a gap). Every fireable `BR-CL-*` assert
   the vendored artifacts carry is implemented, in BOTH the UBL and the CII
   binding — `gen_coverage.py`'s deferred-codelist table
   (`CODELIST_NOT_ASSERTED`) is now the EMPTY dict, and `COVERAGE.md`'s rule
   table is the authoritative inventory. It spans UNTDID 1001 document type
   (`BR-CL-01`), ISO 4217 currency (`BR-CL-03/04/05`), UNTDID 2005 / 2475 VAT
   point date (`BR-CL-06`), UNTDID 1153 (`BR-CL-07`), UNTDID 4451 note subject
   (`BR-CL-08`), the ISO 6523 ICD scheme ids (`BR-CL-10/11/21/26`), UNTDID 7143
   item classification (`BR-CL-13`), ISO 3166-1 country (`BR-CL-14/15`),
   UNCL 4461 payment means (`BR-CL-16`), the UNCL 5305 VAT-category subset
   (`BR-CL-17/18`), UNCL 5189 / UNCL 7161 allowance and charge reasons
   (`BR-CL-19/20`), the CEF VATEX exemption list (`BR-CL-22`), UN/ECE Rec 20
   with the Rec 21 extension for unit codes (`BR-CL-23`), the MIMEMediaType
   subset (`BR-CL-24`) and the CEF EAS electronic-address list (`BR-CL-25`).
   The XRechnung-restricted variants sit on top as `BR-DE-*` / `BR-DEX-*`
   (e.g. `BR-DEX-07` re-grades the endpoint scheme against the EAS *extension*
   list). **The real limit, and it is not a deferral:** every list is
   transcribed VERBATIM from the vendored Schematron at its pinned version into
   `einvoice/codelists.py`, never enumerated from memory — so a code published
   *after* that artifact (a new ISO 4217 or ICD entry) is rejected until the
   corpus is re-vendored, and the UBL and CII sub-lists are pinned separately
   where the official artifacts disagree (the CII UNTDID 1001 list carries 381
   and 471/472/473/500/501; the UBL country list carries `SS` but not `AN`,
   the CII one the reverse).
5. **XSD depth:** no XSD structural validation is performed. Layer S-XSD
   remains deferred — structurally, only XML well-formedness and the root
   element are checked (with `einvoice/_xmlsec.py` refusing DTDs, entity
   declarations and external-entity references on untrusted input), so a
   document that parses but violates the UBL 2.1 / CII schema is still graded
   on business rules alone. A green run therefore means "no implemented rule
   fired", not "schema-valid".
6. **Calculation tolerance / rounding:** the EN 16931 model IS implemented —
   2-decimal quantisation with half-up rounding, plus the official
   Schematron's own `round(x * 10 * 10) div 100` idiom where the artifact uses
   it (that idiom is `floor(x + 0.5)`, which is neither Python's banker's
   rounding nor plain half-up, and it is reproduced deliberately so our verdict
   matches the official one bit for bit). The limit is that this is a
   *reproduction*, not an independent numeric policy: the engine inherits the
   artifact's tolerance behaviour, including its quirks, and the tolerance is
   fixed — there is no knob to widen or tighten it, and no "close enough"
   allowance beyond what the official `@test` itself grants.
7. **Signatures, attachment payloads, PDF/A-3 conformance:**
   - **XML signatures: out of scope.** No XAdES / enveloped signature is
     parsed, and no certificate, chain or digest is cryptographically
     verified. (`einvoice/_xmlsec.py` is parser *hardening* — DTD/entity
     refusal and resource bounds — not signature checking.)
   - **Attachments (BG-24 additional documents): references only.** The
     *references* are graded (`BR-52` supporting-document reference, `BR-DE-22`
     embedded-object filename, `BR-DEX-01` MIME code), but the base64 payload
     itself is never decoded, rendered, virus-scanned or otherwise inspected.
   - **PDF/A-3 (Factur-X / ZUGFeRD hybrid): read, identified, not certified.**
     `einvoice validate invoice.pdf` opens the container, extracts the embedded
     CII XML and grades it on the same rules as a raw `.xml`, and layers six
     advisory container-declaration checks (`FX-CONTAINER-AFRELATIONSHIP`,
     `FX-CONTAINER-AF`, `FX-CONTAINER-XMP`, `FX-CONTAINER-PROFILE`,
     `FX-PDFA3-PART`, `FX-PDFA3-CONFORMANCE`). Those last two are the PDF/A-3
     **identification** subset only — they check that the XMP *declares* part 3
     and conformance level A/B/U. Font embedding, ICC / output-intent colour
     and document tagging are NOT checked, so this is not a PDF/A-3 conformance
     validator (that needs veraPDF-class tooling), and a file that lies in its
     identification schema is out of scope. The reader handles classic-layout
     PDFs; encrypted, cross-reference-stream (PDF 1.5+) and truncated files are
     refused as `unsupported-container` (exit 3), never guessed at.

---

## 7. Sources

- EN 16931 test corpus & Schematron: `github.com/ConnectingEurope/eInvoicing-EN16931` (EUPL-1.2)
- XRechnung test suite: `github.com/itplr-kosit/xrechnung-testsuite` (Apache-2.0)
- Rule wording quoted from the vendored `EN16931-model.sch` / `EN16931-syntax.sch`.
