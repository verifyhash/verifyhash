#!/usr/bin/env python3
"""test_cli_batch.py — pin the first-class ``einvoice validate-batch`` subcommand
(T-VHCLI.2).

Fast, stdlib-only, saxonche-free, offline. Exercises the main-CLI batch
subcommand as a subprocess (``python3 -m einvoice validate-batch <dir|glob>``)
so it proves the packaged dispatcher path, and in-process
(``einvoice.cli.main``) where that is cheaper. It reuses the EXISTING committed
corpus fixtures (no new corpus is added):

  * a business-rule-clean UBL invoice (``cen-bis3-positive_ubl.xml``) -> PASS
    under the CLI default profile (en16931);
  * an invalid UBL *CreditNote* (``creditnote-invalid-typecode_ubl.xml``) -> a
    real BR-CL-01 fatal from the shared CreditNote engine under en16931 -> FAIL;
  * a hostile DOCTYPE/entity file synthesised into the temp dir -> the hardened
    parser rejects it, so it is reported as an ERROR (not parsed, no crash).

Asserted (each maps to a task acceptance criterion):
  1. ``validate-batch <dir>`` prints a per-file PASS/FAIL/ERROR summary and
     returns 1 when a fatal is present.
  2. ``validate-batch <glob>`` gives byte-identical aggregate counts + exit code
     to the directory form over the same file set.
  3. A DOCTYPE/entity file in the batch is reported as an ERROR (hardened parser
     applies) and does not abort the batch.
  4. ``--json`` emits the aggregate batch schema dict; ``--quiet`` suppresses the
     human summary but preserves the exit code.
  5. An all-pass dir -> exit 0; an empty dir / zero-match glob -> file_count 0 +
     explicit note + exit 0, no traceback.
  6. (T-VHUX2.4) the human summary NAMES the rule ids behind its counts, caps
     that listing with an honest omission disclosure, and prints exactly one
     ``einvoice --explain <RULE-ID>`` line whose id is taken from a rule THIS
     run violated — proven on a fixture set whose rules are not the ones the
     feature was developed against.
"""

import io
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.cli import (  # noqa: E402
    main, EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE,
)

# Business-rule-clean UBL invoice: PASS under the CLI default profile en16931.
PASS_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")
# An invalid UBL CreditNote (BT-3 CreditNoteTypeCode = 999, off the UNTDID 1001
# credit-note sub-list) -> a real BR-CL-01 fatal from the CreditNote engine ->
# FAIL under en16931. (Since T-VHCN.2 a CreditNote is really validated, so a
# failing CreditNote fails on its content, not on a structural S-ROOT.)
FAIL_FIXTURE = os.path.join(HERE, "fixtures",
                            "creditnote-invalid-typecode_ubl.xml")
# A hostile DOCTYPE/entity payload: the hardened parser refuses to parse it, so
# it is folded into an ERROR entry rather than being expanded or crashing.
HOSTILE_XML = (
    b'<?xml version="1.0"?>\n'
    b'<!DOCTYPE Invoice [<!ENTITY x "expand-me">]>\n'
    b'<Invoice>&x;</Invoice>\n'
)


def _copy(src, dest):
    with open(src, "rb") as fh:
        data = fh.read()
    with open(dest, "wb") as out:
        out.write(data)


def make_mixed_dir(tmp):
    """One valid + one fatally-invalid + one hostile-DOCTYPE invoice under tmp.

    Returns (good_path, bad_path, hostile_path). All three end in ``.xml`` so
    both the directory walk and a ``*.xml`` glob collect exactly this set.
    """
    good = os.path.join(tmp, "a-good.xml")
    bad = os.path.join(tmp, "b-bad.xml")
    hostile = os.path.join(tmp, "c-hostile.xml")
    _copy(PASS_FIXTURE, good)
    _copy(FAIL_FIXTURE, bad)
    with open(hostile, "wb") as fh:
        fh.write(HOSTILE_XML)
    return good, bad, hostile


