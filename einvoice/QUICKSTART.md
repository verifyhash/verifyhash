# einvoice — 5-minute quickstart

Validate an EN 16931 / XRechnung invoice, and read the outcome three ways: the
human summary, the process **exit code**, and the `--json` machine record.

There are two entry points, one engine. Pick the one that matches how you got
here:

- **You installed the package** (`pip install verifyhash-einvoice`) — §§1–6
  below are a complete path that touches **no file from this repository**: you
  paste one small invoice, validate it, break it, read the JSON, and ask the
  build what it implements.
- **You have a checkout of this repository** — the same walk-through against
  the two committed sample invoices lives in
  [From a repository checkout](#from-a-repository-checkout) at the end. Those
  commands need `einvoice.py` and `examples/`, neither of which is in the
  published wheel.

Zero dependencies, offline, Python 3 standard library only — `pyproject.toml`
declares `dependencies = []` and that is a contract `test_packaging.py`
enforces.

Every command and every line of output below is real. `test_quickstart.py`
parses the commands straight out of this file and runs them against the live
engine; `test_doc_commands_from_wheel.py` independently re-checks that each
fenced command either resolves inside the installed wheel or sits under the
checkout section — so neither entry point can drift from what the tool does.

> **Deutsche Anleitung:** ein deutschsprachiger Schnellstart mit
> byte-identischen, paritäts-geprüften Kommandos ist
> [`QUICKSTART.de.md`](QUICKSTART.de.md).

## 1. Install it

```sh
python3 -m pip install verifyhash-einvoice
```

That puts one console script, `einvoice`, on your PATH (the distribution is
named `verifyhash-einvoice`; the import package and the command are both
`einvoice`). Nothing else is downloaded — there are no dependencies to
resolve.

Check that the install can speak for itself before you point it at anything:

```sh
einvoice info
```

It prints ten stable `key: value` lines and exits `0` without validating
anything. Three of them:

```text
formats: azure, badge, github, gitlab, html, json, junit, sarif, text
profiles: en16931, xrechnung
rule_count: 297
```

The other seven are the attestation content hash, the syntax-binding coverage
counts, and the version. §6 explains what those numbers are and how to gate a
CI job on them.

## 2. An invoice to validate

The wheel deliberately ships **only** the validator package — no sample
invoices, no test corpus, no generators. (`examples/`, the 24 MB `corpus/` of
official test documents and the test suite live in the repository; keeping them
out is why the wheel is ~350 KB against a ~80 MB source tree.) So if you do not
already have an invoice XML to hand, paste this one — a minimal but complete
XRechnung 3.0 (UBL) invoice for four hours of consulting at 19 % VAT:

```sh
cat > invoice.xml <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ID>RE-2026-0001</cbc:ID>
  <cbc:IssueDate>2026-03-02</cbc:IssueDate>
  <cbc:DueDate>2026-03-16</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>04011000-12345-03</cbc:BuyerReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="EM">rechnung@lieferant.de</cbc:EndpointID>
      <cac:PostalAddress>
        <cbc:CityName>Bonn</cbc:CityName>
        <cbc:PostalZone>53113</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>DE123456789</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Lieferant GmbH</cbc:RegistrationName>
      </cac:PartyLegalEntity>
      <cac:Contact>
        <cbc:Name>Buchhaltung</cbc:Name>
        <cbc:Telephone>+49 228 1234567</cbc:Telephone>
        <cbc:ElectronicMail>rechnung@lieferant.de</cbc:ElectronicMail>
      </cac:Contact>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cbc:EndpointID schemeID="EM">einkauf@kunde.de</cbc:EndpointID>
      <cac:PostalAddress>
        <cbc:CityName>Koeln</cbc:CityName>
        <cbc:PostalZone>50667</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Kunde AG</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:Delivery>
    <cbc:ActualDeliveryDate>2026-02-28</cbc:ActualDeliveryDate>
  </cac:Delivery>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount>
      <cbc:ID>DE79000000001234567890</cbc:ID>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>19</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">119.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">119.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="HUR">4</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>Beratungsleistung</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>19</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="EUR">25.00</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>
</Invoice>
XML
```

**Honest limits on that sample.** It is *minimal for the rules this tool
implements*, not a template to bill real customers with: the IBAN is a
non-existent test dummy, the VAT id is fake, and it carries no purchase-order
reference, no payment-terms text and no line-level allowances — all optional
under EN 16931, all things your ERP will emit. It is here so §§3–5 produce
exactly the output shown; swap in your own file the moment you have one, the
commands are unchanged.

## 3. Validate it → exit code 0

```sh
einvoice validate --profile xrechnung invoice.xml
```

```text
PASS: invoice.xml (all implemented fatal rules, profile=xrechnung)
Syntax-binding warnings: 0
```

Exit **0** = "passed every implemented fatal rule." That single integer is the
whole contract a CI gate needs — do not scrape the summary text.

**Why `--profile xrechnung`?** The default profile is `en16931`, the European
core. `xrechnung` adds the German CIUS layer on top: the `BR-DE-*` and
`BR-DEX-*` rules that German public-sector buyers actually reject on (buyer
reference, seller contact block, payment details, …). If your invoice is not
German, drop the flag — or set defaults once in a config file (§7). A pass
under `en16931` says nothing about the German layer, and that asymmetry is the
single most common surprise here.

## 4. Break it → exit 1, naming the rule

Delete the buyer reference (`BT-10`) and validate the result:

```sh
sed '/BuyerReference/d' invoice.xml > broken.xml
einvoice validate --profile xrechnung broken.xml; echo "exit=$?"
```

```text
FAIL: broken.xml
  BR-DE-15: The element 'Buyer reference' (BT-10) must be transmitted.
  offending element: cbc:BuyerReference
Syntax-binding warnings: 0
exit=1
```

Exit **1** = "at least one implemented fatal rule failed." The human summary
names only the *first* fatal rule and the element it looked for; the complete
list comes out under `--json` next. The other exit codes are `2` (usage error)
and `3` (not-well-formed XML) — the full table is
[`EXIT-CODES.md`](EXIT-CODES.md).

Note what did **not** happen: the same file under the default profile
(`einvoice validate broken.xml`) exits `0`, because `BR-DE-15` is not an
EN 16931 core rule. That is §3's asymmetry, demonstrated.

### `BR-DE-15` means nothing to you? Ask the tool

A rule id is not self-explanatory, and hunting it through the KoSIT Schematron
is a ten-minute detour. Paste it straight back at the CLI instead:

```sh
einvoice --explain BR-DE-15
```

```text
BR-DE-15  Buyer reference (BT-10) must be transmitted (non-empty).

  requires : Buyer reference (BT-10) must be transmitted (non-empty).
  BT/BG    : BT-10
  location : cbc:BuyerReference
  fix      : Add the required element at `cbc:BuyerReference`: Buyer reference (BT-10) must be transmitted (non-empty).
  severity : fatal
  source   : xrechnung-ubl (Schematron)
  assert   : Das Element "Buyer reference" (BT-10) muss übermittelt werden.
```

Read it as: **location** is the XPath-ish place in your document to look,
**fix** is the concrete edit, **BT/BG** are the EN 16931 business terms the rule
is about (searchable in the standard and in your ERP's field mapping), and
**assert** is the original normative sentence from the official Schematron —
German here, because `BR-DE-*` rules come from the KoSIT XRechnung artifact
rather than from the CEN core.

It reads no invoice and validates nothing, so it is safe to run from anywhere;
lookup is case-insensitive (`br-de-15` works). Exit `0` when the id is
catalogued, `1` when it is not — that `1` is a *lookup miss*, not a claim that
the id is invalid, since the catalog covers the rules this build can actually
fire. `python3 -m einvoice.report --explain BR-DE-15` prints the identical
block; same code path, so use whichever entry point is already in your hand.

### Not UBL? The same walk in raw CII (UN/CEFACT)

EN 16931 permits **two** syntaxes, and this validator reads both: the OASIS
UBL 2.1 `Invoice` used above, and the UN/CEFACT **Cross Industry Invoice**
(`rsm:CrossIndustryInvoice`) — XRechnung's other permitted flavour, and the
syntax every ZUGFeRD / Factur-X document carries. There is no syntax flag: the
validator dispatches on the root element's local name, and from there it is the
same rule engine, the same `--profile`, the same exit codes. Nothing in §§3–5
changes.

Here is the §2 invoice again — same four consulting hours, 400.00 net /
76.00 VAT / 476.00 gross — written as raw CII instead of UBL:

```sh
cat > cii-invoice.xml <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
    xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
    xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
    xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>RE-2026-0001</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">20260302</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>Beratungsleistung</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>100.00</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="HUR">4</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>S</ram:CategoryCode>
          <ram:RateApplicablePercent>19</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>400.00</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>04011000-12345-03</ram:BuyerReference>
      <ram:SellerTradeParty>
        <ram:Name>Lieferant GmbH</ram:Name>
        <ram:DefinedTradeContact>
          <ram:PersonName>Buchhaltung</ram:PersonName>
          <ram:TelephoneUniversalCommunication><ram:CompleteNumber>+49 228 1234567</ram:CompleteNumber></ram:TelephoneUniversalCommunication>
          <ram:EmailURIUniversalCommunication><ram:URIID>rechnung@lieferant.de</ram:URIID></ram:EmailURIUniversalCommunication>
        </ram:DefinedTradeContact>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>53113</ram:PostcodeCode>
          <ram:LineOne>Musterweg 1</ram:LineOne>
          <ram:CityName>Bonn</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:URIUniversalCommunication><ram:URIID schemeID="EM">rechnung@lieferant.de</ram:URIID></ram:URIUniversalCommunication>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE123456789</ram:ID></ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>Kunde AG</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>50667</ram:PostcodeCode>
          <ram:LineOne>Domplatz 2</ram:LineOne>
          <ram:CityName>Koeln</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:URIUniversalCommunication><ram:URIID schemeID="EM">einkauf@kunde.de</ram:URIID></ram:URIUniversalCommunication>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>
      <ram:ActualDeliverySupplyChainEvent>
        <ram:OccurrenceDateTime><udt:DateTimeString format="102">20260228</udt:DateTimeString></ram:OccurrenceDateTime>
      </ram:ActualDeliverySupplyChainEvent>
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>58</ram:TypeCode>
        <ram:PayeePartyCreditorFinancialAccount><ram:IBANID>DE79000000001234567890</ram:IBANID></ram:PayeePartyCreditorFinancialAccount>
      </ram:SpecifiedTradeSettlementPaymentMeans>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>76.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>400.00</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>19</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>400.00</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>400.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">76.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>476.00</ram:GrandTotalAmount>
        <ram:DuePayableAmount>476.00</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
XML
```

```sh
einvoice validate --profile xrechnung cii-invoice.xml
```

```text
PASS: cii-invoice.xml (all implemented fatal rules, profile=xrechnung)
Syntax-binding warnings: 0
```

Exit **0** — the identical contract §3 describes, on the other syntax. Break
it the identical way and the identical rule fires:

```sh
sed '/BuyerReference/d' cii-invoice.xml > cii-broken.xml
einvoice validate --profile xrechnung cii-broken.xml; echo "exit=$?"
```

```text
FAIL: cii-broken.xml
  BR-DE-15: The element 'Buyer reference' (BT-10) must be transmitted.
  offending element: ram:ApplicableHeaderTradeAgreement/ram:BuyerReference
Syntax-binding warnings: 0
exit=1
```

The **rule id is syntax-independent** (`BR-DE-15` either way) but the
`offending element` is not: CII reports
`ram:ApplicableHeaderTradeAgreement/ram:BuyerReference` where UBL reported
`cbc:BuyerReference`. Key a CI dashboard on the rule id, never on the element
path, if you validate both syntaxes.

**Honest limits on this sample.** Like the UBL one it is minimal for the rules
*this build implements*, not a billing template: fake IBAN and VAT id, no
order reference, no payment terms, no line-level allowances. It is also
deliberately *dense* — every element in it is there to clear a specific
XRechnung requirement (`ram:GuidelineSpecifiedDocumentContextParameter/ram:ID`
for `BR-DE-21`, the `ram:DefinedTradeContact` block for `BR-DE-2`/`5`/`6`/`7`,
the `ram:ActualDeliverySupplyChainEvent` date for `BR-DE-TMP-32`), so deleting
almost any line moves it from exit `0` to exit `1`. That is the point: it is a
probe, not a starting template. `test_json_surface_parity.py` re-validates
this exact block out of this file against the installed wheel, so if the
engine ever stopped passing it, that test would go red rather than this page
going quietly wrong.

**PDFs (ZUGFeRD / Factur-X) are the same CII, wrapped.** A hybrid
PDF/A-3 invoice carries this very `rsm:CrossIndustryInvoice` XML as an
embedded attachment; `einvoice validate` does not open PDFs (it tells you so
and names the route), so hand the container to
`python3 -m einvoice.report <invoice.pdf>` instead — it extracts the
attachment with the stdlib and runs the same rules, plus the
`FX-CONTAINER-*` container-declaration checks.

## 5. Machine-readable: `--json`

```sh
einvoice validate --json --profile xrechnung broken.xml
```

emits the full result on stdout (exit code still **1**):

```json
{
  "source": "broken.xml",
  "valid": false,
  "violation_count": 1,
  "violations": [
    {
      "rule": "BR-DE-15",
      "message": "The element 'Buyer reference' (BT-10) must be transmitted.",
      "element": "cbc:BuyerReference",
      "severity": "fatal",
      "field": "cbc:BuyerReference",
      "title": "Buyer reference (BT-10) must be transmitted (non-empty).",
      "fix_hint": "Add the required element at `cbc:BuyerReference`: Buyer reference (BT-10) must be transmitted (non-empty).",
      "terms": [
        "BT-10"
      ],
      "location": "cbc:BuyerReference"
    }
  ],
  "syntax_bindings": [],
  "syntax_binding_fatal_count": 0,
  "syntax_binding_warning_count": 0
}
```

**How to read it.** The single boolean that mirrors the exit code is `valid`:
`valid: false` ⇔ exit `1`, `valid: true` ⇔ exit `0`. It flips on **fatal**
findings only — a document can carry `warning` / `information` violations, and
the whole `syntax_bindings` category, and still report `valid: true`. Each
`violations` entry carries `rule`, `message`, `element`, `severity`; filter to
`severity == "fatal"` to get exactly the findings that caused the non-zero
exit. Branch on the exit code or on `valid`, never on the summary text.

**The remediation half.** Every entry also carries `field` (the same XPath-ish
element as `element`, under the name the `python3 -m einvoice.report` document
uses — both are always present and always equal, so one parser reads either
surface) plus four fields relayed from the committed
[`remediation_catalog.json`](remediation_catalog.json): `title` (the rule
restated in one line), `fix_hint` (what to change), `terms` (the BT/BG business
terms the rule touches, e.g. `["BT-10"]`), and `location` (the XML location the
official Schematron rule is anchored at). That is the difference between a CI
log saying `BR-DE-15 failed` and one saying *add `cbc:BuyerReference`*. Caveat,
so you can code defensively: a rule the catalog does not cover emits all four
keys with `null` / `[]` values — the keys are never absent, but the values can
be empty, and `terms` is `[]` for rules that are not term-scoped. The wording is
derived from the official Schematron, not written by us, so it is terse and
normative rather than tutorial.

The field-by-field shape of this object is documented in the
[CLI contract](README.md#cli-contract) (README §3, the **`--json` shape**
table) and [`REPORT-SCHEMA.md`](REPORT-SCHEMA.md); the richer `python3 -m einvoice.report`
document is additionally pinned by a machine-checkable JSON Schema,
[`report.schema.json`](report.schema.json) (validated against real engine output
by `test_report_schema.py`). This quickstart cross-links those rather than
restating them.

### The other eight formats: `--format <fmt>`

`--json` is the boolean spelling of one format. The same `einvoice` binary emits
all nine that `einvoice info` advertises, via `--format <fmt>` (or
`--format=<fmt>`) on `validate` and `validate-batch`:

```sh
einvoice validate --format sarif invoice.xml > results.sarif
einvoice validate --format=github invoice.xml            # ::error annotations
einvoice validate-batch --format junit invoices/ > junit.xml
```

The nine names are `json`, `junit`, `sarif`, `gitlab`, `github`, `azure`,
`html`, `badge`, `text` — the exact list `einvoice info --json` returns under
`formats`, read from the same registry, so what the tool advertises is what it
accepts. `--format json` is an **exact alias** for `--json` (same code path,
byte-identical output) and `--format text` is the default human summary, so
adding the flag changes nothing you already rely on. The most common CI use is
the first line above: GitHub code scanning ingests a SARIF file directly, and
this is the ergonomics half of what you are paying for over the free official
KoSIT validator.

Three honest limits, all measured:

- **`validate-batch` takes only `json`, `junit`, `text`.** The other six describe
  ONE invoice — a SARIF run over one artifact, one Code-Quality array, one HTML
  page, one badge — so a directory under those is a usage error (`2`) that names
  the per-file command rather than inventing an aggregate shape.
- **Watch the profile when you compare entry points.** `einvoice validate`
  defaults to `--profile en16931`; the sibling `python3 -m einvoice.report`
  defaults to `xrechnung`. On `examples/01-missing-fields/broken.xml` that is the
  difference between `PASS`/exit `0` and 2 fatals (`BR-DE-2`, `BR-DE-15`)/exit
  `1`. `--format` does **not** change which profile grades the invoice: the
  console script keeps its own `en16931` default, so pass `--profile` explicitly
  whenever the two surfaces must agree.
- **`--quiet` and `--lang` do nothing to a machine format.** The document *is*
  the output (there is no human summary to suppress) and `--lang de` only ever
  swapped the displayed summary string — exactly as both behave with `--json`.

The sibling `python3 -m einvoice.report --format <fmt> <invoice.xml>` entry point
still exists and still works; it remains the only place `--baseline` (fail only
on a *new* fatal vs a stored baseline), `--pretty`, `--recurse` and the
Factur-X/ZUGFeRD PDF route live. For the seven delegated formats both surfaces
call the same emitter, so those bodies are byte-identical for the same invoice
and profile (measured). The two `json` documents and the two `text` summaries are
*not* interchangeable — each surface keeps its own long-standing shape, and
`--format` deliberately changes neither. Format-by-format details —
including how an unsupported PDF container appears in each — are in
[`REPORT-FORMATS.md`](REPORT-FORMATS.md); the exit-code contract with `--format`
set is in [`EXIT-CODES.md`](EXIT-CODES.md).

## 6. What does this build contain? `einvoice info`

Before trusting a green result, ask the tool itself what it implements:

```
python3 -m einvoice info
```

prints stable `key: value` lines (exit `0`, read-only — nothing is validated):
the package `version`, the two `profiles`, the report `formats`, the
implemented business-rule count (`rule_count`) and the syntax-binding coverage
headline, plus the `attestation_sha256` content hash from the packaged
`attestation.json`. `einvoice info` and `python3 -m einvoice info` are the same
entry point. Add `--json` for one machine-readable object:

```
python3 -m einvoice info --json | python3 -c "import json,sys; print(json.load(sys.stdin)['rule_count'])"
```

Every number is read or recomputed at runtime from the same committed
artifacts the test suite asserts against — nothing in the output is a retyped
literal, so `info` cannot drift from the build it ships in. (`attestation.json`
travels *inside* the wheel for exactly this reason: an installed copy can prove
its own claim without the repository — `test_wheel_self_report.py` pins that.)

### Fail fast if the installed build lacks what you need

`info --json` composes into a CI capability gate: drop one line in front of
your validate step, and the job stops there — before any invoice is touched —
if the installed build does not implement a profile or report format the rest
of the pipeline depends on. The canonical form is pure python3 stdlib, the
same zero-dependency footprint as the tool itself:

```
python3 -m einvoice info --json | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'xrechnung' in d['profiles'] and 'sarif' in d['formats']"
```

Exit `0` when both capabilities are present. A failed `assert` — or a broken
`info` invocation feeding the pipe — exits non-zero, so any CI runner fails
the step. The checkable ids are exactly the strings `info --json` prints under
`profiles` and `formats` (this build: `en16931`/`xrechnung`, and the nine
formats including `sarif` and `junit`); requiring an id the build does not
claim — say a `peppol` profile — fails the same way, which is the point.
`test_ci_capability_recipe.py` extracts this exact command from this file and
runs it, present and absent case both, so the recipe cannot drift from the
build.

Optional alternative, only if your CI image already ships `jq` (it is **not**
required and not a dependency of this tool):

```
python3 -m einvoice info --json | jq -e '(.profiles | index("xrechnung")) and (.formats | index("sarif"))' > /dev/null
```

## 7. Project-wide defaults: the `[tool.einvoice]` config file

Typing `--profile`-adjacent flags on every invocation gets old in a repo where
every invoice is, say, XRechnung-bound and CI wants strict JSON. The CLI
accepts opt-in **defaults** for exactly three keys — `format`, `fail-on`,
`lang` — from a config file, resolved once at startup:

1. `.einvoice.toml` in the **current working directory** (keys at the top
   level, no table header). If this file exists it **wins outright** — the
   `pyproject.toml` table below is not even read.
2. else the `[tool.einvoice]` table in `./pyproject.toml`:

```toml
[tool.einvoice]
format = "json"       # "text" (default) | "json" — as if --json were passed
fail-on = "warning"   # "fatal" (default) | "warning" | "information"
lang = "de"           # "en" (default) | "de"
```

Precedence is strict: **explicit CLI flag > config file > built-in default**.
So with the table above, `einvoice validate --fail-on=fatal invoice.xml` still
uses `fatal` — a flag on the command line always beats the file. With no
config file at all, nothing changes: the defaults are byte-identical to a
build without this feature.

**Config discovery is current-working-directory only — no parent-directory
search.** Both files are looked up in the current working directory *alone*.
Unlike git (which walks up the tree from the cwd hunting for a `.git`), or tools
like ESLint/Prettier that climb parent folders for a config, einvoice never
looks above the directory you run it from: a `.einvoice.toml` (or a
`pyproject.toml` `[tool.einvoice]` table) sitting in a **parent** directory is
**not** discovered when you invoke the CLI from a child subdirectory — you get
the built-in defaults, exactly as if no config existed. Put the config file in
the directory you actually run `einvoice` from. When **both** files are present
in that one directory, `.einvoice.toml` takes **precedence** over
`pyproject.toml` (the `[tool.einvoice]` table is not even read).

Two honest limits. First, the config `format` key accepts only the CLI's two
output forms (`text`/`json`), **not** the full nine-name `--format` vocabulary:
a config key is a project-wide default that also applies to `info` and
`receipt --verify`, where a SARIF or HTML body would be meaningless. The richer
formats are a per-invocation choice, so they live on the `--format` flag only —
and because that flag exists (see §5), a `format = "json"` default *can* now be
overridden per invocation with `--format text`. Second, the keys never touch
validation:
`fail-on` moves only the exit-code threshold and `lang` only the human
message text — findings, `--json` payloads and rule results are identical
with and without a config file.

Misconfiguration is never silently swallowed: an unknown key (`formt = ...`)
or a non-string value exits `2` with one `error:` line naming the bad key,
the file, and the accepted set (`fail-on, format, lang`); an invalid value
(`lang = "fr"`) errors exactly like the equivalent bad flag (`--lang=fr`) —
same message, same exit `2` (see [`EXIT-CODES.md`](EXIT-CODES.md)). Every
clause above is pinned by `test_config_file.py` against the live CLI.

**See what actually resolved — `einvoice --show-config`.** Because precedence
mixes three sources (flag, config file, default) it is easy to lose track of
which one won. `--show-config` is a read-only dry run that resolves `format`,
`fail-on` and `lang` exactly as a real `validate` run would and prints each
with its **source** — then exits `0` without reading any invoice or running a
single rule (like `info`, it writes only stdout, nothing on stderr):

```
$ einvoice --show-config          # in a dir with the config above
format: json (source: pyproject.toml)
fail-on: warning (source: pyproject.toml)
lang: de (source: pyproject.toml)

$ einvoice --fail-on=fatal --show-config
format: json (source: pyproject.toml)
fail-on: fatal (source: flag)          # the flag won for THIS key only
lang: de (source: pyproject.toml)      # the sibling config value survives
```

With no config file present all three report `source: default` and the
historical values (`text` / `fatal` / `en`). The value **and** its source come
from the same resolution code the real run uses — there is no second copy of the
precedence rule to drift — and a misconfigured file still errors `2` here, just
as a real run would. Pinned by `test_show_config.py`.

## From a repository checkout

**Everything in this section needs a repository checkout.** The commands below
name `einvoice.py` and files under `examples/`, and **neither ships in the
`verifyhash-einvoice` wheel** — the published package is the validator only. If
you arrived from PyPI and want to run these, clone
`github.com/verifyhash/verifyhash` first; otherwise §§1–6 above are your path.

Run everything in this section from the `einvoice/` directory (the relative
fixture paths assume it). The two fixtures are the same ones the onboarding
walkthrough uses ([`examples/README.md`](examples/README.md)):

- `examples/01-missing-fields/fixed.xml` — a real, valid XRechnung UBL invoice
  (provenance: a KoSIT XRechnung test document).
- `examples/01-missing-fields/broken.xml` — that same file with exactly two
  required things removed: the **Buyer reference** (`BT-10`) and the **SELLER
  CONTACT** group (`BG-6`).

### Two ways to invoke, one code path

**a) Straight from the bare checkout — nothing to install.** The `einvoice.py`
wrapper adds the sibling package to `sys.path`, so it runs as-is:

```sh
python3 einvoice.py validate --profile xrechnung examples/01-missing-fields/fixed.xml
```

**b) `pip install .` for the `einvoice` console script.** From the `einvoice/`
directory (the one holding `pyproject.toml`) — this installs the *checkout*,
not the PyPI release, which is what you want when testing local edits:

