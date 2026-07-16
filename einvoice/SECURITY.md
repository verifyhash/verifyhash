# Security, provenance & supply chain — `verifyhash-einvoice`

This note is for a B2B evaluator deciding whether to embed the einvoice
validator inside their product or run it in their own infrastructure. It
describes the supply-chain posture of **one artifact only**: the
`verifyhash-einvoice` Python package (the pure-Python `einvoice` package
declared in [`pyproject.toml`](pyproject.toml)). It does **not** cover the
separate `verifyhash` / `verify-vh` npm packages elsewhere in this repo — those
have their own toolchain and are out of scope here.

## Zero third-party runtime dependencies

The package imports the Python **standard library only**. Its
`pyproject.toml` declares `dependencies = []`, and that emptiness is a
contract, not an accident:

- **`test_packaging.py`** asserts `dependencies` stays `[]` and that the
  package installs and validates an invoice from a clean temp directory with
  no corpus and no repo present.
- The committed **CycloneDX 1.5** SBOM at [`sbom/bom.json`](sbom/bom.json)
  records the same fact in machine-readable form: its `components` array is
  empty and the root component's dependency edge (`dependencies[0].dependsOn`)
  is empty. **`test_sbom.py`** cross-checks the SBOM against
  `pyproject.toml` so the two sources cannot silently diverge, and runs
  `gen_sbom.py --check` to guarantee the committed SBOM is not stale.

Zero runtime dependencies means there is no transitive dependency tree to
audit, no third-party package that can be yanked or compromised upstream, and
no version-resolution surprise at install time.

## Software Bill of Materials (SBOM)

The SBOM is emitted in the **CycloneDX 1.5** JSON format — the OWASP
CycloneDX standard, schema published at
<https://cyclonedx.org/docs/1.5/json/> — by the zero-dependency generator
[`gen_sbom.py`](gen_sbom.py) (Python stdlib only; no network access at any
point). It reads `name`, `version` and `dependencies` from `pyproject.toml`
and writes `sbom/bom.json`. Run:

```sh
python3 gen_sbom.py            # (re)generate sbom/bom.json
python3 gen_sbom.py --check    # exit non-zero if the committed SBOM is stale
```

The output is **deterministic** — no wall-clock timestamp is embedded — so the
`--check` drift guard is stable and can run in CI. Honesty note: the SBOM
describes the *source package's declared dependencies*. It is not a signed
attestation and does not by itself prove the bytes you received match this
repo; treat it as an auditable inventory, not a cryptographic guarantee.

## Vendored, pinned rule corpus

The validation rules are derived from Schematron corpora that are **vendored
into the repository and pinned to specific upstream versions** rather than
fetched at runtime:

- EN 16931 corpus & Schematron — `ConnectingEurope/eInvoicing-EN16931`
  (EUPL-1.2), under `corpus/cen-en16931/`.
- XRechnung Schematron v2.5.0 (XRechnung 3.0.2) —
  `itplr-kosit/xrechnung-schematron` (Apache-2.0), under
  `corpus/xrechnung-schematron/` (see its `VENDORED.md`).
- XRechnung test suite — `itplr-kosit/xrechnung-testsuite` (Apache-2.0),
  under `corpus/xrechnung-testsuite/`.

The corpus is used to **build and differential-test** the rules; the shipped
wheel contains only the pure-Python `einvoice` package, not the corpus (see
`[tool.setuptools] packages = ["einvoice"]`).

## Offline / air-gappable

The validator makes **no network calls** — no schema downloads, no telemetry,
no license phone-home. It runs fully offline and is safe to deploy in an
air-gapped environment. `gen_sbom.py` is likewise offline.

This is an **enforced** guarantee, not prose:
[`test_network_egress.py`](test_network_egress.py) monkeypatches the stdlib
network primitives (`socket.create_connection`, `socket.getaddrinfo`,
`socket.socket.connect`/`connect_ex`/`sendto`, `urllib.request.urlopen`) to
raise on any call, proves the guard is live with real canary connection
attempts, then runs the full pipeline under it — valid/invalid UBL and CII,
the XXE external-DTD payloads above, the Factur-X PDF-container extractor,
and every registered report format — asserting **zero egress attempts** and
that the guarded output is byte-identical to an unguarded run.

## Untrusted input / XML entity handling

The invoices this validator parses come from **untrusted suppliers**, so every
production XML entry point is hardened against the classic
`xml.etree`/expat attack classes — **DTD/DOCTYPE injection**, **entity-expansion
denial of service** (billion-laughs, quadratic blowup), and **XXE external-entity /
external-DTD** file reads and SSRF. The guarantee, precisely:

- **Standard library only.** The hardening lives in
  [`einvoice/_xmlsec.py`](einvoice/_xmlsec.py) and imports only
  `xml.etree.ElementTree` and `xml.parsers.expat`. There is **no new runtime
  dependency** (no `defusedxml`, no `lxml`); the zero-dependency contract
  above is unchanged and `test_packaging.py` still proves it.
- **No DTD.** A `<!DOCTYPE …>` — internal *or* external subset — is rejected at
  the expat `StartDoctypeDeclHandler` **before** any entity is defined.
