#!/usr/bin/env python3
"""Machine/CI-format output regression lock over the economically-distinct
synthetic fixtures (T-VHFMTP.1).

WHAT THIS IS
------------
``test_golden_snapshot.py`` pins the NORMALIZED PROJECTION (valid / exit_code /
sorted fired-rule ids) of the engine's verdict for a curated corpus. That
projection deliberately drops the actual machine-format bytes — timestamps,
paths, fingerprints and layout are all normalized away — so a driver that
adopts einvoice in CI (``einvoice.report --format sarif|gitlab|github|azure|
junit``) has NO test that its exact, byte-level machine output stays stable
across refactors. A silent change to a SARIF ``partialFingerprint``, a GitLab
Code-Quality ``fingerprint``, a JUnit attribute order, or a GitHub/Azure
workflow-command line would slip past every existing gate and break a
stranger's pipeline (deduped annotations reappear, quality-gate diffs churn).

This module closes that gap for a REPRESENTATIVE subset of the new
economically-distinct fixtures by freezing the EXACT emitted bytes of each
registered machine/CI format and asserting byte-identity with a committed
golden under ``golden/``. It is a pure regression LOCK: it adds no format,
changes no emitter, and asserts no verdict this repo doesn't already produce.

FIXTURES (four distinct economic verdicts, one machine golden set each)
----------------------------------------------------------------------
  * synth-cii-good-fullshape      full-shape valid CII      -> PASS (no fired rule)
  * synth-cii-bad-fullshape       its negative twin         -> FAIL, BR-CO-15
  * synth-cii-bad-reverse-charge  reverse-charge (AE) twin  -> FAIL, BR-AE-10
  * synth-ubl-bad-intra-community intra-community (K) UBL    -> FAIL, BR-IC-02
Each is a genuinely different document producing a genuinely different report,
so its six machine goldens differ substantively (not near-duplicates): the
pass case emits an empty GitLab array / zero-testcase JUnit / "conformant"
GitHub+Azure lines, while each FAIL case carries its own rule id, message,
location and stable fingerprint.

CODE PATH (the REAL emitters — no re-implemented rule logic, no hand-authored
bytes)
------------------------------------------------------------------------------
Per (fixture, format) we render through the IDENTICAL functions and
serialization ``einvoice.report.main`` uses for ``--format <fmt>``:
  json   -> json.dumps(report, separators=(",", ":")) + "\n"
  junit  -> report.build_junit(report)
  sarif  -> json.dumps(report.build_sarif(report),  indent=2, sort_keys=True)+"\n"
  gitlab -> json.dumps(report.build_gitlab(report), indent=2, sort_keys=True)+"\n"
  github -> report.build_github(report)
  azure  -> report.build_azure(report)
This ``emit`` helper is verified byte-identical to driving the real
``python3 -m einvoice.report --format <fmt> --profile en16931 <path>`` CLI (see
``_assert_emit_matches_cli`` below, run on every ``--update`` regeneration).

The REPORT DICT is built by the shipped engine, never hand-authored:
  * UBL fixture  -> ``report.build_report(rel, profile)`` verbatim — the exact
    CLI plain-XML path (native UBL validation + the syntax-binding section).
  * CII fixtures -> ``report._report_from_invoice_bytes(bytes, rel, profile)`` —
    the SAME native-CII engine (``parser_cii.build_model`` + ``rules.ALL_RULES``
    + ``rules_xrechnung.evaluate_cii``) that ``build_report`` runs for a
    Factur-X/ZUGFeRD PDF's embedded CII. HONEST NOTE: the plain-XML report CLI
    parses UBL only, so ``einvoice.report <raw-cii.xml>`` today trips the S-ROOT
    structural check; the native CII verdict pinned here is exactly what the CLI
    emits when the SAME invoice arrives inside its Factur-X PDF container
    (proved for synth-cii-good-fullshape by ``test_pdf_container``'s
    ``facturx-fullshape.pdf`` e2e). We pin the honest economic verdict, not the
    S-ROOT bailout — three raw-CII S-ROOT documents would be near-identical and
    carry no economic signal.

Profile ``en16931`` — the same profile these fixtures are golden-pinned under in
``test_golden_snapshot.py`` — so the machine bytes reflect the exact fired-rule
set already committed there; a CROSS-CHECK below asserts each fixture's
``valid`` here equals that committed projection's ``valid``.

PATH-INVARIANCE (independent of where this checkout lives)
----------------------------------------------------------
Every report is built with the fixture's RELATIVE path (``corpus/...`` /
``fixtures/...``), so the only path any format echoes (json ``source``, gitlab
``location.path``, github ``file=``, azure ``sourcepath=``) is that committed
relative string — never an absolute prefix, ``$HOME`` or this checkout's
location. A guard below rejects regenerating any golden that contains ``HERE``,
``$HOME`` or a ``/home/`` prefix, exactly the discipline the container-golden
block documents ("independent of where this checkout lives").

REGENERATION (never automatic)
------------------------------
The default run NEVER rewrites goldens. After an INTENTIONAL emitter change,
re-baseline with a reviewed diff via:
    python3 test_format_regression.py --update
    REGEN=1 python3 test_format_regression.py
Regeneration first re-checks the emit==CLI equivalence, the no-error report
shape, the verdict cross-check and path-invariance, and refuses to freeze a
golden that fails any of them.

Standard library only. No network. Runs in well under a second.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
GOLDEN_DIR = os.path.join(HERE, "golden")

from einvoice import report  # noqa: E402

#: The profile these fixtures are golden-pinned under in test_golden_snapshot.py.
PROFILE = "en16931"

#: The registered MACHINE/CI formats we lock (the CI-adopter subset of
#: report.REPORT_FORMATS; html/badge/text are human/visual and out of scope).
MACHINE_FORMATS = ("json", "junit", "sarif", "gitlab", "github", "azure")

#: golden filename extension per format, mirroring the existing
#: container-unsupported-truncated.validate.* convention.
FORMAT_EXT = {
    "json": "validate.json",
    "junit": "validate.junit.xml",
    "sarif": "validate.sarif.json",
    "gitlab": "validate.gitlab.json",
    "github": "validate.github.txt",
    "azure": "validate.azure.txt",
}

#: The four economically-distinct fixtures. ``kind`` selects the real report
#: code path; ``rel`` is the checkout-relative path echoed into the output; the
#: ``<stem>.json`` projection golden (already committed by test_golden_snapshot)
#: supplies the verdict cross-check.
FIXTURES = [
    {
        "name": "synth-cii-good-fullshape",
        "rel": "corpus/synthetic/synth-cii-good-fullshape.xml",
        "kind": "cii",
        "note": "full-shape valid CII -> PASS (no fired rule).",
    },
    {
        "name": "synth-cii-bad-fullshape",
        "rel": "corpus/synthetic/synth-cii-bad-fullshape.xml",
        "kind": "cii",
        "note": "negative twin of the full-shape invoice -> FAIL (BR-CO-15).",
    },
    {
        "name": "synth-cii-bad-reverse-charge",
        "rel": "corpus/synthetic/synth-cii-bad-reverse-charge.xml",
        "kind": "cii",
        "note": "reverse-charge (AE) broken twin -> FAIL (BR-AE-10).",
    },
    {
        "name": "synth-ubl-bad-intra-community",
        "rel": "fixtures/synth-ubl-bad-intra-community_ubl.xml",
        "kind": "ubl",
        "note": "intra-community (K) broken UBL twin -> FAIL (BR-IC-02); the "
                "native UBL CLI plain-XML path.",
    },
]


def build_report_dict(rel, kind):
    """Return the shipped-engine report dict for ``rel`` via the SAME code path
    the CLI uses: native UBL (build_report) or native CII
    (_report_from_invoice_bytes, the Factur-X embedded-CII engine)."""
    abspath = os.path.join(HERE, rel)
    if kind == "cii":
        with open(abspath, "rb") as fh:
            xml_bytes = fh.read()
        # source is the RELATIVE path -> path-invariant echoed bytes.
        return report._report_from_invoice_bytes(xml_bytes, rel, PROFILE)
    # UBL: drive build_report with the relative path from cwd=HERE so its
    # own file read + echoed ``source`` stay checkout-independent.
    prev = os.getcwd()
    try:
        os.chdir(HERE)
        return report.build_report(rel, profile=PROFILE)
    finally:
        os.chdir(prev)


def emit(rep, fmt):
    """Render ``rep`` to bytes with the EXACT serialization report.main uses for
    ``--format <fmt>`` (verified against the real CLI in
    ``_assert_emit_matches_cli``)."""
    if fmt == "json":
        return (json.dumps(rep, separators=(",", ":")) + "\n").encode("utf-8")
    if fmt == "junit":
        return report.build_junit(rep).encode("utf-8")
    if fmt == "sarif":
        return (json.dumps(report.build_sarif(rep), indent=2, sort_keys=True)
                + "\n").encode("utf-8")
    if fmt == "gitlab":
        return (json.dumps(report.build_gitlab(rep), indent=2, sort_keys=True)
                + "\n").encode("utf-8")
    if fmt == "github":
        return report.build_github(rep).encode("utf-8")
    if fmt == "azure":
        return report.build_azure(rep).encode("utf-8")
    raise ValueError("unhandled format %r" % fmt)


def golden_path(name, fmt):
    return os.path.join(GOLDEN_DIR, "%s.%s" % (name, FORMAT_EXT[fmt]))


def _path_leak(data):
    """Return a human reason if ``data`` (bytes) carries an absolute checkout
    prefix, $HOME, or any /home/ path — else ''. Enforces path-invariance."""
    home = os.environ.get("HOME", "")
    for needle in (HERE.encode("utf-8"),
                   (home.encode("utf-8") if home else b"\x00never\x00"),
                   b"/home/"):
        if needle and needle in data:
            return "contains absolute/HOME prefix %r" % needle
    return ""


def _assert_emit_matches_cli(fx):
    """Prove ``emit(build_report_dict(...), fmt)`` is byte-identical to driving
    the REAL ``python3 -m einvoice.report --format <fmt>`` CLI. Only meaningful
    for the fixtures the plain-XML CLI dispatches natively (UBL); a CII raw .xml
    trips S-ROOT in the CLI (documented above), so its native verdict is
    cross-checked instead against the committed projection. Returns a list of
    failure lines (empty = OK)."""
    fails = []
    rep = build_report_dict(fx["rel"], fx["kind"])
    if fx["kind"] != "ubl":
        return fails
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    for fmt in MACHINE_FORMATS:
        proc = subprocess.run(
            [sys.executable, "-m", "einvoice.report", "--format", fmt,
             "--profile", PROFILE, fx["rel"]],
            cwd=HERE, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        want = emit(rep, fmt)
        if proc.stdout != want:
            fails.append("  %s/%s: in-process emit != real CLI stdout"
                         % (fx["name"], fmt))
    return fails


def _load_projection_valid(name):
    """Read the committed ``golden/<stem>.json`` projection's ``valid`` (the
    already-pinned economic verdict) for the cross-check; None if absent."""
    p = os.path.join(GOLDEN_DIR, "%s.json" % name)
    if not os.path.isfile(p):
        return None
    with open(p, "r", encoding="utf-8") as fh:
        return json.load(fh).get("valid")


def _regen_guard(fx, rep):
    """Refuse to freeze a golden over a broken report shape. Returns failure
    lines (empty = safe to write)."""
    fails = []
    if rep.get("error"):
        fails.append("  %s: report carries error=%r (never pin an error over "
                     "a well-formed economic fixture)"
                     % (fx["name"], rep.get("error")))
    proj = _load_projection_valid(fx["name"])
    if proj is not None and rep.get("valid") != proj:
        fails.append("  %s: valid=%r disagrees with committed projection "
                     "golden/%s.json valid=%r"
                     % (fx["name"], rep.get("valid"), fx["name"], proj))
    return fails


def write_goldens():
    """Regenerate every machine-format golden (only via --update / REGEN=1),
    refusing to freeze a broken shape, a CLI-divergent emit, or a path leak."""
    if not os.path.isdir(GOLDEN_DIR):
        os.makedirs(GOLDEN_DIR)
    written = 0
    for fx in FIXTURES:
        rep = build_report_dict(fx["rel"], fx["kind"])
        guard = _regen_guard(fx, rep) + _assert_emit_matches_cli(fx)
        if guard:
            raise SystemExit("refusing to regenerate goldens for %s:\n%s"
                             % (fx["name"], "\n".join(guard)))
        for fmt in MACHINE_FORMATS:
            data = emit(rep, fmt)
            leak = _path_leak(data)
            if leak:
                raise SystemExit("refusing to write a NON-path-invariant "
                                 "golden %s/%s: %s"
                                 % (fx["name"], fmt, leak))
            with open(golden_path(fx["name"], fmt), "wb") as fh:
                fh.write(data)
            written += 1
    return written


def check(verbose=True):
    """Byte-compare every (fixture, format) pair against its committed golden,
    plus the report-shape / verdict cross-check / path-invariance guards.
    Returns (ok, failures)."""
    failures = []
    for fx in FIXTURES:
        rep = build_report_dict(fx["rel"], fx["kind"])
        for line in _regen_guard(fx, rep):
            failures.append(line)
        for fmt in MACHINE_FORMATS:
            name = "%s --format %s" % (fx["name"], fmt)
            gpath = golden_path(fx["name"], fmt)
            data = emit(rep, fmt)
            leak = _path_leak(data)
            if leak:
                failures.append("  %s: emitted bytes leak a path: %s"
                                % (name, leak))
            if not os.path.isfile(gpath):
                failures.append("  MISSING golden for %r (run --update)." % name)
                continue
            with open(gpath, "rb") as fh:
                golden = fh.read()
            if _path_leak(golden):
                failures.append("  %s: COMMITTED golden %s leaks a path"
                                % (name, os.path.basename(gpath)))
            if data != golden:
                failures.append(
                    "  DRIFT %r vs %s (golden %d bytes, now %d bytes)"
                    % (name, os.path.basename(gpath), len(golden), len(data)))
    ok = not failures
    total = len(FIXTURES) * len(MACHINE_FORMATS)
    if verbose:
        if ok:
            sys.stdout.write("OK: %d machine-format golden(s) match.\n" % total)
        else:
            sys.stdout.write("FAIL: %d machine-format golden issue(s):\n"
                             % len(failures))
            for ln in failures:
                sys.stdout.write(ln + "\n")
            sys.stdout.write("\nIf INTENTIONAL, re-baseline with:\n"
                             "  python3 test_format_regression.py --update\n")
    return ok, failures


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    regen = ("--update" in argv) or (os.environ.get("REGEN") == "1")
    if regen:
        n = write_goldens()
        sys.stdout.write("Regenerated %d machine-format golden(s) in %s\n"
                         % (n, os.path.relpath(GOLDEN_DIR, HERE)))
        return 0
    ok, _ = check(verbose=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
