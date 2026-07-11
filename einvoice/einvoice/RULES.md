# einvoice — Rule Reference

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with `python3 gen_rules_doc.py` (renders from
     remediation_catalog.json via
     einvoice.remediation.load_catalog_document).
     test_rules_doc.py asserts this file is byte-identical to a fresh
     render, so any manual edit will fail the gate. -->

This is a browsable, plain-language reference to every EN 16931 / XRechnung
business rule the einvoice engine can fire. Each entry is rendered straight
from `remediation_catalog.json`, whose fields are **derived** from the
vendored official Schematron (`corpus/`) and the EN 16931 BT/BG business-term
model — they are not authored from memory. To change any wording here, edit
the catalog (or the rule it derives from) and re-run `gen_rules_doc.py`; do
not edit this file.

Each rule shows these catalog fields:

- **Requires** — what the rule demands (`requires`).
- **Business terms** — the EN 16931 BT-/BG- ids the rule touches (`bt_bg`).
- **Location** — the XML path/element a finding concerns (`location_hint`).
- **Fix** — a one-line corrective action (`fix`).
- **Severity** — engine severity: `fatal` blocks validity; `warning` / `information`
  are reported but non-blocking (`severity`).
- **Provenance** — the Schematron source key plus the verbatim official
  assert the wording is derived from (`provenance`).

Family headings are standard EN 16931 / XRechnung rule-family labels used
only for navigation; every substantive per-rule string above comes from the
catalog.

**276 rules** in total — 265 fatal, 10 warning, 1 information — across 18 families.

## Families

- **BR** (58) — Core EN 16931 content and cardinality rules.
- **BR-CL** (15) — Code-list rules — a coded value must come from the referenced official code list.
- **BR-CO** (19) — Calculation and consistency rules (cross-total arithmetic).
- **BR-DEC** (19) — Decimal-places rules — amounts must not exceed the allowed number of decimals.
- **BR-AE** (10) — VAT breakdown rules for VAT category code AE.
- **BR-AF** (10) — VAT breakdown rules for VAT category code L (IGIC, Canary Islands general indirect tax).
- **BR-AG** (10) — VAT breakdown rules for VAT category code M (IPSI, tax for Ceuta and Melilla).
- **BR-B** (2) — VAT breakdown rules for VAT category code B (Italian split payment).
- **BR-E** (10) — VAT breakdown rules for VAT category code E.
- **BR-G** (10) — VAT breakdown rules for VAT category code G.
- **BR-IC** (12) — VAT breakdown rules for the intra-community VAT category.
- **BR-O** (14) — VAT breakdown rules for VAT category code O.
- **BR-S** (10) — VAT breakdown rules for VAT category code S.
- **BR-Z** (10) — VAT breakdown rules for VAT category code Z.
- **BR-DE** (31) — German XRechnung national CIUS rules (KoSIT).
- **BR-DE-TMP** (1) — German XRechnung national rules (BR-DE-TMP).
- **BR-DEX** (14) — German XRechnung extension-layer rules (BR-DEX).
- **PEPPOL-EN16931** (21) — Peppol-derived rules as vendored inside the official KoSIT XRechnung Schematron artifact — the KoSIT-vendored subset only, NOT full Peppol BIS Billing 3.0 support.

## BR

Core EN 16931 content and cardinality rules.

### BR-01 — An Invoice shall have a Specification identifier (BT-24).

- **Requires:** An Invoice shall have a Specification identifier (BT-24).
- **Business terms:** BT-24
- **Location:** `cbc:CustomizationID`
- **Fix:** Add the required element at `cbc:CustomizationID`: An Invoice shall have a Specification identifier (BT-24).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall have a Specification identifier (BT-24).”

### BR-02 — An Invoice shall have an Invoice number (BT-1).

- **Requires:** An Invoice shall have an Invoice number (BT-1).
- **Business terms:** BT-1
- **Location:** `cbc:ID`
- **Fix:** Add the required element at `cbc:ID`: An Invoice shall have an Invoice number (BT-1).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall have an Invoice number (BT-1).”

### BR-03 — An Invoice shall have an Invoice issue date (BT-2).

- **Requires:** An Invoice shall have an Invoice issue date (BT-2).
- **Business terms:** BT-2
- **Location:** `cbc:IssueDate`
- **Fix:** Add the required element at `cbc:IssueDate`: An Invoice shall have an Invoice issue date (BT-2).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall have an Invoice issue date (BT-2).”

### BR-04 — An Invoice shall have an Invoice type code (BT-3).

- **Requires:** An Invoice shall have an Invoice type code (BT-3).
- **Business terms:** BT-3
- **Location:** `cbc:InvoiceTypeCode`
- **Fix:** Add the required element at `cbc:InvoiceTypeCode`: An Invoice shall have an Invoice type code (BT-3).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall have an Invoice type code (BT-3).”

### BR-05 — An Invoice shall have an Invoice currency code (BT-5).

- **Requires:** An Invoice shall have an Invoice currency code (BT-5).
- **Business terms:** BT-5
- **Location:** `cbc:DocumentCurrencyCode`
- **Fix:** Add the required element at `cbc:DocumentCurrencyCode`: An Invoice shall have an Invoice currency code (BT-5).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall have an Invoice currency code (BT-5).”

### BR-06 — An Invoice shall contain the Seller name (BT-27).

- **Requires:** An Invoice shall contain the Seller name (BT-27).
- **Business terms:** BT-27
- **Location:** `cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName`
- **Fix:** Add the required element at `cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName`: An Invoice shall contain the Seller name (BT-27).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall contain the Seller name (BT-27).”

### BR-07 — An Invoice shall contain the Buyer name (BT-44).

- **Requires:** An Invoice shall contain the Buyer name (BT-44).
- **Business terms:** BT-44
- **Location:** `cac:AccountingCustomerParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName`
- **Fix:** Add the required element at `cac:AccountingCustomerParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName`: An Invoice shall contain the Buyer name (BT-44).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall contain the Buyer name (BT-44).”

### BR-08 — An Invoice shall contain the Seller postal address (BG-5).

- **Requires:** An Invoice shall contain the Seller postal address.
- **Business terms:** BG-5
- **Location:** `cac:AccountingSupplierParty/cac:Party/cac:PostalAddress`
- **Fix:** Add the required element at `cac:AccountingSupplierParty/cac:Party/cac:PostalAddress`: An Invoice shall contain the Seller postal address.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall contain the Seller postal address.”

### BR-09 — The Seller postal address (BG-5) shall contain a Seller country code (BT-40).

- **Requires:** The Seller postal address (BG-5) shall contain a Seller country code (BT-40).
- **Business terms:** BG-5, BT-40
- **Location:** `cac:AccountingSupplierParty/cac:Party/cac:PostalAddress`
- **Fix:** Add the required element at `cac:AccountingSupplierParty/cac:Party/cac:PostalAddress`: The Seller postal address (BG-5) shall contain a Seller country code (BT-40).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The Seller postal address (BG-5) shall contain a Seller country code (BT-40).”

### BR-10 — An Invoice shall contain the Buyer postal address (BG-8).

- **Requires:** An Invoice shall contain the Buyer postal address (BG-8).
- **Business terms:** BG-8
- **Location:** `cac:AccountingCustomerParty/cac:Party/cac:PostalAddress`
- **Fix:** Add the required element at `cac:AccountingCustomerParty/cac:Party/cac:PostalAddress`: An Invoice shall contain the Buyer postal address (BG-8).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall contain the Buyer postal address (BG-8).”

### BR-11 — The Buyer postal address shall contain a Buyer country code (BT-55).

- **Requires:** The Buyer postal address shall contain a Buyer country code (BT-55).
- **Business terms:** BT-55
- **Location:** `cac:AccountingCustomerParty/cac:Party/cac:PostalAddress`
- **Fix:** Add the required element at `cac:AccountingCustomerParty/cac:Party/cac:PostalAddress`: The Buyer postal address shall contain a Buyer country code (BT-55).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The Buyer postal address shall contain a Buyer country code (BT-55).”

### BR-12 — An Invoice shall have the Sum of Invoice line net amount (BT-106).

- **Requires:** An Invoice shall have the Sum of Invoice line net amount (BT-106).
- **Business terms:** BT-106
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Add the required element at `cac:LegalMonetaryTotal`: An Invoice shall have the Sum of Invoice line net amount (BT-106).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall have the Sum of Invoice line net amount (BT-106).”

### BR-13 — An Invoice shall have the Invoice total amount without VAT (BT-109).

- **Requires:** An Invoice shall have the Invoice total amount without VAT (BT-109).
- **Business terms:** BT-109
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Add the required element at `cac:LegalMonetaryTotal`: An Invoice shall have the Invoice total amount without VAT (BT-109).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall have the Invoice total amount without VAT (BT-109).”

### BR-14 — An Invoice shall have the Invoice total amount with VAT (BT-112).

- **Requires:** An Invoice shall have the Invoice total amount with VAT (BT-112).
- **Business terms:** BT-112
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Add the required element at `cac:LegalMonetaryTotal`: An Invoice shall have the Invoice total amount with VAT (BT-112).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall have the Invoice total amount with VAT (BT-112).”

### BR-15 — An Invoice shall have the Amount due for payment (BT-115).

- **Requires:** An Invoice shall have the Amount due for payment (BT-115).
- **Business terms:** BT-115
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Add the required element at `cac:LegalMonetaryTotal`: An Invoice shall have the Amount due for payment (BT-115).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall have the Amount due for payment (BT-115).”

### BR-16 — An Invoice shall have at least one Invoice line (BG-25).

- **Requires:** An Invoice shall have at least one Invoice line (BG-25)
- **Business terms:** BG-25
- **Location:** `cac:InvoiceLine`
- **Fix:** Add the required element at `cac:InvoiceLine`: An Invoice shall have at least one Invoice line (BG-25).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall have at least one Invoice line (BG-25)”

### BR-17 — The Payee name (BT-59) shall be provided in the Invoice, if the Payee (BG-10) is different from the Seller (BG-4).

- **Requires:** The Payee name (BT-59) shall be provided in the Invoice, if the Payee (BG-10) is different from the Seller (BG-4)
- **Business terms:** BG-4, BG-10, BT-59
- **Location:** `cac:PayeeParty`
- **Fix:** Add the required element at `cac:PayeeParty`: The Payee name (BT-59) shall be provided in the Invoice, if the Payee (BG-10) is different from the Seller (BG-4).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The Payee name (BT-59) shall be provided in the Invoice, if the Payee (BG-10) is different from the Seller (BG-4)”

### BR-18 — The Seller tax representative name (BT-62) shall be provided in the Invoice, if the Seller (BG-4) has a Seller tax representative party (BG-11).

- **Requires:** The Seller tax representative name (BT-62) shall be provided in the Invoice, if the Seller (BG-4) has a Seller tax representative party (BG-11)
- **Business terms:** BG-4, BG-11, BT-62
- **Location:** `cac:TaxRepresentativeParty`
- **Fix:** Add the required element at `cac:TaxRepresentativeParty`: The Seller tax representative name (BT-62) shall be provided in the Invoice, if the Seller (BG-4) has a Seller tax representative party (BG-11).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The Seller tax representative name (BT-62) shall be provided in the Invoice, if the Seller (BG-4) has a Seller tax representative party (BG-11)”

### BR-19 — The Seller tax representative postal address (BG-12) shall be provided in the Invoice, if the Seller (BG-4) has a Seller tax representative party (BG-11).

- **Requires:** The Seller tax representative postal address (BG-12) shall be provided in the Invoice, if the Seller (BG-4) has a Seller tax representative party (BG-11).
- **Business terms:** BG-4, BG-11, BG-12
- **Location:** `cac:TaxRepresentativeParty`
- **Fix:** Add the required element at `cac:TaxRepresentativeParty`: The Seller tax representative postal address (BG-12) shall be provided in the Invoice, if the Seller (BG-4) has a Seller tax representative party (BG-11).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The Seller tax representative postal address (BG-12) shall be provided in the Invoice, if the Seller (BG-4) has a Seller tax representative party (BG-11).”

### BR-20 — The Seller tax representative postal address (BG-12) shall contain a Tax representative country code (BT-69), if the Seller (BG-4) has a Seller tax representative party (BG-11).

- **Requires:** The Seller tax representative postal address (BG-12) shall contain a Tax representative country code (BT-69), if the Seller (BG-4) has a Seller tax representative party (BG-11).
- **Business terms:** BG-4, BG-11, BG-12, BT-69
- **Location:** `cac:TaxRepresentativeParty/cac:PostalAddress`
- **Fix:** Add the required element at `cac:TaxRepresentativeParty/cac:PostalAddress`: The Seller tax representative postal address (BG-12) shall contain a Tax representative country code (BT-69), if the Seller (BG-4) has a Seller tax representative party (BG-11).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The Seller tax representative postal address (BG-12) shall contain a Tax representative country code (BT-69), if the Seller (BG-4) has a Seller tax representative party (BG-11).”

### BR-21 — Each Invoice line shall have an Invoice line identifier (BT-126).

- **Requires:** Each Invoice line (BG-25) shall have an Invoice line identifier (BT-126).
- **Business terms:** BG-25, BT-126
- **Location:** `cac:InvoiceLine`
- **Fix:** Add the required element at `cac:InvoiceLine`: Each Invoice line (BG-25) shall have an Invoice line identifier (BT-126).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Invoice line (BG-25) shall have an Invoice line identifier (BT-126).”

### BR-22 — Each Invoice line shall have an Invoiced quantity (BT-129).

- **Requires:** Each Invoice line (BG-25) shall have an Invoiced quantity (BT-129).
- **Business terms:** BG-25, BT-129
- **Location:** `cac:InvoiceLine`
- **Fix:** Add the required element at `cac:InvoiceLine`: Each Invoice line (BG-25) shall have an Invoiced quantity (BT-129).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Invoice line (BG-25) shall have an Invoiced quantity (BT-129).”

### BR-23 — An Invoice line (BG-25) shall have an Invoiced quantity unit of measure code (BT-130).

- **Requires:** An Invoice line (BG-25) shall have an Invoiced quantity unit of measure code (BT-130).
- **Business terms:** BG-25, BT-130
- **Location:** `cac:InvoiceLine`
- **Fix:** Add the required element at `cac:InvoiceLine`: An Invoice line (BG-25) shall have an Invoiced quantity unit of measure code (BT-130).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice line (BG-25) shall have an Invoiced quantity unit of measure code (BT-130).”

### BR-24 — Each Invoice line shall have an Invoice line net amount (BT-131).

- **Requires:** Each Invoice line (BG-25) shall have an Invoice line net amount (BT-131).
- **Business terms:** BG-25, BT-131
- **Location:** `cac:InvoiceLine`
- **Fix:** Add the required element at `cac:InvoiceLine`: Each Invoice line (BG-25) shall have an Invoice line net amount (BT-131).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Invoice line (BG-25) shall have an Invoice line net amount (BT-131).”

### BR-25 — Each Invoice line (BG-25) shall contain the Item name (BT-153).

- **Requires:** Each Invoice line (BG-25) shall contain the Item name (BT-153).
- **Business terms:** BG-25, BT-153
- **Location:** `cac:InvoiceLine`
- **Fix:** Add the required element at `cac:InvoiceLine`: Each Invoice line (BG-25) shall contain the Item name (BT-153).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Invoice line (BG-25) shall contain the Item name (BT-153).”

### BR-26 — Each Invoice line shall contain the Item net price (BT-146).

- **Requires:** Each Invoice line (BG-25) shall contain the Item net price (BT-146).
- **Business terms:** BG-25, BT-146
- **Location:** `cac:InvoiceLine`
- **Fix:** Add the required element at `cac:InvoiceLine`: Each Invoice line (BG-25) shall contain the Item net price (BT-146).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Invoice line (BG-25) shall contain the Item net price (BT-146).”

### BR-27 — The Item net price (BT-146) shall NOT be negative.

- **Requires:** The Item net price (BT-146) shall NOT be negative.
- **Business terms:** BT-146
- **Location:** `cac:InvoiceLine`
- **Fix:** Correct `cac:InvoiceLine` so that The Item net price (BT-146) shall NOT be negative.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The Item net price (BT-146) shall NOT be negative.”

### BR-28 — The Item gross price (BT-148) shall NOT be negative.

- **Requires:** The Item gross price (BT-148) shall NOT be negative.
- **Business terms:** BT-148
- **Location:** `cac:InvoiceLine`
- **Fix:** Add the required element at `cac:InvoiceLine`: The Item gross price (BT-148) shall NOT be negative.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The Item gross price (BT-148) shall NOT be negative.”

### BR-29 — If both Invoicing period start date (BT-73) and end date (BT-74) are given then the end date shall be later or equal to the start date.

- **Requires:** If both Invoicing period start date (BT-73) and Invoicing period end date (BT-74) are given then the Invoicing period end date (BT-74) shall be later or equal to the Invoicing period start date (BT-73).
- **Business terms:** BT-73, BT-74
- **Location:** `cac:InvoicePeriod`
- **Fix:** Add the required element at `cac:InvoicePeriod`: If both Invoicing period start date (BT-73) and Invoicing period end date (BT-74) are given then the Invoicing period end date (BT-74) shall be later or equal to the Invoicing period start date (BT-73).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “If both Invoicing period start date (BT-73) and Invoicing period end date (BT-74) are given then the Invoicing period end date (BT-74) shall be later or equal to the Invoicing period start date (BT-73).”

### BR-30 — If both Invoice line period start date (BT-134) and end date (BT-135) are given then the end date shall be later or equal to the start date.

- **Requires:** If both Invoice line period start date (BT-134) and Invoice line period end date (BT-135) are given then the Invoice line period end date (BT-135) shall be later or equal to the Invoice line period start date (BT-134).
- **Business terms:** BT-134, BT-135
- **Location:** `cac:InvoiceLine/cac:InvoicePeriod`
- **Fix:** Add the required element at `cac:InvoiceLine/cac:InvoicePeriod`: If both Invoice line period start date (BT-134) and Invoice line period end date (BT-135) are given then the Invoice line period end date (BT-135) shall be later or equal to the Invoice line period start date (BT-134).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “If both Invoice line period start date (BT-134) and Invoice line period end date (BT-135) are given then the Invoice line period end date (BT-135) shall be later or equal to the Invoice line period start date (BT-134).”

### BR-31 — Each Document level allowance (BG-20) shall have a Document level allowance amount (BT-92).

- **Requires:** Each Document level allowance (BG-20) shall have a Document level allowance amount (BT-92).
- **Business terms:** BG-20, BT-92
- **Location:** `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`: Each Document level allowance (BG-20) shall have a Document level allowance amount (BT-92).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Document level allowance (BG-20) shall have a Document level allowance amount (BT-92).”

### BR-32 — Each Document level allowance (BG-20) shall have a Document level allowance VAT category code (BT-95).

- **Requires:** Each Document level allowance (BG-20) shall have a Document level allowance VAT category code (BT-95).
- **Business terms:** BG-20, BT-95
- **Location:** `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`
- **Fix:** Correct `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = false()]` so that Each Document level allowance (BG-20) shall have a Document level allowance VAT category code (BT-95).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Document level allowance (BG-20) shall have a Document level allowance VAT category code (BT-95).”

### BR-33 — Each Document level allowance (BG-20) shall have a Document level allowance reason (BT-97) or a Document level allowance reason code (BT-98).

- **Requires:** Each Document level allowance (BG-20) shall have a Document level allowance reason (BT-97) or a Document level allowance reason code (BT-98).
- **Business terms:** BG-20, BT-97, BT-98
- **Location:** `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`: Each Document level allowance (BG-20) shall have a Document level allowance reason (BT-97) or a Document level allowance reason code (BT-98).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Document level allowance (BG-20) shall have a Document level allowance reason (BT-97) or a Document level allowance reason code (BT-98).”

### BR-36 — Each Document level charge (BG-21) shall have a Document level charge amount (BT-99).

- **Requires:** Each Document level charge (BG-21) shall have a Document level charge amount (BT-99).
- **Business terms:** BG-21, BT-99
- **Location:** `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`: Each Document level charge (BG-21) shall have a Document level charge amount (BT-99).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Document level charge (BG-21) shall have a Document level charge amount (BT-99).”

### BR-37 — Each Document level charge (BG-21) shall have a Document level charge VAT category code (BT-102).

- **Requires:** Each Document level charge (BG-21) shall have a Document level charge VAT category code (BT-102).
- **Business terms:** BG-21, BT-102
- **Location:** `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`
- **Fix:** Correct `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = true()]` so that Each Document level charge (BG-21) shall have a Document level charge VAT category code (BT-102).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Document level charge (BG-21) shall have a Document level charge VAT category code (BT-102).”

### BR-38 — Each Document level charge (BG-21) shall have a Document level charge reason (BT-104) or a Document level charge reason code (BT-105).

- **Requires:** Each Document level charge (BG-21) shall have a Document level charge reason (BT-104) or a Document level charge reason code (BT-105).
- **Business terms:** BG-21, BT-104, BT-105
- **Location:** `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`: Each Document level charge (BG-21) shall have a Document level charge reason (BT-104) or a Document level charge reason code (BT-105).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Document level charge (BG-21) shall have a Document level charge reason (BT-104) or a Document level charge reason code (BT-105).”

### BR-41 — Each Invoice line allowance (BG-27) shall have an Invoice line allowance amount (BT-136).

- **Requires:** Each Invoice line allowance (BG-27) shall have an Invoice line allowance amount (BT-136).
- **Business terms:** BG-27, BT-136
- **Location:** `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`
- **Fix:** Add the required element at `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`: Each Invoice line allowance (BG-27) shall have an Invoice line allowance amount (BT-136).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Invoice line allowance (BG-27) shall have an Invoice line allowance amount (BT-136).”

