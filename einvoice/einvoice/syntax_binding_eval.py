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
def _resolve_qname(qname):
    """``prefix:Local`` -> Clark ``{uri}Local`` or None if the prefix is unknown."""
    if not _QNAME_RE.match(qname):
        return None
    prefix, local = qname.split(":", 1)
    uri = NSMAP.get(prefix)
    if uri is None:
        return None
    return "{%s}%s" % (uri, local)


def _resolve_attr(name):
    """Attribute name -> the key ElementTree uses (bare ``local`` for a
    no-namespace attribute, Clark ``{uri}local`` for a prefixed one), or None."""
    if not _ATTR_NAME_RE.match(name):
        return None
    if ":" in name:
        prefix, local = name.split(":", 1)
        uri = NSMAP.get(prefix)
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


def _parse_step(tok):
    """Parse ONE path step into an _ElemStep / _AttrStep, or None if unsupported."""
    tok = tok.strip()
    if not tok:
        return None
    if tok.startswith("@"):
        key = _resolve_attr(tok[1:])
        return _AttrStep(key) if key is not None else None
    if tok.startswith("(") and tok.endswith(")"):
        inner = tok[1:-1]
        members = [m.strip() for m in _split_top(inner, "|")]
        tags = []
        for m in members:
            clark = _resolve_qname(m)
            if clark is None:
                return None
            tags.append(clark)
        return _ElemStep(frozenset(tags))
    clark = _resolve_qname(tok)
    return _ElemStep(frozenset((clark,))) if clark is not None else None


def parse_path(path):
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
        st = _parse_step(raw)
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


def compile_test(test):
    """Compile a ``@test`` into a :class:`_Compiled`, or None if its form is
    outside the restricted grammar (=> the id is known-open)."""
    s = (test or "").strip()
    if not s:
        return None

    # Form 1: bare not(P).
    inner = _strip_outer_not(s)
    if inner is not None:
        p = parse_path(inner)
        return _Compiled("not", p) if p is not None else None

    # Form 2: not(P) or Q = 'literal'  (exactly two top-level disjuncts).
    disjuncts = _split_top(s, " or ")
    if len(disjuncts) == 2:
        left_inner = _strip_outer_not(disjuncts[0].strip())
        if left_inner is None:
            return None
        p = parse_path(left_inner)
        if p is None:
            return None
        m = _LITERAL_CMP_RE.match(disjuncts[1].strip())
        if not m:
            return None
        q = parse_path(m.group("path").strip())
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


def _parse_count_cmp(expr):
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
    p = parse_path(inner.strip())
    if p is None:
        return None
    return (p, m.group(1), int(m.group(2)))


def compile_count_test(test):
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
        p1 = parse_path(left)
        if p1 is None:
            return None
        cc = _parse_count_cmp(disj[1].strip())
        if cc is None:
            return None
        p2, op, n = cc
        return _Compiled("not_or_count", p1, q=p2, op=op, n=n)
    if len(disj) == 1:
        cc = _parse_count_cmp(s)
        if cc is None:
            return None
        p, op, n = cc
        return _Compiled("count", p, op=op, n=n)
    return None


def _exists_term(t):
    """Parse ONE existence term — ``exists(P)`` or a bare parenthesized location
    path ``(P)`` — into its restricted ``_Path``, or None."""
    t = t.strip()
    if t.startswith("exists(") and t.endswith(")"):
        inner, tail = _match_paren(t, len("exists"))
        if inner is None or tail != "":
            return None
        return parse_path(inner.strip())
    if t.startswith("(") and t.endswith(")"):
        inner, tail = _match_paren(t, 0)
        if inner is None or tail != "":
            return None
        return parse_path(inner.strip())
    return None


def compile_existence_test(test):
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
        p = _exists_term(part.strip())
        if p is None:
            return None
        terms.append(p)
    if not terms:
        return None
    return _Compiled("exists_all", terms=terms)


