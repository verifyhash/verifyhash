#!/usr/bin/env python3
"""test_report_explain.py — prove the `einvoice.report --explain <RULE-ID>` mode.

Fast, stdlib-only, saxonche-free, offline. `--explain` is a standalone catalog
lookup: it prints the T-VHR.1 remediation-catalog entry for one rule id and
exits, WITHOUT reading (or needing) any invoice file.

Asserted (each maps to a task acceptance criterion):
  1. A KNOWN id (BR-DE-15) prints every documented field — title, requires,
     BT/BG, location, one-line fix, severity, Schematron provenance — and the
     printed strings come verbatim from the catalog; exit 0.
  2. An UNKNOWN id (NOPE-999) exits non-zero and names the id on stderr.
  3. No invoice file is needed (the mode runs from an empty directory with no
     xml anywhere on argv), and lookup is case-insensitive.

T-VHUX2.5 added the two ONWARD-ROUTE lines and the three guards they need:
  4. The block ends with a `rule page` line built by `report.rule_page_url()`
     (no second origin literal) from the CANONICAL id, in BOTH languages, and
     an `in German` line naming `--lang=de` that is suppressed when the reader
     already asked for German.
  5. THE INVARIANT THE LINK'S TRUTH RESTS ON: every catalogued rule id has a
     generated `www/rules/<ID>/index.html`, so the URL can never 404. Asserted
     in both directions — an orphan page is a lie about coverage the same way a
     missing page is a lie about the link.
  6. THE DOC-DRIFT GUARD: `QUICKSTART.md` shows two VERBATIM `--explain`
     transcripts, and nothing else in the suite replays them
     (`test_docs_example_output.py` skips `--explain` by construction). Both
     fenced ```text blocks are re-run here and compared BYTE FOR BYTE against
     the live output of the `sh` command shown immediately above them, so the
     next change to the block cannot silently falsify the published doc.
"""

import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.remediation import load_catalog  # noqa: E402
from einvoice.report import (  # noqa: E402
    EXIT_OK, EXIT_FAIL, format_explain, rule_page_url)

KNOWN = "BR-DE-15"
#: A rule whose German is a project translation rather than official KoSIT
#: text: the `in German` pointer must appear for it too (German IS shipped),
#: which is what separates "has German" from "has OFFICIAL German".
TRANSLATED = "BR-01"
QUICKSTART = os.path.join(HERE, "QUICKSTART.md")
#: The doc spells the console script; a checkout runs the shim of the same name.
#: Same convention as `test_docs_example_output.CHECKOUT_ENTRY`.
CHECKOUT_ENTRY = "einvoice.py"
FENCE_RE = re.compile(r"```([^\n]*)\n(.*?)```\n", re.S)


def run_cli(args, cwd=None):
    """Invoke `python3 -m einvoice.report ...`; return (rc, stdout, stderr)."""
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice.report"] + args,
        cwd=cwd or HERE, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    return proc.returncode, proc.stdout, proc.stderr


class ExplainKnownId(unittest.TestCase):
    def test_prints_every_documented_field(self):
        entry = load_catalog()[KNOWN]
        rc, out, err = run_cli(["--explain", KNOWN])
        self.assertEqual(rc, EXIT_OK, err)
        self.assertEqual(err, "")
        # The rule id and its human title appear.
        self.assertIn(KNOWN, out)
        self.assertIn(entry["title"], out)
        # Every documented field is rendered, verbatim from the catalog.
        self.assertIn(entry["requires"], out)
        for term in entry["bt_bg"]:
            self.assertIn(term, out)
        self.assertIn(entry["location_hint"], out)
        self.assertIn(entry["fix"], out)
        self.assertIn(entry["severity"], out)
        # Schematron provenance (source) is shown.
        self.assertIn(entry["provenance"]["source"], out)

    def test_format_explain_matches_catalog_only(self):
        # The helper returns text drawn from the catalog; a nonexistent id -> None.
        self.assertIsNotNone(format_explain(KNOWN))
        self.assertIsNone(format_explain("NOPE-999"))

    def test_case_insensitive_lookup(self):
        rc, out, err = run_cli(["--explain", KNOWN.lower()])
        self.assertEqual(rc, EXIT_OK, err)
        # Canonical (catalog-cased) id echoed back.
        self.assertIn(KNOWN, out)


