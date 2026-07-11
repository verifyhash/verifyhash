"""XRechnung national CIUS layer (BR-DE-*) on top of the EN 16931 core.

Germany's XRechnung standard (KoSIT, mandated for B2G invoicing by the
E-Rechnungsverordnung) is a CIUS of EN 16931: every EN 16931 rule still
applies, and the national ``BR-DE-*`` business rules are ADDED on top. This
module implements that added layer for UBL *Invoice* documents.

Each rule is a *pure function* over the parsed UBL Invoice **root element**
(``xml.etree.ElementTree.Element``) — not the flattened core model — because
the BR-DE rules address parts of the document (payment means, contact, postal
addresses, attachments, payment terms) that the core model deliberately does
not carry. A rule returns a :class:`Violation` when it fires and ``None`` when
it holds.

Rule semantics are transcribed from the OFFICIAL KoSIT artifact — the
XRechnung Schematron (``corpus/xrechnung-schematron/schematron/ubl/
XRechnung-UBL-validation.sch``, v2.5.0, XRechnung 3.0.2) — assert by assert,
XPath by XPath, and are differential-tested against the compiled official XSLT
by ``differential.py`` (the ``xrechnung`` leg). Where the official XPath and
the prose rule text could be read differently, the XPath wins.

Severity mirrors the official ``flag``: ``fatal`` blocks acceptance,
``warning`` and ``information`` are reported but do not make the document
invalid.

This module also implements the ``BR-DEX-*`` layer — the fourteen business
rules the KoSIT artifact adds for the XRechnung *Extension* customization
(``…#conformant#urn:xeinkauf.de:kosit:extension:xrechnung_3.0``). Those rules
fire ONLY when the document carries the extension ``CustomizationID`` (the
Schematron gates them behind a global ``$isExtension`` let); on a plain CIUS
invoice they are inert. See ``_is_extension`` and the ``BR-DEX-*`` functions.

Out of scope (deliberately): ``BR-DE-CVD-*`` (the Clean-Vehicle-Directive
profile) and ``BR-TMP-2``. The ``PEPPOL-EN16931-R*`` rules also present in the
KoSIT artifact live in their own module, :mod:`einvoice.rules_peppol` (batch 1
implemented, remainder an explicit known-open worklist in the coverage
matrix).

Standard library only.
"""

from __future__ import annotations

import re
from collections import namedtuple
from decimal import Decimal, ROUND_FLOOR, InvalidOperation

Violation = namedtuple("Violation", ["rule_id", "message", "element", "severity"])

# UBL namespaces (same as einvoice.parser).
NS_INVOICE = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
NS_CAC = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
NS_CBC = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
NS = {"ubl": NS_INVOICE, "cac": NS_CAC, "cbc": NS_CBC}

# ---------------------------------------------------------------------------
# Official constants (corpus/xrechnung-schematron/schematron/common.sch)
# ---------------------------------------------------------------------------
XR_MAJOR_MINOR = "3.0"
XR_CIUS_ID = ("urn:cen.eu:en16931:2017#compliant#"
              "urn:xeinkauf.de:kosit:xrechnung_" + XR_MAJOR_MINOR)
XR_EXTENSION_ID = (XR_CIUS_ID + "#conformant#"
                   "urn:xeinkauf.de:kosit:extension:xrechnung_" + XR_MAJOR_MINOR)
XR_CVD_ID = XR_CIUS_ID + "#compliant#urn:xeinkauf.de:kosit:xrechnung:cvd_0.9"

# XPath \s is exactly [ \t\n\r] — Python's \s is wider (unicode), so the
# official character classes are spelled out literally.
_SKONTO_RE = re.compile(
    r"(^|\r?\n)#(SKONTO)#TAGE=([0-9]+#PROZENT=[0-9]+\.[0-9]{2})"
    r"(#BASISBETRAG=-?[0-9]+\.[0-9]{2})?#$")
_SKONTO_TERMINATOR_RE = re.compile(r"^[ \t\n\r]*\n")
_EMAIL_RE = re.compile(r"^[^@ \t\n\r]+@([^@. \t\n\r]+\.)+[^@. \t\n\r]+$")
_TELEPHONE_RE = re.compile(r".*([0-9].*){3,}.*")
_IBAN_SHAPE_RE = re.compile(r"^[A-Z]{2}[0-9]{2}[a-zA-Z0-9]{0,30}$")
_XP_WHITESPACE_RE = re.compile(r"[ \n\r\t]")  # official: replace(., '([ \n\r\t\s])', '')

# BR-DE-17: the codes XRechnung allows for BT-3 (UNTDID 1001 subset).
_XR_TYPE_CODES = ("326", "380", "384", "389", "381", "875", "876", "877")

# BR-DE-16: the VAT category codes that trigger the seller-VAT-id requirement.
_XR_SUPPORTED_VAT_CODES = ("S", "Z", "E", "AE", "K", "G", "L", "M")

# ---------------------------------------------------------------------------
# Extension (BR-DEX-*) code lists — transcribed VERBATIM from common.sch.
# The Schematron tests membership with contains($LIST, concat(' ', code, ' '))
# over a space-delimited string; a set of the split tokens is the exact same
# predicate (every token is space-flanked, and the query is ' <code> ').
# ---------------------------------------------------------------------------
# common.sch: <let name="DIGA-CODES" value="' XR01 XR02 XR03 '" />
_DIGA_CODES = "XR01 XR02 XR03"

# common.sch: <let name="ISO-6523-ICD-CODES" ...> (note the deliberate gaps:
# 0092, 0103, 0181, 0182 are absent in the official list).
_ISO_6523_ICD_CODES = (
    "0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 "
    "0016 0017 0018 0019 0020 0021 0022 0023 0024 0025 0026 0027 0028 0029 "
    "0030 0031 0032 0033 0034 0035 0036 0037 0038 0039 0040 0041 0042 0043 "
    "0044 0045 0046 0047 0048 0049 0050 0051 0052 0053 0054 0055 0056 0057 "
    "0058 0059 0060 0061 0062 0063 0064 0065 0066 0067 0068 0069 0070 0071 "
    "0072 0073 0074 0075 0076 0077 0078 0079 0080 0081 0082 0083 0084 0085 "
    "0086 0087 0088 0089 0090 0091 0093 0094 0095 0096 0097 0098 0099 0100 "
    "0101 0102 0104 0105 0106 0107 0108 0109 0110 0111 0112 0113 0114 0115 "
    "0116 0117 0118 0119 0120 0121 0122 0123 0124 0125 0126 0127 0128 0129 "
    "0130 0131 0132 0133 0134 0135 0136 0137 0138 0139 0140 0141 0142 0143 "
    "0144 0145 0146 0147 0148 0149 0150 0151 0152 0153 0154 0155 0156 0157 "
    "0158 0159 0160 0161 0162 0163 0164 0165 0166 0167 0168 0169 0170 0171 "
    "0172 0173 0174 0175 0176 0177 0178 0179 0180 0183 0184 0185 0186 0187 "
    "0188 0189 0190 0191 0192 0193 0194 0195 0196 0197 0198 0199 0200 0201 "
    "0202 0203 0204 0205 0206 0207 0208 0209 0210 0211 0212 0213 0214 0215 "
    "0216 0217 0218 0219 0220 0221 0222 0223 0224 0225 0226 0227 0228 0229 "
    "0230 0231 0232 0233 0234 0235 0236 0237 0238 0239 0240 0241 0242 0243 "
    "0244")

# common.sch: <let name="CEF-EAS-CODES" ...>
_CEF_EAS_CODES = (
    "0002 0007 0009 0037 0060 0088 0096 0097 0106 0130 0135 0142 0147 0151 "
    "0154 0158 0170 0177 0183 0184 0188 0190 0191 0192 0193 0194 0195 0196 "
    "0198 0199 0200 0201 0202 0203 0204 0205 0208 0209 0210 0211 0212 0213 "
    "0215 0216 0217 0218 0219 0220 0221 0225 0230 0235 0240 0244 9910 9913 "
    "9914 9915 9918 9919 9920 9922 9923 9924 9925 9926 9927 9928 9929 9930 "
    "9931 9932 9933 9934 9935 9936 9937 9938 9939 9940 9941 9942 9943 9944 "
    "9945 9946 9947 9948 9949 9950 9951 9952 9953 9957 9959 AN AQ AS AU EM")

# ISO-6523-ICD-EXT-CODES = concat($DIGA-CODES, $ISO-6523-ICD-CODES)
_ISO_6523_ICD_EXT_CODES = frozenset(
    (_DIGA_CODES + " " + _ISO_6523_ICD_CODES).split())
# CEF-EAS-EXT-CODES = concat($DIGA-CODES, $CEF-EAS-CODES)
_CEF_EAS_EXT_CODES = frozenset(
    (_DIGA_CODES + " " + _CEF_EAS_CODES).split())

# BR-DEX-01: MIME codes an Extension may use for an Attached Document (BT-125).
_XR_EXT_MIME_CODES = frozenset((
    "application/pdf",
    "image/png",
    "image/jpeg",
    "text/csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/xml",
))


