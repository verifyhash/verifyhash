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
     nothing and adds no findings). While merging, each artifact URI is
     rewritten to the path RELATIVE to the workspace root (``$GITHUB_WORKSPACE``
     or the cwd) and anchored to the ``%SRCROOT%`` ``uriBaseId`` declared in
     ``runs[0].originalUriBaseIds``, because code scanning resolves result
     locations against the repository root: an absolute runner path matches no
     tracked file and renders ZERO annotations. Files genuinely outside the
     workspace keep their absolute URI (never a ``../`` escape);
  3. also emits the caller-chosen console ``--format`` to stdout by driving the
     identical entrypoint ``python3 -m einvoice.report --format <format>
     [--recurse] <path>`` — the literal command the docs describe. The offered
     vocabulary is DERIVED from the engine's own ``report.REPORT_FORMATS``
     registry minus :data:`FORMAT_EXCLUSIONS` (see below), so it can never drift
     behind the engine. For a directory input under a format the engine has no
     aggregate shape for (``report.BATCH_FORMATS``) — today that is ``github`` —
     the runner drives the entrypoint ONCE PER FILE over the same file list the
     SARIF leg walks and concatenates stdout; it invents no batch envelope;
  4. sets the process exit code so the build fails per ``--fail-on``:
       * ``fatal``  (default) — fail iff any FATAL violation is present, exactly
         the entrypoint's own exit-code contract (exit 1 fatal / 3 unparseable);
       * ``warning`` — additionally fail when a WARNING-severity finding is
         present. Warnings are detected by PARSING THE JSON report the
         entrypoint already emits (``--format json`` → ``warning_count``); we do
         NOT add an engine flag for this.

Standard library only. No network. There is no standalone Action repository:
this Action ships in the ``einvoice/action/`` subdirectory of the verifyhash
monorepo, next to the ``einvoice/`` package itself, and a consumer references it
by the three-segment subdirectory form
``uses: verifyhash/verifyhash/einvoice/action@<ref>`` (``<ref>`` = ``main`` or a
full 40-char commit SHA — no release tags exist). The runner locates the
``einvoice`` package by walking up from its own directory (override with
``$EINVOICE_ROOT``), so it works both here and when the product is vendored into
a consumer repo and referenced by local path (``uses: ./third_party/einvoice/action``).
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import urllib.parse

# Exit codes — the entrypoint's contract, mirrored here (kept as literals so a
# drift in einvoice.report is caught by test_action.py, not silently followed).
EXIT_OK = 0
EXIT_FAIL = 1
EXIT_PARSE = 3

#: File extensions treated as invoices in directory mode. Matches
#: ``einvoice.report.BATCH_INVOICE_EXTS`` (``.xml`` UBL/CII, ``.pdf`` Factur-X).
INVOICE_EXTS = (".xml", ".pdf")

#: The SARIF ``uriBaseId`` every workspace-relative artifact location is anchored
#: to. ``%SRCROOT%`` is the conventional id GitHub's own code-scanning tooling
#: uses for "the root of the checked-out repository"; ONE id is declared for the
#: whole run (a per-file id would be meaningless to a consumer).
SRCROOT_ID = "%SRCROOT%"

#: Engine formats this Action deliberately does NOT offer, each with its ONE
#: reason. Everything else in ``einvoice.report.REPORT_FORMATS`` is offered, so
#: a newly registered engine format is either exposed automatically or forces an
#: explicit exclusion decision here — the list can no longer silently rot.
FORMAT_EXCLUSIONS = {
    "gitlab": "GitLab Code Quality artifact — another vendor's CI, not GitHub's.",
    "azure": "Azure Pipelines logging commands — another vendor's CI, not GitHub's.",
    "html": "document-shaped artifact (a whole HTML page), not job-log lines.",
    "badge": "document-shaped artifact (an SVG badge), not job-log lines.",
}


