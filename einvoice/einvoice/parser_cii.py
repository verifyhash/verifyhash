"""CII (UN/CEFACT CrossIndustryInvoice) parser -> normalized model.

Python 3 standard library only (``xml.etree.ElementTree``). No lxml, no pip.

Parses a UN/CEFACT ``CrossIndustryInvoice`` (the CII syntax of EN 16931, used by
Factur-X / ZUGFeRD and by the CII flavour of XRechnung) into the SAME normalized,
flat, rule-friendly model that :mod:`einvoice.parser` produces from UBL. The two
parsers deliberately share one vocabulary: every EN 16931 business term (BT/BG)
is exposed under the identical attribute name regardless of syntax, so the
syntax-agnostic rule functions in :mod:`einvoice.rules` run UNCHANGED against a
CII invoice. The model class here subclasses :class:`einvoice.parser.Invoice`, so
it inherits the full attribute surface and every helper method (``all_category_ids``,
``breakdown_category_ids``, ``all_allowance_charges``, ``seller_has_vat_identifier``,
``doc_currency_tax_totals`` …) verbatim; ``build_model`` populates those attributes
from the CII XPaths.

Every value is kept as *text* (or ``None`` when the element is absent), exactly
like :mod:`einvoice.parser`, so that the interpretation of presence, cardinality
and numeric value is left to the rules layer rather than baked in here.

Where CII and UBL name the same business term (BT) but locate it differently,
this module reuses the UBL model's attribute name so downstream code sees one
vocabulary. The header-total attribute names follow the UBL LegalMonetaryTotal
concepts (``tax_exclusive_amount`` = BT-109, ``tax_inclusive_amount`` = BT-112),
even though the CII element names differ (``TaxBasisTotalAmount`` /
``GrandTotalAmount``); the BT number is the invariant, documented per attribute.

======  =============================  =======================================
BT      model attribute                CII location (relative to root)
======  =============================  =======================================
BT-24   ``customization_id``           ExchangedDocumentContext/Guideline…/ram:ID
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
BG-23   ``tax_totals`` / ``all_tax_subtotals``
                                       ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax
BG-25   ``lines``                      ram:IncludedSupplyChainTradeLineItem
BG-20/1 ``doc_allowance_charges``      …/ram:SpecifiedTradeAllowanceCharge
======  =============================  =======================================
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from collections import namedtuple

from . import parser
from .parser import (ItemTaxCategory, PayeeParty, Period, TaxRepresentative,
                     TaxSubtotal, TaxTotal, AllowanceCharge)

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


def _rawtext(el):
    """Return the element's raw text (whitespace preserved), or ``None`` if absent.

    The BR-DEC-* decimal rules count characters after the '.' of the literal
    string value, so those rules must see the unstripped text (mirrors
    :func:`einvoice.parser._rawtext`).
    """
    if el is None:
        return None
    return el.text or ""


def _norm_space(text):
    """XPath ``normalize-space()``: trim + collapse internal whitespace runs."""
    if text is None:
        return None
    return " ".join(text.split())


def _strval(el):
    """XPath string value of an element (ALL descendant text, unstripped),
    mirroring :func:`einvoice.parser._strval` — the raw atomized value the
    official general comparisons and ``substring()`` calls read."""
    return "".join(el.itertext())


def _localname(tag):
    """Strip the ``{namespace}`` prefix ElementTree prepends to a tag."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _period_bound(period_el, which):
    """One BR-29/BR-30 period bound, transcribed from the official CII test.

    The official assert (shared by BR-29 and BR-30, contexts header/line
    ``ram:BillingSpecifiedPeriod``)::

        (ram:EndDateTime/udt:DateTimeString[@format = '102'])
          >= (ram:StartDateTime/udt:DateTimeString[@format = '102'])
        or not (ram:EndDateTime) or not (ram:StartDateTime)

    The absence disjuncts test the ``ram:StartDateTime``/``ram:EndDateTime``
    ELEMENTS, while the comparison reads only a ``@format='102'``
    (``YYYYMMDD``) DateTimeString child. Mapping onto the shared
    :class:`einvoice.parser.Period` model the UBL rule bodies consume:

    * bound element absent -> ``None`` (the rule then holds via ``not(...)``);
    * present with a valid 8-digit format-102 date -> its ISO ``YYYY-MM-DD``
      form (format-102 strings compare lexicographically exactly as the dates
      compare chronologically, so the shared date comparison is the official
      string comparison);
    * present WITHOUT a comparable format-102 value (missing DateTimeString,
      other @format, or non-8-digit text) -> the raw text (never a parseable
      xs:date), so the shared rule body treats the bound as unparseable and
      fires whenever the opposite bound is also present — exactly the official
      outcome there (the ``>=`` comparison against an empty operand is false
      while both ``not(...)`` disjuncts are false).
    """
    bound_el = period_el.find("ram:%s" % which, NS)
    if bound_el is None:
        return None
    dts = bound_el.find("udt:DateTimeString", NS)
    if dts is not None and dts.get("format") == "102":
        t = (dts.text or "").strip()
        if len(t) == 8 and t.isdigit():
            return "%s-%s-%s" % (t[:4], t[4:6], t[6:8])
        return t or "not-a-102-date"
    return "not-a-102-date"


# One CII seller ``ram:DefinedTradeContact`` (BG-6), carrying the four fields the
# national BR-DE-5/6/7/27/28 rules read. Text is kept raw (untrimmed) so the
# rules apply XPath normalize-space() themselves, exactly like the UBL layer.
CIIContact = namedtuple("CIIContact",
                        ["person_name", "department_name", "telephone", "email"])

# One header-agreement ``ram:AdditionalReferencedDocument`` (BG-24 at the
# agreement level), carrying the raw child node sets the CVD/TMP rules read:
# BR-DE-CVD-02 keys on normalize-space(ram:TypeCode)='50' + a non-empty
# ram:IssuerAssignedID; BR-TMP-2 keys on ram:TypeCode = '916' (untrimmed
# node-set comparison) + ram:URIID. Lists preserve the official node-set
# semantics (multiple children).
CIIRefDoc = namedtuple("CIIRefDoc", ["type_codes", "issuer_ids", "uri_ids"])

# One ``ram:ClassCode`` of a ``ram:DesignatedProductClassification`` (BT-158):
# the raw @listID attribute (None when absent) and the raw element text — each
# ClassCode element is its own rule context for BR-TMP-CVD-01 / BR-DE-CVD-04.
CIIClassCode = namedtuple("CIIClassCode", ["list_id", "value"])

# One ``ram:ApplicableProductCharacteristic`` (BG-32): the raw string values of
# its ram:Description (BT-160) and ram:Value (BT-161) children, as lists (the
# official tests are node-set comparisons).
CIICharacteristic = namedtuple("CIICharacteristic", ["descriptions", "values"])

# One line's ``ram:SpecifiedTradeProduct``: the BT-158 classification codes and
# BG-32 characteristics the BR-DE-CVD-03/04/05/06-a/06-b / BR-TMP-CVD-01 rules
# read.
CIITradeProduct = namedtuple("CIITradeProduct", ["class_codes", "characteristics"])