```sh
python3 -m pip install .
einvoice validate --profile xrechnung examples/01-missing-fields/fixed.xml
```

`pyproject.toml` maps the console script `einvoice = einvoice.cli:main`, so
`python3 einvoice.py validate …` and the installed `einvoice validate …` are
the exact same code path — `test_packaging.py` proves the two entry points
agree, exit code for exit code. The rest of this section uses the wrapper form
so it runs with nothing installed.

Why `--profile xrechnung` here? The two missing fields are German national
(`BR-DE-*`) rules, which live in the XRechnung CIUS layer, **not** the EN 16931
core. Under the default `en16931` profile the broken file passes; the German
layer is what catches these two omissions. See the profile note in the
[CLI contract](README.md#3-install--embed--usage) (README §3).

### Valid fixture → exit code 0

```sh
python3 einvoice.py validate --profile xrechnung examples/01-missing-fields/fixed.xml
```

prints the human summary and exits **0**:

```text
PASS: examples/01-missing-fields/fixed.xml (all implemented fatal rules, profile=xrechnung) — 1 non-fatal warning(s) reported
Syntax-binding warnings: 0
```

The one non-fatal `information` finding it mentions is advisory and never moves
the exit code. (That fixture states no delivery date; the §2 sample above does,
which is why its summary carries no warning tail.) Read the exit code straight
from your shell:

```sh
python3 einvoice.py validate --profile xrechnung examples/01-missing-fields/fixed.xml; echo "exit=$?"
```

prints `exit=0` after the summary.

### Broken fixture → non-zero exit code, naming the rule

```sh
python3 einvoice.py validate --profile xrechnung examples/01-missing-fields/broken.xml
```

exits **1** and prints the first fatal rule it hit — **`BR-DE-2`** — with the
offending element:

```text
FAIL: examples/01-missing-fields/broken.xml
  BR-DE-2: The group 'SELLER CONTACT' (BG-6) must be transmitted.
  offending element: cac:AccountingSupplierParty/cac:Party/cac:Contact
Syntax-binding warnings: 0
```

The full list (here `BR-DE-2` **and** `BR-DE-15`, plus one advisory
`information` finding) comes out under `--json`:

```sh
python3 einvoice.py validate --json --profile xrechnung examples/01-missing-fields/broken.xml
```

emits the full result on stdout (exit code still **1**):

```json
{
  "source": "examples/01-missing-fields/broken.xml",
  "valid": false,
  "violation_count": 3,
  "violations": [
    {
      "rule": "BR-DE-2",
      "message": "The group 'SELLER CONTACT' (BG-6) must be transmitted.",
      "element": "cac:AccountingSupplierParty/cac:Party/cac:Contact",
      "severity": "fatal",
      "field": "cac:AccountingSupplierParty/cac:Party/cac:Contact",
      "title": "SELLER CONTACT (BG-6) must be transmitted.",
      "fix_hint": "Add the required element at `/ubl:Invoice/cac:AccountingSupplierParty`: SELLER CONTACT (BG-6) must be transmitted.",
      "terms": [
        "BG-6"
      ],
      "location": "/ubl:Invoice/cac:AccountingSupplierParty"
    },
    {
      "rule": "BR-DE-15",
      "message": "The element 'Buyer reference' (BT-10) must be transmitted.",
      "element": "cbc:BuyerReference",
      "severity": "fatal",
      "field": "cbc:BuyerReference",
      "title": "Buyer reference (BT-10) must be transmitted (non-empty).",
      "fix_hint": "Add the required element at `cbc:BuyerReference`: Buyer reference (BT-10) must be transmitted (non-empty).",
      "terms": [
        "BT-10"
      ],
      "location": "cbc:BuyerReference"
    },
    {
      "rule": "BR-DE-TMP-32",
      "message": "The invoice should state the delivery/service date: BT-72 'Actual delivery date', BG-14 'Invoicing period', or BG-26 'Invoice line period' on every line.",
      "element": "cac:Delivery/cbc:ActualDeliveryDate",
      "severity": "information",
      "field": "cac:Delivery/cbc:ActualDeliveryDate",
      "title": "An invoice should state the delivery/service date via BT-72 (Actual delivery date), BG-14 (Invoicing period) or a BG-26 (Invoice line period) on EVERY line.",
      "fix_hint": "Correct `cac:Delivery/cbc:ActualDeliveryDate` so that an invoice should state the delivery/service date via BT-72 (Actual delivery date), BG-14 (Invoicing period) or a BG-26 (Invoice line period) on EVERY line.",
      "terms": [
        "BG-14",
        "BG-26",
        "BT-72"
      ],
      "location": "cac:Delivery/cbc:ActualDeliveryDate"
    }
  ],
  "syntax_bindings": [],
  "syntax_binding_fatal_count": 0,
  "syntax_binding_warning_count": 0
}
```

Note the third entry: `valid` is `false` because of the two **fatal** rows, and
would still be `true` if only the `information` row were present — the same
severity contract §5 describes, on a document that actually exercises it.

## Next steps

- **Fix the invoice and re-run.** [`examples/README.md`](examples/README.md)
  walks the broken → fixed edit field by field, with the committed report next
  to each file (repository checkout).
- **Embed the check in your Python test suite.** A copy-paste pytest-style
  recipe (executed verbatim by `test_api_recipe.py`, no pytest required) is in
  [`API.md`](API.md) § "Embed einvoice in your test suite".
- **Gate a whole repo of invoices in CI.** The copy-paste GitHub/GitLab recipes
  and the `validate-invoices.sh` gate (fails the build naming the rule ID) are
  in [`ci/README.md`](ci/README.md) — this quickstart deliberately does not
  duplicate them.
- **Or gate your CI in one step (GitHub only).** The committed composite
  GitHub Action in this repo packages the same gate as a single pinnable step —
  `uses: verifyhash/verifyhash/einvoice/action@<ref>` — with nothing to
  install (the zero-dependency validator travels inside the pinned ref) and
  SARIF upload for inline PR annotations. Inputs, `fail-on` semantics, and the
  full workflow are in [`action/README.md`](action/README.md). (Referenced by
  in-repo path as shown; it is not a Marketplace listing.)
- **Read the honest coverage limits** before trusting a green result: README §2
  and [`COVERAGE.md`](COVERAGE.md). A pass means "no *implemented* fatal rule
  fired," not "legally conformant XRechnung."