### BR-42 — Each Invoice line allowance (BG-27) shall have an Invoice line allowance reason (BT-139) or an Invoice line allowance reason code (BT-140).

- **Requires:** Each Invoice line allowance (BG-27) shall have an Invoice line allowance reason (BT-139) or an Invoice line allowance reason code (BT-140).
- **Business terms:** BG-27, BT-139, BT-140
- **Location:** `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`
- **Fix:** Add the required element at `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`: Each Invoice line allowance (BG-27) shall have an Invoice line allowance reason (BT-139) or an Invoice line allowance reason code (BT-140).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Invoice line allowance (BG-27) shall have an Invoice line allowance reason (BT-139) or an Invoice line allowance reason code (BT-140).”

### BR-43 — Each Invoice line charge (BG-28) shall have an Invoice line charge amount (BT-141).

- **Requires:** Each Invoice line charge (BG-28) shall have an Invoice line charge amount (BT-141).
- **Business terms:** BG-28, BT-141
- **Location:** `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`
- **Fix:** Add the required element at `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`: Each Invoice line charge (BG-28) shall have an Invoice line charge amount (BT-141).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Invoice line charge (BG-28) shall have an Invoice line charge amount (BT-141).”

### BR-44 — Each Invoice line charge (BG-28) shall have an Invoice line charge reason (BT-144) or an Invoice line charge reason code (BT-145).

- **Requires:** Each Invoice line charge shall have an Invoice line charge reason or an invoice line allowance reason code.
- **Business terms:** BG-28, BT-144, BT-145
- **Location:** `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`
- **Fix:** Add the required element at `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`: Each Invoice line charge shall have an Invoice line charge reason or an invoice line allowance reason code.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Invoice line charge shall have an Invoice line charge reason or an invoice line allowance reason code.”

### BR-45 — Each VAT breakdown (BG-23) shall have a VAT category taxable amount (BT-116).

- **Requires:** Each VAT breakdown (BG-23) shall have a VAT category taxable amount (BT-116).
- **Business terms:** BG-23, BT-116
- **Location:** `cac:TaxTotal/cac:TaxSubtotal`
- **Fix:** Add the required element at `cac:TaxTotal/cac:TaxSubtotal`: Each VAT breakdown (BG-23) shall have a VAT category taxable amount (BT-116).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each VAT breakdown (BG-23) shall have a VAT category taxable amount (BT-116).”

### BR-46 — Each VAT breakdown (BG-23) shall have a VAT category tax amount (BT-117).

- **Requires:** Each VAT breakdown (BG-23) shall have a VAT category tax amount (BT-117).
- **Business terms:** BG-23, BT-117
- **Location:** `cac:TaxTotal/cac:TaxSubtotal`
- **Fix:** Add the required element at `cac:TaxTotal/cac:TaxSubtotal`: Each VAT breakdown (BG-23) shall have a VAT category tax amount (BT-117).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each VAT breakdown (BG-23) shall have a VAT category tax amount (BT-117).”

### BR-47 — Each VAT breakdown (BG-23) shall be defined through a VAT category code (BT-118).

- **Requires:** Each VAT breakdown (BG-23) shall be defined through a VAT category code (BT-118).
- **Business terms:** BG-23, BT-118
- **Location:** `cac:TaxTotal/cac:TaxSubtotal`
- **Fix:** Correct `cac:TaxTotal/cac:TaxSubtotal` so that Each VAT breakdown (BG-23) shall be defined through a VAT category code (BT-118).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each VAT breakdown (BG-23) shall be defined through a VAT category code (BT-118).”

### BR-48 — Each VAT breakdown (BG-23) shall have a VAT category rate (BT-119), except if the Invoice is not subject to VAT.

- **Requires:** Each VAT breakdown (BG-23) shall have a VAT category rate (BT-119), except if the Invoice is not subject to VAT.
- **Business terms:** BG-23, BT-119
- **Location:** `cac:TaxTotal/cac:TaxSubtotal`
- **Fix:** Correct `cac:TaxTotal/cac:TaxSubtotal` so that Each VAT breakdown (BG-23) shall have a VAT category rate (BT-119), except if the Invoice is not subject to VAT.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each VAT breakdown (BG-23) shall have a VAT category rate (BT-119), except if the Invoice is not subject to VAT.”

### BR-49 — A Payment instruction (BG-16) shall specify the Payment means type code (BT-81).

- **Requires:** A Payment instruction (BG-16) shall specify the Payment means type code (BT-81).
- **Business terms:** BG-16, BT-81
- **Location:** `cac:PaymentMeans`
- **Fix:** Add the required element at `cac:PaymentMeans`: A Payment instruction (BG-16) shall specify the Payment means type code (BT-81).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “A Payment instruction (BG-16) shall specify the Payment means type code (BT-81).”

### BR-50 — A Payment account identifier (BT-84) shall be present if Credit transfer (BG-17) information is provided in the Invoice.

- **Requires:** A Payment account identifier (BT-84) shall be present if Credit transfer (BG-17) information is provided in the Invoice.
- **Business terms:** BG-17, BT-84
- **Location:** `cac:PaymentMeans[cbc:PaymentMeansCode='30' or cbc:PaymentMeansCode='58']/cac:PayeeFinancialAccount`
- **Fix:** Add the required element at `cac:PaymentMeans[cbc:PaymentMeansCode='30' or cbc:PaymentMeansCode='58']/cac:PayeeFinancialAccount`: A Payment account identifier (BT-84) shall be present if Credit transfer (BG-17) information is provided in the Invoice.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “A Payment account identifier (BT-84) shall be present if Credit transfer (BG-17) information is provided in the Invoice.”

### BR-51 — The last 4 to 6 digits of the Payment card primary account number (BT-87) shall be present if Payment card information (BG-18) is provided.

- **Requires:** In accordance with card payments security standards an invoice should never include a full card primary account number (BT-87). At the moment PCI Security Standards Council has defined that the first 6 digits and last 4 digits are the maximum number of digits to be shown.
- **Business terms:** BG-18, BT-87
- **Location:** `cac:PaymentMeans/cac:CardAccount/cbc:PrimaryAccountNumberID`
- **Fix:** Correct `cac:PaymentMeans/cac:CardAccount/cbc:PrimaryAccountNumberID` so that In accordance with card payments security standards an invoice should never include a full card primary account number (BT-87). At the moment PCI Security Standards Council has defined that the first 6 digits and last 4 digits are the maximum number of digits to be shown.
- **Severity:** warning
- **Provenance:** `en16931-ubl` — “In accordance with card payments security standards an invoice should never include a full card primary account number (BT-87). At the moment PCI Security Standards Council has defined that the first 6 digits and last 4 digits are the maximum number of digits to be shown.”

### BR-52 — Each Additional supporting document (BG-24) shall contain a Supporting document reference (BT-122).

- **Requires:** Each Additional supporting document (BG-24) shall contain a Supporting document reference (BT-122).
- **Business terms:** BG-24, BT-122
- **Location:** `cac:AdditionalDocumentReference`
- **Fix:** Add the required element at `cac:AdditionalDocumentReference`: Each Additional supporting document (BG-24) shall contain a Supporting document reference (BT-122).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Additional supporting document (BG-24) shall contain a Supporting document reference (BT-122).”

### BR-53 — If the VAT accounting currency code (BT-6) is present, then the Invoice total VAT amount in accounting currency (BT-111) shall be provided.

- **Requires:** If the VAT accounting currency code (BT-6) is present, then the Invoice total VAT amount in accounting currency (BT-111) shall be provided.
- **Business terms:** BT-6, BT-111
- **Location:** `cbc:TaxCurrencyCode`
- **Fix:** Add the required element at `cbc:TaxCurrencyCode`: If the VAT accounting currency code (BT-6) is present, then the Invoice total VAT amount in accounting currency (BT-111) shall be provided.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “If the VAT accounting currency code (BT-6) is present, then the Invoice total VAT amount in accounting currency (BT-111) shall be provided.”

### BR-54 — Each Item attribute (BG-32) shall contain an Item attribute name (BT-160) and an Item attribute value (BT-161).

- **Requires:** Each Item attribute (BG-32) shall contain an Item attribute name (BT-160) and an Item attribute value (BT-161).
- **Business terms:** BG-32, BT-160, BT-161
- **Location:** `//cac:AdditionalItemProperty`
- **Fix:** Add the required element at `//cac:AdditionalItemProperty`: Each Item attribute (BG-32) shall contain an Item attribute name (BT-160) and an Item attribute value (BT-161).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Item attribute (BG-32) shall contain an Item attribute name (BT-160) and an Item attribute value (BT-161).”

### BR-55 — Each Preceding Invoice reference (BG-3) shall contain a Preceding Invoice reference (BT-25).

- **Requires:** Each Preceding Invoice reference (BG-3) shall contain a Preceding Invoice reference (BT-25).
- **Business terms:** BG-3, BT-25
- **Location:** `cac:BillingReference`
- **Fix:** Add the required element at `cac:BillingReference`: Each Preceding Invoice reference (BG-3) shall contain a Preceding Invoice reference (BT-25).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Preceding Invoice reference (BG-3) shall contain a Preceding Invoice reference (BT-25).”

### BR-56 — Each Seller tax representative party (BG-11) shall have a Seller tax representative VAT identifier (BT-63).

- **Requires:** Each Seller tax representative party (BG-11) shall have a Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-11, BT-63
- **Location:** `cac:TaxRepresentativeParty`
- **Fix:** Correct `cac:TaxRepresentativeParty` so that Each Seller tax representative party (BG-11) shall have a Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Seller tax representative party (BG-11) shall have a Seller tax representative VAT identifier (BT-63).”

### BR-57 — Each Deliver to address (BG-15) shall contain a Deliver to country code (BT-80).

- **Requires:** Each Deliver to address (BG-15) shall contain a Deliver to country code (BT-80).
- **Business terms:** BG-15, BT-80
- **Location:** `cac:Delivery/cac:DeliveryLocation/cac:Address`
- **Fix:** Add the required element at `cac:Delivery/cac:DeliveryLocation/cac:Address`: Each Deliver to address (BG-15) shall contain a Deliver to country code (BT-80).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Deliver to address (BG-15) shall contain a Deliver to country code (BT-80).”

### BR-61 — If the Payment means type code (BT-81) means SEPA credit transfer, Local credit transfer or Non-SEPA international credit transfer, the Payment account identifier (BT-84) shall be present.

- **Requires:** If the Payment means type code (BT-81) means SEPA credit transfer, Local credit transfer or Non-SEPA international credit transfer, the Payment account identifier (BT-84) shall be present.
- **Business terms:** BT-81, BT-84
- **Location:** `cac:PaymentMeans`
- **Fix:** Add the required element at `cac:PaymentMeans`: If the Payment means type code (BT-81) means SEPA credit transfer, Local credit transfer or Non-SEPA international credit transfer, the Payment account identifier (BT-84) shall be present.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “If the Payment means type code (BT-81) means SEPA credit transfer, Local credit transfer or Non-SEPA international credit transfer, the Payment account identifier (BT-84) shall be present.”

### BR-62 — The Seller electronic address (BT-34) shall have a Scheme identifier.

- **Requires:** The Seller electronic address (BT-34) shall have a Scheme identifier.
- **Business terms:** BT-34
- **Location:** `cac:AccountingSupplierParty/cac:Party/cbc:EndpointID`
- **Fix:** Add the required element at `cac:AccountingSupplierParty/cac:Party/cbc:EndpointID`: The Seller electronic address (BT-34) shall have a Scheme identifier.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The Seller electronic address (BT-34) shall have a Scheme identifier.”

### BR-63 — The Buyer electronic address (BT-49) shall have a Scheme identifier.

- **Requires:** The Buyer electronic address (BT-49) shall have a Scheme identifier.
- **Business terms:** BT-49
- **Location:** `cac:AccountingCustomerParty/cac:Party/cbc:EndpointID`
- **Fix:** Add the required element at `cac:AccountingCustomerParty/cac:Party/cbc:EndpointID`: The Buyer electronic address (BT-49) shall have a Scheme identifier.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The Buyer electronic address (BT-49) shall have a Scheme identifier.”

### BR-64 — The Item standard identifier (BT-157) shall have a Scheme identifier.

- **Requires:** The Item standard identifier (BT-157) shall have a Scheme identifier.
- **Business terms:** BT-157
- **Location:** `cac:InvoiceLine/cac:Item/cac:StandardItemIdentification/cbc:ID`
- **Fix:** Add the required element at `cac:InvoiceLine/cac:Item/cac:StandardItemIdentification/cbc:ID`: The Item standard identifier (BT-157) shall have a Scheme identifier.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The Item standard identifier (BT-157) shall have a Scheme identifier.”

### BR-65 — The Item classification identifier (BT-158) shall have a Scheme identifier.

- **Requires:** The Item classification identifier (BT-158) shall have a Scheme identifier.
- **Business terms:** BT-158
- **Location:** `cac:InvoiceLine/cac:Item/cac:CommodityClassification/cbc:ItemClassificationCode`
- **Fix:** Add the required element at `cac:InvoiceLine/cac:Item/cac:CommodityClassification/cbc:ItemClassificationCode`: The Item classification identifier (BT-158) shall have a Scheme identifier.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The Item classification identifier (BT-158) shall have a Scheme identifier.”

## BR-CL

Code-list rules — a coded value must come from the referenced official code list.

### BR-CL-01 — The document type code (BT-3) MUST be coded per UNTDID 1001.

- **Requires:** The document type code MUST be coded by the invoice and credit note related code lists of UNTDID 1001.
- **Business terms:** BT-3
- **Location:** `cbc:InvoiceTypeCode`
- **Fix:** Encode `cbc:InvoiceTypeCode` using a valid value from the required code list.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The document type code MUST be coded by the invoice and credit note related code lists of UNTDID 1001.”

### BR-CL-03 — CurrencyID MUST be coded using ISO 4217 alpha-3.

- **Requires:** currencyID MUST be coded using ISO code list 4217 alpha-3
- **Business terms:** — (no single business term)
- **Location:** `cbc:Amount`
- **Fix:** Encode `cbc:Amount` using a valid value from ISO code list 4217 alpha-3.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “currencyID MUST be coded using ISO code list 4217 alpha-3”

### BR-CL-04 — Invoice currency code (BT-5) MUST be coded using ISO 4217 alpha-3.

- **Requires:** Invoice currency code MUST be coded using ISO code list 4217 alpha-3
- **Business terms:** BT-5
- **Location:** `cbc:DocumentCurrencyCode`
- **Fix:** Encode `cbc:DocumentCurrencyCode` using a valid value from ISO code list 4217 alpha-3.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Invoice currency code MUST be coded using ISO code list 4217 alpha-3”

### BR-CL-05 — Tax currency code (BT-6) MUST be coded using ISO 4217 alpha-3.

- **Requires:** Tax currency code MUST be coded using ISO code list 4217 alpha-3
- **Business terms:** BT-6
- **Location:** `cbc:TaxCurrencyCode`
- **Fix:** Encode `cbc:TaxCurrencyCode` using a valid value from ISO code list 4217 alpha-3.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Tax currency code MUST be coded using ISO code list 4217 alpha-3”

### BR-CL-13 — Item classification scheme identifier MUST be a UNTDID 7143 code.

- **Requires:** Item classification identifier identification scheme identifier MUST be coded using one of the UNTDID 7143 list.
- **Business terms:** — (no single business term)
- **Location:** `cac:CommodityClassification/cbc:ItemClassificationCode[@listID]`
- **Fix:** Encode `cac:CommodityClassification/cbc:ItemClassificationCode[@listID]` using a valid value from the required code list.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Item classification identifier identification scheme identifier MUST be coded using one of the UNTDID 7143 list.”

### BR-CL-14 — Country codes MUST be coded using ISO 3166-1 alpha-2.

- **Requires:** Country codes in an invoice MUST be coded using ISO code list 3166-1
- **Business terms:** — (no single business term)
- **Location:** `cac:Country/cbc:IdentificationCode`
- **Fix:** Encode `cac:Country/cbc:IdentificationCode` using a valid value from ISO code list 3166-1.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Country codes in an invoice MUST be coded using ISO code list 3166-1”

### BR-CL-16 — Payment means MUST be coded using the UNCL 4461 code list.

- **Requires:** Payment means in an invoice MUST be coded using UNCL4461 code list
- **Business terms:** — (no single business term)
- **Location:** `cac:PaymentMeans/cbc:PaymentMeansCode`
- **Fix:** Encode `cac:PaymentMeans/cbc:PaymentMeansCode` using a valid value from UNCL4461 code list.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Payment means in an invoice MUST be coded using UNCL4461 code list”

### BR-CL-17 — Invoice tax categories MUST be coded using the UNCL 5305 subset.

- **Requires:** Invoice tax categories MUST be coded using UNCL5305 code list
- **Business terms:** — (no single business term)
- **Location:** `cac:TaxCategory/cbc:ID`
- **Fix:** Encode `cac:TaxCategory/cbc:ID` using a valid value from UNCL5305 code list.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Invoice tax categories MUST be coded using UNCL5305 code list”

### BR-CL-18 — Invoice tax categories MUST be coded using the UNCL 5305 subset.

- **Requires:** Invoice tax categories MUST be coded using UNCL5305 code list
- **Business terms:** — (no single business term)
- **Location:** `cac:ClassifiedTaxCategory/cbc:ID`
- **Fix:** Encode `cac:ClassifiedTaxCategory/cbc:ID` using a valid value from UNCL5305 code list.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Invoice tax categories MUST be coded using UNCL5305 code list”

### BR-CL-19 — Coded allowance reasons MUST belong to the UNCL 5189 code list.

- **Requires:** Coded allowance reasons MUST belong to the UNCL 5189 code list
- **Business terms:** — (no single business term)
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator = false()]/cbc:AllowanceChargeReasonCode`
- **Fix:** Encode `cac:AllowanceCharge[cbc:ChargeIndicator = false()]/cbc:AllowanceChargeReasonCode` using a valid value from UNCL 5189 code list.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Coded allowance reasons MUST belong to the UNCL 5189 code list”

### BR-CL-20 — Coded charge reasons MUST belong to the UNCL 7161 code list.

- **Requires:** Coded charge reasons MUST belong to the UNCL 7161 code list
- **Business terms:** — (no single business term)
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator = true()]/cbc:AllowanceChargeReasonCode`
- **Fix:** Encode `cac:AllowanceCharge[cbc:ChargeIndicator = true()]/cbc:AllowanceChargeReasonCode` using a valid value from UNCL 7161 code list.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Coded charge reasons MUST belong to the UNCL 7161 code list”

### BR-CL-21 — Item standard identifier scheme MUST be an ISO 6523 ICD code.

- **Requires:** Item standard identifier scheme identifier MUST belong to the ISO 6523 ICD code list
- **Business terms:** — (no single business term)
- **Location:** `cac:StandardItemIdentification/cbc:ID[@schemeID]`
- **Fix:** Encode `cac:StandardItemIdentification/cbc:ID[@schemeID]` using a valid value from ISO 6523 ICD code list.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Item standard identifier scheme identifier MUST belong to the ISO 6523 ICD code list”

### BR-CL-22 — VAT exemption reason code MUST belong to the CEF VATEX list.

- **Requires:** Tax exemption reason code identifier scheme identifier MUST belong to the CEF VATEX code list
- **Business terms:** — (no single business term)
- **Location:** `cbc:TaxExemptionReasonCode`
- **Fix:** Encode `cbc:TaxExemptionReasonCode` using a valid value from CEF VATEX code list.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Tax exemption reason code identifier scheme identifier MUST belong to the CEF VATEX code list”

### BR-CL-23 — Unit code MUST be coded per UN/ECE Rec 20 with Rec 21 extension.

- **Requires:** Unit code MUST be coded according to the UN/ECE Recommendation 20 with Rec 21 extension
- **Business terms:** — (no single business term)
- **Location:** `cbc:InvoicedQuantity[@unitCode]`
- **Fix:** Encode `cbc:InvoicedQuantity[@unitCode]` using a valid value from UN/ECE Recommendation 20 with Rec 21 extension.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Unit code MUST be coded according to the UN/ECE Recommendation 20 with Rec 21 extension”

### BR-CL-24 — For a MIME code in an attribute use the MIMEMediaType subset.

- **Requires:** For Mime code in attribute use MIMEMediaType.
- **Business terms:** — (no single business term)
- **Location:** `cbc:EmbeddedDocumentBinaryObject[@mimeCode]`
- **Fix:** Encode `cbc:EmbeddedDocumentBinaryObject[@mimeCode]` using a valid value from Mime code in attribute use MIMEMediaType..
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “For Mime code in attribute use MIMEMediaType.”

## BR-CO

Calculation and consistency rules (cross-total arithmetic).

### BR-CO-03 — Value added tax point date (BT-7) and Value added tax point date code (BT-8) are mutually exclusive.

- **Requires:** Value added tax point date (BT-7) and Value added tax point date code (BT-8) are mutually exclusive.
- **Business terms:** BT-7, BT-8
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Add the required element at `cac:LegalMonetaryTotal`: Value added tax point date (BT-7) and Value added tax point date code (BT-8) are mutually exclusive.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Value added tax point date (BT-7) and Value added tax point date code (BT-8) are mutually exclusive.”

### BR-CO-04 — Each Invoice line (BG-25) shall be categorized with an Invoiced item VAT category code (BT-151).

- **Requires:** Each Invoice line (BG-25) shall be categorized with an Invoiced item VAT category code (BT-151).
- **Business terms:** BG-25, BT-151
- **Location:** `cac:InvoiceLine`
- **Fix:** Correct `cac:InvoiceLine` so that Each Invoice line (BG-25) shall be categorized with an Invoiced item VAT category code (BT-151).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Invoice line (BG-25) shall be categorized with an Invoiced item VAT category code (BT-151).”

