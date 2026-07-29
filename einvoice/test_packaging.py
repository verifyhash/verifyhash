#!/usr/bin/env python3
"""test_packaging.py — prove the T-79.4 packaging/distribution claims.

What is actually asserted (each maps to a README/pyproject claim):

  1. ENTRY POINTS: `python3 -m einvoice`, the source-checkout `einvoice.py`
     wrapper, and the console-script target `einvoice.cli:main` are the SAME
     working CLI (exit codes 0/1/2 exercised for real, rule ID named on fail).
  2. PACKAGING METADATA: pyproject.toml declares ZERO runtime dependencies,
     the `einvoice = einvoice.cli:main` console script, and a version that
     matches `einvoice.__version__` (no drift).
  3. EMBEDDABILITY: the bare `einvoice/` package directory, copied ALONE into
     an empty directory (no corpus, no repo, no pyproject), still validates a
     real invoice — i.e. an ERP can vendor just the package, stdlib only.
  4. CI GATE: ci/validate-invoices.sh fails a build on a non-conformant
     invoice NAMING the violated rule ID, passes conformant ones, and refuses
     to green an empty input set.
  5. (env-guarded) a wheel actually builds via pip and contains the package +
     the console-script entry point — skipped when setuptools < 61.
  6. SHIPPED WEB BUNDLE: the committed `www/validate/engine/` bundle — the
     engine the zero-install browser validator at /einvoice/validate/ actually
     runs — is byte-identical to the packaged engine and its manifest sha256
     map is current. This is a DISTRIBUTION claim like the others: the browser
     bundle is a shipped copy of the package, and a stale copy means a
     prospect evaluates a product we no longer sell. Asserted by DELEGATION to
     `test_web_bundle.check_web_bundle()` — that guard owns the definition of
     "fresh"; this file owns only the fact that a registered gate runs it.
     (T-VHWEB.4: the bundle sat ~15 commits stale, 6c4dd18..9ed0b74, because
     test_web_bundle.py was not registered anywhere. Now it cannot be.)
  7. STOREFRONT METADATA: the PyPI project page is the only discovery channel
     for this package that needs no owner action, and up to 0.2.7 it was a
     dead end — one Project-URL (to a repo root), no keywords, no licence text
     in the artifact. `StorefrontMetadata` below pins the fix: every declared
     Project-URL is https and on a domain we own, at least three of them reach
     the product's own pages, keywords exist and stay honest (`peppol` must
     never appear), exactly one Development Status classifier is declared, the
     per-minor Python classifiers agree with requires-python, and the licence
     text the artifact ships is really there and really Apache-2.0.

Standard library only. Runs offline.
"""

import ast
import contextlib
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.parse
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

PKG_DIR = os.path.join(HERE, "einvoice")
WRAPPER = os.path.join(HERE, "einvoice.py")
PYPROJECT = os.path.join(HERE, "pyproject.toml")
GATE = os.path.join(HERE, "ci", "validate-invoices.sh")
NOTICE = os.path.join(HERE, "NOTICE")
REPO_LICENSE = os.path.join(os.path.dirname(HERE), "LICENSE")
#: The committed sitemap is the authoritative list of pages that EXIST on our
#: own domain. Any verifyhash.com URL in the rendered long description must be
#: one of these — the storefront may not invent a page.
SITEMAP = os.path.join(HERE, "www", "sitemap.xml")
BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                    "business-cases", "standard", "01.01a-INVOICE_ubl.xml")


def run(cmd, **kw):
    kw.setdefault("capture_output", True)
    kw.setdefault("text", True)
    kw.setdefault("timeout", 120)
    return subprocess.run(cmd, **kw)


def make_bad_invoice(dest):
    """Copy BASE with its BuyerReference removed -> violates BR-DE-15 (fatal)."""
    with open(BASE, encoding="utf-8") as fh:
        src = fh.read()
    bad = re.sub(r"<cbc:BuyerReference>[^<]*</cbc:BuyerReference>", "", src,
                 count=1)
    assert bad != src, "fixture drift: BASE lost its BuyerReference"
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(bad)


def _strip_full_line_comments(chunk):
    """Drop whole-line ``#`` comments. Deliberately does NOT touch trailing
    comments or ``#`` inside strings, so it cannot corrupt a URL fragment."""
    return "\n".join(ln for ln in chunk.splitlines()
                     if not ln.lstrip().startswith("#"))


def toml_table(text, name):
    """Body of the TOML table ``[name]``: everything after its header up to the
    next top-level ``[...]`` header. Returns None when the table is absent.

    Same deliberately-dumb line-scan approach as test_release_discipline.py's
    ``pyproject_version()`` and test_wheel_self_report.py's parsers: Python
    here is 3.10, which has no ``tomllib``, and the zero-dependency contract
    forbids pulling in ``tomli``. Scoping by table means a key under one table
    can never be mistaken for the same key under another.
    """
    m = re.search(r"(?m)^\[%s\]\s*$" % re.escape(name), text)
    if m is None:
        return None
    rest = text[m.end():]
    nxt = re.search(r"(?m)^\[[^\]]+\]\s*$", rest)
    return rest[:nxt.start()] if nxt else rest


