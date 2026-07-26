#!/usr/bin/env python3
"""test_docs_rule_claims.py — README rule-coverage honesty guard (T-VHDOCV.4).

MEASURE-FIRST result (why this file is new, not a duplicate). The adjacent
coverage guards each bind a *different* pair of artifacts, and none binds the
README's prose/table rule claims to the live engine:

  * test_coverage_matrix.py — COVERAGE.md / coverage_matrix.json ↔ engine
                              registries (it never reads README.md).
  * test_coverage_gap.py    — GAP.md ↔ engine fireable set.
  * test_cli_docs_parity.py — CLI command/flag/exit-code surface ↔ docs; it
                              greps README.md for *flags*, never for rule ids.

So the specific gap this closes: nothing stopped README.md's "Implemented"
tables from claiming a rule the engine cannot fire, or its "NOT covered yet"
section from still listing a rule the engine has since implemented — exactly
the silent overclaim/underclaim drift an evaluator or CI author would be
misled by.

What it binds (against ``einvoice.coverage.engine_fireable_ids()``):

  (a) every concrete rule id the two "Implemented" sections claim
      (table cells AND surrounding prose, shorthand-expanded) is genuinely
      fireable — README may never overclaim;
  (b) every concrete rule id the README claims as NOT covered — the
      "NOT covered yet" bullets (deferred BR-CL codelist checks, the
      BR-CO-05..08 tautologies; BR-DEC-13/15 left this list when T-VHCORE.6
      implemented them) plus the "no BR-DE-12/13/29 exist" numbering-gap
      statement inside the XRechnung section — is genuinely NOT fireable —
      README may never underclaim;
  (c) wildcard family claims made in a positive context (`BR-DEX-*`,
      `PEPPOL-EN16931-R*`, ...) match at least one fireable id.

Parsing rules (anchored on the README's actual claim grammar, so a green run
is a real statement — the TestParserGrammar/parser-health tests below pin the
grammar and known-id canaries so the extractor cannot silently decay to
empty):

  * concrete ids: BR-01, BR-CO-04, BR-DE-23-a, BR-DE-TMP-32,
    PEPPOL-EN16931-R008 ...
  * slash shorthand: "BR-S-02/03/04" → 02,03,04; "BR-DE-23-a/-b" → -a,-b;
    "BR-50/BR-61" → both full ids
  * en-dash ranges: "BR-DE-CVD-01–05", "BR-CO-05–BR-CO-08"
  * wildcards: "BR-DEX-*" → prefix claim (never expanded per-rule)
  * a digit-less family word ("the BR-DE table") is NOT an id claim
  * inside "Implemented" sections, a line of the form "no <ids> exist" flips
    those ids to negative claims (the official-numbering-gap statement)
  * a "NOT covered yet" bullet whose text says its ids ARE
    implemented/validated (the clarifying restatements, e.g. the BR-TMP-3
    CII-only bullet) contributes POSITIVE claims instead; wildcards in
    negative bullets are skipped ("`BR-CL-*` checks" cannot honestly mean
    "no BR-CL rule fires" — BR-CL-01 does).

If any claim drifts, the failure message names the offending id and which
side must change. Doc fixes only — never add or delete engine rules to
satisfy the README.

Fast, stdlib-only, offline. Adds no product behaviour and changes no
validation. Run: python3 test_docs_rule_claims.py

ALSO (T-VHDOCV.6, bottom of this file): the fireable-rule count stated in
CHANGELOG.md's topmost released section is bound to the same
``engine_fireable_ids()`` registry — see ChangelogFireableCountBound.

ALSO (T-VHCII3.2, bottom of this file): the CII-absence denylist that
``test_www_claims.py`` applies to the generated ``www/`` pages is REUSED here
(imported, never re-declared) against the tracked markdown docs — see
TrackedDocsCiiCapability.
"""

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import coverage as _coverage  # noqa: E402

# T-VHCII3.2: the CII-absence denylist and its engine probe are DEFINED ONCE, in
# test_www_claims.py, and reused here for the tracked markdown docs. Importing
# (rather than copying the patterns) is the point: a forked denylist is exactly
# the drift source this guard exists to kill. Only these two names are pulled in
# — no TestCase class — so nothing is double-collected by a test runner.
import test_www_claims as _www_claims  # noqa: E402
from test_www_claims import (  # noqa: E402
    CII_ABSENCE_DENIALS, probe_raw_cii_root_accepted)

README = os.path.join(HERE, "README.md")
EN_DASH = "–"

# A concrete rule id: BR-01 / BR-CO-04 / BR-DE-23-a / PEPPOL-EN16931-R008 ...
ID_RE = re.compile(r"(?:BR|PEPPOL)(?:-[A-Z]+\d*)*(?:-\d+)?(?:-[a-z])?")
# One claim chunk: id-ish characters incl. slash shorthand, en-dash ranges
# and wildcard stars ('**' bold markers are stripped beforehand).
CHUNK_RE = re.compile(r"[A-Za-z0-9*/–-]+")
# "... no BR-DE-12/13/29 exist there" — a negative claim inside an
# otherwise-positive section.
NEG_LINE_RE = re.compile(r"\bno\b.*\bexist")
# A NOT-covered bullet that is really a clarifying POSITIVE restatement.
POS_BULLET_RE = re.compile(
    r"\b(?:is|are)\s+(?:all\s+|now\s+|also\s+)?(?:implemented|validated)\b",
    re.IGNORECASE)


def readme_text():
    with open(README, encoding="utf-8") as fh:
        return fh.read()


def section(text, heading_fragment):
    """The lines of the '### …<heading_fragment>…' section (heading included),
    up to but excluding the next markdown heading."""
    lines = text.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if ln.startswith("### ") and heading_fragment in ln:
            start = i
            break
    if start is None:
        raise AssertionError(
            "README.md lost its %r section — this honesty guard anchors on "
            "it; update the guard if the heading was deliberately renamed"
            % heading_fragment)
    out = [lines[start]]
    for ln in lines[start + 1:]:
        if ln.startswith("#"):
            break
        out.append(ln)
    return "\n".join(out)


def _is_concrete(tok):
    return bool(ID_RE.fullmatch(tok)) and any(c.isdigit() for c in tok)


def _classify_single(tok, chunk):
    """-> ('id', tok) | ('wild', prefix) | ('skip', None). Raises on a token
    that looks like a rule claim but does not parse — grammar drift must be
    loud, never silently ignored."""
    if tok.endswith("*"):
        prefix = tok.rstrip("*")
        if prefix.startswith(("BR", "PEPPOL")):
            return "wild", prefix
        return "skip", None
    if _is_concrete(tok):
        return "id", tok
    if "BR" not in tok and "PEPPOL" not in tok:
        return "skip", None
    if not any(c.isdigit() for c in tok):
        # family word like "the BR-DE table" — a reference, not an id claim
        return "skip", None
    raise AssertionError(
        "unparseable rule-id token %r in README chunk %r — the claim "
        "grammar drifted; teach expand_chunk() the new form" % (tok, chunk))


def _expand_range(chunk):
    """'BR-DE-CVD-01–05' / 'BR-CO-05–BR-CO-08' -> list of ids, or None."""
    left, right = chunk.split(EN_DASH, 1)
    m = re.fullmatch(r"(.+-)(\d+)", left)
    if not m:
        return None
    prefix, lo = m.group(1), m.group(2)
    m2 = re.fullmatch(r"(?:%s)?(\d+)" % re.escape(prefix), right)
    if not m2:
        return None
    hi = m2.group(1)
    if int(hi) < int(lo) or int(hi) - int(lo) > 50:
        return None
    width = len(lo)
    return [prefix + str(n).zfill(width) for n in range(int(lo), int(hi) + 1)]


