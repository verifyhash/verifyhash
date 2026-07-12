#!/usr/bin/env python3
"""syntax_binding_eval.py — a RESTRICTED, data-driven evaluator for the dominant
UBL *absence-restriction* syntax-binding class.

Background
----------
``einvoice/syntax_binding.py`` (T-VHSBL.1) machine-extracts + classifies the
756 UBL / 583 CII syntax-binding (non-``BR-*``) asserts into a committed
``syntax_binding_catalog.json``. Its accounting shows the dominant UBL class is
``shape='absence-restriction'``: **699 of 756** UBL asserts (92.5 %), almost all
a bare ``not(<path>)`` presence restriction on the document root
(``/ubl:Invoice | /cn:CreditNote``) — e.g. ``UBL-CR-001`` = ``not(ext:UBLExtensions)``,
asserting a UBL element the EN 16931 core model has no slot for MUST NOT appear.

This module implements a *closed, restricted* XPath subset — NOT a general XPath
engine — sufficient to safely evaluate the mechanically-simple majority of that
class over an ALREADY-parsed document tree. Anything whose ``@test`` uses a form
outside the closed grammar is left UNIMPLEMENTED and machine-listed as
``known-open`` (see :func:`known_open_ids`); it is never guessed and never
silently dropped. The implemented ids are differential-proven against the
official CEN UBL Schematron by ``differential.py`` (the ``sb`` leg).

The restricted grammar (a ``@test`` is IMPLEMENTED iff it matches one of these
AND its rule context is the document root ``/ubl:Invoice | /cn:CreditNote``):

  1. ``not(P)``                    — P is a *restricted location path* (below).
                                     Fires when the node-set P is NON-empty
                                     (the forbidden node is present).
  2. ``not(P) or Q = 'LITERAL'``   — P, Q restricted location paths, LITERAL a
                                     string. Fires when P is non-empty AND no
                                     node in Q has string-value == LITERAL
                                     (e.g. UBL-CR-002:
                                     ``not(cbc:UBLVersionID) or cbc:UBLVersionID = '2.1'``).

A *restricted location path* is::

    ['//'] step ('/' step)* ['/' '@' attr]

where a ``step`` is either a namespaced element QName ``prefix:Local`` or a
union group ``(prefix:Local | prefix:Local | ...)`` of such QNames, and the
optional trailing ``@attr`` is an attribute name (bare or ``prefix:local``). A
leading ``//`` is the absolute descendant search (``//X`` = every ``X`` in the
document, mirroring XPath's ``/descendant-or-self::node()/child::X``); no other
``//`` and no predicates (``[...]``) / functions are accepted — those forms fall
to ``known-open``.

Standard library only (``xml.etree.ElementTree`` + ``json``); zero new deps. The
catalog is loaded lazily and, if it is absent (e.g. the packaged wheel ships
without the repo-root catalog), the evaluator degrades to emitting NO findings
rather than raising — exactly as the corpus-dependent measurement modules do.
"""

from __future__ import annotations

import json
import os
import re
import xml.etree.ElementTree as ET

# --------------------------------------------------------------------------- #
# Namespaces — the eight prefixes declared in the vendored preprocessed CEN
# UBL Schematron (corpus/.../EN16931-UBL-validation-preprocessed.sch).
# --------------------------------------------------------------------------- #
NSMAP = {
    "ext": "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
    "cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    "cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    "qdt": "urn:oasis:names:specification:ubl:schema:xsd:QualifiedDataTypes-2",
    "udt": "urn:oasis:names:specification:ubl:schema:xsd:UnqualifiedDataTypes-2",
    "cn":  "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
    "ubl": "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
    "xs":  "http://www.w3.org/2001/XMLSchema",
}

# --------------------------------------------------------------------------- #
# CII namespaces — the four prefixes declared in the vendored preprocessed CEN
# CII Schematron (corpus/.../EN16931-CII-validation-preprocessed.sch), matching
# einvoice.parser_cii's URIs exactly. The ``udt``/``qdt`` prefixes deliberately
# resolve to the UN/CEFACT URIs here (DISTINCT from the UBL ``udt``/``qdt`` URIs
# in NSMAP) — which is precisely why QName resolution is threaded per-binding
# rather than sharing one global map.
# --------------------------------------------------------------------------- #
CII_NSMAP = {
    "rsm": "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
    "ram": ("urn:un:unece:uncefact:data:standard:"
            "ReusableAggregateBusinessInformationEntity:100"),
    "udt": "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100",
    "qdt": "urn:un:unece:uncefact:data:standard:QualifiedDataType:100",
}

#: The distinct report category these findings surface under.
CATEGORY = "syntax-binding"

#: The ONE rule context this restricted evaluator supports (the document root).
#: Every implemented id carries exactly this context; an entry whose rule
#: context differs (e.g. UBL-SR-43's ``cac:AdditionalDocumentReference``) is
#: left known-open by construction.
SUPPORTED_CONTEXT = "/ubl:Invoice | /cn:CreditNote"

_HERE = os.path.dirname(os.path.abspath(__file__))
#: Repo-root catalog (parent of the ``einvoice/`` package). Absent in the
#: stdlib-only packaged wheel; then the evaluator emits nothing.
CATALOG_PATH = os.path.join(os.path.dirname(_HERE), "syntax_binding_catalog.json")

_QNAME_RE = re.compile(r"^[A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*$")
_ATTR_NAME_RE = re.compile(r"^(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*$")


