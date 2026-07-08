"""UBL Invoice parser -> normalized model.

Python 3 standard library only (xml.etree.ElementTree). No lxml, no pip.

Parses a UBL 2.1 ``Invoice`` document into a small, flat, rule-friendly model.
The model deliberately keeps everything as *text* (or ``None`` when absent) so
that the business rules in :mod:`rules` can decide how to interpret presence,
cardinality and numeric value. Element-location breadcrumbs are attached to the
model so a failing rule can name the offending element.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from collections import namedtuple

# A VAT (Classified)TaxCategory as seen on an invoice line item or on a
# document/line allowance-charge: the normalize-space()d category code (BT-151/
# BT-95/BT-102), the upper-cased TaxScheme/ID, and the raw Percent text
# (BT-152/BT-96/BT-103). Consumed by the Standard-rate rules BR-S-02..07.
ItemTaxCategory = namedtuple("ItemTaxCategory", ["id", "scheme_id", "percent"])

# One cac:InvoicePeriod (BG-14 document level / BG-26 line level): the stripped
# StartDate/EndDate text, or None when the element is ABSENT ("" = present but
# empty — the official BR-29/BR-30 exists() tests distinguish the two).
Period = namedtuple("Period", ["start", "end"])

# ---------------------------------------------------------------------------
# Namespaces
# ---------------------------------------------------------------------------
NS_INVOICE = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
NS_CAC = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
NS_CBC = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"

NS = {"ubl": NS_INVOICE, "cac": NS_CAC, "cbc": NS_CBC}


class NotWellFormed(Exception):
    """Raised when the input is not well-formed XML (maps to CLI exit code 3)."""


def _text(el):
    """Return stripped text of an element, or None if the element is absent."""
    if el is None:
        return None
    return (el.text or "").strip()


def _rawtext(el):
    """Return the element's raw text (whitespace preserved), or None if absent.

    The BR-DEC-* decimal rules count characters after the '.' of the literal
    string value (``string-length(substring-after(., '.'))``), where trailing
    whitespace counts — so those rules must see the unstripped text.
    """
    if el is None:
        return None
    return el.text or ""


def _norm_space(text):
    """XPath normalize-space(): trim + collapse internal whitespace runs."""
    if text is None:
        return None
    return " ".join(text.split())


def _localname(tag):
    """Strip the ``{namespace}`` prefix ElementTree prepends to a tag."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


class InvoiceLine:
    """One ``cac:InvoiceLine`` (BG-25), fields kept as text/None."""

    __slots__ = ("id", "quantity", "line_extension_amount",
                 "line_extension_amount_raw", "price_amount",
                 "price_base_amounts", "periods",
                 "item_name", "tax_category_ids", "item_tax_categories",
                 "allowance_charges", "index")

    def __init__(self, index):
        self.index = index
        self.id = None                    # BT-126
        self.quantity = None              # BT-129 (text)
        self.line_extension_amount = None  # BT-131 (text)
        self.line_extension_amount_raw = None  # BT-131 raw text (BR-DEC-23)
        self.price_amount = None          # BT-146 (text)
        # BT-148 Item gross price: text of EVERY cac:Price/cac:AllowanceCharge/
        # cbc:BaseAmount on this line (the BR-28 node set is a sequence).
        self.price_base_amounts = []      # list[str]
        # BG-26 Invoice line period(s): cac:InvoicePeriod children of the line.
        self.periods = []                 # list[Period]
        self.item_name = None             # BT-153
        self.tax_category_ids = []        # BG-30 ClassifiedTaxCategory/ID codes
        # Full item VAT categories (BG-30): id/scheme/percent per
        # ClassifiedTaxCategory — needed by BR-S-02 (S-line present) and
        # BR-S-05 (S-line VAT rate > 0).
        self.item_tax_categories = []     # list[ItemTaxCategory]
        self.allowance_charges = []       # line-level BG-27/BG-28 (list[AllowanceCharge])

    @property
    def label(self):
        return "cac:InvoiceLine[%d]%s" % (
            self.index, (" id=%r" % self.id) if self.id else "")