def expand_chunk(chunk):
    """Expand one punctuation-free chunk into (concrete_ids, wildcard_prefixes).
    See the module docstring for the grammar."""
    if "BR" not in chunk and "PEPPOL" not in chunk:
        return [], []
    if EN_DASH in chunk:
        ids = _expand_range(chunk)
        if ids is None:
            raise AssertionError(
                "unparseable rule-id range %r in README — the claim grammar "
                "drifted; teach expand_chunk() the new form" % chunk)
        return ids, []
    ids, wilds = [], []
    parts = chunk.split("/")
    kind, val = _classify_single(parts[0], chunk)
    if kind == "id":
        ids.append(val)
    elif kind == "wild":
        wilds.append(val)
    elif parts[1:]:
        raise AssertionError(
            "slash shorthand %r does not start with a full rule id" % chunk)
    first = parts[0]
    for tail in parts[1:]:
        if tail.startswith(("BR", "PEPPOL")):
            k, v = _classify_single(tail, chunk)
            if k == "id":
                ids.append(v)
            elif k == "wild":
                wilds.append(v)
        elif re.fullmatch(r"\d+", tail):
            # "BR-S-02/03/04": swap the trailing number of the first id
            ids.append(re.sub(r"\d+$", tail, first))
        elif re.fullmatch(r"-[a-z]", tail):
            # "BR-DE-23-a/-b": swap the trailing letter suffix
            ids.append(re.sub(r"-[a-z]$", "", first) + tail)
        else:
            raise AssertionError(
                "unparseable shorthand tail %r in README chunk %r"
                % (tail, chunk))
    return ids, wilds


def _chunks(text):
    return CHUNK_RE.findall(text.replace("`", "").replace("**", ""))


def extract_ids(text):
    """All (concrete_ids, wildcard_prefixes) claimed anywhere in `text`."""
    ids, wilds = set(), set()
    for chunk in _chunks(text):
        i, w = expand_chunk(chunk)
        ids.update(i)
        wilds.update(w)
    return ids, wilds


def implemented_claims():
    """(positive_ids, positive_wildcards, negative_ids) from the two
    'Implemented' sections — negation-aware ('no BR-DE-12/13/29 exist')."""
    text = readme_text()
    pos, wilds, neg = set(), set(), set()
    for fragment in ("Implemented — EN 16931 core",
                     "Implemented — XRechnung CIUS layer"):
        for line in section(text, fragment).splitlines():
            ids, w = extract_ids(line)
            if NEG_LINE_RE.search(line):
                neg.update(ids)  # official numbering gaps: claimed absent
            else:
                pos.update(ids)
                wilds.update(w)
    return pos, wilds, neg


def not_covered_claims():
    """(negative_ids, positive_ids, positive_wildcards) from the
    'NOT covered yet' bullets. Bullets that explicitly say their ids ARE
    implemented/validated are clarifying restatements → positive claims;
    wildcards in genuinely-negative bullets are skipped (see docstring)."""
    body = section(readme_text(), "NOT covered yet")
    bullets, cur = [], None
    for line in body.splitlines():
        if line.startswith("- "):
            if cur is not None:
                bullets.append(cur)
            cur = [line]
        elif cur is not None:
            cur.append(line)
    if cur is not None:
        bullets.append(cur)
    if len(bullets) < 4:
        raise AssertionError(
            "'NOT covered yet' parsed into only %d bullets — the section "
            "structure drifted; update this guard's bullet parser"
            % len(bullets))
    neg, pos, pos_wilds = set(), set(), set()
    for lines in bullets:
        flat = re.sub(r"\s+", " ", " ".join(lines))
        ids, wilds = extract_ids(flat)
        if POS_BULLET_RE.search(flat):
            pos.update(ids)
            pos_wilds.update(wilds)
        else:
            neg.update(ids)  # wildcards deliberately dropped here
    return neg, pos, pos_wilds


def fireable():
    return set(_coverage.engine_fireable_ids())


# --------------------------------------------------------------------------- #
# The honesty guards proper.
# --------------------------------------------------------------------------- #
class ImplementedClaimsAreFireable(unittest.TestCase):
    """Direction (a): README 'Implemented' claims ⊆ engine_fireable_ids()."""

    def test_every_implemented_claim_is_fireable(self):
        pos, _wilds, _neg = implemented_claims()
        _, extra_pos, _ = not_covered_claims()
        eng = fireable()
        for rid in sorted(pos | extra_pos):
            with self.subTest(rule=rid):
                self.assertIn(
                    rid, eng,
                    "README claims %s as Implemented but "
                    "engine_fireable_ids() does not contain it — the README "
                    "must stop claiming it (doc fix); never fabricate an "
                    "engine rule to satisfy the doc" % rid)

    def test_positive_wildcard_families_are_nonempty(self):
        _pos, wilds, _neg = implemented_claims()
        _, _, extra_wilds = not_covered_claims()
        eng = fireable()
        self.assertTrue(wilds | extra_wilds,
                        "no wildcard family claims parsed — extractor decay")
        for prefix in sorted(wilds | extra_wilds):
            with self.subTest(family=prefix):
                self.assertTrue(
                    any(rid.startswith(prefix) for rid in eng),
                    "README claims the %s* family as implemented but no "
                    "fireable id matches that prefix — fix the README"
                    % prefix)


class NotCoveredClaimsDoNotFire(unittest.TestCase):
    """Direction (b): 'NOT covered' claims ∩ engine_fireable_ids() = ∅."""

    def test_no_not_covered_claim_is_fireable(self):
        neg_bullets, _pos, _w = not_covered_claims()
        _p, _wl, neg_gaps = implemented_claims()
        eng = fireable()
        for rid in sorted(neg_bullets | neg_gaps):
            with self.subTest(rule=rid):
                self.assertNotIn(
                    rid, eng,
                    "the engine now fires %s but README still lists it as "
                    "NOT covered / nonexistent — update the README (move it "
                    "to the Implemented inventory); never delete an engine "
                    "rule to satisfy the doc" % rid)

    def test_positive_and_negative_claims_are_disjoint(self):
        pos, _w, neg_gaps = implemented_claims()
        neg, extra_pos, _ = not_covered_claims()
        both = (pos | extra_pos) & (neg | neg_gaps)
        self.assertFalse(
            both,
            "README claims these ids as BOTH implemented and not covered — "
            "the doc contradicts itself: %s" % sorted(both))


class ParserHealth(unittest.TestCase):
    """Canaries: the extractor cannot silently decay to an empty (vacuously
    green) claim set, and each shorthand form provably expands."""

    def test_implemented_claim_volume_and_known_ids(self):
        pos, _w, _n = implemented_claims()
        # README claims 108 core + 55 XRechnung-layer rules; shorthand
        # expansion must recover well over a hundred concrete ids.
        self.assertGreaterEqual(
            len(pos), 100,
            "only %d Implemented ids parsed — extractor decay" % len(pos))
        for canary in ("BR-01",          # plain table id
                       "BR-S-04",        # slash-number shorthand tail
                       "BR-DE-23-b",     # slash-letter shorthand tail
                       "BR-DE-CVD-03",   # en-dash range interior
                       "BR-DE-TMP-32",   # multi-segment id
                       "BR-CO-18"):      # co-constraint family
            self.assertIn(canary, pos,
                          "known README claim %s not parsed — extractor "
                          "decay" % canary)

    def test_not_covered_claim_volume_and_known_ids(self):
        neg, _pos, _w = not_covered_claims()
        _p, _wl, neg_gaps = implemented_claims()
        self.assertGreaterEqual(
            len(neg), 4,
            "only %d NOT-covered ids parsed (expected the BR-CO-05..08 "
            "tautology range at minimum) — extractor decay"
            % len(neg))
        # BR-CL-07/08 moved to Implemented with T-VHCLX.3 — the codelist
        # deferral bucket is now empty, so the only NOT-covered concrete ids
        # left are the four BR-CO-05..08 never-firing tautologies.
        for canary in ("BR-CO-05", "BR-CO-06",   # tautology range
                       "BR-CO-07", "BR-CO-08"):   # (all four)
            self.assertIn(canary, neg,
                          "known NOT-covered claim %s not parsed — extractor "
                          "decay" % canary)
        # BR-CL-07/08 are implemented now — direction (b) goes red if the
        # README ever lists them as NOT covered again.
        self.assertNotIn("BR-CL-07", neg)
        self.assertNotIn("BR-CL-08", neg)
        # BR-DEC-13/15 are implemented since T-VHCORE.6 — direction (b) would
        # go red if the README ever listed them as NOT covered again.
        self.assertNotIn("BR-DEC-13", neg)
        self.assertNotIn("BR-DEC-15", neg)
        self.assertEqual(
            neg_gaps, {"BR-DE-12", "BR-DE-13", "BR-DE-29"},
            "the 'no BR-DE-12/13/29 exist' numbering-gap statement parsed "
            "to %r — README or extractor drifted" % sorted(neg_gaps))


