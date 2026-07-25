#!/usr/bin/env python3
"""test_de_claim_parity.py — EN/DE landing-page CLAIM PARITY (T-VHTRUTH.4).

THE FAILURE THIS GATE EXISTS FOR
--------------------------------
This lane has shipped TWO false limitation claims to prospective buyers:

  * the "no UBL CreditNote support" denial (the engine validates a UBL 2.1
    CreditNote through the same ``rules.ALL_RULES`` core it runs an Invoice
    through), and
  * "noch nicht auf PyPI" (the distribution ``verifyhash-einvoice`` had been
    serving releases the whole time).

Both passed every internal test. The reason is structural, not sloppiness:
each was a NEGATIVE claim that existed ONLY in German prose. Nothing on the
English side could contradict a German sentence that had no English
counterpart, and no engine test can read prose, so the falsehood sat on the
highest-intent sales page until a human happened to notice. ``test_www_claims``
now catches those two *specific* denials by probing the engine — but only
because someone already knew to write the probe. This test attacks the CLASS.

WHAT IT ASSERTS
---------------
``gen_site.py`` emits every limitation / capability claim on the two landing
pages through ``gen_site._claim()``, which wraps it in the site's existing
``<span data-claim="…">`` convention (the same one ``render_compare`` uses to
bind engine figures back to the live registries) and gives an English claim and
its German twin the SAME slug. This module then:

  1. collects the ``data-claim`` slug set of ``www/index.html`` and
     ``www/de/index.html`` and asserts the two sets are EQUAL in BOTH
     directions — an identity comparison on slugs, never a prose heuristic;
  2. permits a genuinely locale-specific claim ONLY if it is declared in
     :data:`LOCALE_ONLY_CLAIMS` below, where every entry carries a written
     reason. An UNDECLARED asymmetry fails and names the slug and the page it
     is missing from;
  3. refuses stale allowlist entries (a declared locale-only slug that is no
     longer on the page it was excused for), so the allowlist cannot rot into
     a blanket exemption;
  4. binds the emitted slugs back to ``gen_site.LANDING_CLAIMS`` in both
     directions, so an unregistered slug or a registered-but-unused one fails;
  5. keeps a floor on how many claims each landing page carries, so "make the
     test pass" can never mean "stop tagging claims".

It does NOT judge whether a claim is true — that is ``test_www_claims.py``'s
job (executable probes against the shipped engine). This one guarantees that a
German claim always has an English counterpart to be judged AGAINST.

Offline, standard-library only, no network, no child processes, no writes;
runs in well under a second. Run: ``python3 test_de_claim_parity.py``
"""

from __future__ import annotations

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import gen_site as _gen  # noqa: E402

WWW_DIR = os.path.join(HERE, "www")

# The two pages in scope. Deliberately ONLY these: the landing pair is where
# the German limitation prose lives and where the EN/DE pairing is meaningful.
# (www/compare/ is English-only by design and carries its own claims-drift
# guard in test_site.py; the rule pages are catalog-generated.)
EN_PAGE = "index.html"
DE_PAGE = "de/index.html"

# ---------------------------------------------------------------------------
# LOCALE_ONLY_CLAIMS — the ONLY sanctioned asymmetries.
#
# slug -> "en" or "de": the single page the claim is allowed to appear on.
# EVERY entry carries a one-line reason. Adding an entry is a deliberate,
# reviewable act; forgetting to write the twin is not.
# ---------------------------------------------------------------------------
LOCALE_ONLY_CLAIMS = {
    # DE only: a statement about the German surface itself — there are no
    # per-rule German pages (the anti-thin-content line). The English landing
    # makes no such claim because it has nothing to concede here.
    "no-german-rule-pages": "de",
    # DE only: the German mandate reader is about to submit to a Rechnungs-
    # eingangsportal, so the DE quickstart names the "run your receiver's
    # official validator too" limit inline; the EN landing routes that same
    # guidance to compare/index.html instead of stating it here.
    "receiver-validator-still-required": "de",
    # EN only: the untrusted-input / XXE hardening section exists only on the
    # English landing (the DE page is quickstart-shaped and links across), so
    # its no-external-entity-resolution claim has no DE landing counterpart.
    "no-external-entity-resolution": "en",
}

