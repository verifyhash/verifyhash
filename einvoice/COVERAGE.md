# einvoice — Conformance Coverage Matrix

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with `python3 gen_coverage.py` (renders from
     coverage_matrix.json via einvoice.coverage.render_markdown).
     test_coverage_matrix.py asserts this file is byte-identical to a
     fresh render, so any manual edit will fail the gate. -->

Machine-readable enumeration of every EN 16931 / XRechnung business rule the einvoice engine actually asserts, with the syntax it is proven to fire in, its blocking severity, and the official Schematron artifact that differentially proved it. This is the artifact to read to answer "does it run the rules my German ERP needs, in my CI?" — it reflects what the CODE fires (proven by test_coverage_matrix.py against the live rule registries), not aspiration.

## Normative Schematron ground truth

Every rule below is proven equivalent to an official compiled Schematron
artifact by `differential.py`, which runs the corpus through the vendored
XSLT and compares the fired-rule set. The sources:

| key | artifact | version | license |
| --- | --- | --- | --- |
| `en16931-ubl` | CEN EN 16931 (`corpus/cen-en16931/ubl/schematron/EN16931-UBL-validation.sch`) | 1.3.16 | EUPL-1.2 |
| `en16931-cii` | CEN EN 16931 (`corpus/cen-en16931/cii/schematron/EN16931-CII-validation.sch`) | 1.3.16 | EUPL-1.2 |
| `xrechnung-ubl` | KoSIT XRechnung (`corpus/xrechnung-schematron/schematron/ubl/XRechnung-UBL-validation.sch`) | 2.5.0 (XRechnung 3.0.2) | Apache-2.0 |
| `xrechnung-cii` | KoSIT XRechnung (`corpus/xrechnung-schematron/schematron/cii/XRechnung-CII-validation.sch`) | 2.5.0 (XRechnung 3.0.2) | Apache-2.0 |

## Coverage at a glance

- **197 business rules** the engine actually asserts (this is the exact set the code fires — `test_coverage_matrix.py` proves it against the live registries).
- Syntax: **62** proven on both UBL and CII, **135** UBL-only, **0** CII-only.
- Severity (blocking class): **187** fatal (block validity), **10** warning / information (reported, non-blocking).

## Rules

`syntax` = the syntaxes the rule is *differentially proven* to fire in.
`severity` = blocking class (fatal blocks validity; warning does not).
`flag` = the raw normative Schematron flag (`information` is folded into
the non-blocking `warning` class for the severity column).

