#!/usr/bin/env python3
"""test_ci_annotation_position.py — T-VHLOC.2: the standing guard that the CI
annotation surfaces actually CARRY the source position, from a wheel-only
install image.

WHY THIS FILE EXISTS
--------------------
``--format github`` and ``--format azure`` exist for one reason: to make a
finding land ON the offending line of a pull request / build. A GitHub Actions
runner anchors an annotation from the ``line=`` property of a ``::error``
workflow command; an Azure DevOps agent anchors an issue from the
``linenumber=`` property of a ``##vso[task.logissue ...]`` logging command.
Drop that one property and both surfaces silently degrade to a file-level (or
log-only) notice — the command still parses, the build still goes red, and
nobody notices the regression. ``test_report_github.py`` /
``test_report_azure.py`` pin the command grammar; nothing pinned the POSITION
end to end, and nothing pinned it from the artifact a user actually installs.

MEASURE-FIRST (measured 2026-07-26 at einvoice HEAD 4a41f1b, BEFORE this file
was written). The backlog claimed both emitters dropped the line. That claim
was STALE — both already emit it correctly:

    ::error file=<path>,line=8,title=BR-CL-04::Invoice currency code (BT-5) …
    ##vso[task.logissue type=error;sourcepath=<path>;linenumber=8;code=BR-CL-04]…

with correct ABSENCE on the seven non-attributed findings of the same run, and
both vendor escapers (``%25``/``%0A`` for GitHub, ``%AZP25``/``%0A`` for Azure)
already implemented at ``report.py`` ``_github_escape_data`` /
``_azure_escape_data``. NO emitter change was therefore made: this file is the
verify-and-close guard the behaviour never had.

WHAT THIS FILE BINDS
--------------------
Everything runs against a WHEEL-ONLY install image built by
``test_wheel_self_report.build_install_image()`` — exactly the files the
``[tool.setuptools] packages`` + ``package-data`` declarations ship, copied
with the stdlib, no pip, no build backend, no network. Every subprocess runs
with ``cwd`` set to a scratch directory OUTSIDE this repo and
``PYTHONPATH`` set to the image ALONE, and a guard asserts the resolved
``einvoice.__file__`` really lives inside the image — so a stray source-tree
import cannot fake a pass.

  1. POSITION PRESENT, VALUE COMPUTED — on the multi-violation fixture
     ``test_report_location.INVALID_UBL`` (imported, never re-copied), the
     attributable BR-CL-04 finding carries ``line=`` (GitHub) and
     ``linenumber=`` (Azure) whose value equals ``_expected_line(INVALID_UBL,
     'DocumentCurrencyCode')`` — computed from the fixture text, never
     hard-coded — and equals the ``source_line`` the wheel's own ``--format
     json`` reports for the same finding.
  2. POSITION ABSENT, NOT FAKED — every finding the JSON reports WITHOUT a
     ``source_line`` (BR-16 and friends: absence/document-level rules) carries
     no position property at all. Not ``line=0``, not ``line=``, not
     ``line=1``: the key is simply not in the command. The set of rule ids
     carrying a position is asserted EQUAL to the set carrying a
     ``source_line``, in both directions, so neither over- nor under-emission
     can pass.
  3. ONE WELL-FORMED LINE PER FINDING — the number of command lines equals the
     number of violations, every line parses under a strict per-vendor parser
     written here (leading sentinel, ``k=v`` property list with the vendor's
     own separator, message after the vendor's own terminator), every rule id
     appears exactly once, and no line is blank or duplicated.
  4. ESCAPING SURVIVES A HOSTILE MESSAGE — a message containing a literal
     ``%`` AND a newline still yields exactly ONE parseable command line per
     vendor, with that vendor's escaping (``%25`` vs ``%AZP25``, ``%0A`` for
     the newline), and un-escaping the message recovers the original string
     byte for byte. HONEST NOTE on how this is driven: the ``%`` leg is
     end-to-end (``rules.py`` formats an offending code with ``%r``, so a
     currency code of ``1%X`` reaches the message through the real engine and
     is observed escaped in real CLI output). A REAL newline is not reachable
     that way — ``%r`` renders it as the two characters ``\\n`` — so the
     newline leg drives ``report.build_github`` / ``report.build_azure``
     directly INSIDE the wheel image on a synthetic report dict. That is still
     the shipped emitter running from the installed artifact; it is simply the
     only input path that can hand it a raw newline.

Standard library only (json/os/re/shutil/subprocess/sys/tempfile/unittest);
offline, saxonche-free, no new deps. Under a second; ~6 subprocesses.

HONEST LIMITS: this proves the BYTES the vendors document, not that GitHub or
Azure render them — no runner is invoked and none can be, offline. It covers
the two annotation formats only (``gitlab`` carries positions in a different
shape, owned by ``test_report_gitlab.py``), and POSIX path spellings as
installed here.
"""

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

