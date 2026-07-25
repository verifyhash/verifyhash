#!/usr/bin/env python3
"""test_json_surface_parity.py — pin the JSON surface `einvoice validate --json`,
`python3 -m einvoice.report --format json` and `einvoice validate-batch --json`
share (T-VHERG.2, third surface added T-VHERG.7).

WHY THIS EXISTS
---------------
The project advertises THREE machine-readable JSON surfaces over one engine:

    einvoice validate --json <invoice.xml>          (README §3, "--json shape")
    python3 -m einvoice.report --format json ...    (REPORT-SCHEMA.md)
    einvoice validate-batch --json <dir>            (the nightly CI run)

The first and the third are the NORMAL adoption pair — `validate --json` on a
pre-commit hook, `validate-batch --json` on a nightly directory sweep — so a CI
consumer that has to special-case which of our own two subcommands produced the
JSON is paying for our drift. That is not hypothetical: until 0.2.7 the batch
surface's per-file violations were missing `element` (9 keys on `validate
--json`, 8 in every `report/v1` record), because the two surfaces have two
record builders. The batch leg below exists so that class of drift fails a gate
instead of reaching a user.

QUICKSTART.md §5 goes further and tells a reader that ``field`` exists "under
the name the ``python3 -m einvoice.report`` document uses ... so one parser
reads either surface". Nothing enforced that. Both surfaces are hand-built
projections of the same ``einvoice.rules.Violation`` in two different modules
(``einvoice/cli.py`` and ``einvoice/report.py``), so a key added, renamed or
re-valued on one side and not the other is a silent, un-caught contract break
for anyone who followed that sentence.

This test measures both surfaces from the INSTALLED WHEEL and fails on any
divergence that is not written down in ``DECLARED_DIVERGENCES`` below, with a
one-line reason each. It is a *pin*, not a fixer: it asserts nothing about what
the shapes OUGHT to be, only that today's measured difference is exactly the
difference the project has consciously declared.

WHAT IS COMPARED
----------------
Five documents, at BOTH profiles (``en16931`` and ``xrechnung``), 10 pairs:

  clean UBL / violating UBL      the two invoices QUICKSTART.md §2 and its
                                 raw-CII leg tell a wheel-only reader to paste
                                 (read straight out of the .md — no second copy
                                 of the samples lives here to drift), plus a
                                 line-deleted variant of each that violates at
                                 BOTH profiles (``BR-02`` core + ``BR-DE-15``)
  clean CII / violating CII      same, for ``rsm:CrossIndustryInvoice``
  credit-note UBL                ``fixtures/creditnote-invalid-typecode_ubl.xml``
                                 — the one document in the corpus that makes
                                 both surfaces emit the OPTIONAL ``source_line``
                                 key, and the evidence that ``element`` is not
                                 an alias of ``location`` (see below); it is
                                 also the document the batch leg runs over

For each pair the checker compares (a) the top-level key SETS, (b) the values
of every shared top-level key, (c) per violation record, the key SETS, and
(d) the values of every shared violation key. Anything not in
``DECLARED_DIVERGENCES`` is a failure naming the offending key.

The THIRD surface is then compared ONCE, with the SAME ``compare_payloads()``
rather than a second comparator that could drift from it: the credit note is
dropped into a directory, ``validate-batch --json`` is run over it, and its one
``files[]`` entry — which is a plain single-file report, stored UNCHANGED by
``build_batch_report_from_files`` — is diffed against ``validate --json`` on the
same document. An undeclared PER-VIOLATION divergence between them fails. The
batch wrapper's own aggregate envelope (``file_count``, ``failed_file_count``,
``files``, the summed counts, …) is legitimately batch-only and is pinned
separately, by EXACT set equality against ``BATCH_ENVELOPE_KEYS`` below, so
adding or dropping a wrapper key also fails.

MEASURED FROM THE WHEEL, NOT THE SOURCE TREE
--------------------------------------------
The import root is ``test_wheel_self_report.build_install_image()`` — the same
reconstruction of the ``[tool.setuptools] packages`` + ``package-data``
declarations the other wheel tests use, imported and never re-implemented — and
every subprocess runs with ``cwd`` in a temp directory OUTSIDE the checkout, so
neither surface can quietly resolve a source-tree artifact. The ``einvoice``
console script is not on PATH in a bare checkout, so the validate surface is
driven as ``python3 -m einvoice validate``; that is the same target module
(``einvoice.cli:main``) ``[project.scripts]`` maps the console script to, and
this test ASSERTS that mapping rather than assuming it.

HONEST LIMITS
-------------
  * Five documents, not the 24 MB corpus: this is a shape/serialisation guard,
    not a conformance sweep (``conformance.py`` and ``test_testsuite_
    conformance.py`` do that job). A key that only ever appears on a rule none
    of these five documents fires would not be seen here.
  * The batch leg is ONE directory holding ONE file, at one profile: it is a
    SHAPE check on the per-file record, not a second batch-semantics suite
    (``test_cli_batch.py`` / ``test_report_batch.py`` own the aggregation,
    counts, ordering and empty-directory behaviour).
  * It compares the surfaces to EACH OTHER. None is treated as correct;
    if both drifted the same way in the same commit, this test stays green
    (``test_report_schema.py`` / ``test_output_schemas.py`` pin the absolute
    shapes).
  * Violation records are compared pairwise IN ORDER. Both surfaces derive
    their list from the same ``validate_file`` call, so the order is the same
    engine order; a re-ordering on one side alone would surface here as value
    divergence, which is the desired outcome.

Stdlib only, offline, no pip, no build backend, no network; ~20 short
subprocesses, a couple of seconds. Plain python3, no pytest: exits 1 on
failure, printing every problem it found.
"""