class TaxSubtotal:
    __slots__ = ("tax_amount", "tax_amount_raw", "taxable_amount",
                 "taxable_amount_raw", "category_id", "category_scheme_id",
                 "percent", "has_exemption_reason", "has_exemption_reason_code")

    def __init__(self):
        self.tax_amount = None          # BT-117 (text)
        self.tax_amount_raw = None      # BT-117 raw text (BR-DEC-20)
        self.taxable_amount = None      # BT-116 (text)
        self.taxable_amount_raw = None  # BT-116 raw text (BR-DEC-19)
        self.category_id = None         # BT-118 VAT category code
        self.category_scheme_id = None  # TaxCategory/TaxScheme/ID, normalized UPPER
        self.percent = None             # BT-119 (text)
        # exists(cbc:TaxExemptionReason) / exists(cbc:TaxExemptionReasonCode)
        # on the breakdown's TaxCategory (BT-120/BT-121) — BR-S-10.
        self.has_exemption_reason = False
        self.has_exemption_reason_code = False


class TaxTotal:
    __slots__ = ("tax_amount", "tax_amount_currency", "subtotals")

    def __init__(self):
        self.tax_amount = None           # BT-110 (text)
        self.tax_amount_currency = None  # currencyID attribute
        self.subtotals = []              # list[TaxSubtotal]


class AllowanceCharge:
    """One ``cac:AllowanceCharge`` group.

    Used for both the document-level allowance/charge (BG-20/BG-21, direct child
    of the Invoice) and the invoice-line-level allowance/charge (BG-27/BG-28,
    child of a ``cac:InvoiceLine``). The presence flags carry the exact
    ``exists(...)`` facts the EN 16931 allowance/charge rules test.
    """

    __slots__ = ("is_charge", "amount_raw", "base_amount_raw",
                 "has_amount", "has_vat_category_id", "has_reason",
                 "tax_categories")

    def __init__(self):
        self.is_charge = None       # True = charge (BG-21/BG-28), False = allowance
        #                             (BG-20/BG-27), None = no usable ChargeIndicator
        #                             (neither the allowance nor the charge context)
        self.amount_raw = None      # BT-92/BT-99 raw text (BR-DEC-01/05)
        self.base_amount_raw = None  # BT-93/BT-100 raw text (BR-DEC-02/06)
        self.has_amount = False          # exists(cbc:Amount)  — BR-31/36/41/43
        self.has_vat_category_id = False  # exists(VAT-scheme cac:TaxCategory/cbc:ID)
        #                                   — BR-32/37
        self.has_reason = False          # exists(cbc:AllowanceChargeReason)
        #                                   or exists(cbc:AllowanceChargeReasonCode)
        #                                   — BR-33/38/42/44
        # Full VAT categories (id/scheme/percent) on this allowance/charge —
        # BR-S-03/04 (S allowance/charge present) and BR-S-06/07 (S rate > 0).
        self.tax_categories = []         # list[ItemTaxCategory]