# ---------------------------------------------------------------------------
# XPath-faithful helpers
# ---------------------------------------------------------------------------
def _sv(el):
    """XPath string-value of an element (all descendant text, untrimmed);
    None when the element is absent."""
    if el is None:
        return None
    return "".join(el.itertext())


def _nsp(text):
    """XPath normalize-space(): '' for absent, else trim + collapse
    [ \\t\\n\\r] runs. (str.split() splits on a wider class, but XML 1.0
    forbids the extra control characters, so they cannot reach us.)"""
    if text is None:
        return ""
    return " ".join(text.split())


def _has_nonempty(parent, path):
    """exists(<path>[boolean(normalize-space(.))]) relative to parent."""
    return any(_nsp(_sv(e)) for e in parent.findall(path, NS))


def _following_siblings(parent, el):
    kids = list(parent)
    return kids[kids.index(el) + 1:]


def _iban_ok(raw):
    """The official BR-DE-19/20 IBAN test, transcribed exactly:

    IBAN := normalize-space(replace(., '([ \\n\\r\\t\\s])', ''))
    matches(IBAN, '^[A-Z]{2}[0-9]{2}[a-zA-Z0-9]{0,30}$')
    and int(map cp -> (cp>64 ? cp-55 : cp-48) over
            IBAN[5:] + upper(IBAN[1:2]) + IBAN[3:2]) mod 97 = 1

    Note the official map handles LOWERCASE body letters as cp-55 (not a
    standard IBAN digitization); we reproduce that verbatim — the legal
    artifact is ground truth, not the IBAN spec.
    """
    s = _nsp(_XP_WHITESPACE_RE.sub("", raw if raw is not None else ""))
    if not _IBAN_SHAPE_RE.match(s):
        return False
    rearranged = s[4:] + s[:2].upper() + s[2:4]
    digits = "".join(str(ord(c) - 55) if ord(c) > 64 else str(ord(c) - 48)
                     for c in rearranged)
    return int(digits) % 97 == 1


def _rule(rule_id, severity):
    def deco(fn):
        fn.rule_id = rule_id
        fn.severity = severity
        return fn
    return deco


def _v(fn, message, element):
    return Violation(fn.rule_id, message, element, fn.severity)


# ---------------------------------------------------------------------------
# Extension (BR-DEX-*) helpers
# ---------------------------------------------------------------------------
def _is_extension(root):
    """The Schematron ``$isExtension`` let (ubl-extension-pattern): true iff a
    cbc:CustomizationID has the EXACT extension string value (untrimmed). All
    BR-DEX-* rules are gated behind this — on a plain CIUS invoice the extension
    contexts never match, so the rules are inert."""
    return any(_sv(e) == XR_EXTENSION_ID
               for e in root.findall("cbc:CustomizationID", NS))


def _dec(text):
    """xs:decimal(<string>): exact decimal, or None when it cannot be parsed
    (in the official transform a bad xs:decimal is a dynamic error that aborts
    the whole run, so such invoices are excluded from the differential; we
    return None and let the caller treat the row as non-comparable/failed)."""
    if text is None:
        return None
    try:
        return Decimal(text.strip())
    except (InvalidOperation, ValueError):
        return None


def _xpath_round(x):
    """fn:round(): nearest integer, halves toward POSITIVE infinity
    (floor(x + 0.5)) — NOT banker's/away-from-zero rounding."""
    return (x + Decimal("0.5")).to_integral_value(rounding=ROUND_FLOOR)


def _parent_map(root):
    return {c: p for p in root.iter() for c in p}


def _ancestor_localnames(root, el, pmap=None):
    """Set of local element names on the ancestor axis of ``el`` (for the
    XPath ``ancestor::cac:Foo`` tests)."""
    pmap = pmap if pmap is not None else _parent_map(root)
    names = set()
    cur = pmap.get(el)
    while cur is not None:
        names.add(cur.tag.rsplit("}", 1)[-1])
        cur = pmap.get(cur)
    return names


def _scheme_no_internal_space(schemeid):
    """not(contains(normalize-space(@schemeID), ' ')) — false when the
    normalized scheme identifier still holds an internal space."""
    return " " not in _nsp(schemeid)


# ---------------------------------------------------------------------------
# Document level (context /ubl:Invoice)
# ---------------------------------------------------------------------------
@_rule("BR-DE-1", "fatal")
def br_de_1(root):
    """BR-DE-1: An invoice must contain PAYMENT INSTRUCTIONS (BG-16)."""
    if root.find("cac:PaymentMeans", NS) is None:
        return _v(br_de_1, "An invoice (INVOICE) must contain information on "
                  "PAYMENT INSTRUCTIONS (BG-16).", "cac:PaymentMeans")
    return None


@_rule("BR-DE-15", "fatal")
def br_de_15(root):
    """BR-DE-15: Buyer reference (BT-10) must be transmitted (non-empty)."""
    if not _has_nonempty(root, "cbc:BuyerReference"):
        return _v(br_de_15, "The element 'Buyer reference' (BT-10) must be "
                  "transmitted.", "cbc:BuyerReference")
    return None


@_rule("BR-DE-16", "fatal")
def br_de_16(root):
    """BR-DE-16: If VAT category codes S/Z/E/AE/K/G/L/M are used, one of
    Seller VAT identifier (BT-31), Seller tax registration identifier (BT-32)
    or SELLER TAX REPRESENTATIVE PARTY (BG-11) must be present.

    Official value sets (string-value equality, untrimmed):
      * BT-95 (Invoice variant): document-level AllowanceCharge TaxCategory IDs
        with ChargeIndicator = 'false' AND a following-sibling VAT TaxScheme;
      * BT-95 (CreditNote variant, also evaluated for Invoices): same without
        the VAT-scheme filter;
      * BT-102: TaxCategory IDs with ChargeIndicator = 'true';
      * BT-151: (InvoiceLine|CreditNoteLine)/Item/ClassifiedTaxCategory IDs.
    """
    used = []
    for ac in root.findall("cac:AllowanceCharge", NS):
        indicators = [_sv(ci) for ci in ac.findall("cbc:ChargeIndicator", NS)]
        ind_false = "false" in indicators
        ind_true = "true" in indicators
        if not (ind_false or ind_true):
            continue
        for cat in ac.findall("cac:TaxCategory", NS):
            for id_el in cat.findall("cbc:ID", NS):
                if ind_true:                      # BT-102
                    used.append(_sv(id_el))
                if ind_false:                     # BT-95, CN variant
                    used.append(_sv(id_el))
                    # BT-95, Invoice variant (VAT-scheme-filtered) is a
                    # subset of the CN variant, kept for transcription
                    # fidelity:
                    if any(_sv(sid) == "VAT"
                           for sib in _following_siblings(cat, id_el)
                           if sib.tag == "{%s}TaxScheme" % NS_CAC
                           for sid in sib.findall("cbc:ID", NS)):
                        used.append(_sv(id_el))
    for id_el in root.findall(
            "cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory/cbc:ID", NS):
        used.append(_sv(id_el))                   # BT-151
    for id_el in root.findall(
            "cac:CreditNoteLine/cac:Item/cac:ClassifiedTaxCategory/cbc:ID", NS):
        used.append(_sv(id_el))

    if not any(code in _XR_SUPPORTED_VAT_CODES for code in used):
        return None
    has_tax_representative = root.find("cac:TaxRepresentativeParty", NS) is not None
    has_seller_tax_id = _has_nonempty(
        root, "cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID")
    if has_tax_representative or has_seller_tax_id:
        return None
    return _v(br_de_16, "VAT category codes S, Z, E, AE, K, G, L or M are "
              "used, so at least one of 'Seller VAT identifier' (BT-31), "
              "'Seller tax registration identifier' (BT-32) or 'SELLER TAX "
              "REPRESENTATIVE PARTY' (BG-11) must be transmitted.",
              "cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID")


@_rule("BR-DE-17", "warning")
def br_de_17(root):
    """BR-DE-17: BT-3 should be one of 326, 380, 384, 389, 381, 875, 876, 877.

    Official test is over normalize-space(cbc:InvoiceTypeCode) — an ABSENT
    type code normalizes to '' and therefore also fires.
    """
    itc = _nsp(_sv(root.find("cbc:InvoiceTypeCode", NS)))
    cnc = _nsp(_sv(root.find("cbc:CreditNoteTypeCode", NS)))
    if itc in _XR_TYPE_CODES or cnc in _XR_TYPE_CODES:
        return None
    return _v(br_de_17, "'Invoice type code' (BT-3) should be one of the "
              "codes 326, 380, 384, 389, 381, 875, 876, 877 (UNTDID 1001 "
              "subset); found %r." % (itc or "(absent)"),
              "cbc:InvoiceTypeCode")