def _run(*cli_args):
    """Run the packaged CLI entry point as a subprocess."""
    return subprocess.run(
        [sys.executable, "-m", "einvoice", *cli_args],
        cwd=HERE, capture_output=True, text=True, timeout=180)


class _Capture:
    """Run ``main(argv)`` in-process, capturing stdout/stderr + exit code."""

    def __init__(self, argv):
        self.argv = argv

    def __enter__(self):
        self._out, self._err = sys.stdout, sys.stderr
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        self.code = main(self.argv)
        self.stdout = sys.stdout.getvalue()
        self.stderr = sys.stderr.getvalue()
        sys.stdout, sys.stderr = self._out, self._err
        return self

    def __exit__(self, *exc):
        return False


class ValidateBatchDir(unittest.TestCase):
    def test_dir_summary_and_exit_code_fatal(self):
        """(criterion 1 + 3) per-file PASS/FAIL/ERROR summary, exit 1 on fatal;
        the DOCTYPE file is an ERROR, not a crash, and the batch still runs."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            good, bad, hostile = make_mixed_dir(tmp)
            proc = _run("validate-batch", tmp)
        self.assertEqual(proc.returncode, EXIT_FAIL, proc.stderr)
        out = proc.stdout
        # one status line per file, correct verdict each
        self.assertIn("PASS  %s" % good, out)
        self.assertIn("FAIL  %s" % bad, out)
        self.assertIn("ERROR %s" % hostile, out)
        # the hostile file was NOT parsed — it is a not-well-formed ERROR
        self.assertRegex(out, r"ERROR .*c-hostile\.xml\s+not-well-formed")
        # aggregate tally line present
        self.assertIn("3 files:", out)

    def test_all_pass_dir_exit_zero(self):
        """(criterion 5) every file passes -> exit 0."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            _copy(PASS_FIXTURE, os.path.join(tmp, "g1.xml"))
            _copy(PASS_FIXTURE, os.path.join(tmp, "g2.xml"))
            proc = _run("validate-batch", tmp)
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        self.assertIn("2 files: 2 passed, 0 failed", proc.stdout)

    def test_only_error_no_fatal_exit_parse(self):
        """A batch whose only failing file is a not-well-formed ERROR (no fatal)
        -> EXIT_PARSE (3), the documented fatal-outranks-parse precedence."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            _copy(PASS_FIXTURE, os.path.join(tmp, "good.xml"))
            with open(os.path.join(tmp, "hostile.xml"), "wb") as fh:
                fh.write(HOSTILE_XML)
            proc = _run("validate-batch", tmp)
        self.assertEqual(proc.returncode, EXIT_PARSE, proc.stderr)


class ValidateBatchGlob(unittest.TestCase):
    def test_glob_matches_dir_form(self):
        """(criterion 2) the glob form yields byte-identical aggregate counts +
        exit code to the directory form over the same file set."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            dir_proc = _run("validate-batch", "--json", tmp)
            glob_proc = _run("validate-batch", "--json",
                             os.path.join(tmp, "*.xml"))
        self.assertEqual(dir_proc.returncode, glob_proc.returncode)
        dir_batch = json.loads(dir_proc.stdout)
        glob_batch = json.loads(glob_proc.stdout)
        for key in ("schema", "file_count", "fatal_count", "warning_count",
                    "violation_count", "failed_file_count"):
            self.assertEqual(dir_batch[key], glob_batch[key], key)
        # the per-file reports (and their order) are identical; only the 'root'
        # label (dir path vs glob pattern) differs between the two forms.
        self.assertEqual(dir_batch["files"], glob_batch["files"])
        dir_no_root = {k: v for k, v in dir_batch.items() if k != "root"}
        glob_no_root = {k: v for k, v in glob_batch.items() if k != "root"}
        self.assertEqual(dir_no_root, glob_no_root)

    def test_zero_match_glob_is_clean(self):
        """(criterion 5) a zero-match glob -> file_count 0 + note + exit 0."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            proc = _run("validate-batch", "--json",
                        os.path.join(tmp, "*.nope"))
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        batch = json.loads(proc.stdout)
        self.assertEqual(batch["file_count"], 0)
        self.assertIn("no invoice files found", batch.get("note", ""))


class ValidateBatchFlags(unittest.TestCase):
    def test_json_emits_batch_schema(self):
        """(criterion 4) --json emits the aggregate batch schema dict."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            proc = _run("validate-batch", "--json", tmp)
        self.assertEqual(proc.returncode, EXIT_FAIL, proc.stderr)
        batch = json.loads(proc.stdout)
        self.assertEqual(batch["schema"], "einvoice-conformance-batch/v1")
        self.assertEqual(batch["file_count"], 3)
        self.assertGreaterEqual(batch["fatal_count"], 1)
        self.assertGreaterEqual(batch["failed_file_count"], 2)  # bad + hostile

    def test_quiet_suppresses_summary_keeps_exit(self):
        """(criterion 4) --quiet suppresses the human summary but preserves the
        (nonzero) exit code."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            proc = _run("validate-batch", "--quiet", tmp)
        self.assertEqual(proc.returncode, EXIT_FAIL, proc.stderr)
        self.assertEqual(proc.stdout, "", "quiet must suppress human summary")

    def test_quiet_json_still_emits_json(self):
        """--quiet --json still prints the aggregate JSON (quiet only silences
        the human summary), and keeps the exit code."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            proc = _run("validate-batch", "--quiet", "--json", tmp)
        self.assertEqual(proc.returncode, EXIT_FAIL, proc.stderr)
        batch = json.loads(proc.stdout)
        self.assertEqual(batch["schema"], "einvoice-conformance-batch/v1")

    def test_profile_flag_honoured(self):
        """--profile is honoured: BR-DE-15 (a German-CIUS fatal, XRechnung only)
        fires on a BuyerReference-less invoice under xrechnung but not en16931,
        proving the flag reaches build_batch_report."""
        import re
        import tempfile
        base = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src",
                            "test", "business-cases", "standard",
                            "01.01a-INVOICE_ubl.xml")
        if not os.path.isfile(base):
            self.skipTest("xrechnung testsuite fixture absent")
        with open(base, encoding="utf-8") as fh:
            src = fh.read()
        bad = re.sub(r"<cbc:BuyerReference>[^<]*</cbc:BuyerReference>", "",
                     src, count=1)
        self.assertNotEqual(bad, src, "fixture drift: no BuyerReference")
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "no-buyer-ref.xml")
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(bad)
            xr = _run("validate-batch", "--json", "--profile", "xrechnung", tmp)
            en = _run("validate-batch", "--json", "--profile", "en16931", tmp)
        xr_batch = json.loads(xr.stdout)
        en_batch = json.loads(en.stdout)
        xr_rules = [v["rule"] for r in xr_batch["files"]
                    for v in r.get("violations", [])]
        self.assertIn("BR-DE-15", xr_rules)
        self.assertEqual(xr.returncode, EXIT_FAIL)
        # en16931 does not apply the German CIUS layer -> this file passes.
        self.assertEqual(en_batch["fatal_count"], 0)
        self.assertEqual(en.returncode, EXIT_OK)