# One line's gross/net price base quantities (BR-TMP-3): each entry is a
# ``(raw_text, unit_code_or_None)`` pair per ``ram:BasisQuantity`` under
# GrossPriceProductTradePrice / NetPriceProductTradePrice.
CIIPriceQuantities = namedtuple("CIIPriceQuantities",
                                ["gross_basis_quantities",
                                 "net_basis_quantities"])


class CIILine(parser.InvoiceLine):
    """One ``ram:IncludedSupplyChainTradeLineItem`` (BG-25).

    Reuses the full field surface of :class:`einvoice.parser.InvoiceLine` so the
    line-level core rules (BR-21/22/24/25/26/27/28, BR-CO-04, BR-S-05, …) read
    the SAME attribute names on a CII line as on a UBL line; only the
    ``label`` breadcrumb differs (it names the CII element).
    """

    @property
    def label(self):
        return "ram:IncludedSupplyChainTradeLineItem[%d]%s" % (
            self.index, (" id=%r" % self.id) if self.id else "")


class Invoice(parser.Invoice):
    """Normalized model of a CII CrossIndustryInvoice.

    Subclasses :class:`einvoice.parser.Invoice`, inheriting its full attribute
    surface and every helper method, so the syntax-agnostic rule functions run
    unchanged. Adds the CII-specific presence/echo attributes used by
    :mod:`einvoice.test_parser_cii` (``root_is_cii_invoice``,
    ``has_header_monetary_summation``, ``tax_total_amount`` +
    ``tax_total_amount_currency`` — the BT-110 echo the CII differential leg
    reconciles).
    """

    def __init__(self):
        super().__init__()
        self.root_is_cii_invoice = False
        # ram:SpecifiedTradeSettlementHeaderMonetarySummation presence + BT-110.
        self.has_header_monetary_summation = False
        self.tax_total_amount = None            # BT-110 ram:TaxTotalAmount (text)
        self.tax_total_amount_currency = None   # ram:TaxTotalAmount/@currencyID

        # -- German-CIUS (BR-DE-*) surface, populated by _build_cii_br_de. -----
        # These carry the exact document parts the CII XRechnung national layer
        # (einvoice.rules_xrechnung, CII_DE_RULES) addresses — payment
        # instructions, seller/buyer/deliver-to postal detail, seller contact,
        # tax representative, preceding-invoice reference, delivery date /
        # billing period — which the syntax-agnostic EN 16931 core model omits.
        self.has_payment_means = False          # BG-16 present (BR-DE-1)
        self.seller_party_present = False       # SellerTradeParty context node
        self.seller_has_defined_trade_contact = False  # BG-6 present (BR-DE-2)
        self.seller_city = None                 # BT-37 raw (BR-DE-3)
        self.seller_post_code = None            # BT-38 raw (BR-DE-4)
        self.seller_defined_trade_contacts = []  # [CIIContact] (BR-DE-5/6/7/27/28)
        self.seller_vat_or_fc_id_present = False  # BT-31/32 VA|FC id (BR-DE-16)
        self.has_tax_representative = False     # BG-11 present (BR-DE-16)
        self.buyer_city = None                  # BT-52 raw (BR-DE-8)
        self.buyer_post_code = None             # BT-53 raw (BR-DE-9)
        # [(city_raw, post_code_raw)] per ShipToTradeParty/PostalTradeAddress
        # (BR-DE-10/11 — each is a rule context node).
        self.shipto_postal_addresses = []
        self.has_invoice_referenced_document = False  # BG-3 present (BR-DE-26)
        self.has_actual_delivery_date = False   # BT-72 present (BR-DE-TMP-32)
        self.has_billing_period = False         # BG-14 present (BR-DE-TMP-32)

        # -- CVD / TMP surface (BR-DE-CVD-*, BR-TMP-CVD-01, BR-TMP-2/3), also
        #    populated by _build_cii_br_de from the official CII rule paths. --
        self.guideline_ids = []                 # all BT-24 Guideline…/ram:ID texts
        self.has_supply_chain_transaction = False  # BR-DE-CVD-03 context node
        self.has_header_trade_agreement = False    # BR-DE-CVD-01/02 context node
        self.contract_reference_ids = []        # BT-12 IssuerAssignedID raw texts
        self.header_ref_docs = []               # [CIIRefDoc] (BR-DE-CVD-02, BR-TMP-2)
        self.trade_products = []                # [CIITradeProduct|None] per line item
        self.line_prices = []                   # [CIIPriceQuantities] per line item


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


def _indicator_bool(ac_el):
    """CII ``ram:ChargeIndicator/udt:Indicator`` -> True (charge) / False
    (allowance) / None (neither), matching the official
    ``[udt:Indicator='true']`` / ``[udt:Indicator='false']`` context split."""
    ind = _norm_space(_text(ac_el.find("ram:ChargeIndicator/udt:Indicator", NS)))
    if ind in ("true", "1"):
        return True
    if ind in ("false", "0"):
        return False
    return None


def _build_trade_tax_subtotal(tt_el):
    """Normalize one document-level ``ram:ApplicableTradeTax`` (BG-23 VAT
    breakdown row) into a :class:`einvoice.parser.TaxSubtotal`, reusing the UBL
    subtotal shape so BR-45/46/47/48, BR-CO-17, BR-S-09/10 and BR-DEC-19/20 run
    unchanged. CII field map: CalculatedAmount=BT-117, BasisAmount=BT-116,
    CategoryCode=BT-118, TypeCode=VAT-scheme, RateApplicablePercent=BT-119,
    ExemptionReason/Code=BT-120/121."""
    st = TaxSubtotal()
    ca_el = tt_el.find("ram:CalculatedAmount", NS)
    ba_el = tt_el.find("ram:BasisAmount", NS)
    st.tax_amount = _text(ca_el)              # BT-117
    st.tax_amount_raw = _rawtext(ca_el)
    st.taxable_amount = _text(ba_el)          # BT-116
    st.taxable_amount_raw = _rawtext(ba_el)
    st.category_id = _text(tt_el.find("ram:CategoryCode", NS))   # BT-118
    st.category_id_raw = _rawtext(tt_el.find("ram:CategoryCode", NS))
    st.percent = _text(tt_el.find("ram:RateApplicablePercent", NS))  # BT-119
    scheme = _norm_space(_text(tt_el.find("ram:TypeCode", NS)))
    st.category_scheme_id = scheme.upper() if scheme else None
    st.has_exemption_reason = (
        tt_el.find("ram:ExemptionReason", NS) is not None)
    st.has_exemption_reason_code = (
        tt_el.find("ram:ExemptionReasonCode", NS) is not None)
    return st


def _build_trade_tax_category(cat_el):
    """Normalize one ``ram:CategoryTradeTax`` (a document-allowance/charge VAT
    category) into an :class:`einvoice.parser.ItemTaxCategory`."""
    scheme = _norm_space(_text(cat_el.find("ram:TypeCode", NS)))
    return ItemTaxCategory(
        _norm_space(_text(cat_el.find("ram:CategoryCode", NS))),
        scheme.upper() if scheme else None,
        _text(cat_el.find("ram:RateApplicablePercent", NS)),
        _rawtext(cat_el.find("ram:CategoryCode", NS)))


