#!/usr/bin/env python3
"""test_idempotence.py — T-VHIDEMPOT.1: pin validation-output IDEMPOTENCE and
within-file DETERMINISTIC finding order for the einvoice conformance engine.

MEASURE-FIRST FINDINGS (what the sibling tests already pin, read 2026-07-16)
----------------------------------------------------------------------------
* ``test_golden_snapshot.py`` pins CROSS-CHANGE stability of a deliberately
  NORMALIZED projection per curated fixture (``valid`` / ``exit_code`` /
  SORTED ``(rule, severity)`` pairs, messages and paths DROPPED) against
  committed golden files. Because it sorts the fired rules and excludes
  messages, it does NOT pin raw-output byte idempotence within a process,
  does NOT pin the finding EMISSION order, and does NOT pin message-text
  stability between two runs. Those legs were genuinely missing.
* ``test_determinism.py`` pins byte-reproducibility of the COMMITTED GENERATED
  ARTIFACTS (every ``gen_*.py`` regenerated into a temp copy must byte-match
  what is committed). It says nothing about the validation REPORT output of
  ``einvoice.report`` — a different surface entirely.
* ``test_report_batch.py`` pins the batch wrapper: per-file reports inside a
  batch are byte-identical to standalone ``build_report`` runs
  (``SingleFileUnchanged``) and the batch ``files`` array is sorted by path
  (``test_mixed_folder_aggregate_shape_and_counts`` asserts
  ``sources == sorted(sources)``; ``collect_invoice_files`` documents and
  returns a sorted walk). NOTE FOR THE STRATEGIST re T-VHIDEMPOT.2: batch
  FILE-ordering determinism (files sorted by path, regardless of filesystem
  enumeration order) is therefore ALREADY pinned by test_report_batch.py;
  what .2 could still add is invariance of the aggregate counts/output under
  a permuted ``build_batch_report_from_files`` input list — but that entry
  point's docstring explicitly defines input order as CALLER-owned contract,
  so there may be nothing left to bind.

WHAT THIS FILE BINDS (the missing legs)
---------------------------------------
LEG A — idempotence: validating the SAME file twice within one process, via
the real pipeline (``einvoice.report.main`` — the exact CLI entry — plus the
CII engine path the golden test uses), must produce BYTE-IDENTICAL JSON
(compact default AND ``--pretty``) and BYTE-IDENTICAL ``--format text``
output, with equal exit codes. Coverage: one valid + one invalid fixture in
EACH syntax (UBL and CII). NOTHING is normalized: the report schema was
inspected (grep for timestamp/datetime/now over einvoice/report.py) and the
report carries NO run-varying field — no timestamp, no duration, no PID — so
a raw byte compare is the honest assertion. Verdicts, rule ids, messages and
counts are compared verbatim, never normalized away.

LEG B — order-independence within a file: two fixtures that are semantically
identical except for the relative ORDER of repeated sibling line items
(``cac:InvoiceLine`` in UBL, ``ram:IncludedSupplyChainTradeLineItem`` in CII
— repeated-element instance order carries no business meaning, so the spec
permits reordering them) must yield IDENTICAL normalized finding sets (the
FULL record: rule, severity, message, field — nothing dropped or merged) and
identical verdicts/counts. Additionally, findings within one file must emit
in a deterministic order across repeated runs; the documented order contract
is EVALUATION ORDER (``einvoice.validate.Result``: "every finding, in
evaluation order" — the fixed ``rules.ALL_RULES`` list, then the CIUS layer),
which is asserted here by re-running and requiring the identical ordered
record list every time.

MEASURED OUTCOME (2026-07-16, before this file was written): every property
above ALREADY holds — double runs were byte-identical for all eight
fixture/format combinations, line-permuted fixtures produced identical full
finding records, and the emission order was stable across repeated runs and
across processes with PYTHONHASHSEED 0/1/42 (findings come from fixed-list
iteration, not set/dict-order). ZERO nondeterminism was found, so NO source
was modified: this file simply pins the already-true property, per the task
spec ("if zero nondeterminism is found, the test simply pins the
already-true property — that is success").

CII note: ``report``/``validate`` do not natively dispatch a bare ``.xml``
CrossIndustryInvoice (only the PDF-container path does), so — exactly like
``test_golden_snapshot.py`` — the CII legs reuse its ``_cii_report`` helper
(imported, not duplicated): ``parser_cii.build_model`` + ``rules.ALL_RULES``
+ ``rules_xrechnung.evaluate_cii`` + ``report._record``. No rule logic is
re-implemented here.

Standard library only (io/json/os/re/subprocess/sys/tempfile/unittest +
contextlib); zero new runtime deps — ``test_packaging.py`` stays green.
Offline, saxonche-free, runs in a few seconds.
"""

