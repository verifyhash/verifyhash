#!/usr/bin/env python3
"""test_report_diff_golden.py — byte-golden LOCK over the emitted ``--baseline``
diff document (T-VHFMTP.8).

WHAT THIS IS
------------
``test_report_diff.py`` proves the ``--baseline`` diff mode's BEHAVIOUR — the
set/count arithmetic (new / resolved / unchanged), the fatal-driven exit code,
and the malformed-baseline handling. What it deliberately never pins is the
EXACT bytes of the emitted diff *document*: a driver that captures a diff in CI
(``python3 -m einvoice.report --baseline prev.json invoice.xml``) and stores or
diffs it byte-for-byte has no test that a refactor keeps that emission stable —
a stray key, a set-ordering flip, a serialization option change, or a leaked
absolute path would slip past every existing gate and churn a stranger's
pipeline. (Confirmed: ``test_report_diff.py`` asserts only ``schema``/``mode``,
list membership and counts — it makes NO byte-golden, regeneration or
path-invariance assertion over the emitted document.)

This module closes that gap the same way ``test_format_regression.py`` /
``test_report_sarif.py`` lock the machine formats: it freezes the EXACT emitted
bytes of a diff document — built by the shipped ``build_diff`` over an EXISTING
committed corpus pair — and asserts byte-identity with a committed golden under
``golden/``. It adds no format, no corpus fixture and no rule logic, and it does
not touch ``build_diff``.

THE PINNED DIFF (a real, economically-meaningful document — not a stub)
----------------------------------------------------------------------
Baseline  = the shipped report of the xrechnung-testsuite standard invoice
            ``corpus/.../standard/01.01a-INVOICE_ubl.xml`` (the SAME BASE the
            fast diff test already uses — no new corpus).
Current   = that same invoice with its ``<cbc:BuyerReference>`` removed (the
            SAME runtime twin ``test_report_diff.py`` builds via
            ``make_bad_invoice`` — a generated document, NOT a committed
            fixture), which re-introduces the BR-DE-15 fatal.
The diff therefore records exactly one NEW fatal (BR-DE-15) against the clean
baseline — the headline regression case ``--baseline`` mode exists to catch.

PATH-INVARIANCE (regenerable but scrubbed)
------------------------------------------
The diff head echoes three path-shaped fields (``source``, ``baseline``,
``baseline_source``). We keep every one checkout-independent exactly the way
``test_format_regression.build_report_dict`` does — by driving the emitters with
RELATIVE paths from a controlled cwd:
  * ``baseline_source`` is captured with ``build_report`` run from ``cwd=HERE``
    over the relative corpus path, so it echoes ``corpus/...`` (never $HOME);
  * ``source``/``baseline`` are the fixed relative strings ``bad.xml`` /
    ``baseline.json`` produced by driving ``build_diff`` from ``cwd`` inside a
    throwaway temp dir.
A ``_path_leak`` guard (mirroring ``test_format_regression._path_leak``) refuses
to write OR accept any golden carrying ``HERE``, ``$HOME`` or a ``/home/``
prefix.

CODE PATH (the REAL emitter — no hand-authored bytes)
-----------------------------------------------------
The golden is serialized with the IDENTICAL options ``report.main`` uses for the
default (non-``--pretty``) ``--baseline`` emission:
    json.dumps(diff, separators=(",", ":")) + "\n"
and ``_assert_emit_matches_cli`` proves that in-process emission is byte-for-byte
what the REAL ``python3 -m einvoice.report --baseline ...`` CLI writes to stdout.

REGENERATION (never automatic)
------------------------------
    REGEN=1 python3 test_report_diff_golden.py     # or:  --update
Regeneration refuses to freeze a broken diff shape, a CLI-divergent emit, or a
path leak — the same discipline the machine-format lock uses.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
GOLDEN_DIR = os.path.join(HERE, "golden")

from einvoice.report import (  # noqa: E402
    build_report, build_diff, REPORT_DIFF_SCHEMA_ID,
)

#: The SAME BASE fixture family the fast diff test uses (no new corpus). Held as
#: a checkout-relative path so build_report's echoed ``source`` stays
#: path-invariant when driven from cwd=HERE.
BASE_REL = os.path.join(
    "corpus", "xrechnung-testsuite", "src", "test", "business-cases",
    "standard", "01.01a-INVOICE_ubl.xml")

PROFILE = "xrechnung"

#: Stable, path-invariant provenance labels recorded in the emitted document.
CURRENT_NAME = "bad.xml"
BASELINE_NAME = "baseline.json"

#: The committed golden. Its name carries "diff" so the harness gate that greps
#: golden/ for a diff artifact matches it.
GOLDEN_NAME = "report-diff-buyerref-new-fatal.json"
GOLDEN_PATH = os.path.join(GOLDEN_DIR, GOLDEN_NAME)


def make_bad_invoice_bytes():
    """The BuyerReference-removed twin of BASE — the SAME construction
    ``test_report_diff.make_bad_invoice`` uses. A generated document, NOT a
    committed corpus fixture. Reintroduces the BR-DE-15 fatal."""
    with open(os.path.join(HERE, BASE_REL), encoding="utf-8") as fh:
        src = fh.read()
    bad = re.sub(r"<cbc:BuyerReference>[^<]*</cbc:BuyerReference>", "", src,
                 count=1)
    assert bad != src, "fixture drift: BASE lost its BuyerReference"
    return bad


def build_baseline():
    """The clean prior report of BASE, captured with a path-invariant
    ``source`` (build_report driven from cwd=HERE with the relative path)."""
    prev = os.getcwd()
    try:
        os.chdir(HERE)
        return build_report(BASE_REL, profile=PROFILE)
    finally:
        os.chdir(prev)


def build_diff_doc():
    """Build the pinned diff document via the shipped ``build_diff`` over the
    committed BASE pair, keeping every echoed path field checkout-independent.
    Returns the diff dict (deterministic; no timestamp/order leakage)."""
    baseline = build_baseline()
    bad = make_bad_invoice_bytes()
    with tempfile.TemporaryDirectory() as tmp:
        with open(os.path.join(tmp, CURRENT_NAME), "w", encoding="utf-8") as fh:
            fh.write(bad)
        prev = os.getcwd()
        try:
            os.chdir(tmp)
            return build_diff(CURRENT_NAME, baseline, profile=PROFILE,
                              baseline_path=BASELINE_NAME)
        finally:
            os.chdir(prev)


def emit(diff):
    """Serialize ``diff`` with the EXACT options report.main uses for the
    default (non --pretty) --baseline emission."""
    return (json.dumps(diff, separators=(",", ":")) + "\n").encode("utf-8")


def _path_leak(data):
    """Return a human reason if ``data`` (bytes) carries an absolute checkout
    prefix, $HOME, or any /home/ path — else ''. Enforces path-invariance
    (mirrors test_format_regression._path_leak)."""
    home = os.environ.get("HOME", "")
    for needle in (HERE.encode("utf-8"),
                   (home.encode("utf-8") if home else b"\x00never\x00"),
                   b"/home/"):
        if needle and needle in data:
            return "contains absolute/HOME prefix %r" % needle
    return ""


def _assert_emit_matches_cli():
    """Prove ``emit(build_diff_doc())`` is byte-identical to driving the REAL
    ``python3 -m einvoice.report --baseline ...`` CLI. Returns failure lines
    (empty = OK). The CLI is run from a temp dir with the SAME relative
    ``bad.xml`` / ``baseline.json`` names so its echoed paths match the golden's
    path-invariant labels exactly."""
    baseline = build_baseline()
    bad = make_bad_invoice_bytes()
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    with tempfile.TemporaryDirectory() as tmp:
        with open(os.path.join(tmp, CURRENT_NAME), "w", encoding="utf-8") as fh:
            fh.write(bad)
        with open(os.path.join(tmp, BASELINE_NAME), "w",
                  encoding="utf-8") as fh:
            json.dump(baseline, fh)
        proc = subprocess.run(
            [sys.executable, "-m", "einvoice.report", "--baseline",
             BASELINE_NAME, "--profile", PROFILE, CURRENT_NAME],
            cwd=tmp, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=120)
    want = emit(build_diff_doc())
    fails = []
    # exit 1 == a NEW fatal vs baseline (the pinned document's whole point).
    if proc.returncode != 1:
        fails.append("  CLI exit=%d (want 1: a NEW fatal vs baseline); "
                     "stderr=%r" % (proc.returncode, proc.stderr[:200]))
    if proc.stdout != want:
        fails.append("  in-process emit != real CLI stdout")
    return fails


def _regen_guard(diff):
    """Refuse to freeze a golden over a diff that does not carry the expected
    economic shape (a single BR-DE-15 NEW fatal). Returns failure lines."""
    fails = []
    if diff.get("schema") != REPORT_DIFF_SCHEMA_ID:
        fails.append("  schema=%r (want %r)"
                     % (diff.get("schema"), REPORT_DIFF_SCHEMA_ID))
    if diff.get("error"):
        fails.append("  diff carries error=%r (never pin an error over a "
                     "well-formed pair)" % diff.get("error"))
    if diff.get("new_fatal_count", 0) < 1:
        fails.append("  new_fatal_count=%r (want >=1: the pinned regression)"
                     % diff.get("new_fatal_count"))
    rules = [v.get("rule") for v in diff.get("new_violations", [])]
    if "BR-DE-15" not in rules:
        fails.append("  BR-DE-15 not in new_violations rules=%r" % rules)
    return fails


def write_golden():
    """Regenerate the diff golden (only via --update / REGEN=1), refusing to
    freeze a broken shape, a CLI-divergent emit, or a path leak."""
    if not os.path.isdir(GOLDEN_DIR):
        os.makedirs(GOLDEN_DIR)
    diff = build_diff_doc()
    guard = _regen_guard(diff) + _assert_emit_matches_cli()
    if guard:
        raise SystemExit("refusing to regenerate diff golden:\n"
                         + "\n".join(guard))
    data = emit(diff)
    leak = _path_leak(data)
    if leak:
        raise SystemExit("refusing to write a NON-path-invariant diff golden: "
                         + leak)
    with open(GOLDEN_PATH, "wb") as fh:
        fh.write(data)
    return GOLDEN_PATH


class DiffGolden(unittest.TestCase):
    def test_byte_identity_with_committed_golden(self):
        """(2) The committed golden is byte-identical to a fresh build_diff
        emission with the default --baseline serialization."""
        self.assertTrue(os.path.isfile(GOLDEN_PATH),
                        "missing golden %s (run REGEN=1)" % GOLDEN_NAME)
        with open(GOLDEN_PATH, "rb") as fh:
            golden = fh.read()
        data = emit(build_diff_doc())
        self.assertEqual(data, golden,
                         "emitted diff bytes drifted from committed golden %s "
                         "(run REGEN=1 to inspect/regenerate)" % GOLDEN_NAME)

    def test_regeneration_determinism(self):
        """(3) Building the diff document twice yields byte-identical output —
        no timestamp, dict-order or set-ordering leakage."""
        self.assertEqual(emit(build_diff_doc()), emit(build_diff_doc()))

    def test_golden_is_path_invariant(self):
        """(4) The committed golden carries no absolute repo path, $HOME,
        username or /home/ prefix."""
        self.assertTrue(os.path.isfile(GOLDEN_PATH), GOLDEN_PATH)
        with open(GOLDEN_PATH, "rb") as fh:
            golden = fh.read()
        leak = _path_leak(golden)
        self.assertEqual(leak, "", "committed golden leaks a path: %s" % leak)
        # The freshly emitted bytes must be scrubbed too (guards regeneration).
        self.assertEqual(_path_leak(emit(build_diff_doc())), "")

    def test_emit_matches_real_cli(self):
        """The in-process emission equals the REAL --baseline CLI stdout
        (the golden is CLI-verified, not merely engine-internal), and the CLI
        exits 1 on the pinned NEW-fatal regression."""
        fails = _assert_emit_matches_cli()
        self.assertEqual(fails, [], "\n".join(fails))

    def test_pinned_document_is_meaningful(self):
        """The pinned diff is a real regression document: exactly the BR-DE-15
        NEW fatal, against a clean baseline, with path-invariant provenance."""
        diff = build_diff_doc()
        self.assertEqual(_regen_guard(diff), [])
        self.assertEqual(diff["source"], CURRENT_NAME)
        self.assertEqual(diff["baseline"], BASELINE_NAME)
        self.assertEqual(diff["mode"], "diff")
        # baseline_source is the checkout-relative corpus path (path-invariant).
        self.assertEqual(diff["baseline_source"], BASE_REL.replace(os.sep, "/"))


def _main():
    if "--update" in sys.argv[1:] or os.environ.get("REGEN"):
        path = write_golden()
        sys.stderr.write("wrote %s\n" % path)
        return
    unittest.main()


if __name__ == "__main__":
    _main()