from __future__ import annotations

import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

from test_doc_commands_from_wheel import console_scripts
from test_wheel_self_report import build_install_image

HERE = os.path.dirname(os.path.abspath(__file__))
QUICKSTART = os.path.join(HERE, "QUICKSTART.md")
CREDITNOTE = os.path.join(HERE, "fixtures", "creditnote-invalid-typecode_ubl.xml")

PROFILES = ("en16931", "xrechnung")

VALIDATE_SURFACE = "einvoice validate --json"
REPORT_SURFACE = "python3 -m einvoice.report --format json"


# ---------------------------------------------------------------------------
# DECLARED_DIVERGENCES — the ONLY differences the two surfaces are allowed to
# have. Every entry is (scope, key, side, reason); anything measured and not
# listed here fails the test, and anything listed here that is NOT measured
# also fails (a stale allowlist is as bad as a missing one).
#
#   scope "violation"  a key inside a `violations[]` record
#   scope "envelope"   a top-level key of the document
#   scope "invocation" a behavioural asymmetry of the two entry points, checked
#                      by its own measurement rather than by key diffing
#   side               the surface that carries the key the other one lacks
# ---------------------------------------------------------------------------
DECLARED_DIVERGENCES = (
    # `element` used to be listed here as validate-only. It no longer is:
    # report/v1 gained the key ADDITIVELY in 0.2.7 (report._record +
    # VIOLATION_KEYS + report.schema.json), so all three surfaces now carry it
    # and the "`element` CONVERGENCE" section below measures that directly.
    # Report-only envelope: the versioned-document header the CI contract owns.
    {
        "scope": "envelope",
        "key": "report_version",
        "side": "report",
        "reason": "report envelope: version of the einvoice-conformance-report "
                  "document; validate --json is not a versioned document",
    },
    # Report-only envelope: the schema id consumers dispatch on.
    {
        "scope": "envelope",
        "key": "schema",
        "side": "report",
        "reason": "report envelope: the 'einvoice-conformance-report/v1' schema "
                  "id; validate --json declares no schema id",
    },
    # Report-only envelope: an archived report has to be self-describing.
    {
        "scope": "envelope",
        "key": "profile",
        "side": "report",
        "reason": "report envelope: echoes the resolved profile so an archived "
                  "report says which rule set produced it",
    },
    # Report-only envelope: severity split precomputed for CI gates.
    {
        "scope": "envelope",
        "key": "fatal_count",
        "side": "report",
        "reason": "report envelope: precomputed severity split for CI gates; "
                  "validate --json leaves the counting to the consumer",
    },
    # Report-only envelope: the other half of that precomputed severity split.
    {
        "scope": "envelope",
        "key": "warning_count",
        "side": "report",
        "reason": "report envelope: the other half of the precomputed severity "
                  "split (see fatal_count)",
    },
    # Deliberate, pinned elsewhere; every comparison here passes --profile.
    {
        "scope": "invocation",
        "key": "default-profile",
        "side": "both",
        "reason": "deliberate: with no flag `validate` runs en16931 while "
                  "`report` runs xrechnung — pinned by test_xrechnung.py::"
                  "test_cli_default_profile_unchanged, so every comparison "
                  "below passes an EXPLICIT --profile to both surfaces",
    },
)

DEFAULT_PROFILE_VALIDATE = "en16931"
DEFAULT_PROFILE_REPORT = "xrechnung"


