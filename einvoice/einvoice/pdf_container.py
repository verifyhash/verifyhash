"""Zero-dependency extractor for the embedded e-invoice XML inside a
Factur-X / ZUGFeRD (and CII-flavour XRechnung) PDF container.

WHAT THIS IS
------------
A hybrid PDF (Factur-X 1.x / ZUGFeRD 2.x, and the PDF/A-3 carrier used by the
CII flavour of XRechnung) is a normal PDF whose EN 16931 invoice travels as an
*embedded file* — a UN/CEFACT CrossIndustryInvoice XML attachment named
``factur-x.xml`` (Factur-X 1.x), ``zugferd-invoice.xml`` (ZUGFeRD 2.x),
``xrechnung.xml`` (XRechnung) or the legacy ``ZUGFeRD-invoice.xml``. This module
walks the PDF's document catalog to the ``/Names`` -> ``/EmbeddedFiles`` name
tree, finds that attachment, follows its ``/EF`` -> ``/F`` (or ``/UF``) indirect
reference to the embedded-file stream, inflates it (``/FlateDecode`` via stdlib
``zlib``, or raw bytes when unfiltered) and returns the XML bytes. Those bytes
are then fed to the SAME CII parser + rule engine the tool already ships, so
``python3 -m einvoice.report invoice.pdf`` runs the identical EN 16931 /
XRechnung rules it would run on the raw ``factur-x.xml``.

Provenance for the structure walked here:
  * PDF 32000-1:2008 (ISO 32000-1) — §7.7.2 (document catalog ``/Names`` and
    ``/AF``), §7.7.4 & §7.9.6 (name trees, ``/Kids`` / ``/Names`` node shapes),
    §7.11.3 (file specification dictionary, ``/EF``, ``/F``, ``/UF``,
    ``/AFRelationship``), §7.11.4 (embedded file streams), §7.4.4
    (``FlateDecode``), §7.5.4 (classic cross-reference table), §7.5.5 (file
    trailer) and §14.3.2 / §7.10 (the document ``/Metadata`` XMP stream).
  * Factur-X 1.0.7 / ZUGFeRD 2.x and PDF/A-3 (ISO 19005-3) — the attachment
    naming, the ``/AFRelationship`` (``/Data`` | ``/Alternative`` | ...) marker
    on the file specification, the requirement that the invoice file be an
    associated file of the catalog (``/AF``), and the Factur-X/ZUGFeRD XMP
    extension schema (namespace ``urn:factur-x:pdfa:CrossIndustryDocument:``
    ``invoice:1p0#`` / ``urn:zugferd:pdfa:...``) that declares the invoice
    ``DocumentType`` / ``ConformanceLevel`` (profile) / ``Version``.

CONTAINER-DECLARATION CHECKS (FX-CONTAINER-*)
---------------------------------------------
On top of extraction, :func:`inspect_container` layers the ZUGFeRD/Factur-X
container-declaration checks the official UN/CEFACT CII Schematron does NOT
cover, emitting each as a first-class report finding with a STABLE id:

  * ``FX-CONTAINER-AFRELATIONSHIP`` — the invoice file specification's
    ``/AFRelationship`` is absent or is not ``/Data`` or ``/Alternative``
    (PDF 32000-1 §7.11.3; Factur-X/ZUGFeRD mandate ``/Alternative`` for the
    hybrid invoice, ``/Data`` where the XML is the data source).
  * ``FX-CONTAINER-AF`` — the invoice file specification is NOT listed in the
    document catalog's ``/AF`` associated-files array (PDF 32000-1 §7.7.2 /
    §7.11.4.2), i.e. the embedded invoice is not declared an associated file.
  * ``FX-CONTAINER-XMP`` — the document ``/Metadata`` XMP stream is absent, is
    unreachable zero-dependency, or declares no Factur-X/ZUGFeRD profile
    (no ``ConformanceLevel`` in a ``urn:factur-x``/``urn:zugferd`` namespace).
    This is the "undeclared / unsupported" finding — never a false pass.
  * ``FX-CONTAINER-PROFILE`` — the XMP-declared ``ConformanceLevel`` and the CII
    ``CustomizationID`` (BT-24) map to DIFFERENT profiles (e.g. XMP says
    ``EN 16931`` but the XML CustomizationID is BASIC). Only fires when BOTH
    sides map to a recognised, distinct profile token.

PDF/A-3 IDENTIFICATION-SCHEMA CHECKS (FX-PDFA3-*)
-------------------------------------------------
A conformant ZUGFeRD/Factur-X carrier is a PDF/A-3 file, so its document XMP
MUST carry the PDF/A IDENTIFICATION schema (namespace
``http://www.aiim.org/pdfa/ns/id/``) declaring ``pdfaid:part`` and
``pdfaid:conformance``. These two checks (ISO 19005-3, identification schema)
are only evaluated when an XMP stream is PRESENT — an absent XMP stream is
already reported once as ``FX-CONTAINER-XMP``, so FX-PDFA3-* is suppressed in
that case to avoid double-reporting the same root cause:

  * ``FX-PDFA3-PART`` — the XMP does not declare ``pdfaid:part`` = 3 (absent or
    a different value). The pdfaid prefix is resolved from the declared
    namespace URI (not hardcoded), and both element form
    (``<pdfaid:part>3</pdfaid:part>``) and attribute form (``pdfaid:part="3"``)
    are accepted.
  * ``FX-PDFA3-CONFORMANCE`` — the XMP does not declare a ``pdfaid:conformance``
    level of A, B or U (absent or an out-of-range value).

This is the PDF/A-3 IDENTIFICATION subset ONLY — it verifies that the file
*declares itself* a PDF/A-3 (part 3, level A/B/U) in its XMP. It is NOT full
PDF/A-3 validation: it does NOT check font embedding, ICC/output-intent colour,
document tagging/structure, or the many other Level A/B/U requirements (those
need veraPDF-class tooling). A present-but-lying identification schema is out of
scope; a false PDF/A-3 pass is never emitted.

These are advisory ``warning`` findings: the authoritative EN 16931 / XRechnung
pass/fail is still decided by the rule engine on the embedded XML, so a wrong
container declaration is reported WITHOUT flipping ``valid`` on its own.

WHAT THIS IS *NOT* (honesty guardrail — constitution §7)
--------------------------------------------------------
This is a CONTAINER XML *extractor* plus the declaration checks above (the four
FX-CONTAINER-* checks and the two FX-PDFA3-* identification-schema checks) —
NOT a PDF/A-3 conformance validator, a typographic/visual validator, or a
digital-signature checker. The XMP, ``/AF`` and pdfaid checks inspect only the
*declarations* (is the relationship right, is the profile string consistent,
does the XMP DECLARE PDF/A-3 part 3 + level A/B/U). The FX-PDFA3-* pair is the
PDF/A-3 IDENTIFICATION subset ONLY — it does NOT verify actual PDF/A-3 Level
A/B/U conformance, font embedding, colour spaces, the output intent, document
tagging, or that the rendered page matches the XML (that needs veraPDF-class
tooling). It
deliberately handles only the common, unencrypted, classic case and refuses
everything else with a clear "unsupported container" error (never a false
pass, never a traceback). Specifically:

  HANDLED
    * ``%PDF-`` files with a classic cross-reference *table* + a ``trailer``
      dictionary carrying ``/Root``;
    * an ``/EmbeddedFiles`` name tree (inline or via ``/Kids``) naming one of
      the four known invoice attachments (case-insensitive);
    * an embedded-file stream that is either unfiltered or ``/FlateDecode``.

  NOT HANDLED (each -> ``UnsupportedContainer`` -> a valid=false report, NOT a
  crash and NOT a false pass):
    * encrypted PDFs (``/Encrypt`` in the trailer);
    * cross-reference *streams* / object streams (PDF 1.5+ compressed xref) —
      detected as "no classic trailer";
    * a missing / empty ``/EmbeddedFiles`` tree, or none of the four known
      invoice names present;
    * an embedded stream under any filter chain other than a single
      ``/FlateDecode`` (e.g. ``/DCTDecode``, multi-filter pipelines);
    * anything that is not a PDF at all (no ``%PDF-`` magic).

  Beyond the FX-CONTAINER-* and FX-PDFA3-* declaration checks above, it does
  NOT verify PDF/A-3 conformance, digital signatures, or that the visual
  rendering matches the XML.

Standard library only (``re``, ``zlib``). No network, no new dependencies.
"""