def compile_class_test(shape, test):
    """Dispatch @test compilation by the catalog's mechanical shape class. Only
    the shapes with a closed, provable grammar compile; everything else returns
    None (=> known-open). ``datatype-regex`` is deliberately never implemented
    here — the single UBL-DT lexical restriction (UBL-DT-01) is a
    function-context decimal-place check outside any closed element grammar, so
    it is left machine-listed as known-open rather than approximated."""
    if shape == "absence-restriction":
        return compile_test(test)
    if shape == "cardinality-count":
        return compile_count_test(test)
    if shape == "existence":
        return compile_existence_test(test)
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


def compile_context(ctx):
    """Compile a rule ``@context`` into a :class:`_Context`, or None if it uses a
    form outside the closed pattern grammar (a predicate ``[...]``, a function
    ``ends-with(...)``, an interior ``//``, an ``@attr`` step, ...). Such
    contexts leave their asserts known-open by construction."""
    s = (ctx or "").strip()
    if not s:
        return None
    branches = []
    for raw in _split_top(s, "|"):
        b = _parse_ctx_branch(raw.strip())
        if b is None:
            return None
        branches.append(b)
    return _Context(branches) if branches else None


def _parse_ctx_branch(s):
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
        clark = _resolve_qname(step.strip())   # rejects predicates/functions/@attr
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


class _Entry:
    __slots__ = ("id", "flag", "test", "context", "compiled", "ctx", "shape")

    def __init__(self, rid, flag, test, context, compiled, ctx, shape):
        self.id = rid
        self.flag = flag
        self.test = test
        self.context = context
        self.compiled = compiled    # compiled @test (_Compiled)
        self.ctx = ctx              # compiled rule @context (_Context)
        self.shape = shape


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


_CACHE = {"ready": False, "abs_impl": None, "abs_ko": None,
          "class_impl": None, "class_ko": None, "all_impl": None}


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
        _CACHE.update(ready=True, abs_impl=abs_impl, abs_ko=abs_ko,
                      class_impl=class_impl, class_ko=class_ko,
                      all_impl=all_impl)
    return _CACHE


def reset_cache():
    """Drop the cached partition (used by tests that reload the catalog)."""
    _CACHE.update(ready=False, abs_impl=None, abs_ko=None,
                  class_impl=None, class_ko=None, all_impl=None)


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
    k = entry.compiled.kind
    if k in ("not", "not_or_eq"):
        # absence-restriction wording — kept byte-identical to the T-VHSBL.2 form.
        kind = ("forbidden UBL element/attribute is present"
                if k == "not"
                else "restricted UBL element is present with a non-conforming value")
        return ("Syntax-binding restriction %s (CEN EN 16931 UBL, flag=%s): %s at "
                "%s — the EN 16931 core model has no conformant slot for it "
                "(@test=%s)." % (entry.id, entry.flag, kind, path, entry.test))
    if k in ("count", "not_or_count"):
        detail = "UBL element repetition exceeds the EN 16931 syntax-binding cardinality cap"
    elif k == "exists_all":
        detail = "a UBL element/attribute the EN 16931 syntax binding requires is absent"
    else:
        detail = "syntax-binding restriction violated"
    return ("Syntax-binding restriction %s (CEN EN 16931 UBL, flag=%s): %s at %s "
            "(@test=%s)." % (entry.id, entry.flag, detail, path, entry.test))


def evaluate(root):
    """Evaluate every IMPLEMENTED syntax-binding assert (absence-restriction +
    cardinality-count + existence) over a parsed UBL document ``root`` and return
    the list of syntax-binding findings.

    Each finding is a dict carrying ``id``, ``category`` (``"syntax-binding"``),
    ``severity`` (mirroring the official @flag), ``flag``, ``message`` and
    ``element`` (the offending node's location path). An assert is evaluated on
    EVERY node its (restricted) rule context matches, so a cardinality cap fires
    once per violating context node — exactly as the official Schematron fires
    the assert per matched context. Non-UBL roots (or a missing catalog) yield an
    empty list.
    """
    if root is None or root.tag not in _ROOT_TAGS:
        return []
    implemented = _ensure_cache()["all_impl"]
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


def fired_ids(root):
    """The set of implemented syntax-binding ids that FIRE on ``root`` — the
    fired-id projection ``differential.py`` compares against the official
    SVRL failed-assert set."""
    return {f["id"] for f in evaluate(root)}
