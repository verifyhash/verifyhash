#!/usr/bin/env python3
"""test_seam_pdf_payload.py — seeded fuzz of the extractor->validator SEAM.

WHAT THIS FUZZES (and how it differs from test_fuzz_pdf_container.py)
--------------------------------------------------------------------
``test_fuzz_pdf_container.py`` fuzzes the *container*: it mutates raw PDF bytes
and asserts the EXTRACTOR contract only — every mutant comes back as a
documented ``ContainerInspection``/``bytes`` result or ``UnsupportedContainer``,
never a traceback. It deliberately never checks what the rule engine does with a
mutated *embedded payload*, because almost every byte-level PDF mutation either
leaves the payload untouched or breaks the container so extraction refuses long
before the validator is reached. That leaves ONE junction unfuzzed: a
structurally-VALID Factur-X PDF whose embedded CII XML is HOSTILE — extraction
SUCCEEDS and hands the poisoned bytes straight to the rule engine.

This suite targets exactly that seam. For each mutant it:

  1. starts from a committed VALID fixture (``corpus/pdf/facturx-valid.pdf``),
     extracts its embedded CII payload,
  2. MUTATES the CII payload (four named strategies below),
  3. RE-WRAPS the mutated payload into a fresh, structurally-valid PDF container
     (``_wrap_pdf``) that still walks catalog -> /Names -> /EmbeddedFiles ->
     filespec -> /EF /F -> unfiltered stream, so EXTRACTION STILL SUCCEEDS and
     the mutation lands on the *payload*, not on the container. Every built
     mutant is verified to still extract to exactly the mutated bytes before it
     enters the population (``_generate_population`` discards + regenerates any
     that does not — so the seam, never the extractor's reject path, is what is
     exercised),
  4. drives the REAL end-to-end validate-from-PDF entry point
     ``einvoice.report.build_report(path, profile="en16931")`` — the same
     path-in / report-dict-out callable the ``python3 -m einvoice.report`` CLI
     uses (since T-VHERG.5 the bare ``einvoice validate`` subcommand also opens
     containers, through the same extractor; see test_fuzz_pdf_container.py's
     LEG B note), plus a fixed-seed subset through that CLI across a real
     process boundary (LEG B).

THE SEAM INVARIANT (asserted for every mutant)
----------------------------------------------
  * TOTALITY: ``build_report`` returns a report dict in the documented shape —
    a ``valid`` verdict, OR a documented ``error`` in
    {``not-well-formed``, ``unsupported-container``}. Never an uncaught
    traceback, never a hang (per-population wall-time bound + per-subprocess
    timeout, mirroring test_fuzz_pdf_container.py).
  * NO SILENT PASS: a corrupt embedded payload NEVER yields ``valid=true``.
    Every mutant here genuinely alters the payload, so every mutant must be a
    non-pass — either a documented parse error (truncation / well-formedness
    break) or REAL findings (>=1 fatal: a wrong-root S-ROOT, or a broken EN
    16931 business rule). The truncated / well-formedness-broken pass-through
    case is asserted directly (``error == not-well-formed``, ``valid False``).
  * DETERMINISM: the whole population is drawn from a FIXED ``SEED``
    ``random.Random``; it is built twice from two freshly seeded generators and
    the two mutant-PDF lists must be byte-for-byte identical.

STRATEGIES (>= ``N_MUTATIONS`` mutants across these four, each named)
--------------------------------------------------------------------
  (1) ``truncate``          — cut the CII bytes at a seeded offset (drops the
                              closing root tag => not-well-formed);
  (2) ``wf-break``          — insert a bare ``<`` or ``&`` inside the element
                              region (illegal in XML content/attrs => not
                              well-formed);
  (3) ``wrong-root``        — a parseable XML document whose root is neither
                              ``CrossIndustryInvoice`` nor a UBL ``Invoice``
                              (=> S-ROOT fatal);
  (4) ``en16931-violating`` — a structurally-valid CII (root intact,
                              well-formed) with one EN 16931 business rule
                              broken (BR-03 missing issue date, a tampered
                              GrandTotal/LineTotal => BR-CO-*, or an invalid
                              document TypeCode => BR-CL-01).

STRICT (constitution §7): this harness changes NO rule/extractor/verdict
behaviour. It only feeds committed-fixture-derived inputs through the shipped
engine and asserts the standing contract. No defect was found at introduction
time (the expected outcome), so there is no source change and no pinned
regression seed — the harness stands as the seam's guard. Standard library
only, offline. Run: python3 test_seam_pdf_payload.py
"""