import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import report  # noqa: E402
# Reuse the golden harness's CII engine invocation verbatim (no duplication;
# it is the same parser_cii + ALL_RULES + evaluate_cii + report._record path).
from test_golden_snapshot import _cii_report  # noqa: E402

# ---------------------------------------------------------------------------
# LEG A fixtures: >=1 valid + >=1 invalid in EACH syntax. All are existing
# committed corpus files also used by test_golden_snapshot.py — no new corpus.
# ---------------------------------------------------------------------------
UBL_VALID = os.path.join(HERE, "corpus", "vendored", "valid",
                         "xr-01.01a_ubl.xml")            # exit 0 (xrechnung)
UBL_INVALID = os.path.join(HERE, "corpus", "vendored", "valid",
                           "cen-bis3-positive_ubl.xml")  # BR-DE-2 fatal
CII_VALID = os.path.join(HERE, "corpus", "cen-en16931", "cii", "examples",
                         "huf_example_cii.xml")          # valid, 1 warning
CII_INVALID = os.path.join(HERE, "corpus", "cen-en16931", "cii", "examples",
                           "CII_example6.xml")           # many fatals

# LEG B base fixtures: the synthetic multi-line invoices (3 line items each).
UBL_MULTILINE = os.path.join(HERE, "corpus", "synthetic",
                             "synth-ubl-good-multiline.xml")
CII_MULTILINE = os.path.join(HERE, "corpus", "synthetic",
                             "synth-cii-good-multiline.xml")

PROFILE = "xrechnung"


def _run_cli_inprocess(argv):
    """Run the REAL report CLI entry (``einvoice.report.main``) in-process and
    return ``(exit_code, output_bytes)``. This is the exact code path behind
    ``python3 -m einvoice.report`` — same argument parsing, same serializer
    (compact ``separators=(",", ":")`` by default, ``indent=2, sort_keys``
    under ``--pretty``, ``build_text`` under ``--format text``)."""
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = report.main(list(argv))
    return code, buf.getvalue().encode("utf-8")


def _cii_outputs(path):
    """The three output renderings for a CII invoice via the engine's CII path
    (see module docstring). Returns (compact_json, pretty_json, text) bytes,
    serialized with the byte-exact conventions ``report.main`` uses."""
    rep = _cii_report(path, PROFILE)
    compact = (json.dumps(rep, separators=(",", ":")) + "\n").encode("utf-8")
    pretty = (json.dumps(rep, indent=2, sort_keys=True) + "\n").encode("utf-8")
    text = report.build_text(rep).encode("utf-8")
    return compact, pretty, text


def _full_records(violations):
    """The FULL normalized record tuples for set comparison: rule, severity,
    message and field are all kept verbatim (nothing dropped, merged or
    altered); sorting makes the comparison order-insensitive while the sorted
    LISTS (not sets) preserve multiplicity, so a duplicated finding would
    still be caught."""
    return sorted((v["rule"], v["severity"], v["message"], v["field"])
                  for v in violations)


def _permute_blocks(text, pattern):
    """Return ``text`` with its repeated sibling blocks (matched contiguously
    by ``pattern``) rotated (last block first). Asserts the fixture really has
    >=2 blocks and that the permutation actually changed the bytes."""
    blocks = re.findall(pattern, text, re.S)
    assert len(blocks) >= 2, "fixture drift: expected >=2 line items"
    permuted = text.replace("".join(blocks),
                            blocks[-1] + "".join(blocks[:-1]))
    assert permuted != text, "permutation did not change the document"
    return permuted


