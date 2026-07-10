#!/usr/bin/env python3
"""Thin GitHub-Action runner for the einvoice conformance report.

This is the executable half of ``einvoice/action/action.yml``. It is a *thin
orchestrator*: every rule decision is made by the REAL, unmodified entrypoint
``python3 -m einvoice.report`` — this script re-implements NO validation logic,
defines NO second engine, and invents NO new output format. It only:

  1. enumerates the invoice files the caller pointed ``--path`` at (a single
     file, or every ``*.xml`` / ``*.pdf`` under a directory, dotfiles skipped —
     the SAME selection the report's own batch mode makes);
  2. runs ``python3 -m einvoice.report --format sarif <file>`` once per file
     and MERGES the per-file SARIF 2.1.0 documents into one, so the whole run
     can be handed to ``github/codeql-action/upload-sarif`` for inline PR
     annotations (SARIF merging is pure aggregation — it reorders/relabels
     nothing and adds no findings);
  3. also emits the caller-chosen console ``--format`` (json | junit | sarif |
     text) to stdout by driving the identical entrypoint
     ``python3 -m einvoice.report --format <format> [--recurse] <path>`` — the
     literal command the docs describe;
  4. sets the process exit code so the build fails per ``--fail-on``:
       * ``fatal``  (default) — fail iff any FATAL violation is present, exactly
         the entrypoint's own exit-code contract (exit 1 fatal / 3 unparseable);
       * ``warning`` — additionally fail when a WARNING-severity finding is
         present. Warnings are detected by PARSING THE JSON report the
         entrypoint already emits (``--format json`` → ``warning_count``); we do
         NOT add an engine flag for this.

Standard library only. No network. The runner locates the vendored ``einvoice``
package by walking up from its own directory (override with ``$EINVOICE_ROOT``),
so it works both in this repo and when the product is vendored into the Action
repository the consumer pins with ``uses: verifyhash/einvoice-action@vX``.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

# Exit codes — the entrypoint's contract, mirrored here (kept as literals so a
# drift in einvoice.report is caught by test_action.py, not silently followed).
EXIT_OK = 0
EXIT_FAIL = 1
EXIT_PARSE = 3

#: File extensions treated as invoices in directory mode. Matches
#: ``einvoice.report.BATCH_INVOICE_EXTS`` (``.xml`` UBL/CII, ``.pdf`` Factur-X).
INVOICE_EXTS = (".xml", ".pdf")

#: Console formats this Action exposes (a subset of the entrypoint's formats).
CONSOLE_FORMATS = ("json", "junit", "sarif", "text")


def find_root(start=None):
    """Return the directory that contains the importable ``einvoice`` package.

    Honors ``$EINVOICE_ROOT`` first; otherwise walks upward from this file's
    directory until it finds a folder holding ``einvoice/report.py``. Raising a
    clear error (rather than a bare ImportError later) if the package cannot be
    found keeps failures legible in a CI log.
    """
    override = os.environ.get("EINVOICE_ROOT")
    if override:
        return os.path.abspath(override)
    here = start or os.path.dirname(os.path.abspath(__file__))
    cur = here
    while True:
        if os.path.isfile(os.path.join(cur, "einvoice", "report.py")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            raise SystemExit(
                "error: could not locate the 'einvoice' package near %s; "
                "set $EINVOICE_ROOT to the directory that contains it." % here)
        cur = parent


def collect_files(path):
    """Deterministic, sorted list of invoice files under ``path``.

    A regular file is returned as ``[path]``. A directory is walked recursively
    for ``*.xml`` / ``*.pdf`` files; dotfiles and dot-directories are skipped so
    editor swap files, ``.git`` metadata and macOS resource forks are never
    validated. This mirrors ``einvoice.report.collect_invoice_files`` — it is
    file *selection*, not rule logic.
    """
    if os.path.isfile(path):
        return [path]
    if not os.path.isdir(path):
        raise SystemExit("error: no such file or directory: %s" % path)
    found = []
    for dirpath, dirnames, filenames in os.walk(path):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.startswith("."):
                continue
            if name.lower().endswith(INVOICE_EXTS):
                found.append(os.path.join(dirpath, name))
    return sorted(found)


def _entrypoint_cmd(root):
    """The base command that invokes the REAL report entrypoint."""
    return [sys.executable, "-m", "einvoice.report"]


def _run_report(root, args):
    """Run ``python3 -m einvoice.report <args>`` from the package root.

    Returns the completed process (``stdout``/``stderr`` captured, text mode).
    ``cwd`` is the package root and ``PYTHONPATH`` is prefixed with it so the
    vendored package imports whether or not it is pip-installed.
    """
    env = dict(os.environ)
    env["PYTHONPATH"] = root + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        _entrypoint_cmd(root) + list(args),
        cwd=root, env=env, capture_output=True, text=True)


def _empty_sarif():
    """A valid, empty SARIF 2.1.0 skeleton to merge per-file runs into."""
    return {
        "version": "2.1.0",
        "$schema": ("https://raw.githubusercontent.com/oasis-tcs/sarif-spec/"
                    "master/Schemata/sarif-schema-2.1.0.json"),
        "runs": [{
            "tool": {"driver": {"name": "einvoice",
                                "informationUri":
                                    "https://github.com/verifyhash/verifyhash",
                                "rules": []}},
            "results": [],
        }],
    }


def _merge_sarif(into, doc):
    """Merge a single-file SARIF ``doc`` into the aggregate ``into`` document.

    Aggregation only: results are concatenated and driver rules are unioned by
    ``id`` (deduplicated). No result is dropped, reordered relative to its file,
    relabelled, or synthesised — the merged document carries exactly the union
    of what the entrypoint reported per file.
    """
    dst_run = into["runs"][0]
    dst_rules = dst_run["tool"]["driver"]["rules"]
    seen = {r.get("id") for r in dst_rules}
    for run in doc.get("runs", []):
        for rule in run.get("tool", {}).get("driver", {}).get("rules", []):
            rid = rule.get("id")
            if rid not in seen:
                seen.add(rid)
                dst_rules.append(rule)
        dst_run["results"].extend(run.get("results", []))


def _count_levels(sarif_doc):
    """Count SARIF result levels across a document -> ``{level: n}``."""
    counts = {}
    for run in sarif_doc.get("runs", []):
        for res in run.get("results", []):
            lvl = res.get("level", "note")
            counts[lvl] = counts.get(lvl, 0) + 1
    return counts


def _set_output(name, value):
    """Emit a GitHub Actions step output (no-op when not running in Actions)."""
    out = os.environ.get("GITHUB_OUTPUT")
    if not out:
        return
    try:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write("%s=%s\n" % (name, value))
    except OSError:
        pass


def run(path, fmt, fail_on, sarif_file, profile, root=None):
    """Execute the action. Returns the process exit code.

    Separated from :func:`main` so tests can drive it directly with explicit
    arguments (and so the argument plumbing stays trivial).
    """
    if root is None:
        root = find_root()
    if fmt not in CONSOLE_FORMATS:
        sys.stderr.write("error: unknown format %r (choose from %s)\n"
                         % (fmt, ", ".join(CONSOLE_FORMATS)))
        return EXIT_FAIL
    if fail_on not in ("fatal", "warning"):
        sys.stderr.write("error: unknown fail-on %r (choose fatal or warning)\n"
                         % fail_on)
        return EXIT_FAIL

    files = collect_files(path)

    merged = _empty_sarif()
    total_fatal = 0
    total_warning = 0
    any_parse_error = False

    for f in files:
        # (1) SARIF projection of the REAL entrypoint, one file at a time.
        proc = _run_report(root, ["--profile", profile, "--format", "sarif", f])
        if proc.returncode not in (EXIT_OK, EXIT_FAIL, EXIT_PARSE):
            sys.stderr.write(
                "error: einvoice.report failed on %s (exit %d)\n%s\n"
                % (f, proc.returncode, proc.stderr))
            return EXIT_FAIL
        try:
            doc = json.loads(proc.stdout)
        except ValueError:
            sys.stderr.write(
                "error: einvoice.report produced no SARIF for %s\n%s\n"
                % (f, proc.stderr))
            return EXIT_FAIL
        _merge_sarif(merged, doc)

        if proc.returncode == EXIT_PARSE:
            # Unparseable / unsupported container: not a fatal *violation*, but
            # still a hard failure (the file could not be validated).
            any_parse_error = True
            continue

        levels = _count_levels(doc)
        total_fatal += levels.get("error", 0)

        if fail_on == "warning":
            # DISCIPLINE: detect warnings by parsing the JSON report the
            # entrypoint already emits — never by inventing an engine flag.
            jproc = _run_report(
                root, ["--profile", profile, "--format", "json", f])
            try:
                jdoc = json.loads(jproc.stdout)
                total_warning += jdoc.get("warning_count", 0)
            except ValueError:
                pass
        else:
            total_warning += levels.get("warning", 0)

    # Write the merged SARIF file the caller feeds to upload-sarif.
    sarif_path = os.path.abspath(sarif_file)
    with open(sarif_path, "w", encoding="utf-8") as fh:
        json.dump(merged, fh, indent=2, sort_keys=True)
        fh.write("\n")
    _set_output("sarif-file", sarif_path)

    # (3) Console format: drive the identical entrypoint for the human/log view.
    # For sarif we already have the merged document (batch sarif is single-file
    # only in the engine); other formats support --recurse for directories.
    if fmt == "sarif":
        sys.stdout.write(json.dumps(merged, indent=2, sort_keys=True) + "\n")
    else:
        console_args = ["--profile", profile, "--format", fmt]
        if os.path.isdir(path):
            console_args.append("--recurse")
        console_args.append(path)
        cproc = _run_report(root, console_args)
        sys.stdout.write(cproc.stdout)
        if cproc.stderr:
            sys.stderr.write(cproc.stderr)

    # (4) Exit-code contract.
    if not files:
        sys.stderr.write("einvoice-action: no invoice files found under %s\n"
                         % path)
        return EXIT_OK

    sys.stderr.write(
        "einvoice-action: %d file(s), %d fatal, %d warning (fail-on=%s)\n"
        % (len(files), total_fatal, total_warning, fail_on))

    if total_fatal > 0:
        return EXIT_FAIL
    if fail_on == "warning" and total_warning > 0:
        return EXIT_FAIL
    if any_parse_error:
        return EXIT_PARSE
    return EXIT_OK


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="einvoice-action", add_help=True,
        description="Thin runner driving `python3 -m einvoice.report`.")
    parser.add_argument("--path", default=".",
                        help="file or directory of invoices (default '.').")
    parser.add_argument("--format", dest="fmt", default="sarif",
                        choices=CONSOLE_FORMATS,
                        help="console report format (default sarif).")
    parser.add_argument("--fail-on", dest="fail_on", default="fatal",
                        choices=("fatal", "warning"),
                        help="severity that fails the build (default fatal).")
    parser.add_argument("--sarif-file", dest="sarif_file",
                        default="einvoice.sarif",
                        help="path the merged SARIF is written to.")
    parser.add_argument("--profile", default="xrechnung",
                        choices=("xrechnung", "en16931"),
                        help="validation profile (default xrechnung).")
    args = parser.parse_args(argv)
    return run(args.path, args.fmt, args.fail_on, args.sarif_file, args.profile)


if __name__ == "__main__":
    sys.exit(main())
