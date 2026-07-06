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


def _localname(tag):
    """Strip the ``{namespace}`` prefix ElementTree prepends to a tag."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


class InvoiceLine:
    """One ``cac:InvoiceLine`` (BG-25), fields kept as text/None."""

    __slots__ = ("id", "quantity", "line_extension_amount", "price_amount",
                 "item_name", "tax_category_ids", "index")

    def __init__(self, index):
        self.index = index
        self.id = None                    # BT-126
        self.quantity = None              # BT-129 (text)
        self.line_extension_amount = None  # BT-131 (text)
        self.price_amount = None          # BT-146 (text)
        self.item_name = None             # BT-153
        self.tax_category_ids = []        # BG-30 ClassifiedTaxCategory/ID codes

    @property
    def label(self):
        return "cac:InvoiceLine[%d]%s" % (
            self.index, (" id=%r" % self.id) if self.id else "")


class TaxSubtotal:
    __slots__ = ("tax_amount", "taxable_amount", "category_id")

    def __init__(self):
        self.tax_amount = None      # BT-117 (text)
        self.taxable_amount = None  # BT-116 (text)
        self.category_id = None     # BT-118 VAT category code


class TaxTotal:
    __slots__ = ("tax_amount", "tax_amount_currency", "subtotals")

    def __init__(self):
        self.tax_amount = None           # BT-110 (text)
        self.tax_amount_currency = None  # currencyID attribute
        self.subtotals = []              # list[TaxSubtotal]


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
        self.buyer_name = None            # BT-44
        # Totals
        self.line_extension_total = None  # BT-106
        self.tax_exclusive_amount = None  # BT-109
        self.tax_inclusive_amount = None  # BT-112
        self.payable_amount = None        # BT-115
        self.allowance_total = None       # BT-107
        self.charge_total = None          # BT-108
        self.has_legal_monetary_total = False
        # Tax + lines
        self.tax_totals = []              # list[TaxTotal]
        self.lines = []                   # list[InvoiceLine]
        # Document-level allowance/charge VAT category codes
        self.doc_allowance_charge_category_ids = []

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

    # Buyer
    customer = root.find("cac:AccountingCustomerParty/cac:Party", NS)
    if customer is not None:
        inv.buyer_name = _text(
            customer.find("cac:PartyLegalEntity/cbc:RegistrationName", NS))

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

    # TaxTotal(s)
    for tt_el in root.findall("cac:TaxTotal", NS):
        tt = TaxTotal()
        amount_el = tt_el.find("cbc:TaxAmount", NS)
        tt.tax_amount = _text(amount_el)
        if amount_el is not None:
            tt.tax_amount_currency = amount_el.get("currencyID")
        for st_el in tt_el.findall("cac:TaxSubtotal", NS):
            st = TaxSubtotal()
            st.tax_amount = _text(st_el.find("cbc:TaxAmount", NS))
            st.taxable_amount = _text(st_el.find("cbc:TaxableAmount", NS))
            st.category_id = _text(st_el.find("cac:TaxCategory/cbc:ID", NS))
            tt.subtotals.append(st)
        inv.tax_totals.append(tt)

    # Document-level allowance/charge VAT categories
    for ac_el in root.findall("cac:AllowanceCharge", NS):
        cat = _text(ac_el.find("cac:TaxCategory/cbc:ID", NS))
        if cat is not None:
            inv.doc_allowance_charge_category_ids.append(cat)

    # InvoiceLines
    for i, ln_el in enumerate(root.findall("cac:InvoiceLine", NS), start=1):
        ln = InvoiceLine(i)
        ln.id = _text(ln_el.find("cbc:ID", NS))
        ln.quantity = _text(ln_el.find("cbc:InvoicedQuantity", NS))
        ln.line_extension_amount = _text(ln_el.find("cbc:LineExtensionAmount", NS))
        ln.price_amount = _text(ln_el.find("cac:Price/cbc:PriceAmount", NS))
        ln.item_name = _text(ln_el.find("cac:Item/cbc:Name", NS))
        for cat_el in ln_el.findall("cac:Item/cac:ClassifiedTaxCategory/cbc:ID", NS):
            code = _text(cat_el)
            if code is not None:
                ln.tax_category_ids.append(code)
        inv.lines.append(ln)

    return inv