from __future__ import annotations

import re
import zlib

#: The leading magic every PDF carries (PDF 32000-1 §7.5.2). We look for it in
#: the first bytes rather than trusting the file extension.
PDF_MAGIC = b"%PDF-"

#: Invoice attachment names defined by Factur-X 1.x / ZUGFeRD 2.x / XRechnung,
#: matched case-insensitively (so the legacy ``ZUGFeRD-invoice.xml`` casing is
#: covered by ``zugferd-invoice.xml``). Kept lowercase for the comparison.
KNOWN_INVOICE_NAMES = frozenset({
    "factur-x.xml",
    "zugferd-invoice.xml",
    "xrechnung.xml",
})

#: Valid ``/AFRelationship`` values for the embedded invoice file specification
#: per Factur-X 1.x / ZUGFeRD 2.x (PDF 32000-1 §7.11.3 Table 45 defines the full
#: set; the hybrid invoice attachment must be ``/Alternative`` — the XML is an
#: alternative representation of the visual invoice — or ``/Data``).
VALID_AF_RELATIONSHIPS = frozenset({"Data", "Alternative"})

#: Stable ids for the FX-CONTAINER-* container-declaration findings (see the
#: module docstring). Reported as first-class ``warning`` findings on PDF input.
FX_AFRELATIONSHIP = "FX-CONTAINER-AFRELATIONSHIP"
FX_AF = "FX-CONTAINER-AF"
FX_XMP = "FX-CONTAINER-XMP"
FX_PROFILE = "FX-CONTAINER-PROFILE"

#: Stable ids for the PDF/A-3 IDENTIFICATION-schema findings (ISO 19005-3). A
#: conformant ZUGFeRD/Factur-X carrier is a PDF/A-3 file, so its document XMP
#: MUST declare the PDF/A identification schema: ``pdfaid:part`` = 3 and a
#: ``pdfaid:conformance`` level of A, B or U. These are the IDENTIFICATION
#: subset only — NOT full PDF/A-3 validation (see the docstring honesty note).
FX_PDFA3_PART = "FX-PDFA3-PART"
FX_PDFA3_CONFORMANCE = "FX-PDFA3-CONFORMANCE"

#: The PDF/A conformance levels ISO 19005-3 defines for Part 3 (A = accessible,
#: B = basic, U = Unicode). Matched case-insensitively.
VALID_PDFA3_CONFORMANCE = frozenset({"A", "B", "U"})


class ContainerFinding:
    """One FX-CONTAINER-* container-declaration finding.

    Structurally mirrors :class:`einvoice.rules.Violation`
    (``rule_id`` / ``message`` / ``element`` / ``severity``) so
    :mod:`einvoice.report` can project it with the SAME ``_record`` mapping it
    uses for every other violation — no special-casing in the report shape.
    """

    __slots__ = ("rule_id", "message", "element", "severity")

    def __init__(self, rule_id, message, element, severity="warning"):
        self.rule_id = rule_id
        self.message = message
        self.element = element
        self.severity = severity

    def __repr__(self):
        return "ContainerFinding(%r, %r)" % (self.rule_id, self.severity)


