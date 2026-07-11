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
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from xml.parsers import expat


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
        fixname = self._fixname
        tag = fixname(tag)
        attrib = {}
        if attr_list:
            for i in range(0, len(attr_list), 2):
                attrib[fixname(attr_list[i])] = attr_list[i + 1]
        return self.target.start(tag, attrib)

    def _end(self, tag):
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
    reference, and the usual :class:`~xml.etree.ElementTree.ParseError` on
    ordinary ill-formed input.
    """
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
    if hasattr(source, "read"):
        data = source.read()
    else:
        with open(source, "rb") as fh:
            data = fh.read()
    return ET.ElementTree(_safe_fromstring(data))