class ExplainUnknownId(unittest.TestCase):
    def test_unknown_id_exits_nonzero_and_names_it(self):
        rc, out, err = run_cli(["--explain", "NOPE-999"])
        self.assertNotEqual(rc, EXIT_OK)
        self.assertEqual(rc, EXIT_FAIL)
        self.assertEqual(out, "")
        self.assertIn("NOPE-999", err)


class ExplainNeedsNoInvoice(unittest.TestCase):
    def test_runs_with_no_invoice_file_present(self):
        # Run from an EMPTY temp dir with no xml anywhere: still succeeds.
        with tempfile.TemporaryDirectory() as tmp:
            rc, out, err = run_cli(["--explain", KNOWN], cwd=tmp)
            self.assertEqual(rc, EXIT_OK, err)
            self.assertIn(KNOWN, out)

    def test_explain_rejects_an_invoice_path(self):
        rc, out, err = run_cli(["--explain", KNOWN, "some-invoice.xml"])
        self.assertEqual(rc, EXIT_FAIL)
        self.assertIn("some-invoice.xml", err)

    def test_explain_rejects_format_and_baseline(self):
        rc, _, err = run_cli(["--explain", KNOWN, "--format", "junit"])
        self.assertEqual(rc, EXIT_FAIL)
        self.assertIn("--explain", err)
        rc, _, err = run_cli(["--explain", KNOWN, "--baseline", "prev.json"])
        self.assertEqual(rc, EXIT_FAIL)
        self.assertIn("--explain", err)


class OnwardRoutes(unittest.TestCase):
    """The block must not be a dead end (T-VHUX2.5)."""

    def test_rule_page_line_uses_the_single_url_builder(self):
        rc, out, err = run_cli(["--explain", KNOWN])
        self.assertEqual(rc, EXIT_OK, err)
        self.assertIn("  rule page: %s\n" % rule_page_url(KNOWN), out)

    def test_rule_page_uses_the_canonical_id_not_the_typed_one(self):
        # A lowercase lookup must still link to the real (upper-case) page.
        rc, out, err = run_cli(["--explain", KNOWN.lower()])
        self.assertEqual(rc, EXIT_OK, err)
        self.assertIn(rule_page_url(KNOWN), out)
        self.assertNotIn(rule_page_url(KNOWN.lower()), out)

    def test_rule_page_is_shown_in_german_too(self):
        rc, out, err = run_cli(["--explain", KNOWN, "--lang=de"])
        self.assertEqual(rc, EXIT_OK, err)
        self.assertIn(rule_page_url(KNOWN), out)

    def test_english_block_points_at_lang_de_with_a_pasteable_command(self):
        for rule in (KNOWN, TRANSLATED):
            rc, out, err = run_cli(["--explain", rule])
            self.assertEqual(rc, EXIT_OK, err)
            self.assertIn("--lang=de", out)
            # Exactly one line, and it names THIS rule (not an example id).
            pointer = [ln for ln in out.splitlines() if "--lang" in ln]
            self.assertEqual(len(pointer), 1, out)
            self.assertIn(rule, pointer[0])
            # ...and the label is NOT `german`, which already means provenance.
            self.assertNotIn("german", pointer[0])

    def test_german_block_suppresses_the_german_pointer(self):
        for rule in (KNOWN, TRANSLATED):
            rc, out, err = run_cli(["--explain", rule, "--lang=de"])
            self.assertEqual(rc, EXIT_OK, err)
            self.assertNotIn("--lang", out)

    def test_pointer_is_omitted_when_no_german_is_shipped(self):
        # Never promise German the catalog cannot deliver. Synthetic entry: the
        # real catalog has German for all 297 rules today, so this guard is only
        # reachable through a crafted catalog — which is exactly why it is
        # tested rather than trusted.
        bare = {"NO-DE-1": {"title": "t", "requires": "r", "bt_bg": [],
                            "location_hint": "loc", "fix": "f",
                            "severity": "fatal", "provenance": {"source": "s"},
                            "de_source": None, "title_de": "", "fix_de": ""}}
        block = format_explain("NO-DE-1", catalog=bare)
        self.assertIsNotNone(block)
        self.assertNotIn("--lang", block)
        # The rule-page line is unaffected: the entry IS catalogued.
        self.assertIn(rule_page_url("NO-DE-1"), block)

    def test_at_most_two_lines_were_added_to_the_historical_block(self):
        # The pre-existing fields are untouched and still first: the new lines
        # only ever append.
        en = run_cli(["--explain", KNOWN])[1].splitlines()
        self.assertEqual(en[-2][:11], "  rule page")
        self.assertEqual(en[-1][:11], "  in German")
        # Column alignment: every field line puts its colon in the same column.
        cols = set(ln.index(":") for ln in en if ln.startswith("  "))
        self.assertEqual(len(cols), 1, en)