# --------------------------------------------------------------------------- #
# QName / attribute resolution
# --------------------------------------------------------------------------- #
def _resolve_qname(qname, ns=NSMAP):
    """``prefix:Local`` -> Clark ``{uri}Local`` or None if the prefix is unknown
    in ``ns`` (the active binding's namespace map — UBL ``NSMAP`` by default,
    ``CII_NSMAP`` for the CII leg)."""
    if not _QNAME_RE.match(qname):
        return None
    prefix, local = qname.split(":", 1)
    uri = ns.get(prefix)
    if uri is None:
        return None
    return "{%s}%s" % (uri, local)


def _resolve_attr(name, ns=NSMAP):
    """Attribute name -> the key ElementTree uses (bare ``local`` for a
    no-namespace attribute, Clark ``{uri}local`` for a prefixed one), or None."""
    if not _ATTR_NAME_RE.match(name):
        return None
    if ":" in name:
        prefix, local = name.split(":", 1)
        uri = ns.get(prefix)
        if uri is None:
            return None
        return "{%s}%s" % (uri, local)
    return name


# --------------------------------------------------------------------------- #
# Restricted-path parsing
# --------------------------------------------------------------------------- #
class _ElemStep:
    __slots__ = ("tags",)

    def __init__(self, tags):
        self.tags = tags  # frozenset of Clark-notation element tags


class _AttrStep:
    __slots__ = ("key",)

    def __init__(self, key):
        self.key = key    # ElementTree attribute key


class _Path:
    __slots__ = ("descendant", "steps")

    def __init__(self, descendant, steps):
        self.descendant = descendant
        self.steps = steps