class TestParserGrammar(unittest.TestCase):
    """The claim grammar itself, pinned on synthetic input so a grammar
    regression is caught even if the README happens not to exercise a form."""

    def test_slash_number_shorthand(self):
        self.assertEqual(expand_chunk("BR-S-02/03/04"),
                         (["BR-S-02", "BR-S-03", "BR-S-04"], []))

    def test_slash_letter_shorthand(self):
        self.assertEqual(expand_chunk("BR-DE-23-a/-b"),
                         (["BR-DE-23-a", "BR-DE-23-b"], []))

    def test_slash_full_ids(self):
        self.assertEqual(expand_chunk("BR-50/BR-61"),
                         (["BR-50", "BR-61"], []))

    def test_en_dash_range_short_and_full_right(self):
        self.assertEqual(
            expand_chunk("BR-DE-CVD-01" + EN_DASH + "05")[0],
            ["BR-DE-CVD-01", "BR-DE-CVD-02", "BR-DE-CVD-03",
             "BR-DE-CVD-04", "BR-DE-CVD-05"])
        self.assertEqual(expand_chunk("BR-CO-05" + EN_DASH + "BR-CO-08")[0],
                         ["BR-CO-05", "BR-CO-06", "BR-CO-07", "BR-CO-08"])

    def test_wildcards_and_family_words(self):
        self.assertEqual(expand_chunk("BR-DEX-*"), ([], ["BR-DEX-"]))
        self.assertEqual(expand_chunk("PEPPOL-EN16931-R*"),
                         ([], ["PEPPOL-EN16931-R"]))
        # a digit-less family word is a reference, not a claim
        self.assertEqual(expand_chunk("BR-DE"), ([], []))
        # non-rule chunks contribute nothing
        self.assertEqual(expand_chunk("seller/buyer"), ([], []))

    def test_grammar_drift_is_loud_not_silent(self):
        with self.assertRaises(AssertionError):
            expand_chunk("BR-01" + EN_DASH + "banana")

    def test_a_fabricated_claim_would_be_flagged(self):
        # Non-vacuity for the honesty guard itself: an invented id passes the
        # grammar but is NOT fireable, so direction (a) would go red on it.
        ids, _ = expand_chunk("BR-XX-999")
        self.assertEqual(ids, ["BR-XX-999"])
        self.assertNotIn("BR-XX-999", fireable())


# --------------------------------------------------------------------------- #
# T-VHDOCV.6: CHANGELOG fireable-count drift guard.
#
# The topmost CHANGELOG section states the engine's fireable-rule count in
# prose ("… fires N rules …"). That number must never be hand-maintained
# folklore: it is bound here to len(engine_fireable_ids()), the same live
# registry the README guards above use. If the engine grows (or a rule is
# removed) without the CHANGELOG being updated, this fails naming both
# numbers; if the guarded phrase is reworded away entirely, the non-vacuity
# assert fails loudly instead of the guard silently going vacuous.
# --------------------------------------------------------------------------- #
CHANGELOG = os.path.join(HERE, "CHANGELOG.md")
# "the engine now fires 286 rules" — the guarded claim grammar. Reword the
# CHANGELOG only together with this pattern.
FIRES_N_RULES_RE = re.compile(r"\bfires\s+(\d+)\s+rules\b")
# any other "<N> fireable" phrasing in the section is bound too, so a future
# edit cannot introduce a second, stale copy of the count.
N_FIREABLE_RE = re.compile(r"\b(\d+)\s+fireable\b")


def changelog_topmost_section():
    """The topmost released section of CHANGELOG.md: from the first
    ``## [x.y.z]`` heading (Unreleased skipped) to the next ``## `` heading
    or EOF. Heading included."""
    with open(CHANGELOG, encoding="utf-8") as fh:
        text = fh.read()
    headings = [m for m in re.finditer(r"(?m)^## .*$", text)
                if not re.search(r"unreleased", m.group(0), re.IGNORECASE)]
    if not headings:
        raise AssertionError("CHANGELOG.md has no '## [x.y.z]' section")
    start = headings[0].start()
    end = headings[1].start() if len(headings) > 1 else len(text)
    return text[start:end]


class ChangelogFireableCountBound(unittest.TestCase):
    """The CHANGELOG's stated rule count == the live engine registry."""

    def test_topmost_section_states_the_live_fireable_count(self):
        section = changelog_topmost_section()
        claims = [int(n) for n in FIRES_N_RULES_RE.findall(section)]
        self.assertTrue(
            claims,
            "the topmost CHANGELOG section no longer contains the guarded "
            "'fires <N> rules' phrase — if the wording was deliberately "
            "changed, update FIRES_N_RULES_RE in the same edit so the count "
            "stays bound to the engine")
        live = len(fireable())
        for n in claims:
            self.assertEqual(
                n, live,
                "CHANGELOG's topmost section claims the engine fires %d "
                "rules but engine_fireable_ids() returns %d — update the "
                "CHANGELOG prose (doc fix); never touch the engine to match "
                "the doc" % (n, live))

    def test_no_stale_fireable_phrasing_in_topmost_section(self):
        section = changelog_topmost_section()
        live = len(fireable())
        for n in (int(x) for x in N_FIREABLE_RE.findall(section)):
            self.assertEqual(
                n, live,
                "CHANGELOG topmost section carries a '%d fireable' claim "
                "that disagrees with engine_fireable_ids() == %d" % (n, live))

    def test_topmost_section_is_nonempty_prose(self):
        # Non-vacuity for the extractor itself: a real section with the live
        # count present as a literal number.
        section = changelog_topmost_section()
        self.assertGreater(len(section.splitlines()), 5,
                           "topmost CHANGELOG section suspiciously short")
        self.assertIn(str(len(fireable())), section)


