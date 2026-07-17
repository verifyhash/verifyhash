#!/usr/bin/env python3
"""test_path_invariance.py — T-VHENV.2: pin WORKING-DIRECTORY + PATH-
PRESENTATION INVARIANCE for the einvoice CLI: validating the SAME file must
yield the identical verdict and exit code whether the caller passes a bare
relative filename from the file's own directory or an absolute path from any
other cwd — and the emitted reports must never leak the tool's own
machine-internal paths.

MEASURE-FIRST FINDINGS (measured 2026-07-17, BEFORE this file was written)
---------------------------------------------------------------------------
One valid fixture (corpus/vendored/valid/cen-bis3-positive_ubl.xml, validate
exit 0) and one invalid fixture (fixtures/creditnote-invalid-typecode_ubl.xml,
validate exit 1) were each run through ``python3 -m einvoice validate`` (text
and --json) and ``python3 -m einvoice.report --format json / --format sarif``
twice: once with cwd = the fixture's parent directory using the bare filename,
once from a different cwd (/tmp and a fresh temp dir) using the absolute path.

  * Verdicts and exit codes were IDENTICAL in every pair (valid: 0/PASS,
    invalid: 1/FAIL for validate; einvoice.report applies its own default
    profile and both legs again agreed byte-for-byte on everything).
  * PATH-ECHO RULE (the measured rule, now documented in REPORT-FORMATS.md
    "Path echo"): every surface echoes the input path EXACTLY as supplied on
    argv — never absolutized, resolved, or rewritten. The path appears in the
    text PASS:/FAIL: verdict line and the json ``source`` field; cli.py's
    ``display_path = path`` (with "-" for stdin) is the whole mechanism.
  * SARIF contains NO filesystem path at all: findings are anchored by
    ``logicalLocations`` (element names), never physicalLocation/
    artifactLocation; the only URIs are static rule/help URLs. The
    relative-path and absolute-path SARIF documents were BYTE-IDENTICAL.
  * No leakage: with the user-supplied path string removed from the report
    bytes, neither the home directory nor the package's install dir appeared
    anywhere in json or sarif output.

ZERO divergence and ZERO leakage were measured, so per the task spec NO
product source was modified: this file pins the already-true property as a
regression guard (verify-and-close).

WHAT THIS FILE BINDS
--------------------
Every invocation is a REAL subprocess (``python3 -m einvoice`` /
``python3 -m einvoice.report``) with an EXPLICIT cwd= per leg (the fixture's
parent dir, this repo dir, or a fresh tempfile.TemporaryDirectory) and an env
that only prepends this directory to PYTHONPATH so the package resolves from
any cwd — the product itself pins nothing.

  1. relative-from-parent vs absolute-from-temp-cwd on the same file must
     yield the identical exit code, and identical output bytes once the
     user-supplied path string is normalized to a placeholder (i.e. reports
     may differ ONLY in the echoed path, per the documented rule) — valid and
     invalid fixture, text and json.
  2. json ``source`` must be the argv string VERBATIM (relative stays
     relative, absolute stays absolute) — the path-echo rule itself.
  3. NO internal-absolute-path leakage in json and sarif: after removing
     every occurrence of the user-supplied path string from the report bytes,
     the remainder contains neither os.path.expanduser('~') nor the einvoice
     package's own install dir prefix (both computed here, nothing
     hardcoded). A relative invocation must additionally contain them
     nowhere at all, and sarif must contain no path in ANY leg.
  4. cwd itself never changes the output: the same absolute-path invocation
     from two different fresh temp cwds and from this repo dir must be
     byte-identical (stdout, stderr, exit code).

HONEST LIMITS: this pins the CLI surface on POSIX paths as installed here;
library callers who print their own paths, and exotic path spellings
(symlinked cwds, UNC paths), are outside its scope.

Standard library only (json/os/shutil/subprocess/sys/tempfile/unittest);
offline, saxonche-free, no new deps — test_packaging.py stays green.
~30 subprocess runs, well under a minute.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))

# Same canonical pass/fail pair test_cli.py and test_env_invariance.py use.
VALID_FIXTURE = os.path.join(
    "corpus", "vendored", "valid", "cen-bis3-positive_ubl.xml")
INVALID_FIXTURE = os.path.join(
    "fixtures", "creditnote-invalid-typecode_ubl.xml")

#: (repo-relative fixture, expected ``einvoice validate`` exit code)
FIXTURES = ((VALID_FIXTURE, 0), (INVALID_FIXTURE, 1))

PLACEHOLDER = b"{{INPUT-PATH}}"

TIMEOUT = 120


def _env():
    """Runner env with HERE prepended to PYTHONPATH.

    The subprocess legs deliberately run from cwds where the package is NOT
    importable via the script directory (a temp dir, a fixture dir), so the
    harness — not the product — supplies the import path. Only PYTHONPATH is
    touched; PYTHONHASHSEED is fixed to keep the hash-seed axis (owned by
    test_idempotence.py) from confounding a byte comparison.
    """
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONHASHSEED"] = "0"
    return env


def _run(module, cli_args, cwd):
    """Run ``python3 -m <module> <cli_args>`` with an explicit cwd."""
    return subprocess.run(
        [sys.executable, "-m", module, *cli_args],
        cwd=cwd, capture_output=True, env=_env(), timeout=TIMEOUT)


def _normalize(raw, supplied_path):
    """Replace every occurrence of the user-supplied path with a placeholder.

    Per the documented path-echo rule the supplied argv string is the ONLY
    thing allowed to differ between a relative and an absolute invocation of
    the same file, so after this substitution the outputs must be
    byte-identical.
    """
    return raw.replace(supplied_path.encode("utf-8"), PLACEHOLDER)


class TestPathInvariance(unittest.TestCase):
    """Relative vs absolute vs cwd: identical verdicts, no path leakage."""

    maxDiff = None

    @classmethod
    def setUpClass(cls):
        for rel, _ in FIXTURES:
            if not os.path.isfile(os.path.join(HERE, rel)):
                raise AssertionError("required fixture missing: %s" % rel)
        # Computed forbidden prefixes for the leakage check — NOT hardcoded.
        cls.home = os.path.expanduser("~").encode("utf-8")
        import einvoice  # resolvable: HERE is this script's directory
        cls.pkg_dir = os.path.dirname(
            os.path.abspath(einvoice.__file__)).encode("utf-8")
        # Guard the guard: if either prefix were degenerate ("", "/"), the
        # leakage assertions below would be vacuous or absurd.
        assert len(cls.home) > 1 and len(cls.pkg_dir) > 1

    # ---------------------------------------------------------------- legs

    def _legs(self, rel_fixture):
        """Yield (label, supplied_path, cwd, cleanup) for the two task legs.

        Leg A: cwd = the fixture's parent directory, bare relative filename.
        Leg B: cwd = a fresh temp directory, absolute path.
        """
        parent = os.path.join(HERE, os.path.dirname(rel_fixture))
        basename = os.path.basename(rel_fixture)
        abspath = os.path.join(HERE, rel_fixture)
        tmp = tempfile.TemporaryDirectory(prefix="einvoice-pathinv-")
        return [
            ("relative-from-parent", basename, parent, None),
            ("absolute-from-temp-cwd", abspath, tmp.name, tmp),
        ]

    # --------------------------------------------------------------- tests

    def test_relative_vs_absolute_validate_text_and_json(self):
        """(a) validate: identical verdict + exit, path echoed as supplied.

        Both fixtures x both forms (text, --json). The two legs must agree on
        the exit code (which must be the KNOWN verdict, so a matrix of
        identical crashes cannot pass), on stderr, and on every output byte
        once the supplied path is normalized to a placeholder. For --json the
        ``source`` field must equal the argv string verbatim and the rest of
        the parsed document must be EQUAL — findings may not shift at all.
        """
        for rel_fixture, want_exit in FIXTURES:
            for extra, form in (([], "text"), (["--json"], "json")):
                results = []
                for label, supplied, cwd, tmp in self._legs(rel_fixture):
                    try:
                        proc = _run("einvoice",
                                    ["validate", supplied, *extra], cwd)
                    finally:
                        if tmp is not None:
                            tmp.cleanup()
                    tag = "[%s %s %s]" % (rel_fixture, form, label)
                    self.assertEqual(
                        proc.returncode, want_exit,
                        "%s exit %d != expected %d (stderr: %r)"
                        % (tag, proc.returncode, want_exit,
                           proc.stderr[:400]))
                    # The echoed path must appear AS SUPPLIED in the output.
                    self.assertIn(
                        supplied.encode("utf-8"), proc.stdout,
                        "%s stdout does not echo the supplied path" % tag)
                    if form == "json":
                        doc = json.loads(proc.stdout.decode("utf-8"))
                        self.assertEqual(
                            doc.get("source"), supplied,
                            "%s json 'source' is not the argv string "
                            "verbatim" % tag)
                        rest = dict(doc)
                        del rest["source"]
                        results.append((label, supplied, proc, rest))
                    else:
                        results.append((label, supplied, proc, None))
                (la, pa, a, resta), (lb, pb, b, restb) = results
                ctx = "[%s %s] %s vs %s" % (rel_fixture, form, la, lb)
                self.assertEqual(
                    _normalize(a.stdout, pa), _normalize(b.stdout, pb),
                    "%s: stdout differs beyond the echoed path" % ctx)
                self.assertEqual(
                    _normalize(a.stderr, pa), _normalize(b.stderr, pb),
                    "%s: stderr differs beyond the echoed path" % ctx)
                if form == "json":
                    self.assertEqual(
                        resta, restb,
                        "%s: json fields other than 'source' differ" % ctx)

    def test_no_internal_absolute_path_leakage_json_and_sarif(self):
        """(b) json + sarif: no home-dir / install-dir leakage.

        For both fixtures, each machine surface (validate --json,
        einvoice.report --format json, einvoice.report --format sarif) is run
        in both legs. After removing every occurrence of the user-supplied
        path string from the report bytes, the remainder must contain neither
        os.path.expanduser('~') nor the einvoice package's install dir —
        both computed in setUpClass, nothing hardcoded. Extra pins per the
        measured rule: a RELATIVE invocation contains those prefixes nowhere
        at all (nothing was absolutized), and sarif contains no path in ANY
        leg (it has no filesystem-path field).
        """
        surfaces = [
            ("einvoice", ["validate"], ["--json"], "validate-json"),
            ("einvoice.report", ["--format", "json"], [], "report-json"),
            ("einvoice.report", ["--format", "sarif"], [], "report-sarif"),
        ]
        for rel_fixture, _ in FIXTURES:
            for module, pre, post, sname in surfaces:
                for label, supplied, cwd, tmp in self._legs(rel_fixture):
                    try:
                        proc = _run(module, [*pre, supplied, *post], cwd)
                    finally:
                        if tmp is not None:
                            tmp.cleanup()
                    tag = "[%s %s %s]" % (rel_fixture, sname, label)
                    self.assertIn(
                        proc.returncode, (0, 1, 3),
                        "%s unexpected exit %d (stderr: %r)"
                        % (tag, proc.returncode, proc.stderr[:400]))
                    supplied_b = supplied.encode("utf-8")
                    if sname == "report-sarif":
                        # Measured rule: sarif embeds NO filesystem path.
                        self.assertNotIn(
                            supplied_b, proc.stdout,
                            "%s sarif embeds the input path — the "
                            "documented 'no path in sarif' rule broke" % tag)
                    remainder = proc.stdout.replace(supplied_b, b"")
                    for name, prefix in (("home dir", self.home),
                                         ("package install dir",
                                          self.pkg_dir)):
                        self.assertNotIn(
                            prefix, remainder,
                            "%s leaks the tool's %s (%r) beyond the "
                            "user-supplied path" % (tag, name, prefix))
                        if label == "relative-from-parent":
                            # Relative in => no absolute machine path out,
                            # even via the echo itself.
                            self.assertNotIn(
                                prefix, proc.stdout,
                                "%s absolutized a relative input (%s "
                                "appeared)" % (tag, name))

    def test_temp_cwd_never_changes_output(self):
        """(c) the SAME absolute-path invocation is cwd-proof, byte-for-byte.

        Both fixtures x (text, --json), each run from THREE cwds: two
        distinct fresh temp directories and this repo directory. Since the
        argv is identical in every leg, the documented rule demands fully
        byte-identical stdout/stderr and the identical (known) exit code —
        cwd alone may change NOTHING, verdict least of all.
        """
        for rel_fixture, want_exit in FIXTURES:
            abspath = os.path.join(HERE, rel_fixture)
            for extra, form in (([], "text"), (["--json"], "json")):
                ref = None
                for i in range(3):
                    if i < 2:
                        with tempfile.TemporaryDirectory(
                                prefix="einvoice-cwd%d-" % i) as tmp:
                            proc = _run("einvoice",
                                        ["validate", abspath, *extra], tmp)
                        cwd_label = "temp-cwd-%d" % i
                    else:
                        proc = _run("einvoice",
                                    ["validate", abspath, *extra], HERE)
                        cwd_label = "repo-dir"
                    tag = "[%s %s %s]" % (rel_fixture, form, cwd_label)
                    self.assertEqual(
                        proc.returncode, want_exit,
                        "%s exit %d != expected %d — cwd changed the "
                        "verdict (stderr: %r)"
                        % (tag, proc.returncode, want_exit,
                           proc.stderr[:400]))
                    if ref is None:
                        ref = (cwd_label, proc)
                        continue
                    self.assertEqual(
                        proc.stdout, ref[1].stdout,
                        "%s stdout differs from %s leg" % (tag, ref[0]))
                    self.assertEqual(
                        proc.stderr, ref[1].stderr,
                        "%s stderr differs from %s leg" % (tag, ref[0]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