class ContainerInspection:
    """Result of :func:`inspect_container`: the extracted invoice ``xml_bytes``
    plus the list of :class:`ContainerFinding` container-declaration findings
    (empty when every declaration is consistent)."""

    __slots__ = ("xml_bytes", "findings")

    def __init__(self, xml_bytes, findings):
        self.xml_bytes = xml_bytes
        self.findings = findings


class UnsupportedContainer(Exception):
    """The PDF container could not be reduced to an embedded invoice XML by the
    zero-dependency, classic-case extractor (encryption, xref streams, a missing
    ``/EmbeddedFiles`` tree, an unknown filter chain, ...).

    The caller maps this to an explicit "unsupported container" non-pass report
    — never a false pass and never a traceback.
    """


# --------------------------------------------------------------------------- #
# Public entry points
# --------------------------------------------------------------------------- #
def looks_like_pdf(data: bytes) -> bool:
    """True iff ``data`` begins (within its first 1024 bytes, per PDF 32000-1
    §7.5.2 which permits leading junk) with the ``%PDF-`` magic."""
    return PDF_MAGIC in data[:1024]


def is_pdf_file(path: str) -> bool:
    """True iff the file at ``path`` carries the ``%PDF-`` magic near its head.

    Reads bytes — never trusts the ``.pdf`` extension. Returns ``False`` (rather
    than raising) if the file cannot be opened/read as a header probe.
    """
    try:
        with open(path, "rb") as fh:
            head = fh.read(1024)
    except OSError:
        return False
    return looks_like_pdf(head)


def extract_invoice_xml(path: str) -> bytes:
    """Extract and return the embedded e-invoice XML bytes from a Factur-X /
    ZUGFeRD / XRechnung PDF at ``path``.

    :raises UnsupportedContainer: on any shape the classic-case extractor does
        not handle (see the module docstring). NEVER returns partial/garbage
        bytes and never raises a bare ``zlib``/parse traceback — those are
        wrapped into :class:`UnsupportedContainer` with a human message.
    """
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        raise UnsupportedContainer("cannot read PDF %s: %s" % (path, exc))
    return extract_invoice_xml_from_bytes(data)


def extract_invoice_xml_from_bytes(data: bytes) -> bytes:
    """Bytes-level core of :func:`extract_invoice_xml` (see it for contract)."""
    container = _open_container(data)
    return _decode_stream(container.stream_obj)


def inspect_container(path: str) -> "ContainerInspection":
    """Extract the embedded invoice XML AND run the FX-CONTAINER-* container
    declaration checks (``/AFRelationship`` + ``/AF``, XMP profile declaration,
    and XMP-vs-CII profile consistency) for the PDF at ``path``.

    :returns: a :class:`ContainerInspection` — ``.xml_bytes`` (identical to
        :func:`extract_invoice_xml`) plus ``.findings`` (a list of
        :class:`ContainerFinding`, empty when the container is consistent).
    :raises UnsupportedContainer: on any shape the classic extractor cannot open
        (same contract as :func:`extract_invoice_xml`). The container CHECKS
        themselves never raise — an unparseable/absent XMP stream is reported as
        an FX-CONTAINER-XMP finding, never a traceback and never a false pass.
    """
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        raise UnsupportedContainer("cannot read PDF %s: %s" % (path, exc))
    return inspect_container_from_bytes(data)


def inspect_container_from_bytes(data: bytes) -> "ContainerInspection":
    """Bytes-level core of :func:`inspect_container` (see it for the contract)."""
    container = _open_container(data)
    xml_bytes = _decode_stream(container.stream_obj)
    findings = _container_findings(container, xml_bytes)
    return ContainerInspection(xml_bytes, findings)


def _open_container(data: bytes) -> "_Container":
    """Parse the PDF and walk it to the invoice file specification + embedded
    stream object, returning a :class:`_Container` bundle. Raises
    :class:`UnsupportedContainer` on any unhandled shape (the single place the
    extraction refusals live, shared by extraction and inspection)."""
    if not looks_like_pdf(data):
        raise UnsupportedContainer(
            "unsupported container: not a PDF (missing %PDF- magic)")

    trailer = _find_trailer(data)
    if trailer is None:
        raise UnsupportedContainer(
            "unsupported container: no classic PDF trailer — cross-reference "
            "stream / object-stream PDFs (PDF 1.5+) are not supported by the "
            "zero-dependency extractor")
    if "Encrypt" in trailer:
        raise UnsupportedContainer(
            "unsupported container: encrypted PDF (/Encrypt present) — the "
            "zero-dependency extractor does not decrypt")

    root_ref = trailer.get("Root")
    if not isinstance(root_ref, _Ref):
        raise UnsupportedContainer(
            "unsupported container: trailer has no /Root catalog reference")

    objects = _scan_objects(data)
    _finalize_streams(data, objects)

    catalog = _deref(root_ref, objects)
    if not isinstance(catalog, dict):
        raise UnsupportedContainer(
            "unsupported container: document catalog (/Root) is not a dictionary")

    names = _deref(catalog.get("Names"), objects)
    if not isinstance(names, dict):
        raise UnsupportedContainer(
            "unsupported container: catalog has no /Names dictionary "
            "(no embedded-files name tree)")

    ef_tree = _deref(names.get("EmbeddedFiles"), objects)
    if not isinstance(ef_tree, dict):
        raise UnsupportedContainer(
            "unsupported container: no /EmbeddedFiles name tree "
            "(this PDF carries no attached files)")

    filespec = _find_invoice_filespec(ef_tree, objects)
    if filespec is None:
        raise UnsupportedContainer(
            "unsupported container: /EmbeddedFiles tree has none of the known "
            "invoice attachments (%s)"
            % ", ".join(sorted(KNOWN_INVOICE_NAMES)))

    ef = _deref(filespec.get("EF"), objects)
    if not isinstance(ef, dict):
        raise UnsupportedContainer(
            "unsupported container: invoice file specification has no /EF "
            "embedded-file dictionary")

    stream_ref = ef.get("F")
    if stream_ref is None:
        stream_ref = ef.get("UF")
    stream_obj = _deref_obj(stream_ref, objects)
    if stream_obj is None or stream_obj.stream is None:
        raise UnsupportedContainer(
            "unsupported container: embedded-file stream object is missing or "
            "carries no stream data")

    return _Container(data, objects, catalog, filespec, stream_obj)


