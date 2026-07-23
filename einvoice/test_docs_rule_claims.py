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
"""

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import coverage as _coverage  # noqa: E402

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
            len(neg), 12,
            "only %d NOT-covered ids parsed (expected the 8 BR-CL deferrals "
            "+ BR-CO-05..08 at minimum) — extractor decay"
            % len(neg))
        for canary in ("BR-CL-06", "BR-CL-26",   # slash-shorthand deferrals
                       "BR-CO-05", "BR-CO-08"):   # tautology range ends
            self.assertIn(canary, neg,
                          "known NOT-covered claim %s not parsed — extractor "
                          "decay" % canary)
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
# "… 286 business rules …" — the guarded claim grammar shared by both
# surfaces. Reword the docs only together with this pattern.
N_BUSINESS_RULES_RE = re.compile(r"\b(\d+)\s+business\s+rules\b")
STALE_PHRASES = ("50 of ~200", "not yet implemented")


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


class InstallSurfaceRuleCountBound(unittest.TestCase):
    """pyproject description + action/README.md counts == live registry."""

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
        self.assertIn(live, _read(PYPROJECT))
        self.assertIn(live, _read(ACTION_README))


if __name__ == "__main__":
    unittest.main()
