#!/usr/bin/env python3
"""test_spec_declaration.py — pin the declared-CIUS-vs-``--profile`` boundary.

Fast, stdlib-only, saxonche-free, offline. This test does **NOT** add, change,
gate, loosen, or widen any business rule, verdict, or accepted profile. It
MEASURES what the shipped CLI already does and PINS the honest, documented
contract so it can never silently drift:

    The ``--profile`` token is **authoritative** — it alone selects the rule set
    that runs. The document's *declared* identifier — the UBL
    ``cbc:CustomizationID`` (BT-24) or the CII
    ``rsm:ExchangedDocumentContext/ram:GuidelineSpecifiedDocumentContextParameter/ram:ID``
    — is **informational**: the engine applies the SAME rule set regardless of
    what the document declares.

MEASURE-FIRST (re-confirmed on disk while writing this test): no BR rule and no
CLI path compares the declared id against the selected ``--profile``. The
XRechnung national CIUS layer (the ``BR-DE-*`` rules in
``einvoice.rules_xrechnung``) runs **iff** ``--profile=xrechnung`` was passed —
never because the document declared an XRechnung urn, and it is never skipped
because the document declared a plain-core or garbage urn.

How the contract is made observable through the REAL CLI
--------------------------------------------------------
``--profile=xrechnung`` = the EN 16931 core rule set **plus** the German CIUS
layer (``BR-DE-*``); ``--profile=en16931`` = the core rule set **only**
(``einvoice.validate.PROFILES`` / ``validate_root`` layer C). So the presence or
absence of any ``BR-DE-*`` finding in the machine-readable ``--json`` report is
a direct, black-box witness of *which* rule set the CLI applied. The test drives
``python3 -m einvoice validate … --json`` as a subprocess (the packaged entry
point, exactly as ``test_cli.py`` does) and asserts:

  * the process exit code is one of the documented ``EXIT-CODES.md`` values,
  * stderr carries no Python ``Traceback`` (the run never crashes or hangs),
  * the applied rule set follows ``--profile``, **not** the declared id —
    proven by holding the declared id constant-varying across three documents
    (core urn / XRechnung CIUS urn / unknown garbage urn) and showing the CLI's
    observable result under a given profile is **invariant** to the declared id.

Scenarios (each an acceptance-criterion row):
  (a) a plain-EN 16931 UBL document (declared ``CustomizationID`` = the Peppol
      BIS / EN 16931-core urn, no XRechnung CIUS) under ``--profile=xrechnung``:
      the xrechnung layer IS applied (``BR-DE-*`` findings appear) even though
      the document did not declare XRechnung — the token governs.
  (b) an XRechnung-declared UBL document (``CustomizationID`` = the XRechnung
      CIUS urn) under ``--profile=en16931``: the core-only rule set is applied
      (NO ``BR-DE-*`` findings) — the declared CIUS id does NOT force the CIUS
      layer on.
  (c) a document declaring an UNKNOWN / garbage CIUS id: the CLI still produces
      a clean, deterministic result under each profile (documented exit code, no
      traceback), applying exactly the rule set the ``--profile`` selected — the
      unknown declared id neither enables nor disables any scope.

A CII declared-id case is pinned too (scenario b's ``ram:ID`` form): a raw CII
``CrossIndustryInvoice`` whose ``GuidelineSpecifiedDocumentContextParameter/ram:ID``
declares the XRechnung guideline urn. NOTE the measured reality of the *raw-XML*
CLI ``validate`` path: it dispatches on the XML root and only the UBL engine is
reached there, so a raw CII root deterministically trips the structural
``S-ROOT`` fatal — identically under BOTH profiles (the engine's CII rule path
is reached via the Factur-X/ZUGFeRD PDF container or the internal API, exercised
by ``test_golden_snapshot`` / ``test_rules_cii``). That is itself the boundary
this task pins: the raw-CII CLI path never *silently* applies the XRechnung
scope off the declared ``ram:ID`` — it rejects the same way regardless of the
declared id and regardless of ``--profile``, with no traceback.

Finally a drift-guard asserts the COVERAGE/SPEC prose still carries the honest
contract wording, so the pinned behaviour and the human-readable statement
cannot silently diverge.

Run: python3 test_spec_declaration.py
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

from einvoice.cli import (  # noqa: E402
    EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE, EXIT_PIPE, EXIT_INT, EXIT_TERM,
)

# The full documented exit-code contract (EXIT-CODES.md). Every CLI run this
# test makes must land on one of these — never a raw crash code.
DOCUMENTED_EXIT_CODES = {
    EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE, EXIT_PIPE, EXIT_INT, EXIT_TERM,
}

# A committed, EN 16931-core-clean UBL invoice. Its declared CustomizationID is
# the Peppol BIS 3.0 / EN 16931-core urn (NOT an XRechnung CIUS marker) — so it
# is a genuine "plain-EN16931 declared" document for scenario (a).
CORE_UBL = os.path.join(HERE, "corpus", "vendored", "valid",
                        "cen-bis3-positive_ubl.xml")

# A committed raw CII CrossIndustryInvoice that declares the XRechnung guideline
# urn in GuidelineSpecifiedDocumentContextParameter/ram:ID — used to pin the
# raw-CII CLI path's deterministic, declared-id-independent behaviour.
CII_XRECHNUNG_DECLARED = os.path.join(
    HERE, "corpus", "cen-en16931", "cii", "examples", "XRechnung-O.xml")

# The shipped human-readable coverage doc and its generator source, drift-guarded
# below so the prose and the pinned behaviour stay in lock-step.
COVERAGE_MD = os.path.join(HERE, "COVERAGE.md")
COVERAGE_PY = os.path.join(HERE, "einvoice", "coverage.py")

# Declared-identifier variants planted into the SAME core-clean UBL body. The
# document's business content is byte-identical across all three; only the
# declared CustomizationID text differs. If the tool ever let the declared id
# steer scope, these three would diverge under a fixed --profile — they must not.
DECLARED_ID_VARIANTS = {
    # plain EN 16931 core / Peppol BIS (no XRechnung CIUS marker)
    "core": "urn:cen.eu:en16931:2017#compliant#"
            "urn:fdc:peppol.eu:2017:poacc:billing:3.0",
    # the German XRechnung CIUS urn
    "xrechnung_cius": "urn:cen.eu:en16931:2017#compliant#"
                      "urn:xoev-de:kosit:standard:xrechnung_2.3",
    # a syntactically well-formed but wholly unknown / garbage identifier
    "garbage": "urn:example:not-a-real-profile:v99-garbage",
}

_CUSTOMIZATION_RE = re.compile(
    r"(<cbc:CustomizationID>)[^<]*(</cbc:CustomizationID>)")


def run_validate(path, profile):
    """Drive the packaged CLI: ``python3 -m einvoice validate <path> --json
    --profile=<profile>`` as a subprocess (bytes captured), matching how
    ``test_cli.py`` exercises the real entry point."""
    return subprocess.run(
        [sys.executable, "-m", "einvoice", "validate", path,
         "--json", "--profile=%s" % profile],
        cwd=HERE, capture_output=True)


def _rule_ids(stdout_bytes):
    """Parse the --json report and return the list of violation rule ids."""
    report = json.loads(stdout_bytes.decode("utf-8"))
    return [v["rule"] for v in report.get("violations", [])]


def _split_ids(rule_ids):
    """Partition rule ids into (core, br_de): the German CIUS layer is exactly
    the ``BR-DE-*`` family; everything else is the syntax-agnostic core."""
    br_de = [r for r in rule_ids if r.startswith("BR-DE")]
    core = [r for r in rule_ids if not r.startswith("BR-DE")]
    return sorted(core), sorted(br_de)


class _CliContractMixin:
    def assert_clean_documented_run(self, proc, label):
        """Every CLI run must exit on a documented code and never dump a
        Python traceback — no crash, no hang, no silent wrong-scope."""
        self.assertIn(
            proc.returncode, DOCUMENTED_EXIT_CODES,
            "%s: exit %s not in documented set %s (stderr: %r)"
            % (label, proc.returncode, sorted(DOCUMENTED_EXIT_CODES),
               proc.stderr))
        self.assertNotIn(
            b"Traceback", proc.stderr,
            "%s: CLI emitted a Python traceback: %r" % (label, proc.stderr))


class DeclaredIdVsProfileUBL(_CliContractMixin, unittest.TestCase):
    """Scenarios (a)/(b)/(c): drive the real CLI over three UBL documents that
    are byte-identical except for the declared CustomizationID, and prove the
    applied rule set is a pure function of ``--profile``."""

    @classmethod
    def setUpClass(cls):
        assert os.path.isfile(CORE_UBL), CORE_UBL
        with open(CORE_UBL, encoding="utf-8") as fh:
            body = fh.read()
        assert _CUSTOMIZATION_RE.search(body), \
            "fixture lost its cbc:CustomizationID: %s" % CORE_UBL
        cls._tmp = tempfile.TemporaryDirectory(prefix="specdecl_")
        cls.paths = {}
        for name, urn in DECLARED_ID_VARIANTS.items():
            variant = _CUSTOMIZATION_RE.sub(
                r"\g<1>" + urn.replace("\\", "\\\\") + r"\g<2>", body, count=1)
            # Confirm the substitution actually planted the intended id and did
            # not disturb the rest of the (core-clean) invoice body.
            assert ("<cbc:CustomizationID>%s</cbc:CustomizationID>" % urn) \
                in variant, name
            p = os.path.join(cls._tmp.name, "%s.xml" % name)
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(variant)
            cls.paths[name] = p

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    # ---- the three named scenarios ---------------------------------------

    def test_a_core_declared_under_xrechnung_applies_cius(self):
        """(a) A plain-EN16931-declared document under --profile=xrechnung: the
        XRechnung CIUS layer IS applied (BR-DE findings appear) even though the
        document declared only the core/Peppol urn — the token governs."""
        proc = run_validate(self.paths["core"], "xrechnung")
        self.assert_clean_documented_run(proc, "core-under-xrechnung")
        _core, br_de = _split_ids(_rule_ids(proc.stdout))
        self.assertTrue(
            br_de,
            "expected BR-DE-* findings when --profile=xrechnung is applied to "
            "the core-declared document; got none")

    def test_b_xrechnung_declared_under_en16931_stays_core_only(self):
        """(b) An XRechnung-CIUS-declared document under --profile=en16931: the
        core-only rule set is applied — NO BR-DE findings. The declared CIUS id
        does NOT force the CIUS layer on."""
        proc = run_validate(self.paths["xrechnung_cius"], "en16931")
        self.assert_clean_documented_run(proc, "xrechnung-declared-under-en16931")
        _core, br_de = _split_ids(_rule_ids(proc.stdout))
        self.assertEqual(
            br_de, [],
            "the declared XRechnung CIUS id must NOT switch on the BR-DE layer "
            "under --profile=en16931; got %r" % br_de)

    def test_c_unknown_declared_is_clean_and_deterministic(self):
        """(c) An unknown / garbage declared id: the CLI still produces a clean,
        deterministic, documented result under EACH profile, applying exactly
        the rule set --profile selected (core-only for en16931; +BR-DE for
        xrechnung). The garbage id neither enables nor disables any scope."""
        p = self.paths["garbage"]
        en = run_validate(p, "en16931")
        xr = run_validate(p, "xrechnung")
        self.assert_clean_documented_run(en, "garbage-under-en16931")
        self.assert_clean_documented_run(xr, "garbage-under-xrechnung")
        _en_core, en_br = _split_ids(_rule_ids(en.stdout))
        _xr_core, xr_br = _split_ids(_rule_ids(xr.stdout))
        self.assertEqual(
            en_br, [],
            "en16931 must stay core-only for a garbage-declared doc; got %r"
            % en_br)
        self.assertTrue(
            xr_br,
            "xrechnung must still apply the BR-DE layer for a garbage-declared "
            "doc; got none")
        # Determinism: re-running the exact invocation reproduces the report.
        en2 = run_validate(p, "en16931")
        self.assertEqual(en.stdout, en2.stdout)
        self.assertEqual(en.returncode, en2.returncode)

    # ---- the sharp pin: behaviour is invariant to the declared id --------

    def test_profile_token_governs_declared_id_is_informational(self):
        """Cross-variant invariance — the crux of the contract. For a FIXED
        --profile, the CLI's observable outcome (exit code + full rule-id
        multiset) is IDENTICAL across the core / XRechnung-CIUS / garbage
        declared-id variants. Nothing about the declared id changes the applied
        scope; the --profile token alone does."""
        for profile in ("en16931", "xrechnung"):
            outcomes = {}
            for name in DECLARED_ID_VARIANTS:
                proc = run_validate(self.paths[name], profile)
                self.assert_clean_documented_run(
                    proc, "%s-under-%s" % (name, profile))
                outcomes[name] = (proc.returncode,
                                  tuple(sorted(_rule_ids(proc.stdout))))
            distinct = set(outcomes.values())
            self.assertEqual(
                len(distinct), 1,
                "under --profile=%s the outcome MUST NOT depend on the declared "
                "id, but variants diverged: %r" % (profile, outcomes))

    def test_en16931_is_a_subset_scope_of_xrechnung(self):
        """The core (non-BR-DE) findings are identical under both profiles for
        the same document; xrechnung only ADDS the BR-DE layer on top. This pins
        that --profile=xrechnung is 'core + CIUS' and en16931 is 'core', never a
        different core, regardless of what the document declares."""
        for name in DECLARED_ID_VARIANTS:
            en = run_validate(self.paths[name], "en16931")
            xr = run_validate(self.paths[name], "xrechnung")
            en_core, en_br = _split_ids(_rule_ids(en.stdout))
            xr_core, _xr_br = _split_ids(_rule_ids(xr.stdout))
            self.assertEqual(
                en_core, xr_core,
                "%s: the core rule set must be identical under both profiles"
                % name)
            self.assertEqual(
                en_br, [],
                "%s: en16931 must never emit a BR-DE finding" % name)


class DeclaredCiiIdBoundary(_CliContractMixin, unittest.TestCase):
    """The CII ``ram:ID`` declared-id form. Pins the MEASURED behaviour of the
    raw-XML CLI ``validate`` path: it dispatches on the XML root and reaches only
    the UBL engine, so a raw CrossIndustryInvoice deterministically trips the
    structural S-ROOT fatal — identically under BOTH profiles, with no
    traceback. The declared XRechnung ``ram:ID`` never silently switches on the
    CIUS scope; the raw-CII path rejects the same way regardless of the declared
    id or the --profile token. (The engine's CII rule path is reached via the
    Factur-X/ZUGFeRD PDF container or the internal API — see
    ``test_golden_snapshot`` / ``test_rules_cii`` — not this raw-XML entry.)"""

    def test_declared_xrechnung_cii_is_deterministic_across_profiles(self):
        self.assertTrue(os.path.isfile(CII_XRECHNUNG_DECLARED),
                        CII_XRECHNUNG_DECLARED)
        # Sanity: the fixture really declares the XRechnung guideline urn.
        with open(CII_XRECHNUNG_DECLARED, encoding="utf-8") as fh:
            body = fh.read()
        self.assertIn("GuidelineSpecifiedDocumentContextParameter", body)
        self.assertIn("xoev-de:kosit:standard:xrechnung", body)

        en = run_validate(CII_XRECHNUNG_DECLARED, "en16931")
        xr = run_validate(CII_XRECHNUNG_DECLARED, "xrechnung")
        self.assert_clean_documented_run(en, "cii-xrechnung-declared-en16931")
        self.assert_clean_documented_run(xr, "cii-xrechnung-declared-xrechnung")

        # Same declared id, both profiles -> identical outcome (no wrong scope
        # applied off the declared ram:ID).
        self.assertEqual(en.returncode, xr.returncode,
                         "raw-CII outcome must not depend on --profile here")
        self.assertEqual(sorted(_rule_ids(en.stdout)),
                         sorted(_rule_ids(xr.stdout)),
                         "raw-CII rule ids must not depend on --profile here")
        # And no BR-DE CIUS layer was silently switched on off the declared id.
        _core, br_de = _split_ids(_rule_ids(en.stdout))
        self.assertEqual(br_de, [],
                         "declared CII ram:ID must not switch on BR-DE: %r"
                         % br_de)


class HonestContractDriftGuard(unittest.TestCase):
    """Pin the human-readable coverage contract so the prose and the measured,
    pinned behaviour above cannot silently diverge. Guards BOTH the shipped
    COVERAGE.md (rendered, contiguous prose) and its generator source
    (einvoice/coverage.py) so a regeneration cannot quietly drop the statement."""

    def test_coverage_md_states_profile_is_authoritative(self):
        with open(COVERAGE_MD, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("declared profile token is used", text)
        self.assertIn("same rule set regardless of the declared profile", text)

    def test_coverage_generator_source_carries_the_wording(self):
        with open(COVERAGE_PY, encoding="utf-8") as fh:
            src = fh.read()
        # These fragments each appear contiguously within single string literals
        # of the generator, so the rendered doc cannot be regenerated without
        # them present.
        self.assertIn("declared profile token is used", src)
        self.assertIn("the same rule set", src)
        self.assertIn("regardless of the declared profile", src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
