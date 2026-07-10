#!/usr/bin/env python3
"""gen_examples.py — (re)generate the committed report.json for every
onboarding example under einvoice/examples/.

The committed reports are NEVER hand-written. This generator drives the SAME
entry point an end user runs —

    python3 -m einvoice.report <example>/broken.xml --format json

— captures its exact JSON, and writes it (pretty-printed, key-sorted, so the
file is diff-stable and readable) to <example>/report.json. Because the report
is produced by the real engine, the committed file cannot silently drift from
what the tool actually emits: test_examples.py re-runs the engine and fails if
any committed report.json differs from live output.

No new dependencies (standard library only), no network. Run from anywhere:

    python3 gen_examples.py            # rewrite every report.json
    python3 gen_examples.py --check    # exit 1 if any committed report is stale

See examples/README.md for the human walkthrough and examples/*/broken.xml for
the provenance of each fixture (all minimal mutations of a real, valid
corpus/vendored/valid/*.xml document).
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXAMPLES_DIR = os.path.join(HERE, "examples")


def find_example_dirs():
    """Return the sorted list of example directories (each holding broken.xml)."""
    if not os.path.isdir(EXAMPLES_DIR):
        return []
    dirs = []
    for name in sorted(os.listdir(EXAMPLES_DIR)):
        d = os.path.join(EXAMPLES_DIR, name)
        if os.path.isdir(d) and os.path.isfile(os.path.join(d, "broken.xml")):
            dirs.append(d)
    return dirs


def live_report_json(broken_path):
    """Drive the real CLI on broken_path and return its parsed JSON report.

    Invoked exactly as a user would: ``python3 -m einvoice.report <file>
    --format json``. The working directory is pinned to the package root and
    the path is passed RELATIVE to it, so the report's ``source`` field (and
    therefore the committed file) is stable regardless of where this script is
    run from. The broken invoices intentionally fail, so a non-zero exit code
    is expected and NOT treated as an error here.
    """
    rel = os.path.relpath(broken_path, HERE)
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice.report", rel, "--format", "json"],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    out = proc.stdout.decode("utf-8")
    if not out.strip():
        raise SystemExit(
            "gen_examples: engine produced no JSON for %s\n%s"
            % (rel, proc.stderr.decode("utf-8")))
    return json.loads(out)


def render(report):
    """Canonical, diff-stable serialization of a report dict for committing."""
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    check_only = "--check" in argv

    dirs = find_example_dirs()
    if not dirs:
        sys.stderr.write("gen_examples: no example directories found under %s\n"
                         % EXAMPLES_DIR)
        return 1

    stale = []
    for d in dirs:
        broken = os.path.join(d, "broken.xml")
        report_path = os.path.join(d, "report.json")
        text = render(live_report_json(broken))
        if check_only:
            current = None
            if os.path.isfile(report_path):
                with open(report_path, encoding="utf-8") as fh:
                    current = fh.read()
            if current != text:
                stale.append(os.path.relpath(report_path, HERE))
        else:
            with open(report_path, "w", encoding="utf-8") as fh:
                fh.write(text)
            sys.stdout.write("wrote %s\n" % os.path.relpath(report_path, HERE))

    if check_only:
        if stale:
            sys.stderr.write(
                "gen_examples: STALE report(s) — re-run `python3 "
                "gen_examples.py`:\n  " + "\n  ".join(stale) + "\n")
            return 1
        sys.stdout.write("gen_examples: all committed reports are current\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