def _build_doc_allowance_charge(ac_el):
    """Normalize one ``ram:SpecifiedTradeAllowanceCharge`` (document-level
    BG-20/BG-21 or line-level BG-27/BG-28 — the element vocabulary is
    identical) into an :class:`einvoice.parser.AllowanceCharge`, capturing the
    exact ``exists(...)`` facts the EN 16931 allowance/charge rules test."""
    ac = AllowanceCharge()
    ac.is_charge = _indicator_bool(ac_el)
    amount_el = ac_el.find("ram:ActualAmount", NS)
    ac.has_amount = amount_el is not None
    ac.amount_raw = _rawtext(amount_el)                   # BT-92/BT-99
    ac.base_amount_raw = _rawtext(ac_el.find("ram:BasisAmount", NS))  # BT-93/100
    for cat_el in ac_el.findall("ram:CategoryTradeTax", NS):
        scheme = _norm_space(_text(cat_el.find("ram:TypeCode", NS)))
        if (scheme and scheme.upper() == "VAT"
                and cat_el.find("ram:CategoryCode", NS) is not None):
            ac.has_vat_category_id = True
        ac.tax_categories.append(_build_trade_tax_category(cat_el))
    ac.has_reason = (
        ac_el.find("ram:Reason", NS) is not None
        or ac_el.find("ram:ReasonCode", NS) is not None)
    return ac