@_rule("BR-DE-18", "fatal")
def br_de_18(root):
    """BR-DE-18: Skonto (cash-discount) lines in Payment terms (BT-20).

    Official test (context /ubl:Invoice), over cac:PaymentTerms/cbc:Note[1]:

        every $line in tokenize(., '(\\r?\\n)')[starts-with(normalize-space(.), '#')]
        satisfies matches(normalize-space($line), $XR-SKONTO-REGEX)
              and matches(tokenize(., '#.+#')[last()], '^\\s*\\n')

    Only lines that start with '#' (after normalize-space) are constrained; a
    document without such lines holds vacuously. When they exist, each must
    match the SKONTO grammar AND the note must end each entry with a newline
    after the final '#'. With MORE than one cac:PaymentTerms/cbc:Note[1] node
    the official matches() call is a dynamic error (the whole official
    transform aborts); we deterministically FIRE in that unreachable-for-
    comparison corner.
    """
    notes = [_sv(pt.find("cbc:Note", NS))
             for pt in root.findall("cac:PaymentTerms", NS)
             if pt.find("cbc:Note", NS) is not None]
    skonto_lines = [line
                    for note in notes
                    for line in re.split(r"\r?\n", note)
                    if _nsp(line).startswith("#")]
    if not skonto_lines:
        return None
    holds = all(_SKONTO_RE.search(_nsp(line)) for line in skonto_lines)
    if holds:
        if len(notes) != 1:
            holds = False
        else:
            last_token = re.split(r"#.+#", notes[0])[-1]
            holds = bool(_SKONTO_TERMINATOR_RE.search(last_token))
    if holds:
        return None
    return _v(br_de_18, "Skonto entries in 'Payment terms' (BT-20) must "
              "follow the XRechnung grammar #SKONTO#TAGE=n#PROZENT=n.nn#"
              "[BASISBETRAG=n.nn#] with a newline terminating each entry.",
              "cac:PaymentTerms/cbc:Note")


@_rule("BR-DE-21", "warning")
def br_de_21(root):
    """BR-DE-21: BT-24 should be the XRechnung specification identifier
    (CIUS, extension or CVD variant) — untrimmed string equality."""
    ids = [_sv(e) for e in root.findall("cbc:CustomizationID", NS)]
    if any(i in (XR_CIUS_ID, XR_EXTENSION_ID, XR_CVD_ID) for i in ids):
        return None
    return _v(br_de_21, "'Specification identifier' (BT-24) should "
              "syntactically match the XRechnung standard identifier.",
              "cbc:CustomizationID")


@_rule("BR-DE-22", "fatal")
def br_de_22(root):
    """BR-DE-22: the filename attribute of all EmbeddedDocumentBinaryObject
    elements must be unique (across cac:AdditionalDocumentReference)."""
    seen = []
    for adr in root.findall("cac:AdditionalDocumentReference", NS):
        filenames = [obj.get("filename")
                     for obj in adr.findall(
                         "cac:Attachment/cbc:EmbeddedDocumentBinaryObject", NS)
                     if obj.get("filename") is not None]
        for fn in filenames:
            if fn in seen:
                return _v(br_de_22, "The 'filename' attribute of all "
                          "'EmbeddedDocumentBinaryObject' elements must be "
                          "unique; %r repeats." % fn,
                          "cac:AdditionalDocumentReference/cac:Attachment/"
                          "cbc:EmbeddedDocumentBinaryObject/@filename")
        seen.extend(filenames)
    return None


@_rule("BR-DE-26", "warning")
def br_de_26(root):
    """BR-DE-26: type code 384 (Corrected invoice) should carry a PRECEDING
    INVOICE REFERENCE (BG-3)."""
    itc = _nsp(_sv(root.find("cbc:InvoiceTypeCode", NS)))
    cnc = _nsp(_sv(root.find("cbc:CreditNoteTypeCode", NS)))
    if itc != "384" and cnc != "384":
        return None
    if root.find("cac:BillingReference/cac:InvoiceDocumentReference", NS) is not None:
        return None
    return _v(br_de_26, "'Invoice type code' (BT-3) is 384 (Corrected "
              "invoice), so PRECEDING INVOICE REFERENCE (BG-3) should be "
              "present at least once.",
              "cac:BillingReference/cac:InvoiceDocumentReference")


@_rule("BR-DE-30", "fatal")
def br_de_30(root):
    """BR-DE-30: DIRECT DEBIT (BG-19) requires the Bank assigned creditor
    identifier (BT-90: a SEPA-scheme PartyIdentification of the seller or
    payee)."""
    if root.find("cac:PaymentMeans/cac:PaymentMandate", NS) is None:
        return None
    sepa_ids = [e for e in root.findall(
                    "cac:AccountingSupplierParty/cac:Party/"
                    "cac:PartyIdentification/cbc:ID", NS)
                if e.get("schemeID") == "SEPA"]
    sepa_ids += [e for e in root.findall(
                     "cac:PayeeParty/cac:PartyIdentification/cbc:ID", NS)
                 if e.get("schemeID") == "SEPA"]
    if sepa_ids:
        return None
    return _v(br_de_30, "DIRECT DEBIT (BG-19) is present, so 'Bank assigned "
              "creditor identifier' (BT-90) must be transmitted.",
              "cac:PartyIdentification/cbc:ID[@schemeID='SEPA']")


@_rule("BR-DE-31", "fatal")
def br_de_31(root):
    """BR-DE-31: DIRECT DEBIT (BG-19) requires the Debited account identifier
    (BT-91)."""
    if root.find("cac:PaymentMeans/cac:PaymentMandate", NS) is None:
        return None
    if root.find("cac:PaymentMeans/cac:PaymentMandate/"
                 "cac:PayerFinancialAccount/cbc:ID", NS) is not None:
        return None
    return _v(br_de_31, "DIRECT DEBIT (BG-19) is present, so 'Debited account "
              "identifier' (BT-91) must be transmitted.",
              "cac:PaymentMeans/cac:PaymentMandate/cac:PayerFinancialAccount/cbc:ID")


@_rule("BR-DE-TMP-32", "information")
def br_de_tmp_32(root):
    """BR-DE-TMP-32: an invoice should state the delivery/service date via
    BT-72 (Actual delivery date), BG-14 (Invoicing period) or a BG-26
    (Invoice line period) on EVERY line."""
    if root.find("cac:Delivery/cbc:ActualDeliveryDate", NS) is not None:
        return None
    if root.findall("cac:InvoicePeriod", NS):
        return None
    lines = (root.findall("cac:InvoiceLine", NS)
             + root.findall("cac:CreditNoteLine", NS))
    if all(ln.find("cac:InvoicePeriod", NS) is not None for ln in lines):
        return None  # vacuously true for zero lines, like the official 'every'
    return _v(br_de_tmp_32, "The invoice should state the delivery/service "
              "date: BT-72 'Actual delivery date', BG-14 'Invoicing period', "
              "or BG-26 'Invoice line period' on every line.",
              "cac:Delivery/cbc:ActualDeliveryDate")


# ---------------------------------------------------------------------------
# Seller / buyer / delivery details
# ---------------------------------------------------------------------------
@_rule("BR-DE-2", "fatal")
def br_de_2(root):
    """BR-DE-2: SELLER CONTACT (BG-6) must be transmitted."""
    asp = root.find("cac:AccountingSupplierParty", NS)
    if asp is None:
        return None  # context node absent -> rule never evaluated
    if asp.find("cac:Party/cac:Contact", NS) is None:
        return _v(br_de_2, "The group 'SELLER CONTACT' (BG-6) must be "
                  "transmitted.",
                  "cac:AccountingSupplierParty/cac:Party/cac:Contact")
    return None


@_rule("BR-DE-3", "fatal")
def br_de_3(root):
    """BR-DE-3: Seller city (BT-37) must be transmitted (non-empty)."""
    for addr in root.findall(
            "cac:AccountingSupplierParty/cac:Party/cac:PostalAddress", NS):
        if not _has_nonempty(addr, "cbc:CityName"):
            return _v(br_de_3, "The element 'Seller city' (BT-37) must be "
                      "transmitted.",
                      "cac:AccountingSupplierParty/cac:Party/cac:PostalAddress/"
                      "cbc:CityName")
    return None


@_rule("BR-DE-4", "fatal")
def br_de_4(root):
    """BR-DE-4: Seller post code (BT-38) must be transmitted (non-empty)."""
    for addr in root.findall(
            "cac:AccountingSupplierParty/cac:Party/cac:PostalAddress", NS):
        if not _has_nonempty(addr, "cbc:PostalZone"):
            return _v(br_de_4, "The element 'Seller post code' (BT-38) must "
                      "be transmitted.",
                      "cac:AccountingSupplierParty/cac:Party/cac:PostalAddress/"
                      "cbc:PostalZone")
    return None


def _seller_contacts(root):
    return root.findall("cac:AccountingSupplierParty/cac:Party/cac:Contact", NS)


@_rule("BR-DE-5", "fatal")
def br_de_5(root):
    """BR-DE-5: Seller contact point (BT-41) must be transmitted (non-empty)."""
    for contact in _seller_contacts(root):
        if not _has_nonempty(contact, "cbc:Name"):
            return _v(br_de_5, "The element 'Seller contact point' (BT-41) "
                      "must be transmitted.",
                      "cac:AccountingSupplierParty/cac:Party/cac:Contact/cbc:Name")
    return None