| id | syntax | severity | flag | UBL proof | CII proof | rule |
| --- | --- | --- | --- | --- | --- | --- |
| `BR-01` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall have a Specification identifier (BT-24). |
| `BR-02` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall have an Invoice number (BT-1). |
| `BR-03` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall have an Invoice issue date (BT-2). |
| `BR-04` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall have an Invoice type code (BT-3). |
| `BR-05` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall have an Invoice currency code (BT-5). |
| `BR-06` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall contain the Seller name (BT-27). |
| `BR-07` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall contain the Buyer name (BT-44). |
| `BR-08` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall contain the Seller postal address (BG-5). |
| `BR-09` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The Seller postal address (BG-5) shall contain a Seller country code (BT-40). |
| `BR-10` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall contain the Buyer postal address (BG-8). |
| `BR-11` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The Buyer postal address shall contain a Buyer country code (BT-55). |
| `BR-12` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall have the Sum of Invoice line net amount (BT-106). |
| `BR-13` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall have the Invoice total amount without VAT (BT-109). |
| `BR-14` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall have the Invoice total amount with VAT (BT-112). |
| `BR-15` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall have the Amount due for payment (BT-115). |
| `BR-16` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall have at least one Invoice line (BG-25). |
| `BR-17` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The Payee name (BT-59) shall be provided in the Invoice, if the Payee (BG-10) is different from the Seller (BG-4). |
| `BR-18` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The Seller tax representative name (BT-62) shall be provided in the Invoice, if the Seller (BG-4) has a Seller tax representative party (BG-11). |
| `BR-19` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The Seller tax representative postal address (BG-12) shall be provided in the Invoice, if the Seller (BG-4) has a Seller tax representative party (BG-11). |
| `BR-20` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The Seller tax representative postal address (BG-12) shall contain a Tax representative country code (BT-69), if the Seller (BG-4) has a Seller tax representative party (BG-11). |
| `BR-21` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Each Invoice line shall have an Invoice line identifier (BT-126). |
| `BR-22` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Each Invoice line shall have an Invoiced quantity (BT-129). |
| `BR-24` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Each Invoice line shall have an Invoice line net amount (BT-131). |
| `BR-25` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Each Invoice line (BG-25) shall contain the Item name (BT-153). |
| `BR-26` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Each Invoice line shall contain the Item net price (BT-146). |
| `BR-27` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | The Item net price (BT-146) shall NOT be negative. |
| `BR-28` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The Item gross price (BT-148) shall NOT be negative. |
| `BR-29` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | If both Invoicing period start date (BT-73) and end date (BT-74) are given then the end date shall be later or equal to the start date. |
| `BR-30` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | If both Invoice line period start date (BT-134) and end date (BT-135) are given then the end date shall be later or equal to the start date. |
| `BR-31` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Each Document level allowance (BG-20) shall have a Document level allowance amount (BT-92). |
| `BR-32` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Each Document level allowance (BG-20) shall have a Document level allowance VAT category code (BT-95). |
| `BR-33` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Each Document level allowance (BG-20) shall have a Document level allowance reason (BT-97) or a Document level allowance reason code (BT-98). |
| `BR-36` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Each Document level charge (BG-21) shall have a Document level charge amount (BT-99). |
| `BR-37` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Each Document level charge (BG-21) shall have a Document level charge VAT category code (BT-102). |
| `BR-38` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Each Document level charge (BG-21) shall have a Document level charge reason (BT-104) or a Document level charge reason code (BT-105). |
| `BR-41` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Each Invoice line allowance (BG-27) shall have an Invoice line allowance amount (BT-136). |
| `BR-42` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Each Invoice line allowance (BG-27) shall have an Invoice line allowance reason (BT-139) or an Invoice line allowance reason code (BT-140). |
| `BR-43` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Each Invoice line charge (BG-28) shall have an Invoice line charge amount (BT-141). |
| `BR-44` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Each Invoice line charge (BG-28) shall have an Invoice line charge reason (BT-144) or an Invoice line charge reason code (BT-145). |
| `BR-45` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Each VAT breakdown (BG-23) shall have a VAT category taxable amount (BT-116). |
| `BR-46` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Each VAT breakdown (BG-23) shall have a VAT category tax amount (BT-117). |
| `BR-47` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Each VAT breakdown (BG-23) shall be defined through a VAT category code (BT-118). |
| `BR-48` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Each VAT breakdown (BG-23) shall have a VAT category rate (BT-119), except if the Invoice is not subject to VAT. |
| `BR-49` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | A Payment instruction (BG-16) shall specify the Payment means type code (BT-81). |
| `BR-50` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | A Payment account identifier (BT-84) shall be present if Credit transfer (BG-17) information is provided in the Invoice. |
| `BR-51` | UBL | warning | warning | CEN EN 16931 1.3.16 | not proven | The last 4 to 6 digits of the Payment card primary account number (BT-87) shall be present if Payment card information (BG-18) is provided. |
| `BR-55` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Each Preceding Invoice reference (BG-3) shall contain a Preceding Invoice reference (BT-25). |
| `BR-57` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Each Deliver to address (BG-15) shall contain a Deliver to country code (BT-80). |
| `BR-61` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | If the Payment means type code (BT-81) means SEPA credit transfer, Local credit transfer or Non-SEPA international credit transfer, the Payment account identifier (BT-84) shall be present. |
| `BR-62` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The Seller electronic address (BT-34) shall have a Scheme identifier. |
| `BR-63` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The Buyer electronic address (BT-49) shall have a Scheme identifier. |
| `BR-CL-01` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | The document type code (BT-3) MUST be coded per UNTDID 1001. |
| `BR-CO-04` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Each Invoice line (BG-25) shall be categorized with an Invoiced item VAT category code (BT-151). |
| `BR-CO-10` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Sum of Invoice line net amount (BT-106) = Σ line net amount (BT-131). |
| `BR-CO-11` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Sum of allowances on document level (BT-107) = Σ Document level allowance amount (BT-92). |
| `BR-CO-12` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Sum of charges on document level (BT-108) = Σ Document level charge amount (BT-99). |
| `BR-CO-13` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Invoice total without VAT (BT-109) = Σ line net (BT-131) − document allowances (BT-107) + document charges (BT-108). |
| `BR-CO-14` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Invoice total VAT amount (BT-110) = Σ VAT category tax amount (BT-117). |
| `BR-CO-15` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Invoice total with VAT (BT-112) = total without VAT (BT-109) + total VAT (BT-110). |
| `BR-CO-16` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Amount due for payment (BT-115) = Invoice total with VAT (BT-112) − Paid amount (BT-113) + Rounding amount (BT-114). |
| `BR-CO-17` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | VAT category tax amount (BT-117) = VAT category taxable amount (BT-116) x (VAT category rate (BT-119) / 100), rounded to two decimals. |
| `BR-CO-18` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice shall at least have one VAT breakdown group (BG-23). |
| `BR-DEC-01` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Max 2 decimals for the Document level allowance amount (BT-92). |
| `BR-DEC-02` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Max 2 decimals for the Document level allowance base amount (BT-93). |
| `BR-DEC-05` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Max 2 decimals for the Document level charge amount (BT-99). |
| `BR-DEC-06` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Max 2 decimals for the Document level charge base amount (BT-100). |
| `BR-DEC-09` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Max 2 decimals for the Sum of Invoice line net amount (BT-106). |
| `BR-DEC-10` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Max 2 decimals for the Sum of allowances on document level (BT-107). |
| `BR-DEC-11` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Max 2 decimals for the Sum of charges on document level (BT-108). |
| `BR-DEC-12` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Max 2 decimals for the Invoice total amount without VAT (BT-109). |
| `BR-DEC-14` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Max 2 decimals for the Invoice total amount with VAT (BT-112). |
| `BR-DEC-16` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Max 2 decimals for the Paid amount (BT-113). |
| `BR-DEC-17` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Max 2 decimals for the Rounding amount (BT-114). |
| `BR-DEC-18` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Max 2 decimals for the Amount due for payment (BT-115). |
| `BR-DEC-19` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Max 2 decimals for the VAT category taxable amount (BT-116). |
| `BR-DEC-20` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Max 2 decimals for the VAT category tax amount (BT-117). |
| `BR-DEC-23` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | Max 2 decimals for the Invoice line net amount (BT-131). |
| `BR-AE-01` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | 'Reverse charge' (AE) items require exactly one AE VAT breakdown (BG-23) row. |
| `BR-AE-02` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with a Reverse charge (AE) Invoice line (BT-151) shall carry a Seller identifier AND a Buyer identifier. |
| `BR-AE-03` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with a Reverse charge (AE) Document level allowance (BT-95) shall carry a Seller identifier AND a Buyer identifier. |
| `BR-AE-04` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with a Reverse charge (AE) Document level charge (BT-102) shall carry a Seller identifier AND a Buyer identifier. |
| `BR-AE-05` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In a Reverse charge (AE) Invoice line the Invoiced item VAT rate (BT-152) shall be 0. |
| `BR-AE-06` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In a Reverse charge (AE) Document level allowance the allowance VAT rate (BT-96) shall be 0. |
| `BR-AE-07` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In a Reverse charge (AE) Document level charge the charge VAT rate (BT-103) shall be 0. |
| `BR-AE-08` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The Reverse charge (AE) VAT breakdown taxable amount (BT-116) shall equal the exact sum of AE line nets − AE allowances + AE charges. |
| `BR-AE-09` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The VAT category tax amount (BT-117) in a Reverse charge (AE) VAT breakdown shall equal 0. |
| `BR-AE-10` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | A VAT breakdown (BG-23) with a Reverse charge (AE) VAT category code (BT-118) SHALL have a VAT exemption reason code (BT-121) meaning 'Reverse charge' or the reason text (BT-120) 'Reverse charge' — the presence-required shape shared with BR-E-10. |
| `BR-E-01` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | 'Exempt from VAT' (E) items require exactly one E VAT breakdown (BG-23) row. |
| `BR-E-02` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Exempt (E) Invoice line (BT-151) requires the Seller VAT identifier / tax registration id / tax representative VAT id. |
| `BR-E-03` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Exempt (E) Document level allowance (BT-95) requires the Seller VAT identifier disjunct. |
| `BR-E-04` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Exempt (E) Document level charge (BT-102) requires the Seller VAT identifier disjunct. |
| `BR-E-05` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In an Exempt (E) Invoice line the Invoiced item VAT rate (BT-152) shall be 0. |
| `BR-E-06` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In an Exempt (E) Document level allowance the allowance VAT rate (BT-96) shall be 0. |
| `BR-E-07` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In an Exempt (E) Document level charge the charge VAT rate (BT-103) shall be 0. |
| `BR-E-08` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The Exempt (E) VAT breakdown taxable amount (BT-116) shall equal the exact sum of E line net amounts − E allowances + E charges. |
| `BR-E-09` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The VAT category tax amount (BT-117) in an Exempt (E) VAT breakdown shall equal 0. |
| `BR-E-10` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | A VAT breakdown (BG-23) with an Exempt from VAT (E) VAT category code (BT-118) SHALL have a VAT exemption reason code (BT-121) or text (BT-120) — the presence-required mirror image of BR-Z-10/BR-S-10. |
| `BR-G-01` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | 'Export outside the EU' (G) items require exactly one G VAT breakdown (BG-23) row. |
| `BR-G-02` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with an Export outside the EU (G) Invoice line (BT-151) shall carry a VAT-scoped Seller identifier (BT-31/BT-63). |
| `BR-G-03` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with an Export outside the EU (G) Document level allowance (BT-95) shall carry a VAT-scoped Seller identifier. |
| `BR-G-04` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with an Export outside the EU (G) Document level charge (BT-102) shall carry a VAT-scoped Seller identifier. |
| `BR-G-05` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In an Export outside the EU (G) Invoice line the Invoiced item VAT rate (BT-152) shall be 0. |
| `BR-G-06` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In an Export outside the EU (G) Document level allowance the allowance VAT rate (BT-96) shall be 0. |
| `BR-G-07` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In an Export outside the EU (G) Document level charge the charge VAT rate (BT-103) shall be 0. |
| `BR-G-08` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The Export outside the EU (G) VAT breakdown taxable amount (BT-116) shall equal the exact sum of G line nets − G allowances + G charges. |
| `BR-G-09` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The VAT category tax amount (BT-117) in an Export outside the EU (G) VAT breakdown shall equal 0. |
| `BR-G-10` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | A VAT breakdown (BG-23) with an Export outside the EU (G) VAT category code (BT-118) SHALL have a VAT exemption reason code (BT-121) or text (BT-120) — the presence-required shape shared with BR-E-10. |
| `BR-IC-01` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | 'Intra-community supply' (K) items require exactly one K VAT breakdown (BG-23) row. |
| `BR-IC-02` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with an Intra-community supply (K) Invoice line (BT-151) shall carry a VAT-scoped Seller identifier AND the Buyer VAT identifier. |
| `BR-IC-03` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with an Intra-community supply (K) Document level allowance (BT-95) shall carry a VAT-scoped Seller identifier AND the Buyer VAT identifier. |
| `BR-IC-04` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with an Intra-community supply (K) Document level charge (BT-102) shall carry a VAT-scoped Seller identifier AND the Buyer VAT identifier. |
| `BR-IC-05` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In an Intra-community supply (K) Invoice line the Invoiced item VAT rate (BT-152) shall be 0. |
| `BR-IC-06` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In an Intra-community supply (K) Document level allowance the allowance VAT rate (BT-96) shall be 0. |
| `BR-IC-07` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In an Intra-community supply (K) Document level charge the charge VAT rate (BT-103) shall be 0. |
| `BR-IC-08` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The Intra-community supply (K) VAT breakdown taxable amount (BT-116) shall equal the exact sum of K line nets − K allowances + K charges. |
| `BR-IC-09` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The VAT category tax amount (BT-117) in an Intra-community supply (K) VAT breakdown shall equal 0. |
| `BR-IC-11` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In an Invoice with an Intra-community supply (K) VAT breakdown (BG-23) the Actual delivery date (BT-72) or the Invoicing period (BG-14) shall not be blank. |
| `BR-IC-12` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In an Invoice with an Intra-community supply (K) VAT breakdown (BG-23) the Deliver to country code (BT-80) shall not be blank. |
| `BR-O-01` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | 'Not subject to VAT' (O) items require exactly one O VAT breakdown (BG-23) row. |
| `BR-O-02` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with a 'Not subject to VAT' (O) Invoice line (BT-151) shall NOT contain a Seller/tax-representative/Buyer VAT identifier. |
| `BR-O-03` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with a 'Not subject to VAT' (O) Document level allowance (BT-95) shall NOT contain any VAT identifier. |
| `BR-O-04` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with a 'Not subject to VAT' (O) Document level charge (BT-102) shall NOT contain any VAT identifier. |
| `BR-O-05` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | A 'Not subject to VAT' (O) Invoice line shall NOT contain an Invoiced item VAT rate (BT-152) — ``not(cbc:Percent)``. |
| `BR-O-06` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | A 'Not subject to VAT' (O) Document level allowance shall NOT contain a Document level allowance VAT rate (BT-96). |
| `BR-O-07` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | A 'Not subject to VAT' (O) Document level charge shall NOT contain a Document level charge VAT rate (BT-103). |
| `BR-O-08` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The 'Not subject to VAT' (O) VAT breakdown taxable amount (BT-116) shall equal the exact sum of O line nets − O allowances + O charges. |
| `BR-O-09` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The VAT category tax amount (BT-117) in a 'Not subject to VAT' (O) VAT breakdown shall equal 0. |
| `BR-O-10` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | A VAT breakdown (BG-23) with a 'Not subject to VAT' (O) VAT category code (BT-118) SHALL have a VAT exemption reason code (BT-121) or text (BT-120). |
| `BR-O-11` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with a 'Not subject to VAT' (O) VAT breakdown (BG-23) shall NOT contain any other VAT breakdown group. |
| `BR-O-12` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with a 'Not subject to VAT' (O) VAT breakdown (BG-23) shall NOT contain an Invoice line (BG-25) whose Invoiced item VAT category code (BT-151) is not 'Not subject to VAT'. |
| `BR-O-13` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with a 'Not subject to VAT' (O) VAT breakdown (BG-23) shall NOT contain a Document level allowance (BG-20) whose VAT category code (BT-95) is not 'Not subject to VAT'. |
| `BR-O-14` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with a 'Not subject to VAT' (O) VAT breakdown (BG-23) shall NOT contain a Document level charge (BG-21) whose VAT category code (BT-102) is not 'Not subject to VAT'. |
| `BR-S-01` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | Standard-rated (S) items and the VAT breakdown must agree. |
| `BR-S-02` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | An Invoice with a Standard-rated (S) Invoice line (BT-151) shall contain the Seller VAT Identifier (BT-31), Seller tax registration id (BT-32) and/or Seller tax representative VAT id (BT-63). |
| `BR-S-03` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with a Standard-rated (S) Document level allowance (BT-95) shall contain the Seller VAT id / tax registration id / tax rep VAT id (same seller disjunct as BR-S-02). |
| `BR-S-04` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | An Invoice with a Standard-rated (S) Document level charge (BT-102) shall contain the Seller VAT id / tax registration id / tax rep VAT id (same seller disjunct as BR-S-02). |
| `BR-S-05` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | In an Invoice line where the Invoiced item VAT category code (BT-151) is 'Standard rated' the Invoiced item VAT rate (BT-152) shall be greater than zero. |
| `BR-S-06` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In a Document level allowance where the allowance VAT category code (BT-95) is 'Standard rated' the allowance VAT rate (BT-96) shall be greater than zero. |
| `BR-S-07` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In a Document level charge where the charge VAT category code (BT-102) is 'Standard rated' the charge VAT rate (BT-103) shall be greater than zero. |
| `BR-S-09` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | The VAT category tax amount (BT-117) in a Standard-rated (S) VAT breakdown shall equal the VAT category taxable amount (BT-116) x the VAT category rate (BT-119). |
| `BR-S-10` | UBL + CII | fatal | fatal | CEN EN 16931 1.3.16 | CEN EN 16931 1.3.16 | A VAT breakdown (BG-23) with a Standard rated (S) VAT category code (BT-118) shall not have a VAT exemption reason text (BT-120) or code (BT-121). |
| `BR-Z-01` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | If any line/allowance/charge is Zero rated (Z), the VAT breakdown must contain exactly one Zero rated category. |
| `BR-Z-02` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | A Zero-rated (Z) Invoice line (BT-151) requires the Seller VAT identifier / tax registration id / tax representative VAT id. |
| `BR-Z-03` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | A Zero-rated (Z) Document level allowance (BT-95) requires the Seller VAT identifier disjunct. |
| `BR-Z-04` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | A Zero-rated (Z) Document level charge (BT-102) requires the Seller VAT identifier disjunct. |
| `BR-Z-05` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In a Zero-rated (Z) Invoice line the Invoiced item VAT rate (BT-152) shall be 0. |
| `BR-Z-06` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In a Zero-rated (Z) Document level allowance the allowance VAT rate (BT-96) shall be 0. |
| `BR-Z-07` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | In a Zero-rated (Z) Document level charge the charge VAT rate (BT-103) shall be 0. |
| `BR-Z-08` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The Zero-rated (Z) VAT breakdown taxable amount (BT-116) shall equal the exact sum of Z line net amounts − Z allowances + Z charges. |
| `BR-Z-09` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | The VAT category tax amount (BT-117) in a Zero-rated (Z) VAT breakdown shall equal 0. |
| `BR-Z-10` | UBL | fatal | fatal | CEN EN 16931 1.3.16 | not proven | A VAT breakdown (BG-23) with a Zero rated (Z) VAT category code (BT-118) shall not have a VAT exemption reason text (BT-120) or code (BT-121). |
| `BR-DE-1` | UBL + CII | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | An invoice must contain PAYMENT INSTRUCTIONS (BG-16). |
| `BR-DE-2` | UBL + CII | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | SELLER CONTACT (BG-6) must be transmitted. |
| `BR-DE-3` | UBL + CII | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | Seller city (BT-37) must be transmitted (non-empty). |
| `BR-DE-4` | UBL + CII | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | Seller post code (BT-38) must be transmitted (non-empty). |
| `BR-DE-5` | UBL + CII | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | Seller contact point (BT-41) must be transmitted (non-empty). |
| `BR-DE-6` | UBL + CII | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | Seller contact telephone number (BT-42) must be transmitted. |
| `BR-DE-7` | UBL + CII | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | Seller contact email address (BT-43) must be transmitted. |
| `BR-DE-8` | UBL + CII | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | Buyer city (BT-52) must be transmitted (non-empty). |
| `BR-DE-9` | UBL + CII | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | Buyer post code (BT-53) must be transmitted (non-empty). |
| `BR-DE-10` | UBL + CII | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | Deliver to city (BT-77) must be transmitted when DELIVER TO ADDRESS (BG-15) is present. |
| `BR-DE-11` | UBL + CII | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | Deliver to post code (BT-78) must be transmitted when DELIVER TO ADDRESS (BG-15) is present. |
| `BR-DE-14` | UBL + CII | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | VAT category rate (BT-119) must be transmitted (non-empty) in every top-level VAT breakdown row. |
| `BR-DE-15` | UBL + CII | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | Buyer reference (BT-10) must be transmitted (non-empty). |
| `BR-DE-16` | UBL + CII | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | If VAT category codes S/Z/E/AE/K/G/L/M are used, one of Seller VAT identifier (BT-31), Seller tax registration identifier (BT-32) or SELLER TAX REPRESENTATIVE PARTY (BG-11) must be present. |
| `BR-DE-17` | UBL + CII | warning | warning | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | BT-3 should be one of 326, 380, 384, 389, 381, 875, 876, 877. |
| `BR-DE-18` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | Skonto (cash-discount) lines in Payment terms (BT-20). |
| `BR-DE-19` | UBL | warning | warning | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | With payment means code 58 (SEPA credit transfer), BT-84 should be a correct IBAN (official regex + mod-97 transcription). |
| `BR-DE-20` | UBL | warning | warning | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | With payment means code 59 (SEPA direct debit), BT-91 should be a correct IBAN. |
| `BR-DE-21` | UBL + CII | warning | warning | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | BT-24 should be the XRechnung specification identifier (CIUS, extension or CVD variant) — untrimmed string equality. |
| `BR-DE-22` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | The filename attribute of all EmbeddedDocumentBinaryObject elements must be unique (across cac:AdditionalDocumentReference). |
| `BR-DE-23-a` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | Codes 30/58 (credit transfer) require CREDIT TRANSFER (BG-17). |
| `BR-DE-23-b` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | Codes 30/58 forbid PAYMENT CARD (BG-18) and DIRECT DEBIT (BG-19). |
| `BR-DE-24-a` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | Codes 48/54/55 (card) require PAYMENT CARD INFORMATION (BG-18). |
| `BR-DE-24-b` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | Codes 48/54/55 forbid CREDIT TRANSFER (BG-17) and DIRECT DEBIT (BG-19). |
| `BR-DE-25-a` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | Code 59 (direct debit) requires DIRECT DEBIT (BG-19). |
| `BR-DE-25-b` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | Code 59 forbids CREDIT TRANSFER (BG-17) and PAYMENT CARD (BG-18). |
| `BR-DE-26` | UBL + CII | warning | warning | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | Type code 384 (Corrected invoice) should carry a PRECEDING INVOICE REFERENCE (BG-3). |
| `BR-DE-27` | UBL + CII | warning | warning | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | BT-42 should contain at least three digits. Evaluated per seller Contact; an ABSENT telephone normalizes to '' and fires too. |
| `BR-DE-28` | UBL + CII | warning | warning | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | BT-43 should look like an email address (exactly one '@', flanked per the official regex). |
| `BR-DE-30` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | DIRECT DEBIT (BG-19) requires the Bank assigned creditor identifier (BT-90: a SEPA-scheme PartyIdentification of the seller or payee). |
| `BR-DE-31` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | DIRECT DEBIT (BG-19) requires the Debited account identifier (BT-91). |
| `BR-DE-TMP-32` | UBL + CII | warning | information | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | An invoice should state the delivery/service date via BT-72 (Actual delivery date), BG-14 (Invoicing period) or a BG-26 (Invoice line period) on EVERY line. |
| `BR-DEX-01` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | Every 'Attached Document' binary object (BT-125) must use an Extension-allowed MIME code. Context is cbc:EmbeddedDocumentBinaryObject anywhere in the document; the extra allowance over EN 8.2 is application/xml. An absent @mimeCode also fires (empty node-set). |
| `BR-DEX-02` | UBL | warning | warning | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | The 'Invoice line net amount' (BT-131) of an INVOICE LINE (BG-25) or a SUB INVOICE LINE (BG-DEX-01) should equal the sum of the directly nested SUB INVOICE LINEs' net amounts. |
| `BR-DEX-03` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | A SUB INVOICE LINE (BG-DEX-01) must carry exactly one SUB INVOICE LINE VAT INFORMATION (BG-DEX-06) — i.e. its Item must have exactly one cac:ClassifiedTaxCategory. Fires if any sub-line item has 0 or >1. |
| `BR-DEX-04` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | Any scheme identifier on a Party identifier (cac:Party Identification/cbc:ID) must be an ISO 6523 ICD (extension) code — or 'SEPA' when the identifier belongs to the Seller or the Payee. |
| `BR-DEX-05` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | Any scheme identifier on a legal registration identifier (cac:PartyLegalEntity/cbc:CompanyID, BT-30/BT-47) must be an ISO 6523 ICD (extension) code. |
| `BR-DEX-06` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | Any scheme identifier on an item standard identifier (cac:StandardItemIdentification/cbc:ID, BT-157) must be an ISO 6523 ICD (extension) code. |
| `BR-DEX-07` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | Any scheme identifier on an Endpoint identifier (cbc:Endpoint ID, BT-34/BT-49) must belong to the CEF EAS (extension) code list. |
| `BR-DEX-08` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | Any scheme identifier on a Deliver-to location identifier (cac:DeliveryLocation/cbc:ID, BT-71) must be an ISO 6523 ICD (extension) code. |
| `BR-DEX-09` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | Amount due for payment (BT-115) = Invoice total amount with VAT (BT-112) - Paid amount (BT-113) + Rounding amount (BT-114) + Σ Third party payment amount (BT-DEX-002). |
| `BR-DEX-10` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | 'Third party payment type' (BT-DEX-001, cbc:ID) must be present (non-empty) in every THIRD PARTY PAYMENT group (BG-DEX-09). |
| `BR-DEX-11` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | 'Third party payment amount' (BT-DEX-002, cbc:PaidAmount) must be present (non-empty) in every THIRD PARTY PAYMENT group (BG-DEX-09). |
| `BR-DEX-12` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | 'Third party payment description' (BT-DEX-003, cbc:InstructionID) must be present (non-empty) in every THIRD PARTY PAYMENT group (BG-DEX-09). |
| `BR-DEX-13` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | 'Third party payment amount' (BT-DEX-002) may carry at most 2 fractional digits: string-length(substring-after(cbc:PaidAmount, '.')) <= 2 (no '.' -> '' -> length 0 -> holds). |
| `BR-DEX-14` | UBL | fatal | fatal | KoSIT XRechnung 2.5.0 (XRechnung 3.0.2) | not proven | The currency of 'Third party payment amount' (BT-DEX-002) must equal BT-5 (Invoice currency code): cbc:PaidAmount/@currencyID = parent::node()/cbc:DocumentCurrencyCode. A missing @currencyID or a missing DocumentCurrencyCode makes the node-set comparison false -> fires. |

