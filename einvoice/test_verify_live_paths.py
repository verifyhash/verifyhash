#!/usr/bin/env python3
"""test_verify_live_paths.py — verify_live.py must cover the WHOLE committed
``www/`` tree (T-VHLIVE.1).

WHY (measured gap): verify_live.py is the supervisor's post-deploy check —
the last line of defence before the owner trusts a redeploy. Until this task
its BYTE_COMPARE / SPOT_200 lists were hand-kept and had silently fallen
behind the tree: the four newest buyer-facing page families (``/de/``,
``/de/walkthrough/``, ``/compare/``, ``/licensing/``) were committed and
sitemapped but NEVER checked live, so a partial deploy that dropped them
would have passed "verification". verify_live.py now DERIVES its lists from
the committed tree (``verify_live.committed_pages()``); this test pins that
binding so the gap can never reopen.

WHAT IS ASSERTED (all offline — no network anywhere; the import itself runs
under a socket trap so verify_live.py can never grow network-at-import):

  (a) COMPLETENESS: every ``www/**/index.html`` plus ``sitemap.xml`` and
      ``robots.txt`` — enumerated here with an independent walk — maps to
      exactly one BYTE_COMPARE entry with the correct live sub-path, and
      that sub-path appears in SPOT_200. A page family missing from either
      list fails the run.
  (b) NO PHANTOMS: every file BYTE_COMPARE references exists on disk, and
      every SPOT_200 path corresponds to a committed page — the script can
      never demand a URL the tree does not ship (which would make every
      live run red) or check a file that is not deployed.
  (c) THE FOUR ONCE-MISSING FAMILIES are explicitly present in BOTH lists:
      ``/de/``, ``/de/walkthrough/``, ``/compare/``, ``/licensing/`` — the
      regression this task exists for, pinned by name.
  (d) NON-VACUITY: the rule-page count in BYTE_COMPARE equals the number of
      ``www/rules/<RULE-ID>/`` directories (counted via os.listdir, a
      mechanism independent of the os.walk both sides use), and the core
      families (``/``, ``/rules/``, ``/walkthrough/``, ``/sitemap.xml``,
      ``/robots.txt``) are present — a decayed walker cannot go green.
  (e) PARITY DERIVATIONS (T-VHLIVEV.2): the four expectation sources the
      new sitemap/share/noindex parity checks compare the live origin
      against — ``committed_base()``, ``sitemapped_pages()``,
      ``surface_pages()``, ``robots_partition()``, ``stride_sample()`` and
      the ``canon_loc()`` normaliser — are re-derived here by independent
      means (regex over sitemap.xml and robots.txt instead of ElementTree,
      os.listdir instead of os.walk) and must agree. This is the anti-rot
      binding: a checker whose EXPECTED values were hard-coded, or whose
      derivation silently returned an empty set, would go green against any
      live origin at all, which is worse than no check.
  (f) ENGINE BUNDLE (T-VHWEB.6): the ``/validate/engine/`` inventory —
      the only files on the site that are EXECUTED — is derived from the
      committed ``manifest.json``'s own ``files`` list, re-derived here by
      a directory listing, and must agree, be >= 10 entries and hold a
      well-formed sha256 for every name. The comparison is then proved
      MUTATION-SENSITIVE ON A DIGEST: flipping ONE character of ONE
      ``sha256`` value in an in-memory manifest copy must be reported
      against that file NAME. That is the whole point — on the stale
      deploy this task was written for the ``files`` list was identical
      (19 == 19) while 4 digests disagreed.

Standard library only, no network anywhere. Run:
    python3 test_verify_live_paths.py
"""

from __future__ import annotations

import copy
import json
import os
import re
import socket
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
WWW = os.path.join(HERE, "www")

# --------------------------------------------------------------------------- #
# Import verify_live under a socket trap: module import must be pure data
# (verify_live gates all network behind main()). If an edit ever moves a GET
# to import time, this raises immediately instead of letting a "unit test"
# hit the live site.
# --------------------------------------------------------------------------- #
_REAL_SOCKET = socket.socket


