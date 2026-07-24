#!/usr/bin/env python3
"""test_web_bundle.py — the in-browser validator ENGINE BUNDLE
(``einvoice/www/validate/engine/``, T-VHWEB.1) must be a byte-identical,
manifest-pinned, SELF-CONTAINED copy of the einvoice package modules the
validate path transitively imports, plus the ONE declared data file it reads
at runtime. This is the drift guard that makes it impossible for the browser
page (T-VHWEB.2) to run a stale or divergent engine: any byte of difference
between a bundled file and its package source fails here.

Standard library only; no network; no browser. Run from the einvoice dir:

    python3 test_web_bundle.py

The bundle's file set is ``.py`` modules PLUS exactly the names in
:data:`DATA_FILES` (T-VHWHEEL.5: ``remediation_catalog.json``, which
``report._record()`` reads to attach each finding's title/fix hint and which
no import trace can discover). That allowance is NAMED and closed: any other
non-``.py`` manifest entry still fails, and the allowed set is pinned against
``gen_site.ENGINE_DATA_FILES`` so the generator cannot widen it unilaterally.

Checks (each an independent hard assert):

  (a) BYTE-IDENTITY: every file listed in manifest.json — modules and the
      declared data file alike — is byte-for-byte identical (raw ``rb``
      comparison — no decode, no newline forgiveness) to the same-named file
      under ``einvoice/einvoice/``.
  (b) MANIFEST INTEGRITY: manifest.json holds exactly the keys
      ``files``/``sha256``/``version``; ``files`` is sorted and non-empty;
      every entry is a ``.py`` module or one of the declared data files, and
      every declared data file is present; the sha256 map covers exactly the
      same file set; every digest is 64-char lowercase hex AND equals the
      actual sha256 of the bundled bytes; the on-disk directory holds EXACTLY
      files + manifest.json (no extra file, no missing file, no
      subdirectory).
  (c) VERSION BINDING: manifest["version"] equals the live
      ``einvoice.__version__`` — read from the package, never a literal here,
      so a version bump with a stale bundle fails.
  (d) SELF-CONTAINMENT (Pyodide requirement): parsing every bundled module
      with ``ast`` (function-level imports count), every RELATIVE import
      resolves inside the bundle set, and every ABSOLUTE import is Python
      stdlib — so the bundle needs nothing but itself + a Python runtime.
      The seed modules ``__init__.py`` and ``validate.py`` must be present.
  (e) GENERATOR AGREEMENT: the bundle's module set equals what
      ``gen_site.engine_bundle_modules()`` traces right now — a module newly
      imported by the validate path cannot be silently absent — and its data
      set equals ``gen_site.ENGINE_DATA_FILES``.
  (f) DATA FILE USABLE: each declared data file is non-empty, parses as JSON,
      and (for the remediation catalog) carries the ``rules`` mapping the
      browser needs, so a mounted-but-unusable catalog cannot pass.
"""

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

import einvoice as _einvoice           # noqa: E402
import gen_site as _gen                # noqa: E402

PKG_DIR = os.path.join(HERE, "einvoice")
ENGINE_DIR = os.path.join(HERE, "www", "validate", "engine")
MANIFEST_PATH = os.path.join(ENGINE_DIR, "manifest.json")

# Modules that ARE Python stdlib but only from a newer interpreter than this
# suite's floor, so they are absent from sys.stdlib_module_names on 3.10.
# config.py imports tomllib (stdlib since 3.11) inside a try/except
# ModuleNotFoundError with a committed fallback — it is never an external
# dependency. Anything else non-stdlib fails check (d).
_NEWER_STDLIB = {"tomllib"}

# The CLOSED list of non-.py files the bundle is allowed to carry, written
# out literally here (never derived from the generator) so that widening it
# takes a deliberate edit to this test. main() additionally asserts this set
# equals gen_site.ENGINE_DATA_FILES, so generator and test cannot drift.
DATA_FILES = {"remediation_catalog.json"}

_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")