class _Container:
    """An opened Factur-X/ZUGFeRD container: the raw bytes, the scanned object
    map, the document catalog, the invoice file specification dict and its
    embedded-file stream object. The bundle the FX-CONTAINER-* checks read."""

    __slots__ = ("data", "objects", "catalog", "filespec", "stream_obj")

    def __init__(self, data, objects, catalog, filespec, stream_obj):
        self.data = data
        self.objects = objects
        self.catalog = catalog
        self.filespec = filespec
        self.stream_obj = stream_obj


# --------------------------------------------------------------------------- #
# FX-CONTAINER-* container-declaration checks
#
# These layer over extraction: given an opened container + the embedded XML,
# check the ZUGFeRD/Factur-X declarations the CII Schematron does not cover.
# Every helper is total (never raises) — a shape it cannot read becomes an
# explicit finding, mirroring the UnsupportedContainer discipline.
# --------------------------------------------------------------------------- #
def _container_findings(container, xml_bytes):
    """Return the list of :class:`ContainerFinding` for an opened container.

    Runs the three checks (AFRelationship+/AF, XMP profile declaration, and
    XMP-vs-CII profile consistency) and returns them ordered deterministically.
    """
    findings = []

    # (a) /AFRelationship on the invoice file spec (PDF 32000-1 §7.11.3).
    rel = _as_text(container.filespec.get("AFRelationship"))
    if rel is None or rel not in VALID_AF_RELATIONSHIPS:
        shown = "/%s" % rel if rel else "absent"
        findings.append(ContainerFinding(
            FX_AFRELATIONSHIP,
            "embedded invoice file specification has an absent or invalid "
            "/AFRelationship (%s); Factur-X/ZUGFeRD require /Alternative "
            "(or /Data) per PDF 32000-1 §7.11.3" % shown,
            "/EmbeddedFiles filespec /AFRelationship"))

    # (a, cont.) the invoice filespec must be an associated file of the catalog
    # (/AF array — PDF 32000-1 §7.7.2 / §7.11.4.2; ZUGFeRD/Factur-X mandate it).
    if not _filespec_in_af(container):
        findings.append(ContainerFinding(
            FX_AF,
            "embedded invoice is not declared an associated file: the invoice "
            "file specification is not referenced from the document catalog's "
            "/AF array (PDF 32000-1 §7.7.2 / §7.11.4.2)",
            "/Catalog /AF"))

    # (b) + (c): parse the XMP profile declaration, then check consistency.
    xmp_bytes = _catalog_metadata_bytes(container)

    # (d): PDF/A-3 IDENTIFICATION schema (pdfaid:part / pdfaid:conformance).
    # Only evaluated when an XMP stream is PRESENT — an absent XMP stream is
    # already reported once as FX-CONTAINER-XMP below, so firing FX-PDFA3-*
    # for the same root cause would double-report it.
    if xmp_bytes is not None:
        findings.extend(_pdfa3_identification_findings(xmp_bytes))

    xmp = _parse_xmp_profile(xmp_bytes) if xmp_bytes is not None else None
    if xmp is None or not xmp.get("conformance_level"):
        if xmp_bytes is None:
            why = ("the document has no reachable /Metadata XMP stream")
        elif xmp is None:
            why = ("the /Metadata XMP declares no urn:factur-x / urn:zugferd "
                   "namespace")
        else:
            why = ("the Factur-X/ZUGFeRD XMP declares no ConformanceLevel")
        findings.append(ContainerFinding(
            FX_XMP,
            "undeclared container profile: %s, so the ZUGFeRD/Factur-X "
            "DocumentType/ConformanceLevel/Version cannot be confirmed "
            "(ZUGFeRD 2.x / Factur-X 1.x XMP extension schema)" % why,
            "/Catalog /Metadata (XMP)"))
    else:
        # (c) consistency: XMP ConformanceLevel vs CII CustomizationID (BT-24).
        xmp_profile = _canonical_profile(xmp["conformance_level"])
        cii_id = _cii_customization_id(xml_bytes)
        cii_profile = _canonical_profile(cii_id) if cii_id else None
        if (xmp_profile is not None and cii_profile is not None
                and xmp_profile != cii_profile):
            findings.append(ContainerFinding(
                FX_PROFILE,
                "container profile mismatch: the XMP ConformanceLevel %r "
                "(profile %s) disagrees with the embedded CII CustomizationID "
                "%r (profile %s) — the PDF misdeclares its EN 16931 profile"
                % (xmp["conformance_level"], xmp_profile, cii_id, cii_profile),
                "/Metadata ConformanceLevel vs CII BT-24 CustomizationID"))
    return findings


def _filespec_in_af(container):
    """True iff the invoice file specification is listed in the catalog ``/AF``
    associated-files array (matched by object identity, falling back to the
    invoice attachment name on the referenced spec)."""
    af = _deref(container.catalog.get("AF"), container.objects)
    if not isinstance(af, list):
        return False
    for item in af:
        spec = _deref(item, container.objects)
        if spec is container.filespec:
            return True
        if isinstance(spec, dict):
            for key in ("F", "UF"):
                name = _as_text(spec.get(key))
                if name and name.strip().lower() in KNOWN_INVOICE_NAMES:
                    return True
    return False


def _catalog_metadata_bytes(container):
    """Return the decoded document ``/Metadata`` XMP stream bytes, or ``None``
    when the catalog has no reachable/decodable metadata stream (PDF 32000-1
    §14.3.2). Never raises — an undecodable stream is treated as absent."""
    obj = _deref_obj(container.catalog.get("Metadata"), container.objects)
    if obj is None or obj.stream is None or not isinstance(obj.value, dict):
        return None
    try:
        return _decode_stream(obj)
    except UnsupportedContainer:
        return None