class _NoNetworkAtImport(_REAL_SOCKET):
    """Still a class (stdlib ssl subclasses socket.socket at import time),
    but any attempt to actually CREATE a socket raises."""

    def __init__(self, *_args, **_kwargs):
        raise AssertionError(
            "verify_live.py tried to open a socket at IMPORT time — all "
            "network must stay behind main(); this suite is offline by "
            "contract")


socket.socket = _NoNetworkAtImport  # type: ignore[misc]
try:
    import verify_live  # noqa: E402
finally:
    socket.socket = _REAL_SOCKET  # type: ignore[assignment]

# The four page families whose absence from the old hand-kept lists motivated
# this task — pinned by name so the exact regression is named on failure.
ONCE_MISSING_FAMILIES = ("/de/", "/de/walkthrough/", "/compare/", "/licensing/")


def independent_expected_pages():
    """(live sub-path -> rel file) for the committed www/ tree.

    Deliberately re-implemented here (not calling verify_live.committed_pages)
    so the test is an independent enumeration of the tree, not a tautology.
    """
    expected = {}
    for dirpath, _dirnames, filenames in os.walk(WWW):
        if "index.html" not in filenames:
            continue
        rel = os.path.relpath(os.path.join(dirpath, "index.html"), WWW)
        rel = rel.replace(os.sep, "/")
        sub = "/" if rel == "index.html" else "/" + rel[: -len("index.html")]
        expected[sub] = rel
    for extra in ("sitemap.xml", "robots.txt"):
        expected["/" + extra] = extra
    return expected


class TestCompleteness(unittest.TestCase):
    """(a) every committed page family is in BOTH lists."""

    def test_every_committed_page_maps_into_byte_compare(self):
        expected = independent_expected_pages()
        got = dict(verify_live.BYTE_COMPARE)
        self.assertEqual(
            len(got), len(verify_live.BYTE_COMPARE),
            "BYTE_COMPARE contains a duplicated live sub-path")
        missing = sorted(set(expected) - set(got))
        self.assertFalse(
            missing,
            "committed page families ABSENT from BYTE_COMPARE — a deploy "
            "dropping them would pass live verification: %s" % missing)
        for sub, rel in sorted(expected.items()):
            with self.subTest(path=sub):
                self.assertEqual(
                    got[sub], rel,
                    "BYTE_COMPARE maps %s to %r, committed tree says %r"
                    % (sub, got[sub], rel))

    def test_every_committed_page_is_spot_checked(self):
        expected = independent_expected_pages()
        spot = set(verify_live.SPOT_200)
        missing = sorted(set(expected) - spot)
        self.assertFalse(
            missing,
            "committed page families ABSENT from SPOT_200: %s" % missing)

    def test_sitemap_and_robots_are_covered(self):
        got = dict(verify_live.BYTE_COMPARE)
        for sub, rel in (("/sitemap.xml", "sitemap.xml"),
                         ("/robots.txt", "robots.txt")):
            self.assertEqual(got.get(sub), rel)
            self.assertIn(sub, verify_live.SPOT_200)


class TestNoPhantoms(unittest.TestCase):
    """(b) the lists never reference anything the tree does not ship."""

    def test_every_byte_compare_file_exists_on_disk(self):
        for sub, rel in verify_live.BYTE_COMPARE:
            with self.subTest(path=sub):
                self.assertTrue(
                    os.path.isfile(os.path.join(WWW, rel)),
                    "BYTE_COMPARE references www/%s which is not committed"
                    % rel)

    def test_no_stale_entries_beyond_the_tree(self):
        expected = independent_expected_pages()
        extra_bc = sorted(set(dict(verify_live.BYTE_COMPARE)) - set(expected))
        self.assertFalse(
            extra_bc,
            "BYTE_COMPARE checks paths the committed tree does not ship "
            "(every live run would be red): %s" % extra_bc)
        extra_spot = sorted(set(verify_live.SPOT_200) - set(expected))
        self.assertFalse(
            extra_spot,
            "SPOT_200 demands paths the committed tree does not ship: %s"
            % extra_spot)

    def test_spot_200_has_no_duplicates(self):
        self.assertEqual(
            len(verify_live.SPOT_200), len(set(verify_live.SPOT_200)),
            "SPOT_200 contains duplicate paths")