def toml_list(section, key):
    """``key = [ ... ]`` inside ``section``, as a Python list.

    TOML array-of-strings syntax is a subset of Python literal syntax once
    whole-line comments are removed, so ``ast.literal_eval`` is enough and no
    parser dependency is needed.
    """
    m = re.search(r"(?m)^\s*%s\s*=\s*(\[.*?\])" % re.escape(key), section,
                  re.S)
    if m is None:
        return None
    return ast.literal_eval(_strip_full_line_comments(m.group(1)))


def toml_string_pairs(section):
    """``key = "value"`` lines of a TOML table, as an ordered list of pairs.

    Handles both bare keys (``Homepage``) and quoted keys (``"Why not
    KoSIT?"``), which [project.urls] needs because a PyPI sidebar label may
    contain spaces and punctuation.
    """
    pairs = []
    for line in section.splitlines():
        if line.lstrip().startswith("#"):
            continue
        m = re.match(r'^\s*(?:"([^"]+)"|([A-Za-z0-9_.\- ]+?))\s*=\s*'
                     r'"([^"]*)"\s*$', line)
        if m:
            pairs.append(((m.group(1) or m.group(2)).strip(), m.group(3)))
    return pairs


#: Inline markdown link target: the ``target`` of ``[text](target)``. Targets
#: containing whitespace are not matched on purpose — markdown's ``(url "title")``
#: form is not used anywhere in this tree, and excluding whitespace keeps prose
#: like "…) (see" from being captured as a URL.
MD_LINK_RE = re.compile(r"\]\(([^)\s]+)\)")

#: Link targets that need no file/page to resolve against: in-page anchors and
#: mail links.
_MD_NON_FILE_PREFIXES = ("#", "mailto:")

#: Docs that exist in the working tree but NOT at ``origin/main``. Measured
#: 2026-07-29 with ``git cat-file -e origin/main:einvoice/<f>`` over all 29
#: distinct link targets of README.md: 27 present, exactly these two absent.
#:
#: This is the SAME ground on which
#: ``StorefrontMetadata.test_no_changelog_url_until_the_file_is_actually_pushed``
#: keeps a Changelog entry out of [project.urls]: a link to a file that is not on
#: the published branch is a 404 for every visitor, and the push that would fix
#: it is an owner decision this suite cannot make. So the rendered long
#: description NAMES these two files in plain text instead of linking them.
#: Relative was not an alternative — PyPI does not rewrite relative markdown
#: targets, so a relative link is a 404 with extra steps. Remove an entry here in
#: the same change that pushes the file, never before.
DOCS_NOT_ON_ORIGIN_MAIN = ("RECEIPT-VERIFICATION.md", "QUICKSTART.de.md")

#: The three own-domain pages the rendered body must reach, and why: what is it,
#: why not the incumbent, can I try it without installing anything. Same three
#: the [project.urls] sidebar guard requires, because a reader who arrives at the
#: body scrolls rather than looking at the sidebar.
REQUIRED_PRODUCT_PAGES = (
    "https://verifyhash.com/einvoice/",
    "https://verifyhash.com/einvoice/compare/",
    "https://verifyhash.com/einvoice/validate/",
)


def sitemap_locations(path=SITEMAP):
    """The ``<loc>`` set of the committed sitemap.

    Regex, not an XML parser, for the same reason the pyproject readers above
    are line scans: the file is generated by gen_site.py from a single
    ``BASE_URL`` and its shape is asserted by test_site.py section (e). This
    function only needs the URL set.
    """
    with open(path, encoding="utf-8") as fh:
        return set(re.findall(r"<loc>([^<]+)</loc>", fh.read()))


class EntryPoints(unittest.TestCase):
    """One CLI, three doors: -m, source wrapper, console-script target."""

    def test_python_dash_m_passes_valid_invoice(self):
        proc = run([sys.executable, "-m", "einvoice", "validate", BASE,
                    "--profile=xrechnung"], cwd=HERE)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("PASS", proc.stdout)

    def test_python_dash_m_fails_bad_invoice_naming_rule_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            proc = run([sys.executable, "-m", "einvoice", "validate", bad,
                        "--profile=xrechnung"], cwd=HERE)
            self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
            self.assertIn("BR-DE-15", proc.stdout)

    def test_python_dash_m_usage_error(self):
        proc = run([sys.executable, "-m", "einvoice"], cwd=HERE)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("usage:", proc.stderr)

    def test_source_wrapper_same_behaviour(self):
        # From an UNRELATED cwd, to prove the wrapper's sys.path shim works.
        with tempfile.TemporaryDirectory() as tmp:
            proc = run([sys.executable, WRAPPER, "validate", BASE,
                        "--profile=xrechnung"], cwd=tmp)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("PASS", proc.stdout)

    def test_console_script_target_importable_and_runs_in_process(self):
        # The exact target named in pyproject [project.scripts].
        from einvoice.cli import main
        self.assertTrue(callable(main))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main(["validate", BASE, "--profile=xrechnung"])
        self.assertEqual(code, 0)
        self.assertIn("PASS", out.getvalue())


