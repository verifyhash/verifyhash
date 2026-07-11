"""Hardened XML parsing for untrusted invoice input — standard library only.

Every production entry point that reads invoice XML from an untrusted supplier
(``parser.parse_file``, ``parser_cii.parse_file`` and the PDF-container byte
path in ``report._report_from_invoice_bytes``) routes through the helpers in
this module instead of calling :func:`xml.etree.ElementTree.parse` /
:func:`~xml.etree.ElementTree.fromstring` directly.

The helpers wrap the standard-library **expat** parser (via
:class:`xml.etree.ElementTree.TreeBuilder`) and install expat handlers that
**refuse** any DTD/DOCTYPE, any entity declaration, and any external-entity
reference *before* expat can define or expand a single entity. This defeats,
by construction:

* **billion-laughs** and **quadratic-blowup** entity-expansion denial of
  service — the nested ``<!ENTITY>`` definitions live inside a ``<!DOCTYPE>``
  internal subset, which is rejected at the ``StartDoctypeDeclHandler`` before
  any entity is defined, so nothing is ever expanded;
* **XXE external-entity file reads** (``<!ENTITY x SYSTEM
  'file:///etc/passwd'>``) — the DOCTYPE is rejected up front, and, as
  defence in depth, the entity-declaration and external-entity-reference
  handlers also refuse; expat never opens a URL or a file;
* **external-DTD** ``SYSTEM``/``PUBLIC`` references — rejected at the same
  DOCTYPE handler.

There are **no new runtime dependencies**: this module imports only
``xml.etree.ElementTree`` and ``xml.parsers.expat`` from the Python standard
library, so the package's zero-runtime-dependency contract is preserved.

Legitimate EN 16931 / XRechnung (UBL) and UN/CEFACT CII invoices carry **no**
DTD and **no** custom entity definitions — only the five XML-predefined
entities (``&lt; &gt; &amp; &quot; &apos;``), which expat expands natively
through the character-data path exactly as the previous ``ET.parse`` did. A
well-formed invoice therefore parses to a byte-identical model, which the
differential harness and golden-snapshot gate verify.

Resource bounds for legitimate-but-hostile input
-------------------------------------------------
Entity/DTD refusal defeats *expansion* denial-of-service, but a document with
no DTD at all can still be hostile by sheer size or shape:

* a multi-hundred-megabyte but well-formed document (memory pressure);
* millions of tiny sibling elements — a moderate-size file can still explode
  into ~1 GB of :class:`~xml.etree.ElementTree.Element` objects;
* pathologically deep element nesting — harmless on a CPython build with the
  C ``_elementtree`` accelerator (iterative tree teardown and ``.//`` search),
  but a stack-overflow / :class:`RecursionError` risk on the pure-Python
  ElementTree fallback and in any recursive consumer of the tree.

This module therefore enforces three hard, stdlib-only ceilings, each far above
anything a real EN 16931 invoice reaches (the shipped corpus tops out at
3.3 MB, depth 9, ~900 elements), each surfaced through
:class:`XMLResourceLimit` with a stable leading error-id token:

* :data:`MAX_INPUT_BYTES` — ``input-too-large``;
* :data:`MAX_ELEMENT_DEPTH` — ``max-depth-exceeded``;
* :data:`MAX_ELEMENT_COUNT` — ``too-many-elements``.

:class:`XMLResourceLimit`, like :class:`XMLSecurityError`, subclasses
:class:`~xml.etree.ElementTree.ParseError`, so an over-limit payload folds into
the engine's ordinary *not-well-formed* outcome (CLI exit 3,
``error='not-well-formed'`` report) — never a traceback, hang, OOM, or silent
pass. The ceilings are validated by ``test_robustness.py``; because they sit
orders of magnitude above every legitimate invoice, no real document's output
changes (``differential.py`` and ``test_golden_snapshot.py`` confirm).
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from xml.parsers import expat

#: Hard ceiling on the raw byte length of an untrusted invoice document. The
#: largest legitimate invoice in the shipped corpus is ~3.3 MB (an Italian
#: invoice carrying a base64 attachment); 64 MiB leaves ~20x headroom while
#: bounding the memory a single parse can commit. Exceeding it raises
#: :class:`XMLResourceLimit` with the ``input-too-large`` error id.
MAX_INPUT_BYTES = 64 * 1024 * 1024  # 67_108_864

#: Hard ceiling on XML element nesting depth. Real UBL/CII invoices are
#: schema-bounded to ~9 levels; 256 is unreachable by any legitimate document
#: yet keeps a hostile deeply-nested tree well under CPython's recursion limit
#: so no recursive consumer (or the pure-Python ElementTree fallback) can blow
#: the stack. Exceeding it raises :class:`XMLResourceLimit` with the
#: ``max-depth-exceeded`` error id.
MAX_ELEMENT_DEPTH = 256

#: Hard ceiling on the total number of XML elements in one document. The
#: shipped corpus tops out near 900 elements; 2,000,000 bounds the number of
#: Element objects (hence memory) a single parse can materialise while sitting
#: far above any real invoice, even one with thousands of lines. Exceeding it
#: raises :class:`XMLResourceLimit` with the ``too-many-elements`` error id.
MAX_ELEMENT_COUNT = 2_000_000

#: Stable machine-readable error-id tokens. Each is the leading token of the
#: corresponding :class:`XMLResourceLimit` message and is asserted verbatim by
#: ``test_robustness.py`` / documented in ``SECURITY.md``.
ERR_INPUT_TOO_LARGE = "input-too-large"
ERR_MAX_DEPTH = "max-depth-exceeded"
ERR_TOO_MANY_ELEMENTS = "too-many-elements"


class XMLResourceLimit(ET.ParseError):
    """A well-formed input exceeded a hard resource bound (size/depth/count).

    Subclasses :class:`~xml.etree.ElementTree.ParseError` for the SAME reason as
    :class:`XMLSecurityError`: the ``except ET.ParseError`` guards already in
    every production parse site fold it into the engine's ordinary
    *not-well-formed* outcome (CLI exit 3, ``error='not-well-formed'`` report),
    so a resource-abusive payload surfaces as a bounded, actionable, non-crash
    result rather than an OOM, a hang, a stack overflow, or a silent pass. The
    message always begins with one of the stable ``ERR_*`` id tokens.
    """


class XMLSecurityError(ET.ParseError):
    """A DTD, entity declaration, or external reference was found in input.

    Subclasses :class:`xml.etree.ElementTree.ParseError` on purpose: the
    existing ``except ET.ParseError`` guards in ``parser.parse_file`` /
    ``parser_cii.parse_file`` / ``report._report_from_invoice_bytes`` already
    fold a parse error into the engine's ordinary *not-well-formed* outcome
    (CLI exit 3, ``error='not-well-formed'`` report). Reusing that channel
    means a hostile payload surfaces as the SAME actionable, non-crashing
    result an ill-formed invoice would — never a bare traceback, never a hang,
    never a silent expansion.
    """


class _HardenedTreeParser:
    """A minimal ElementTree ``feed``/``close`` parser that forbids DTDs.

    Mirrors the namespace handling of the stdlib
    :class:`xml.etree.ElementTree.XMLParser` (expat created with the ``"}"``
    namespace separator, ``ordered_attributes``, ``buffer_text``) so that the
    produced tree is identical to ``ET.parse``/``ET.fromstring`` for any
    DTD-free, entity-free document — i.e. every legitimate invoice — while
    rejecting hostile constructs at the expat handler level.
    """

    def __init__(self):
        parser = expat.ParserCreate(None, "}")
        target = ET.TreeBuilder()
        self.parser = parser
        self.target = target
        self._error = expat.error
        self._names = {}
        # Resource bounds tracked live in the element handlers so a hostile
        # shape is refused mid-parse, before the whole tree is materialised.
        self._depth = 0
        self._count = 0

        parser.StartElementHandler = self._start
        parser.EndElementHandler = self._end
        parser.CharacterDataHandler = target.data
        # Match ElementTree's expat configuration so text/attributes atomize
        # identically to the previous ET.parse path.
        parser.buffer_text = 1
        parser.ordered_attributes = 1

        # --- security handlers: refuse BEFORE any definition/expansion ------
        parser.StartDoctypeDeclHandler = self._forbid_dtd
        parser.EntityDeclHandler = self._forbid_entity
        parser.UnparsedEntityDeclHandler = self._forbid_unparsed_entity
        parser.ExternalEntityRefHandler = self._forbid_external_entity
        # Do NOT set DefaultHandlerExpand: without it, expat rejects any
        # reference to an entity it was never allowed to define (undefined
        # entity -> expat error -> ParseError), which is exactly the desired
        # refusal for hostile input while leaving well-formed input untouched.

    # -- security handlers ---------------------------------------------------
    def _forbid_dtd(self, name, sysid, pubid, has_internal_subset):
        raise XMLSecurityError(
            "DTD/DOCTYPE declarations are not permitted in untrusted "
            "invoice XML (line %d, column %d)"
            % (self.parser.ErrorLineNumber, self.parser.ErrorColumnNumber))

    def _forbid_entity(self, name, is_parameter_entity, value, base,
                       sysid, pubid, notation_name):
        raise XMLSecurityError(
            "entity declarations are not permitted in untrusted invoice XML "
            "(entity %r)" % (name,))

    def _forbid_unparsed_entity(self, *args):
        raise XMLSecurityError(
            "unparsed-entity declarations are not permitted in untrusted "
            "invoice XML")

    def _forbid_external_entity(self, context, base, sysid, pubid):
        raise XMLSecurityError(
            "external entity references are not permitted in untrusted "
            "invoice XML (system id %r)" % (sysid,))

    # -- ElementTree-compatible name/element handling ------------------------
    def _fixname(self, key):
        try:
            return self._names[key]
        except KeyError:
            name = key
            if "}" in name:
                name = "{" + name
            self._names[key] = name
            return name

    def _start(self, tag, attr_list):
        # -- resource bounds: refuse a hostile shape before building the node --
        self._depth += 1
        if self._depth > MAX_ELEMENT_DEPTH:
            raise XMLResourceLimit(
                "%s: element nesting depth exceeded the hard limit of %d "
                "(line %d, column %d)"
                % (ERR_MAX_DEPTH, MAX_ELEMENT_DEPTH,
                   self.parser.ErrorLineNumber, self.parser.ErrorColumnNumber))
        self._count += 1
        if self._count > MAX_ELEMENT_COUNT:
            raise XMLResourceLimit(
                "%s: element count exceeded the hard limit of %d "
                "(line %d, column %d)"
                % (ERR_TOO_MANY_ELEMENTS, MAX_ELEMENT_COUNT,
                   self.parser.ErrorLineNumber, self.parser.ErrorColumnNumber))
        fixname = self._fixname
        tag = fixname(tag)
        attrib = {}
        if attr_list:
            for i in range(0, len(attr_list), 2):
                attrib[fixname(attr_list[i])] = attr_list[i + 1]
        return self.target.start(tag, attrib)

    def _end(self, tag):
        self._depth -= 1
        return self.target.end(self._fixname(tag))

    def _raiseerror(self, value):
        err = ET.ParseError(value)
        err.code = value.code
        err.position = value.lineno, value.offset
        raise err

    # -- driving -------------------------------------------------------------
    def feed(self, data):
        try:
            self.parser.Parse(data, False)
        except self._error as exc:
            self._raiseerror(exc)

    def close(self):
        try:
            self.parser.Parse(b"", True)
        except self._error as exc:
            self._raiseerror(exc)
        return self.target.close()


def _safe_fromstring(text):
    """Parse an XML document from ``bytes`` (or ``str``) into an Element.

    Drop-in for :func:`xml.etree.ElementTree.fromstring` for the untrusted
    byte path. Raises :class:`XMLSecurityError` (a
    :class:`~xml.etree.ElementTree.ParseError`) on any DTD / entity / external
    reference, :class:`XMLResourceLimit` when a resource bound
    (:data:`MAX_INPUT_BYTES` / :data:`MAX_ELEMENT_DEPTH` /
    :data:`MAX_ELEMENT_COUNT`) is exceeded, and the usual
    :class:`~xml.etree.ElementTree.ParseError` on ordinary ill-formed input.
    """
    # Size ceiling first: reject an oversized document before feeding a single
    # byte to expat, so the guard cost is O(1) and no giant buffer is parsed.
    if len(text) > MAX_INPUT_BYTES:
        raise XMLResourceLimit(
            "%s: input is %d bytes, exceeds the hard %d-byte parse ceiling"
            % (ERR_INPUT_TOO_LARGE, len(text), MAX_INPUT_BYTES))
    parser = _HardenedTreeParser()
    parser.feed(text)
    return parser.close()


def _safe_parse(source):
    """Parse an XML file into an :class:`~xml.etree.ElementTree.ElementTree`.

    Drop-in for :func:`xml.etree.ElementTree.parse` for the untrusted file
    path: ``_safe_parse(path).getroot()`` replaces ``ET.parse(path)`` with the
    identical return shape. Accepts a path string or an open binary file
    object. Refuses DTDs / entities / external references exactly like
    :func:`_safe_fromstring`.
    """
    # Read at most one byte past the ceiling: an oversized file is detected
    # without ever loading its full (possibly multi-GB) contents into memory.
    if hasattr(source, "read"):
        data = source.read(MAX_INPUT_BYTES + 1)
    else:
        with open(source, "rb") as fh:
            data = fh.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise XMLResourceLimit(
            "%s: input exceeds the hard %d-byte parse ceiling"
            % (ERR_INPUT_TOO_LARGE, MAX_INPUT_BYTES))
    return ET.ElementTree(_safe_fromstring(data))
