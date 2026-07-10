#!/usr/bin/env python3
"""Reproducibly build the tiny Factur-X/ZUGFeRD PDF fixtures used by
``einvoice/test_pdf_container.py``.

Standard library only (``zlib``). Each fixture is a *minimal but real* PDF:
a classic cross-reference table, a ``trailer`` with ``/Root``, one blank page,
and — where applicable — a ``/Names`` -> ``/EmbeddedFiles`` name tree wrapping
a corpus CrossIndustryInvoice XML as a ``/FlateDecode`` embedded-file stream
named ``factur-x.xml`` (the Factur-X 1.x attachment name; PDF 32000-1 §7.11.4
+ ISO 19005-3 / Factur-X ``/AFRelationship``).

The embedded payloads are EXISTING corpus invoices so the extracted XML runs the
same rule engine as validating that XML directly:

  * facturx-valid.pdf   wraps corpus CII_example5.xml  (zero fatal findings)
  * facturx-bad.pdf     wraps corpus CII_example6.xml  (multiple BR-DE fatals)
  * no-embedded.pdf     a valid PDF with NO /EmbeddedFiles (unsupported)
  * encrypted.pdf       a PDF whose trailer carries /Encrypt (unsupported)

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


def build_facturx_pdf(xml_bytes, attach_name="factur-x.xml", compress=True):
    """Return the bytes of a minimal hybrid PDF embedding ``xml_bytes``.

    Object layout (contiguous, gen 0):
      1 Catalog  -> /Pages 2, /Names << /EmbeddedFiles 6 >>, /AF [4]
      2 Pages    -> /Kids [3]
      3 Page     (blank A-ish page)
      4 Filespec -> /F,/UF = attach_name, /AFRelationship /Alternative, /EF /F 5
      5 EmbeddedFile stream (FlateDecode by default)
      6 EmbeddedFiles name-tree leaf -> /Names [ (attach_name) 4 0 R ]
    """
    name = attach_name.encode("latin-1")
    catalog = (b"<< /Type /Catalog /Pages 2 0 R "
               b"/Names << /EmbeddedFiles 6 0 R >> /AF [4 0 R] >>")
    pages = b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"
    page = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"
    filespec = (b"<< /Type /Filespec /F (%s) /UF (%s) "
                b"/AFRelationship /Alternative /Desc (Invoice) "
                b"/EF << /F 5 0 R /UF 5 0 R >> >>" % (name, name))
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


FIXTURES = {
    "facturx-valid.pdf": lambda: build_facturx_pdf(
        _read(os.path.join(CORPUS, "CII_example5.xml"))),
    "facturx-bad.pdf": lambda: build_facturx_pdf(
        _read(os.path.join(CORPUS, "CII_example6.xml"))),
    "facturx-valid-uncompressed.pdf": lambda: build_facturx_pdf(
        _read(os.path.join(CORPUS, "CII_example5.xml")), compress=False),
    "no-embedded.pdf": build_plain_pdf,
    "encrypted.pdf": build_encrypted_pdf,
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