#: A Factur-X/ZUGFeRD XMP namespace URI (any version). Matched
#: case-insensitively; ``ferd`` also catches the legacy ZUGFeRD 1.x
#: ``urn:ferd:...`` namespace.
_XMP_NS_RE = re.compile(
    r'xmlns:([\w.\-]+)\s*=\s*["\'](urn:[^"\']*(?:factur-x|zugferd|ferd)'
    r'[^"\']*)["\']', re.IGNORECASE)


def _parse_xmp_profile(xmp_bytes):
    """Parse the Factur-X/ZUGFeRD profile declaration out of an XMP packet using
    stdlib ``re`` only (no XML parser, no new deps).

    Returns ``{"namespace", "conformance_level", "document_type", "version"}``
    when a ``urn:factur-x``/``urn:zugferd`` namespace is declared, else ``None``.
    Field values may be ``None`` if that particular element/attribute is absent.
    """
    text = xmp_bytes.decode("utf-8", "replace")
    m = _XMP_NS_RE.search(text)
    if not m:
        return None
    prefix = re.escape(m.group(1))

    def _field(local):
        el = re.search(r'<%s:%s\b[^>]*>\s*(.*?)\s*</%s:%s\s*>'
                       % (prefix, local, prefix, local), text,
                       re.IGNORECASE | re.DOTALL)
        if el:
            return el.group(1).strip() or None
        attr = re.search(r'\b%s:%s\s*=\s*["\'](.*?)["\']' % (prefix, local),
                         text, re.IGNORECASE)
        return attr.group(1).strip() if attr else None

    return {
        "namespace": m.group(2),
        "conformance_level": _field("ConformanceLevel"),
        "document_type": _field("DocumentType"),
        "version": _field("Version"),
    }


#: The PDF/A IDENTIFICATION-schema namespace URI (ISO 19005-1 §6.7.11, reused
#: by ISO 19005-3). Its prefix is resolved from this declaration — NOT assumed
#: to be the conventional ``pdfaid`` — exactly like :data:`_XMP_NS_RE` resolves
#: the Factur-X prefix. Both ``http`` and ``https`` and an optional trailing
#: slash are tolerated; matched case-insensitively.
_PDFAID_NS_RE = re.compile(
    r'xmlns:([\w.\-]+)\s*=\s*["\']https?://www\.aiim\.org/pdfa/ns/id/?["\']',
    re.IGNORECASE)


def _parse_pdfaid(xmp_bytes):
    """Parse the PDF/A-3 IDENTIFICATION schema (``pdfaid:part`` /
    ``pdfaid:conformance``) out of an XMP packet using stdlib ``re`` only.

    The XML prefix bound to the pdfaid namespace URI is resolved from the
    ``xmlns:`` declaration (never hardcoded as ``pdfaid``), then used to read
    each field in BOTH element form (``<pdfaid:part>3</pdfaid:part>``) and
    attribute form (``pdfaid:part="3"``).

    Returns ``{"part", "conformance"}`` when the pdfaid namespace is declared
    (a field value is ``None`` if that element/attribute is itself absent), or
    ``None`` when no pdfaid namespace is present at all. Never raises.
    """
    text = xmp_bytes.decode("utf-8", "replace")
    m = _PDFAID_NS_RE.search(text)
    if not m:
        return None
    prefix = re.escape(m.group(1))

    def _field(local):
        el = re.search(r'<%s:%s\b[^>]*>\s*(.*?)\s*</%s:%s\s*>'
                       % (prefix, local, prefix, local), text,
                       re.IGNORECASE | re.DOTALL)
        if el:
            return el.group(1).strip() or None
        attr = re.search(r'\b%s:%s\s*=\s*["\'](.*?)["\']' % (prefix, local),
                         text, re.IGNORECASE)
        return attr.group(1).strip() if attr else None

    return {"part": _field("part"), "conformance": _field("conformance")}


def _pdfa3_identification_findings(xmp_bytes):
    """Return the FX-PDFA3-* IDENTIFICATION-schema findings for an XMP packet
    that is PRESENT (callers must gate on that — see :func:`_container_findings`).

    A ZUGFeRD/Factur-X carrier is a PDF/A-3 file (ISO 19005-3), so its document
    XMP must declare the PDF/A identification schema: ``pdfaid:part`` = 3 and a
    ``pdfaid:conformance`` of A, B or U. Absent or wrong values each become one
    ``warning`` finding. Total — never raises, never a false pass."""
    findings = []
    pdfaid = _parse_pdfaid(xmp_bytes)
    part = pdfaid.get("part") if pdfaid else None
    conformance = pdfaid.get("conformance") if pdfaid else None

    if part is None or part.strip() != "3":
        findings.append(ContainerFinding(
            FX_PDFA3_PART,
            "PDF/A-3 identification absent/wrong: the document XMP does not "
            "declare pdfaid:part = 3 (found %s). A conformant Factur-X/ZUGFeRD "
            "carrier is a PDF/A-3 file and MUST carry the PDF/A identification "
            "schema declaring part 3 (ISO 19005-3, identification schema; XMP "
            "namespace http://www.aiim.org/pdfa/ns/id/)"
            % (repr(part) if part else "absent"),
            "/Catalog /Metadata (XMP pdfaid:part)"))

    if (conformance is None
            or conformance.strip().upper() not in VALID_PDFA3_CONFORMANCE):
        findings.append(ContainerFinding(
            FX_PDFA3_CONFORMANCE,
            "PDF/A-3 identification absent/wrong: the document XMP does not "
            "declare a valid pdfaid:conformance (found %s). ISO 19005-3 "
            "requires the identification schema to declare a conformance level "
            "of A, B or U (XMP namespace http://www.aiim.org/pdfa/ns/id/)"
            % (repr(conformance) if conformance else "absent"),
            "/Catalog /Metadata (XMP pdfaid:conformance)"))
    return findings