## Exclusions (honest scope boundaries)

Rules deliberately NOT counted as coverage, documented so the matrix is honest about its boundaries.

### Vacuous / tautological rules (never fire — not asserted)

- **BR-DEC-13** — vacuous in official Schematron (predicate references a non-existent child of cbc:TaxAmount) — never fires
- **BR-DEC-15** — vacuous in official Schematron (same defect, TaxCurrencyCode) — never fires

### Fired on UBL, not differentially proven on CII

These core rules fire and are proven on the UBL leg; the official CII
Schematron binds them differently, so they are excluded from the CII
graded set rather than approximated.

- **BR-09** — the CII binding evaluates the country-code test from the document root, firing even when the whole postal address is absent; the UBL function is gated on the address node existing, so it misses there. Address existence (BR-08) stays graded; the country code does not.
- **BR-11** — same as BR-09 for the buyer postal address country code.
- **BR-CO-14** — official CII context requires a document-currency BT-110 (ram:TaxTotalAmount) which a no-VAT CII invoice legitimately omits, so the assert never fires there; the UBL transcription would over-reject those documents.
- **BR-CO-15** — the CII binding carries an extra GrandTotalAmount = TaxBasisTotalAmount disjunct that holds for a no-VAT invoice with no BT-110; the UBL function has no such disjunct and would over-reject the same documents.
- **BR-S-01** — the CII binding is a weak one-directional count that does not flag an orphan Standard-rated breakdown; the UBL biconditional would over-fire on such CII invoices.

