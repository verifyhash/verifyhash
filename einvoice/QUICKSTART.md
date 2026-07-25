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

Two honest limits. First, there is no `--format` flag on this CLI (`--json`
is the only format switch), so `format = "json"` can only be reverted by
editing the config, not per-invocation; `format` here means the CLI's two
output forms (`text`/`json`), **not** the nine-name `--format` vocabulary of
`python3 -m einvoice.report`. Second, the keys never touch validation:
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
