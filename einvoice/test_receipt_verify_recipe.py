#!/usr/bin/env python3
"""test_receipt_verify_recipe.py — drift-guard for the documented CI recipe.

RECEIPT-VERIFICATION.md tells an adopter one thing to run when a party hands
them a conformance receipt and they want CI to fail on tampering:

    einvoice receipt --verify <receipt.json>

That convenience command (shipped by T-VHRVFY.1/.2, commits 0ece1c2/5cfdace)
could silently drift from what the docs say to run. This test closes that gap
the same way ``test_receipt_recipe.py`` guards the zero-trust manual snippet: it
does NOT hardcode a parallel command string — it PARSES the command out of the
doc's ``## Verify a supplied receipt in CI`` fenced block and drives the REAL
CLI (``einvoice.py`` as a subprocess, same style as ``test_receipt_verify.py``)
with it. If the doc's copy-paste command and the tool ever diverge, this fails.

It asserts, using the extracted command:

  * a committed golden receipt fixture under ``golden/`` VERIFIES clean
    (exit 0, ``VERIFIED`` on stdout), and
  * a single-field-tampered copy of that fixture is REJECTED
    (exit 1, ``TAMPERED`` on stdout).

Distinct from test_receipt_recipe.py (which runs the stdlib recompute snippet,
no einvoice binary) and from test_receipt_verify.py (which hardcodes the CLI
invocation to prove the subcommand's behaviour): THIS suite pins the CLI's use
to the exact command string printed in the doc, so the doc cannot promise a
command the tool no longer honours. Standard library only; runnable directly as
``python3 test_receipt_verify_recipe.py``. No package code is touched.
"""

import copy
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DOC_NAME = "RECEIPT-VERIFICATION.md"
DOC_PATH = os.path.join(HERE, DOC_NAME)
WRAPPER = os.path.join(HERE, "einvoice.py")
GOLDEN_DIR = os.path.join(HERE, "golden")

# A committed golden receipt fixture this recipe is exercised against. It is a
# real receipt produced by build_receipt and stored with its true
# content_sha256, so it MUST verify clean; a single-field mutation of it MUST be
# rejected. (The full golden set is covered by test_receipt_recipe.py.)
GOLDEN_FIXTURE = os.path.join(GOLDEN_DIR, "receipt-cii-valid-example5.json")


# --------------------------------------------------------------------------
# Extract the ONE copy-paste command out of the doc's CI-recipe section, rather
# than duplicating it here. Mirrors how test_receipt_recipe.py transcribes the
# manual snippet verbatim: the doc is the single source of truth for the command.
# --------------------------------------------------------------------------
def _ci_section_text():
    """The body of the '## ... in CI' section, up to the next '## ' heading."""
    with open(DOC_PATH, encoding="utf-8") as fh:
        text = fh.read()
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.startswith("## ") and re.search(r"\bin CI\b", line, re.IGNORECASE):
            start = i
            break
    if start is None:
        raise AssertionError(
            "%s has no '## ... in CI' section to extract the recipe from" % DOC_NAME)
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if lines[j].startswith("## "):
            end = j
            break
    return "\n".join(lines[start:end])


def _fenced_blocks(section):
    """Yield the text inside each ``` ... ``` fence in the given section."""
    blocks = []
    inside = False
    buf = []
    for line in section.splitlines():
        if line.strip().startswith("```"):
            if inside:
                blocks.append("\n".join(buf))
                buf = []
            inside = not inside
            continue
        if inside:
            buf.append(line)
    return blocks