def declared_keys(scope, side):
    return {e["key"] for e in DECLARED_DIVERGENCES
            if e["scope"] == scope and e["side"] == side}


# ---------------------------------------------------------------------------
# BATCH_ENVELOPE_KEYS — the third surface, `einvoice validate-batch --json`, is
# an AGGREGATE document: it legitimately has a wrapper envelope of its own that
# no single-document surface can or should have. Those wrapper keys are
# declared here with a one-line reason each and pinned by EXACT set equality
# below, so adding or dropping one fails this test.
#
# The wrapper's `files[]` entries, by contrast, are plain single-file reports
# (build_batch_report_from_files calls build_report per file and stores the dict
# UNCHANGED), so ONE of them is fed to the SAME compare_payloads() used for the
# other two surfaces. That is where the real guard lives: a per-violation key
# present on `validate --json` and missing from a batch file entry is an
# UNDECLARED divergence and fails — exactly the defect (`element` missing from
# every report/v1 record) this pin was extended to catch in 0.2.7.
# ---------------------------------------------------------------------------
BATCH_SURFACE = "einvoice validate-batch --json"

BATCH_ENVELOPE_KEYS = {
    "report_version": "version of the einvoice-conformance-batch document",
    "schema": "the 'einvoice-conformance-batch/v1' id consumers dispatch on",
    "root": "the directory (or glob) the run covered — a batch-only fact",
    "profile": "the resolved profile the whole run used",
    "file_count": "how many invoice files the walk collected",
    "failed_file_count": "files that errored or carry >=1 fatal (the CI gate)",
    "fatal_count": "fatal violations SUMMED across every file",
    "warning_count": "warnings SUMMED across every file",
    "violation_count": "violations SUMMED across every file",
    "files": "the per-file single-document reports themselves",
}


# ---------------------------------------------------------------------------
# the checker (pure — no I/O, so the negative self-test can drive it directly)
# ---------------------------------------------------------------------------
def compare_payloads(validate_payload, report_payload, where,
                     other_surface=REPORT_SURFACE):
    """Return a list of problem strings, one per undeclared divergence.

    Every problem string NAMES the offending key, so a failure tells the reader
    what to add to ``DECLARED_DIVERGENCES`` (or what to fix).

    ``other_surface`` is only the LABEL printed for the right-hand payload. It
    exists so the third surface (`einvoice validate-batch --json`, whose
    ``files[]`` entries are single-document reports) can be compared by THIS
    comparator instead of a second one that could drift from it. The comparison
    logic and the allowlist are identical for both right-hand surfaces, which
    is the point: a batch file entry IS a report document, so it is held to the
    report document's declared divergences and nothing looser.
    """
    problems = []
    env_validate_only = declared_keys("envelope", "validate")
    env_report_only = declared_keys("envelope", "report")
    vio_validate_only = declared_keys("violation", "validate")
    vio_report_only = declared_keys("violation", "report")

    vkeys, rkeys = set(validate_payload), set(report_payload)

    for key in sorted(vkeys - rkeys - env_validate_only):
        problems.append(
            "%s: top-level key %r present only in `%s` (undeclared)"
            % (where, key, VALIDATE_SURFACE))
    for key in sorted(rkeys - vkeys - env_report_only):
        problems.append(
            "%s: top-level key %r present only in `%s` (undeclared)"
            % (where, key, other_surface))

    for key in sorted((vkeys & rkeys) - {"violations"}):
        if validate_payload[key] != report_payload[key]:
            problems.append(
                "%s: shared top-level key %r differs: validate=%r report=%r"
                % (where, key, validate_payload[key], report_payload[key]))

    vviol = validate_payload.get("violations", [])
    rviol = report_payload.get("violations", [])
    if len(vviol) != len(rviol):
        problems.append(
            "%s: shared key 'violations' has %d record(s) on `%s` but %d on "
            "`%s`" % (where, len(vviol), VALIDATE_SURFACE, len(rviol),
                      other_surface))

    for idx, (a, b) in enumerate(zip(vviol, rviol)):
        rule = a.get("rule", b.get("rule", "?"))
        tag = "%s violations[%d] (%s)" % (where, idx, rule)
        akeys, bkeys = set(a), set(b)
        for key in sorted(akeys - bkeys - vio_validate_only):
            problems.append("%s: key %r present only in `%s` (undeclared)"
                            % (tag, key, VALIDATE_SURFACE))
        for key in sorted(bkeys - akeys - vio_report_only):
            problems.append("%s: key %r present only in `%s` (undeclared)"
                            % (tag, key, other_surface))
        for key in sorted(akeys & bkeys):
            if a[key] != b[key]:
                problems.append(
                    "%s: shared key %r differs: validate=%r report=%r"
                    % (tag, key, a[key], b[key]))
    return problems