@_rule("BR-DE-6", "fatal")
def br_de_6(root):
    """BR-DE-6: Seller contact telephone number (BT-42) must be transmitted."""
    for contact in _seller_contacts(root):
        if not _has_nonempty(contact, "cbc:Telephone"):
            return _v(br_de_6, "The element 'Seller contact telephone number' "
                      "(BT-42) must be transmitted.",
                      "cac:AccountingSupplierParty/cac:Party/cac:Contact/"
                      "cbc:Telephone")
    return None


@_rule("BR-DE-7", "fatal")
def br_de_7(root):
    """BR-DE-7: Seller contact email address (BT-43) must be transmitted."""
    for contact in _seller_contacts(root):
        if not _has_nonempty(contact, "cbc:ElectronicMail"):
            return _v(br_de_7, "The element 'Seller contact email address' "
                      "(BT-43) must be transmitted.",
                      "cac:AccountingSupplierParty/cac:Party/cac:Contact/"
                      "cbc:ElectronicMail")
    return None


@_rule("BR-DE-27", "warning")
def br_de_27(root):
    """BR-DE-27: BT-42 should contain at least three digits. Evaluated per
    seller Contact; an ABSENT telephone normalizes to '' and fires too."""
    for contact in _seller_contacts(root):
        tel = _nsp(_sv(contact.find("cbc:Telephone", NS)))
        if not _TELEPHONE_RE.search(tel):
            return _v(br_de_27, "'Seller contact telephone number' (BT-42) "
                      "should contain at least three digits.",
                      "cac:AccountingSupplierParty/cac:Party/cac:Contact/"
                      "cbc:Telephone")
    return None


@_rule("BR-DE-28", "warning")
def br_de_28(root):
    """BR-DE-28: BT-43 should look like an email address (exactly one '@',
    flanked per the official regex)."""
    for contact in _seller_contacts(root):
        mail = _nsp(_sv(contact.find("cbc:ElectronicMail", NS)))
        if not _EMAIL_RE.search(mail):
            return _v(br_de_28, "'Seller contact email address' (BT-43) "
                      "should contain exactly one '@' with valid flanking "
                      "characters.",
                      "cac:AccountingSupplierParty/cac:Party/cac:Contact/"
                      "cbc:ElectronicMail")
    return None


@_rule("BR-DE-8", "fatal")
def br_de_8(root):
    """BR-DE-8: Buyer city (BT-52) must be transmitted (non-empty)."""
    for addr in root.findall(
            "cac:AccountingCustomerParty/cac:Party/cac:PostalAddress", NS):
        if not _has_nonempty(addr, "cbc:CityName"):
            return _v(br_de_8, "The element 'Buyer city' (BT-52) must be "
                      "transmitted.",
                      "cac:AccountingCustomerParty/cac:Party/cac:PostalAddress/"
                      "cbc:CityName")
    return None


@_rule("BR-DE-9", "fatal")
def br_de_9(root):
    """BR-DE-9: Buyer post code (BT-53) must be transmitted (non-empty)."""
    for addr in root.findall(
            "cac:AccountingCustomerParty/cac:Party/cac:PostalAddress", NS):
        if not _has_nonempty(addr, "cbc:PostalZone"):
            return _v(br_de_9, "The element 'Buyer post code' (BT-53) must be "
                      "transmitted.",
                      "cac:AccountingCustomerParty/cac:Party/cac:PostalAddress/"
                      "cbc:PostalZone")
    return None


@_rule("BR-DE-10", "fatal")
def br_de_10(root):
    """BR-DE-10: Deliver to city (BT-77) must be transmitted when DELIVER TO
    ADDRESS (BG-15) is present."""
    for addr in root.findall("cac:Delivery/cac:DeliveryLocation/cac:Address", NS):
        if not _has_nonempty(addr, "cbc:CityName"):
            return _v(br_de_10, "The element 'Deliver to city' (BT-77) must "
                      "be transmitted when DELIVER TO ADDRESS (BG-15) is "
                      "present.",
                      "cac:Delivery/cac:DeliveryLocation/cac:Address/cbc:CityName")
    return None


@_rule("BR-DE-11", "fatal")
def br_de_11(root):
    """BR-DE-11: Deliver to post code (BT-78) must be transmitted when
    DELIVER TO ADDRESS (BG-15) is present."""
    for addr in root.findall("cac:Delivery/cac:DeliveryLocation/cac:Address", NS):
        if not _has_nonempty(addr, "cbc:PostalZone"):
            return _v(br_de_11, "The element 'Deliver to post code' (BT-78) "
                      "must be transmitted when DELIVER TO ADDRESS (BG-15) is "
                      "present.",
                      "cac:Delivery/cac:DeliveryLocation/cac:Address/cbc:PostalZone")
    return None


# ---------------------------------------------------------------------------
# VAT breakdown (context /ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal)
# ---------------------------------------------------------------------------
@_rule("BR-DE-14", "fatal")
def br_de_14(root):
    """BR-DE-14: VAT category rate (BT-119) must be transmitted (non-empty)
    in every top-level VAT breakdown row."""
    for st in root.findall("cac:TaxTotal/cac:TaxSubtotal", NS):
        if not _has_nonempty(st, "cac:TaxCategory/cbc:Percent"):
            return _v(br_de_14, "The element 'VAT category rate' (BT-119) "
                      "must be transmitted.",
                      "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:Percent")
    return None


# ---------------------------------------------------------------------------
# Payment means (contexts keyed on normalize-space(cbc:PaymentMeansCode))
# ---------------------------------------------------------------------------
def _payment_means(root):
    for pm in root.findall("cac:PaymentMeans", NS):
        yield pm, _nsp(_sv(pm.find("cbc:PaymentMeansCode", NS)))


@_rule("BR-DE-19", "warning")
def br_de_19(root):
    """BR-DE-19: with payment means code 58 (SEPA credit transfer), BT-84
    should be a correct IBAN (official regex + mod-97 transcription)."""
    for pm, code in _payment_means(root):
        if code not in ("30", "58"):
            continue
        if code != "58":
            continue  # not(... = '58') -> assert holds for code 30
        raw = _sv(pm.find("cac:PayeeFinancialAccount/cbc:ID", NS))
        if not _iban_ok(raw):
            return _v(br_de_19, "'Payment account identifier' (BT-84) should "
                      "be a correct IBAN when 'Payment means type code' "
                      "(BT-81) is 58 (SEPA).",
                      "cac:PaymentMeans/cac:PayeeFinancialAccount/cbc:ID")
    return None


@_rule("BR-DE-20", "warning")
def br_de_20(root):
    """BR-DE-20: with payment means code 59 (SEPA direct debit), BT-91 should
    be a correct IBAN."""
    for pm, code in _payment_means(root):
        if code != "59":
            continue
        raw = _sv(pm.find("cac:PaymentMandate/cac:PayerFinancialAccount/cbc:ID", NS))
        if not _iban_ok(raw):
            return _v(br_de_20, "'Debited account identifier' (BT-91) should "
                      "be a correct IBAN when 'Payment means type code' "
                      "(BT-81) is 59 (SEPA direct debit).",
                      "cac:PaymentMeans/cac:PaymentMandate/"
                      "cac:PayerFinancialAccount/cbc:ID")
    return None


@_rule("BR-DE-23-a", "fatal")
def br_de_23_a(root):
    """BR-DE-23-a: codes 30/58 (credit transfer) require CREDIT TRANSFER
    (BG-17)."""
    for pm, code in _payment_means(root):
        if code in ("30", "58") and pm.find("cac:PayeeFinancialAccount", NS) is None:
            return _v(br_de_23_a, "'Payment means type code' (BT-81) is a "
                      "credit-transfer code (30, 58), so CREDIT TRANSFER "
                      "(BG-17) must be transmitted.",
                      "cac:PaymentMeans/cac:PayeeFinancialAccount")
    return None


@_rule("BR-DE-23-b", "fatal")
def br_de_23_b(root):
    """BR-DE-23-b: codes 30/58 forbid PAYMENT CARD (BG-18) and DIRECT DEBIT
    (BG-19)."""
    for pm, code in _payment_means(root):
        if code in ("30", "58") and (
                pm.find("cac:CardAccount", NS) is not None
                or pm.find("cac:PaymentMandate", NS) is not None):
            return _v(br_de_23_b, "'Payment means type code' (BT-81) is a "
                      "credit-transfer code (30, 58), so BG-18 and BG-19 must "
                      "not be transmitted.",
                      "cac:PaymentMeans/cac:CardAccount | "
                      "cac:PaymentMeans/cac:PaymentMandate")
    return None


