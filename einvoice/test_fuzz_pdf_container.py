#!/usr/bin/env python3
"""test_fuzz_pdf_container.py — seeded byte-mutation fuzz over the PDF path.

The PDF container path (:mod:`einvoice.pdf_container`) was the last unfuzzed
input surface: ``test_fuzz_input.py`` mutates the golden UBL XML and
``test_fuzz_report_formats.py`` fuzzes the report emitters, but neither ever
feeds a mutated *PDF* to the extractor (measured before this task:
``grep -ci pdf`` over both = 0). ``test_pdf_container.py`` pins 35 targeted,
KNOWN container shapes; this suite is DISJOINT from it the same way
``test_fuzz_input.py`` is disjoint from ``test_robustness*.py``: a large,
deterministic POPULATION of byte-level mutants of the two committed VALID
fixtures, to catch the unknown malformed shape nobody enumerated.

The contract under test is the one ``pdf_container``'s docstrings state:

  * :func:`einvoice.pdf_container.inspect_container_from_bytes` and
    :func:`einvoice.pdf_container.extract_invoice_xml_from_bytes` either
    return their documented result (a ``ContainerInspection`` / the XML
    ``bytes``) or raise exactly ``UnsupportedContainer`` ("never a false pass,
    never a traceback"). ANY other exception type escaping is a harness
    FAILURE — the allowed set is deliberately NOT widened beyond what the
    module docstring documents.
  * At the real process boundary the exit code is always a member of the
    documented set and no Python traceback ever reaches stderr.

What the suite pins:

  * DETERMINISM: every mutant is drawn from a FIXED-``SEED``
    :class:`random.Random`; the population is built twice from two freshly
    seeded generators and the two blob lists must be byte-for-byte IDENTICAL.

  * >=5 NAMED mutation strategies (>= ``N_MUTATIONS`` mutants total), each
    driven only by ``rng``:
      (1) ``truncate``        — cut the file at a seeded offset;
      (2) ``struct-corrupt``  — corrupt/delete a seeded occurrence of a PDF
                                structure token (``%PDF-``, ``%%EOF``,
                                ``xref``, ``startxref``, ``trailer``);
      (3) ``stream-corrupt``  — flip bytes INSIDE a stream body; this strategy
                                always mutates the /FlateDecode fixture so the
                                flip lands in deflate-compressed payload;
      (4) ``filespec-mangle`` — mutate the byte range of an EmbeddedFiles
                                name-tree / AF filespec dict token
                                (``/EmbeddedFiles``, ``/AF``, ``/EF``, ``/UF``,
                                ``/AFRelationship``, ``/Names``, ``/Filespec``,
                                ``factur-x.xml``);
      (5) ``byte-flip``       — XOR 1..8 seeded positions with a non-zero byte.

  * LEG A (all mutants, in-process): each mutant through BOTH
    ``inspect_container_from_bytes`` and ``extract_invoice_xml_from_bytes``;
    only a documented result object or ``UnsupportedContainer`` may come back.
    A per-population wall-time sanity bound guards against a pathological
    hang/blow-up (each call is sub-millisecond on the ~24 KiB fixtures).

  * LEG B (a fixed-seed sample of >= ``N_SUBPROCESS`` mutants) through TWO
    real process boundaries, each with a per-case timeout:

      (i)  ``python3 -m einvoice validate <mutant.pdf>`` — the ``einvoice``
           CLI. MEASURED asymmetry, documented here on purpose: this
           single-file subcommand is XML-only (usage: ``validate
           <invoice.xml|->``); the PDF container path is wired into
           ``einvoice.report`` / ``validate-batch``, NOT into single-file
           ``validate``. Any PDF (including the unmutated valid fixture)
           therefore lands on the documented exit 3 (S-WF not-well-formed) —
           an honest non-pass, never a false green, never a traceback. The
           contract asserted is EXIT-CODES.md membership {0,1,2,3} + zero
           traceback + no hang.
      (ii) ``python3 -m einvoice.report --profile en16931 <mutant.pdf>`` —
           the CLI that actually exercises the PDF container path across a
           process boundary (documented exits {0,1,3}; the unmutated base is
           a real PASS under en16931, which is what gives the honesty check
           below its teeth).

    HONESTY: on surface (ii) a mutant may legitimately exit 0 (PASS) ONLY if
    its extracted invoice XML is byte-identical to the unmutated base
    fixture's extracted XML (the mutation missed the embedded payload, e.g. a
    flip inside XMP whitespace). Any mutant whose payload extraction differs
    or raises must exit in the documented non-pass set — asserted exactly.
    On surface (i) exit 0 would require the raw mutant bytes to be a fully
    valid XRechnung XML document; the same PASS-implies-identical-payload
    assertion is applied there too.

No new fixture, no source change, no new dependency: every input is derived
at runtime from the two committed valid fixtures
(``corpus/pdf/facturx-valid.pdf`` and ``corpus/pdf/facturx-valid-
uncompressed.pdf``, both embedding the same ``CII_example5.xml`` payload —
asserted). Mutant files touch disk only inside a ``tempfile`` tempdir.
Standard library only. Runs offline. Run: python3 test_fuzz_pdf_container.py

No defect was found by this harness at introduction time: both legs came back
clean over the full population (only documented results / documented exits),
so per the task contract there is no source fix and no pinned regression seed.
"""

