#!/usr/bin/env python3
"""test_cli_docs_value_parity.py — enumerated-flag VALUE ↔ docs parity guard
(T-VHDOCV.2).

MEASURE-FIRST result (why this file is new, not a duplicate). Its sibling
``test_cli_docs_parity.py`` (DOCV.1) pins the flag NAMES, subcommands and exit
codes, and it proves that the three valued ``validate`` flags
(``--profile``/``--lang``/``--fail-on``) each CONSUME a token — but it never
enumerates the accepted VALUES of the enumerated flags, and never cross-checks
those value sets against the docs. A grep of the suite
(``grep -rniE 'PROFILES|SUPPORTED_LANGS|REPORT_FORMATS' test_*.py``) confirms the
other value-aware tests each pin a slice for their own purpose and none asserts
a doc↔registry value matrix:

  * test_report_formats.py / test_fuzz_report_formats.py — exercise the format
    EMITTERS over a corpus; they never read the docs.
  * test_fail_on.py — drives the ``--fail-on`` exit-code SEMANTICS; it does not
    assert the documented value set equals the accepted one.
  * test_facturx_profile_scope.py — pins the five façade profiles, not the
    ``--profile`` dispatch tuple against the docs.

So the specific gap this closes: nothing asserted that, for each enumerated
flag, EVERY value the parser accepts is documented AND EVERY value the docs
advertise is actually accepted (no undocumented value, no phantom doc-only
value). This file is that matrix guard.

The four value registries are the SINGLE SOURCE OF TRUTH — imported, never
hand-listed as a parallel copy:

  * ``--profile``  -> ``einvoice.validate.PROFILES``        (cli.py L787 / report.py
                      L2074 validate ``x not in PROFILES``)
  * ``--lang``     -> ``einvoice.remediation.SUPPORTED_LANGS`` (cli.py L791)
  * ``--fail-on``  -> ``einvoice.cli.FAIL_ON_LEVELS``        (cli.py L795, the
                      constant the parser validates against; its keys equal the
                      ``_SEVERITY_RANK`` vocabulary)
  * ``--format``   -> ``einvoice.report.REPORT_FORMATS``     (report.py L2068;
                      this nine-name tuple ALREADY includes ``text``, so the
                      CLI's ``sorted(set(REPORT_FORMATS) | {"text"})`` in
                      ``einvoice info`` is a no-op superset — no extra value)

Note the entry-point split: ``--profile``/``--lang``/``--fail-on`` are the
``einvoice`` CLI's (validated in ``cli.py``), while ``--format`` belongs to the
SEPARATE ``python3 -m einvoice.report`` entry point (validated in ``report.py``)
— DOCV.1 deliberately excludes that entry point, which is exactly why its value
set is unguarded until now. Each flag is driven through the parser that actually
validates it.

The documented value set is DERIVED from the real doc surface, never hand-kept:
for each flag we scan the four user docs DOCV.1 audits (README.md / QUICKSTART.md
/ EXIT-CODES.md / RECEIPT-VERIFICATION.md) PLUS the two live ``USAGE`` strings
(``einvoice.cli.USAGE`` and ``einvoice.report.USAGE``) for the flag's
enumeration form — ``--flag v1|v2|…`` (pipe) or ``--flag a/b/c`` (slash, as in
README's ``--format sarif/html/badge``). Only multi-value enumerations are read,
so an intentional invalid-value counter-example written in prose (e.g.
QUICKSTART's ``--lang=fr`` "errors exactly like the bad flag" or EXIT-CODES'
``fail-on = "bogus"`` / ``format = "yaml"``) is NOT misread as an advertised
value.

Three assertions per enumerated flag (the matrix):
  (a) registry ⊆ documented — every accepted value is documented somewhere
      (no undocumented accepted value);
  (b) documented ⊆ registry — every advertised value is in the registry the
      parser validates against (no phantom doc-only value); and, STRONGER,
  (c) each documented value is driven through the REAL parser against a
      committed fixture and asserted NOT rejected as an invalid value — while a
      synthetic bogus value IS rejected (non-vacuity: proves registry membership
      genuinely equals parser acceptance).

MEASURED at authoring time: all four flags already match exactly (0 drift), so
this file adds a REGRESSION guard and changes no docs, no USAGE string, and no
engine/registry/validation behaviour. Fast, stdlib-only, offline, path-invariant.
Run: python3 test_cli_docs_value_parity.py
"""

import io
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice.cli as cli  # noqa: E402
import einvoice.report as report  # noqa: E402
from einvoice.validate import PROFILES  # noqa: E402
from einvoice.remediation import SUPPORTED_LANGS  # noqa: E402
from einvoice.report import REPORT_FORMATS  # noqa: E402
from einvoice.cli import FAIL_ON_LEVELS, EXIT_USAGE  # noqa: E402

# The four user docs DOCV.1 audits — the same doc surface, reused verbatim.
DOC_FILES = ("README.md", "QUICKSTART.md", "EXIT-CODES.md",
             "RECEIPT-VERIFICATION.md")