@_rule("BR-DE-24-a", "fatal")
def br_de_24_a(root):
    """BR-DE-24-a: codes 48/54/55 (card) require PAYMENT CARD INFORMATION
    (BG-18)."""
    for pm, code in _payment_means(root):
        if code in ("48", "54", "55") and pm.find("cac:CardAccount", NS) is None:
            return _v(br_de_24_a, "'Payment means type code' (BT-81) is a "
                      "card-payment code (48, 54, 55), so PAYMENT CARD "
                      "INFORMATION (BG-18) must be transmitted.",
                      "cac:PaymentMeans/cac:CardAccount")
    return None


@_rule("BR-DE-24-b", "fatal")
def br_de_24_b(root):
    """BR-DE-24-b: codes 48/54/55 forbid CREDIT TRANSFER (BG-17) and DIRECT
    DEBIT (BG-19)."""
    for pm, code in _payment_means(root):
        if code in ("48", "54", "55") and (
                pm.find("cac:PayeeFinancialAccount", NS) is not None
                or pm.find("cac:PaymentMandate", NS) is not None):
            return _v(br_de_24_b, "'Payment means type code' (BT-81) is a "
                      "card-payment code (48, 54, 55), so BG-17 and BG-19 "
                      "must not be transmitted.",
                      "cac:PaymentMeans/cac:PayeeFinancialAccount | "
                      "cac:PaymentMeans/cac:PaymentMandate")
    return None


@_rule("BR-DE-25-a", "fatal")
def br_de_25_a(root):
    """BR-DE-25-a: code 59 (direct debit) requires DIRECT DEBIT (BG-19)."""
    for pm, code in _payment_means(root):
        if code == "59" and pm.find("cac:PaymentMandate", NS) is None:
            return _v(br_de_25_a, "'Payment means type code' (BT-81) is the "
                      "direct-debit code (59), so DIRECT DEBIT (BG-19) must "
                      "be transmitted.",
                      "cac:PaymentMeans/cac:PaymentMandate")
    return None


@_rule("BR-DE-25-b", "fatal")
def br_de_25_b(root):
    """BR-DE-25-b: code 59 forbids CREDIT TRANSFER (BG-17) and PAYMENT CARD
    (BG-18)."""
    for pm, code in _payment_means(root):
        if code == "59" and (
                pm.find("cac:PayeeFinancialAccount", NS) is not None
                or pm.find("cac:CardAccount", NS) is not None):
            return _v(br_de_25_b, "'Payment means type code' (BT-81) is the "
                      "direct-debit code (59), so BG-17 and BG-18 must not be "
                      "transmitted.",
                      "cac:PaymentMeans/cac:PayeeFinancialAccount | "
                      "cac:PaymentMeans/cac:CardAccount")
    return None


# ---------------------------------------------------------------------------
# XRechnung EXTENSION layer (BR-DEX-*), context gated behind $isExtension.
# Transcribed from XRechnung-UBL-validation.sch, pattern "ubl-extension-pattern".
# ---------------------------------------------------------------------------
def _prepaid_payments(root):
    """context /ubl:Invoice/cac:PrepaidPayment — the THIRD PARTY PAYMENT groups
    (BG-DEX-09), direct children of the Invoice."""
    return root.findall("cac:PrepaidPayment", NS)


@_rule("BR-DEX-01", "fatal")
def br_dex_1(root):
    """BR-DEX-01: every 'Attached Document' binary object (BT-125) must use an
    Extension-allowed MIME code. Context is cbc:EmbeddedDocumentBinaryObject
    anywhere in the document; the extra allowance over EN 8.2 is
    application/xml. An absent @mimeCode also fires (empty node-set)."""
    if not _is_extension(root):
        return None
    for obj in root.iter("{%s}EmbeddedDocumentBinaryObject" % NS_CBC):
        if obj.get("mimeCode") not in _XR_EXT_MIME_CODES:
            return _v(br_dex_1, "The 'Attached Document' (BT-125) uses a MIME "
                      "code that an XRechnung Extension does not permit: %r."
                      % (obj.get("mimeCode"),),
                      "cbc:EmbeddedDocumentBinaryObject/@mimeCode")
    return None


@_rule("BR-DEX-02", "warning")
def br_dex_2(root):
    """BR-DEX-02: the 'Invoice line net amount' (BT-131) of an INVOICE LINE
    (BG-25) or a SUB INVOICE LINE (BG-DEX-01) should equal the sum of the
    directly nested SUB INVOICE LINEs' net amounts.

    Two official conjuncts: (1) every top-level InvoiceLine that HAS sub-lines
    must equal the sum of its direct sub-lines; (2) every SubInvoiceLine (at any
    depth) that itself HAS sub-lines must equal the sum of ITS direct
    sub-lines."""
    if not _is_extension(root):
        return None

    def _sub_sum(node):
        total = Decimal(0)
        for sub in node.findall("cac:SubInvoiceLine", NS):
            d = _dec(_sv(sub.find("cbc:LineExtensionAmount", NS)))
            if d is None:
                return None
            total += d
        return total

    for il in root.findall("cac:InvoiceLine", NS):
        subs = il.findall("cac:SubInvoiceLine", NS)
        if not subs:
            continue
        own = _dec(_sv(il.find("cbc:LineExtensionAmount", NS)))
        s = _sub_sum(il)
        if own is None or s is None or own != s:
            return _v(br_dex_2, "The 'Invoice line net amount' (BT-131) should "
                      "equal the sum of the directly nested SUB INVOICE LINE "
                      "net amounts.",
                      "cac:InvoiceLine/cbc:LineExtensionAmount")
    for sub in root.iter("{%s}SubInvoiceLine" % NS_CAC):
        if not sub.findall("cac:SubInvoiceLine", NS):
            continue
        own = _dec(_sv(sub.find("cbc:LineExtensionAmount", NS)))
        s = _sub_sum(sub)
        if own is None or s is None or own != s:
            return _v(br_dex_2, "The 'Invoice line net amount' (BT-131) of a "
                      "SUB INVOICE LINE should equal the sum of the directly "
                      "nested SUB INVOICE LINE net amounts.",
                      "cac:SubInvoiceLine/cbc:LineExtensionAmount")
    return None


@_rule("BR-DEX-03", "fatal")
def br_dex_3(root):
    """BR-DEX-03: a SUB INVOICE LINE (BG-DEX-01) must carry exactly one SUB
    INVOICE LINE VAT INFORMATION (BG-DEX-06) — i.e. its Item must have exactly
    one cac:ClassifiedTaxCategory. Fires if any sub-line item has 0 or >1."""
    if not _is_extension(root):
        return None
    for sub in root.iter("{%s}SubInvoiceLine" % NS_CAC):
        for item in sub.findall("cac:Item", NS):
            if len(item.findall("cac:ClassifiedTaxCategory", NS)) != 1:
                return _v(br_dex_3, "A SUB INVOICE LINE (BG-DEX-01) must contain "
                          "exactly one SUB INVOICE LINE VAT INFORMATION "
                          "(BG-DEX-06).",
                          "cac:SubInvoiceLine/cac:Item/cac:ClassifiedTaxCategory")
    return None


@_rule("BR-DEX-09", "fatal")
def br_dex_9(root):
    """BR-DEX-09: Amount due for payment (BT-115) = Invoice total amount with
    VAT (BT-112) - Paid amount (BT-113) + Rounding amount (BT-114)
    + Σ Third party payment amount (BT-DEX-002).

    Context cac:LegalMonetaryTotal; both sides rounded to 2 decimals with
    fn:round(x*100) div 100. The third-party sum is taken from the sibling
    cac:PrepaidPayment/cbc:PaidAmount values (0 when none are present)."""
    if not _is_extension(root):
        return None
    for lmt in root.findall("cac:LegalMonetaryTotal", NS):
        payable = _dec(_sv(lmt.find("cbc:PayableAmount", NS)))
        if payable is None:
            continue
        prepaid = _dec(_sv(lmt.find("cbc:PrepaidAmount", NS)))
        prepaid = prepaid if prepaid is not None else Decimal(0)
        rounding = _dec(_sv(lmt.find("cbc:PayableRoundingAmount", NS)))
        rounding = rounding if rounding is not None else Decimal(0)
        taxincl = _dec(_sv(lmt.find("cbc:TaxInclusiveAmount", NS)))
        if taxincl is None:
            continue
        # thirdpartyprepaidamount: sum of sibling PrepaidPayment PaidAmounts
        # when at least one non-empty PaidAmount exists, else 0.
        paid_nodes = [pp.find("cbc:PaidAmount", NS)
                      for pp in root.findall("cac:PrepaidPayment", NS)]
        paid_vals = [_sv(n) for n in paid_nodes if n is not None]
        if any(_nsp(v) for v in paid_vals):
            third = Decimal(0)
            for v in paid_vals:
                d = _dec(v)
                if d is None:
                    third = None
                    break
                third += d
        else:
            third = Decimal(0)
        if third is None:
            continue
        lhs = _xpath_round((payable - rounding) * 100)
        rhs = _xpath_round((taxincl - prepaid + third) * 100)
        if lhs != rhs:
            return _v(br_dex_9, "'Amount due for payment' (BT-115) must equal "
                      "Invoice total with VAT (BT-112) - Paid amount (BT-113) "
                      "+ Rounding amount (BT-114) + Σ Third party payment "
                      "amount (BT-DEX-002).",
                      "cac:LegalMonetaryTotal/cbc:PayableAmount")
    return None