- **No entity definition or expansion.** Because the DOCTYPE that would carry
  `<!ENTITY …>` declarations is refused up front, no custom entity is ever
  defined, so nothing is ever expanded. As defence in depth the
  entity-declaration and unparsed-entity handlers also refuse. A billion-laughs
  or quadratic-blowup payload therefore aborts in constant time and memory — it
  never materialises the expanded string.
- **No external entity / external DTD resolution.** External `SYSTEM`/`PUBLIC`
  references are refused; expat never opens a `file://`, `http://`, or any other
  URL, so `<!ENTITY xxe SYSTEM 'file:///etc/passwd'>` reads **nothing**.
- **Only the five XML-predefined entities** (`&lt; &gt; &amp; &quot; &apos;`)
  are honoured, exactly as before — they are handled natively by expat's
  character-data path, so legitimate invoice text is untouched.

A refused payload is folded into the engine's **existing** *not-well-formed*
outcome — `error: "not-well-formed"` in the JSON report (`report.build_report`)
and CLI exit code **3** — an actionable result identical to any ill-formed
invoice, **never a traceback, never a hang, never a silent pass**.

Every production XML call site routes through this helper:
`einvoice/parser.py` (UBL `parse_file`), `einvoice/parser_cii.py` (CII
`parse_file`), and `einvoice/report.py` (the PDF-container embedded-XML byte
path). The behaviour is verified end-to-end by
[`test_security.py`](test_security.py) — billion-laughs, quadratic-blowup,
external-entity `file://` read (asserting a written canary secret never leaks),
`/etc/passwd` XXE, and external-DTD `SYSTEM` references are each asserted to be
refused in bounded time with the actionable error, while a benign XRechnung
invoice still parses and validates unchanged. That last invariant is also
covered by the differential harness (0 divergences) and
`test_golden_snapshot.py` (byte-identical output), which guarantee the
hardening changed **no** validation result on any legitimate invoice.

### Resource bounds on well-formed-but-hostile input

Refusing DTDs/entities defeats *expansion* attacks, but a document with no DTD
at all can still be hostile by sheer **size or shape**: a multi-hundred-megabyte
body (memory pressure), millions of tiny sibling elements (a moderate-size file
can still explode into ~1 GB of `Element` objects), or pathologically deep
nesting (a stack-overflow / `RecursionError` risk for the pure-Python
ElementTree fallback and any recursive tree consumer). `einvoice/_xmlsec.py`
therefore enforces three hard, stdlib-only ceilings, each far above every
legitimate invoice — the shipped corpus tops out at **3.3 MB, depth 9, ~900
elements** — and each surfaced with a stable leading **error-id token**:

| Bound | Limit (constant) | Error id | Enforcement |
|-------|------------------|----------|-------------|
| Input byte length | 64 MiB (`MAX_INPUT_BYTES`) | `input-too-large` | O(1) length check before expat; the file read is capped at the ceiling so an oversized file is never fully loaded |
| Element nesting depth | 256 (`MAX_ELEMENT_DEPTH`) | `max-depth-exceeded` | refused mid-parse in the start-element handler, before the node is built |
| Total element count | 2,000,000 (`MAX_ELEMENT_COUNT`) | `too-many-elements` | counted per start-element, refused once the ceiling is crossed |

Each bound raises `_xmlsec.XMLResourceLimit` — like `XMLSecurityError`, a
`xml.etree.ElementTree.ParseError` subclass — so it folds into the SAME
actionable **`error: "not-well-formed"`** report (CLI exit **3**) as any other
parse failure: **never** an OOM, a hang, a stack overflow, or a silent pass. The
message always begins with the stable error id above. The ceilings are wired
into both `parser.parse_file` (UBL) and `parser_cii.parse_file` (CII) and the
PDF-container byte path, and are verified by
[`test_robustness.py`](test_robustness.py), which drives each of six cases —
(a) large well-formed, (b) deep nesting, (c) truncated/garbled, (d)
wrong-root/non-invoice, (e) empty/zero-byte, (f) non-UTF-8/wrong-encoding —
through `report.build_report` and asserts a bounded, non-crash, non-pass
outcome. Because the limits sit orders of magnitude above real invoices, they
change **no** legitimate output (again confirmed by `differential.py` and
`test_golden_snapshot.py`). No benchmark numbers are quoted here; the wall-clock
assertions live in the test.

## Deterministic, auditable output

Given the same invoice and profile, the validator produces the same result;
the machine-readable report is a versioned JSON contract documented in
[`REPORT-SCHEMA.md`](REPORT-SCHEMA.md). Every rule quotes its source
Schematron text verbatim (see [`CORRECTNESS.md`](CORRECTNESS.md)), so a
finding can be traced back to the standard it comes from.

## Install from a source checkout

There is **no PyPI release** — publishing (and any signing) is a deliberate
human/supervisor step, not something this package does for itself. Install
from a checkout or a vendored copy:

```sh
python3 -m pip install /path/to/einvoice
```

## Reporting an issue

This is an early-slice project without a formal disclosure process yet. If you
find a correctness or security problem, open an issue on the source repository
(`github.com/verifyhash/verifyhash`) describing the input and the observed vs.
expected behaviour.