def _split_top(expr, sep):
    """Split ``expr`` on ``sep`` at parenthesis depth 0."""
    parts, buf, depth = [], [], 0
    i, n, m = 0, len(expr), len(sep)
    while i < n:
        ch = expr[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if depth == 0 and expr[i:i + m] == sep:
            parts.append("".join(buf))
            buf = []
            i += m
            continue
        buf.append(ch)
        i += 1
    parts.append("".join(buf))
    return parts


def _parse_step(tok, ns=NSMAP):
    """Parse ONE path step into an _ElemStep / _AttrStep, or None if unsupported."""
    tok = tok.strip()
    if not tok:
        return None
    if tok.startswith("@"):
        key = _resolve_attr(tok[1:], ns)
        return _AttrStep(key) if key is not None else None
    if tok.startswith("(") and tok.endswith(")"):
        inner = tok[1:-1]
        members = [m.strip() for m in _split_top(inner, "|")]
        tags = []
        for m in members:
            clark = _resolve_qname(m, ns)
            if clark is None:
                return None
            tags.append(clark)
        return _ElemStep(frozenset(tags))
    clark = _resolve_qname(tok, ns)
    return _ElemStep(frozenset((clark,))) if clark is not None else None


def parse_path(path, ns=NSMAP):
    """Parse a restricted location path into a :class:`_Path`, or None."""
    s = path.strip()
    descendant = False
    if s.startswith("//"):
        descendant = True
        rest = s[2:]
    elif s.startswith("/"):
        # Absolute-from-root (single leading slash) is not in the supported set.
        return None
    else:
        rest = s
    if not rest or "//" in rest:
        return None
    raw_steps = _split_top(rest, "/")
    steps = []
    for i, raw in enumerate(raw_steps):
        st = _parse_step(raw, ns)
        if st is None:
            return None
        if isinstance(st, _AttrStep) and i != len(raw_steps) - 1:
            # An attribute step is only valid as the final step.
            return None
        steps.append(st)
    return _Path(descendant, steps)


# --------------------------------------------------------------------------- #
# Restricted-path evaluation over a parsed tree
# --------------------------------------------------------------------------- #
def _select(path, ctx, root):
    """Return the node-set a restricted path selects.

    Elements are returned as Element objects; a trailing attribute step returns
    ``(element, attr_key)`` pairs. ``//`` starts the walk from
    descendant-or-self of ``root`` (the whole document), mirroring XPath's
    absolute-descendant semantics — which is context-independent, exactly as
    Schematron evaluates a ``//`` inside a ``not(...)``.
    """
    if path.descendant:
        current = list(root.iter())        # descendant-or-self::node()
    else:
        current = [ctx]
    for step in path.steps:
        if isinstance(step, _AttrStep):
            out = []
            for el in current:
                if el.get(step.key) is not None:
                    out.append((el, step.key))
            return out
        nxt = []
        for el in current:
            for child in el:
                if child.tag in step.tags:
                    nxt.append(child)
        current = nxt
        if not current:
            break
    return current


def _string_value(node):
    """XPath string-value of a selected node (element text concatenation, or the
    attribute value for an ``(element, attr_key)`` pair)."""
    if isinstance(node, tuple):
        el, key = node
        return el.get(key) or ""
    return "".join(node.itertext())


# --------------------------------------------------------------------------- #
# @test compilation
# --------------------------------------------------------------------------- #
_LITERAL_CMP_RE = re.compile(r"^(?P<path>.+?)\s*=\s*'(?P<lit>[^']*)'$", re.S)


def _cmp(count, op, n):
    """Evaluate ``count OP n`` for the closed set of relational operators the
    cardinality-count grammar admits."""
    if op == "<=":
        return count <= n
    if op == "=":
        return count == n
    if op == "<":
        return count < n
    if op == ">=":
        return count >= n
    if op == ">":
        return count > n
    return False


class _Compiled:
    """A compiled @test: ``evaluate(ctx, root) -> (fires, offending_node)``.

    ``kind`` is one of the closed shapes this restricted evaluator proves
    equivalent to the official Schematron:

      * ``not``          — ``not(P)``: fires when P is non-empty.
      * ``not_or_eq``    — ``not(P) or Q = 'lit'``: fires when P non-empty and no
                           Q string-value equals the literal.
      * ``count``        — ``count(P) OP n``: fires when the count does NOT satisfy
                           the bound.
      * ``not_or_count`` — ``not(P1) or count(P2) OP n``: fires when P1 non-empty
                           and the count of P2 does NOT satisfy the bound.
      * ``exists_all``   — conjunction of existence terms (``exists(P)`` /
                           ``(P)``): fires when ANY term selects an empty node-set.
    """

    __slots__ = ("kind", "p", "q", "literal", "op", "n", "terms")

    def __init__(self, kind, p=None, q=None, literal=None, op=None, n=None,
                 terms=None):
        self.kind = kind
        self.p = p
        self.q = q
        self.literal = literal
        self.op = op
        self.n = n
        self.terms = terms

    def evaluate(self, ctx, root):
        kind = self.kind
        if kind == "not":
            p_nodes = _select(self.p, ctx, root)
            return (True, p_nodes[0]) if p_nodes else (False, None)
        if kind == "not_or_eq":
            p_nodes = _select(self.p, ctx, root)
            if not p_nodes:
                return (False, None)
            # not(P) or Q = 'literal' : passes if any Q string-value == literal.
            q_nodes = _select(self.q, ctx, root)
            if any(_string_value(n) == self.literal for n in q_nodes):
                return (False, None)
            return (True, p_nodes[0])
        if kind == "count":
            nodes = _select(self.p, ctx, root)
            if _cmp(len(nodes), self.op, self.n):
                return (False, None)
            return (True, nodes[0] if nodes else None)
        if kind == "not_or_count":
            p1 = _select(self.p, ctx, root)
            if not p1:
                return (False, None)
            nodes = _select(self.q, ctx, root)
            if _cmp(len(nodes), self.op, self.n):
                return (False, None)
            return (True, nodes[0] if nodes else p1[0])
        if kind == "exists_all":
            for term in self.terms:
                if not _select(term, ctx, root):
                    return (True, None)   # a required node-set is empty
            return (False, None)
        return (False, None)


def _strip_outer_not(expr):
    """If ``expr`` is exactly one ``not( ... )`` group, return its inner text,
    else None."""
    s = expr.strip()
    if not (s.startswith("not(") and s.endswith(")")):
        return None
    depth = 0
    for i, ch in enumerate(s):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0 and i != len(s) - 1:
                return None
    return s[len("not("):-1]


def compile_test(test, ns=NSMAP):
    """Compile a ``@test`` into a :class:`_Compiled`, or None if its form is
    outside the restricted grammar (=> the id is known-open)."""
    s = (test or "").strip()
    if not s:
        return None

    # Form 1: bare not(P).
    inner = _strip_outer_not(s)
    if inner is not None:
        p = parse_path(inner, ns)
        return _Compiled("not", p) if p is not None else None

    # Form 2: not(P) or Q = 'literal'  (exactly two top-level disjuncts).
    disjuncts = _split_top(s, " or ")
    if len(disjuncts) == 2:
        left_inner = _strip_outer_not(disjuncts[0].strip())
        if left_inner is None:
            return None
        p = parse_path(left_inner, ns)
        if p is None:
            return None
        m = _LITERAL_CMP_RE.match(disjuncts[1].strip())
        if not m:
            return None
        q = parse_path(m.group("path").strip(), ns)
        if q is None:
            return None
        return _Compiled("not_or_eq", p, q=q, literal=m.group("lit"))

    return None


# --------------------------------------------------------------------------- #
# cardinality-count + existence @test compilation
# --------------------------------------------------------------------------- #
def _match_paren(s, open_idx):
    """From an opening ``(`` at ``open_idx``, return (inner_text, tail) where the
    tail is everything after the MATCHING close paren, or (None, None)."""
    depth = 0
    for i in range(open_idx, len(s)):
        ch = s[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return s[open_idx + 1:i], s[i + 1:]
    return None, None


def _strip_outer_parens(s):
    """Strip whole-expression wrapping parens, e.g. ``(count(x) <= 1)`` -> the
    inside. Leaves ``count(x) <= 1`` (parens not wrapping the whole) untouched."""
    s = s.strip()
    while s.startswith("(") and s.endswith(")"):
        inner, tail = _match_paren(s, 0)
        if inner is None or tail != "":
            break
        s = inner.strip()
    return s


_COUNT_OP_RE = re.compile(r"^\s*(<=|>=|=|<|>)\s*(\d+)\s*$")


def _parse_count_cmp(expr, ns=NSMAP):
    """Parse ``count(P) OP n`` into ``(_Path, op, n)`` or None. P must be a
    restricted location path; OP a single relational operator; n a non-negative
    integer literal. No arithmetic (``count(a) - count(b)``), no predicates and
    no functions inside P (those forms fall to known-open)."""
    e = expr.strip()
    if not e.startswith("count("):
        return None
    inner, tail = _match_paren(e, len("count"))
    if inner is None:
        return None
    m = _COUNT_OP_RE.match(tail)
    if not m:
        return None
    p = parse_path(inner.strip(), ns)
    if p is None:
        return None
    return (p, m.group(1), int(m.group(2)))


def compile_count_test(test, ns=NSMAP):
    """Compile a ``cardinality-count`` @test into a :class:`_Compiled`, or None
    if it is outside the closed grammar (=> the id is known-open).

    Accepted:
      * ``count(P) OP n``                    -> kind ``count``
      * ``not(P1) or count(P2) OP n``        -> kind ``not_or_count``
    (each optionally wrapped in a single pair of outer parens). Anything else —
    a difference of counts, a predicated / function path, an ``and`` conjunction
    — is rejected."""
    s = _strip_outer_parens((test or "").strip())
    if not s:
        return None
    disj = _split_top(s, " or ")
    if len(disj) == 2:
        left = _strip_outer_not(disj[0].strip())
        if left is None:
            return None
        p1 = parse_path(left, ns)
        if p1 is None:
            return None
        cc = _parse_count_cmp(disj[1].strip(), ns)
        if cc is None:
            return None
        p2, op, n = cc
        return _Compiled("not_or_count", p1, q=p2, op=op, n=n)
    if len(disj) == 1:
        cc = _parse_count_cmp(s, ns)
        if cc is None:
            return None
        p, op, n = cc
        return _Compiled("count", p, op=op, n=n)
    return None


def _exists_term(t, ns=NSMAP):
    """Parse ONE existence term — ``exists(P)`` or a bare parenthesized location
    path ``(P)`` — into its restricted ``_Path``, or None."""
    t = t.strip()
    if t.startswith("exists(") and t.endswith(")"):
        inner, tail = _match_paren(t, len("exists"))
        if inner is None or tail != "":
            return None
        return parse_path(inner.strip(), ns)
    if t.startswith("(") and t.endswith(")"):
        inner, tail = _match_paren(t, 0)
        if inner is None or tail != "":
            return None
        return parse_path(inner.strip(), ns)
    return None


def compile_existence_test(test, ns=NSMAP):
    """Compile an ``existence`` @test into a :class:`_Compiled` of kind
    ``exists_all``, or None. Accepted: a single existence term or an ``and``
    conjunction of them, where each term is ``exists(P)`` or ``(P)`` over a
    restricted location path. A ``normalize-space(...) != ''`` or a compound with
    ``or`` / comparisons falls to known-open."""
    s = (test or "").strip()
    if not s:
        return None
    terms = []
    for part in _split_top(s, " and "):
        p = _exists_term(part.strip(), ns)
        if p is None:
            return None
        terms.append(p)
    if not terms:
        return None
    return _Compiled("exists_all", terms=terms)


def compile_class_test(shape, test, ns=NSMAP):
    """Dispatch @test compilation by the catalog's mechanical shape class. Only
    the shapes with a closed, provable grammar compile; everything else returns
    None (=> known-open). ``datatype-regex`` is deliberately never implemented
    here — the single UBL-DT lexical restriction (UBL-DT-01) is a
    function-context decimal-place check outside any closed element grammar, so
    it is left machine-listed as known-open rather than approximated."""
    if shape == "absence-restriction":
        return compile_test(test, ns)
    if shape == "cardinality-count":
        return compile_count_test(test, ns)
    if shape == "existence":
        return compile_existence_test(test, ns)
    return None


# --------------------------------------------------------------------------- #
# Restricted rule-CONTEXT matching (an XSLT-match-pattern subset)
# --------------------------------------------------------------------------- #
class _CtxBranch:
    """One ``|``-branch of a rule context: a chain of element QNames plus a flag
    for whether the branch is rooted at the document node (leading single
    ``/``)."""

    __slots__ = ("rooted", "tags")

    def __init__(self, rooted, tags):
        self.rooted = rooted     # True for '/ubl:Invoice'-style absolute steps
        self.tags = tags         # Clark tags, outermost..self (document order)


class _Context:
    __slots__ = ("branches",)

    def __init__(self, branches):
        self.branches = branches

    def match(self, root, parents):
        """Every element matching ANY branch of this context, in document order.

        Restricted to the closed pattern set the evaluator can prove equivalent
        to XSLT match semantics for the actual UBL-syntax rules: an element
        matches ``a/b/c`` iff its tag is ``c`` and its parent chain is ``b`` then
        ``a`` (a rooted branch additionally requires the outermost step to BE the
        document root). All supported contexts target pairwise-distinct element
        types, so no 'first matching rule wins' claiming can occur between
        implemented asserts (verified by the differential leg)."""
        out = []
        for el in root.iter():
            for br in self.branches:
                if _branch_matches(el, br, parents):
                    out.append(el)
                    break
        return out


def _branch_matches(el, br, parents):
    tags = br.tags
    cur = el
    for i in range(len(tags) - 1, -1, -1):
        if cur is None or cur.tag != tags[i]:
            return False
        if i > 0:
            cur = parents.get(id(cur))
    if br.rooted:
        # The outermost step must itself be the document root (no parent).
        return parents.get(id(cur)) is None
    return True


def compile_context(ctx, ns=NSMAP):
    """Compile a rule ``@context`` into a :class:`_Context`, or None if it uses a
    form outside the closed pattern grammar (a predicate ``[...]``, a function
    ``ends-with(...)``, an interior ``//``, an ``@attr`` step, ...). Such
    contexts leave their asserts known-open by construction."""
    s = (ctx or "").strip()
    if not s:
        return None
    branches = []
    for raw in _split_top(s, "|"):
        b = _parse_ctx_branch(raw.strip(), ns)
        if b is None:
            return None
        branches.append(b)
    return _Context(branches) if branches else None


def _parse_ctx_branch(s, ns=NSMAP):
    rooted = False
    if s.startswith("//"):
        rest = s[2:]
    elif s.startswith("/"):
        rooted = True
        rest = s[1:]
    else:
        rest = s
    if not rest or "//" in rest:
        return None
    tags = []
    for step in _split_top(rest, "/"):
        clark = _resolve_qname(step.strip(), ns)   # rejects predicates/functions/@attr
        if clark is None:
            return None
        tags.append(clark)
    return _CtxBranch(rooted, tags) if tags else None


# --------------------------------------------------------------------------- #
# Catalog loading + implemented / known-open partition (LIVE from the catalog).
# --------------------------------------------------------------------------- #
def load_catalog(path=None):
    """Load ``syntax_binding_catalog.json`` (or None if it is not present)."""
    path = path or CATALOG_PATH
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def absence_restriction_entries(catalog=None):
    """The UBL ``absence-restriction`` entries (the 699-strong dominant class),
    in catalog document order. Empty when the catalog is unavailable."""
    if catalog is None:
        catalog = load_catalog()
    if not catalog:
        return []
    return [e for e in catalog.get("entries", [])
            if e.get("binding") == "ubl"
            and e.get("shape") == "absence-restriction"]


#: The UBL syntax-binding shape classes this restricted evaluator partitions,
#: beyond the dominant ``absence-restriction`` class.
NEW_CLASSES = ("cardinality-count", "existence", "datatype-regex")

#: Implemented cardinality-count ids whose FIRING direction is NOT differentially
#: observable against the official CEN artifact. The only way to violate each cap
#: is to duplicate a leaf (seller/customer ``PartyLegalEntity/RegistrationName``,
#: ``PaymentMeans/PaymentMeansCode``, ``TaxRepresentativeParty`` ``PartyName/Name``)
#: that OTHER official rules pass to XSLT ``fn:normalize-space()`` — which raises a
#: type error on a >1-item sequence and aborts the entire transform, so the
#: official validator emits NOTHING for such a document (the differential would
#: SKIP, not grade, it). These ids stay IMPLEMENTED (grammar-driven) and their
#: CLEARING direction is proven at 0 divergence over the full corpus; only the
#: both-fire datapoint is unobtainable. The evaluator's firing on them is still
#: exercised in-memory by ``test_syntax_binding.py`` — nothing is faked.
FIRING_UNOBSERVABLE = frozenset((
    "UBL-SR-09", "UBL-SR-15", "UBL-SR-22", "UBL-SR-27",
))

#: Every UBL shape class the evaluator accounts for (partition covers each).
ALL_CLASSES = ("absence-restriction",) + NEW_CLASSES

#: CII cardinality-count ids whose FIRING direction crashes the official CEN
#: EN16931-CII XSLT: violating the cap duplicates a leaf that a DOWNSTREAM
#: official rule feeds to ``fn:normalize-space()`` / ``number()`` / a ``cast as``
#: on a now >1-item sequence, aborting the whole transform (the official
#: validator emits NOTHING). Unlike the UBL ``FIRING_UNOBSERVABLE`` ids, their
#: targeted firing fixtures ARE shipped — each still fires in OUR evaluator and is
#: a real per-id violation — but the differential SKIPS them on the OFFICIAL side
#: (recorded as errors, never divergences). Their CLEARING direction is proven at
#: 0 divergence over the full CII corpus. DOCUMENTATION ONLY: these stay
#: IMPLEMENTED and graded — they are NOT removed from the id set. The set is a
#: subset of the implemented cardinality-count ids (asserted live by the test).
CII_FIRING_UNOBSERVABLE = frozenset((
    "CII-SR-010", "CII-SR-014", "CII-SR-477", "CII-SR-478", "CII-SR-479",
    "CII-SR-480", "CII-SR-481", "CII-SR-482", "CII-SR-484", "CII-SR-487",
))


class _Entry:
    __slots__ = ("id", "flag", "test", "context", "compiled", "ctx", "shape",
                 "binding")

    def __init__(self, rid, flag, test, context, compiled, ctx, shape,
                 binding="ubl"):
        self.id = rid
        self.flag = flag
        self.test = test
        self.context = context
        self.compiled = compiled    # compiled @test (_Compiled)
        self.ctx = ctx              # compiled rule @context (_Context)
        self.shape = shape
        self.binding = binding      # "ubl" or "cii"


def class_entries(shape, catalog=None):
    """The UBL catalog entries of one shape class, in catalog document order."""
    if shape == "absence-restriction":
        return absence_restriction_entries(catalog)
    if catalog is None:
        catalog = load_catalog()
    if not catalog:
        return []
    return [e for e in catalog.get("entries", [])
            if e.get("binding") == "ubl" and e.get("shape") == shape]


def _partition(catalog=None):
    """Split the absence-restriction class into (implemented, known_open).

    An entry is IMPLEMENTED iff its context is the supported document root AND
    its @test compiles under the restricted grammar; otherwise it is known-open.
    Purely a function of the catalog + the grammar — no hardcoded id list.
    """
    implemented, known_open = [], []
    root_ctx = compile_context(SUPPORTED_CONTEXT)
    for e in absence_restriction_entries(catalog):
        rid = e.get("id")
        compiled = None
        if e.get("context") == SUPPORTED_CONTEXT:
            compiled = compile_test(e.get("test"))
        if compiled is not None:
            implemented.append(_Entry(rid, e.get("flag") or "fatal",
                                      e.get("test"), e.get("context"),
                                      compiled, root_ctx, "absence-restriction"))
        else:
            known_open.append(rid)
    return implemented, known_open


def _partition_class(shape, catalog=None):
    """Split one NEW shape class (cardinality-count / existence / datatype-regex)
    into (implemented, known_open).

    An entry is IMPLEMENTED iff BOTH its rule @context compiles under the closed
    context-pattern grammar AND its @test compiles under that class's closed test
    grammar. Anything outside either grammar is machine-listed as known-open —
    never guessed, never dropped. Purely a function of the catalog + the two
    grammars; no hardcoded id list.
    """
    implemented, known_open = [], []
    for e in class_entries(shape, catalog):
        rid = e.get("id")
        tc = compile_class_test(shape, e.get("test"))
        cc = compile_context(e.get("context")) if tc is not None else None
        if tc is not None and cc is not None:
            implemented.append(_Entry(rid, e.get("flag") or "fatal",
                                      e.get("test"), e.get("context"),
                                      tc, cc, shape))
        else:
            known_open.append(rid)
    return implemented, known_open


# --------------------------------------------------------------------------- #
# CII binding partition (T-VHSBL.4) — the SAME generic shape-class grammars,     #
# driven by the catalog's ``binding == 'cii'`` entries and resolved through      #
# CII_NSMAP. Unlike the UBL absence class (whose one supported context is the    #
# document root), CII asserts bind to a variety of rule contexts (header trade   #
# agreement / settlement, line items, //-anchored element types, ...), so a CII  #
# entry is IMPLEMENTED iff BOTH its rule @context AND its class @test compile     #
# under the closed grammars — exactly the class-partition rule, applied to every #
# CII shape class. ``other-complex`` (CII-SR-119, a compound or/and predicate)   #
# and ``datatype-regex`` (CII-DT-097, a ``matches()`` lexical restriction) never #
# compile and stay machine-listed as known-open — never approximated.            #
# --------------------------------------------------------------------------- #

#: Every CII syntax-binding shape class the catalog enumerates (the partition
#: covers each honestly, totalling the full CII population).
CII_SHAPE_CLASSES = ("absence-restriction", "cardinality-count", "existence",
                     "other-complex", "datatype-regex")


def cii_class_entries(shape, catalog=None):
    """The CII catalog entries of one shape class, in catalog document order."""
    if catalog is None:
        catalog = load_catalog()
    if not catalog:
        return []
    return [e for e in catalog.get("entries", [])
            if e.get("binding") == "cii" and e.get("shape") == shape]


# --------------------------------------------------------------------------- #
# Schematron rule-CLAIMING (T-VHSBL.4). Inside ONE Schematron pattern, an
# element node is claimed by the FIRST rule whose @context matches it; later
# rules in that pattern never evaluate on an already-claimed node (XSLT
# apply-templates mode semantics). The CEN CII ``EN16931-CII-Syntax`` pattern
# lists the universal rule ``//ram:TypeCode`` (CII-DT-008/009) BEFORE the
# specific ``/rsm:.../ram:ExchangedDocument/ram:TypeCode`` rule
# (CII-DT-010/011/012), so the document TypeCode — the only node the specific
# rule matches — is always claimed first and those three asserts are DEAD: the
# official validator can never fire them. Evaluating them independently would
# over-fire, so they are machine-listed as known-open (claim-shadowed), backed
# by the pattern order in the vendored artifact — never a hardcoded id list.
#
# The detector is a SOUND, restricted sufficient condition: an assert is
# shadowed iff an EARLIER rule in the same pattern has a context that is a bare
# universal single element type ``//X`` / ``X`` (one branch, unrooted, one QName
# step, no predicate) AND every branch of the assert's own context ends in that
# same element type X. That exactly captures the ``//ram:TypeCode`` case and
# excludes nothing that could still legitimately fire. Any deeper claiming shape
# a future artifact bump might introduce would surface as a differential
# divergence and reopen the worklist — the same guardrail the rest of the leg
# relies on.
# --------------------------------------------------------------------------- #
_SCH_NS = "{http://purl.oclc.org/dsdl/schematron}"
CII_ARTIFACT_PATH = os.path.join(
    os.path.dirname(_HERE), "corpus", "cen-en16931", "cii", "schematron",
    "preprocessed", "EN16931-CII-validation-preprocessed.sch")


def _universal_qname(ctx):
    """If a compiled rule ``@context`` is a bare universal element type
    (``//X`` / ``X``: one branch, unrooted, exactly one element QName step),
    return that Clark tag X; else None."""
    if ctx is None or len(ctx.branches) != 1:
        return None
    br = ctx.branches[0]
    if br.rooted or len(br.tags) != 1:
        return None
    return br.tags[0]


def _context_leaf_tags(ctx):
    """Every branch's LEAF element tag (the element type each branch selects), or
    None if any branch has no element leaf."""
    if ctx is None:
        return None
    leaves = []
    for br in ctx.branches:
        if not br.tags:
            return None
        leaves.append(br.tags[-1])
    return leaves


def cii_claim_shadowed_ids(artifact_path=None):
    """The set of CII assert ids that are DEAD by Schematron rule-claiming — an
    earlier bare universal ``//X`` rule in the SAME pattern claims every node
    their context could match. Read live from the vendored preprocessed CII
    artifact; empty if the artifact is absent (e.g. the packaged wheel), in which
    case the differential leg still keeps the leg honest."""
    path = artifact_path or CII_ARTIFACT_PATH
    if not os.path.exists(path):
        return set()
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError:
        return set()
    shadowed = set()
    for pattern in root.iter(_SCH_NS + "pattern"):
        universal = set()
        for rule in pattern.findall(_SCH_NS + "rule"):
            ctx = compile_context(rule.get("context"), CII_NSMAP)
            leaves = _context_leaf_tags(ctx)
            if leaves is not None and universal and all(t in universal
                                                        for t in leaves):
                for a in rule.findall(_SCH_NS + "assert"):
                    aid = a.get("id")
                    if aid:
                        shadowed.add(aid)
            uq = _universal_qname(ctx)
            if uq is not None:
                universal.add(uq)
    return shadowed


def _partition_cii(shape, catalog=None, shadowed=None):
    """Split one CII shape class into (implemented, known_open) using the closed
    context + test grammars resolved through CII_NSMAP. Purely a function of the
    catalog + the grammars + the artifact's rule-claiming order — no hardcoded id
    list; an id whose context or test falls outside the grammar, or which is DEAD
    by Schematron claiming (``shadowed``), is machine-listed as known-open, never
    guessed."""
    if shadowed is None:
        shadowed = cii_claim_shadowed_ids()
    implemented, known_open = [], []
    for e in cii_class_entries(shape, catalog):
        rid = e.get("id")
        tc = compile_class_test(shape, e.get("test"), CII_NSMAP)
        cc = compile_context(e.get("context"), CII_NSMAP) if tc is not None else None
        if tc is not None and cc is not None and rid not in shadowed:
            implemented.append(_Entry(rid, e.get("flag") or "fatal",
                                      e.get("test"), e.get("context"),
                                      tc, cc, shape, binding="cii"))
        else:
            known_open.append(rid)
    return implemented, known_open


_CACHE = {"ready": False, "abs_impl": None, "abs_ko": None,
          "class_impl": None, "class_ko": None, "all_impl": None,
          "cii_impl": None, "cii_ko": None, "cii_all_impl": None}


def _ensure_cache():
    if not _CACHE["ready"]:
        catalog = load_catalog()
        abs_impl, abs_ko = _partition(catalog)
        class_impl, class_ko = {}, {}
        for shape in NEW_CLASSES:
            i, k = _partition_class(shape, catalog)
            class_impl[shape] = i
            class_ko[shape] = k
        all_impl = list(abs_impl)
        for shape in NEW_CLASSES:
            all_impl.extend(class_impl[shape])
        cii_impl, cii_ko = {}, {}
        cii_shadowed = cii_claim_shadowed_ids()
        for shape in CII_SHAPE_CLASSES:
            i, k = _partition_cii(shape, catalog, cii_shadowed)
            cii_impl[shape] = i
            cii_ko[shape] = k
        cii_all_impl = []
        for shape in CII_SHAPE_CLASSES:
            cii_all_impl.extend(cii_impl[shape])
        _CACHE.update(ready=True, abs_impl=abs_impl, abs_ko=abs_ko,
                      class_impl=class_impl, class_ko=class_ko,
                      all_impl=all_impl, cii_impl=cii_impl, cii_ko=cii_ko,
                      cii_all_impl=cii_all_impl)
    return _CACHE


def reset_cache():
    """Drop the cached partition (used by tests that reload the catalog)."""
    _CACHE.update(ready=False, abs_impl=None, abs_ko=None,
                  class_impl=None, class_ko=None, all_impl=None,
                  cii_impl=None, cii_ko=None, cii_all_impl=None)


def implemented_ids():
    """Sorted list of EVERY differential-proven, implemented UBL syntax-binding
    id across all shape classes (absence-restriction + cardinality-count +
    existence) — live-computed from the catalog + the restricted grammars. This
    is exactly the id set ``differential.py``'s ``sb`` leg grades."""
    c = _ensure_cache()
    return sorted(e.id for e in c["all_impl"])


def known_open_ids():
    """Sorted list of the ``absence-restriction`` ids left UNIMPLEMENTED
    (machine-listed as known-open) — the exact remainder of the 699-strong
    dominant class. (Per-class remainders: :func:`class_known_open_ids`.)"""
    c = _ensure_cache()
    return sorted(c["abs_ko"])


def absence_implemented_ids():
    """Sorted implemented ids of the ``absence-restriction`` class only."""
    c = _ensure_cache()
    return sorted(e.id for e in c["abs_impl"])


def class_implemented_ids(shape):
    """Sorted implemented ids of ONE new shape class (empty for an unknown or
    fully-known-open class, e.g. ``datatype-regex``)."""
    c = _ensure_cache()
    return sorted(e.id for e in c["class_impl"].get(shape, []))


def class_known_open_ids(shape):
    """Sorted known-open (machine-listed) ids of ONE new shape class."""
    c = _ensure_cache()
    return sorted(c["class_ko"].get(shape, []))


def implemented_entries():
    """Every compiled implemented entry across all classes (absence order first,
    then the new classes in NEW_CLASSES order) — feeds report + differential."""
    c = _ensure_cache()
    return c["all_impl"]


# --------------------------------------------------------------------------- #
# CII public accessors (mirror the UBL ones, live from the catalog).           #
# --------------------------------------------------------------------------- #
def cii_implemented_ids():
    """Sorted list of EVERY implemented CII syntax-binding id across all shape
    classes — live-computed from the catalog + the restricted grammars. This is
    exactly the id set ``differential.py``'s CII ``sbcii`` leg grades."""
    c = _ensure_cache()
    return sorted(e.id for e in c["cii_all_impl"])


def cii_implemented_entries():
    """Every compiled implemented CII entry across all classes (in
    CII_SHAPE_CLASSES order) — feeds the CII fixture generator + differential."""
    c = _ensure_cache()
    return c["cii_all_impl"]


def cii_class_implemented_ids(shape):
    """Sorted implemented CII ids of ONE shape class (empty for a fully-known-open
    class, e.g. ``other-complex`` / ``datatype-regex``)."""
    c = _ensure_cache()
    return sorted(e.id for e in c["cii_impl"].get(shape, []))


def cii_class_known_open_ids(shape):
    """Sorted known-open (machine-listed) CII ids of ONE shape class."""
    c = _ensure_cache()
    return sorted(c["cii_ko"].get(shape, []))


def cii_known_open_ids():
    """Sorted list of EVERY CII id left UNIMPLEMENTED (machine-listed as
    known-open) across all shape classes."""
    c = _ensure_cache()
    out = []
    for shape in CII_SHAPE_CLASSES:
        out.extend(c["cii_ko"].get(shape, []))
    return sorted(out)


# --------------------------------------------------------------------------- #
# Evaluation over a parsed document root
# --------------------------------------------------------------------------- #
_ROOT_TAGS = frozenset((
    "{%s}Invoice" % NSMAP["ubl"],
    "{%s}CreditNote" % NSMAP["cn"],
))


def _context_nodes(root):
    """The nodes matching the supported context ``/ubl:Invoice | /cn:CreditNote``
    — the document root itself when it is a UBL Invoice or CreditNote."""
    if root is not None and root.tag in _ROOT_TAGS:
        return [root]
    return []


def _severity_from_flag(flag):
    """Mirror the official @flag: ``fatal`` blocks validity (affects exit code);
    every other flag (``warning`` / ``information``) is the non-blocking
    warning class (reported, does NOT affect exit code) — the same BR-DE
    warning convention the rest of the engine uses."""
    return "fatal" if (flag or "").strip().lower() == "fatal" else "warning"


def _node_path(node, parents):
    """A readable location path for a matched node, e.g.
    ``/Invoice/ext:UBLExtensions`` or ``/Invoice/cbc:ID/@schemeID``."""
    if isinstance(node, tuple):
        el, key = node
        attr = key.rsplit("}", 1)[-1] if "}" in key else key
        return _node_path(el, parents) + "/@" + attr
    steps = []
    cur = node
    while cur is not None:
        steps.append(_localname(cur.tag))
        cur = parents.get(id(cur))
    return "/" + "/".join(reversed(steps))


def _localname(tag):
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _message(entry, path):
    syn = "CII" if getattr(entry, "binding", "ubl") == "cii" else "UBL"
    k = entry.compiled.kind
    if k in ("not", "not_or_eq"):
        # absence-restriction wording — kept byte-identical to the T-VHSBL.2 form.
        kind = ("forbidden %s element/attribute is present" % syn
                if k == "not"
                else "restricted %s element is present with a non-conforming value"
                     % syn)
        return ("Syntax-binding restriction %s (CEN EN 16931 %s, flag=%s): %s at "
                "%s — the EN 16931 core model has no conformant slot for it "
                "(@test=%s)." % (entry.id, syn, entry.flag, kind, path, entry.test))
    if k in ("count", "not_or_count"):
        detail = ("%s element repetition exceeds the EN 16931 syntax-binding "
                  "cardinality cap" % syn)
    elif k == "exists_all":
        detail = ("a %s element/attribute the EN 16931 syntax binding requires "
                  "is absent" % syn)
    else:
        detail = "syntax-binding restriction violated"
    return ("Syntax-binding restriction %s (CEN EN 16931 %s, flag=%s): %s at %s "
            "(@test=%s)." % (entry.id, syn, entry.flag, detail, path, entry.test))


#: The CII document root tag (Clark notation) — the CrossIndustryInvoice.
CII_ROOT_TAG = "{%s}CrossIndustryInvoice" % CII_NSMAP["rsm"]


def _evaluate_entries(root, implemented):
    """Run a list of compiled implemented entries over a parsed document ``root``
    and return syntax-binding findings. Binding-agnostic: an entry's compiled
    @context / @test already carry Clark-resolved tags, so evaluation is the same
    for UBL and CII. An assert is evaluated on EVERY node its (restricted) rule
    context matches — exactly as the official Schematron fires per matched
    context."""
    if not implemented:
        return []
    parents = {id(child): parent
               for parent in root.iter() for child in parent}
    findings = []
    for entry in implemented:
        for ctx in entry.ctx.match(root, parents):
            fires, node = entry.compiled.evaluate(ctx, root)
            if fires:
                path = _node_path(node if node is not None else ctx, parents)
                findings.append({
                    "id": entry.id,
                    "category": CATEGORY,
                    "severity": _severity_from_flag(entry.flag),
                    "flag": entry.flag,
                    "message": _message(entry, path),
                    "element": path,
                })
    return findings


def evaluate(root):
    """Evaluate every IMPLEMENTED UBL syntax-binding assert (absence-restriction +
    cardinality-count + existence) over a parsed UBL document ``root`` and return
    the list of syntax-binding findings.

    Each finding is a dict carrying ``id``, ``category`` (``"syntax-binding"``),
    ``severity`` (mirroring the official @flag), ``flag``, ``message`` and
    ``element`` (the offending node's location path). Non-UBL roots (or a missing
    catalog) yield an empty list.
    """
    if root is None or root.tag not in _ROOT_TAGS:
        return []
    return _evaluate_entries(root, _ensure_cache()["all_impl"])


def fired_ids(root):
    """The set of implemented UBL syntax-binding ids that FIRE on ``root`` — the
    fired-id projection ``differential.py`` compares against the official
    SVRL failed-assert set."""
    return {f["id"] for f in evaluate(root)}


def evaluate_cii(root):
    """Evaluate every IMPLEMENTED CII syntax-binding assert (CII-DT + CII-SR,
    across absence-restriction / cardinality-count / existence) over a parsed
    CrossIndustryInvoice ``root``. Same finding shape and @flag-mirroring
    severity as :func:`evaluate`. A non-CII root (or a missing catalog) yields an
    empty list — so a UBL document run through here fires nothing and vice
    versa, keeping the two bindings' findings strictly separate."""
    if root is None or root.tag != CII_ROOT_TAG:
        return []
    return _evaluate_entries(root, _ensure_cache()["cii_all_impl"])


def cii_fired_ids(root):
    """The set of implemented CII syntax-binding ids that FIRE on ``root`` — the
    fired-id projection ``differential.py``'s CII ``sbcii`` leg compares against
    the official CEN EN16931-CII SVRL failed-assert set."""
    return {f["id"] for f in evaluate_cii(root)}
