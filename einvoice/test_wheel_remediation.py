#!/usr/bin/env python3
"""test_wheel_remediation.py — the INSTALLED WHEEL must carry actionable fix
guidance, not just rule ids (T-VHWHEEL.1).

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

#: A committed fixture whose ONLY fatal is BR-CL-01 (an invalid UNTDID 1001
#: document type code) — the same file test_api_recipe.py / test_api_embed.py /
#: test_exit_codes.py drive. BR-CL-01 is a good probe because its catalog entry
#: carries all four relayed fields: a title, a fix, a location hint and a
#: non-empty bt_bg list (["BT-3"]).
BR_CL_01_FIXTURE = os.path.join(
    HERE, "fixtures", "creditnote-invalid-typecode_ubl.xml")

#: The rule the fixture is built to trip.
PROBE_RULE = "BR-CL-01"


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
        env = dict(os.environ)
        env["PYTHONPATH"] = self.image
        return subprocess.run(
            [sys.executable] + argv,
            cwd=self.image,   # sys.path[0]=='' -> the image, not the checkout
            env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True,
        )

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