#: Closing tag of the CII specification-identifier container, used to bound the
#: CustomizationID (BT-24) search to that element (prefix-agnostic).
_CII_GUIDELINE_RE = re.compile(
    rb"GuidelineSpecifiedDocumentContextParameter\b(.*?)"
    rb"</[\w.\-]*:?GuidelineSpecifiedDocumentContextParameter\s*>", re.DOTALL)
_CII_ID_RE = re.compile(rb"<[\w.\-]*:?ID\b[^>]*>\s*(.*?)\s*</[\w.\-]*:?ID\s*>",
                        re.DOTALL)


def _cii_customization_id(xml_bytes):
    """Extract the CII CustomizationID (BT-24, the specification identifier under
    ``ram:GuidelineSpecifiedDocumentContextParameter/ram:ID``) with ``re`` only.
    Returns the string, or ``None`` when it is absent (so no false mismatch)."""
    block = _CII_GUIDELINE_RE.search(xml_bytes)
    if not block:
        return None
    idm = _CII_ID_RE.search(block.group(1))
    if not idm:
        return None
    return idm.group(1).decode("utf-8", "replace").strip() or None


def _canonical_profile(value):
    """Map an XMP ConformanceLevel string OR a CII CustomizationID URN to a
    canonical Factur-X/ZUGFeRD profile token, or ``None`` if unrecognised.

    Recognised tokens: MINIMUM, BASICWL, BASIC, EN16931, EXTENDED, XRECHNUNG.
    Ordering matters (BASIC WL before BASIC; the CIUS/XRechnung marker before the
    plain EN 16931 URN) so the most specific match wins. Provenance: the profile
    URNs of ZUGFeRD 2.x / Factur-X 1.x (``urn:factur-x.eu:1p0:*`` and the
    ``urn:cen.eu:en16931:2017[#(compliant|conformant)#...]`` CustomizationIDs)."""
    if not value:
        return None
    v = re.sub(r"\s+", "", value).upper()
    if "MINIMUM" in v:
        return "MINIMUM"
    if "BASICWL" in v:
        return "BASICWL"
    if "EXTENDED" in v:
        return "EXTENDED"
    if "XRECHNUNG" in v:
        return "XRECHNUNG"
    if "BASIC" in v:
        return "BASIC"
    if "EN16931" in v or "COMFORT" in v:
        # Plain EN 16931 CustomizationID (urn:cen.eu:en16931:2017) or the XMP
        # 'EN 16931' / legacy 'COMFORT' ConformanceLevel.
        return "EN16931"
    return None


# --------------------------------------------------------------------------- #
# Embedded-file stream decoding
# --------------------------------------------------------------------------- #
def _decode_stream(obj: "_Obj") -> bytes:
    """Inflate (or pass through) the raw bytes of an embedded-file stream.

    Honours a single ``/FlateDecode`` (PDF 32000-1 §7.4.4, RFC 1950 zlib) or no
    filter. Any other filter, or a multi-filter chain, is an unsupported
    container (we do not implement LZW/ASCII85/DCT/etc. here).
    """
    flt = obj.value.get("Filter")
    if flt is None:
        return obj.stream
    if isinstance(flt, _Name):
        filters = [flt]
    elif isinstance(flt, list):
        filters = list(flt)
    else:
        raise UnsupportedContainer(
            "unsupported container: unrecognised /Filter on embedded stream")

    if len(filters) != 1 or not isinstance(filters[0], _Name):
        raise UnsupportedContainer(
            "unsupported container: multi-filter or non-name /Filter chain on "
            "the embedded stream is not supported")

    name = str(filters[0])
    if name != "FlateDecode":
        raise UnsupportedContainer(
            "unsupported container: embedded stream uses /%s, only "
            "/FlateDecode (or no filter) is supported" % name)
    try:
        return zlib.decompress(obj.stream)
    except zlib.error as exc:
        raise UnsupportedContainer(
            "unsupported container: FlateDecode inflate failed: %s" % exc)


# --------------------------------------------------------------------------- #
# Name-tree walk (PDF 32000-1 §7.9.6)
# --------------------------------------------------------------------------- #
def _find_invoice_filespec(node, objects, depth=0):
    """Walk an ``/EmbeddedFiles`` name tree and return the file-specification
    dict whose attachment name is one of :data:`KNOWN_INVOICE_NAMES`, else None.

    Handles both node shapes: a leaf with ``/Names [ name filespec ... ]`` and
    an intermediate with ``/Kids [ ... ]`` (recursed). The match is made on the
    name-tree key AND on the file spec's own ``/F`` / ``/UF`` display name, all
    compared case-insensitively.
    """
    if depth > 64 or not isinstance(node, dict):
        return None

    pairs = node.get("Names")
    if isinstance(pairs, list):
        # [ key1 filespec1 key2 filespec2 ... ]
        for i in range(0, len(pairs) - 1, 2):
            key = _as_text(pairs[i])
            filespec = _deref(pairs[i + 1], objects)
            if not isinstance(filespec, dict):
                continue
            candidates = [key,
                          _as_text(filespec.get("F")),
                          _as_text(filespec.get("UF"))]
            for cand in candidates:
                if cand and cand.strip().lower() in KNOWN_INVOICE_NAMES:
                    return filespec

    kids = node.get("Kids")
    if isinstance(kids, list):
        for kid in kids:
            child = _deref(kid, objects)
            found = _find_invoice_filespec(child, objects, depth + 1)
            if found is not None:
                return found
    return None


# --------------------------------------------------------------------------- #
# PDF object model + a small recursive-descent value parser
# --------------------------------------------------------------------------- #
class _Ref:
    """An indirect object reference ``num gen R`` (PDF 32000-1 §7.3.10)."""

    __slots__ = ("num", "gen")

    def __init__(self, num, gen):
        self.num = num
        self.gen = gen

    def __repr__(self):
        return "_Ref(%d, %d)" % (self.num, self.gen)