from __future__ import annotations

import os
import random
import re
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import pdf_container  # noqa: E402
from einvoice.pdf_container import (  # noqa: E402
    ContainerInspection, UnsupportedContainer,
)
# Symbolic exit codes come from the shipped modules so this test pins the SAME
# numbers the docs document, never hand-copied literals.
from einvoice.cli import (  # noqa: E402
    EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE,
)
from einvoice import report as _report_mod  # noqa: E402

PDF_DIR = os.path.join(HERE, "corpus", "pdf")
VALID_PDF = os.path.join(PDF_DIR, "facturx-valid.pdf")           # /FlateDecode
VALID_PDF_RAW = os.path.join(PDF_DIR, "facturx-valid-uncompressed.pdf")

TRACEBACK_MARK = "Traceback (most recent call last)"

#: Documented exit-code set of ``python3 -m einvoice validate`` (EXIT-CODES.md;
#: symbolic constants from einvoice/cli.py). Membership is the contract.
VALIDATE_EXITS = frozenset({EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE})

#: Documented exit-code set of ``python3 -m einvoice.report`` (its module
#: docstring + main(): EXIT_OK=0 / EXIT_FAIL=1 / EXIT_PARSE=3 — the
#: "unsupported PDF container" non-pass is EXIT_PARSE).
REPORT_EXITS = frozenset({
    _report_mod.EXIT_OK, _report_mod.EXIT_FAIL, _report_mod.EXIT_PARSE})

# Fixed integer seed => the ENTIRE mutant population is byte-for-byte
# reproducible run to run.
SEED = 0xFD7C0DE1

#: Population size (>=150 required) and the subprocess-boundary sample size
#: (>=30 required). Both driven off the fixed seed only.
N_MUTATIONS = 180
N_SUBPROCESS = 32

#: Per-case wall-clock ceiling at the process boundary. A legitimate run
#: finishes in ~0.1 s (measured); a hang blows past this and FAILS the test.
CASE_TIMEOUT_S = 30.0

#: Wall-time sanity bound for pushing the WHOLE population through both
#: in-process entry points (Leg A). Each call is sub-millisecond on these
#: ~4-25 KiB mutants; 60 s is two orders of magnitude of headroom on a loaded
#: box while still catching a real hang / pathological blow-up.
POPULATION_WALL_S = 60.0

#: The five named strategies, indexed by the selector in _mutate_once.
STRATEGIES = (
    "truncate",
    "struct-corrupt",
    "stream-corrupt",
    "filespec-mangle",
    "byte-flip",
)