from __future__ import annotations

import os
import random
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import pdf_container  # noqa: E402
from einvoice.pdf_container import UnsupportedContainer  # noqa: E402
from einvoice import report as _report_mod  # noqa: E402
from einvoice.report import build_report  # noqa: E402  (the real path->report entry)

PDF_DIR = os.path.join(HERE, "corpus", "pdf")
VALID_PDF = os.path.join(PDF_DIR, "facturx-valid.pdf")

TRACEBACK_MARK = "Traceback (most recent call last)"

#: Documented exit-code set of ``python3 -m einvoice.report`` (its module
#: docstring + main(): EXIT_OK=0 / EXIT_FAIL=1 / EXIT_PARSE=3). Membership is
#: the process-boundary contract; it is NOT widened.
REPORT_EXITS = frozenset({
    _report_mod.EXIT_OK, _report_mod.EXIT_FAIL, _report_mod.EXIT_PARSE})

#: The documented ``error`` codes a non-pass report may carry (report.py:
#: not-well-formed XML and unsupported-container). Anything else is undocumented.
DOCUMENTED_ERRORS = frozenset({"not-well-formed", "unsupported-container"})

#: Fixed integer seed => the ENTIRE mutant population is byte-for-byte
#: reproducible run to run.
SEED = 0x5EA3C0DE

#: Population size (>=100 required) and the process-boundary sample size.
#: Both driven off the fixed seed only.
N_MUTATIONS = 160
N_SUBPROCESS = 24

#: Per-case wall-clock ceiling at the process boundary. A legitimate run
#: finishes in ~0.1 s (measured); a hang blows past this and FAILS the test.
CASE_TIMEOUT_S = 30.0

#: Wall-time sanity bound for pushing the WHOLE population through the in-process
#: end-to-end entry point (Leg A). 160 build_report calls measure ~0.1 s; 90 s is
#: three orders of magnitude of headroom on a loaded box while still catching a
#: real hang / pathological blow-up.
POPULATION_WALL_S = 90.0

#: The four NAMED payload-mutation strategies, indexed by the selector in
#: _mutate_once.
STRATEGIES = (
    "truncate",
    "wf-break",
    "wrong-root",
    "en16931-violating",
)

#: Root element names for the ``wrong-root`` strategy — parseable XML whose root
#: is neither CrossIndustryInvoice (CII) nor Invoice (UBL), so the report path
#: falls out on the S-ROOT fatal. Deliberately excludes those two names.
_WRONG_ROOTS = (b"foo", b"Document", b"Note", b"data", b"records", b"envelope")

#: Clearly-wrong monetary values for the ``en16931-violating`` amount tampers.
#: None coincides with the fixture's real totals (verified: each breaks a BR-CO
#: calculation rule), so the mutated CII stays well-formed but fails validation.
_WRONG_AMOUNTS = (b"999999.99", b"0.01", b"12345.67", b"31337.00", b"1.00")

#: Invalid UN/EDIFACT 1001 document type codes for the ``en16931-violating``
#: TypeCode tamper (none is an EN 16931-allowed invoice type => BR-CL-01).
_BAD_TYPECODES = (b"999", b"000", b"123", b"777", b"555")


def _read(path):
    with open(path, "rb") as fh:
        return fh.read()


# --------------------------------------------------------------------------- #
# The re-wrap: a fresh, minimal, structurally-valid Factur-X container around an
# arbitrary embedded payload. It carries exactly the shapes pdf_container walks
# (catalog /Names -> /EmbeddedFiles name tree -> filespec /EF /F -> unfiltered
# embedded stream with an exact /Length), so extraction ALWAYS returns the
# payload bytes verbatim regardless of their content (verified per-mutant in
# _generate_population). Unfiltered + explicit /Length means the payload is
# echoed byte-for-byte even if it happens to contain PDF tokens like
# ``endstream`` or ``trailer``.
# --------------------------------------------------------------------------- #
_PDF_HEAD = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"
_PDF_TRAILER = b"trailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF\n"