def _import_report(root):
    """Import the engine's ``einvoice.report`` module from ``root``.

    Used ONLY to read the format registry constants (``REPORT_FORMATS`` /
    ``BATCH_FORMATS``) so this runner never retypes the engine's vocabulary.
    All actual validation still happens in the subprocess entrypoint — no rule
    module is imported here and no second engine exists.
    """
    if root not in sys.path:
        sys.path.insert(0, root)
    from einvoice import report as _report
    return _report


def console_formats(root):
    """The console ``--format`` names this Action offers, in engine order.

    ``report.REPORT_FORMATS`` minus :data:`FORMAT_EXCLUSIONS`. Today that is
    ``json, junit, sarif, github, text``.
    """
    return tuple(f for f in _import_report(root).REPORT_FORMATS
                 if f not in FORMAT_EXCLUSIONS)


def batch_formats(root):
    """Formats the engine can emit for a whole directory (``--recurse``)."""
    return tuple(_import_report(root).BATCH_FORMATS)


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

    CWD WARNING: because ``cwd`` is the PACKAGE root and this runner's own cwd
    is the WORKSPACE (a GitHub step runs in ``$GITHUB_WORKSPACE``), any path in
    ``args`` must already be ABSOLUTE. A workspace-relative path handed to this
    function is resolved by the child against the wrong directory — it either
    fails with ``no such file`` or, worse, silently hits a same-named file that
    happens to exist under the package root. Use :func:`_report_on` instead of
    calling this with a user path.
    """
    env = dict(os.environ)
    env["PYTHONPATH"] = root + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        _entrypoint_cmd(root) + list(args),
        cwd=root, env=env, capture_output=True, text=True)


def exec_path(path):
    """The ABSOLUTE form of ``path``, used for EXECUTION only.

    Resolved against THIS process's cwd (the workspace) before it crosses the
    cwd-changing subprocess boundary, so file identity can never depend on the
    child's cwd. Selection (:func:`collect_files`) still happens on the caller's
    own spelling; only the value handed to the subprocess is absolutised.
    """
    return os.path.abspath(path)


def display_path(path):
    """The user's OWN spelling of ``path``, used for PRESENTATION only.

    GitHub resolves ``::error file=<p>`` and SARIF artifact URIs against the
    workspace, so an annotation carrying a runner-absolute path points at
    nothing. A trailing separator is dropped so that a child name joined back
    onto a directory cannot come out as ``invoices//bad.xml``.
    """
    trimmed = path.rstrip(os.sep)
    return trimmed or path


def workspace_root():
    """The absolute directory SARIF artifact URIs are made relative to.

    ``$GITHUB_WORKSPACE`` when it is set and non-empty — that is the checkout
    root GitHub's code-scanning ingest resolves every result location against —
    otherwise this process's cwd, which is the same directory in a local run,
    under ``act``, and under GitLab (``$CI_PROJECT_DIR`` is the cwd there too).
    So the Action behaves identically in all four situations without special
    casing any of them.

    ``os.path.abspath`` only (no ``os.path.realpath``): a runner hands us BOTH
    the workspace value and the ``--path`` value in unresolved form, and the two
    are only comparable when neither side has its symlinks collapsed. On a
    GitHub-hosted runner ``/home/runner/work/...`` is itself reachable through
    symlinked parents; resolving one side alone would make a file that IS inside
    the workspace look outside it and silently fall back to absolute URIs.
    """
    ws = os.environ.get("GITHUB_WORKSPACE") or ""
    if not ws.strip():
        ws = os.getcwd()
    return os.path.abspath(ws)


def workspace_base_uri(workspace):
    """The ``originalUriBaseIds`` value for :data:`SRCROOT_ID`.

    SARIF 2.1.0 §3.14.14 wants a base id to denote a DIRECTORY, i.e. an absolute
    URI ending in ``/``. ``Path.as_uri()`` does the ``file://`` framing and the
    percent-encoding; the trailing slash is appended here.
    """
    return pathlib.Path(workspace).as_uri().rstrip("/") + "/"


def artifact_uri(path, workspace):
    """-> ``(uri, inside)`` for one invoice: the SARIF URI and containment flag.

    ``inside`` is True when ``path`` really lies under ``workspace``; then the
    URI is the workspace-RELATIVE path, ``/``-separated (SARIF URIs are always
    POSIX-style, never ``os.sep``) and percent-encoded except for the separators.
    That is the only form GitHub can match against a tracked file — an absolute
    runner path such as ``/home/runner/work/repo/repo/invoices/bad.xml`` matches
    nothing in the repository tree, so ``upload-sarif`` succeeds and renders ZERO
    annotations.

    When ``path`` lies outside the workspace the ABSOLUTE path is returned and
    ``inside`` is False. Escaping the repository root with ``../`` segments is
    strictly worse than an absolute URI: code scanning rejects or mis-resolves
    it, and the reader loses the file's real identity. Containment is decided on
    path COMPONENTS via ``os.path.relpath`` + a ``..`` test — a ``startswith``
    string test would wrongly call ``/tmp/ws-other/x`` a child of ``/tmp/ws``.
    """
    abs_path = os.path.abspath(path)
    absolute_uri = abs_path.replace(os.sep, "/")
    try:
        rel = os.path.relpath(abs_path, workspace)
    except ValueError:
        # Different Windows drive letters — genuinely not relatable.
        return absolute_uri, False
    parts = rel.split(os.sep)
    if os.path.isabs(rel) or ".." in parts or rel == os.curdir:
        return absolute_uri, False
    return urllib.parse.quote("/".join(parts), safe="/"), True


def _localise_sarif(doc, path, workspace):
    """Rewrite the artifact URIs of ONE per-file SARIF document in place.

    This is the single place in the runner where a SARIF URI is rewritten. Every
    location in ``doc`` describes ``path`` — the engine was driven on exactly one
    invoice — so each ``artifactLocation`` gets the same URI, computed from the
    FILE PATH rather than by string-munging whatever the engine printed (the
    engine echoes the spelling it was given, which may be absolute, relative to
    the cwd, or the user's own trailing-slash form).

    Nothing else is touched: no result is added, dropped, reordered, relabelled
    or deduplicated, no level or ruleId changes, and the region/logicalLocation
    detail the engine attached is preserved verbatim.
    """
    uri, inside = artifact_uri(path, workspace)
    for run in doc.get("runs", []):
        for res in run.get("results", []):
            locations = list(res.get("locations") or [])
            locations += list(res.get("relatedLocations") or [])
            for loc in locations:
                if not isinstance(loc, dict):
                    continue
                phys = loc.get("physicalLocation")
                if not isinstance(phys, dict):
                    continue
                art = phys.get("artifactLocation")
                if not isinstance(art, dict):
                    continue
                art["uri"] = uri
                if inside:
                    art["uriBaseId"] = SRCROOT_ID
                else:
                    # An absolute URI must NOT claim a base id it is not
                    # relative to.
                    art.pop("uriBaseId", None)
    return doc


def _present(proc, execp, display):
    """Rewrite ``execp`` back to the user's ``display`` form in the child output.

    The engine echoes the path it was GIVEN (report ``source`` -> ``file=`` in
    the github format, ``artifactLocation.uri`` in SARIF, the filename headers
    in text/junit). We gave it an absolute path so the read could not miss; the
    caller must still see the path they typed. Pure string restoration of a
    value this runner itself substituted — no finding is added, dropped or
    relabelled, and it is a no-op when the caller already passed an absolute
    path.
    """
    if execp == display:
        return proc
    return subprocess.CompletedProcess(
        proc.args, proc.returncode,
        stdout=(proc.stdout or "").replace(execp, display),
        stderr=(proc.stderr or "").replace(execp, display))


def _report_on(root, args, path):
    """Drive the entrypoint on ``path``: absolute in, user's form out.

    The one sanctioned way to run the report against a caller-supplied path.
    """
    execp = exec_path(path)
    return _present(_run_report(root, list(args) + [execp]),
                    execp, display_path(path))


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
    offered = console_formats(root)
    if fmt not in offered:
        sys.stderr.write("error: unknown format %r (choose from %s)\n"
                         % (fmt, ", ".join(offered)))
        return EXIT_FAIL
    if fail_on not in ("fatal", "warning"):
        sys.stderr.write("error: unknown fail-on %r (choose fatal or warning)\n"
                         % fail_on)
        return EXIT_FAIL

    files = collect_files(path)

    # Every artifact URI in the merged document is expressed relative to this
    # root and anchored to SRCROOT_ID, so a consumer that needs the absolute
    # form can still recover it from originalUriBaseIds.
    workspace = workspace_root()
    merged = _empty_sarif()
    merged["runs"][0]["originalUriBaseIds"] = {
        SRCROOT_ID: {"uri": workspace_base_uri(workspace)},
    }
    total_fatal = 0
    total_warning = 0
    any_parse_error = False

    for f in files:
        # (1) SARIF projection of the REAL entrypoint, one file at a time.
        # `f` is the caller's own spelling (possibly relative to the WORKSPACE);
        # _report_on absolutises it for the child and restores it afterwards.
        proc = _report_on(root, ["--profile", profile, "--format", "sarif"], f)
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
        # Workspace-relative URIs BEFORE merging: GitHub resolves result
        # locations against the repository root, so the absolute runner path the
        # engine echoes back would match no tracked file and render zero
        # annotations. The job log is untouched — this is the SARIF document
        # only (see _present for the console path).
        _merge_sarif(merged, _localise_sarif(doc, f, workspace))

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
            jproc = _report_on(
                root, ["--profile", profile, "--format", "json"], f)
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
    # For sarif we already have the merged document. Formats in the engine's
    # BATCH_FORMATS get --recurse for a directory; the rest (github) are driven
    # once per file, because the engine defines no aggregate shape for them.
    if fmt == "sarif":
        sys.stdout.write(json.dumps(merged, indent=2, sort_keys=True) + "\n")
    elif os.path.isdir(path) and fmt not in batch_formats(root):
        # The engine gives this format no AGGREGATE shape (it is single-invoice
        # by construction, e.g. `github` workflow commands are per-file lines),
        # so `--recurse` is refused. Drive the identical entrypoint ONCE PER
        # FILE over the SAME `files` list the SARIF leg walked, in the same
        # order, and concatenate stdout. No batch envelope is invented, no
        # finding is added or dropped — this is exactly what the caller would
        # get from a `for f in ...; do einvoice.report --format <fmt> $f; done`.
        for f in files:
            cproc = _report_on(root, ["--profile", profile, "--format", fmt], f)
            sys.stdout.write(cproc.stdout)
            if cproc.stderr:
                sys.stderr.write(cproc.stderr)
    else:
        console_args = ["--profile", profile, "--format", fmt]
        if os.path.isdir(path):
            console_args.append("--recurse")
        cproc = _report_on(root, console_args, path)
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
    # Resolve the package root ONCE here so the offered --format choices are
    # read from the engine's own registry rather than retyped.
    root = find_root()
    parser = argparse.ArgumentParser(
        prog="einvoice-action", add_help=True,
        description="Thin runner driving `python3 -m einvoice.report`.")
    parser.add_argument("--path", default=".",
                        help="file or directory of invoices (default '.').")
    parser.add_argument("--format", dest="fmt", default="sarif",
                        choices=console_formats(root),
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
    return run(args.path, args.fmt, args.fail_on, args.sarif_file, args.profile,
               root=root)


if __name__ == "__main__":
    sys.exit(main())