### German CIUS rules fired on UBL, not evaluated on CII

These BR-DE / BR-DEX rules bind CII document parts (payment-means, IBAN,
skonto grammar, attachments, the extension layer) the syntax-agnostic
core model does not carry; excluded on the CII leg, still proven on UBL.

- **BR-DE-18** — Skonto grammar in the BT-20 payment-terms free text — a structure the syntax-agnostic core model omits.
- **BR-DE-19** — IBAN mod-97 on a credit-transfer payment-means IBANID — the CII payment-means node set and IBAN digits are not in the core model.
- **BR-DE-20** — IBAN mod-97 on a payment-means IBANID — not carried by the core model (see BR-DE-19).
- **BR-DE-22** — unique attachment filename check over every EmbeddedDocumentBinaryObject/@filename — not carried.
- **BR-DE-23-a** — payment-means type-code group check keyed on SpecifiedTradeSettlementPaymentMeans TypeCode and its financial-account children — not carried.
- **BR-DE-23-b** — payment-means type-code group check keyed on SpecifiedTradeSettlementPaymentMeans TypeCode and its financial-account children — not carried.
- **BR-DE-24-a** — payment-means type-code group check (card) — not carried.
- **BR-DE-24-b** — payment-means type-code group check (card) — not carried.
- **BR-DE-25-a** — payment-means type-code group check (direct debit) — not carried.
- **BR-DE-25-b** — payment-means type-code group check (direct debit) — not carried.
- **BR-DE-30** — BT-90/BT-91 with DIRECT DEBIT (BG-19), reconstructed from mandate / creditor-reference / IBAN presence — not in the core model.
- **BR-DE-31** — BT-90/BT-91 with DIRECT DEBIT (BG-19) — not carried (see BR-DE-30).

### Peppol-only rules

The Peppol BIS Billing 3.0 CIUS layer (the PEPPOL-EN16931-* rules) is NOT shipped — that work item (T-VH.17) is not implemented, so no Peppol-only rule is asserted or claimed here. The engine covers the EN 16931 core and the German XRechnung national CIUS + extension only.