class ValidateBatchUsage(unittest.TestCase):
    def test_missing_argument_is_usage_error(self):
        with _Capture(["validate-batch"]) as cap:
            pass
        self.assertEqual(cap.code, EXIT_USAGE)
        self.assertIn("validate-batch", cap.stderr)

    def test_extra_argument_is_usage_error(self):
        with _Capture(["validate-batch", "a", "b"]) as cap:
            pass
        self.assertEqual(cap.code, EXIT_USAGE)


class SingleFileUnchanged(unittest.TestCase):
    """validate/receipt single-file behaviour must be untouched by the new
    subcommand (criterion 6). A spot-check that the plain validate path still
    passes/fails as before and validate-batch did not shadow it."""

    def test_validate_single_file_pass(self):
        with _Capture(["validate", PASS_FIXTURE]) as cap:
            pass
        self.assertEqual(cap.code, EXIT_OK, cap.stderr)
        self.assertIn("PASS", cap.stdout)

    def test_validate_single_file_fail(self):
        with _Capture(["validate", FAIL_FIXTURE]) as cap:
            pass
        self.assertEqual(cap.code, EXIT_FAIL, cap.stderr)
        self.assertIn("FAIL", cap.stdout)


class BatchJsonCarriesRemediation(unittest.TestCase):
    """(T-VHERG.1) `validate-batch --json` must expose the remediation catalog
    on every per-file violation, exactly as the single-file `validate --json`
    surface now does.

    Worth stating precisely, because the two surfaces reach the catalog by
    DIFFERENT routes: `validate --json` projects through
    `validate.Result.to_dict`, while `validate-batch --json` aggregates per-file
    reports through `einvoice.report.build_batch_report`. Since T-VHERG.1 both
    routes relay through the one
    `einvoice.remediation.remediation_fields()` helper, so they cannot report
    different guidance for the same rule id. The report record names the
    offending path `field` (the CLI record carries both `field` and its
    historical `element`); everything else is shared.
    """

    def _batch(self, path):
        proc = _run("validate-batch", "--profile", "xrechnung", "--json", path)
        return json.loads(proc.stdout)

    def test_every_batched_violation_carries_the_remediation_fields(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            batch = self._batch(tmp)
            seen = 0
            for report in batch["files"]:
                for rec in report.get("violations", []):
                    for key in ("rule", "severity", "message", "field",
                                "title", "fix_hint", "terms", "location"):
                        self.assertIn(key, rec, rec.get("rule"))
                    seen += 1
            self.assertGreater(seen, 0, "the mixed dir must fire violations")

    def test_batched_values_match_the_single_file_surface(self):
        # Same file, same profile, two surfaces: identical count and identical
        # values on every shared key.
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            _copy(FAIL_FIXTURE, os.path.join(tmp, "only.xml"))
            batch = self._batch(tmp)
            self.assertEqual(batch["file_count"], 1)
            batched = batch["files"][0]["violations"]
            single = json.loads(_run("validate", "--profile", "xrechnung",
                                     "--json",
                                     os.path.join(tmp, "only.xml")).stdout)
            self.assertEqual(len(batched), len(single["violations"]))
            for rep_rec, cli_rec in zip(batched, single["violations"]):
                for key in ("rule", "severity", "message", "field",
                            "title", "fix_hint", "terms", "location"):
                    self.assertEqual(rep_rec[key], cli_rec[key],
                                     "%s disagrees on %r"
                                     % (rep_rec["rule"], key))
                # The CLI record additionally keeps its historical `element`
                # key, always equal to `field`.
                self.assertEqual(cli_rec["element"], cli_rec["field"])


class BatchTextNamesItsRules(unittest.TestCase):
    """(T-VHUX2.4) the human batch summary must name the rule ids it already
    computed, and route the reader onward — honestly, and without hard-coding.

    Both tests below are anti-regression proofs for the two ways this feature
    can be faked: printing a canned example rule id, and truncating a long
    listing without admitting it.
    """

    def _explained_ids(self, out):
        """Every id printed on an ``einvoice --explain <ID>`` line, in order."""
        import re
        return re.findall(r"--explain\s+(\S+)", out)

    def test_explain_hint_uses_a_real_violated_rule(self):
        """The `--explain` id comes from THIS run's findings, not a constant.

        The proof needs a run whose violated rules are NOT the ones the feature
        was developed against (examples/01-missing-fields fires BR-DE-2 and
        BR-DE-15), so it uses the mixed corpus dir this file already builds:
        under the CLI default profile en16931 the only violated rule in it is
        BR-CL-01, from creditnote-invalid-typecode_ubl.xml. A hard-coded
        BR-DE-2 (or any other canned id) fails here twice over — it is not in
        the run's finding set, and the run's finding set does not contain it.
        """
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            text = _run("validate-batch", tmp)
            machine = _run("validate-batch", "--json", tmp)
        self.assertEqual(text.returncode, EXIT_FAIL, text.stderr)
        violated = {v["rule"]
                    for f in json.loads(machine.stdout)["files"]
                    for v in f.get("violations", [])}
        self.assertTrue(violated, "the mixed dir must fire violations")
        # The fixture set is genuinely a different one from the development
        # fixture — otherwise a hard-coded BR-DE-2 would pass by luck.
        self.assertNotIn("BR-DE-2", violated)
        self.assertNotIn("BR-DE-15", violated)

        ids = self._explained_ids(text.stdout)
        self.assertEqual(len(ids), 1,
                         "exactly one discoverability line per run; got %r"
                         % (ids,))
        self.assertIn(ids[0], violated,
                      "the --explain hint names %r, which this run did not "
                      "violate (violated: %s) — it is hard-coded, not derived"
                      % (ids[0], sorted(violated)))
        # And the id it names is one the summary actually put on screen, so the
        # reader can see where the suggestion came from.
        self.assertIn(ids[0], text.stdout.split("--explain")[0])

    def test_batch_rule_list_cap_discloses_omission(self):
        """A truncated per-file listing states what it hid, out of how many, and
        which format shows everything.

        Needs a file with MORE findings than einvoice.report's one cap
        constant, which no committed fixture has (the corpus fixtures used above
        fire 1-5 findings each), so a minimal-but-well-formed UBL Invoice is
        synthesised into the temp dir: it parses, then trips the whole
        mandatory-field family at once. Measured under xrechnung: 15 findings
        (13 fatal, 2 warning) against a cap of 11. The exact rule ids are never
        asserted — only the arithmetic of the disclosure — so a rule-set change
        cannot make this test lie.
        """
        import tempfile
        from einvoice.report import _BATCH_RULE_LIST_CAP as CAP
        minimal = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:'
            'Invoice-2"\n'
            '         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:'
            'CommonAggregateComponents"\n'
            '         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:'
            'CommonBasicComponents">\n'
            '  <cbc:ID>BATCH-CAP-1</cbc:ID>\n'
            '</Invoice>\n'
        )
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "sparse.xml"), "w",
                      encoding="utf-8") as fh:
                fh.write(minimal)
            text = _run("validate-batch", "--profile", "xrechnung", tmp)
            machine = _run("validate-batch", "--profile", "xrechnung",
                           "--json", tmp)
        self.assertEqual(text.returncode, EXIT_FAIL, text.stderr)
        violations = json.loads(machine.stdout)["files"][0]["violations"]
        total = len(violations)
        self.assertGreater(total, CAP,
                           "fixture no longer exceeds the cap (%d findings, "
                           "cap %d) — this test would prove nothing" % (total,
                                                                       CAP))
        out = text.stdout
        fatal = sum(1 for v in violations if v["severity"] == "fatal")
        # (a) the explicit total, so the reader knows the listing is partial.
        self.assertIn("%d finding(s) total: %d fatal, %d non-fatal"
                      % (total, fatal, total - fatal), out)
        # (b) the omitted count, the total, and the format that carries all.
        self.assertIn("... %d more not shown — use --format json for all %d"
                      % (total - CAP, total), out)
        # (c) the listing really is capped: exactly CAP `[severity] RULE:` lines.
        listed = [ln for ln in out.splitlines()
                  if ln.startswith("    [") and "]" in ln]
        self.assertEqual(len(listed), CAP,
                         "expected exactly %d listed findings, got %d:\n%s"
                         % (CAP, len(listed), "\n".join(listed)))
        # (d) the aggregate rule block is bounded by the SAME constant.
        aggregate = out.split("Most violated rules")[1]
        rules_shown = [ln for ln in aggregate.splitlines()
                       if ln.startswith("  ") and " file" in ln]
        self.assertEqual(len(rules_shown), CAP)
        # (e) and the format it names is a real batch format, so the advice
        #     actually works on a directory.
        self.assertEqual(machine.returncode, EXIT_FAIL, machine.stderr)


if __name__ == "__main__":
    unittest.main()
