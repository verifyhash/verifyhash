#!/usr/bin/env python3
"""test_finding_set_parity.py — no surface may SILENTLY drop findings the
engine already computed (T-VHFULL.2).

THE CLASS THIS CLOSES
---------------------
Nothing in this suite compared WHICH findings one surface renders against
another. Every existing report test checks a surface against ITSELF (a golden
snapshot, a schema, a count), so ``--format json`` could carry twelve findings
and the human report one *forever* without a single test going red — and it did,
for 344 runs, on the most-read surface the product has (T-VHFULL.1). That was
the third instance of "the engine computes X and one surface drops it" in three
reviews (T-VHERG.4 dropped formats, T-VHUX2.2 dropped non-fatal findings,
T-VHFULL.1 dropped the whole finding set bar one), and each narrow per-instance
fix hid the class again.

So this test does not check a surface against a snapshot. It takes
``--format json`` as the REFERENCE finding set and asserts that every other
finding-listing surface renders the same SET OF RULE IDS — the ids actually
present in the rendered bytes, not a count. A surface that cannot carry the full
set must SAY SO, in one of exactly two commented declarations below:

  * :data:`FINDING_SET_SURFACES` — surfaces that must carry the finding set.
    A surface may narrow it in two DECLARED, MODELLED ways (never a blanket
    exemption): a ``severities`` filter (it carries only some severities, e.g.
    the receipt is fatal-only by construction) and ``capped`` (it truncates a
    long human listing — and then it MUST disclose the omission and the total
    in the CLI's existing wording).
  * :data:`FINDING_SET_OMISSION_ALLOWLIST` — surfaces that legitimately list no
    findings at all, each with a one-line reason.

Every name in ``einvoice.report.REPORT_FORMATS`` must appear in exactly one of
those two (or be the reference format itself) — :meth:`test_every_report_format_is_declared`
fails otherwise, so a NEWLY ADDED output format cannot silently omit findings:
its author has to make a deliberate, written decision.

An UNDECLARED omission fails. :meth:`test_detector_catches_an_undeclared_omission`
proves the detector is not vacuous by running the very same comparison against
``--format badge`` (a real single-verdict surface) *as if* it had been declared
full-set, and asserting the checker reports the missing ids.

MEASURED, NOT ASSUMED
---------------------
Nothing here hard-codes a rule id. The reference set is re-derived from
``--format json`` on each fixture at runtime; the expectations are functions of
that set. Two fixtures are used, because the interesting behaviours live on
opposite sides of the CLI's listing cap:

  * ``examples/01-missing-fields/broken.xml`` — the documented small case:
    3 findings (2 fatal + 1 information), comfortably under the cap, so every
    full-set surface must render ALL of them and the severity-filtered ones must
    render exactly their subset.
  * a minimal UBL invoice written inline below — 15 findings, which EXCEEDS
    ``einvoice.cli._NON_FATAL_LIST_CAP`` (10) and so exercises the capped human
    listing's disclosure.

HONEST LIMITS
-------------
  * The id universe is the packaged remediation catalog's 297 rule ids (plus the
    reference ids, belt and braces). That makes the comparison a real SET
    equality in both directions — a surface that invents an id it did not hit is
    caught too — but a finding whose rule id is outside that catalog would be
    invisible to the scan; :meth:`test_universe_covers_the_reference` fails if
    that ever becomes true of a reference id.
  * Presence is textual (a word-boundary search of the rendered bytes), not a
    parse of each format's structure. That is deliberate: it works uniformly
    across nine wildly different renderings, and "the id appears nowhere in the
    output" is exactly the defect class. It cannot tell "listed as a finding"
    from "mentioned in prose"; the surfaces here have no such prose.
  * ``validate-batch`` text named ZERO rule ids when this file was written, and
    sat in the allowlist with that measured reason. T-VHUX2.4 (2026-07-25) made
    it list them; the measured allowlist entry went red on the spot, exactly as
    designed, and the surface was PROMOTED into ``FINDING_SET_SURFACES`` below
    as a capped full-set surface. The mechanism is the point: an exemption here
    cannot outlive the defect it excused.

Runs against a WHEEL-ONLY install image (``test_wheel_self_report.build_install_image``
— reused, deliberately not reimplemented) with cwd outside the repository:
stdlib only, no pip, no build backend, no network, a few seconds.
"""