def _wrap_pdf(payload: bytes) -> bytes:
    """Wrap ``payload`` as the embedded ``factur-x.xml`` of a fresh, structurally
    valid PDF container that ``pdf_container`` can open."""
    objs = [
        b"1 0 obj\n<< /Type /Catalog /Names 2 0 R /AF [4 0 R] >>\nendobj\n",
        b"2 0 obj\n<< /EmbeddedFiles 3 0 R >>\nendobj\n",
        b"3 0 obj\n<< /Names [ (factur-x.xml) 4 0 R ] >>\nendobj\n",
        b"4 0 obj\n<< /Type /Filespec /F (factur-x.xml) /UF (factur-x.xml) "
        b"/AFRelationship /Alternative /EF << /F 5 0 R >> >>\nendobj\n",
        b"5 0 obj\n<< /Type /EmbeddedFile /Length "
        + str(len(payload)).encode("ascii")
        + b" >>\nstream\n" + payload + b"\nendstream\nendobj\n",
    ]
    return _PDF_HEAD + b"".join(objs) + _PDF_TRAILER


def _extraction_of(pdf_bytes):
    """In-process extraction outcome for a container: the embedded XML bytes, or
    None when the container is (documented-)unsupported."""
    try:
        return pdf_container.extract_invoice_xml_from_bytes(pdf_bytes)
    except UnsupportedContainer:
        return None


# --------------------------------------------------------------------------- #
# Payload mutation — every offset/choice comes from ``rng`` alone, so a fixed
# seed fixes the whole sequence. Each returns (mutated_payload_bytes,
# strategy_tag).
# --------------------------------------------------------------------------- #
_BASE_XML = pdf_container.extract_invoice_xml_from_bytes(_read(VALID_PDF))
#: First byte of the root element: mutations for wf-break land at/after here so
#: an inserted ``<``/``&`` cannot fall inside a leading XML comment (where it
#: would be legal). Asserted below that no comment/CDATA follows this offset.
_ROOT_START = _BASE_XML.find(b"<rsm:CrossIndustryInvoice")


def _sub_once(rng, hay, needle, repl):
    """Replace the FIRST occurrence of ``needle`` in ``hay`` with ``repl``.
    Deterministic; returns the new bytes (unchanged if ``needle`` absent)."""
    idx = hay.find(needle)
    if idx == -1:
        return hay
    return hay[:idx] + repl + hay[idx + len(needle):]


def _mutate_once(rng, base):
    """Produce ONE mutated CII payload from ``base``, driven entirely by ``rng``.
    Returns ``(mutated_bytes, strategy_tag)``."""
    strat = rng.randrange(len(STRATEGIES))

    if strat == 0:
        # (1) truncation: cut at a seeded offset in [1, len-1] — always drops the
        # closing root tag, so the payload is no longer well-formed.
        cut = rng.randrange(1, len(base))
        return base[:cut], STRATEGIES[0]

    if strat == 1:
        # (2) well-formedness break: inject a bare '<' or '&' into the element
        # region (never inside the leading comments). Both are illegal in XML
        # element content and attribute values => a guaranteed parse error.
        pos = rng.randrange(_ROOT_START, len(base))
        inject = b"<" if rng.random() < 0.5 else b"&"
        return base[:pos] + inject + base[pos:], STRATEGIES[1]

    if strat == 2:
        # (3) valid XML, wrong root: parseable but neither CII nor UBL Invoice.
        name = rng.choice(_WRONG_ROOTS)
        n = rng.randrange(1000000)
        doc = (b'<?xml version="1.0" encoding="utf-8"?>\n<' + name
               + b' id="' + str(n).encode("ascii") + b'"><child>'
               + str(n).encode("ascii") + b'</child></' + name + b">")
        return doc, STRATEGIES[2]

    # (4) EN16931-violating but parseable: root intact + well-formed, one BR
    # broken. One transform picked by rng; each is verified to yield >=1 fatal.
    kind = rng.randrange(4)
    if kind == 0:
        # BR-03: drop the mandatory issue date by deleting the whole element.
        start = base.find(b"<ram:IssueDateTime>")
        end = base.find(b"</ram:IssueDateTime>")
        if start != -1 and end != -1:
            end += len(b"</ram:IssueDateTime>")
            return base[:start] + base[end:], STRATEGIES[3]
        return base, STRATEGIES[3]
    if kind == 1:
        # BR-CO-*: tamper the document GrandTotalAmount to a clearly-wrong value.
        amt = rng.choice(_WRONG_AMOUNTS)
        start = base.find(b"<ram:GrandTotalAmount>")
        if start != -1:
            vstart = start + len(b"<ram:GrandTotalAmount>")
            vend = base.find(b"</ram:GrandTotalAmount>", vstart)
            if vend != -1:
                return base[:vstart] + amt + base[vend:], STRATEGIES[3]
        return base, STRATEGIES[3]
    if kind == 2:
        # BR-CO-*: tamper the FIRST (line-level) LineTotalAmount.
        amt = rng.choice(_WRONG_AMOUNTS)
        start = base.find(b"<ram:LineTotalAmount>")
        if start != -1:
            vstart = start + len(b"<ram:LineTotalAmount>")
            vend = base.find(b"</ram:LineTotalAmount>", vstart)
            if vend != -1:
                return base[:vstart] + amt + base[vend:], STRATEGIES[3]
        return base, STRATEGIES[3]
    # BR-CL-01: replace the invoice TypeCode 380 with an invalid code.
    code = rng.choice(_BAD_TYPECODES)
    return (_sub_once(rng, base, b"<ram:TypeCode>380</ram:TypeCode>",
                      b"<ram:TypeCode>" + code + b"</ram:TypeCode>"),
            STRATEGIES[3])


