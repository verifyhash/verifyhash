# CI conformance gate

Drop-in recipes that make a build **fail** whenever an invoice in your repo
violates an implemented EN 16931 / XRechnung rule — with the **violated rule
ID** (e.g. `BR-DE-15`) named in the job log. This is the "your invoices can
never regress below conformance" gate an ERP/billing vendor wires in once.

Honest scope first: the gate checks the validator's **implemented** rules
(43 EN 16931 core + all 32 XRechnung `BR-DE-*`; each differential-proven at
100% agreement against the official Schematron). It does **not** check the
~155 unimplemented core rules — a green gate means "no implemented rule
fired", not "legally conformant". See [`../README.md`](../README.md) §2.

## Files

| File | What it is |
|---|---|
| `validate-invoices.sh` | the gate itself — POSIX sh, zero deps beyond python3 |
| `github-actions.yml` | copy to `.github/workflows/invoice-conformance.yml` |
| `gitlab-ci.yml` | merge the job into your `.gitlab-ci.yml` |

## 60-second install (any CI)

1. **Vendor the validator** into your repo (it is not on PyPI yet — publishing
   is a deliberate not-yet): copy this product directory (the parent of
   `ci/`) to `third_party/einvoice/`, or add it as a git subtree/submodule.
2. **Install it** in the CI job — zero runtime dependencies, stdlib only:

   ```sh
   python3 -m pip install ./third_party/einvoice
   ```

   (Skippable: the gate script falls back to `python3 -m einvoice`, or set
   `EINVOICE_CMD="python3 third_party/einvoice/einvoice.py"` to run straight
   from the vendored source with no install step at all.)
3. **Run the gate** over your invoice files/fixtures:

   ```sh
   sh third_party/einvoice/ci/validate-invoices.sh invoices/
   ```

## What failure looks like

```
FAIL: invoices/2026-04-017.xml
  BR-DE-15: The element 'Buyer reference' (BT-10) must be transmitted.
  offending element: cbc:BuyerReference
conformance gate: 1/12 invoice(s) NON-CONFORMANT (profile=xrechnung) — FAIL
```

…and the job exits `1`, so the build is red until the invoice is fixed.

## Knobs

| Env var | Default | Meaning |
|---|---|---|
| `EINVOICE_PROFILE` | `xrechnung` | `xrechnung` = core + German CIUS layer; `en16931` = core only |
| `EINVOICE_CMD` | auto | override the validator command (e.g. run from vendored source) |
| `EINVOICE_ALLOW_EMPTY` | `0` | by default the gate exits `2` when it finds **no** `*.xml` — an empty gate is a broken gate |

Gate exit codes: `0` all conformant, `1` at least one non-conformant or
malformed invoice, `2` the gate itself is misconfigured (no validator, no
input). Only fatal-severity rules fail the build — warnings/information (the
official Schematron `flag` semantics) do not.
