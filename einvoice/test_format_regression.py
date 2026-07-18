#!/usr/bin/env python3
"""Machine/CI-format output regression lock over the economically-distinct
synthetic fixtures (T-VHFMTP.1).

WHAT THIS IS
------------
``test_golden_snapshot.py`` pins the NORMALIZED PROJECTION (valid / exit_code /
sorted fired-rule ids) of the engine's verdict for a curated corpus. That
projection deliberately drops the actual machine-format bytes — timestamps,
paths, fingerprints and layout are all normalized away — so a driver that
adopts einvoice in CI (``einvoice.report --format sarif|gitlab|github|azure|
junit``) has NO test that its exact, byte-level machine output stays stable
across refactors. A silent change to a SARIF ``partialFingerprint``, a GitLab
Code-Quality ``fingerprint``, a JUnit attribute order, or a GitHub/Azure
workflow-command line would slip past every existing gate and break a
stranger's pipeline (deduped annotations reappear, quality-gate diffs churn).

This module closes that gap for a REPRESENTATIVE subset of the new
economically-distinct fixtures by freezing the EXACT emitted bytes of each
registered machine/CI format and asserting byte-identity with a committed
golden under ``golden/``. It is a pure regression LOCK: it adds no format,
changes no emitter, and asserts no verdict this repo doesn't already produce.

FIXTURES (distinct economic verdicts, one machine golden set each)
------------------------------------------------------------------
The original T-VHFMTP.1 subset:
  * synth-cii-good-fullshape      full-shape valid CII      -> PASS (no fired rule)
  * synth-cii-bad-fullshape       its negative twin         -> FAIL, BR-CO-15
  * synth-cii-bad-reverse-charge  reverse-charge (AE) twin  -> FAIL, BR-AE-10
  * synth-ubl-bad-intra-community intra-community (K) UBL    -> FAIL, BR-IC-02

T-VHFMTP.3 closes the remaining CII-syntax gap — every economically-distinct
CII source fixture on disk that still lacked a machine-format golden set. These
are the native-CII documents (``corpus/synthetic/synth-cii-*.xml``) whose
verdicts are already pinned as normalized projections in
``test_golden_snapshot.py`` but whose EXACT machine bytes were never frozen:
  * synth-cii-good-export           export/zero-rated supply (cat G)  -> PASS
  * synth-cii-good-foreign-currency non-EUR invoice + EUR VAT accting -> PASS
  * synth-cii-good-intra-community  intra-community (cat K)           -> PASS
  * synth-cii-good-multiline        several line items                -> PASS
  * synth-cii-good-reverse-charge   reverse-charge (cat AE)           -> PASS
  * synth-cii-good-rounding-boundary half-cent rounding edge          -> PASS
  * synth-cii-good-zero-rated       zero-rated (cat Z)                -> PASS
  * synth-cii-bad-export            export missing exemption reason   -> FAIL, BR-G-10
  * synth-cii-bad-intra-community   intra-community missing reason    -> FAIL, BR-IC-02
  * synth-cii-bad-missing-seller-vat seller VAT id absent, std-rated  -> FAIL, BR-CO-26/BR-S-02/03/04
  * synth-cii-bad-vat-mismatch      BT-110 != Σ BT-117                -> FAIL, BR-CO-14
  * synth-cii-bad-xrechnung-nocontact XRechnung seller-contact gap    -> FAIL, BR-DE-2/BR-DE-21

T-VHFMTP.5 extends the lock over the Factur-X/PDF-CONTAINER input path — the
third native input syntax (alongside plain UBL XML and raw CII), and the first
whose verdict can turn on CONTAINER integrity rather than the invoice body.
These fixtures (``kind:"pdf"``) drive the SAME ``report.build_report`` the CLI
runs: it auto-detects the PDF, extracts the embedded CII and runs the
embedded-CII engine PLUS the container-integrity (``FX-CONTAINER-*``) checks.
Crucially the report CLI dispatches a ``.pdf`` NATIVELY (unlike a raw CII
``.xml``, which trips the S-ROOT structural check), so the emit==CLI
byte-equivalence proof in ``_assert_emit_matches_cli`` runs for pdf fixtures too
— these six-format goldens are CLI-verified, not merely engine-internal:
  * pdf-container-cii-good-fullshape  full-shape valid CII in a MATCHING
      Factur-X container (corpus/pdf/facturx-fullshape.pdf) -> PASS, no fired
      rule. Same invoice as synth-cii-good-fullshape now travelling the PDF
      path; reuses the committed projection golden
      golden/pdf-container-cii-good-fullshape.json for the regen cross-check.
  * pdf-container-cii-bad-fullshape   clean container, business-rule-invalid
      embedded CII (corpus/pdf/facturx-bad.pdf) -> FAIL (BR-DE-* embedded-CII
      business rules) under the xrechnung profile — a body verdict, container OK.
  * pdf-container-afrel-bad           structurally-defective container
      (corpus/pdf/facturx-afrel-bad.pdf, /AFRelationship /Unspecified) -> fires
      FX-CONTAINER-AFRELATIONSHIP, the container-integrity verdict CLASS no
      other machine golden covers (not a business rule).

Each is a genuinely different document producing a genuinely different report,
so its six machine goldens differ substantively (not near-duplicates): every
pass case emits an empty GitLab array / zero-testcase JUnit / "conformant"
GitHub+Azure lines, while each FAIL case carries its own rule id(s), message,
location and stable fingerprint.

CODE PATH (the REAL emitters — no re-implemented rule logic, no hand-authored
bytes)
------------------------------------------------------------------------------
Per (fixture, format) we render through the IDENTICAL functions and
serialization ``einvoice.report.main`` uses for ``--format <fmt>``:
  json   -> json.dumps(report, separators=(",", ":")) + "\n"
  junit  -> report.build_junit(report)
  sarif  -> json.dumps(report.build_sarif(report),  indent=2, sort_keys=True)+"\n"
  gitlab -> json.dumps(report.build_gitlab(report), indent=2, sort_keys=True)+"\n"
  github -> report.build_github(report)
  azure  -> report.build_azure(report)
This ``emit`` helper is verified byte-identical to driving the real
``python3 -m einvoice.report --format <fmt> --profile en16931 <path>`` CLI (see
``_assert_emit_matches_cli`` below, run on every ``--update`` regeneration).

The REPORT DICT is built by the shipped engine, never hand-authored:
  * UBL fixture  -> ``report.build_report(rel, profile)`` verbatim — the exact
    CLI plain-XML path (native UBL validation + the syntax-binding section).
  * CII fixtures -> ``report._report_from_invoice_bytes(bytes, rel, profile)`` —
    the SAME native-CII engine (``parser_cii.build_model`` + ``rules.ALL_RULES``
    + ``rules_xrechnung.evaluate_cii``) that ``build_report`` runs for a
    Factur-X/ZUGFeRD PDF's embedded CII. HONEST NOTE: the plain-XML report CLI
    parses UBL only, so ``einvoice.report <raw-cii.xml>`` today trips the S-ROOT
    structural check; the native CII verdict pinned here is exactly what the CLI
    emits when the SAME invoice arrives inside its Factur-X PDF container
    (proved for synth-cii-good-fullshape by ``test_pdf_container``'s
    ``facturx-fullshape.pdf`` e2e). We pin the honest economic verdict, not the
    S-ROOT bailout — three raw-CII S-ROOT documents would be near-identical and
    carry no economic signal.

Profile ``en16931`` — the same profile these fixtures are golden-pinned under in
``test_golden_snapshot.py`` — so the machine bytes reflect the exact fired-rule
set already committed there; a CROSS-CHECK below asserts each fixture's
``valid`` here equals that committed projection's ``valid``.

PATH-INVARIANCE (independent of where this checkout lives)
----------------------------------------------------------
Every report is built with the fixture's RELATIVE path (``corpus/...`` /
``fixtures/...``), so the only path any format echoes (json ``source``, gitlab
``location.path``, github ``file=``, azure ``sourcepath=``) is that committed
relative string — never an absolute prefix, ``$HOME`` or this checkout's
location. A guard below rejects regenerating any golden that contains ``HERE``,
``$HOME`` or a ``/home/`` prefix, exactly the discipline the container-golden
block documents ("independent of where this checkout lives").

REGENERATION (never automatic)
------------------------------
The default run NEVER rewrites goldens. After an INTENTIONAL emitter change,
re-baseline with a reviewed diff via:
    python3 test_format_regression.py --update
    REGEN=1 python3 test_format_regression.py
Regeneration first re-checks the emit==CLI equivalence, the no-error report
shape, the verdict cross-check and path-invariance, and refuses to freeze a
golden that fails any of them.

Standard library only. No network. Runs in well under a second.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
GOLDEN_DIR = os.path.join(HERE, "golden")

from einvoice import report  # noqa: E402

#: The profile these fixtures are golden-pinned under in test_golden_snapshot.py.
PROFILE = "en16931"

#: The registered MACHINE/CI formats we lock (the CI-adopter subset of
#: report.REPORT_FORMATS; html/badge/text are human/visual and out of scope).
MACHINE_FORMATS = ("json", "junit", "sarif", "gitlab", "github", "azure")

#: golden filename extension per format, mirroring the existing
#: container-unsupported-truncated.validate.* convention.
FORMAT_EXT = {
    "json": "validate.json",
    "junit": "validate.junit.xml",
    "sarif": "validate.sarif.json",
    "gitlab": "validate.gitlab.json",
    "github": "validate.github.txt",
    "azure": "validate.azure.txt",
}

#: The four economically-distinct fixtures. ``kind`` selects the real report
#: code path; ``rel`` is the checkout-relative path echoed into the output; the
#: ``<stem>.json`` projection golden (already committed by test_golden_snapshot)
#: supplies the verdict cross-check.
FIXTURES = [
    {
        "name": "synth-cii-good-fullshape",
        "rel": "corpus/synthetic/synth-cii-good-fullshape.xml",
        "kind": "cii",
        "note": "full-shape valid CII -> PASS (no fired rule).",
    },
    {
        "name": "synth-cii-bad-fullshape",
        "rel": "corpus/synthetic/synth-cii-bad-fullshape.xml",
        "kind": "cii",
        "note": "negative twin of the full-shape invoice -> FAIL (BR-CO-15).",
    },
    {
        "name": "synth-cii-bad-reverse-charge",
        "rel": "corpus/synthetic/synth-cii-bad-reverse-charge.xml",
        "kind": "cii",
        "note": "reverse-charge (AE) broken twin -> FAIL (BR-AE-10).",
    },
    {
        "name": "synth-ubl-bad-intra-community",
        "rel": "fixtures/synth-ubl-bad-intra-community_ubl.xml",
        "kind": "ubl",
        "note": "intra-community (K) broken UBL twin -> FAIL (BR-IC-02); the "
                "native UBL CLI plain-XML path.",
    },
    # --- T-VHFMTP.3: the remaining economically-distinct CII source fixtures.
    # Same native-CII engine (_report_from_invoice_bytes) as the FMTP.1 CII
    # entries; each rel is the checkout-relative corpus path echoed into output.
    {
        "name": "synth-cii-good-export",
        "rel": "corpus/synthetic/synth-cii-good-export.xml",
        "kind": "cii",
        "note": "export supply (VAT category G) -> PASS (no fired rule).",
    },
    {
        "name": "synth-cii-good-foreign-currency",
        "rel": "corpus/synthetic/synth-cii-good-foreign-currency.xml",
        "kind": "cii",
        "note": "non-EUR invoice with EUR VAT accounting currency -> PASS.",
    },
    {
        "name": "synth-cii-good-intra-community",
        "rel": "corpus/synthetic/synth-cii-good-intra-community.xml",
        "kind": "cii",
        "note": "intra-community supply (VAT category K) -> PASS.",
    },
    {
        "name": "synth-cii-good-multiline",
        "rel": "corpus/synthetic/synth-cii-good-multiline.xml",
        "kind": "cii",
        "note": "multiple invoice lines -> PASS (no fired rule).",
    },
    {
        "name": "synth-cii-good-reverse-charge",
        "rel": "corpus/synthetic/synth-cii-good-reverse-charge.xml",
        "kind": "cii",
        "note": "reverse-charge (VAT category AE) valid document -> PASS.",
    },
    {
        "name": "synth-cii-good-rounding-boundary",
        "rel": "corpus/synthetic/synth-cii-good-rounding-boundary.xml",
        "kind": "cii",
        "note": "half-cent rounding-boundary totals -> PASS.",
    },
    {
        "name": "synth-cii-good-zero-rated",
        "rel": "corpus/synthetic/synth-cii-good-zero-rated.xml",
        "kind": "cii",
        "note": "zero-rated supply (VAT category Z) -> PASS.",
    },
    {
        "name": "synth-cii-bad-export",
        "rel": "corpus/synthetic/synth-cii-bad-export.xml",
        "kind": "cii",
        "note": "export missing exemption reason -> FAIL (BR-G-10).",
    },
    {
        "name": "synth-cii-bad-intra-community",
        "rel": "corpus/synthetic/synth-cii-bad-intra-community.xml",
        "kind": "cii",
        "note": "intra-community missing exemption reason -> FAIL (BR-IC-02).",
    },
    {
        "name": "synth-cii-bad-missing-seller-vat",
        "rel": "corpus/synthetic/synth-cii-bad-missing-seller-vat.xml",
        "kind": "cii",
        "note": "standard-rated with no seller VAT id -> FAIL "
                "(BR-CO-26, BR-S-02, BR-S-03, BR-S-04).",
    },
    {
        "name": "synth-cii-bad-vat-mismatch",
        "rel": "corpus/synthetic/synth-cii-bad-vat-mismatch.xml",
        "kind": "cii",
        "note": "invoice total VAT (BT-110) != sum of category VAT (BT-117) "
                "-> FAIL (BR-CO-14).",
    },
    {
        "name": "synth-cii-bad-xrechnung-nocontact",
        "rel": "corpus/synthetic/synth-cii-bad-xrechnung-nocontact.xml",
        "kind": "cii",
        # XRechnung national rules (BR-DE-*) fire ONLY under the xrechnung
        # profile; under en16931 this document is valid. Pin its genuinely-
        # distinct verdict under the profile its projection golden uses.
        "profile": "xrechnung",
        "note": "XRechnung seller-contact gap -> FAIL (BR-DE-2, BR-DE-21) "
                "under the xrechnung profile.",
    },
    # --- T-VHFMTP.4: the remaining economically-distinct UBL-syntax source
    # fixtures. Measure-first (see module head) found every synth-ubl-*
    # projection golden that still lacked a machine-format golden set; each is
    # driven through the SAME native-UBL plain-XML CLI path (build_report) as
    # the FMTP.1 synth-ubl-bad-intra-community entry, and its emit==CLI
    # equivalence is proved for all six formats on every regeneration. The
    # profile per entry MATCHES the one its projection golden
    # (golden/<name>.json) was pinned under in test_golden_snapshot.py, so the
    # frozen bytes reflect exactly the already-committed fired-rule set (the
    # verdict cross-check enforces this): fixtures whose distinguishing rule is
    # a German BR-DE national rule pin under ``xrechnung``; the rest under
    # ``en16931``. Each rel is confirmed to resolve to a committed UBL source.
    {
        "name": "synth-ubl-good-fullshape",
        "rel": "fixtures/synth-ubl-good-fullshape_ubl.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "full-shape valid UBL (XRechnung CIUS) -> PASS; the positive "
                "parity twin of synth-ubl-bad-fullshape.",
    },
    {
        "name": "synth-ubl-bad-fullshape",
        "rel": "fixtures/synth-ubl-bad-fullshape_ubl.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "negative twin of the full-shape UBL invoice -> FAIL under the "
                "xrechnung profile.",
    },
    {
        "name": "synth-ubl-good-reverse-charge",
        "rel": "fixtures/synth-ubl-good-reverse-charge_ubl.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "reverse-charge (VAT category AE) valid UBL -> PASS.",
    },
    {
        "name": "synth-ubl-bad-reverse-charge",
        "rel": "fixtures/synth-ubl-bad-reverse-charge_ubl.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "reverse-charge (AE) broken UBL twin -> FAIL.",
    },
    {
        "name": "synth-ubl-good-intra-community",
        "rel": "fixtures/synth-ubl-good-intra-community_ubl.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "intra-community supply (VAT category K) valid UBL -> PASS.",
    },
    {
        "name": "synth-ubl-good-export",
        "rel": "fixtures/synth-ubl-good-export_ubl.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "export supply (VAT category G) valid UBL -> PASS.",
    },
    {
        "name": "synth-ubl-bad-export",
        "rel": "fixtures/synth-ubl-bad-export_ubl.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "export UBL missing exemption reason -> FAIL.",
    },
    {
        "name": "synth-ubl-good-not-subject",
        "rel": "fixtures/synth-ubl-good-not-subject_ubl.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "not-subject-to-VAT (category O) valid UBL -> PASS.",
    },
    {
        "name": "synth-ubl-bad-not-subject",
        "rel": "fixtures/synth-ubl-bad-not-subject_ubl.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "not-subject (O) broken UBL twin -> FAIL.",
    },
    {
        "name": "synth-ubl-good-corrected",
        "rel": "fixtures/synth-ubl-good-corrected_ubl.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "corrective invoice (type 384) valid UBL -> PASS.",
    },
    {
        "name": "synth-ubl-bad-corrected",
        "rel": "fixtures/synth-ubl-bad-corrected_ubl.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "corrective-invoice broken UBL twin -> FAIL.",
    },
    {
        "name": "synth-ubl-good-selfbilled",
        "rel": "fixtures/synth-ubl-good-selfbilled_ubl.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "self-billed invoice (type 389) valid UBL -> PASS.",
    },
    {
        "name": "synth-ubl-bad-selfbilled",
        "rel": "fixtures/synth-ubl-bad-selfbilled_ubl.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "self-billed broken UBL twin -> FAIL.",
    },
    {
        "name": "synth-ubl-bad-missing-buyerref",
        "rel": "corpus/synthetic/synth-ubl-bad-missing-buyerref.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "buyer reference (BT-10) absent -> FAIL (BR-DE-15) under the "
                "xrechnung profile.",
    },
    {
        "name": "synth-ubl-good-multiline",
        "rel": "corpus/synthetic/synth-ubl-good-multiline.xml",
        "kind": "ubl",
        "note": "multiple invoice lines, valid UBL -> PASS.",
    },
    {
        "name": "synth-ubl-good-multivat",
        "rel": "corpus/synthetic/synth-ubl-good-multivat.xml",
        "kind": "ubl",
        "note": "several VAT breakdown categories, valid UBL -> PASS.",
    },
    {
        "name": "synth-ubl-bad-multivat-subtotal",
        "rel": "corpus/synthetic/synth-ubl-bad-multivat-subtotal.xml",
        "kind": "ubl",
        "note": "a VAT category subtotal disagrees with its lines -> FAIL.",
    },
    {
        "name": "synth-ubl-good-allowance-charge",
        "rel": "corpus/synthetic/synth-ubl-good-allowance-charge.xml",
        "kind": "ubl",
        "note": "document-level allowance + charge, valid UBL -> PASS.",
    },
    {
        "name": "synth-ubl-good-large-mixed",
        "rel": "corpus/synthetic/synth-ubl-good-large-mixed.xml",
        "kind": "ubl",
        "note": "large mixed-category invoice, valid UBL -> PASS.",
    },
    {
        "name": "synth-ubl-bad-large-mixed",
        "rel": "corpus/synthetic/synth-ubl-bad-large-mixed.xml",
        "kind": "ubl",
        "note": "large mixed-category broken twin -> FAIL.",
    },
    {
        "name": "synth-ubl-bad-exempt-noreason",
        "rel": "corpus/synthetic/synth-ubl-bad-exempt-noreason.xml",
        "kind": "ubl",
        "note": "exempt (category E) with no exemption reason -> FAIL.",
    },
    {
        "name": "synth-ubl-bad-vat-mismatch",
        "rel": "corpus/synthetic/synth-ubl-bad-vat-mismatch.xml",
        "kind": "ubl",
        "note": "invoice total VAT != sum of category VAT -> FAIL.",
    },
    {
        "name": "synth-ubl-good-xrechnung",
        "rel": "corpus/synthetic/synth-ubl-good-xrechnung.xml",
        "kind": "ubl",
        "profile": "xrechnung",
        "note": "XRechnung-conformant UBL invoice -> PASS under the xrechnung "
                "profile.",
    },
    # --- T-VHFMTP.5: the Factur-X/PDF-CONTAINER input path. These drive the
    # SAME build_report the CLI runs; it auto-detects the PDF, extracts the
    # embedded CII and runs the embedded-CII engine PLUS container-integrity
    # (FX-CONTAINER-*) checks. Because the report CLI dispatches a .pdf
    # natively (unlike a raw CII .xml, which trips S-ROOT), the emit==CLI
    # byte-equivalence proof runs for these too. Three genuinely-distinct
    # verdict classes: a clean container + valid CII (PASS), a clean container
    # wrapping business-rule-invalid CII (FAIL), and a STRUCTURALLY-defective
    # container that fires an FX-CONTAINER-* finding no other machine golden
    # covers. Each rel is confirmed on disk.
    {
        "name": "pdf-container-cii-good-fullshape",
        "rel": "corpus/pdf/facturx-fullshape.pdf",
        "kind": "pdf",
        # Reuses the committed projection golden
        # golden/pdf-container-cii-good-fullshape.json (en16931) for the regen
        # cross-check: same full-shape CII as synth-cii-good-fullshape, now
        # travelling the PDF-container path, must still validate.
        "note": "full-shape valid embedded CII in a MATCHING Factur-X container "
                "-> PASS (no fired rule); reuses the committed projection "
                "golden for the regen cross-check.",
    },
    {
        "name": "pdf-container-cii-bad-fullshape",
        "rel": "corpus/pdf/facturx-bad.pdf",
        "kind": "pdf",
        # The container is clean; only the embedded CII is bad. Its BR-DE
        # business rules fire ONLY under the xrechnung profile (as with
        # synth-cii-bad-xrechnung-nocontact), so pin the genuinely-invalid
        # verdict under xrechnung — a business-rule FAIL, distinct from the
        # container-structure defect below.
        "profile": "xrechnung",
        "note": "clean Factur-X container wrapping business-rule-invalid "
                "embedded CII -> FAIL (BR-DE-* embedded-CII business rules) "
                "under the xrechnung profile.",
    },
    {
        "name": "pdf-container-afrel-bad",
        "rel": "corpus/pdf/facturx-afrel-bad.pdf",
        "kind": "pdf",
        # The embedded CII is valid; the CONTAINER is defective (invoice
        # filespec /AFRelationship is /Unspecified, not /Alternative or /Data),
        # firing FX-CONTAINER-AFRELATIONSHIP — a container-integrity verdict
        # class no existing machine golden exercises.
        "note": "structurally-defective Factur-X container "
                "(/AFRelationship /Unspecified) -> fires "
                "FX-CONTAINER-AFRELATIONSHIP, the container-integrity verdict "
                "class (not a business rule).",
    },
]


def fx_profile(fx):
    """The profile a fixture is pinned under (default PROFILE=en16931). A single
    fixture — synth-cii-bad-xrechnung-nocontact — pins under ``xrechnung`` where
    its national BR-DE rules actually fire."""
    return fx.get("profile", PROFILE)


def build_report_dict(rel, kind, profile=PROFILE):
    """Return the shipped-engine report dict for ``rel`` via the SAME code path
    the CLI uses: native UBL (build_report) or native CII
    (_report_from_invoice_bytes, the Factur-X embedded-CII engine)."""
    abspath = os.path.join(HERE, rel)
    if kind == "cii":
        with open(abspath, "rb") as fh:
            xml_bytes = fh.read()
        # source is the RELATIVE path -> path-invariant echoed bytes.
        return report._report_from_invoice_bytes(xml_bytes, rel, profile)
    if kind == "pdf":
        # Factur-X/ZUGFeRD PDF container: build_report auto-detects the PDF,
        # extracts the embedded CII and runs the SAME embedded-CII engine PLUS
        # the container-integrity (FX-CONTAINER-*/FX-PDFA3-*) checks the CLI
        # runs — no hand-authored bytes, no re-implemented rule logic. Identical
        # cwd=HERE mechanism as the ubl branch below, so build_report's own file
        # read and the echoed ``source`` stay the checkout-relative
        # ``corpus/pdf/...`` string (path-invariant).
        prev = os.getcwd()
        try:
            os.chdir(HERE)
            return report.build_report(rel, profile=profile)
        finally:
            os.chdir(prev)
    # UBL: drive build_report with the relative path from cwd=HERE so its
    # own file read + echoed ``source`` stay checkout-independent.
    prev = os.getcwd()
    try:
        os.chdir(HERE)
        return report.build_report(rel, profile=profile)
    finally:
        os.chdir(prev)


def emit(rep, fmt):
    """Render ``rep`` to bytes with the EXACT serialization report.main uses for
    ``--format <fmt>`` (verified against the real CLI in
    ``_assert_emit_matches_cli``)."""
    if fmt == "json":
        return (json.dumps(rep, separators=(",", ":")) + "\n").encode("utf-8")
    if fmt == "junit":
        return report.build_junit(rep).encode("utf-8")
    if fmt == "sarif":
        return (json.dumps(report.build_sarif(rep), indent=2, sort_keys=True)
                + "\n").encode("utf-8")
    if fmt == "gitlab":
        return (json.dumps(report.build_gitlab(rep), indent=2, sort_keys=True)
                + "\n").encode("utf-8")
    if fmt == "github":
        return report.build_github(rep).encode("utf-8")
    if fmt == "azure":
        return report.build_azure(rep).encode("utf-8")
    raise ValueError("unhandled format %r" % fmt)


def golden_path(name, fmt):
    return os.path.join(GOLDEN_DIR, "%s.%s" % (name, FORMAT_EXT[fmt]))


def _path_leak(data):
    """Return a human reason if ``data`` (bytes) carries an absolute checkout
    prefix, $HOME, or any /home/ path — else ''. Enforces path-invariance."""
    home = os.environ.get("HOME", "")
    for needle in (HERE.encode("utf-8"),
                   (home.encode("utf-8") if home else b"\x00never\x00"),
                   b"/home/"):
        if needle and needle in data:
            return "contains absolute/HOME prefix %r" % needle
    return ""


def _assert_emit_matches_cli(fx):
    """Prove ``emit(build_report_dict(...), fmt)`` is byte-identical to driving
    the REAL ``python3 -m einvoice.report --format <fmt>`` CLI. Meaningful for
    every fixture the report CLI dispatches natively: UBL plain-XML AND the
    Factur-X/ZUGFeRD PDF container (build_report auto-detects the PDF and runs
    the embedded-CII engine, so ``einvoice.report <fx>.pdf`` emits exactly these
    bytes). ONLY a raw CII .xml is exempt — it trips the S-ROOT structural check
    in the plain-XML CLI (documented above), so its native verdict is
    cross-checked instead against the committed projection. Returns a list of
    failure lines (empty = OK)."""
    fails = []
    rep = build_report_dict(fx["rel"], fx["kind"], fx_profile(fx))
    if fx["kind"] == "cii":
        return fails
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    for fmt in MACHINE_FORMATS:
        proc = subprocess.run(
            [sys.executable, "-m", "einvoice.report", "--format", fmt,
             "--profile", fx_profile(fx), fx["rel"]],
            cwd=HERE, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        want = emit(rep, fmt)
        if proc.stdout != want:
            fails.append("  %s/%s: in-process emit != real CLI stdout"
                         % (fx["name"], fmt))
    return fails


def _load_projection_valid(name):
    """Read the committed ``golden/<stem>.json`` projection's ``valid`` (the
    already-pinned economic verdict) for the cross-check; None if absent."""
    p = os.path.join(GOLDEN_DIR, "%s.json" % name)
    if not os.path.isfile(p):
        return None
    with open(p, "r", encoding="utf-8") as fh:
        return json.load(fh).get("valid")


def _regen_guard(fx, rep):
    """Refuse to freeze a golden over a broken report shape. Returns failure
    lines (empty = safe to write)."""
    fails = []
    if rep.get("error"):
        fails.append("  %s: report carries error=%r (never pin an error over "
                     "a well-formed economic fixture)"
                     % (fx["name"], rep.get("error")))
    proj = _load_projection_valid(fx["name"])
    if proj is not None and rep.get("valid") != proj:
        fails.append("  %s: valid=%r disagrees with committed projection "
                     "golden/%s.json valid=%r"
                     % (fx["name"], rep.get("valid"), fx["name"], proj))
    return fails


def write_goldens():
    """Regenerate every machine-format golden (only via --update / REGEN=1),
    refusing to freeze a broken shape, a CLI-divergent emit, or a path leak."""
    if not os.path.isdir(GOLDEN_DIR):
        os.makedirs(GOLDEN_DIR)
    written = 0
    for fx in FIXTURES:
        rep = build_report_dict(fx["rel"], fx["kind"], fx_profile(fx))
        guard = _regen_guard(fx, rep) + _assert_emit_matches_cli(fx)
        if guard:
            raise SystemExit("refusing to regenerate goldens for %s:\n%s"
                             % (fx["name"], "\n".join(guard)))
        for fmt in MACHINE_FORMATS:
            data = emit(rep, fmt)
            leak = _path_leak(data)
            if leak:
                raise SystemExit("refusing to write a NON-path-invariant "
                                 "golden %s/%s: %s"
                                 % (fx["name"], fmt, leak))
            with open(golden_path(fx["name"], fmt), "wb") as fh:
                fh.write(data)
            written += 1
    return written


def check(verbose=True):
    """Byte-compare every (fixture, format) pair against its committed golden,
    plus the report-shape / verdict cross-check / path-invariance guards.
    Returns (ok, failures)."""
    failures = []
    for fx in FIXTURES:
        rep = build_report_dict(fx["rel"], fx["kind"], fx_profile(fx))
        for line in _regen_guard(fx, rep):
            failures.append(line)
        for fmt in MACHINE_FORMATS:
            name = "%s --format %s" % (fx["name"], fmt)
            gpath = golden_path(fx["name"], fmt)
            data = emit(rep, fmt)
            leak = _path_leak(data)
            if leak:
                failures.append("  %s: emitted bytes leak a path: %s"
                                % (name, leak))
            if not os.path.isfile(gpath):
                failures.append("  MISSING golden for %r (run --update)." % name)
                continue
            with open(gpath, "rb") as fh:
                golden = fh.read()
            if _path_leak(golden):
                failures.append("  %s: COMMITTED golden %s leaks a path"
                                % (name, os.path.basename(gpath)))
            if data != golden:
                failures.append(
                    "  DRIFT %r vs %s (golden %d bytes, now %d bytes)"
                    % (name, os.path.basename(gpath), len(golden), len(data)))
    ok = not failures
    total = len(FIXTURES) * len(MACHINE_FORMATS)
    if verbose:
        if ok:
            sys.stdout.write("OK: %d machine-format golden(s) match.\n" % total)
        else:
            sys.stdout.write("FAIL: %d machine-format golden issue(s):\n"
                             % len(failures))
            for ln in failures:
                sys.stdout.write(ln + "\n")
            sys.stdout.write("\nIf INTENTIONAL, re-baseline with:\n"
                             "  python3 test_format_regression.py --update\n")
    return ok, failures


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    regen = ("--update" in argv) or (os.environ.get("REGEN") == "1")
    if regen:
        n = write_goldens()
        sys.stdout.write("Regenerated %d machine-format golden(s) in %s\n"
                         % (n, os.path.relpath(GOLDEN_DIR, HERE)))
        return 0
    ok, _ = check(verbose=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