### BR-CO-09 — The Seller VAT identifier (BT-31), the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48) shall have a prefix in accordance with ISO code ISO 3166-1 alpha-2 by which the country of issue may be identified. Nevertheless, Greece may use the prefix 'EL'.

- **Requires:** The Seller VAT identifier (BT-31), the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48) shall have a prefix in accordance with ISO code ISO 3166-1 alpha-2 by which the country of issue may be identified. Nevertheless, Greece may use the prefix ‘EL’.
- **Business terms:** BT-31, BT-48, BT-63
- **Location:** `//cac:PartyTaxScheme[cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Add the required element at `//cac:PartyTaxScheme[cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`: The Seller VAT identifier (BT-31), the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48) shall have a prefix in accordance with ISO code ISO 3166-1 alpha-2 by which the country of issue may be identified. Nevertheless, Greece may use the prefix ‘EL’.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The Seller VAT identifier (BT-31), the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48) shall have a prefix in accordance with ISO code ISO 3166-1 alpha-2 by which the country of issue may be identified. Nevertheless, Greece may use the prefix ‘EL’.”

### BR-CO-10 — Sum of Invoice line net amount (BT-106) = Σ line net amount (BT-131).

- **Requires:** Sum of Invoice line net amount (BT-106) = Σ Invoice line net amount (BT-131).
- **Business terms:** BT-106, BT-131
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Correct the calculated amount at `cac:LegalMonetaryTotal` so that Sum of Invoice line net amount (BT-106) = Σ Invoice line net amount (BT-131).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Sum of Invoice line net amount (BT-106) = Σ Invoice line net amount (BT-131).”

### BR-CO-11 — Sum of allowances on document level (BT-107) = Σ Document level allowance amount (BT-92).

- **Requires:** Sum of allowances on document level (BT-107) = Σ Document level allowance amount (BT-92).
- **Business terms:** BT-92, BT-107
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Correct the calculated amount at `cac:LegalMonetaryTotal` so that Sum of allowances on document level (BT-107) = Σ Document level allowance amount (BT-92).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Sum of allowances on document level (BT-107) = Σ Document level allowance amount (BT-92).”

### BR-CO-12 — Sum of charges on document level (BT-108) = Σ Document level charge amount (BT-99).

- **Requires:** Sum of charges on document level (BT-108) = Σ Document level charge amount (BT-99).
- **Business terms:** BT-99, BT-108
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Correct the calculated amount at `cac:LegalMonetaryTotal` so that Sum of charges on document level (BT-108) = Σ Document level charge amount (BT-99).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Sum of charges on document level (BT-108) = Σ Document level charge amount (BT-99).”

### BR-CO-13 — Invoice total without VAT (BT-109) = Σ line net (BT-131) − document allowances (BT-107) + document charges (BT-108).

- **Requires:** Invoice total amount without VAT (BT-109) = Σ Invoice line net amount (BT-131) - Sum of allowances on document level (BT-107) + Sum of charges on document level (BT-108).
- **Business terms:** BT-107, BT-108, BT-109, BT-131
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Correct the calculated amount at `cac:LegalMonetaryTotal` so that Invoice total amount without VAT (BT-109) = Σ Invoice line net amount (BT-131) - Sum of allowances on document level (BT-107) + Sum of charges on document level (BT-108).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Invoice total amount without VAT (BT-109) = Σ Invoice line net amount (BT-131) - Sum of allowances on document level (BT-107) + Sum of charges on document level (BT-108).”

### BR-CO-14 — Invoice total VAT amount (BT-110) = Σ VAT category tax amount (BT-117).

- **Requires:** Invoice total VAT amount (BT-110) = Σ VAT category tax amount (BT-117).
- **Business terms:** BT-110, BT-117
- **Location:** `/ubl:Invoice/cac:TaxTotal`
- **Fix:** Correct the calculated amount at `/ubl:Invoice/cac:TaxTotal` so that Invoice total VAT amount (BT-110) = Σ VAT category tax amount (BT-117).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Invoice total VAT amount (BT-110) = Σ VAT category tax amount (BT-117).”

### BR-CO-15 — Invoice total with VAT (BT-112) = total without VAT (BT-109) + total VAT (BT-110).

- **Requires:** Invoice total amount with VAT (BT-112) = Invoice total amount without VAT (BT-109) + Invoice total VAT amount (BT-110).
- **Business terms:** BT-109, BT-110, BT-112
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Correct the calculated amount at `cac:LegalMonetaryTotal` so that Invoice total amount with VAT (BT-112) = Invoice total amount without VAT (BT-109) + Invoice total VAT amount (BT-110).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Invoice total amount with VAT (BT-112) = Invoice total amount without VAT (BT-109) + Invoice total VAT amount (BT-110).”

### BR-CO-16 — Amount due for payment (BT-115) = Invoice total with VAT (BT-112) − Paid amount (BT-113) + Rounding amount (BT-114).

- **Requires:** Amount due for payment (BT-115) = Invoice total amount with VAT (BT-112) -Paid amount (BT-113) +Rounding amount (BT-114).
- **Business terms:** BT-112, BT-113, BT-114, BT-115
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Correct the calculated amount at `cac:LegalMonetaryTotal` so that Amount due for payment (BT-115) = Invoice total amount with VAT (BT-112) -Paid amount (BT-113) +Rounding amount (BT-114).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Amount due for payment (BT-115) = Invoice total amount with VAT (BT-112) -Paid amount (BT-113) +Rounding amount (BT-114).”

### BR-CO-17 — VAT category tax amount (BT-117) = VAT category taxable amount (BT-116) x (VAT category rate (BT-119) / 100), rounded to two decimals.

- **Requires:** VAT category tax amount (BT-117) = VAT category taxable amount (BT-116) x (VAT category rate (BT-119) / 100), rounded to two decimals.
- **Business terms:** BT-116, BT-117, BT-119
- **Location:** `cac:TaxTotal/cac:TaxSubtotal`
- **Fix:** Correct the calculated amount at `cac:TaxTotal/cac:TaxSubtotal` so that VAT category tax amount (BT-117) = VAT category taxable amount (BT-116) x (VAT category rate (BT-119) / 100), rounded to two decimals.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “VAT category tax amount (BT-117) = VAT category taxable amount (BT-116) x (VAT category rate (BT-119) / 100), rounded to two decimals.”

### BR-CO-18 — An Invoice shall at least have one VAT breakdown group (BG-23).

- **Requires:** An Invoice shall at least have one VAT breakdown group (BG-23).
- **Business terms:** BG-23
- **Location:** `cac:TaxTotal/cac:TaxSubtotal`
- **Fix:** Add the required element at `cac:TaxTotal/cac:TaxSubtotal`: An Invoice shall at least have one VAT breakdown group (BG-23).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice shall at least have one VAT breakdown group (BG-23).”

### BR-CO-19 — If Invoicing period (BG-14) is used, the Invoicing period start date (BT-73) or the Invoicing period end date (BT-74) shall be filled, or both.

- **Requires:** If Invoicing period (BG-14) is used, the Invoicing period start date (BT-73) or the Invoicing period end date (BT-74) shall be filled, or both.
- **Business terms:** BG-14, BT-73, BT-74
- **Location:** `cac:InvoicePeriod`
- **Fix:** Add the required element at `cac:InvoicePeriod`: If Invoicing period (BG-14) is used, the Invoicing period start date (BT-73) or the Invoicing period end date (BT-74) shall be filled, or both.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “If Invoicing period (BG-14) is used, the Invoicing period start date (BT-73) or the Invoicing period end date (BT-74) shall be filled, or both.”

### BR-CO-20 — If Invoice line period (BG-26) is used, the Invoice line period start date (BT-134) or the Invoice line period end date (BT-135) shall be filled, or both.

- **Requires:** If Invoice line period (BG-26) is used, the Invoice line period start date (BT-134) or the Invoice line period end date (BT-135) shall be filled, or both.
- **Business terms:** BG-26, BT-134, BT-135
- **Location:** `cac:InvoiceLine/cac:InvoicePeriod`
- **Fix:** Add the required element at `cac:InvoiceLine/cac:InvoicePeriod`: If Invoice line period (BG-26) is used, the Invoice line period start date (BT-134) or the Invoice line period end date (BT-135) shall be filled, or both.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “If Invoice line period (BG-26) is used, the Invoice line period start date (BT-134) or the Invoice line period end date (BT-135) shall be filled, or both.”

### BR-CO-21 — Each Document level allowance (BG-20) shall contain a Document level allowance reason (BT-97) or a Document level allowance reason code (BT-98), or both.

- **Requires:** Each Document level allowance (BG-20) shall contain a Document level allowance reason (BT-97) or a Document level allowance reason code (BT-98), or both.
- **Business terms:** BG-20, BT-97, BT-98
- **Location:** `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`: Each Document level allowance (BG-20) shall contain a Document level allowance reason (BT-97) or a Document level allowance reason code (BT-98), or both.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Document level allowance (BG-20) shall contain a Document level allowance reason (BT-97) or a Document level allowance reason code (BT-98), or both.”

### BR-CO-22 — Each Document level charge (BG-21) shall contain a Document level charge reason (BT-104) or a Document level charge reason code (BT-105), or both.

- **Requires:** Each Document level charge (BG-21) shall contain a Document level charge reason (BT-104) or a Document level charge reason code (BT-105), or both.
- **Business terms:** BG-21, BT-104, BT-105
- **Location:** `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`: Each Document level charge (BG-21) shall contain a Document level charge reason (BT-104) or a Document level charge reason code (BT-105), or both.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Document level charge (BG-21) shall contain a Document level charge reason (BT-104) or a Document level charge reason code (BT-105), or both.”

### BR-CO-23 — Each Invoice line allowance (BG-27) shall contain an Invoice line allowance reason (BT-139) or an Invoice line allowance reason code (BT-140), or both.

- **Requires:** Each Invoice line allowance (BG-27) shall contain an Invoice line allowance reason (BT-139) or an Invoice line allowance reason code (BT-140), or both.
- **Business terms:** BG-27, BT-139, BT-140
- **Location:** `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`
- **Fix:** Add the required element at `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`: Each Invoice line allowance (BG-27) shall contain an Invoice line allowance reason (BT-139) or an Invoice line allowance reason code (BT-140), or both.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Invoice line allowance (BG-27) shall contain an Invoice line allowance reason (BT-139) or an Invoice line allowance reason code (BT-140), or both.”

### BR-CO-24 — Each Invoice line charge (BG-28) shall contain an Invoice line charge reason (BT-144) or an Invoice line charge reason code (BT-145), or both.

- **Requires:** Each Invoice line charge (BG-28) shall contain an Invoice line charge reason (BT-144) or an Invoice line charge reason code (BT-145), or both.
- **Business terms:** BG-28, BT-144, BT-145
- **Location:** `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`
- **Fix:** Add the required element at `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`: Each Invoice line charge (BG-28) shall contain an Invoice line charge reason (BT-144) or an Invoice line charge reason code (BT-145), or both.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “Each Invoice line charge (BG-28) shall contain an Invoice line charge reason (BT-144) or an Invoice line charge reason code (BT-145), or both.”

### BR-CO-26 — In order for the buyer to automatically identify a supplier, the Seller identifier (BT-29), the Seller legal registration identifier (BT-30) and/or the Seller VAT identifier (BT-31) shall be present.

- **Requires:** In order for the buyer to automatically identify a supplier, the Seller identifier (BT-29), the Seller legal registration identifier (BT-30) and/or the Seller VAT identifier (BT-31) shall be present.
- **Business terms:** BT-29, BT-30, BT-31
- **Location:** `cac:AccountingSupplierParty`
- **Fix:** Correct `cac:AccountingSupplierParty` so that In order for the buyer to automatically identify a supplier, the Seller identifier (BT-29), the Seller legal registration identifier (BT-30) and/or the Seller VAT identifier (BT-31) shall be present.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In order for the buyer to automatically identify a supplier, the Seller identifier (BT-29), the Seller legal registration identifier (BT-30) and/or the Seller VAT identifier (BT-31) shall be present.”

## BR-DEC

Decimal-places rules — amounts must not exceed the allowed number of decimals.

### BR-DEC-01 — Max 2 decimals for the Document level allowance amount (BT-92).

- **Requires:** The allowed maximum number of decimals for the Document level allowance amount (BT-92) is 2.
- **Business terms:** BT-92
- **Location:** `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`
- **Fix:** Round the value at `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = false()]` to the allowed number of decimals: The allowed maximum number of decimals for the Document level allowance amount (BT-92) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Document level allowance amount (BT-92) is 2.”

### BR-DEC-02 — Max 2 decimals for the Document level allowance base amount (BT-93).

- **Requires:** The allowed maximum number of decimals for the Document level allowance base amount (BT-93) is 2.
- **Business terms:** BT-93
- **Location:** `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`
- **Fix:** Round the value at `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = false()]` to the allowed number of decimals: The allowed maximum number of decimals for the Document level allowance base amount (BT-93) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Document level allowance base amount (BT-93) is 2.”

### BR-DEC-05 — Max 2 decimals for the Document level charge amount (BT-99).

- **Requires:** The allowed maximum number of decimals for the Document level charge amount (BT-99) is 2.
- **Business terms:** BT-99
- **Location:** `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`
- **Fix:** Round the value at `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = true()]` to the allowed number of decimals: The allowed maximum number of decimals for the Document level charge amount (BT-99) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Document level charge amount (BT-99) is 2.”

### BR-DEC-06 — Max 2 decimals for the Document level charge base amount (BT-100).

- **Requires:** The allowed maximum number of decimals for the Document level charge base amount (BT-100) is 2.
- **Business terms:** BT-100
- **Location:** `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`
- **Fix:** Round the value at `/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = true()]` to the allowed number of decimals: The allowed maximum number of decimals for the Document level charge base amount (BT-100) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Document level charge base amount (BT-100) is 2.”

### BR-DEC-09 — Max 2 decimals for the Sum of Invoice line net amount (BT-106).

- **Requires:** The allowed maximum number of decimals for the Sum of Invoice line net amount (BT-106) is 2.
- **Business terms:** BT-106
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Round the value at `cac:LegalMonetaryTotal` to the allowed number of decimals: The allowed maximum number of decimals for the Sum of Invoice line net amount (BT-106) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Sum of Invoice line net amount (BT-106) is 2.”

### BR-DEC-10 — Max 2 decimals for the Sum of allowances on document level (BT-107).

- **Requires:** The allowed maximum number of decimals for the Sum of allowanced on document level (BT-107) is 2.
- **Business terms:** BT-107
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Round the value at `cac:LegalMonetaryTotal` to the allowed number of decimals: The allowed maximum number of decimals for the Sum of allowanced on document level (BT-107) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Sum of allowanced on document level (BT-107) is 2.”

### BR-DEC-11 — Max 2 decimals for the Sum of charges on document level (BT-108).

- **Requires:** The allowed maximum number of decimals for the Sum of charges on document level (BT-108) is 2.
- **Business terms:** BT-108
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Round the value at `cac:LegalMonetaryTotal` to the allowed number of decimals: The allowed maximum number of decimals for the Sum of charges on document level (BT-108) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Sum of charges on document level (BT-108) is 2.”

### BR-DEC-12 — Max 2 decimals for the Invoice total amount without VAT (BT-109).

- **Requires:** The allowed maximum number of decimals for the Invoice total amount without VAT (BT-109) is 2.
- **Business terms:** BT-109
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Round the value at `cac:LegalMonetaryTotal` to the allowed number of decimals: The allowed maximum number of decimals for the Invoice total amount without VAT (BT-109) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Invoice total amount without VAT (BT-109) is 2.”

### BR-DEC-14 — Max 2 decimals for the Invoice total amount with VAT (BT-112).

- **Requires:** The allowed maximum number of decimals for the Invoice total amount with VAT (BT-112) is 2.
- **Business terms:** BT-112
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Round the value at `cac:LegalMonetaryTotal` to the allowed number of decimals: The allowed maximum number of decimals for the Invoice total amount with VAT (BT-112) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Invoice total amount with VAT (BT-112) is 2.”

### BR-DEC-16 — Max 2 decimals for the Paid amount (BT-113).

- **Requires:** The allowed maximum number of decimals for the Paid amount (BT-113) is 2.
- **Business terms:** BT-113
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Round the value at `cac:LegalMonetaryTotal` to the allowed number of decimals: The allowed maximum number of decimals for the Paid amount (BT-113) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Paid amount (BT-113) is 2.”

### BR-DEC-17 — Max 2 decimals for the Rounding amount (BT-114).

- **Requires:** The allowed maximum number of decimals for the Rounding amount (BT-114) is 2.
- **Business terms:** BT-114
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Round the value at `cac:LegalMonetaryTotal` to the allowed number of decimals: The allowed maximum number of decimals for the Rounding amount (BT-114) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Rounding amount (BT-114) is 2.”

### BR-DEC-18 — Max 2 decimals for the Amount due for payment (BT-115).

- **Requires:** The allowed maximum number of decimals for the Amount due for payment (BT-115) is 2.
- **Business terms:** BT-115
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Round the value at `cac:LegalMonetaryTotal` to the allowed number of decimals: The allowed maximum number of decimals for the Amount due for payment (BT-115) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Amount due for payment (BT-115) is 2.”

### BR-DEC-19 — Max 2 decimals for the VAT category taxable amount (BT-116).

- **Requires:** The allowed maximum number of decimals for the VAT category taxable amount (BT-116) is 2.
- **Business terms:** BT-116
- **Location:** `cac:TaxTotal/cac:TaxSubtotal`
- **Fix:** Round the value at `cac:TaxTotal/cac:TaxSubtotal` to the allowed number of decimals: The allowed maximum number of decimals for the VAT category taxable amount (BT-116) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the VAT category taxable amount (BT-116) is 2.”

### BR-DEC-20 — Max 2 decimals for the VAT category tax amount (BT-117).

- **Requires:** The allowed maximum number of decimals for the VAT category tax amount (BT-117) is 2.
- **Business terms:** BT-117
- **Location:** `cac:TaxTotal/cac:TaxSubtotal`
- **Fix:** Round the value at `cac:TaxTotal/cac:TaxSubtotal` to the allowed number of decimals: The allowed maximum number of decimals for the VAT category tax amount (BT-117) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the VAT category tax amount (BT-117) is 2.”

### BR-DEC-23 — Max 2 decimals for the Invoice line net amount (BT-131).

- **Requires:** The allowed maximum number of decimals for the Invoice line net amount (BT-131) is 2.
- **Business terms:** BT-131
- **Location:** `cac:InvoiceLine`
- **Fix:** Round the value at `cac:InvoiceLine` to the allowed number of decimals: The allowed maximum number of decimals for the Invoice line net amount (BT-131) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Invoice line net amount (BT-131) is 2.”

### BR-DEC-24 — Max 2 decimals for the Invoice line allowance amount (BT-136).

- **Requires:** The allowed maximum number of decimals for the Invoice line allowance amount (BT-136) is 2.
- **Business terms:** BT-136
- **Location:** `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`
- **Fix:** Round the value at `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = false()]` to the allowed number of decimals: The allowed maximum number of decimals for the Invoice line allowance amount (BT-136) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Invoice line allowance amount (BT-136) is 2.”

### BR-DEC-25 — Max 2 decimals for the Invoice line allowance base amount (BT-137). Same line-level allowance context as BR-DEC-24, over ``cbc:BaseAmount`` (UBL) / ``../ram:BasisAmount`` (CII).

- **Requires:** The allowed maximum number of decimals for the Invoice line allowance base amount (BT-137) is 2.
- **Business terms:** BT-137
- **Location:** `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = false()]`
- **Fix:** Round the value at `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = false()]` to the allowed number of decimals: The allowed maximum number of decimals for the Invoice line allowance base amount (BT-137) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Invoice line allowance base amount (BT-137) is 2.”

### BR-DEC-27 — Max 2 decimals for the Invoice line charge amount (BT-141). The charge twin of BR-DEC-24 (ChargeIndicator true() / 'true').

- **Requires:** The allowed maximum number of decimals for the Invoice line charge amount (BT-141) is 2.
- **Business terms:** BT-141
- **Location:** `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`
- **Fix:** Round the value at `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = true()]` to the allowed number of decimals: The allowed maximum number of decimals for the Invoice line charge amount (BT-141) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Invoice line charge amount (BT-141) is 2.”

### BR-DEC-28 — Max 2 decimals for the Invoice line charge base amount (BT-142). The charge twin of BR-DEC-25.

- **Requires:** The allowed maximum number of decimals for the Invoice line charge base amount (BT-142) is 2.
- **Business terms:** BT-142
- **Location:** `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = true()]`
- **Fix:** Round the value at `//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator = true()]` to the allowed number of decimals: The allowed maximum number of decimals for the Invoice line charge base amount (BT-142) is 2.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “The allowed maximum number of decimals for the Invoice line charge base amount (BT-142) is 2.”

## BR-AE

VAT breakdown rules for VAT category code AE.

### BR-AE-01 — 'Reverse charge' (AE) items require exactly one AE VAT breakdown (BG-23) row.

- **Requires:** An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Reverse charge" shall contain in the VAT Breakdown (BG-23) exactly one VAT category code (BT-118) equal with "VAT reverse charge".
- **Business terms:** BG-20, BG-21, BG-23, BG-25, BT-95, BT-102, BT-118, BT-151
- **Location:** `cac:TaxCategory`
- **Fix:** Adjust the VAT breakdown at `cac:TaxCategory` so that An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Reverse charge" shall contain in the VAT Breakdown (BG-23) exactly one VAT category code (BT-118) equal with "VAT reverse charge".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Reverse charge" shall contain in the VAT Breakdown (BG-23) exactly one VAT category code (BT-118) equal with "VAT reverse charge".”

