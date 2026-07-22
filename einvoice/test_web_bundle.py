#!/usr/bin/env python3
"""test_web_bundle.py — the in-browser validator ENGINE BUNDLE
(``einvoice/www/validate/engine/``, T-VHWEB.1) must be a byte-identical,
manifest-pinned, SELF-CONTAINED copy of the einvoice package modules the
validate path transitively imports. This is the drift guard that makes it
impossible for a future browser page (T-VHWEB.2) to run a stale or divergent
engine: any byte of difference between a bundled module and its package
source fails here.

Standard library only; no network; no browser. Run from the einvoice dir:

    python3 test_web_bundle.py

Checks (each an independent hard assert):

  (a) BYTE-IDENTITY: every ``*.py`` listed in manifest.json is byte-for-byte
      identical (raw ``rb`` comparison — no decode, no newline forgiveness)
      to the same-named module under ``einvoice/einvoice/``.
  (b) MANIFEST INTEGRITY: manifest.json holds exactly the keys
      ``files``/``sha256``/``version``; ``files`` is sorted and non-empty;
      the sha256 map covers exactly the same file set; every digest is
      64-char lowercase hex AND equals the actual sha256 of the bundled
      bytes; the on-disk directory holds EXACTLY files + manifest.json (no
      extra file, no missing file, no subdirectory).
  (c) VERSION BINDING: manifest["version"] equals the live
      ``einvoice.__version__`` — read from the package, never a literal here,
      so a version bump with a stale bundle fails.
  (d) SELF-CONTAINMENT (Pyodide requirement): parsing every bundled module
      with ``ast`` (function-level imports count), every RELATIVE import
      resolves inside the bundle set, and every ABSOLUTE import is Python
      stdlib — so the bundle needs nothing but itself + a Python runtime.
      The seed modules ``__init__.py`` and ``validate.py`` must be present.
  (e) GENERATOR AGREEMENT: the bundle file set equals what
      ``gen_site.engine_bundle_modules()`` traces right now — a module newly
      imported by the validate path cannot be silently absent.
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
    check(all(fn.endswith(".py") for fn in files),
          "manifest lists a non-.py file: %r"
          % [fn for fn in files if not fn.endswith(".py")])
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
    bundle_mods = {fn[:-3] for fn in files}
    stdlib = set(getattr(sys, "stdlib_module_names", ())) | _NEWER_STDLIB
    check(bool(getattr(sys, "stdlib_module_names", ())),
          "sys.stdlib_module_names unavailable — cannot audit imports")
    for fn in sorted(bundled):
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
          "gen_site.engine_bundle_modules() != bundled set; "
          "traced-not-bundled=%s bundled-not-traced=%s"
          % (sorted(traced - bundle_mods)[:5],
             sorted(bundle_mods - traced)[:5]))

    if failures:
        sys.stderr.write("WEB BUNDLE TEST: FAIL (%d)\n" % len(failures))
        for m in failures[:40]:
            sys.stderr.write("  !! " + m + "\n")
        return 1
    print("web bundle OK: %d modules byte-identical to the package, manifest "
          "hashes/list/version bound, imports self-contained (stdlib only), "
          "traced closure matches." % len(files))
    return 0


if __name__ == "__main__":
    sys.exit(main())