def _scheme_targets(root, parent_ns, parent_ln, child_ln):
    """The cbc elements a BR-DEX-04..08 context selects. When ``parent_ln`` is
    the element itself (EndpointID) ``child_ln`` is None; otherwise iterate the
    named parent elements and take their cbc:<child_ln> children."""
    if child_ln is None:
        yield from root.iter("{%s}%s" % (parent_ns, parent_ln))
        return
    for parent in root.iter("{%s}%s" % (parent_ns, parent_ln)):
        yield from parent.findall("cbc:%s" % child_ln, NS)


def _scheme_rule(fn, root, targets, code_set, allow_sepa, message, element):
    """Shared BR-DEX-04..08 body: for each context element that carries a
    @schemeID, the normalized scheme id must have no internal space AND be a
    member of ``code_set`` (or 'SEPA' under Seller/Payee when allowed)."""
    if not _is_extension(root):
        return None
    pmap = _parent_map(root)
    for el in targets:
        scheme = el.get("schemeID")
        if scheme is None:
            continue
        nsp_scheme = _nsp(scheme)
        no_space = _scheme_no_internal_space(scheme)
        ok = no_space and nsp_scheme in code_set
        if not ok and allow_sepa and no_space and nsp_scheme == "SEPA":
            anc = _ancestor_localnames(root, el, pmap)
            ok = "AccountingSupplierParty" in anc or "PayeeParty" in anc
        if not ok:
            return _v(fn, message, element)
    return None


@_rule("BR-DEX-04", "fatal")
def br_dex_4(root):
    """BR-DEX-04: any scheme identifier on a Party identifier (cac:Party
    Identification/cbc:ID) must be an ISO 6523 ICD (extension) code — or 'SEPA'
    when the identifier belongs to the Seller or the Payee."""
    return _scheme_rule(
        br_dex_4, root,
        _scheme_targets(root, NS_CAC, "PartyIdentification", "ID"),
        _ISO_6523_ICD_EXT_CODES, allow_sepa=True,
        message="Any scheme identifier on a Party identification (BT-29/BT-46/"
                "BT-60) must be coded with an ISO 6523 ICD code (or 'SEPA' for "
                "the Seller/Payee creditor identifier).",
        element="cac:PartyIdentification/cbc:ID/@schemeID")


@_rule("BR-DEX-05", "fatal")
def br_dex_5(root):
    """BR-DEX-05: any scheme identifier on a legal registration identifier
    (cac:PartyLegalEntity/cbc:CompanyID, BT-30/BT-47) must be an ISO 6523 ICD
    (extension) code."""
    return _scheme_rule(
        br_dex_5, root,
        _scheme_targets(root, NS_CAC, "PartyLegalEntity", "CompanyID"),
        _ISO_6523_ICD_EXT_CODES, allow_sepa=False,
        message="Any scheme identifier on a legal registration identifier "
                "(BT-30/BT-47) must be coded with an ISO 6523 ICD code.",
        element="cac:PartyLegalEntity/cbc:CompanyID/@schemeID")


@_rule("BR-DEX-06", "fatal")
def br_dex_6(root):
    """BR-DEX-06: any scheme identifier on an item standard identifier
    (cac:StandardItemIdentification/cbc:ID, BT-157) must be an ISO 6523 ICD
    (extension) code."""
    return _scheme_rule(
        br_dex_6, root,
        _scheme_targets(root, NS_CAC, "StandardItemIdentification", "ID"),
        _ISO_6523_ICD_EXT_CODES, allow_sepa=False,
        message="Any scheme identifier on an 'Item standard identifier' "
                "(BT-157) must be coded with an ISO 6523 ICD code.",
        element="cac:StandardItemIdentification/cbc:ID/@schemeID")


@_rule("BR-DEX-07", "fatal")
def br_dex_7(root):
    """BR-DEX-07: any scheme identifier on an Endpoint identifier (cbc:Endpoint
    ID, BT-34/BT-49) must belong to the CEF EAS (extension) code list."""
    return _scheme_rule(
        br_dex_7, root,
        _scheme_targets(root, NS_CBC, "EndpointID", None),
        _CEF_EAS_EXT_CODES, allow_sepa=False,
        message="Any scheme identifier on an 'Electronic address' endpoint "
                "(BT-34/BT-49) must belong to the CEF EAS code list.",
        element="cbc:EndpointID/@schemeID")


@_rule("BR-DEX-08", "fatal")
def br_dex_8(root):
    """BR-DEX-08: any scheme identifier on a Deliver-to location identifier
    (cac:DeliveryLocation/cbc:ID, BT-71) must be an ISO 6523 ICD (extension)
    code."""
    return _scheme_rule(
        br_dex_8, root,
        _scheme_targets(root, NS_CAC, "DeliveryLocation", "ID"),
        _ISO_6523_ICD_EXT_CODES, allow_sepa=False,
        message="Any scheme identifier on a 'Deliver to location identifier' "
                "(BT-71) must be coded with an ISO 6523 ICD code.",
        element="cac:DeliveryLocation/cbc:ID/@schemeID")


@_rule("BR-DEX-10", "fatal")
def br_dex_10(root):
    """BR-DEX-10: 'Third party payment type' (BT-DEX-001, cbc:ID) must be
    present (non-empty) in every THIRD PARTY PAYMENT group (BG-DEX-09)."""
    if not _is_extension(root):
        return None
    for pp in _prepaid_payments(root):
        if not _has_nonempty(pp, "cbc:ID"):
            return _v(br_dex_10, "'Third party payment type' (BT-DEX-001) must "
                      "be transmitted when a THIRD PARTY PAYMENT (BG-DEX-09) is "
                      "present.", "cac:PrepaidPayment/cbc:ID")
    return None


@_rule("BR-DEX-11", "fatal")
def br_dex_11(root):
    """BR-DEX-11: 'Third party payment amount' (BT-DEX-002, cbc:PaidAmount) must
    be present (non-empty) in every THIRD PARTY PAYMENT group (BG-DEX-09)."""
    if not _is_extension(root):
        return None
    for pp in _prepaid_payments(root):
        if not _has_nonempty(pp, "cbc:PaidAmount"):
            return _v(br_dex_11, "'Third party payment amount' (BT-DEX-002) "
                      "must be transmitted when a THIRD PARTY PAYMENT "
                      "(BG-DEX-09) is present.",
                      "cac:PrepaidPayment/cbc:PaidAmount")
    return None


@_rule("BR-DEX-12", "fatal")
def br_dex_12(root):
    """BR-DEX-12: 'Third party payment description' (BT-DEX-003,
    cbc:InstructionID) must be present (non-empty) in every THIRD PARTY PAYMENT
    group (BG-DEX-09)."""
    if not _is_extension(root):
        return None
    for pp in _prepaid_payments(root):
        if not _has_nonempty(pp, "cbc:InstructionID"):
            return _v(br_dex_12, "'Third party payment description' "
                      "(BT-DEX-003) must be transmitted when a THIRD PARTY "
                      "PAYMENT (BG-DEX-09) is present.",
                      "cac:PrepaidPayment/cbc:InstructionID")
    return None


@_rule("BR-DEX-13", "fatal")
def br_dex_13(root):
    """BR-DEX-13: 'Third party payment amount' (BT-DEX-002) may carry at most 2
    fractional digits: string-length(substring-after(cbc:PaidAmount, '.')) <= 2
    (no '.' -> '' -> length 0 -> holds)."""
    if not _is_extension(root):
        return None
    for pp in _prepaid_payments(root):
        amt = pp.find("cbc:PaidAmount", NS)
        raw = _sv(amt) if amt is not None else ""
        frac = raw.split(".", 1)[1] if "." in raw else ""
        if len(frac) > 2:
            return _v(br_dex_13, "'Third party payment amount' (BT-DEX-002) "
                      "must have at most 2 decimal places.",
                      "cac:PrepaidPayment/cbc:PaidAmount")
    return None


@_rule("BR-DEX-14", "fatal")
def br_dex_14(root):
    """BR-DEX-14: the currency of 'Third party payment amount' (BT-DEX-002) must
    equal BT-5 (Invoice currency code): cbc:PaidAmount/@currencyID =
    parent::node()/cbc:DocumentCurrencyCode. A missing @currencyID or a missing
    DocumentCurrencyCode makes the node-set comparison false -> fires."""
    if not _is_extension(root):
        return None
    doc_ccs = {_sv(e) for e in root.findall("cbc:DocumentCurrencyCode", NS)}
    for pp in _prepaid_payments(root):
        cur_ids = {a.get("currencyID")
                   for a in pp.findall("cbc:PaidAmount", NS)
                   if a.get("currencyID") is not None}
        if not any(c in doc_ccs for c in cur_ids):
            return _v(br_dex_14, "The currency of 'Third party payment amount' "
                      "(BT-DEX-002) must equal the 'Invoice currency code' "
                      "(BT-5).", "cac:PrepaidPayment/cbc:PaidAmount/@currencyID")
    return None