### BR-AE-02 — An Invoice with a Reverse charge (AE) Invoice line (BT-151) shall carry a Seller identifier AND a Buyer identifier.

- **Requires:** An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Reverse charge" shall contain the Seller VAT Identifier (BT-31), the Seller Tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48) and/or the Buyer legal registration identifier (BT-47).
- **Business terms:** BG-25, BT-31, BT-32, BT-47, BT-48, BT-63, BT-151
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='AE']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='AE']` so that An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Reverse charge" shall contain the Seller VAT Identifier (BT-31), the Seller Tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48) and/or the Buyer legal registration identifier (BT-47).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Reverse charge" shall contain the Seller VAT Identifier (BT-31), the Seller Tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48) and/or the Buyer legal registration identifier (BT-47).”

### BR-AE-03 — An Invoice with a Reverse charge (AE) Document level allowance (BT-95) shall carry a Seller identifier AND a Buyer identifier.

- **Requires:** An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Reverse charge" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48) and/or the Buyer legal registration identifier (BT-47).
- **Business terms:** BG-20, BT-31, BT-32, BT-47, BT-48, BT-63, BT-95
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='AE']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='AE']` so that An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Reverse charge" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48) and/or the Buyer legal registration identifier (BT-47).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Reverse charge" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48) and/or the Buyer legal registration identifier (BT-47).”

### BR-AE-04 — An Invoice with a Reverse charge (AE) Document level charge (BT-102) shall carry a Seller identifier AND a Buyer identifier.

- **Requires:** An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Reverse charge" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48) and/or the Buyer legal registration identifier (BT-47).
- **Business terms:** BG-21, BT-31, BT-32, BT-47, BT-48, BT-63, BT-102
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='AE']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='AE']` so that An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Reverse charge" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48) and/or the Buyer legal registration identifier (BT-47).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Reverse charge" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48) and/or the Buyer legal registration identifier (BT-47).”

### BR-AE-05 — In a Reverse charge (AE) Invoice line the Invoiced item VAT rate (BT-152) shall be 0.

- **Requires:** In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Reverse charge" the Invoiced item VAT rate (BT-152) shall be 0 (zero).
- **Business terms:** BG-25, BT-151, BT-152
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'AE'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'AE'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Reverse charge" the Invoiced item VAT rate (BT-152) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Reverse charge" the Invoiced item VAT rate (BT-152) shall be 0 (zero).”

### BR-AE-06 — In a Reverse charge (AE) Document level allowance the allowance VAT rate (BT-96) shall be 0.

- **Requires:** In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Reverse charge" the Document level allowance VAT rate (BT-96) shall be 0 (zero).
- **Business terms:** BG-20, BT-95, BT-96
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='AE'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='AE'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Reverse charge" the Document level allowance VAT rate (BT-96) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Reverse charge" the Document level allowance VAT rate (BT-96) shall be 0 (zero).”

### BR-AE-07 — In a Reverse charge (AE) Document level charge the charge VAT rate (BT-103) shall be 0.

- **Requires:** In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Reverse charge" the Document level charge VAT rate (BT-103) shall be 0 (zero).
- **Business terms:** BG-21, BT-102, BT-103
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='AE'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='AE'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Reverse charge" the Document level charge VAT rate (BT-103) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Reverse charge" the Document level charge VAT rate (BT-103) shall be 0 (zero).”

### BR-AE-08 — The Reverse charge (AE) VAT breakdown taxable amount (BT-116) shall equal the exact sum of AE line nets − AE allowances + AE charges.

- **Requires:** In a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Reverse charge" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Reverse charge".
- **Business terms:** BG-23, BT-92, BT-95, BT-99, BT-102, BT-116, BT-118, BT-131, BT-151
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'AE'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'AE'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Reverse charge" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Reverse charge".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Reverse charge" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Reverse charge".”

### BR-AE-09 — The VAT category tax amount (BT-117) in a Reverse charge (AE) VAT breakdown shall equal 0.

- **Requires:** The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Reverse charge" shall be 0 (zero).
- **Business terms:** BG-23, BT-117, BT-118
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'AE'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'AE'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Reverse charge" shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Reverse charge" shall be 0 (zero).”

### BR-AE-10 — A VAT breakdown (BG-23) with a Reverse charge (AE) VAT category code (BT-118) SHALL have a VAT exemption reason code (BT-121) meaning 'Reverse charge' or the reason text (BT-120) 'Reverse charge' — the presence-required shape shared with BR-E-10.

- **Requires:** A VAT breakdown (BG-23) with VAT Category code (BT-118) "Reverse charge" shall have a VAT exemption reason code (BT-121), meaning "Reverse charge" or the VAT exemption reason text (BT-120) "Reverse charge" (or the equivalent standard text in another language).
- **Business terms:** BG-23, BT-118, BT-120, BT-121
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'AE'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Add the required element at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'AE'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`: A VAT breakdown (BG-23) with VAT Category code (BT-118) "Reverse charge" shall have a VAT exemption reason code (BT-121), meaning "Reverse charge" or the VAT exemption reason text (BT-120) "Reverse charge" (or the equivalent standard text in another language).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “A VAT breakdown (BG-23) with VAT Category code (BT-118) "Reverse charge" shall have a VAT exemption reason code (BT-121), meaning "Reverse charge" or the VAT exemption reason text (BT-120) "Reverse charge" (or the equivalent standard text in another language).”

## BR-AF

VAT breakdown rules for VAT category code L (IGIC, Canary Islands general indirect tax).

### BR-AF-01 — IGIC (L) items and the VAT breakdown (BG-23) must agree.

- **Requires:** An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "IGIC" shall contain in the VAT breakdown (BG-23) at least one VAT category code (BT-118) equal with "IGIC".
- **Business terms:** BG-20, BG-21, BG-23, BG-25, BT-95, BT-102, BT-118, BT-151
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='L']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='L']` so that An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "IGIC" shall contain in the VAT breakdown (BG-23) at least one VAT category code (BT-118) equal with "IGIC".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "IGIC" shall contain in the VAT breakdown (BG-23) at least one VAT category code (BT-118) equal with "IGIC".”

### BR-AF-02 — An IGIC (L) Invoice line (BT-151) requires the Seller VAT identifier (BT-31), Seller tax registration id (BT-32) and/or Seller tax representative VAT id (BT-63) — both official disjuncts are VAT-scoped (the BR-Z/E-02 symmetric shape, not BR-S-02's scheme-agnostic tail).

- **Requires:** An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "IGIC" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-25, BT-31, BT-32, BT-63, BT-151
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='L']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='L']` so that An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "IGIC" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "IGIC" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-AF-03 — An IGIC (L) Document level allowance (BT-95) requires the Seller VAT identifier disjunct (same shape as BR-AF-02).

- **Requires:** An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "IGIC" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-20, BT-31, BT-32, BT-63, BT-95
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='L']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='L']` so that An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "IGIC" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "IGIC" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-AF-04 — An IGIC (L) Document level charge (BT-102) requires the Seller VAT identifier disjunct.

- **Requires:** An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "IGIC" shall contain the Seller VAT Identifier (BT-31), the Seller Tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-21, BT-31, BT-32, BT-63, BT-102
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='L']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='L']` so that An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "IGIC" shall contain the Seller VAT Identifier (BT-31), the Seller Tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "IGIC" shall contain the Seller VAT Identifier (BT-31), the Seller Tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-AF-05 — In an IGIC (L) Invoice line the Invoiced item VAT rate (BT-152) shall be 0 (zero) or greater than zero.

- **Requires:** In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "IGIC" the invoiced item VAT rate (BT-152) shall be 0 (zero) or greater than zero.
- **Business terms:** BG-25, BT-151, BT-152
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'L'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'L'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "IGIC" the invoiced item VAT rate (BT-152) shall be 0 (zero) or greater than zero.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "IGIC" the invoiced item VAT rate (BT-152) shall be 0 (zero) or greater than zero.”

### BR-AF-06 — In an IGIC (L) Document level allowance the allowance VAT rate (BT-96) shall be 0 (zero) or greater than zero.

- **Requires:** In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "IGIC" the Document level allowance VAT rate (BT-96) shall be 0 (zero) or greater than zero.
- **Business terms:** BG-20, BT-95, BT-96
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='L'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='L'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "IGIC" the Document level allowance VAT rate (BT-96) shall be 0 (zero) or greater than zero.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "IGIC" the Document level allowance VAT rate (BT-96) shall be 0 (zero) or greater than zero.”

### BR-AF-07 — In an IGIC (L) Document level charge the charge VAT rate (BT-103) shall be 0 (zero) or greater than zero.

- **Requires:** In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "IGIC" the Document level charge VAT rate (BT-103) shall be 0 (zero) or greater than zero.
- **Business terms:** BG-21, BT-102, BT-103
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='L'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='L'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "IGIC" the Document level charge VAT rate (BT-103) shall be 0 (zero) or greater than zero.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "IGIC" the Document level charge VAT rate (BT-103) shall be 0 (zero) or greater than zero.”

### BR-AF-08 — For each different value of VAT category rate (BT-119) where the VAT category code (BT-118) is 'IGIC', the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) plus document level charge amounts (BT-99) minus document level allowance amounts (BT-92) where the VAT category code is 'IGIC' and the VAT rate equals BT-119.

- **Requires:** For each different value of VAT category rate (BT-119) where the VAT category code (BT-118) is "IGIC", the VAT category taxable amount (BT-116) in a VAT breakdown (BG-23) shall equal the sum of Invoice line net amounts (BT-131) plus the sum of document level charge amounts (BT-99) minus the sum of document level allowance amounts (BT-92) where the VAT category code (BT-151, BT-102, BT-95) is "IGIC" and the VAT rate (BT-152, BT-103, BT-96) equals the VAT category rate (BT-119).
- **Business terms:** BG-23, BT-92, BT-95, BT-96, BT-99, BT-102, BT-103, BT-116, BT-118, BT-119, BT-131, BT-151, BT-152
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'L'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'L'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that For each different value of VAT category rate (BT-119) where the VAT category code (BT-118) is "IGIC", the VAT category taxable amount (BT-116) in a VAT breakdown (BG-23) shall equal the sum of Invoice line net amounts (BT-131) plus the sum of document level charge amounts (BT-99) minus the sum of document level allowance amounts (BT-92) where the VAT category code (BT-151, BT-102, BT-95) is "IGIC" and the VAT rate (BT-152, BT-103, BT-96) equals the VAT category rate (BT-119).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “For each different value of VAT category rate (BT-119) where the VAT category code (BT-118) is "IGIC", the VAT category taxable amount (BT-116) in a VAT breakdown (BG-23) shall equal the sum of Invoice line net amounts (BT-131) plus the sum of document level charge amounts (BT-99) minus the sum of document level allowance amounts (BT-92) where the VAT category code (BT-151, BT-102, BT-95) is "IGIC" and the VAT rate (BT-152, BT-103, BT-96) equals the VAT category rate (BT-119).”

### BR-AF-09 — The VAT category tax amount (BT-117) in an IGIC (L) VAT breakdown shall equal the VAT category taxable amount (BT-116) multiplied by the VAT category rate (BT-119).

- **Requires:** The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where VAT category code (BT-118) is "IGIC" shall equal the VAT category taxable amount (BT-116) multiplied by the VAT category rate (BT-119).
- **Business terms:** BG-23, BT-116, BT-117, BT-118, BT-119
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'L'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'L'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where VAT category code (BT-118) is "IGIC" shall equal the VAT category taxable amount (BT-116) multiplied by the VAT category rate (BT-119).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where VAT category code (BT-118) is "IGIC" shall equal the VAT category taxable amount (BT-116) multiplied by the VAT category rate (BT-119).”

### BR-AF-10 — A VAT breakdown (BG-23) with an IGIC (L) VAT category code (BT-118) shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).

- **Requires:** A VAT breakdown (BG-23) with VAT Category code (BT-118) "IGIC" shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).
- **Business terms:** BG-23, BT-118, BT-120, BT-121
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'L'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'L'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that A VAT breakdown (BG-23) with VAT Category code (BT-118) "IGIC" shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “A VAT breakdown (BG-23) with VAT Category code (BT-118) "IGIC" shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).”

## BR-AG

VAT breakdown rules for VAT category code M (IPSI, tax for Ceuta and Melilla).

### BR-AG-01 — IPSI (M) items and the VAT breakdown (BG-23) must agree.

- **Requires:** An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "IPSI" shall contain in the VAT breakdown (BG-23) at least one VAT category code (BT-118) equal with "IPSI".
- **Business terms:** BG-20, BG-21, BG-23, BG-25, BT-95, BT-102, BT-118, BT-151
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='M']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='M']` so that An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "IPSI" shall contain in the VAT breakdown (BG-23) at least one VAT category code (BT-118) equal with "IPSI".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "IPSI" shall contain in the VAT breakdown (BG-23) at least one VAT category code (BT-118) equal with "IPSI".”

### BR-AG-02 — An IPSI (M) Invoice line (BT-151) requires the Seller VAT identifier (BT-31), Seller tax registration id (BT-32) and/or Seller tax representative VAT id (BT-63) — both official disjuncts are VAT-scoped (the BR-Z/E/AF-02 symmetric shape, not BR-S-02's scheme-agnostic tail).

- **Requires:** An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "IPSI" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-25, BT-31, BT-32, BT-63, BT-151
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='M']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='M']` so that An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "IPSI" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "IPSI" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-AG-03 — An IPSI (M) Document level allowance (BT-95) requires the Seller VAT identifier disjunct (same shape as BR-AG-02).

- **Requires:** An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "IPSI" shall contain the Seller VAT Identifier (BT-31), the Seller Tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-20, BT-31, BT-32, BT-63, BT-95
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='M']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='M']` so that An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "IPSI" shall contain the Seller VAT Identifier (BT-31), the Seller Tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "IPSI" shall contain the Seller VAT Identifier (BT-31), the Seller Tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-AG-04 — An IPSI (M) Document level charge (BT-102) requires the Seller VAT identifier disjunct.

- **Requires:** An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "IPSI" shall contain the Seller VAT Identifier (BT-31), the Seller Tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-21, BT-31, BT-32, BT-63, BT-102
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='M']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='M']` so that An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "IPSI" shall contain the Seller VAT Identifier (BT-31), the Seller Tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "IPSI" shall contain the Seller VAT Identifier (BT-31), the Seller Tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-AG-05 — In an IPSI (M) Invoice line the Invoiced item VAT rate (BT-152) shall be 0 (zero) or greater than zero.

- **Requires:** In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "IPSI" the Invoiced item VAT rate (BT-152) shall be 0 (zero) or greater than zero.
- **Business terms:** BG-25, BT-151, BT-152
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'M'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'M'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "IPSI" the Invoiced item VAT rate (BT-152) shall be 0 (zero) or greater than zero.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "IPSI" the Invoiced item VAT rate (BT-152) shall be 0 (zero) or greater than zero.”

### BR-AG-06 — In an IPSI (M) Document level allowance the allowance VAT rate (BT-96) shall be 0 (zero) or greater than zero.

- **Requires:** In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "IPSI" the Document level allowance VAT rate (BT-96) shall be 0 (zero) or greater than zero.
- **Business terms:** BG-20, BT-95, BT-96
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='M'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='M'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "IPSI" the Document level allowance VAT rate (BT-96) shall be 0 (zero) or greater than zero.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "IPSI" the Document level allowance VAT rate (BT-96) shall be 0 (zero) or greater than zero.”

### BR-AG-07 — In an IPSI (M) Document level charge the charge VAT rate (BT-103) shall be 0 (zero) or greater than zero.

- **Requires:** In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "IPSI" the Document level charge VAT rate (BT-103) shall be 0 (zero) or greater than zero.
- **Business terms:** BG-21, BT-102, BT-103
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='M'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='M'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "IPSI" the Document level charge VAT rate (BT-103) shall be 0 (zero) or greater than zero.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "IPSI" the Document level charge VAT rate (BT-103) shall be 0 (zero) or greater than zero.”

### BR-AG-08 — For each different value of VAT category rate (BT-119) where the VAT category code (BT-118) is 'IPSI', the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) plus document level charge amounts (BT-99) minus document level allowance amounts (BT-92) where the VAT category code is 'IPSI' and the VAT rate equals BT-119.

- **Requires:** For each different value of VAT category rate (BT-119) where the VAT category code (BT-118) is "IPSI", the VAT category taxable amount (BT-116) in a VAT breakdown (BG-23) shall equal the sum of Invoice line net amounts (BT-131) plus the sum of document level charge amounts (BT-99) minus the sum of document level allowance amounts (BT-92) where the VAT category code (BT-151, BT-102, BT-95) is "IPSI" and the VAT rate (BT-152, BT-103, BT-96) equals the VAT category rate (BT-119).
- **Business terms:** BG-23, BT-92, BT-95, BT-96, BT-99, BT-102, BT-103, BT-116, BT-118, BT-119, BT-131, BT-151, BT-152
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'M'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'M'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that For each different value of VAT category rate (BT-119) where the VAT category code (BT-118) is "IPSI", the VAT category taxable amount (BT-116) in a VAT breakdown (BG-23) shall equal the sum of Invoice line net amounts (BT-131) plus the sum of document level charge amounts (BT-99) minus the sum of document level allowance amounts (BT-92) where the VAT category code (BT-151, BT-102, BT-95) is "IPSI" and the VAT rate (BT-152, BT-103, BT-96) equals the VAT category rate (BT-119).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “For each different value of VAT category rate (BT-119) where the VAT category code (BT-118) is "IPSI", the VAT category taxable amount (BT-116) in a VAT breakdown (BG-23) shall equal the sum of Invoice line net amounts (BT-131) plus the sum of document level charge amounts (BT-99) minus the sum of document level allowance amounts (BT-92) where the VAT category code (BT-151, BT-102, BT-95) is "IPSI" and the VAT rate (BT-152, BT-103, BT-96) equals the VAT category rate (BT-119).”

### BR-AG-09 — The VAT category tax amount (BT-117) in an IPSI (M) VAT breakdown shall equal the VAT category taxable amount (BT-116) multiplied by the VAT category rate (BT-119).

- **Requires:** The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where VAT category code (BT-118) is "IPSI" shall equal the VAT category taxable amount (BT-116) multiplied by the VAT category rate (BT-119).
- **Business terms:** BG-23, BT-116, BT-117, BT-118, BT-119
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'M'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'M'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where VAT category code (BT-118) is "IPSI" shall equal the VAT category taxable amount (BT-116) multiplied by the VAT category rate (BT-119).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where VAT category code (BT-118) is "IPSI" shall equal the VAT category taxable amount (BT-116) multiplied by the VAT category rate (BT-119).”

### BR-AG-10 — A VAT breakdown (BG-23) with an IPSI (M) VAT category code (BT-118) shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).

- **Requires:** A VAT breakdown (BG-23) with VAT Category code (BT-118) "IPSI" shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).
- **Business terms:** BG-23, BT-118, BT-120, BT-121
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'M'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'M'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that A VAT breakdown (BG-23) with VAT Category code (BT-118) "IPSI" shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “A VAT breakdown (BG-23) with VAT Category code (BT-118) "IPSI" shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).”

## BR-B

VAT breakdown rules for VAT category code B (Italian split payment).

### BR-B-01 — An Invoice where the VAT category code (BT-151, BT-95 or BT-102) is 'Split payment' shall be a domestic Italian invoice.

- **Requires:** An Invoice where the VAT category code (BT-151, BT-95 or BT-102) is “Split payment” shall be a domestic Italian invoice.
- **Business terms:** BT-95, BT-102, BT-151
- **Location:** `cbc:IdentificationCode`
- **Fix:** Adjust the VAT breakdown at `cbc:IdentificationCode` so that An Invoice where the VAT category code (BT-151, BT-95 or BT-102) is “Split payment” shall be a domestic Italian invoice.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice where the VAT category code (BT-151, BT-95 or BT-102) is “Split payment” shall be a domestic Italian invoice.”

### BR-B-02 — An Invoice with a 'Split payment' (B) VAT category code (BT-151, BT-95, BT-118 or BT-102) shall not also contain a 'Standard rated' (S) VAT category code.

- **Requires:** An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95, BT-118 or BT-102) is “Split payment" shall not contain an invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95, BT-118 or BT-102) is “Standard rated”.
- **Business terms:** BG-20, BG-21, BG-25, BT-95, BT-102, BT-118, BT-151
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID` so that An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95, BT-118 or BT-102) is “Split payment" shall not contain an invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95, BT-118 or BT-102) is “Standard rated”.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95, BT-118 or BT-102) is “Split payment" shall not contain an invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95, BT-118 or BT-102) is “Standard rated”.”

## BR-E

VAT breakdown rules for VAT category code E.

### BR-E-01 — 'Exempt from VAT' (E) items require exactly one E VAT breakdown (BG-23) row.

- **Requires:** An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Exempt from VAT" shall contain exactly one VAT breakdown (BG-23) with the VAT category code (BT-118) equal to "Exempt from VAT".
- **Business terms:** BG-20, BG-21, BG-23, BG-25, BT-95, BT-102, BT-118, BT-151
- **Location:** `cac:TaxCategory`
- **Fix:** Adjust the VAT breakdown at `cac:TaxCategory` so that An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Exempt from VAT" shall contain exactly one VAT breakdown (BG-23) with the VAT category code (BT-118) equal to "Exempt from VAT".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Exempt from VAT" shall contain exactly one VAT breakdown (BG-23) with the VAT category code (BT-118) equal to "Exempt from VAT".”

### BR-E-02 — An Exempt (E) Invoice line (BT-151) requires the Seller VAT identifier / tax registration id / tax representative VAT id.

- **Requires:** An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Exempt from VAT" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-25, BT-31, BT-32, BT-63, BT-151
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='E']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='E']` so that An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Exempt from VAT" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Exempt from VAT" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-E-03 — An Exempt (E) Document level allowance (BT-95) requires the Seller VAT identifier disjunct.

