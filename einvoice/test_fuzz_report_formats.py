#!/usr/bin/env python3
"""test_fuzz_report_formats.py — report-emitter TOTALITY over the fuzz corpus.

T-VHFUZZ.2, second task of the EPIC-VHFUZZ lane. T-VHFUZZ.1
(``test_fuzz_input.py``) proved the *front* of the pipeline is total: for any
byte sequence, ``report.build_report`` returns a real report dict rather than
raising. This suite proves the *back* of the pipeline is total too: EVERY
registered output format, driven over EVERY report the fuzz corpus produces,
must emit WELL-FORMED output — never an exception, never malformed JSON/XML,
never a half-rendered page.

The corpus is IMPORTED from ``test_fuzz_input`` (``_generate_population``,
``SEED``, ``_BASE``, ``N_MUTATIONS``) — the mutation machinery lives in one
place only; this file duplicates none of it. The population is therefore the
exact same seed-pinned draw of mutated blobs .1 exercises, byte-for-byte.

MEASURED (this run of the corpus, seed 0xF0221A7):
  * population size : 240 mutated blobs -> 240 reports through build_report
  * emitter defects : 0 — every registered format (text, json, junit, sarif,
    gitlab, github, azure, badge, html) was already total and well-formed over
    all 240 fuzz reports; the batch, diff and explain paths were likewise
    defect-free on their fixed-seed subsets. No change to einvoice/report.py
    was needed. (This count feeds T-VHFUZZ.3's land-or-drop decision.)

What the suite pins:

  * FORMAT-LIST PARITY: the set of formats exercised here is derived from the
    SAME source ``test_report_formats.accepted_formats()`` reads (the widest
    ``fmt not in (...)`` tuple in report.py), so registering a new format
    without adding its emitter+checker here turns this gate red automatically.

  * SINGLE-REPORT TOTALITY (full population, all 9 formats): for every fuzz
    report, each emitter returns without raising AND its output is well-formed:
      text   -> non-empty str;
      json   -> ``json.dumps(report)`` round-trips through ``json.loads``;
      junit  -> parses with ``xml.etree.ElementTree.fromstring``;
      sarif  -> ``json.loads`` + the SAME structural validation helper
                ``test_report_sarif._assert_valid_sarif_head`` applies
                (version 2.1.0, $schema, non-empty runs, driver name);
      gitlab -> ``json.loads`` yields a list of finding dicts;
      github -> every non-blank line is a ``::error|::warning|::notice``
                workflow command (with file=/title=) or a ``#`` comment,
                mirroring test_report_github.py's shape checks;
      azure  -> every non-blank line is ``##vso[task.logissue ...]`` (with
                sourcepath=/code=) or a ``#`` comment, per test_report_azure.py;
      badge  -> ``json.loads`` + the shields.io endpoint keys via
                ``test_report_badge._assert_valid_endpoint``;
      html   -> non-empty str containing ``<html`` that feeds through
                ``html.parser.HTMLParser`` without error.

  * BATCH path (fixed-seed subset of 20 blobs written to a temp dir):
    ``build_batch_report_from_files`` + ``build_batch_text`` +
    ``build_junit_batch`` — no throw, JSON round-trip, XML parses.

  * DIFF path (fixed-seed subset of 20): ``build_diff`` between the golden
    base report and each fuzz blob's report, BOTH directions — no throw,
    json-serializable.

  * EXPLAIN path: for every distinct rule id observed across ALL fuzz reports
    (plus a set of deliberately odd/unknown ids), ``format_explain`` never
    raises: a catalogued id yields a non-empty str, an uncatalogued id yields
    the documented clean miss (``None``) — never a traceback.

  * DETERMINISM: on a fixed-seed sample of 10 reports, a second emitter pass
    produces byte-identical output for every format (the corpus itself is
    already seed-pinned by the .1 import).

Changes NO parser / rule / report source. Stdlib only, offline, saxonche-free.
Run: python3 test_fuzz_report_formats.py
"""

from __future__ import annotations