# Ordered ruleset (document flow: header -> parties -> delivery -> VAT ->
# payment means -> extension layer).
ALL_RULES = [
    br_de_1, br_de_2, br_de_3, br_de_4, br_de_5, br_de_6, br_de_7,
    br_de_8, br_de_9, br_de_10, br_de_11, br_de_14, br_de_15, br_de_16,
    br_de_17, br_de_18, br_de_19, br_de_20, br_de_21, br_de_22,
    br_de_23_a, br_de_23_b, br_de_24_a, br_de_24_b, br_de_25_a, br_de_25_b,
    br_de_26, br_de_27, br_de_28, br_de_30, br_de_31, br_de_tmp_32,
    br_dex_1, br_dex_2, br_dex_3, br_dex_4, br_dex_5, br_dex_6, br_dex_7,
    br_dex_8, br_dex_9, br_dex_10, br_dex_11, br_dex_12, br_dex_13, br_dex_14,
]


def evaluate(root):
    """Run the full XRechnung CIUS layer over a parsed UBL Invoice root.

    Returns the list of Violations that fire (each rule contributes at most
    one, naming the first offending node — same convention as the core rules).
    """
    out = []
    for rule in ALL_RULES:
        v = rule(root)
        if v is not None:
            out.append(v)
    return out


# ===========================================================================
# CII-syntax BR-DE layer (evaluated over the normalized model, not a UBL tree).
#
# The BR-DE functions above read a UBL Invoice ``ElementTree`` directly — their
# XPath contexts are UBL ``cac:``/``cbc:`` paths — so they cannot run over a CII
# (UN/CEFACT CrossIndustryInvoice) document. This section provides the SAME
# national BR-DE assertions, transcribed assert-by-assert from the OFFICIAL
# XRechnung-CII Schematron (``corpus/xrechnung-schematron/schematron/cii/
# XRechnung-CII-validation.sch``), evaluated against the syntax-agnostic
# normalized model produced by :func:`einvoice.parser_cii.build_model` — exactly
# the way the EN 16931 core rules run over CII. Because the German rules address
# document parts the core model deliberately omits (payment instructions, postal
# detail, seller contact, tax representative, preceding-invoice reference,
# delivery date / billing period), :func:`einvoice.parser_cii._build_cii_br_de`
# populates those attributes from the CII paths and the rules below read them.
#
# ONLY the BR-DE rules whose guarded fact the model carries AND which reach
# EXACT parity (0 false-positive / 0 false-negative) with the official
# XRechnung-CII Schematron on the differential corpus are admitted here (list
# ``CII_DE_RULES``). The rules whose CII binding needs structure the EN 16931
# core model does not carry — payment-means type-code groups, IBAN mod-97
# (BR-DE-19/20/23/24/25/30/31), the Skonto grammar (BR-DE-18), attachment
# filename uniqueness (BR-DE-22) and the whole BR-DEX-* / BR-DE-CVD-* extension
# layer — are EXCLUDED, not approximated (see the documented exclusion list in
# ``differential.CII_XR_EXCLUDED_RULE_IDS``). Every admitted rule is
# differentially proven by ``differential.py xrechnung-cii``.
# ===========================================================================
def _mnz(text):
    """normalize-space() truthiness on a stored model string ('' / None -> False)."""
    return bool(_nsp(text))


@_rule("BR-DE-1", "fatal")
def cii_br_de_1(inv):
    """BR-DE-1: an invoice must contain PAYMENT INSTRUCTIONS (BG-16). CII:
    exists ram:ApplicableHeaderTradeSettlement/ram:SpecifiedTradeSettlementPaymentMeans."""
    if not inv.has_payment_means:
        return _v(cii_br_de_1, "An invoice (INVOICE) must contain information on "
                  "PAYMENT INSTRUCTIONS (BG-16).",
                  "ram:ApplicableHeaderTradeSettlement/"
                  "ram:SpecifiedTradeSettlementPaymentMeans")
    return None


@_rule("BR-DE-2", "fatal")
def cii_br_de_2(inv):
    """BR-DE-2: SELLER CONTACT (BG-6) must be transmitted. CII rule context is the
    SellerTradeParty node; assert ram:DefinedTradeContact exists."""
    if inv.seller_party_present and not inv.seller_has_defined_trade_contact:
        return _v(cii_br_de_2, "The group 'SELLER CONTACT' (BG-6) must be "
                  "transmitted.", "ram:SellerTradeParty/ram:DefinedTradeContact")
    return None


@_rule("BR-DE-3", "fatal")
def cii_br_de_3(inv):
    """BR-DE-3: Seller city (BT-37) non-empty. CII rule context is the seller
    PostalTradeAddress; assert ram:CityName[normalize-space]."""
    if inv.seller_has_postal_address and not _mnz(inv.seller_city):
        return _v(cii_br_de_3, "The element 'Seller city' (BT-37) must be "
                  "transmitted.",
                  "ram:SellerTradeParty/ram:PostalTradeAddress/ram:CityName")
    return None


@_rule("BR-DE-4", "fatal")
def cii_br_de_4(inv):
    """BR-DE-4: Seller post code (BT-38) non-empty (seller PostalTradeAddress
    context; ram:PostcodeCode)."""
    if inv.seller_has_postal_address and not _mnz(inv.seller_post_code):
        return _v(cii_br_de_4, "The element 'Seller post code' (BT-38) must be "
                  "transmitted.",
                  "ram:SellerTradeParty/ram:PostalTradeAddress/ram:PostcodeCode")
    return None


@_rule("BR-DE-5", "fatal")
def cii_br_de_5(inv):
    """BR-DE-5: Seller contact point (BT-41) non-empty. CII rule context is each
    DefinedTradeContact; assert (ram:PersonName, ram:DepartmentName)[normalize-space]."""
    for c in inv.seller_defined_trade_contacts:
        if not (_mnz(c.person_name) or _mnz(c.department_name)):
            return _v(cii_br_de_5, "The element 'Seller contact point' (BT-41) "
                      "must be transmitted.",
                      "ram:SellerTradeParty/ram:DefinedTradeContact/ram:PersonName")
    return None


@_rule("BR-DE-6", "fatal")
def cii_br_de_6(inv):
    """BR-DE-6: Seller contact telephone number (BT-42) non-empty (per contact;
    ram:TelephoneUniversalCommunication/ram:CompleteNumber)."""
    for c in inv.seller_defined_trade_contacts:
        if not _mnz(c.telephone):
            return _v(cii_br_de_6, "The element 'Seller contact telephone "
                      "number' (BT-42) must be transmitted.",
                      "ram:SellerTradeParty/ram:DefinedTradeContact/"
                      "ram:TelephoneUniversalCommunication/ram:CompleteNumber")
    return None


@_rule("BR-DE-7", "fatal")
def cii_br_de_7(inv):
    """BR-DE-7: Seller contact email address (BT-43) non-empty (per contact;
    ram:EmailURIUniversalCommunication/ram:URIID)."""
    for c in inv.seller_defined_trade_contacts:
        if not _mnz(c.email):
            return _v(cii_br_de_7, "The element 'Seller contact email address' "
                      "(BT-43) must be transmitted.",
                      "ram:SellerTradeParty/ram:DefinedTradeContact/"
                      "ram:EmailURIUniversalCommunication/ram:URIID")
    return None


@_rule("BR-DE-27", "warning")
def cii_br_de_27(inv):
    """BR-DE-27: BT-42 should contain at least three digits. Per contact;
    normalize-space of an absent telephone is '' and therefore also fires."""
    for c in inv.seller_defined_trade_contacts:
        if not _TELEPHONE_RE.search(_nsp(c.telephone)):
            return _v(cii_br_de_27, "'Seller contact telephone number' (BT-42) "
                      "should contain at least three digits.",
                      "ram:SellerTradeParty/ram:DefinedTradeContact/"
                      "ram:TelephoneUniversalCommunication/ram:CompleteNumber")
    return None


@_rule("BR-DE-28", "warning")
def cii_br_de_28(inv):
    """BR-DE-28: BT-43 should look like an email address (exactly one '@',
    flanked per the official regex). Per contact; absent email -> '' -> fires."""
    for c in inv.seller_defined_trade_contacts:
        if not _EMAIL_RE.search(_nsp(c.email)):
            return _v(cii_br_de_28, "'Seller contact email address' (BT-43) "
                      "should contain exactly one '@' with valid flanking "
                      "characters.",
                      "ram:SellerTradeParty/ram:DefinedTradeContact/"
                      "ram:EmailURIUniversalCommunication/ram:URIID")
    return None