#: PDF structure tokens targeted by ``struct-corrupt`` (header, EOF marker,
#: classic cross-reference table, trailer, startxref pointer).
_STRUCT_TOKENS = (b"%PDF-", b"%%EOF", b"xref", b"startxref", b"trailer")

#: EmbeddedFiles name-tree / AF filespec dict tokens targeted by
#: ``filespec-mangle`` (the walk pdf_container performs: catalog /Names ->
#: /EmbeddedFiles -> filespec /EF /F|/UF (+ /AF, /AFRelationship checks) and
#: the invoice attachment name itself).
_FILESPEC_TOKENS = (b"/EmbeddedFiles", b"/AFRelationship", b"/Filespec",
                    b"/Names", b"/AF", b"/EF", b"/UF", b"factur-x.xml")


def _read(path):
    with open(path, "rb") as fh:
        return fh.read()


def _token_spans(base, tokens):
    """Every (start, end) occurrence of any of ``tokens`` in ``base``, in a
    deterministic (position-sorted) order."""
    spans = []
    for tok in tokens:
        for m in re.finditer(re.escape(tok), base):
            spans.append((m.start(), m.end()))
    spans.sort()
    return spans


def _stream_spans(base):
    """The (start, end) byte range of every ``stream ... endstream`` body."""
    spans = []
    for m in re.finditer(rb"stream\r?\n", base):
        start = m.end()
        end = base.find(b"endstream", start)
        if end > start:
            spans.append((start, end))
    return spans


def _corrupt_span(rng, buf, span):
    """Apply one seeded corruption to ``buf`` inside ``span``: XOR a byte,
    overwrite the span with random bytes, or delete it outright."""
    a, b = span
    action = rng.randrange(3)
    if action == 0:  # flip one byte inside the span
        pos = rng.randrange(a, b)
        buf[pos] ^= rng.randint(1, 255)
    elif action == 1:  # overwrite the span with random bytes (same length)
        buf[a:b] = bytes(rng.randint(0, 255) for _ in range(b - a))
    else:  # delete the span entirely
        del buf[a:b]


def _mutate_once(rng, bases):
    """Produce ONE mutant, driven entirely by ``rng``.

    ``bases`` is ``{"flate": bytes, "raw": bytes}`` (the two committed valid
    fixtures). Returns ``(mutant_bytes, strategy_tag)``. Strategy selection,
    base selection and every offset come from ``rng`` alone, so a fixed seed
    fixes the whole sequence.
    """
    strat = rng.randrange(len(STRATEGIES))
    if strat == 2:
        # stream-corrupt always hits the /FlateDecode fixture so the flip
        # lands inside deflate-compressed payload (the named strategy).
        base = bases["flate"]
    else:
        base = bases["flate"] if rng.random() < 0.5 else bases["raw"]
    n = len(base)
    buf = bytearray(base)

    if strat == 0:
        # (1) truncation at a seeded offset (may leave 0 bytes .. n-1 bytes).
        buf = bytearray(base[:rng.randrange(n)])

    elif strat == 1:
        # (2) header / %%EOF / xref-table / trailer corruption.
        spans = _token_spans(base, _STRUCT_TOKENS)
        _corrupt_span(rng, buf, rng.choice(spans))

    elif strat == 2:
        # (3) FlateDecode stream-byte corruption: flip 1..8 bytes inside one
        # stream body (embedded invoice, XMP metadata, ...).
        a, b = rng.choice(_stream_spans(base))
        for _ in range(rng.randint(1, 8)):
            pos = rng.randrange(a, b)
            buf[pos] ^= rng.randint(1, 255)

    elif strat == 3:
        # (4) EmbeddedFiles name-tree / AF filespec token mangling.
        spans = _token_spans(base, _FILESPEC_TOKENS)
        _corrupt_span(rng, buf, rng.choice(spans))

    else:
        # (5) random byte flips: XOR 1..8 seeded positions.
        for _ in range(rng.randint(1, 8)):
            pos = rng.randrange(n)
            buf[pos] ^= rng.randint(1, 255)

    return bytes(buf), STRATEGIES[strat]


