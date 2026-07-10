#!/usr/bin/env python3
"""Reproducibly build the tiny Factur-X/ZUGFeRD PDF fixtures used by
``einvoice/test_pdf_container.py``.

Standard library only (``zlib``). Each fixture is a *minimal but real* PDF:
a classic cross-reference table, a ``trailer`` with ``/Root``, one blank page,
and — where applicable — a ``/Names`` -> ``/EmbeddedFiles`` name tree wrapping
a corpus CrossIndustryInvoice XML as a ``/FlateDecode`` embedded-file stream
named ``factur-x.xml`` (the Factur-X 1.x attachment name; PDF 32000-1 §7.11.4
+ ISO 19005-3 / Factur-X ``/AFRelationship``), a catalog ``/AF`` associated-file
array (PDF 32000-1 §7.7.2 / §7.11.4.2) and a document ``/Metadata`` XMP stream
declaring the Factur-X/ZUGFeRD profile (``urn:factur-x:pdfa:CrossIndustry``
``Document:invoice:1p0#`` DocumentType/Version/ConformanceLevel).

The embedded payloads are EXISTING corpus invoices so the extracted XML runs the
same rule engine as validating that XML directly. Both corpus samples carry the
CustomizationID ``urn:cen.eu:en16931:2017`` (the EN 16931 profile), so a matching
container declares ConformanceLevel ``EN 16931``:

  * facturx-valid.pdf        wraps CII_example5.xml, MATCHING container
  * facturx-bad.pdf          wraps CII_example6.xml (BR-DE fatals), MATCHING
                             container (only the XML is bad, not the container)
  * facturx-valid-uncompressed.pdf  as facturx-valid.pdf, unfiltered stream
  * no-embedded.pdf          a valid PDF with NO /EmbeddedFiles (unsupported)
  * encrypted.pdf            a PDF whose trailer carries /Encrypt (unsupported)
  * facturx-afrel-bad.pdf    /AFRelationship /Unspecified -> FX-CONTAINER-AFRELATIONSHIP
  * facturx-af-missing.pdf   no catalog /AF array -> FX-CONTAINER-AF
  * facturx-xmp-missing.pdf  no /Metadata XMP stream -> FX-CONTAINER-XMP
  * facturx-xmp-mismatch.pdf XMP ConformanceLevel BASIC vs XML EN 16931 ->
                             FX-CONTAINER-PROFILE
  * facturx-pdfa3-missing.pdf XMP present with a valid Factur-X profile but NO
                             pdfaid identification schema -> FX-PDFA3-PART +
                             FX-PDFA3-CONFORMANCE (ISO 19005-3 identity subset)

Run ``python3 make_pdf_fixtures.py`` from this directory to regenerate; the
outputs are byte-stable (deterministic zlib level 9), so the committed fixtures
and a fresh build are identical.
"""

import os
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.normpath(os.path.join(HERE, "..", "cen-en16931", "cii",
                                       "examples"))


def _assemble(objects, root_num, extra_trailer=b""):
    """Assemble numbered PDF objects (contiguous 1..K) into a classic-xref PDF.

    :param objects: list of ``(num, body_bytes)`` where ``body_bytes`` is the
        full object payload (a ``<<...>>`` dict, optionally followed by a
        ``stream ... endstream`` block) WITHOUT the ``N G obj`` / ``endobj``
        wrapper.
    :param root_num: object number of the document catalog (trailer ``/Root``).
    :param extra_trailer: extra raw bytes to splice into the trailer dict
        (e.g. ``b" /Encrypt 9 0 R"``) — used to forge the unsupported cases.
    """
    objects = sorted(objects, key=lambda t: t[0])
    out = bytearray()
    out += b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"  # binary marker per PDF 32000-1 note
    offsets = {}
    for num, body in objects:
        offsets[num] = len(out)
        out += b"%d 0 obj\n" % num
        out += body
        out += b"\nendobj\n"

    count = max(offsets) + 1
    xref_pos = len(out)
    xref = bytearray()
    xref += b"xref\n0 %d\n" % count
    xref += b"0000000000 65535 f \n"
    for num in range(1, count):
        xref += b"%010d 00000 n \n" % offsets.get(num, 0)
    out += xref
    out += (b"trailer\n<< /Size %d /Root %d 0 R%s >>\nstartxref\n%d\n%%%%EOF\n"
            % (count, root_num, extra_trailer, xref_pos))
    return bytes(out)


def _embedded_file_object(num, xml_bytes, compress=True):
    """Build the ``/EmbeddedFile`` stream object body for ``xml_bytes``."""
    if compress:
        data = zlib.compress(xml_bytes, 9)
        filt = b" /Filter /FlateDecode"
    else:
        data = xml_bytes
        filt = b""
    dict_bytes = (b"<< /Type /EmbeddedFile /Subtype /text#2Fxml%s "
                  b"/Length %d /Params << /Size %d >> >>"
                  % (filt, len(data), len(xml_bytes)))
    body = dict_bytes + b"\nstream\n" + data + b"\nendstream"
    return (num, body)


