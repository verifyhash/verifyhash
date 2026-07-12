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


class _Compiled:
    """A compiled @test: ``evaluate(ctx, root) -> (fires, offending_node)``."""

    __slots__ = ("kind", "p", "q", "literal")

    def __init__(self, kind, p, q=None, literal=None):
        self.kind = kind        # "not" | "not_or_eq"
        self.p = p
        self.q = q
        self.literal = literal

    def evaluate(self, ctx, root):
        p_nodes = _select(self.p, ctx, root)
        if not p_nodes:
            return (False, None)
        if self.kind == "not":
            return (True, p_nodes[0])
        # not(P) or Q = 'literal' : passes if any Q string-value == literal.
        q_nodes = _select(self.q, ctx, root)
        if any(_string_value(n) == self.literal for n in q_nodes):
            return (False, None)
        return (True, p_nodes[0])


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


class _Entry:
    __slots__ = ("id", "flag", "test", "context", "compiled")

    def __init__(self, rid, flag, test, context, compiled):
        self.id = rid
        self.flag = flag
        self.test = test
        self.context = context
        self.compiled = compiled


def _partition(catalog=None):
    """Split the absence-restriction class into (implemented, known_open).

    An entry is IMPLEMENTED iff its context is the supported document root AND
    its @test compiles under the restricted grammar; otherwise it is known-open.
    Purely a function of the catalog + the grammar — no hardcoded id list.
    """
    implemented, known_open = [], []
    for e in absence_restriction_entries(catalog):
        rid = e.get("id")
        compiled = None
        if e.get("context") == SUPPORTED_CONTEXT:
            compiled = compile_test(e.get("test"))
        if compiled is not None:
            implemented.append(_Entry(rid, e.get("flag") or "fatal",
                                      e.get("test"), e.get("context"), compiled))
        else:
            known_open.append(rid)
    return implemented, known_open


_CACHE = {"implemented": None, "known_open": None}


def _ensure_cache():
    if _CACHE["implemented"] is None:
        impl, ko = _partition()
        _CACHE["implemented"] = impl
        _CACHE["known_open"] = ko
    return _CACHE["implemented"], _CACHE["known_open"]


def reset_cache():
    """Drop the cached partition (used by tests that reload the catalog)."""
    _CACHE["implemented"] = None
    _CACHE["known_open"] = None


def implemented_ids():
    """Sorted list of the differential-proven, implemented absence-restriction
    ids — live-computed from the catalog + the restricted grammar."""
    impl, _ = _ensure_cache()
    return sorted(e.id for e in impl)


def known_open_ids():
    """Sorted list of the absence-restriction ids left UNIMPLEMENTED (machine-
    listed as known-open) — the exact remainder of the 699-strong class."""
    _, ko = _ensure_cache()
    return sorted(ko)


def implemented_entries():
    """The compiled implemented entries (for the report/differential pipeline)."""
    impl, _ = _ensure_cache()
    return impl


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
    kind = ("forbidden UBL element/attribute is present"
            if entry.compiled.kind == "not"
            else "restricted UBL element is present with a non-conforming value")
    return ("Syntax-binding restriction %s (CEN EN 16931 UBL, flag=%s): %s at "
            "%s — the EN 16931 core model has no conformant slot for it "
            "(@test=%s)." % (entry.id, entry.flag, kind, path, entry.test))


def evaluate(root):
    """Evaluate every IMPLEMENTED absence-restriction assert over a parsed UBL
    document ``root`` and return the list of syntax-binding findings.

    Each finding is a dict carrying ``id``, ``category`` (``"syntax-binding"``),
    ``severity`` (mirroring the official @flag), ``flag``, ``message`` and
    ``element`` (the offending node's location path). Non-UBL roots (or a missing
    catalog) yield an empty list.
    """
    ctx_nodes = _context_nodes(root)
    if not ctx_nodes:
        return []
    implemented, _ = _ensure_cache()
    if not implemented:
        return []
    parents = {id(child): parent
               for parent in root.iter() for child in parent}
    findings = []
    for entry in implemented:
        for ctx in ctx_nodes:
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
                break  # one finding per assert (the context is a single root)
    return findings


def fired_ids(root):
    """The set of implemented syntax-binding ids that FIRE on ``root`` — the
    fired-id projection ``differential.py`` compares against the official
    SVRL failed-assert set."""
    return {f["id"] for f in evaluate(root)}