def _build_allowance_charge(ac_el):
    """Parse one ``cac:AllowanceCharge`` element into an :class:`AllowanceCharge`.

    Captures the ``exists(...)`` facts the EN 16931 rules test, verbatim to the
    compiled Schematron:

    * ``is_charge`` — the ``cbc:ChargeIndicator = true()/false()`` context split.
      An untyped element atomizes and casts to xs:boolean, so only the four
      lexical booleans count; anything else (absent, "TRUE", junk) matches
      neither the allowance nor the charge context.
    * ``has_amount`` — ``exists(cbc:Amount)`` (pure existence; empty satisfies it).
    * ``has_vat_category_id`` —
      ``exists(cac:TaxCategory[cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']/cbc:ID)``.
    * ``has_reason`` — ``exists(cbc:AllowanceChargeReason)
      or exists(cbc:AllowanceChargeReasonCode)``.
    """
    ac = AllowanceCharge()
    ind = _norm_space(_text(ac_el.find("cbc:ChargeIndicator", NS)))
    if ind in ("true", "1"):
        ac.is_charge = True
    elif ind in ("false", "0"):
        ac.is_charge = False
    amount_el = ac_el.find("cbc:Amount", NS)
    ac.has_amount = amount_el is not None
    ac.amount_raw = _rawtext(amount_el)
    ac.base_amount_raw = _rawtext(ac_el.find("cbc:BaseAmount", NS))
    for cat_el in ac_el.findall("cac:TaxCategory", NS):
        scheme = _norm_space(_text(cat_el.find("cac:TaxScheme/cbc:ID", NS)))
        if (scheme and scheme.upper() == "VAT"
                and cat_el.find("cbc:ID", NS) is not None):
            ac.has_vat_category_id = True
        ac.tax_categories.append(ItemTaxCategory(
            _norm_space(_text(cat_el.find("cbc:ID", NS))),
            scheme.upper() if scheme else None,
            _text(cat_el.find("cbc:Percent", NS))))
    ac.has_reason = (
        ac_el.find("cbc:AllowanceChargeReason", NS) is not None
        or ac_el.find("cbc:AllowanceChargeReasonCode", NS) is not None)
    return ac


def _build_period(period_el):
    """Parse one ``cac:InvoicePeriod`` into a :class:`Period` (None = absent)."""
    return Period(_text(period_el.find("cbc:StartDate", NS)),
                  _text(period_el.find("cbc:EndDate", NS)))