#: The Factur-X 1.x XMP extension-schema namespace (ZUGFeRD 2.1.1 recommends the
#: SAME namespace). Fields: DocumentType, DocumentFileName, Version,
#: ConformanceLevel — the profile declaration the FX-CONTAINER-XMP/-PROFILE
#: checks read. Provenance: Factur-X 1.0.7 technical spec, XMP extension schema.
XMP_FX_NAMESPACE = "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"


#: The PDF/A IDENTIFICATION-schema namespace (ISO 19005-1 §6.7.11, reused by
#: ISO 19005-3). A conformant Factur-X/ZUGFeRD carrier is a PDF/A-3 file, so its
#: document XMP declares pdfaid:part = 3 and pdfaid:conformance = A/B/U here.
XMP_PDFAID_NAMESPACE = "http://www.aiim.org/pdfa/ns/id/"


def _xmp_packet(attach_name, conformance_level, version="1.0",
                document_type="INVOICE", include_pdfaid=True,
                pdfaid_part="3", pdfaid_conformance="B"):
    """Build a minimal, deterministic XMP metadata packet declaring the
    Factur-X/ZUGFeRD profile. Byte-stable (fixed whitespace, no timestamps).

    When ``include_pdfaid`` (the conformant default) it also carries the PDF/A-3
    IDENTIFICATION schema (``pdfaid:part`` / ``pdfaid:conformance``, ISO 19005-3)
    in its own ``rdf:Description``; ``include_pdfaid=False`` forges the
    FX-PDFA3-* negative fixture (a Factur-X profile but no pdfaid identity)."""
    pdfaid_block = ""
    if include_pdfaid:
        pdfaid_block = (
            '  <rdf:Description rdf:about="" xmlns:pdfaid="%s">\n'
            '   <pdfaid:part>%s</pdfaid:part>\n'
            '   <pdfaid:conformance>%s</pdfaid:conformance>\n'
            '  </rdf:Description>\n'
            % (XMP_PDFAID_NAMESPACE, pdfaid_part, pdfaid_conformance))
    return (
        '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
        ' <rdf:RDF xmlns:rdf='
        '"http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        '  <rdf:Description rdf:about="" xmlns:fx="%s">\n'
        '   <fx:DocumentType>%s</fx:DocumentType>\n'
        '   <fx:DocumentFileName>%s</fx:DocumentFileName>\n'
        '   <fx:Version>%s</fx:Version>\n'
        '   <fx:ConformanceLevel>%s</fx:ConformanceLevel>\n'
        '  </rdf:Description>\n'
        '%s'
        ' </rdf:RDF>\n'
        '</x:xmpmeta>\n'
        '<?xpacket end="w"?>'
        % (XMP_FX_NAMESPACE, document_type, attach_name, version,
           conformance_level, pdfaid_block)
    ).encode("utf-8")


def _metadata_object(num, xmp_bytes):
    """Build the document ``/Metadata`` XMP stream object body (uncompressed —
    PDF/A requires the XMP metadata stream to be readable without a filter)."""
    dict_bytes = (b"<< /Type /Metadata /Subtype /XML /Length %d >>"
                  % len(xmp_bytes))
    body = dict_bytes + b"\nstream\n" + xmp_bytes + b"\nendstream"
    return (num, body)