# A committed VALID invoice reused verbatim from DOCV.1 / test_cli.py — no new
# corpus data. Driving any accepted flag value against it must never raise an
# invalid-VALUE usage error (it validates cleanly under the default profile).
PASS_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")

# A value no registry will ever contain — used to prove the reject probes below
# are not vacuous (a bogus value really is refused as an invalid value).
BOGUS_VALUE = "definitely-not-a-value"


# --------------------------------------------------------------------------- #
# In-process driver (identical shape to DOCV.1 / test_cli._Capture); works for
# both entry points because both expose a ``main(argv)`` that returns an int.
# --------------------------------------------------------------------------- #
class _Capture:
    def __init__(self, fn, argv):
        self.fn, self.argv = fn, argv
        self.rc = self.out = self.err = None

    def __enter__(self):
        self._out, self._err = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = io.StringIO(), io.StringIO()
        try:
            self.rc = self.fn(self.argv)
        finally:
            self.out = sys.stdout.getvalue()
            self.err = sys.stderr.getvalue()
            sys.stdout, sys.stderr = self._out, self._err
        return self

    def __exit__(self, *exc):
        return False


def drive_cli(argv):
    """Drive the ``einvoice`` CLI (cli.main); return (rc, stdout, stderr)."""
    with _Capture(cli.main, argv) as cap:
        return cap.rc, cap.out, cap.err


def drive_report(argv):
    """Drive ``python3 -m einvoice.report`` (report.main); return the triple."""
    with _Capture(report.main, argv) as cap:
        return cap.rc, cap.out, cap.err


# --------------------------------------------------------------------------- #
# Documented-value derivation — parse the REAL doc surface, never a hand list.
# --------------------------------------------------------------------------- #
def doc_corpus():
    """All four doc files PLUS the two live USAGE strings, concatenated.

    The USAGE strings ARE part of the documented surface a user reads (they are
    printed on every usage error), and they carry the full pipe enumerations
    that README/EXIT-CODES sometimes split across prose.
    """
    parts = []
    for name in DOC_FILES:
        with open(os.path.join(HERE, name), encoding="utf-8") as fh:
            parts.append(fh.read())
    parts.append(cli.USAGE)
    parts.append(report.USAGE)
    return "\n".join(parts)


def documented_values(flag, text):
    """Values the docs ADVERTISE for ``flag``, from its enumeration form only.

    Matches ``--flag<sep>tok(<pipe-or-slash>tok)+`` where ``<sep>`` is ``=`` or
    whitespace — i.e. a genuine multi-choice advertisement such as
    ``--profile=en16931|xrechnung`` or README's ``--format sarif/html/badge``.
    A REQUIRED second alternative (the ``+`` on the group) means a bare mention
    or an intentional invalid-value counter-example in prose (``--lang=fr``) is
    never captured. Values are lower-cased tokens; the union across every
    occurrence is returned.
    """
    vals = set()
    pat = re.compile(
        re.escape(flag) + r"[=\s]([A-Za-z0-9]+(?:[|/][A-Za-z0-9]+)+)")
    for group in pat.findall(text):
        for tok in re.split(r"[|/]", group):
            if tok:
                vals.add(tok)
    return vals


# The enumerated flags and their single-source registries. ``fail-on``'s source
# is FAIL_ON_LEVELS (the tuple the parser tests against); we also assert its
# vocabulary equals the _SEVERITY_RANK keys so the two never drift apart.
_FLAG_REGISTRY = {
    "--profile": PROFILES,
    "--lang": SUPPORTED_LANGS,
    "--fail-on": FAIL_ON_LEVELS,
    "--format": REPORT_FORMATS,
}


# --------------------------------------------------------------------------- #
# Live reject probes (leg c) — drive the parser that actually validates a flag.
# Return True iff ``value`` is refused as an INVALID VALUE for ``flag``.
# --------------------------------------------------------------------------- #
def cli_value_rejected(flag, value):
    """``einvoice validate <flag> <value> <fixture>`` — rejected as bad value?"""
    needle = {
        "--profile": "unknown profile",
        "--lang": "unknown lang",
        "--fail-on": "unknown --fail-on value",
    }[flag]
    rc, _out, err = drive_cli(["validate", flag, value, PASS_FIXTURE])
    rejected = needle in err
    # A genuine invalid-value refusal is always the usage exit code.
    if rejected:
        assert rc == EXIT_USAGE, (flag, value, rc, err)
    return rejected


def report_value_rejected(flag, value):
    """``python3 -m einvoice.report <flag> <value> <fixture>`` — bad value?"""
    assert flag == "--format", flag
    rc, _out, err = drive_report([flag, value, PASS_FIXTURE])
    return "unknown format" in err


def value_rejected(flag, value):
    if flag == "--format":
        return report_value_rejected(flag, value)
    return cli_value_rejected(flag, value)