def _generate_population(seed, bases, count):
    """Build the FIXED mutant population from a freshly seeded generator.
    Same (seed, bases, count) => byte-for-byte identical output."""
    rng = random.Random(seed)
    return [_mutate_once(rng, bases) for _ in range(count)]


# Build the population ONCE at import so every test shares the same draw.
_BASES = {"flate": _read(VALID_PDF), "raw": _read(VALID_PDF_RAW)}
_POPULATION = _generate_population(SEED, _BASES, N_MUTATIONS)

#: The payload both valid fixtures embed (asserted equal below): the byte
#: string a mutant must STILL extract for a PASS exit to be legitimate.
_BASE_XML = pdf_container.extract_invoice_xml_from_bytes(_BASES["flate"])

# Deterministic subprocess sample from a SEPARATE fixed generator so it never
# perturbs the population draw above (same pattern as test_fuzz_input.py).
_SUBSET_INDICES = tuple(sorted(
    random.Random(SEED ^ 0x5EED).sample(range(N_MUTATIONS), N_SUBPROCESS)))


def _extraction_of(blob):
    """In-process extraction outcome for ``blob``: the XML bytes, or None when
    the container is (documented-)unsupported."""
    try:
        return pdf_container.extract_invoice_xml_from_bytes(blob)
    except UnsupportedContainer:
        return None