def observed_divergences(validate_payload, report_payload):
    """The (scope, key, side) triples this pair actually exhibits — used to
    prove no allowlist entry has gone stale."""
    seen = set()
    vkeys, rkeys = set(validate_payload), set(report_payload)
    for key in vkeys - rkeys:
        seen.add(("envelope", key, "validate"))
    for key in rkeys - vkeys:
        seen.add(("envelope", key, "report"))
    for a, b in zip(validate_payload.get("violations", []),
                    report_payload.get("violations", [])):
        for key in set(a) - set(b):
            seen.add(("violation", key, "validate"))
        for key in set(b) - set(a):
            seen.add(("violation", key, "report"))
    return seen


# ---------------------------------------------------------------------------
# negative self-test: prove the checker is not `pass` in a trench coat
# ---------------------------------------------------------------------------
def _synthetic_pair():
    """A minimal pair shaped exactly like the real ones (measured 2026-07-25):
    identical apart from the DECLARED divergences."""
    shared = {
        "rule": "BR-DE-15",
        "severity": "fatal",
        "message": "The element 'Buyer reference' (BT-10) must be transmitted.",
        "field": "cbc:BuyerReference",
        "title": "Buyer reference (BT-10) must be transmitted (non-empty).",
        "fix_hint": "Add the required element at `cbc:BuyerReference`.",
        "terms": ["BT-10"],
        "location": "cbc:BuyerReference",
        # Since 0.2.7 `element` is on BOTH sides (report._record emits it), so
        # it belongs in `shared` — that is exactly what makes it no longer a
        # declared divergence.
        "element": "cbc:BuyerReference",
    }
    validate = {
        "source": "invoice.xml",
        "valid": False,
        "violation_count": 1,
        "violations": [dict(shared)],
        "syntax_bindings": [],
        "syntax_binding_fatal_count": 0,
        "syntax_binding_warning_count": 0,
    }
    report = {
        "report_version": 1,
        "schema": "einvoice-conformance-report/v1",
        "source": "invoice.xml",
        "profile": "xrechnung",
        "valid": False,
        "fatal_count": 1,
        "warning_count": 0,
        "violation_count": 1,
        "violations": [dict(shared)],
        "syntax_bindings": [],
        "syntax_binding_fatal_count": 0,
        "syntax_binding_warning_count": 0,
    }
    return validate, report