class TestOnceMissingFamilies(unittest.TestCase):
    """(c) the exact regression this task fixes, pinned by name."""

    def test_the_four_families_are_in_both_lists(self):
        got = dict(verify_live.BYTE_COMPARE)
        spot = set(verify_live.SPOT_200)
        for fam in ONCE_MISSING_FAMILIES:
            with self.subTest(family=fam):
                self.assertIn(
                    fam, got,
                    "%s (a committed buyer-facing surface) is missing from "
                    "BYTE_COMPARE — the T-VHLIVE.1 regression reopened" % fam)
                self.assertEqual(got[fam], fam.lstrip("/") + "index.html")
                self.assertIn(fam, spot, "%s missing from SPOT_200" % fam)


class TestNonVacuity(unittest.TestCase):
    """(d) a decayed walker cannot pass — counts bound to the tree."""

    def test_rule_page_count_matches_rules_directory(self):
        rules_dir = os.path.join(WWW, "rules")
        rule_dirs = sorted(
            d for d in os.listdir(rules_dir)
            if os.path.isdir(os.path.join(rules_dir, d)))
        self.assertGreater(len(rule_dirs), 0, "www/rules/ has no rule pages")
        byte_rule_pages = sorted(
            sub for sub, _rel in verify_live.BYTE_COMPARE
            if sub.startswith("/rules/") and sub != "/rules/")
        self.assertEqual(
            len(byte_rule_pages), len(rule_dirs),
            "BYTE_COMPARE holds %d rule pages but www/rules/ holds %d rule "
            "directories" % (len(byte_rule_pages), len(rule_dirs)))

    def test_core_families_present(self):
        got = dict(verify_live.BYTE_COMPARE)
        for sub in ("/", "/rules/", "/walkthrough/",
                    "/sitemap.xml", "/robots.txt"):
            self.assertIn(sub, got, "core path %s missing" % sub)
        # the full surface is the ~290-page tree, never a hand-kept handful
        self.assertGreaterEqual(
            len(verify_live.BYTE_COMPARE), len(ONCE_MISSING_FAMILIES) + 5)

    def test_module_stays_import_pure(self):
        # Executable statement of the import contract: the module exposes
        # main() (all network lives behind it) and plain-data lists.
        self.assertTrue(callable(getattr(verify_live, "main", None)))
        for sub, rel in verify_live.BYTE_COMPARE:
            self.assertIsInstance(sub, str)
            self.assertIsInstance(rel, str)
            self.assertTrue(sub.startswith("/"))
            self.assertFalse(rel.startswith("/"))


