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
- **Syntax (first slice):** **UBL 2.1 `Invoice`** only.
  - `CustomizationID = urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`
  - The UN/CEFACT CII syntax and the UBL `CreditNote` document are explicitly
    out of scope for the first slice (see §6).
- **Rule stack the profile layers (outermost narrows innermost):**
  1. XML well-formedness
  2. UBL 2.1 XSD (`Invoice` schema) — structural validity
  3. EN 16931 business rules (`BR-*`, `BR-CO-*`, `BR-CL-*`, `BR-S/Z/E/...-*`)
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
- `S-ROOT`— root element is `Invoice` in the UBL Invoice-2 namespace.
- `S-XSD` — document validates against the UBL 2.1 `Invoice` XSD
  (`corpus/cen-en16931/ubl/schema/`). Establishes that the paths in §2 exist and
  are correctly typed before business rules run.

**Layer B — business rules.** Each is a testable predicate over the parsed
tree. The FIRST SLICE was the 20 rules specified in §4; the ruleset has since
grown to 50 (see `README.md` §2 and `CORRECTNESS.md` for the current list —
BR-CO-16/17/18, the BR-AE/E/G/IC/O-01 VAT families and 15 BR-DEC-* decimal
rules were added as a second batch, then the BR-09/10/11 seller/buyer
postal-address country-code rules and BR-12..BR-15 document-total presence
rules as a third — all differential-proven).

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

1. **Syntax:** UN/CEFACT **CII** invoices and UBL **CreditNote** documents are
   not validated. Only UBL `Invoice` is in scope. (CII twins are present in the
   corpus but unused.)
2. **XRechnung `BR-DE-*` rules: SHIPPED** (no longer a gap). All 32 `BR-DE-*`
   asserts of the official KoSIT XRechnung 3.0.2 UBL Schematron are
   implemented as a layered profile (`einvoice/rules_xrechnung.py`, enabled
   with `--profile=xrechnung`) and differential-proven at 100% against the
   vendored official artifact (`corpus/xrechnung-schematron/`, see
   `CORRECTNESS.md` §2a). The "failing fixture per rule" contract is honored
   via generated BR-DE-targeted mutations in `differential.py` plus the
   pinned unit vectors in `test_xrechnung.py`. Still out of scope:
   `BR-DEX-*` (extension profile) and `BR-DE-CVD-*` (CVD profile).
3. **EN 16931 breadth:** ~180 further `BR-*` rules are unimplemented, including
   most `BR-CO-*` arithmetic (only 10/13/14/15 chosen), the full VAT-category
   matrices for E/G/O/IC/IP/IG/AE/K/L/M categories (only S-01, Z-01 chosen),
   allowance/charge rules (BR-31…BR-44), and the `BR-CL-*` code-list family
   (only BR-CL-01 chosen).
4. **Code lists:** only UNTDID 1001 (type code) is checked, and only for
   presence-in-list, not the XRechnung-restricted subset. ISO 4217 currency,
   UNCL5305 VAT categories, ISO 3166 country, ISO 6523 scheme IDs, EAS/electronic
   address schemes, and unit-of-measure (UNECERec20) lists are deferred.
5. **XSD depth:** Layer S-XSD assumes the UBL 2.1 schema files resolve locally;
   full offline schema-resolution hardening is deferred.
6. **Calculation tolerance / rounding:** BR-CO-* arithmetic will need the EN 16931
   half-up rounding and 2-decimal tolerance model; the precise tolerance policy
   is not yet specified here.
7. **Signatures, attachments (BG-24 additional documents), PDF/A-3 (ZUGFeRD
   hybrid) containers:** entirely out of scope.

---

## 7. Sources

- EN 16931 test corpus & Schematron: `github.com/ConnectingEurope/eInvoicing-EN16931` (EUPL-1.2)
- XRechnung test suite: `github.com/itplr-kosit/xrechnung-testsuite` (Apache-2.0)
- Rule wording quoted from the vendored `EN16931-model.sch` / `EN16931-syntax.sch`.