class LegAIdempotence(unittest.TestCase):
    """Validating the same file twice in one process is byte-idempotent."""

    def _assert_double_run_identical(self, argv):
        code1, out1 = _run_cli_inprocess(argv)
        code2, out2 = _run_cli_inprocess(argv)
        self.assertEqual(code1, code2, "exit code changed between runs: %r"
                         % (argv,))
        self.assertEqual(out1, out2,
                         "output bytes changed between two runs of %r" % (argv,))
        self.assertTrue(out1, "empty output for %r" % (argv,))
        return code1, out1

    def test_ubl_valid_and_invalid_double_run_byte_identical(self):
        """UBL, valid + invalid: default JSON, --pretty JSON and text output
        are byte-identical between run 1 and run 2; exit codes equal."""
        # valid -> exit 0
        for fmt_args in ([], ["--pretty"], ["--format", "text"]):
            code, _ = self._assert_double_run_identical(
                ["--profile", PROFILE, *fmt_args, UBL_VALID])
            self.assertEqual(code, 0)
        # invalid (BR-DE-2 fatal) -> exit 1; verdict itself must be stable too
        for fmt_args in ([], ["--pretty"], ["--format", "text"]):
            code, out = self._assert_double_run_identical(
                ["--profile", PROFILE, *fmt_args, UBL_INVALID])
            self.assertEqual(code, 1)
        self.assertIn(b"BR-DE-2", out)

    def test_cii_valid_and_invalid_double_run_byte_identical(self):
        """CII, valid + invalid: compact JSON, pretty JSON and text renderings
        are byte-identical between run 1 and run 2 (engine CII path)."""
        for path, expect_valid in ((CII_VALID, True), (CII_INVALID, False)):
            first = _cii_outputs(path)
            second = _cii_outputs(path)
            for name, a, b in zip(("compact", "pretty", "text"),
                                  first, second):
                self.assertEqual(
                    a, b, "%s output for %s changed between runs"
                    % (name, os.path.basename(path)))
            rep = _cii_report(path, PROFILE)
            self.assertEqual(rep["valid"], expect_valid)

    def test_double_run_report_dicts_equal_no_normalization(self):
        """The raw report DICTS (verdict, counts, every violation record) are
        equal between runs with ZERO normalization — proving no run-varying
        field (timestamp/duration/pid) exists to normalize."""
        r1 = report.build_report(UBL_INVALID, profile=PROFILE)
        r2 = report.build_report(UBL_INVALID, profile=PROFILE)
        self.assertEqual(r1, r2)
        self.assertFalse(r1["valid"])
        self.assertGreaterEqual(r1["fatal_count"], 1)
        c1 = _cii_report(CII_INVALID, PROFILE)
        c2 = _cii_report(CII_INVALID, PROFILE)
        self.assertEqual(c1, c2)
        self.assertFalse(c1["valid"])