def extract_ci_command():
    """The plain `einvoice receipt --verify <path>` command, parsed from the doc.

    Returns the shlex-split token list. Picks the copy-paste command (no shell
    prompt, no `--json`) — the single line an adopter drops into a CI step."""
    section = _ci_section_text()
    candidates = []
    for block in _fenced_blocks(section):
        for raw in block.splitlines():
            line = raw.strip()
            if line.startswith("$ "):          # a shown-output / prompt line
                line = line[2:].strip()
            if not line.startswith("einvoice receipt --verify"):
                continue
            if "--json" in line:               # the machine-branching variant
                continue
            candidates.append(line)
    if not candidates:
        raise AssertionError(
            "no plain `einvoice receipt --verify` command found in the CI "
            "section of %s" % DOC_NAME)
    # The doc's contract is a single copy-paste command; if it grew a second,
    # the drift guard should notice rather than silently pick one.
    if len(candidates) != 1:
        raise AssertionError(
            "expected exactly one plain CI command, found %d: %r"
            % (len(candidates), candidates))
    return shlex.split(candidates[0])


def _cli_argv_from_recipe(receipt_path):
    """Turn the documented command into a real CLI argv for `receipt_path`.

    tokens = ['einvoice', 'receipt', '--verify', '<placeholder>.json']
    ->        [python, einvoice.py, 'receipt', '--verify', receipt_path]
    Only the binary name and the trailing path placeholder are substituted; the
    subcommand/flags in the middle are taken verbatim from the doc."""
    tokens = extract_ci_command()
    assert tokens[0] == "einvoice", "recipe must invoke the einvoice binary: %r" % tokens
    assert tokens[1] == "receipt", "recipe must call the receipt subcommand: %r" % tokens
    assert "--verify" in tokens, "recipe must pass --verify: %r" % tokens
    assert tokens[-1].endswith(".json"), \
        "recipe's last token must be a receipt path placeholder: %r" % tokens
    return [sys.executable, WRAPPER] + tokens[1:-1] + [receipt_path]


def _run(receipt_path):
    return subprocess.run(_cli_argv_from_recipe(receipt_path),
                          capture_output=True, text=True)


class RecipeExtraction(unittest.TestCase):
    """The command is really parsed out of the doc, not hardcoded here."""

    def test_doc_and_fixture_exist(self):
        self.assertTrue(os.path.isfile(DOC_PATH),
                        "%s must exist — this test is its executable guard" % DOC_NAME)
        self.assertTrue(os.path.isfile(GOLDEN_FIXTURE),
                        "committed golden fixture missing: %s" % GOLDEN_FIXTURE)

    def test_extracted_command_shape(self):
        tokens = extract_ci_command()
        self.assertEqual(tokens[0], "einvoice")
        self.assertEqual(tokens[1], "receipt")
        self.assertIn("--verify", tokens)
        self.assertNotIn("--json", tokens)


class ExtractedCommandVerifiesGolden(unittest.TestCase):
    """The doc's command verifies a committed golden receipt clean."""

    def test_golden_receipt_verifies_clean(self):
        proc = _run(GOLDEN_FIXTURE)
        self.assertEqual(proc.returncode, 0,
                         "golden receipt must VERIFY via the documented command "
                         "(stderr: %s)" % proc.stderr)
        self.assertIn("VERIFIED", proc.stdout)


class ExtractedCommandRejectsTamper(unittest.TestCase):
    """The doc's command rejects a single-field-tampered copy of the golden."""

    def test_tampered_copy_is_rejected(self):
        with open(GOLDEN_FIXTURE, encoding="utf-8") as fh:
            doc = json.load(fh)
        tampered = copy.deepcopy(doc)
        body = tampered["receipt"]
        # A single body field changed, content_sha256 left as-is -> mismatch.
        body["verdict"] = "PASS" if body.get("verdict") != "PASS" else "FAIL"
        self.assertNotEqual(tampered["receipt"], doc["receipt"],
                            "tamper must actually change the body")

        fd, path = tempfile.mkstemp(suffix=".json", prefix="receipt-verify-recipe-")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(tampered, fh)
        try:
            proc = _run(path)
        finally:
            os.remove(path)
        self.assertEqual(proc.returncode, 1,
                         "tampered receipt must be REJECTED with exit 1 "
                         "(got %d; stderr %s)" % (proc.returncode, proc.stderr))
        self.assertIn("TAMPERED", proc.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
