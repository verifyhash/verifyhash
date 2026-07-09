"""CII (UN/CEFACT CrossIndustryInvoice) parser -> normalized model.

Python 3 standard library only (``xml.etree.ElementTree``). No lxml, no pip.

Parses a UN/CEFACT ``CrossIndustryInvoice`` (the CII syntax of EN 16931, used by
Factur-X / ZUGFeRD and by the CII flavour of XRechnung) into a small, flat,
rule-friendly model. This deliberately mirrors the SHAPE of the UBL
:mod:`einvoice.parser` model where the two syntaxes carry the same EN 16931
concept, so a future CII rules layer can be written against a familiar surface.

Every value is kept as *text* (or ``None`` when the element is absent), exactly
like :mod:`einvoice.parser`, so that the interpretation of presence, cardinality
and numeric value is left to the rules layer rather than baked in here.

Where CII and UBL name the same business term (BT) but locate it differently,
this module reuses the UBL model's attribute name so downstream code sees one
vocabulary:

======  =============================  =======================================
BT      model attribute                CII location
======  =============================  =======================================
BT-1    ``id``                         rsm:ExchangedDocument/ram:ID
BT-2    ``issue_date``                 .../ram:IssueDateTime/udt:DateTimeString
BT-3    ``invoice_type_code``          rsm:ExchangedDocument/ram:TypeCode
BT-5    ``document_currency_code``     .../ram:InvoiceCurrencyCode
BT-10   ``buyer_reference``            .../ram:BuyerReference
BT-27   ``seller_name``                ram:SellerTradeParty/ram:Name
BT-40   ``seller_country_code``        SellerTradeParty/.../ram:CountryID
BT-44   ``buyer_name``                 ram:BuyerTradeParty/ram:Name
BT-55   ``buyer_country_code``         BuyerTradeParty/.../ram:CountryID
BT-106  ``line_extension_total``       ram:LineTotalAmount
BT-107  ``allowance_total``            ram:AllowanceTotalAmount
BT-108  ``charge_total``               ram:ChargeTotalAmount
BT-109  ``tax_exclusive_amount``       ram:TaxBasisTotalAmount
BT-110  ``tax_total_amount``           ram:TaxTotalAmount
BT-112  ``tax_inclusive_amount``       ram:GrandTotalAmount
BT-113  ``prepaid_amount``             ram:TotalPrepaidAmount
BT-114  ``payable_rounding_amount``    ram:RoundingAmount
BT-115  ``payable_amount``             ram:DuePayableAmount
======  =============================  =======================================

Note the header-total attribute names follow the UBL LegalMonetaryTotal
concepts (``tax_exclusive_amount`` = BT-109, ``tax_inclusive_amount`` = BT-112),
even though the CII element names differ (``TaxBasisTotalAmount`` /
``GrandTotalAmount``). The BT number is the invariant, and it is documented on
each attribute so nothing is ambiguous.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

# ---------------------------------------------------------------------------
# Namespaces (confirmed against corpus/cen-en16931/cii/examples/CII_example1.xml)
# ---------------------------------------------------------------------------
NS_RSM = "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
NS_RAM = ("urn:un:unece:uncefact:data:standard:"
          "ReusableAggregateBusinessInformationEntity:100")
NS_UDT = "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"

NS = {"rsm": NS_RSM, "ram": NS_RAM, "udt": NS_UDT}


class NotWellFormed(Exception):
    """Raised when the input is not well-formed XML (maps to CLI exit code 3)."""


def _text(el):
    """Return stripped text of an element, or ``None`` if the element is absent.

    Mirrors :func:`einvoice.parser._text` so the two parsers atomize identically.
    """
    if el is None:
        return None
    return (el.text or "").strip()


def _norm_space(text):
    """XPath ``normalize-space()``: trim + collapse internal whitespace runs."""
    if text is None:
        return None
    return " ".join(text.split())


def _localname(tag):
    """Strip the ``{namespace}`` prefix ElementTree prepends to a tag."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


class CIILine:
    """One ``ram:IncludedSupplyChainTradeLineItem`` (BG-25), text/None fields.

    Kept intentionally minimal for this foundation slice: the line identifier
    and the line net amount, the two fields every downstream total/consistency
    rule needs first. Shaped after :class:`einvoice.parser.InvoiceLine`.
    """

    __slots__ = ("index", "id", "line_extension_amount")

    def __init__(self, index):
        self.index = index
        self.id = None                    # BT-126 ram:AssociatedDocumentLineDocument/ram:LineID
        self.line_extension_amount = None  # BT-131 line net amount (text)

    @property
    def label(self):
        return "ram:IncludedSupplyChainTradeLineItem[%d]%s" % (
            self.index, (" id=%r" % self.id) if self.id else "")


class Invoice:
    """Normalized first-slice model of a CII CrossIndustryInvoice.

    Attribute names mirror :class:`einvoice.parser.Invoice` where the EN 16931
    business term is shared, so a rules layer can treat UBL and CII models
    through one vocabulary. Every value is text (or ``None`` when absent).
    """

    def __init__(self):
        self.root_is_cii_invoice = False
        # Header
        self.id = None                    # BT-1
        self.issue_date = None            # BT-2 (raw digits, e.g. '20150109')
        self.invoice_type_code = None     # BT-3
        self.document_currency_code = None  # BT-5
        self.buyer_reference = None       # BT-10
        # Parties
        self.seller_name = None           # BT-27
        self.seller_country_code = None   # BT-40 (normalize-space; None = no addr)
        self.buyer_name = None            # BT-44
        self.buyer_country_code = None    # BT-55 (normalize-space; None = no addr)
        # Document totals (ram:SpecifiedTradeSettlementHeaderMonetarySummation)
        self.line_extension_total = None  # BT-106 ram:LineTotalAmount
        self.allowance_total = None       # BT-107 ram:AllowanceTotalAmount
        self.charge_total = None          # BT-108 ram:ChargeTotalAmount
        self.tax_exclusive_amount = None  # BT-109 ram:TaxBasisTotalAmount
        self.tax_total_amount = None      # BT-110 ram:TaxTotalAmount (text)
        self.tax_total_amount_currency = None  # ram:TaxTotalAmount/@currencyID
        self.tax_inclusive_amount = None  # BT-112 ram:GrandTotalAmount
        self.prepaid_amount = None        # BT-113 ram:TotalPrepaidAmount
        self.payable_rounding_amount = None  # BT-114 ram:RoundingAmount
        self.payable_amount = None        # BT-115 ram:DuePayableAmount
        self.has_header_monetary_summation = False
        # Lines
        self.lines = []                   # list[CIILine]