class PackagingMetadata(unittest.TestCase):
    def setUp(self):
        with open(PYPROJECT, encoding="utf-8") as fh:
            self.text = fh.read()

    def test_zero_runtime_dependencies_declared(self):
        m = re.search(r"^dependencies\s*=\s*\[(.*?)\]", self.text,
                      re.M | re.S)
        self.assertIsNotNone(m, "pyproject.toml must declare `dependencies`")
        self.assertEqual(re.sub(r"\s|#.*", "", m.group(1)), "",
                         "runtime dependencies MUST stay empty (stdlib-only "
                         "is the product claim)")

    def test_console_script_points_at_real_entry(self):
        self.assertIn("[project.scripts]", self.text)
        m = re.search(r'^einvoice\s*=\s*"([^"]+)"', self.text, re.M)
        self.assertIsNotNone(m, "console script `einvoice` missing")
        self.assertEqual(m.group(1), "einvoice.cli:main")
        # …and the target genuinely exists (guards a rename breaking install).
        import einvoice.cli
        self.assertTrue(callable(einvoice.cli.main))

    def test_version_no_drift(self):
        import einvoice
        m = re.search(r'^version\s*=\s*"([^"]+)"', self.text, re.M)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), einvoice.__version__)

    def test_description_scopes_the_100pct_claim(self):
        """The one-line package card (`pip show` / the live PyPI card) must
        state the ENGINE-DERIVED rule count and keep the SAME scope caveat
        README §2 + CORRECTNESS.md keep. A legally-forced compliance product
        must not imply full-standard conformance on metadata a buyer might
        read alone — and it must not UNDERclaim either: the 0.1.0-era
        '50 of ~200 … not yet implemented' wording survived the 0.2.0 bump
        onto the live PyPI page, repelling the exact audience the engine
        already serves. Rule-count truth lives in
        coverage.engine_fireable_ids(); this guard (with the cross-file
        binding in test_docs_rule_claims.py, which covers action/README.md
        too) makes that staleness structurally impossible at future bumps."""
        m = re.search(r'^description\s*=\s*"([^"]+)"', self.text, re.M)
        self.assertIsNotNone(m, "pyproject.toml must declare a description")
        desc = m.group(1)
        low = desc.lower()
        # The claimed rule count is bound to the live engine registry — the
        # number is never folklore. (Same source of truth as the README /
        # CHANGELOG guards in test_docs_rule_claims.py.)
        from einvoice import coverage
        live = len(coverage.engine_fireable_ids())
        counts = [int(n) for n in
                  re.findall(r"\b(\d+)\s+business\s+rules\b", desc)]
        self.assertTrue(
            counts,
            "description must state the rule count as '<N> business rules' "
            "so this guard can bind it to engine_fireable_ids()")
        for n in counts:
            self.assertEqual(
                n, live,
                "description claims %d business rules but "
                "engine_fireable_ids() returns %d — update the description "
                "(metadata fix), never the engine" % (n, live))
        # Honest-scope caveat, same shape as README §2: scoped to the
        # implemented set, pointing at CORRECTNESS.md.
        self.assertIn("within the implemented set", low,
                      "description must scope its differential claim to the "
                      "implemented set, as README §2 does")
        self.assertIn("correctness.md", low,
                      "description must point at CORRECTNESS.md for the "
                      "honest remaining scope")
        # The stale 0.1.0-era phrasings must never come back.
        for stale in ("50 of ~200", "not yet implemented"):
            self.assertNotIn(stale, low,
                             "stale 0.1.0-era claim %r resurfaced in the "
                             "description" % stale)
        if "100%" in low:
            self.assertIn(
                "implemented", low,
                "a bare '100% agreement' claim on the metadata card is an "
                "overclaim; scope it to the implemented set")

    def test_only_the_package_ships(self):
        m = re.search(r'^packages\s*=\s*\[\s*"einvoice"\s*\]', self.text, re.M)
        self.assertIsNotNone(m, "wheel must contain ONLY the einvoice package "
                                "(never corpus/, ci/, tests)")


class Embeddability(unittest.TestCase):
    def test_bare_package_copy_validates_alone(self):
        """Copy ONLY einvoice/ (the package) into an empty dir; it must work
        with nothing else present — the vendor-embed scenario."""
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(PKG_DIR, os.path.join(tmp, "einvoice"),
                            ignore=shutil.ignore_patterns("__pycache__"))
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            code = ("import sys\n"
                    "from einvoice.cli import main\n"
                    "sys.exit(main(sys.argv[1:]))\n")
            # cwd=tmp puts the copied package first on sys.path; -E/-s keep
            # the interpreter from pulling anything from the outer env.
            ok = run([sys.executable, "-E", "-s", "-c", code, "validate",
                      BASE, "--profile=xrechnung"], cwd=tmp)
            self.assertEqual(ok.returncode, 0, ok.stderr)
            fail = run([sys.executable, "-E", "-s", "-c", code, "validate",
                        bad, "--profile=xrechnung"], cwd=tmp)
            self.assertEqual(fail.returncode, 1, fail.stdout + fail.stderr)
            self.assertIn("BR-DE-15", fail.stdout)