def _generate_population(seed, base, count):
    """Build the FIXED mutant population from a freshly seeded generator.

    Each entry is ``(pdf_bytes, payload_bytes, strategy_tag)``. Every built
    container is verified to still extract to EXACTLY its mutated payload before
    it is accepted (so the seam, not the extractor's reject path, is exercised);
    a container that somehow no longer round-trips is discarded and the next
    seeded draw is taken. Same ``(seed, base, count)`` => byte-for-byte
    identical output."""
    rng = random.Random(seed)
    pop = []
    guard = 0
    while len(pop) < count:
        guard += 1
        if guard > count * 50:
            raise AssertionError(
                "could not build %d round-tripping mutants (built %d) — the "
                "re-wrap is not container-stable" % (count, len(pop)))
        payload, tag = _mutate_once(rng, base)
        pdf = _wrap_pdf(payload)
        if _extraction_of(pdf) != payload:
            continue  # container broke — regenerate deterministically
        pop.append((pdf, payload, tag))
    return pop


# Build the population ONCE at import so every test shares the same draw.
_POPULATION = _generate_population(SEED, _BASE_XML, N_MUTATIONS)

# Deterministic subprocess sample from a SEPARATE fixed generator so it never
# perturbs the population draw above (same pattern as test_fuzz_pdf_container.py).
_SUBSET_INDICES = tuple(sorted(
    random.Random(SEED ^ 0x5EED).sample(range(N_MUTATIONS), N_SUBPROCESS)))