- **Requires:** An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Exempt from VAT" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-20, BT-31, BT-32, BT-63, BT-95
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='E']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='E']` so that An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Exempt from VAT" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Exempt from VAT" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-E-04 — An Exempt (E) Document level charge (BT-102) requires the Seller VAT identifier disjunct.

- **Requires:** An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Exempt from VAT" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-21, BT-31, BT-32, BT-63, BT-102
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='E']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='E']` so that An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Exempt from VAT" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Exempt from VAT" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-E-05 — In an Exempt (E) Invoice line the Invoiced item VAT rate (BT-152) shall be 0.

- **Requires:** In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Exempt from VAT", the Invoiced item VAT rate (BT-152) shall be 0 (zero).
- **Business terms:** BG-25, BT-151, BT-152
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'E'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'E'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Exempt from VAT", the Invoiced item VAT rate (BT-152) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Exempt from VAT", the Invoiced item VAT rate (BT-152) shall be 0 (zero).”

### BR-E-06 — In an Exempt (E) Document level allowance the allowance VAT rate (BT-96) shall be 0.

- **Requires:** In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Exempt from VAT", the Document level allowance VAT rate (BT-96) shall be 0 (zero).
- **Business terms:** BG-20, BT-95, BT-96
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='E'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='E'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Exempt from VAT", the Document level allowance VAT rate (BT-96) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Exempt from VAT", the Document level allowance VAT rate (BT-96) shall be 0 (zero).”

### BR-E-07 — In an Exempt (E) Document level charge the charge VAT rate (BT-103) shall be 0.

- **Requires:** In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Exempt from VAT", the Document level charge VAT rate (BT-103) shall be 0 (zero).
- **Business terms:** BG-21, BT-102, BT-103
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='E'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='E'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Exempt from VAT", the Document level charge VAT rate (BT-103) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Exempt from VAT", the Document level charge VAT rate (BT-103) shall be 0 (zero).”

### BR-E-08 — The Exempt (E) VAT breakdown taxable amount (BT-116) shall equal the exact sum of E line net amounts − E allowances + E charges.

- **Requires:** In a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Exempt from VAT" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Exempt from VAT".
- **Business terms:** BG-23, BT-92, BT-95, BT-99, BT-102, BT-116, BT-118, BT-131, BT-151
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'E'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'E'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Exempt from VAT" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Exempt from VAT".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Exempt from VAT" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Exempt from VAT".”

### BR-E-09 — The VAT category tax amount (BT-117) in an Exempt (E) VAT breakdown shall equal 0.

- **Requires:** The VAT category tax amount (BT-117) In a VAT breakdown (BG-23) where the VAT category code (BT-118) equals "Exempt from VAT" shall equal 0 (zero).
- **Business terms:** BG-23, BT-117, BT-118
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'E'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'E'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that The VAT category tax amount (BT-117) In a VAT breakdown (BG-23) where the VAT category code (BT-118) equals "Exempt from VAT" shall equal 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The VAT category tax amount (BT-117) In a VAT breakdown (BG-23) where the VAT category code (BT-118) equals "Exempt from VAT" shall equal 0 (zero).”

### BR-E-10 — A VAT breakdown (BG-23) with an Exempt from VAT (E) VAT category code (BT-118) SHALL have a VAT exemption reason code (BT-121) or text (BT-120) — the presence-required mirror image of BR-Z-10/BR-S-10.

- **Requires:** A VAT breakdown (BG-23) with VAT Category code (BT-118) "Exempt from VAT" shall have a VAT exemption reason code (BT-121) or a VAT exemption reason text (BT-120).
- **Business terms:** BG-23, BT-118, BT-120, BT-121
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'E'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Add the required element at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'E'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`: A VAT breakdown (BG-23) with VAT Category code (BT-118) "Exempt from VAT" shall have a VAT exemption reason code (BT-121) or a VAT exemption reason text (BT-120).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “A VAT breakdown (BG-23) with VAT Category code (BT-118) "Exempt from VAT" shall have a VAT exemption reason code (BT-121) or a VAT exemption reason text (BT-120).”

## BR-G

VAT breakdown rules for VAT category code G.

### BR-G-01 — 'Export outside the EU' (G) items require exactly one G VAT breakdown (BG-23) row.

- **Requires:** An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Export outside the EU" shall contain in the VAT breakdown (BG-23) exactly one VAT category code (BT-118) equal with "Export outside the EU".
- **Business terms:** BG-20, BG-21, BG-23, BG-25, BT-95, BT-102, BT-118, BT-151
- **Location:** `cac:TaxCategory`
- **Fix:** Adjust the VAT breakdown at `cac:TaxCategory` so that An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Export outside the EU" shall contain in the VAT breakdown (BG-23) exactly one VAT category code (BT-118) equal with "Export outside the EU".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Export outside the EU" shall contain in the VAT breakdown (BG-23) exactly one VAT category code (BT-118) equal with "Export outside the EU".”

### BR-G-02 — An Invoice with an Export outside the EU (G) Invoice line (BT-151) shall carry a VAT-scoped Seller identifier (BT-31/BT-63).

- **Requires:** An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Export outside the EU" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-25, BT-31, BT-63, BT-151
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='G']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='G']` so that An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Export outside the EU" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Export outside the EU" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63).”

### BR-G-03 — An Invoice with an Export outside the EU (G) Document level allowance (BT-95) shall carry a VAT-scoped Seller identifier.

- **Requires:** An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Export outside the EU" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-20, BT-31, BT-63, BT-95
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='G']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='G']` so that An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Export outside the EU" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Export outside the EU" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63).”

### BR-G-04 — An Invoice with an Export outside the EU (G) Document level charge (BT-102) shall carry a VAT-scoped Seller identifier.

- **Requires:** An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Export outside the EU" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-21, BT-31, BT-63, BT-102
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='G']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='G']` so that An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Export outside the EU" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Export outside the EU" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63).”

### BR-G-05 — In an Export outside the EU (G) Invoice line the Invoiced item VAT rate (BT-152) shall be 0.

- **Requires:** In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Export outside the EU" the Invoiced item VAT rate (BT-152) shall be 0 (zero).
- **Business terms:** BG-25, BT-151, BT-152
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'G'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'G'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Export outside the EU" the Invoiced item VAT rate (BT-152) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Export outside the EU" the Invoiced item VAT rate (BT-152) shall be 0 (zero).”

### BR-G-06 — In an Export outside the EU (G) Document level allowance the allowance VAT rate (BT-96) shall be 0.

- **Requires:** In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Export outside the EU" the Document level allowance VAT rate (BT-96) shall be 0 (zero).
- **Business terms:** BG-20, BT-95, BT-96
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='G'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='G'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Export outside the EU" the Document level allowance VAT rate (BT-96) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Export outside the EU" the Document level allowance VAT rate (BT-96) shall be 0 (zero).”

### BR-G-07 — In an Export outside the EU (G) Document level charge the charge VAT rate (BT-103) shall be 0.

- **Requires:** In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Export outside the EU" the Document level charge VAT rate (BT-103) shall be 0 (zero).
- **Business terms:** BG-21, BT-102, BT-103
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='G'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='G'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Export outside the EU" the Document level charge VAT rate (BT-103) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Export outside the EU" the Document level charge VAT rate (BT-103) shall be 0 (zero).”

### BR-G-08 — The Export outside the EU (G) VAT breakdown taxable amount (BT-116) shall equal the exact sum of G line nets − G allowances + G charges.

- **Requires:** In a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Export outside the EU" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Export outside the EU".
- **Business terms:** BG-23, BT-92, BT-95, BT-99, BT-102, BT-116, BT-118, BT-131, BT-151
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'G'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'G'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Export outside the EU" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Export outside the EU".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Export outside the EU" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Export outside the EU".”

### BR-G-09 — The VAT category tax amount (BT-117) in an Export outside the EU (G) VAT breakdown shall equal 0.

- **Requires:** The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Export outside the EU" shall be 0 (zero).
- **Business terms:** BG-23, BT-117, BT-118
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'G'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'G'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Export outside the EU" shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Export outside the EU" shall be 0 (zero).”

### BR-G-10 — A VAT breakdown (BG-23) with an Export outside the EU (G) VAT category code (BT-118) SHALL have a VAT exemption reason code (BT-121) or text (BT-120) — the presence-required shape shared with BR-E-10.

- **Requires:** A VAT breakdown (BG-23) with the VAT Category code (BT-118) "Export outside the EU" shall have a VAT exemption reason code (BT-121), meaning "Export outside the EU" or the VAT exemption reason text (BT-120) "Export outside the EU" (or the equivalent standard text in another language).
- **Business terms:** BG-23, BT-118, BT-120, BT-121
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'G'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Add the required element at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'G'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`: A VAT breakdown (BG-23) with the VAT Category code (BT-118) "Export outside the EU" shall have a VAT exemption reason code (BT-121), meaning "Export outside the EU" or the VAT exemption reason text (BT-120) "Export outside the EU" (or the equivalent standard text in another language).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “A VAT breakdown (BG-23) with the VAT Category code (BT-118) "Export outside the EU" shall have a VAT exemption reason code (BT-121), meaning "Export outside the EU" or the VAT exemption reason text (BT-120) "Export outside the EU" (or the equivalent standard text in another language).”

## BR-IC

VAT breakdown rules for the intra-community VAT category.

### BR-IC-01 — 'Intra-community supply' (K) items require exactly one K VAT breakdown (BG-23) row.

- **Requires:** An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Intra-community supply" shall contain in the VAT breakdown (BG-23) exactly one VAT category code (BT-118) equal with "Intra-community supply".
- **Business terms:** BG-20, BG-21, BG-23, BG-25, BT-95, BT-102, BT-118, BT-151
- **Location:** `cac:TaxCategory`
- **Fix:** Adjust the VAT breakdown at `cac:TaxCategory` so that An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Intra-community supply" shall contain in the VAT breakdown (BG-23) exactly one VAT category code (BT-118) equal with "Intra-community supply".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Intra-community supply" shall contain in the VAT breakdown (BG-23) exactly one VAT category code (BT-118) equal with "Intra-community supply".”

### BR-IC-02 — An Invoice with an Intra-community supply (K) Invoice line (BT-151) shall carry a VAT-scoped Seller identifier AND the Buyer VAT identifier.

- **Requires:** An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Intra-community supply" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48).
- **Business terms:** BG-25, BT-31, BT-48, BT-63, BT-151
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='K']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='K']` so that An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Intra-community supply" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Intra-community supply" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48).”

### BR-IC-03 — An Invoice with an Intra-community supply (K) Document level allowance (BT-95) shall carry a VAT-scoped Seller identifier AND the Buyer VAT identifier.

- **Requires:** An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Intra-community supply" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48).
- **Business terms:** BG-20, BT-31, BT-48, BT-63, BT-95
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='K']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='K']` so that An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Intra-community supply" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Intra-community supply" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48).”

### BR-IC-04 — An Invoice with an Intra-community supply (K) Document level charge (BT-102) shall carry a VAT-scoped Seller identifier AND the Buyer VAT identifier.

- **Requires:** An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Intra-community supply" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48).
- **Business terms:** BG-21, BT-31, BT-48, BT-63, BT-102
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='K']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='K']` so that An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Intra-community supply" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Intra-community supply" shall contain the Seller VAT Identifier (BT-31) or the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48).”

### BR-IC-05 — In an Intra-community supply (K) Invoice line the Invoiced item VAT rate (BT-152) shall be 0.

- **Requires:** In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Intracommunity supply" the Invoiced item VAT rate (BT-152) shall be 0 (zero).
- **Business terms:** BG-25, BT-151, BT-152
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'K'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'K'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Intracommunity supply" the Invoiced item VAT rate (BT-152) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Intracommunity supply" the Invoiced item VAT rate (BT-152) shall be 0 (zero).”

### BR-IC-06 — In an Intra-community supply (K) Document level allowance the allowance VAT rate (BT-96) shall be 0.

- **Requires:** In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Intra-community supply" the Document level allowance VAT rate (BT-96) shall be 0 (zero).
- **Business terms:** BG-20, BT-95, BT-96
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='K'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='K'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Intra-community supply" the Document level allowance VAT rate (BT-96) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Intra-community supply" the Document level allowance VAT rate (BT-96) shall be 0 (zero).”

### BR-IC-07 — In an Intra-community supply (K) Document level charge the charge VAT rate (BT-103) shall be 0.

- **Requires:** In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Intra-community supply" the Document level charge VAT rate (BT-103) shall be 0 (zero).
- **Business terms:** BG-21, BT-102, BT-103
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='K'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='K'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Intra-community supply" the Document level charge VAT rate (BT-103) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Intra-community supply" the Document level charge VAT rate (BT-103) shall be 0 (zero).”

### BR-IC-08 — The Intra-community supply (K) VAT breakdown taxable amount (BT-116) shall equal the exact sum of K line nets − K allowances + K charges.

- **Requires:** In a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Intra-community supply" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Intra-community supply".
- **Business terms:** BG-23, BT-92, BT-95, BT-99, BT-102, BT-116, BT-118, BT-131, BT-151
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'K'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'K'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Intra-community supply" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Intra-community supply".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Intra-community supply" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Intra-community supply".”

### BR-IC-09 — The VAT category tax amount (BT-117) in an Intra-community supply (K) VAT breakdown shall equal 0.

- **Requires:** The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Intra-community supply" shall be 0 (zero).
- **Business terms:** BG-23, BT-117, BT-118
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'K'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'K'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Intra-community supply" shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Intra-community supply" shall be 0 (zero).”

### BR-IC-10 — A VAT breakdown (BG-23) with the VAT category code (BT-118) "Intra-community supply" (K) SHALL have a VAT exemption reason code (BT-121) or text (BT-120) — the K twin of BR-E-10 / BR-AE-10.

- **Requires:** A VAT breakdown (BG-23) with the VAT Category code (BT-118) "Intra-community supply" shall have a VAT exemption reason code (BT-121), meaning "Intra-community supply" or the VAT exemption reason text (BT-120) "Intra-community supply" (or the equivalent standard text in another language).
- **Business terms:** BG-23, BT-118, BT-120, BT-121
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'K'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Add the required element at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'K'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`: A VAT breakdown (BG-23) with the VAT Category code (BT-118) "Intra-community supply" shall have a VAT exemption reason code (BT-121), meaning "Intra-community supply" or the VAT exemption reason text (BT-120) "Intra-community supply" (or the equivalent standard text in another language).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “A VAT breakdown (BG-23) with the VAT Category code (BT-118) "Intra-community supply" shall have a VAT exemption reason code (BT-121), meaning "Intra-community supply" or the VAT exemption reason text (BT-120) "Intra-community supply" (or the equivalent standard text in another language).”

### BR-IC-11 — In an Invoice with an Intra-community supply (K) VAT breakdown (BG-23) the Actual delivery date (BT-72) or the Invoicing period (BG-14) shall not be blank.

- **Requires:** In an Invoice with a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Intra-community supply" the Actual delivery date (BT-72) or the Invoicing period (BG-14) shall not be blank.
- **Business terms:** BG-14, BG-23, BT-72, BT-118
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory` so that In an Invoice with a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Intra-community supply" the Actual delivery date (BT-72) or the Invoicing period (BG-14) shall not be blank.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In an Invoice with a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Intra-community supply" the Actual delivery date (BT-72) or the Invoicing period (BG-14) shall not be blank.”

### BR-IC-12 — In an Invoice with an Intra-community supply (K) VAT breakdown (BG-23) the Deliver to country code (BT-80) shall not be blank.

- **Requires:** In an Invoice with a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Intra-community supply" the Deliver to country code (BT-80) shall not be blank.
- **Business terms:** BG-23, BT-80, BT-118
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory` so that In an Invoice with a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Intra-community supply" the Deliver to country code (BT-80) shall not be blank.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In an Invoice with a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Intra-community supply" the Deliver to country code (BT-80) shall not be blank.”

## BR-O

VAT breakdown rules for VAT category code O.

### BR-O-01 — 'Not subject to VAT' (O) items require exactly one O VAT breakdown (BG-23) row.

- **Requires:** An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Not subject to VAT" shall contain exactly one VAT breakdown group (BG-23) with the VAT category code (BT-118) equal to "Not subject to VAT".
- **Business terms:** BG-20, BG-21, BG-23, BG-25, BT-95, BT-102, BT-118, BT-151
- **Location:** `cac:TaxCategory`
- **Fix:** Adjust the VAT breakdown at `cac:TaxCategory` so that An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Not subject to VAT" shall contain exactly one VAT breakdown group (BG-23) with the VAT category code (BT-118) equal to "Not subject to VAT".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Not subject to VAT" shall contain exactly one VAT breakdown group (BG-23) with the VAT category code (BT-118) equal to "Not subject to VAT".”

### BR-O-02 — An Invoice with a 'Not subject to VAT' (O) Invoice line (BT-151) shall NOT contain a Seller/tax-representative/Buyer VAT identifier.

- **Requires:** An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Not subject to VAT" shall not contain the Seller VAT identifier (BT-31), the Seller tax representative VAT identifier (BT-63) or the Buyer VAT identifier (BT-48).
- **Business terms:** BG-25, BT-31, BT-48, BT-63, BT-151
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='O']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='O']` so that An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Not subject to VAT" shall not contain the Seller VAT identifier (BT-31), the Seller tax representative VAT identifier (BT-63) or the Buyer VAT identifier (BT-48).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Not subject to VAT" shall not contain the Seller VAT identifier (BT-31), the Seller tax representative VAT identifier (BT-63) or the Buyer VAT identifier (BT-48).”

### BR-O-03 — An Invoice with a 'Not subject to VAT' (O) Document level allowance (BT-95) shall NOT contain any VAT identifier.

- **Requires:** An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Not subject to VAT" shall not contain the Seller VAT identifier (BT-31), the Seller tax representative VAT identifier (BT-63) or the Buyer VAT identifier (BT-48).
- **Business terms:** BG-20, BT-31, BT-48, BT-63, BT-95
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='O']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='O']` so that An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Not subject to VAT" shall not contain the Seller VAT identifier (BT-31), the Seller tax representative VAT identifier (BT-63) or the Buyer VAT identifier (BT-48).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Not subject to VAT" shall not contain the Seller VAT identifier (BT-31), the Seller tax representative VAT identifier (BT-63) or the Buyer VAT identifier (BT-48).”

### BR-O-04 — An Invoice with a 'Not subject to VAT' (O) Document level charge (BT-102) shall NOT contain any VAT identifier.

- **Requires:** An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Not subject to VAT" shall not contain the Seller VAT identifier (BT-31), the Seller tax representative VAT identifier (BT-63) or the Buyer VAT identifier (BT-48).
- **Business terms:** BG-21, BT-31, BT-48, BT-63, BT-102
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='O']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='O']` so that An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Not subject to VAT" shall not contain the Seller VAT identifier (BT-31), the Seller tax representative VAT identifier (BT-63) or the Buyer VAT identifier (BT-48).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Not subject to VAT" shall not contain the Seller VAT identifier (BT-31), the Seller tax representative VAT identifier (BT-63) or the Buyer VAT identifier (BT-48).”

### BR-O-05 — A 'Not subject to VAT' (O) Invoice line shall NOT contain an Invoiced item VAT rate (BT-152) — ``not(cbc:Percent)``.

- **Requires:** An Invoice line (BG-25) where the VAT category code (BT-151) is "Not subject to VAT" shall not contain an Invoiced item VAT rate (BT-152).
- **Business terms:** BG-25, BT-151, BT-152
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'O'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'O'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that An Invoice line (BG-25) where the VAT category code (BT-151) is "Not subject to VAT" shall not contain an Invoiced item VAT rate (BT-152).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice line (BG-25) where the VAT category code (BT-151) is "Not subject to VAT" shall not contain an Invoiced item VAT rate (BT-152).”

### BR-O-06 — A 'Not subject to VAT' (O) Document level allowance shall NOT contain a Document level allowance VAT rate (BT-96).

- **Requires:** A Document level allowance (BG-20) where VAT category code (BT-95) is "Not subject to VAT" shall not contain a Document level allowance VAT rate (BT-96).
- **Business terms:** BG-20, BT-95, BT-96
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='O'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='O'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that A Document level allowance (BG-20) where VAT category code (BT-95) is "Not subject to VAT" shall not contain a Document level allowance VAT rate (BT-96).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “A Document level allowance (BG-20) where VAT category code (BT-95) is "Not subject to VAT" shall not contain a Document level allowance VAT rate (BT-96).”

### BR-O-07 — A 'Not subject to VAT' (O) Document level charge shall NOT contain a Document level charge VAT rate (BT-103).

- **Requires:** A Document level charge (BG-21) where the VAT category code (BT-102) is "Not subject to VAT" shall not contain a Document level charge VAT rate (BT-103).
- **Business terms:** BG-21, BT-102, BT-103
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='O'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='O'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that A Document level charge (BG-21) where the VAT category code (BT-102) is "Not subject to VAT" shall not contain a Document level charge VAT rate (BT-103).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “A Document level charge (BG-21) where the VAT category code (BT-102) is "Not subject to VAT" shall not contain a Document level charge VAT rate (BT-103).”