class LegBOrderIndependence(unittest.TestCase):
    """Reordering repeated sibling line items never changes the finding set,
    and findings within one file emit in a deterministic order."""

    def _pair(self, base_path, pattern, mutate=None):
        """Write (original, line-permuted) variants of ``base_path`` into a
        temp dir — both freshly written so path effects are equal-footing —
        after applying the optional ``mutate`` text transform to BOTH."""
        with open(base_path, encoding="utf-8") as fh:
            src = fh.read()
        if mutate is not None:
            src = mutate(src)
        permuted = _permute_blocks(src, pattern)
        tmp = tempfile.mkdtemp(prefix="vh-idempot-")
        self.addCleanup(__import__("shutil").rmtree, tmp, ignore_errors=True)
        a = os.path.join(tmp, "original.xml")
        b = os.path.join(tmp, "permuted.xml")
        with open(a, "w", encoding="utf-8") as fh:
            fh.write(src)
        with open(b, "w", encoding="utf-8") as fh:
            fh.write(permuted)
        return a, b

    def _assert_equivalent(self, rep_a, rep_b):
        """Same verdict, same counts, same FULL normalized finding multiset —
        no record is dropped, merged or altered in the comparison."""
        self.assertEqual(rep_a["valid"], rep_b["valid"])
        self.assertEqual(rep_a["fatal_count"], rep_b["fatal_count"])
        self.assertEqual(rep_a.get("warning_count"),
                         rep_b.get("warning_count"))
        self.assertEqual(len(rep_a["violations"]), len(rep_b["violations"]))
        self.assertEqual(_full_records(rep_a["violations"]),
                         _full_records(rep_b["violations"]))

    def test_ubl_line_item_order_does_not_change_findings(self):
        """UBL: rotating the three cac:InvoiceLine siblings changes neither
        the verdict nor any finding record, on a passing invoice (3 non-fatal
        BR-DE findings under xrechnung) AND on a failing variant (BuyerReference
        removed -> BR-DE-15 fatal)."""
        pattern = r"  <cac:InvoiceLine>.*?</cac:InvoiceLine>\n"

        # Passing invoice: non-empty finding set (BR-DE-19/21 warnings + info).
        a, b = self._pair(UBL_MULTILINE, pattern)
        rep_a = report.build_report(a, profile=PROFILE)
        rep_b = report.build_report(b, profile=PROFILE)
        self.assertTrue(rep_a["valid"])
        self.assertTrue(rep_a["violations"],
                        "fixture drift: expected non-fatal findings so the "
                        "order-independence check is not vacuous")
        self._assert_equivalent(rep_a, rep_b)
        # syntax-binding findings (separate top-level key) must also match
        self.assertEqual(rep_a.get("syntax_bindings"),
                         rep_b.get("syntax_bindings"))

        # Failing variant: drop BT-10 BuyerReference -> BR-DE-15 fatal, then
        # permute the lines; the fatal set must be order-independent too.
        def drop_buyerref(text):
            out = re.sub(r"\s*<cbc:BuyerReference>[^<]*</cbc:BuyerReference>",
                         "", text, count=1)
            assert out != text, "fixture drift: BuyerReference not found"
            return out

        a, b = self._pair(UBL_MULTILINE, pattern, mutate=drop_buyerref)
        rep_a = report.build_report(a, profile=PROFILE)
        rep_b = report.build_report(b, profile=PROFILE)
        self.assertFalse(rep_a["valid"])
        self.assertIn("BR-DE-15", [v["rule"] for v in rep_a["violations"]])
        self._assert_equivalent(rep_a, rep_b)

    def test_cii_line_item_order_does_not_change_findings(self):
        """CII: rotating the three ram:IncludedSupplyChainTradeLineItem
        siblings changes neither the verdict nor any finding record."""
        pattern = (r"    <ram:IncludedSupplyChainTradeLineItem>.*?"
                   r"</ram:IncludedSupplyChainTradeLineItem>\n")
        a, b = self._pair(CII_MULTILINE, pattern)
        rep_a = _cii_report(a, PROFILE)
        rep_b = _cii_report(b, PROFILE)
        self.assertTrue(rep_a["valid"])
        self.assertTrue(rep_a["violations"],
                        "fixture drift: expected >=1 non-fatal finding")
        self._assert_equivalent(rep_a, rep_b)

    def test_findings_emit_in_deterministic_order_across_runs(self):
        """Within one file, findings emit in a stable, documented order —
        evaluation order (the fixed rules.ALL_RULES list, then the CIUS
        layer; see einvoice.validate.Result: 'every finding, in evaluation
        order') — identical ordered record lists across three repeated runs,
        for both syntaxes."""
        runs = [report.build_report(UBL_INVALID, profile=PROFILE)["violations"]
                for _ in range(3)]
        self.assertTrue(runs[0], "expected findings on the invalid UBL fixture")
        self.assertEqual(runs[0], runs[1])
        self.assertEqual(runs[1], runs[2])

        cii_runs = [_cii_report(CII_INVALID, PROFILE)["violations"]
                    for _ in range(3)]
        self.assertTrue(cii_runs[0],
                        "expected findings on the invalid CII fixture")
        self.assertEqual(cii_runs[0], cii_runs[1])
        self.assertEqual(cii_runs[1], cii_runs[2])

    def test_output_stable_across_processes_and_hash_seeds(self):
        """Cross-PROCESS determinism: the real CLI, run as a subprocess under
        PYTHONHASHSEED=0 and PYTHONHASHSEED=1, emits byte-identical stdout and
        the same exit code — no set/dict-iteration order leaks into the
        report. (In-process double runs cannot catch hash-seed leakage; this
        leg can.)"""
        for path, want_code in ((UBL_VALID, 0), (UBL_INVALID, 1)):
            outputs = []
            for seed in ("0", "1"):
                env = dict(os.environ, PYTHONHASHSEED=seed)
                proc = subprocess.run(
                    [sys.executable, "-m", "einvoice.report",
                     "--profile", PROFILE, path],
                    cwd=HERE, capture_output=True, env=env, timeout=180)
                self.assertEqual(proc.returncode, want_code, proc.stderr)
                outputs.append(proc.stdout)
            self.assertEqual(
                outputs[0], outputs[1],
                "report bytes for %s differ across hash seeds"
                % os.path.basename(path))


if __name__ == "__main__":
    unittest.main(verbosity=2)