class SeamBase(unittest.TestCase):
    """Shared helpers: in-process end-to-end report, and a CLI on a staged PDF."""

    def _report(self, pdf_bytes, profile="en16931"):
        """Drive the REAL path->report entry ``build_report`` on ``pdf_bytes``
        staged as a temp .pdf. Any exception escaping build_report is a
        TOTALITY failure (an uncaught traceback at the seam)."""
        with tempfile.TemporaryDirectory(prefix="einvoice-seam-") as tmp:
            path = os.path.join(tmp, "mutant.pdf")
            with open(path, "wb") as fh:
                fh.write(pdf_bytes)
            return build_report(path, profile=profile)

    def _run_report_cli(self, pdf_bytes, profile="en16931"):
        """Run ``python3 -m einvoice.report --profile <p> <mutant.pdf>`` with a
        per-case timeout. A timeout is a FAILURE (hang). Returns
        ``(returncode, stdout, stderr)``."""
        with tempfile.TemporaryDirectory(prefix="einvoice-seam-") as tmp:
            path = os.path.join(tmp, "mutant.pdf")
            with open(path, "wb") as fh:
                fh.write(pdf_bytes)
            try:
                proc = subprocess.run(
                    [sys.executable, "-m", "einvoice.report",
                     "--profile", profile, path],
                    cwd=HERE, capture_output=True, text=True,
                    timeout=CASE_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                self.fail("report CLI hung > %.0fs on a seam mutant — a hang is "
                          "a TOTALITY FAILURE" % CASE_TIMEOUT_S)
            return proc.returncode, proc.stdout, proc.stderr


class TestFixtureAndSeamControls(SeamBase):
    def test_base_payload_extracts_and_is_cii(self):
        self.assertGreater(len(_BASE_XML), 1000)
        self.assertIn(b"CrossIndustryInvoice", _BASE_XML)
        # No comment / CDATA follows the root start, so a wf-break injection
        # there is always in element content/attrs (guaranteed not-well-formed).
        self.assertGreater(_ROOT_START, 0)
        self.assertNotIn(b"<!--", _BASE_XML[_ROOT_START:])
        self.assertNotIn(b"<![CDATA[", _BASE_XML)

    def test_rewrap_of_unmutated_payload_passes_end_to_end(self):
        """CONTROL: re-wrapping the UNMUTATED extracted payload and driving the
        real report path yields a clean PASS (valid=true) under en16931 — this
        is what proves the mutants fail BECAUSE of the mutation, not because the
        re-wrap itself is rejected. Extraction of the control also round-trips
        byte-for-byte."""
        pdf = _wrap_pdf(_BASE_XML)
        self.assertEqual(_extraction_of(pdf), _BASE_XML)
        rep = self._report(pdf, profile="en16931")
        self.assertIsNone(rep.get("error"), rep)
        self.assertTrue(rep["valid"], rep)
        self.assertEqual(rep["fatal_count"], 0, rep)

    def test_rewrap_control_passes_through_cli(self):
        """CONTROL at the process boundary: the unmutated re-wrap exits 0
        (PASS) through the real CLI — giving the no-false-pass assertions below
        their teeth."""
        rc, out, err = self._run_report_cli(_wrap_pdf(_BASE_XML))
        self.assertEqual(rc, _report_mod.EXIT_OK, (out[-300:], err[-300:]))
        self.assertIn('"valid":true', out)
        self.assertNotIn(TRACEBACK_MARK, err)


class TestPopulationIsReproducible(SeamBase):
    """Determinism: a fixed SEED yields a byte-for-byte fixed draw of PDFs."""

    def test_two_seeded_generations_are_identical(self):
        first = _generate_population(SEED, _BASE_XML, N_MUTATIONS)
        second = _generate_population(SEED, _BASE_XML, N_MUTATIONS)
        self.assertEqual([p for p, _, _ in first], [p for p, _, _ in second],
                         "mutant population is NOT reproducible for a fixed "
                         "seed — the determinism pin is broken")
        self.assertEqual([p for p, _, _ in first],
                         [p for p, _, _ in _POPULATION])

    def test_population_size_and_strategy_coverage(self):
        self.assertGreaterEqual(N_MUTATIONS, 100)
        self.assertEqual(len(_POPULATION), N_MUTATIONS)
        self.assertGreaterEqual(len(_SUBSET_INDICES), 20)
        seen = {tag for _, _, tag in _POPULATION}
        # Every one of the four NAMED strategies must actually fire.
        self.assertEqual(seen, set(STRATEGIES),
                         "strategy coverage hole: %r" % sorted(seen))
        # And the subprocess sample itself must span several strategies.
        sample_seen = {_POPULATION[i][2] for i in _SUBSET_INDICES}
        self.assertGreaterEqual(len(sample_seen), 3, sorted(sample_seen))

    def test_every_mutant_alters_the_payload_and_still_extracts(self):
        # The seam premise: extraction SUCCEEDS (never the reject path) AND the
        # payload genuinely differs from the base — so any non-pass below is the
        # validator's verdict on a corrupt payload, not the extractor refusing.
        offenders = []
        for i, (pdf, payload, tag) in enumerate(_POPULATION):
            if _extraction_of(pdf) != payload:
                offenders.append("mutant #%d (%s): does not round-trip" % (i, tag))
            elif payload == _BASE_XML:
                offenders.append("mutant #%d (%s): payload == base" % (i, tag))
        self.assertEqual(offenders, [], "\n".join(offenders[:20]))


class TestSeamInProcessTotality(SeamBase):
    """Leg A: EVERY mutant through the real end-to-end ``build_report`` path.

    The seam invariant: a report dict in the documented shape (a ``valid``
    verdict OR a documented ``error``), never a traceback, never a hang, and
    NEVER a false pass — a corrupt embedded payload must not yield valid=true.
    """

    def test_seam_invariant_over_full_population(self):
        false_pass, bad_shape, bad_error = [], [], []
        wf_should_error = []
        start = time.monotonic()
        for idx, (pdf, payload, tag) in enumerate(_POPULATION):
            try:
                rep = self._report(pdf, profile="en16931")
            except Exception as exc:  # noqa: BLE001 — ANY escape is a failure
                bad_shape.append("mutant #%d (%s): build_report raised "
                                 "UNDOCUMENTED %s: %s"
                                 % (idx, tag, type(exc).__name__, exc))
                continue
            if not isinstance(rep, dict) or "valid" not in rep:
                bad_shape.append("mutant #%d (%s): report not a verdict dict: %r"
                                 % (idx, tag, rep))
                continue
            err = rep.get("error")
            if err is not None and err not in DOCUMENTED_ERRORS:
                bad_error.append("mutant #%d (%s): undocumented error %r"
                                 % (idx, tag, err))
            # NO SILENT PASS: every mutant genuinely corrupts the payload.
            if rep["valid"] is not False:
                false_pass.append("mutant #%d (%s): corrupt payload but "
                                  "valid=%r" % (idx, tag, rep["valid"]))
                continue
            # A non-pass must be substantiated: a documented parse error OR real
            # findings (>=1 fatal). An empty valid=false with no error and no
            # fatal would be a hollow verdict.
            if err is None and rep.get("fatal_count", 0) < 1:
                bad_error.append("mutant #%d (%s): valid=false but no error "
                                 "and zero fatals — hollow verdict" % (idx, tag))
            # The task's explicit pass-through case: truncation / wf-break must
            # surface as the documented not-well-formed parse error.
            if tag in ("truncate", "wf-break") and err != "not-well-formed":
                wf_should_error.append(
                    "mutant #%d (%s): expected error='not-well-formed', got "
                    "error=%r valid=%r" % (idx, tag, err, rep["valid"]))
        elapsed = time.monotonic() - start
        self.assertEqual(false_pass, [], "SILENT PASS at the seam:\n"
                         + "\n".join(false_pass[:20]))
        self.assertEqual(bad_shape, [], "\n".join(bad_shape[:20]))
        self.assertEqual(bad_error, [], "\n".join(bad_error[:20]))
        self.assertEqual(wf_should_error, [], "\n".join(wf_should_error[:20]))
        self.assertLess(elapsed, POPULATION_WALL_S,
                        "Leg A took %.1fs for %d mutants — pathological slowdown"
                        % (elapsed, N_MUTATIONS))

    def test_strategy_verdicts_are_as_documented(self):
        """The four strategies must reach the report path they claim: truncate /
        wf-break => not-well-formed; wrong-root & en16931-violating => a real
        fatal verdict (error is None, >=1 fatal)."""
        problems = []
        for idx, (pdf, payload, tag) in enumerate(_POPULATION):
            rep = self._report(pdf, profile="en16931")
            if tag in ("truncate", "wf-break"):
                if rep.get("error") != "not-well-formed":
                    problems.append("#%d %s: got error=%r" % (idx, tag,
                                                              rep.get("error")))
            else:  # wrong-root / en16931-violating
                if rep.get("error") is not None or rep.get("fatal_count", 0) < 1:
                    problems.append(
                        "#%d %s: expected real fatal findings, got error=%r "
                        "fatal=%r" % (idx, tag, rep.get("error"),
                                      rep.get("fatal_count")))
        self.assertEqual(problems, [], "\n".join(problems[:20]))


class TestSeamProcessBoundary(SeamBase):
    """Leg B: the fixed-seed subset through the REAL ``einvoice.report`` CLI
    across a process boundary (per-case timeout). Exit in {0,1,3} (documented,
    not widened), no traceback on either stream, no hang — and, since every
    mutant corrupts the payload, NEVER a false PASS (exit 0)."""

    def test_report_cli_contract_and_no_false_pass(self):
        bad_exit, tracebacks, false_pass = [], [], []
        for idx in _SUBSET_INDICES:
            pdf, payload, tag = _POPULATION[idx]
            rc, out, err = self._run_report_cli(pdf)
            if rc not in REPORT_EXITS:
                bad_exit.append("mutant #%d (%s): undocumented exit %r (not in "
                                "%s)" % (idx, tag, rc, sorted(REPORT_EXITS)))
            if TRACEBACK_MARK in out or TRACEBACK_MARK in err:
                tracebacks.append("mutant #%d (%s): traceback leak\nstderr=%r"
                                  % (idx, tag, err[-400:]))
            if rc == _report_mod.EXIT_OK:
                false_pass.append("mutant #%d (%s): corrupt payload but the CLI "
                                  "exited 0 (PASS) — a FALSE PASS" % (idx, tag))
        self.assertEqual(bad_exit, [], "\n".join(bad_exit))
        self.assertEqual(tracebacks, [], "\n".join(tracebacks[:10]))
        self.assertEqual(false_pass, [], "\n".join(false_pass))


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful():
        print("OK: %d seam mutants (%d via subprocess), seed=%#x"
              % (N_MUTATIONS, N_SUBPROCESS, SEED))
        sys.exit(0)
    sys.exit(1)