class _Name:
    """A PDF name object ``/Foo`` (PDF 32000-1 §7.3.5), stored without the ``/``
    and with ``#XX`` escapes decoded. Compares/str()s as its text."""

    __slots__ = ("value",)

    def __init__(self, value):
        self.value = value

    def __str__(self):
        return self.value

    def __repr__(self):
        return "/%s" % self.value

    def __eq__(self, other):
        if isinstance(other, _Name):
            return self.value == other.value
        return NotImplemented

    def __hash__(self):
        return hash(self.value)


class _Obj:
    """A scanned indirect object: its parsed value plus raw stream bytes (if a
    stream object)."""

    __slots__ = ("num", "gen", "value", "stream")

    def __init__(self, num, gen, value, stream=None):
        self.num = num
        self.gen = gen
        self.value = value
        self.stream = stream


_WHITESPACE = b"\x00\t\n\x0c\r "
_DELIM = b"()<>[]{}/%"


def _skip_ws(b, i):
    """Advance past PDF whitespace and ``%`` comments (PDF 32000-1 §7.2.3)."""
    n = len(b)
    while i < n:
        c = b[i]
        if c in _WHITESPACE:
            i += 1
        elif c == 0x25:  # '%' comment runs to end of line
            j = i + 1
            while j < n and b[j] not in b"\r\n":
                j += 1
            i = j
        else:
            break
    return i


_REF_RE = re.compile(rb"(\d+)\s+(\d+)\s+R(?![a-zA-Z0-9])")
_NUM_RE = re.compile(rb"[+-]?(?:\d+\.?\d*|\.\d+)")


def _parse_value(b, i):
    """Parse ONE PDF object value starting at ``i``; return ``(value, next_i)``.

    Supports dicts, arrays, names, literal/hex strings, numbers, booleans,
    null and indirect references — the subset needed to walk to an embedded
    file. Raises :class:`UnsupportedContainer` on a construct it cannot parse.
    """
    i = _skip_ws(b, i)
    if i >= len(b):
        raise UnsupportedContainer("unsupported container: truncated PDF object")
    two = b[i:i + 2]
    c = b[i:i + 1]
    if two == b"<<":
        return _parse_dict(b, i)
    if c == b"[":
        return _parse_array(b, i)
    if c == b"(":
        return _parse_literal_string(b, i)
    if c == b"<":
        return _parse_hex_string(b, i)
    if c == b"/":
        return _parse_name(b, i)
    if b[i:i + 4] == b"true":
        return True, i + 4
    if b[i:i + 5] == b"false":
        return False, i + 5
    if b[i:i + 4] == b"null":
        return None, i + 4
    # number or indirect reference
    m = _REF_RE.match(b, i)
    if m:
        return _Ref(int(m.group(1)), int(m.group(2))), m.end()
    m = _NUM_RE.match(b, i)
    if m:
        tok = m.group(0)
        if b"." in tok:
            return float(tok), m.end()
        return int(tok), m.end()
    raise UnsupportedContainer(
        "unsupported container: unparseable PDF token at byte %d" % i)


def _parse_dict(b, i):
    i += 2  # past '<<'
    out = {}
    n = len(b)
    while True:
        i = _skip_ws(b, i)
        if i >= n:
            raise UnsupportedContainer("unsupported container: unterminated dict")
        if b[i:i + 2] == b">>":
            return out, i + 2
        if b[i:i + 1] != b"/":
            raise UnsupportedContainer(
                "unsupported container: dict key is not a name at byte %d" % i)
        key, i = _parse_name(b, i)
        val, i = _parse_value(b, i)
        out[str(key)] = val


def _parse_array(b, i):
    i += 1  # past '['
    out = []
    n = len(b)
    while True:
        i = _skip_ws(b, i)
        if i >= n:
            raise UnsupportedContainer("unsupported container: unterminated array")
        if b[i:i + 1] == b"]":
            return out, i + 1
        val, i = _parse_value(b, i)
        out.append(val)


_NAME_HEX_RE = re.compile(rb"#([0-9A-Fa-f]{2})")


def _parse_name(b, i):
    i += 1  # past '/'
    n = len(b)
    start = i
    while i < n and b[i] not in _WHITESPACE and b[i] not in _DELIM:
        i += 1
    raw = b[start:i]
    raw = _NAME_HEX_RE.sub(lambda m: bytes([int(m.group(1), 16)]), raw)
    return _Name(raw.decode("latin-1")), i


def _parse_literal_string(b, i):
    """Parse a ``(...)`` literal string with balanced parens + backslash escapes
    (PDF 32000-1 §7.3.4.2). Returned as a Python ``str`` (latin-1 / decoded
    bytes) — sufficient for the ASCII attachment names we match on."""
    i += 1  # past '('
    n = len(b)
    depth = 1
    out = bytearray()
    while i < n:
        c = b[i]
        if c == 0x5C:  # backslash
            i += 1
            if i >= n:
                break
            e = b[i]
            simple = {0x6E: 0x0A, 0x72: 0x0D, 0x74: 0x09, 0x62: 0x08,
                      0x66: 0x0C, 0x28: 0x28, 0x29: 0x29, 0x5C: 0x5C}
            if e in simple:
                out.append(simple[e])
                i += 1
            elif 0x30 <= e <= 0x37:  # up to 3 octal digits
                j = i
                digits = b""
                while j < n and len(digits) < 3 and 0x30 <= b[j] <= 0x37:
                    digits += b[j:j + 1]
                    j += 1
                out.append(int(digits, 8) & 0xFF)
                i = j
            elif e in (0x0A, 0x0D):  # line continuation
                i += 1
                if e == 0x0D and i < n and b[i] == 0x0A:
                    i += 1
            else:
                out.append(e)
                i += 1
        elif c == 0x28:  # '('
            depth += 1
            out.append(c)
            i += 1
        elif c == 0x29:  # ')'
            depth -= 1
            if depth == 0:
                i += 1
                break
            out.append(c)
            i += 1
        else:
            out.append(c)
            i += 1
    return _decode_pdf_string_bytes(bytes(out)), i