from __future__ import annotations

import collections
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from test_wheel_self_report import build_install_image  # noqa: E402

#: Profile the whole test runs under. The BR-DE layer is where the documented
#: multi-violation fixture lives; the CLI's own default is en16931, under which
#: broken.xml is conformant and there would be nothing to compare.
PROFILE = "xrechnung"

#: The surface taken as the REFERENCE finding set. It is the machine surface the
#: CLI's own truncation wording points readers at ("use --format json for all
#: N"), so it is the one surface that is contractually complete.
REFERENCE_FORMAT = "json"

#: The documented small fixture: 3 findings across 2 severities.
SMALL_FIXTURE = os.path.join(HERE, "examples", "01-missing-fields", "broken.xml")

#: A minimal but well-formed UBL Invoice: enough structure to parse, almost no
#: content, so it trips a large number of the mandatory-field rules at once
#: (measured: 15 findings — 13 fatal, 2 non-fatal). Written inline rather than
#: added to examples/ because its ONLY job is to be longer than the human
#: listing cap; the exact ids are never asserted, only re-derived.
CAPPED_FIXTURE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents">
  <cbc:ID>PARITY-CAPPED-1</cbc:ID>
</Invoice>
"""

#: ``severities=EVERY_SEVERITY`` means "carries findings of every severity the
#: reference carries" — the default contract.
EVERY_SEVERITY = None


class Surface(collections.namedtuple(
        "Surface", "key report_format argv severities capped why")):
    """One finding-LISTING surface and the finding set it is contracted to render.

    ``key``            human name, as a user would invoke it.
    ``report_format``  the ``einvoice.report.REPORT_FORMATS`` member it renders,
                       or ``None`` for a surface that is not a ``--format``
                       (``einvoice receipt``).
    ``argv``           callable(case) -> CLI argv (after ``python -m einvoice``).
    ``severities``     ``EVERY_SEVERITY``, or a frozenset naming EXACTLY the
                       severities this surface carries by construction. A
                       narrowed set is a MODELLED filter, not an exemption: the
                       expected set is still computed from the reference, just
                       restricted to those severities, so dropping a finding of
                       a severity the surface *does* carry still fails.
    ``capped``         True if the surface truncates a long listing. Then a
                       truncated render must DISCLOSE the omitted count and the
                       total in the CLI's existing wording (see
                       ``_capped_disclosure_failures``).
    ``why``            one-line reason, REQUIRED whenever ``severities`` is
                       narrowed or ``capped`` is set.
    """
    __slots__ = ()


class Omission(collections.namedtuple("Omission", "reason report_format argv")):
    """A surface that legitimately lists NO findings, plus its one-line reason.

    ``argv`` is kept so the allowlist stays MEASURED: each entry is executed and
    asserted to really render zero rule ids. An allowlist nobody runs is how a
    stale exemption outlives the defect it excused.
    """
    __slots__ = ()


def _validate(fmt):
    return lambda case: ["validate", case.path, "--profile", PROFILE,
                         "--format", fmt]


# ---------------------------------------------------------------------------
# DECLARATION 1 — the listing-capable surfaces.
#
# Adding an output format? Add it here (or, if it is a single-verdict artifact,
# to the allowlist below). test_every_report_format_is_declared makes that a
# hard requirement, so "new format silently drops findings" cannot recur.
# ---------------------------------------------------------------------------
FINDING_SET_SURFACES = (
    # The default human report — the most-read surface, and the one that
    # rendered 1 of 12 findings for 344 runs until T-VHFULL.1. `--format text`
    # is byte-identical to the default, so this covers both.
    Surface(
        key="validate --format text",
        report_format="text",
        argv=_validate("text"),
        severities=EVERY_SEVERITY,
        capped=True,
        why=("human listing: einvoice.cli._NON_FATAL_LIST_CAP truncates a long "
             "tail, and must then disclose the omitted count and the total"),
    ),
    # The shareable single-file HTML report: one card per violation, no cap.
    Surface(
        key="validate --format html",
        report_format="html",
        argv=_validate("html"),
        severities=EVERY_SEVERITY,
        capped=False,
        why=None,
    ),
    # CI surfaces. All render one entry per finding; none of them caps.
    Surface(
        key="validate --format junit",
        report_format="junit",
        argv=_validate("junit"),
        severities=EVERY_SEVERITY,
        capped=False,
        why=None,
    ),
    Surface(
        key="validate --format sarif",
        report_format="sarif",
        argv=_validate("sarif"),
        severities=EVERY_SEVERITY,
        capped=False,
        why=None,
    ),
    Surface(
        key="validate --format github",
        report_format="github",
        argv=_validate("github"),
        severities=EVERY_SEVERITY,
        capped=False,
        why=None,
    ),
    Surface(
        key="validate --format azure",
        report_format="azure",
        argv=_validate("azure"),
        severities=EVERY_SEVERITY,
        capped=False,
        why=None,
    ),
    # SEVERITY-FILTERED, declared and modelled — not exempt. GitLab Code Quality
    # must be EMPTY for a conformant invoice, so einvoice/report.py:~1352 skips
    # 'information' findings (`if severity == "information": continue`) while
    # keeping fatal -> major and warning -> minor. Its expected set is therefore
    # the fatal+warning subset of the reference, and dropping a fatal or a
    # warning still fails.
    Surface(
        key="validate --format gitlab",
        report_format="gitlab",
        argv=_validate("gitlab"),
        severities=frozenset({"fatal", "warning"}),
        capped=False,
        why=("GitLab Code Quality must be empty for a conformant invoice, so "
             "advisory 'information' findings are excluded by construction "
             "(einvoice/report.py build_gitlab)"),
    ),
    # SEVERITY-FILTERED, declared and modelled — not exempt. The conformance
    # receipt is a signed statement about CONFORMANCE, and only fatal findings
    # make an invoice non-conformant: einvoice/receipt.py:109 builds
    # failed_fatal_rules with `if v["severity"] == "fatal"`. Expected set = the
    # FATAL SUBSET of the --format json reference, re-derived per fixture; if the
    # receipt ever drops a fatal rule id, this fails.
    # PROMOTED out of FINDING_SET_OMISSION_ALLOWLIST by T-VHUX2.4. It used to be
    # the allowlist's second entry ("names counts only and zero rule ids"); the
    # exemption's own reason said it was chartered to this task, and
    # test_allowlisted_surfaces_really_render_no_finding_ids is what forced the
    # promotion the moment the surface started listing ids. report_format stays
    # None because 'text' is already declared above for single-file validate —
    # this is the DIFFERENT batch rendering behind the same word.
    Surface(
        key="validate-batch --format text",
        report_format=None,
        argv=lambda case: ["validate-batch", case.batch_dir, "--profile",
                           PROFILE, "--format", "text"],
        severities=EVERY_SEVERITY,
        capped=True,
        why=("human listing: einvoice.report._BATCH_RULE_LIST_CAP truncates a "
             "long per-file listing (and the aggregate rule block), and must "
             "then disclose the omitted count and the total in the single-file "
             "wording"),
    ),
    Surface(
        key="einvoice receipt",
        report_format=None,
        argv=lambda case: ["receipt", case.path, "--profile", PROFILE],
        severities=frozenset({"fatal"}),
        capped=False,
        why=("the receipt attests CONFORMANCE, and only fatal findings make an "
             "invoice non-conformant: receipt.py:109 filters "
             "`if v[\"severity\"] == \"fatal\"`"),
    ),
)


# ---------------------------------------------------------------------------
# DECLARATION 2 — surfaces that legitimately carry NO finding ids, with the
# one-line reason each. An omission that is NOT declared here fails the test.
# ---------------------------------------------------------------------------
FINDING_SET_OMISSION_ALLOWLIST = {
    "validate --format badge": Omission(
        reason=("single-verdict artifact: a shields.io endpoint object carrying "
                "one colour/label/message ('2 issues') — it has no per-finding "
                "slot to drop findings from"),
        report_format="badge",
        argv=_validate("badge"),
    ),
}

#: Formats that are neither declared surfaces nor allowlisted, because they ARE
#: the reference. Kept explicit so test_every_report_format_is_declared reads as
#: a partition rather than a special case.
REFERENCE_FORMATS = frozenset({REFERENCE_FORMAT})


#: One fixture, plus the reference finding set measured from it.
#: ``universe`` is the id set the presence scan searches for (the packaged
#: catalog's ids, unioned with the reference ids so a reference id can never
#: fall outside the scan).
Case = collections.namedtuple(
    "Case", "name path batch_dir findings ids severity_of universe")


def _id_present(text, rule_id):
    """True if ``rule_id`` appears in ``text`` as a whole token.

    The boundary classes exclude ``[A-Za-z0-9-]`` on both sides so 'BR-DE-1'
    never matches inside 'BR-DE-15' (a real collision: both fire on the capped
    fixture), while still matching inside '/rules/BR-DE-2/' or 'code=BR-DE-2]'.
    """
    return re.search(r"(?<![A-Za-z0-9-])%s(?![A-Za-z0-9-])" % re.escape(rule_id),
                     text) is not None


def rendered_ids(text, universe):
    """The set of rule ids from ``universe`` that ``text`` actually names."""
    return {rid for rid in universe if _id_present(text, rid)}


def expected_ids(surface, case):
    """The finding set ``surface`` is contracted to render for ``case``.

    Always DERIVED from the ``--format json`` reference: the full id set, or —
    for a declared severity-filtered surface — the subset of the reference whose
    severity the surface carries.
    """
    if surface.severities is EVERY_SEVERITY:
        return set(case.ids)
    return {rid for rid in case.ids if case.severity_of[rid] in surface.severities}


def _capped_disclosure_failures(case, output, cap):
    """Failures if a TRUNCATED human listing does not disclose the omission.

    Reuses the CLI's existing convention verbatim (einvoice/cli.py:1804-1836) —
    the '%d finding(s) total: ...' line and the PASS path's '... %d more not
    shown — use --format json for all %d' truncation wording. No second
    convention is invented here.
    """
    failures = []
    total = case.findings
    fatal = sum(1 for rid in case.ids if case.severity_of[rid] == "fatal")
    total_line = ("  %d finding(s) total: %d fatal, %d non-fatal"
                  % (total, fatal, total - fatal))
    if total_line not in output:
        failures.append("truncated listing does not disclose the total; "
                        "expected a line starting %r" % total_line)
    omitted = total - 1 - cap          # headline finding + cap listed lines
    truncation = ("... %d more not shown — use --format json for all %d"
                  % (omitted, total))
    if truncation not in output:
        failures.append("truncated listing does not disclose the omission; "
                        "expected %r" % truncation)
    return failures


def parity_failures(surface, case, output, cap):
    """Compare one surface's rendered id set against the reference.

    Returns a list of human-readable failure strings — EMPTY means parity holds.
    Returning failures instead of asserting is what lets
    test_detector_catches_an_undeclared_omission run this exact code against a
    known-omitting surface and prove the detector bites.
    """
    want = expected_ids(surface, case)
    got = rendered_ids(output, case.universe)
    failures = []
    extra = got - want
    if extra:
        failures.append("names rule id(s) the reference does not carry for this "
                        "surface: %s" % sorted(extra))
    missing = want - got
    if missing:
        if not surface.capped:
            failures.append("DROPS finding(s) the engine computed and --format "
                            "%s carries: %s" % (REFERENCE_FORMAT, sorted(missing)))
        else:
            # A capped surface may omit — but only by truncating the TAIL, and
            # only if it says so. Anything else is still a silent drop.
            #
            # ``cap + 1`` is the ONE human rule-id budget, expressed from the
            # single-file surface's side: it renders its headline finding in
            # full and then lists ``_NON_FATAL_LIST_CAP`` more. The batch text
            # surface has no headline finding, so einvoice.report spends the
            # identical budget as a flat ``_BATCH_RULE_LIST_CAP == cap + 1``
            # (documented at its definition). Both therefore put the same number
            # of rule ids in front of the reader, and this single assertion
            # holds them to it.
            if len(got) != cap + 1:
                failures.append(
                    "capped surface rendered %d id(s); a truncated listing "
                    "renders exactly the headline finding plus %d = %d"
                    % (len(got), cap, cap + 1))
            failures.extend(_capped_disclosure_failures(case, output, cap))
    return failures


class FindingSetParity(unittest.TestCase):
    """Every declared surface renders the reference finding set."""

    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="einvoice-parity-")
        # cwd/import root live under /tmp — OUTSIDE the repository — so nothing
        # can resolve out of the source checkout.
        cls.image = build_install_image(os.path.join(cls.tmp, "image"))
        cls.work = os.path.join(cls.tmp, "work")

        cls.env = {k: v for k, v in os.environ.items()
                   if not k.startswith(("EINVOICE_", "PYTHON"))}
        cls.env["PYTHONPATH"] = cls.image
        cls.env["PYTHONIOENCODING"] = "utf-8"   # the truncation line has an em dash
        cls._output_cache = {}

        cls.universe = cls._rule_id_universe()
        # Read the cap from the INSTALLED module rather than restating 10 here:
        # if the CLI's cap moves, the expectations move with it.
        cls.cap = int(cls._probe("import einvoice.cli as c; "
                                 "print(c._NON_FATAL_LIST_CAP)"))
        cls.report_formats = json.loads(cls._probe(
            "import json, einvoice.report as r; "
            "print(json.dumps(list(r.REPORT_FORMATS)))"))

        # Each fixture gets its OWN directory so `validate-batch <dir>` sees
        # exactly one invoice and the batch summary stays predictable.
        cls.cases = (
            cls._make_case("small", _read(SMALL_FIXTURE)),
            cls._make_case("capped", CAPPED_FIXTURE_XML),
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # -- process plumbing ---------------------------------------------------

    @classmethod
    def _probe(cls, code):
        proc = subprocess.run([sys.executable, "-c", code], cwd=cls.work_root(),
                              env=cls.env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, encoding="utf-8")
        assert proc.returncode == 0, "probe failed: " + proc.stderr
        return proc.stdout.strip()

    @classmethod
    def work_root(cls):
        os.makedirs(cls.work, exist_ok=True)
        return cls.work

    @classmethod
    def _rule_id_universe(cls):
        """Every rule id the PACKAGED remediation catalog knows (297 today).

        Read from the WHEEL IMAGE, never the checkout, so the universe is the
        one the installed artifact itself ships. Used as the scan universe so
        the comparison is a genuine two-way set equality: a surface that names a
        rule it did not hit is caught as well as one that drops a rule it did.
        """
        catalog = os.path.join(cls.image, "einvoice", "remediation_catalog.json")
        with open(catalog, encoding="utf-8") as fh:
            rules = json.load(fh)["rules"]
        assert isinstance(rules, dict) and rules, "packaged catalog has no rules"
        return frozenset(rules)

    @classmethod
    def _make_case(cls, name, xml_text):
        case_dir = os.path.join(cls.work_root(), name)
        os.makedirs(case_dir, exist_ok=True)
        path = os.path.join(case_dir, "invoice.xml")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(xml_text)
        reference = json.loads(cls._run_argv(
            ["validate", path, "--profile", PROFILE,
             "--format", REFERENCE_FORMAT]))
        violations = reference["violations"]
        ids = {v["rule"] for v in violations}
        return Case(name=name, path=path, batch_dir=case_dir,
                    findings=len(violations), ids=ids,
                    severity_of={v["rule"]: v["severity"] for v in violations},
                    universe=cls.universe | ids)

    @classmethod
    def _run_argv(cls, argv):
        key = tuple(argv)
        if key not in cls._output_cache:
            proc = subprocess.run(
                [sys.executable, "-m", "einvoice"] + list(argv),
                cwd=cls.work_root(), env=cls.env, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, encoding="utf-8")
            assert proc.returncode in (0, 1), (
                "%r exited %d (expected 0=clean or 1=findings)\n%s"
                % (argv, proc.returncode, proc.stderr))
            assert proc.stdout, "%r wrote nothing to stdout" % (argv,)
            cls._output_cache[key] = proc.stdout
        return cls._output_cache[key]

    def output_for(self, argv_builder, case):
        return self._run_argv(argv_builder(case))

    # -- the fixtures are worth what the test assumes of them ---------------

    def test_reference_is_non_trivial(self):
        """The reference must actually contain something to drop.

        Guards against the fixture quietly becoming conformant (or single-
        severity), which would turn every parity assertion below into a
        comparison of two empty sets.
        """
        small, capped = self.cases
        self.assertGreaterEqual(small.findings, 3,
                                "small fixture must carry >= 3 findings")
        self.assertGreaterEqual(
            len(set(small.severity_of.values())), 2,
            "small fixture must span >= 2 severities, else the severity-filtered "
            "surfaces (receipt, gitlab) are not exercised")
        self.assertTrue(
            any(s != "fatal" for s in small.severity_of.values()),
            "small fixture must carry a non-fatal finding")
        self.assertLessEqual(small.findings, self.cap,
                             "small fixture must stay UNDER the human listing "
                             "cap, else no surface is required to be complete")
        self.assertGreater(capped.findings, self.cap + 1,
                           "capped fixture must EXCEED the human listing cap")
        self.assertEqual(len(capped.ids), capped.findings,
                         "capped fixture must have one finding per rule id, "
                         "else counting rendered ids under-reports")

    def test_universe_covers_the_reference(self):
        """Every reference rule id is in the packaged catalog.

        If this ever fails the scan universe has a hole and a dropped finding
        could go unseen — the exact failure mode this file exists to prevent.
        """
        for case in self.cases:
            self.assertLessEqual(
                case.ids, self.universe,
                "%s: rule id(s) missing from the packaged remediation catalog: "
                "%s" % (case.name, sorted(case.ids - self.universe)))

    # -- the declarations are well-formed -----------------------------------

    def test_declarations_are_well_formed(self):
        keys = [s.key for s in FINDING_SET_SURFACES]
        self.assertEqual(len(keys), len(set(keys)), "duplicate surface key")
        self.assertFalse(set(keys) & set(FINDING_SET_OMISSION_ALLOWLIST),
                         "a surface cannot be both required and allowlisted")
        for s in FINDING_SET_SURFACES:
            narrowed = s.severities is not EVERY_SEVERITY
            if narrowed or s.capped:
                self.assertTrue(
                    s.why and s.why.strip(),
                    "%s narrows the finding set and must carry a one-line "
                    "reason" % s.key)
            if narrowed:
                self.assertIsInstance(s.severities, frozenset)
                self.assertTrue(s.severities, "%s: empty severity set — that is "
                                              "an omission, not a filter" % s.key)
        for key, entry in FINDING_SET_OMISSION_ALLOWLIST.items():
            self.assertTrue(entry.reason and entry.reason.strip(),
                            "allowlisted surface %s has no reason" % key)

    def test_every_report_format_is_declared(self):
        """No output format may exist without a written finding-set decision."""
        declared = {s.report_format for s in FINDING_SET_SURFACES}
        declared |= {e.report_format
                     for e in FINDING_SET_OMISSION_ALLOWLIST.values()}
        declared |= set(REFERENCE_FORMATS)
        declared.discard(None)
        self.assertEqual(
            set(self.report_formats), declared,
            "einvoice.report.REPORT_FORMATS and the declarations in this file "
            "have diverged. Every format must be either the reference, a member "
            "of FINDING_SET_SURFACES, or an entry in "
            "FINDING_SET_OMISSION_ALLOWLIST with a reason.")

    # -- the actual parity check --------------------------------------------

    def test_declared_surfaces_render_the_reference_finding_set(self):
        problems = []
        for case in self.cases:
            for surface in FINDING_SET_SURFACES:
                output = self.output_for(surface.argv, case)
                for failure in parity_failures(surface, case, output, self.cap):
                    problems.append("[%s / %s] %s"
                                    % (case.name, surface.key, failure))
        self.assertEqual(problems, [], "finding-set parity broken:\n  " +
                                       "\n  ".join(problems))

    def test_severity_filtered_receipt_carries_exactly_the_fatal_subset(self):
        """The receipt is modelled, not exempted — spelled out explicitly.

        The generic loop above already covers it; this states the contract in
        one readable place: fatals in, non-fatals out, both directions asserted.
        """
        surface = next(s for s in FINDING_SET_SURFACES
                       if s.key == "einvoice receipt")
        self.assertEqual(surface.severities, frozenset({"fatal"}))
        for case in self.cases:
            output = self.output_for(surface.argv, case)
            got = rendered_ids(output, case.universe)
            fatal = {r for r in case.ids if case.severity_of[r] == "fatal"}
            non_fatal = case.ids - fatal
            self.assertTrue(fatal, "%s: no fatal findings to attest" % case.name)
            self.assertEqual(got, fatal,
                             "%s: receipt must carry EXACTLY the fatal subset "
                             "of the --format json reference" % case.name)
            self.assertFalse(got & non_fatal)

    def test_allowlisted_surfaces_really_render_no_finding_ids(self):
        """Keep the allowlist honest and self-expiring.

        Each allowlisted surface is executed and must render ZERO rule ids. If
        one starts listing findings, this goes red and the surface must be MOVED
        into FINDING_SET_SURFACES — an exemption cannot outlive its reason. That
        has already happened once: `validate-batch --format text` was the second
        entry here until T-VHUX2.4 made it name rule ids, at which point this
        test forced its promotion.
        """
        for key, entry in sorted(FINDING_SET_OMISSION_ALLOWLIST.items()):
            for case in self.cases:
                output = self.output_for(entry.argv, case)
                got = rendered_ids(output, case.universe)
                self.assertEqual(
                    got, set(),
                    "%s (%s) now renders rule ids %s — it is no longer an "
                    "omission. Move it into FINDING_SET_SURFACES and delete the "
                    "allowlist entry (reason was: %s)"
                    % (key, case.name, sorted(got), entry.reason))

    def test_capped_text_report_discloses_what_it_omitted(self):
        """A capped human listing must say how many it hid, and out of how many."""
        capped = self.cases[1]
        surface = next(s for s in FINDING_SET_SURFACES if s.capped)
        output = self.output_for(surface.argv, capped)
        got = rendered_ids(output, capped.universe)
        self.assertLess(len(got), len(capped.ids),
                        "capped fixture did not actually trigger truncation")
        self.assertEqual(len(got), self.cap + 1)
        self.assertLessEqual(got, capped.ids)
        self.assertEqual(_capped_disclosure_failures(capped, output, self.cap), [])

    # -- the detector is not vacuous ----------------------------------------

    def test_detector_catches_an_undeclared_omission(self):
        """Run the checker against a real omitting surface as if it were declared.

        `--format badge` genuinely lists no findings (which is why it is
        allowlisted). Declared as a full-set surface it MUST produce a failure
        naming the dropped ids — proof that an UNDECLARED omission fails rather
        than slipping through.
        """
        entry = FINDING_SET_OMISSION_ALLOWLIST["validate --format badge"]
        undeclared = Surface(key="validate --format badge (negative control)",
                             report_format="badge", argv=entry.argv,
                             severities=EVERY_SEVERITY, capped=False, why=None)
        case = self.cases[0]
        failures = parity_failures(undeclared, case,
                                   self.output_for(undeclared.argv, case),
                                   self.cap)
        self.assertTrue(failures, "the parity checker did not flag a surface "
                                  "that renders none of the findings")
        self.assertIn("DROPS", failures[0])
        for rule_id in sorted(case.ids):
            self.assertIn(rule_id, failures[0])

    def test_detector_catches_a_severity_filter_that_drops_too_much(self):
        """A severity filter is not a licence to drop everything.

        Model the receipt as if it were contracted to carry warnings too: it
        does not, so the checker must flag the non-fatal id it omits. This is
        what keeps `severities` an honest MODEL rather than a blanket exemption.
        """
        receipt = next(s for s in FINDING_SET_SURFACES
                       if s.key == "einvoice receipt")
        case = self.cases[0]
        widened = receipt._replace(
            severities=frozenset({"fatal", "warning", "information"}))
        failures = parity_failures(widened, case,
                                  self.output_for(widened.argv, case), self.cap)
        self.assertTrue(failures,
                        "widening the receipt's declared severities did not "
                        "produce a failure — the filter is not being enforced")


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


if __name__ == "__main__":
    unittest.main(verbosity=2)
