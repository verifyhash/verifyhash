#!/usr/bin/env python3
"""test_cli_api_acceptance_parity.py — pin CLI-vs-API ACCEPTANCE parity from the
installed wheel image (T-VHCII3.4).

WHY THIS EXISTS
---------------
The CII false-FATAL fixed by EPIC-VHCII3 was possible only because the public
API and the two CLI entry points were free to disagree about which document
roots they will GRADE. Until 0.2.7 the raw-XML CLI answered a perfectly valid
XRechnung-CII invoice with the structural ``S-ROOT`` fatal ("Root element must
be Invoice in the UBL Invoice-2 namespace, or CreditNote in the UBL CreditNote-2
namespace.") while the container / report path graded the identical bytes and
returned a real conformance verdict. Every existing test asserted things about
one surface at a time; nothing asserted that the surfaces AGREE about
acceptance, so the divergence was invisible until a user hit it.

``einvoice/validate.py`` has since funnelled every CII-grading surface through
one seam (``validate.cii_violations``), and its docstring says so. This test is
the gate under that claim: it closes the CLASS of defect, not the instance, on
the format the product's bet rests on.

THE CONTRACT PINNED HERE
------------------------
For every document root in the set below, all three shipped surfaces must reach
the same VERDICT CLASS:

    graded              the engine ran business rules and produced a
                        conformance verdict (valid or invalid — either is a
                        verdict)
    refused:<marker>    the engine declined to grade the document at all

The directional statement of the same contract, asserted separately below
because it is the one that actually cost money: a root that
``einvoice.validate_bytes()`` GRADES must NEVER be structurally REFUSED by
``einvoice validate`` or by ``python3 -m einvoice.report``.

The refusal markers are not guessed. ``einvoice/validate.py`` emits
``Violation("S-ROOT", S_ROOT_MESSAGE, ...)`` for a root that is neither a UBL
``Invoice``/``CreditNote`` nor a ``CrossIndustryInvoice`` (see
:data:`STRUCTURAL_REFUSAL_RULES`), and ``einvoice.report._error_report``
projects a non-gradeable input into an envelope carrying an ``error`` key
(measured values: ``not-well-formed``, ``unsupported-container``). A rename of
either marker would make every document look "graded" to this test, so the
NON-VACUITY block below requires at least one fixture to land in each class and
independently greps the marker literal out of the wheel image's own
``validate.py``.

EXIT CODES ARE **NOT** THE CONTRACT
-----------------------------------
An exit-code-equality test would have been vacuous here, and this file proves
that by measurement rather than asserting it: at ``--profile xrechnung``
``fixtures/creditnote-valid_cii.xml`` is GRADED and invalid (BR-DE-2, BR-DE-15,
BR-DE-21, BR-DE-TMP-32 -> exit 1) while ``fixtures/wrong-root-order_ubl.xml`` is
structurally REFUSED (S-ROOT -> exit 1). Same exit code, opposite acceptance
outcome — an exit-code test cannot tell them apart and would not have caught the
original defect. ``validate_bytes()`` has no exit code at all, so for the API
leg the notion is not even definable. Exit codes are RECORDED and printed here
as diagnostics; the assertions are all on the class.

DOCUMENTS COVERED (all pre-existing committed fixtures — no new corpus file)
---------------------------------------------------------------------------
  clean UBL Invoice        fixtures/synth-ubl-good-fullshape_ubl.xml
  UBL CreditNote           fixtures/creditnote-invalid-typecode_ubl.xml
  raw CII invoice          fixtures/sb-pass-clean_cii.xml
  raw CII credit note      fixtures/creditnote-valid_cii.xml
  raw CII, rule-invalid    fixtures/creditnote-invalid_cii.xml
  unsupported root         fixtures/wrong-root-order_ubl.xml  (a UBL *Order*)
  not XML at all           fixtures/wrong-file-type.json      (a JSON export)

each at BOTH profiles (``en16931`` and ``xrechnung``) — 14 document/profile
cells, 3 surfaces each.

MEASURED FROM THE WHEEL, NOT THE SOURCE TREE
--------------------------------------------
The import root is ``test_wheel_self_report.build_install_image()`` — the same
reconstruction of the ``[tool.setuptools] packages`` + ``package-data``
declarations the other wheel tests use, imported here and never re-implemented
— and every subprocess runs with ``cwd`` in a temp directory OUTSIDE the
checkout, so no surface can quietly resolve a source-tree artifact. The
``einvoice`` console script is not on PATH in a bare checkout, so the validate
surface is driven as ``python3 -m einvoice validate``; that is the same target
module ``[project.scripts]`` maps the console script to, and this test ASSERTS
that mapping rather than assuming it.

HONEST LIMITS
-------------
  * Seven documents, not the 24 MB corpus. This is an ACCEPTANCE guard (does
    the engine agree to grade this root?), not a conformance sweep —
    ``conformance.py`` and ``test_testsuite_conformance.py`` do that job. A root
    shape none of these seven exhibits is not covered.
  * It compares the surfaces to EACH OTHER, plus the directional API->CLI
    statement. Neither side is treated as ground truth: if all three drifted the
    same way in one commit (e.g. all three started refusing CII), parity stays
    green and the CII acceptance tests (``test_cii_*.py``,
    ``test_golden_snapshot.py``) are what fail.
  * Class granularity is deliberate. Two surfaces that both GRADE a document
    but disagree about the violation LIST would pass here;
    ``test_json_surface_parity.py`` is the gate for payload-level agreement.

Stdlib only, offline, no network, no build backend, plain python3 (no pytest):
exits 1 on failure printing every problem found. ~29 short subprocesses, a few
seconds.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile

from test_doc_commands_from_wheel import console_scripts
from test_wheel_self_report import build_install_image

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")

PROFILES = ("en16931", "xrechnung")

API_SURFACE = "einvoice.validate_bytes()"
VALIDATE_SURFACE = "einvoice validate --json"
REPORT_SURFACE = "python3 -m einvoice.report --format json"
SURFACES = ("api", "validate", "report")
SURFACE_LABEL = {"api": API_SURFACE, "validate": VALIDATE_SURFACE,
                 "report": REPORT_SURFACE}

#: Rule ids that mean "the engine declined to grade this document", read off
#: ``einvoice/validate.py`` (``Violation("S-ROOT", S_ROOT_MESSAGE, ...)`` in
#: ``validate_root``) rather than guessed. A document carrying one of these has
#: NOT been graded: ``validate_root`` returns immediately, before any business
#: rule runs.
STRUCTURAL_REFUSAL_RULES = frozenset({"S-ROOT"})

#: The class label for a graded document (a real conformance verdict was
#: produced — ``valid=True`` and ``valid=False`` are both verdicts).
GRADED = "graded"


# ---------------------------------------------------------------------------
# The documents. Only pre-existing committed fixtures — adding a corpus fixture
# is a standing reject, and none is needed: the corpus already contains every
# root shape this contract is about.
# ---------------------------------------------------------------------------
DOCUMENTS = (
    # (label, fixture filename, what root shape it contributes)
    ("ubl-invoice", "synth-ubl-good-fullshape_ubl.xml",
     "UBL Invoice, XRechnung 3.0 CIUS, clean"),
    ("ubl-creditnote", "creditnote-invalid-typecode_ubl.xml",
     "UBL CreditNote (rule-invalid: BR-CL-01)"),
    ("cii-invoice", "sb-pass-clean_cii.xml",
     "raw UN/CEFACT CrossIndustryInvoice"),
    ("cii-creditnote", "creditnote-valid_cii.xml",
     "raw CII credit note (the shape the false-FATAL hit)"),
    ("cii-invalid", "creditnote-invalid_cii.xml",
     "raw CII, rule-invalid (BR-05) — graded, not refused"),
    ("unsupported-root", "wrong-root-order_ubl.xml",
     "a well-formed UBL *Order* — genuinely unsupported root"),
    ("not-xml", "wrong-file-type.json",
     "a JSON export — not an XML invoice at all"),
)

#: Documents whose class MUST be a refusal (they are the non-vacuity anchors);
#: everything else must be graded at both profiles.
EXPECTED_REFUSALS = {"unsupported-root", "not-xml"}


# ---------------------------------------------------------------------------
# ALLOWLIST — the ONLY acceptance divergences the three surfaces are allowed to
# have. Following the convention of ``test_json_surface_parity.py``: every entry
# carries a ``scope``, the exact measured disagreement, and ONE LINE of reason.
# Anything measured and not listed here FAILS, naming the fixture and both
# verdicts; anything listed here that is no longer measured ALSO fails (a stale
# allowlist is as bad as a missing one).
#
#   scope "class"       a (fixture, profile) cell where the surfaces genuinely
#                       reach different verdict CLASSES. Requires "fixture",
#                       "profile" and "surfaces" ({surface: measured class} for
#                       ALL THREE surfaces — a declaration has to be exact, so
#                       it cannot silently absorb a different disagreement).
#   scope "invocation"  a behavioural asymmetry of the entry points that is NOT
#                       a class divergence, checked by its own measurement.
#
# STATE AS MEASURED 2026-07-25 (0.2.7): there are ZERO class-scope entries. All
# 14 document/profile cells x 3 surfaces agree exactly. That emptiness is the
# result, not an oversight — and it is asserted below (``NO_CLASS_DIVERGENCE``),
# so a future divergence cannot be made to disappear by deleting a line.
# ---------------------------------------------------------------------------
DECLARED_DIVERGENCES = (
    {
        "scope": "invocation",
        "key": "default-profile",
        "reason": "deliberate, pinned by test_xrechnung.py::"
                  "test_cli_default_profile_unchanged: with no flag `validate` "
                  "runs en16931 while `report` and validate_bytes() default to "
                  "xrechnung, so every cell below passes an EXPLICIT profile to "
                  "all three surfaces",
    },
)

#: Asserted below: today, no class-scope divergence exists. Flipping this to
#: True is a deliberate admission that the surfaces disagree about acceptance,
#: and it requires a class-scope entry above with a real reason.
NO_CLASS_DIVERGENCE = True

DEFAULT_PROFILE_VALIDATE = "en16931"
DEFAULT_PROFILE_REPORT = "xrechnung"


def class_divergence_entries(declared=None):
    """The class-scope allowlist entries, keyed by ``(fixture, profile)``."""
    if declared is None:
        declared = DECLARED_DIVERGENCES
    out = {}
    for entry in declared:
        if entry.get("scope") != "class":
            continue
        out[(entry["fixture"], entry["profile"])] = entry
    return out


# ---------------------------------------------------------------------------
# classification (pure)
# ---------------------------------------------------------------------------
def verdict_class(payload):
    """Reduce one surface's JSON payload to its VERDICT CLASS.

    ``"graded"`` when the engine produced a conformance verdict;
    ``"refused:<marker>"`` when it declined to grade the document, where the
    marker is either the ``error`` code of the envelope
    (``not-well-formed`` / ``unsupported-container``) or the structural
    refusal rule id(s) the engine emitted (``S-ROOT``).

    Note what is deliberately NOT consulted: the exit code (see the module
    docstring — a graded-but-invalid document and a structurally refused one
    both exit 1) and the ``valid`` flag (a graded document is frequently
    invalid; that is a verdict, not a refusal).
    """
    if not isinstance(payload, dict):
        return "unparseable"
    if payload.get("__exception__"):
        return "exception:%s" % payload["__exception__"]
    error = payload.get("error")
    if error:
        return "refused:%s" % error
    rules = [v.get("rule") for v in payload.get("violations", []) or []]
    structural = sorted({r for r in rules if r in STRUCTURAL_REFUSAL_RULES})
    if structural:
        return "refused:%s" % ",".join(structural)
    return GRADED


def is_refusal(cls):
    return cls != GRADED


def compare_cell(fixture, profile, classes, declared=None):
    """Return a list of problem strings for one (fixture, profile) cell.

    ``classes`` is ``{surface: class}`` for all three surfaces. Every problem
    string NAMES the fixture and BOTH verdicts, so a failure is actionable
    without re-running anything.
    """
    problems = []
    distinct = sorted(set(classes.values()))
    if len(distinct) == 1:
        return problems

    entry = class_divergence_entries(declared).get((fixture, profile))
    if entry is not None and entry.get("surfaces") == classes:
        return problems          # declared, exactly as measured

    # Report every disagreeing PAIR, naming the fixture and both verdicts.
    for i, a in enumerate(SURFACES):
        for b in SURFACES[i + 1:]:
            if classes[a] == classes[b]:
                continue
            problems.append(
                "%s @ --profile %s: `%s` says %s but `%s` says %s "
                "(undeclared acceptance divergence)"
                % (fixture, profile, SURFACE_LABEL[a], classes[a],
                   SURFACE_LABEL[b], classes[b]))
    if entry is not None:
        problems.append(
            "%s @ --profile %s: an allowlist entry exists but does not match "
            "what was measured (declared %r, measured %r)"
            % (fixture, profile, entry.get("surfaces"), classes))
    return problems


def directional_problems(fixture, profile, classes):
    """The statement that actually cost money: a root the API GRADES must never
    be structurally REFUSED by either CLI entry point."""
    problems = []
    if is_refusal(classes["api"]):
        return problems
    for side in ("validate", "report"):
        if is_refusal(classes[side]):
            problems.append(
                "%s @ --profile %s: %s GRADED the document but `%s` REFUSED it "
                "(%s) — this is the CII false-FATAL shape"
                % (fixture, profile, API_SURFACE, SURFACE_LABEL[side],
                   classes[side]))
    return problems


# ---------------------------------------------------------------------------
# negative self-test: prove the checker is not `pass` in a trench coat
# ---------------------------------------------------------------------------
def _graded_payload(invalid=False):
    """A payload shaped like a real graded one (measured 2026-07-25)."""
    violations = []
    if invalid:
        violations = [{"rule": "BR-DE-15", "severity": "fatal",
                       "message": "The element 'Buyer reference' (BT-10) must "
                                  "be transmitted.",
                       "element": "cbc:BuyerReference"}]
    return {"source": "doc.xml", "valid": not invalid,
            "violation_count": len(violations), "violations": violations}


def _sroot_payload():
    return {"source": "doc.xml", "valid": False, "violation_count": 1,
            "violations": [{"rule": "S-ROOT", "severity": "fatal",
                            "message": "Root element must be Invoice in the "
                                       "UBL Invoice-2 namespace, or CreditNote "
                                       "in the UBL CreditNote-2 namespace.",
                            "element": "Order"}]}


def _error_payload(code="not-well-formed"):
    return {"source": "doc.json", "valid": False, "error": code,
            "violation_count": 0, "violations": []}


def run_negative_self_test():
    """Drive the pure checker with synthetic payloads and require it to catch
    every injected divergence BY NAME. Returns ``(failures, checks_run)``."""
    failures = []
    checks = 0

    def expect(cond, name, detail=""):
        print("  [%s] %s%s" % ("ok" if cond else "FAIL", name,
                               ("" if cond else " — " + detail)))
        if not cond:
            failures.append(name)

    def check(cond, name, detail=""):
        nonlocal checks
        checks += 1
        expect(cond, name, detail)

    # --- the classifier itself ---------------------------------------------
    check(verdict_class(_graded_payload()) == GRADED,
          "a clean payload classifies as graded",
          repr(verdict_class(_graded_payload())))
    check(verdict_class(_graded_payload(invalid=True)) == GRADED,
          "a GRADED-BUT-INVALID payload is still `graded`, not a refusal",
          repr(verdict_class(_graded_payload(invalid=True))))
    check(verdict_class(_sroot_payload()) == "refused:S-ROOT",
          "an S-ROOT payload classifies as refused:S-ROOT",
          repr(verdict_class(_sroot_payload())))
    check(verdict_class(_error_payload()) == "refused:not-well-formed",
          "an error envelope classifies as a refusal",
          repr(verdict_class(_error_payload())))
    check(verdict_class({"__exception__": "ValueError: boom"})
          == "exception:ValueError: boom",
          "an API exception is its own class, not silently `graded`")
    # The whole point: the two classes must be DISTINGUISHABLE even when the
    # exit code is identical, which is exactly the vacuity the spec calls out.
    check(verdict_class(_graded_payload(invalid=True))
          != verdict_class(_sroot_payload()),
          "graded-invalid and structurally-refused are DIFFERENT classes "
          "(an exit-code test conflates them)")

    # --- agreement is clean -------------------------------------------------
    agree = {s: GRADED for s in SURFACES}
    check(compare_cell("f.xml", "en16931", agree) == [],
          "three agreeing surfaces -> zero problems",
          repr(compare_cell("f.xml", "en16931", agree)))
    check(directional_problems("f.xml", "en16931", agree) == [],
          "three agreeing surfaces -> zero directional problems")

    # --- the CII false-FATAL shape, injected -------------------------------
    false_fatal = {"api": GRADED, "validate": "refused:S-ROOT",
                   "report": GRADED}
    probs = compare_cell("cii.xml", "xrechnung", false_fatal)
    check(len(probs) == 2,
          "the injected false-FATAL yields exactly the 2 disagreeing pairs",
          repr(probs))
    check(all("cii.xml" in p for p in probs),
          "every problem NAMES the fixture", repr(probs))
    check(all(GRADED in p and "refused:S-ROOT" in p for p in probs),
          "every problem NAMES BOTH verdicts", repr(probs))
    dprobs = directional_problems("cii.xml", "xrechnung", false_fatal)
    check(len(dprobs) == 1 and "false-FATAL" in dprobs[0]
          and "cii.xml" in dprobs[0],
          "the directional API-graded/CLI-refused check fires by name",
          repr(dprobs))

    # The reverse direction (CLI grades, API refuses) is a class divergence but
    # NOT the directional violation — the two checks must stay independent.
    reverse = {"api": "refused:S-ROOT", "validate": GRADED, "report": GRADED}
    check(compare_cell("cii.xml", "xrechnung", reverse) != [],
          "a CLI-grades/API-refuses split is still a class divergence")
    check(directional_problems("cii.xml", "xrechnung", reverse) == [],
          "...but is NOT reported as the directional API->CLI violation")

    # --- the allowlist mechanism is real, and is not a blanket mute ---------
    synthetic = ({"scope": "class", "fixture": "cii.xml", "profile": "xrechnung",
                  "surfaces": dict(false_fatal),
                  "reason": "self-test only — never shipped"},)
    check(compare_cell("cii.xml", "xrechnung", false_fatal, synthetic) == [],
          "an EXACT allowlist entry absorbs the declared divergence",
          repr(compare_cell("cii.xml", "xrechnung", false_fatal, synthetic)))
    other = {"api": GRADED, "validate": GRADED,
             "report": "refused:not-well-formed"}
    probs = compare_cell("cii.xml", "xrechnung", other, synthetic)
    check(probs != [],
          "the same entry does NOT absorb a DIFFERENT divergence on that cell",
          repr(probs))
    check(any("does not match what was measured" in p for p in probs),
          "a near-miss allowlist entry is called out explicitly", repr(probs))
    check(compare_cell("other.xml", "xrechnung", false_fatal, synthetic) != [],
          "the entry does not leak onto a different fixture")
    check(compare_cell("cii.xml", "en16931", false_fatal, synthetic) != [],
          "the entry does not leak onto a different profile")

    # --- every shipped entry carries a reason ------------------------------
    check(all(str(e.get("reason", "")).strip() for e in DECLARED_DIVERGENCES),
          "every shipped allowlist entry carries a one-line reason")
    check(all(e.get("scope") in ("class", "invocation")
              for e in DECLARED_DIVERGENCES),
          "every shipped allowlist entry has a known scope")

    return failures, checks


# ---------------------------------------------------------------------------
# the real measurement
# ---------------------------------------------------------------------------
#: Run the PUBLIC API over every (document, profile) job in ONE subprocess: same
#: bytes off disk as the CLI legs read, no exit code involved.
API_PROBE = r"""
import json, sys
import einvoice
jobs = json.load(open(sys.argv[1], encoding="utf-8"))
out = {}
for name, profile in jobs:
    with open(name, "rb") as fh:
        data = fh.read()
    try:
        payload = einvoice.validate_bytes(data, name, profile)
    except BaseException as exc:
        payload = {"__exception__": "%s: %s" % (type(exc).__name__, exc)}
    out[name + "@" + profile] = payload
