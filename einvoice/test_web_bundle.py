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
  (g) ACCEPTED-ROOT PARITY: the bundled engine and the packaged engine ACCEPT
      exactly the same set of invoice root element tags. Checks (a)-(e) are
      all about *bytes and file lists*; this one is about BEHAVIOUR. It exists
      because the failure it catches actually shipped: after T-VHCII3.1 taught
      ``validate.validate_root`` to dispatch a raw UN/CEFACT
      ``CrossIndustryInvoice`` to the CII engine, the committed bundle was not
      regenerated — so the browser validator kept answering the structural
      ``S-ROOT`` fatal for a document the CLI graded fine. Both sets are
      DERIVED (never a literal list here): the candidate roots are harvested
      with ``ast`` from the two engines' own source, and acceptance is decided
      by RUNNING each engine's ``validate_root`` and asking whether it emits
      the structural refusal. See :func:`accepted_root_set`.
"""

# ---------------------------------------------------------------------------
# REGISTERED-GATE CARRIER (T-VHWEB.4) — mirrors the remedy T-VHDRIFT.1 wrote
# into test_docs_example_output.py, except this one is WIRED, not merely
# documented.
#
# This guard is not registered as a gate under its own name, and that is
# exactly how the bundle rotted: it sat red at HEAD for ~15 commits
# (6c4dd18..9ed0b74) while the browser validator at /einvoice/validate/ shipped
# the pre-EPIC-VHLOC engine — no source line, no insertion point, no rule-page
# links — and nobody ran the guard that knew.
#
# The REGISTERED gate that now runs it is:
#
#     python3 test_packaging.py     (class WebBundleFreshness, claim 6)
#
# It calls :func:`check_web_bundle` below — the single importable definition of
# "the shipped bundle is fresh". test_packaging.py deliberately holds NO copy
# of the byte-comparison logic, so the two files cannot drift apart. If you
# move or rename that entry point, fix test_packaging.py in the same commit.
# ---------------------------------------------------------------------------

from __future__ import annotations

import ast
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

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

# ---------------------------------------------------------------------------
# (g) ACCEPTED-ROOT PARITY — derivation knobs.
#
# The rule id the engine emits when it REFUSES a root structurally. Read off
# the packaged engine's own module (never spelled out as a literal here), so
# renaming the structural fatal cannot leave this probe silently classifying
# every root as "accepted".
# ---------------------------------------------------------------------------
#: Profile the probe validates under: the widest one the engine offers, so a
#: root only reachable on the national CIUS layer still counts as accepted.
ACCEPTED_ROOT_PROFILE = "xrechnung"

#: Shapes harvested from source to build the candidate root universe: an
#: element LOCALNAME (XML NCName, initial capital — every real invoice root in
#: either syntax is one) and an XML NAMESPACE URI.
_ROOT_LOCALNAME_RE = re.compile(r"[A-Z][A-Za-z0-9]{2,}")
_ROOT_NAMESPACE_RE = re.compile(r"^(?:urn:|https?://)")

#: Negative controls. These are NOT part of the derived accepted set — they are
#: nonsense roots that both engines must REFUSE, which is what proves the probe
#: actually discriminates (a probe that called everything "accepted" would make
#: the parity assertion vacuously true) and that the generic structural fatal
#: still fires for genuinely unsupported roots.
ACCEPTED_ROOT_SENTINELS = (
    "ZzDefinitelyNotAnInvoiceRoot",
    "{urn:example:not-a-real-syntax}ZzDefinitelyNotAnInvoiceRoot",
)

#: Package name the bundled copy is imported under. Deliberately NOT
#: ``einvoice``: the two engines must be live in the same interpreter at once
#: for the comparison to mean anything.
_BUNDLE_PKG_NAME = "_einvoice_bundle_under_test"


def _read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


# ---------------------------------------------------------------------------
# (g) ACCEPTED-ROOT PARITY — implementation.
# ---------------------------------------------------------------------------

def _harvest_root_literals(py_paths):
    """Harvest candidate root localnames + XML namespaces from source.

    Parses each file with ``ast`` and collects its string constants, keeping
    the two shapes a root tag is built from: NCName-ish localnames
    (``CrossIndustryInvoice``, ``CreditNote``, ``InvoiceLine``, …) and
    namespace URIs (``urn:…`` / ``http(s)://…``). Deriving the universe from
    the engines' OWN literals is the point: a dispatch change necessarily
    mentions the root it newly handles, so the new root lands in the universe
    automatically and the parity check sees it — nothing to remember to add
    here.

    :param py_paths: iterable of ``.py`` file paths to parse.
    :returns: ``(localnames, namespaces)``, both sets of ``str``.
    """
    localnames = set()
    namespaces = set()
    for path in py_paths:
        try:
            tree = ast.parse(_read_bytes(path))
        except SyntaxError:
            continue  # reported by check (d); nothing to harvest here
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Constant)
                    and isinstance(node.value, str)):
                continue
            text = node.value
            if _ROOT_LOCALNAME_RE.fullmatch(text):
                localnames.add(text)
            elif _ROOT_NAMESPACE_RE.match(text):
                namespaces.add(text)
    return localnames, namespaces


def _root_tag_universe(localnames, namespaces):
    """Every candidate root TAG to probe: each localname bare (no namespace)
    and qualified with each harvested namespace, in ``xml.etree``'s
    ``{ns}local`` form. Sorted, so failures report deterministically."""
    tags = set(localnames)
    for ns in namespaces:
        for local in localnames:
            tags.add("{%s}%s" % (ns, local))
    return sorted(tags)


def _import_bundled_engine():
    """Import ``www/validate/engine/`` as a SECOND, independent package.

    Loaded straight from the committed bundle directory in memory — no copy,
    no temp dir, no write anywhere — with ``submodule_search_locations`` set
    so the bundle's relative imports (``from . import parser``) resolve inside
    the bundle and nothing leaks in from the installed ``einvoice``. That is
    the same self-contained-package assumption the Pyodide page relies on, so
    a bundle that cannot be imported this way is already broken in the
    browser.

    :returns: the bundled ``validate`` module, or ``None`` if it will not
        import (the caller turns that into a failure).
    """
    for name in [n for n in sys.modules
                 if n == _BUNDLE_PKG_NAME
                 or n.startswith(_BUNDLE_PKG_NAME + ".")]:
        del sys.modules[name]
    init_path = os.path.join(ENGINE_DIR, "__init__.py")
    if not os.path.isfile(init_path):
        return None
    spec = importlib.util.spec_from_file_location(
        _BUNDLE_PKG_NAME, init_path,
        submodule_search_locations=[ENGINE_DIR])
    if spec is None or spec.loader is None:
        return None
    # Import WITHOUT emitting bytecode: a __pycache__/ dropped into the bundle
    # would be an untracked extra file inside a directory whose exact contents
    # check (b) pins, and would show up as site drift in test_site.py.
    saved = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        pkg = importlib.util.module_from_spec(spec)
        sys.modules[_BUNDLE_PKG_NAME] = pkg
        spec.loader.exec_module(pkg)
        return importlib.import_module(_BUNDLE_PKG_NAME + ".validate")
    finally:
        sys.dont_write_bytecode = saved


def accepted_root_set(validate_mod, tags, refusal):
    """The set of root tags this engine ACCEPTS, decided by running it.

    For each candidate tag an empty element with that tag is handed to
    ``validate_mod.validate_root``. The document is meaningless, so a heap of
    business-rule violations is expected and irrelevant; the ONE thing read
    off the result is whether the engine emitted its structural refusal (the
    ``refusal`` rule id, itself discovered from the engine under test — see
    :func:`refusal_rule_id`). No refusal means the engine took the root
    seriously enough to run rules over it, i.e. it accepts that root.

    :param validate_mod: a ``validate`` module (packaged or bundled).
    :param tags: candidate root tags, from :func:`_root_tag_universe`.
    :param refusal: the structural-refusal rule id for this engine.
    :returns: ``(accepted, errors)`` — the accepted tag set, and a
        ``tag -> exception class name`` map for tags the engine blew up on
        (compared too, so a crash-divergence is not silently an "acceptance"
        difference).
    """
    accepted = set()
    errors = {}
    for tag in tags:
        try:
            result = validate_mod.validate_root(
                ET.Element(tag), ACCEPTED_ROOT_PROFILE)
        except Exception as exc:  # noqa: BLE001 — a crash IS a divergence
            errors[tag] = type(exc).__name__
            continue
        if not any(getattr(v, "rule_id", None) == refusal
                   for v in result.violations):
            accepted.add(tag)
    return accepted, errors


def refusal_rule_id(validate_mod):
    """The structural-refusal rule id this engine emits for an unsupported
    root, read from the engine itself rather than written out here: probe the
    sentinel roots and take the id both come back with. Keeps the probe honest
    if the id is ever renamed, and returns ``None`` when the engine does not
    refuse a nonsense root with exactly one violation — a state the caller
    must treat as a failure, because it would make the parity check vacuous.
    """
    ids = None
    for sentinel in ACCEPTED_ROOT_SENTINELS:
        try:
            result = validate_mod.validate_root(
                ET.Element(sentinel), ACCEPTED_ROOT_PROFILE)
        except Exception:  # noqa: BLE001
            return None
        got = {getattr(v, "rule_id", None) for v in result.violations}
        if len(got) != 1:
            return None
        if ids is not None and got != ids:
            return None
        ids = got
    return next(iter(ids)) if ids else None


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

    # ---- (g) ACCEPTED-ROOT PARITY ------------------------------------------
    # Byte-identity above already compares the files the manifest LISTS; this
    # asks the independent question "do the two engines answer the same way?",
    # which is what a reader of the browser page actually experiences. It is
    # what catches a dispatch change (T-VHCII3.1's raw-CII routing) shipped
    # without a bundle regen.
    accepted_pkg = accepted_bundle = None
    bundled_validate = None
    tags = []
    try:
        bundled_validate = _import_bundled_engine()
    except Exception as exc:  # noqa: BLE001
        check(False, "bundled engine does not import as a self-contained "
                     "package (%s: %s) — the browser could not run it either"
                     % (type(exc).__name__, exc))
    check(bundled_validate is not None,
          "bundled engine exposes no importable validate module")

    if bundled_validate is not None:
        pkg_validate = _einvoice.validate
        # The candidate universe is the UNION of what both engines mention, so
        # a root only one side knows about is still probed on both — exactly
        # the stale-bundle case.
        pkg_py = [os.path.join(PKG_DIR, fn) for fn in sorted(os.listdir(PKG_DIR))
                  if fn.endswith(".py")]
        bundle_py = [os.path.join(ENGINE_DIR, fn) for fn in sorted(files)
                     if fn.endswith(".py")]
        locals_pkg, ns_pkg = _harvest_root_literals(pkg_py)
        locals_bun, ns_bun = _harvest_root_literals(bundle_py)
        tags = _root_tag_universe(locals_pkg | locals_bun, ns_pkg | ns_bun)
        check(len(tags) > 10,
              "root-tag universe is implausibly small (%d) — the ast harvest "
              "found nothing, so parity would be vacuous" % len(tags))

        refusal_pkg = refusal_rule_id(pkg_validate)
        refusal_bun = refusal_rule_id(bundled_validate)
        check(refusal_pkg is not None,
              "packaged engine does not refuse a nonsense root with exactly "
              "one structural violation — cannot derive the refusal rule id")
        check(refusal_bun == refusal_pkg,
              "bundled engine's structural refusal id %r != packaged %r"
              % (refusal_bun, refusal_pkg))

        if refusal_pkg is not None and refusal_bun is not None:
            accepted_pkg, errors_pkg = accepted_root_set(
                pkg_validate, tags, refusal_pkg)
            accepted_bundle, errors_bundle = accepted_root_set(
                bundled_validate, tags, refusal_bun)

            # The probe must discriminate: real roots in, nonsense out.
            check(bool(accepted_pkg),
                  "packaged engine accepted NO root at all — probe is broken")
            for sentinel in ACCEPTED_ROOT_SENTINELS:
                check(sentinel not in accepted_pkg,
                      "packaged engine ACCEPTS the nonsense root %r — the "
                      "generic structural fatal no longer fires" % sentinel)
                check(sentinel not in accepted_bundle,
                      "bundled engine ACCEPTS the nonsense root %r — the "
                      "generic structural fatal no longer fires" % sentinel)

            check(accepted_pkg == accepted_bundle,
                  "ACCEPTED_ROOT set differs between the packaged engine and "
                  "the browser bundle — re-run gen_site.py. "
                  "package-only=%s bundle-only=%s"
                  % (sorted(accepted_pkg - accepted_bundle)[:5],
                     sorted(accepted_bundle - accepted_pkg)[:5]))
            check(errors_pkg == errors_bundle,
                  "the two engines CRASH on different roots; package-only=%s "
                  "bundle-only=%s"
                  % (sorted(set(errors_pkg) - set(errors_bundle))[:5],
                     sorted(set(errors_bundle) - set(errors_pkg))[:5]))

    if failures:
        sys.stderr.write("WEB BUNDLE TEST: FAIL (%d)\n" % len(failures))
        for m in failures[:40]:
            sys.stderr.write("  !! " + m + "\n")
        return 1
    print("web bundle OK: %d modules + %d declared data file(s) (%s) "
          "byte-identical to the package, manifest hashes/list/version "
          "bound, imports self-contained (stdlib only), traced closure "
          "matches, ACCEPTED_ROOT parity holds (%d accepted of %d probed "
          "root tags)."
          % (len(bundle_mods), len(bundle_data), ", ".join(sorted(bundle_data)),
             len(accepted_pkg or ()), len(tags) if accepted_pkg else 0))
    return 0


def check_web_bundle():
    """Importable entry point — the ONE definition of "the bundle is fresh".

    Runs the exact same checks :func:`main` runs (it *is* ``main``; nothing is
    reimplemented or subsetted here) with stdout/stderr captured, so a caller
    inside another test runner gets a value instead of console noise.

    Used by the registered gate ``test_packaging.py`` (claim 6) — see the
    REGISTERED-GATE CARRIER note at the top of this file. Keep this the only
    seam: a second copy of the byte-comparison loop anywhere else is precisely
    the drift this guard exists to prevent.

    :returns: ``(rc, report)`` — ``rc`` is 0 iff the committed bundle is
        byte-identical to the packaged engine with a current manifest, and
        ``report`` is main()'s own diagnostic text (the ``!!`` failure lines on
        failure, the one-line summary on success).
    """
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = main()
    return rc, (err.getvalue() + out.getvalue()).strip()


if __name__ == "__main__":
    sys.exit(main())