# --------------------------------------------------------------------------- #
# T-VHMETA.1: PyPI front-door metadata drift guard.
#
# The two install-surface documents a pip-searching evaluator reads FIRST —
# the pyproject description (rendered on the live PyPI card / `pip show`) and
# action/README.md's "Honest scope" section — each state the engine's total
# business-rule count in prose. Both went stale once already: the 0.1.0-era
# "50 of ~200" claim survived the 0.2.0 version bump onto the published PyPI
# page. Bind both counts to len(engine_fireable_ids()), the same live
# registry every other guard in this file uses, so metadata staleness at a
# future version bump is structurally impossible. Doc fixes only — never
# touch the engine to satisfy the metadata.
# --------------------------------------------------------------------------- #
PYPROJECT = os.path.join(HERE, "pyproject.toml")
ACTION_README = os.path.join(HERE, "action", "README.md")
# T-VHCLAIM.1: ci/README.md is the third install surface — the page the
# GitHub Action and both copy-paste CI recipes funnel an ERP developer into.
# It underclaimed the engine ~4x ("43 EN 16931 core + 32 BR-DE-*", "~155
# unimplemented core rules") for months while action/README.md next door
# stated the true scope, so the two CI documents contradicted each other.
# Bound to the SAME live registry through the SAME helper — never a second
# hard-coded count.
CI_README = os.path.join(HERE, "ci", "README.md")
# T-VHCLAIM.2: SPEC.md is not an install surface — it is the SCOPE document a
# technical evaluator opens to decide whether to embed this engine instead of
# the free official KoSIT validator. Its §6 "Honest NON-coverage" list carried
# two SPECIFIC, credible denials of capabilities the engine has had for
# releases: "~180 further BR-* rules are unimplemented … and the BR-CL-*
# code-list family (only BR-CL-01 chosen)", and "only UNTDID 1001 (type code)
# is checked". Against the live registry (len(engine_fireable_ids()), and
# gen_coverage's CODELIST_NOT_ASSERTED, which is now the empty dict) both were
# false — no count is repeated here, only derived. A specific denial is more
# convincing to a reader than any headline — so the page argued the evaluator
# out of the funnel. Bound here through the SAME helper and the SAME live
# registry as the three install surfaces; never a second hard-coded count.
SPEC_MD = os.path.join(HERE, "SPEC.md")
# "… 286 business rules …" — the guarded claim grammar shared by both
# surfaces. Reword the docs only together with this pattern.
N_BUSINESS_RULES_RE = re.compile(r"\b(\d+)\s+business\s+rules\b")
STALE_PHRASES = ("50 of ~200", "not yet implemented")


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


class InstallSurfaceRuleCountBound(unittest.TestCase):
    """pyproject / action / ci README + SPEC.md counts == live registry."""

    def _assert_counts_live(self, text, label):
        claims = [int(n) for n in N_BUSINESS_RULES_RE.findall(text)]
        self.assertTrue(
            claims,
            "%s no longer contains the guarded '<N> business rules' phrase "
            "— if the wording was deliberately changed, update "
            "N_BUSINESS_RULES_RE in the same edit so the count stays bound "
            "to the engine" % label)
        live = len(fireable())
        for n in claims:
            self.assertEqual(
                n, live,
                "%s claims %d business rules but engine_fireable_ids() "
                "returns %d — update the doc (metadata fix), never the "
                "engine" % (label, n, live))

    def test_pyproject_description_count_is_live(self):
        text = _read(PYPROJECT)
        m = re.search(r'(?m)^description\s*=\s*"([^"]+)"', text)
        self.assertIsNotNone(m, "pyproject.toml lost its description line")
        self._assert_counts_live(m.group(1), "pyproject.toml description")

    def test_action_readme_count_is_live(self):
        self._assert_counts_live(_read(ACTION_README), "action/README.md")

    def test_ci_readme_count_is_live(self):
        self._assert_counts_live(_read(CI_README), "ci/README.md")

    def test_ci_readme_has_no_underclaiming_scope_prose(self):
        # The exact fabricated figures this surface carried before
        # T-VHCLAIM.1. They were not "softened" — they were deleted, and a
        # doc that reintroduces either one fails here rather than shipping a
        # ~4x understatement to the highest-intent buyer page.
        text = _read(CI_README)
        for stale in ("155 unimplemented", "43 EN 16931 core"):
            self.assertNotIn(
                stale, text,
                "ci/README.md reintroduced the retired understatement %r — "
                "state the live engine scope instead (see "
                "action/README.md's Honest scope)" % stale)

    def test_spec_count_is_live(self):
        self._assert_counts_live(_read(SPEC_MD), "SPEC.md")

    def test_spec_has_no_retired_scope_denials(self):
        # The exact fabricated denials SPEC.md §6 carried before T-VHCLAIM.2.
        # They were DELETED, not softened — a doc that reintroduces either one
        # fails here rather than telling an evaluator that ~180 core rules and
        # the whole BR-CL-* family are missing when the engine asserts them.
        text = _read(SPEC_MD)
        for stale in ("180 further", "only BR-CL-01 chosen",
                      "only UNTDID 1001"):
            self.assertNotIn(
                stale, text,
                "SPEC.md reintroduced the retired denial %r — state the live "
                "engine scope instead (COVERAGE.md is the inventory; "
                "gen_coverage.CODELIST_NOT_ASSERTED is the deferred-codelist "
                "table and it is empty)" % stale)

    def test_spec_keeps_its_genuine_limits(self):
        # Deleting the false denials must never cost the TRUE ones. Each
        # needle below was re-verified against the tree: no XSD layer runs,
        # the four CEN tautologies can never fire, the rounding model is a
        # reproduction of the artifact's own idiom with no configurable
        # tolerance, and signatures / attachment payloads / PDF/A-3
        # conformance are genuinely not checked.
        text = _read(SPEC_MD)
        for needle, what in (
                ("no XSD structural validation is performed",
                 "the no-XSD limit"),
                ('`test="true()"` tautologies',
                 "the BR-CO-05..08 never-provable exclusion"),
                ("BR-CO-08", "the tautology ids"),
                ("Calculation tolerance / rounding",
                 "the rounding/tolerance limit"),
                ("XML signatures: out of scope",
                 "the no-signature-verification limit"),
                ("never decoded", "the attachment-payload limit"),
                ("not a PDF/A-3 conformance", "the PDF/A-3 limit")):
            self.assertIn(needle, text,
                          "SPEC.md lost %s (%r)" % (what, needle))

    def test_ci_readme_keeps_its_genuine_limits(self):
        # Removing the understatement must never cost the real limits: the
        # three statements below are TRUE and are the only thing standing
        # between a green gate and a reader who thinks it means "legally
        # conformant".
        text = _read(CI_README)
        for needle, what in (
                ("implemented* rule fired", "the 'no implemented rule fired' "
                                            "disclaimer"),
                ("No XSD structural validation", "the no-XSD limit"),
                ("PEPPOL-EN16931-R", "the KoSIT-vendored PEPPOL layer scope"),
                ("not** Peppol BIS Billing 3.0", "the 'not Peppol BIS "
                                                 "Billing 3.0' denial")):
            self.assertIn(needle, text,
                          "ci/README.md lost %s (%r)" % (what, needle))

    def test_no_stale_claims_on_install_surfaces(self):
        # The 0.1.0-era phrasing that actually shipped stale to PyPI must
        # never resurface on either install surface.
        for path, label in ((PYPROJECT, "pyproject.toml"),
                            (ACTION_README, "action/README.md")):
            low = _read(path).lower()
            for stale in STALE_PHRASES:
                self.assertNotIn(
                    stale, low,
                    "stale 0.1.0-era claim %r resurfaced in %s"
                    % (stale, label))

    def test_guard_is_not_vacuous(self):
        # Non-vacuity: both surfaces really carry the literal live count, and
        # the grammar really extracts it (a reworded doc fails loudly above,
        # not silently here).
        live = str(len(fireable()))
        for path, label in ((PYPROJECT, "pyproject.toml"),
                            (ACTION_README, "action/README.md"),
                            (CI_README, "ci/README.md"),
                            (SPEC_MD, "SPEC.md")):
            text = _read(path)
            self.assertIn(live, text,
                          "%s no longer carries the literal live count %s"
                          % (label, live))
            self.assertTrue(
                N_BUSINESS_RULES_RE.search(text),
                "%s lost the guarded '<N> business rules' phrase, so its "
                "count guard would pass vacuously — restore the phrase or "
                "update N_BUSINESS_RULES_RE in the same edit" % label)