def build_model(root):
    """Build an :class:`Invoice` model from a parsed CII root element."""
    inv = Invoice()
    inv.root_is_cii_invoice = (
        root.tag == "{%s}CrossIndustryInvoice" % NS_RSM
        or (_localname(root.tag) == "CrossIndustryInvoice"
            and root.tag.startswith("{%s}" % NS_RSM))
    )
    inv.root_is_ubl_invoice = False
    inv.syntax = "cii"

    # --- Code-list rule inputs (BR-CL-03/05/13/14), CII bindings ----------- #
    # These mirror einvoice.parser's UBL collection but at the context nodes the
    # official EN16931-CII codelist Schematron
    # (corpus/cen-en16931/cii/schematron/codelist/EN16931-CII-codes.sch) uses:
    #   BR-CL-03 context = ram:TaxTotalAmount[@currencyID] (predicate: only
    #            elements that HAVE @currencyID are context nodes).
    #   BR-CL-05 context = ram:TaxCurrencyCode (BT-6).
    #   BR-CL-13 context = ram:ClassCode[@listID].
    #   BR-CL-14 context = ram:CountryID.
    inv.tax_currency_code = _norm_space(_text(root.find(".//ram:TaxCurrencyCode", NS)))
    inv.amount_currency_ids = [
        _norm_space(el.get("currencyID")) or ""
        for el in root.findall(".//ram:TaxTotalAmount", NS)
        if el.get("currencyID") is not None
    ]
    inv.item_class_list_ids = [
        _norm_space(el.get("listID"))
        for el in root.findall(".//ram:ClassCode", NS)
        if el.get("listID") is not None
    ]
    inv.country_codes = [
        _norm_space(_text(el)) or ""
        for el in root.findall(".//ram:CountryID", NS)
    ]
    # BR-B-01/BR-B-02 (Italian split payment) node sets — RAW string values
    # (the official CII tests are the raw general comparisons
    # ``//ram:CategoryCode = 'B'`` / ``//ram:CountryID != 'IT'``). The two
    # category lists below (CategoryTradeTax + ApplicableTradeTax) together
    # cover EVERY ram:CategoryCode element a CII invoice can carry. The UBL
    # child-axis BR-B-02 sets (doc_breakdown/doc_ac) stay empty on CII —
    # br_b_02 branches on syntax and compares the whole set here.
    inv.tax_category_ids_raw = [
        _strval(el)
        for el in root.findall(".//ram:CategoryTradeTax/ram:CategoryCode", NS)
    ]
    inv.classified_category_ids_raw = [
        _strval(el)
        for el in root.findall(".//ram:ApplicableTradeTax/ram:CategoryCode", NS)
    ]
    inv.all_country_codes_raw = [
        _strval(el) for el in root.findall(".//ram:CountryID", NS)
    ]
    # BR-AE-01 (CII binding) node sets: the official CII test counts RAW
    # ``ram:CategoryCode='AE'`` rows over three //-global node sets — the
    # header VAT breakdown rows, the line VAT rows and every
    # ram:CategoryTradeTax (the latter is ``tax_category_ids_raw`` above) —
    # with NO VAT TypeCode filter, unlike the VAT-scoped UBL binding.
    # One list of raw CategoryCode string values per row, so the rule can
    # count rows (a row matches when any of its codes equals the category).
    inv.cii_header_trade_tax_code_rows = [
        [_strval(cc) for cc in tt.findall("ram:CategoryCode", NS)]
        for tt in root.findall(
            ".//ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax",
            NS)
    ]
    inv.cii_line_trade_tax_code_rows = [
        [_strval(cc) for cc in tt.findall("ram:CategoryCode", NS)]
        for tt in root.findall(
            ".//ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax", NS)
    ]
    # BR-CL-17 context = ram:CategoryTradeTax/ram:CategoryCode (CII): the VAT
    # category of a document/line allowance-charge (ram:SpecifiedTradeAllowance
    # Charge/ram:CategoryTradeTax). NOTE the CII Schematron splits the two
    # category asserts differently from UBL — the document VAT breakdown and the
    # line item categories are ram:ApplicableTradeTax and fall under BR-CL-18.
    inv.taxcategory_id_codes = [
        _norm_space(_text(el)) or ""
        for el in root.findall(".//ram:CategoryTradeTax/ram:CategoryCode", NS)
    ]
    # BR-CL-18 context = ram:ApplicableTradeTax/ram:CategoryCode (CII): both the
    # document VAT breakdown (ram:ApplicableHeaderTradeSettlement/ram:Applicable
    # TradeTax) and each line's category (ram:SpecifiedLineTradeSettlement/
    # ram:ApplicableTradeTax). Same UNCL 5305 code set as BR-CL-17.
    inv.classified_tax_category_codes = [
        _norm_space(_text(el)) or ""
        for el in root.findall(".//ram:ApplicableTradeTax/ram:CategoryCode", NS)
    ]
    # BR-CL-22 context = ram:ExemptionReasonCode (CII). Stored UPPER-CASED to
    # mirror the official normalize-space(upper-case(.)) VATEX test.
    inv.tax_exemption_reason_codes = [
        (_norm_space(_text(el)) or "").upper()
        for el in root.findall(".//ram:ExemptionReasonCode", NS)
    ]
    # BR-CL-23 context (CII) = ram:BasisQuantity[@unitCode] |
    # ram:BilledQuantity[@unitCode] — the [@unitCode] predicate means only
    # elements carrying that attribute are context nodes; the rule tests
    # normalize-space(@unitCode) against the UN/ECE Rec 20 + Rec 21 unit-code
    # list. BilledQuantity is the invoiced line quantity (BT-129);
    # BasisQuantity is the item price base quantity (BT-149).
    inv.unit_codes = [
        _norm_space(el.get("unitCode")) or ""
        for tag in ("BasisQuantity", "BilledQuantity")
        for el in root.findall(".//ram:%s" % tag, NS)
        if el.get("unitCode") is not None
    ]
    # BR-CL-16 context = ram:SpecifiedTradeSettlementPaymentMeans/ram:TypeCode
    # (CII) — NOT rsm:ExchangedDocument/ram:TypeCode (that is BR-CL-01). The rule
    # tests normalize-space(.) against the UNCL 4461 payment-means list.
    inv.payment_means_codes = [
        _norm_space(_text(el)) or ""
        for el in root.findall(
            ".//ram:SpecifiedTradeSettlementPaymentMeans/ram:TypeCode", NS)
    ]
    # BR-CL-19 / BR-CL-20 context = ram:SpecifiedTradeAllowanceCharge split by
    # ram:ChargeIndicator/udt:Indicator: false() -> allowance reason (UNCL 5189,
    # BR-CL-19), true() -> charge reason (UNCL 7161, BR-CL-20). The pattern
    # matches an allowance/charge at ANY depth, so document- (settlement) AND
    # line-level (SpecifiedLineTradeSettlement) are both covered.
    for ac_el in root.findall(".//ram:SpecifiedTradeAllowanceCharge", NS):
        ind = _norm_space(_text(
            ac_el.find("ram:ChargeIndicator/udt:Indicator", NS)))
        codes = [_norm_space(_text(el)) or ""
                 for el in ac_el.findall("ram:ReasonCode", NS)]
        if ind in ("true", "1"):
            inv.charge_reason_codes.extend(codes)
        elif ind in ("false", "0"):
            inv.allowance_reason_codes.extend(codes)
    # BR-CL-21 context = ram:SpecifiedTradeProduct/ram:GlobalID[@schemeID] (CII);
    # only elements CARRYING @schemeID are context nodes. The rule tests
    # normalize-space(@schemeID) against the ISO 6523 ICD list.
    inv.item_std_id_scheme_ids = [
        _norm_space(el.get("schemeID"))
        for el in root.findall(
            ".//ram:SpecifiedTradeProduct/ram:GlobalID", NS)
        if el.get("schemeID") is not None
    ]
    # BR-CL-24 context = ram:AttachmentBinaryObject[@mimeCode] (CII). Direct
    # equality of the RAW @mimeCode against the six MIME literals (no
    # normalize-space), mirroring the official assert.
    inv.mime_codes = [
        el.get("mimeCode")
        for el in root.findall(".//ram:AttachmentBinaryObject", NS)
        if el.get("mimeCode") is not None
    ]

    # --- BR-23/52/53/54/56/64/65/CO-03/CO-09/CO-19 context extraction (CII) - #
    # BR-52 context = //ram:AdditionalReferencedDocument (BG-24, any depth —
    # header AND line references). Test:
    # ``normalize-space(ram:IssuerAssignedID) != ''`` over the FIRST child.
    for ard_el in root.findall(".//ram:AdditionalReferencedDocument", NS):
        id_el = ard_el.find("ram:IssuerAssignedID", NS)
        inv.supporting_doc_refs.append(
            _norm_space(_strval(id_el)) if id_el is not None else "")
    # BR-53 (CII): context = //ram:SpecifiedTradeSettlementHeaderMonetary
    # Summation; the test reads the settlement's TaxCurrencyCode and
    # InvoiceCurrencyCode via ABSOLUTE paths and the context node's own
    # ram:TaxTotalAmount/@currencyID. All comparisons are over RAW values.
    _settle_path = ("rsm:SupplyChainTradeTransaction/"
                    "ram:ApplicableHeaderTradeSettlement")
    inv.tax_currency_codes_raw = [
        _strval(el)
        for el in root.findall(_settle_path + "/ram:TaxCurrencyCode", NS)]
    inv.cii_invoice_currency_codes_raw = [
        _strval(el)
        for el in root.findall(_settle_path + "/ram:InvoiceCurrencyCode", NS)]
    inv.cii_summation_taxtotal_currencies = [
        [tta.get("currencyID")
         for tta in summ.findall("ram:TaxTotalAmount", NS)
         if tta.get("currencyID") is not None]
        for summ in root.findall(
            ".//ram:SpecifiedTradeSettlementHeaderMonetarySummation", NS)]
    # BR-54 context = //ram:ApplicableProductCharacteristic (BG-32). Test:
    # ``(ram:Description) and (ram:Value)`` — child-element existence.
    for apc_el in root.findall(".//ram:ApplicableProductCharacteristic", NS):
        inv.item_attributes.append(
            (apc_el.find("ram:Description", NS) is not None,
             apc_el.find("ram:Value", NS) is not None))
    # BR-56 context = //ram:SellerTaxRepresentativeTradeParty (BG-11). Test:
    # ``normalize-space(ram:SpecifiedTaxRegistration/ram:ID[@schemeID='VA'])
    # != ''`` — the VA-scheme ID must exist AND be non-empty (unlike the UBL
    # pure-existence binding; the @schemeID='VA' predicate compares RAW).
    # The same context node carries BR-18 (``normalize-space(ram:Name) != ''``),
    # BR-19 (``(ram:PostalTradeAddress)``) and — unlike the UBL binding, where
    # BR-20's context is the PostalAddress itself — BR-20
    # (``normalize-space(ram:PostalTradeAddress/ram:CountryID) != ''``,
    # evaluated per PARTY even when the address is absent), so one
    # ``taxrep_postal_addresses`` entry is appended per party (None when the
    # address or its CountryID is missing — the path string-values to '').
    for trp_el in root.findall(".//ram:SellerTaxRepresentativeTradeParty", NS):
        va_ids = [id_el for id_el in trp_el.findall(
                      "ram:SpecifiedTaxRegistration/ram:ID", NS)
                  if id_el.get("schemeID") == "VA"]
        inv.taxrep_vat_ids_ok.append(
            bool(va_ids) and bool(_norm_space(_strval(va_ids[0]))))
        name_el = trp_el.find("ram:Name", NS)
        inv.tax_representatives.append(TaxRepresentative(
            _strval(name_el) if name_el is not None else None,
            trp_el.find("ram:PostalTradeAddress", NS) is not None))
        cc_el = trp_el.find("ram:PostalTradeAddress/ram:CountryID", NS)
        inv.taxrep_postal_addresses.append(
            _strval(cc_el) if cc_el is not None else None)
    # BR-64 context = //ram:IncludedSupplyChainTradeLineItem. Test:
    # ``normalize-space(ram:SpecifiedTradeProduct/ram:GlobalID/@schemeID) != ''
    #   or not(ram:SpecifiedTradeProduct/ram:GlobalID)`` — one verdict per line
    # WITH a GlobalID (lines without one hold via the second disjunct).
    for line_el in root.findall(
            ".//ram:IncludedSupplyChainTradeLineItem", NS):
        gids = line_el.findall("ram:SpecifiedTradeProduct/ram:GlobalID", NS)
        if gids:
            inv.item_std_ids_scheme_ok.append(
                bool(_norm_space(gids[0].get("schemeID") or "")))
    # BR-65 context = //ram:DesignatedProductClassification. Test:
    # ``normalize-space(ram:ClassCode/@listID) != '' or not(ram:ClassCode)``.
    for dpc_el in root.findall(".//ram:DesignatedProductClassification", NS):
        ccs = dpc_el.findall("ram:ClassCode", NS)
        if ccs:
            inv.item_class_ids_scheme_ok.append(
                bool(_norm_space(ccs[0].get("listID") or "")))
    # BR-CO-03 (CII): the test is GLOBAL — ``//ram:TaxPointDate`` (BT-7) and
    # ``//ram:DueDateTypeCode`` (BT-8) — evaluated per VAT-breakdown row
    # (the rule's context; the rules layer gates on all_tax_subtotals).
    inv.has_tax_point_date = root.find(".//ram:TaxPointDate", NS) is not None
    inv.has_tax_point_date_code = (
        root.find(".//ram:DueDateTypeCode", NS) is not None)
    # BR-CO-09 context = //ram:SpecifiedTaxRegistration/ram:ID[@schemeID='VA'].
    # The tested value is ``substring(., 1, 2)`` — raw first two characters.
    for id_el in root.findall(".//ram:SpecifiedTaxRegistration/ram:ID", NS):
        if id_el.get("schemeID") == "VA":
            inv.vat_id_prefixes.append(_strval(id_el)[:2])
    # BR-CO-19 context = //ram:ApplicableHeaderTradeSettlement/
    # ram:BillingSpecifiedPeriod (BG-14). Test: ``(ram:StartDateTime) or
    # (ram:EndDateTime)`` — element existence.
    for period_el in root.findall(
            ".//ram:ApplicableHeaderTradeSettlement/"
            "ram:BillingSpecifiedPeriod", NS):
        inv.invoice_period_filled.append(
            period_el.find("ram:StartDateTime", NS) is not None
            or period_el.find("ram:EndDateTime", NS) is not None)
    # BR-CO-20 context = //ram:SpecifiedLineTradeSettlement/
    # ram:BillingSpecifiedPeriod (BG-26, the LINE billing period). Test:
    # ``(ram:StartDateTime) or (ram:EndDateTime)`` — element existence.
    for period_el in root.findall(
            ".//ram:SpecifiedLineTradeSettlement/"
            "ram:BillingSpecifiedPeriod", NS):
        inv.line_period_filled.append(
            period_el.find("ram:StartDateTime", NS) is not None
            or period_el.find("ram:EndDateTime", NS) is not None)
    # BR-29 context = //ram:ApplicableHeaderTradeSettlement/
    # ram:BillingSpecifiedPeriod (BG-14): end >= start over the @format='102'
    # DateTimeStrings whenever both bound ELEMENTS exist (see _period_bound
    # for the exact transcription onto the shared Period model). The line
    # periods (BR-30) are collected per line in the line loop below.
    for period_el in root.findall(
            ".//ram:ApplicableHeaderTradeSettlement/"
            "ram:BillingSpecifiedPeriod", NS):
        inv.invoice_periods.append(Period(
            _period_bound(period_el, "StartDateTime"),
            _period_bound(period_el, "EndDateTime")))
    # BR-17 context = //ram:PayeeTradeParty (BG-10). Test: ``(ram:Name) and
    # (not(ram:Name = ../../ram:ApplicableHeaderTradeAgreement/
    # ram:SellerTradeParty/ram:Name) and not(ram:ID = .../ram:ID) and
    # not(ram:SpecifiedLegalOrganization/ram:ID = .../ram:SpecifiedLegal
    # Organization/ram:ID))`` — the seller node sets are resolved via the
    # ``../..`` axis (the payee's grandparent, rsm:SupplyChainTradeTransaction
    # in a real document), all general comparisons over RAW string values.
    _payee_tag = "{%s}PayeeTradeParty" % NS_RAM
    _pmap = None
    for el in root.iter(_payee_tag):
        if _pmap is None:
            _pmap = {c: p for p in root.iter() for c in p}
        gp = _pmap.get(_pmap.get(el))
        _seller_path = ("ram:ApplicableHeaderTradeAgreement/"
                        "ram:SellerTradeParty/")
        inv.payee_parties.append(PayeeParty(
            [_strval(e) for e in el.findall("ram:Name", NS)],
            [_strval(e) for e in el.findall("ram:ID", NS)],
            [_strval(e) for e in gp.findall(_seller_path + "ram:Name", NS)]
            if gp is not None else [],
            [_strval(e) for e in gp.findall(_seller_path + "ram:ID", NS)]
            if gp is not None else [],
            [_strval(e) for e in el.findall(
                "ram:SpecifiedLegalOrganization/ram:ID", NS)],
            [_strval(e) for e in gp.findall(
                _seller_path + "ram:SpecifiedLegalOrganization/ram:ID", NS)]
            if gp is not None else []))
    # BR-CO-26 context = //ram:SellerTradeParty. Test (four disjuncts, pure
    # existence except the RAW @schemeID='VA' predicate): ``(ram:ID) or
    # (ram:GlobalID) or (ram:SpecifiedLegalOrganization/ram:ID) or
    # (ram:SpecifiedTaxRegistration/ram:ID[@schemeID='VA'])``.
    for seller_el in root.findall(".//ram:SellerTradeParty", NS):
        inv.seller_identification_ok.append(
            seller_el.find("ram:ID", NS) is not None
            or seller_el.find("ram:GlobalID", NS) is not None
            or seller_el.find(
                "ram:SpecifiedLegalOrganization/ram:ID", NS) is not None
            or any(id_el.get("schemeID") == "VA"
                   for id_el in seller_el.findall(
                       "ram:SpecifiedTaxRegistration/ram:ID", NS)))

    # --- Payment / references / deliver-to / endpoints batch (T-VHCIIP.3) --- #
    # BR-49 context = //ram:SpecifiedTradeSettlementPaymentMeans (BG-16); test
    # ``(ram:TypeCode)`` — element existence per payment means group.
    # BR-50/BR-61 context = //ram:SpecifiedTradeSettlementPaymentMeans
    # [ram:TypeCode='30' or ram:TypeCode='58']/ram:PayeePartyCreditorFinancial
    # Account — the context predicate compares the RAW TypeCode string values
    # (kept in ``codes_raw``), and the rules are evaluated PER ACCOUNT node:
    #   BR-50 test: normalize-space(ram:IBANID) != '' or
    #               normalize-space(ram:ProprietaryID) != ''  (non-empty value)
    #   BR-61 test: (ram:IBANID) or (ram:ProprietaryID)       (pure existence)
    # Each ``account_first_ids`` entry bakes BOTH facts in: None when neither
    # element exists (BR-61's CII branch fires; BR-50 sees ''), else the first
    # non-empty normalize-space of the two ('' when both are present-but-empty
    # or whitespace — BR-50 fires, BR-61 holds). NOTE the CII BR-61 binding
    # differs from UBL: a credit-transfer payment means with NO account group
    # carries no context node, so nothing fires (rules.br_61 branches on
    # inv.syntax and transcribes this exactly).
    for pm_el in root.findall(".//ram:SpecifiedTradeSettlementPaymentMeans",
                              NS):
        code_els = pm_el.findall("ram:TypeCode", NS)
        codes_raw = [_strval(e) for e in code_els]
        account_first_ids = []
        has_account_id = False
        for acct_el in pm_el.findall("ram:PayeePartyCreditorFinancialAccount",
                                     NS):
            iban_el = acct_el.find("ram:IBANID", NS)
            prop_el = acct_el.find("ram:ProprietaryID", NS)
            if iban_el is None and prop_el is None:
                account_first_ids.append(None)
            else:
                has_account_id = True
                iban = _norm_space(_strval(iban_el)) if iban_el is not None else ""
                prop = _norm_space(_strval(prop_el)) if prop_el is not None else ""
                account_first_ids.append(iban or prop)
        inv.payment_means.append(parser.PaymentMeans(
            bool(code_els),
            _norm_space(codes_raw[0]) if codes_raw else "",
            codes_raw,
            has_account_id,
            account_first_ids))
    # BR-51 context = //ram:ApplicableTradeSettlementFinancialCard (BG-18);
    # test ``string-length(normalize-space(ram:ID)) <= 10``. An absent ram:ID
    # string-values to '' (length 0, holds), so '' is appended then.
    for card_el in root.findall(
            ".//ram:ApplicableTradeSettlementFinancialCard", NS):
        id_el = card_el.find("ram:ID", NS)
        inv.card_pans.append(_strval(id_el) if id_el is not None else "")
    # BR-55 context = /rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction/
    # ram:ApplicableHeaderTradeSettlement/ram:InvoiceReferencedDocument (BG-3);
    # test ``normalize-space(ram:IssuerAssignedID) != ''`` — non-empty required
    # (the UBL binding is pure existence; each parser bakes its own semantics
    # into the bool, exactly like taxrep_vat_ids_ok).
    for ird_el in root.findall(
            "rsm:SupplyChainTradeTransaction/ram:ApplicableHeaderTradeSettlement/"
            "ram:InvoiceReferencedDocument", NS):
        id_el = ird_el.find("ram:IssuerAssignedID", NS)
        inv.billing_references.append(
            id_el is not None and bool(_norm_space(_strval(id_el))))
    # BR-57 context = /rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction/
    # ram:ApplicableHeaderTradeDelivery (BG-13/BG-15); test:
    #   (ram:ShipToTradeParty/ram:PostalTradeAddress and
    #    normalize-space(ram:ShipToTradeParty/ram:PostalTradeAddress/
    #                    ram:CountryID) != '')
    #   or not (ram:ShipToTradeParty/ram:PostalTradeAddress)
    # One verdict per header delivery WITH a deliver-to postal address; the
    # normalize-space operand is the FIRST CountryID of that path node set.
    for dlv_el in root.findall(
            "rsm:SupplyChainTradeTransaction/ram:ApplicableHeaderTradeDelivery",
            NS):
        if dlv_el.findall(
                "ram:ShipToTradeParty/ram:PostalTradeAddress", NS):
            cc_els = dlv_el.findall(
                "ram:ShipToTradeParty/ram:PostalTradeAddress/ram:CountryID",
                NS)
            inv.delivery_addresses.append(
                bool(cc_els) and bool(_norm_space(_strval(cc_els[0]))))
    # BR-62 / BR-63 (context = the document root): the Seller/Buyer electronic
    # address (BT-34/BT-49). Test per party:
    #   normalize-space(...ram:URIUniversalCommunication[1]/ram:URIID/@schemeID)
    #     != ''  or  not (...ram:URIUniversalCommunication)
    # — evaluated over the FIRST ram:URIUniversalCommunication only, and the
    # @schemeID must be NON-EMPTY after normalize-space (the UBL binding is
    # attribute existence; each parser bakes its own semantics into the bool).
    for party_path, endpoints in (
            ("rsm:SupplyChainTradeTransaction/ram:ApplicableHeaderTradeAgreement/"
             "ram:SellerTradeParty", inv.seller_endpoints),
            ("rsm:SupplyChainTradeTransaction/ram:ApplicableHeaderTradeAgreement/"
             "ram:BuyerTradeParty", inv.buyer_endpoints)):
        party_el = root.find(party_path, NS)
        if party_el is None:
            continue
        uri_els = party_el.findall("ram:URIUniversalCommunication", NS)
        if uri_els:
            uid_el = uri_els[0].find("ram:URIID", NS)
            scheme = uid_el.get("schemeID") if uid_el is not None else None
            endpoints.append(bool(_norm_space(scheme or "")))

    # -- BT-24 Specification identifier (ExchangedDocumentContext) ----------
    inv.customization_id = _text(root.find(
        "rsm:ExchangedDocumentContext/"
        "ram:GuidelineSpecifiedDocumentContextParameter/ram:ID", NS))

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
                inv.seller_has_postal_address = (
                    seller.find("ram:PostalTradeAddress", NS) is not None)
                inv.seller_country_code = _norm_space(_text(
                    seller.find(
                        "ram:PostalTradeAddress/ram:CountryID", NS)))  # BT-40
                # BT-31/32 Seller VAT / tax registration id. BR-S/Z/E-02..04's
                # seller disjunct accepts a SpecifiedTaxRegistration ID whose
                # schemeID is VA (VAT) or FC (tax registration); the VAT-scoped
                # rules (BR-IC-*) require VA only. We reuse the UBL attribute
                # names: ``seller_has_party_tax_scheme_company_id`` = VA-or-FC
                # (the scheme-agnostic seller id), ``seller_has_vat_scheme_company_id``
                # = VA only.
                inv.seller_has_party_tax_scheme_company_id = _has_tax_reg(
                    seller, ("VA", "FC"))
                inv.seller_has_vat_scheme_company_id = _has_tax_reg(
                    seller, ("VA",))
            # BT-63 Seller tax representative VAT id.
            taxrep = agreement.find("ram:SellerTaxRepresentativeTradeParty", NS)
            if taxrep is not None:
                inv.taxrep_has_vat_company_id = _has_tax_reg(taxrep, ("VA",))
            buyer = agreement.find("ram:BuyerTradeParty", NS)
            if buyer is not None:
                inv.buyer_name = _text(buyer.find("ram:Name", NS))    # BT-44
                inv.buyer_has_postal_address = (
                    buyer.find("ram:PostalTradeAddress", NS) is not None)
                inv.buyer_country_code = _norm_space(_text(
                    buyer.find(
                        "ram:PostalTradeAddress/ram:CountryID", NS)))  # BT-55
                inv.buyer_has_vat_scheme_company_id = _has_tax_reg(
                    buyer, ("VA",))                                   # BT-48
                inv.buyer_has_legal_entity_company_id = (
                    buyer.find(
                        "ram:SpecifiedLegalOrganization/ram:ID", NS)
                    is not None)                                     # BT-47

        # Header trade settlement -> currency + document monetary totals +
        # VAT breakdown + document allowances/charges + payment means.
        settlement = txn.find("ram:ApplicableHeaderTradeSettlement", NS)
        if settlement is not None:
            inv.document_currency_code = _text(
                settlement.find("ram:InvoiceCurrencyCode", NS))       # BT-5

            summation = settlement.find(
                "ram:SpecifiedTradeSettlementHeaderMonetarySummation", NS)
            if summation is not None:
                inv.has_header_monetary_summation = True
                inv.has_legal_monetary_total = True
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
                # Raw (unstripped) totals, keyed by the UBL LegalMonetaryTotal
                # local names the BR-DEC-* rules index by, mapped from the CII
                # summation elements — so BR-DEC-09..18 run unchanged.
                for ubl_local, cii_local in (
                        ("LineExtensionAmount", "LineTotalAmount"),
                        ("AllowanceTotalAmount", "AllowanceTotalAmount"),
                        ("ChargeTotalAmount", "ChargeTotalAmount"),
                        ("TaxExclusiveAmount", "TaxBasisTotalAmount"),
                        ("TaxInclusiveAmount", "GrandTotalAmount"),
                        ("PrepaidAmount", "TotalPrepaidAmount"),
                        ("PayableRoundingAmount", "RoundingAmount"),
                        ("PayableAmount", "DuePayableAmount")):
                    inv.lmt_raw[ubl_local] = _rawtext(
                        summation.find("ram:%s" % cii_local, NS))

            # VAT breakdown (BG-23): the document-level ram:ApplicableTradeTax
            # rows. Both the per-subtotal rules (all_tax_subtotals) and the
            # accounting-VAT rules (tax_totals) consume this one node set; we
            # synthesize a single TaxTotal carrying BT-110 (the doc-currency VAT
            # total) so BR-CO-14/15/18 read it exactly like the UBL cac:TaxTotal.
            breakdown = [_build_trade_tax_subtotal(el)
                         for el in settlement.findall(
                             "ram:ApplicableTradeTax", NS)]
            inv.all_tax_subtotals = list(breakdown)
            if breakdown or inv.tax_total_amount is not None:
                tt = TaxTotal()
                tt.tax_amount = inv.tax_total_amount           # BT-110
                tt.tax_amount_currency = inv.tax_total_amount_currency
                tt.subtotals = list(breakdown)
                inv.tax_totals = [tt]

            # Document-level allowances/charges (BG-20/BG-21).
            for ac_el in settlement.findall(
                    "ram:SpecifiedTradeAllowanceCharge", NS):
                cat = _text(ac_el.find(
                    "ram:CategoryTradeTax/ram:CategoryCode", NS))
                if cat is not None:
                    inv.doc_allowance_charge_category_ids.append(cat)
                inv.doc_allowance_charges.append(
                    _build_doc_allowance_charge(ac_el))

        # Invoice lines (BG-25).
        for i, ln_el in enumerate(
                txn.findall("ram:IncludedSupplyChainTradeLineItem", NS),
                start=1):
            ln = CIILine(i)
            # BG-26 Invoice line period (BR-DE-TMP-32's per-line disjunct).
            ln.has_line_billing_period = (
                ln_el.find("ram:SpecifiedLineTradeSettlement/"
                           "ram:BillingSpecifiedPeriod", NS) is not None)
            # BR-30 context = //ram:SpecifiedLineTradeSettlement/
            # ram:BillingSpecifiedPeriod: the same end >= start test as BR-29,
            # scoped to the line periods (see _period_bound).
            for period_el in ln_el.findall(
                    "ram:SpecifiedLineTradeSettlement/"
                    "ram:BillingSpecifiedPeriod", NS):
                ln.periods.append(Period(
                    _period_bound(period_el, "StartDateTime"),
                    _period_bound(period_el, "EndDateTime")))
            ln.id = _text(ln_el.find(
                "ram:AssociatedDocumentLineDocument/ram:LineID", NS))  # BT-126
            ln.quantity = _text(ln_el.find(
                "ram:SpecifiedLineTradeDelivery/ram:BilledQuantity", NS))  # BT-129
            # BR-23 (CII test, per line): effective boolean value of
            # ram:SpecifiedLineTradeDelivery/ram:BilledQuantity/@unitCode —
            # attribute existence (an empty unitCode="" satisfies it).
            ln.has_quantity_unit_code = any(
                q_el.get("unitCode") is not None
                for q_el in ln_el.findall(
                    "ram:SpecifiedLineTradeDelivery/ram:BilledQuantity", NS))
            lea_el = ln_el.find(
                "ram:SpecifiedLineTradeSettlement/"
                "ram:SpecifiedTradeSettlementLineMonetarySummation/"
                "ram:LineTotalAmount", NS)                             # BT-131
            ln.line_extension_amount = _text(lea_el)
            ln.line_extension_amount_raw = _rawtext(lea_el)
            ln.price_amount = _text(ln_el.find(
                "ram:SpecifiedLineTradeAgreement/"
                "ram:NetPriceProductTradePrice/ram:ChargeAmount", NS))  # BT-146
            # BT-148 Item gross price: CII carries one GrossPriceProductTradePrice
            # ChargeAmount (BR-28 uses a single value). Keep as a list to match
            # the UBL model's ``price_base_amounts`` sequence.
            gross = ln_el.find(
                "ram:SpecifiedLineTradeAgreement/"
                "ram:GrossPriceProductTradePrice/ram:ChargeAmount", NS)
            if gross is not None:
                ln.price_base_amounts = [_text(gross)]
            ln.item_name = _text(ln_el.find(
                "ram:SpecifiedTradeProduct/ram:Name", NS))            # BT-153
            # BG-30 Invoiced item VAT (line-level ram:ApplicableTradeTax).
            for cat_el in ln_el.findall(
                    "ram:SpecifiedLineTradeSettlement/"
                    "ram:ApplicableTradeTax", NS):
                code = _norm_space(_text(cat_el.find("ram:CategoryCode", NS)))
                if code is not None:
                    ln.tax_category_ids.append(code)
                ln.item_tax_categories.append(
                    _build_trade_tax_category(cat_el))
            # Invoice line allowance/charge (BG-27/BG-28) — the official CII
            # contexts are //ram:SpecifiedLineTradeSettlement/
            # ram:SpecifiedTradeAllowanceCharge (BR-41..44, BR-CO-23/24,
            # BR-DEC-24/25/27/28). Same element vocabulary as the document
            # level, so the shared builder applies (ActualAmount[1] = the
            # first ram:ActualAmount, exactly what find() returns).
            for ac_el in ln_el.findall(
                    "ram:SpecifiedLineTradeSettlement/"
                    "ram:SpecifiedTradeAllowanceCharge", NS):
                ln.allowance_charges.append(_build_doc_allowance_charge(ac_el))
            inv.lines.append(ln)

    _build_cii_br_de(inv, root)
    return inv