def run_negative_self_test():
    """Inject synthetic divergences and require the checker to report each one
    BY NAME. Returns ``(failures, checks_run)``."""
    failures = []
    checks = 0

    def expect(cond, name, detail=""):
        print("  [%s] %s%s" % ("ok" if cond else "FAIL", name,
                               ("" if cond else " — " + detail)))
        if not cond:
            failures.append(name)

    def problems_for(mutate):
        a, b = _synthetic_pair()
        mutate(a, b)
        return compare_payloads(a, b, "self-test")

    # --- case 0: a pair differing ONLY by declared divergences is CLEAN ------
    clean = problems_for(lambda a, b: None)
    checks += 1
    expect(clean == [], "declared-only divergence -> zero problems",
           "unexpected problems: %r" % (clean,))

    # The allowlist must not be able to swallow an arbitrary name.
    checks += 1
    expect("phantom_key" not in declared_keys("violation", "report")
           and "phantom_key" not in declared_keys("envelope", "report"),
           "the probe key is genuinely undeclared")

    # --- case 1: an undeclared EXTRA violation key on the report side -------
    def add_violation_key(a, b):
        b["violations"][0]["phantom_key"] = "surprise"

    probs = problems_for(add_violation_key)
    checks += 1
    expect(len(probs) == 1, "extra violation key -> exactly one problem",
           "got %r" % (probs,))
    checks += 1
    expect(any("'phantom_key'" in p for p in probs),
           "problem NAMES the extra violation key", "problems: %r" % (probs,))

    # --- case 2: an undeclared EXTRA violation key on the validate side -----
    def add_validate_key(a, b):
        a["violations"][0]["element_v2"] = "cbc:BuyerReference"

    probs = problems_for(add_validate_key)
    checks += 1
    expect(any("'element_v2'" in p and VALIDATE_SURFACE in p for p in probs),
           "extra validate-side violation key is named",
           "problems: %r" % (probs,))

    # --- case 3: an undeclared EXTRA top-level key --------------------------
    def add_envelope_key(a, b):
        b["phantom_envelope"] = 7

    probs = problems_for(add_envelope_key)
    checks += 1
    expect(any("'phantom_envelope'" in p for p in probs),
           "problem NAMES the extra top-level key", "problems: %r" % (probs,))

    # --- case 4: a SHARED violation key whose VALUE drifts ------------------
    def drift_violation_value(a, b):
        b["violations"][0]["message"] = "something else entirely"

    probs = problems_for(drift_violation_value)
    checks += 1
    expect(any("'message'" in p and "differs" in p for p in probs),
           "problem NAMES the drifted shared violation key",
           "problems: %r" % (probs,))

    # `element` is the key report/v1 gained in 0.2.7; a value drift on it must
    # be caught like any other shared key (the allowlist covers presence only,
    # and `element` is not even in the allowlist any more).
    def drift_element_value(a, b):
        b["violations"][0]["element"] = "cbc:Other"

    probs = problems_for(drift_element_value)
    checks += 1
    expect(any("'element'" in p and "differs" in p for p in probs),
           "a drifted `element` value is caught on both surfaces",
           "problems: %r" % (probs,))

    # --- case 5: a SHARED top-level key whose VALUE drifts ------------------
    def drift_envelope_value(a, b):
        b["valid"] = True

    probs = problems_for(drift_envelope_value)
    checks += 1
    expect(any("'valid'" in p and "differs" in p for p in probs),
           "problem NAMES the drifted shared top-level key",
           "problems: %r" % (probs,))

    # --- case 6: the two surfaces disagree on HOW MANY violations -----------
    def drop_violation(a, b):
        b["violations"] = []
        b["violation_count"] = 0

    probs = problems_for(drop_violation)
    checks += 1
    expect(any("'violations'" in p and "record(s)" in p for p in probs),
           "a violation-count disagreement is reported",
           "problems: %r" % (probs,))

    # --- case 7: the stale-allowlist detector actually detects --------------
    # Driven on a PROBE key rather than on a real one, so the case keeps
    # working whichever way the surfaces converge next.
    a, b = _synthetic_pair()
    a["violations"][0]["probe_only"] = "x"
    observed = observed_divergences(a, b)
    checks += 1
    expect(("violation", "probe_only", "validate") in observed,
           "observed-divergence scan sees a validate-only violation key",
           "observed: %r" % (sorted(observed),))
    a2 = copy.deepcopy(a)
    del a2["violations"][0]["probe_only"]
    checks += 1
    expect(("violation", "probe_only", "validate")
           not in observed_divergences(a2, b),
           "observed-divergence scan STOPS seeing the key once it is gone")

    # --- case 8 (0.2.7): a batch FILE entry missing a per-violation key the
    # single-file surface carries must FAIL, named. This is the exact defect
    # the third-surface comparison was added for: `element` was absent from
    # every report/v1 record, so `validate-batch --json` handed a CI consumer a
    # different violation object than `validate --json` did.
    a, b = _synthetic_pair()
    del b["violations"][0]["element"]      # b stands in for a batch files[] entry
    probs = compare_payloads(a, b, "self-test batch", other_surface=BATCH_SURFACE)
    checks += 1
    expect(any("'element'" in p and "self-test batch" in p for p in probs),
           "a batch file entry missing `element` is reported, named, against "
           "the batch comparison", "problems: %r" % (probs,))

    return failures, checks


# ---------------------------------------------------------------------------
# the real measurement
# ---------------------------------------------------------------------------
HEREDOC_RE = re.compile(r"cat > ([A-Za-z0-9._-]+) <<'XML'\n(.*?)\nXML\n", re.S)


def quickstart_samples():
    """The invoices QUICKSTART.md tells a wheel-only reader to paste, read out
    of the .md itself so no second copy lives here to drift."""
    with open(QUICKSTART, encoding="utf-8") as fh:
        text = fh.read()
    out = {name: body + "\n" for name, body in HEREDOC_RE.findall(text)}
    if not out:
        raise SystemExit("FAIL: QUICKSTART.md carries no `cat > ... <<'XML'` "
                         "invoice heredoc — the doc structure changed")
    return out