# --------------------------------------------------------------------------- #
# T-VHCII3.2: CII-absence guard extended from www/ to the TRACKED MARKDOWN DOCS.
#
# T-VHCII3.1 made our raw-XML surfaces grade a `CrossIndustryInvoice` root on
# its real business rules; T-VHCII3.3 added CII_ABSENCE_DENIALS in
# test_www_claims.py so no GENERATED sales page could keep telling readers the
# tool is UBL-only. But the denylist was scoped to www/ alone, and five TRACKED
# documents kept the falsehood for two more releases — COVERAGE.md ("the raw-XML
# CLI surface stays honestly UBL-only"), EXIT-CODES.md ("direct XML validation
# is UBL-only"), REPORT-SCHEMA.md ("validates through the UBL-only validate_file
# code path"), README.md and SPEC.md. An ERP developer evaluating the German
# mandate reads EXIT-CODES.md or COVERAGE.md BEFORE installing anything, so the
# docs are the earlier, more damaging surface. This class closes that gap by
# pointing the SAME imported denylist at the same docs.
#
# Deliberately NOT a second pattern list: `CII_ABSENCE_DENIALS` is imported
# above. Whoever tightens or loosens a pattern does it in one place and both
# surfaces move together.
# --------------------------------------------------------------------------- #

#: The tracked markdown docs a prospect actually reads before installing.
CII_GUARDED_DOCS = (
    "README.md", "COVERAGE.md", "SPEC.md", "EXIT-CODES.md",
    "REPORT-SCHEMA.md", "CHANGELOG.md",
)

#: Documents are matched in a whitespace-collapsed rendering (same convention as
#: test_www_claims' `_normalize`, minus tag stripping) so a claim that happens to
#: straddle a markdown line wrap is still caught.
_WS_RE = re.compile(r"\s+")


def _normalize_doc(text):
    return _WS_RE.sub(" ", text)


#: EXPLICIT ALLOWLIST — (doc, excerpt, reason). A denial match is excused only if
#: it falls entirely INSIDE an occurrence of the excerpt in that document. Every
#: entry is a rule-BINDING or measurement-METHOD statement about the official
#: Schematron artifacts (how many EN 16931 asserts bind to which syntax, and how
#: a `syntax = UBL + CII` tag is earned), never a claim about which documents we
#: accept — so each must survive untouched. Both non-vacuity directions are
#: asserted below: a stale excerpt and an unnecessary excerpt each fail the gate.
CII_DENIAL_ALLOWLIST = (
    ("README.md",
     "12 are officially UBL-only, and 4 are CII-only** (`BR-TMP-3` and "
     "`BR-DEX-15`, whose asserts exist only in the CII artifact",
     "rule-binding COUNT fact: those two asserts exist in the official CII "
     "artifact only — about the Schematron, not about our accepted roots"),
    ("COVERAGE.md",
     "The UBL artifact carries nine asserts; the CII artifact carries the same "
     "nine plus BR-TMP-3, which exists ONLY in the CII binding",
     "the same BR-TMP-3 binding fact, stated in the CVD/TMP worklist section"),
    ("COVERAGE.md",
     "a rule reaches `syntax = UBL + CII` only via a landed `differential.py` "
     "proof",
     "measurement METHOD: a both-syntaxes tag is only awarded by a landed "
     "differential proof — a proof-discipline statement, not a capability "
     "denial"),
)