def _read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def main():
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    # ---- bundle + manifest must exist at all --------------------------------
    check(os.path.isdir(ENGINE_DIR),
          "www/validate/engine/ directory is missing")
    check(os.path.isfile(MANIFEST_PATH),
          "www/validate/engine/manifest.json is missing")
    if not os.path.isfile(MANIFEST_PATH):
        sys.stderr.write("WEB BUNDLE TEST: FAIL (no manifest)\n")
        return 1

    try:
        manifest = json.loads(_read_bytes(MANIFEST_PATH).decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("WEB BUNDLE TEST: FAIL (manifest does not parse: %s)\n"
                         % exc)
        return 1

    # ---- (b) manifest structure --------------------------------------------
    check(set(manifest) == {"files", "sha256", "version"},
          "manifest keys != {files, sha256, version}: %r" % sorted(manifest))
    files = manifest.get("files") or []
    hashes = manifest.get("sha256") or {}
    check(isinstance(files, list) and files,
          "manifest 'files' is empty or not a list")
    check(files == sorted(files), "manifest 'files' is not sorted")
    check(len(files) == len(set(files)), "manifest 'files' has duplicates")
    # A manifest entry is either a .py module or one of the NAMED data files.
    # Anything else — a stray asset, a directory, a second data file nobody
    # declared — still fails, exactly as the blanket .py rule used to.
    check(all(fn.endswith(".py") or fn in DATA_FILES for fn in files),
          "manifest lists a file that is neither .py nor a declared data "
          "file %r: %r"
          % (sorted(DATA_FILES),
             [fn for fn in files
              if not fn.endswith(".py") and fn not in DATA_FILES]))
    # ...and every declared data file must actually be there: dropping the
    # remediation catalog silently strips every fix hint in the browser.
    check(DATA_FILES <= set(files),
          "manifest is missing declared data file(s): %r"
          % sorted(DATA_FILES - set(files)))
    # The generator's declaration and this test's allowance must agree.
    check(set(_gen.ENGINE_DATA_FILES) == DATA_FILES,
          "gen_site.ENGINE_DATA_FILES %r != this test's allowed set %r"
          % (sorted(_gen.ENGINE_DATA_FILES), sorted(DATA_FILES)))
    check(set(hashes) == set(files),
          "manifest sha256 keys != files list; only-in-sha256=%s "
          "only-in-files=%s"
          % (sorted(set(hashes) - set(files))[:5],
             sorted(set(files) - set(hashes))[:5]))

    # Seeds must be present — a bundle without the validate entry point or
    # the package init is not an engine.
    check("validate.py" in files, "bundle is missing validate.py")
    check("__init__.py" in files, "bundle is missing __init__.py")

    # Directory holds EXACTLY files + manifest.json; no subdirectories.
    entries = sorted(os.listdir(ENGINE_DIR))
    subdirs = [e for e in entries
               if os.path.isdir(os.path.join(ENGINE_DIR, e))]
    check(not subdirs, "engine dir contains subdirectories: %r" % subdirs)
    check(set(entries) == set(files) | {"manifest.json"},
          "engine dir != manifest files + manifest.json; extra=%s missing=%s"
          % (sorted(set(entries) - set(files) - {"manifest.json"})[:5],
             sorted(set(files) - set(entries))[:5]))

    # ---- (a) byte-identity + (b) hash correctness ---------------------------
    # Covers modules AND the declared data files uniformly: each is compared
    # raw against einvoice/<fn> and against its manifest sha256 pin (the
    # browser hard-stops on a pin mismatch, so the pin has to be real).
    bundled = {}
    for fn in files:
        bpath = os.path.join(ENGINE_DIR, fn)
        spath = os.path.join(PKG_DIR, fn)
        check(os.path.isfile(bpath), "bundled file missing on disk: %s" % fn)
        check(os.path.isfile(spath),
              "bundle lists a file with NO package source: %s" % fn)
        if not (os.path.isfile(bpath) and os.path.isfile(spath)):
            continue
        bdata = _read_bytes(bpath)
        sdata = _read_bytes(spath)
        bundled[fn] = bdata
        check(bdata == sdata,
              "%s: bundled copy is NOT byte-identical to einvoice/%s" % (fn, fn))
        digest = hashes.get(fn, "")
        check(_HEX64_RE.match(digest) is not None,
              "%s: manifest sha256 is not 64-char lowercase hex: %r"
              % (fn, digest))
        check(digest == hashlib.sha256(bdata).hexdigest(),
              "%s: manifest sha256 does not match the bundled bytes" % fn)

    # ---- (c) version binding ------------------------------------------------
    check(manifest.get("version") == _einvoice.__version__,
          "manifest version %r != einvoice.__version__ %r"
          % (manifest.get("version"), _einvoice.__version__))

    # ---- (d) self-containment: bundle imports nothing outside itself +
    # stdlib. Parsed from the BUNDLED bytes (what the browser would run),
    # with ast so function-level imports count.
    bundle_mods = {fn[:-3] for fn in files if fn.endswith(".py")}
    stdlib = set(getattr(sys, "stdlib_module_names", ())) | _NEWER_STDLIB
    check(bool(getattr(sys, "stdlib_module_names", ())),
          "sys.stdlib_module_names unavailable — cannot audit imports")
    for fn in sorted(f for f in bundled if f.endswith(".py")):
        try:
            tree = ast.parse(bundled[fn])
        except SyntaxError as exc:
            check(False, "%s: bundled file does not parse: %s" % (fn, exc))
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    top = alias.name.split(".")[0]
                    check(top in stdlib,
                          "%s: absolute import %r is not Python stdlib "
                          "(bundle would not be self-contained)"
                          % (fn, alias.name))
            elif isinstance(node, ast.ImportFrom):
                if (node.level or 0) == 0:
                    top = (node.module or "").split(".")[0]
                    check(top in stdlib or node.module == "__future__",
                          "%s: absolute from-import %r is not Python stdlib"
                          % (fn, node.module))
                else:
                    # Relative: must resolve inside the bundle. level>=2 would
                    # escape the single-package bundle entirely.
                    check((node.level or 0) == 1,
                          "%s: relative import with level %d escapes the "
                          "package" % (fn, node.level))
                    if node.module:
                        top = node.module.split(".")[0]
                        check(top in bundle_mods,
                              "%s: relative import '.%s' is OUTSIDE the "
                              "bundle set" % (fn, node.module))
                    else:
                        # ``from . import X`` — X must be a bundled module,
                        # or an attribute of the (bundled) package __init__.
                        pkg_mods = {f[:-3] for f in os.listdir(PKG_DIR)
                                    if f.endswith(".py")}
                        for alias in node.names:
                            if alias.name in pkg_mods:
                                check(alias.name in bundle_mods,
                                      "%s: 'from . import %s' references a "
                                      "package module OUTSIDE the bundle"
                                      % (fn, alias.name))
                            else:
                                check("__init__" in bundle_mods,
                                      "%s: 'from . import %s' needs the "
                                      "package __init__ in the bundle"
                                      % (fn, alias.name))

    # ---- (e) generator agreement: the traced closure is exactly the bundle --
    traced = set(_gen.engine_bundle_modules())
    check(traced == bundle_mods,
          "gen_site.engine_bundle_modules() != bundled module set; "
          "traced-not-bundled=%s bundled-not-traced=%s"
          % (sorted(traced - bundle_mods)[:5],
             sorted(bundle_mods - traced)[:5]))
    bundle_data = {fn for fn in files if not fn.endswith(".py")}
    check(bundle_data == DATA_FILES,
          "bundled data files %r != declared %r"
          % (sorted(bundle_data), sorted(DATA_FILES)))

    # ---- (f) the mounted data must be USABLE, not merely present -----------
    # A truncated or unparseable catalog would mount fine and then leave the
    # browser with no fix hints at all, which is the exact failure this task
    # exists to close.
    for fn in sorted(DATA_FILES & set(bundled)):
        raw = bundled[fn]
        check(len(raw) > 0, "%s: bundled data file is EMPTY" % fn)
        doc = None
        try:
            doc = json.loads(raw.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            check(False, "%s: bundled data file does not parse as JSON: %s"
                  % (fn, exc))
        if doc is not None and fn == "remediation_catalog.json":
            rules = doc.get("rules") if isinstance(doc, dict) else None
            check(isinstance(rules, dict) and bool(rules),
                  "%s: no non-empty 'rules' mapping — the browser would show "
                  "rule ids with no fix guidance" % fn)
            if isinstance(rules, dict) and rules:
                # At least one entry must carry the 'fix' text the page
                # renders as its Fix line (report._record maps fix ->
                # fix_hint).
                check(any(isinstance(e, dict) and
                          isinstance(e.get("fix"), str) and e["fix"].strip()
                          for e in rules.values()),
                      "%s: no rule entry carries a non-empty 'fix' string"
                      % fn)

    if failures:
        sys.stderr.write("WEB BUNDLE TEST: FAIL (%d)\n" % len(failures))
        for m in failures[:40]:
            sys.stderr.write("  !! " + m + "\n")
        return 1
    print("web bundle OK: %d modules + %d declared data file(s) (%s) "
          "byte-identical to the package, manifest hashes/list/version "
          "bound, imports self-contained (stdlib only), traced closure "
          "matches."
          % (len(bundle_mods), len(bundle_data), ", ".join(sorted(bundle_data))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