class Invoice:
    """Normalized first-slice model of a UBL Invoice."""

    def __init__(self):
        self.root_is_ubl_invoice = False
        # Header
        self.customization_id = None      # BT-24
        self.id = None                    # BT-1
        self.issue_date = None            # BT-2
        self.invoice_type_code = None     # BT-3
        self.document_currency_code = None  # BT-5
        self.buyer_reference = None       # BT-10
        # Parties
        self.seller_name = None           # BT-27
        self.seller_has_postal_address = False  # BG-5
        self.seller_country_code = None   # BT-40 (normalize-space; None = no addr)
        # exists(//AccountingSupplierParty/Party/PartyTaxScheme/CompanyID) —
        # the Seller VAT/tax-registration id (BT-31/BT-32). NOTE: the official
        # BR-S-02/03/04 seller test is SCHEME-AGNOSTIC (any PartyTaxScheme with
        # a CompanyID satisfies it, not only the VAT one).
        self.seller_has_party_tax_scheme_company_id = False
        # exists(//TaxRepresentativeParty/PartyTaxScheme[VAT]/CompanyID) —
        # the Seller tax representative VAT id (BT-63); VAT scheme IS required
        # here, unlike the seller test above.
        self.taxrep_has_vat_company_id = False
        self.buyer_name = None            # BT-44
        self.buyer_has_postal_address = False  # BG-8
        self.buyer_country_code = None    # BT-55 (normalize-space; None = no addr)
        # Totals
        self.line_extension_total = None  # BT-106
        self.tax_exclusive_amount = None  # BT-109
        self.tax_inclusive_amount = None  # BT-112
        self.payable_amount = None        # BT-115
        self.allowance_total = None       # BT-107
        self.charge_total = None          # BT-108
        self.prepaid_amount = None        # BT-113 (text; None = element absent)
        self.payable_rounding_amount = None  # BT-114 (text; None = element absent)
        self.has_legal_monetary_total = False
        # Raw (unstripped) text of the LegalMonetaryTotal amount children,
        # keyed by local element name — consumed by the BR-DEC-* rules.
        self.lmt_raw = {}
        # BG-14 Invoicing period(s): every cac:InvoicePeriod in the document
        # EXCEPT those inside an invoice/credit-note line — exactly the node
        # set the official BR-29 rule context ends up matching (its Schematron
        # pattern ``cac:InvoicePeriod`` matches any InvoicePeriod, but the
        # line-period rule appears FIRST in the same pattern and captures the
        # line-level ones — first matching rule wins in a Schematron pattern).
        self.invoice_periods = []         # list[Period]
        # Tax + lines
        self.tax_totals = []              # list[TaxTotal]  (top-level only)
        self.all_tax_subtotals = []       # every cac:TaxSubtotal in the document
        self.lines = []                   # list[InvoiceLine]
        # Document-level allowance/charge VAT category codes
        self.doc_allowance_charge_category_ids = []
        # Document-level allowance/charge objects (BG-20/BG-21)
        self.doc_allowance_charges = []   # list[AllowanceCharge]
        # normalize-space()d codes of EVERY cac:TaxCategory / cac:ClassifiedTaxCategory
        # in the document whose TaxScheme/ID is 'VAT' (case-insensitive) — the
        # "//cac:TaxCategory | //cac:ClassifiedTaxCategory" set the VAT-category
        # family rules (BR-AE/E/G/IC/O-01) test against.
        self.vat_category_codes = []

    # -- document-currency tax totals --------------------------------------
    def doc_currency_tax_totals(self):
        """The TaxTotal(s) carrying the accounting VAT figures (BT-110/BG-23).

        A UBL invoice may hold a second TaxTotal expressing the VAT total in a
        different tax currency (BT-111); that one is excluded here. Prefer the
        TaxTotal(s) whose TaxAmount currency matches DocumentCurrencyCode; when
        no currency information is available (minimal rule fragments), fall back
        to all TaxTotals. The EN 16931 Schematron sums/counts across this set,
        so more than one may legitimately be returned.
        """
        if not self.tax_totals:
            return []
        if self.document_currency_code:
            matched = [tt for tt in self.tax_totals
                       if tt.tax_amount_currency == self.document_currency_code]
            if matched:
                return matched
        return list(self.tax_totals)

    # -- category codes across lines + doc-level allowance/charge ----------
    def all_category_ids(self):
        codes = []
        for ln in self.lines:
            codes.extend(ln.tax_category_ids)
        codes.extend(self.doc_allowance_charge_category_ids)
        return codes

    def breakdown_category_ids(self):
        """VAT category codes of the VAT breakdown (BG-23), across all TaxTotals.

        BR-S-01 / BR-Z-01 count the VAT breakdown groups over every
        cac:TaxTotal/cac:TaxSubtotal in the document (the secondary tax-currency
        TaxTotal carries no subtotals, so it contributes nothing).
        """
        codes = []
        for tt in self.tax_totals:
            for st in tt.subtotals:
                if st.category_id is not None:
                    codes.append(st.category_id)
        return codes

    def breakdown_vat_category_codes(self):
        """VAT breakdown (BG-23) codes, restricted to TaxCategory rows whose
        TaxScheme/ID is 'VAT' — the exact node set the official BR-AE/E/G/IC/O-01
        asserts count (``cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[...VAT...]``,
        relative to the Invoice root, i.e. top-level TaxTotals only)."""
        codes = []
        for tt in self.tax_totals:
            for st in tt.subtotals:
                if st.category_scheme_id == "VAT" and st.category_id:
                    codes.append(_norm_space(st.category_id))
        return codes

    # -- Standard-rate (BR-S-*) helpers ------------------------------------
    def all_allowance_charges(self):
        """Every cac:AllowanceCharge in the document (document-level BG-20/21
        AND line-level BG-27/28) — the official BR-S-03/04/06/07 contexts use
        ``//cac:AllowanceCharge``, i.e. any depth."""
        acs = list(self.doc_allowance_charges)
        for ln in self.lines:
            acs.extend(ln.allowance_charges)
        return acs

    def has_classified_category(self, code, scheme="VAT"):
        """True iff any invoice-line item ClassifiedTaxCategory has this
        normalize-space()d code — ``//cac:ClassifiedTaxCategory[normalize-space
        (cbc:ID)=code][VAT]`` when ``scheme='VAT'``, or the scheme-AGNOSTIC
        ``//cac:ClassifiedTaxCategory[normalize-space(cbc:ID)=code]`` when
        ``scheme=None`` (the BR-S-02 last-disjunct node set, which — unlike its
        first disjunct — omits the TaxScheme predicate)."""
        for ln in self.lines:
            for cat in ln.item_tax_categories:
                if cat.id == code and (scheme is None or cat.scheme_id == scheme):
                    return True
        return False

    def seller_has_vat_identifier(self):
        """The BR-S-02/03/04 seller disjunct: a Seller PartyTaxScheme CompanyID
        (any scheme) OR a tax-representative VAT PartyTaxScheme CompanyID."""
        return (self.seller_has_party_tax_scheme_company_id
                or self.taxrep_has_vat_company_id)