### BR-O-08 — The 'Not subject to VAT' (O) VAT breakdown taxable amount (BT-116) shall equal the exact sum of O line nets − O allowances + O charges.

- **Requires:** In a VAT breakdown (BG-23) where the VAT category code (BT-118) is " Not subject to VAT" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Not subject to VAT".
- **Business terms:** BG-23, BT-92, BT-95, BT-99, BT-102, BT-116, BT-118, BT-131, BT-151
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'O'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'O'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a VAT breakdown (BG-23) where the VAT category code (BT-118) is " Not subject to VAT" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Not subject to VAT".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a VAT breakdown (BG-23) where the VAT category code (BT-118) is " Not subject to VAT" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Not subject to VAT".”

### BR-O-09 — The VAT category tax amount (BT-117) in a 'Not subject to VAT' (O) VAT breakdown shall equal 0.

- **Requires:** The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Not subject to VAT" shall be 0 (zero).
- **Business terms:** BG-23, BT-117, BT-118
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'O'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'O'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Not subject to VAT" shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Not subject to VAT" shall be 0 (zero).”

### BR-O-10 — A VAT breakdown (BG-23) with a 'Not subject to VAT' (O) VAT category code (BT-118) SHALL have a VAT exemption reason code (BT-121) or text (BT-120).

- **Requires:** A VAT breakdown (BG-23) with VAT Category code (BT-118) " Not subject to VAT" shall have a VAT exemption reason code (BT-121), meaning " Not subject to VAT" or a VAT exemption reason text (BT-120) " Not subject to VAT" (or the equivalent standard text in another language).
- **Business terms:** BG-23, BT-118, BT-120, BT-121
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'O'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Add the required element at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'O'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`: A VAT breakdown (BG-23) with VAT Category code (BT-118) " Not subject to VAT" shall have a VAT exemption reason code (BT-121), meaning " Not subject to VAT" or a VAT exemption reason text (BT-120) " Not subject to VAT" (or the equivalent standard text in another language).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “A VAT breakdown (BG-23) with VAT Category code (BT-118) " Not subject to VAT" shall have a VAT exemption reason code (BT-121), meaning " Not subject to VAT" or a VAT exemption reason text (BT-120) " Not subject to VAT" (or the equivalent standard text in another language).”

### BR-O-11 — An Invoice with a 'Not subject to VAT' (O) VAT breakdown (BG-23) shall NOT contain any other VAT breakdown group.

- **Requires:** An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain other VAT breakdown groups (BG-23).
- **Business terms:** BG-23, BT-118
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory` so that An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain other VAT breakdown groups (BG-23).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain other VAT breakdown groups (BG-23).”

### BR-O-12 — An Invoice with a 'Not subject to VAT' (O) VAT breakdown (BG-23) shall NOT contain an Invoice line (BG-25) whose Invoiced item VAT category code (BT-151) is not 'Not subject to VAT'.

- **Requires:** An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is not "Not subject to VAT".
- **Business terms:** BG-23, BG-25, BT-118, BT-151
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory` so that An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is not "Not subject to VAT".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is not "Not subject to VAT".”

### BR-O-13 — An Invoice with a 'Not subject to VAT' (O) VAT breakdown (BG-23) shall NOT contain a Document level allowance (BG-20) whose VAT category code (BT-95) is not 'Not subject to VAT'.

- **Requires:** An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain Document level allowances (BG-20) where Document level allowance VAT category code (BT-95) is not "Not subject to VAT".
- **Business terms:** BG-20, BG-23, BT-95, BT-118
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory` so that An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain Document level allowances (BG-20) where Document level allowance VAT category code (BT-95) is not "Not subject to VAT".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain Document level allowances (BG-20) where Document level allowance VAT category code (BT-95) is not "Not subject to VAT".”

### BR-O-14 — An Invoice with a 'Not subject to VAT' (O) VAT breakdown (BG-23) shall NOT contain a Document level charge (BG-21) whose VAT category code (BT-102) is not 'Not subject to VAT'.

- **Requires:** An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain Document level charges (BG-21) where Document level charge VAT category code (BT-102) is not "Not subject to VAT".
- **Business terms:** BG-21, BG-23, BT-102, BT-118
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory` so that An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain Document level charges (BG-21) where Document level charge VAT category code (BT-102) is not "Not subject to VAT".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain Document level charges (BG-21) where Document level charge VAT category code (BT-102) is not "Not subject to VAT".”

## BR-S

VAT breakdown rules for VAT category code S.

### BR-S-01 — Standard-rated (S) items and the VAT breakdown must agree.

- **Requires:** An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Standard rated" shall contain in the VAT breakdown (BG-23) at least one VAT category code (BT-118) equal with "Standard rated".
- **Business terms:** BG-20, BG-21, BG-23, BG-25, BT-95, BT-102, BT-118, BT-151
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='S']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='S']` so that An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Standard rated" shall contain in the VAT breakdown (BG-23) at least one VAT category code (BT-118) equal with "Standard rated".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Standard rated" shall contain in the VAT breakdown (BG-23) at least one VAT category code (BT-118) equal with "Standard rated".”

### BR-S-02 — An Invoice with a Standard-rated (S) Invoice line (BT-151) shall contain the Seller VAT Identifier (BT-31), Seller tax registration id (BT-32) and/or Seller tax representative VAT id (BT-63).

- **Requires:** An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Standard rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-25, BT-31, BT-32, BT-63, BT-151
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='S']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='S']` so that An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Standard rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Standard rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-S-03 — An Invoice with a Standard-rated (S) Document level allowance (BT-95) shall contain the Seller VAT id / tax registration id / tax rep VAT id (same seller disjunct as BR-S-02).

- **Requires:** An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Standard rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-20, BT-31, BT-32, BT-63, BT-95
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='S']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='S']` so that An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Standard rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Standard rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-S-04 — An Invoice with a Standard-rated (S) Document level charge (BT-102) shall contain the Seller VAT id / tax registration id / tax rep VAT id (same seller disjunct as BR-S-02).

- **Requires:** An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Standard rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-21, BT-31, BT-32, BT-63, BT-102
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='S']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='S']` so that An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Standard rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Standard rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-S-05 — In an Invoice line where the Invoiced item VAT category code (BT-151) is 'Standard rated' the Invoiced item VAT rate (BT-152) shall be greater than zero.

- **Requires:** In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Standard rated" the Invoiced item VAT rate (BT-152) shall be greater than zero.
- **Business terms:** BG-25, BT-151, BT-152
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'S'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'S'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Standard rated" the Invoiced item VAT rate (BT-152) shall be greater than zero.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Standard rated" the Invoiced item VAT rate (BT-152) shall be greater than zero.”

### BR-S-06 — In a Document level allowance where the allowance VAT category code (BT-95) is 'Standard rated' the allowance VAT rate (BT-96) shall be greater than zero.

- **Requires:** In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Standard rated" the Document level allowance VAT rate (BT-96) shall be greater than zero.
- **Business terms:** BG-20, BT-95, BT-96
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='S'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='S'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Standard rated" the Document level allowance VAT rate (BT-96) shall be greater than zero.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Standard rated" the Document level allowance VAT rate (BT-96) shall be greater than zero.”

### BR-S-07 — In a Document level charge where the charge VAT category code (BT-102) is 'Standard rated' the charge VAT rate (BT-103) shall be greater than zero.

- **Requires:** In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Standard rated" the Document level charge VAT rate (BT-103) shall be greater than zero.
- **Business terms:** BG-21, BT-102, BT-103
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='S'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='S'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Standard rated" the Document level charge VAT rate (BT-103) shall be greater than zero.
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Standard rated" the Document level charge VAT rate (BT-103) shall be greater than zero.”

### BR-S-08 — For each different value of VAT category rate (BT-119) where the VAT category code (BT-118) is "Standard rated", the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amounts (BT-131) plus document level charge amounts (BT-99) minus document level allowance amounts (BT-92) where the VAT category code is "Standard rated" and the VAT rate equals BT-119.

- **Requires:** For each different value of VAT category rate (BT-119) where the VAT category code (BT-118) is "Standard rated", the VAT category taxable amount (BT-116) in a VAT breakdown (BG-23) shall equal the sum of Invoice line net amounts (BT-131) plus the sum of document level charge amounts (BT-99) minus the sum of document level allowance amounts (BT-92) where the VAT category code (BT-151, BT-102, BT-95) is "Standard rated" and the VAT rate (BT-152, BT-103, BT-96) equals the VAT category rate (BT-119).
- **Business terms:** BG-23, BT-92, BT-95, BT-96, BT-99, BT-102, BT-103, BT-116, BT-118, BT-119, BT-131, BT-151, BT-152
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'S'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'S'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that For each different value of VAT category rate (BT-119) where the VAT category code (BT-118) is "Standard rated", the VAT category taxable amount (BT-116) in a VAT breakdown (BG-23) shall equal the sum of Invoice line net amounts (BT-131) plus the sum of document level charge amounts (BT-99) minus the sum of document level allowance amounts (BT-92) where the VAT category code (BT-151, BT-102, BT-95) is "Standard rated" and the VAT rate (BT-152, BT-103, BT-96) equals the VAT category rate (BT-119).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “For each different value of VAT category rate (BT-119) where the VAT category code (BT-118) is "Standard rated", the VAT category taxable amount (BT-116) in a VAT breakdown (BG-23) shall equal the sum of Invoice line net amounts (BT-131) plus the sum of document level charge amounts (BT-99) minus the sum of document level allowance amounts (BT-92) where the VAT category code (BT-151, BT-102, BT-95) is "Standard rated" and the VAT rate (BT-152, BT-103, BT-96) equals the VAT category rate (BT-119).”

### BR-S-09 — The VAT category tax amount (BT-117) in a Standard-rated (S) VAT breakdown shall equal the VAT category taxable amount (BT-116) x the VAT category rate (BT-119).

- **Requires:** The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where VAT category code (BT-118) is "Standard rated" shall equal the VAT category taxable amount (BT-116) multiplied by the VAT category rate (BT-119).
- **Business terms:** BG-23, BT-116, BT-117, BT-118, BT-119
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'S'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'S'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where VAT category code (BT-118) is "Standard rated" shall equal the VAT category taxable amount (BT-116) multiplied by the VAT category rate (BT-119).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where VAT category code (BT-118) is "Standard rated" shall equal the VAT category taxable amount (BT-116) multiplied by the VAT category rate (BT-119).”

### BR-S-10 — A VAT breakdown (BG-23) with a Standard rated (S) VAT category code (BT-118) shall not have a VAT exemption reason text (BT-120) or code (BT-121).

- **Requires:** A VAT breakdown (BG-23) with VAT Category code (BT-118) "Standard rate" shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).
- **Business terms:** BG-23, BT-118, BT-120, BT-121
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'S'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'S'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that A VAT breakdown (BG-23) with VAT Category code (BT-118) "Standard rate" shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “A VAT breakdown (BG-23) with VAT Category code (BT-118) "Standard rate" shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).”

## BR-Z

VAT breakdown rules for VAT category code Z.

### BR-Z-01 — If any line/allowance/charge is Zero rated (Z), the VAT breakdown must contain exactly one Zero rated category.

- **Requires:** An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Zero rated" shall contain in the VAT breakdown (BG-23) exactly one VAT category code (BT-118) equal with "Zero rated".
- **Business terms:** BG-20, BG-21, BG-23, BG-25, BT-95, BT-102, BT-118, BT-151
- **Location:** `cac:TaxCategory`
- **Fix:** Adjust the VAT breakdown at `cac:TaxCategory` so that An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Zero rated" shall contain in the VAT breakdown (BG-23) exactly one VAT category code (BT-118) equal with "Zero rated".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line (BG-25), a Document level allowance (BG-20) or a Document level charge (BG-21) where the VAT category code (BT-151, BT-95 or BT-102) is "Zero rated" shall contain in the VAT breakdown (BG-23) exactly one VAT category code (BT-118) equal with "Zero rated".”

### BR-Z-02 — A Zero-rated (Z) Invoice line (BT-151) requires the Seller VAT identifier / tax registration id / tax representative VAT id.

- **Requires:** An Invoice that contains an Invoice line where the Invoiced item VAT category code (BT-151) is "Zero rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BT-31, BT-32, BT-63, BT-151
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='Z']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[cbc:ID='Z']` so that An Invoice that contains an Invoice line where the Invoiced item VAT category code (BT-151) is "Zero rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains an Invoice line where the Invoiced item VAT category code (BT-151) is "Zero rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-Z-03 — A Zero-rated (Z) Document level allowance (BT-95) requires the Seller VAT identifier disjunct.