import json
import os
import random
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# The corpus machinery is REUSED from T-VHFUZZ.1 — no mutation code lives here.
from test_fuzz_input import (  # noqa: E402
    _generate_population, SEED, _BASE, N_MUTATIONS, GOLDEN,
)
# Format list derived from the same source test_report_formats reads, and the
# committed validation helpers reused verbatim (zero new validation logic).
from test_report_formats import accepted_formats  # noqa: E402
from test_report_sarif import _assert_valid_sarif_head  # noqa: E402
from test_report_badge import _assert_valid_endpoint  # noqa: E402

from einvoice.report import (  # noqa: E402
    build_report, build_text, build_junit, build_sarif, build_gitlab,
    build_github, build_azure, build_badge, build_html,
    build_batch_report_from_files, build_batch_text, build_junit_batch,
    build_diff, format_explain,
)
from einvoice.remediation import load_catalog  # noqa: E402

# The exact seed-pinned population T-VHFUZZ.1 exercises (byte-for-byte: same
# seed, same base bytes, same count, same generator).
_POPULATION = _generate_population(SEED, _BASE, N_MUTATIONS)

# Fixed-seed subset sizes for the heavy paths (mirrors .1's N_SUBPROCESS
# sampling style: a SEPARATE seeded generator per subset so none perturbs
# another draw).
N_BATCH = 20
N_DIFF = 20
N_DETERMINISM = 10

_BATCH_INDICES = tuple(sorted(
    random.Random(SEED ^ 0xBA7C4).sample(range(N_MUTATIONS), N_BATCH)))
_DIFF_INDICES = tuple(sorted(
    random.Random(SEED ^ 0xD1FF).sample(range(N_MUTATIONS), N_DIFF)))
_DETERMINISM_INDICES = tuple(sorted(
    random.Random(SEED ^ 0xDE7).sample(range(N_MUTATIONS), N_DETERMINISM)))