@_rule("BR-DE-8", "fatal")
def cii_br_de_8(inv):
    """BR-DE-8: Buyer city (BT-52) non-empty (buyer PostalTradeAddress context)."""
    if inv.buyer_has_postal_address and not _mnz(inv.buyer_city):
        return _v(cii_br_de_8, "The element 'Buyer city' (BT-52) must be "
                  "transmitted.",
                  "ram:BuyerTradeParty/ram:PostalTradeAddress/ram:CityName")
    return None


@_rule("BR-DE-9", "fatal")
def cii_br_de_9(inv):
    """BR-DE-9: Buyer post code (BT-53) non-empty (buyer PostalTradeAddress)."""
    if inv.buyer_has_postal_address and not _mnz(inv.buyer_post_code):
        return _v(cii_br_de_9, "The element 'Buyer post code' (BT-53) must be "
                  "transmitted.",
                  "ram:BuyerTradeParty/ram:PostalTradeAddress/ram:PostcodeCode")
    return None


@_rule("BR-DE-10", "fatal")
def cii_br_de_10(inv):
    """BR-DE-10: Deliver to city (BT-77) non-empty when DELIVER TO ADDRESS
    (BG-15) is present. CII rule context is each ShipToTradeParty/PostalTradeAddress."""
    for city, _zone in inv.shipto_postal_addresses:
        if not _mnz(city):
            return _v(cii_br_de_10, "The element 'Deliver to city' (BT-77) must "
                      "be transmitted when DELIVER TO ADDRESS (BG-15) is present.",
                      "ram:ShipToTradeParty/ram:PostalTradeAddress/ram:CityName")
    return None


@_rule("BR-DE-11", "fatal")
def cii_br_de_11(inv):
    """BR-DE-11: Deliver to post code (BT-78) non-empty when DELIVER TO ADDRESS
    (BG-15) is present (ShipToTradeParty/PostalTradeAddress context)."""
    for _city, zone in inv.shipto_postal_addresses:
        if not _mnz(zone):
            return _v(cii_br_de_11, "The element 'Deliver to post code' (BT-78) "
                      "must be transmitted when DELIVER TO ADDRESS (BG-15) is "
                      "present.",
                      "ram:ShipToTradeParty/ram:PostalTradeAddress/ram:PostcodeCode")
    return None


@_rule("BR-DE-14", "fatal")
def cii_br_de_14(inv):
    """BR-DE-14: VAT category rate (BT-119) non-empty in every VAT breakdown row.
    CII rule context is each ram:ApplicableTradeTax; assert ram:RateApplicablePercent."""
    for st in inv.all_tax_subtotals:
        if not _mnz(st.percent):
            return _v(cii_br_de_14, "The element 'VAT category rate' (BT-119) "
                      "must be transmitted.",
                      "ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax/"
                      "ram:RateApplicablePercent")
    return None


@_rule("BR-DE-15", "fatal")
def cii_br_de_15(inv):
    """BR-DE-15: Buyer reference (BT-10) must be transmitted (non-empty)."""
    if not _mnz(inv.buyer_reference):
        return _v(cii_br_de_15, "The element 'Buyer reference' (BT-10) must be "
                  "transmitted.",
                  "ram:ApplicableHeaderTradeAgreement/ram:BuyerReference")
    return None


@_rule("BR-DE-16", "fatal")
def cii_br_de_16(inv):
    """BR-DE-16: if VAT category codes S/Z/E/AE/K/G/L/M are used, one of Seller
    VAT identifier (BT-31), Seller tax registration identifier (BT-32) or SELLER
    TAX REPRESENTATIVE PARTY (BG-11) must be present.

    Official CII value set (line-level): an ApplicableTradeTax with
    ram:TypeCode = 'VAT' AND an ApplicableTradeTax with ram:CategoryCode in the
    set (separate existence checks over the line node set). The document-level
    allowance/charge disjunct in the official assert compares the *aggregate*
    ``ram:CategoryTradeTax`` to the string 'VAT'; a schema-valid CategoryTradeTax
    always carries a ram:CategoryCode child, so its string value is never exactly
    'VAT' — the disjunct is unsatisfiable and contributes nothing (transcribed as
    such, and confirmed at parity by the differential). Seller disjunct: a VA|FC
    tax-registration id (non-empty) OR a tax representative party.
    """
    type_vat = any(c.scheme_id == "VAT"
                   for ln in inv.lines for c in ln.item_tax_categories)
    cat_in_set = any(c.id in _XR_SUPPORTED_VAT_CODES
                     for ln in inv.lines for c in ln.item_tax_categories)
    used = type_vat and cat_in_set
    if not used:
        return None
    if inv.seller_vat_or_fc_id_present or inv.has_tax_representative:
        return None
    return _v(cii_br_de_16, "VAT category codes S, Z, E, AE, K, G, L or M are "
              "used, so at least one of 'Seller VAT identifier' (BT-31), 'Seller "
              "tax registration identifier' (BT-32) or 'SELLER TAX REPRESENTATIVE "
              "PARTY' (BG-11) must be transmitted.",
              "ram:SellerTradeParty/ram:SpecifiedTaxRegistration/ram:ID")


@_rule("BR-DE-17", "warning")
def cii_br_de_17(inv):
    """BR-DE-17: BT-3 should be one of 326, 380, 384, 389, 381, 875, 876, 877.
    Official test is over normalize-space(ram:ExchangedDocument/ram:TypeCode) — an
    ABSENT type code normalizes to '' and therefore also fires."""
    itc = _nsp(inv.invoice_type_code)
    if itc in _XR_TYPE_CODES:
        return None
    return _v(cii_br_de_17, "'Invoice type code' (BT-3) should be one of the "
              "codes 326, 380, 384, 389, 381, 875, 876, 877 (UNTDID 1001 "
              "subset); found %r." % (itc or "(absent)"),
              "ram:ExchangedDocument/ram:TypeCode")


@_rule("BR-DE-21", "warning")
def cii_br_de_21(inv):
    """BR-DE-21: BT-24 should be the XRechnung specification identifier (CIUS,
    extension or CVD variant)."""
    if inv.customization_id in (XR_CIUS_ID, XR_EXTENSION_ID, XR_CVD_ID):
        return None
    return _v(cii_br_de_21, "'Specification identifier' (BT-24) should "
              "syntactically match the XRechnung standard identifier.",
              "ram:ExchangedDocumentContext/"
              "ram:GuidelineSpecifiedDocumentContextParameter/ram:ID")


@_rule("BR-DE-26", "warning")
def cii_br_de_26(inv):
    """BR-DE-26: type code 384 (Corrected invoice) should carry a PRECEDING
    INVOICE REFERENCE (BG-3). CII: ram:ApplicableHeaderTradeSettlement/
    ram:InvoiceReferencedDocument."""
    if _nsp(inv.invoice_type_code) != "384":
        return None
    if inv.has_invoice_referenced_document:
        return None
    return _v(cii_br_de_26, "'Invoice type code' (BT-3) is 384 (Corrected "
              "invoice), so PRECEDING INVOICE REFERENCE (BG-3) should be present "
              "at least once.",
              "ram:ApplicableHeaderTradeSettlement/ram:InvoiceReferencedDocument")


@_rule("BR-DE-TMP-32", "information")
def cii_br_de_tmp_32(inv):
    """BR-DE-TMP-32: an invoice should state the delivery/service date via BT-72
    (Actual delivery date), BG-14 (Invoicing period) or a BG-26 (Invoice line
    period) on EVERY line. CII context is SupplyChainTradeTransaction; the 'every
    line' disjunct is vacuously true for zero lines."""
    if inv.has_actual_delivery_date or inv.has_billing_period:
        return None
    if all(getattr(ln, "has_line_billing_period", False) for ln in inv.lines):
        return None
    return _v(cii_br_de_tmp_32, "The invoice should state the delivery/service "
              "date: BT-72 'Actual delivery date', BG-14 'Invoicing period', or "
              "BG-26 'Invoice line period' on every line.",
              "ram:ApplicableHeaderTradeDelivery/"
              "ram:ActualDeliverySupplyChainEvent/ram:OccurrenceDateTime")


# Admitted CII BR-DE set — document flow order. Every id here is proven at exact
# parity with the official XRechnung-CII Schematron by differential.py.
CII_DE_RULES = [
    cii_br_de_1, cii_br_de_2, cii_br_de_3, cii_br_de_4, cii_br_de_5,
    cii_br_de_6, cii_br_de_7, cii_br_de_8, cii_br_de_9, cii_br_de_10,
    cii_br_de_11, cii_br_de_14, cii_br_de_15, cii_br_de_16, cii_br_de_17,
    cii_br_de_21, cii_br_de_26, cii_br_de_27, cii_br_de_28, cii_br_de_tmp_32,
]


def evaluate_cii(inv):
    """Run the admitted CII BR-DE layer over a normalized CII model.

    ``inv`` is an :class:`einvoice.parser_cii.Invoice` (from
    :func:`einvoice.parser_cii.build_model`). Returns the list of Violations
    that fire (each admitted rule contributes at most one)."""
    out = []
    for rule in CII_DE_RULES:
        v = rule(inv)
        if v is not None:
            out.append(v)
    return out
