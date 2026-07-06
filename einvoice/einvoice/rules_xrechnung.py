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

Out of scope (deliberately): ``BR-DEX-*`` (the XRechnung *extension* profile),
``BR-DE-CVD-*`` (the Clean-Vehicle-Directive profile), ``BR-TMP-2`` and the
``PEPPOL-EN16931-*`` rules also present in the KoSIT artifact.

Standard library only.
"""

from __future__ import annotations

import re
from collections import namedtuple

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


# Ordered ruleset (document flow: header -> parties -> delivery -> VAT ->
# payment means).
ALL_RULES = [
    br_de_1, br_de_2, br_de_3, br_de_4, br_de_5, br_de_6, br_de_7,
    br_de_8, br_de_9, br_de_10, br_de_11, br_de_14, br_de_15, br_de_16,
    br_de_17, br_de_18, br_de_19, br_de_20, br_de_21, br_de_22,
    br_de_23_a, br_de_23_b, br_de_24_a, br_de_24_b, br_de_25_a, br_de_25_b,
    br_de_26, br_de_27, br_de_28, br_de_30, br_de_31, br_de_tmp_32,
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
