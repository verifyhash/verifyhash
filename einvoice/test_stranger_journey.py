#!/usr/bin/env python3
"""test_stranger_journey.py — one end-to-end stranger-journey regression smoke
over the WHOLE documented adoption path (T-VHINTEG.4).

MEASURE-FIRST result (why this file is new, not a duplicate): the individual
legs of the adoption path were each already guarded in isolation —

  * test_quickstart.py       — the QUICKSTART.md commands run as documented,
  * test_report_formats.py   — every ``--format`` emits and the doc/code sets agree,
  * test_lang.py             — ``--lang de`` surfaces the vendored German text,
  * test_readme_einvoice_links.py / test_link_graph.py — README links resolve,
  * test_exit_codes.py       — the EXIT-CODES.md table is re-derived from the CLI.

No single test walked a stranger through the ENTIRE path in one place, so a
regression that only breaks the *seams* between those legs (e.g. the documented
quickstart command no longer being invokable exactly as printed, or a newly
added ``--format`` that never gets exercised on both a good and a bad invoice)
could slip past. This test is that missing whole-journey smoke: it drives the
real, documented commands via ``subprocess`` and pins the CURRENT contract. It
adds NO product behaviour, NO validation change, and NO runtime dependency
(stdlib ``unittest`` / ``subprocess`` only — the zero-dep contract is preserved).

The journey, walked exactly as the docs tell a first-time user to walk it:

  1. The QUICKSTART.md command resolves and runs (parsed verbatim out of the
     doc, then executed — so it cannot drift from what is printed).
  2. A bundled VALID invoice exits 0; the bundled INVALID invoice exits the
     precise non-zero code the EXIT-CODES.md table pins (parsed from the doc,
     cross-checked against einvoice/cli.py — never hard-coded here).
  3. EVERY ``--format`` advertised in REPORT-FORMATS.md (list reused from the
     parity guard, not hard-coded) emits non-empty output for BOTH fixtures.
  4. The invalid-run exit code equals the EXIT-CODES.md fatal code.
  5. ``--lang de`` surfaces the OFFICIAL vendored German assert text on a BR-DE
     finding (expected string read from the remediation catalog that test_lang
     proves is byte-verbatim from the vendored KoSIT Schematron — no fabrication).
  6. Every committed local doc-link target along the funnel / quickstart /
     licensing path resolves to a real file on disk.

Run: python3 test_stranger_journey.py
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

# Exit-code constants straight from the CLI (the doc is cross-checked against
# these below; neither the test nor the assertions hard-code the integers).
from einvoice.cli import (  # noqa: E402
    EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE,
)
# The official vendored German text source (test_lang proves each message_de is
# byte-identical to the vendored KoSIT <sch:assert>). We read expected German
# from here rather than typing a German string into this test.
from einvoice import remediation as _R  # noqa: E402
# Reuse the parity guard's doc parser so a newly-added --format cannot escape
# the journey: the set is read from REPORT-FORMATS.md, never enumerated here.
from test_report_formats import documented as _documented_formats  # noqa: E402
# Reuse the README link extractor (markdown inline + autolinks).
from test_readme_einvoice_links import _extract_links  # noqa: E402

CATALOG = _R.load_catalog()

QUICKSTART = os.path.join(HERE, "QUICKSTART.md")
REPORT_FORMATS_DOC = os.path.join(HERE, "REPORT-FORMATS.md")
EXIT_CODES_DOC = os.path.join(HERE, "EXIT-CODES.md")
ROOT_README = os.path.join(REPO_ROOT, "README.md")

# The committed known-good / known-bad onboarding pair used across the docs.
FIXED = os.path.join("examples", "01-missing-fields", "fixed.xml")    # exit 0
BROKEN = os.path.join("examples", "01-missing-fields", "broken.xml")  # exit 1
# A clean CEN-positive UBL invoice whose FIRST xrechnung fatal is BR-DE-2 — a
# rule that carries an official German message_de (reused from test_lang).
BR_DE_FIXTURE = os.path.join("corpus", "vendored", "valid",
                             "cen-bis3-positive_ubl.xml")


def _env():
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    return env


def _run(argv):
    """Run a command line (list) from the einvoice/ dir; return the process."""
    return subprocess.run(
        argv, cwd=HERE, env=_env(),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        universal_newlines=True, timeout=180,
    )


def _run_shell(cmd):
    """Run a doc command string verbatim (as a stranger would paste it)."""
    return subprocess.run(
        cmd, cwd=HERE, env=_env(), shell=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        universal_newlines=True, timeout=180,
    )


def _module_cli(*args):
    """The documented module form: python3 -m einvoice ..."""
    return [sys.executable, "-m", "einvoice", *args]


def _module_report(*args):
    """The documented report form: python3 -m einvoice.report ..."""
    return [sys.executable, "-m", "einvoice.report", *args]


# --------------------------------------------------------------------------- #
# Doc parsers (sources of truth — nothing about the journey is hard-coded here)
# --------------------------------------------------------------------------- #
def _quickstart_validate_commands():
    """Every ``python3 einvoice.py validate ...`` line inside QUICKSTART.md's
    fenced ```sh blocks, verbatim, trailing ``; echo ...`` diagnostics dropped,
    de-duplicated preserving order. These are the exact commands the doc prints."""
    with open(QUICKSTART, encoding="utf-8") as fh:
        text = fh.read()
    blocks = re.findall(r"```sh\n(.*?)```", text, re.DOTALL)
    cmds, seen = [], set()
    for block in blocks:
        for raw in block.splitlines():
            line = raw.strip()
            if not line.startswith("python3 einvoice.py validate"):
                continue
            cmd = line.split(";", 1)[0].strip()  # drop `; echo "exit=$?"`
            if cmd not in seen:
                seen.add(cmd)
                cmds.append(cmd)
    return cmds


def _exit_codes_from_doc():
    """Parse the ``EXIT_OK=0`` … constants out of EXIT-CODES.md prose. This ties
    the documented codes to the values the journey asserts against."""
    with open(EXIT_CODES_DOC, encoding="utf-8") as fh:
        text = fh.read()
    codes = {name: int(val)
             for name, val in re.findall(r"`(EXIT_[A-Z]+)=(\d+)`", text)}
    return codes


def _first_fail_rule(out):
    """From a human ``FAIL:`` summary, return (rule_id, message) of the first
    reported fatal rule line (``<RULE-ID>: <message>``), or (None, None)."""
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("FAIL"):
            continue
        m = re.match(r"^([A-Z0-9][A-Za-z0-9-]*): (.+)$", s)
        if m:
            return m.group(1), m.group(2)
    return None, None


def _local_links(text):
    """Repo-relative (committed-local) link targets from markdown text: drop
    http(s)/mailto/pure-anchor links and strip #fragments."""
    out = []
    for link in _extract_links(text):
        if link.startswith(("http://", "https://", "mailto:")) or link.startswith("#"):
            continue
        out.append(link.split("#", 1)[0])
    return out


def _readme_einvoice_section(text):
    """Lines of the first '## ...einvoice...' section of a README."""
    lines = text.splitlines()
    start = next((i for i, ln in enumerate(lines)
                  if ln.startswith("## ") and "einvoice" in ln.lower()), None)
    assert start is not None, "no '## ...einvoice...' section in README.md"
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if lines[j].startswith("## "):
            end = j
            break
    return "\n".join(lines[start:end])


# --------------------------------------------------------------------------- #
# Preconditions: the exit-code contract the whole journey branches on is exactly
# what EXIT-CODES.md documents AND what einvoice/cli.py exports.
# --------------------------------------------------------------------------- #
class ExitCodeContract(unittest.TestCase):
    def test_doc_codes_match_cli_constants(self):
        doc = _exit_codes_from_doc()
        self.assertEqual(
            doc,
            {"EXIT_OK": EXIT_OK, "EXIT_FAIL": EXIT_FAIL,
             "EXIT_USAGE": EXIT_USAGE, "EXIT_PARSE": EXIT_PARSE},
            "EXIT-CODES.md constants drifted from einvoice/cli.py: %r" % doc)
        # The fatal code the journey asserts against is 1, per the doc table.
        self.assertEqual(doc["EXIT_FAIL"], 1)
        self.assertEqual(doc["EXIT_OK"], 0)


# --------------------------------------------------------------------------- #
# THE journey: one method walks the whole documented path end to end.
# --------------------------------------------------------------------------- #
class StrangerJourney(unittest.TestCase):
    def test_full_documented_adoption_path(self):
        doc_codes = _exit_codes_from_doc()
        ok_code = doc_codes["EXIT_OK"]
        fatal_code = doc_codes["EXIT_FAIL"]

        # -- Step 1+2: the documented QUICKSTART commands resolve and run, with
        # the valid fixture -> ok_code and the broken fixture -> fatal_code.
        quick_cmds = _quickstart_validate_commands()
        self.assertTrue(quick_cmds,
                        "QUICKSTART.md has no `python3 einvoice.py validate` command")
        saw_valid = saw_broken = False
        for cmd in quick_cmds:
            proc = _run_shell(cmd)
            on_valid = FIXED in cmd or "fixed.xml" in cmd
            on_broken = BROKEN in cmd or "broken.xml" in cmd
            self.assertTrue(on_valid or on_broken,
                            "documented command names neither fixture: %r" % cmd)
            if on_valid:
                saw_valid = True
                self.assertEqual(
                    proc.returncode, ok_code,
                    "valid fixture must exit %d, got %d for %r\nstderr: %s"
                    % (ok_code, proc.returncode, cmd, proc.stderr))
            if on_broken:
                saw_broken = True
                self.assertEqual(
                    proc.returncode, fatal_code,
                    "broken fixture must exit %d (EXIT-CODES.md fatal), got %d "
                    "for %r\nstderr: %s"
                    % (fatal_code, proc.returncode, cmd, proc.stderr))
        self.assertTrue(saw_valid, "QUICKSTART never validates the valid fixture")
        self.assertTrue(saw_broken, "QUICKSTART never validates the broken fixture")

        # The same journey via the module form the docs also advertise
        # (`python3 -m einvoice validate ...`) — proves that entry point too.
        good = _run(_module_cli("validate", "--profile", "xrechnung", FIXED))
        self.assertEqual(good.returncode, ok_code, good.stderr)
        bad = _run(_module_cli("validate", "--profile", "xrechnung", BROKEN))
        self.assertEqual(bad.returncode, fatal_code, bad.stderr)
        # Step 4 (restated explicitly): the invalid-run code IS the doc fatal code.
        self.assertEqual(bad.returncode, fatal_code)
        self.assertEqual(fatal_code, EXIT_FAIL)

        # -- Step 3: every advertised --format emits non-empty output for BOTH
        # the valid (exit ok) and invalid (exit fatal) fixture. List comes from
        # REPORT-FORMATS.md via the parity guard, so a new format can't escape.
        formats, modes = _documented_formats()
        self.assertTrue(formats, "REPORT-FORMATS.md advertised no --format values")
        for fmt in sorted(formats):
            with self.subTest(fmt=fmt):
                good = _run(_module_report("--format", fmt, FIXED))
                self.assertEqual(good.returncode, ok_code,
                                 "%s on valid: rc=%d err=%s"
                                 % (fmt, good.returncode, good.stderr))
                self.assertTrue(good.stdout.strip(),
                                "%s emitted empty output for valid fixture" % fmt)
                bad = _run(_module_report("--format", fmt, BROKEN))
                self.assertEqual(bad.returncode, fatal_code,
                                 "%s on invalid: rc=%d err=%s"
                                 % (fmt, bad.returncode, bad.stderr))
                self.assertTrue(bad.stdout.strip(),
                                "%s emitted empty output for invalid fixture" % fmt)

        # -- Step 5: --lang de surfaces the OFFICIAL vendored German text on a
        # BR-DE finding (expected string comes from the catalog, never fabricated).
        de = _run(_module_cli("validate", BR_DE_FIXTURE,
                              "--profile=xrechnung", "--lang=de"))
        en = _run(_module_cli("validate", BR_DE_FIXTURE, "--profile=xrechnung"))
        self.assertEqual(de.returncode, fatal_code, de.stderr)
        self.assertEqual(en.returncode, fatal_code, en.stderr)
        de_rid, de_msg = _first_fail_rule(de.stdout)
        en_rid, en_msg = _first_fail_rule(en.stdout)
        self.assertIsNotNone(de_rid, "no rule line in --lang de output:\n%s" % de.stdout)
        self.assertEqual(de_rid, en_rid, "language changed which rule fired")
        self.assertTrue(de_rid.startswith("BR-DE"),
                        "expected a BR-DE finding, got %r" % de_rid)
        expected_de = CATALOG.get(de_rid, {}).get("message_de")
        self.assertTrue(expected_de,
                        "catalog has no official message_de for %s" % de_rid)
        self.assertEqual(de_msg, expected_de,
                         "--lang de did not surface the official vendored German text")
        # Non-vacuous: the German string genuinely differs from the English one.
        self.assertNotEqual(de_msg, en_msg)

        # -- Step 6: every committed local doc-link target along the
        # funnel(root README einvoice block) / quickstart / licensing path
        # resolves to a real file on disk.
        with open(QUICKSTART, encoding="utf-8") as fh:
            quick_text = fh.read()
        with open(ROOT_README, encoding="utf-8") as fh:
            root_text = fh.read()
        section = _readme_einvoice_section(root_text)

        checked = 0
        for link in _local_links(quick_text):
            target = os.path.join(HERE, link)  # QUICKSTART paths are einvoice/-relative
            self.assertTrue(os.path.exists(target),
                            "QUICKSTART.md local link does not resolve: %s" % link)
            checked += 1
        funnel_links = _local_links(section)
        for link in funnel_links:
            target = os.path.join(REPO_ROOT, link)  # root README paths are repo-relative
            self.assertTrue(os.path.exists(target),
                            "README einvoice-block local link does not resolve: %s" % link)
            checked += 1
        # The funnel block must actually carry a committed licensing target
        # (the licensing leg of the path is really walked, not vacuously true).
        self.assertTrue(any("licensing" in ln for ln in funnel_links),
                        "README einvoice block links no committed licensing page")
        self.assertGreater(checked, 0, "no committed local doc links were walked")


if __name__ == "__main__":
    unittest.main(verbosity=2)
