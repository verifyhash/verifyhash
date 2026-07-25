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

Standard library only, no network anywhere. Run:
    python3 test_verify_live_paths.py
"""

from __future__ import annotations

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