class TestParityDerivations(unittest.TestCase):
    """(e) the EXPECTED side of the live parity checks is really derived.

    Every assertion below re-derives the same fact from the committed tree
    by a different mechanism than verify_live uses, so agreement is
    evidence and not a tautology.
    """

    # -- independent re-derivations ------------------------------------- #

    @staticmethod
    def _sitemap_locs_by_regex():
        """<loc> texts via regex — verify_live uses ElementTree."""
        with open(os.path.join(WWW, "sitemap.xml"), encoding="utf-8") as fh:
            return [t.strip() for t in re.findall(r"<loc>(.*?)</loc>", fh.read(), re.S)]

    @staticmethod
    def _rule_dirs():
        """Rule ids via os.listdir — verify_live uses os.walk."""
        rules = os.path.join(WWW, "rules")
        return sorted(d for d in os.listdir(rules)
                      if os.path.isdir(os.path.join(rules, d)))

    # -- committed_base -------------------------------------------------- #

    def test_committed_base_is_read_from_the_tree(self):
        base = verify_live.committed_base()
        self.assertTrue(base.startswith("http"), base)
        self.assertFalse(base.endswith("/"), "base must be slash-normalised")
        locs = self._sitemap_locs_by_regex()
        self.assertTrue(locs, "sitemap.xml yielded no <loc> — extraction broken")
        for loc in locs:
            self.assertTrue(
                loc.startswith(base + "/") or loc == base + "/",
                "committed_base() %r is not a prefix of committed loc %r"
                % (base, loc))
        with open(os.path.join(WWW, "robots.txt"), encoding="utf-8") as fh:
            m = re.search(r"(?im)^\s*Sitemap:\s*(\S+)", fh.read())
        self.assertIsNotNone(m, "robots.txt has no Sitemap: line")
        self.assertEqual(m.group(1), base + "/sitemap.xml")

    # -- canon_loc normalisation ----------------------------------------- #

    def test_canon_loc_normalises_both_sides_identically(self):
        base = verify_live.committed_base()
        # trailing slash and surrounding whitespace must not create a diff
        self.assertEqual(verify_live.canon_loc(base + "/rules/BR-51/", base),
                         verify_live.canon_loc("  " + base + "/rules/BR-51  ",
                                               base + "/"))
        # the root reduces to "/" whether or not the slash is there
        self.assertEqual(verify_live.canon_loc(base + "/", base), "/")
        self.assertEqual(verify_live.canon_loc(base, base), "/")
        # a URL on ANOTHER origin is kept whole, so it shows up as a
        # difference instead of being folded into the local path space
        other = verify_live.canon_loc("https://example.invalid/x/", base)
        self.assertTrue(other.startswith("https://example.invalid"), other)

    def test_committed_and_live_sitemaps_agree_when_identical(self):
        """The parity comparison is reflexive: the committed loc set
        normalised against the committed base equals itself normalised
        against a DIFFERENT origin, so pointing --base at a staging host
        does not report all 24 URLs as differences."""
        base = verify_live.committed_base()
        locs = self._sitemap_locs_by_regex()
        here = {verify_live.canon_loc(u, base) for u in locs}
        staged = {verify_live.canon_loc(u.replace(base, "https://stg.invalid/e"),
                                        "https://stg.invalid/e") for u in locs}
        self.assertEqual(here, staged)
        self.assertEqual(len(here), len(locs), "normalisation collided URLs")

    # -- sitemapped_pages / surface_pages -------------------------------- #

    def test_sitemapped_pages_matches_the_sitemap(self):
        base = verify_live.committed_base()
        expected = {verify_live.canon_loc(u, base)
                    for u in self._sitemap_locs_by_regex()}
        got = {verify_live._norm_path(sub)
               for sub, _rel in verify_live.sitemapped_pages()}
        self.assertEqual(
            got, expected,
            "sitemapped_pages() disagrees with www/sitemap.xml "
            "(only-derived=%s only-in-sitemap=%s)"
            % (sorted(got - expected)[:5], sorted(expected - got)[:5]))
        for _sub, rel in verify_live.sitemapped_pages():
            self.assertTrue(os.path.isfile(os.path.join(WWW, rel)),
                            "sitemapped page www/%s is not committed" % rel)

    def test_surface_pages_are_the_non_rule_sitemapped_pages(self):
        surface = verify_live.surface_pages()
        sitemapped = verify_live.sitemapped_pages()
        self.assertTrue(surface, "surface_pages() is empty — the share "
                                 "parity check would be vacuous")
        self.assertLess(len(surface), len(sitemapped),
                        "surface_pages() did not exclude the rule pages")
        for sub, rel in surface:
            self.assertIn((sub, rel), sitemapped)
            self.assertFalse(
                rel.startswith("rules/") and rel != "rules/index.html",
                "%s is a per-rule detail page, not a surface page" % sub)

    def test_every_surface_page_carries_the_expected_share_tags(self):
        """The EXPECTED tag names come off the committed page (never a list
        typed into verify_live), so each surface page must actually carry a
        card — otherwise the live comparison would expect nothing."""
        for sub, rel in verify_live.surface_pages():
            with self.subTest(path=sub):
                with open(os.path.join(WWW, rel), encoding="utf-8") as fh:
                    tags = verify_live.share_tags(fh.read())
                for floor in verify_live.SHARE_FLOOR:
                    self.assertIn(floor, tags,
                                  "committed www/%s carries no %s" % (rel, floor))
                self.assertGreaterEqual(
                    len(tags), 6,
                    "www/%s yielded only %d og:/twitter: tags — the share-tag "
                    "parser has decayed" % (rel, len(tags)))
                self.assertTrue(all(v.strip() for v in tags.values()),
                                "www/%s has an empty share tag value" % rel)

    # -- robots_partition / stride_sample -------------------------------- #

    def test_robots_partition_covers_every_rule_page_exactly_once(self):
        noindex, indexable = verify_live.robots_partition()
        ni = {sub for sub, _rel, _c in noindex}
        ix = {sub for sub, _rel, _c in indexable}
        self.assertFalse(ni & ix, "a rule page landed in both partitions")
        expected = {"/rules/%s/" % rid for rid in self._rule_dirs()}
        self.assertEqual(
            ni | ix, expected,
            "robots_partition() does not cover www/rules/ exactly "
            "(missing=%s extra=%s)"
            % (sorted(expected - (ni | ix))[:5], sorted((ni | ix) - expected)[:5]))
        self.assertTrue(ni, "no committed-noindex rule pages found — the "
                            "noindex parity check would be vacuous")
        self.assertTrue(ix, "no committed-indexable rule pages found — the "
                            "indexable half of the check would be vacuous")

    def test_indexable_partition_equals_the_sitemapped_rule_pages(self):
        """Cross-check against a wholly different source: a rule page is
        indexable IFF the sitemap lists it (the invariant
        test_share_metadata.py enforces on the generator side)."""
        _noindex, indexable = verify_live.robots_partition()
        ix = {verify_live._norm_path(sub) for sub, _rel, _c in indexable}
        base = verify_live.committed_base()
        sitemapped_rules = {
            verify_live.canon_loc(u, base) for u in self._sitemap_locs_by_regex()
            if verify_live.canon_loc(u, base).startswith("/rules/")
            and verify_live.canon_loc(u, base) != "/rules"}
        self.assertEqual(ix, sitemapped_rules,
                         "committed robots meta and sitemap.xml disagree about "
                         "which rule pages are indexable")

    def test_stride_sample_is_deterministic_and_bounded(self):
        noindex, _ix = verify_live.robots_partition()
        first = verify_live.stride_sample(noindex, 8)
        second = verify_live.stride_sample(list(reversed(noindex)), 8)
        self.assertEqual(first, second, "stride_sample() is order-dependent — "
                                        "two runs would report different pages")
        self.assertLessEqual(len(first), 8)
        self.assertEqual(len(first), len(set(first)), "sample has duplicates")
        for item in first:
            self.assertIn(item, noindex)
        self.assertEqual(verify_live.stride_sample([], 8), [])
        self.assertEqual(verify_live.stride_sample(noindex, 0), [])
        # a strided sample spreads across the corpus rather than taking a
        # contiguous head — otherwise it only ever sees BR-01..BR-08
        self.assertNotEqual(first, sorted(noindex)[:len(first)])

    # -- source shape ----------------------------------------------------- #

    def test_source_names_the_checks_and_stays_stdlib_only(self):
        with open(os.path.join(HERE, "verify_live.py"), encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("SITEMAP_LOC_PARITY", src,
                      "the full-set sitemap parity check lost its stable name")
        self.assertIn("og:title", src, "the share parity floor is gone")
        for mod in ("requests", "httpx", "bs4", "lxml"):
            self.assertIsNone(
                re.search(r"(?m)^\s*(import|from)\s+%s\b" % mod, src),
                "verify_live.py imported the third-party module %r — this "
                "tool must stay stdlib-only" % mod)
        # network stays behind main(): no module-level _get call
        self.assertIsNone(re.search(r"(?m)^_get\(|^\w+\s*=\s*_get\(", src))


class TestShareAssets(unittest.TestCase):
    """``committed_share_assets()`` — the og:image card's live coverage.

    The card (T-VHSHARE.4) is the only committed file the site advertises
    that is NOT an ``index.html``, so ``committed_pages()`` cannot see it and
    the byte-compare phase would have skipped it. It is also the only asset
    whose absence is invisible to a human check of the deployed site: nothing
    links to it, so a live tree missing it browses perfectly while every
    social unfurl of the one-shot announce renders a blank tile. These tests
    pin the derivation the same way the rest of this file pins the others.
    """

    def setUp(self):
        self.assets = verify_live.committed_share_assets()

    def test_matches_the_landing_pages_og_image(self):
        """The list is DERIVED from the committed og:image, not typed."""
        with open(os.path.join(WWW, "index.html"), encoding="utf-8") as fh:
            page = fh.read()
        m = re.search(
            r'<meta property="og:image" content="([^"]*)">', page)
        if m is None:
            # Outcome (ii): no card ships. The derivation must then be empty
            # rather than demanding a URL the tree does not have.
            self.assertEqual(self.assets, [],
                             "no og:image is advertised, yet a share asset is "
                             "still claimed for live verification")
            return
        base = verify_live.committed_base().rstrip("/")
        self.assertTrue(m.group(1).startswith(base + "/"),
                        "og:image %r is not on the committed base %r"
                        % (m.group(1), base))
        rel = m.group(1)[len(base) + 1:]
        self.assertEqual([sub for sub, _ in self.assets], ["/" + rel],
                         "the derived share-asset set does not match the "
                         "og:image the landing page actually emits")

    def test_no_phantoms_and_no_pages(self):
        """Every claimed asset is a real committed file, and never a page."""
        for sub, rel in self.assets:
            path = os.path.join(WWW, rel.replace("/", os.sep))
            self.assertTrue(os.path.isfile(path),
                            "share asset %s has no committed file www/%s"
                            % (sub, rel))
            self.assertTrue(os.path.getsize(path) > 0,
                            "committed share asset www/%s is empty" % rel)
            self.assertFalse(rel.endswith("index.html"),
                             "%s is a page — it belongs to BYTE_COMPARE, not "
                             "the share-asset phase" % rel)
            # It must NOT be double-checked by the page walker.
            self.assertNotIn(rel, [r for _, r in verify_live.BYTE_COMPARE])

    def test_phase_is_wired_into_main(self):
        """A derived list nothing consumes would be silently dead code."""
        with open(os.path.join(HERE, "verify_live.py"), encoding="utf-8") as fh:
            src = fh.read()
        body = src.split("def main(", 1)[1]
        self.assertIn("committed_share_assets()", body,
                      "committed_share_assets() is never called from main() — "
                      "the card would go unverified on every deploy")

    def test_off_origin_image_is_not_claimed(self):
        """An og:image on someone else's origin is not ours to verify."""
        page = ('<meta property="og:image" '
                'content="https://cdn.example.net/card.png">')
        tags = verify_live.share_tags(page)
        self.assertEqual(tags.get("og:image"),
                         "https://cdn.example.net/card.png")
        base = verify_live.committed_base().rstrip("/")
        self.assertFalse(tags["og:image"].startswith(base + "/"),
                         "the off-origin fixture must not look like our own "
                         "card, or this test proves nothing")


class TestEngineBundle(unittest.TestCase):
    """(f) the EXECUTABLE inventory — ``/validate/engine/`` (T-VHWEB.6).

    WHY: the browser validator's Pyodide bundle holds the only files on the
    site that are actually RUN. A stale deploy ships HTML that byte-compares
    clean (``'0.2.7'`` and ``'0.2.9'`` are the same length, so even the sizes
    match) while the German conformance report, the provenance footer and the
    attestation digest silently run older code. The gap is visible ONLY in
    the manifest's separate top-level ``sha256`` MAP: measured on the live
    site this task was written for, the ``files`` LIST agreed on all 19
    entries while 4 digests disagreed. Every assertion below is offline.
    """

    ENGINE_SUBDIR = os.path.join(WWW, "validate", "engine")

    def independent_engine_names(self):
        """The bundle's file names re-derived WITHOUT verify_live's helpers.

        A plain directory listing minus ``manifest.json`` — a different
        mechanism than the manifest-driven derivation under test, so
        agreement is evidence rather than a tautology.
        """
        return {n for n in os.listdir(self.ENGINE_SUBDIR)
                if n != "manifest.json"
                and os.path.isfile(os.path.join(self.ENGINE_SUBDIR, n))}

    # -- the inventory ----------------------------------------------------- #

    def test_manifest_derivation_matches_an_independent_listing(self):
        derived = {rel.rsplit("/", 1)[-1]
                   for _sub, rel in verify_live.ENGINE_FILES}
        self.assertEqual(
            derived, self.independent_engine_names(),
            "the manifest-derived engine file set disagrees with the "
            "committed www/validate/engine/ directory listing — either the "
            "manifest is stale or the derivation is broken")

    def test_inventory_is_non_empty_and_substantial(self):
        self.assertGreaterEqual(
            len(verify_live.ENGINE_FILES), 10,
            "the engine inventory holds %d entries — a decayed derivation "
            "must not pass" % len(verify_live.ENGINE_FILES))
        for sub, rel in verify_live.ENGINE_FILES:
            self.assertEqual(sub, "/" + rel)
            self.assertTrue(rel.startswith("validate/engine/"))
            self.assertTrue(os.path.isfile(os.path.join(WWW, *rel.split("/"))),
                            "engine file www/%s does not exist on disk" % rel)
        # manifest.json is fetched separately, never as one of the entries
        self.assertNotIn("/validate/engine/manifest.json",
                         [s for s, _ in verify_live.ENGINE_FILES])

    def test_manifest_declares_a_digest_for_every_file(self):
        manifest = verify_live.committed_engine_manifest()
        self.assertEqual(set(manifest["files"]), set(manifest["sha256"]),
                         "the committed manifest's files list and sha256 map "
                         "disagree — the map comparison would be partly blind")
        for name, digest in manifest["sha256"].items():
            self.assertRegex(digest, r"^[0-9a-f]{64}$",
                             "%s carries a malformed sha256" % name)

    def test_no_hard_coded_file_names_in_the_source(self):
        with open(os.path.join(HERE, "verify_live.py"), encoding="utf-8") as fh:
            src = fh.read()
        for name in ("cli.py", "coverage.py", "report.py", "rules_xrechnung.py"):
            self.assertNotIn(
                '"%s"' % name, src,
                "verify_live.py hard-codes the engine file %r — the inventory "
                "must come from the manifest's own files list, or it goes "
                "blind the moment the bundle changes" % name)

    # -- the comparison is MUTATION-SENSITIVE ON A DIGEST ------------------ #

    def committed_manifest_copy(self):
        with open(os.path.join(WWW, "validate", "engine", "manifest.json"),
                  encoding="utf-8") as fh:
            return json.load(fh)

    def test_identical_manifests_compare_clean(self):
        committed = self.committed_manifest_copy()
        missing, extra, digests, version = verify_live.compare_engine_manifests(
            committed, copy.deepcopy(committed))
        self.assertEqual((missing, extra, digests, version), ([], [], [], None))

    def test_one_flipped_digest_character_is_reported_by_name(self):
        """THE POINT: a name-only comparison reproduces the bug it pins."""
        committed = self.committed_manifest_copy()
        live = copy.deepcopy(committed)
        target = sorted(live["sha256"])[0]
        original = live["sha256"][target]
        live["sha256"][target] = ("1" if original[0] != "1" else "2") + original[1:]
        self.assertNotEqual(live["sha256"][target], original)
        # the files LIST is untouched and identical — exactly the live case
        self.assertEqual(sorted(live["files"]), sorted(committed["files"]))

        missing, extra, digests, version = verify_live.compare_engine_manifests(
            committed, live)
        self.assertEqual(missing, [], "no name went missing in this mutation")
        self.assertEqual(extra, [])
        self.assertIsNone(version, "only a digest was mutated")
        self.assertEqual([name for name, _want, _got in digests], [target],
                         "flipping one character of %s's sha256 must be "
                         "reported against that file name" % target)
        name, want, got = digests[0]
        self.assertEqual(want, original)
        self.assertEqual(got, live["sha256"][target])

    def test_several_flipped_digests_are_all_reported(self):
        committed = self.committed_manifest_copy()
        live = copy.deepcopy(committed)
        targets = sorted(live["sha256"])[:4]
        for name in targets:
            live["sha256"][name] = "0" * 64
        _missing, _extra, digests, _version = \
            verify_live.compare_engine_manifests(committed, live)
        self.assertEqual([n for n, _w, _g in digests], targets)

    def test_version_only_mutation_is_reported_as_a_version_mismatch(self):
        committed = self.committed_manifest_copy()
        live = copy.deepcopy(committed)
        live["version"] = str(committed["version"]) + "-stale"
        missing, extra, digests, version = verify_live.compare_engine_manifests(
            committed, live)
        self.assertEqual((missing, extra, digests), ([], [], []))
        self.assertEqual(version, (committed["version"], live["version"]),
                         "a version disagreement must be its own finding, "
                         "never swallowed by an otherwise-clean bundle")

    def test_a_dropped_name_is_reported_as_missing_not_as_a_digest_diff(self):
        committed = self.committed_manifest_copy()
        live = copy.deepcopy(committed)
        dropped = sorted(live["files"])[0]
        live["files"] = [n for n in live["files"] if n != dropped]
        del live["sha256"][dropped]
        missing, extra, digests, _version = \
            verify_live.compare_engine_manifests(committed, live)
        self.assertEqual(missing, [dropped])
        self.assertEqual(extra, [])
        self.assertEqual(digests, [],
                         "a missing file must be reported once, not twice")

    def test_comparison_degrades_on_junk_input_instead_of_raising(self):
        """Offline / half-served manifests must not traceback."""
        committed = self.committed_manifest_copy()
        for junk in ({}, {"files": None}, {"files": [], "sha256": "nope"},
                     {"version": None}):
            missing, extra, digests, version = \
                verify_live.compare_engine_manifests(committed, junk)
            self.assertEqual(sorted(missing), sorted(committed["files"]))
            self.assertEqual(extra, [])
            self.assertEqual(digests, [])
            self.assertIsNotNone(version)

    # -- wiring ------------------------------------------------------------ #

    def test_phase_is_wired_into_main(self):
        with open(os.path.join(HERE, "verify_live.py"), encoding="utf-8") as fh:
            src = fh.read()
        body = src.split("def main(", 1)[1]
        for token in ("ENGINE_FILES", "compare_engine_manifests",
                      "ENGINE_MANIFEST_REL"):
            self.assertIn(token, body,
                          "main() never uses %s — the engine bundle would go "
                          "unverified on every deploy" % token)
        self.assertIn("engine bundle", body,
                      "main() prints no engine-bundle section header")
        # every engine finding rides the existing failures list / rc=1 path
        self.assertGreaterEqual(
            body.count("failures.append"), 20,
            "engine findings must be appended to the existing failures list")


if __name__ == "__main__":
    unittest.main(verbosity=2)