- **Requires:** An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Zero rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BG-20, BT-31, BT-32, BT-63, BT-95
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='Z']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='Z']` so that An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Zero rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Zero rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-Z-04 — A Zero-rated (Z) Document level charge (BT-102) requires the Seller VAT identifier disjunct.

- **Requires:** An Invoice that contains a Document level charge where the Document level charge VAT category code (BT-102) is "Zero rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Business terms:** BT-31, BT-32, BT-63, BT-102
- **Location:** `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='Z']`
- **Fix:** Adjust the VAT breakdown at `cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='Z']` so that An Invoice that contains a Document level charge where the Document level charge VAT category code (BT-102) is "Zero rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “An Invoice that contains a Document level charge where the Document level charge VAT category code (BT-102) is "Zero rated" shall contain the Seller VAT Identifier (BT-31), the Seller tax registration identifier (BT-32) and/or the Seller tax representative VAT identifier (BT-63).”

### BR-Z-05 — In a Zero-rated (Z) Invoice line the Invoiced item VAT rate (BT-152) shall be 0.

- **Requires:** In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Zero rated" the Invoiced item VAT rate (BT-152) shall be 0 (zero).
- **Business terms:** BG-25, BT-151, BT-152
- **Location:** `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'Z'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory[normalize-space(cbc:ID) = 'Z'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Zero rated" the Invoiced item VAT rate (BT-152) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is "Zero rated" the Invoiced item VAT rate (BT-152) shall be 0 (zero).”

### BR-Z-06 — In a Zero-rated (Z) Document level allowance the allowance VAT rate (BT-96) shall be 0.

- **Requires:** In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Zero rated" the Document level allowance VAT rate (BT-96) shall be 0 (zero).
- **Business terms:** BG-20, BT-95, BT-96
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='Z'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=false()]/cac:TaxCategory[normalize-space(cbc:ID)='Z'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Zero rated" the Document level allowance VAT rate (BT-96) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level allowance (BG-20) where the Document level allowance VAT category code (BT-95) is "Zero rated" the Document level allowance VAT rate (BT-96) shall be 0 (zero).”

### BR-Z-07 — In a Zero-rated (Z) Document level charge the charge VAT rate (BT-103) shall be 0.

- **Requires:** In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Zero rated" the Document level charge VAT rate (BT-103) shall be 0 (zero).
- **Business terms:** BG-21, BT-102, BT-103
- **Location:** `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='Z'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `cac:AllowanceCharge[cbc:ChargeIndicator=true()]/cac:TaxCategory[normalize-space(cbc:ID)='Z'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Zero rated" the Document level charge VAT rate (BT-103) shall be 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a Document level charge (BG-21) where the Document level charge VAT category code (BT-102) is "Zero rated" the Document level charge VAT rate (BT-103) shall be 0 (zero).”

### BR-Z-08 — The Zero-rated (Z) VAT breakdown taxable amount (BT-116) shall equal the exact sum of Z line net amounts − Z allowances + Z charges.

- **Requires:** In a VAT breakdown (BG-23) where VAT category code (BT-118) is "Zero rated" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amount (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Zero rated".
- **Business terms:** BG-23, BT-92, BT-95, BT-99, BT-102, BT-116, BT-118, BT-131, BT-151
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'Z'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'Z'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that In a VAT breakdown (BG-23) where VAT category code (BT-118) is "Zero rated" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amount (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Zero rated".
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “In a VAT breakdown (BG-23) where VAT category code (BT-118) is "Zero rated" the VAT category taxable amount (BT-116) shall equal the sum of Invoice line net amount (BT-131) minus the sum of Document level allowance amounts (BT-92) plus the sum of Document level charge amounts (BT-99) where the VAT category codes (BT-151, BT-95, BT-102) are "Zero rated".”

### BR-Z-09 — The VAT category tax amount (BT-117) in a Zero-rated (Z) VAT breakdown shall equal 0.

- **Requires:** The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where VAT category code (BT-118) is "Zero rated" shall equal 0 (zero).
- **Business terms:** BG-23, BT-117, BT-118
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'Z'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'Z'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where VAT category code (BT-118) is "Zero rated" shall equal 0 (zero).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where VAT category code (BT-118) is "Zero rated" shall equal 0 (zero).”

### BR-Z-10 — A VAT breakdown (BG-23) with a Zero rated (Z) VAT category code (BT-118) shall not have a VAT exemption reason text (BT-120) or code (BT-121).

- **Requires:** A VAT breakdown (BG-23) with VAT Category code (BT-118) "Zero rated" shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).
- **Business terms:** BG-23, BT-118, BT-120, BT-121
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'Z'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']`
- **Fix:** Adjust the VAT breakdown at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[normalize-space(cbc:ID) = 'Z'][cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']` so that A VAT breakdown (BG-23) with VAT Category code (BT-118) "Zero rated" shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).
- **Severity:** fatal
- **Provenance:** `en16931-ubl` — “A VAT breakdown (BG-23) with VAT Category code (BT-118) "Zero rated" shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).”

## BR-DE

German XRechnung national CIUS rules (KoSIT).

### BR-DE-1 — An invoice must contain PAYMENT INSTRUCTIONS (BG-16).

- **Requires:** An invoice must contain PAYMENT INSTRUCTIONS (BG-16).
- **Business terms:** BG-16
- **Location:** `cac:PaymentMeans`
- **Fix:** Add the required element at `cac:PaymentMeans`: An invoice must contain PAYMENT INSTRUCTIONS (BG-16).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Eine Rechnung (INVOICE) muss Angaben zu "PAYMENT INSTRUCTIONS" (BG-16) enthalten.”

### BR-DE-2 — SELLER CONTACT (BG-6) must be transmitted.

- **Requires:** SELLER CONTACT (BG-6) must be transmitted.
- **Business terms:** BG-6
- **Location:** `/ubl:Invoice/cac:AccountingSupplierParty`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AccountingSupplierParty`: SELLER CONTACT (BG-6) must be transmitted.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Die Gruppe "SELLER CONTACT" (BG-6) muss übermittelt werden.”

### BR-DE-3 — Seller city (BT-37) must be transmitted (non-empty).

- **Requires:** Seller city (BT-37) must be transmitted (non-empty).
- **Business terms:** BT-37
- **Location:** `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PostalAddress`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PostalAddress`: Seller city (BT-37) must be transmitted (non-empty).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "Seller city" (BT-37) muss übermittelt werden.”

### BR-DE-4 — Seller post code (BT-38) must be transmitted (non-empty).

- **Requires:** Seller post code (BT-38) must be transmitted (non-empty).
- **Business terms:** BT-38
- **Location:** `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PostalAddress`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PostalAddress`: Seller post code (BT-38) must be transmitted (non-empty).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "Seller post code" (BT-38) muss übermittelt werden.”

### BR-DE-5 — Seller contact point (BT-41) must be transmitted (non-empty).

- **Requires:** Seller contact point (BT-41) must be transmitted (non-empty).
- **Business terms:** BT-41
- **Location:** `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact`: Seller contact point (BT-41) must be transmitted (non-empty).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "Seller contact point" (BT-41) muss übermittelt werden.”

### BR-DE-6 — Seller contact telephone number (BT-42) must be transmitted.

- **Requires:** Seller contact telephone number (BT-42) must be transmitted.
- **Business terms:** BT-42
- **Location:** `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact`: Seller contact telephone number (BT-42) must be transmitted.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "Seller contact telephone number" (BT-42) muss übermittelt werden.”

### BR-DE-7 — Seller contact email address (BT-43) must be transmitted.

- **Requires:** Seller contact email address (BT-43) must be transmitted.
- **Business terms:** BT-43
- **Location:** `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact`: Seller contact email address (BT-43) must be transmitted.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "Seller contact email address" (BT-43) muss übermittelt werden.”

### BR-DE-8 — Buyer city (BT-52) must be transmitted (non-empty).

- **Requires:** Buyer city (BT-52) must be transmitted (non-empty).
- **Business terms:** BT-52
- **Location:** `/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cac:PostalAddress`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cac:PostalAddress`: Buyer city (BT-52) must be transmitted (non-empty).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "Buyer city" (BT-52) muss übermittelt werden.”

### BR-DE-9 — Buyer post code (BT-53) must be transmitted (non-empty).

- **Requires:** Buyer post code (BT-53) must be transmitted (non-empty).
- **Business terms:** BT-53
- **Location:** `/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cac:PostalAddress`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cac:PostalAddress`: Buyer post code (BT-53) must be transmitted (non-empty).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "Buyer post code" (BT-53) muss übermittelt werden.”

### BR-DE-10 — Deliver to city (BT-77) must be transmitted when DELIVER TO ADDRESS (BG-15) is present.

- **Requires:** Deliver to city (BT-77) must be transmitted when DELIVER TO ADDRESS (BG-15) is present.
- **Business terms:** BG-15, BT-77
- **Location:** `/ubl:Invoice/cac:Delivery/cac:DeliveryLocation/cac:Address`
- **Fix:** Add the required element at `/ubl:Invoice/cac:Delivery/cac:DeliveryLocation/cac:Address`: Deliver to city (BT-77) must be transmitted when DELIVER TO ADDRESS (BG-15) is present.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "Deliver to city" (BT-77) muss übermittelt werden, wenn die Gruppe "DELIVER TO ADDRESS" (BG-15) übermittelt wird.”

### BR-DE-11 — Deliver to post code (BT-78) must be transmitted when DELIVER TO ADDRESS (BG-15) is present.

- **Requires:** Deliver to post code (BT-78) must be transmitted when DELIVER TO ADDRESS (BG-15) is present.
- **Business terms:** BG-15, BT-78
- **Location:** `/ubl:Invoice/cac:Delivery/cac:DeliveryLocation/cac:Address`
- **Fix:** Add the required element at `/ubl:Invoice/cac:Delivery/cac:DeliveryLocation/cac:Address`: Deliver to post code (BT-78) must be transmitted when DELIVER TO ADDRESS (BG-15) is present.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "Deliver to post code" (BT-78) muss übermittelt werden, wenn die Gruppe "DELIVER TO ADDRESS" (BG-15) übermittelt wird.”

### BR-DE-14 — VAT category rate (BT-119) must be transmitted (non-empty) in every top-level VAT breakdown row.

- **Requires:** VAT category rate (BT-119) must be transmitted (non-empty) in every top-level VAT breakdown row.
- **Business terms:** BT-119
- **Location:** `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal`
- **Fix:** Add the required element at `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal`: VAT category rate (BT-119) must be transmitted (non-empty) in every top-level VAT breakdown row.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "VAT category rate" (BT-119) muss übermittelt werden.”

### BR-DE-15 — Buyer reference (BT-10) must be transmitted (non-empty).

- **Requires:** Buyer reference (BT-10) must be transmitted (non-empty).
- **Business terms:** BT-10
- **Location:** `cbc:BuyerReference`
- **Fix:** Add the required element at `cbc:BuyerReference`: Buyer reference (BT-10) must be transmitted (non-empty).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "Buyer reference" (BT-10) muss übermittelt werden.”

### BR-DE-16 — If VAT category codes S/Z/E/AE/K/G/L/M are used, one of Seller VAT identifier (BT-31), Seller tax registration identifier (BT-32) or SELLER TAX REPRESENTATIVE PARTY (BG-11) must be present.

- **Requires:** If VAT category codes S/Z/E/AE/K/G/L/M are used, one of Seller VAT identifier (BT-31), Seller tax registration identifier (BT-32) or SELLER TAX REPRESENTATIVE PARTY (BG-11) must be present.
- **Business terms:** BG-11, BT-31, BT-32
- **Location:** `cac:TaxRepresentativeParty`
- **Fix:** Correct `cac:TaxRepresentativeParty` so that If VAT category codes S/Z/E/AE/K/G/L/M are used, one of Seller VAT identifier (BT-31), Seller tax registration identifier (BT-32) or SELLER TAX REPRESENTATIVE PARTY (BG-11) must be present.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Wenn in einer Rechnung die Steuercodes S, Z, E, AE, K, G, L oder M verwendet werden, muss mindestens eines der Elemente "Seller VAT identifier" (BT-31), "Seller tax registration identifier" (BT-32) oder "SELLER TAX REPRESENTATIVE PARTY" (BG-11) übermittelt werden.”

### BR-DE-17 — BT-3 should be one of 326, 380, 384, 389, 381, 875, 876, 877.

- **Requires:** BT-3 should be one of 326, 380, 384, 389, 381, 875, 876, 877.
- **Business terms:** BT-3
- **Location:** `cbc:InvoiceTypeCode`
- **Fix:** Correct `cbc:InvoiceTypeCode` so that BT-3 should be one of 326, 380, 384, 389, 381, 875, 876, 877.
- **Severity:** warning
- **Provenance:** `xrechnung-ubl` — “Mit dem Element "Invoice type code" (BT-3) sollen ausschließlich folgende Codes aus der Codeliste UNTDID 1001 übermittelt werden: 326 (Partial invoice), 380 (Commercial invoice), 384 (Corrected invoice), 389 (Self-billed invoice) und 381 (Credit note),875 (Partial construction invoice), 876 (Partial final construction invoice), 877 (Final construction invoice).”

### BR-DE-18 — Skonto (cash-discount) lines in Payment terms (BT-20).

- **Requires:** Skonto (cash-discount) lines in Payment terms (BT-20).
- **Business terms:** BT-20, BT-115
- **Location:** `cac:PaymentTerms/cbc:Note`
- **Fix:** Correct `cac:PaymentTerms/cbc:Note` so that Skonto (cash-discount) lines in Payment terms (BT-20).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Skonto Zeilen in müssen diesem regulärem Ausdruck entsprechen: . Die Informationen zur Gewährung von Skonto müssen wie folgt im Element "Payment terms" (BT-20) übermittelt werden: Anzugeben ist im ersten Segment "SKONTO", im zweiten "TAGE=n", im dritten "PROZENT=n". Prozentzahlen sind ohne Vorzeichen sowie mit Punkt getrennt von zwei Nachkommastellen anzugeben. Liegt dem zu berechnenden Betrag nicht BT-115, "fälliger Betrag" zugrunde, sondern nur ein Teil des fälligen Betrags der Rechnung, ist der Grundwert zur Berechnung von Skonto als viertes Segment "BASISBETRAG=n" gemäß dem semantischen Datentypen Amount anzugeben. Jeder Eintrag beginnt mit einer #, die Segmente sind mit einer # getrennt und eine Zeile schließt mit einer # ab. Am Ende einer vollständigen Skontoangabe muss ein XML-konformer Zeilenumbruch folgen. Alle Angaben zur Gewährung von Skonto müssen in Großbuchstaben gemacht werden. Zusätzliches Whitespace (Leerzeichen, Tabulatoren oder Zeilenumbrüche) ist nicht zulässig. Andere Zeichen oder Texte als in den oberen Vorgaben genannt sind nicht zulässig.”

### BR-DE-19 — With payment means code 58 (SEPA credit transfer), BT-84 should be a correct IBAN (official regex + mod-97 transcription).

- **Requires:** with payment means code 58 (SEPA credit transfer), BT-84 should be a correct IBAN (official regex + mod-97 transcription).
- **Business terms:** BT-81, BT-84
- **Location:** `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = ('30','58')]`
- **Fix:** Correct `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = ('30','58')]` so that with payment means code 58 (SEPA credit transfer), BT-84 should be a correct IBAN (official regex + mod-97 transcription).
- **Severity:** warning
- **Provenance:** `xrechnung-ubl` — “"Payment account identifier" (BT-84) soll eine korrekte IBAN enthalten, wenn in "Payment means type code" (BT-81) mit dem Code 58 SEPA als Zahlungsmittel gefordert wird.”

### BR-DE-20 — With payment means code 59 (SEPA direct debit), BT-91 should be a correct IBAN.

- **Requires:** with payment means code 59 (SEPA direct debit), BT-91 should be a correct IBAN.
- **Business terms:** BT-81, BT-91
- **Location:** `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = '59']`
- **Fix:** Correct `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = '59']` so that with payment means code 59 (SEPA direct debit), BT-91 should be a correct IBAN.
- **Severity:** warning
- **Provenance:** `xrechnung-ubl` — “"Debited account identifier" (BT-91) soll eine korrekte IBAN enthalten, wenn in "Payment means type code" (BT-81) mit dem Code 59 SEPA als Zahlungsmittel gefordert wird.”

### BR-DE-21 — BT-24 should be the XRechnung specification identifier (CIUS, extension or CVD variant) — untrimmed string equality.

- **Requires:** BT-24 should be the XRechnung specification identifier (CIUS, extension or CVD variant) — untrimmed string equality.
- **Business terms:** BT-24
- **Location:** `cbc:CustomizationID`
- **Fix:** Correct `cbc:CustomizationID` so that BT-24 should be the XRechnung specification identifier (CIUS, extension or CVD variant) — untrimmed string equality.
- **Severity:** warning
- **Provenance:** `xrechnung-ubl` — “Das Element "Specification identifier" (BT-24) soll syntaktisch der Kennung des Standards XRechnung entsprechen.”

### BR-DE-22 — The filename attribute of all EmbeddedDocumentBinaryObject elements must be unique (across cac:AdditionalDocumentReference).

- **Requires:** the filename attribute of all EmbeddedDocumentBinaryObject elements must be unique (across cac:AdditionalDocumentReference).
- **Business terms:** — (no single business term)
- **Location:** `cac:AdditionalDocumentReference`
- **Fix:** Correct `cac:AdditionalDocumentReference` so that the filename attribute of all EmbeddedDocumentBinaryObject elements must be unique (across cac:AdditionalDocumentReference).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das "filename"-Attribut aller "EmbeddedDocumentBinaryObject"-Elemente muss eindeutig sein”

### BR-DE-23-a — Codes 30/58 (credit transfer) require CREDIT TRANSFER (BG-17).

- **Requires:** codes 30/58 (credit transfer) require CREDIT TRANSFER (BG-17).
- **Business terms:** BG-17, BT-81
- **Location:** `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = ('30','58')]`
- **Fix:** Correct `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = ('30','58')]` so that codes 30/58 (credit transfer) require CREDIT TRANSFER (BG-17).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Wenn BT-81 "Payment means type code" einen Schlüssel für Überweisungen enthält (30, 58), muss BG-17 "CREDIT TRANSFER" übermittelt werden.”

### BR-DE-23-b — Codes 30/58 forbid PAYMENT CARD (BG-18) and DIRECT DEBIT (BG-19).

- **Requires:** codes 30/58 forbid PAYMENT CARD (BG-18) and DIRECT DEBIT (BG-19).
- **Business terms:** BG-18, BG-19, BT-81
- **Location:** `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = ('30','58')]`
- **Fix:** Correct `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = ('30','58')]` so that codes 30/58 forbid PAYMENT CARD (BG-18) and DIRECT DEBIT (BG-19).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Wenn BT-81 "Payment means type code" einen Schlüssel für Überweisungen enthält (30, 58), dürfen BG-18 und BG-19 nicht übermittelt werden.”

### BR-DE-24-a — Codes 48/54/55 (card) require PAYMENT CARD INFORMATION (BG-18).

- **Requires:** codes 48/54/55 (card) require PAYMENT CARD INFORMATION (BG-18).
- **Business terms:** BG-18, BT-81
- **Location:** `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = ('48','54','55')]`
- **Fix:** Correct `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = ('48','54','55')]` so that codes 48/54/55 (card) require PAYMENT CARD INFORMATION (BG-18).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Wenn BT-81 "Payment means type code" einen Schlüssel für Kartenzahlungen enthält (48, 54, 55), muss genau BG-18 "PAYMENT CARD INFORMATION" übermittelt werden.”

### BR-DE-24-b — Codes 48/54/55 forbid CREDIT TRANSFER (BG-17) and DIRECT DEBIT (BG-19).

- **Requires:** codes 48/54/55 forbid CREDIT TRANSFER (BG-17) and DIRECT DEBIT (BG-19).
- **Business terms:** BG-17, BG-19, BT-81
- **Location:** `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = ('48','54','55')]`
- **Fix:** Correct `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = ('48','54','55')]` so that codes 48/54/55 forbid CREDIT TRANSFER (BG-17) and DIRECT DEBIT (BG-19).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Wenn BT-81 "Payment means type code" einen Schlüssel für Kartenzahlungen enthält (48, 54, 55), dürfen BG-17 und BG-19 nicht übermittelt werden.”

### BR-DE-25-a — Code 59 (direct debit) requires DIRECT DEBIT (BG-19).

- **Requires:** code 59 (direct debit) requires DIRECT DEBIT (BG-19).
- **Business terms:** BG-19, BT-81
- **Location:** `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = '59']`
- **Fix:** Correct `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = '59']` so that code 59 (direct debit) requires DIRECT DEBIT (BG-19).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Wenn BT-81 "Payment means type code" einen Schlüssel für Lastschriften enthält (59), muss genau BG-19 "DIRECT DEBIT" übermittelt werden.”

### BR-DE-25-b — Code 59 forbids CREDIT TRANSFER (BG-17) and PAYMENT CARD (BG-18).

- **Requires:** code 59 forbids CREDIT TRANSFER (BG-17) and PAYMENT CARD (BG-18).
- **Business terms:** BG-17, BG-18, BT-81
- **Location:** `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = '59']`
- **Fix:** Correct `/ubl:Invoice/cac:PaymentMeans[normalize-space(cbc:PaymentMeansCode) = '59']` so that code 59 forbids CREDIT TRANSFER (BG-17) and PAYMENT CARD (BG-18).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Wenn BT-81 "Payment means type code" einen Schlüssel für Lastschriften enthält (59), dürfen BG-17 und BG-18 nicht übermittelt werden.”

### BR-DE-26 — Type code 384 (Corrected invoice) should carry a PRECEDING INVOICE REFERENCE (BG-3).

- **Requires:** type code 384 (Corrected invoice) should carry a PRECEDING INVOICE REFERENCE (BG-3).
- **Business terms:** BG-3, BT-3
- **Location:** `cbc:InvoiceTypeCode`
- **Fix:** Correct `cbc:InvoiceTypeCode` so that type code 384 (Corrected invoice) should carry a PRECEDING INVOICE REFERENCE (BG-3).
- **Severity:** warning
- **Provenance:** `xrechnung-ubl` — “Wenn im Element "Invoice type code" (BT-3) der Code 384 (Corrected invoice) übergeben wird, soll PRECEDING INVOICE REFERENCE BG-3 mind. einmal vorhanden sein.”

### BR-DE-27 — BT-42 should contain at least three digits. Evaluated per seller Contact; an ABSENT telephone normalizes to '' and fires too.

- **Requires:** BT-42 should contain at least three digits. Evaluated per seller Contact; an ABSENT telephone normalizes to '' and fires too.
- **Business terms:** BT-42
- **Location:** `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact`
- **Fix:** Correct `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact` so that BT-42 should contain at least three digits. Evaluated per seller Contact; an ABSENT telephone normalizes to '' and fires too.
- **Severity:** warning
- **Provenance:** `xrechnung-ubl` — “In BT-42 sollen mindestens drei Ziffern enthalten sein.”

### BR-DE-28 — BT-43 should look like an email address (exactly one '@', flanked per the official regex).

- **Requires:** BT-43 should look like an email address (exactly one '@', flanked per the official regex).
- **Business terms:** BT-43
- **Location:** `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact`
- **Fix:** Correct `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact` so that BT-43 should look like an email address (exactly one '@', flanked per the official regex).
- **Severity:** warning
- **Provenance:** `xrechnung-ubl` — “In BT-43 soll genau ein @-Zeichen enthalten sein, welches nicht von einem Leerzeichen, einem Punkt, aber mindestens zwei Zeichen auf beiden Seiten flankiert werden soll. Ein Punkt sollte nicht am Anfang oder am Ende stehen.”

### BR-DE-30 — DIRECT DEBIT (BG-19) requires the Bank assigned creditor identifier (BT-90: a SEPA-scheme PartyIdentification of the seller or payee).

- **Requires:** DIRECT DEBIT (BG-19) requires the Bank assigned creditor identifier (BT-90: a SEPA-scheme PartyIdentification of the seller or payee).
- **Business terms:** BG-19, BT-90
- **Location:** `cac:PaymentMeans/cac:PaymentMandate`
- **Fix:** Correct `cac:PaymentMeans/cac:PaymentMandate` so that DIRECT DEBIT (BG-19) requires the Bank assigned creditor identifier (BT-90: a SEPA-scheme PartyIdentification of the seller or payee).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Wenn "DIRECT DEBIT" BG-19 vorhanden ist, dann muss "Bank assigned creditor identifier" BT-90 übermittelt werden.”

### BR-DE-31 — DIRECT DEBIT (BG-19) requires the Debited account identifier (BT-91).

- **Requires:** DIRECT DEBIT (BG-19) requires the Debited account identifier (BT-91).
- **Business terms:** BG-19, BT-91
- **Location:** `cac:PaymentMeans/cac:PaymentMandate`
- **Fix:** Correct `cac:PaymentMeans/cac:PaymentMandate` so that DIRECT DEBIT (BG-19) requires the Debited account identifier (BT-91).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Wenn "DIRECT DEBIT" BG-19 vorhanden ist, dann muss "Debited account identifier" BT-91 übermittelt werden.”

## BR-DE-TMP

German XRechnung national rules (BR-DE-TMP).

### BR-DE-TMP-32 — An invoice should state the delivery/service date via BT-72 (Actual delivery date), BG-14 (Invoicing period) or a BG-26 (Invoice line period) on EVERY line.

- **Requires:** an invoice should state the delivery/service date via BT-72 (Actual delivery date), BG-14 (Invoicing period) or a BG-26 (Invoice line period) on EVERY line.
- **Business terms:** BG-14, BG-26, BT-72
- **Location:** `cac:Delivery/cbc:ActualDeliveryDate`
- **Fix:** Correct `cac:Delivery/cbc:ActualDeliveryDate` so that an invoice should state the delivery/service date via BT-72 (Actual delivery date), BG-14 (Invoicing period) or a BG-26 (Invoice line period) on EVERY line.
- **Severity:** information
- **Provenance:** `xrechnung-ubl` — “Eine Rechnung sollte zur Angabe des Liefer-/Leistungsdatums entweder BT-72 "Actual delivery date", BG-14 "Invoicing period" oder in jeder Rechnungsposition BG-26 "Invoice line period" enthalten.”

## BR-DEX

German XRechnung extension-layer rules (BR-DEX).

### BR-DEX-01 — Every 'Attached Document' binary object (BT-125) must use an Extension-allowed MIME code. Context is cbc:EmbeddedDocumentBinaryObject anywhere in the document; the extra allowance over EN 8.2 is application/xml. An absent @mimeCode also fires (empty node-set).

- **Requires:** every 'Attached Document' binary object (BT-125) must use an Extension-allowed MIME code. Context is cbc:EmbeddedDocumentBinaryObject anywhere in the document; the extra allowance over EN 8.2 is application/xml. An absent @mimeCode also fires (empty node-set).
- **Business terms:** BT-125
- **Location:** `cbc:EmbeddedDocumentBinaryObject`
- **Fix:** Correct `cbc:EmbeddedDocumentBinaryObject` so that every 'Attached Document' binary object (BT-125) must use an Extension-allowed MIME code. Context is cbc:EmbeddedDocumentBinaryObject anywhere in the document; the extra allowance over EN 8.2 is application/xml. An absent @mimeCode also fires (empty node-set).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "Attached Document" (BT-125) benutzt einen nicht zulässigen MIME-Code: . Im Falle einer Extension darf zusätzlich zu der Liste der mime codes (definiert in Abschnitt 8.2, "Binary Object") der MIME-Code application/xml genutzt werden.”

### BR-DEX-02 — The 'Invoice line net amount' (BT-131) of an INVOICE LINE (BG-25) or a SUB INVOICE LINE (BG-DEX-01) should equal the sum of the directly nested SUB INVOICE LINEs' net amounts.

- **Requires:** the 'Invoice line net amount' (BT-131) of an INVOICE LINE (BG-25) or a SUB INVOICE LINE (BG-DEX-01) should equal the sum of the directly nested SUB INVOICE LINEs' net amounts.
- **Business terms:** BG-25, BG-DEX-01, BT-131
- **Location:** `cac:InvoiceLine`
- **Fix:** Add the required element at `cac:InvoiceLine`: the 'Invoice line net amount' (BT-131) of an INVOICE LINE (BG-25) or a SUB INVOICE LINE (BG-DEX-01) should equal the sum of the directly nested SUB INVOICE LINEs' net amounts.
- **Severity:** warning
- **Provenance:** `xrechnung-ubl` — “Der Wert von "Invoice line net amount" (BT-131) einer "INVOICE LINE" (BG-25) oder einer "SUB INVOICE LINE" (BG-DEX-01) soll der Summe der "Invoice line net amount" (BT-131) der direkt darunterliegenden "SUB INVOICE LINE" (BG-DEX-01) entsprechen.”

### BR-DEX-03 — A SUB INVOICE LINE (BG-DEX-01) must carry exactly one SUB INVOICE LINE VAT INFORMATION (BG-DEX-06) — i.e. its Item must have exactly one cac:ClassifiedTaxCategory. Fires if any sub-line item has 0 or >1.

- **Requires:** a SUB INVOICE LINE (BG-DEX-01) must carry exactly one SUB INVOICE LINE VAT INFORMATION (BG-DEX-06) — i.e. its Item must have exactly one cac:ClassifiedTaxCategory. Fires if any sub-line item has 0 or >1.
- **Business terms:** BG-DEX-01, BG-DEX-06
- **Location:** `cac:SubInvoiceLine/cac:Item`
- **Fix:** Add the required element at `cac:SubInvoiceLine/cac:Item`: a SUB INVOICE LINE (BG-DEX-01) must carry exactly one SUB INVOICE LINE VAT INFORMATION (BG-DEX-06) — i.e. its Item must have exactly one cac:ClassifiedTaxCategory. Fires if any sub-line item has 0 or >1.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Eine Sub Invoice Line (BG-DEX-01) muss genau eine "SUB INVOICE LINE VAT INFORMATION" (BG-DEX-06) enthalten.”

### BR-DEX-04 — Any scheme identifier on a Party identifier (cac:Party Identification/cbc:ID) must be an ISO 6523 ICD (extension) code — or 'SEPA' when the identifier belongs to the Seller or the Payee.

- **Requires:** any scheme identifier on a Party identifier (cac:Party Identification/cbc:ID) must be an ISO 6523 ICD (extension) code — or 'SEPA' when the identifier belongs to the Seller or the Payee.
- **Business terms:** — (no single business term)
- **Location:** `cac:PartyIdentification/cbc:ID[@schemeID and $isExtension]`
- **Fix:** Correct `cac:PartyIdentification/cbc:ID[@schemeID and $isExtension]` so that any scheme identifier on a Party identifier (cac:Party Identification/cbc:ID) must be an ISO 6523 ICD (extension) code — or 'SEPA' when the identifier belongs to the Seller or the Payee.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Any scheme identifier in MUST be coded using one of the ISO 6523 ICD list.”

### BR-DEX-05 — Any scheme identifier on a legal registration identifier (cac:PartyLegalEntity/cbc:CompanyID, BT-30/BT-47) must be an ISO 6523 ICD (extension) code.

- **Requires:** any scheme identifier on a legal registration identifier (cac:PartyLegalEntity/cbc:CompanyID, BT-30/BT-47) must be an ISO 6523 ICD (extension) code.
- **Business terms:** BT-30, BT-47
- **Location:** `cac:PartyLegalEntity/cbc:CompanyID[@schemeID and $isExtension]`
- **Fix:** Correct `cac:PartyLegalEntity/cbc:CompanyID[@schemeID and $isExtension]` so that any scheme identifier on a legal registration identifier (cac:PartyLegalEntity/cbc:CompanyID, BT-30/BT-47) must be an ISO 6523 ICD (extension) code.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Any scheme identifier in MUST be coded using one of the ISO 6523 ICD list.”

### BR-DEX-06 — Any scheme identifier on an item standard identifier (cac:StandardItemIdentification/cbc:ID, BT-157) must be an ISO 6523 ICD (extension) code.

- **Requires:** any scheme identifier on an item standard identifier (cac:StandardItemIdentification/cbc:ID, BT-157) must be an ISO 6523 ICD (extension) code.
- **Business terms:** BT-157
- **Location:** `cac:StandardItemIdentification/cbc:ID[@schemeID and $isExtension]`
- **Fix:** Correct `cac:StandardItemIdentification/cbc:ID[@schemeID and $isExtension]` so that any scheme identifier on an item standard identifier (cac:StandardItemIdentification/cbc:ID, BT-157) must be an ISO 6523 ICD (extension) code.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Any scheme identifier in MUST be coded using one of the ISO 6523 ICD list.”

### BR-DEX-07 — Any scheme identifier on an Endpoint identifier (cbc:Endpoint ID, BT-34/BT-49) must belong to the CEF EAS (extension) code list.

- **Requires:** any scheme identifier on an Endpoint identifier (cbc:Endpoint ID, BT-34/BT-49) must belong to the CEF EAS (extension) code list.
- **Business terms:** BT-34, BT-49
- **Location:** `cbc:EndpointID[@schemeID and $isExtension]`
- **Fix:** Correct `cbc:EndpointID[@schemeID and $isExtension]` so that any scheme identifier on an Endpoint identifier (cbc:Endpoint ID, BT-34/BT-49) must belong to the CEF EAS (extension) code list.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Any scheme identifier for an Endpoint Identifier in MUST belong to the CEF EAS code list.”

### BR-DEX-08 — Any scheme identifier on a Deliver-to location identifier (cac:DeliveryLocation/cbc:ID, BT-71) must be an ISO 6523 ICD (extension) code.

- **Requires:** any scheme identifier on a Deliver-to location identifier (cac:DeliveryLocation/cbc:ID, BT-71) must be an ISO 6523 ICD (extension) code.
- **Business terms:** BT-71
- **Location:** `cac:DeliveryLocation/cbc:ID[@schemeID and $isExtension]`
- **Fix:** Correct `cac:DeliveryLocation/cbc:ID[@schemeID and $isExtension]` so that any scheme identifier on a Deliver-to location identifier (cac:DeliveryLocation/cbc:ID, BT-71) must be an ISO 6523 ICD (extension) code.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Any scheme identifier for a Delivery location identifier in MUST be coded using one of the ISO 6523 ICD list.”

### BR-DEX-09 — Amount due for payment (BT-115) = Invoice total amount with VAT (BT-112) - Paid amount (BT-113) + Rounding amount (BT-114) + Σ Third party payment amount (BT-DEX-002).

- **Requires:** Amount due for payment (BT-115) = Invoice total amount with VAT (BT-112) - Paid amount (BT-113) + Rounding amount (BT-114) + Σ Third party payment amount (BT-DEX-002).
- **Business terms:** BT-112, BT-113, BT-114, BT-115, BT-DEX-002
- **Location:** `cac:LegalMonetaryTotal`
- **Fix:** Correct the calculated amount at `cac:LegalMonetaryTotal` so that Amount due for payment (BT-115) = Invoice total amount with VAT (BT-112) - Paid amount (BT-113) + Rounding amount (BT-114) + Σ Third party payment amount (BT-DEX-002).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Amount due for payment (BT-115) = Invoice total amount with VAT (BT-112) - Paid amount (BT-113) + Rounding amount (BT-114) + Σ Third party payment amount (BT-DEX-002).”

### BR-DEX-10 — 'Third party payment type' (BT-DEX-001, cbc:ID) must be present (non-empty) in every THIRD PARTY PAYMENT group (BG-DEX-09).

- **Requires:** 'Third party payment type' (BT-DEX-001, cbc:ID) must be present (non-empty) in every THIRD PARTY PAYMENT group (BG-DEX-09).
- **Business terms:** BG-DEX-09, BT-DEX-001
- **Location:** `/ubl:Invoice/cac:PrepaidPayment`
- **Fix:** Correct `/ubl:Invoice/cac:PrepaidPayment` so that 'Third party payment type' (BT-DEX-001, cbc:ID) must be present (non-empty) in every THIRD PARTY PAYMENT group (BG-DEX-09).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "Third party payment type" BT-DEX-001 muss übermittelt werden, wenn die Gruppe "THIRD PARTY PAYMENT" (BG-DEX-09) übermittelt wird.”

### BR-DEX-11 — 'Third party payment amount' (BT-DEX-002, cbc:PaidAmount) must be present (non-empty) in every THIRD PARTY PAYMENT group (BG-DEX-09).

- **Requires:** 'Third party payment amount' (BT-DEX-002, cbc:PaidAmount) must be present (non-empty) in every THIRD PARTY PAYMENT group (BG-DEX-09).
- **Business terms:** BG-DEX-09, BT-DEX-002
- **Location:** `/ubl:Invoice/cac:PrepaidPayment`
- **Fix:** Correct `/ubl:Invoice/cac:PrepaidPayment` so that 'Third party payment amount' (BT-DEX-002, cbc:PaidAmount) must be present (non-empty) in every THIRD PARTY PAYMENT group (BG-DEX-09).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "Third party payment amount" BT-DEX-002 muss übermittelt werden, wenn die Gruppe "THIRD PARTY PAYMENT" (BG-DEX-09) übermittelt wird.”

### BR-DEX-12 — 'Third party payment description' (BT-DEX-003, cbc:InstructionID) must be present (non-empty) in every THIRD PARTY PAYMENT group (BG-DEX-09).

- **Requires:** 'Third party payment description' (BT-DEX-003, cbc:InstructionID) must be present (non-empty) in every THIRD PARTY PAYMENT group (BG-DEX-09).
- **Business terms:** BG-DEX-09, BT-DEX-003
- **Location:** `/ubl:Invoice/cac:PrepaidPayment`
- **Fix:** Correct `/ubl:Invoice/cac:PrepaidPayment` so that 'Third party payment description' (BT-DEX-003, cbc:InstructionID) must be present (non-empty) in every THIRD PARTY PAYMENT group (BG-DEX-09).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Das Element "Third party payment description" BT-DEX-003 muss übermittelt werden, wenn die Gruppe "THIRD PARTY PAYMENT" (BG-DEX-09) übermittelt wird.”

### BR-DEX-13 — 'Third party payment amount' (BT-DEX-002) may carry at most 2 fractional digits: string-length(substring-after(cbc:PaidAmount, '.')) <= 2 (no '.' -> '' -> length 0 -> holds).

- **Requires:** 'Third party payment amount' (BT-DEX-002) may carry at most 2 fractional digits: string-length(substring-after(cbc:PaidAmount, '.')) <= 2 (no '.' -> '' -> length 0 -> holds).
- **Business terms:** BT-DEX-002
- **Location:** `/ubl:Invoice/cac:PrepaidPayment`
- **Fix:** Correct the calculated amount at `/ubl:Invoice/cac:PrepaidPayment` so that 'Third party payment amount' (BT-DEX-002) may carry at most 2 fractional digits: string-length(substring-after(cbc:PaidAmount, '.')) <= 2 (no '.' -> '' -> length 0 -> holds).
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Die maximale Anzahl zulässiger Nachkommastellen für das Element "Third party payment amount" (BT-DEX-002) ist 2.”

### BR-DEX-14 — The currency of 'Third party payment amount' (BT-DEX-002) must equal BT-5 (Invoice currency code): cbc:PaidAmount/@currencyID = parent::node()/cbc:DocumentCurrencyCode. A missing @currencyID or a missing DocumentCurrencyCode makes the node-set comparison false -> fires.

- **Requires:** the currency of 'Third party payment amount' (BT-DEX-002) must equal BT-5 (Invoice currency code): cbc:PaidAmount/@currencyID = parent::node()/cbc:DocumentCurrencyCode. A missing @currencyID or a missing DocumentCurrencyCode makes the node-set comparison false -> fires.
- **Business terms:** BT-5, BT-DEX-002
- **Location:** `/ubl:Invoice/cac:PrepaidPayment`
- **Fix:** Correct the calculated amount at `/ubl:Invoice/cac:PrepaidPayment` so that the currency of 'Third party payment amount' (BT-DEX-002) must equal BT-5 (Invoice currency code): cbc:PaidAmount/@currencyID = parent::node()/cbc:DocumentCurrencyCode. A missing @currencyID or a missing DocumentCurrencyCode makes the node-set comparison false -> fires.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Die Währungsangabe von "Third party payment amount" BT-DEX-002 muss BT-5 ("Invoice currency code") entsprechen.”

## PEPPOL-EN16931

Peppol-derived rules as vendored inside the official KoSIT XRechnung Schematron artifact — the KoSIT-vendored subset only, NOT full Peppol BIS Billing 3.0 support.

### PEPPOL-EN16931-R001 — Business process MUST be provided.

- **Requires:** Business process MUST be provided.
- **Business terms:** — (no single business term)
- **Location:** `cbc:ProfileID`
- **Fix:** Add the required element at `cbc:ProfileID`: Business process MUST be provided.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Business process MUST be provided.”

### PEPPOL-EN16931-R005 — VAT accounting currency code MUST be different from invoice currency code when provided.

- **Requires:** VAT accounting currency code MUST be different from invoice currency code when provided.
- **Business terms:** — (no single business term)
- **Location:** `cbc:TaxCurrencyCode`
- **Fix:** Correct `cbc:TaxCurrencyCode` so that VAT accounting currency code MUST be different from invoice currency code when provided.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “VAT accounting currency code MUST be different from invoice currency code when provided.”

### PEPPOL-EN16931-R008 — Document MUST not contain empty elements.

- **Requires:** Document MUST not contain empty elements.
- **Business terms:** — (no single business term)
- **Location:** `//*[not(*) and not(normalize-space())]`
- **Fix:** Correct `//*[not(*) and not(normalize-space())]` so that Document MUST not contain empty elements.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Document MUST not contain empty elements.”