json.dump(out, sys.stdout)
"""


class Runner(object):
    def __init__(self, image, workdir):
        self.image = image
        self.workdir = workdir
        self.env = dict(os.environ)
        self.env["PYTHONPATH"] = image
        self.env.pop("PYTHONSTARTUP", None)

    def _run(self, args):
        return subprocess.run(
            [sys.executable] + args,
            cwd=self.workdir, env=self.env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            timeout=120,
        )

    def api_all(self, jobs):
        """``{"name@profile": payload}`` for every job, one subprocess."""
        manifest = os.path.join(self.workdir, "_jobs.json")
        with open(manifest, "w", encoding="utf-8") as fh:
            json.dump(jobs, fh)
        proc = self._run(["-c", API_PROBE, manifest])
        if proc.returncode != 0:
            raise SystemExit("FAIL: the %s probe crashed (exit %d)\n%s"
                             % (API_SURFACE, proc.returncode, proc.stderr))
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise SystemExit("FAIL: the %s probe emitted no JSON (%s)\n%s"
                             % (API_SURFACE, exc, proc.stdout[:400]))

    def validate_json(self, name, profile):
        proc = self._run(["-m", "einvoice", "validate", "--json",
                          "--profile", profile, name])
        return self._parse(proc, "%s %s" % (VALIDATE_SURFACE, name))

    def report_json(self, name, profile):
        proc = self._run(["-m", "einvoice.report", "--format", "json",
                          "--profile", profile, name])
        return self._parse(proc, "%s %s" % (REPORT_SURFACE, name))

    @staticmethod
    def _parse(proc, what):
        """``(exit_code, payload_or_None, problem_or_None)``.

        Exit code 0/1 = a verdict, 3 = an input the engine would not grade; any
        other code, or non-JSON on stdout, is itself a problem (recorded, not
        swallowed) and classifies as ``unparseable``.
        """
        if proc.returncode not in (0, 1, 3):
            return proc.returncode, None, (
                "%s exited %d (not a validate outcome)\n%s"
                % (what, proc.returncode, proc.stderr.strip()[:400]))
        try:
            return proc.returncode, json.loads(proc.stdout), None
        except json.JSONDecodeError as exc:
            return proc.returncode, None, (
                "%s did not emit JSON (%s): %s"
                % (what, exc, proc.stdout[:300]))


def stage_documents(workdir):
    """Copy the committed fixtures into ``workdir``. Returns ``[(label, name)]``."""
    staged = []
    for label, name, _note in DOCUMENTS:
        src = os.path.join(FIXTURES, name)
        if not os.path.isfile(src):
            raise SystemExit("FAIL: committed fixture is missing: %s" % src)
        shutil.copy2(src, os.path.join(workdir, name))
        staged.append((label, name))
    return staged


def main():
    print("NEGATIVE SELF-TEST (the checker must catch an injected divergence)")
    failures, checks = run_negative_self_test()
    print("  %d self-check(s) run" % checks)

    scripts = console_scripts()
    if scripts.get("einvoice") != "einvoice.cli":
        failures.append(
            "[project.scripts] einvoice no longer maps to einvoice.cli (%r) — "
            "`python3 -m einvoice` is no longer the console script's code path"
            % (scripts.get("einvoice"),))

    problems = []
    tmp = tempfile.mkdtemp(prefix="einvoice-acceptance-")
    try:
        image = build_install_image(os.path.join(tmp, "image"))
        workdir = os.path.join(tmp, "work")
        os.makedirs(workdir)
        if os.path.abspath(workdir).startswith(HERE + os.sep):
            raise SystemExit("FAIL: work directory is inside the checkout")
        if not os.path.exists(os.path.join(image, "einvoice", "cli.py")):
            raise SystemExit("FAIL: wheel image looks empty (no einvoice/cli.py)")
        for absent in ("examples", "corpus", "fixtures", "einvoice.py"):
            if os.path.exists(os.path.join(image, absent)):
                raise SystemExit("FAIL: wheel image unexpectedly contains %r — "
                                 "it would not be a wheel-only measurement"
                                 % absent)

        # The refusal marker must still exist in the artifact under test; if it
        # were renamed, every document would look "graded" and this whole file
        # would go quietly vacuous.
        with open(os.path.join(image, "einvoice", "validate.py"),
                  encoding="utf-8") as fh:
            validate_src = fh.read()
        for rule in sorted(STRUCTURAL_REFUSAL_RULES):
            if '"%s"' % rule not in validate_src:
                problems.append(
                    "the structural refusal marker %r no longer appears in the "
                    "wheel's einvoice/validate.py — STRUCTURAL_REFUSAL_RULES is "
                    "stale and every document would classify as `graded`" % rule)

        staged = stage_documents(workdir)
        runner = Runner(image, workdir)
        jobs = [[name, profile] for _label, name in staged
                for profile in PROFILES]
        api = runner.api_all(jobs)

        print("\nACCEPTANCE PARITY (wheel image, cwd %s, %d cell(s))"
              % (os.path.basename(workdir), len(jobs)))
        print("  %-17s %-9s %-26s %-26s %-26s"
              % ("document", "profile", API_SURFACE, "validate --json",
                 "report --format json"))
        cells = {}
        for label, name in staged:
            for profile in PROFILES:
                key = "%s@%s" % (name, profile)
                if key not in api:
                    problems.append("the %s probe returned nothing for %s"
                                    % (API_SURFACE, key))
                    continue
                vrc, vpayload, vprob = runner.validate_json(name, profile)
                rrc, rpayload, rprob = runner.report_json(name, profile)
                for prob in (vprob, rprob):
                    if prob:
                        problems.append(prob)
                classes = {
                    "api": verdict_class(api[key]),
                    "validate": verdict_class(vpayload),
                    "report": verdict_class(rpayload),
                }
                cells[(label, profile)] = classes
                found = compare_cell(name, profile, classes)
                found += directional_problems(name, profile, classes)
                problems.extend(found)
                print("  [%s] %-13s %-9s %-26s %-26s %-26s (exit -/%d/%d)"
                      % ("ok" if not found else "FAIL", label, profile,
                         classes["api"], classes["validate"], classes["report"],
                         vrc, rrc))

        # ---- NON-VACUITY: both classes must actually be represented, on all
        # three surfaces, or the parity above proves nothing.
        print("\nNON-VACUITY")
        observed = [c for classes in cells.values() for c in classes.values()]
        n_graded = sum(1 for c in observed if c == GRADED)
        n_refused = sum(1 for c in observed if is_refusal(c))
        print("  %d graded reading(s), %d refusal reading(s) over %d cell(s)"
              % (n_graded, n_refused, len(cells)))
        if n_graded < 3:
            problems.append(
                "no document was GRADED by all three surfaces — the parity "
                "check is vacuous")
        if n_refused < 3:
            problems.append(
                "no document was REFUSED by all three surfaces — the refusal "
                "class is never exercised, so parity proves nothing")
        for label in sorted(EXPECTED_REFUSALS):
            for profile in PROFILES:
                classes = cells.get((label, profile), {})
                if not all(is_refusal(c) for c in classes.values()):
                    problems.append(
                        "%s @ %s must be refused by every surface (an "
                        "unsupported root); got %r" % (label, profile, classes))
        for label, _name, _note in DOCUMENTS:
            if label in EXPECTED_REFUSALS:
                continue
            for profile in PROFILES:
                classes = cells.get((label, profile), {})
                if not all(c == GRADED for c in classes.values()):
                    problems.append(
                        "%s @ %s must be GRADED by every surface (it is a "
                        "supported root); got %r" % (label, profile, classes))
        if not any(is_refusal(c) and c.startswith("refused:S-ROOT")
                   for c in observed):
            problems.append(
                "the S-ROOT structural refusal was never observed — "
                "wrong-root-order_ubl.xml no longer exercises it")

        # ---- EXIT CODES ARE NOT THE CONTRACT, measured ----------------------
        # Two documents with the SAME exit code and OPPOSITE acceptance
        # outcomes: proof that the exit-code test this one replaces would be
        # vacuous. Measured, not asserted in prose.
        print("\nWHY NOT EXIT CODES (measured)")
        graded_invalid = "creditnote-valid_cii.xml"      # graded, invalid @ DE
        refused = "wrong-root-order_ubl.xml"             # structurally refused
        g_rc, g_payload, _ = runner.validate_json(graded_invalid, "xrechnung")
        r_rc, r_payload, _ = runner.validate_json(refused, "xrechnung")
        g_cls, r_cls = verdict_class(g_payload), verdict_class(r_payload)
        print("  %-32s exit %d  class %s  (%d violation(s))"
              % (graded_invalid, g_rc, g_cls,
                 len((g_payload or {}).get("violations", []))))
        print("  %-32s exit %d  class %s"
              % (refused, r_rc, r_cls))
        if not (g_rc == r_rc == 1):
            problems.append(
                "the exit-code vacuity demonstration no longer reproduces: "
                "expected BOTH %s and %s to exit 1, got %d and %d"
                % (graded_invalid, refused, g_rc, r_rc))
        elif not (g_cls == GRADED and r_cls.startswith("refused:")):
            problems.append(
                "the exit-code vacuity demonstration no longer reproduces: "
                "%s is %s and %s is %s — they must be graded vs refused"
                % (graded_invalid, g_cls, refused, r_cls))
        else:
            print("  [ok] same exit code (1), opposite acceptance outcome — an "
                  "exit-code-equality test cannot tell these apart")

        # ---- the allowlist must not rot -------------------------------------
        print("\nALLOWLIST (%d declared entr(ies), %d class-scope)"
              % (len(DECLARED_DIVERGENCES), len(class_divergence_entries())))
        measured_divergent = {
            (label, profile) for (label, profile), classes in cells.items()
            if len(set(classes.values())) > 1}
        for (fixture, profile), entry in sorted(class_divergence_entries().items()):
            label = next((l for l, n, _ in DOCUMENTS if n == fixture), fixture)
            hit = (label, profile) in measured_divergent
            print("  [%s] class  %s @ %s" % ("ok" if hit else "FAIL",
                                             fixture, profile))
            if not hit:
                problems.append(
                    "declared class divergence for %s @ %s was NOT observed — "
                    "the surfaces converged; drop the allowlist entry"
                    % (fixture, profile))
        if NO_CLASS_DIVERGENCE and measured_divergent:
            problems.append(
                "NO_CLASS_DIVERGENCE is True but %d cell(s) diverged: %r"
                % (len(measured_divergent), sorted(measured_divergent)))
        if NO_CLASS_DIVERGENCE and class_divergence_entries():
            problems.append(
                "NO_CLASS_DIVERGENCE is True but class-scope allowlist entries "
                "exist — the two statements contradict each other")
        if NO_CLASS_DIVERGENCE:
            print("  [ok] zero class-scope entries and zero measured "
                  "divergences — the surfaces agree everywhere")

        # ---- the declared invocation asymmetry, measured --------------------
        # The one real asymmetry: with NO --profile flag the entry points do not
        # even run the same rule set. Every cell above therefore passes an
        # explicit profile; this block proves that precaution is still needed.
        print("\nDECLARED INVOCATION ASYMMETRY (no --profile flag)")
        de_only = "creditnote-valid_cii.xml"   # valid @ en16931, invalid @ DE
        v_rc, v_payload, _ = Runner._parse(
            runner._run(["-m", "einvoice", "validate", "--json", de_only]),
            "validate (no flag)")
        r2_rc, r2_payload, _ = Runner._parse(
            runner._run(["-m", "einvoice.report", "--format", "json", de_only]),
            "report (no flag)")
        got_profile = (r2_payload or {}).get("profile")
        print("  validate (no flag): exit %d, valid=%s, class %s"
              % (v_rc, (v_payload or {}).get("valid"), verdict_class(v_payload)))
        print("  report   (no flag): exit %d, valid=%s, class %s, profile=%r"
              % (r2_rc, (r2_payload or {}).get("valid"),
                 verdict_class(r2_payload), got_profile))
        if got_profile != DEFAULT_PROFILE_REPORT:
            problems.append(
                "report's default profile is %r, not the declared %r"
                % (got_profile, DEFAULT_PROFILE_REPORT))
        if not ((v_payload or {}).get("valid") is True
                and (r2_payload or {}).get("valid") is False):
            problems.append(
                "the declared default-profile asymmetry no longer reproduces: "
                "%s must be valid under validate's default (%s) and invalid "
                "under report's default (%s); got validate.valid=%r "
                "report.valid=%r" % (de_only, DEFAULT_PROFILE_VALIDATE,
                                     DEFAULT_PROFILE_REPORT,
                                     (v_payload or {}).get("valid"),
                                     (r2_payload or {}).get("valid")))
        elif verdict_class(v_payload) != verdict_class(r2_payload):
            problems.append(
                "the default-flag asymmetry has become an ACCEPTANCE "
                "divergence: %s is %s to validate but %s to report"
                % (de_only, verdict_class(v_payload),
                   verdict_class(r2_payload)))
        else:
            print("  [ok] different rule sets, SAME acceptance class — the "
                  "asymmetry is a profile default, not a refusal")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("")
    total = len(failures) + len(problems)
    if total:
        print("FAIL — %d problem(s): %d self-test, %d acceptance"
              % (total, len(failures), len(problems)))
        for msg in failures + problems:
            print("  %s" % msg)
        return 1
    print("PASS — the API and both CLI entry points agree on acceptance for "
          "every document, with %d declared divergence(s)"
          % len(DECLARED_DIVERGENCES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