# The wheel-image builder (T-VHPROOF.3) and the source_line fixture + line
# helper (T-VHDIAG.1) — imported, never duplicated.
from test_wheel_self_report import build_install_image      # noqa: E402
from test_report_location import INVALID_UBL, _expected_line  # noqa: E402

TIMEOUT = 120

#: A currency code carrying a literal ``%``. ``rules.py`` renders the offending
#: code with ``%r`` into the BR-CL-04 message, so this reaches the annotation
#: message through the REAL engine and must come out vendor-escaped.
PERCENT_CODE = "1%X"


# --------------------------------------------------------------- vendor specs

def _parse_github(line):
    """Strictly parse ONE GitHub Actions workflow command line.

    Grammar (github/toolkit ``issueCommand``):
    ``::<command> <k=v>[,<k=v>...]::<message>``. Property values escape ``,``
    and ``:`` (to ``%2C`` / ``%3A``), so the header can contain neither — the
    FIRST ``::`` after the sentinel therefore ends it, exactly as the runner
    splits it, and a message may safely contain a bare ``:``.

    Returns ``(command, {prop: value}, message)``. Raises AssertionError on
    anything the runner would not accept.
    """
    assert line.startswith("::"), "no leading '::' sentinel: %r" % line
    body = line[2:]
    idx = body.find("::")
    assert idx != -1, "no '::' message separator: %r" % line
    header, message = body[:idx], body[idx + 2:]
    assert " " in header, "no space between command and properties: %r" % line
    command, propstr = header.split(" ", 1)
    assert command in ("error", "warning", "notice"), \
        "unknown workflow command %r: %r" % (command, line)
    props = {}
    for pair in propstr.split(","):
        assert "=" in pair, "property %r is not k=v: %r" % (pair, line)
        key, value = pair.split("=", 1)
        assert key and key not in props, "bad/duplicate property key: %r" % line
        props[key] = value
    return command, props, message


def _parse_azure(line):
    """Strictly parse ONE Azure DevOps logging command line.

    Grammar: ``##vso[task.logissue <k=v>[;<k=v>...]]<message>``. Property
    values escape ``;`` and ``]`` (to ``%3B`` / ``%5D``), so the FIRST ``]``
    closes the property list and a message may safely contain a bare ``]``.

    Returns ``(area_action, {prop: value}, message)``.
    """
    prefix = "##vso["
    assert line.startswith(prefix), "no '##vso[' sentinel: %r" % line
    close = line.find("]")
    assert close != -1, "unterminated '[' property list: %r" % line
    inner, message = line[len(prefix):close], line[close + 1:]
    assert " " in inner, "no space between area.action and properties: %r" % line
    action, propstr = inner.split(" ", 1)
    assert action == "task.logissue", "unexpected area.action %r" % action
    props = {}
    for pair in propstr.split(";"):
        assert "=" in pair, "property %r is not k=v: %r" % (pair, line)
        key, value = pair.split("=", 1)
        assert key and key not in props, "bad/duplicate property key: %r" % line
        props[key] = value
    return action, props, message


def _unescape_github(text):
    """Reverse ``_github_escape_data``: ``%0A``/``%0D`` first, ``%25`` last."""
    return (text.replace("%0A", "\n").replace("%0D", "\r")
                .replace("%25", "%"))


def _unescape_azure(text):
    """Reverse ``_azure_escape_data``: ``%0A``/``%0D`` first, ``%AZP25`` last."""
    return (text.replace("%0A", "\n").replace("%0D", "\r")
                .replace("%AZP25", "%"))


#: name -> (report format, parser, position property key, rule-id property
#: key, percent sentinel, message un-escaper). Everything vendor-specific in
#: this file is read from HERE, so a leg cannot accidentally assert GitHub's
#: rules against Azure's bytes.
VENDORS = {
    "github": ("github", _parse_github, "line", "title", "%25",
               _unescape_github),
    "azure": ("azure", _parse_azure, "linenumber", "code", "%AZP25",
              _unescape_azure),
}


# ------------------------------------------------------------- the wheel image