def _doc_text(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as fh:
        return _normalize_doc(fh.read())


def _allowed_spans(doc, text):
    """Character spans in ``text`` covered by this doc's allowlist excerpts."""
    spans = []
    for entry_doc, excerpt, _reason in CII_DENIAL_ALLOWLIST:
        if entry_doc != doc:
            continue
        start = text.find(excerpt)
        while start != -1:
            spans.append((start, start + len(excerpt)))
            start = text.find(excerpt, start + 1)
    return spans


#: The exact sentences these documents SHIPPED, kept as the non-vacuity anchor:
#: if a future refactor of the shared patterns stopped catching them, this guard
#: would silently become decoration.
SHIPPED_DOC_FALSEHOODS = (
    "- **The raw-XML CLI surface stays honestly UBL-only:** `einvoice "
    "validate` on a raw CII `.xml` file returns the structural `S-ROOT` fatal",
    "`build_receipt` validates through the UBL-only `validate_file` code path",
)


class TrackedDocsCiiCapability(unittest.TestCase):
    """No tracked markdown doc may tell a reader raw CII is out of scope."""

    def test_probe_shows_raw_cii_really_is_graded(self):
        """Anchor the denylist to the engine, not to an opinion. If the engine
        ever stopped grading a raw CII root the denials would become TRUE and
        this guard must fail HERE, not by flagging honest prose."""
        present, evidence = probe_raw_cii_root_accepted()
        self.assertTrue(
            present,
            "PROBE FAILED — the engine no longer grades a raw CII root (%s). "
            "Fix the engine; CII_ABSENCE_DENIALS is only a denylist of "
            "falsehoods while this holds." % evidence)

    def test_denylist_is_the_shared_one_not_a_fork(self):
        """The patterns must be the SAME object test_www_claims applies to
        www/. A pasted copy here would drift the moment one side is tuned."""
        self.assertIs(CII_ABSENCE_DENIALS, _www_claims.CII_ABSENCE_DENIALS)
        self.assertTrue(CII_ABSENCE_DENIALS, "denylist is empty — vacuous gate")

    def test_no_tracked_doc_claims_cii_absence(self):
        present, evidence = probe_raw_cii_root_accepted()
        self.assertTrue(present, evidence)  # covered in detail above
        patterns = [re.compile(p, re.IGNORECASE) for p in CII_ABSENCE_DENIALS]
        offenders = []
        for doc in CII_GUARDED_DOCS:
            text = _doc_text(doc)
            allowed = _allowed_spans(doc, text)
            for pat in patterns:
                for m in pat.finditer(text):
                    if any(lo <= m.start() and m.end() <= hi
                           for lo, hi in allowed):
                        continue
                    offenders.append(
                        "%s claims CII-absence via /%s/ -> matched %r "
                        "(engine proof: %s)"
                        % (doc, pat.pattern, m.group(0), evidence))
        self.assertEqual(
            offenders, [],
            "tracked docs tell readers raw CII is unsupported or PDF-"
            "container-only:\n  " + "\n  ".join(offenders))

    def test_guard_would_have_caught_the_shipped_doc_falsehoods(self):
        """Non-vacuity #1: the shared patterns really fire on the exact
        sentences this task removed from COVERAGE.md and REPORT-SCHEMA.md."""
        patterns = [re.compile(p, re.IGNORECASE) for p in CII_ABSENCE_DENIALS]
        for sample in SHIPPED_DOC_FALSEHOODS:
            self.assertTrue(
                any(p.search(sample) for p in patterns),
                "no CII_ABSENCE_DENIALS pattern catches the falsehood this "
                "lane actually shipped: %r" % sample)
        # ...and those sentences are really gone from the docs.
        for sample in SHIPPED_DOC_FALSEHOODS:
            for doc in CII_GUARDED_DOCS:
                self.assertNotIn(sample, _doc_text(doc),
                                 "%s still carries %r" % (doc, sample))

    def test_every_allowlist_excerpt_is_present_and_needed(self):
        """Non-vacuity #2: the allowlist may not rot into a blanket escape
        hatch. Each excerpt must still exist in its document (else it is stale
        and must be deleted) AND must really be matched by some pattern (else
        it is excusing nothing and must be deleted)."""
        patterns = [re.compile(p, re.IGNORECASE) for p in CII_ABSENCE_DENIALS]
        for doc, excerpt, reason in CII_DENIAL_ALLOWLIST:
            self.assertIn(doc, CII_GUARDED_DOCS, doc)
            self.assertTrue(reason.strip(),
                            "allowlist entry for %s has no reason" % doc)
            text = _doc_text(doc)
            self.assertIn(
                excerpt, text,
                "STALE allowlist entry: %s no longer contains %r — delete the "
                "entry in the same edit that reworded the doc" % (doc, excerpt))
            self.assertTrue(
                any(p.search(excerpt) for p in patterns),
                "UNNECESSARY allowlist entry: no CII_ABSENCE_DENIALS pattern "
                "matches %r in %s — delete it rather than leaving a hole"
                % (excerpt, doc))

    def test_rule_binding_count_facts_survive(self):
        """The COUNT facts the allowlist protects are statements about the
        official artifacts and must remain stated, verbatim, in both docs."""
        readme = _doc_text("README.md")
        self.assertIn("12 are officially UBL-only, and 4 are CII-only", readme)
        coverage = _doc_text("COVERAGE.md")
        self.assertIn("12", coverage)
        self.assertIn("UBL-only", coverage)
        self.assertIn("CII-only", coverage)

    def test_docs_still_state_the_honest_limits(self):
        """Correcting an underclaim must not have quietly deleted an overclaim
        guard: the real, still-true scope limits stay on the page."""
        readme = _doc_text("README.md")
        self.assertIn("Peppol BIS Billing 3.0", readme)
        self.assertIn("known-open", readme)


# --------------------------------------------------------------------------- #
# T-VHCLAIM.3: rule-COUNT parity guard across every pre-install document.
#
# Five consecutive reviews found the SAME defect in four documents —
# ci/README.md ("~155 unimplemented core rules", T-VHCLAIM.1), SPEC.md's §6
# denials (T-VHCLAIM.2), CORRECTNESS.md ("the ~157 unimplemented EN core
# rules", ~39x our real gap) and README.md's §2 table (T-VHCLAIM.4/.5). All
# four UNDERCLAIMED the engine to the exact German buyer this product exists
# for, and the CORRECTNESS.md one sat on the page BOTH CI surfaces send an
# evaluator to for "what is NOT covered".
#
# T-VHCLAIM.1's repair guarded two literal STRINGS; "~157 unimplemented" walked
# straight past it, because a string guard cannot close a NUMERIC class, and
# `InstallSurfaceRuleCountBound` above closes only one PHRASE. This guard
# closes the class: every count-shaped rule claim, in every document a prospect
# reads before installing, must equal a number the RUNNING ENGINE produces — or
# be listed, with a written reason, in RULE_COUNT_ALLOWLIST. It found one live
# bug on the way in: SPEC.md §3 still said the ruleset "has since grown to 72"
# (the engine asserts 297), fixed in this diff rather than allowlisted.
# InstallSurfaceRuleCountBound stays as-is and green: it also pins
# pyproject.toml's PyPI description, which no prospect reads as a document.
# --------------------------------------------------------------------------- #

#: The documents a prospect reads BEFORE installing anything. Explicit, not
#: globbed: a glob would silently pull in generated pages (www/) and internal
#: notes, and would never tell a future reader WHY a page is on the list.
RULE_COUNT_GUARDED_DOCS = (
    # front door: first page a GitHub/PyPI visitor lands on, linked from all.
    "README.md",
    # scope doc an evaluator opens before choosing us over KoSIT's validator.
    "SPEC.md",
    # proof doc a German buyer's auditor reads — and where BOTH CI surfaces
    # below send readers for "what is NOT covered" (one number, three pages).
    "CORRECTNESS.md",
    # per-rule inventory an ERP integrator greps for the rule that rejects them.
    "COVERAGE.md",
    # highest-intent buyer page: the copy-paste CI recipes off the Action.
    "ci/README.md",
    # Marketplace listing body: scope a CI author reads before adopting it.
    "action/README.md",
)

_CEN_UNIVERSE_CACHE = {}


def official_cen_assert_ids():
    """The official CEN EN 16931 ``BR-*`` assert-id universe — a real XML parse
    of the two preprocessed CEN artifacts, i.e. the SAME generator input
    COVERAGE.md's gap section is built from (``gen_coverage.GAP_ARTIFACT_SCH``).
    Never a second hard-coded total: if CEN ship a new assert the number moves
    on its own and the docs must follow."""
    if "ids" not in _CEN_UNIVERSE_CACHE:
        import gen_coverage as _gen  # local import: keeps module load cheap
        ids = set()
        for key in _gen.GAP_ARTIFACT_ORDER:
            path = os.path.join(HERE, _gen.GAP_ARTIFACT_SCH[key])
            ids |= {rid for rid in _coverage.schematron_assert_index(path)
                    if rid.startswith("BR-")}
        _CEN_UNIVERSE_CACHE["ids"] = ids
    return _CEN_UNIVERSE_CACHE["ids"]


def official_german_message_count():
    """Rules carrying an official (verbatim KoSIT) German assert message —
    read off the live remediation catalog exactly as
    ``gen_coverage.build_german_message_coverage()`` derives the number it
    publishes into COVERAGE.md."""
    from einvoice import remediation as _remediation
    catalog = _remediation.load_catalog()
    return len([e for e in catalog.values()
                if isinstance(e, dict) and "message_de" in e])


def live_rule_counts():
    """``{count: [why it is a legitimate live number, ...]}`` — EVERY entry read
    off the running engine (or off the generator input COVERAGE.md is built
    from). This guard holds NO hard-coded rule-count constant: that is the whole
    point, the trusted numbers move when the code moves."""
    import einvoice as _einvoice
    from einvoice import rules as _rules
    from einvoice import rules_xrechnung as _rules_xr

    out = {}

    def add(n, why):
        out.setdefault(int(n), []).append(why)

    add(_einvoice.capabilities()["rule_count"],
        "capabilities()['rule_count'] — every rule the engine can fire")
    add(len(fireable()),
        "len(engine_fireable_ids()) — the same set enumerated by id")
    add(len(_rules.ALL_RULES),
        "len(einvoice.rules.ALL_RULES) — implemented EN 16931 core rules")
    add(len(official_cen_assert_ids()),
        "the official CEN BR-* assert universe, parsed from the vendored "
        "preprocessed Schematron artifacts")
    add(len(_rules_xr.ALL_RULES),
        "len(rules_xrechnung.ALL_RULES) — German national asserts over UBL")
    add(len(_rules_xr.CII_DE_RULES),
        "len(rules_xrechnung.CII_DE_RULES) — German national asserts over CII")
    add(len(_coverage.peppol_ubl_rule_ids()
            | _coverage.peppol_cii_rule_ids()),
        "canonical KoSIT-vendored PEPPOL-EN16931-R* ids")
    add(official_german_message_count(),
        "rules carrying an official German (KoSIT) assert message")
    return out


#: A number that is part of a STANDARD's name is not a count: "EN 16931
#: business rules" must not be read as a claim of 16931 rules. Fixed-width
#: lookbehind, prefixed onto every pattern below.
_NOT_A_STANDARD_NUMBER = r"(?<!EN )"

#: THE CLAIM GRAMMAR. Each entry is (human label, regex); every capturing group
#: is one claimed count. Extending the family that `N_BUSINESS_RULES_RE` above
#: started — a doc may reword freely, but a reworded count that stops matching
#: is caught by the per-doc non-vacuity assert below, so silence is not an
#: escape route.
RULE_COUNT_CLAIM_PATTERNS = tuple(
    (label, re.compile(_NOT_A_STANDARD_NUMBER + pattern))
    for label, pattern in (
        # "the engine asserts 297 business rules" — the headline phrase.
        ("<N> business rules", r"\b(\d+)\s+business\s+rules\b"),
        # "297 asserted rules" — CORRECTNESS.md's live-counts header.
        ("<N> asserted rules", r"\b(\d+)\s+asserted\s+rules\b"),
        # "219 core rules" / "217 implemented core rules" / the exact shape
        # that shipped the two repaired understatements: "~155 unimplemented
        # core rules" and "the ~157 unimplemented EN core rules".
        ("<N> [un]implemented/graded [EN] core rules",
         r"\b(\d+)\s+(?:(?:un)?implemented\s+|graded\s+)?"
         r"(?:EN\s*(?:16931)?\s+)?core\s+rules\b"),
        # "55 German national asserts" — the XRechnung CIUS layer headline.
        ("<N> [German] national asserts",
         r"\b(\d+)\s+(?:German\s+)?national\s+asserts\b"),
        # "219 rule ids" — CORRECTNESS.md §1's table cell.
        ("<N> rule ids", r"\b(\d+)\s+rule\s+ids\b"),
        # "21 canonical rules" / "21 canonical PEPPOL-EN16931-R* rules".
        ("<N> canonical rules",
         r"\b(\d+)\s+canonical\s+(?:PEPPOL-EN16931-R\*\s+)?rules\b"),
        # "the ruleset has since grown to 297" — SPEC.md's growth sentence,
        # which is exactly where the "grown to 72" understatement hid.
        ("(ruleset) grown to <N>", r"\b(?:grown|grew)\s+to\s+(\d+)\b"),
        # "108 of ~200 core rules" — BOTH numbers are claims (numerator and
        # denominator). Bounded to 40 non-sentence-ending chars so it cannot
        # reach across into an unrelated clause.
        ("<N> of ~<M> ... rules",
         r"\b(\d+)\s+of\s+~?(\d+)\b[^.\n]{0,40}?\brules\b"),
        # Catch-all for the bare forms the specific patterns miss:
        # "1145 invoices x 209 rules", "50 rules", "(22 asserts)".
        ("<N> rules", r"\b(\d+)\s+rules\b"),
        ("<N> asserts", r"\b(\d+)\s+asserts\b"),
    )
)

#: Markdown blockquote marker at the head of a line — dropped before matching
#: so a claim inside a `>` snapshot notice reads as ordinary prose.
_BLOCKQUOTE_RE = re.compile(r"(?m)^[ \t]*>[ \t]?")


def _normalize_counts(text):
    """Doc text as the count grammar sees it: bold markers, code ticks and
    blockquote markers dropped, all whitespace collapsed. Line wraps therefore
    never split a claim, and RULE_COUNT_ALLOWLIST excerpts can be written as
    single plain-text lines."""
    text = _BLOCKQUOTE_RE.sub("", text)
    return _WS_RE.sub(" ", text.replace("**", "").replace("`", ""))


def _count_doc_text(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as fh:
        return _normalize_counts(fh.read())


def extract_count_claims(text):
    """-> ``[(number, label, matched_text, start, end)]`` for every
    count-shaped rule claim in ``text`` (already normalized)."""
    found = []
    for label, pat in RULE_COUNT_CLAIM_PATTERNS:
        for m in pat.finditer(text):
            for group in m.groups():
                if group is not None:
                    found.append((int(group), label, m.group(0),
                                  m.start(), m.end()))
    return found


#: EXPLICIT ALLOWLIST — (doc, excerpt, reason). A claim is excused only if its
#: whole match falls INSIDE an occurrence of the excerpt in that document, so
#: excusing a number costs you the surrounding sentence: a snapshot figure is
#: allowed only where the snapshot LABELLING travels with it. Every entry below
#: was read in context first; a number that was merely WRONG (SPEC.md's "grown
#: to 72") was fixed in this diff instead of being excused. Both non-vacuity
#: directions are asserted below — a stale excerpt and an unnecessary excerpt
#: each fail the gate.
RULE_COUNT_ALLOWLIST = (
    # --- README.md: the frozen 2026-07-11 differential run table -----------
    ("README.md",
     "EN 16931 core on UBL — 209 rules × 1145 real invoices",
     "frozen run record: LEG 1 graded 209 core rules at that snapshot (the live "
     "UBL-graded set is the 219 core rules minus artifact-vacuous BR-DEC-13/15)"),
    ("README.md",
     "1145 invoices x 209 rules = 239,305",
     "the same 2026-07-11 LEG 1 figure inside the verbatim run transcript"),
    ("README.md",
     "1067 invoices x 76 rules = 81,092",
     "LEG 2 graded 76 = the 55 German national asserts + 21 canonical PEPPOL "
     "ids together; both addends are live numbers"),

    # --- SPEC.md: the historical first slice §4 still tabulates -------------
    ("SPEC.md",
     "The FIRST SLICE was the 20 rules specified in §4",
     "history: the original 20-rule slice, kept because §4 still lists them"),
    ("SPEC.md",
     "## 4. First-slice business ruleset (the original 20 rules)",
     "the §4 heading naming that same historical first slice"),

    # --- COVERAGE.md: two measurement-scope figures -------------------------
    ("COVERAGE.md",
     "Graded across 217 implemented core rules",
     "CreditNote leg scope = the 219 core rules minus BR-DEC-13/15, whose "
     "vendored UBL asserts can never fire"),
    ("COVERAGE.md",
     "21 canonical rules (22 asserts)",
     "asserts, not rules: the CII artifact splits PEPPOL-EN16931-R043 in two"),

    # --- CORRECTNESS.md -----------------------------------------------------
    # The founding-snapshot excerpts deliberately carry the snapshot LABELLING
    # T-VHCLAIM.5 added, so deleting a label makes the entry stale (gate red).
    ("CORRECTNESS.md",
     "the standard's own \"about 200 business rules\" framing, not a second "
     "measurement",
     "EN 16931's own approximate framing, labelled here as NOT a measurement"),
    ("CORRECTNESS.md",
     "Where the sections below quote a smaller scope — \"108 of ~200 core "
     "rules\", or a 32-assert BR-DE-* slice — that is the frozen scope of an "
     "earlier differential snapshot",
     "the doc's own up-front notice, quoting the figure it disclaims"),
    ("CORRECTNESS.md",
     "the graded rule count reported in this section are the frozen output of "
     "the founding EN-core run, when 108 core rules were graded",
     "the §2 Snapshot notice: 108 is the founding scope, stated beside 219"),
    ("CORRECTNESS.md",
     "That is 117,180 rule-vs-law comparisons (1085 invoices × 108 rules)",
     "arithmetic of the founding run's own corpus (1085 × 108 = 117,180)"),
    ("CORRECTNESS.md",
     "TOTAL AGREEMENT: 32,512 / 32,512 = 100.0000% (1016 invoices x 32 rules)",
     "verbatim transcript of the founding BR-DE leg's 32-assert CIUS slice"),
    ("CORRECTNESS.md",
     "The 23 rules added in the second batch",
     "history: the size of the second implementation batch, not a scope claim"),
    ("CORRECTNESS.md",
     "This section is written from the founding snapshot and each bullet says "
     "what has changed since; read it together with the live counts at the top "
     "of this document (297 asserted rules, 219 core, 55 UBL / 49 CII "
     "German-layer). The 100% figure of §2 is 100% agreement on the 108 core "
     "rules graded in that run",
     "§5's preamble, which states the live counts before quoting the 108"),
    ("CORRECTNESS.md",
     "Only 108 of ~200 EN 16931 business rules were implemented at this "
     "snapshot",
     "explicitly 'at this snapshot', against the standard's own ~200 framing"),
    ("CORRECTNESS.md",
     "With BR-S-08 the set this snapshot describes becomes 109 of ~200 graded "
     "core rules",
     "'the set this snapshot describes': the founding scope after BR-S-08"),
    ("CORRECTNESS.md",
     "At the snapshot this section describes, only the 32-assert CIUS core was "
     "graded and the EN core was only 108/~200 rules",
     "'at the snapshot this section describes': §2a's frozen XRechnung scope"),
    ("CORRECTNESS.md",
     "The run this document reports in full detail is the founding snapshot: "
     "for the 108 core rules graded in §2",
     "§7's closing restatement of the founding snapshot's 108-rule scope"),
)


def _count_allowed_spans(doc, text):
    """Character spans in ``text`` covered by this doc's allowlist excerpts."""
    spans = []
    for entry_doc, excerpt, _reason in RULE_COUNT_ALLOWLIST:
        if entry_doc != doc:
            continue
        start = text.find(excerpt)
        while start != -1:
            spans.append((start, start + len(excerpt)))
            start = text.find(excerpt, start + 1)
    return spans


#: The exact sentences this defect class actually SHIPPED, kept as the
#: non-vacuity anchor for the GRAMMAR: if the patterns ever stopped extracting
#: a number from these, the guard would be decoration. The first two were
#: deleted by T-VHCLAIM.1/.5; the third is the bug this task's own grammar
#: found and fixed in SPEC.md.
SHIPPED_UNDERCLAIMS = (
    ("ci/README.md", "~155 unimplemented core rules", 155),
    ("CORRECTNESS.md", "the ~157 unimplemented EN core rules", 157),
    ("SPEC.md", "the ruleset has since grown to 72", 72),
)


class DocRuleCountParity(unittest.TestCase):
    """Every count-shaped rule claim in a pre-install doc is a LIVE number."""

    def test_every_count_claim_is_live_or_allowlisted(self):
        live = live_rule_counts()
        offenders = []
        for doc in RULE_COUNT_GUARDED_DOCS:
            text = _count_doc_text(doc)
            allowed = _count_allowed_spans(doc, text)
            for n, label, matched, lo, hi in extract_count_claims(text):
                if n in live:
                    continue
                if any(a <= lo and hi <= b for a, b in allowed):
                    continue
                offenders.append(
                    "%s claims %d via %s -> %r; live engine counts are %s"
                    % (doc, n, label, matched,
                       ", ".join("%d (%s)" % (k, v[0])
                                 for k, v in sorted(live.items()))))
        self.assertEqual(
            offenders, [],
            "a pre-install document states a rule count the engine does not "
            "produce. Fix the DOC to the live number (never the engine), or — "
            "if the figure is legitimately different (a frozen snapshot, an "
            "assert-vs-rule count, the standard's own framing) — add a "
            "(doc, excerpt, reason) entry to RULE_COUNT_ALLOWLIST:\n  "
            + "\n  ".join(offenders))

    def test_live_counts_come_from_the_engine(self):
        """Derived, never declared: each probe is named here so a future edit
        that swaps one for a literal is obvious."""
        live = live_rule_counts()
        import einvoice as _einvoice
        from einvoice import rules as _rules
        from einvoice import rules_xrechnung as _rules_xr
        for probe in (_einvoice.capabilities()["rule_count"],
                      len(_rules.ALL_RULES),
                      len(official_cen_assert_ids()),
                      len(_rules_xr.ALL_RULES),
                      len(_rules_xr.CII_DE_RULES),
                      official_german_message_count()):
            self.assertIn(probe, live)
        # The core registry is a strict subset of the official CEN universe:
        # if that ever inverted, the "official universe" probe would be junk.
        self.assertTrue(
            _coverage.core_rule_ids() <= official_cen_assert_ids(),
            "core_rule_ids() is no longer a subset of the official CEN BR-* "
            "universe — the universe probe is measuring the wrong thing")

    def test_every_guarded_doc_yields_claims(self):
        """Non-vacuity #1: a doc whose grammar stopped matching FAILS rather
        than silently passing with zero claims."""
        for doc in RULE_COUNT_GUARDED_DOCS:
            with self.subTest(doc=doc):
                claims = extract_count_claims(_count_doc_text(doc))
                self.assertTrue(
                    claims,
                    "%s yielded ZERO count claims — either the doc stopped "
                    "stating its rule count (say it) or the grammar decayed "
                    "(teach RULE_COUNT_CLAIM_PATTERNS the new wording)" % doc)

    def test_guarded_docs_cover_the_audited_pages(self):
        """The two pages the audit caught may never leave the guarded set."""
        for required in ("ci/README.md", "CORRECTNESS.md"):
            self.assertIn(required, RULE_COUNT_GUARDED_DOCS)

    def test_allowlist_entries_are_scoped_present_and_needed(self):
        """Non-vacuity #2, both directions: an entry for a doc OUTSIDE the
        guarded set fails; a STALE excerpt (reworded away) fails; an
        UNNECESSARY excerpt (excusing nothing) fails."""
        live = live_rule_counts()
        for doc, excerpt, reason in RULE_COUNT_ALLOWLIST:
            with self.subTest(doc=doc, excerpt=excerpt[:40]):
                self.assertIn(
                    doc, RULE_COUNT_GUARDED_DOCS,
                    "allowlist entry for %s, which is not in "
                    "RULE_COUNT_GUARDED_DOCS — it excuses nothing and hides "
                    "the fact that the doc is unguarded" % doc)
                self.assertTrue(reason.strip(),
                                "allowlist entry for %s has no reason" % doc)
                text = _count_doc_text(doc)
                self.assertIn(
                    excerpt, text,
                    "STALE allowlist entry: %s no longer contains %r — delete "
                    "it in the same edit that reworded the doc (if the snapshot "
                    "LABELLING moved, the figure is not excusable at all)"
                    % (doc, excerpt))
                excused = [n for n, _l, _m, _lo, _hi
                           in extract_count_claims(excerpt) if n not in live]
                self.assertTrue(
                    excused,
                    "UNNECESSARY allowlist entry: %r in %s excuses no "
                    "non-live count — delete it rather than leaving a hole"
                    % (excerpt, doc))

    def test_grammar_catches_the_underclaims_that_shipped(self):
        """Non-vacuity #3: the patterns really extract the numbers from the
        exact sentences this defect class shipped — and those sentences are
        really gone from the docs."""
        live = live_rule_counts()
        for doc, sentence, number in SHIPPED_UNDERCLAIMS:
            with self.subTest(sentence=sentence):
                got = [n for n, _l, _m, _lo, _hi
                       in extract_count_claims(_normalize_counts(sentence))]
                self.assertIn(
                    number, got,
                    "RULE_COUNT_CLAIM_PATTERNS no longer extracts %d from the "
                    "underclaim this repo actually shipped (%r) — the guard "
                    "would not have caught it" % (number, sentence))
                self.assertNotIn(
                    number, live,
                    "%d is now a live engine count, so %r is no longer an "
                    "underclaim — retire this anchor" % (number, sentence))
                self.assertNotIn(sentence, _count_doc_text(doc),
                                 "%s still carries %r" % (doc, sentence))

    def test_a_fabricated_count_would_be_flagged(self):
        """Non-vacuity #4: the checker itself. A synthetic doc line with an
        invented count parses, is not live, and is not allowlisted."""
        text = _normalize_counts("The engine asserts **4242 business rules**.")
        claims = extract_count_claims(text)
        self.assertEqual([c[0] for c in claims], [4242])
        self.assertNotIn(4242, live_rule_counts())
        self.assertEqual(_count_allowed_spans("README.md", text), [])

    def test_standard_numbers_are_not_read_as_counts(self):
        """The lookbehind really works: "EN 16931 business rules" is the
        standard's name, not a claim of 16931 rules."""
        self.assertEqual(
            extract_count_claims(_normalize_counts(
                "not EN 16931 business rules, so they are out of scope")),
            [])
        # ...while a real count in front of the standard's name still parses
        # (synthetic number: this guard never hard-codes a live rule count).
        self.assertEqual(
            [c[0] for c in extract_count_claims(
                _normalize_counts("314 EN 16931 core rules"))],
            [314])


if __name__ == "__main__":
    unittest.main()