def parse_file(path):
    """Parse ``path`` and return the CrossIndustryInvoice root element.

    Raises :class:`NotWellFormed` for parse errors (CLI exit 3), mirroring
    :func:`einvoice.parser.parse_file`.
    """
    try:
        tree = ET.parse(path)
    except ET.ParseError as exc:
        raise NotWellFormed(str(exc))
    return tree.getroot()


def build_model(root):
    """Build an :class:`Invoice` model from a parsed CII root element."""
    inv = Invoice()
    inv.root_is_cii_invoice = (
        root.tag == "{%s}CrossIndustryInvoice" % NS_RSM
        or (_localname(root.tag) == "CrossIndustryInvoice"
            and root.tag.startswith("{%s}" % NS_RSM))
    )

    # -- ExchangedDocument (header identifiers) ----------------------------
    doc = root.find("rsm:ExchangedDocument", NS)
    if doc is not None:
        inv.id = _text(doc.find("ram:ID", NS))                       # BT-1
        inv.invoice_type_code = _text(doc.find("ram:TypeCode", NS))  # BT-3
        # BT-2: the date lives in udt:DateTimeString under ram:IssueDateTime.
        inv.issue_date = _text(
            doc.find("ram:IssueDateTime/udt:DateTimeString", NS))

    # -- SupplyChainTradeTransaction (parties, settlement, lines) ----------
    txn = root.find("rsm:SupplyChainTradeTransaction", NS)
    if txn is not None:
        # Header trade agreement -> seller / buyer parties + buyer reference.
        agreement = txn.find("ram:ApplicableHeaderTradeAgreement", NS)
        if agreement is not None:
            inv.buyer_reference = _text(
                agreement.find("ram:BuyerReference", NS))            # BT-10
            seller = agreement.find("ram:SellerTradeParty", NS)
            if seller is not None:
                inv.seller_name = _text(seller.find("ram:Name", NS))  # BT-27
                inv.seller_country_code = _norm_space(_text(
                    seller.find(
                        "ram:PostalTradeAddress/ram:CountryID", NS)))  # BT-40
            buyer = agreement.find("ram:BuyerTradeParty", NS)
            if buyer is not None:
                inv.buyer_name = _text(buyer.find("ram:Name", NS))    # BT-44
                inv.buyer_country_code = _norm_space(_text(
                    buyer.find(
                        "ram:PostalTradeAddress/ram:CountryID", NS)))  # BT-55

        # Header trade settlement -> currency + document monetary totals.
        settlement = txn.find("ram:ApplicableHeaderTradeSettlement", NS)
        if settlement is not None:
            inv.document_currency_code = _text(
                settlement.find("ram:InvoiceCurrencyCode", NS))       # BT-5
            summation = settlement.find(
                "ram:SpecifiedTradeSettlementHeaderMonetarySummation", NS)
            if summation is not None:
                inv.has_header_monetary_summation = True
                inv.line_extension_total = _text(
                    summation.find("ram:LineTotalAmount", NS))        # BT-106
                inv.allowance_total = _text(
                    summation.find("ram:AllowanceTotalAmount", NS))   # BT-107
                inv.charge_total = _text(
                    summation.find("ram:ChargeTotalAmount", NS))      # BT-108
                inv.tax_exclusive_amount = _text(
                    summation.find("ram:TaxBasisTotalAmount", NS))    # BT-109
                tta_el = summation.find("ram:TaxTotalAmount", NS)
                inv.tax_total_amount = _text(tta_el)                  # BT-110
                if tta_el is not None:
                    inv.tax_total_amount_currency = tta_el.get("currencyID")
                inv.tax_inclusive_amount = _text(
                    summation.find("ram:GrandTotalAmount", NS))       # BT-112
                inv.prepaid_amount = _text(
                    summation.find("ram:TotalPrepaidAmount", NS))     # BT-113
                inv.payable_rounding_amount = _text(
                    summation.find("ram:RoundingAmount", NS))         # BT-114
                inv.payable_amount = _text(
                    summation.find("ram:DuePayableAmount", NS))       # BT-115

        # Invoice lines (BG-25).
        for i, ln_el in enumerate(
                txn.findall("ram:IncludedSupplyChainTradeLineItem", NS),
                start=1):
            ln = CIILine(i)
            ln.id = _text(ln_el.find(
                "ram:AssociatedDocumentLineDocument/ram:LineID", NS))  # BT-126
            ln.line_extension_amount = _text(ln_el.find(
                "ram:SpecifiedLineTradeSettlement/"
                "ram:SpecifiedTradeSettlementLineMonetarySummation/"
                "ram:LineTotalAmount", NS))                            # BT-131
            inv.lines.append(ln)

    return inv


def parse(path):
    """Convenience: parse ``path`` and return its :class:`Invoice` model."""
    return build_model(parse_file(path))