class EveryCatalogedRuleHasAPage(unittest.TestCase):
    """The invariant the new `rule page` link's truth rests on."""

    def test_every_catalogued_rule_has_a_generated_page(self):
        rules = sorted(load_catalog())
        self.assertGreater(len(rules), 200)  # the corpus, not an empty read
        missing = [rid for rid in rules if not os.path.isfile(
            os.path.join(HERE, "www", "rules", rid, "index.html"))]
        self.assertEqual(missing, [], "catalogued rules with no generated "
                                      "page (rule_page_url would 404): %r"
                                      % missing[:5])

    def test_no_generated_page_lacks_a_catalog_entry(self):
        rules = set(load_catalog())
        pages = set(os.listdir(os.path.join(HERE, "www", "rules")))
        pages = set(p for p in pages
                    if os.path.isdir(os.path.join(HERE, "www", "rules", p)))
        self.assertEqual(sorted(pages - rules), [])


def quickstart_explain_transcripts():
    """Yield (command, shown_output) for every `--explain` demo in QUICKSTART.

    A demo is an ```sh fence holding exactly one `einvoice --explain …` command,
    immediately followed by a ```text fence carrying its output verbatim.
    """
    with open(QUICKSTART, encoding="utf-8") as fh:
        text = fh.read()
    blocks = [(m.group(1).strip(), m.group(2)) for m in FENCE_RE.finditer(text)]
    for i, (info, body) in enumerate(blocks):
        if info != "sh" or i + 1 >= len(blocks):
            continue
        cmds = [ln.strip() for ln in body.splitlines()
                if ln.strip() and not ln.strip().startswith("#")]
        if len(cmds) != 1 or not cmds[0].startswith("einvoice --explain"):
            continue
        nxt_info, nxt_body = blocks[i + 1]
        if nxt_info != "text":
            continue
        yield cmds[0], nxt_body


class QuickstartTranscriptsAreReal(unittest.TestCase):
    """Replay the doc's verbatim transcripts. Nothing else in the suite does."""

    def test_both_explain_transcripts_match_live_output_byte_for_byte(self):
        found = []
        for cmd, shown in quickstart_explain_transcripts():
            argv = cmd.split()
            self.assertEqual(argv[0], "einvoice")
            env = dict(os.environ)
            env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
            proc = subprocess.run(
                [sys.executable, CHECKOUT_ENTRY] + argv[1:],
                cwd=HERE, env=env, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, universal_newlines=True)
            self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
            self.assertEqual(
                proc.stdout, shown,
                "QUICKSTART.md's transcript for `%s` no longer matches what "
                "the command prints. Regenerate it by RUNNING the command, "
                "never by hand-editing the fence." % cmd)
            found.append(cmd)
        # Both the English and the German demo must have been exercised: a
        # deleted fence must fail this test, not silently shrink its scope.
        self.assertEqual(found, ["einvoice --explain %s" % KNOWN,
                                 "einvoice --explain %s --lang=de" % KNOWN])

    def test_the_doc_shows_the_rule_page_link(self):
        # The whole point of the task: the doc's reader sees the hop too.
        with open(QUICKSTART, encoding="utf-8") as fh:
            text = fh.read()
        self.assertGreaterEqual(text.count(rule_page_url(KNOWN)), 2)


if __name__ == "__main__":
    unittest.main()