class CiGate(unittest.TestCase):
    """ci/validate-invoices.sh — the copy-paste build gate."""

    def gate(self, *args, env_extra=None):
        env = dict(os.environ)
        # Pin the REPORT entrypoint so the test exercises OUR tree, not a stray
        # pip-installed `einvoice` on PATH. The gate drives
        # `python3 -m einvoice.report --format junit`, so EINVOICE_CMD must
        # invoke that module (the legacy validate CLI would not understand
        # --format junit).
        env["EINVOICE_CMD"] = "%s -m einvoice.report" % sys.executable
        if env_extra:
            env.update(env_extra)
        return run(["sh", GATE] + list(args), env=env, cwd=HERE)

    def test_gate_passes_conformant_invoices(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copy(BASE, os.path.join(tmp, "good.xml"))
            proc = self.gate(tmp)
            self.assertEqual(proc.returncode, 0,
                             proc.stdout + proc.stderr)
            self.assertIn("PASS", proc.stdout)

    def test_gate_fails_build_naming_rule_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copy(BASE, os.path.join(tmp, "good.xml"))
            make_bad_invoice(os.path.join(tmp, "bad.xml"))
            proc = self.gate(tmp)
            self.assertEqual(proc.returncode, 1,
                             proc.stdout + proc.stderr)
            self.assertIn("BR-DE-15", proc.stdout)      # the rule ID, named
            self.assertIn("NON-CONFORMANT", proc.stdout)
            self.assertIn("1/2", proc.stdout)           # and counted honestly

    def test_gate_fails_on_malformed_xml(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "broken.xml"), "w") as fh:
                fh.write("<Invoice><unclosed>")
            proc = self.gate(tmp)
            self.assertEqual(proc.returncode, 1,
                             proc.stdout + proc.stderr)
            # The report entrypoint renders a not-well-formed input as a
            # `not-well-formed` JUnit testcase (exit 3 per invoice -> the gate
            # counts it non-conformant and prints the label).
            self.assertIn("not well-formed", proc.stdout.lower())

    def test_gate_refuses_empty_input_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = self.gate(tmp)
            self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)

    def test_gate_allows_empty_only_when_opted_in(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = self.gate(tmp, env_extra={"EINVOICE_ALLOW_EMPTY": "1"})
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_gate_respects_profile_env(self):
        # bad.xml only violates the GERMAN layer; core-only profile passes it.
        with tempfile.TemporaryDirectory() as tmp:
            make_bad_invoice(os.path.join(tmp, "bad.xml"))
            proc = self.gate(tmp, env_extra={"EINVOICE_PROFILE": "en16931"})
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


class WebBundleFreshness(unittest.TestCase):
    """Claim 6 — the shipped browser bundle is a CURRENT copy of the package.

    Pure delegation, on purpose. The byte-identity / manifest / self-
    containment / accepted-root-parity logic lives in exactly one place,
    `test_web_bundle.py`; duplicating any of it here would recreate the drift
    it guards against one level up. All this test contributes is REACHABILITY:
    test_packaging.py is a registered gate, test_web_bundle.py was not.
    """

    def test_shipped_web_bundle_matches_the_packaged_engine(self):
        # Imported lazily so test_web_bundle's module-level sys.path edits and
        # engine imports only happen when this claim actually runs.
        sys.path.insert(0, HERE)
        import test_web_bundle

        self.assertTrue(
            os.path.isdir(os.path.join(HERE, "www", "validate", "engine")),
            "www/validate/engine/ is missing — the browser validator has no "
            "engine to run")
        rc, report = test_web_bundle.check_web_bundle()
        self.assertEqual(
            rc, 0,
            "the committed www/validate/engine/ bundle is STALE or divergent "
            "from einvoice/ — regenerate it with `python3 gen_site.py` (never "
            "hand-edit a bundled file or manifest.json).\n" + report)


class StorefrontMetadata(unittest.TestCase):
    """Claim 7 — the PyPI project page is navigable, honest, and self-contained.

    HOW THIS IS ASSERTED, honestly: these are contract tests over the
    DECLARATIONS THAT SHAPE the artifact, not over a real METADATA file. This
    file's own `WheelBuild` test is the only place that builds a wheel (it is
    env-guarded on setuptools>=61 and pip), and
    test_wheel_self_report.build_install_image() reproduces the wheel's
    *package payload* only — it copies `packages` + `package-data` and models
    nothing about `dist-info/licenses/`. So nothing here pretends to read
    METADATA; each test names the pyproject key it is guarding and, where a
    declaration points at a file on disk (license-files), checks that file for
    real. Building or installing a distribution to test this would mean pip,
    a build backend or the network inside a gate, which this suite does not do.
    """

    maxDiff = None

    def setUp(self):
        with open(PYPROJECT, encoding="utf-8") as fh:
            self.text = fh.read()
        self.project = toml_table(self.text, "project")
        self.assertIsNotNone(self.project, "pyproject.toml has no [project]")
        urls = toml_table(self.text, "project.urls")
        self.assertIsNotNone(urls,
                             "[project.urls] is missing — the PyPI sidebar is "
                             "the package's only no-owner-action discovery "
                             "channel")
        self.url_pairs = toml_string_pairs(urls)

        # The long description PyPI actually renders. Read from the `readme`
        # KEY, never from a hard-coded "README.md": the route comment above that
        # key records that we chose to keep README.md itself and rewrite its
        # links (route A), and if a later change declares a dedicated
        # PyPI-facing readme instead, this contract must travel with it rather
        # than silently start guarding an unpublished file.
        m = re.search(r'(?m)^readme\s*=\s*"([^"]+)"',
                      _strip_full_line_comments(self.project))
        self.assertIsNotNone(
            m, "[project] declares no `readme` — PyPI would render an empty "
               "page body, which is the whole discovery channel gone")
        self.readme_name = m.group(1)
        readme_path = os.path.join(HERE, self.readme_name)
        self.assertTrue(
            os.path.isfile(readme_path),
            "`readme = \"%s\"` names a file that is not in einvoice/ — the "
            "build would fail and the page body would be empty"
            % self.readme_name)
        with open(readme_path, encoding="utf-8") as fh:
            self.readme = fh.read()
        self.readme_links = MD_LINK_RE.findall(self.readme)
        self.readme_abs = [u for u in self.readme_links
                           if u.startswith(("http://", "https://"))]
        self.readme_own = [u for u in self.readme_abs
                           if urllib.parse.urlsplit(u).netloc
                           == "verifyhash.com"]

    # ---------------------------------------------------------------- URLs

    def test_every_project_url_is_https_and_on_a_domain_we_own(self):
        self.assertTrue(self.url_pairs, "[project.urls] declares nothing")
        for label, url in self.url_pairs:
            self.assertTrue(
                url.startswith("https://"),
                "Project-URL %r is not https: %r" % (label, url))
            parts = urllib.parse.urlsplit(url)
            self.assertEqual(parts.scheme, "https", url)
            if parts.netloc == "verifyhash.com":
                continue
            # Only our own repository on GitHub — not the org root, not a
            # third-party host. A PyPI sidebar link is an endorsement; we only
            # endorse addresses we control.
            self.assertEqual(
                parts.netloc, "github.com",
                "Project-URL %r points at a host we do not own: %r"
                % (label, url))
            self.assertTrue(
                parts.path == "/verifyhash/verifyhash"
                or parts.path.startswith("/verifyhash/verifyhash/"),
                "Project-URL %r is on github.com but not on the verifyhash "
                "repository: %r" % (label, url))

    def test_product_pages_and_issue_tracker_are_reachable_from_pypi(self):
        values = [u for _, u in self.url_pairs]
        product = [u for u in values
                   if u.startswith("https://verifyhash.com/einvoice/")]
        self.assertGreaterEqual(
            len(product), 3,
            "the PyPI sidebar must reach at least three of the product's own "
            "pages, not just a repo root; got %r" % (product,))
        # The three that answer a visitor's first three questions: what is it,
        # why not the incumbent, can I try it without installing anything.
        for required in ("https://verifyhash.com/einvoice/",
                         "https://verifyhash.com/einvoice/compare/",
                         "https://verifyhash.com/einvoice/validate/"):
            self.assertIn(required, values,
                          "[project.urls] must link %s" % required)
        issues = [(k, v) for k, v in self.url_pairs
                  if re.search(r"issue|bug|tracker", k, re.I)]
        self.assertTrue(
            issues,
            "no Issues / Bug Tracker URL declared — a user who hits a false "
            "positive on a legally-forced compliance run must be one click "
            "from reporting it; got labels %r"
            % ([k for k, _ in self.url_pairs],))
        for _, url in issues:
            self.assertTrue(url.endswith("/issues"), url)

    def test_no_changelog_url_until_the_file_is_actually_pushed(self):
        """einvoice/CHANGELOG.md is not at origin/main, so a blob/main link
        would 404 for every visitor. The omission is deliberate and the
        pyproject comment must keep saying why, so that whoever pushes the
        history knows to add the link in the same change."""
        for label, url in self.url_pairs:
            self.assertNotRegex(
                label, r"(?i)change ?log",
                "a Changelog Project-URL is declared, but the file it would "
                "point at is not on origin/main yet")
            self.assertNotIn(
                "/blob/main/", url,
                "Project-URL %r links a repository blob (%r); blob links go "
                "stale silently — link a published page instead" % (label, url))
        self.assertIn(
            "CHANGELOG.md", self.text,
            "the reason the Changelog URL is omitted must stay written down "
            "in pyproject.toml")

    # ------------------------------------------- rendered long description

    def test_rendered_readme_links_are_absolute_and_reach_our_own_pages(self):
        """The page BODY must be navigable, not just the sidebar.

        Up to 0.2.7 the `readme` target was a 70.7 KB graph of 49 RELATIVE
        markdown links (29 distinct targets) against exactly ONE absolute link
        — and that one went to pre-commit.com. PyPI does not rewrite relative
        markdown targets, so every in-repo pointer resolved against pypi.org
        and led nowhere: the reader who wanted CORRECTNESS.md, the document the
        honest-scope pitch defers to, clicked into a 404. Nothing structural
        prevented that, which is what this test is for.
        """
        self.assertGreaterEqual(
            len(self.readme_abs), 10,
            "%s carries only %d absolute link(s); a relative markdown target "
            "resolves against pypi.org and 404s, so the rendered body must "
            "point at real URLs" % (self.readme_name, len(self.readme_abs)))
        self.assertGreaterEqual(
            len(self.readme_own), 3,
            "%s reaches %d page(s) on verifyhash.com; the body must reach at "
            "least three of our own pages (we prefer our domain over a "
            "github.com blob wherever both cover the topic); got %r"
            % (self.readme_name, len(self.readme_own), self.readme_own))
        for required in REQUIRED_PRODUCT_PAGES:
            self.assertIn(
                required, self.readme_own,
                "%s must link %s — the body answers 'what is it / why not the "
                "incumbent / can I try it without installing anything' or it "
                "is not a storefront" % (self.readme_name, required))
        # Route A's actual contract: no in-repo target survives. Anchors
        # (`#section`) and mailto: resolve without a file and stay as they are.
        leftover = sorted({
            t for t in self.readme_links
            if not t.startswith(("http://", "https://"))
            and not t.startswith(_MD_NON_FILE_PREFIXES)})
        self.assertEqual(
            [], leftover,
            "%s still carries relative link target(s) %r — on pypi.org they "
            "resolve against pypi.org/project/... and 404. Make them absolute "
            "(verifyhash.com page, or .../blob/main/einvoice/<file>), or name "
            "the file in plain text if it is not on origin/main yet."
            % (self.readme_name, leftover))

    def test_every_own_domain_url_in_the_readme_is_a_page_that_exists(self):
        """A verifyhash.com URL in the body must be in the committed sitemap.

        The sitemap is generated from gen_site.py's single BASE_URL and is the
        authoritative list of pages that exist, so this catches an invented or
        renamed path offline — no probe, no network. Own-domain links get this
        check and github.com ones do not, because we control one of those two.
        """
        locs = sitemap_locations()
        self.assertGreaterEqual(
            len(locs), 8,
            "www/sitemap.xml parsed to %d <loc> entries — the parse looks "
            "broken, so this guard would be vacuously green" % len(locs))
        unknown = sorted({u for u in self.readme_own
                          if u.split("#", 1)[0] not in locs})
        self.assertEqual(
            [], unknown,
            "%s links verifyhash.com URL(s) %r that are not a <loc> in the "
            "committed www/sitemap.xml. Either the page does not exist (invent "
            "no URL) or the site was regenerated without it."
            % (self.readme_name, unknown))

    def test_readme_never_links_a_doc_that_is_not_on_origin_main(self):
        """Same reasoning as the Changelog guard above, applied to the body.

        `RECEIPT-VERIFICATION.md` and `QUICKSTART.de.md` are the only two of
        README.md's 29 link targets absent from origin/main. Linking either —
        relatively OR as a blob URL — ships a 404 for an unknown period,
        because the push is an owner decision. They must be NAMED in plain
        text instead, so the reader still learns the file exists and where,
        and the pyproject comment must keep saying why.
        """
        for doc in DOCS_NOT_ON_ORIGIN_MAIN:
            offenders = sorted({t for t in self.readme_links if doc in t})
            self.assertEqual(
                [], offenders,
                "%s links %s (%r), but that file is not at origin/main — the "
                "link 404s for every visitor. Name it in plain text until the "
                "history that carries it is pushed."
                % (self.readme_name, doc, offenders))
            # Named, not silently deleted: dropping the mention would "fix"
            # this guard by hiding a document adopters are told to read.
            self.assertIn(
                doc, self.readme,
                "%s no longer even NAMES %s — the fix for an unpushed doc is "
                "plain text, not amnesia" % (self.readme_name, doc))
            self.assertIn(
                doc, self.text,
                "pyproject.toml must keep recording why %s is named rather "
                "than linked, so whoever pushes the history knows to link it "
                "in the same change" % doc)

    # ------------------------------------------------------------ keywords

    def test_keywords_are_present_and_claim_nothing_we_do_not_do(self):
        keywords = toml_list(self.project, "keywords")
        self.assertIsNotNone(keywords,
                             "pyproject.toml must declare `keywords` — PyPI "
                             "search has nothing else to match on")
        self.assertTrue(keywords, "`keywords` is empty")
        for kw in keywords:
            self.assertIsInstance(kw, str)
            self.assertTrue(kw.strip(), "blank keyword in %r" % (keywords,))
            self.assertEqual(kw, kw.lower(), "keyword %r is not lower-case" % kw)
        self.assertEqual(len(keywords), len(set(keywords)),
                         "duplicate keyword in %r" % (keywords,))
        # `peppol` is the one term this product refuses. What is vendored is
        # the 21-assert KoSIT `PEPPOL-EN16931-R*` subset, NOT the OpenPeppol
        # ruleset — CORRECTNESS.md §5 says so explicitly ("the OpenPeppol
        # ruleset proper beyond the KoSIT-vendored subset … it makes no claim
        # at all"). A `peppol` keyword would sell a capability we do not have,
        # so it is banned from the whole file, not merely from the list.
        hits = [i + 1 for i, ln in enumerate(self.text.splitlines())
                if "peppol" in ln.lower()]
        self.assertEqual(
            hits, [],
            "`peppol` must not appear anywhere in pyproject.toml (found on "
            "line(s) %r): the vendored subset is 21 KoSIT asserts, not the "
            "OpenPeppol ruleset (CORRECTNESS.md §5)" % (hits,))

    # --------------------------------------------------------- classifiers

    def test_exactly_one_development_status_and_it_is_the_decided_one(self):
        classifiers = toml_list(self.project, "classifiers")
        self.assertIsNotNone(classifiers)
        status = [c for c in classifiers if c.startswith("Development Status ::")]
        self.assertEqual(
            len(status), 1,
            "exactly one Development Status classifier may be declared; got %r"
            % (status,))
        # Decided against CORRECTNESS.md §5 and recorded as a comment in
        # pyproject.toml: §5's limits are SCOPE limits (no XSD, no signatures,
        # "corpus, not universe"), not maturity limits, and "Alpha" is the one
        # word that disqualifies a validator from a compliance pipeline.
        self.assertEqual(status[0], "Development Status :: 4 - Beta")
        self.assertIn("CORRECTNESS.md", self.text,
                      "the Development-Status decision must stay traceable to "
                      "CORRECTNESS.md from pyproject.toml itself")

    def test_python_minor_classifiers_agree_with_requires_python(self):
        classifiers = toml_list(self.project, "classifiers")
        m = re.search(r'(?m)^\s*requires-python\s*=\s*">=3\.(\d+)"\s*$',
                      self.project)
        self.assertIsNotNone(
            m, "requires-python must be a `>=3.N` floor for this guard")
        floor = int(m.group(1))
        minors = sorted(
            int(c.rsplit(".", 1)[1]) for c in classifiers
            if re.fullmatch(r"Programming Language :: Python :: 3\.\d+", c))
        self.assertTrue(
            minors,
            "no per-minor `Programming Language :: Python :: 3.N` classifiers "
            "— PyPI's sidebar version filter has nothing to match")
        self.assertGreaterEqual(
            minors[0], floor,
            "classifier claims Python 3.%d but requires-python is >=3.%d"
            % (minors[0], floor))
        self.assertEqual(
            minors[0], floor,
            "requires-python allows 3.%d but the lowest classified minor is "
            "3.%d — the sidebar filter would hide us from users on the oldest "
            "version we actually support" % (floor, minors[0]))
        self.assertEqual(
            minors, list(range(minors[0], minors[-1] + 1)),
            "the classified Python minors have a hole in them: %r" % (minors,))
        self.assertIn("Programming Language :: Python :: 3", classifiers,
                      "keep the generic Python 3 classifier alongside the "
                      "per-minor ones")
        for required in ("Topic :: Software Development :: Quality Assurance",
                         "Natural Language :: German",
                         "Natural Language :: English"):
            self.assertIn(required, classifiers)

    # ------------------------------------------------------------- licence

    def test_licence_text_ships_inside_the_distribution(self):
        setuptools_table = toml_table(self.text, "tool.setuptools")
        self.assertIsNotNone(setuptools_table)
        license_files = toml_list(setuptools_table, "license-files")
        self.assertIsNotNone(
            license_files,
            "[tool.setuptools] must declare `license-files` — up to 0.2.7 the "
            "artifact carried no LICENSE at all")
        for name in ("LICENSE", "NOTICE"):
            self.assertIn(
                name, license_files,
                "an explicit license-files list REPLACES setuptools' default "
                "LICENSE*/NOTICE* glob, so omitting %s silently stops "
                "shipping it" % name)
        for name in license_files:
            path = os.path.join(HERE, name)
            self.assertTrue(os.path.isfile(path),
                            "declared license file %r does not exist next to "
                            "pyproject.toml" % name)
            self.assertGreater(os.path.getsize(path), 0,
                               "declared license file %r is empty" % name)
        # Byte-equality with the repo-root original, the same duplicated-
        # artifact discipline test_attestation.py / test_remediation_catalog.py
        # apply to attestation.json and remediation_catalog.json.
        with open(os.path.join(HERE, "LICENSE"), "rb") as fh:
            shipped = fh.read()
        with open(REPO_LICENSE, "rb") as fh:
            root = fh.read()
        self.assertEqual(
            shipped, root,
            "einvoice/LICENSE has drifted from the repo-root LICENSE (%d vs "
            "%d bytes) — it must be a byte-identical copy"
            % (len(shipped), len(root)))

    def test_license_declaration_and_classifier_agree_with_the_shipped_text(self):
        classifiers = toml_list(self.project, "classifiers")
        osi = [c for c in classifiers if c.startswith("License :: ")]
        table = re.search(r'(?m)^\s*license\s*=\s*\{\s*text\s*=\s*"([^"]+)"',
                          self.project)
        string = re.search(r'(?m)^\s*license\s*=\s*"([^"]+)"\s*$', self.project)
        self.assertTrue(table or string,
                        "pyproject.toml must declare a `license` key")
        if string:
            # PEP 639 route: License-Expression. Only legal from setuptools 77,
            # and it BANS the OSI classifier — so the build-system floor must
            # have been raised in the same change.
            declared = string.group(1)
            self.assertEqual(osi, [],
                             "PEP 639 `license = \"...\"` forbids a "
                             "`License ::` classifier; found %r" % (osi,))
            floor = re.search(r'setuptools>=(\d+)', self.text)
            self.assertIsNotNone(floor)
            self.assertGreaterEqual(
                int(floor.group(1)), 77,
                "a PEP 639 license expression needs setuptools>=77, but "
                "[build-system] still promises a lower floor")
        else:
            # Table route, which is what the declared setuptools>=61 floor
            # honours (see the comment in pyproject.toml).
            declared = table.group(1)
            self.assertIn("License :: OSI Approved :: Apache Software License",
                          osi)
        self.assertEqual(declared, "Apache-2.0")
        with open(os.path.join(HERE, "LICENSE"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("Apache License", text)
        self.assertIn("Version 2.0", text)

    def test_notice_does_not_send_the_reader_off_the_artifact(self):
        """Apache-2.0 §4(a) asks a redistributor to hand over the licence text.
        Up to 0.2.7 the NOTICE ended by pointing at "the LICENSE file at the
        repository root" — a file the distribution did not contain, so the
        artifact described something the recipient did not hold."""
        with open(NOTICE, encoding="utf-8") as fh:
            notice = fh.read()
        self.assertNotIn(
            "license text is the LICENSE file", notice,
            "the NOTICE still points at a LICENSE the recipient may not have")
        self.assertNotRegex(
            notice, r"(?is)full license text[^.]{0,120}repository root",
            "the NOTICE still sends the reader to the repository for the "
            "licence text instead of to the copy shipped beside it")
        self.assertIn("LICENSE", notice,
                      "the NOTICE should still name the LICENSE file that now "
                      "travels with the distribution")


def _setuptools_can_pep621():
    try:
        import setuptools
        return int(setuptools.__version__.split(".")[0]) >= 61
    except Exception:
        return False


class WheelBuild(unittest.TestCase):
    @unittest.skipUnless(_setuptools_can_pep621(),
                         "needs setuptools>=61 (PEP 621) to build the wheel")
    def test_wheel_builds_offline_and_contains_entry_point(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Build from a COPY of the source, never against the real tree.
            # pip 21.3+ does in-tree builds, so setuptools writes build/ and
            # *.egg-info/ NEXT TO pyproject.toml; pointing that at HERE would
            # leave build junk in the working tree (and none of it is
            # gitignored deeply enough to be safe from a `git add -A`). A
            # throwaway copy keeps "tests leave the tree clean" true by
            # construction, on every setuptools>=61 machine.
            src = os.path.join(tmp, "src")
            os.mkdir(src)
            shutil.copytree(PKG_DIR, os.path.join(src, "einvoice"),
                            ignore=shutil.ignore_patterns("__pycache__"))
            # pyproject.toml + the README it references + the two declared
            # license-files are all the backend needs (packages = ["einvoice"]
            # is explicit; no corpus/tests). LICENSE/NOTICE are copied because
            # setuptools SILENTLY skips a license-files pattern that matches
            # nothing (measured), so a build from a tree missing them would
            # produce a green wheel with no licence in it — exactly the 0.2.7
            # bug this test now guards.
            for f in ("pyproject.toml", "README.md", "LICENSE", "NOTICE"):
                shutil.copy(os.path.join(HERE, f), os.path.join(src, f))
            out = os.path.join(tmp, "wheels")
            os.mkdir(out)
            proc = run([sys.executable, "-m", "pip", "wheel",
                        "--no-build-isolation", "--no-deps", "--no-index",
                        "-w", out, src], timeout=300)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            wheels = [f for f in os.listdir(out) if f.endswith(".whl")]
            self.assertEqual(len(wheels), 1, wheels)
            with zipfile.ZipFile(os.path.join(out, wheels[0])) as zf:
                names = zf.namelist()
                self.assertIn("einvoice/cli.py", names)
                self.assertNotIn("corpus", " ".join(names))
                ep = next(n for n in names if n.endswith("entry_points.txt"))
                self.assertIn("einvoice = einvoice.cli:main",
                              zf.read(ep).decode())
                # The licence text really lands in the built artifact. Where
                # setuptools puts it moved over the versions (dist-info/ root
                # on old releases, dist-info/licenses/ since 77), so match on
                # "inside .dist-info, by basename" rather than on a fixed path.
                dist_info = [n for n in names if ".dist-info/" in n]
                for want in ("LICENSE", "NOTICE"):
                    hit = [n for n in dist_info
                           if os.path.basename(n) == want]
                    self.assertEqual(
                        len(hit), 1,
                        "%s is not in the wheel's .dist-info; the artifact "
                        "would ship without its licence text again. Members: "
                        "%r" % (want, dist_info))
                    with open(os.path.join(HERE, want), "rb") as fh:
                        self.assertEqual(zf.read(hit[0]), fh.read(),
                                         "wheel's %s differs from the source "
                                         "tree copy" % want)


if __name__ == "__main__":
    unittest.main(verbosity=2)