def build_corpus(workdir):
    """Write the five documents under ``workdir``. Returns ``[(label, name)]``."""
    samples = quickstart_samples()
    ubl = next((b for b in samples.values() if "<Invoice" in b), None)
    cii = next((b for b in samples.values() if "CrossIndustryInvoice" in b), None)
    if ubl is None:
        raise SystemExit("FAIL: QUICKSTART.md has no pasteable UBL Invoice "
                         "heredoc")
    if cii is None:
        raise SystemExit("FAIL: QUICKSTART.md has no pasteable raw-CII "
                         "CrossIndustryInvoice heredoc (T-VHCII3.7)")
    if not os.path.isfile(CREDITNOTE):
        raise SystemExit("FAIL: committed fixture is missing: %s" % CREDITNOTE)
    with open(CREDITNOTE, encoding="utf-8") as fh:
        creditnote = fh.read()

    def drop_lines(text, needles):
        kept = [ln for ln in text.splitlines(True)
                if not any(n in ln for n in needles)]
        out = "".join(kept)
        if len(out) == len(text):
            raise SystemExit("FAIL: mutation removed nothing (needles %r) — the "
                             "sample changed shape" % (needles,))
        return out

    # Violating variants break ONE core EN 16931 rule (BR-02, the invoice
    # number) AND one German CIUS rule (BR-DE-15, the buyer reference), so the
    # comparison is non-vacuous at BOTH profiles rather than only at xrechnung.
    docs = [
        ("clean-ubl", "clean-ubl.xml", ubl),
        ("violating-ubl", "violating-ubl.xml",
         drop_lines(ubl, ("<cbc:BuyerReference>", "<cbc:ID>RE-2026-0001<"))),
        ("clean-cii", "clean-cii.xml", cii),
        ("violating-cii", "violating-cii.xml",
         drop_lines(cii, ("<ram:BuyerReference>", "<ram:ID>RE-2026-0001<"))),
        ("creditnote-ubl", "creditnote-ubl.xml", creditnote),
        # DE-only breakage: valid under en16931, invalid under xrechnung. Used
        # ONLY to measure the declared default-profile asymmetry.
        ("de-only-ubl", "de-only-ubl.xml",
         drop_lines(ubl, ("<cbc:BuyerReference>",))),
    ]
    for _, name, body in docs:
        with open(os.path.join(workdir, name), "w", encoding="utf-8") as fh:
            fh.write(body)
    return [(label, name) for label, name, _ in docs]