class FuzzPdfBase(unittest.TestCase):
    """Shared helper: drive one CLI on a mutant staged in a tempdir."""

    def _run_cli(self, module_args, blob):
        """Write ``blob`` to a tempdir .pdf, run ``python3 -m <module_args>``
        on it with a per-case timeout. A timeout is a FAILURE (hang), never a
        blocked suite. Returns ``(returncode, stdout, stderr)``."""
        with tempfile.TemporaryDirectory(prefix="einvoice-pdf-fuzz-") as tmp:
            path = os.path.join(tmp, "mutant.pdf")
            with open(path, "wb") as fh:
                fh.write(blob)
            try:
                proc = subprocess.run(
                    [sys.executable, "-m"] + module_args + [path],
                    cwd=HERE, capture_output=True, text=True,
                    timeout=CASE_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                self.fail("CLI %r hung > %.0fs on a fuzzed PDF — a hang is a "
                          "TOTALITY FAILURE" % (module_args, CASE_TIMEOUT_S))
            return proc.returncode, proc.stdout, proc.stderr


class TestFixturesAndSetup(FuzzPdfBase):
    def test_bases_present_and_share_one_payload(self):
        self.assertGreater(len(_BASES["flate"]), 1000)
        self.assertGreater(len(_BASES["raw"]), 1000)
        # Both fixtures embed the SAME CII invoice — the single reference
        # payload the PASS-honesty assertion compares against.
        self.assertEqual(
            pdf_container.extract_invoice_xml_from_bytes(_BASES["raw"]),
            _BASE_XML)
        self.assertGreater(len(_BASE_XML), 1000)

    def test_unmutated_bases_are_the_documented_controls(self):
        """Controls proving the mutants stress the pipeline BECAUSE of the
        mutation: the report CLI really PASSes the unmutated bases under
        en16931, and the XML-only validate subcommand lands every PDF on the
        documented exit 3 (S-WF) with a clean stderr."""
        for base in (_BASES["flate"], _BASES["raw"]):
            rc, out, err = self._run_cli(
                ["einvoice.report", "--profile", "en16931"], base)
            self.assertEqual(rc, EXIT_OK, (out[-300:], err[-300:]))
            self.assertIn('"valid":true', out)
            rc, out, err = self._run_cli(["einvoice", "validate"], base)
            self.assertEqual(rc, EXIT_PARSE, (out[-300:], err[-300:]))
            self.assertNotIn(TRACEBACK_MARK, err)

    def test_documented_exit_symbols(self):
        # Guards against accidental repurposing of a documented code.
        self.assertEqual((EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE),
                         (0, 1, 2, 3))
        self.assertEqual(VALIDATE_EXITS, {0, 1, 2, 3})
        self.assertEqual(REPORT_EXITS, {0, 1, 3})


class TestPopulationIsReproducible(FuzzPdfBase):
    """The determinism leg: a fixed SEED yields a byte-for-byte fixed draw."""

    def test_two_seeded_generations_are_identical(self):
        first = _generate_population(SEED, _BASES, N_MUTATIONS)
        second = _generate_population(SEED, _BASES, N_MUTATIONS)
        self.assertEqual([b for b, _ in first], [b for b, _ in second],
                         "mutant population is NOT reproducible for a fixed "
                         "seed — the reproduce-yourself foundation is broken")
        self.assertEqual([b for b, _ in first], [b for b, _ in _POPULATION])

    def test_population_size_and_strategy_coverage(self):
        self.assertGreaterEqual(N_MUTATIONS, 150)
        self.assertGreaterEqual(N_SUBPROCESS, 30)
        self.assertEqual(len(_POPULATION), N_MUTATIONS)
        self.assertGreaterEqual(len(_SUBSET_INDICES), 30)
        seen = {tag for _, tag in _POPULATION}
        # Every one of the five NAMED strategies must actually fire.
        self.assertEqual(seen, set(STRATEGIES),
                         "strategy coverage hole: %r" % sorted(seen))
        # And the subprocess sample itself must span several strategies.
        sample_seen = {_POPULATION[i][1] for i in _SUBSET_INDICES}
        self.assertGreaterEqual(len(sample_seen), 3, sorted(sample_seen))

    def test_mutants_differ_from_their_bases(self):
        # Sanity: mutation is real — no mutant equals a committed fixture.
        originals = set(_BASES.values())
        same = [i for i, (blob, _) in enumerate(_POPULATION)
                if blob in originals]
        self.assertEqual(same, [],
                         "mutants identical to a base fixture: %r" % same)


class TestLegAInProcessTotality(FuzzPdfBase):
    """Leg A: every mutant through inspect_container_from_bytes AND
    extract_invoice_xml_from_bytes. The documented contract (module + function
    docstrings of einvoice/pdf_container.py, pinned by test_pdf_container.py)
    is: a ContainerInspection / bytes result, or UnsupportedContainer —
    nothing else. The allowed exception set is deliberately NOT widened."""

    def test_only_documented_results_or_unsupported_container(self):
        failures = []
        start = time.monotonic()
        for idx, (blob, tag) in enumerate(_POPULATION):
            for name, fn, want_type in (
                    ("inspect_container_from_bytes",
                     pdf_container.inspect_container_from_bytes,
                     ContainerInspection),
                    ("extract_invoice_xml_from_bytes",
                     pdf_container.extract_invoice_xml_from_bytes,
                     bytes)):
                try:
                    result = fn(blob)
                except UnsupportedContainer:
                    continue  # the documented refusal — always acceptable
                except Exception as exc:  # noqa: BLE001 — the point is ANY other
                    failures.append(
                        "mutant #%d (%s, %d bytes): %s raised UNDOCUMENTED "
                        "%s: %s" % (idx, tag, len(blob), name,
                                    type(exc).__name__, exc))
                    continue
                if not isinstance(result, want_type):
                    failures.append(
                        "mutant #%d (%s): %s returned non-%s %r"
                        % (idx, tag, name, want_type.__name__,
                           type(result).__name__))
                elif (want_type is ContainerInspection
                      and not isinstance(result.xml_bytes, bytes)):
                    failures.append(
                        "mutant #%d (%s): ContainerInspection.xml_bytes is %r"
                        % (idx, tag, type(result.xml_bytes).__name__))
        elapsed = time.monotonic() - start
        self.assertEqual(
            failures, [],
            "PDF container path is NOT total over fuzzed input:\n"
            + "\n".join(failures[:20]))
        # Per-population wall-time sanity bound (hang / blow-up guard).
        self.assertLess(
            elapsed, POPULATION_WALL_S,
            "Leg A took %.1fs for %d mutants — pathological slowdown"
            % (elapsed, N_MUTATIONS))


class TestLegBProcessBoundary(FuzzPdfBase):
    """Leg B: the fixed-seed sample through the real CLIs (per-case timeout).

    Contract per surface:
      * ``python3 -m einvoice validate``: exit in {0,1,2,3} (EXIT-CODES.md),
        no Traceback on either stream, no hang.
      * ``python3 -m einvoice.report --profile en16931``: exit in {0,1,3},
        no Traceback, no hang; this is the surface that actually walks the
        mutated container.
    HONESTY on both: exit 0 (PASS) is legitimate ONLY when the mutant's
    extracted invoice XML is byte-identical to the unmutated base's — so any
    mutant whose payload extraction differs or fails must land in the
    documented non-pass set.
    """

    def _drive(self, module_args, documented_exits):
        bad_exit, tracebacks, false_pass = [], [], []
        passes = 0
        for idx in _SUBSET_INDICES:
            blob, tag = _POPULATION[idx]
            rc, out, err = self._run_cli(module_args, blob)
            if rc not in documented_exits:
                bad_exit.append("mutant #%d (%s): undocumented exit %r "
                                "(not in %s)" % (idx, tag, rc,
                                                 sorted(documented_exits)))
            if TRACEBACK_MARK in out or TRACEBACK_MARK in err:
                tracebacks.append(
                    "mutant #%d (%s): traceback leak\nstdout=%r\nstderr=%r"
                    % (idx, tag, out[-400:], err[-400:]))
            if rc == 0:
                passes += 1
                # A PASS is only honest when the mutation missed the payload:
                # the extraction must succeed AND be byte-identical to the
                # unmutated base fixture's extracted XML.
                if _extraction_of(blob) != _BASE_XML:
                    false_pass.append(
                        "mutant #%d (%s): exit 0 but its extracted payload "
                        "differs from (or fails against) the base fixture's "
                        "XML — a FALSE PASS" % (idx, tag))
        self.assertEqual(bad_exit, [], "\n".join(bad_exit))
        self.assertEqual(tracebacks, [], "\n".join(tracebacks[:10]))
        self.assertEqual(false_pass, [], "\n".join(false_pass))
        return passes

    def test_validate_cli_contract(self):
        self._drive(["einvoice", "validate"], VALIDATE_EXITS)

    def test_report_cli_contract_and_pass_honesty(self):
        self._drive(["einvoice.report", "--profile", "en16931"], REPORT_EXITS)

    def test_altered_payload_never_passes_report_cli(self):
        """The contrapositive, asserted directly on the sample: every mutant
        whose in-process extraction differs from the base payload (or is
        refused) must exit NON-ZERO on the PDF-walking surface."""
        offenders = []
        for idx in _SUBSET_INDICES:
            blob, tag = _POPULATION[idx]
            if _extraction_of(blob) == _BASE_XML:
                continue  # payload untouched — a PASS would be legitimate
            rc, out, err = self._run_cli(
                ["einvoice.report", "--profile", "en16931"], blob)
            if rc == 0:
                offenders.append(
                    "mutant #%d (%s): altered/failed payload but exit 0"
                    % (idx, tag))
        self.assertEqual(offenders, [], "\n".join(offenders))


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful():
        print("OK: %d PDF mutants (%d via subprocess), seed=%d"
              % (N_MUTATIONS, N_SUBPROCESS, SEED))
        sys.exit(0)
    sys.exit(1)
