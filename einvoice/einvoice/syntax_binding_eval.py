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
  3. ``not(P) or (Q)``             — bare node-set existence guard (T-VHCOV.2).
                                     Fires when P is non-empty AND Q is EMPTY;
                                     Q may be a rooted leading-``/`` path
                                     (CII-DT-033's document-wide guard).
  4. ``not(A and B)``              — negated conjunction (CII-SR-465/466), also
                                     reached via the truth-table-proven
                                     three-way mutual-exclusion DNF
                                     ``(not(A) and B) or (A and not(B)) or
                                     (not(A) and not(B))`` (CII-SR-449/450/451).
                                     Fires when BOTH node-sets are non-empty.

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


class _ParentStep:
    """A ``..`` (parent-axis) step. Bounded: it selects the parent of each node in
    the current node-set (via the document ``parents`` map). Used only by the
    ``and``-conjoined UBL-SR-19/21 tests, whose right disjunct navigates
    ``../cac:AccountingSupplierParty/…`` up from the ``cac:PayeeParty`` context."""

    __slots__ = ()


class _Path:
    __slots__ = ("descendant", "steps", "rooted")

    def __init__(self, descendant, steps, rooted=False):
        self.descendant = descendant
        self.steps = steps
        self.rooted = rooted   # leading single '/' — absolute from the document node


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
    if tok == "..":
        return _ParentStep()
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


def parse_path(path, ns=NSMAP, allow_rooted=False):
    """Parse a restricted location path into a :class:`_Path`, or None.

    ``allow_rooted`` admits the ONE additional bounded form a leading single
    ``/`` denotes — an absolute path evaluated from the document node (its first
    step must be the document element). Off by default so every pre-existing
    production keeps its exact grammar; only the bare node-set existence
    right-disjunct (CII-DT-033's rooted ``/rsm:...`` guard) opts in."""
    s = path.strip()
    descendant = False
    rooted = False
    if s.startswith("//"):
        descendant = True
        rest = s[2:]
    elif s.startswith("/"):
        # Absolute-from-root (single leading slash): only where the calling
        # production explicitly opts in; not in the base supported set.
        if not allow_rooted:
            return None
        rooted = True
        rest = s[1:]
    else:
        rest = s
    if not rest or "//" in rest:
        return None
    raw_steps = _split_top(rest, "/")
    steps = []
    seen_non_parent = False
    for i, raw in enumerate(raw_steps):
        st = _parse_step(raw, ns)
        if st is None:
            return None
        if isinstance(st, _AttrStep) and i != len(raw_steps) - 1:
            # An attribute step is only valid as the final step.
            return None
        if isinstance(st, _ParentStep):
            # A leading `..` chain only (`../a/b`); a `..` after an element step
            # (`a/../b`) — or any `..` in a rooted path — is outside the bounded
            # form and stays known-open.
            if seen_non_parent or descendant or rooted:
                return None
        else:
            seen_non_parent = True
        steps.append(st)
    if rooted and not isinstance(steps[0], _ElemStep):
        # A rooted path's first step must be the document element.
        return None
    return _Path(descendant, steps, rooted)


# --------------------------------------------------------------------------- #
# Restricted-path evaluation over a parsed tree
# --------------------------------------------------------------------------- #
def _select(path, ctx, root, parents=None):
    """Return the node-set a restricted path selects.

    Elements are returned as Element objects; a trailing attribute step returns
    ``(element, attr_key)`` pairs. ``//`` starts the walk from
    descendant-or-self of ``root`` (the whole document), mirroring XPath's
    absolute-descendant semantics — which is context-independent, exactly as
    Schematron evaluates a ``//`` inside a ``not(...)``. A leading ``..`` step
    walks to the parent via ``parents`` (the document parent map, built on demand
    when not supplied).
    """
    if path.descendant:
        current = list(root.iter())        # descendant-or-self::node()
    elif path.rooted:
        # Absolute from the DOCUMENT node: the first (element) step selects the
        # document element iff its tag matches — context-independent, exactly as
        # Schematron evaluates a leading-/ path inside a @test. The remaining
        # steps then walk down as usual.
        first = path.steps[0]
        current = [root] if root.tag in first.tags else []
        for step in path.steps[1:]:
            if isinstance(step, _AttrStep):
                return [(el, step.key) for el in current
                        if el.get(step.key) is not None]
            current = [child for el in current for child in el
                       if child.tag in step.tags]
            if not current:
                break
        return current
    else:
        current = [ctx]
    for step in path.steps:
        if isinstance(step, _ParentStep):
            if parents is None:
                parents = {id(c): p for p in root.iter() for c in p}
            nxt, seen = [], set()
            for el in current:
                par = parents.get(id(el))
                if par is not None and id(par) not in seen:
                    seen.add(id(par))
                    nxt.append(par)
            current = nxt
            if not current:
                break
            continue
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


def _nodeset_ne(a_nodes, b_nodes):
    """XPath ``A != B`` for two node-sets: True iff there exist ``a in A`` and
    ``b in B`` whose string-values differ. An empty operand yields no pair, so the
    result is False — matching both XPath 1.0 node-set ``!=`` and the XPath 2.0
    general comparison Saxon evaluates for the CEN artifact (existential over
    atomized string values). This is the exact semantics of the UBL-SR-19/21 right
    conjunct."""
    if not a_nodes or not b_nodes:
        return False
    a_vals = {_string_value(a) for a in a_nodes}
    b_vals = {_string_value(b) for b in b_nodes}
    # Differ iff the two value sets are not both the single same value.
    return not (len(a_vals) == 1 and a_vals == b_vals)


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
      * ``not_or_exists`` — ``not(P) or (Q)``: fires when P is non-empty and the
                           bare node-set Q is EMPTY (Q may be a rooted leading-/
                           path — the CII-DT-033 document-wide guard).
      * ``not_and``      — ``not(A and B)`` (also reached via the equivalent
                           three-way ``(not(A) and B) or (A and not(B)) or
                           (not(A) and not(B))`` mutual-exclusion form): fires
                           when BOTH node-sets are non-empty.
      * ``count``        — ``count(P) OP n``: fires when the count does NOT satisfy
                           the bound.
      * ``not_or_count`` — ``not(P1) or count(P2) OP n``: fires when P1 non-empty
                           and the count of P2 does NOT satisfy the bound.
      * ``exists_all``   — conjunction of existence terms (``exists(P)`` /
                           ``(P)``): fires when ANY term selects an empty node-set.
      * ``count_diff``   — ``count(P1) - count(P2) OP n``: fires when the integer
                           difference of the two counts does NOT satisfy the bound
                           (the UBL-DT-18 difference-of-counts form).
      * ``and_count_ne`` — ``(count(P) OP n) and ((A) != (B))``: fires when EITHER
                           the count bound is violated OR the node-set inequality
                           ``A != B`` is false (no differing string pair, or either
                           side empty) — the UBL-SR-19/21 ``and``-conjoined form.
                           ``A`` / ``B`` are restricted paths (``B`` may lead with
                           ``..``); the ``!=`` is XPath's general node-set
                           comparison (∃ a∈A, b∈B with different string values).
      * ``decimal_le``   — ``string-length(substring-after(., '.')) <= n``: fires
                           when the context node's string value has MORE than ``n``
                           characters after its first ``.`` (the UBL-DT-01 decimal
                           cap on amounts).
    """

    __slots__ = ("kind", "p", "q", "literal", "op", "n", "terms",
                 "a_path", "b_path")

    def __init__(self, kind, p=None, q=None, literal=None, op=None, n=None,
                 terms=None, a_path=None, b_path=None):
        self.kind = kind
        self.p = p
        self.q = q
        self.literal = literal
        self.op = op
        self.n = n
        self.terms = terms
        self.a_path = a_path
        self.b_path = b_path

    def evaluate(self, ctx, root, parents=None):
        kind = self.kind
        if kind == "not":
            p_nodes = _select(self.p, ctx, root, parents)
            return (True, p_nodes[0]) if p_nodes else (False, None)
        if kind == "not_or_eq":
            p_nodes = _select(self.p, ctx, root, parents)
            if not p_nodes:
                return (False, None)
            # not(P) or Q = 'literal' : passes if any Q string-value == literal.
            q_nodes = _select(self.q, ctx, root, parents)
            if any(_string_value(n) == self.literal for n in q_nodes):
                return (False, None)
            return (True, p_nodes[0])
        if kind == "not_or_exists":
            # not(P) or (Q): passes when P is empty OR Q is non-empty; fires
            # when P is present and the required companion node-set Q is empty.
            p_nodes = _select(self.p, ctx, root, parents)
            if not p_nodes:
                return (False, None)
            if _select(self.q, ctx, root, parents):
                return (False, None)
            return (True, p_nodes[0])
        if kind == "not_and":
            # not(A and B): fires exactly when BOTH node-sets are non-empty.
            sets = [_select(t, ctx, root, parents) for t in self.terms]
            if all(sets):
                return (True, sets[0][0])
            return (False, None)
        if kind == "count":
            nodes = _select(self.p, ctx, root, parents)
            if _cmp(len(nodes), self.op, self.n):
                return (False, None)
            return (True, nodes[0] if nodes else None)
        if kind == "not_or_count":
            p1 = _select(self.p, ctx, root, parents)
            if not p1:
                return (False, None)
            nodes = _select(self.q, ctx, root, parents)
            if _cmp(len(nodes), self.op, self.n):
                return (False, None)
            return (True, nodes[0] if nodes else p1[0])
        if kind == "count_diff":
            c1 = len(_select(self.p, ctx, root, parents))
            c2 = len(_select(self.q, ctx, root, parents))
            if _cmp(c1 - c2, self.op, self.n):
                return (False, None)
            return (True, None)
        if kind == "and_count_ne":
            nodes = _select(self.p, ctx, root, parents)
            count_ok = _cmp(len(nodes), self.op, self.n)
            a_nodes = _select(self.a_path, ctx, root, parents)
            b_nodes = _select(self.b_path, ctx, root, parents)
            ne_true = _nodeset_ne(a_nodes, b_nodes)
            if count_ok and ne_true:
                return (False, None)          # both conjuncts hold — assert passes
            # Fires: point at the offending count node when the cap is what broke,
            # else at the context node (the equality conjunct failed).
            off = (nodes[0] if not count_ok and nodes else None)
            return (True, off)
        if kind == "decimal_le":
            sval = _string_value(ctx)
            idx = sval.find(".")
            after = sval[idx + 1:] if idx >= 0 else ""
            if len(after) <= self.n:
                return (False, None)
            return (True, ctx)
        if kind == "exists_all":
            for term in self.terms:
                if not _select(term, ctx, root, parents):
                    return (True, None)   # a required node-set is empty
            return (False, None)
        return (False, None)


def _strip_outer_not(expr):
    """If ``expr`` is exactly one ``not( ... )`` / ``not ( ... )`` group (the
    official CEN CII artifact writes both spacings — CII-SR-090 uses ``not (``,
    a pure lexical variant of the same XPath call), return its inner text, else
    None."""
    s = expr.strip()
    if not s.startswith("not"):
        return None
    body = s[len("not"):].lstrip()
    if not (body.startswith("(") and body.endswith(")")):
        return None
    depth = 0
    for i, ch in enumerate(body):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0 and i != len(body) - 1:
                return None
    return body[1:-1]


def _plain_child_path(expr, ns=NSMAP, allow_rooted=False):
    """Parse ``expr`` as a restricted location path CONTAINING NO parent-axis
    step (the ``..`` chain stays exclusive to the UBL-SR-19/21 ``and_count_ne``
    form) — the path shape the T-VHCOV.2 absence extensions admit. Returns the
    ``_Path`` or None."""
    p = parse_path(expr, ns, allow_rooted=allow_rooted)
    if p is None or any(isinstance(st, _ParentStep) for st in p.steps):
        return None
    return p


def _parse_existence_atom(term, ns=NSMAP):
    """Parse ONE possibly-negated existence atom — ``not(P)`` or a bare plain
    child path ``P`` — into ``(path_text, _Path, positive)`` or None. Used by
    the three-way mutual-exclusion production; the raw path text is the atom's
    identity key (the mutual-exclusion check needs the SAME two paths across
    all disjuncts)."""
    t = term.strip()
    inner = _strip_outer_not(t)
    if inner is not None:
        key = inner.strip()
        p = _plain_child_path(key, ns)
        return (key, p, False) if p is not None else None
    p = _plain_child_path(t, ns)
    return (t, p, True) if p is not None else None


def _compile_mutual_exclusion(disjuncts, ns=NSMAP):
    """Compile the exact three-way mutual-exclusion form
    ``(not(A) and B) or (A and not(B)) or (not(A) and not(B))`` (any order of
    the three disjuncts) into a ``not_and`` :class:`_Compiled` over A and B, or
    None. The truth-table check is EXACT: the three sign-pairs must be
    precisely every combination except (A present and B present), so the whole
    @test is provably equivalent to ``not(A and B)`` — never approximated."""
    if len(disjuncts) != 3:
        return None
    paths = {}          # path text -> _Path (must end up with exactly 2)
    order = []          # first-seen order of the two path texts
    sign_pairs = set()
    for d in disjuncts:
        conj = _split_top(_strip_outer_parens(d.strip()), " and ")
        if len(conj) != 2:
            return None
        atoms = []
        for term in conj:
            a = _parse_existence_atom(term, ns)
            if a is None:
                return None
            atoms.append(a)
        keys = [a[0] for a in atoms]
        if keys[0] == keys[1]:
            return None                 # both atoms over the same path
        for key, p, _pos in atoms:
            if key not in paths:
                paths[key] = p
                order.append(key)
        if len(paths) > 2:
            return None
        # Normalize the pair to (sign of path A, sign of path B).
        signs = dict((key, pos) for key, _p, pos in atoms)
        if set(signs) != set(order[:2]) or len(order) < 2:
            return None
        sign_pairs.add((signs[order[0]], signs[order[1]]))
    if len(paths) != 2 or len(order) != 2:
        return None
    # Exactly the NAND truth table: every sign combination EXCEPT (True, True).
    if sign_pairs != {(False, True), (True, False), (False, False)}:
        return None
    return _Compiled("not_and", terms=[paths[order[0]], paths[order[1]]])


def compile_test(test, ns=NSMAP):
    """Compile a ``@test`` into a :class:`_Compiled`, or None if its form is
    outside the restricted grammar (=> the id is known-open)."""
    s = (test or "").strip()
    if not s:
        return None

    # Form 1: bare not(P) — or the negated conjunction not(A and B) (CII-SR-465/
    # 466: fires when both plain child node-sets are present).
    inner = _strip_outer_not(s)
    if inner is not None:
        p = parse_path(inner, ns)
        if p is not None:
            return _Compiled("not", p)
        conj = _split_top(inner, " and ")
        if len(conj) == 2:
            a = _plain_child_path(conj[0], ns)
            b = _plain_child_path(conj[1], ns)
            if a is not None and b is not None:
                return _Compiled("not_and", terms=[a, b])
        return None

    # Form 2: not(P) or Q = 'literal'  (exactly two top-level disjuncts). The
    # right disjunct may be wrapped in one pair of parens — the official CEN CII
    # artifact writes it both ways (``... or (ram:TypeCode = 'VAT')`` for
    # CII-DT-037 vs the bare ``... = '2.1'`` of UBL-CR-002). A right disjunct
    # that is a bare parenthesized node-set ``(Q)`` (no comparison) is the
    # existence guard form (CII-SR-046 / CII-DT-033): the assert passes when Q
    # is non-empty, so it FIRES when P is present and Q empty. Q must be a
    # plain child path (optionally rooted at the document node — CII-DT-033's
    # /rsm:... guard); a parent-axis (../) disjunct stays known-open.
    disjuncts = _split_top(s, " or ")
    if len(disjuncts) == 2:
        left_inner = _strip_outer_not(disjuncts[0].strip())
        if left_inner is None:
            return None
        p = parse_path(left_inner, ns)
        if p is None:
            return None
        right = _strip_outer_parens(disjuncts[1].strip())
        m = _LITERAL_CMP_RE.match(right)
        if m:
            q = parse_path(m.group("path").strip(), ns)
            if q is None:
                return None
            return _Compiled("not_or_eq", p, q=q, literal=m.group("lit"))
        if disjuncts[1].strip().startswith("("):
            # bare node-set existence right-disjunct — only in the explicitly
            # parenthesized form the official artifact writes.
            q = _plain_child_path(right, ns, allow_rooted=True)
            if q is not None:
                return _Compiled("not_or_exists", p, q=q)
        return None

    # Form 3: the three-way mutual-exclusion DNF (CII-SR-449/450/451),
    # truth-table-proven equivalent to not(A and B).
    if len(disjuncts) == 3:
        return _compile_mutual_exclusion(disjuncts, ns)

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


def _parse_count_diff(expr, ns=NSMAP):
    """Parse ``count(P1) - count(P2) OP n`` into a ``count_diff`` compiled test, or
    None. Both P1 and P2 must be restricted location paths, ``OP`` a single
    relational operator, ``n`` an integer literal. Exactly the UBL-DT-18 shape
    ``count(//@name) - count(//cbc:PaymentMeansCode/@name) <= 0``; any other
    arithmetic (a product, a nested difference) stays known-open."""
    e = expr.strip()
    if not e.startswith("count("):
        return None
    inner1, tail1 = _match_paren(e, len("count"))
    if inner1 is None:
        return None
    tail1 = tail1.strip()
    if not tail1.startswith("-"):
        return None
    rest = tail1[1:].strip()
    if not rest.startswith("count("):
        return None
    inner2, tail2 = _match_paren(rest, len("count"))
    if inner2 is None:
        return None
    m = _COUNT_OP_RE.match(tail2)
    if not m:
        return None
    p1 = parse_path(inner1.strip(), ns)
    p2 = parse_path(inner2.strip(), ns)
    if p1 is None or p2 is None:
        return None
    return _Compiled("count_diff", p1, q=p2, op=m.group(1), n=int(m.group(2)))


def _parse_nodeset_ne(expr, ns=NSMAP):
    """Parse ``(A) != (B)`` (a node-set inequality) into ``(_Path A, _Path B)`` or
    None. A and B are restricted location paths (B may lead with ``..``). Only the
    bare ``!=`` general comparison compiles; a ``=`` / ``<`` / string-function
    comparison stays known-open."""
    parts = _split_top(expr, "!=")
    if len(parts) != 2:
        return None
    a = parse_path(_strip_outer_parens(parts[0].strip()), ns)
    b = parse_path(_strip_outer_parens(parts[1].strip()), ns)
    if a is None or b is None:
        return None
    return (a, b)


def _compile_and_count_ne(left, right, ns=NSMAP):
    """Compile ``(count(P) OP n) and ((A) != (B))`` into an ``and_count_ne``
    compiled test, or None. Exactly the UBL-SR-19/21 shape: a cardinality cap
    conjoined with a cross-branch node-set inequality. UBL-SR-20's left conjunct
    carries an ``upper-case(@schemeID)`` predicate, so its count path fails
    :func:`_parse_count_cmp` and it stays known-open — never approximated."""
    cc = _parse_count_cmp(_strip_outer_parens(left.strip()), ns)
    if cc is None:
        return None
    ne = _parse_nodeset_ne(_strip_outer_parens(right.strip()), ns)
    if ne is None:
        return None
    p, op, n = cc
    a, b = ne
    return _Compiled("and_count_ne", p, op=op, n=n, a_path=a, b_path=b)


def compile_count_test(test, ns=NSMAP):
    """Compile a ``cardinality-count`` @test into a :class:`_Compiled`, or None
    if it is outside the closed grammar (=> the id is known-open).

    Accepted:
      * ``count(P) OP n``                       -> kind ``count``
      * ``not(P1) or count(P2) OP n``           -> kind ``not_or_count``
      * ``count(P1) - count(P2) OP n``          -> kind ``count_diff``   (UBL-DT-18)
      * ``(count(P) OP n) and ((A) != (B))``    -> kind ``and_count_ne`` (UBL-SR-19/21)
    (each optionally wrapped in a single pair of outer parens). Anything else —
    a predicated / function path, a difference other than of two plain counts —
    is rejected."""
    s = _strip_outer_parens((test or "").strip())
    if not s:
        return None
    # (count(P) OP n) and ((A) != (B))  — the and-conjoined cardinality form.
    andp = _split_top(s, " and ")
    if len(andp) == 2:
        return _compile_and_count_ne(andp[0], andp[1], ns)
    disj = _split_top(s, " or ")
    if len(disj) == 2:
        left = _strip_outer_not(disj[0].strip())
        if left is None:
            return None
        p1 = parse_path(left, ns)
        if p1 is None:
            return None
        # The right disjunct may be wrapped in one redundant pair of parens —
        # the official CII artifact writes CII-SR-090 as
        # ``not (P) or (count(Q) =1)`` (pure lexical variance).
        cc = _parse_count_cmp(_strip_outer_parens(disj[1].strip()), ns)
        if cc is None:
            return None
        p2, op, n = cc
        return _Compiled("not_or_count", p1, q=p2, op=op, n=n)
    if len(disj) == 1:
        cd = _parse_count_diff(s, ns)
        if cd is not None:
            return cd
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


_DECIMAL_LE_RE = re.compile(
    r"^string-length\(\s*substring-after\(\s*\.\s*,\s*'\.'\s*\)\s*\)\s*<=\s*(\d+)$")


def compile_datatype_test(test, ns=NSMAP):
    """Compile a ``datatype-regex`` @test into a :class:`_Compiled`, or None.

    The ONLY lexical restriction with a closed, provable form is the decimal-place
    cap ``string-length(substring-after(., '.')) <= n`` (UBL-DT-01, ``n = 2``): a
    node's string value may carry at most ``n`` characters after its first ``.``.
    ``substring-after`` returns the part after the first ``.`` (or the empty string
    when absent — length 0, which passes), so this is a pure string operation with
    no rounding or number() coercion, exactly reproducible.

    A ``matches(., '<regex>')`` restriction (CII-DT-097) is NOT compiled — a real
    regex engine is outside the bounded grammar, so it stays machine-listed
    known-open rather than hand-faked."""
    m = _DECIMAL_LE_RE.match((test or "").strip())
    if not m:
        return None
    return _Compiled("decimal_le", n=int(m.group(1)))


def compile_class_test(shape, test, ns=NSMAP):
    """Dispatch @test compilation by the catalog's mechanical shape class. Only
    the shapes with a closed, provable grammar compile; everything else returns
    None (=> known-open). ``datatype-regex`` compiles ONLY the decimal-place cap
    (UBL-DT-01); a ``matches()`` regex restriction (CII-DT-097) stays known-open."""
    if shape == "absence-restriction":
        return compile_test(test, ns)
    if shape == "cardinality-count":
        return compile_count_test(test, ns)
    if shape == "existence":
        return compile_existence_test(test, ns)
    if shape == "datatype-regex":
        return compile_datatype_test(test, ns)
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


class _SuffixBranch:
    """A predicated element-suffix context branch of the exact bounded form
    ``//ram:*[ends-with(name(), 'SUFFIX')]`` (or the any-namespace
    ``//*[ends-with(name(), 'SUFFIX')]``), optionally carrying the two guards the
    official CEN CII/UBL Schematron uses:

      * ``and not(self::ram:QName)``          — exclude one exact element type;
      * ``and not(ends-with(name(), 'OTHER'))`` — exclude a second name-suffix;
      * ``and not(ancestor::A/B)``            — exclude any element that has an
        ``A`` ancestor carrying a ``B`` child (the UBL-DT-01 amount guard
        ``not(ancestor::cac:Price/cac:AllowanceCharge)``).

    An element matches iff (a) if a namespace-wildcard prefix is given, the
    element is in that namespace; (b) its local name ends with SUFFIX; (c) it is
    not one of the excluded ``self::`` QNames; (d) its local name ends with none
    of the excluded suffixes; (e) none of the excluded ``ancestor::A/B`` node-sets
    is non-empty for it.

    ``ends-with(name(), 'S')`` compares the QUALIFIED name (``prefix:local``); but
    since every SUFFIX here is a plain NCName fragment (no colon), a qualified
    name can only end with it INSIDE its local part — so the local-name suffix
    test used here is provably equivalent to the official ``name()`` test. No
    general XPath: only this one predicate shape + the three bounded guards
    compile; any other predicate falls to :func:`compile_context` -> None ->
    known-open."""

    __slots__ = ("ns_uri", "suffix", "exclude_tags", "exclude_suffixes",
                 "exclude_ancestors")

    def __init__(self, ns_uri, suffix, exclude_tags, exclude_suffixes,
                 exclude_ancestors=()):
        self.ns_uri = ns_uri                    # required element ns URI, or None (//*)
        self.suffix = suffix                    # required local-name suffix
        self.exclude_tags = exclude_tags        # frozenset of Clark tags (self:: guards)
        self.exclude_suffixes = exclude_suffixes  # tuple of excluded local-name suffixes
        # tuple of (ancestor_clark, (child_clark, ...)) ancestor-path guards.
        self.exclude_ancestors = exclude_ancestors

    def matches(self, el, parents=None):
        tag = el.tag
        if not isinstance(tag, str):
            return False
        if "}" in tag:
            uri, local = tag[1:].split("}", 1)
        else:
            uri, local = "", tag
        if self.ns_uri is not None and uri != self.ns_uri:
            return False
        if not local.endswith(self.suffix):
            return False
        if tag in self.exclude_tags:
            return False
        for s in self.exclude_suffixes:
            if local.endswith(s):
                return False
        for anc_tag, child_chain in self.exclude_ancestors:
            if _ancestor_path_present(el, anc_tag, child_chain, parents):
                return False
        return True


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


def _ancestor_path_present(el, anc_tag, child_chain, parents):
    """XPath ``ancestor::<anc_tag>/<child_chain>`` non-empty test for element
    ``el``: True iff some ancestor of ``el`` has tag ``anc_tag`` AND, following the
    child-step chain from that ancestor, a non-empty node-set is reachable. Exactly
    reproduces ``ancestor::cac:Price/cac:AllowanceCharge`` (child_chain =
    ``(cac:AllowanceCharge,)``). ``parents`` is the document parent map."""
    if parents is None:
        return False
    cur = parents.get(id(el)) if parents else None
    while cur is not None:
        if cur.tag == anc_tag and _child_chain_present(cur, child_chain):
            return True
        cur = parents.get(id(cur))
    return False


def _child_chain_present(node, child_chain):
    """Whether following the child-step chain (a tuple of Clark tags) from
    ``node`` reaches at least one element."""
    current = [node]
    for tag in child_chain:
        nxt = [c for el in current for c in el if c.tag == tag]
        if not nxt:
            return False
        current = nxt
    return bool(current)


def _branch_matches(el, br, parents):
    if isinstance(br, _SuffixBranch):
        return br.matches(el, parents)
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
        raw = raw.strip()
        b = _parse_ctx_branch(raw, ns)
        if b is None:
            # Fall back to the bounded element-suffix predicate form
            # //ram:*[ends-with(name(), 'X') (and <guard>)*].
            b = _parse_suffix_ctx_branch(raw, ns)
        if b is None:
            return None
        branches.append(b)
    return _Context(branches) if branches else None


_ENDS_WITH_RE = re.compile(r"^ends-with\(\s*name\(\)\s*,\s*'([^']*)'\s*\)$")


def _strip_guard_not(g):
    """``not(...)`` / ``not (...)`` (the official artifact writes both spacings) ->
    inner text, or None if it is not a single whole-expression negation."""
    g = g.strip()
    if not g.startswith("not"):
        return None
    r = g[3:].lstrip()
    if not r.startswith("("):
        return None
    inner, tail = _match_paren(r, 0)
    if inner is None or tail.strip() != "":
        return None
    return inner.strip()


def _parse_suffix_ctx_branch(s, ns=NSMAP):
    """Parse ``//ram:*[ends-with(name(), 'X') (and <guard>)*]`` (or ``//*[...]``)
    into a :class:`_SuffixBranch`, or None if it uses any form outside this exact
    bounded grammar. Each ``<guard>`` is ``not(self::prefix:QName)`` or
    ``not(ends-with(name(), 'Y'))`` — nothing else (an ``ancestor::`` guard, an
    ``or`` in the predicate, a positional predicate, ... all fall to None ->
    known-open)."""
    s = s.strip()
    if not s.startswith("//"):
        return None
    rest = s[2:]
    lb = rest.find("[")
    if lb < 0 or not rest.endswith("]"):
        return None
    head = rest[:lb].strip()
    pred = rest[lb + 1:-1].strip()
    if head == "*":
        ns_uri = None                       # //* — any namespace
    elif head.endswith(":*"):
        ns_uri = ns.get(head[:-2])          # //prefix:* — that namespace only
        if ns_uri is None:
            return None
    else:
        return None
    conj = _split_top(pred, " and ")
    m = _ENDS_WITH_RE.match(conj[0].strip())
    if not m or not m.group(1):
        return None
    suffix = m.group(1)
    exclude_tags, exclude_suffixes, exclude_ancestors = [], [], []
    for guard in conj[1:]:
        inner = _strip_guard_not(guard)
        if inner is None:
            return None
        if inner.startswith("self::"):
            tag = _resolve_qname(inner[len("self::"):].strip(), ns)
            if tag is None:
                return None
            exclude_tags.append(tag)
        elif inner.startswith("ancestor::"):
            anc = _parse_ancestor_guard(inner, ns)
            if anc is None:
                return None
            exclude_ancestors.append(anc)
        else:
            gm = _ENDS_WITH_RE.match(inner)
            if not gm or not gm.group(1):
                return None
            exclude_suffixes.append(gm.group(1))
    return _SuffixBranch(ns_uri, suffix, frozenset(exclude_tags),
                         tuple(exclude_suffixes), tuple(exclude_ancestors))


def _parse_ancestor_guard(inner, ns=NSMAP):
    """Parse ``ancestor::A/B[/C...]`` into ``(anc_clark, (child_clark, ...))`` or
    None. A is an element QName on the ancestor axis; B, C, ... are child-step
    QNames. No predicates, no ``//``, no attribute step — only this bounded
    ancestor-then-children path (the UBL-DT-01 amount-in-price guard)."""
    body = inner[len("ancestor::"):].strip()
    if not body or "//" in body:
        return None
    parts = _split_top(body, "/")
    if len(parts) < 2:
        return None
    tags = []
    for step in parts:
        clark = _resolve_qname(step.strip(), ns)  # rejects predicates/@attr/functions
        if clark is None:
            return None
        tags.append(clark)
    return (tags[0], tuple(tags[1:]))


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
    if isinstance(br, _SuffixBranch) or br.rooted or len(br.tags) != 1:
        return None
    return br.tags[0]


def _context_leaf_tags(ctx):
    """Every branch's LEAF element tag (the element type each branch selects), or
    None if any branch has no element leaf."""
    if ctx is None:
        return None
    leaves = []
    for br in ctx.branches:
        if isinstance(br, _SuffixBranch) or not br.tags:
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


# --------------------------------------------------------------------------- #
# Element-suffix rule claim-safety (T-VHSBL.6). A predicated element-suffix rule
# ``//ram:*[ends-with(name(), 'X')]`` matches EVERY element whose name ends with
# X, but XSLT apply-templates gives each node to the FIRST rule in the pattern
# that matches it. So if an EARLIER rule in the same pattern already claims some
# of those nodes (its context selects an element whose local name also ends with
# X), the suffix rule fires on FEWER nodes than a naive independent evaluation
# would — a node-level (not whole-rule) claim. Evaluating such a suffix rule
# independently would over-fire on the stolen nodes, so we conservatively leave
# its asserts machine-listed known-open. The CEN CII artifact's ID family
# (``//ram:*[ends-with(name(), 'ID')]``, CII-DT-101..104) is exactly this case:
# the earlier specific ID-union rule (CII-DT-001/002/003) claims the four core
# ``ram:ID`` / ``ram:LineID`` / ``ram:SellerAssignedID`` nodes first. The check is
# a SOUND sufficient condition read live from the artifact (both directions: a
# concrete rule whose leaf name ends with an EARLIER suffix is likewise stolen);
# any deeper claim shape a future bump introduces would otherwise surface as a
# differential divergence and reopen the worklist.
# --------------------------------------------------------------------------- #
def _suffix_branch_of(ctx):
    """The single :class:`_SuffixBranch` of a compiled context, or None if the
    context is not exactly one bare element-suffix branch."""
    if ctx is None or len(ctx.branches) != 1:
        return None
    br = ctx.branches[0]
    return br if isinstance(br, _SuffixBranch) else None


def cii_suffix_claim_unsafe_ids(artifact_path=None):
    """CII assert ids of element-suffix rules that a per-node Schematron claim
    makes unsafe to evaluate independently (see the module note above). Read live
    from the vendored preprocessed CII artifact; empty if it is absent."""
    path = artifact_path or CII_ARTIFACT_PATH
    if not os.path.exists(path):
        return set()
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError:
        return set()
    unsafe = set()
    for pattern in root.iter(_SCH_NS + "pattern"):
        earlier_leaves = []       # local names of concrete rule leaves seen so far
        earlier_suffixes = []     # suffixes of earlier element-suffix rules
        for rule in pattern.findall(_SCH_NS + "rule"):
            ctx = compile_context(rule.get("context"), CII_NSMAP)
            sb = _suffix_branch_of(ctx)
            if sb is not None:
                suf = sb.suffix
                clash = (any(lv.endswith(suf) for lv in earlier_leaves)
                         or any(s.endswith(suf) or suf.endswith(s)
                                for s in earlier_suffixes))
                if clash:
                    _add_rule_assert_ids(rule, unsafe)
                earlier_suffixes.append(suf)
            else:
                leaves = _context_leaf_tags(ctx)
                if leaves:
                    locals_ = [_localname(t) for t in leaves]
                    if any(lv.endswith(s) for lv in locals_
                           for s in earlier_suffixes):
                        _add_rule_assert_ids(rule, unsafe)
                    earlier_leaves.extend(locals_)
    return unsafe


def _add_rule_assert_ids(rule, out):
    for a in rule.findall(_SCH_NS + "assert"):
        aid = a.get("id")
        if aid:
            out.add(aid)


def _partition_cii(shape, catalog=None, shadowed=None, suffix_unsafe=None):
    """Split one CII shape class into (implemented, known_open) using the closed
    context + test grammars resolved through CII_NSMAP. Purely a function of the
    catalog + the grammars + the artifact's rule-claiming order — no hardcoded id
    list; an id whose context or test falls outside the grammar, or which is DEAD
    by Schematron claiming (``shadowed``), is machine-listed as known-open, never
    guessed."""
    if shadowed is None:
        shadowed = cii_claim_shadowed_ids()
    if suffix_unsafe is None:
        suffix_unsafe = cii_suffix_claim_unsafe_ids()
    implemented, known_open = [], []
    for e in cii_class_entries(shape, catalog):
        rid = e.get("id")
        tc = compile_class_test(shape, e.get("test"), CII_NSMAP)
        cc = compile_context(e.get("context"), CII_NSMAP) if tc is not None else None
        if (tc is not None and cc is not None and rid not in shadowed
                and rid not in suffix_unsafe):
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
        cii_suffix_unsafe = cii_suffix_claim_unsafe_ids()
        for shape in CII_SHAPE_CLASSES:
            i, k = _partition_cii(shape, catalog, cii_shadowed,
                                  cii_suffix_unsafe)
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
    if k == "not_or_exists":
        detail = ("a restricted %s element is present without the companion "
                  "element/attribute the EN 16931 syntax binding requires "
                  "alongside it" % syn)
    elif k == "not_and":
        detail = ("two mutually-exclusive %s elements are both present — the "
                  "EN 16931 syntax binding allows at most one of them" % syn)
    elif k in ("count", "not_or_count"):
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


def _match_context_indexed(ctx, parents, by_tag, elems, positions):
    """Every element matching ANY branch of compiled context ``ctx``, in document
    order — semantically IDENTICAL to :meth:`_Context.match`, but consulting a
    per-document Clark-tag index instead of re-walking the whole tree.

    A concrete branch (``_CtxBranch``) can only match an element whose tag is the
    branch's LEAF tag, so its candidate set is exactly ``by_tag[leaf]`` (already
    in document order); each candidate is then verified with the SAME
    :func:`_branch_matches` predicate the tree-walking path uses. A
    ``_SuffixBranch`` has no single tag key, so it scans the full document-order
    element list — the same node sequence ``root.iter()`` yields. De-duplication
    (an element matching several branches counts once) plus a final sort on the
    precomputed document-order position reproduces the tree walk's
    first-matching-branch iteration order exactly."""
    out, seen = [], set()
    for br in ctx.branches:
        candidates = elems if isinstance(br, _SuffixBranch) \
            else by_tag.get(br.tags[-1], ())
        for el in candidates:
            if id(el) in seen:
                continue
            if _branch_matches(el, br, parents):
                seen.add(id(el))
                out.append(el)
    if len(ctx.branches) > 1:
        out.sort(key=lambda el: positions[id(el)])
    return out


def _evaluate_entries(root, implemented):
    """Run a list of compiled implemented entries over a parsed document ``root``
    and return syntax-binding findings. Binding-agnostic: an entry's compiled
    @context / @test already carry Clark-resolved tags, so evaluation is the same
    for UBL and CII. An assert is evaluated on EVERY node its (restricted) rule
    context matches — exactly as the official Schematron fires per matched
    context.

    PERF (T-VHPERF.2): the ONE walk that builds the ``parents`` map also builds a
    per-document, in-memory index (Clark tag -> [elements, document order] + a
    document-order position map), and each DISTINCT compiled rule context is
    matched exactly once against that index (memoized by object identity for the
    duration of this call — entry objects are alive throughout, so ``id()`` keys
    are stable). Previously every one of the ~740 entries re-walked the full tree
    in ``entry.ctx.match``; profiling put ~96% of evaluation time there. Nothing
    about WHAT fires changes: candidates are verified with the same
    ``_branch_matches`` predicate, per-entry iteration order and per-context node
    order are preserved exactly, and the index lives only for this call — no disk
    cache, no environment sensitivity."""
    if not implemented:
        return []
    parents, by_tag, elems, positions = {}, {}, [], {}
    for i, el in enumerate(root.iter()):
        elems.append(el)
        positions[id(el)] = i
        by_tag.setdefault(el.tag, []).append(el)
        for child in el:
            parents[id(child)] = el
    ctx_nodes_memo = {}
    findings = []
    for entry in implemented:
        key = id(entry.ctx)
        ctx_nodes = ctx_nodes_memo.get(key)
        if ctx_nodes is None:
            ctx_nodes = _match_context_indexed(entry.ctx, parents, by_tag,
                                               elems, positions)
            ctx_nodes_memo[key] = ctx_nodes
        for ctx in ctx_nodes:
            fires, node = entry.compiled.evaluate(ctx, root, parents)
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