class Runner(object):
    def __init__(self, image, workdir):
        self.image = image
        self.workdir = workdir
        self.env = dict(os.environ)
        self.env["PYTHONPATH"] = image
        self.env.pop("PYTHONSTARTUP", None)

    def _run(self, args):
        proc = subprocess.run(
            [sys.executable] + args,
            cwd=self.workdir, env=self.env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            timeout=120,
        )
        return proc

    def validate_json(self, name, profile=None):
        args = ["-m", "einvoice", "validate", "--json"]
        if profile:
            args += ["--profile", profile]
        proc = self._run(args + [name])
        return self._parse(proc, "%s %s" % (VALIDATE_SURFACE, name))

    def report_json(self, name, profile=None):
        args = ["-m", "einvoice.report", "--format", "json"]
        if profile:
            args += ["--profile", profile]
        proc = self._run(args + [name])
        return self._parse(proc, "%s %s" % (REPORT_SURFACE, name))

    def batch_json(self, directory, profile=None):
        """The THIRD surface: `einvoice validate-batch --json <dir>`."""
        args = ["-m", "einvoice", "validate-batch", "--json"]
        if profile:
            args += ["--profile", profile]
        proc = self._run(args + [directory])
        return self._parse(proc, "%s %s" % (BATCH_SURFACE, directory))

    @staticmethod
    def _parse(proc, what):
        if proc.returncode not in (0, 1):
            raise SystemExit("FAIL: %s exited %d (not a validate outcome)\n%s"
                             % (what, proc.returncode, proc.stderr))
        try:
            return proc.returncode, json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise SystemExit("FAIL: %s did not emit JSON (%s)\n%s"
                             % (what, exc, proc.stdout[:400]))


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

    tmp = tempfile.mkdtemp(prefix="einvoice-parity-")
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

        docs = build_corpus(workdir)
        runner = Runner(image, workdir)

        print("\nSURFACE PARITY (wheel image %s, cwd %s)"
              % (os.path.basename(image), os.path.basename(workdir)))
        problems = []
        observed = set()
        records = 0
        for label, name in docs:
            if label == "de-only-ubl":
                continue          # measured separately, below
            for profile in PROFILES:
                where = "%s@%s" % (label, profile)
                vrc, vpayload = runner.validate_json(name, profile)
                rrc, rpayload = runner.report_json(name, profile)
                if vrc != rrc:
                    problems.append(
                        "%s: exit codes disagree at a matched profile: "
                        "validate=%d report=%d" % (where, vrc, rrc))
                found = compare_payloads(vpayload, rpayload, where)
                observed |= observed_divergences(vpayload, rpayload)
                records += len(vpayload.get("violations", []))
                problems.extend(found)
                print("  [%s] %-28s exit %d/%d, %d violation(s), %d problem(s)"
                      % ("ok" if not found else "FAIL", where, vrc, rrc,
                         vpayload.get("violation_count", 0), len(found)))

        # Non-vacuity: the comparison must actually have looked at violations.
        if records < 4:
            problems.append(
                "only %d violation record(s) compared — the corpus stopped "
                "producing violations, so the per-record comparison proves "
                "nothing" % records)

        # ---- the allowlist must not rot: every declared key/value divergence
        # must still be OBSERVED, and nothing observed may be undeclared.
        print("\nALLOWLIST FRESHNESS (%d declared entr(ies))"
              % len(DECLARED_DIVERGENCES))
        for entry in DECLARED_DIVERGENCES:
            if entry["scope"] == "invocation":
                continue
            triple = (entry["scope"], entry["key"], entry["side"])
            hit = triple in observed
            print("  [%s] %-9s %-14s only in %s"
                  % ("ok" if hit else "FAIL", entry["scope"], entry["key"],
                     entry["side"]))
            if not hit:
                problems.append(
                    "declared divergence %r (%s, %s-only) was NOT observed — "
                    "the surfaces converged; drop the allowlist entry"
                    % (entry["key"], entry["scope"], entry["side"]))

        # ---- `element` converged in 0.2.7: it is on BOTH surfaces now, and it
        # is still NOT an alias of `location` (which is why carrying it matters)
        print("\n`element` CONVERGENCE (0.2.7, was a declared divergence)")
        _, cn_validate = runner.validate_json("creditnote-ubl.xml", "en16931")
        _, cn_report = runner.report_json("creditnote-ubl.xml", "en16931")
        missing = [v.get("rule") for v in cn_report["violations"]
                   if "element" not in v]
        if missing:
            problems.append(
                "`%s` does NOT emit `element` on %r — report/v1 must carry it "
                "since 0.2.7 (report._record + VIOLATION_KEYS)"
                % (REPORT_SURFACE, missing))
            print("  [FAIL] report/v1 lost `element` again")
        else:
            print("  [ok] every report/v1 violation carries `element`")
        alias_broken = [
            (v["rule"], v["element"], v["location"])
            for v in cn_validate["violations"]
            if v.get("element") is not None and v.get("element") != v.get("location")
        ]
        if not alias_broken:
            problems.append(
                "no violation where `element` differs from `location` — the "
                "reason `element` is a datum worth carrying (\"not an alias of "
                "location\") is no longer evidenced")
            print("  [FAIL] `element` is indistinguishable from `location` here")
        else:
            rule, elem, loc = alias_broken[0]
            print("  [ok] %s: element=%r != location=%r  (a genuinely distinct "
                  "datum, now on all three surfaces)" % (rule, elem, loc))

        # ---- THIRD SURFACE: `einvoice validate-batch --json <dir>` ----------
        # The adoption shape is `validate --json` on a pre-commit hook and
        # `validate-batch --json` on a nightly directory run. Those two MUST
        # hand back the same violation object or every consumer has to
        # special-case which of our own subcommands produced the JSON.
        print("\nTHIRD SURFACE — %s" % BATCH_SURFACE)
        batchdir = os.path.join(workdir, "batchdir")
        os.makedirs(batchdir)
        shutil.copy(os.path.join(workdir, "creditnote-ubl.xml"),
                    os.path.join(batchdir, "creditnote-ubl.xml"))
        _, batch = runner.batch_json(batchdir, "en16931")

        # (a) the wrapper envelope is exactly the declared aggregate key set.
        got_env = set(batch)
        declared_env = set(BATCH_ENVELOPE_KEYS)
        for key in sorted(got_env - declared_env):
            problems.append(
                "batch envelope key %r is undeclared — add it to "
                "BATCH_ENVELOPE_KEYS with a reason, or drop it" % key)
        for key in sorted(declared_env - got_env):
            problems.append(
                "declared batch envelope key %r was NOT emitted — "
                "BATCH_ENVELOPE_KEYS has gone stale" % key)
        print("  [%s] wrapper envelope = the %d declared aggregate key(s)"
              % ("ok" if got_env == declared_env else "FAIL",
                 len(declared_env)))

        # (b) one files[] entry, through the SAME comparator as the report
        # surface — an undeclared PER-VIOLATION divergence fails here.
        entries = batch.get("files", [])
        if len(entries) != 1:
            problems.append(
                "batch over a 1-file directory reported %d file entr(ies)"
                % len(entries))
        else:
            entry = entries[0]
            _, single = runner.validate_json("creditnote-ubl.xml", "en16931")
            # `source` is the only legitimate VALUE difference: the two runs
            # name the same document by the path each was given. Checked
            # explicitly before it is normalised away, so normalising cannot
            # hide a missing or wrong `source`.
            if not str(entry.get("source", "")).endswith("creditnote-ubl.xml"):
                problems.append(
                    "batch files[0].source is %r — it must name the file that "
                    "was validated" % (entry.get("source"),))
            entry = dict(entry, source=single["source"])
            found = compare_payloads(single, entry, "batch[creditnote]@en16931",
                                     other_surface=BATCH_SURFACE)
            problems.extend(found)
            nvio = len(entry.get("violations", []))
            if nvio < 1:
                problems.append(
                    "the batch file entry carries no violations — the "
                    "per-violation comparison would prove nothing")
            print("  [%s] files[0] vs `%s`: %d violation(s), %d problem(s)"
                  % ("ok" if not found else "FAIL", VALIDATE_SURFACE, nvio,
                     len(found)))
            if not found:
                print("       (same violation object: %s)"
                      % ", ".join(sorted(entry["violations"][0])))

        # ---- the deliberate default-profile asymmetry, measured -------------
        print("\nDECLARED DEFAULT-PROFILE ASYMMETRY (no --profile flag)")
        vrc, vpayload = runner.validate_json("de-only-ubl.xml")
        rrc, rpayload = runner.report_json("de-only-ubl.xml")
        got = rpayload.get("profile")
        print("  validate (no flag): exit %d, valid=%s, %d violation(s)"
              % (vrc, vpayload["valid"], vpayload["violation_count"]))
        print("  report   (no flag): exit %d, valid=%s, %d violation(s), "
              "profile=%r" % (rrc, rpayload["valid"],
                              rpayload["violation_count"], got))
        if got != DEFAULT_PROFILE_REPORT:
            problems.append(
                "report's default profile is %r, not the declared %r"
                % (got, DEFAULT_PROFILE_REPORT))
        if not (vpayload["valid"] is True and rpayload["valid"] is False):
            problems.append(
                "the declared default-profile asymmetry no longer reproduces: "
                "a DE-only-violating invoice must be valid under validate's "
                "default (%s) and invalid under report's default (%s); got "
                "validate.valid=%r report.valid=%r"
                % (DEFAULT_PROFILE_VALIDATE, DEFAULT_PROFILE_REPORT,
                   vpayload["valid"], rpayload["valid"]))
        else:
            print("  [ok] same file, no flags: valid on `%s` (%s default), "
                  "invalid on `%s` (%s default) — declared, not a bug"
                  % (VALIDATE_SURFACE, DEFAULT_PROFILE_VALIDATE,
                     REPORT_SURFACE, DEFAULT_PROFILE_REPORT))

        # ---- QUICKSTART's raw-CII leg must really pass, from the wheel ------
        print("\nQUICKSTART RAW-CII LEG (T-VHCII3.7)")
        crc, cpayload = runner.validate_json("clean-cii.xml", "xrechnung")
        brc, bpayload = runner.validate_json("violating-cii.xml", "xrechnung")
        if not (crc == 0 and cpayload["valid"] is True):
            problems.append(
                "QUICKSTART's pasteable CII invoice does NOT pass `validate "
                "--profile xrechnung` from the wheel (exit %d, valid=%r, %r)"
                % (crc, cpayload["valid"],
                   [v["rule"] for v in cpayload["violations"]]))
        else:
            print("  [ok] the pasted CII invoice passes --profile xrechnung, "
                  "exit 0")
        if not (brc == 1 and "BR-DE-15" in
                [v["rule"] for v in bpayload["violations"]]):
            problems.append(
                "the mutated CII invoice does not fail with BR-DE-15 (exit %d, "
                "%r)" % (brc, [v["rule"] for v in bpayload["violations"]]))
        else:
            print("  [ok] deleting ram:BuyerReference -> exit 1, BR-DE-15")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("")
    total = len(failures) + len(problems)
    if total:
        print("FAIL — %d problem(s): %d self-test, %d surface"
              % (total, len(failures), len(problems)))
        for msg in failures + problems:
            print("  %s" % msg)
        return 1
    print("PASS — the JSON surfaces diverge in exactly the %d declared way(s), "
          "and `validate-batch --json` hands back the same violation object as "
          "`validate --json` over the %d declared aggregate envelope key(s)"
          % (len(DECLARED_DIVERGENCES), len(BATCH_ENVELOPE_KEYS)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