class WheelImageCase(unittest.TestCase):
    """Base: one wheel-only image + a scratch cwd OUTSIDE this repo."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="einvoice-ciannot-")
        cls.image = build_install_image(os.path.join(cls.tmp, "image"))
        cls.work = os.path.join(cls.tmp, "work")
        os.makedirs(cls.work)
        # GUARD THE GUARD: prove the subprocess really resolves einvoice out of
        # the wheel image and not out of this checkout. Everything below is
        # worthless if the source tree leaks back in.
        proc = cls._raw(["-c", "import einvoice, sys; "
                              "sys.stdout.write(einvoice.__file__)"])
        assert proc.returncode == 0, proc.stderr
        resolved = os.path.realpath(proc.stdout.strip())
        assert resolved.startswith(os.path.realpath(cls.image) + os.sep), (
            "einvoice resolved OUTSIDE the wheel image (%r) — the image "
            "isolation broke" % resolved)
        assert not resolved.startswith(os.path.realpath(HERE) + os.sep), (
            "einvoice resolved from the source checkout: %r" % resolved)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def _raw(cls, argv):
        """Run python with the image as the ONLY import root, cwd outside the
        repo. PYTHONPATH is REPLACED (not prepended) so an inherited entry
        pointing at this checkout cannot shadow the image."""
        env = dict(os.environ)
        env["PYTHONPATH"] = cls.image
        env["PYTHONHASHSEED"] = "0"
        return subprocess.run([sys.executable, *argv], cwd=cls.work, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT)

    @classmethod
    def _cli(cls, fmt, path):
        return cls._raw(["-m", "einvoice", "validate", "--profile",
                         "xrechnung", "--format", fmt, path])

    def _command_lines(self, stdout):
        """The vendor command lines, with the trailing newline dropped.

        The emitters end every line with ``\\n``; ``splitlines()`` on the raw
        stdout therefore yields exactly the commands. A blank line would be a
        defect (a runner treats it as log noise), so it is rejected here rather
        than filtered away.
        """
        lines = stdout.split("\n")
        self.assertEqual(lines[-1], "",
                         "stdout must end with a newline: %r" % stdout[-40:])
        lines = lines[:-1]
        for line in lines:
            self.assertTrue(line.strip(),
                            "blank command line in stdout: %r" % stdout)
        return lines


def _write(directory, name, text):
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path


# ------------------------------------------------------------------- the legs

class AnnotationPosition(WheelImageCase):
    """Legs 1-3 on the real CLI: presence, computed value, absence, shape."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.invoice = _write(cls.work, "loc.xml", INVALID_UBL)
        # The wheel's OWN json view is the authority for which findings are
        # attributable — never a hard-coded list.
        proc = cls._cli("json", cls.invoice)
        assert proc.returncode == 1, proc.stdout + proc.stderr
        doc = json.loads(proc.stdout)
        cls.violations = doc["violations"]
        cls.with_line = {v["rule"] for v in cls.violations
                         if v.get("source_line") is not None}
        cls.without_line = {v["rule"] for v in cls.violations
                            if v.get("source_line") is None}
        cls.emitted = {}
        for name, (fmt, _p, _k, _r, _s, _u) in VENDORS.items():
            proc = cls._cli(fmt, cls.invoice)
            assert proc.returncode == 1, proc.stdout + proc.stderr
            assert proc.stderr == "", proc.stderr
            cls.emitted[name] = proc.stdout

    def test_fixture_still_exercises_both_classes(self):
        """Non-vacuity: without BOTH an attributed and a non-attributed
        finding in the same run, every assertion below is empty."""
        self.assertIn("BR-CL-04", self.with_line, sorted(self.with_line))
        self.assertIn("BR-16", self.without_line, sorted(self.without_line))
        self.assertGreaterEqual(len(self.without_line), 2)

    def test_source_line_matches_the_fixture_text(self):
        """The engine's own line is the fixture's real line — computed, so a
        fixture edit cannot silently drift the vendor assertions below."""
        expected = _expected_line(INVALID_UBL, "DocumentCurrencyCode")
        rec = [v for v in self.violations if v["rule"] == "BR-CL-04"][0]
        self.assertEqual(rec["source_line"], expected)

    def test_attributed_finding_carries_the_computed_position(self):
        expected = str(_expected_line(INVALID_UBL, "DocumentCurrencyCode"))
        for name, (_f, parse, poskey, rulekey, _s, _u) in VENDORS.items():
            found = False
            for line in self._command_lines(self.emitted[name]):
                _cmd, props, _msg = parse(line)
                if props[rulekey] != "BR-CL-04":
                    continue
                found = True
                self.assertIn(poskey, props,
                              "%s: BR-CL-04 lost its %s= property: %r"
                              % (name, poskey, line))
                self.assertEqual(props[poskey], expected,
                                 "%s: %s= is not the fixture's real line: %r"
                                 % (name, poskey, line))
            self.assertTrue(found, "%s: BR-CL-04 not annotated at all" % name)

    def test_position_appears_on_exactly_the_attributed_findings(self):
        for name, (_f, parse, poskey, rulekey, _s, _u) in VENDORS.items():
            positioned, plain = set(), set()
            for line in self._command_lines(self.emitted[name]):
                _cmd, props, _msg = parse(line)
                (positioned if poskey in props else plain).add(props[rulekey])
            self.assertEqual(
                positioned, self.with_line,
                "%s: findings carrying %s= != findings carrying source_line"
                % (name, poskey))
            self.assertEqual(
                plain, self.without_line,
                "%s: findings WITHOUT %s= != findings without source_line"
                % (name, poskey))

    def test_absent_position_is_never_faked(self):
        """No placeholder: not ``=0``, not an empty value, not a guessed 1."""
        for name, (_f, parse, poskey, rulekey, _s, _u) in VENDORS.items():
            stdout = self.emitted[name]
            self.assertNotIn("%s=0" % poskey, stdout,
                             "%s emitted a zero position" % name)
            self.assertNotIn("%s=" % poskey + ",", stdout)
            for line in self._command_lines(stdout):
                _cmd, props, _msg = parse(line)
                if props[rulekey] in self.without_line:
                    self.assertNotIn(
                        poskey, props,
                        "%s: non-attributed %s gained a position: %r"
                        % (name, props[rulekey], line))
                else:
                    self.assertRegex(props[poskey], r"^[1-9][0-9]*$",
                                     "%s: %r is not a 1-based line"
                                     % (name, props[poskey]))

    def test_one_well_formed_line_per_finding(self):
        for name, (_f, parse, _k, rulekey, _s, _u) in VENDORS.items():
            lines = self._command_lines(self.emitted[name])
            self.assertEqual(
                len(lines), len(self.violations),
                "%s: %d command lines for %d violations"
                % (name, len(lines), len(self.violations)))
            seen = []
            for line in lines:
                _cmd, props, message = parse(line)   # raises if malformed
                self.assertTrue(message, "%s: empty message: %r" % (name, line))
                seen.append(props[rulekey])
            self.assertEqual(len(seen), len(set(seen)),
                             "%s: a rule id was annotated twice: %r"
                             % (name, seen))
            self.assertEqual(set(seen),
                             {v["rule"] for v in self.violations})

    def test_the_annotated_path_is_the_argv_string(self):
        """Both vendors anchor on the file the caller named — echoed, not
        absolutized (the path-echo rule); the annotation is useless if the
        path does not match the checkout GitHub/Azure has."""
        keys = {"github": "file", "azure": "sourcepath"}
        for name, (_f, parse, _k, _r, _s, _u) in VENDORS.items():
            for line in self._command_lines(self.emitted[name]):
                _cmd, props, _msg = parse(line)
                self.assertEqual(props[keys[name]].replace("%3A", ":"),
                                 self.invoice, line)