# --------------------------------------------------------------------------- #
# Preconditions.
# --------------------------------------------------------------------------- #
class Preconditions(unittest.TestCase):
    def test_fixture_and_docs_present(self):
        self.assertTrue(os.path.isfile(PASS_FIXTURE), PASS_FIXTURE)
        for name in DOC_FILES:
            self.assertTrue(os.path.isfile(os.path.join(HERE, name)), name)

    def test_registries_are_nonempty_tuples(self):
        for flag, reg in _FLAG_REGISTRY.items():
            self.assertIsInstance(reg, tuple, flag)
            self.assertTrue(reg, "%s registry is empty" % flag)

    def test_fail_on_registry_matches_severity_rank_keys(self):
        # FAIL_ON_LEVELS is the parser's accept-list; the exit-code logic ranks
        # the SAME vocabulary in _SEVERITY_RANK. Pin them together so neither can
        # gain/lose a value silently.
        self.assertEqual(set(FAIL_ON_LEVELS), set(cli._SEVERITY_RANK.keys()))

    def test_format_registry_absorbs_cli_text(self):
        # The CLI's `info` derives its formats as sorted(set(REPORT_FORMATS) |
        # {"text"}); assert that union adds nothing, so REPORT_FORMATS alone is
        # the complete --format value set (no hidden CLI-only value).
        self.assertIn("text", REPORT_FORMATS)
        self.assertEqual(set(REPORT_FORMATS) | {"text"}, set(REPORT_FORMATS))


# --------------------------------------------------------------------------- #
# Non-vacuity of the parser (each registry genuinely governs acceptance).
# --------------------------------------------------------------------------- #
class ProbeNonVacuity(unittest.TestCase):
    def test_bogus_value_is_rejected_by_each_flag(self):
        for flag in _FLAG_REGISTRY:
            with self.subTest(flag=flag):
                self.assertTrue(
                    value_rejected(flag, BOGUS_VALUE),
                    "%s did not reject a bogus value — the reject probe is "
                    "vacuous" % flag)

    def test_a_real_value_is_accepted_by_each_flag(self):
        # The first registry value of each flag must NOT be refused as invalid.
        for flag, reg in _FLAG_REGISTRY.items():
            with self.subTest(flag=flag):
                self.assertFalse(
                    value_rejected(flag, reg[0]),
                    "%s rejected its own registry value %r as invalid"
                    % (flag, reg[0]))

    def test_extraction_is_non_vacuous(self):
        # Guard the doc parser itself: a made-up flag yields nothing, and a
        # real enumeration is found.
        corpus = doc_corpus()
        self.assertEqual(documented_values("--no-such-flag", corpus), set())
        self.assertTrue(documented_values("--profile", corpus))


# --------------------------------------------------------------------------- #
# The parity matrix — leg (a), leg (b), leg (c) for every enumerated flag.
# --------------------------------------------------------------------------- #
class ValueMatrixParity(unittest.TestCase):
    def setUp(self):
        self.corpus = doc_corpus()

    def test_a_every_accepted_value_is_documented(self):
        # registry ⊆ documented.
        for flag, reg in _FLAG_REGISTRY.items():
            documented = documented_values(flag, self.corpus)
            with self.subTest(flag=flag):
                missing = set(reg) - documented
                self.assertFalse(
                    missing,
                    "%s accepts %r but the docs never advertise it "
                    "(undocumented accepted value); documented=%r"
                    % (flag, sorted(missing), sorted(documented)))

    def test_b_every_documented_value_is_in_the_registry(self):
        # documented ⊆ registry (static: no phantom doc-only value).
        for flag, reg in _FLAG_REGISTRY.items():
            documented = documented_values(flag, self.corpus)
            with self.subTest(flag=flag):
                self.assertTrue(documented, "no documented values for %s" % flag)
                phantom = documented - set(reg)
                self.assertFalse(
                    phantom,
                    "%s: docs advertise %r which is not in the registry the "
                    "parser validates against (phantom value)"
                    % (flag, sorted(phantom)))

    def test_c_every_documented_value_is_accepted_by_the_parser(self):
        # documented ⊆ accepted, PROVEN live through the real parser (stronger
        # than the static membership check above).
        for flag in _FLAG_REGISTRY:
            documented = documented_values(flag, self.corpus)
            for value in sorted(documented):
                with self.subTest(flag=flag, value=value):
                    self.assertFalse(
                        value_rejected(flag, value),
                        "%s: docs advertise value %r but the parser rejects it "
                        "as invalid (phantom)" % (flag, value))

    def test_matrix_is_exact_for_every_flag(self):
        # Combined, (a)+(b) mean documented == registry for each flag — assert
        # the equality directly as the headline invariant.
        for flag, reg in _FLAG_REGISTRY.items():
            with self.subTest(flag=flag):
                self.assertEqual(
                    documented_values(flag, self.corpus), set(reg),
                    "%s: documented value set diverged from the registry" % flag)


if __name__ == "__main__":
    unittest.main(verbosity=2)