def _has_tax_reg_nonempty(party_el, schemes):
    """True iff ``party_el`` carries a ``ram:SpecifiedTaxRegistration/ram:ID`` with
    ``normalize-space(@schemeID)`` in ``schemes`` AND a non-empty value — the exact
    BR-DE-16 seller-VAT-id disjunct (``ram:ID[normalize-space(@schemeID)='VA' or
    normalize-space(@schemeID)='FC'][boolean(normalize-space(.))]``)."""
    if party_el is None:
        return False
    for id_el in party_el.findall("ram:SpecifiedTaxRegistration/ram:ID", NS):
        sid = _norm_space(id_el.get("schemeID"))
        if sid in schemes and (id_el.text or "").strip():
            return True
    return False


def _build_cii_br_de(inv, root):
    """Populate the German-CIUS (BR-DE-*) surface the CII XRechnung layer reads.

    Every attribute is transcribed from the OFFICIAL XRechnung-CII Schematron
    (corpus/xrechnung-schematron/schematron/cii/XRechnung-CII-validation.sch)
    rule contexts/paths, so the CII BR-DE rules in
    :mod:`einvoice.rules_xrechnung` (``CII_DE_RULES``) reach exact parity with it
    (proven by ``differential.py xrechnung-cii``)."""
    # $isCVD gate (cii-cvd-pattern): every Guideline…/ram:ID text value.
    # Populated before the transaction guard — the ExchangedDocumentContext
    # lives outside rsm:SupplyChainTradeTransaction.
    for gid in root.findall(
            "rsm:ExchangedDocumentContext/"
            "ram:GuidelineSpecifiedDocumentContextParameter/ram:ID", NS):
        inv.guideline_ids.append(gid.text or "")
    txn = root.find("rsm:SupplyChainTradeTransaction", NS)
    if txn is None:
        return
    inv.has_supply_chain_transaction = True
    # CVD line surface: one record per IncludedSupplyChainTradeLineItem (the
    # BR-TMP-3 / BR-DE-CVD line contexts), independent of inv.lines.
    for ln_el in txn.findall("ram:IncludedSupplyChainTradeLineItem", NS):
        product_el = ln_el.find("ram:SpecifiedTradeProduct", NS)
        if product_el is None:
            inv.trade_products.append(None)
        else:
            class_codes = [
                CIIClassCode(cc.get("listID"), cc.text or "")
                for cc in product_el.findall(
                    "ram:DesignatedProductClassification/ram:ClassCode", NS)]
            characteristics = [
                CIICharacteristic(
                    [d.text or "" for d in ch.findall("ram:Description", NS)],
                    [v.text or "" for v in ch.findall("ram:Value", NS)])
                for ch in product_el.findall(
                    "ram:ApplicableProductCharacteristic", NS)]
            inv.trade_products.append(
                CIITradeProduct(class_codes, characteristics))
        line_agreement = ln_el.find("ram:SpecifiedLineTradeAgreement", NS)
        gross, net = [], []
        if line_agreement is not None:
            for tag, dst in (("GrossPriceProductTradePrice", gross),
                             ("NetPriceProductTradePrice", net)):
                for bq in line_agreement.findall(
                        "ram:%s/ram:BasisQuantity" % tag, NS):
                    dst.append((bq.text or "", bq.get("unitCode")))
        inv.line_prices.append(CIIPriceQuantities(gross, net))
    agreement = txn.find("ram:ApplicableHeaderTradeAgreement", NS)
    settlement = txn.find("ram:ApplicableHeaderTradeSettlement", NS)
    delivery = txn.find("ram:ApplicableHeaderTradeDelivery", NS)

    # BR-DE-1: PAYMENT INSTRUCTIONS (BG-16) present.
    if settlement is not None:
        inv.has_payment_means = (
            settlement.find("ram:SpecifiedTradeSettlementPaymentMeans", NS)
            is not None)
        # BR-DE-26: PRECEDING INVOICE REFERENCE (BG-3).
        inv.has_invoice_referenced_document = (
            settlement.find("ram:InvoiceReferencedDocument", NS) is not None)
        # BR-DE-TMP-32: BG-14 Invoicing period.
        inv.has_billing_period = (
            settlement.find("ram:BillingSpecifiedPeriod", NS) is not None)

    if agreement is not None:
        inv.has_header_trade_agreement = True
        # BR-DE-CVD-01: BT-12 Contract reference.
        for cr in agreement.findall(
                "ram:ContractReferencedDocument/ram:IssuerAssignedID", NS):
            inv.contract_reference_ids.append(cr.text or "")
        # BR-DE-CVD-02 / BR-TMP-2: header AdditionalReferencedDocument node sets.
        for doc in agreement.findall("ram:AdditionalReferencedDocument", NS):
            inv.header_ref_docs.append(CIIRefDoc(
                [t.text or "" for t in doc.findall("ram:TypeCode", NS)],
                [i.text or "" for i in doc.findall("ram:IssuerAssignedID", NS)],
                [u.text or "" for u in doc.findall("ram:URIID", NS)]))
        # BR-DE-16: SELLER TAX REPRESENTATIVE PARTY (BG-11) present.
        inv.has_tax_representative = (
            agreement.find("ram:SellerTaxRepresentativeTradeParty", NS)
            is not None)
        seller = agreement.find("ram:SellerTradeParty", NS)
        if seller is not None:
            inv.seller_party_present = True
            inv.seller_has_defined_trade_contact = (
                seller.find("ram:DefinedTradeContact", NS) is not None)
            addr = seller.find("ram:PostalTradeAddress", NS)
            if addr is not None:
                inv.seller_city = _rawtext(addr.find("ram:CityName", NS))
                inv.seller_post_code = _rawtext(
                    addr.find("ram:PostcodeCode", NS))
            for c in seller.findall("ram:DefinedTradeContact", NS):
                inv.seller_defined_trade_contacts.append(CIIContact(
                    person_name=_rawtext(c.find("ram:PersonName", NS)),
                    department_name=_rawtext(c.find("ram:DepartmentName", NS)),
                    telephone=_rawtext(c.find(
                        "ram:TelephoneUniversalCommunication/"
                        "ram:CompleteNumber", NS)),
                    email=_rawtext(c.find(
                        "ram:EmailURIUniversalCommunication/ram:URIID", NS)),
                ))
            inv.seller_vat_or_fc_id_present = _has_tax_reg_nonempty(
                seller, ("VA", "FC"))
        buyer = agreement.find("ram:BuyerTradeParty", NS)
        if buyer is not None:
            baddr = buyer.find("ram:PostalTradeAddress", NS)
            if baddr is not None:
                inv.buyer_city = _rawtext(baddr.find("ram:CityName", NS))
                inv.buyer_post_code = _rawtext(
                    baddr.find("ram:PostcodeCode", NS))

    if delivery is not None:
        # BR-DE-10/11: each ShipToTradeParty/PostalTradeAddress is a rule context.
        for shipto in delivery.findall("ram:ShipToTradeParty", NS):
            for a in shipto.findall("ram:PostalTradeAddress", NS):
                inv.shipto_postal_addresses.append((
                    _rawtext(a.find("ram:CityName", NS)),
                    _rawtext(a.find("ram:PostcodeCode", NS))))
        # BR-DE-TMP-32: BT-72 Actual delivery date.
        inv.has_actual_delivery_date = (
            delivery.find("ram:ActualDeliverySupplyChainEvent/"
                          "ram:OccurrenceDateTime", NS) is not None)


def _has_tax_reg(party_el, schemes):
    """True iff ``party_el`` carries a ``ram:SpecifiedTaxRegistration/ram:ID``
    whose ``@schemeID`` is one of ``schemes`` — the CII form of the party VAT /
    tax-registration id disjuncts (BT-31/32/48/63)."""
    if party_el is None:
        return False
    for id_el in party_el.findall(
            "ram:SpecifiedTaxRegistration/ram:ID", NS):
        if id_el.get("schemeID") in schemes:
            return True
    return False


def parse(path):
    """Convenience: parse ``path`` and return its :class:`Invoice` model."""
    return build_model(parse_file(path))