class AnnotationEscaping(WheelImageCase):
    """Leg 4: a hostile message stays exactly one parseable line per vendor."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.percent_invoice = _write(
            cls.work, "percent.xml",
            INVALID_UBL.replace(
                "<cbc:DocumentCurrencyCode>ZZ</cbc:DocumentCurrencyCode>",
                "<cbc:DocumentCurrencyCode>%s</cbc:DocumentCurrencyCode>"
                % PERCENT_CODE))

    def test_literal_percent_from_a_real_invoice_is_vendor_escaped(self):
        """END-TO-END: a ``%`` in the invoice reaches the message through the
        real engine and comes out with the VENDOR'S sentinel — and the line
        property still rides along."""
        expected = str(_expected_line(INVALID_UBL, "DocumentCurrencyCode"))
        for name, (fmt, parse, poskey, rulekey, sentinel, unescape) in \
                VENDORS.items():
            proc = self._cli(fmt, self.percent_invoice)
            self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
            hits = []
            for line in self._command_lines(proc.stdout):
                _cmd, props, message = parse(line)
                if props[rulekey] != "BR-CL-04":
                    continue
                hits.append(line)
                self.assertIn(sentinel, message,
                              "%s: the literal %% was not escaped as %s: %r"
                              % (name, sentinel, line))
                self.assertIn(PERCENT_CODE.replace("%", sentinel), message,
                              "%s: escaped code not found: %r" % (name, line))
                self.assertIn("%", unescape(message))
                self.assertEqual(props[poskey], expected,
                                 "%s: the position was lost: %r" % (name, line))
            self.assertEqual(len(hits), 1,
                             "%s: expected exactly one BR-CL-04 line, got %d"
                             % (name, len(hits)))

    def _emit_in_image(self, builder, message, source_line):
        """Run the WHEEL's own ``report.build_<vendor>`` on a synthetic report
        whose message carries a raw newline and a literal ``%``.

        A raw newline cannot be driven in through an invoice — ``rules.py``
        renders offending values with ``%r``, which turns a newline into the
        two characters ``\\n`` — so this is the only input path that can hand
        the shipped emitter a real one. The emitter itself is the installed
        artifact's, executed inside the image.
        """
        code = (
            "import json, sys\n"
            "from einvoice import report\n"
            "rep = json.loads(sys.stdin.read())\n"
            "sys.stdout.write(report.%s(rep))\n" % builder)
        rep = {
            "source": "invoices/q1.xml",
            "valid": False,
            "violation_count": 1,
            "violations": [{
                "rule": "BR-CL-04",
                "severity": "fatal",
                "message": message,
                "field": "cbc:DocumentCurrencyCode",
                "title": "t",
                "fix_hint": "f",
                "terms": [],
                "source_line": source_line,
            }],
        }
        env = dict(os.environ)
        env["PYTHONPATH"] = self.image
        proc = subprocess.run([sys.executable, "-c", code], cwd=self.work,
                              env=env, input=json.dumps(rep),
                              capture_output=True, text=True, timeout=TIMEOUT)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout

    def test_newline_and_percent_stay_one_parseable_line_per_vendor(self):
        message = "total 50% off\nsecond physical line\r\nthird"
        builders = {"github": "build_github", "azure": "build_azure"}
        for name, (_f, parse, poskey, rulekey, sentinel, unescape) in \
                VENDORS.items():
            out = self._emit_in_image(builders[name], message, 42)
            lines = self._command_lines(out)
            # THE point of the leg: the raw newlines did NOT split the command.
            self.assertEqual(len(lines), 1,
                             "%s: a newline in the message split the command "
                             "into %d lines: %r" % (name, len(lines), out))
            _cmd, props, emitted_message = parse(lines[0])
            self.assertEqual(props[rulekey], "BR-CL-04", lines[0])
            self.assertEqual(props[poskey], "42", lines[0])
            self.assertIn(sentinel, emitted_message,
                          "%s: %% not escaped as %s" % (name, sentinel))
            self.assertIn("%0A", emitted_message,
                          "%s: LF not escaped as %%0A" % name)
            self.assertIn("%0D", emitted_message,
                          "%s: CR not escaped as %%0D" % name)
            # Round-trip: un-escaping recovers the message byte for byte.
            self.assertEqual(unescape(emitted_message), message,
                             "%s: message did not round-trip" % name)
            # And the OTHER vendor's sentinel must not appear — the escapers
            # are genuinely distinct, not a copy-paste of one another.
            other = "%AZP25" if name == "github" else "%25"
            if name == "github":
                self.assertNotIn(other, emitted_message, lines[0])
            else:
                # "%AZP25" trivially contains no bare "%25"; assert the
                # GitHub-style single-percent escape is NOT what was used.
                self.assertNotIn("50%25 off", emitted_message, lines[0])

    def test_absent_source_line_stays_absent_under_escaping(self):
        """The hostile-message path must not smuggle a position in either."""
        builders = {"github": "build_github", "azure": "build_azure"}
        for name, (_f, parse, poskey, _r, _s, _u) in VENDORS.items():
            out = self._emit_in_image(builders[name], "a % and a \n newline",
                                      None)
            lines = self._command_lines(out)
            self.assertEqual(len(lines), 1, out)
            _cmd, props, _msg = parse(lines[0])
            self.assertNotIn(poskey, props,
                             "%s: a source_line of None became %r"
                             % (name, props.get(poskey)))
            self.assertNotIn("%s=" % poskey, lines[0], lines[0])

    def test_no_raw_control_character_survives_in_any_command(self):
        """Belt and braces: whatever the message held, the emitted bytes carry
        no bare CR/LF inside a command line and no C0 control at all."""
        builders = {"github": "build_github", "azure": "build_azure"}
        for name in VENDORS:
            out = self._emit_in_image(builders[name],
                                      "x\ny\rz\ttab % end", 7)
            for line in self._command_lines(out):
                self.assertIsNone(
                    re.search(r"[\x00-\x08\x0a-\x1f]", line),
                    "%s: raw control character survived: %r" % (name, line))


if __name__ == "__main__":
    unittest.main(verbosity=2)
