#!/usr/bin/env python3
"""test_wheel_remediation.py — the INSTALLED WHEEL must carry actionable fix
guidance (T-VHWHEEL.1), and must DEGRADE rather than crash when it does not
(T-VHWHEEL.2).

Two halves, both driven from a reconstructed wheel image:

  * ``WheelRemediation`` — the catalog SHIPS and its wording is relayed
    verbatim (VHWHEEL.1, below);
  * ``WheelWithoutCatalog`` — the same image with the packaged catalog DELETED
    still answers all nine ``--format`` values and ``--explain`` without a
    traceback, on documented exit codes only (VHWHEEL.2, at the bottom).

The second half exists because a PyPI version is IMMUTABLE: shipping the file
fixes today's release, but only code that cannot depend on the file prevents a
future packaging slip from re-crashing the GitHub Action's DEFAULT
``format: sarif``.

MEASURED before this change, on the committed BR-CL-01 fixture
``fixtures/creditnote-invalid-typecode_ubl.xml``:

  * from the SOURCE checkout the report says
    ``title="The document type code (BT-3) MUST be coded per UNTDID 1001."``,
    ``fix_hint="Encode `cbc:InvoiceTypeCode` using a valid value from the
    required code list."``, ``location="cbc:InvoiceTypeCode"``,
    ``terms=["BT-3"]``;
  * from a WHEEL-ONLY image the same fixture yields
    ``title=null, fix_hint=null, location=null, terms=[]``.

The cause was purely a packaging one: ``einvoice.report`` relays those four
fields out of ``remediation_catalog.json`` via
``einvoice.remediation.load_catalog()``, but the catalog lived only at the repo
root — OUTSIDE the ``einvoice/`` package dir that ``packages=["einvoice"]``
ships — so a `pip install verifyhash-einvoice` user received a validator that
names a broken rule and hands them nothing to fix it with, while
``report.schema.json`` kept advertising the fields. The fix ships the catalog as
package-data (a byte-identical copy written by ``gen_remediation.py`` from the
same serialized bytes) and lets ``default_catalog_path()`` prefer it.

This test REUSES ``test_wheel_self_report.build_install_image()`` — the single
image builder that reconstructs a wheel layout straight from the pyproject
``packages`` + ``package-data`` declarations, stdlib only, no pip, no build
backend, no network. It deliberately does NOT import the source tree to
validate: every assertion is made from a subprocess whose sole import root is
the image, exactly the way ``test_wheel_self_report.py`` drives it. Adding the
catalog to package-data is therefore the ONLY thing that can make it pass.

Run:

    python3 test_wheel_remediation.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from test_wheel_self_report import build_install_image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

#: The nine ``--format`` values the report CLI accepts, imported from the REAL
#: registry (never hand-typed) so a newly added format automatically lands in
#: the no-catalog degradation sweep below. Importing the constant from the
#: source checkout is not a validation shortcut: every assertion in this file is
#: still made against a subprocess whose sole import root is the wheel image.
from einvoice.report import REPORT_FORMATS  # noqa: E402

#: A committed fixture whose ONLY fatal is BR-CL-01 (an invalid UNTDID 1001
#: document type code) — the same file test_api_recipe.py / test_api_embed.py /
#: test_exit_codes.py drive. BR-CL-01 is a good probe because its catalog entry
#: carries all four relayed fields: a title, a fix, a location hint and a
#: non-empty bt_bg list (["BT-3"]).
BR_CL_01_FIXTURE = os.path.join(
    HERE, "fixtures", "creditnote-invalid-typecode_ubl.xml")

#: The rule the fixture is built to trip.
PROBE_RULE = "BR-CL-01"

#: The exit codes ``python3 -m einvoice.report`` is DOCUMENTED to return
#: (module docstring + EXIT-CODES.md): 0 = no fatal violation, 1 = at least one
#: fatal violation / usage-level refusal, 3 = input not well-formed. Anything
#: else (notably 1 accompanied by a traceback, or a signal-derived code) means
#: the tool crashed rather than reported.
DOCUMENTED_EXIT_CODES = (0, 1, 3)

#: A rule id that IS in the committed catalog, used to drive ``--explain``.
EXPLAIN_RULE = "BR-DE-1"


def run_in_image(image, argv):
    """Run ``python <argv>`` with ``image`` as the SOLE import root
    (PYTHONPATH + cwd), never the source checkout."""
    env = dict(os.environ)
    env["PYTHONPATH"] = image
    return subprocess.run(
        [sys.executable] + argv,
        cwd=image,        # sys.path[0]=='' -> the image, not the checkout
        env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        universal_newlines=True,
    )


class WheelRemediation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="einvoice-wheel-remediation-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # The wheel-only import root.
        self.image = build_install_image(os.path.join(self.tmp, "image"))
        # Test INPUTS live outside the image, so the image stays exactly the
        # set of files a wheel ships.
        self.inputs = os.path.join(self.tmp, "inputs")
        os.makedirs(self.inputs, exist_ok=True)

    # -- helpers ---------------------------------------------------------
    def _run_in_image(self, argv):
        """Run ``python -m <argv>`` with the install image as the SOLE import
        root (PYTHONPATH + cwd), never the source checkout."""
        return run_in_image(self.image, argv)

    def _packaged_catalog_path(self):
        return os.path.join(self.image, "einvoice", "remediation_catalog.json")

    # -- (a) the catalog is IN the wheel and parses ------------------------
    def test_catalog_ships_in_the_wheel_image(self):
        path = self._packaged_catalog_path()
        self.assertTrue(
            os.path.isfile(path),
            "einvoice/remediation_catalog.json must ship as package-data — "
            "without it an installed wheel emits null title/fix_hint/location "
            "for every violation. Declare it in [tool.setuptools.package-data] "
            "and regenerate with `python3 gen_remediation.py`.")
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        rules = doc.get("rules")
        self.assertIsInstance(rules, dict,
                              "packaged catalog has no `rules` mapping")
        self.assertTrue(rules, "packaged catalog `rules` mapping is empty")
        self.assertIn(PROBE_RULE, rules,
                      "packaged catalog does not cover %s" % PROBE_RULE)

    def test_loader_resolves_to_the_packaged_copy_in_the_wheel(self):
        """From the wheel image there is no repo-root copy, so
        ``default_catalog_path()`` must resolve to the packaged one and
        ``load_catalog()`` must return a non-empty mapping."""
        code = (
            "import json, os, einvoice.remediation as r;"
            "print(json.dumps({"
            "'path': os.path.abspath(r.default_catalog_path()),"
            "'n': len(r.load_catalog())}))"
        )
        proc = self._run_in_image(["-c", code])
        self.assertEqual(proc.returncode, 0,
                         "remediation loader crashed on the wheel image:\n"
                         + proc.stderr)
        got = json.loads(proc.stdout)
        self.assertEqual(os.path.abspath(got["path"]),
                         os.path.abspath(self._packaged_catalog_path()),
                         "the wheel must load its OWN packaged catalog")
        self.assertGreater(got["n"], 0, "wheel loaded an empty catalog")

    # -- (b) a real report from the wheel carries the guidance -------------
    def _wheel_report(self, fixture):
        """Validate ``fixture`` with the wheel image as the sole import root and
        return the parsed JSON report."""
        dest = os.path.join(self.inputs, os.path.basename(fixture))
        shutil.copy2(fixture, dest)
        proc = self._run_in_image(
            ["-m", "einvoice.report", "--format", "json", dest])
        # Exit 1 is the documented "validation failures found" code (see
        # EXIT-CODES.md); anything else means the wheel actually crashed.
        self.assertIn(proc.returncode, (0, 1),
                      "einvoice.report crashed on the wheel image (rc=%d):\n%s"
                      % (proc.returncode, proc.stderr))
        return json.loads(proc.stdout)

    def test_br_cl_01_report_from_the_wheel_has_fix_guidance(self):
        report = self._wheel_report(BR_CL_01_FIXTURE)
        records = [v for v in report.get("violations", [])
                   if v.get("rule") == PROBE_RULE]
        self.assertEqual(
            len(records), 1,
            "expected exactly one %s record from the fixture, got %d"
            % (PROBE_RULE, len(records)))
        rec = records[0]
        for field in ("title", "fix_hint", "location"):
            self.assertIsNotNone(
                rec.get(field),
                "%s record from the WHEEL has %s=None — the installed "
                "artifact names a broken rule but gives no way to fix it "
                "(remediation_catalog.json missing from the wheel?). Record: %r"
                % (PROBE_RULE, field, rec))
            self.assertTrue(
                str(rec[field]).strip(),
                "%s record from the WHEEL has an empty %s" % (PROBE_RULE, field))
        self.assertTrue(
            rec.get("terms"),
            "%s record from the WHEEL has empty `terms` — the BT/BG business "
            "terms the rule touches must be relayed. Record: %r"
            % (PROBE_RULE, rec))

    def test_wheel_guidance_equals_the_committed_catalog_entry(self):
        """The wheel must relay the COMMITTED wording verbatim — not some
        placeholder that merely happens to be non-null."""
        report = self._wheel_report(BR_CL_01_FIXTURE)
        rec = next(v for v in report["violations"]
                   if v.get("rule") == PROBE_RULE)
        with open(os.path.join(HERE, "remediation_catalog.json"),
                  encoding="utf-8") as fh:
            entry = json.load(fh)["rules"][PROBE_RULE]
        self.assertEqual(rec["title"], entry["title"])
        self.assertEqual(rec["fix_hint"], entry["fix"])
        self.assertEqual(rec["location"], entry["location_hint"])
        self.assertEqual(rec["terms"], list(entry["bt_bg"]))


class WheelWithoutCatalog(unittest.TestCase):
    """The HOSTILE half (T-VHWHEEL.2): an installation whose remediation
    catalog is ABSENT must DEGRADE, never crash.

    T-VHWHEEL.1 (above) made the catalog travel inside the wheel. This class
    makes the CODE incapable of depending on that, because a PyPI version is
    IMMUTABLE: if a future packaging slip drops the file again, users cannot be
    handed a raw ``FileNotFoundError`` traceback from the shipped GitHub
    Action's DEFAULT ``format: sarif``.

    MEASURED before the fix (clean venv, verifyhash-einvoice 0.4.2, audit
    run-302): ``python3 -m einvoice.report --format sarif <file>`` and
    ``--explain BR-DE-1`` both died with
    ``FileNotFoundError: [Errno 2] ... remediation_catalog.json``. The cause was
    two UNGUARDED ``remediation.load_catalog()`` calls (in ``build_sarif()`` and
    ``format_explain()``) bypassing the defensive ``_remediation_catalog()``
    accessor that already degraded to ``{}``.

    The image here is the SAME wheel image builder as above with the packaged
    catalog DELETED — the exact on-disk state of the broken release, without
    ever invoking pip, the build backend or the network.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="einvoice-wheel-nocatalog-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.image = build_install_image(os.path.join(self.tmp, "image"))
        # Amputate the packaged catalog — this is the whole point of the class.
        catalog = os.path.join(self.image, "einvoice", "remediation_catalog.json")
        self.assertTrue(os.path.isfile(catalog),
                        "expected the wheel image to ship the catalog before "
                        "this test removes it (see WheelRemediation above)")
        os.remove(catalog)
        # And make sure no repo-root fallback copy is reachable either: the
        # image is the sole import root and its parent holds only `inputs`.
        self.assertFalse(
            os.path.exists(os.path.join(self.tmp, "remediation_catalog.json")),
            "the catalog-less image must have no fallback catalog next to it")
        self.inputs = os.path.join(self.tmp, "inputs")
        os.makedirs(self.inputs, exist_ok=True)
        self.fixture = os.path.join(
            self.inputs, os.path.basename(BR_CL_01_FIXTURE))
        shutil.copy2(BR_CL_01_FIXTURE, self.fixture)

    def _report(self, argv):
        return run_in_image(self.image, ["-m", "einvoice.report"] + argv)

    def _assert_degraded(self, proc, label):
        """No traceback, and only a documented exit code."""
        self.assertNotIn(
            "Traceback", proc.stderr,
            "%s crashed with a Python traceback on a catalog-less "
            "installation — a missing remediation catalog must degrade, not "
            "raise. stderr:\n%s" % (label, proc.stderr))
        self.assertIn(
            proc.returncode, DOCUMENTED_EXIT_CODES,
            "%s returned undocumented exit code %d (documented: %s). "
            "stderr:\n%s" % (label, proc.returncode,
                             DOCUMENTED_EXIT_CODES, proc.stderr))

    # -- the format sweep --------------------------------------------------
    def test_registry_still_has_the_nine_swept_formats(self):
        """Guard the sweep below against a silently shrinking registry."""
        self.assertEqual(
            set(REPORT_FORMATS),
            {"json", "junit", "sarif", "gitlab", "github", "azure", "html",
             "badge", "text"},
            "the --format registry changed; extend this no-catalog sweep")
        self.assertEqual(len(REPORT_FORMATS), 9)

    def test_every_format_degrades_without_the_catalog(self):
        for fmt in REPORT_FORMATS:
            with self.subTest(fmt=fmt):
                proc = self._report(["--format", fmt, self.fixture])
                self._assert_degraded(proc, "--format %s" % fmt)
                self.assertTrue(
                    proc.stdout.strip(),
                    "--format %s emitted an EMPTY document on a catalog-less "
                    "installation; it must still report the violation, only "
                    "without the remediation prose. stderr:\n%s"
                    % (fmt, proc.stderr))

    def test_sarif_still_emits_a_parseable_document(self):
        """The Action's DEFAULT format — the one that actually broke."""
        proc = self._report(["--format", "sarif", self.fixture])
        self._assert_degraded(proc, "--format sarif")
        doc = json.loads(proc.stdout)   # a stray byte or a crash fails here
        self.assertEqual(doc.get("version"), "2.1.0")
        runs = doc.get("runs")
        self.assertIsInstance(runs, list)
        self.assertEqual(len(runs), 1)
        results = runs[0].get("results")
        self.assertTrue(results, "SARIF run carries no results for a fixture "
                                 "with a fatal violation")
        self.assertIn(PROBE_RULE, [r.get("ruleId") for r in results],
                      "SARIF lost the fired rule id when the catalog vanished")
        # An empty catalog means simply "no rule earns a helpUri" — the
        # document is still whole.
        for descriptor in runs[0]["tool"]["driver"].get("rules", []):
            self.assertNotIn(
                "helpUri", descriptor,
                "no rule-reference page can be asserted without a catalog")

    def test_json_report_degrades_to_null_guidance_not_a_crash(self):
        """The honest degraded shape: the violation is still reported, only its
        catalog-relayed prose is null/empty (exactly the pre-VHWHEEL.1 wheel
        behaviour — which was WRONG but never a crash)."""
        proc = self._report(["--format", "json", self.fixture])
        self._assert_degraded(proc, "--format json")
        report = json.loads(proc.stdout)
        rec = next(v for v in report["violations"]
                   if v.get("rule") == PROBE_RULE)
        self.assertIsNone(rec.get("title"))
        self.assertIsNone(rec.get("fix_hint"))
        self.assertEqual(rec.get("terms"), [])

    # -- the --explain surface --------------------------------------------
    def test_explain_says_so_honestly_instead_of_crashing(self):
        proc = self._report(["--explain", EXPLAIN_RULE])
        self._assert_degraded(proc, "--explain %s" % EXPLAIN_RULE)
        self.assertNotEqual(
            proc.returncode, 0,
            "--explain cannot succeed with no catalog to explain from")
        self.assertIn(
            "catalog", proc.stderr.lower(),
            "--explain on a catalog-less installation must say WHY in one "
            "line (it is not the user's rule id that is wrong). stderr:\n%s"
            % proc.stderr)
        self.assertEqual(
            proc.stdout, "",
            "--explain must not emit a half block on stdout when it failed")
        self.assertLessEqual(
            len([ln for ln in proc.stderr.splitlines() if ln.strip()]), 1,
            "the missing-catalog diagnostic must be ONE line, got:\n%s"
            % proc.stderr)

    def test_validate_lang_de_falls_back_to_english_not_a_wrong_verdict(self):
        """The OTHER catalog reader on a user-facing path: ``einvoice validate
        --lang de`` looks the official German assert text up in the same file
        (``remediation.official_message``).

        MEASURED before the fix, on this catalog-less image: it exited **2**
        with ``error: cannot read <invoice>: No such file or directory`` —
        cli.py's OSError arm catching the CATALOG's FileNotFoundError and
        blaming an invoice file that plainly exists, after that invoice had
        already been validated. A missing TRANSLATION must never change a
        verdict; the honest degradation is the English message.
        """
        proc = run_in_image(
            self.image, ["-m", "einvoice", "validate", self.fixture,
                         "--lang", "de"])
        self.assertNotIn("Traceback", proc.stderr, proc.stderr)
        self.assertEqual(
            proc.returncode, 1,
            "the fixture has a fatal violation, so the verdict is exit 1 with "
            "or without a German translation; got rc=%d\nstdout:\n%s\n"
            "stderr:\n%s" % (proc.returncode, proc.stdout, proc.stderr))
        self.assertIn(PROBE_RULE, proc.stdout,
                      "the verdict must still name the fired rule")
        self.assertNotIn("cannot read", proc.stderr,
                         "a missing catalog must not be reported as an "
                         "unreadable INVOICE. stderr:\n%s" % proc.stderr)

    def test_help_still_works_without_the_catalog(self):
        """--help resolves nothing and reads nothing, so it must be immune."""
        proc = self._report(["--help"])
        self._assert_degraded(proc, "--help")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("usage:", proc.stdout)
        self.assertEqual(proc.stderr, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
