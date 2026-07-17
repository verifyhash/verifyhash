# einvoice — 5-minute quickstart

Install the validator, run it against two committed sample invoices — one that
**passes** and one that **fails** — and read the outcome three ways: the human
summary, the process **exit code**, and the `--json` machine record. Every
command and every line of output below is real: `test_quickstart.py` parses the
commands straight out of this file and runs them against the live engine, so the
doc cannot drift from what the tool actually does.

Zero dependencies, offline, Python 3 standard library only. If you have a
checkout of this repository and `python3`, you can reproduce all of it.

The two fixtures live in the repo and are the same ones the onboarding
walkthrough uses ([`examples/README.md`](examples/README.md)):

- `examples/01-missing-fields/fixed.xml` — a real, valid XRechnung UBL invoice.
- `examples/01-missing-fields/broken.xml` — that same file with exactly two
  required things removed: the **Buyer reference** (`BT-10`) and the **SELLER
  CONTACT** group (`BG-6`).

Run everything from the `einvoice/` directory (the relative fixture paths below
assume it).

## 1. Install / invoke — two forms, one code path

**a) Straight from a bare checkout — nothing to install.** The `einvoice.py`
wrapper adds the sibling package to `sys.path`, so it runs as-is:

```sh
python3 einvoice.py validate --profile xrechnung examples/01-missing-fields/fixed.xml
```

**b) `pip install .` for the `einvoice` console script.** From the `einvoice/`
directory (the one holding `pyproject.toml`):

```sh
python3 -m pip install .
einvoice validate --profile xrechnung examples/01-missing-fields/fixed.xml
```

`pyproject.toml` declares **zero runtime dependencies** (`dependencies = []`)
and maps the console script `einvoice = einvoice.cli:main`, so `python3
einvoice.py validate …` and the installed `einvoice validate …` are the exact
same code path — `test_packaging.py` proves the two entry points agree, exit
code for exit code. Everything after this uses the checkout form so it runs with
nothing installed; drop in `einvoice` for `python3 einvoice.py` once you have
pip-installed it.

Why `--profile xrechnung`? The two missing fields are German national
(`BR-DE-*`) rules, which live in the XRechnung CIUS layer, **not** the EN 16931
core. Under the default `en16931` profile the broken file passes; the German
layer is what catches these two omissions. See the profile note in the
[CLI contract](README.md#3-install--embed--usage) (README §3).

## 2. Valid invoice → exit code 0

```sh
python3 einvoice.py validate --profile xrechnung examples/01-missing-fields/fixed.xml
```

prints the human summary and exits **0**:

```text
PASS: examples/01-missing-fields/fixed.xml (all implemented fatal rules, profile=xrechnung) — 1 non-fatal warning(s) reported
Syntax-binding warnings: 0
```

Exit **0** = "passed every implemented fatal rule." (The one non-fatal
`information` finding it mentions is advisory and never moves the exit code — see
§3.) Read the exit code straight from your shell:

```sh
python3 einvoice.py validate --profile xrechnung examples/01-missing-fields/fixed.xml; echo "exit=$?"
```

prints `exit=0` after the summary. That single integer is the whole contract a
CI gate needs.

## 3. Broken invoice → non-zero exit code, naming the rule

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

Exit **1** = "at least one implemented fatal rule failed." The human summary
shows only the *first* fatal rule; the full list (here `BR-DE-2` **and**
`BR-DE-15`, plus one advisory `information` finding) comes out under `--json`
next. The other exit codes are `2` (usage error) and `3` (not-well-formed XML) —
the full table is the [exit-code contract](README.md#cli-contract) in README §3.

## 4. Machine-readable: `--json`

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
      "severity": "fatal"
    },
    {
      "rule": "BR-DE-15",
      "message": "The element 'Buyer reference' (BT-10) must be transmitted.",
      "element": "cbc:BuyerReference",
      "severity": "fatal"
    },
    {
      "rule": "BR-DE-TMP-32",
      "message": "The invoice should state the delivery/service date: BT-72 'Actual delivery date', BG-14 'Invoicing period', or BG-26 'Invoice line period' on every line.",
      "element": "cac:Delivery/cbc:ActualDeliveryDate",
      "severity": "information"
    }
  ],
  "syntax_bindings": [],
  "syntax_binding_fatal_count": 0,
  "syntax_binding_warning_count": 0
}
```

**How to read it.** The single boolean that mirrors the exit code is `valid`:
`valid: false` ⇔ exit `1`, `valid: true` ⇔ exit `0`. It flips on **fatal**
findings only — note the valid fixture reports `valid: true` even though it has
one `information` violation, because advisory severities (`warning`,
`information`, and the whole `syntax_bindings` category) never invalidate. Each
`violations` entry carries `rule`, `message`, `element`, `severity`; filter to
`severity == "fatal"` to get exactly the findings that caused the non-zero exit.

Do not scrape the human summary; branch on the exit code (or `valid`). The
field-by-field shape of this `--json` object is documented in the
[CLI contract](README.md#cli-contract) (README §3, the **`--json` shape**
table) and [`REPORT-SCHEMA.md`](REPORT-SCHEMA.md); the richer `python3 -m einvoice.report`
document is additionally pinned by a machine-checkable JSON Schema,
[`report.schema.json`](report.schema.json) (validated against real engine output
by `test_report_schema.py`). This quickstart cross-links those rather than
restating them.

## 5. What does this build contain? `einvoice info`

Before trusting a green result, ask the tool itself what it implements:

```
python3 -m einvoice info
```

prints stable `key: value` lines (exit `0`, read-only — nothing is validated):
the package `version`, the two `profiles`, the report `formats`, the
implemented business-rule count (`rule_count`) and the syntax-binding coverage
headline, plus the `attestation_sha256` content hash from the committed
`attestation.json`. Add `--json` for one machine-readable object:

```
python3 -m einvoice info --json | python3 -c "import json,sys; print(json.load(sys.stdin)['rule_count'])"
```

Every number is read or recomputed at runtime from the same committed
artifacts the test suite asserts against — nothing in the output is a retyped
literal, so `info` cannot drift from the build it ships in.

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

## Next steps

- **Fix the invoice and re-run.** [`examples/README.md`](examples/README.md)
  walks the broken → fixed edit field by field, with the committed report next
  to each file.
- **Embed the check in your Python test suite.** A copy-paste pytest-style
  recipe (executed verbatim by `test_api_recipe.py`, no pytest required) is in
  [`API.md`](API.md) § "Embed einvoice in your test suite".
- **Gate a whole repo of invoices in CI.** The copy-paste GitHub/GitLab recipes
  and the `validate-invoices.sh` gate (fails the build naming the rule ID) are
  in [`ci/README.md`](ci/README.md) — this quickstart deliberately does not
  duplicate them.
- **Read the honest coverage limits** before trusting a green result: README §2
  and [`COVERAGE.md`](COVERAGE.md). A pass means "no *implemented* fatal rule
  fired," not "legally conformant XRechnung."