def parse_file(path):
    """Parse ``path`` into an (root, ElementTree) pair.

    Raises :class:`NotWellFormed` for parse errors (CLI exit 3).
    """
    try:
        tree = ET.parse(path)
    except ET.ParseError as exc:
        raise NotWellFormed(str(exc))
    return tree.getroot()


def build_model(root):
    """Build an :class:`Invoice` model from a parsed UBL Invoice root."""
    inv = Invoice()
    inv.root_is_ubl_invoice = (
        root.tag == "{%s}Invoice" % NS_INVOICE
        or (_localname(root.tag) == "Invoice"
            and root.tag.startswith("{%s}" % NS_INVOICE))
    )

    # Header scalars
    inv.customization_id = _text(root.find("cbc:CustomizationID", NS))
    inv.id = _text(root.find("cbc:ID", NS))
    inv.issue_date = _text(root.find("cbc:IssueDate", NS))
    inv.invoice_type_code = _text(root.find("cbc:InvoiceTypeCode", NS))
    inv.document_currency_code = _text(root.find("cbc:DocumentCurrencyCode", NS))
    inv.buyer_reference = _text(root.find("cbc:BuyerReference", NS))

    # Seller
    supplier = root.find("cac:AccountingSupplierParty/cac:Party", NS)
    if supplier is not None:
        inv.seller_name = _text(
            supplier.find("cac:PartyLegalEntity/cbc:RegistrationName", NS))
        inv.seller_has_postal_address = (
            supplier.find("cac:PostalAddress", NS) is not None)
        # BR-09 context is the Seller PostalAddress node; its test is
        # normalize-space(cac:Country/cbc:IdentificationCode) != '' — evaluate
        # the country code relative to that address (None when no address).
        inv.seller_country_code = _norm_space(_text(
            supplier.find(
                "cac:PostalAddress/cac:Country/cbc:IdentificationCode", NS)))
        # exists(cac:PartyTaxScheme/cbc:CompanyID) — scheme-agnostic (BR-S-02..04).
        inv.seller_has_party_tax_scheme_company_id = (
            supplier.find("cac:PartyTaxScheme/cbc:CompanyID", NS) is not None)

    # TaxRepresentativeParty (anywhere): a VAT-scheme PartyTaxScheme with a
    # CompanyID satisfies the seller-tax-representative disjunct of BR-S-02..04.
    for trp_el in root.iter("{%s}TaxRepresentativeParty" % NS_CAC):
        for pts_el in trp_el.findall("cac:PartyTaxScheme", NS):
            scheme = _norm_space(_text(pts_el.find("cac:TaxScheme/cbc:ID", NS)))
            if (scheme and scheme.upper() == "VAT"
                    and pts_el.find("cbc:CompanyID", NS) is not None):
                inv.taxrep_has_vat_company_id = True
                break
        if inv.taxrep_has_vat_company_id:
            break

    # Buyer
    customer = root.find("cac:AccountingCustomerParty/cac:Party", NS)
    if customer is not None:
        inv.buyer_name = _text(
            customer.find("cac:PartyLegalEntity/cbc:RegistrationName", NS))
        inv.buyer_has_postal_address = (
            customer.find("cac:PostalAddress", NS) is not None)
        inv.buyer_country_code = _norm_space(_text(
            customer.find(
                "cac:PostalAddress/cac:Country/cbc:IdentificationCode", NS)))

    # LegalMonetaryTotal
    lmt = root.find("cac:LegalMonetaryTotal", NS)
    if lmt is not None:
        inv.has_legal_monetary_total = True
        inv.line_extension_total = _text(lmt.find("cbc:LineExtensionAmount", NS))
        inv.tax_exclusive_amount = _text(lmt.find("cbc:TaxExclusiveAmount", NS))
        inv.tax_inclusive_amount = _text(lmt.find("cbc:TaxInclusiveAmount", NS))
        inv.payable_amount = _text(lmt.find("cbc:PayableAmount", NS))
        inv.allowance_total = _text(lmt.find("cbc:AllowanceTotalAmount", NS))
        inv.charge_total = _text(lmt.find("cbc:ChargeTotalAmount", NS))
        inv.prepaid_amount = _text(lmt.find("cbc:PrepaidAmount", NS))
        inv.payable_rounding_amount = _text(lmt.find("cbc:PayableRoundingAmount", NS))
        for local in ("LineExtensionAmount", "AllowanceTotalAmount",
                      "ChargeTotalAmount", "TaxExclusiveAmount",
                      "TaxInclusiveAmount", "PrepaidAmount",
                      "PayableRoundingAmount", "PayableAmount"):
            inv.lmt_raw[local] = _rawtext(lmt.find("cbc:%s" % local, NS))

    # TaxTotal(s)
    def _parse_subtotal(st_el):
        st = TaxSubtotal()
        ta_el = st_el.find("cbc:TaxAmount", NS)
        tx_el = st_el.find("cbc:TaxableAmount", NS)
        st.tax_amount = _text(ta_el)
        st.tax_amount_raw = _rawtext(ta_el)
        st.taxable_amount = _text(tx_el)
        st.taxable_amount_raw = _rawtext(tx_el)
        cat_el = st_el.find("cac:TaxCategory", NS)
        if cat_el is not None:
            st.category_id = _text(cat_el.find("cbc:ID", NS))
            st.percent = _text(cat_el.find("cbc:Percent", NS))
            scheme = _norm_space(_text(cat_el.find("cac:TaxScheme/cbc:ID", NS)))
            st.category_scheme_id = scheme.upper() if scheme else None
            st.has_exemption_reason = (
                cat_el.find("cbc:TaxExemptionReason", NS) is not None)
            st.has_exemption_reason_code = (
                cat_el.find("cbc:TaxExemptionReasonCode", NS) is not None)
        return st

    for tt_el in root.findall("cac:TaxTotal", NS):
        tt = TaxTotal()
        amount_el = tt_el.find("cbc:TaxAmount", NS)
        tt.tax_amount = _text(amount_el)
        if amount_el is not None:
            tt.tax_amount_currency = amount_el.get("currencyID")
        for st_el in tt_el.findall("cac:TaxSubtotal", NS):
            tt.subtotals.append(_parse_subtotal(st_el))
        inv.tax_totals.append(tt)

    # EVERY TaxSubtotal in the document (the official BR-CO-17 / BR-DEC-19/20
    # context is "cac:TaxTotal/cac:TaxSubtotal" — any depth, not only top-level).
    for st_el in root.iter("{%s}TaxSubtotal" % NS_CAC):
        inv.all_tax_subtotals.append(_parse_subtotal(st_el))

    # Every TaxCategory / ClassifiedTaxCategory with a 'VAT' TaxScheme, anywhere
    # (the "//cac:TaxCategory | //cac:ClassifiedTaxCategory" set of the official
    # VAT-category family rules — this INCLUDES the breakdown's own categories).
    _cat_tags = ("{%s}TaxCategory" % NS_CAC, "{%s}ClassifiedTaxCategory" % NS_CAC)
    for el in root.iter():
        if el.tag not in _cat_tags:
            continue
        scheme = _norm_space(_text(el.find("cac:TaxScheme/cbc:ID", NS)))
        if not scheme or scheme.upper() != "VAT":
            continue
        for id_el in el.findall("cbc:ID", NS):
            code = _norm_space(_text(id_el))
            if code:
                inv.vat_category_codes.append(code)

    # Invoicing period(s) (BG-14): every cac:InvoicePeriod that is NOT the
    # child of an invoice/credit-note line (those are BG-26 / BR-30's context).
    _period_tag = "{%s}InvoicePeriod" % NS_CAC
    _line_tags = ("{%s}InvoiceLine" % NS_CAC, "{%s}CreditNoteLine" % NS_CAC)
    for parent in root.iter():
        if parent.tag in _line_tags:
            continue
        for el in parent:
            if el.tag == _period_tag:
                inv.invoice_periods.append(_build_period(el))

    # Document-level allowance/charge (BG-20/BG-21) — direct children of Invoice.
    for ac_el in root.findall("cac:AllowanceCharge", NS):
        cat = _text(ac_el.find("cac:TaxCategory/cbc:ID", NS))
        if cat is not None:
            inv.doc_allowance_charge_category_ids.append(cat)
        inv.doc_allowance_charges.append(_build_allowance_charge(ac_el))

    # InvoiceLines
    for i, ln_el in enumerate(root.findall("cac:InvoiceLine", NS), start=1):
        ln = InvoiceLine(i)
        ln.id = _text(ln_el.find("cbc:ID", NS))
        ln.quantity = _text(ln_el.find("cbc:InvoicedQuantity", NS))
        lea_el = ln_el.find("cbc:LineExtensionAmount", NS)
        ln.line_extension_amount = _text(lea_el)
        ln.line_extension_amount_raw = _rawtext(lea_el)
        ln.price_amount = _text(ln_el.find("cac:Price/cbc:PriceAmount", NS))
        ln.price_base_amounts = [
            _text(el) for el in ln_el.findall(
                "cac:Price/cac:AllowanceCharge/cbc:BaseAmount", NS)]
        for period_el in ln_el.findall("cac:InvoicePeriod", NS):
            ln.periods.append(_build_period(period_el))
        ln.item_name = _text(ln_el.find("cac:Item/cbc:Name", NS))
        for cat_el in ln_el.findall("cac:Item/cac:ClassifiedTaxCategory/cbc:ID", NS):
            code = _text(cat_el)
            if code is not None:
                ln.tax_category_ids.append(code)
        for cat_el in ln_el.findall("cac:Item/cac:ClassifiedTaxCategory", NS):
            scheme = _norm_space(_text(cat_el.find("cac:TaxScheme/cbc:ID", NS)))
            ln.item_tax_categories.append(ItemTaxCategory(
                _norm_space(_text(cat_el.find("cbc:ID", NS))),
                scheme.upper() if scheme else None,
                _text(cat_el.find("cbc:Percent", NS))))
        # Invoice line allowance/charge (BG-27/BG-28) — the official context is
        # //cac:InvoiceLine/cac:AllowanceCharge, i.e. AllowanceCharge children of
        # the line (UBL InvoiceLines are direct children of the Invoice root).
        for ac_el in ln_el.findall("cac:AllowanceCharge", NS):
            ln.allowance_charges.append(_build_allowance_charge(ac_el))
        inv.lines.append(ln)

    return inv