def _parse_hex_string(b, i):
    i += 1  # past '<'
    n = len(b)
    start = i
    while i < n and b[i:i + 1] != b">":
        i += 1
    hexdigits = re.sub(rb"[^0-9A-Fa-f]", b"", b[start:i])
    if len(hexdigits) % 2:
        hexdigits += b"0"
    try:
        raw = bytes.fromhex(hexdigits.decode("ascii"))
    except ValueError:
        raw = b""
    return _decode_pdf_string_bytes(raw), i + 1


def _decode_pdf_string_bytes(raw):
    """Decode PDF string bytes to text. UTF-16BE when the ``\\xfe\\xff`` BOM is
    present (PDF 32000-1 §7.9.2.2), otherwise latin-1 (PDFDocEncoding is
    ASCII-compatible for the filenames we compare)."""
    if raw[:2] == b"\xfe\xff":
        try:
            return raw[2:].decode("utf-16-be")
        except UnicodeDecodeError:
            return raw[2:].decode("latin-1")
    return raw.decode("latin-1")


def _as_text(value):
    """Coerce a parsed name/string value to plain text for name matching."""
    if isinstance(value, _Name):
        return value.value
    if isinstance(value, str):
        return value
    return None


# --------------------------------------------------------------------------- #
# Object scanning + stream capture
# --------------------------------------------------------------------------- #
_OBJ_RE = re.compile(rb"(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+obj\b")


def _scan_objects(data):
    """Scan every ``N G obj ... endobj`` into an ``{(num, gen): _Obj}`` map.

    The value dict is parsed eagerly; a stream's raw byte range is recorded and
    resolved later in :func:`_finalize_streams` (once all indirect ``/Length``
    references are known). Matches that fall *inside* an already-captured stream
    body are skipped, so binary stream content that happens to contain
    ``N G obj`` bytes cannot forge a spurious object.
    """
    objects = {}
    pending = []  # (num, gen, _Obj, stream_start, length_value)
    covered_until = 0
    for m in _OBJ_RE.finditer(data):
        if m.start() < covered_until:
            continue
        num = int(m.group(1))
        gen = int(m.group(2))
        try:
            value, j = _parse_value(data, m.end())
        except UnsupportedContainer:
            continue  # skip an object we cannot parse; others may still resolve
        obj = _Obj(num, gen, value)
        stream_start = None
        length_value = None
        k = _skip_ws(data, j)
        if data[k:k + 6] == b"stream" and isinstance(value, dict):
            k += 6
            if data[k:k + 2] == b"\r\n":
                k += 2
            elif data[k:k + 1] in (b"\n", b"\r"):
                k += 1
            stream_start = k
            length_value = value.get("Length")
            end = data.find(b"endstream", k)
            covered_until = end if end != -1 else k
        objects[(num, gen)] = obj
        pending.append((num, gen, obj, stream_start, length_value))
    # stash pending stream metadata on the objects for _finalize_streams
    _PENDING_STREAMS[id(objects)] = pending
    return objects


#: Transient side-table so :func:`_finalize_streams` can see the stream byte
#: offsets discovered during scanning without threading them through the public
#: return type. Keyed by ``id(objects)`` and popped immediately after use.
_PENDING_STREAMS = {}


def _finalize_streams(data, objects):
    """Slice each stream object's raw bytes now that every object (hence any
    indirect ``/Length``) is known. Prefers an explicit ``/Length`` and falls
    back to the ``endstream`` sentinel, trimming one trailing EOL."""
    pending = _PENDING_STREAMS.pop(id(objects), [])
    for num, gen, obj, stream_start, length_value in pending:
        if stream_start is None:
            continue
        length = _deref(length_value, objects)
        if isinstance(length, int) and length >= 0:
            candidate = data[stream_start:stream_start + length]
            # Sanity-check that endstream follows; if not, fall back to search.
            tail = _skip_ws(data, stream_start + length)
            if data[tail:tail + 9] == b"endstream":
                obj.stream = candidate
                continue
        end = data.find(b"endstream", stream_start)
        if end == -1:
            obj.stream = data[stream_start:]
            continue
        raw = data[stream_start:end]
        if raw.endswith(b"\r\n"):
            raw = raw[:-2]
        elif raw.endswith(b"\n") or raw.endswith(b"\r"):
            raw = raw[:-1]
        obj.stream = raw


def _find_trailer(data):
    """Return the file-trailer dictionary (PDF 32000-1 §7.5.5), or None.

    Uses the LAST ``trailer`` keyword (the most recent incremental update).
    ``None`` means there is no classic trailer at all — the signature of a
    cross-reference-stream PDF, which this extractor does not support.
    """
    idx = data.rfind(b"trailer")
    if idx == -1:
        return None
    try:
        value, _ = _parse_value(data, idx + len("trailer"))
    except UnsupportedContainer:
        return None
    return value if isinstance(value, dict) else None


def _deref(value, objects, depth=0):
    """Resolve indirect references to their parsed value (one or more hops)."""
    seen = 0
    while isinstance(value, _Ref) and seen < 64:
        obj = _deref_obj(value, objects)
        if obj is None:
            return None
        value = obj.value
        seen += 1
    return value


def _deref_obj(ref, objects):
    """Resolve a :class:`_Ref` to its :class:`_Obj` (with a gen-0 fallback)."""
    if not isinstance(ref, _Ref):
        return None
    obj = objects.get((ref.num, ref.gen))
    if obj is None:
        obj = objects.get((ref.num, 0))
    return obj