def build_facturx_pdf(xml_bytes, attach_name="factur-x.xml", compress=True,
                      af_relationship="Alternative", in_af_array=True,
                      xmp_conformance_level="EN 16931", include_xmp=True,
                      include_pdfaid=True):
    """Return the bytes of a minimal hybrid PDF embedding ``xml_bytes``.

    Object layout (contiguous, gen 0):
      1 Catalog  -> /Pages 2, /Names << /EmbeddedFiles 6 >>, [/AF [4]],
                    [/Metadata 7]
      2 Pages    -> /Kids [3]
      3 Page     (blank A-ish page)
      4 Filespec -> /F,/UF = attach_name, [/AFRelationship rel], /EF /F 5
      5 EmbeddedFile stream (FlateDecode by default)
      6 EmbeddedFiles name-tree leaf -> /Names [ (attach_name) 4 0 R ]
      7 Metadata XMP stream (only when ``include_xmp``)

    The knobs forge the FX-CONTAINER-* mismatch fixtures:
      * ``af_relationship=None`` / an invalid value  -> FX-CONTAINER-AFRELATIONSHIP
      * ``in_af_array=False``                        -> FX-CONTAINER-AF
      * ``include_xmp=False``                        -> FX-CONTAINER-XMP
      * ``xmp_conformance_level`` != the XML profile -> FX-CONTAINER-PROFILE
      * ``include_pdfaid=False`` (XMP present, no pdfaid identity)
                                             -> FX-PDFA3-PART + FX-PDFA3-CONFORMANCE
    """
    name = attach_name.encode("latin-1")
    af_part = b" /AF [4 0 R]" if in_af_array else b""
    meta_part = b" /Metadata 7 0 R" if include_xmp else b""
    catalog = (b"<< /Type /Catalog /Pages 2 0 R "
               b"/Names << /EmbeddedFiles 6 0 R >>%s%s >>"
               % (af_part, meta_part))
    pages = b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"
    page = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"
    rel_part = (b" /AFRelationship /%s" % af_relationship.encode("latin-1")
                if af_relationship else b"")
    filespec = (b"<< /Type /Filespec /F (%s) /UF (%s)%s /Desc (Invoice) "
                b"/EF << /F 5 0 R /UF 5 0 R >> >>" % (name, name, rel_part))
    embedded = _embedded_file_object(5, xml_bytes, compress=compress)
    nametree = b"<< /Names [ (%s) 4 0 R ] >>" % name
    objects = [
        (1, catalog),
        (2, pages),
        (3, page),
        (4, filespec),
        embedded,
        (6, nametree),
    ]
    if include_xmp:
        xmp = _xmp_packet(attach_name, xmp_conformance_level,
                          include_pdfaid=include_pdfaid)
        objects.append(_metadata_object(7, xmp))
    return _assemble(objects, root_num=1)


def build_plain_pdf():
    """A valid one-page PDF with NO /EmbeddedFiles (the 'no attachment' case)."""
    catalog = b"<< /Type /Catalog /Pages 2 0 R >>"
    pages = b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"
    page = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"
    return _assemble([(1, catalog), (2, pages), (3, page)], root_num=1)


def build_encrypted_pdf():
    """A PDF whose trailer advertises /Encrypt — the extractor must refuse it
    rather than emit garbage (it does not implement decryption)."""
    catalog = b"<< /Type /Catalog /Pages 2 0 R >>"
    pages = b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"
    page = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"
    enc = (b"<< /Filter /Standard /V 2 /R 3 /Length 128 "
           b"/P -44 /O (0000000000000000) /U (0000000000000000) >>")
    return _assemble([(1, catalog), (2, pages), (3, page), (9, enc)],
                     root_num=1, extra_trailer=b" /Encrypt 9 0 R")


def _example5():
    return _read(os.path.join(CORPUS, "CII_example5.xml"))


FIXTURES = {
    # --- MATCHING containers (no FX-CONTAINER-* finding) -------------------
    "facturx-valid.pdf": lambda: build_facturx_pdf(_example5()),
    "facturx-bad.pdf": lambda: build_facturx_pdf(
        _read(os.path.join(CORPUS, "CII_example6.xml"))),
    "facturx-valid-uncompressed.pdf": lambda: build_facturx_pdf(
        _example5(), compress=False),
    # --- unsupported containers (refused before any FX-CONTAINER check) ----
    "no-embedded.pdf": build_plain_pdf,
    "encrypted.pdf": build_encrypted_pdf,
    # --- MISMATCHING containers (each fires one FX-CONTAINER-* finding) -----
    #  wrong /AFRelationship (/Unspecified is not /Data or /Alternative)
    "facturx-afrel-bad.pdf": lambda: build_facturx_pdf(
        _example5(), af_relationship="Unspecified"),
    #  invoice filespec is NOT in the catalog /AF associated-files array
    "facturx-af-missing.pdf": lambda: build_facturx_pdf(
        _example5(), in_af_array=False),
    #  no document /Metadata XMP stream at all (undeclared profile)
    "facturx-xmp-missing.pdf": lambda: build_facturx_pdf(
        _example5(), include_xmp=False),
    #  XMP says BASIC but the embedded CII CustomizationID is EN 16931
    "facturx-xmp-mismatch.pdf": lambda: build_facturx_pdf(
        _example5(), xmp_conformance_level="BASIC"),
    #  XMP present with a valid Factur-X ConformanceLevel but NO PDF/A-3
    #  pdfaid identification schema -> FX-PDFA3-PART + FX-PDFA3-CONFORMANCE
    "facturx-pdfa3-missing.pdf": lambda: build_facturx_pdf(
        _example5(), include_pdfaid=False),
}


def _read(path):
    with open(path, "rb") as fh:
        return fh.read()


def write_all():
    for name, builder in FIXTURES.items():
        data = builder()
        with open(os.path.join(HERE, name), "wb") as fh:
            fh.write(data)
        print("wrote %s (%d bytes)" % (name, len(data)))


if __name__ == "__main__":
    write_all()