def _report_for(blob):
    """Run one blob through ``build_report`` via a temp file (the .1 boundary)."""
    fd, path = tempfile.mkstemp(suffix=".xml", prefix="einvoice-fuzzfmt-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(blob)
        return build_report(path, profile="xrechnung")
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


# Build every fuzz report ONCE and share it across tests (build_report totality
# over this exact population is already .1's theorem; a raise here is a real
# regression and fails at import with a visible traceback).
_REPORTS = [_report_for(blob) for blob, _tag in _POPULATION]


# --------------------------------------------------------------------------- #
# Emitters + per-format well-formedness checkers. Keys MUST stay in parity
# with accepted_formats() — asserted below — so a future format cannot land
# without fuzz coverage.
# --------------------------------------------------------------------------- #
def _check_text(tc, out):
    tc.assertIsInstance(out, str)
    tc.assertTrue(out.strip(), "text emitted empty output")


def _check_json(tc, out):
    tc.assertIsInstance(out, str)
    json.loads(out)  # raises -> test fails, which is the point


def _check_junit(tc, out):
    tc.assertIsInstance(out, str)
    ET.fromstring(out)  # raises ParseError on malformed XML


def _check_sarif(tc, out):
    doc = json.loads(out)
    _assert_valid_sarif_head(tc, doc)  # the committed SARIF validation helper


def _check_gitlab(tc, out):
    obj = json.loads(out)
    tc.assertIsInstance(obj, list, "gitlab output is not a JSON list")
    for item in obj:
        tc.assertIsInstance(item, dict,
                            "gitlab finding is not a dict: %r" % (item,))


def _check_github(tc, out):
    tc.assertIsInstance(out, str)
    for line in out.splitlines():
        if not line.strip():
            continue
        tc.assertTrue(
            line.startswith(("::error ", "::warning ", "::notice ", "#")),
            "github line is not a workflow command or comment: %r" % line)
        if line.startswith("::"):
            tc.assertIn("file=", line,
                        "github command line missing file=: %r" % line)
            tc.assertIn("title=", line,
                        "github command line missing title=: %r" % line)


def _check_azure(tc, out):
    tc.assertIsInstance(out, str)
    for line in out.splitlines():
        if not line.strip():
            continue
        if line.startswith("##vso[task.logissue "):
            tc.assertIn("sourcepath=", line,
                        "azure logissue line missing sourcepath=: %r" % line)
            tc.assertIn("code=", line,
                        "azure logissue line missing code=: %r" % line)
        else:
            tc.assertTrue(
                line.startswith("#"),
                "azure line is not a logissue command or comment: %r" % line)


def _check_badge(tc, out):
    doc = json.loads(out)
    _assert_valid_endpoint(tc, doc)  # the committed shields.io key pins


def _check_html(tc, out):
    tc.assertIsInstance(out, str)
    tc.assertTrue(out.strip(), "html emitted empty output")
    tc.assertIn("<html", out.lower())
    parser = HTMLParser(convert_charrefs=True)
    parser.feed(out)   # any exception fails the test
    parser.close()


#: fmt -> (emitter over a report dict, well-formedness checker). The sarif /
#: gitlab / badge builders return Python objects and the CLI serialises them
#: with ``json.dumps(..., sort_keys=True)`` — the emitters here mirror that
#: exact wrapping so the fuzz drives the same build+serialise pipeline the
#: shipped ``--format`` path runs.
EMITTERS = {
    "text": (build_text, _check_text),
    "json": (lambda rep: json.dumps(rep, sort_keys=True), _check_json),
    "junit": (build_junit, _check_junit),
    "sarif": (lambda rep: json.dumps(build_sarif(rep), sort_keys=True),
              _check_sarif),
    "gitlab": (lambda rep: json.dumps(build_gitlab(rep), sort_keys=True),
               _check_gitlab),
    "github": (build_github, _check_github),
    "azure": (build_azure, _check_azure),
    "badge": (lambda rep: json.dumps(build_badge(rep), sort_keys=True),
              _check_badge),
    "html": (build_html, _check_html),
}


class TestFormatListParity(unittest.TestCase):
    """The exercised format set equals the set report.py actually registers."""

    def test_emitter_table_matches_accepted_formats(self):
        self.assertEqual(
            set(EMITTERS), accepted_formats(),
            "EMITTERS drifted from report.py's registered --format set — a "
            "new format MUST gain fuzz coverage here (or a removed one must "
            "be dropped)")

    def test_population_is_the_dot1_corpus(self):
        # Same machinery, same seed, same count as test_fuzz_input.
        self.assertEqual(len(_POPULATION), N_MUTATIONS)
        self.assertEqual(len(_REPORTS), N_MUTATIONS)
        self.assertEqual(SEED, 0xF0221A7)


class TestSingleReportEmitterTotality(unittest.TestCase):
    """Every registered format over EVERY fuzz report: no throw, well-formed."""

    def test_every_format_total_and_well_formed_over_population(self):
        for fmt in sorted(accepted_formats()):
            emitter, checker = EMITTERS[fmt]
            with self.subTest(fmt=fmt):
                failures = []
                for idx, rep in enumerate(_REPORTS):
                    tag = _POPULATION[idx][1]
                    try:
                        out = emitter(rep)
                        checker(self, out)
                    except AssertionError:
                        raise  # a checker failure carries its own message
                    except Exception as exc:  # noqa: BLE001 — totality is the point
                        failures.append(
                            "report #%d (%s): %s raised %s: %s"
                            % (idx, tag, fmt, type(exc).__name__, exc))
                self.assertEqual(
                    failures, [],
                    "%s emitter is NOT total over fuzz reports:\n%s"
                    % (fmt, "\n".join(failures[:20])))

    def test_json_round_trips_every_report(self):
        # (b) of the spec verbatim: dumps -> loads is the identity on the dict.
        for idx, rep in enumerate(_REPORTS):
            back = json.loads(json.dumps(rep))
            self.assertEqual(
                back, rep,
                "report #%d does not survive a json round-trip" % idx)


class TestBatchPathTotality(unittest.TestCase):
    """Fixed-seed subset through the three batch surfaces: no throw, well-formed."""

    def test_batch_report_text_and_junit_over_fuzz_files(self):
        with tempfile.TemporaryDirectory(prefix="einvoice-fuzzbatch-") as tmp:
            paths = []
            for idx in _BATCH_INDICES:
                blob, _tag = _POPULATION[idx]
                p = os.path.join(tmp, "case-%03d.xml" % idx)
                with open(p, "wb") as fh:
                    fh.write(blob)
                paths.append(p)

            batch = build_batch_report_from_files(
                sorted(paths), profile="xrechnung", root=tmp)
            self.assertIsInstance(batch, dict)
            self.assertEqual(batch.get("file_count"), len(paths))
            # JSON-serializable and round-trips.
            self.assertEqual(json.loads(json.dumps(batch)), batch)

            text = build_batch_text(batch)
            self.assertIsInstance(text, str)
            self.assertTrue(text.strip(), "batch text emitted empty output")

            junit = build_junit_batch(batch)
            self.assertIsInstance(junit, str)
            root = ET.fromstring(junit)  # malformed XML raises -> fails
            self.assertEqual(root.tag, "testsuites")


class TestDiffPathTotality(unittest.TestCase):
    """build_diff golden<->fuzz in BOTH directions: no throw, json-serializable."""

    @classmethod
    def setUpClass(cls):
        cls.golden_report = build_report(GOLDEN, profile="xrechnung")

    def test_diff_both_directions_on_subset(self):
        for idx in _DIFF_INDICES:
            blob, tag = _POPULATION[idx]
            fuzz_report = _REPORTS[idx]
            fd, path = tempfile.mkstemp(
                suffix=".xml", prefix="einvoice-fuzzdiff-")
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(blob)
                with self.subTest(idx=idx, tag=tag, direction="fuzz-vs-golden"):
                    # Direction 1: current = fuzz blob, baseline = golden report.
                    diff = build_diff(path, self.golden_report,
                                      profile="xrechnung",
                                      baseline_path="<golden>")
                    self.assertIsInstance(diff, dict)
                    self.assertEqual(json.loads(json.dumps(diff)), diff)
                with self.subTest(idx=idx, tag=tag, direction="golden-vs-fuzz"):
                    # Direction 2: current = golden file, baseline = fuzz report.
                    diff = build_diff(GOLDEN, fuzz_report,
                                      profile="xrechnung",
                                      baseline_path="<fuzz-%d>" % idx)
                    self.assertIsInstance(diff, dict)
                    self.assertEqual(json.loads(json.dumps(diff)), diff)
            finally:
                try:
                    os.unlink(path)
                except OSError:
                    pass


class TestExplainPathTotality(unittest.TestCase):
    """format_explain over every observed rule id (+ odd ids): never a traceback."""

    def test_every_observed_rule_id_explains_cleanly(self):
        observed = sorted({
            rec.get("rule")
            for rep in _REPORTS
            for rec in rep.get("violations", [])
            if isinstance(rec, dict) and rec.get("rule")
        })
        self.assertTrue(observed,
                        "fuzz corpus produced no violations at all — the "
                        "explain leg would be vacuous")
        catalog = load_catalog()
        canonical = {k.upper() for k in catalog}
        for rid in observed:
            with self.subTest(rule_id=rid):
                block = format_explain(rid)  # any raise fails the test
                if rid.upper() in canonical:
                    self.assertIsInstance(block, str)
                    self.assertTrue(block.strip(),
                                    "catalogued id %r explained to empty" % rid)
                else:
                    # Documented clean miss for an uncatalogued id: None,
                    # never a traceback (the CLI turns this into a clear
                    # 'unknown rule id' error + exit 1).
                    self.assertIsNone(block)

    def test_odd_and_unknown_ids_never_raise(self):
        for rid in ("", "NO-SUCH-RULE", "br-de-15", "BR-DE-15 ",
                    "\x00weird\x00", "<script>", "…", "A" * 512):
            with self.subTest(rule_id=rid):
                block = format_explain(rid)  # must not raise
                self.assertTrue(block is None or isinstance(block, str))


class TestEmitterDeterminism(unittest.TestCase):
    """A second emitter pass is byte-identical (corpus is already seed-pinned)."""

    def test_second_pass_identical_on_fixed_sample(self):
        for idx in _DETERMINISM_INDICES:
            rep = _REPORTS[idx]
            for fmt in sorted(EMITTERS):
                emitter, _checker = EMITTERS[fmt]
                with self.subTest(idx=idx, fmt=fmt):
                    self.assertEqual(
                        emitter(rep), emitter(rep),
                        "%s emit is not repeatable on report #%d" % (fmt, idx))


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful():
        print("OK: %d formats x %d fuzz reports, seed=%d"
              % (len(EMITTERS), len(_REPORTS), SEED))
        sys.exit(0)
    sys.exit(1)