### PEPPOL-EN16931-R010 — Buyer electronic address MUST be provided.

- **Requires:** Buyer electronic address MUST be provided
- **Business terms:** — (no single business term)
- **Location:** `cac:AccountingCustomerParty/cac:Party/cbc:EndpointID`
- **Fix:** Add the required element at `cac:AccountingCustomerParty/cac:Party/cbc:EndpointID`: Buyer electronic address MUST be provided.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Buyer electronic address MUST be provided”

### PEPPOL-EN16931-R020 — Seller electronic address MUST be provided.

- **Requires:** Seller electronic address MUST be provided
- **Business terms:** — (no single business term)
- **Location:** `cac:AccountingSupplierParty/cac:Party/cbc:EndpointID`
- **Fix:** Add the required element at `cac:AccountingSupplierParty/cac:Party/cbc:EndpointID`: Seller electronic address MUST be provided.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Seller electronic address MUST be provided”

### PEPPOL-EN16931-R040 — Allowance/charge amount must equal base amount * percentage/100 if base amount and percentage exists.

- **Requires:** Allowance/charge amount must equal base amount * percentage/100 if base amount and percentage exists
- **Business terms:** — (no single business term)
- **Location:** `/ubl:Invoice/cac:AllowanceCharge`
- **Fix:** Correct the calculated amount at `/ubl:Invoice/cac:AllowanceCharge` so that Allowance/charge amount must equal base amount * percentage/100 if base amount and percentage exists.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Allowance/charge amount must equal base amount * percentage/100 if base amount and percentage exists”

### PEPPOL-EN16931-R041 — Allowance/charge base amount MUST be provided when allowance/charge percentage is provided.

- **Requires:** Allowance/charge base amount MUST be provided when allowance/charge percentage is provided.
- **Business terms:** — (no single business term)
- **Location:** `/ubl:Invoice/cac:AllowanceCharge[cbc:MultiplierFactorNumeric and not(cbc:BaseAmount)]`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AllowanceCharge[cbc:MultiplierFactorNumeric and not(cbc:BaseAmount)]`: Allowance/charge base amount MUST be provided when allowance/charge percentage is provided.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Allowance/charge base amount MUST be provided when allowance/charge percentage is provided.”

### PEPPOL-EN16931-R042 — Allowance/charge percentage MUST be provided when allowance/charge base amount is provided.

- **Requires:** Allowance/charge percentage MUST be provided when allowance/charge base amount is provided.
- **Business terms:** — (no single business term)
- **Location:** `/ubl:Invoice/cac:AllowanceCharge[not(cbc:MultiplierFactorNumeric) and cbc:BaseAmount]`
- **Fix:** Add the required element at `/ubl:Invoice/cac:AllowanceCharge[not(cbc:MultiplierFactorNumeric) and cbc:BaseAmount]`: Allowance/charge percentage MUST be provided when allowance/charge base amount is provided.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Allowance/charge percentage MUST be provided when allowance/charge base amount is provided.”

### PEPPOL-EN16931-R043 — Allowance/charge ChargeIndicator value MUST equal 'true' or 'false'.

- **Requires:** Allowance/charge ChargeIndicator value MUST equal 'true' or 'false'
- **Business terms:** — (no single business term)
- **Location:** `/ubl:Invoice/cac:AllowanceCharge`
- **Fix:** Correct `/ubl:Invoice/cac:AllowanceCharge` so that Allowance/charge ChargeIndicator value MUST equal 'true' or 'false'.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Allowance/charge ChargeIndicator value MUST equal 'true' or 'false'”

### PEPPOL-EN16931-R044 — Charge on price level is NOT allowed. Only value 'false' allowed.

- **Requires:** Charge on price level is NOT allowed. Only value 'false' allowed.
- **Business terms:** — (no single business term)
- **Location:** `cac:Price/cac:AllowanceCharge`
- **Fix:** Correct `cac:Price/cac:AllowanceCharge` so that Charge on price level is NOT allowed. Only value 'false' allowed.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Charge on price level is NOT allowed. Only value 'false' allowed.”

### PEPPOL-EN16931-R046 — Item net price MUST equal (Gross price - Allowance amount) when gross price is provided.

- **Requires:** Item net price MUST equal (Gross price - Allowance amount) when gross price is provided.
- **Business terms:** — (no single business term)
- **Location:** `cac:Price/cac:AllowanceCharge`
- **Fix:** Correct the calculated amount at `cac:Price/cac:AllowanceCharge` so that Item net price MUST equal (Gross price - Allowance amount) when gross price is provided.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Item net price MUST equal (Gross price - Allowance amount) when gross price is provided.”

### PEPPOL-EN16931-R053 — Only one tax total with tax subtotals MUST be provided.

- **Requires:** Only one tax total with tax subtotals MUST be provided.
- **Business terms:** — (no single business term)
- **Location:** `cac:TaxTotal`
- **Fix:** Correct `cac:TaxTotal` so that Only one tax total with tax subtotals MUST be provided.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Only one tax total with tax subtotals MUST be provided.”

### PEPPOL-EN16931-R054 — Only one tax total without tax subtotals MUST be provided when tax currency code is provided.

- **Requires:** Only one tax total without tax subtotals MUST be provided when tax currency code is provided.
- **Business terms:** — (no single business term)
- **Location:** `cac:TaxTotal`
- **Fix:** Correct `cac:TaxTotal` so that Only one tax total without tax subtotals MUST be provided when tax currency code is provided.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Only one tax total without tax subtotals MUST be provided when tax currency code is provided.”

### PEPPOL-EN16931-R055 — Invoice total VAT amount and Invoice total VAT amount in accounting currency MUST have the same operational sign.

- **Requires:** Invoice total VAT amount and Invoice total VAT amount in accounting currency MUST have the same operational sign
- **Business terms:** — (no single business term)
- **Location:** `cac:TaxTotal/cbc:TaxAmount`
- **Fix:** Correct `cac:TaxTotal/cbc:TaxAmount` so that Invoice total VAT amount and Invoice total VAT amount in accounting currency MUST have the same operational sign.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Invoice total VAT amount and Invoice total VAT amount in accounting currency MUST have the same operational sign”

### PEPPOL-EN16931-R061 — Mandate reference MUST be provided for direct debit.

- **Requires:** Mandate reference MUST be provided for direct debit.
- **Business terms:** — (no single business term)
- **Location:** `cac:PaymentMeans[some $code in tokenize('49 59', '\s') satisfies normalize-space(cbc:PaymentMeansCode) = $code]/cac:PaymentMandate/cbc:ID`
- **Fix:** Add the required element at `cac:PaymentMeans[some $code in tokenize('49 59', '\s') satisfies normalize-space(cbc:PaymentMeansCode) = $code]/cac:PaymentMandate/cbc:ID`: Mandate reference MUST be provided for direct debit.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Mandate reference MUST be provided for direct debit.”

### PEPPOL-EN16931-R101 — Element Document reference can only be used for Invoice line object.

- **Requires:** Element Document reference can only be used for Invoice line object
- **Business terms:** — (no single business term)
- **Location:** `cac:InvoiceLine/cac:DocumentReference`
- **Fix:** Correct `cac:InvoiceLine/cac:DocumentReference` so that Element Document reference can only be used for Invoice line object.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Element Document reference can only be used for Invoice line object”

### PEPPOL-EN16931-R110 — Start date of line period MUST be within invoice period. (Line start >= document invoice-period start.)

- **Requires:** Start date of line period MUST be within invoice period.
- **Business terms:** — (no single business term)
- **Location:** `/ubl:Invoice[cac:InvoicePeriod/cbc:StartDate]/cac:InvoiceLine/cac:InvoicePeriod/cbc:StartDate`
- **Fix:** Correct `/ubl:Invoice[cac:InvoicePeriod/cbc:StartDate]/cac:InvoiceLine/cac:InvoicePeriod/cbc:StartDate` so that Start date of line period MUST be within invoice period.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Start date of line period MUST be within invoice period.”

### PEPPOL-EN16931-R111 — End date of line period MUST be within invoice period. (Line end <= document invoice-period end.)

- **Requires:** End date of line period MUST be within invoice period.
- **Business terms:** — (no single business term)
- **Location:** `/ubl:Invoice[cac:InvoicePeriod/cbc:EndDate]/cac:InvoiceLine/cac:InvoicePeriod/cbc:EndDate`
- **Fix:** Correct `/ubl:Invoice[cac:InvoicePeriod/cbc:EndDate]/cac:InvoiceLine/cac:InvoicePeriod/cbc:EndDate` so that End date of line period MUST be within invoice period.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “End date of line period MUST be within invoice period.”

### PEPPOL-EN16931-R120 — Invoice line net amount MUST equal (Invoiced quantity * (Item net price/item price base quantity) + Sum of invoice line charge amount - sum of invoice line allowance amount.

- **Requires:** Invoice line net amount MUST equal (Invoiced quantity * (Item net price/item price base quantity) + Sum of invoice line charge amount - sum of invoice line allowance amount
- **Business terms:** — (no single business term)
- **Location:** `cac:InvoiceLine/cbc:LineExtensionAmount`
- **Fix:** Correct the calculated amount at `cac:InvoiceLine/cbc:LineExtensionAmount` so that Invoice line net amount MUST equal (Invoiced quantity * (Item net price/item price base quantity) + Sum of invoice line charge amount - sum of invoice line allowance amount.
- **Severity:** warning
- **Provenance:** `xrechnung-ubl` — “Invoice line net amount MUST equal (Invoiced quantity * (Item net price/item price base quantity) + Sum of invoice line charge amount - sum of invoice line allowance amount”

### PEPPOL-EN16931-R121 — Base quantity MUST be a positive number above zero.

- **Requires:** Base quantity MUST be a positive number above zero.
- **Business terms:** — (no single business term)
- **Location:** `cac:InvoiceLine/cac:Price/cbc:BaseQuantity`
- **Fix:** Correct `cac:InvoiceLine/cac:Price/cbc:BaseQuantity` so that Base quantity MUST be a positive number above zero.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Base quantity MUST be a positive number above zero.”

### PEPPOL-EN16931-R130 — Unit code of price base quantity MUST be same as invoiced quantity.

- **Requires:** Unit code of price base quantity MUST be same as invoiced quantity.
- **Business terms:** — (no single business term)
- **Location:** `cac:Price/cbc:BaseQuantity[@unitCode]`
- **Fix:** Correct `cac:Price/cbc:BaseQuantity[@unitCode]` so that Unit code of price base quantity MUST be same as invoiced quantity.
- **Severity:** fatal
- **Provenance:** `xrechnung-ubl` — “Unit code of price base quantity MUST be same as invoiced quantity.”