# Floor on tagged claims per landing page. Both pages carry more than this
# today; the floor stops a future edit from "fixing" a parity failure by
# deleting tags instead of writing the missing twin.
MIN_CLAIMS_PER_PAGE = 5

_CLAIM_RE = re.compile(r'data-claim="([^"]+)"')


def _slugs(rel_path):
    """The set of data-claim slugs on one generated page."""
    path = os.path.join(WWW_DIR, *rel_path.split("/"))
    if not os.path.exists(path):
        raise AssertionError(
            "www/%s does not exist — run `python3 gen_site.py` first"
            % rel_path)
    with open(path, encoding="utf-8") as fh:
        return set(_CLAIM_RE.findall(fh.read()))


class ClaimParity(unittest.TestCase):
    """Every German limitation claim has an English twin, and vice versa."""

    @classmethod
    def setUpClass(cls):
        cls.en = _slugs(EN_PAGE)
        cls.de = _slugs(DE_PAGE)

    # -- the core invariant, both directions --------------------------------

    def test_every_de_claim_has_an_en_twin(self):
        missing = sorted(
            s for s in self.de - self.en
            if LOCALE_ONLY_CLAIMS.get(s) != "de")
        self.assertEqual(
            missing, [],
            "German landing claim(s) with NO English counterpart: %s.\n"
            "Each of these is tagged on www/%s but MISSING from www/%s. This "
            "is exactly how the CreditNote denial and 'noch nicht auf PyPI' "
            "shipped: a negative claim in German prose that no English-side "
            "assertion could contradict.\n"
            "Fix it by tagging the English twin with the SAME slug in "
            "gen_site.render_landing(), or — if the claim is genuinely "
            "German-only — add it to LOCALE_ONLY_CLAIMS with a written "
            "reason." % (", ".join(missing), DE_PAGE, EN_PAGE))

    def test_every_en_claim_has_a_de_twin(self):
        missing = sorted(
            s for s in self.en - self.de
            if LOCALE_ONLY_CLAIMS.get(s) != "en")
        self.assertEqual(
            missing, [],
            "English landing claim(s) with NO German counterpart: %s.\n"
            "Each of these is tagged on www/%s but MISSING from www/%s — the "
            "German reader is being shown a page that silently drops a limit "
            "the English page states.\n"
            "Fix it by tagging the German twin with the SAME slug in "
            "gen_site.render_de(), or add it to LOCALE_ONLY_CLAIMS with a "
            "written reason." % (", ".join(missing), EN_PAGE, DE_PAGE))

    def test_claim_sets_are_equal_modulo_the_allowlist(self):
        """The same invariant stated once more as a set identity.

        Redundant with the two directional tests on purpose: this is the
        one-line statement of the contract, and it fails with both sides
        printed so a reviewer can see the shape of the drift at a glance.
        """
        en_only_ok = {s for s, loc in LOCALE_ONLY_CLAIMS.items()
                      if loc == "en"}
        de_only_ok = {s for s, loc in LOCALE_ONLY_CLAIMS.items()
                      if loc == "de"}
        self.assertEqual(
            self.en - en_only_ok, self.de - de_only_ok,
            "landing claim slug sets differ after the allowlist.\n"
            "  www/%s: %s\n  www/%s: %s"
            % (EN_PAGE, sorted(self.en), DE_PAGE, sorted(self.de)))

    # -- the allowlist itself cannot rot ------------------------------------

    def test_allowlist_entries_are_live_and_one_sided(self):
        """A declared locale-only slug must actually be on its page — and
        nowhere else. A stale entry would silently excuse a future claim that
        happens to reuse the slug."""
        pages = {"en": (EN_PAGE, self.en), "de": (DE_PAGE, self.de)}
        for slug, locale in sorted(LOCALE_ONLY_CLAIMS.items()):
            self.assertIn(
                locale, pages,
                "LOCALE_ONLY_CLAIMS[%r] = %r is not 'en' or 'de'"
                % (slug, locale))
            rel, here = pages[locale]
            other_locale = "de" if locale == "en" else "en"
            other_rel, there = pages[other_locale]
            self.assertIn(
                slug, here,
                "stale allowlist entry: %r is excused as %s-only but is no "
                "longer emitted on www/%s — delete the LOCALE_ONLY_CLAIMS "
                "entry" % (slug, locale, rel))
            self.assertNotIn(
                slug, there,
                "%r is declared %s-only but ALSO appears on www/%s — it is a "
                "paired claim now, so remove it from LOCALE_ONLY_CLAIMS"
                % (slug, locale, other_rel))

    def test_allowlist_stays_small(self):
        """A guard whose allowlist swallows the claim set proves nothing."""
        self.assertLess(
            len(LOCALE_ONLY_CLAIMS), min(len(self.en), len(self.de)),
            "LOCALE_ONLY_CLAIMS (%d entries) has grown to rival the tagged "
            "claim sets (en=%d, de=%d) — the parity guard is being hollowed "
            "out one exemption at a time"
            % (len(LOCALE_ONLY_CLAIMS), len(self.en), len(self.de)))

    # -- binding back to the generator's own registry -----------------------

    def test_every_emitted_slug_is_registered_in_gen_site(self):
        unregistered = sorted((self.en | self.de) - set(_gen.LANDING_CLAIMS))
        self.assertEqual(
            unregistered, [],
            "landing page(s) emit data-claim slug(s) %s that gen_site."
            "LANDING_CLAIMS does not describe — register them (a slug with no "
            "written meaning cannot be reviewed for truth)"
            % (", ".join(unregistered),))

    def test_no_registered_slug_has_fallen_off_both_pages(self):
        unused = sorted(set(_gen.LANDING_CLAIMS) - (self.en | self.de))
        self.assertEqual(
            unused, [],
            "gen_site.LANDING_CLAIMS registers %s, but no landing page emits "
            "them any more — a claim was deleted or untagged; drop the "
            "registry entry deliberately if that was intended"
            % (", ".join(unused),))

    def test_registry_descriptions_are_substantive(self):
        for slug, why in sorted(_gen.LANDING_CLAIMS.items()):
            self.assertTrue(
                isinstance(why, str) and len(why.strip()) >= 20,
                "gen_site.LANDING_CLAIMS[%r] has no usable description "
                "(%r) — the description is what a reviewer checks the prose "
                "against" % (slug, why))

    # -- floors --------------------------------------------------------------

    def test_both_pages_carry_a_meaningful_number_of_claims(self):
        for rel, slugs in ((EN_PAGE, self.en), (DE_PAGE, self.de)):
            self.assertGreaterEqual(
                len(slugs), MIN_CLAIMS_PER_PAGE,
                "www/%s carries only %d data-claim slug(s); at least %d of "
                "its limitation/capability claims must stay machine-paired"
                % (rel, len(slugs), MIN_CLAIMS_PER_PAGE))

    def test_the_two_historically_false_claims_are_tagged_on_both_pages(self):
        """The two claims that actually shipped false are pinned by name, on
        both pages, so this guard can never be satisfied while the exact prose
        that burned us goes back to being invisible."""
        for slug in ("creditnote-validated", "pypi-published"):
            self.assertIn(slug, self.en,
                          "www/%s no longer tags %r — that claim shipped "
                          "FALSE once already" % (EN_PAGE, slug))
            self.assertIn(slug, self.de,
                          "www/%s no longer tags %r — that claim shipped "
                          "FALSE once already" % (DE_PAGE, slug))

    # -- the wrapper itself --------------------------------------------------

    def test_claim_helper_rejects_an_unregistered_slug(self):
        """gen_site._claim() is the only way a slug reaches a page, and it
        refuses one that is not in LANDING_CLAIMS — so a typo is a render-time
        error, not a silent unpaired claim discovered here."""
        with self.assertRaises(KeyError):
            _gen._claim("definitely-not-a-registered-slug", "x")
        self.assertEqual(
            _gen._claim("no-xsd", "text"),
            '<span data-claim="no-xsd">text</span>',
            "gen_site._claim no longer emits the site's data-claim wrapper "
            "convention")


if __name__ == "__main__":
    unittest.main(verbosity=2)
