"""First-slice EN 16931 + XRechnung business rules.

Each rule is a *pure function* taking the parsed :class:`~einvoice.parser.Invoice`
model and returning a :class:`Violation` when the rule is broken, or ``None`` when
it holds. Rule wording follows the vendored EN 16931 Schematron
(``corpus/cen-en16931/ubl/schematron/abstract/EN16931-model.sch``).

Standard library only.
"""

from __future__ import annotations

import datetime

from collections import namedtuple
from decimal import Decimal, InvalidOperation, ROUND_FLOOR, ROUND_HALF_UP

from .codelists import (
    CURRENCY_CODES,
    ITEM_CLASS_LIST_CODES,
    UBL_COUNTRY_CODES,
    CII_COUNTRY_CODES,
    VAT_CATEGORY_CODES,
    VATEX_CODES,
    UNIT_CODES,
    PAYMENT_MEANS_CODES,
    ALLOWANCE_REASON_CODES,
    CHARGE_REASON_CODES,
    ITEM_SCHEME_ID_CODES,
    MIME_CODES,
)

# ``severity`` mirrors the official Schematron ``flag``: every core rule is
# ``fatal`` except BR-51, which the normative artifact flags as ``warning``
# (validate.Result.ok only blocks on fatal violations).
Violation = namedtuple("Violation", ["rule_id", "message", "element", "severity"])
Violation.__new__.__defaults__ = ("fatal",)

# UNTDID 1001 invoice type codes accepted by EN 16931 for an Invoice document
# (presence-in-list check only; the XRechnung-restricted subset is deferred).
UNTDID_1001_INVOICE = {
    "71", "80", "81", "82", "84", "102", "130", "202", "203", "204", "211",
    "218", "219", "295", "325", "326", "331", "380", "382", "383", "384",
    "385", "386", "387", "388", "389", "390", "393", "394", "395", "396",
    "420", "456", "457", "458", "527", "532", "553", "575", "623", "633",
    "751", "780", "817", "870", "875", "876", "877", "935",
}

_CENT = Decimal("0.01")


def _dec(text):
    """Parse a numeric text field to Decimal, or None if absent/unparseable.

    Non-finite parses ("NaN"/"Infinity" are valid Python Decimals but NOT valid
    xs:decimal lexical forms) are rejected as unparseable.
    """
    if text is None or text == "":
        return None
    try:
        value = Decimal(text)
    except (InvalidOperation, ValueError):
        return None
    return value if value.is_finite() else None


def _q(value):
    """Quantize a Decimal to 2 places, EN 16931 half-up rounding."""
    return value.quantize(_CENT, rounding=ROUND_HALF_UP)


def _fn_round(value):
    """XPath 2.0 fn:round(): nearest integer, HALVES TOWARD +INFINITY.

    This is floor(x + 0.5) — NOT Python's banker's rounding and NOT half-up
    (fn:round(-2.5) = -2, whereas half-up gives -3). The official Schematron
    computes every 2-place rounding as ``round(x * 10 * 10) div 100`` with
    these semantics, so rules transcribed from it must match exactly.
    """
    return (value + Decimal("0.5")).to_integral_value(rounding=ROUND_FLOOR)


def _xr2(value):
    """The official ``round(x * 10 * 10) div 100`` idiom: 2-place rounding
    with fn:round() (halves toward +infinity) semantics."""
    return _fn_round(value * 100) / Decimal(100)


def _date(text):
    """Parse an xs:date lexical value to a ``datetime.date``, or None.

    xs:date is ``YYYY-MM-DD`` with an optional timezone suffix (``Z`` or
    ``+hh:mm``/``-hh:mm``). The BR-29/BR-30 comparison in the corpus is always
    between two plain dates, so the timezone (when present) is stripped rather
    than modelled; an unparseable value returns None (on the official side an
    invalid xs:date cast is a dynamic ERROR that aborts the whole transform,
    so such documents carry no official verdict at all).
    """
    if not text:
        return None
    t = text.strip()
    if t.endswith("Z"):
        t = t[:-1]
    elif len(t) > 10 and t[10] in "+-":
        t = t[:10]
    try:
        return datetime.date.fromisoformat(t)
    except ValueError:
        return None


def _dec_places(raw):
    """string-length(substring-after(v, '.')) over the RAW text value.

    Everything after the FIRST '.' counts — including whitespace — exactly like
    the official BR-DEC-* XPath. An absent element (None), an empty element or
    a dot-less value yields 0 (the official rules hold in those cases).
    """
    if raw is None or "." not in raw:
        return 0
    return len(raw.split(".", 1)[1])


# ---------------------------------------------------------------------------
# Existence / cardinality — document header
# ---------------------------------------------------------------------------
def br_01(inv):
    """BR-01: An Invoice shall have a Specification identifier (BT-24)."""
    if not inv.customization_id:
        return Violation("BR-01",
                         "An Invoice shall have a Specification identifier (BT-24).",
                         "cbc:CustomizationID")
    return None


def br_02(inv):
    """BR-02: An Invoice shall have an Invoice number (BT-1)."""
    if not inv.id:
        return Violation("BR-02",
                         "An Invoice shall have an Invoice number (BT-1).",
                         "cbc:ID")
    return None


def br_03(inv):
    """BR-03: An Invoice shall have an Invoice issue date (BT-2)."""
    if not inv.issue_date:
        return Violation("BR-03",
                         "An Invoice shall have an Invoice issue date (BT-2).",
                         "cbc:IssueDate")
    return None


def br_04(inv):
    """BR-04: An Invoice shall have an Invoice type code (BT-3)."""
    if not inv.invoice_type_code:
        return Violation("BR-04",
                         "An Invoice shall have an Invoice type code (BT-3).",
                         "cbc:InvoiceTypeCode")
    return None


def br_05(inv):
    """BR-05: An Invoice shall have an Invoice currency code (BT-5)."""
    if not inv.document_currency_code:
        return Violation("BR-05",
                         "An Invoice shall have an Invoice currency code (BT-5).",
                         "cbc:DocumentCurrencyCode")
    return None


def br_06(inv):
    """BR-06: An Invoice shall contain the Seller name (BT-27)."""
    if not inv.seller_name:
        return Violation(
            "BR-06",
            "An Invoice shall contain the Seller name (BT-27).",
            "cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName")
    return None


def br_07(inv):
    """BR-07: An Invoice shall contain the Buyer name (BT-44)."""
    if not inv.buyer_name:
        return Violation(
            "BR-07",
            "An Invoice shall contain the Buyer name (BT-44).",
            "cac:AccountingCustomerParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName")
    return None


def br_08(inv):
    """BR-08: An Invoice shall contain the Seller postal address (BG-5)."""
    if not inv.seller_has_postal_address:
        return Violation(
            "BR-08",
            "An Invoice shall contain the Seller postal address (BG-5).",
            "cac:AccountingSupplierParty/cac:Party/cac:PostalAddress")
    return None


def br_09(inv):
    """BR-09: The Seller postal address (BG-5) shall contain a Seller country
    code (BT-40).

    Official (context ``$Seller_postal_address`` =
    ``cac:AccountingSupplierParty/cac:Party/cac:PostalAddress``)::

        normalize-space(cac:Country/cbc:IdentificationCode) != ''

    The UBL rule's context node is the Seller PostalAddress itself, so it is
    only evaluated when that address is PRESENT (an absent address is BR-08's
    job, not this rule's). Given a present address, the country code must
    normalize-space to a non-empty string — an absent, empty or whitespace-only
    ``Country/IdentificationCode`` fires the assert.

    Official CII (context ``/rsm:CrossIndustryInvoice`` — the document ROOT)::

        normalize-space(rsm:SupplyChainTradeTransaction/
            ram:ApplicableHeaderTradeAgreement/ram:SellerTradeParty/
            ram:PostalTradeAddress/ram:CountryID) != ''

    The CII binding is NOT gated on the postal address existing: with the root
    as context the assert is evaluated on every document, and an entirely
    absent ``ram:PostalTradeAddress`` (or SellerTradeParty) string-values to
    ``''`` — so it fires ALONGSIDE BR-08 there. The two bindings genuinely
    differ, so the body branches on ``inv.syntax`` and transcribes each
    exactly.
    """
    gate = True if inv.syntax == "cii" else inv.seller_has_postal_address
    if gate and not inv.seller_country_code:
        return Violation(
            "BR-09",
            "The Seller postal address (BG-5) shall contain a Seller country "
            "code (BT-40).",
            "cac:AccountingSupplierParty/cac:Party/cac:PostalAddress/"
            "cac:Country/cbc:IdentificationCode")
    return None


def br_10(inv):
    """BR-10: An Invoice shall contain the Buyer postal address (BG-8).

    Official (context ``$Invoice`` = ``/ubl:Invoice | /cn:CreditNote``)::

        exists(cac:AccountingCustomerParty/cac:Party/cac:PostalAddress)

    Evaluated on every Invoice (the context always exists); the Buyer postal
    address must be present. This mirrors BR-08 for the Seller.
    """
    if not inv.buyer_has_postal_address:
        return Violation(
            "BR-10",
            "An Invoice shall contain the Buyer postal address (BG-8).",
            "cac:AccountingCustomerParty/cac:Party/cac:PostalAddress")
    return None


def br_11(inv):
    """BR-11: The Buyer postal address shall contain a Buyer country code
    (BT-55).

    Official (context ``$Buyer_postal_address`` =
    ``cac:AccountingCustomerParty/cac:Party/cac:PostalAddress``)::

        normalize-space(cac:Country/cbc:IdentificationCode) != ''

    Symmetric to BR-09 for the Buyer: on UBL only evaluated when the Buyer
    postal address is present (absence is BR-10's job); given a present
    address, the country code must normalize-space to a non-empty string.

    Official CII (context ``/rsm:CrossIndustryInvoice`` — the document ROOT)::

        normalize-space(rsm:SupplyChainTradeTransaction/
            ram:ApplicableHeaderTradeAgreement/ram:BuyerTradeParty/
            ram:PostalTradeAddress/ram:CountryID) != ''

    As with BR-09, the CII binding is ungated — an absent Buyer postal address
    string-values to ``''`` and fires this rule alongside BR-10 — so the body
    branches on ``inv.syntax`` and transcribes each binding exactly.
    """
    gate = True if inv.syntax == "cii" else inv.buyer_has_postal_address
    if gate and not inv.buyer_country_code:
        return Violation(
            "BR-11",
            "The Buyer postal address shall contain a Buyer country code "
            "(BT-55).",
            "cac:AccountingCustomerParty/cac:Party/cac:PostalAddress/"
            "cac:Country/cbc:IdentificationCode")
    return None


# ---------------------------------------------------------------------------
# Existence — document totals (BG-22, context cac:LegalMonetaryTotal)
# ---------------------------------------------------------------------------
def br_12(inv):
    """BR-12: An Invoice shall have the Sum of Invoice line net amount (BT-106).

    Official (context ``$Document_totals`` = ``cac:LegalMonetaryTotal``)::

        exists(cbc:LineExtensionAmount)

    A pure existence check whose context node is the LegalMonetaryTotal: it is
    only evaluated when an LMT is present, and then requires the child element
    to exist (present-but-empty satisfies it; only absence fires).
    """
    if inv.has_legal_monetary_total and inv.line_extension_total is None:
        return Violation(
            "BR-12",
            "An Invoice shall have the Sum of Invoice line net amount (BT-106).",
            "cac:LegalMonetaryTotal/cbc:LineExtensionAmount")
    return None


def br_13(inv):
    """BR-13: An Invoice shall have the Invoice total amount without VAT (BT-109).

    Official (context ``cac:LegalMonetaryTotal``): ``exists(cbc:TaxExclusiveAmount)``.
    """
    if inv.has_legal_monetary_total and inv.tax_exclusive_amount is None:
        return Violation(
            "BR-13",
            "An Invoice shall have the Invoice total amount without VAT "
            "(BT-109).",
            "cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount")
    return None


def br_14(inv):
    """BR-14: An Invoice shall have the Invoice total amount with VAT (BT-112).

    Official (context ``cac:LegalMonetaryTotal``): ``exists(cbc:TaxInclusiveAmount)``.
    """
    if inv.has_legal_monetary_total and inv.tax_inclusive_amount is None:
        return Violation(
            "BR-14",
            "An Invoice shall have the Invoice total amount with VAT (BT-112).",
            "cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount")
    return None


def br_15(inv):
    """BR-15: An Invoice shall have the Amount due for payment (BT-115).

    Official (context ``cac:LegalMonetaryTotal``): ``exists(cbc:PayableAmount)``.
    """
    if inv.has_legal_monetary_total and inv.payable_amount is None:
        return Violation(
            "BR-15",
            "An Invoice shall have the Amount due for payment (BT-115).",
            "cac:LegalMonetaryTotal/cbc:PayableAmount")
    return None


# ---------------------------------------------------------------------------
# Cardinality — invoice lines
# ---------------------------------------------------------------------------
def br_16(inv):
    """BR-16: An Invoice shall have at least one Invoice line (BG-25)."""
    if not inv.lines:
        return Violation("BR-16",
                         "An Invoice shall have at least one Invoice line (BG-25).",
                         "cac:InvoiceLine")
    return None


def br_21(inv):
    """BR-21: Each Invoice line shall have an Invoice line identifier (BT-126)."""
    for ln in inv.lines:
        if not ln.id:
            return Violation(
                "BR-21",
                "Each Invoice line shall have an Invoice line identifier (BT-126).",
                ln.label + "/cbc:ID")
    return None


def br_22(inv):
    """BR-22: Each Invoice line shall have an Invoiced quantity (BT-129).

    Official test: ``exists(cbc:InvoicedQuantity) or exists(cbc:CreditedQuantity)``
    — a pure *existence* check. An element that is present but empty
    (``<cbc:InvoicedQuantity/>``) satisfies the rule; only an absent element
    fires it. ``ln.quantity is None`` is exactly "element absent" (the parser
    returns ``""`` for a present-but-empty element), so we test presence only.
    """
    for ln in inv.lines:
        if ln.quantity is None:
            return Violation(
                "BR-22",
                "Each Invoice line shall have an Invoiced quantity (BT-129).",
                ln.label + "/cbc:InvoicedQuantity")
    return None


def br_24(inv):
    """BR-24: Each Invoice line shall have an Invoice line net amount (BT-131).

    Official test: ``exists(cbc:LineExtensionAmount)`` — pure existence
    (present-but-empty satisfies it; only absence fires).
    """
    for ln in inv.lines:
        if ln.line_extension_amount is None:
            return Violation(
                "BR-24",
                "Each Invoice line shall have an Invoice line net amount (BT-131).",
                ln.label + "/cbc:LineExtensionAmount")
    return None


def br_25(inv):
    """BR-25: Each Invoice line (BG-25) shall contain the Item name (BT-153).

    Official (context = each Invoice line)::

        normalize-space(cac:Item/cbc:Name) != ''

    Not a pure existence check: an absent, empty or whitespace-only Item name
    all normalize-space to ``''`` and fire the assert. The parser strips the
    text, so ``ln.item_name`` is falsy in exactly those three cases.
    """
    for ln in inv.lines:
        if not ln.item_name:
            return Violation(
                "BR-25",
                "Each Invoice line (BG-25) shall contain the Item name (BT-153).",
                ln.label + "/cac:Item/cbc:Name")
    return None


def br_26(inv):
    """BR-26: Each Invoice line shall contain the Item net price (BT-146).

    Official test: ``exists(cac:Price/cbc:PriceAmount)`` — pure existence.
    """
    for ln in inv.lines:
        if ln.price_amount is None:
            return Violation(
                "BR-26",
                "Each Invoice line shall contain the Item net price (BT-146).",
                ln.label + "/cac:Price/cbc:PriceAmount")
    return None


def br_27(inv):
    """BR-27: The Item net price (BT-146) shall NOT be negative.

    Official (context = each Invoice line)::

        (cac:Price/cbc:PriceAmount) >= 0

    A general comparison, NOT presence-gated: with no PriceAmount the left
    side is the empty sequence, ``() >= 0`` is false and the assert FIRES
    (alongside BR-26 — the official artifact fires both on a price-less line).
    A present, parseable PriceAmount must be >= 0. (A non-numeric value is a
    dynamic cast error officially — no verdict; we fire.)
    """
    for ln in inv.lines:
        price = _dec(ln.price_amount)
        if price is None or price < 0:
            return Violation(
                "BR-27",
                "The Item net price (BT-146=%s) shall NOT be negative."
                % (ln.price_amount if ln.price_amount is not None
                   else "(absent)"),
                ln.label + "/cac:Price/cbc:PriceAmount")
    return None


def br_28(inv):
    """BR-28: The Item gross price (BT-148) shall NOT be negative.

    Official (context = each Invoice line)::

        (cac:Price/cac:AllowanceCharge/cbc:BaseAmount) >= 0
          or not(exists(cac:Price/cac:AllowanceCharge/cbc:BaseAmount))

    Unlike BR-27 this IS presence-gated (the second disjunct): a line without
    a gross price holds. When BaseAmount nodes exist, the general comparison
    holds iff ANY of them is >= 0.
    """
    for ln in inv.lines:
        if not ln.price_base_amounts:
            continue  # not(exists(...)) -> holds
        holds = False
        for raw in ln.price_base_amounts:
            v = _dec(raw)
            if v is not None and v >= 0:
                holds = True
                break
        if not holds:
            return Violation(
                "BR-28",
                "The Item gross price (BT-148=%s) shall NOT be negative."
                % ", ".join(ln.price_base_amounts),
                ln.label + "/cac:Price/cac:AllowanceCharge/cbc:BaseAmount")
    return None


def _period_end_before_start(period):
    """The shared official BR-29/BR-30 test, negated (True = assert fires)::

        (exists(cbc:EndDate) and exists(cbc:StartDate)
           and xs:date(cbc:EndDate) >= xs:date(cbc:StartDate))
        or not(exists(cbc:StartDate)) or not(exists(cbc:EndDate))

    Holds whenever either date is absent; with both present the end date must
    be >= the start date. A present-but-unparseable date is a dynamic error on
    the official side (no verdict there); we treat it as firing.
    """
    if period.start is None or period.end is None:
        return False  # not(exists(...)) -> assert holds
    start, end = _date(period.start), _date(period.end)
    return start is None or end is None or end < start


def br_29(inv):
    """BR-29: If both Invoicing period start date (BT-73) and end date (BT-74)
    are given then the end date shall be later or equal to the start date.

    Official context: the document-level ``cac:InvoicePeriod`` (BG-14) — the
    line-level periods are captured by BR-30's rule, which appears first in
    the same Schematron pattern.
    """
    for period in inv.invoice_periods:
        if _period_end_before_start(period):
            return Violation(
                "BR-29",
                "The Invoicing period end date (BT-74=%s) shall be later or "
                "equal to the Invoicing period start date (BT-73=%s)."
                % (period.end, period.start),
                "cac:InvoicePeriod/cbc:EndDate")
    return None


def br_30(inv):
    """BR-30: If both Invoice line period start date (BT-134) and end date
    (BT-135) are given then the end date shall be later or equal to the start
    date.

    Official context: ``cac:InvoiceLine/cac:InvoicePeriod`` (BG-26) — same
    test as BR-29, scoped to the line periods.
    """
    for ln in inv.lines:
        for period in ln.periods:
            if _period_end_before_start(period):
                return Violation(
                    "BR-30",
                    "The Invoice line period end date (BT-135=%s) shall be "
                    "later or equal to the Invoice line period start date "
                    "(BT-134=%s)." % (period.end, period.start),
                    ln.label + "/cac:InvoicePeriod/cbc:EndDate")
    return None


# ---------------------------------------------------------------------------
# Code list
# ---------------------------------------------------------------------------
def br_cl_01(inv):
    """BR-CL-01: The document type code (BT-3) MUST be coded per UNTDID 1001."""
    code = inv.invoice_type_code
    if code and code not in UNTDID_1001_INVOICE:
        return Violation(
            "BR-CL-01",
            "The document type code (BT-3) MUST be coded according to UNTDID 1001; "
            "%r is not a listed code." % code,
            "cbc:InvoiceTypeCode")
    return None


def _bad_code(value, allowed):
    """Replicate the codelist assert test in the FAILING direction.

    The official Schematron test is
    ``not(contains(normalize-space(V),' ')) and contains(' L ', ' '+V+' ')``
    — it HOLDS iff V has no internal space AND V is a member of the list ``L``.
    So it FAILS (the rule fires) iff V contains a space OR V is not in ``L``.
    ``value`` is already normalize-space'd by the parser.
    """
    return (" " in value) or (value not in allowed)


def br_cl_03(inv):
    """BR-CL-03: currencyID MUST be coded using ISO 4217 alpha-3.

    Official context = each monetary amount element (UBL: cbc:Amount |
    cbc:BaseAmount | … | cbc:PayableAmount; CII: ram:TaxTotalAmount[@currencyID]);
    the assert tests that element's ``@currencyID`` against the ISO 4217 set.
    """
    for cur in inv.amount_currency_ids:
        if _bad_code(cur, CURRENCY_CODES):
            return Violation(
                "BR-CL-03",
                "currencyID MUST be coded using ISO 4217 alpha-3; "
                "%r is not a listed currency code." % cur,
                "@currencyID")
    return None


def br_cl_04(inv):
    """BR-CL-04: Invoice currency code (BT-5) MUST be coded using ISO 4217 alpha-3.

    Official context = cbc:DocumentCurrencyCode (UBL) / ram:InvoiceCurrencyCode
    (CII); both map to ``document_currency_code``. Absent = no context node
    (presence is BR-05's job), so only a PRESENT, invalid code fires here.
    """
    code = inv.document_currency_code
    if code is not None and _bad_code(code, CURRENCY_CODES):
        return Violation(
            "BR-CL-04",
            "Invoice currency code (BT-5) MUST be coded using ISO 4217 alpha-3; "
            "%r is not a listed currency code." % code,
            "cbc:DocumentCurrencyCode")
    return None


def br_cl_05(inv):
    """BR-CL-05: Tax currency code (BT-6) MUST be coded using ISO 4217 alpha-3.

    Official context = cbc:TaxCurrencyCode (UBL) / ram:TaxCurrencyCode (CII).
    Absent = no context node, so only a PRESENT, invalid code fires.
    """
    code = inv.tax_currency_code
    if code is not None and _bad_code(code, CURRENCY_CODES):
        return Violation(
            "BR-CL-05",
            "Tax currency code (BT-6) MUST be coded using ISO 4217 alpha-3; "
            "%r is not a listed currency code." % code,
            "cbc:TaxCurrencyCode")
    return None


def br_cl_13(inv):
    """BR-CL-13: Item classification scheme identifier MUST be a UNTDID 7143 code.

    Official context = cac:CommodityClassification/cbc:ItemClassificationCode
    with a @listID (UBL) / ram:ClassCode[@listID] (CII); the assert tests
    that ``@listID`` against the UNTDID 7143 restriction.
    """
    for list_id in inv.item_class_list_ids:
        if _bad_code(list_id, ITEM_CLASS_LIST_CODES):
            return Violation(
                "BR-CL-13",
                "Item classification identifier scheme identifier MUST be coded "
                "using one of the UNTDID 7143 list; %r is not listed." % list_id,
                "cbc:ItemClassificationCode/@listID")
    return None


def br_cl_14(inv):
    """BR-CL-14: Country codes MUST be coded using ISO 3166-1 alpha-2.

    Official context = cac:Country/cbc:IdentificationCode (UBL) / ram:CountryID
    (CII) — the seller/buyer/deliver-to/tax-representative/payee postal-address
    country codes (item OriginCountry is BR-CL-15, not this rule). The UBL and
    CII code lists differ by one code each, so the matching pinned set is
    selected by syntax.
    """
    allowed = CII_COUNTRY_CODES if inv.syntax == "cii" else UBL_COUNTRY_CODES
    for code in inv.country_codes:
        if _bad_code(code, allowed):
            return Violation(
                "BR-CL-14",
                "Country codes in an invoice MUST be coded using ISO 3166-1; "
                "%r is not a listed country code." % code,
                "cac:Country/cbc:IdentificationCode")
    return None


def br_cl_17(inv):
    """BR-CL-17: Invoice tax categories MUST be coded using the UNCL 5305 subset.

    Official context differs by syntax but the allowed value set is IDENTICAL:
      * UBL: cac:TaxCategory/cbc:ID — the document VAT breakdown category AND
        every document/line allowance-charge tax category.
      * CII: ram:CategoryTradeTax/ram:CategoryCode — the allowance-charge VAT
        category (the CII binding routes the breakdown/line categories through
        BR-CL-18 instead).
    The parser populates ``taxcategory_id_codes`` with exactly those context-node
    values per syntax, so the shared body runs unchanged.
    """
    for code in inv.taxcategory_id_codes:
        if _bad_code(code, VAT_CATEGORY_CODES):
            return Violation(
                "BR-CL-17",
                "Invoice tax categories MUST be coded using the UNCL 5305 code "
                "list; %r is not a listed VAT category code." % code,
                "cac:TaxCategory/cbc:ID")
    return None


def br_cl_18(inv):
    """BR-CL-18: Invoice tax categories MUST be coded using the UNCL 5305 subset.

    Official context differs by syntax; the allowed set is the same as BR-CL-17:
      * UBL: cac:ClassifiedTaxCategory/cbc:ID — the line item VAT category.
      * CII: ram:ApplicableTradeTax/ram:CategoryCode — the document VAT breakdown
        category AND each line's VAT category.
    The parser populates ``classified_tax_category_codes`` per syntax.
    """
    for code in inv.classified_tax_category_codes:
        if _bad_code(code, VAT_CATEGORY_CODES):
            return Violation(
                "BR-CL-18",
                "Invoice tax categories MUST be coded using the UNCL 5305 code "
                "list; %r is not a listed VAT category code." % code,
                "cac:ClassifiedTaxCategory/cbc:ID")
    return None


def br_cl_22(inv):
    """BR-CL-22: VAT exemption reason code MUST belong to the CEF VATEX list.

    Official context = cbc:TaxExemptionReasonCode (UBL) / ram:ExemptionReasonCode
    (CII). The assert tests ``normalize-space(upper-case(.))`` against the VATEX
    list, so the parser stores each value UPPER-CASED; the membership check is
    therefore case-insensitive exactly like the official rule.
    """
    for code in inv.tax_exemption_reason_codes:
        if _bad_code(code, VATEX_CODES):
            return Violation(
                "BR-CL-22",
                "The VAT exemption reason code MUST belong to the CEF VATEX code "
                "list; %r is not a listed VATEX code." % code,
                "cbc:TaxExemptionReasonCode")
    return None


def br_cl_23(inv):
    """BR-CL-23: Unit code MUST be coded per UN/ECE Rec 20 with Rec 21 extension.

    Official context differs by syntax but the allowed value set is IDENTICAL
    (the vendored UBL and CII asserts inline the same 2162-entry string):
      * UBL: cbc:InvoicedQuantity[@unitCode] | cbc:BaseQuantity[@unitCode] |
        cbc:CreditedQuantity[@unitCode] — the line invoiced/credited quantity
        (BT-129) and the item price base quantity (BT-149) @unitCode.
      * CII: ram:BasisQuantity[@unitCode] | ram:BilledQuantity[@unitCode] —
        the item price base quantity (BT-149) and billed line quantity (BT-129).
    The [@unitCode] predicate means only quantity elements that CARRY a unitCode
    attribute are context nodes, so a missing attribute cannot fire; the parser
    populates ``unit_codes`` with exactly those normalize-space'd @unitCode
    values per syntax, so the shared body runs unchanged and reaches parity with
    each official codes Schematron.
    """
    for code in inv.unit_codes:
        if _bad_code(code, UNIT_CODES):
            return Violation(
                "BR-CL-23",
                "Unit code MUST be coded according to the UN/ECE Recommendation "
                "20 with Rec 21 extension; %r is not a listed unit code." % code,
                "cbc:InvoicedQuantity/@unitCode")
    return None


def br_cl_16(inv):
    """BR-CL-16: Payment means MUST be coded using the UNCL 4461 code list.

    Official context = cac:PaymentMeans/cbc:PaymentMeansCode (UBL) /
    ram:SpecifiedTradeSettlementPaymentMeans/ram:TypeCode (CII). Both syntaxes
    inline the IDENTICAL 84-code UNCL 4461 subset, so the shared pinned set
    (``PAYMENT_MEANS_CODES``) serves both; the parser feeds
    ``payment_means_codes`` the normalize-space'd code at exactly that context
    node per syntax. NOTE the CII binding is the PAYMENT-means TypeCode, not the
    document TypeCode (that is BR-CL-01).
    """
    for code in inv.payment_means_codes:
        if _bad_code(code, PAYMENT_MEANS_CODES):
            return Violation(
                "BR-CL-16",
                "Payment means in an invoice MUST be coded using the UNCL 4461 "
                "code list; %r is not a listed payment-means code." % code,
                "cbc:PaymentMeansCode")
    return None


def br_cl_19(inv):
    """BR-CL-19: Coded allowance reasons MUST belong to the UNCL 5189 code list.

    Official context = cac:AllowanceCharge[cbc:ChargeIndicator = false()]/
    cbc:AllowanceChargeReasonCode (UBL) /
    ram:SpecifiedTradeAllowanceCharge[ram:ChargeIndicator/udt:Indicator = false()]/
    ram:ReasonCode (CII) — the ALLOWANCE (charge-indicator false) reason code, at
    BOTH document and line level (the pattern matches an allowance/charge at any
    depth). The parser feeds ``allowance_reason_codes`` exactly the normalize-
    space'd reason codes of the false-indicator allowances per syntax. Both
    syntaxes inline the IDENTICAL 19-code UNCL 5189 set.
    """
    for code in inv.allowance_reason_codes:
        if _bad_code(code, ALLOWANCE_REASON_CODES):
            return Violation(
                "BR-CL-19",
                "Coded allowance reasons MUST belong to the UNCL 5189 code list; "
                "%r is not a listed allowance reason code." % code,
                "cbc:AllowanceChargeReasonCode")
    return None


def br_cl_20(inv):
    """BR-CL-20: Coded charge reasons MUST belong to the UNCL 7161 code list.

    Official context = cac:AllowanceCharge[cbc:ChargeIndicator = true()]/
    cbc:AllowanceChargeReasonCode (UBL) /
    ram:SpecifiedTradeAllowanceCharge[ram:ChargeIndicator/udt:Indicator = true()]/
    ram:ReasonCode (CII) — the CHARGE (charge-indicator true) reason code, at BOTH
    document and line level. The parser feeds ``charge_reason_codes`` exactly the
    normalize-space'd reason codes of the true-indicator charges per syntax. Both
    syntaxes inline the IDENTICAL 178-code UNCL 7161 set.
    """
    for code in inv.charge_reason_codes:
        if _bad_code(code, CHARGE_REASON_CODES):
            return Violation(
                "BR-CL-20",
                "Coded charge reasons MUST belong to the UNCL 7161 code list; "
                "%r is not a listed charge reason code." % code,
                "cbc:AllowanceChargeReasonCode")
    return None


def br_cl_21(inv):
    """BR-CL-21: Item standard identifier scheme MUST be an ISO 6523 ICD code.

    Official context = cac:StandardItemIdentification/cbc:ID[@schemeID] (UBL) /
    ram:SpecifiedTradeProduct/ram:GlobalID[@schemeID] (CII); only nodes carrying
    @schemeID are context nodes, and the assert tests that @schemeID against the
    ISO 6523 ICD list. Both syntaxes inline the IDENTICAL 243-code list, so the
    shared pinned set (``ITEM_SCHEME_ID_CODES``) serves both; the parser feeds
    ``item_std_id_scheme_ids`` the normalize-space'd @schemeID per syntax.
    """
    for scheme in inv.item_std_id_scheme_ids:
        if _bad_code(scheme, ITEM_SCHEME_ID_CODES):
            return Violation(
                "BR-CL-21",
                "Item standard identifier scheme identifier MUST belong to the "
                "ISO 6523 ICD code list; %r is not a listed ICD." % scheme,
                "cac:StandardItemIdentification/cbc:ID/@schemeID")
    return None


def br_cl_24(inv):
    """BR-CL-24: For a MIME code in an attribute use the MIMEMediaType subset.

    Official context = cbc:EmbeddedDocumentBinaryObject[@mimeCode] (UBL) /
    ram:AttachmentBinaryObject[@mimeCode] (CII). Unlike the other codelist
    asserts, the official test is a DIRECT disjunction of six ``@mimeCode = '...'``
    string equalities (no normalize-space, no internal-space guard), so the raw
    @mimeCode value is compared for exact membership in the six-entry
    ``MIME_CODES`` set. Both syntaxes test the SAME six MIME literals. (This is
    the ATTACHMENT MIME-code rule; the BT-3 document type code is BR-CL-01.)
    """
    for code in inv.mime_codes:
        if code not in MIME_CODES:
            return Violation(
                "BR-CL-24",
                "For a MIME code in an attribute use the MIMEMediaType subset; "
                "%r is not a listed MIME type." % code,
                "cbc:EmbeddedDocumentBinaryObject/@mimeCode")
    return None


# ---------------------------------------------------------------------------
# Calculation / co-constraint (arithmetic integrity)
# ---------------------------------------------------------------------------
def br_co_04(inv):
    """BR-CO-04: Each Invoice line (BG-25) shall be categorized with an
    Invoiced item VAT category code (BT-151).

    Official (context = each Invoice line)::

        (cac:Item/cac:ClassifiedTaxCategory
            [cac:TaxScheme/(normalize-space(upper-case(cbc:ID))='VAT')]/cbc:ID)

    Effective-boolean-value of a node sequence: the line must carry a
    ``ClassifiedTaxCategory`` whose TaxScheme/ID upper-cases + normalize-spaces
    to 'VAT' AND which has a ``cbc:ID`` ELEMENT (pure existence — a
    present-but-empty ID satisfies it; the parser's ``cat.id`` is None only
    when the element is absent).
    """
    for ln in inv.lines:
        has_vat_code = any(
            cat.scheme_id == "VAT" and cat.id is not None
            for cat in ln.item_tax_categories)
        if not has_vat_code:
            return Violation(
                "BR-CO-04",
                "Each Invoice line (BG-25) shall be categorized with an "
                "Invoiced item VAT category code (BT-151).",
                ln.label + "/cac:Item/cac:ClassifiedTaxCategory/cbc:ID")
    return None


def br_co_10(inv):
    """BR-CO-10: Sum of Invoice line net amount (BT-106) = Σ line net amount (BT-131).

    Official (context ``cac:LegalMonetaryTotal``)::

        xs:decimal(cbc:LineExtensionAmount)
          = xs:decimal(round(sum(//(cac:InvoiceLine|cac:CreditNoteLine)
                                 /xs:decimal(cbc:LineExtensionAmount)) * 100) div 100)

    The rule only exists where a ``LegalMonetaryTotal`` is present (that is its
    context node). Given that, a MISSING stated total (BT-106) casts to the empty
    sequence and ``() = n`` is false, so the assert FIRES — it does not "skip".
    Lines that omit BT-131 contribute nothing to the sum (they are not an error
    for THIS rule); a document with no lines sums to 0.
    """
    if not inv.has_legal_monetary_total:
        return None  # context node absent -> rule never evaluated
    total = Decimal("0")
    for ln in inv.lines:
        v = _dec(ln.line_extension_amount)
        if v is not None:
            total += v
    stated = _dec(inv.line_extension_total)
    if stated is None or _q(stated) != _q(total):
        return Violation(
            "BR-CO-10",
            "Sum of Invoice line net amounts (BT-106=%s) must equal the sum of "
            "line net amounts (Σ BT-131=%s)."
            % ("(absent)" if stated is None else _q(stated), _q(total)),
            "cac:LegalMonetaryTotal/cbc:LineExtensionAmount")
    return None


def _doc_ac_amount_sum(inv, is_charge):
    """Σ over document-level allowances (is_charge False) / charges (True) of
    ``xs:decimal(cbc:Amount)``.

    Mirrors the official ``sum(../cac:AllowanceCharge[...]/xs:decimal(cbc:Amount))``
    path expression: a matching AllowanceCharge whose ``cbc:Amount`` is absent or
    unparseable maps to the empty sequence and simply drops out of the sum (it is
    not itself an error for this rule). ``../cac:AllowanceCharge`` is the sibling
    of the LegalMonetaryTotal, i.e. the DOCUMENT-level allowance/charge (BG-20/21)
    captured by the parser as ``inv.doc_allowance_charges``.
    """
    total = Decimal("0")
    for ac in inv.doc_allowance_charges:
        if ac.is_charge is is_charge:
            v = _dec(ac.amount_raw)
            if v is not None:
                total += v
    return total


def _has_doc_ac(inv, is_charge):
    """True iff a document-level allowance (is_charge False) / charge (True)
    exists — the official ``exists(../cac:AllowanceCharge[cbc:ChargeIndicator=…])``
    node test. The parser's ``is_charge`` is True/False only for a usable
    ``cbc:ChargeIndicator`` (true()/1 vs false()/0), matching the XPath boolean
    cast; an absent/garbage indicator is ``None`` and counts for neither side."""
    return any(ac.is_charge is is_charge for ac in inv.doc_allowance_charges)


def br_co_11(inv):
    """BR-CO-11: Sum of allowances on document level (BT-107) = Σ Document level
    allowance amount (BT-92).

    Official (context ``cac:LegalMonetaryTotal``)::

        xs:decimal(cbc:AllowanceTotalAmount)
            = (round(sum(../cac:AllowanceCharge[cbc:ChargeIndicator=false()]
                          /xs:decimal(cbc:Amount)) * 10 * 10) div 100)
          or (not(cbc:AllowanceTotalAmount)
              and not(../cac:AllowanceCharge[cbc:ChargeIndicator=false()]))

    The rule's context node is the LegalMonetaryTotal, so it is only evaluated
    when an LMT is present. ``round(x * 10 * 10) div 100`` is 2-place rounding
    with fn:round() (halves toward +infinity) semantics — the shared ``_xr2``
    idiom; only the summed right-hand side is rounded (the stated total keeps its
    exact xs:decimal value, matching the official). The assert HOLDS iff EITHER
    the stated total equals round2(Σ allowance amounts) OR there is neither a
    stated total NOR any document-level allowance. It therefore FIRES when:

    * a stated total is present but != round2(Σ) — including the sub-case where a
      total is stated with no allowances at all (Σ = 0, so it must equal 0); or
    * document-level allowances exist but NO total (BT-107) is stated (the empty
      sequence makes ``() = n`` false and the second disjunct false).
    """
    if not inv.has_legal_monetary_total:
        return None  # context node absent -> rule never evaluated
    stated = _dec(inv.allowance_total)
    if stated is None and not _has_doc_ac(inv, False):
        return None  # second disjunct: nothing to reconcile -> holds
    expected = _xr2(_doc_ac_amount_sum(inv, False))
    if stated is not None and stated == expected:
        return None  # first disjunct: stated == round2(Σ) -> holds
    return Violation(
        "BR-CO-11",
        "Sum of allowances on document level (BT-107=%s) must equal the sum of "
        "Document level allowance amounts (Σ BT-92=%s)."
        % ("(absent)" if stated is None else stated, expected),
        "cac:LegalMonetaryTotal/cbc:AllowanceTotalAmount")


def br_co_12(inv):
    """BR-CO-12: Sum of charges on document level (BT-108) = Σ Document level
    charge amount (BT-99).

    Official (context ``cac:LegalMonetaryTotal``)::

        xs:decimal(cbc:ChargeTotalAmount)
            = (round(sum(../cac:AllowanceCharge[cbc:ChargeIndicator=true()]
                          /xs:decimal(cbc:Amount)) * 10 * 10) div 100)
          or (not(cbc:ChargeTotalAmount)
              and not(../cac:AllowanceCharge[cbc:ChargeIndicator=true()]))

    Exactly BR-CO-11's shape scoped to CHARGES (ChargeIndicator=true()): see
    :func:`br_co_11` for the disjunction/rounding/tolerance semantics.
    """
    if not inv.has_legal_monetary_total:
        return None  # context node absent -> rule never evaluated
    stated = _dec(inv.charge_total)
    if stated is None and not _has_doc_ac(inv, True):
        return None  # second disjunct: nothing to reconcile -> holds
    expected = _xr2(_doc_ac_amount_sum(inv, True))
    if stated is not None and stated == expected:
        return None  # first disjunct: stated == round2(Σ) -> holds
    return Violation(
        "BR-CO-12",
        "Sum of charges on document level (BT-108=%s) must equal the sum of "
        "Document level charge amounts (Σ BT-99=%s)."
        % ("(absent)" if stated is None else stated, expected),
        "cac:LegalMonetaryTotal/cbc:ChargeTotalAmount")


def br_co_13(inv):
    """BR-CO-13: Invoice total without VAT (BT-109) = Σ line net (BT-131)
    − document allowances (BT-107) + document charges (BT-108)."""
    # Context node is cac:LegalMonetaryTotal; the rule does not evaluate without it.
    if not inv.has_legal_monetary_total:
        return None
    tax_excl = _dec(inv.tax_exclusive_amount)
    line_total = _dec(inv.line_extension_total)
    allowance = _dec(inv.allowance_total) or Decimal("0")
    charge = _dec(inv.charge_total) or Decimal("0")
    # A missing operand casts to the empty sequence in the official XPath, and
    # any equation touching it is false -> the assert FIRES (it does not skip).
    if tax_excl is None or line_total is None:
        return Violation(
            "BR-CO-13",
            "Invoice total without VAT (BT-109=%s) must equal Σ line net "
            "(BT-106=%s) − allowances + charges; a required operand is absent."
            % ("(absent)" if tax_excl is None else _q(tax_excl),
               "(absent)" if line_total is None else _q(line_total)),
            "cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount")
    expected = line_total - allowance + charge
    if _q(tax_excl) != _q(expected):
        return Violation(
            "BR-CO-13",
            "Invoice total without VAT (BT-109=%s) must equal Σ line net (BT-106=%s) "
            "− allowances (BT-107=%s) + charges (BT-108=%s) = %s."
            % (_q(tax_excl), _q(line_total), _q(allowance), _q(charge), _q(expected)),
            "cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount")
    return None


def br_co_14(inv):
    """BR-CO-14: Invoice total VAT amount (BT-110) = Σ VAT category tax amount (BT-117).

    Official (context = each top-level ``cac:TaxTotal``)::

        (xs:decimal(child::cbc:TaxAmount)
            = round((sum(cac:TaxSubtotal/xs:decimal(cbc:TaxAmount)) * 100)) div 100)
        or not(cac:TaxSubtotal)

    Evaluated once per TaxTotal. A TaxTotal with no TaxSubtotal is exempt
    (``not(cac:TaxSubtotal)``). Otherwise the TaxTotal's own TaxAmount (BT-110)
    must equal the sum of its subtotal tax amounts — and a MISSING TaxAmount
    casts to the empty sequence, so ``() = n`` is false and the assert FIRES
    (this is the large gap the differential surfaced, e.g. a bare
    ``<TaxTotal><TaxSubtotal/></TaxTotal>``).

    The official CII binding (context = each ``ram:TaxTotalAmount`` whose
    ``@currencyID`` equals BT-5, transcribed T-VHCIIP.9)::

        . = round(sum(//ram:ApplicableHeaderTradeSettlement/
                      ram:ApplicableTradeTax/ram:CalculatedAmount) * 10 * 10)
              div 100

    is GENUINELY different from the UBL binding in two ways the differential
    pinned down, so the body branches on ``inv.syntax``:

    * the rule context is the document-currency BT-110 element ITSELF, not the
      breakdown — a no-VAT CII invoice that legitimately OMITS ram:TaxTotalAmount
      has no context node, so the assert never fires (where the UBL binding,
      which fires when a subtotal exists but the total is absent, over-rejects);
    * the compared total is the round2 sum of EVERY breakdown BT-117
      (``ram:CalculatedAmount``), with no per-TaxTotal grouping (CII carries a
      single header breakdown).
    """
    if inv.syntax == "cii":
        totals = inv.cii_doc_currency_tax_total_values
        if not totals:
            return None  # no document-currency BT-110 -> empty context
        breakdown_sum = Decimal("0")
        for st in inv.all_tax_subtotals:
            v = _dec(st.tax_amount)               # BT-117 ram:CalculatedAmount
            if v is not None:
                breakdown_sum += v
        expected = _xr2(breakdown_sum)
        for raw in totals:
            stated = _dec(raw)
            if stated is None or stated != expected:
                return Violation(
                    "BR-CO-14",
                    "Invoice total VAT amount (BT-110=%s) must equal the sum of "
                    "VAT category tax amounts (Σ BT-117=%s)."
                    % ("(absent)" if stated is None else _q(stated), expected),
                    "ram:SpecifiedTradeSettlementHeaderMonetarySummation/"
                    "ram:TaxTotalAmount")
        return None
    for tt in inv.tax_totals:
        if not tt.subtotals:
            continue  # not(cac:TaxSubtotal) -> assert holds
        subtotal_sum = Decimal("0")
        for st in tt.subtotals:
            v = _dec(st.tax_amount)
            if v is not None:
                subtotal_sum += v
        stated = _dec(tt.tax_amount)
        if stated is None or _q(stated) != _q(subtotal_sum):
            return Violation(
                "BR-CO-14",
                "Invoice total VAT amount (BT-110=%s) must equal the sum of VAT "
                "category tax amounts (Σ BT-117=%s)."
                % ("(absent)" if stated is None else _q(stated), _q(subtotal_sum)),
                "cac:TaxTotal/cbc:TaxAmount")
    return None


def br_co_15(inv):
    """BR-CO-15: Invoice total with VAT (BT-112) = total without VAT (BT-109)
    + total VAT (BT-110).

    Official (context = ``/ubl:Invoice``)::

        every $Currency in cbc:DocumentCurrencyCode satisfies
          (count(cac:TaxTotal/xs:decimal(cbc:TaxAmount[@currencyID=$Currency])) eq 1)
          and (cac:LegalMonetaryTotal/xs:decimal(cbc:TaxInclusiveAmount)
                 = round((cac:LegalMonetaryTotal/xs:decimal(cbc:TaxExclusiveAmount)
                          + cac:TaxTotal/xs:decimal(cbc:TaxAmount[@currencyID=$Currency]))
                         * 100) div 100)

    Two things the differential proved matter:

    * ``every ... in cbc:DocumentCurrencyCode`` — if BT-5 is absent the quantifier
      is vacuously TRUE, so the assert does NOT fire (presence is BR-05's job).
    * The VAT total used is *currency-scoped*: only a ``TaxTotal/TaxAmount`` whose
      ``@currencyID`` equals the document currency counts, and there must be
      exactly one. Summing across foreign-currency tax totals (as we used to)
      over-rejects — the source of the false positives on mixed-currency samples.

    The official CII binding (context ``/rsm:CrossIndustryInvoice``, transcribed
    T-VHCIIP.9) is::

        every $Currency in .../ram:InvoiceCurrencyCode satisfies
          ( count(.../ram:TaxTotalAmount[@currencyID = $Currency]) = 1
            and GrandTotalAmount[1]
                  = round((TaxBasisTotalAmount[1]
                           + TaxTotalAmount[@currencyID=$Currency][1]) * 100)
                      div 100 )
          or ( GrandTotalAmount[1] = TaxBasisTotalAmount[1] )

    which carries an EXTRA disjunct — ``GrandTotalAmount = TaxBasisTotalAmount``
    — with no UBL counterpart. It HOLDS for a no-VAT CII invoice that omits
    BT-110 (BT-112 == BT-109 there), so the UBL function (which requires exactly
    one document-currency VAT total and has no such disjunct) over-rejects those
    documents. The body branches on ``inv.syntax`` and transcribes each binding
    exactly. GrandTotalAmount=BT-112 (``tax_inclusive_amount``),
    TaxBasisTotalAmount=BT-109 (``tax_exclusive_amount``).
    """
    cur = inv.document_currency_code
    if not cur:
        return None  # every $Currency in () satisfies ... -> vacuously true

    if inv.syntax == "cii":
        grand = _dec(inv.tax_inclusive_amount)   # BT-112 GrandTotalAmount[1]
        basis = _dec(inv.tax_exclusive_amount)   # BT-109 TaxBasisTotalAmount[1]
        # Disjunct 2: GrandTotalAmount = TaxBasisTotalAmount (a missing operand
        # casts to () and the comparison is false, exactly like XPath).
        if grand is not None and basis is not None and grand == basis:
            return None
        matching = list(inv.cii_doc_currency_tax_total_values)
        if len(matching) == 1:
            tax = _dec(matching[0])
            if (grand is not None and basis is not None and tax is not None
                    and grand == _xr2(basis + tax)):
                return None
            detail = ("Invoice total with VAT (BT-112=%s) must equal total "
                      "without VAT (BT-109=%s) + total VAT (BT-110=%s)."
                      % (inv.tax_inclusive_amount or "(absent)",
                         inv.tax_exclusive_amount or "(absent)",
                         matching[0] or "(absent)"))
        else:
            detail = ("exactly one VAT total (BT-110) in the document currency "
                      "%r is required (or BT-112 = BT-109); found %d."
                      % (cur, len(matching)))
        return Violation(
            "BR-CO-15", "Invoice total with VAT must reconcile: " + detail,
            "ram:SpecifiedTradeSettlementHeaderMonetarySummation/"
            "ram:GrandTotalAmount")

    # count(cac:TaxTotal/cbc:TaxAmount[@currencyID = document currency])
    matching = [_dec(tt.tax_amount) for tt in inv.tax_totals
                if tt.tax_amount_currency == cur]

    fired = False
    if len(matching) != 1:
        # count(...) ne 1 -> the conjunction is false -> assert fires
        fired = True
        detail = ("exactly one VAT total (BT-110) in the document currency %r is "
                  "required; found %d." % (cur, len(matching)))
    else:
        tax_amount = matching[0]
        tax_incl = _dec(inv.tax_inclusive_amount)
        tax_excl = _dec(inv.tax_exclusive_amount)
        if tax_incl is None or tax_excl is None or tax_amount is None:
            fired = True
            detail = ("a required monetary operand (BT-112/BT-109/BT-110) is absent.")
        elif _q(tax_incl) != _q(tax_excl + tax_amount):
            fired = True
            detail = ("Invoice total with VAT (BT-112=%s) must equal total without "
                      "VAT (BT-109=%s) + total VAT (BT-110=%s) = %s."
                      % (_q(tax_incl), _q(tax_excl), _q(tax_amount),
                         _q(tax_excl + tax_amount)))
    if fired:
        return Violation(
            "BR-CO-15", "Invoice total with VAT must reconcile: " + detail,
            "cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount")
    return None


# ---------------------------------------------------------------------------
# VAT-category consistency
# ---------------------------------------------------------------------------
def br_s_01(inv):
    """BR-S-01: Standard-rated (S) items and the VAT breakdown must agree.

    The official UBL rule (context ``/ubl:Invoice``) is BIDIRECTIONAL — it
    holds iff::

        (items-have-S AND breakdown-has-S) OR (no-items-have-S AND breakdown-has-no-S)

    where "items-have-S" counts any Invoice line, Document level allowance or
    Document level charge whose VAT category code (BT-151/BT-95/BT-102) is 'S',
    and "breakdown-has-S" counts a VAT breakdown category (BT-118) of 'S'. So the
    assert fires whenever exactly ONE side carries 'S' — not only the
    "S item, no S breakdown" direction, but also an orphan 'S' breakdown with no
    corresponding 'S' line/allowance/charge (the misses the differential found).

    The official CII binding (context ``/rsm:CrossIndustryInvoice``) is a
    GENUINELY WEAKER count formula, transcribed exactly (T-VHCIIP.6)::

        ((count(line-S-rows) + count(header-S-rows)) >= 2 or not(line-S-rows))
        and
        ((count(CategoryTradeTax-S) + count(header-S-rows)) >= 2
         or not(CategoryTradeTax-S))

    over three RAW (VAT-TypeCode-unscoped) node sets: the line VAT rows
    (``//ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax
    [ram:CategoryCode='S']``), the header breakdown rows
    (``//ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax
    [ram:CategoryCode='S']``) and every allowance/charge category
    (``//ram:CategoryTradeTax[ram:CategoryCode='S']`` — document AND line
    level). Three consequences the differential pinned down, none shared by
    the UBL biconditional:

    * ONE S line (or one S allowance/charge) with no S breakdown row fires —
      that direction survives;
    * TWO or more S rows on the item side alone satisfy the ``>= 2`` count,
      so e.g. two S lines with NO S breakdown row officially HOLD on CII;
    * an orphan S breakdown row with no S item never fires (``not(...)`` on
      the empty item side is true).
    """
    if inv.syntax == "cii":
        hdr_s = sum(1 for row in inv.cii_header_trade_tax_code_rows
                    if "S" in row)
        line_s = sum(1 for row in inv.cii_line_trade_tax_code_rows
                     if "S" in row)
        # ram:CategoryTradeTax carries at most one ram:CategoryCode child, so
        # counting 'S' VALUES equals counting matching CategoryTradeTax rows.
        cat_s = inv.tax_category_ids_raw.count("S")
        if (((line_s + hdr_s) >= 2 or line_s == 0)
                and ((cat_s + hdr_s) >= 2 or cat_s == 0)):
            return None
        return Violation(
            "BR-S-01",
            "A Standard rated (S) item/allowance/charge is present, so the "
            "VAT breakdown (BG-23) must contain a Standard rated VAT "
            "category.",
            "ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax/"
            "ram:CategoryCode")
    item_has_s = "S" in inv.all_category_ids()
    breakdown_has_s = "S" in inv.breakdown_category_ids()
    if item_has_s != breakdown_has_s:
        if item_has_s:
            msg = ("A Standard rated (S) item/allowance/charge is present, so the "
                   "VAT breakdown (BG-23) must contain a Standard rated VAT category.")
        else:
            msg = ("The VAT breakdown (BG-23) contains a Standard rated (S) VAT "
                   "category, but no Standard rated item/allowance/charge is present.")
        return Violation(
            "BR-S-01", msg,
            "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")
    return None


def br_z_01(inv):
    """BR-Z-01: If any line/allowance/charge is Zero rated (Z), the VAT breakdown
    must contain exactly one Zero rated category.

    The CII binding is the exact BR-AE-01 shape for category 'Z' (raw
    comparisons, no VAT TypeCode filter, and an orphan Z breakdown row
    fires) — byte-identical to the official BR-E-01 CII test with 'E'
    replaced by 'Z' — so the body branches on ``inv.syntax`` like
    :func:`br_e_01` (see :func:`_cii_vat_exactly_one_breakdown`).
    """
    if inv.syntax == "cii":
        if _cii_vat_exactly_one_breakdown(inv, "Z"):
            return None
        return Violation(
            "BR-Z-01",
            "An Invoice with a 'Zero rated' (Z) VAT category (BT-151/BT-95/"
            "BT-102) must contain exactly one Z VAT breakdown row (BT-118); "
            "found %d."
            % sum(1 for row in inv.cii_header_trade_tax_code_rows
                  if "Z" in row),
            "ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax/"
            "ram:CategoryCode")
    if "Z" in inv.all_category_ids():
        z_count = inv.breakdown_category_ids().count("Z")
        if z_count != 1:
            return Violation(
                "BR-Z-01",
                "A Zero rated (Z) item is present, so the VAT breakdown (BG-23) "
                "must contain exactly one Zero rated VAT category (found %d)."
                % z_count,
                "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")
    return None


def br_co_16(inv):
    """BR-CO-16: Amount due for payment (BT-115) = Invoice total with VAT
    (BT-112) − Paid amount (BT-113) + Rounding amount (BT-114).

    Official (context ``cac:LegalMonetaryTotal``) is a 4-way disjunction keyed
    on the PRESENCE of ``cbc:PrepaidAmount`` / ``cbc:PayableRoundingAmount``:

    * neither present:  ``PayableAmount = TaxInclusiveAmount``  (EXACT decimal
      equality — no rounding in the official test);
    * prepaid only:     ``PayableAmount = round2(TaxIncl − Prepaid)``;
    * rounding only:    ``round2(Payable − Rounding) = TaxInclusiveAmount``
      (right side unrounded);
    * both:             ``round2(Payable − Rounding) = round2(TaxIncl − Prepaid)``.

    round2 = ``round(x*100) div 100`` with fn:round() (halves toward +inf)
    semantics. A missing/unparseable operand casts to the empty sequence, every
    comparison with it is false, and the assert FIRES.
    """
    if not inv.has_legal_monetary_total:
        return None  # context node absent -> rule never evaluated
    payable = _dec(inv.payable_amount)
    tax_incl = _dec(inv.tax_inclusive_amount)
    prepaid_present = inv.prepaid_amount is not None
    rounding_present = inv.payable_rounding_amount is not None
    prepaid = _dec(inv.prepaid_amount)
    rounding = _dec(inv.payable_rounding_amount)

    if payable is None or tax_incl is None:
        holds = False
    elif not prepaid_present and not rounding_present:
        holds = (payable == tax_incl)
    elif prepaid_present and not rounding_present:
        holds = (prepaid is not None and payable == _xr2(tax_incl - prepaid))
    elif not prepaid_present and rounding_present:
        holds = (rounding is not None and _xr2(payable - rounding) == tax_incl)
    else:
        holds = (prepaid is not None and rounding is not None
                 and _xr2(payable - rounding) == _xr2(tax_incl - prepaid))
    if holds:
        return None
    return Violation(
        "BR-CO-16",
        "Amount due for payment (BT-115=%s) must equal Invoice total with VAT "
        "(BT-112=%s) - paid amount (BT-113=%s) + rounding amount (BT-114=%s)."
        % (inv.payable_amount or "(absent)", inv.tax_inclusive_amount or "(absent)",
           inv.prepaid_amount if prepaid_present else "(absent)",
           inv.payable_rounding_amount if rounding_present else "(absent)"),
        "cac:LegalMonetaryTotal/cbc:PayableAmount")


def br_co_17(inv):
    """BR-CO-17: VAT category tax amount (BT-117) = VAT category taxable amount
    (BT-116) x (VAT category rate (BT-119) / 100), rounded to two decimals.

    Official (context = EVERY ``cac:TaxTotal/cac:TaxSubtotal``, any depth) is a
    3-way disjunction, where pct = the VAT-scheme TaxCategory's xs:decimal
    Percent (a non-VAT scheme or missing Percent = absent):

    * fn:round(pct) = 0  and fn:round(TaxAmount) = 0; or
    * fn:round(pct) != 0 and |TaxAmount| is STRICTLY within +/-1 of
      round2(|TaxableAmount| * pct/100)  (a whole tolerance band, not equality —
      the legal artifact allows sub-1-unit rounding drift here); or
    * pct absent and fn:round(TaxAmount) = 0.

    A missing TaxAmount / TaxableAmount operand makes its comparison false, so
    the assert FIRES.
    """
    for st in inv.all_tax_subtotals:
        pct = _dec(st.percent) if st.category_scheme_id == "VAT" else None
        tax = _dec(st.tax_amount)
        taxable = _dec(st.taxable_amount)
        d1 = (pct is not None and _fn_round(pct) == 0
              and tax is not None and _fn_round(tax) == 0)
        d2 = False
        if (pct is not None and _fn_round(pct) != 0
                and tax is not None and taxable is not None):
            expected = _xr2(abs(taxable) * (pct / Decimal(100)))
            d2 = (abs(tax) - 1 < expected) and (abs(tax) + 1 > expected)
        d3 = (pct is None and tax is not None and _fn_round(tax) == 0)
        if not (d1 or d2 or d3):
            return Violation(
                "BR-CO-17",
                "VAT category tax amount (BT-117=%s) must equal VAT category "
                "taxable amount (BT-116=%s) x (VAT rate (BT-119=%s) / 100), "
                "rounded to two decimals."
                % (st.tax_amount or "(absent)", st.taxable_amount or "(absent)",
                   st.percent if pct is not None else "(absent)"),
                "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount")
    return None


def br_co_18(inv):
    """BR-CO-18: An Invoice shall at least have one VAT breakdown group (BG-23).

    Official (context ``/ubl:Invoice``): ``exists(cac:TaxTotal/cac:TaxSubtotal)``
    — at least one TaxSubtotal under a TOP-LEVEL TaxTotal.
    """
    for tt in inv.tax_totals:
        if tt.subtotals:
            return None
    return Violation(
        "BR-CO-18",
        "An Invoice shall at least have one VAT breakdown group (BG-23).",
        "cac:TaxTotal/cac:TaxSubtotal")


# ---------------------------------------------------------------------------
# VAT breakdown group (BG-23) — per-subtotal existence + rate.
# Context everywhere here: cac:TaxTotal/cac:TaxSubtotal (any depth), so these
# use inv.all_tax_subtotals — exactly like BR-CO-17 / BR-DEC-19/20.
# ---------------------------------------------------------------------------
def br_45(inv):
    """BR-45: Each VAT breakdown (BG-23) shall have a VAT category taxable
    amount (BT-116).

    Official (context ``cac:TaxTotal/cac:TaxSubtotal``): ``exists(cbc:TaxableAmount)``
    — pure existence (present-but-empty satisfies it; only absence fires). The
    parser's ``taxable_amount_raw`` is ``None`` iff the element is absent.
    """
    for st in inv.all_tax_subtotals:
        if st.taxable_amount_raw is None:
            return Violation(
                "BR-45",
                "Each VAT breakdown (BG-23) shall have a VAT category taxable "
                "amount (BT-116).",
                "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount")
    return None


def br_46(inv):
    """BR-46: Each VAT breakdown (BG-23) shall have a VAT category tax amount
    (BT-117).

    Official (context ``cac:TaxTotal/cac:TaxSubtotal``): ``exists(cbc:TaxAmount)``.
    """
    for st in inv.all_tax_subtotals:
        if st.tax_amount_raw is None:
            return Violation(
                "BR-46",
                "Each VAT breakdown (BG-23) shall have a VAT category tax "
                "amount (BT-117).",
                "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount")
    return None


def br_47(inv):
    """BR-47: Each VAT breakdown (BG-23) shall be defined through a VAT category
    code (BT-118).

    Official (context ``cac:TaxTotal/cac:TaxSubtotal``)::

        exists(cac:TaxCategory[cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']/cbc:ID)

    A VAT-scheme ``cac:TaxCategory`` carrying a ``cbc:ID`` must exist. A subtotal
    with no TaxCategory, a non-VAT TaxScheme, or a VAT TaxCategory without an ID
    fires the assert (present-but-empty ID satisfies existence — ``category_id``
    is ``None`` only when the ID element is absent).
    """
    for st in inv.all_tax_subtotals:
        if not (st.category_scheme_id == "VAT" and st.category_id is not None):
            return Violation(
                "BR-47",
                "Each VAT breakdown (BG-23) shall be defined through a VAT "
                "category code (BT-118).",
                "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")
    return None


def br_48(inv):
    """BR-48: Each VAT breakdown (BG-23) shall have a VAT category rate
    (BT-119), except if the Invoice is not subject to VAT.

    Official (context ``cac:TaxTotal/cac:TaxSubtotal``)::

        exists(cac:TaxCategory[VAT]/cbc:Percent)
          or (cac:TaxCategory[VAT]/normalize-space(cbc:ID) = 'O')

    Both disjuncts require the VAT-scheme TaxCategory: a VAT breakdown must carry
    a Percent (BT-119) UNLESS its category is 'O' (Not subject to VAT). No VAT
    TaxCategory at all fires the assert. ``category_id`` is already
    normalize-space()d/stripped by the parser, so ``== 'O'`` is exact.
    """
    for st in inv.all_tax_subtotals:
        vat = st.category_scheme_id == "VAT"
        holds = vat and (st.percent is not None or st.category_id == "O")
        if not holds:
            return Violation(
                "BR-48",
                "Each VAT breakdown (BG-23) shall have a VAT category rate "
                "(BT-119), except if the Invoice is not subject to VAT.",
                "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:Percent")
    return None


# ---------------------------------------------------------------------------
# Standard-rated (S) VAT category rules (BR-S-02..10, minus the -01/-08 already
# handled / documented). "S rate > 0" reads BT-152/BT-96/BT-103; the seller-id
# rules read the Seller/tax-representative VAT identifiers; BR-S-09/10 are
# breakdown rules scoped to TOP-LEVEL TaxTotals (official context "/*/cac:TaxTotal").
# ---------------------------------------------------------------------------
def _percent_gt_zero(percent_text):
    """The official ``(cbc:Percent) > 0`` test: holds iff Percent parses to a
    number strictly greater than zero. Absent / empty / non-numeric / <= 0 all
    make the general comparison false, so the assert fires."""
    pct = _dec(percent_text)
    return pct is not None and pct > 0


def _percent_eq_zero(percent_text):
    """The official ``xs:decimal(cbc:Percent) = 0`` test (BR-Z/E-05..07): holds
    iff Percent parses to exactly zero. An absent Percent casts to the empty
    sequence and ``() = 0`` is false, so the assert fires; a non-numeric value
    is a dynamic error on the official side (no verdict) — treated as firing."""
    pct = _dec(percent_text)
    return pct is not None and pct == 0


def _ac_has_vat_category(inv, is_charge, code):
    """True iff any allowance (is_charge False) / charge (True) carries a VAT
    TaxCategory whose code is ``code`` — the ``//cac:AllowanceCharge[...]/
    cac:TaxCategory[normalize-space(cbc:ID)=code][VAT]`` node set (document-
    AND line-level)."""
    for ac in inv.all_allowance_charges():
        if ac.is_charge is is_charge:
            for cat in ac.tax_categories:
                if cat.id == code and cat.scheme_id == "VAT":
                    return True
    return False


def _ac_has_standard_rated(inv, is_charge):
    """The BR-S-03/04/06/07 node set (code 'S')."""
    return _ac_has_vat_category(inv, is_charge, "S")


def br_s_02(inv):
    """BR-S-02: An Invoice with a Standard-rated (S) Invoice line (BT-151) shall
    contain the Seller VAT Identifier (BT-31), Seller tax registration id
    (BT-32) and/or Seller tax representative VAT id (BT-63).

    Official (context ``/ubl:Invoice``)::

        (exists(//ClassifiedTaxCategory[ID='S'][VAT]) and SELLER_ID)
          or not(exists(//ClassifiedTaxCategory[ID='S']))

    Two node sets that DIFFER: the first disjunct's S-line check is VAT-scheme
    scoped (call it A), the last disjunct's is SCHEME-AGNOSTIC (C — no TaxScheme
    predicate). So the assert fires iff ``C and not(A and SELLER_ID)`` — an S
    ClassifiedTaxCategory exists (any scheme) AND it is not the case that a
    VAT-scheme S line is backed by a Seller VAT identifier. SELLER_ID = a Seller
    ``PartyTaxScheme/CompanyID`` (ANY scheme) or a tax-representative VAT
    ``PartyTaxScheme/CompanyID``.
    """
    if not inv.has_classified_category("S", scheme=None):   # C
        return None
    if (inv.has_classified_category("S", "VAT")             # A
            and inv.seller_has_vat_identifier()):           # SELLER_ID
        return None
    return Violation(
        "BR-S-02",
        "An Invoice with a Standard rated (S) Invoice line (BT-151) shall "
        "contain the Seller VAT Identifier (BT-31), the Seller tax "
        "registration identifier (BT-32) and/or the Seller tax "
        "representative VAT identifier (BT-63).",
        "cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID")


def br_s_03(inv):
    """BR-S-03: An Invoice with a Standard-rated (S) Document level allowance
    (BT-95) shall contain the Seller VAT id / tax registration id / tax rep VAT
    id (same seller disjunct as BR-S-02)."""
    if _ac_has_standard_rated(inv, False) and not inv.seller_has_vat_identifier():
        return Violation(
            "BR-S-03",
            "An Invoice with a Standard rated (S) Document level allowance "
            "(BT-95) shall contain the Seller VAT Identifier (BT-31), the "
            "Seller tax registration identifier (BT-32) and/or the Seller tax "
            "representative VAT identifier (BT-63).",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_s_04(inv):
    """BR-S-04: An Invoice with a Standard-rated (S) Document level charge
    (BT-102) shall contain the Seller VAT id / tax registration id / tax rep VAT
    id (same seller disjunct as BR-S-02)."""
    if _ac_has_standard_rated(inv, True) and not inv.seller_has_vat_identifier():
        return Violation(
            "BR-S-04",
            "An Invoice with a Standard rated (S) Document level charge "
            "(BT-102) shall contain the Seller VAT Identifier (BT-31), the "
            "Seller tax registration identifier (BT-32) and/or the Seller tax "
            "representative VAT identifier (BT-63).",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_s_05(inv):
    """BR-S-05: In an Invoice line where the Invoiced item VAT category code
    (BT-151) is 'Standard rated' the Invoiced item VAT rate (BT-152) shall be
    greater than zero.

    Official (context ``cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory
    [normalize-space(cbc:ID)='S'][VAT]``): ``(cbc:Percent) > 0`` per matching
    category (absent / <= 0 fires).
    """
    for ln in inv.lines:
        for cat in ln.item_tax_categories:
            if (cat.id == "S" and cat.scheme_id == "VAT"
                    and not _percent_gt_zero(cat.percent)):
                return Violation(
                    "BR-S-05",
                    "In an Invoice line (BG-25) where the Invoiced item VAT "
                    "category code (BT-151) is 'Standard rated' the Invoiced "
                    "item VAT rate (BT-152) shall be greater than zero.",
                    ln.label + "/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent")
    return None


def br_s_06(inv):
    """BR-S-06: In a Document level allowance where the allowance VAT category
    code (BT-95) is 'Standard rated' the allowance VAT rate (BT-96) shall be
    greater than zero.

    Official (context ``cac:AllowanceCharge[cbc:ChargeIndicator=false()]/
    cac:TaxCategory[normalize-space(cbc:ID)='S'][VAT]``): ``(cbc:Percent) > 0``.
    """
    for ac in inv.all_allowance_charges():
        if ac.is_charge is False:
            for cat in ac.tax_categories:
                if (cat.id == "S" and cat.scheme_id == "VAT"
                        and not _percent_gt_zero(cat.percent)):
                    return Violation(
                        "BR-S-06",
                        "In a Document level allowance (BG-20) where the "
                        "Document level allowance VAT category code (BT-95) is "
                        "'Standard rated' the Document level allowance VAT rate "
                        "(BT-96) shall be greater than zero.",
                        "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_s_07(inv):
    """BR-S-07: In a Document level charge where the charge VAT category code
    (BT-102) is 'Standard rated' the charge VAT rate (BT-103) shall be greater
    than zero.

    Official (context ``cac:AllowanceCharge[cbc:ChargeIndicator=true()]/
    cac:TaxCategory[normalize-space(cbc:ID)='S'][VAT]``): ``(cbc:Percent) > 0``.
    """
    for ac in inv.all_allowance_charges():
        if ac.is_charge is True:
            for cat in ac.tax_categories:
                if (cat.id == "S" and cat.scheme_id == "VAT"
                        and not _percent_gt_zero(cat.percent)):
                    return Violation(
                        "BR-S-07",
                        "In a Document level charge (BG-21) where the Document "
                        "level charge VAT category code (BT-102) is 'Standard "
                        "rated' the Document level charge VAT rate (BT-103) "
                        "shall be greater than zero.",
                        "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_s_09(inv):
    """BR-S-09: The VAT category tax amount (BT-117) in a Standard-rated (S) VAT
    breakdown shall equal the VAT category taxable amount (BT-116) x the VAT
    category rate (BT-119).

    Official (context ``/*/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)='S'][VAT]`` — TOP-LEVEL TaxTotals only)::

        abs(TaxAmount) - 1 < round2(abs(TaxableAmount) * Percent/100)
          and abs(TaxAmount) + 1 > round2(abs(TaxableAmount) * Percent/100)

    A ±1 tolerance band (like BR-CO-17), not equality; round2 = ``round(x*100)
    div 100`` with fn:round() (halves toward +inf). A missing TaxAmount /
    TaxableAmount / Percent makes the comparison false, so the assert fires.
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if not (st.category_id == "S" and st.category_scheme_id == "VAT"):
                continue
            pct = _dec(st.percent)
            tax = _dec(st.tax_amount)
            taxable = _dec(st.taxable_amount)
            holds = False
            if pct is not None and tax is not None and taxable is not None:
                expected = _xr2(abs(taxable) * (pct / Decimal(100)))
                holds = (abs(tax) - 1 < expected) and (abs(tax) + 1 > expected)
            if not holds:
                return Violation(
                    "BR-S-09",
                    "The VAT category tax amount (BT-117=%s) in a Standard "
                    "rated (S) VAT breakdown must equal the VAT category "
                    "taxable amount (BT-116=%s) x (VAT rate (BT-119=%s) / 100)."
                    % (st.tax_amount or "(absent)",
                       st.taxable_amount or "(absent)",
                       st.percent if st.percent is not None else "(absent)"),
                    "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount")
    return None


def br_s_10(inv):
    """BR-S-10: A VAT breakdown (BG-23) with a Standard rated (S) VAT category
    code (BT-118) shall not have a VAT exemption reason text (BT-120) or code
    (BT-121).

    Official (context ``/*/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)='S'][VAT]``)::

        not(cbc:TaxExemptionReason) and not(cbc:TaxExemptionReasonCode)
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if (st.category_id == "S" and st.category_scheme_id == "VAT"
                    and (st.has_exemption_reason or st.has_exemption_reason_code)):
                return Violation(
                    "BR-S-10",
                    "A VAT breakdown (BG-23) with a Standard rated (S) VAT "
                    "category code (BT-118) shall not have a VAT exemption "
                    "reason text (BT-120) or code (BT-121).",
                    "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/"
                    "cbc:TaxExemptionReason")
    return None


# ---------------------------------------------------------------------------
# Zero-rated (Z) and Exempt (E) VAT category rules (BR-Z-02..10, BR-E-02..10).
# Same shapes as the BR-S family, with three differences pinned by the official
# Schematron:
#
# * the seller-id rules (-02..04) are SYMMETRIC: both disjuncts of the official
#   test use the SAME VAT-scheme-scoped node set (unlike BR-S-02, whose last
#   disjunct is scheme-agnostic), so the assert fires iff a VAT-scheme Z/E
#   line/allowance/charge exists AND no Seller VAT identifier is present;
# * the rate rules (-05..07) require ``xs:decimal(cbc:Percent) = 0`` (absent
#   Percent -> empty sequence -> comparison false -> fires), not ``> 0``;
# * the breakdown rules (-08..10) are per TOP-LEVEL TaxTotal subtotal whose
#   VAT TaxCategory code is Z/E: BT-116 must equal the EXACT (unrounded,
#   no tolerance band) sum of matching line net amounts + charges − allowances
#   (-08), BT-117 must equal 0 (-09), and the exemption reason is FORBIDDEN
#   for Z (-10) but REQUIRED for E (-10).
# ---------------------------------------------------------------------------
_SELLER_ID_ELEMENT = ("cac:AccountingSupplierParty/cac:Party/"
                      "cac:PartyTaxScheme/cbc:CompanyID")


def _seller_id_message(label, subject):
    return ("An Invoice with a %s %s shall contain the Seller VAT Identifier "
            "(BT-31), the Seller tax registration identifier (BT-32) and/or "
            "the Seller tax representative VAT identifier (BT-63)."
            % (label, subject))


def _line_seller_id_fires(inv, code):
    """The BR-Z/E-02 shape (context ``/ubl:Invoice``)::

        (exists(//cac:ClassifiedTaxCategory[normalize-space(cbc:ID)=code][VAT])
           and SELLER_ID)
        or not(exists(//cac:ClassifiedTaxCategory[normalize-space(cbc:ID)=code][VAT]))

    Both disjuncts test the SAME VAT-scoped node set, so the assert fires iff a
    VAT-scheme ``code`` invoice line exists and no Seller VAT identifier does.
    SELLER_ID = a Seller ``PartyTaxScheme/CompanyID`` (ANY scheme) or a
    tax-representative VAT ``PartyTaxScheme/CompanyID`` — same as BR-S-02.
    """
    return (inv.has_classified_category(code, "VAT")
            and not inv.seller_has_vat_identifier())


def _ac_seller_id_fires(inv, code, is_charge):
    """The BR-Z/E-03/04 shape: a VAT-scheme ``code`` document level allowance
    (is_charge False, BT-95) / charge (True, BT-102) requires the Seller VAT
    identifier disjunct. Symmetric node sets, both ``//cac:AllowanceCharge
    [ChargeIndicator]/cac:TaxCategory[normalize-space(cbc:ID)=code][VAT]``."""
    return (_ac_has_vat_category(inv, is_charge, code)
            and not inv.seller_has_vat_identifier())


def _line_rate_nonzero(inv, code):
    """The BR-Z/E-05 shape (context ``cac:InvoiceLine/cac:Item/
    cac:ClassifiedTaxCategory[normalize-space(cbc:ID)=code][VAT]``):
    ``xs:decimal(cbc:Percent) = 0`` per matching category. Returns the first
    offending line, or None when the rule holds."""
    for ln in inv.lines:
        for cat in ln.item_tax_categories:
            if (cat.id == code and cat.scheme_id == "VAT"
                    and not _percent_eq_zero(cat.percent)):
                return ln
    return None


def _ac_rate_nonzero(inv, code, is_charge):
    """The BR-Z/E-06/07 shape (context ``cac:AllowanceCharge[ChargeIndicator]/
    cac:TaxCategory[normalize-space(cbc:ID)=code][VAT]`` — document- AND
    line-level, like BR-S-06/07): ``xs:decimal(cbc:Percent) = 0``."""
    for ac in inv.all_allowance_charges():
        if ac.is_charge is is_charge:
            for cat in ac.tax_categories:
                if (cat.id == code and cat.scheme_id == "VAT"
                        and not _percent_eq_zero(cat.percent)):
                    return True
    return False


def _breakdown_taxable_sum_mismatch(inv, code, cii_band=True):
    """The BR-Z/E-08 shape (context ``/*/cac:TaxTotal/cac:TaxSubtotal/
    cac:TaxCategory[normalize-space(cbc:ID)=code][VAT]`` — TOP-LEVEL TaxTotals
    only). For an Invoice document the official test reduces to::

        exists(//cac:InvoiceLine) and
        xs:decimal(../cbc:TaxableAmount)
          = sum(/Invoice/cac:InvoiceLine[cac:Item/cac:ClassifiedTaxCategory/
                  normalize-space(cbc:ID)=code]/xs:decimal(cbc:LineExtensionAmount))
            + sum(charges with cac:TaxCategory[normalize-space(cbc:ID)=code])
            - sum(allowances with cac:TaxCategory[normalize-space(cbc:ID)=code])

    Three details the official UBL XPath pins down:

    * the line/allowance/charge predicates are SCHEME-AGNOSTIC (no TaxScheme
      test — unlike this rule's own context);
    * the equality is EXACT xs:decimal equality — no rounding, no tolerance
      band (unlike BR-S-08/09);
    * with no ``cac:InvoiceLine`` in the document neither disjunct can hold,
      so the assert FIRES; a missing BT-116 casts to the empty sequence and
      fires too. Lines/allowances missing their amount contribute nothing.

    The CII binding (context ``//ram:ApplicableHeaderTradeSettlement/
    ram:ApplicableTradeTax/ram:CategoryCode[.=code][upper-case(../ram:TypeCode)
    ='VAT']`` — the CategoryCode CHILD, like BR-S-08's context, so the assert
    CAN fire, unlike the row-bound BR-AF/AG-08 artifact defects) is genuinely
    different and shared verbatim by the Z/E/AE/K/G families::

        ../ram:BasisAmount - 1 < round2(Σ code-line LineTotalAmount)
                                 + round2(Σ code header charges' ActualAmount[1])
                                 - round2(Σ code header allowances' ActualAmount[1])
        and ../ram:BasisAmount + 1 > (the same sum)

    i.e. a STRICT ±1 tolerance band around the PER-BUCKET fn:round 2-place
    sums (round2 = ``round(x*10*10) div 100``, the ``_xr2`` idiom) — where
    the UBL binding is exact and unrounded. The CII sum predicates are raw,
    scheme-agnostic comparisons (``ram:CategoryCode = code``, no TypeCode
    test) over document lines and HEADER-level allowance/charge groups split
    by ``ChargeIndicator/udt:Indicator``; there is NO exists(//line) term, so
    a line-less document holds when BT-116 sits inside the band around the
    allowance/charge sums; a missing BT-116 empties the band comparison and
    fires.

    ``cii_band=False`` selects the OTHER official CII shape (BR-O-08,
    T-VHCIIP.6): the assert is bound to the ``ram:ApplicableTradeTax`` ROW
    itself (``[ram:CategoryCode = 'O'][upper-case(ram:TypeCode) = 'VAT']``)
    and its test is EXACT — ``ram:BasisAmount = round2(Σ O-line
    LineTotalAmount) + round2(Σ O header charges) − round2(Σ O header
    allowances)`` — the same raw, scheme-agnostic sum predicates and per-sum
    ``round(x*10*10) div 100`` rounding as the band shape, but with NO ±1
    tolerance and, like the band shape, NO exists(//line) term (a line-less
    O invoice with a 0.00 BasisAmount HOLDS on CII where the UBL binding
    fires); a missing BT-116 fails the equality and fires.

    Returns ``(subtotal, expected_sum)`` for the first offending breakdown,
    or None when the rule holds.
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if not (st.category_id == code
                    and st.category_scheme_id == "VAT"):
                continue
            line_sum = Decimal("0")
            for ln in inv.lines:
                if any(cat.id == code for cat in ln.item_tax_categories):
                    v = _dec(ln.line_extension_amount)
                    if v is not None:
                        line_sum += v
            charge_sum = Decimal("0")
            allowance_sum = Decimal("0")
            for ac in inv.doc_allowance_charges:
                if ac.is_charge is None:
                    continue
                if any(cat.id == code for cat in ac.tax_categories):
                    v = _dec(ac.amount_raw)
                    if v is None:
                        continue
                    if ac.is_charge:
                        charge_sum += v
                    else:
                        allowance_sum += v
            taxable = _dec(st.taxable_amount)
            if inv.syntax == "cii":
                expected = (_xr2(line_sum) + _xr2(charge_sum)
                            - _xr2(allowance_sum))
                if cii_band:
                    if not (taxable is not None
                            and taxable - 1 < expected
                            and taxable + 1 > expected):
                        return st, expected
                else:  # BR-O-08: exact equality, no band, no exists(//line)
                    if taxable is None or taxable != expected:
                        return st, expected
                continue
            expected = line_sum + charge_sum - allowance_sum
            if not inv.lines or taxable is None or taxable != expected:
                return st, expected
    return None


def _taxable_sum_message(label, st, expected):
    return ("In a VAT breakdown (BG-23) where the VAT category code (BT-118) "
            "is '%s' the VAT category taxable amount (BT-116=%s) shall equal "
            "the sum of Invoice line net amounts minus allowances plus "
            "charges with a '%s' VAT category code (= %s)."
            % (label, st.taxable_amount or "(absent)", label, expected))


def _breakdown_tax_nonzero(inv, code):
    """The BR-Z/E-09 shape (same top-level breakdown context as -08):
    ``xs:decimal(../cbc:TaxAmount) = 0`` — a missing/unparseable BT-117
    fires (empty sequence compares false). Returns the first offending
    subtotal, or None when the rule holds."""
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if st.category_id == code and st.category_scheme_id == "VAT":
                tax = _dec(st.tax_amount)
                if tax is None or tax != 0:
                    return st
    return None


def _tax_zero_message(label, st):
    return ("The VAT category tax amount (BT-117=%s) in a VAT breakdown "
            "(BG-23) where the VAT category code (BT-118) is '%s' shall "
            "equal 0 (zero)." % (st.tax_amount or "(absent)", label))


def br_z_02(inv):
    """BR-Z-02: a Zero-rated (Z) Invoice line (BT-151) requires the Seller VAT
    identifier / tax registration id / tax representative VAT id."""
    if _line_seller_id_fires(inv, "Z"):
        return Violation(
            "BR-Z-02",
            _seller_id_message("Zero rated (Z)", "Invoice line (BT-151)"),
            _SELLER_ID_ELEMENT)
    return None


def br_z_03(inv):
    """BR-Z-03: a Zero-rated (Z) Document level allowance (BT-95) requires the
    Seller VAT identifier disjunct."""
    if _ac_seller_id_fires(inv, "Z", False):
        return Violation(
            "BR-Z-03",
            _seller_id_message("Zero rated (Z)",
                               "Document level allowance (BT-95)"),
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_z_04(inv):
    """BR-Z-04: a Zero-rated (Z) Document level charge (BT-102) requires the
    Seller VAT identifier disjunct."""
    if _ac_seller_id_fires(inv, "Z", True):
        return Violation(
            "BR-Z-04",
            _seller_id_message("Zero rated (Z)",
                               "Document level charge (BT-102)"),
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_z_05(inv):
    """BR-Z-05: in a Zero-rated (Z) Invoice line the Invoiced item VAT rate
    (BT-152) shall be 0."""
    ln = _line_rate_nonzero(inv, "Z")
    if ln is not None:
        return Violation(
            "BR-Z-05",
            "In an Invoice line (BG-25) where the Invoiced item VAT category "
            "code (BT-151) is 'Zero rated' the Invoiced item VAT rate "
            "(BT-152) shall be 0 (zero).",
            ln.label + "/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent")
    return None


def br_z_06(inv):
    """BR-Z-06: in a Zero-rated (Z) Document level allowance the allowance VAT
    rate (BT-96) shall be 0."""
    if _ac_rate_nonzero(inv, "Z", False):
        return Violation(
            "BR-Z-06",
            "In a Document level allowance (BG-20) where the Document level "
            "allowance VAT category code (BT-95) is 'Zero rated' the Document "
            "level allowance VAT rate (BT-96) shall be 0 (zero).",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_z_07(inv):
    """BR-Z-07: in a Zero-rated (Z) Document level charge the charge VAT rate
    (BT-103) shall be 0."""
    if _ac_rate_nonzero(inv, "Z", True):
        return Violation(
            "BR-Z-07",
            "In a Document level charge (BG-21) where the Document level "
            "charge VAT category code (BT-102) is 'Zero rated' the Document "
            "level charge VAT rate (BT-103) shall be 0 (zero).",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_z_08(inv):
    """BR-Z-08: the Zero-rated (Z) VAT breakdown taxable amount (BT-116) shall
    equal the exact sum of Z line net amounts − Z allowances + Z charges."""
    hit = _breakdown_taxable_sum_mismatch(inv, "Z")
    if hit is not None:
        st, expected = hit
        return Violation(
            "BR-Z-08", _taxable_sum_message("Zero rated", st, expected),
            "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount")
    return None


def br_z_09(inv):
    """BR-Z-09: the VAT category tax amount (BT-117) in a Zero-rated (Z) VAT
    breakdown shall equal 0."""
    st = _breakdown_tax_nonzero(inv, "Z")
    if st is not None:
        return Violation(
            "BR-Z-09", _tax_zero_message("Zero rated", st),
            "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount")
    return None


def br_z_10(inv):
    """BR-Z-10: a VAT breakdown (BG-23) with a Zero rated (Z) VAT category code
    (BT-118) shall not have a VAT exemption reason text (BT-120) or code
    (BT-121).

    Official (context ``/*/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)='Z'][VAT]``)::

        not((cbc:TaxExemptionReason) or (cbc:TaxExemptionReasonCode))
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if (st.category_id == "Z" and st.category_scheme_id == "VAT"
                    and (st.has_exemption_reason or st.has_exemption_reason_code)):
                return Violation(
                    "BR-Z-10",
                    "A VAT breakdown (BG-23) with a Zero rated (Z) VAT "
                    "category code (BT-118) shall not have a VAT exemption "
                    "reason code (BT-121) or VAT exemption reason text "
                    "(BT-120).",
                    "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/"
                    "cbc:TaxExemptionReason")
    return None


def br_e_02(inv):
    """BR-E-02: an Exempt (E) Invoice line (BT-151) requires the Seller VAT
    identifier / tax registration id / tax representative VAT id."""
    if _line_seller_id_fires(inv, "E"):
        return Violation(
            "BR-E-02",
            _seller_id_message("Exempt from VAT (E)", "Invoice line (BT-151)"),
            _SELLER_ID_ELEMENT)
    return None


def br_e_03(inv):
    """BR-E-03: an Exempt (E) Document level allowance (BT-95) requires the
    Seller VAT identifier disjunct."""
    if _ac_seller_id_fires(inv, "E", False):
        return Violation(
            "BR-E-03",
            _seller_id_message("Exempt from VAT (E)",
                               "Document level allowance (BT-95)"),
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_e_04(inv):
    """BR-E-04: an Exempt (E) Document level charge (BT-102) requires the
    Seller VAT identifier disjunct."""
    if _ac_seller_id_fires(inv, "E", True):
        return Violation(
            "BR-E-04",
            _seller_id_message("Exempt from VAT (E)",
                               "Document level charge (BT-102)"),
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_e_05(inv):
    """BR-E-05: in an Exempt (E) Invoice line the Invoiced item VAT rate
    (BT-152) shall be 0."""
    ln = _line_rate_nonzero(inv, "E")
    if ln is not None:
        return Violation(
            "BR-E-05",
            "In an Invoice line (BG-25) where the Invoiced item VAT category "
            "code (BT-151) is 'Exempt from VAT', the Invoiced item VAT rate "
            "(BT-152) shall be 0 (zero).",
            ln.label + "/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent")
    return None


def br_e_06(inv):
    """BR-E-06: in an Exempt (E) Document level allowance the allowance VAT
    rate (BT-96) shall be 0."""
    if _ac_rate_nonzero(inv, "E", False):
        return Violation(
            "BR-E-06",
            "In a Document level allowance (BG-20) where the Document level "
            "allowance VAT category code (BT-95) is 'Exempt from VAT', the "
            "Document level allowance VAT rate (BT-96) shall be 0 (zero).",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_e_07(inv):
    """BR-E-07: in an Exempt (E) Document level charge the charge VAT rate
    (BT-103) shall be 0."""
    if _ac_rate_nonzero(inv, "E", True):
        return Violation(
            "BR-E-07",
            "In a Document level charge (BG-21) where the Document level "
            "charge VAT category code (BT-102) is 'Exempt from VAT', the "
            "Document level charge VAT rate (BT-103) shall be 0 (zero).",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_e_08(inv):
    """BR-E-08: the Exempt (E) VAT breakdown taxable amount (BT-116) shall
    equal the sum of E line net amounts − E allowances + E charges (exact on
    UBL; the ±1 band around the round2 bucket sums on CII — see
    :func:`_breakdown_taxable_sum_mismatch`)."""
    hit = _breakdown_taxable_sum_mismatch(inv, "E")
    if hit is not None:
        st, expected = hit
        return Violation(
            "BR-E-08", _taxable_sum_message("Exempt from VAT", st, expected),
            "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount")
    return None


def br_e_09(inv):
    """BR-E-09: the VAT category tax amount (BT-117) in an Exempt (E) VAT
    breakdown shall equal 0."""
    st = _breakdown_tax_nonzero(inv, "E")
    if st is not None:
        return Violation(
            "BR-E-09", _tax_zero_message("Exempt from VAT", st),
            "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount")
    return None


def br_e_10(inv):
    """BR-E-10: a VAT breakdown (BG-23) with an Exempt from VAT (E) VAT
    category code (BT-118) SHALL have a VAT exemption reason code (BT-121) or
    text (BT-120) — the presence-required mirror image of BR-Z-10/BR-S-10.

    Official (context ``/*/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)='E'][VAT]``)::

        exists(cbc:TaxExemptionReason) or exists(cbc:TaxExemptionReasonCode)
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if (st.category_id == "E" and st.category_scheme_id == "VAT"
                    and not (st.has_exemption_reason
                             or st.has_exemption_reason_code)):
                return Violation(
                    "BR-E-10",
                    "A VAT breakdown (BG-23) with an Exempt from VAT (E) VAT "
                    "category code (BT-118) shall have a VAT exemption reason "
                    "code (BT-121) or a VAT exemption reason text (BT-120).",
                    "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/"
                    "cbc:TaxExemptionReason")
    return None


# ---------------------------------------------------------------------------
# Reverse charge (AE) and Intra-community supply (K) VAT category rules
# (BR-AE-02..10, BR-IC-02..12). These share the BR-Z/BR-E rate (-05..07),
# breakdown-sum (-08), breakdown-tax-zero (-09) and (for AE) the exemption-
# reason (-10) shapes, so the helpers above are reused directly. What is NEW
# is the party-identifier requirement of the -02..04 rules: unlike BR-Z/BR-E
# (which need ONLY a Seller identifier), reverse charge and intra-community
# supply are cross-border B2B transactions where the tax liability shifts to
# the customer, so the official Schematron also demands a BUYER identifier.
#
# Reverse charge (AE), BR-AE-02..04 fire iff an AE VAT line/allowance/charge
# exists AND NOT (a SELLER id AND a BUYER id), where:
#   * SELLER id = a Seller PartyTaxScheme/CompanyID (ANY scheme, BT-31/BT-32)
#                 OR a tax-representative VAT PartyTaxScheme/CompanyID (BT-63);
#   * BUYER  id = a Buyer VAT PartyTaxScheme/CompanyID (BT-48)
#                 OR a Buyer PartyLegalEntity/CompanyID (BT-47).
#
# Intra-community supply (K), BR-IC-02..04 are the same shape but STRICTER on
# the identifiers — every accepted id must be VAT-scheme scoped:
#   * SELLER id = a Seller VAT PartyTaxScheme/CompanyID (BT-31)
#                 OR a tax-representative VAT PartyTaxScheme/CompanyID (BT-63);
#   * BUYER  id = a Buyer VAT PartyTaxScheme/CompanyID (BT-48) ONLY (no legal
#                 registration fallback).
# ---------------------------------------------------------------------------
def _ae_buyer_id_present(inv):
    """The BR-AE-02..04 buyer disjunct: a Buyer VAT identifier (BT-48) OR a
    Buyer legal registration identifier (BT-47)."""
    return (inv.buyer_has_vat_scheme_company_id
            or inv.buyer_has_legal_entity_company_id)


def _ic_seller_id_present(inv):
    """The BR-IC-02..04 seller disjunct: a VAT-scoped Seller VAT identifier
    (BT-31) OR a tax-representative VAT identifier (BT-63)."""
    return (inv.seller_has_vat_scheme_company_id
            or inv.taxrep_has_vat_company_id)


def _ae_party_id_message(subject):
    return ("An Invoice with a Reverse charge (AE) %s shall contain the Seller "
            "VAT Identifier (BT-31), the Seller tax registration identifier "
            "(BT-32) and/or the Seller tax representative VAT identifier (BT-63) "
            "AND the Buyer VAT identifier (BT-48) and/or the Buyer legal "
            "registration identifier (BT-47)." % subject)


def _ic_party_id_message(subject):
    return ("An Invoice with an Intra-community supply (K) %s shall contain the "
            "Seller VAT Identifier (BT-31) or the Seller tax representative VAT "
            "identifier (BT-63) AND the Buyer VAT identifier (BT-48)." % subject)


def br_ae_02(inv):
    """BR-AE-02: an Invoice with a Reverse charge (AE) Invoice line (BT-151)
    shall carry a Seller identifier AND a Buyer identifier."""
    if (inv.has_classified_category("AE", "VAT")
            and not (inv.seller_has_vat_identifier()
                     and _ae_buyer_id_present(inv))):
        return Violation(
            "BR-AE-02", _ae_party_id_message("Invoice line (BT-151)"),
            _SELLER_ID_ELEMENT)
    return None


def br_ae_03(inv):
    """BR-AE-03: an Invoice with a Reverse charge (AE) Document level allowance
    (BT-95) shall carry a Seller identifier AND a Buyer identifier."""
    if (_ac_has_vat_category(inv, False, "AE")
            and not (inv.seller_has_vat_identifier()
                     and _ae_buyer_id_present(inv))):
        return Violation(
            "BR-AE-03",
            _ae_party_id_message("Document level allowance (BT-95)"),
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_ae_04(inv):
    """BR-AE-04: an Invoice with a Reverse charge (AE) Document level charge
    (BT-102) shall carry a Seller identifier AND a Buyer identifier."""
    if (_ac_has_vat_category(inv, True, "AE")
            and not (inv.seller_has_vat_identifier()
                     and _ae_buyer_id_present(inv))):
        return Violation(
            "BR-AE-04",
            _ae_party_id_message("Document level charge (BT-102)"),
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_ae_05(inv):
    """BR-AE-05: in a Reverse charge (AE) Invoice line the Invoiced item VAT
    rate (BT-152) shall be 0."""
    ln = _line_rate_nonzero(inv, "AE")
    if ln is not None:
        return Violation(
            "BR-AE-05",
            "In an Invoice line (BG-25) where the Invoiced item VAT category "
            "code (BT-151) is 'Reverse charge' the Invoiced item VAT rate "
            "(BT-152) shall be 0 (zero).",
            ln.label + "/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent")
    return None


def br_ae_06(inv):
    """BR-AE-06: in a Reverse charge (AE) Document level allowance the allowance
    VAT rate (BT-96) shall be 0."""
    if _ac_rate_nonzero(inv, "AE", False):
        return Violation(
            "BR-AE-06",
            "In a Document level allowance (BG-20) where the Document level "
            "allowance VAT category code (BT-95) is 'Reverse charge' the "
            "Document level allowance VAT rate (BT-96) shall be 0 (zero).",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_ae_07(inv):
    """BR-AE-07: in a Reverse charge (AE) Document level charge the charge VAT
    rate (BT-103) shall be 0."""
    if _ac_rate_nonzero(inv, "AE", True):
        return Violation(
            "BR-AE-07",
            "In a Document level charge (BG-21) where the Document level charge "
            "VAT category code (BT-102) is 'Reverse charge' the Document level "
            "charge VAT rate (BT-103) shall be 0 (zero).",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_ae_08(inv):
    """BR-AE-08: the Reverse charge (AE) VAT breakdown taxable amount (BT-116)
    shall equal the exact sum of AE line nets − AE allowances + AE charges."""
    hit = _breakdown_taxable_sum_mismatch(inv, "AE")
    if hit is not None:
        st, expected = hit
        return Violation(
            "BR-AE-08", _taxable_sum_message("Reverse charge", st, expected),
            "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount")
    return None


def br_ae_09(inv):
    """BR-AE-09: the VAT category tax amount (BT-117) in a Reverse charge (AE)
    VAT breakdown shall equal 0."""
    st = _breakdown_tax_nonzero(inv, "AE")
    if st is not None:
        return Violation(
            "BR-AE-09", _tax_zero_message("Reverse charge", st),
            "cac:TaxTotal/cac:TaxSubtotal/cac:TaxAmount")
    return None


def br_ae_10(inv):
    """BR-AE-10: a VAT breakdown (BG-23) with a Reverse charge (AE) VAT category
    code (BT-118) SHALL have a VAT exemption reason code (BT-121) meaning
    'Reverse charge' or the reason text (BT-120) 'Reverse charge' — the
    presence-required shape shared with BR-E-10.

    Official (context ``/*/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)='AE'][VAT]``)::

        exists(cbc:TaxExemptionReason) or exists(cbc:TaxExemptionReasonCode)
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if (st.category_id == "AE" and st.category_scheme_id == "VAT"
                    and not (st.has_exemption_reason
                             or st.has_exemption_reason_code)):
                return Violation(
                    "BR-AE-10",
                    "A VAT breakdown (BG-23) with a Reverse charge (AE) VAT "
                    "category code (BT-118) shall have a VAT exemption reason "
                    "code (BT-121), meaning 'Reverse charge', or the VAT "
                    "exemption reason text (BT-120) 'Reverse charge'.",
                    "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/"
                    "cbc:TaxExemptionReason")
    return None


def br_ic_02(inv):
    """BR-IC-02: an Invoice with an Intra-community supply (K) Invoice line
    (BT-151) shall carry a VAT-scoped Seller identifier AND the Buyer VAT
    identifier."""
    if (inv.has_classified_category("K", "VAT")
            and not (_ic_seller_id_present(inv)
                     and inv.buyer_has_vat_scheme_company_id)):
        return Violation(
            "BR-IC-02", _ic_party_id_message("Invoice line (BT-151)"),
            _SELLER_ID_ELEMENT)
    return None


def br_ic_03(inv):
    """BR-IC-03: an Invoice with an Intra-community supply (K) Document level
    allowance (BT-95) shall carry a VAT-scoped Seller identifier AND the Buyer
    VAT identifier."""
    if (_ac_has_vat_category(inv, False, "K")
            and not (_ic_seller_id_present(inv)
                     and inv.buyer_has_vat_scheme_company_id)):
        return Violation(
            "BR-IC-03",
            _ic_party_id_message("Document level allowance (BT-95)"),
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_ic_04(inv):
    """BR-IC-04: an Invoice with an Intra-community supply (K) Document level
    charge (BT-102) shall carry a VAT-scoped Seller identifier AND the Buyer
    VAT identifier."""
    if (_ac_has_vat_category(inv, True, "K")
            and not (_ic_seller_id_present(inv)
                     and inv.buyer_has_vat_scheme_company_id)):
        return Violation(
            "BR-IC-04",
            _ic_party_id_message("Document level charge (BT-102)"),
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_ic_05(inv):
    """BR-IC-05: in an Intra-community supply (K) Invoice line the Invoiced item
    VAT rate (BT-152) shall be 0."""
    ln = _line_rate_nonzero(inv, "K")
    if ln is not None:
        return Violation(
            "BR-IC-05",
            "In an Invoice line (BG-25) where the Invoiced item VAT category "
            "code (BT-151) is 'Intra-community supply' the Invoiced item VAT "
            "rate (BT-152) shall be 0 (zero).",
            ln.label + "/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent")
    return None


def br_ic_06(inv):
    """BR-IC-06: in an Intra-community supply (K) Document level allowance the
    allowance VAT rate (BT-96) shall be 0."""
    if _ac_rate_nonzero(inv, "K", False):
        return Violation(
            "BR-IC-06",
            "In a Document level allowance (BG-20) where the Document level "
            "allowance VAT category code (BT-95) is 'Intra-community supply' "
            "the Document level allowance VAT rate (BT-96) shall be 0 (zero).",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_ic_07(inv):
    """BR-IC-07: in an Intra-community supply (K) Document level charge the
    charge VAT rate (BT-103) shall be 0."""
    if _ac_rate_nonzero(inv, "K", True):
        return Violation(
            "BR-IC-07",
            "In a Document level charge (BG-21) where the Document level charge "
            "VAT category code (BT-102) is 'Intra-community supply' the Document "
            "level charge VAT rate (BT-103) shall be 0 (zero).",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_ic_08(inv):
    """BR-IC-08: the Intra-community supply (K) VAT breakdown taxable amount
    (BT-116) shall equal the exact sum of K line nets − K allowances + K
    charges."""
    hit = _breakdown_taxable_sum_mismatch(inv, "K")
    if hit is not None:
        st, expected = hit
        return Violation(
            "BR-IC-08",
            _taxable_sum_message("Intra-community supply", st, expected),
            "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount")
    return None


def br_ic_09(inv):
    """BR-IC-09: the VAT category tax amount (BT-117) in an Intra-community
    supply (K) VAT breakdown shall equal 0."""
    st = _breakdown_tax_nonzero(inv, "K")
    if st is not None:
        return Violation(
            "BR-IC-09", _tax_zero_message("Intra-community supply", st),
            "cac:TaxTotal/cac:TaxSubtotal/cac:TaxAmount")
    return None


def br_ic_11(inv):
    """BR-IC-11: in an Invoice with an Intra-community supply (K) VAT breakdown
    (BG-23) the Actual delivery date (BT-72) or the Invoicing period (BG-14)
    shall not be blank.

    Official (context ``/ubl:Invoice``)::

        (exists K-VAT breakdown row AND
           (string-length(cac:Delivery/cbc:ActualDeliveryDate) > 1
            or (cac:InvoicePeriod/*)))
        or not(exists K-VAT breakdown row)

    So it FIRES iff a K breakdown row exists AND neither a >1-char actual
    delivery date nor a document-level invoicing period with a child is present.

    The CII binding (context = each header K VAT breakdown row's
    ``ram:CategoryCode[.='K'][upper-case(../ram:TypeCode)='VAT']``) is a pure
    NODE-EXISTENCE disjunction — no string-length test, no exists-any-child::

        (/rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction/
           ram:ApplicableHeaderTradeDelivery/ram:ActualDeliverySupplyChainEvent/
           ram:OccurrenceDateTime/udt:DateTimeString)
        or (../../ram:BillingSpecifiedPeriod/ram:StartDateTime)
        or (../../ram:BillingSpecifiedPeriod/ram:EndDateTime)

    (``../..`` = the header ApplicableHeaderTradeSettlement, so ONLY a period
    Start/EndDateTime child counts — a BillingSpecifiedPeriod with some other
    child does NOT satisfy the CII binding, while ANY child satisfies the UBL
    one.) The body branches on ``inv.syntax`` and transcribes each binding
    exactly.
    """
    if "K" not in inv.breakdown_vat_category_codes():
        return None
    if inv.syntax == "cii":
        if not (inv.cii_delivery_datetime_string_present
                or inv.cii_billing_period_start_present
                or inv.cii_billing_period_end_present):
            return Violation(
                "BR-IC-11",
                "In an Invoice with a VAT breakdown (BG-23) where the VAT "
                "category code (BT-118) is 'Intra-community supply' the "
                "Actual delivery date (BT-72) or the Invoicing period "
                "(BG-14) shall not be blank.",
                "ram:ApplicableHeaderTradeDelivery/"
                "ram:ActualDeliverySupplyChainEvent/ram:OccurrenceDateTime/"
                "udt:DateTimeString")
        return None
    date_ok = len(inv.doc_delivery_actual_date_raw or "") > 1
    if not (date_ok or inv.doc_invoice_period_has_child):
        return Violation(
            "BR-IC-11",
            "In an Invoice with a VAT breakdown (BG-23) where the VAT category "
            "code (BT-118) is 'Intra-community supply' the Actual delivery date "
            "(BT-72) or the Invoicing period (BG-14) shall not be blank.",
            "cac:Delivery/cbc:ActualDeliveryDate")
    return None


def br_ic_12(inv):
    """BR-IC-12: in an Invoice with an Intra-community supply (K) VAT breakdown
    (BG-23) the Deliver to country code (BT-80) shall not be blank.

    Official (context ``/ubl:Invoice``)::

        (exists K-VAT breakdown row AND
           string-length(cac:Delivery/cac:DeliveryLocation/cac:Address/
                         cac:Country/cbc:IdentificationCode) > 1)
        or not(exists K-VAT breakdown row)

    FIRES iff a K breakdown row exists AND the document-level deliver-to country
    code is absent or 1 character or shorter.

    The CII binding (same per-K-breakdown-row context as BR-IC-11) is a pure
    NODE-EXISTENCE test — no string-length, so even an EMPTY element
    satisfies it::

        /rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction/
          ram:ApplicableHeaderTradeDelivery/ram:ShipToTradeParty/
          ram:PostalTradeAddress/ram:CountryID

    The body branches on ``inv.syntax`` and transcribes each binding exactly.
    """
    if "K" not in inv.breakdown_vat_category_codes():
        return None
    if inv.syntax == "cii":
        if not inv.cii_shipto_country_id_present:
            return Violation(
                "BR-IC-12",
                "In an Invoice with a VAT breakdown (BG-23) where the VAT "
                "category code (BT-118) is 'Intra-community supply' the "
                "Deliver to country code (BT-80) shall not be blank.",
                "ram:ApplicableHeaderTradeDelivery/ram:ShipToTradeParty/"
                "ram:PostalTradeAddress/ram:CountryID")
        return None
    if len(inv.doc_delivery_country_code_raw or "") <= 1:
        return Violation(
            "BR-IC-12",
            "In an Invoice with a VAT breakdown (BG-23) where the VAT category "
            "code (BT-118) is 'Intra-community supply' the Deliver to country "
            "code (BT-80) shall not be blank.",
            "cac:Delivery/cac:DeliveryLocation/cac:Address/cac:Country/"
            "cbc:IdentificationCode")
    return None


# ---------------------------------------------------------------------------
# Export outside the EU (G) VAT category rules (BR-G-02..10). The G family is
# the BR-E family with ONE difference the official Schematron pins down: the
# seller-identifier disjunct of -02..04 is VAT-scheme SCOPED (like BR-IC, not
# BR-Z/BR-E), so it accepts ONLY a VAT-scheme Seller CompanyID (BT-31) or a
# tax-representative VAT CompanyID (BT-63) — no ANY-scheme / tax-registration
# fallback. Everything else — rate 0 (-05..07), breakdown taxable sum (-08),
# tax 0 (-09), REQUIRED exemption reason (-10) — is the reused BR-E shape.
# ---------------------------------------------------------------------------
def _g_seller_id_message(subject):
    return ("An Invoice with an Export outside the EU (G) %s shall contain the "
            "Seller VAT Identifier (BT-31) or the Seller tax representative VAT "
            "identifier (BT-63)." % subject)


def br_g_02(inv):
    """BR-G-02: an Invoice with an Export outside the EU (G) Invoice line
    (BT-151) shall carry a VAT-scoped Seller identifier (BT-31/BT-63)."""
    if (inv.has_classified_category("G", "VAT")
            and not _ic_seller_id_present(inv)):
        return Violation(
            "BR-G-02", _g_seller_id_message("Invoice line (BT-151)"),
            _SELLER_ID_ELEMENT)
    return None


def br_g_03(inv):
    """BR-G-03: an Invoice with an Export outside the EU (G) Document level
    allowance (BT-95) shall carry a VAT-scoped Seller identifier."""
    if (_ac_has_vat_category(inv, False, "G")
            and not _ic_seller_id_present(inv)):
        return Violation(
            "BR-G-03",
            _g_seller_id_message("Document level allowance (BT-95)"),
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_g_04(inv):
    """BR-G-04: an Invoice with an Export outside the EU (G) Document level
    charge (BT-102) shall carry a VAT-scoped Seller identifier."""
    if (_ac_has_vat_category(inv, True, "G")
            and not _ic_seller_id_present(inv)):
        return Violation(
            "BR-G-04",
            _g_seller_id_message("Document level charge (BT-102)"),
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_g_05(inv):
    """BR-G-05: in an Export outside the EU (G) Invoice line the Invoiced item
    VAT rate (BT-152) shall be 0."""
    ln = _line_rate_nonzero(inv, "G")
    if ln is not None:
        return Violation(
            "BR-G-05",
            "In an Invoice line (BG-25) where the Invoiced item VAT category "
            "code (BT-151) is 'Export outside the EU' the Invoiced item VAT "
            "rate (BT-152) shall be 0 (zero).",
            ln.label + "/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent")
    return None


def br_g_06(inv):
    """BR-G-06: in an Export outside the EU (G) Document level allowance the
    allowance VAT rate (BT-96) shall be 0."""
    if _ac_rate_nonzero(inv, "G", False):
        return Violation(
            "BR-G-06",
            "In a Document level allowance (BG-20) where the Document level "
            "allowance VAT category code (BT-95) is 'Export outside the EU' the "
            "Document level allowance VAT rate (BT-96) shall be 0 (zero).",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_g_07(inv):
    """BR-G-07: in an Export outside the EU (G) Document level charge the charge
    VAT rate (BT-103) shall be 0."""
    if _ac_rate_nonzero(inv, "G", True):
        return Violation(
            "BR-G-07",
            "In a Document level charge (BG-21) where the Document level charge "
            "VAT category code (BT-102) is 'Export outside the EU' the Document "
            "level charge VAT rate (BT-103) shall be 0 (zero).",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_g_08(inv):
    """BR-G-08: the Export outside the EU (G) VAT breakdown taxable amount
    (BT-116) shall equal the sum of G line nets − G allowances + G charges
    (exact on UBL; the ±1 band around the round2 bucket sums on CII — see
    :func:`_breakdown_taxable_sum_mismatch`)."""
    hit = _breakdown_taxable_sum_mismatch(inv, "G")
    if hit is not None:
        st, expected = hit
        return Violation(
            "BR-G-08", _taxable_sum_message("Export outside the EU", st, expected),
            "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount")
    return None


def br_g_09(inv):
    """BR-G-09: the VAT category tax amount (BT-117) in an Export outside the EU
    (G) VAT breakdown shall equal 0."""
    st = _breakdown_tax_nonzero(inv, "G")
    if st is not None:
        return Violation(
            "BR-G-09", _tax_zero_message("Export outside the EU", st),
            "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount")
    return None


def br_g_10(inv):
    """BR-G-10: a VAT breakdown (BG-23) with an Export outside the EU (G) VAT
    category code (BT-118) SHALL have a VAT exemption reason code (BT-121) or
    text (BT-120) — the presence-required shape shared with BR-E-10.

    Official (context ``/*/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)='G'][VAT]``)::

        exists(cbc:TaxExemptionReason) or exists(cbc:TaxExemptionReasonCode)
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if (st.category_id == "G" and st.category_scheme_id == "VAT"
                    and not (st.has_exemption_reason
                             or st.has_exemption_reason_code)):
                return Violation(
                    "BR-G-10",
                    "A VAT breakdown (BG-23) with an Export outside the EU (G) "
                    "VAT category code (BT-118) shall have a VAT exemption "
                    "reason code (BT-121), meaning 'Export outside the EU', or "
                    "the VAT exemption reason text (BT-120) 'Export outside the "
                    "EU'.",
                    "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/"
                    "cbc:TaxExemptionReason")
    return None


# ---------------------------------------------------------------------------
# Not subject to VAT (O) — Services outside the scope of tax (BR-O-02..14).
# This family is structurally the ODD ONE OUT, so it needs its own helpers:
#
# * -02..04 are PROHIBITIONS, not requirements: an O line/allowance/charge must
#   NOT carry ANY VAT registration identifier — not the Seller VAT id (BT-31),
#   not the tax-representative VAT id (BT-63), and not the Buyer VAT id (BT-48).
#   So the assert fires iff an O item exists AND one of those three VAT ids is
#   present (the inverse polarity of every other -02..04 family).
# * -05..07 forbid the VAT rate itself: ``not(cbc:Percent)`` — a Percent ELEMENT
#   present (any value, even empty) fires, its absence holds. This differs from
#   the "= 0" rate rules, so it needs the -present helpers below.
# * -08 (taxable sum) / -09 (tax = 0) / -10 (reason required) reuse the shared
#   BR-E shapes.
# * -11..14 are O-EXCLUSIVITY rules evaluated at the Invoice root: once an O VAT
#   breakdown row exists the document may NOT mix in any other VAT-scheme
#   category — not another VAT breakdown row (-11), not a non-O line item
#   category (-12), a non-O document/line allowance (-13) or charge (-14).
# ---------------------------------------------------------------------------
def _o_party_vat_id_present(inv):
    """The BR-O-02..04 prohibition set: a VAT-scheme Seller CompanyID (BT-31),
    a tax-representative VAT CompanyID (BT-63) OR a VAT-scheme Buyer CompanyID
    (BT-48). Any one present makes the O rule fire."""
    return (inv.seller_has_vat_scheme_company_id
            or inv.taxrep_has_vat_company_id
            or inv.buyer_has_vat_scheme_company_id)


def _o_party_id_message(subject):
    return ("An Invoice with a 'Not subject to VAT' (O) %s shall not contain "
            "the Seller VAT identifier (BT-31), the Seller tax representative "
            "VAT identifier (BT-63) or the Buyer VAT identifier (BT-48)."
            % subject)


def _line_rate_present(inv, code):
    """The BR-O-05 shape: a ``code`` VAT invoice-line ClassifiedTaxCategory that
    carries a Percent ELEMENT (present, any value) — ``not(cbc:Percent)`` is
    FALSE. Returns the first offending line, or None."""
    for ln in inv.lines:
        for cat in ln.item_tax_categories:
            if (cat.id == code and cat.scheme_id == "VAT"
                    and cat.percent is not None):
                return ln
    return None


def _ac_rate_present(inv, code, is_charge):
    """The BR-O-06/07 shape: a ``code`` VAT allowance (is_charge False) / charge
    (True) — document- AND line-level — carrying a Percent element."""
    for ac in inv.all_allowance_charges():
        if ac.is_charge is is_charge:
            for cat in ac.tax_categories:
                if (cat.id == code and cat.scheme_id == "VAT"
                        and cat.percent is not None):
                    return True
    return False


def _cii_o_header_vat_row_exists(inv):
    """The official CII BR-O-11..14 CONTEXT node set (one context node per
    matching row)::

        //rsm:SupplyChainTradeTransaction/ram:ApplicableHeaderTradeSettlement/
        ram:ApplicableTradeTax[ram:CategoryCode = 'O']
                              [upper-case(ram:TypeCode) = 'VAT']

    True iff at least one 'O' VAT header breakdown row exists — with no such
    row the four asserts have no context node and can never fire on CII."""
    return any(st.category_id == "O" and st.category_scheme_id == "VAT"
               for tt in inv.tax_totals for st in tt.subtotals)


def _line_has_other_vat_category(inv, exclude):
    """The BR-O-12 node set: any invoice-line item VAT ClassifiedTaxCategory
    whose code differs from ``exclude`` (an absent code — normalize-space '' —
    counts as different, matching the official ``[normalize-space(cbc:ID)!='O']``
    predicate)."""
    for ln in inv.lines:
        for cat in ln.item_tax_categories:
            if cat.scheme_id == "VAT" and cat.id != exclude:
                return True
    return False


def _ac_has_other_vat_category(inv, is_charge, exclude):
    """The BR-O-13/14 node set: any allowance (is_charge False) / charge (True)
    — document- AND line-level, matching the official ``//cac:AllowanceCharge``
    — with a VAT TaxCategory whose code differs from ``exclude``."""
    for ac in inv.all_allowance_charges():
        if ac.is_charge is is_charge:
            for cat in ac.tax_categories:
                if cat.scheme_id == "VAT" and cat.id != exclude:
                    return True
    return False


def br_o_02(inv):
    """BR-O-02: an Invoice with a 'Not subject to VAT' (O) Invoice line (BT-151)
    shall NOT contain a Seller/tax-representative/Buyer VAT identifier."""
    if (inv.has_classified_category("O", "VAT")
            and _o_party_vat_id_present(inv)):
        return Violation(
            "BR-O-02", _o_party_id_message("Invoice line (BT-151)"),
            _SELLER_ID_ELEMENT)
    return None


def br_o_03(inv):
    """BR-O-03: an Invoice with a 'Not subject to VAT' (O) Document level
    allowance (BT-95) shall NOT contain any VAT identifier."""
    if _ac_has_vat_category(inv, False, "O") and _o_party_vat_id_present(inv):
        return Violation(
            "BR-O-03",
            _o_party_id_message("Document level allowance (BT-95)"),
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_o_04(inv):
    """BR-O-04: an Invoice with a 'Not subject to VAT' (O) Document level charge
    (BT-102) shall NOT contain any VAT identifier."""
    if _ac_has_vat_category(inv, True, "O") and _o_party_vat_id_present(inv):
        return Violation(
            "BR-O-04",
            _o_party_id_message("Document level charge (BT-102)"),
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_o_05(inv):
    """BR-O-05: a 'Not subject to VAT' (O) Invoice line shall NOT contain an
    Invoiced item VAT rate (BT-152) — ``not(cbc:Percent)``."""
    ln = _line_rate_present(inv, "O")
    if ln is not None:
        return Violation(
            "BR-O-05",
            "An Invoice line (BG-25) where the VAT category code (BT-151) is "
            "'Not subject to VAT' shall not contain an Invoiced item VAT rate "
            "(BT-152).",
            ln.label + "/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent")
    return None


def br_o_06(inv):
    """BR-O-06: a 'Not subject to VAT' (O) Document level allowance shall NOT
    contain a Document level allowance VAT rate (BT-96)."""
    if _ac_rate_present(inv, "O", False):
        return Violation(
            "BR-O-06",
            "A Document level allowance (BG-20) where the Document level "
            "allowance VAT category code (BT-95) is 'Not subject to VAT' shall "
            "not contain a Document level allowance VAT rate (BT-96).",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_o_07(inv):
    """BR-O-07: a 'Not subject to VAT' (O) Document level charge shall NOT
    contain a Document level charge VAT rate (BT-103)."""
    if _ac_rate_present(inv, "O", True):
        return Violation(
            "BR-O-07",
            "A Document level charge (BG-21) where the Document level charge "
            "VAT category code (BT-102) is 'Not subject to VAT' shall not "
            "contain a Document level charge VAT rate (BT-103).",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_o_08(inv):
    """BR-O-08: the 'Not subject to VAT' (O) VAT breakdown taxable amount
    (BT-116) shall equal the exact sum of O line nets − O allowances + O
    charges.

    ``cii_band=False``: unlike the Z/E/AE/K/G families, the official CII
    BR-O-08 is EXACT (``ram:BasisAmount = round2(Σ O lines) + round2(Σ O
    header charges) − round2(Σ O header allowances)``, no ±1 band) and bound
    to the ``ram:ApplicableTradeTax`` ROW itself; like the band shape it has
    NO exists(//line) term, so a line-less O invoice whose BasisAmount
    matches the allowance/charge sums HOLDS on CII where the UBL binding
    fires (differential-proven T-VHCIIP.6 — see the shared helper's
    docstring for the verbatim shapes)."""
    hit = _breakdown_taxable_sum_mismatch(inv, "O", cii_band=False)
    if hit is not None:
        st, expected = hit
        return Violation(
            "BR-O-08", _taxable_sum_message("Not subject to VAT", st, expected),
            "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount")
    return None


def br_o_09(inv):
    """BR-O-09: the VAT category tax amount (BT-117) in a 'Not subject to VAT'
    (O) VAT breakdown shall equal 0."""
    st = _breakdown_tax_nonzero(inv, "O")
    if st is not None:
        return Violation(
            "BR-O-09", _tax_zero_message("Not subject to VAT", st),
            "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount")
    return None


def br_o_10(inv):
    """BR-O-10: a VAT breakdown (BG-23) with a 'Not subject to VAT' (O) VAT
    category code (BT-118) SHALL have a VAT exemption reason code (BT-121) or
    text (BT-120).

    Official (context ``/*/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)='O'][VAT]``)::

        exists(cbc:TaxExemptionReason) or exists(cbc:TaxExemptionReasonCode)
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if (st.category_id == "O" and st.category_scheme_id == "VAT"
                    and not (st.has_exemption_reason
                             or st.has_exemption_reason_code)):
                return Violation(
                    "BR-O-10",
                    "A VAT breakdown (BG-23) with a 'Not subject to VAT' (O) "
                    "VAT category code (BT-118) shall have a VAT exemption "
                    "reason code (BT-121), meaning 'Not subject to VAT', or a "
                    "VAT exemption reason text (BT-120) 'Not subject to VAT'.",
                    "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/"
                    "cbc:TaxExemptionReason")
    return None


def br_o_11(inv):
    """BR-O-11: an Invoice with a 'Not subject to VAT' (O) VAT breakdown (BG-23)
    shall NOT contain any other VAT breakdown group.

    Official UBL (context ``/ubl:Invoice``): HOLDS iff either no O breakdown
    row exists, or an O row exists AND every top-level VAT breakdown category
    code equals 'O' (``count(cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)!='O'][VAT]) = 0``). Fires iff an O breakdown row
    coexists with any non-O VAT breakdown row.

    The official CII binding is genuinely WIDER (T-VHCIIP.6): the context is
    each 'O' VAT header row and the test is
    ``not(//ram:ApplicableTradeTax[ram:CategoryCode != 'O'])`` — the RAW
    (VAT-TypeCode-unscoped) node set of EVERY trade-tax row, header
    breakdown AND line VAT rows alike, and it is byte-identical to the CII
    BR-O-12 test — so on CII the two rules fire together whenever an O
    header VAT row coexists with any non-O ``ram:CategoryCode`` on a header
    or line ApplicableTradeTax.
    """
    if inv.syntax == "cii":
        if (_cii_o_header_vat_row_exists(inv)
                and any(c != "O" for c in inv.classified_category_ids_raw)):
            return Violation(
                "BR-O-11",
                "An Invoice that contains a VAT breakdown group (BG-23) with "
                "a VAT category code (BT-118) 'Not subject to VAT' shall not "
                "contain other VAT breakdown groups (BG-23).",
                "ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax/"
                "ram:CategoryCode")
        return None
    codes = inv.breakdown_vat_category_codes()
    if "O" not in codes:
        return None
    if any(c != "O" for c in codes):
        return Violation(
            "BR-O-11",
            "An Invoice that contains a VAT breakdown group (BG-23) with a VAT "
            "category code (BT-118) 'Not subject to VAT' shall not contain "
            "other VAT breakdown groups (BG-23).",
            "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")
    return None


def br_o_12(inv):
    """BR-O-12: an Invoice with a 'Not subject to VAT' (O) VAT breakdown (BG-23)
    shall NOT contain an Invoice line (BG-25) whose Invoiced item VAT category
    code (BT-151) is not 'Not subject to VAT'.

    Official UBL (context ``/ubl:Invoice``): fires iff an O VAT breakdown row
    exists AND a line-item VAT ClassifiedTaxCategory with a non-O code exists
    (``count(//cac:ClassifiedTaxCategory[normalize-space(cbc:ID)!='O'][VAT])``).

    The official CII test is byte-identical to CII BR-O-11 —
    ``not(//ram:ApplicableTradeTax[ram:CategoryCode != 'O'])`` over the raw
    header+line trade-tax rows — so on CII BR-O-11 and BR-O-12 always fire
    together (see :func:`br_o_11`; differential-proven T-VHCIIP.6).
    """
    if inv.syntax == "cii":
        if (_cii_o_header_vat_row_exists(inv)
                and any(c != "O" for c in inv.classified_category_ids_raw)):
            return Violation(
                "BR-O-12",
                "An Invoice that contains a VAT breakdown group (BG-23) with "
                "a VAT category code (BT-118) 'Not subject to VAT' shall not "
                "contain an Invoice line (BG-25) where the Invoiced item VAT "
                "category code (BT-151) is not 'Not subject to VAT'.",
                "ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax/"
                "ram:CategoryCode")
        return None
    if "O" not in inv.breakdown_vat_category_codes():
        return None
    if _line_has_other_vat_category(inv, "O"):
        return Violation(
            "BR-O-12",
            "An Invoice that contains a VAT breakdown group (BG-23) with a VAT "
            "category code (BT-118) 'Not subject to VAT' shall not contain an "
            "Invoice line (BG-25) where the Invoiced item VAT category code "
            "(BT-151) is not 'Not subject to VAT'.",
            "cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory/cbc:ID")
    return None


def br_o_13(inv):
    """BR-O-13: an Invoice with a 'Not subject to VAT' (O) VAT breakdown (BG-23)
    shall NOT contain a Document level allowance (BG-20) whose VAT category code
    (BT-95) is not 'Not subject to VAT'.

    Official UBL (context ``/ubl:Invoice``): fires iff an O VAT breakdown row
    exists AND an allowance (``//cac:AllowanceCharge[cbc:ChargeIndicator=
    false()]``) carries a VAT TaxCategory with a non-O code.

    The official CII test —
    ``not(//ram:CategoryTradeTax[ram:CategoryCode != 'O'])`` — is RAW
    (VAT-TypeCode-unscoped), spans document- AND line-level allowance/charge
    categories, and does NOT split on the ChargeIndicator: it is
    byte-identical to the CII BR-O-14 test, so on CII the two rules fire
    together on ANY non-O allowance/charge category once an O header VAT row
    exists (differential-proven T-VHCIIP.6).
    """
    if inv.syntax == "cii":
        if (_cii_o_header_vat_row_exists(inv)
                and any(c != "O" for c in inv.tax_category_ids_raw)):
            return Violation(
                "BR-O-13",
                "An Invoice that contains a VAT breakdown group (BG-23) with "
                "a VAT category code (BT-118) 'Not subject to VAT' shall not "
                "contain Document level allowances (BG-20) where the Document "
                "level allowance VAT category code (BT-95) is not 'Not "
                "subject to VAT'.",
                "ram:SpecifiedTradeAllowanceCharge/ram:CategoryTradeTax/"
                "ram:CategoryCode")
        return None
    if "O" not in inv.breakdown_vat_category_codes():
        return None
    if _ac_has_other_vat_category(inv, False, "O"):
        return Violation(
            "BR-O-13",
            "An Invoice that contains a VAT breakdown group (BG-23) with a VAT "
            "category code (BT-118) 'Not subject to VAT' shall not contain "
            "Document level allowances (BG-20) where the Document level "
            "allowance VAT category code (BT-95) is not 'Not subject to VAT'.",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_o_14(inv):
    """BR-O-14: an Invoice with a 'Not subject to VAT' (O) VAT breakdown (BG-23)
    shall NOT contain a Document level charge (BG-21) whose VAT category code
    (BT-102) is not 'Not subject to VAT'.

    Official UBL (context ``/ubl:Invoice``): fires iff an O VAT breakdown row
    exists AND a charge (``//cac:AllowanceCharge[cbc:ChargeIndicator=true()]``)
    carries a VAT TaxCategory with a non-O code.

    The official CII test is byte-identical to CII BR-O-13 —
    ``not(//ram:CategoryTradeTax[ram:CategoryCode != 'O'])``, raw and
    indicator-agnostic — so on CII BR-O-13 and BR-O-14 always fire together
    (see :func:`br_o_13`; differential-proven T-VHCIIP.6).
    """
    if inv.syntax == "cii":
        if (_cii_o_header_vat_row_exists(inv)
                and any(c != "O" for c in inv.tax_category_ids_raw)):
            return Violation(
                "BR-O-14",
                "An Invoice that contains a VAT breakdown group (BG-23) with "
                "a VAT category code (BT-118) 'Not subject to VAT' shall not "
                "contain Document level charges (BG-21) where the Document "
                "level charge VAT category code (BT-102) is not 'Not subject "
                "to VAT'.",
                "ram:SpecifiedTradeAllowanceCharge/ram:CategoryTradeTax/"
                "ram:CategoryCode")
        return None
    if "O" not in inv.breakdown_vat_category_codes():
        return None
    if _ac_has_other_vat_category(inv, True, "O"):
        return Violation(
            "BR-O-14",
            "An Invoice that contains a VAT breakdown group (BG-23) with a VAT "
            "category code (BT-118) 'Not subject to VAT' shall not contain "
            "Document level charges (BG-21) where the Document level charge VAT "
            "category code (BT-102) is not 'Not subject to VAT'.",
            "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


# ---------------------------------------------------------------------------
# Canary Islands IGIC (L) VAT category rules (BR-AF-01..10).
#
# IGIC ("Impuesto General Indirecto Canario") is the Canary Islands' general
# indirect tax; EN 16931 models it as VAT category code 'L'. The family
# MIRRORS the Standard-rated (S) machinery with three differences pinned by
# the official artifacts:
#
# * the seller-id rules (-02..04) are SYMMETRIC like BR-Z/E-02..04 (both
#   disjuncts of the official UBL test use the SAME VAT-scoped node set,
#   unlike BR-S-02 whose last disjunct is scheme-agnostic);
# * the rate rules (-05..07) are ``(cbc:Percent) >= 0`` on UBL — zero IS
#   allowed — while the CII binding tests ``ram:RateApplicablePercent > 0``
#   (strictly greater); the bodies branch on syntax and transcribe each;
# * the breakdown-sum rule (-08) is gated on ``exists(//cac:InvoiceLine)``
#   (ANY line, not an L-restricted set) on UBL, with the same strict ±1 band
#   as BR-S-08; the CII binding is BR-S-08's exact per-bucket round2 sum.
#
# BR-AF-09/-10 are the BR-S-09/-10 shapes verbatim with code 'L'.
# ---------------------------------------------------------------------------
def _percent_ge_zero(percent_text):
    """The official UBL ``(cbc:Percent) >= 0`` test (BR-AF-05..07): holds iff
    Percent parses to a number greater than or equal to zero (zero IS a valid
    IGIC rate). An absent / empty / non-numeric Percent makes the general
    comparison false, so the assert fires; a negative rate fires."""
    pct = _dec(percent_text)
    return pct is not None and pct >= 0


def _af_rate_holds(inv, percent_text):
    """BR-AF-05..07 rate predicate, branched on syntax: the UBL artifact tests
    ``(cbc:Percent) >= 0`` while the CII artifact tests
    ``ram:RateApplicablePercent > 0`` — the two official bindings genuinely
    differ on a zero rate, so each binding's predicate is transcribed
    exactly (the shared model carries the same Percent fact for both)."""
    if inv.syntax == "cii":
        return _percent_gt_zero(percent_text)
    return _percent_ge_zero(percent_text)


def br_af_01(inv):
    """BR-AF-01: IGIC (L) items and the VAT breakdown (BG-23) must agree.

    Official (context ``/ubl:Invoice``) — the same bidirectional count shape
    as BR-S-01, with the item side VAT-scheme scoped::

        ((count(//cac:AllowanceCharge/cac:TaxCategory[ns ID='L'][VAT])
            + count(//cac:ClassifiedTaxCategory[ns ID='L'][VAT])) > 0
          and count(cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='L']) > 0)
        or (the same item count = 0
          and count(cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[ns ID='L'][VAT]) = 0)

    so the assert fires whenever exactly ONE side carries 'L': an L line /
    allowance / charge with no L breakdown row, or an orphan L breakdown row
    with no L item. The first disjunct's breakdown count is the raw,
    scheme-agnostic ``cbc:ID = 'L'`` node set (``breakdown_category_ids``);
    the orphan direction's is VAT-scoped (``breakdown_vat_category_codes``).
    """
    items_l = (inv.has_classified_category("L", "VAT")
               or any(cat.id == "L" and cat.scheme_id == "VAT"
                      for ac in inv.all_allowance_charges()
                      for cat in ac.tax_categories))
    if items_l:
        if "L" not in inv.breakdown_category_ids():
            return Violation(
                "BR-AF-01",
                "An IGIC (L) item/allowance/charge is present, so the VAT "
                "breakdown (BG-23) must contain at least one VAT category "
                "code (BT-118) equal with 'IGIC'.",
                "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")
    elif "L" in inv.breakdown_vat_category_codes():
        return Violation(
            "BR-AF-01",
            "The VAT breakdown (BG-23) contains an IGIC (L) VAT category, "
            "but no IGIC item/allowance/charge is present.",
            "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")
    return None


def br_af_02(inv):
    """BR-AF-02: an IGIC (L) Invoice line (BT-151) requires the Seller VAT
    identifier (BT-31), Seller tax registration id (BT-32) and/or Seller tax
    representative VAT id (BT-63) — both official disjuncts are VAT-scoped
    (the BR-Z/E-02 symmetric shape, not BR-S-02's scheme-agnostic tail)."""
    if _line_seller_id_fires(inv, "L"):
        return Violation(
            "BR-AF-02",
            _seller_id_message("IGIC (L)", "Invoice line (BT-151)"),
            _SELLER_ID_ELEMENT)
    return None


def br_af_03(inv):
    """BR-AF-03: an IGIC (L) Document level allowance (BT-95) requires the
    Seller VAT identifier disjunct (same shape as BR-AF-02)."""
    if _ac_seller_id_fires(inv, "L", False):
        return Violation(
            "BR-AF-03",
            _seller_id_message("IGIC (L)", "Document level allowance (BT-95)"),
            _SELLER_ID_ELEMENT)
    return None


def br_af_04(inv):
    """BR-AF-04: an IGIC (L) Document level charge (BT-102) requires the
    Seller VAT identifier disjunct.

    Unlike BR-AF-02/03, the official UBL test's LAST disjunct gates on the
    RAW ``cbc:ID = 'L'`` charge node set (NO normalize-space — an artifact
    quirk)::

        (exists(//cac:AllowanceCharge[true()]/cac:TaxCategory
                 [normalize-space(cbc:ID)='L'][VAT]) and SELLER_ID)
        or not(exists(//cac:AllowanceCharge[true()]/cac:TaxCategory
                 [cbc:ID='L'][VAT]))

    Every raw-'L' category is also a normalize-space-'L' one, so the assert
    fires iff a VAT-scoped charge TaxCategory whose EXACT text is 'L' exists
    and no Seller VAT identifier does — a whitespace-padded ``' L '`` charge
    category can never fire it (pinned by CEN unit vector BR-IG-08-3). The
    CII binding's context is the exact ``ram:CategoryCode = 'L'`` match, so
    the raw comparison transcribes both.
    """
    raw_l_charge = any(
        cat.raw_id == "L" and cat.scheme_id == "VAT"
        for ac in inv.all_allowance_charges() if ac.is_charge is True
        for cat in ac.tax_categories)
    if raw_l_charge and not inv.seller_has_vat_identifier():
        return Violation(
            "BR-AF-04",
            _seller_id_message("IGIC (L)", "Document level charge (BT-102)"),
            _SELLER_ID_ELEMENT)
    return None


def br_af_05(inv):
    """BR-AF-05: in an IGIC (L) Invoice line the Invoiced item VAT rate
    (BT-152) shall be 0 (zero) or greater than zero.

    Official UBL (context ``cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory
    [normalize-space(cbc:ID)='L'][VAT]``): ``(cbc:Percent) >= 0`` per matching
    category (absent / non-numeric / negative fires). The CII artifact tests
    ``ram:RateApplicablePercent > 0`` instead — see :func:`_af_rate_holds`.
    """
    for ln in inv.lines:
        for cat in ln.item_tax_categories:
            if (cat.id == "L" and cat.scheme_id == "VAT"
                    and not _af_rate_holds(inv, cat.percent)):
                return Violation(
                    "BR-AF-05",
                    "In an Invoice line (BG-25) where the Invoiced item VAT "
                    "category code (BT-151) is 'IGIC' the Invoiced item VAT "
                    "rate (BT-152) shall be 0 (zero) or greater than zero.",
                    ln.label + "/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent")
    return None


def br_af_06(inv):
    """BR-AF-06: in an IGIC (L) Document level allowance the allowance VAT
    rate (BT-96) shall be 0 (zero) or greater than zero.

    Official UBL (context ``cac:AllowanceCharge[cbc:ChargeIndicator=false()]/
    cac:TaxCategory[normalize-space(cbc:ID)='L'][VAT]``): ``(cbc:Percent) >= 0``;
    the CII artifact tests ``> 0`` — see :func:`_af_rate_holds`.
    """
    for ac in inv.all_allowance_charges():
        if ac.is_charge is False:
            for cat in ac.tax_categories:
                if (cat.id == "L" and cat.scheme_id == "VAT"
                        and not _af_rate_holds(inv, cat.percent)):
                    return Violation(
                        "BR-AF-06",
                        "In a Document level allowance (BG-20) where the "
                        "Document level allowance VAT category code (BT-95) is "
                        "'IGIC' the Document level allowance VAT rate (BT-96) "
                        "shall be 0 (zero) or greater than zero.",
                        "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_af_07(inv):
    """BR-AF-07: in an IGIC (L) Document level charge the charge VAT rate
    (BT-103) shall be 0 (zero) or greater than zero.

    Official UBL (context ``cac:AllowanceCharge[cbc:ChargeIndicator=true()]/
    cac:TaxCategory[normalize-space(cbc:ID)='L'][VAT]``): ``(cbc:Percent) >= 0``;
    the CII artifact tests ``> 0`` — see :func:`_af_rate_holds`.
    """
    for ac in inv.all_allowance_charges():
        if ac.is_charge is True:
            for cat in ac.tax_categories:
                if (cat.id == "L" and cat.scheme_id == "VAT"
                        and not _af_rate_holds(inv, cat.percent)):
                    return Violation(
                        "BR-AF-07",
                        "In a Document level charge (BG-21) where the Document "
                        "level charge VAT category code (BT-102) is 'IGIC' the "
                        "Document level charge VAT rate (BT-103) shall be 0 "
                        "(zero) or greater than zero.",
                        "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_af_08(inv):
    """BR-AF-08: for each different value of VAT category rate (BT-119) where
    the VAT category code (BT-118) is 'IGIC', the VAT category taxable amount
    (BT-116) shall equal the sum of Invoice line net amounts (BT-131) plus
    document level charge amounts (BT-99) minus document level allowance
    amounts (BT-92) where the VAT category code is 'IGIC' and the VAT rate
    equals BT-119.

    The two bindings encode the bucket sum with genuinely different
    predicates (the BR-S-08 situation), so the body branches on syntax.

    UBL (context ``/*/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)='L'][VAT]``)::

        every $rate in xs:decimal(cbc:Percent) satisfies
          (exists(//cac:InvoiceLine) and
             ../xs:decimal(cbc:TaxableAmount - 1) < SUM_IL
             and ../xs:decimal(cbc:TaxableAmount + 1) > SUM_IL)
          or (exists(//cac:CreditNoteLine) and the same band against SUM_CNL)

    where ``SUM_IL`` = Σ L/$rate lines' LineExtensionAmount + Σ L/$rate
    document-level charges − Σ L/$rate document-level allowances, each group
    restricted by TWO INDEPENDENT scheme-agnostic predicates
    (``normalize-space(id)='L'`` and ``xs:decimal(Percent)=$rate`` may match
    different categories of the same group). Unlike BR-S-08 there is NO
    allowance-charge exists() disjunct: the band is gated on ANY
    ``//cac:InvoiceLine`` existing, so an L breakdown with a rate on a
    line-less Invoice document fires. An absent Percent makes ``every $rate
    in ()`` vacuously true (holds); a missing/unparseable BT-116 empties the
    band comparison and fires.

    CII (context ``//ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax
    [ram:CategoryCode='L'][upper-case(ram:TypeCode)='VAT']``)::

        every $rate in ../ram:RateApplicablePercent/xs:decimal(.) satisfies
          ../ram:BasisAmount = round2(Σ L/$rate line LineTotalAmount)
            + round2(Σ L/$rate header charges' ActualAmount[1])
            - round2(Σ L/$rate header allowances' ActualAmount[1])

    EXACT equality against the per-bucket fn:round 2-place sums (the
    ``_xr2`` idiom) — no tolerance band, no line-exists gate; a missing
    BT-116 compares false and fires. NOTE: as SHIPPED the CII assert can
    never fire — its context is the ``ram:ApplicableTradeTax`` ROW (unlike
    BR-S-08, whose context node is the ``ram:CategoryCode`` CHILD), so
    ``../ram:RateApplicablePercent`` resolves against the header settlement
    (empty) and ``every $rate in ()`` is vacuously true. The engine asserts
    the INTENDED arithmetic above on the CII model anyway (deliberate
    strictness); the rule is therefore not graded on the CII differential
    leg.
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if not (st.category_id == "L"
                    and st.category_scheme_id == "VAT"):
                continue
            rate = _dec(st.percent)
            if rate is None:
                continue  # every $rate in () — vacuously true
            line_sum = Decimal("0")
            for ln in inv.lines:
                cats = ln.item_tax_categories
                if (any(cat.id == "L" for cat in cats)
                        and any(_dec(cat.percent) == rate for cat in cats)):
                    v = _dec(ln.line_extension_amount)
                    if v is not None:
                        line_sum += v
            charge_sum = Decimal("0")
            allowance_sum = Decimal("0")
            for ac in inv.doc_allowance_charges:
                if ac.is_charge is None:
                    continue
                cats = ac.tax_categories
                if not (any(cat.id == "L" for cat in cats)
                        and any(_dec(cat.percent) == rate for cat in cats)):
                    continue
                v = _dec(ac.amount_raw)
                if v is None:
                    continue
                if ac.is_charge:
                    charge_sum += v
                else:
                    allowance_sum += v
            taxable = _dec(st.taxable_amount)
            if inv.syntax == "cii":
                expected = (_xr2(line_sum) + _xr2(charge_sum)
                            - _xr2(allowance_sum))
                if taxable is not None and taxable == expected:
                    continue
            else:
                expected = line_sum + charge_sum - allowance_sum
                if (inv.lines and taxable is not None
                        and taxable - 1 < expected
                        and taxable + 1 > expected):
                    continue
            return Violation(
                "BR-AF-08",
                "For each different value of VAT category rate (BT-119=%s) "
                "where the VAT category code (BT-118) is 'IGIC', the VAT "
                "category taxable amount (BT-116=%s) in a VAT breakdown "
                "(BG-23) shall equal the sum of Invoice line net amounts "
                "plus document level charges minus document level allowances "
                "at that IGIC rate."
                % (st.percent, st.taxable_amount or "(absent)"),
                "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount")
    return None


def br_af_09(inv):
    """BR-AF-09: the VAT category tax amount (BT-117) in an IGIC (L) VAT
    breakdown shall equal the VAT category taxable amount (BT-116) multiplied
    by the VAT category rate (BT-119).

    Official UBL (context ``/*/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)='L'][VAT]`` — TOP-LEVEL TaxTotals only) — the
    BR-S-09 band verbatim::

        abs(TaxAmount) - 1 < round2(abs(TaxableAmount) * Percent/100)
          and abs(TaxAmount) + 1 > round2(abs(TaxableAmount) * Percent/100)

    A ±1 tolerance band; round2 = ``round(x*100) div 100`` with fn:round()
    (halves toward +inf). A missing TaxAmount / TaxableAmount / Percent makes
    the comparison false, so the assert fires. NOTE: the official CII
    artifact ships this assert as ``test="true()"`` — a tautology that can
    never fire — so the rule is deliberately NOT graded on the CII
    differential leg; the engine asserts the real EN 16931 arithmetic on
    both syntaxes.
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if not (st.category_id == "L" and st.category_scheme_id == "VAT"):
                continue
            pct = _dec(st.percent)
            tax = _dec(st.tax_amount)
            taxable = _dec(st.taxable_amount)
            holds = False
            if pct is not None and tax is not None and taxable is not None:
                expected = _xr2(abs(taxable) * (pct / Decimal(100)))
                holds = (abs(tax) - 1 < expected) and (abs(tax) + 1 > expected)
            if not holds:
                return Violation(
                    "BR-AF-09",
                    "The VAT category tax amount (BT-117=%s) in an IGIC (L) "
                    "VAT breakdown must equal the VAT category taxable "
                    "amount (BT-116=%s) x (VAT rate (BT-119=%s) / 100)."
                    % (st.tax_amount or "(absent)",
                       st.taxable_amount or "(absent)",
                       st.percent if st.percent is not None else "(absent)"),
                    "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount")
    return None


def br_af_10(inv):
    """BR-AF-10: a VAT breakdown (BG-23) with an IGIC (L) VAT category code
    (BT-118) shall not have a VAT exemption reason code (BT-121) or VAT
    exemption reason text (BT-120).

    Official (context ``/*/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)='L'][VAT]``, CII the L VAT header trade tax)::

        not(cbc:TaxExemptionReason) and not(cbc:TaxExemptionReasonCode)

    — the exemption-forbidding BR-S-10/BR-Z-10 shape, identical on both
    bindings.
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if (st.category_id == "L" and st.category_scheme_id == "VAT"
                    and (st.has_exemption_reason or st.has_exemption_reason_code)):
                return Violation(
                    "BR-AF-10",
                    "A VAT breakdown (BG-23) with VAT category code (BT-118) "
                    "'IGIC' shall not have a VAT exemption reason code "
                    "(BT-121) or VAT exemption reason text (BT-120).",
                    "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/"
                    "cbc:TaxExemptionReason")
    return None


# ---------------------------------------------------------------------------
# Ceuta and Melilla IPSI (M) VAT category rules (BR-AG-01..10).
#
# IPSI ("Impuesto sobre la Producción, los Servicios y la Importación") is the
# indirect tax of the Spanish autonomous cities Ceuta and Melilla; EN 16931
# models it as VAT category code 'M'. The family mirrors the IGIC (BR-AF)
# machinery — itself the Standard-rate shape — with three differences pinned
# by the official artifacts:
#
# * the breakdown-agreement rule (-01) scopes the FIRST disjunct's breakdown
#   count to VAT-scheme rows with the RAW ``cbc:ID = 'M'`` (no
#   normalize-space; BR-AF-01's first disjunct is the raw scheme-AGNOSTIC set
#   instead), so it reads the subtotal's ``category_id_raw``;
# * the rate rules (-05..07) are ``>= 0`` on BOTH bindings — the UBL artifact
#   tests ``(cbc:Percent) >= 0`` and the CII artifact tests
#   ``ram:RateApplicablePercent >= 0`` (unlike BR-AF-05..07, whose CII
#   binding is strictly ``> 0``) — so the bodies use :func:`_percent_ge_zero`
#   without branching on syntax;
# * the charge seller-id rule (-04) is fully SYMMETRIC (normalize-space in
#   both disjuncts — no BR-AF-04 raw-node-set quirk), so all three seller-id
#   rules (-02..04) share the BR-Z/E helpers.
#
# BR-AG-08/-09/-10 are the BR-AF-08/-09/-10 shapes verbatim with code 'M',
# including the two CII artifact defects: the shipped CII -08 assert is
# vacuously bound (its ``../ram:RateApplicablePercent`` is empty, so ``every
# $rate in ()`` always holds) and the shipped CII -09 assert is
# ``test="true()"`` — both can never fire officially on CII, so both are
# CII-ungraded in the differential while the engine asserts the intended
# arithmetic on both syntaxes (deliberate strictness).
# ---------------------------------------------------------------------------
def br_ag_01(inv):
    """BR-AG-01: IPSI (M) items and the VAT breakdown (BG-23) must agree.

    Official (context ``/ubl:Invoice``) — the BR-AF-01 bidirectional count
    shape with the item side VAT-scheme scoped::

        ((count(//cac:AllowanceCharge/cac:TaxCategory[ns ID='M'][VAT])
            + count(//cac:ClassifiedTaxCategory[ns ID='M'][VAT])) > 0
          and count(cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
                    [cbc:ID='M'][VAT]) > 0)
        or (the same item count = 0
          and count(cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
                    [ns ID='M'][VAT]) = 0)

    so the assert fires whenever exactly ONE side carries 'M': an M line /
    allowance / charge with no M breakdown row, or an orphan M breakdown row
    with no M item. Both breakdown counts are VAT-scoped, but the FIRST
    disjunct's compares the RAW ``cbc:ID`` (no normalize-space — unlike
    BR-AF-01, whose first-disjunct set is raw but scheme-agnostic); the
    orphan direction's is the normalize-space'd VAT set
    (``breakdown_vat_category_codes``).
    """
    items_m = (inv.has_classified_category("M", "VAT")
               or any(cat.id == "M" and cat.scheme_id == "VAT"
                      for ac in inv.all_allowance_charges()
                      for cat in ac.tax_categories))
    if items_m:
        has_raw_m_vat_row = any(
            st.category_id_raw == "M" and st.category_scheme_id == "VAT"
            for tt in inv.tax_totals for st in tt.subtotals)
        if not has_raw_m_vat_row:
            return Violation(
                "BR-AG-01",
                "An IPSI (M) item/allowance/charge is present, so the VAT "
                "breakdown (BG-23) must contain at least one VAT category "
                "code (BT-118) equal with 'IPSI'.",
                "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")
    elif "M" in inv.breakdown_vat_category_codes():
        return Violation(
            "BR-AG-01",
            "The VAT breakdown (BG-23) contains an IPSI (M) VAT category, "
            "but no IPSI item/allowance/charge is present.",
            "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")
    return None


def br_ag_02(inv):
    """BR-AG-02: an IPSI (M) Invoice line (BT-151) requires the Seller VAT
    identifier (BT-31), Seller tax registration id (BT-32) and/or Seller tax
    representative VAT id (BT-63) — both official disjuncts are VAT-scoped
    (the BR-Z/E/AF-02 symmetric shape, not BR-S-02's scheme-agnostic tail)."""
    if _line_seller_id_fires(inv, "M"):
        return Violation(
            "BR-AG-02",
            _seller_id_message("IPSI (M)", "Invoice line (BT-151)"),
            _SELLER_ID_ELEMENT)
    return None


def br_ag_03(inv):
    """BR-AG-03: an IPSI (M) Document level allowance (BT-95) requires the
    Seller VAT identifier disjunct (same shape as BR-AG-02)."""
    if _ac_seller_id_fires(inv, "M", False):
        return Violation(
            "BR-AG-03",
            _seller_id_message("IPSI (M)", "Document level allowance (BT-95)"),
            _SELLER_ID_ELEMENT)
    return None


def br_ag_04(inv):
    """BR-AG-04: an IPSI (M) Document level charge (BT-102) requires the
    Seller VAT identifier disjunct.

    Unlike BR-AF-04 (whose official last disjunct gates on the RAW charge
    node set), BOTH disjuncts of the official BR-AG-04 test use the same
    ``normalize-space(cbc:ID)='M'`` VAT-scoped charge set — the fully
    symmetric BR-Z/E-04 shape — so the shared helper transcribes it."""
    if _ac_seller_id_fires(inv, "M", True):
        return Violation(
            "BR-AG-04",
            _seller_id_message("IPSI (M)", "Document level charge (BT-102)"),
            _SELLER_ID_ELEMENT)
    return None


def br_ag_05(inv):
    """BR-AG-05: in an IPSI (M) Invoice line the Invoiced item VAT rate
    (BT-152) shall be 0 (zero) or greater than zero.

    Official UBL (context ``cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory
    [normalize-space(cbc:ID)='M'][VAT]``): ``(cbc:Percent) >= 0`` per matching
    category. The CII artifact tests ``ram:RateApplicablePercent >= 0`` — the
    SAME predicate (unlike BR-AF-05, where the CII binding is strict ``> 0``),
    so the body does not branch on syntax: an absent / non-numeric / negative
    rate fires, a zero rate holds on both bindings.
    """
    for ln in inv.lines:
        for cat in ln.item_tax_categories:
            if (cat.id == "M" and cat.scheme_id == "VAT"
                    and not _percent_ge_zero(cat.percent)):
                return Violation(
                    "BR-AG-05",
                    "In an Invoice line (BG-25) where the Invoiced item VAT "
                    "category code (BT-151) is 'IPSI' the Invoiced item VAT "
                    "rate (BT-152) shall be 0 (zero) or greater than zero.",
                    ln.label + "/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent")
    return None


def br_ag_06(inv):
    """BR-AG-06: in an IPSI (M) Document level allowance the allowance VAT
    rate (BT-96) shall be 0 (zero) or greater than zero.

    Official UBL (context ``cac:AllowanceCharge[cbc:ChargeIndicator=false()]/
    cac:TaxCategory[normalize-space(cbc:ID)='M'][VAT]``): ``(cbc:Percent) >= 0``;
    the CII artifact tests ``ram:RateApplicablePercent >= 0`` — identical.
    """
    for ac in inv.all_allowance_charges():
        if ac.is_charge is False:
            for cat in ac.tax_categories:
                if (cat.id == "M" and cat.scheme_id == "VAT"
                        and not _percent_ge_zero(cat.percent)):
                    return Violation(
                        "BR-AG-06",
                        "In a Document level allowance (BG-20) where the "
                        "Document level allowance VAT category code (BT-95) is "
                        "'IPSI' the Document level allowance VAT rate (BT-96) "
                        "shall be 0 (zero) or greater than zero.",
                        "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_ag_07(inv):
    """BR-AG-07: in an IPSI (M) Document level charge the charge VAT rate
    (BT-103) shall be 0 (zero) or greater than zero.

    Official UBL (context ``cac:AllowanceCharge[cbc:ChargeIndicator=true()]/
    cac:TaxCategory[normalize-space(cbc:ID)='M'][VAT]``): ``(cbc:Percent) >= 0``;
    the CII artifact tests ``ram:RateApplicablePercent >= 0`` — identical.
    """
    for ac in inv.all_allowance_charges():
        if ac.is_charge is True:
            for cat in ac.tax_categories:
                if (cat.id == "M" and cat.scheme_id == "VAT"
                        and not _percent_ge_zero(cat.percent)):
                    return Violation(
                        "BR-AG-07",
                        "In a Document level charge (BG-21) where the Document "
                        "level charge VAT category code (BT-102) is 'IPSI' the "
                        "Document level charge VAT rate (BT-103) shall be 0 "
                        "(zero) or greater than zero.",
                        "cac:AllowanceCharge/cac:TaxCategory/cbc:Percent")
    return None


def br_ag_08(inv):
    """BR-AG-08: for each different value of VAT category rate (BT-119) where
    the VAT category code (BT-118) is 'IPSI', the VAT category taxable amount
    (BT-116) shall equal the sum of Invoice line net amounts (BT-131) plus
    document level charge amounts (BT-99) minus document level allowance
    amounts (BT-92) where the VAT category code is 'IPSI' and the VAT rate
    equals BT-119.

    The BR-AF-08 shape verbatim with code 'M' — see :func:`br_af_08` for the
    full official XPath commentary. UBL: the strict ±1 band per breakdown
    rate, each bucket group restricted by TWO INDEPENDENT scheme-agnostic
    predicates (``normalize-space(id)='M'`` and ``xs:decimal(Percent)=$rate``),
    gated on ANY ``//cac:InvoiceLine`` existing (a line-less document with an
    M-rate breakdown fires). An absent Percent is vacuously true; a
    missing/unparseable BT-116 fires. CII: the exact per-bucket round2 sum —
    but NOTE the SHIPPED CII assert is bound to the ``ram:ApplicableTradeTax``
    ROW (like BR-AF-08, unlike BR-S-08), so its ``../ram:RateApplicablePercent``
    is empty and the official assert can never fire; the engine asserts the
    intended arithmetic on the CII model anyway (deliberate strictness) and
    the rule is not graded on the CII differential leg.
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if not (st.category_id == "M"
                    and st.category_scheme_id == "VAT"):
                continue
            rate = _dec(st.percent)
            if rate is None:
                continue  # every $rate in () — vacuously true
            line_sum = Decimal("0")
            for ln in inv.lines:
                cats = ln.item_tax_categories
                if (any(cat.id == "M" for cat in cats)
                        and any(_dec(cat.percent) == rate for cat in cats)):
                    v = _dec(ln.line_extension_amount)
                    if v is not None:
                        line_sum += v
            charge_sum = Decimal("0")
            allowance_sum = Decimal("0")
            for ac in inv.doc_allowance_charges:
                if ac.is_charge is None:
                    continue
                cats = ac.tax_categories
                if not (any(cat.id == "M" for cat in cats)
                        and any(_dec(cat.percent) == rate for cat in cats)):
                    continue
                v = _dec(ac.amount_raw)
                if v is None:
                    continue
                if ac.is_charge:
                    charge_sum += v
                else:
                    allowance_sum += v
            taxable = _dec(st.taxable_amount)
            if inv.syntax == "cii":
                expected = (_xr2(line_sum) + _xr2(charge_sum)
                            - _xr2(allowance_sum))
                if taxable is not None and taxable == expected:
                    continue
            else:
                expected = line_sum + charge_sum - allowance_sum
                if (inv.lines and taxable is not None
                        and taxable - 1 < expected
                        and taxable + 1 > expected):
                    continue
            return Violation(
                "BR-AG-08",
                "For each different value of VAT category rate (BT-119=%s) "
                "where the VAT category code (BT-118) is 'IPSI', the VAT "
                "category taxable amount (BT-116=%s) in a VAT breakdown "
                "(BG-23) shall equal the sum of Invoice line net amounts "
                "plus document level charges minus document level allowances "
                "at that IPSI rate."
                % (st.percent, st.taxable_amount or "(absent)"),
                "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount")
    return None


def br_ag_09(inv):
    """BR-AG-09: the VAT category tax amount (BT-117) in an IPSI (M) VAT
    breakdown shall equal the VAT category taxable amount (BT-116) multiplied
    by the VAT category rate (BT-119).

    Official UBL (context ``/*/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)='M'][VAT]`` — TOP-LEVEL TaxTotals only) — the
    BR-S/AF-09 band verbatim::

        abs(TaxAmount) - 1 < round2(abs(TaxableAmount) * Percent/100)
          and abs(TaxAmount) + 1 > round2(abs(TaxableAmount) * Percent/100)

    A ±1 tolerance band; round2 = ``round(x*100) div 100`` with fn:round()
    (halves toward +inf). A missing TaxAmount / TaxableAmount / Percent makes
    the comparison false, so the assert fires. NOTE: the official CII
    artifact ships this assert as ``test="true()"`` — a tautology that can
    never fire (exactly like BR-AF-09) — so the rule is deliberately NOT
    graded on the CII differential leg; the engine asserts the real EN 16931
    arithmetic on both syntaxes.
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if not (st.category_id == "M" and st.category_scheme_id == "VAT"):
                continue
            pct = _dec(st.percent)
            tax = _dec(st.tax_amount)
            taxable = _dec(st.taxable_amount)
            holds = False
            if pct is not None and tax is not None and taxable is not None:
                expected = _xr2(abs(taxable) * (pct / Decimal(100)))
                holds = (abs(tax) - 1 < expected) and (abs(tax) + 1 > expected)
            if not holds:
                return Violation(
                    "BR-AG-09",
                    "The VAT category tax amount (BT-117=%s) in an IPSI (M) "
                    "VAT breakdown must equal the VAT category taxable "
                    "amount (BT-116=%s) x (VAT rate (BT-119=%s) / 100)."
                    % (st.tax_amount or "(absent)",
                       st.taxable_amount or "(absent)",
                       st.percent if st.percent is not None else "(absent)"),
                    "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount")
    return None


def br_ag_10(inv):
    """BR-AG-10: a VAT breakdown (BG-23) with an IPSI (M) VAT category code
    (BT-118) shall not have a VAT exemption reason code (BT-121) or VAT
    exemption reason text (BT-120).

    Official (context ``/*/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)='M'][VAT]``, CII the M VAT header trade tax)::

        not(cbc:TaxExemptionReason) and not(cbc:TaxExemptionReasonCode)

    — the exemption-forbidding BR-S/Z/AF-10 shape, identical on both
    bindings.
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if (st.category_id == "M" and st.category_scheme_id == "VAT"
                    and (st.has_exemption_reason or st.has_exemption_reason_code)):
                return Violation(
                    "BR-AG-10",
                    "A VAT breakdown (BG-23) with VAT category code (BT-118) "
                    "'IPSI' shall not have a VAT exemption reason code "
                    "(BT-121) or VAT exemption reason text (BT-120).",
                    "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/"
                    "cbc:TaxExemptionReason")
    return None


# ---------------------------------------------------------------------------
# Italian split payment (B) rules (BR-B-01/BR-B-02).
#
# UNCL 5305 category 'B' ("transferred VAT / split payment") is the Italian
# scissione dei pagamenti regime, where the buyer pays the VAT directly to
# the state instead of to the seller. EN 16931 constrains it with just two
# document-level rules — there is no BR-B breakdown/rate family. Both
# official tests are RAW general comparisons (no normalize-space, no
# TaxScheme scoping), so the bodies read the raw string-value node sets the
# parsers collect verbatim (``tax_category_ids_raw`` etc.).
# ---------------------------------------------------------------------------
def _split_payment_item_present(inv):
    """The BR-B-01 'B'-presence node set.

    UBL: ``//cac:TaxCategory/cbc:ID = 'B' or //cac:ClassifiedTaxCategory/
    cbc:ID = 'B'`` — ANY tax category anywhere (breakdown rows, document- and
    line-level allowance/charge categories, line item categories), raw
    string-value equality. CII: ``//ram:CategoryCode = 'B'`` — the union of
    the CategoryTradeTax and ApplicableTradeTax code lists covers every
    ``ram:CategoryCode`` element, so the same two model lists transcribe it.
    """
    return ("B" in inv.tax_category_ids_raw
            or "B" in inv.classified_category_ids_raw)


def br_b_01(inv):
    """BR-B-01: an Invoice where the VAT category code (BT-151, BT-95 or
    BT-102) is 'Split payment' shall be a domestic Italian invoice.

    Official UBL (context ``/ubl:Invoice``)::

        (not(//cbc:IdentificationCode != 'IT')
           and (//cac:TaxCategory/cbc:ID ='B'
                or //cac:ClassifiedTaxCategory/cbc:ID = 'B'))
        or (not(//cac:TaxCategory/cbc:ID ='B'
                or //cac:ClassifiedTaxCategory/cbc:ID = 'B'))

    CII: ``(not(//ram:CountryID != 'IT') and //ram:CategoryCode ='B') or
    (not(//ram:CategoryCode ='B'))``. Both are raw comparisons: the assert
    fires iff a 'B' category exists anywhere AND at least one country
    identification code in the document differs from 'IT'
    (``//cbc:IdentificationCode`` covers the postal-address Country codes
    AND the item OriginCountry codes; a document with 'B' categories and NO
    country code at all vacuously passes).
    """
    if (_split_payment_item_present(inv)
            and any(c != "IT" for c in inv.all_country_codes_raw)):
        return Violation(
            "BR-B-01",
            "An Invoice where the VAT category code (BT-151, BT-95 or "
            "BT-102) is 'Split payment' (B) shall be a domestic Italian "
            "invoice: every country identification code in the document "
            "must be 'IT'.",
            "cac:Country/cbc:IdentificationCode")
    return None


def br_b_02(inv):
    """BR-B-02: an Invoice with a 'Split payment' (B) VAT category code
    (BT-151, BT-95, BT-118 or BT-102) shall not also contain a 'Standard
    rated' (S) VAT category code.

    Official UBL (context ``/ubl:Invoice``) — three raw child-axis /
    descendant node sets, the same union on both sides::

        ((cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID ='B'
           or cac:AllowanceCharge/cac:TaxCategory/cbc:ID ='B'
           or //cac:ClassifiedTaxCategory/cbc:ID = 'B')
         and not( ... the same three sets = 'S' ...))
        or not( ... the same three sets = 'B' ...)

    — the breakdown and allowance/charge sets are CHILD-axis (top-level
    TaxTotal rows and document-level allowance/charge categories only; a
    line-level allowance category is NOT in this rule's UBL node set, unlike
    BR-B-01's ``//cac:TaxCategory``), while the item classified set is any
    depth. The CII binding is simply ``(//ram:CategoryCode ='B' and
    not(//ram:CategoryCode ='S')) or not(//ram:CategoryCode ='B')`` — every
    CategoryCode anywhere — so the body branches on syntax and compares each
    binding's exact node set. Fires iff 'B' and 'S' are both present.
    """
    if inv.syntax == "cii":
        codes = inv.tax_category_ids_raw + inv.classified_category_ids_raw
    else:
        codes = (inv.doc_breakdown_category_ids_raw
                 + inv.doc_ac_category_ids_raw
                 + inv.classified_category_ids_raw)
    if "B" in codes and "S" in codes:
        return Violation(
            "BR-B-02",
            "An Invoice that contains a VAT category code (BT-151, BT-95, "
            "BT-118 or BT-102) 'Split payment' (B) shall not also contain "
            "the VAT category code 'Standard rated' (S).",
            "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")
    return None


# ---------------------------------------------------------------------------
# VAT-category families (BR-AE/E/G/IC/O-01) — "exactly one breakdown row"
# ---------------------------------------------------------------------------
def _vat_exactly_one_breakdown(inv, code):
    """The shared official -01 pattern for categories AE/E/G/K/O (and Z).

    HOLDS iff::

        (X appears on ANY VAT-scheme TaxCategory/ClassifiedTaxCategory in the
         document AND the VAT breakdown has EXACTLY ONE X row)
        OR (X appears nowhere)

    Two things the official XPath pins down:

    * the "anywhere" set is ``//cac:TaxCategory | //cac:ClassifiedTaxCategory``
      (VAT scheme only) — which INCLUDES the breakdown's own categories, so two
      X breakdown rows fire the rule even with no X line/allowance/charge;
    * one orphan X breakdown row (count = 1) does NOT fire it.
    """
    if code not in inv.vat_category_codes:
        return True
    return inv.breakdown_vat_category_codes().count(code) == 1


def _cii_vat_exactly_one_breakdown(inv, code):
    """The official CII -01 shape (context ``/rsm:CrossIndustryInvoice``),
    transcribed for category ``code``::

        (count(//ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax
               [ram:CategoryCode='X']) = 0
         and count(//ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax
               [ram:CategoryCode='X']) = 0
         and count(//ram:CategoryTradeTax[ram:CategoryCode='X']) = 0)
        or (count(//ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax
               [ram:CategoryCode='X']) = 1
            and (exists(//ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax
                   [ram:CategoryCode='X'])
                 or exists(//ram:CategoryTradeTax[ram:CategoryCode='X'])))

    Two genuine differences from the UBL binding, transcribed exactly:
    the comparisons are RAW (``ram:CategoryCode='X'``) with NO VAT TypeCode
    filter anywhere, and one ORPHAN X breakdown row (header count = 1 with no
    X line/allowance/charge) FIRES the rule — on UBL the same orphan holds.
    """
    hdr = sum(1 for row in inv.cii_header_trade_tax_code_rows if code in row)
    line_any = any(code in row for row in inv.cii_line_trade_tax_code_rows)
    cat_any = code in inv.tax_category_ids_raw
    return ((hdr == 0 and not line_any and not cat_any)
            or (hdr == 1 and (line_any or cat_any)))


def _cii_o_exactly_one_breakdown(inv):
    """The official CII BR-O-01 shape (context ``/rsm:CrossIndustryInvoice``)
    — NOT the AE/Z/E/G/K ``_cii_vat_exactly_one_breakdown`` shape. Verbatim::

        not(//ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax
              [ram:CategoryCode='O'])
        or (count(//ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax
              [ram:CategoryCode='O']) = 1
            and (exists(//ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax
                  [ram:CategoryCode='O'])
                 or exists(//ram:CategoryTradeTax[ram:CategoryCode='O'])))

    The comparisons are RAW (no VAT TypeCode filter), like the other -01
    heads — but the first disjunct is ``not(header-O-rows)`` rather than the
    all-three-node-sets-empty conjunction, so an O line or O allowance/charge
    with NO O header breakdown row officially HOLDS on CII (where the UBL
    binding and every other CII -01 head fire); what fires is an O header
    row count != 1, or one ORPHAN O header row with no O item anywhere
    (differential-proven T-VHCIIP.6)."""
    hdr = sum(1 for row in inv.cii_header_trade_tax_code_rows if "O" in row)
    if hdr == 0:
        return True
    line_any = any("O" in row for row in inv.cii_line_trade_tax_code_rows)
    cat_any = "O" in inv.tax_category_ids_raw
    return hdr == 1 and (line_any or cat_any)


def br_ae_01(inv):
    """BR-AE-01: 'Reverse charge' (AE) items require exactly one AE VAT
    breakdown (BG-23) row.

    The CII binding differs from the UBL one (raw comparisons, no VAT scheme
    filter, and an orphan AE breakdown row fires) — the body branches on
    ``inv.syntax`` and transcribes each binding exactly (see
    :func:`_cii_vat_exactly_one_breakdown`).
    """
    if inv.syntax == "cii":
        if _cii_vat_exactly_one_breakdown(inv, "AE"):
            return None
        return Violation(
            "BR-AE-01",
            "An Invoice with a 'Reverse charge' (AE) VAT category (BT-151/"
            "BT-95/BT-102) must contain exactly one AE VAT breakdown row "
            "(BT-118); found %d."
            % sum(1 for row in inv.cii_header_trade_tax_code_rows
                  if "AE" in row),
            "ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax/"
            "ram:CategoryCode")
    if _vat_exactly_one_breakdown(inv, "AE"):
        return None
    return Violation(
        "BR-AE-01",
        "An Invoice with a 'Reverse charge' (AE) VAT category (BT-151/BT-95/"
        "BT-102) must contain exactly one AE VAT breakdown row (BT-118); "
        "found %d." % inv.breakdown_vat_category_codes().count("AE"),
        "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")


def br_e_01(inv):
    """BR-E-01: 'Exempt from VAT' (E) items require exactly one E VAT
    breakdown (BG-23) row.

    The CII binding is the exact BR-AE-01 shape for category 'E' (raw
    comparisons, no VAT TypeCode filter, and an orphan E breakdown row
    fires) — the body branches on ``inv.syntax`` like :func:`br_ae_01`
    (see :func:`_cii_vat_exactly_one_breakdown`).
    """
    if inv.syntax == "cii":
        if _cii_vat_exactly_one_breakdown(inv, "E"):
            return None
        return Violation(
            "BR-E-01",
            "An Invoice with an 'Exempt from VAT' (E) VAT category (BT-151/"
            "BT-95/BT-102) must contain exactly one E VAT breakdown row "
            "(BT-118); found %d."
            % sum(1 for row in inv.cii_header_trade_tax_code_rows
                  if "E" in row),
            "ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax/"
            "ram:CategoryCode")
    if _vat_exactly_one_breakdown(inv, "E"):
        return None
    return Violation(
        "BR-E-01",
        "An Invoice with an 'Exempt from VAT' (E) VAT category (BT-151/BT-95/"
        "BT-102) must contain exactly one E VAT breakdown row (BT-118); "
        "found %d." % inv.breakdown_vat_category_codes().count("E"),
        "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")


def br_g_01(inv):
    """BR-G-01: 'Export outside the EU' (G) items require exactly one G VAT
    breakdown (BG-23) row.

    The CII binding is the exact BR-AE-01 shape for category 'G' (raw
    comparisons, no VAT TypeCode filter, and an orphan G breakdown row
    fires) — the body branches on ``inv.syntax`` like :func:`br_ae_01`
    (see :func:`_cii_vat_exactly_one_breakdown`).
    """
    if inv.syntax == "cii":
        if _cii_vat_exactly_one_breakdown(inv, "G"):
            return None
        return Violation(
            "BR-G-01",
            "An Invoice with an 'Export outside the EU' (G) VAT category "
            "(BT-151/BT-95/BT-102) must contain exactly one G VAT breakdown "
            "row (BT-118); found %d."
            % sum(1 for row in inv.cii_header_trade_tax_code_rows
                  if "G" in row),
            "ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax/"
            "ram:CategoryCode")
    if _vat_exactly_one_breakdown(inv, "G"):
        return None
    return Violation(
        "BR-G-01",
        "An Invoice with an 'Export outside the EU' (G) VAT category (BT-151/"
        "BT-95/BT-102) must contain exactly one G VAT breakdown row (BT-118); "
        "found %d." % inv.breakdown_vat_category_codes().count("G"),
        "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")


def br_ic_01(inv):
    """BR-IC-01: 'Intra-community supply' (K) items require exactly one K VAT
    breakdown (BG-23) row.

    The CII binding is the exact BR-AE-01 shape for category 'K' (raw
    comparisons, no VAT TypeCode filter, and an orphan K breakdown row
    fires) — the body branches on ``inv.syntax`` like :func:`br_ae_01`
    (see :func:`_cii_vat_exactly_one_breakdown`).
    """
    if inv.syntax == "cii":
        if _cii_vat_exactly_one_breakdown(inv, "K"):
            return None
        return Violation(
            "BR-IC-01",
            "An Invoice with an 'Intra-community supply' (K) VAT category "
            "(BT-151/BT-95/BT-102) must contain exactly one K VAT breakdown "
            "row (BT-118); found %d."
            % sum(1 for row in inv.cii_header_trade_tax_code_rows
                  if "K" in row),
            "ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax/"
            "ram:CategoryCode")
    if _vat_exactly_one_breakdown(inv, "K"):
        return None
    return Violation(
        "BR-IC-01",
        "An Invoice with an 'Intra-community supply' (K) VAT category (BT-151/"
        "BT-95/BT-102) must contain exactly one K VAT breakdown row (BT-118); "
        "found %d." % inv.breakdown_vat_category_codes().count("K"),
        "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")


def br_o_01(inv):
    """BR-O-01: 'Not subject to VAT' (O) items require exactly one O VAT
    breakdown (BG-23) row.

    The CII binding is its OWN shape — ``not(header-O-rows) or ...`` — not
    the AE/Z/E/G/K one: an O item with no O header row officially HOLDS on
    CII, while an orphan or duplicated O header row fires. The body branches
    on ``inv.syntax`` (see :func:`_cii_o_exactly_one_breakdown` for the
    verbatim official test)."""
    if inv.syntax == "cii":
        if _cii_o_exactly_one_breakdown(inv):
            return None
        return Violation(
            "BR-O-01",
            "An Invoice with a 'Not subject to VAT' (O) VAT breakdown row "
            "(BT-118) must contain exactly one such row AND an O Invoice "
            "line, Document level allowance or charge (BT-151/BT-95/BT-102); "
            "found %d row(s)."
            % sum(1 for row in inv.cii_header_trade_tax_code_rows
                  if "O" in row),
            "ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax/"
            "ram:CategoryCode")
    if _vat_exactly_one_breakdown(inv, "O"):
        return None
    return Violation(
        "BR-O-01",
        "An Invoice with a 'Not subject to VAT' (O) VAT category (BT-151/BT-95/"
        "BT-102) must contain exactly one O VAT breakdown row (BT-118); "
        "found %d." % inv.breakdown_vat_category_codes().count("O"),
        "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")


# ---------------------------------------------------------------------------
# Decimal-precision rules (BR-DEC-*): max 2 decimals on monetary fields.
# Official test everywhere: string-length(substring-after(V, '.')) <= 2 over
# the literal string value — absent element / no '.' = 0 decimals = holds.
# ---------------------------------------------------------------------------
def _dec_violation(rule_id, bt, label, element):
    return Violation(
        rule_id,
        "The allowed maximum number of decimals for %s (%s) is 2." % (label, bt),
        element)


def br_dec_01(inv):
    """BR-DEC-01: max 2 decimals for the Document level allowance amount (BT-92)."""
    for ac in inv.doc_allowance_charges:
        if ac.is_charge is False and _dec_places(ac.amount_raw) > 2:
            return _dec_violation("BR-DEC-01", "BT-92",
                                  "the Document level allowance amount",
                                  "cac:AllowanceCharge/cbc:Amount")
    return None


def br_dec_02(inv):
    """BR-DEC-02: max 2 decimals for the Document level allowance base amount (BT-93)."""
    for ac in inv.doc_allowance_charges:
        if ac.is_charge is False and _dec_places(ac.base_amount_raw) > 2:
            return _dec_violation("BR-DEC-02", "BT-93",
                                  "the Document level allowance base amount",
                                  "cac:AllowanceCharge/cbc:BaseAmount")
    return None


def br_dec_05(inv):
    """BR-DEC-05: max 2 decimals for the Document level charge amount (BT-99)."""
    for ac in inv.doc_allowance_charges:
        if ac.is_charge is True and _dec_places(ac.amount_raw) > 2:
            return _dec_violation("BR-DEC-05", "BT-99",
                                  "the Document level charge amount",
                                  "cac:AllowanceCharge/cbc:Amount")
    return None


def br_dec_06(inv):
    """BR-DEC-06: max 2 decimals for the Document level charge base amount (BT-100)."""
    for ac in inv.doc_allowance_charges:
        if ac.is_charge is True and _dec_places(ac.base_amount_raw) > 2:
            return _dec_violation("BR-DEC-06", "BT-100",
                                  "the Document level charge base amount",
                                  "cac:AllowanceCharge/cbc:BaseAmount")
    return None


def _dec_lmt(inv, rule_id, bt, label, local):
    """Shared body for the LegalMonetaryTotal BR-DEC rules (context = LMT)."""
    if _dec_places(inv.lmt_raw.get(local)) > 2:
        return _dec_violation(rule_id, bt, label,
                              "cac:LegalMonetaryTotal/cbc:%s" % local)
    return None


def br_dec_09(inv):
    """BR-DEC-09: max 2 decimals for the Sum of Invoice line net amount (BT-106)."""
    return _dec_lmt(inv, "BR-DEC-09", "BT-106",
                    "the Sum of Invoice line net amount", "LineExtensionAmount")


def br_dec_10(inv):
    """BR-DEC-10: max 2 decimals for the Sum of allowances on document level (BT-107)."""
    return _dec_lmt(inv, "BR-DEC-10", "BT-107",
                    "the Sum of allowances on document level", "AllowanceTotalAmount")


def br_dec_11(inv):
    """BR-DEC-11: max 2 decimals for the Sum of charges on document level (BT-108)."""
    return _dec_lmt(inv, "BR-DEC-11", "BT-108",
                    "the Sum of charges on document level", "ChargeTotalAmount")


def br_dec_12(inv):
    """BR-DEC-12: max 2 decimals for the Invoice total amount without VAT (BT-109)."""
    return _dec_lmt(inv, "BR-DEC-12", "BT-109",
                    "the Invoice total amount without VAT", "TaxExclusiveAmount")


def br_dec_14(inv):
    """BR-DEC-14: max 2 decimals for the Invoice total amount with VAT (BT-112)."""
    return _dec_lmt(inv, "BR-DEC-14", "BT-112",
                    "the Invoice total amount with VAT", "TaxInclusiveAmount")


def br_dec_16(inv):
    """BR-DEC-16: max 2 decimals for the Paid amount (BT-113)."""
    return _dec_lmt(inv, "BR-DEC-16", "BT-113",
                    "the Paid amount", "PrepaidAmount")


def br_dec_17(inv):
    """BR-DEC-17: max 2 decimals for the Rounding amount (BT-114)."""
    return _dec_lmt(inv, "BR-DEC-17", "BT-114",
                    "the Rounding amount", "PayableRoundingAmount")


def br_dec_18(inv):
    """BR-DEC-18: max 2 decimals for the Amount due for payment (BT-115)."""
    return _dec_lmt(inv, "BR-DEC-18", "BT-115",
                    "the Amount due for payment", "PayableAmount")


def br_dec_19(inv):
    """BR-DEC-19: max 2 decimals for the VAT category taxable amount (BT-116).

    Context = every ``cac:TaxTotal/cac:TaxSubtotal`` (any depth).
    """
    for st in inv.all_tax_subtotals:
        if _dec_places(st.taxable_amount_raw) > 2:
            return _dec_violation("BR-DEC-19", "BT-116",
                                  "the VAT category taxable amount",
                                  "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount")
    return None


def br_dec_20(inv):
    """BR-DEC-20: max 2 decimals for the VAT category tax amount (BT-117)."""
    for st in inv.all_tax_subtotals:
        if _dec_places(st.tax_amount_raw) > 2:
            return _dec_violation("BR-DEC-20", "BT-117",
                                  "the VAT category tax amount",
                                  "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount")
    return None


def br_dec_23(inv):
    """BR-DEC-23: max 2 decimals for the Invoice line net amount (BT-131)."""
    for ln in inv.lines:
        if _dec_places(ln.line_extension_amount_raw) > 2:
            return _dec_violation("BR-DEC-23", "BT-131",
                                  "the Invoice line net amount",
                                  ln.label + "/cbc:LineExtensionAmount")
    return None


# ---------------------------------------------------------------------------
# Allowance / charge existence rules (BG-20/21 document level, BG-27/28 line
# level). Each official rule's CONTEXT is the AllowanceCharge itself, split on
# the boolean cbc:ChargeIndicator, so a rule is evaluated per matching group and
# only when the ChargeIndicator casts to the required boolean (allowance=false,
# charge=true). A group whose ChargeIndicator is absent/unparseable matches
# neither context (parser: is_charge is None) and is skipped by every rule here.
# ---------------------------------------------------------------------------
def br_31(inv):
    """BR-31: Each Document level allowance (BG-20) shall have a Document level
    allowance amount (BT-92).

    Official (context ``/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator =
    false()]``): ``exists(cbc:Amount)`` — pure existence (present-but-empty
    satisfies it; only absence fires).
    """
    for ac in inv.doc_allowance_charges:
        if ac.is_charge is False and not ac.has_amount:
            return Violation(
                "BR-31",
                "Each Document level allowance (BG-20) shall have a Document "
                "level allowance amount (BT-92).",
                "cac:AllowanceCharge/cbc:Amount")
    return None


def br_32(inv):
    """BR-32: Each Document level allowance (BG-20) shall have a Document level
    allowance VAT category code (BT-95).

    Official (context = document-level allowance)::

        exists(cac:TaxCategory[cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']/cbc:ID)

    A VAT-scheme ``cac:TaxCategory`` (its ``TaxScheme/ID`` normalize-space +
    upper-case = 'VAT') carrying a ``cbc:ID`` must exist. A TaxCategory with no
    VAT TaxScheme, or a VAT TaxCategory with no ID, does not satisfy it.
    """
    for ac in inv.doc_allowance_charges:
        if ac.is_charge is False and not ac.has_vat_category_id:
            return Violation(
                "BR-32",
                "Each Document level allowance (BG-20) shall have a Document "
                "level allowance VAT category code (BT-95).",
                "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_33(inv):
    """BR-33: Each Document level allowance (BG-20) shall have a Document level
    allowance reason (BT-97) or a Document level allowance reason code (BT-98).

    Official (context = document-level allowance)::

        exists(cbc:AllowanceChargeReason) or exists(cbc:AllowanceChargeReasonCode)
    """
    for ac in inv.doc_allowance_charges:
        if ac.is_charge is False and not ac.has_reason:
            return Violation(
                "BR-33",
                "Each Document level allowance (BG-20) shall have a Document "
                "level allowance reason (BT-97) or a Document level allowance "
                "reason code (BT-98).",
                "cac:AllowanceCharge/cbc:AllowanceChargeReason")
    return None


def br_36(inv):
    """BR-36: Each Document level charge (BG-21) shall have a Document level
    charge amount (BT-99).

    Official (context ``/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator =
    true()]``): ``exists(cbc:Amount)``.
    """
    for ac in inv.doc_allowance_charges:
        if ac.is_charge is True and not ac.has_amount:
            return Violation(
                "BR-36",
                "Each Document level charge (BG-21) shall have a Document level "
                "charge amount (BT-99).",
                "cac:AllowanceCharge/cbc:Amount")
    return None


def br_37(inv):
    """BR-37: Each Document level charge (BG-21) shall have a Document level
    charge VAT category code (BT-102).

    Official (context = document-level charge)::

        exists(cac:TaxCategory[cac:TaxScheme/normalize-space(upper-case(cbc:ID))='VAT']/cbc:ID)
    """
    for ac in inv.doc_allowance_charges:
        if ac.is_charge is True and not ac.has_vat_category_id:
            return Violation(
                "BR-37",
                "Each Document level charge (BG-21) shall have a Document level "
                "charge VAT category code (BT-102).",
                "cac:AllowanceCharge/cac:TaxCategory/cbc:ID")
    return None


def br_38(inv):
    """BR-38: Each Document level charge (BG-21) shall have a Document level
    charge reason (BT-104) or a Document level charge reason code (BT-105).

    Official (context = document-level charge)::

        exists(cbc:AllowanceChargeReason) or exists(cbc:AllowanceChargeReasonCode)
    """
    for ac in inv.doc_allowance_charges:
        if ac.is_charge is True and not ac.has_reason:
            return Violation(
                "BR-38",
                "Each Document level charge (BG-21) shall have a Document level "
                "charge reason (BT-104) or a Document level charge reason code "
                "(BT-105).",
                "cac:AllowanceCharge/cbc:AllowanceChargeReason")
    return None


def br_41(inv):
    """BR-41: Each Invoice line allowance (BG-27) shall have an Invoice line
    allowance amount (BT-136).

    Official (context ``//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator
    = false()]``): ``exists(cbc:Amount)`` — evaluated per line-level allowance.
    """
    for ln in inv.lines:
        for ac in ln.allowance_charges:
            if ac.is_charge is False and not ac.has_amount:
                return Violation(
                    "BR-41",
                    "Each Invoice line allowance (BG-27) shall have an Invoice "
                    "line allowance amount (BT-136).",
                    ln.label + "/cac:AllowanceCharge/cbc:Amount")
    return None


def br_42(inv):
    """BR-42: Each Invoice line allowance (BG-27) shall have an Invoice line
    allowance reason (BT-139) or an Invoice line allowance reason code (BT-140).

    Official (context = line-level allowance)::

        exists(cbc:AllowanceChargeReason) or exists(cbc:AllowanceChargeReasonCode)
    """
    for ln in inv.lines:
        for ac in ln.allowance_charges:
            if ac.is_charge is False and not ac.has_reason:
                return Violation(
                    "BR-42",
                    "Each Invoice line allowance (BG-27) shall have an Invoice "
                    "line allowance reason (BT-139) or an Invoice line allowance "
                    "reason code (BT-140).",
                    ln.label + "/cac:AllowanceCharge/cbc:AllowanceChargeReason")
    return None


def br_43(inv):
    """BR-43: Each Invoice line charge (BG-28) shall have an Invoice line charge
    amount (BT-141).

    Official (context ``//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator
    = true()]``): ``exists(cbc:Amount)``.
    """
    for ln in inv.lines:
        for ac in ln.allowance_charges:
            if ac.is_charge is True and not ac.has_amount:
                return Violation(
                    "BR-43",
                    "Each Invoice line charge (BG-28) shall have an Invoice line "
                    "charge amount (BT-141).",
                    ln.label + "/cac:AllowanceCharge/cbc:Amount")
    return None


def br_44(inv):
    """BR-44: Each Invoice line charge (BG-28) shall have an Invoice line charge
    reason (BT-144) or an Invoice line charge reason code (BT-145).

    Official (context = line-level charge)::

        exists(cbc:AllowanceChargeReason) or exists(cbc:AllowanceChargeReasonCode)
    """
    for ln in inv.lines:
        for ac in ln.allowance_charges:
            if ac.is_charge is True and not ac.has_reason:
                return Violation(
                    "BR-44",
                    "Each Invoice line charge (BG-28) shall have an Invoice line "
                    "charge reason (BT-144) or an Invoice line charge reason code "
                    "(BT-145).",
                    ln.label + "/cac:AllowanceCharge/cbc:AllowanceChargeReason")
    return None


# ---------------------------------------------------------------------------
# Payee (BG-10), Seller tax representative (BG-11/BG-12), Payment instructions
# (BG-16/BG-17/BG-18), Preceding invoice references (BG-3), Deliver-to address
# (BG-15) and electronic-address scheme rules.
# ---------------------------------------------------------------------------
def br_17(inv):
    """BR-17: The Payee name (BT-59) shall be provided in the Invoice, if the
    Payee (BG-10) is different from the Seller (BG-4).

    Official (context ``cac:PayeeParty``)::

        exists(cac:PartyName/cbc:Name)
          and (not(cac:PartyName/cbc:Name
                     = ../cac:AccountingSupplierParty/cac:Party/cac:PartyName/cbc:Name)
               and not(cac:PartyIdentification/cbc:ID
                     = ../cac:AccountingSupplierParty/cac:Party/cac:PartyIdentification/cbc:ID))

    Evaluated per PayeeParty group. The name/id equalities are general
    comparisons over RAW string values (no normalize-space): the assert fires
    when the payee has no name element, OR when any payee name equals any
    Seller PartyName name, OR when any payee identifier equals any Seller
    identifier (i.e. the official artifact rejects a PayeeParty that duplicates
    the Seller — the payee must genuinely differ).

    Official CII (context ``//ram:PayeeTradeParty``)::

        (ram:Name)
          and (not(ram:Name = ../../ram:ApplicableHeaderTradeAgreement/
                       ram:SellerTradeParty/ram:Name)
               and not(ram:ID = .../ram:SellerTradeParty/ram:ID)
               and not(ram:SpecifiedLegalOrganization/ram:ID
                     = .../ram:SellerTradeParty/ram:SpecifiedLegalOrganization/
                       ram:ID))

    Same shape plus a THIRD equality conjunct over the legal-registration
    identifiers (BT-61 vs BT-30). The UBL test has no such conjunct, so the
    UBL parser leaves ``legal_ids``/``seller_legal_ids`` empty and the extra
    check below is vacuously satisfied there.
    """
    for pp in inv.payee_parties:
        holds = (bool(pp.names)
                 and not any(n in pp.seller_names for n in pp.names)
                 and not any(i in pp.seller_ids for i in pp.ids)
                 and not any(i in pp.seller_legal_ids for i in pp.legal_ids))
        if not holds:
            return Violation(
                "BR-17",
                "The Payee name (BT-59) shall be provided in the Invoice, if "
                "the Payee (BG-10) is different from the Seller (BG-4).",
                "cac:PayeeParty/cac:PartyName/cbc:Name")
    return None


def br_18(inv):
    """BR-18: The Seller tax representative name (BT-62) shall be provided in
    the Invoice, if the Seller (BG-4) has a Seller tax representative party
    (BG-11).

    Official (context ``cac:TaxRepresentativeParty``)::

        normalize-space(cac:PartyName/cbc:Name) != ''

    Absent, empty or whitespace-only name fires per representative party.
    """
    for trp in inv.tax_representatives:
        name = trp.name if trp.name is not None else ""
        if not " ".join(name.split()):
            return Violation(
                "BR-18",
                "The Seller tax representative name (BT-62) shall be provided "
                "in the Invoice, if the Seller (BG-4) has a Seller tax "
                "representative party (BG-11).",
                "cac:TaxRepresentativeParty/cac:PartyName/cbc:Name")
    return None


def br_19(inv):
    """BR-19: The Seller tax representative postal address (BG-12) shall be
    provided in the Invoice, if the Seller (BG-4) has a Seller tax
    representative party (BG-11).

    Official (context ``cac:TaxRepresentativeParty``): ``exists(cac:PostalAddress)``.
    """
    for trp in inv.tax_representatives:
        if not trp.has_postal_address:
            return Violation(
                "BR-19",
                "The Seller tax representative postal address (BG-12) shall be "
                "provided in the Invoice, if the Seller (BG-4) has a Seller "
                "tax representative party (BG-11).",
                "cac:TaxRepresentativeParty/cac:PostalAddress")
    return None


def br_20(inv):
    """BR-20: The Seller tax representative postal address (BG-12) shall
    contain a Tax representative country code (BT-69), if the Seller (BG-4)
    has a Seller tax representative party (BG-11).

    Official (context ``cac:TaxRepresentativeParty/cac:PostalAddress``)::

        normalize-space(cac:Country/cbc:IdentificationCode) != ''

    On UBL only evaluated when that postal address is PRESENT (absence is
    BR-19's job); absent/empty/whitespace-only country code fires.

    Official CII (context ``//ram:SellerTaxRepresentativeTradeParty`` — the
    trade PARTY, not the address)::

        normalize-space(ram:PostalTradeAddress/ram:CountryID) != ''

    The CII binding is evaluated once per representative party even when the
    postal address is absent (the path then string-values to ``''``), so on
    CII this rule fires ALONGSIDE BR-19 for an address-less representative.
    The CII parser transcribes that by appending one entry per trade party
    (None when the address or country is absent), so this body runs unchanged.
    """
    for cc in inv.taxrep_postal_addresses:
        if not " ".join((cc or "").split()):
            return Violation(
                "BR-20",
                "The Seller tax representative postal address (BG-12) shall "
                "contain a Tax representative country code (BT-69), if the "
                "Seller (BG-4) has a Seller tax representative party (BG-11).",
                "cac:TaxRepresentativeParty/cac:PostalAddress/"
                "cac:Country/cbc:IdentificationCode")
    return None


def br_49(inv):
    """BR-49: A Payment instruction (BG-16) shall specify the Payment means
    type code (BT-81).

    Official (context ``cac:PaymentMeans``): ``exists(cbc:PaymentMeansCode)``
    — pure existence per PaymentMeans group (present-but-empty satisfies it).
    """
    for pm in inv.payment_means:
        if not pm.has_code:
            return Violation(
                "BR-49",
                "A Payment instruction (BG-16) shall specify the Payment means "
                "type code (BT-81).",
                "cac:PaymentMeans/cbc:PaymentMeansCode")
    return None


def br_50(inv):
    """BR-50: A Payment account identifier (BT-84) shall be present if Credit
    transfer (BG-17) information is provided in the Invoice.

    Official (context ``cac:PaymentMeans[cbc:PaymentMeansCode='30' or
    cbc:PaymentMeansCode='58']/cac:PayeeFinancialAccount``)::

        normalize-space(cbc:ID) != ''

    The context predicate compares the RAW code string values (no
    normalize-space, unlike BR-61); given a matching PaymentMeans, the rule is
    evaluated per PayeeFinancialAccount, whose ID must normalize-space to a
    non-empty string.
    """
    for pm in inv.payment_means:
        if not any(c in ("30", "58") for c in pm.codes_raw):
            continue  # context predicate does not match
        for first_id in pm.account_first_ids:
            if not " ".join((first_id or "").split()):
                return Violation(
                    "BR-50",
                    "A Payment account identifier (BT-84) shall be present if "
                    "Credit transfer (BG-17) information is provided in the "
                    "Invoice.",
                    "cac:PaymentMeans/cac:PayeeFinancialAccount/cbc:ID")
    return None


def br_51(inv):
    """BR-51: The last 4 to 6 digits of the Payment card primary account number
    (BT-87) shall be present if Payment card information (BG-18) is provided.

    Official (context ``cac:PaymentMeans/cac:CardAccount/
    cbc:PrimaryAccountNumberID``, flag WARNING)::

        string-length(normalize-space(.)) <= 10

    Per PCI DSS an invoice must never carry a full primary account number: at
    most first 6 + last 4 digits (10 characters after normalize-space). The
    official flag is ``warning``, so the violation is non-blocking.
    """
    for pan in inv.card_pans:
        if len(" ".join(pan.split())) > 10:
            return Violation(
                "BR-51",
                "In accordance with card payments security standards an "
                "invoice should never include a full card primary account "
                "number (BT-87); at most the first 6 and last 4 digits may be "
                "shown.",
                "cac:PaymentMeans/cac:CardAccount/cbc:PrimaryAccountNumberID",
                "warning")
    return None


def br_55(inv):
    """BR-55: Each Preceding Invoice reference (BG-3) shall contain a Preceding
    Invoice reference (BT-25).

    Official (context ``cac:BillingReference``)::

        exists(cac:InvoiceDocumentReference/cbc:ID)

    Pure existence, evaluated per BillingReference group (any depth — UBL also
    allows line-level BillingReference, which the pattern context matches).
    """
    for has_id in inv.billing_references:
        if not has_id:
            return Violation(
                "BR-55",
                "Each Preceding Invoice reference (BG-3) shall contain a "
                "Preceding Invoice reference (BT-25).",
                "cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID")
    return None


def br_57(inv):
    """BR-57: Each Deliver to address (BG-15) shall contain a Deliver to
    country code (BT-80).

    Official (context ``cac:Delivery/cac:DeliveryLocation/cac:Address``)::

        exists(cac:Country/cbc:IdentificationCode)

    Pure existence (present-but-EMPTY satisfies it, unlike the normalize-space
    tests of BR-09/BR-11/BR-20), per deliver-to Address — including line-level
    Delivery groups, which the pattern context matches.
    """
    for has_cc in inv.delivery_addresses:
        if not has_cc:
            return Violation(
                "BR-57",
                "Each Deliver to address (BG-15) shall contain a Deliver to "
                "country code (BT-80).",
                "cac:Delivery/cac:DeliveryLocation/cac:Address/"
                "cac:Country/cbc:IdentificationCode")
    return None


def br_61(inv):
    """BR-61: If the Payment means type code (BT-81) means SEPA credit
    transfer, Local credit transfer or Non-SEPA international credit transfer,
    the Payment account identifier (BT-84) shall be present.

    Official (context ``cac:PaymentMeans``)::

        (exists(cac:PayeeFinancialAccount/cbc:ID)
           and (normalize-space(cbc:PaymentMeansCode) = '30'
                or normalize-space(cbc:PaymentMeansCode) = '58'))
        or (normalize-space(cbc:PaymentMeansCode) != '30'
            and normalize-space(cbc:PaymentMeansCode) != '58')

    normalize-space here (unlike BR-50's raw context predicate): an absent code
    normalizes to '' and the second disjunct holds. Fires iff the normalized
    code is credit transfer (30/58) and no PayeeFinancialAccount/ID exists.

    Official CII (context ``//ram:SpecifiedTradeSettlementPaymentMeans
    [ram:TypeCode='30' or ram:TypeCode='58']/ram:PayeePartyCreditorFinancial
    Account`` — the ACCOUNT node, unlike the UBL PaymentMeans context)::

        (ram:IBANID) or (ram:ProprietaryID)

    Two genuine binding differences, transcribed exactly: (1) the context
    predicate compares the RAW TypeCode string values (as BR-50 does on UBL),
    not normalize-space; (2) a credit-transfer payment means with NO account
    group carries no context node at all, so nothing fires — the rule only
    fires for an account that exists but carries NEITHER an ``ram:IBANID``
    nor a ``ram:ProprietaryID`` element (the CII parser encodes that
    existence fact as a ``None`` entry in ``account_first_ids``).
    """
    if inv.syntax == "cii":
        for pm in inv.payment_means:
            if not any(c in ("30", "58") for c in pm.codes_raw):
                continue
            for first_id in pm.account_first_ids:
                if first_id is None:
                    return Violation(
                        "BR-61",
                        "If the Payment means type code (BT-81) means credit "
                        "transfer, the Payment account identifier (BT-84) "
                        "shall be present.",
                        "ram:SpecifiedTradeSettlementPaymentMeans/"
                        "ram:PayeePartyCreditorFinancialAccount/ram:IBANID")
        return None
    for pm in inv.payment_means:
        if pm.code_norm in ("30", "58") and not pm.has_account_id:
            return Violation(
                "BR-61",
                "If the Payment means type code (BT-81=%s) means credit "
                "transfer, the Payment account identifier (BT-84) shall be "
                "present." % pm.code_norm,
                "cac:PaymentMeans/cac:PayeeFinancialAccount/cbc:ID")
    return None


def br_62(inv):
    """BR-62: The Seller electronic address (BT-34) shall have a Scheme
    identifier.

    Official (context ``cac:AccountingSupplierParty/cac:Party/cbc:EndpointID``)::

        exists(@schemeID)

    Attribute EXISTENCE per Seller EndpointID (an empty ``schemeID=""``
    satisfies it).
    """
    for has_scheme in inv.seller_endpoints:
        if not has_scheme:
            return Violation(
                "BR-62",
                "The Seller electronic address (BT-34) shall have a Scheme "
                "identifier.",
                "cac:AccountingSupplierParty/cac:Party/cbc:EndpointID/@schemeID")
    return None


def br_63(inv):
    """BR-63: The Buyer electronic address (BT-49) shall have a Scheme
    identifier.

    Official (context ``cac:AccountingCustomerParty/cac:Party/cbc:EndpointID``)::

        exists(@schemeID)
    """
    for has_scheme in inv.buyer_endpoints:
        if not has_scheme:
            return Violation(
                "BR-63",
                "The Buyer electronic address (BT-49) shall have a Scheme "
                "identifier.",
                "cac:AccountingCustomerParty/cac:Party/cbc:EndpointID/@schemeID")
    return None


# --------------------------------------------------------------------------- #
# Supporting-document / item-metadata / VAT-point batch                        #
# (BR-23, BR-52, BR-53, BR-54, BR-56, BR-64, BR-65, BR-CO-03/-09/-19)          #
# --------------------------------------------------------------------------- #

# BR-CO-09: both official artifacts embed the allowed VAT-identifier prefixes
# as ONE literal space-separated string (ISO 3166-1 alpha-2 plus the documented
# non-ISO entries '1A' Kosovo, 'EL' Greece and 'XI' Northern Ireland). The two
# bindings pin DIFFERENT snapshots of that list: the UBL string carries 'SS'
# (South Sudan) and orders '... BJ BL ...'; the CII string instead carries the
# withdrawn 'AN' (Netherlands Antilles), lacks 'SS', and orders '... BL BJ ...'.
# Each constant below is copied VERBATIM from its artifact (including the
# leading/trailing space the contains() idiom relies on), and br_co_09
# reproduces each binding's exact predicate rather than a cleaned-up union.
_BR_CO_09_UBL_LIST = (
    " 1A AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE "
    "BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF "
    "CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ "
    "EC EE EG EH EL ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH "
    "GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL "
    "IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY "
    "KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML "
    "MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL "
    "NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA "
    "RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS "
    "ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ "
    "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XI YE YT ZA ZM ZW ")
_BR_CO_09_CII_LIST = (
    " 1A AD AE AF AG AI AL AM AN AO AQ AR AS AT AU AW AX AZ BA BB BD "
    "BE BF BG BH BI BL BJ BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD "
    "CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO "
    "DZ EC EE EG EH EL ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG "
    "GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE "
    "IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW "
    "KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK "
    "ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI "
    "NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY "
    "QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR "
    "ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ "
    "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XI YE YT ZA ZM ZW ")


def br_23(inv):
    """BR-23: An Invoice line (BG-25) shall have an Invoiced quantity unit of
    measure code (BT-130).

    Official (context = each Invoice line)::

        UBL: exists(cbc:InvoicedQuantity/@unitCode)
             or exists(cbc:CreditedQuantity/@unitCode)
        CII: (ram:SpecifiedLineTradeDelivery/ram:BilledQuantity/@unitCode)

    Both are attribute EXISTENCE — an empty ``unitCode=""`` satisfies the rule,
    only a missing attribute (or, in CII, a missing BilledQuantity altogether)
    fires it. Each parser bakes its binding's check into
    ``ln.has_quantity_unit_code``.
    """
    for ln in inv.lines:
        if not ln.has_quantity_unit_code:
            return Violation(
                "BR-23",
                "An Invoice line (BG-25) shall have an Invoiced quantity unit "
                "of measure code (BT-130).",
                ln.label + "/cbc:InvoicedQuantity/@unitCode")
    return None


def br_52(inv):
    """BR-52: Each Additional supporting document (BG-24) shall contain a
    Supporting document reference (BT-122).

    Official (context = each supporting-document group, any depth)::

        UBL (cac:AdditionalDocumentReference):   normalize-space(cbc:ID) != ''
        CII (//ram:AdditionalReferencedDocument):
                                    normalize-space(ram:IssuerAssignedID) != ''

    NOT pure existence: an absent, empty or whitespace-only reference all
    normalize-space to ``''`` and fire. The parsers store the normalized value
    of each group's first reference child ('' when absent).
    """
    for ref in inv.supporting_doc_refs:
        if not ref:
            return Violation(
                "BR-52",
                "Each Additional supporting document (BG-24) shall contain a "
                "Supporting document reference (BT-122).",
                "cac:AdditionalDocumentReference/cbc:ID")
    return None


def br_53(inv):
    """BR-53: If the VAT accounting currency code (BT-6) is present, then the
    Invoice total VAT amount in accounting currency (BT-111) shall be provided.

    The two bindings encode the same business rule with genuinely different
    predicates, so the body branches on syntax:

    UBL (context = the document root)::

        every $taxcurrency in cbc:TaxCurrencyCode satisfies
            exists(//cac:TaxTotal/cbc:TaxAmount[@currencyID = $taxcurrency])

    — each BT-6 value must be matched by SOME TaxAmount's @currencyID; the
    @currencyID = $taxcurrency comparison atomizes both sides RAW (no
    normalize-space), hence ``tax_currency_codes_raw``. No BT-6 present =>
    the ``every`` quantifier is vacuously true.

    CII (context = //ram:SpecifiedTradeSettlementHeaderMonetarySummation, with
    ABSOLUTE paths for BT-6/BT-5)::

        not(TCC) or (TCC and (ram:TaxTotalAmount/@currencyID = TCC)
                         and not(TCC = ICC))

    where TCC/ICC are the settlement's ram:TaxCurrencyCode /
    ram:InvoiceCurrencyCode. With BT-6 present the context summation must carry
    a TaxTotalAmount whose @currencyID general-equals some TCC AND no TCC may
    equal any ICC (the CII binding additionally rejects BT-6 == BT-5). With no
    header summation the CII rule has no context node and cannot fire.
    """
    if not inv.tax_currency_codes_raw:
        return None
    if inv.syntax == "cii":
        for currencies in inv.cii_summation_taxtotal_currencies:
            matched = any(c in inv.tax_currency_codes_raw for c in currencies)
            tcc_is_icc = any(t in inv.cii_invoice_currency_codes_raw
                             for t in inv.tax_currency_codes_raw)
            if not matched or tcc_is_icc:
                return Violation(
                    "BR-53",
                    "If the VAT accounting currency code (BT-6) is present, "
                    "then the Invoice total VAT amount in accounting currency "
                    "(BT-111) shall be provided.",
                    "ram:SpecifiedTradeSettlementHeaderMonetarySummation/"
                    "ram:TaxTotalAmount/@currencyID")
        return None
    for tcc in inv.tax_currency_codes_raw:
        if tcc not in inv.taxtotal_amount_currencies:
            return Violation(
                "BR-53",
                "If the VAT accounting currency code (BT-6) is present, then "
                "the Invoice total VAT amount in accounting currency (BT-111) "
                "shall be provided.",
                "cac:TaxTotal/cbc:TaxAmount/@currencyID")
    return None


def br_54(inv):
    """BR-54: Each Item attribute (BG-32) shall contain an Item attribute name
    (BT-160) and an Item attribute value (BT-161).

    Official (context = each item-attribute group, any depth)::

        UBL (//cac:AdditionalItemProperty):  exists(cbc:Name) and
                                             exists(cbc:Value)
        CII (//ram:ApplicableProductCharacteristic):
                                             (ram:Description) and (ram:Value)

    Pure child-element EXISTENCE on both bindings (present-but-empty children
    satisfy it). The parsers store one (has_name, has_value) pair per group.
    """
    for has_name, has_value in inv.item_attributes:
        if not (has_name and has_value):
            return Violation(
                "BR-54",
                "Each Item attribute (BG-32) shall contain an Item attribute "
                "name (BT-160) and an Item attribute value (BT-161).",
                "cac:AdditionalItemProperty")
    return None


def br_56(inv):
    """BR-56: Each Seller tax representative party (BG-11) shall have a Seller
    tax representative VAT identifier (BT-63).

    Official (context = each tax-representative party)::

        UBL (cac:TaxRepresentativeParty):
            exists(cac:PartyTaxScheme[cac:TaxScheme/
                   (normalize-space(upper-case(cbc:ID)) = 'VAT')]/cbc:CompanyID)
        CII (//ram:SellerTaxRepresentativeTradeParty):
            normalize-space(ram:SpecifiedTaxRegistration/
                            ram:ID[@schemeID='VA']) != ''

    The bindings genuinely differ (UBL is pure existence — an EMPTY CompanyID
    satisfies it; CII requires a non-empty VA-scheme id), so each parser bakes
    ITS binding's verdict into one bool per representative party
    (``taxrep_vat_ids_ok``) and the shared body just scans them.
    """
    for ok in inv.taxrep_vat_ids_ok:
        if not ok:
            return Violation(
                "BR-56",
                "Each Seller tax representative party (BG-11) shall have a "
                "Seller tax representative VAT identifier (BT-63).",
                "cac:TaxRepresentativeParty/cac:PartyTaxScheme/cbc:CompanyID")
    return None


def br_64(inv):
    """BR-64: The Item standard identifier (BT-157) shall have a Scheme
    identifier.

    Official::

        UBL (context = each line's cac:StandardItemIdentification/cbc:ID):
            exists(@schemeID)                  -- empty schemeID="" satisfies
        CII (context = //ram:IncludedSupplyChainTradeLineItem):
            normalize-space(ram:SpecifiedTradeProduct/ram:GlobalID/@schemeID)
                != ''  or  not(ram:SpecifiedTradeProduct/ram:GlobalID)

    Each parser stores one bool per context node that CARRIES a standard
    identifier, already evaluated under its binding's semantics (UBL attribute
    existence; CII non-empty-after-normalize-space of the first GlobalID's
    scheme, lines without a GlobalID contributing nothing).
    """
    for ok in inv.item_std_ids_scheme_ok:
        if not ok:
            return Violation(
                "BR-64",
                "The Item standard identifier (BT-157) shall have a Scheme "
                "identifier.",
                "cac:StandardItemIdentification/cbc:ID/@schemeID")
    return None


def br_65(inv):
    """BR-65: The Item classification identifier (BT-158) shall have a Scheme
    identifier.

    Official::

        UBL (context = each line's cac:CommodityClassification/
             cbc:ItemClassificationCode):
            exists(@listID)                    -- empty listID="" satisfies
        CII (context = //ram:DesignatedProductClassification):
            normalize-space(ram:ClassCode/@listID) != ''
                or not(ram:ClassCode)

    Same shape as BR-64: one pre-evaluated bool per identifier-carrying context
    node, each under its own binding's semantics.
    """
    for ok in inv.item_class_ids_scheme_ok:
        if not ok:
            return Violation(
                "BR-65",
                "The Item classification identifier (BT-158) shall have a "
                "Scheme identifier.",
                "cac:CommodityClassification/cbc:ItemClassificationCode"
                "/@listID")
    return None


def br_co_03(inv):
    """BR-CO-03: Value added tax point date (BT-7) and Value added tax point
    date code (BT-8) are mutually exclusive.

    Official — both bindings' three-disjunct tests reduce to
    ``not(BT-7 present and BT-8 present)``::

        UBL (context = the document root):
            BT-7 = cbc:TaxPointDate, BT-8 = cac:InvoicePeriod/cbc:DescriptionCode
        CII (context = //ram:ApplicableHeaderTradeSettlement/
             ram:ApplicableTradeTax):
            BT-7 = //ram:TaxPointDate, BT-8 = //ram:DueDateTypeCode (GLOBAL
            existence, asserted once per document-level VAT-breakdown row)

    The CII context detail matters: a CII invoice with NO document-level
    ApplicableTradeTax rows carries no BR-CO-03 assert at all, so the official
    artifact stays silent there even when both BT-7 and BT-8 are present —
    the CII branch gates on ``all_tax_subtotals`` (exactly those rows) to
    match. UBL asserts at the always-present document root.
    """
    if not (inv.has_tax_point_date and inv.has_tax_point_date_code):
        return None
    if inv.syntax == "cii" and not inv.all_tax_subtotals:
        return None
    return Violation(
        "BR-CO-03",
        "Value added tax point date (BT-7) and Value added tax point date "
        "code (BT-8) are mutually exclusive.",
        "cbc:TaxPointDate")


def br_co_09(inv):
    """BR-CO-09: The Seller VAT identifier (BT-31), the Seller tax
    representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48)
    shall have a prefix in accordance with ISO code ISO 3166-1 alpha-2 by which
    the country of issue may be identified. Nevertheless, Greece may use the
    prefix 'EL'.

    Official (the tested value is the RAW first two characters of the VAT
    identifier — ``substring(..., 1, 2)`` — against the artifact's literal
    prefix list; see the two verbatim list constants above)::

        UBL (context = //cac:PartyTaxScheme[cac:TaxScheme/
             normalize-space(upper-case(cbc:ID))='VAT']):
            contains(' 1A AD ... ZW ', substring(cbc:CompanyID, 1, 2))
        CII (context = //ram:SpecifiedTaxRegistration/ram:ID[@schemeID='VA']):
            contains(' 1A AD ... ZW ', concat(' ', substring(., 1, 2), ' '))

    The idioms differ materially and are reproduced exactly:

      * UBL searches the prefix UNWRAPPED, so any 2-character substring of the
        list matches — including cross-token windows like ``'D '`` or ``' A'``
        — and a CompanyID shorter than 2 characters (or absent: substring of
        the empty sequence is ``''``) ALWAYS satisfies the rule.
      * CII wraps the prefix in spaces, so only whole listed tokens match and
        a short or empty identifier always FIRES.
    """
    if inv.syntax == "cii":
        for prefix in inv.vat_id_prefixes:
            if (" " + prefix + " ") not in _BR_CO_09_CII_LIST:
                return Violation(
                    "BR-CO-09",
                    "The Seller VAT identifier (BT-31), the Seller tax "
                    "representative VAT identifier (BT-63) and the Buyer VAT "
                    "identifier (BT-48) shall have a prefix in accordance "
                    "with ISO code ISO 3166-1 alpha-2 by which the country "
                    "of issue may be identified. Nevertheless, Greece may "
                    "use the prefix 'EL'.",
                    "ram:SpecifiedTaxRegistration/ram:ID")
        return None
    for prefix in inv.vat_id_prefixes:
        if prefix not in _BR_CO_09_UBL_LIST:
            return Violation(
                "BR-CO-09",
                "The Seller VAT identifier (BT-31), the Seller tax "
                "representative VAT identifier (BT-63) and the Buyer VAT "
                "identifier (BT-48) shall have a prefix in accordance with "
                "ISO code ISO 3166-1 alpha-2 by which the country of issue "
                "may be identified. Nevertheless, Greece may use the prefix "
                "'EL'.",
                "cac:PartyTaxScheme/cbc:CompanyID")
    return None


def br_co_19(inv):
    """BR-CO-19: If Invoicing period (BG-14) is used, the Invoicing period
    start date (BT-73) or the Invoicing period end date (BT-74) shall be
    filled, or both.

    Official (context = each document-level Invoicing period)::

        UBL (cac:InvoicePeriod, the non-line BR-29 context set):
            exists(cbc:StartDate) or exists(cbc:EndDate)
            or (exists(cbc:DescriptionCode)
                and not(exists(cbc:StartDate)) and not(exists(cbc:EndDate)))
            -- logically: any of StartDate / EndDate / DescriptionCode exists
        CII (//ram:ApplicableHeaderTradeSettlement/ram:BillingSpecifiedPeriod):
            (ram:StartDateTime) or (ram:EndDateTime)
            -- CII has no period DescriptionCode child; start/end only

    Each parser stores one already-evaluated bool per context period
    (``invoice_period_filled``) under its own binding's disjuncts.
    """
    for filled in inv.invoice_period_filled:
        if not filled:
            return Violation(
                "BR-CO-19",
                "If Invoicing period (BG-14) is used, the Invoicing period "
                "start date (BT-73) or the Invoicing period end date (BT-74) "
                "shall be filled, or both.",
                "cac:InvoicePeriod")
    return None


# --------------------------------------------------------------------------- #
# Core/decimals/VAT gap batch A                                                 #
# (BR-CO-20/-21/-22/-23/-24/-26, BR-DEC-24/-25/-27/-28, BR-IC-10, BR-S-08)      #
# --------------------------------------------------------------------------- #
def br_co_20(inv):
    """BR-CO-20: If Invoice line period (BG-26) is used, the Invoice line
    period start date (BT-134) or the Invoice line period end date (BT-135)
    shall be filled, or both.

    Official (context = each Invoice line period)::

        UBL (cac:InvoiceLine/cac:InvoicePeriod):
            exists(cbc:StartDate) or exists(cbc:EndDate)
        CII (//ram:SpecifiedLineTradeSettlement/ram:BillingSpecifiedPeriod):
            (ram:StartDateTime) or (ram:EndDateTime)

    Pure child-element EXISTENCE on both bindings (a present-but-empty date
    element satisfies it — the value's validity is BR-30's business, not this
    rule's). Each parser stores one already-evaluated bool per line-period
    context node (``line_period_filled``), mirroring BR-CO-19's document-level
    ``invoice_period_filled``.
    """
    for filled in inv.line_period_filled:
        if not filled:
            return Violation(
                "BR-CO-20",
                "If Invoice line period (BG-26) is used, the Invoice line "
                "period start date (BT-134) or the Invoice line period end "
                "date (BT-135) shall be filled, or both.",
                "cac:InvoiceLine/cac:InvoicePeriod")
    return None


def br_co_21(inv):
    """BR-CO-21: Each Document level allowance (BG-20) shall contain a
    Document level allowance reason (BT-97) or a Document level allowance
    reason code (BT-98), or both.

    Official (context = each DOCUMENT-level allowance)::

        UBL (/ubl:Invoice/cac:AllowanceCharge[cbc:ChargeIndicator = false()]):
            exists(cbc:AllowanceChargeReason)
            or exists(cbc:AllowanceChargeReasonCode)
        CII (//ram:ApplicableHeaderTradeSettlement/
             ram:SpecifiedTradeAllowanceCharge/
             ram:ChargeIndicator[udt:Indicator='false']):
            (../ram:Reason) or (../ram:ReasonCode)

    Same ``exists(reason) or exists(reason code)`` fact BR-33 tests (the
    official artifact carries BOTH ids for this constraint); the parsers bake
    it into ``ac.has_reason``. A group whose ChargeIndicator matches neither
    boolean context (``is_charge is None``) fires neither binding.
    """
    for ac in inv.doc_allowance_charges:
        if ac.is_charge is False and not ac.has_reason:
            return Violation(
                "BR-CO-21",
                "Each Document level allowance (BG-20) shall contain a "
                "Document level allowance reason (BT-97) or a Document level "
                "allowance reason code (BT-98), or both.",
                "cac:AllowanceCharge/cbc:AllowanceChargeReason")
    return None


def br_co_22(inv):
    """BR-CO-22: Each Document level charge (BG-21) shall contain a Document
    level charge reason (BT-104) or a Document level charge reason code
    (BT-105), or both.

    Official: the charge twin of BR-CO-21 — same contexts split on
    ``ChargeIndicator = true()`` / ``udt:Indicator='true'``, same
    ``exists(reason) or exists(reason code)`` test (duplicated by BR-38).
    """
    for ac in inv.doc_allowance_charges:
        if ac.is_charge is True and not ac.has_reason:
            return Violation(
                "BR-CO-22",
                "Each Document level charge (BG-21) shall contain a Document "
                "level charge reason (BT-104) or a Document level charge "
                "reason code (BT-105), or both.",
                "cac:AllowanceCharge/cbc:AllowanceChargeReason")
    return None


def br_co_23(inv):
    """BR-CO-23: Each Invoice line allowance (BG-27) shall contain an Invoice
    line allowance reason (BT-139) or an Invoice line allowance reason code
    (BT-140), or both.

    Official (context = each LINE-level allowance)::

        UBL (//cac:InvoiceLine/cac:AllowanceCharge[cbc:ChargeIndicator=false()]):
            exists(cbc:AllowanceChargeReason)
            or exists(cbc:AllowanceChargeReasonCode)
        CII (//ram:SpecifiedLineTradeSettlement/ram:SpecifiedTradeAllowanceCharge/
             ram:ChargeIndicator[udt:Indicator = 'false']):
            (../ram:Reason) or (../ram:ReasonCode)

    The line twin of BR-CO-21 (and the same fact BR-42 tests).
    """
    for ln in inv.lines:
        for ac in ln.allowance_charges:
            if ac.is_charge is False and not ac.has_reason:
                return Violation(
                    "BR-CO-23",
                    "Each Invoice line allowance (BG-27) shall contain an "
                    "Invoice line allowance reason (BT-139) or an Invoice "
                    "line allowance reason code (BT-140), or both.",
                    ln.label + "/cac:AllowanceCharge/cbc:AllowanceChargeReason")
    return None


def br_co_24(inv):
    """BR-CO-24: Each Invoice line charge (BG-28) shall contain an Invoice
    line charge reason (BT-144) or an Invoice line charge reason code
    (BT-145), or both.

    Official: the charge twin of BR-CO-23 — same line-level contexts split on
    the true() / 'true' ChargeIndicator (and the same fact BR-44 tests).
    """
    for ln in inv.lines:
        for ac in ln.allowance_charges:
            if ac.is_charge is True and not ac.has_reason:
                return Violation(
                    "BR-CO-24",
                    "Each Invoice line charge (BG-28) shall contain an "
                    "Invoice line charge reason (BT-144) or an Invoice line "
                    "charge reason code (BT-145), or both.",
                    ln.label + "/cac:AllowanceCharge/cbc:AllowanceChargeReason")
    return None


def br_co_26(inv):
    """BR-CO-26: In order for the buyer to automatically identify a supplier,
    the Seller identifier (BT-29), the Seller legal registration identifier
    (BT-30) and/or the Seller VAT identifier (BT-31) shall be present.

    Official (context = each Seller party group)::

        UBL (cac:AccountingSupplierParty):
            exists(cac:Party/cac:PartyTaxScheme[cac:TaxScheme/
                   normalize-space(upper-case(cbc:ID))='VAT']/cbc:CompanyID)
            or exists(cac:Party/cac:PartyIdentification/
                      cbc:ID[not(@schemeID = 'SEPA')])
            or exists(cac:Party/cac:PartyLegalEntity/cbc:CompanyID)
        CII (//ram:SellerTradeParty):
            (ram:ID) or (ram:GlobalID)
            or (ram:SpecifiedLegalOrganization/ram:ID)
            or (ram:SpecifiedTaxRegistration/ram:ID[@schemeID='VA'])

    The bindings accept genuinely different identifier sets (UBL admits ANY
    non-SEPA PartyIdentification/ID — an ID with no @schemeID at all counts,
    since ``not(() = 'SEPA')`` is true; CII admits ram:ID / ram:GlobalID and
    requires the RAW @schemeID='VA' on the tax registration), so each parser
    bakes ITS binding's verdict into one bool per Seller context node
    (``seller_identification_ok``).
    """
    for ok in inv.seller_identification_ok:
        if not ok:
            return Violation(
                "BR-CO-26",
                "In order for the buyer to automatically identify a supplier, "
                "the Seller identifier (BT-29), the Seller legal registration "
                "identifier (BT-30) and/or the Seller VAT identifier (BT-31) "
                "shall be present.",
                "cac:AccountingSupplierParty/cac:Party/"
                "cac:PartyIdentification/cbc:ID")
    return None


def br_dec_24(inv):
    """BR-DEC-24: max 2 decimals for the Invoice line allowance amount (BT-136).

    Official (context = each LINE-level allowance, the BR-CO-23 context set)::

        UBL: string-length(substring-after(cbc:Amount,'.')) <= 2
        CII: string-length(substring-after(../ram:ActualAmount[1],'.')) <= 2

    Counted over the RAW text after the first '.' (whitespace included), like
    every BR-DEC rule; an absent amount yields '' and holds.
    """
    for ln in inv.lines:
        for ac in ln.allowance_charges:
            if ac.is_charge is False and _dec_places(ac.amount_raw) > 2:
                return _dec_violation(
                    "BR-DEC-24", "BT-136",
                    "the Invoice line allowance amount",
                    ln.label + "/cac:AllowanceCharge/cbc:Amount")
    return None


def br_dec_25(inv):
    """BR-DEC-25: max 2 decimals for the Invoice line allowance base amount
    (BT-137). Same line-level allowance context as BR-DEC-24, over
    ``cbc:BaseAmount`` (UBL) / ``../ram:BasisAmount`` (CII)."""
    for ln in inv.lines:
        for ac in ln.allowance_charges:
            if ac.is_charge is False and _dec_places(ac.base_amount_raw) > 2:
                return _dec_violation(
                    "BR-DEC-25", "BT-137",
                    "the Invoice line allowance base amount",
                    ln.label + "/cac:AllowanceCharge/cbc:BaseAmount")
    return None


def br_dec_27(inv):
    """BR-DEC-27: max 2 decimals for the Invoice line charge amount (BT-141).
    The charge twin of BR-DEC-24 (ChargeIndicator true() / 'true')."""
    for ln in inv.lines:
        for ac in ln.allowance_charges:
            if ac.is_charge is True and _dec_places(ac.amount_raw) > 2:
                return _dec_violation(
                    "BR-DEC-27", "BT-141",
                    "the Invoice line charge amount",
                    ln.label + "/cac:AllowanceCharge/cbc:Amount")
    return None


def br_dec_28(inv):
    """BR-DEC-28: max 2 decimals for the Invoice line charge base amount
    (BT-142). The charge twin of BR-DEC-25."""
    for ln in inv.lines:
        for ac in ln.allowance_charges:
            if ac.is_charge is True and _dec_places(ac.base_amount_raw) > 2:
                return _dec_violation(
                    "BR-DEC-28", "BT-142",
                    "the Invoice line charge base amount",
                    ln.label + "/cac:AllowanceCharge/cbc:BaseAmount")
    return None


def br_ic_10(inv):
    """BR-IC-10: a VAT breakdown (BG-23) with the VAT category code (BT-118)
    "Intra-community supply" (K) SHALL have a VAT exemption reason code
    (BT-121) or text (BT-120) — the K twin of BR-E-10 / BR-AE-10.

    Official (context = each K VAT-breakdown category)::

        UBL (/*/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
             [normalize-space(cbc:ID) = 'K'][VAT]):
            exists(cbc:TaxExemptionReason) or (exists(cbc:TaxExemptionReasonCode))
        CII (//rsm:SupplyChainTradeTransaction/ram:ApplicableHeaderTradeSettlement/
             ram:ApplicableTradeTax/ram:CategoryCode[.= 'K']
             [upper-case(../ram:TypeCode) = 'VAT']):
            (../ram:ExemptionReason) or (../ram:ExemptionReasonCode)

    Both contexts are exactly the top-level VAT-breakdown rows the model's
    ``tax_totals`` carry (CII's header ApplicableTradeTax rows ARE that set).
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if (st.category_id == "K" and st.category_scheme_id == "VAT"
                    and not (st.has_exemption_reason
                             or st.has_exemption_reason_code)):
                return Violation(
                    "BR-IC-10",
                    "A VAT breakdown (BG-23) with the VAT Category code "
                    "(BT-118) 'Intra-community supply' shall have a VAT "
                    "exemption reason code (BT-121) or a VAT exemption "
                    "reason text (BT-120).",
                    "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/"
                    "cbc:TaxExemptionReason")
    return None


def br_s_08(inv):
    """BR-S-08: for each different value of VAT category rate (BT-119) where
    the VAT category code (BT-118) is "Standard rated", the VAT category
    taxable amount (BT-116) shall equal the sum of Invoice line net amounts
    (BT-131) plus document level charge amounts (BT-99) minus document level
    allowance amounts (BT-92) where the VAT category code is "Standard rated"
    and the VAT rate equals BT-119.

    The two bindings encode this per-rate bucket sum with genuinely different
    predicates, so the body branches on syntax.

    UBL (context ``/*/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)='S'][VAT]``)::

        every $rate in xs:decimal(cbc:Percent) satisfies
          ( (exists(//cac:InvoiceLine[... 'S'][... = $rate])
               or exists(//cac:AllowanceCharge[cac:TaxCategory/... 'S']
                         [cac:TaxCategory/xs:decimal(cbc:Percent) = $rate]))
            and abs-free ±1 band:
                ../xs:decimal(cbc:TaxableAmount - 1) < SUM_IL
                and ../xs:decimal(cbc:TaxableAmount + 1) > SUM_IL )
          or ( (exists(//cac:CreditNoteLine[...]) or exists(//cac:AllowanceCharge[...]))
               and the same band against SUM_CNL )

    where ``SUM_IL`` = Σ document lines' LineExtensionAmount + Σ document-level
    charges − Σ document-level allowances, each restricted by TWO INDEPENDENT
    predicates over the group's categories — ``normalize-space(id)='S'`` and
    ``xs:decimal(Percent)=$rate`` — that are SCHEME-AGNOSTIC (no TaxScheme
    test, unlike this rule's own context). Details the official XPath pins:

    * an ABSENT Percent makes ``every $rate in ()`` vacuously true (holds);
    * the exists() disjunct scans //cac:AllowanceCharge at ANY depth (line
      allowances included, no ChargeIndicator test), while the SUMS scan only
      the document-level siblings split by ``ChargeIndicator = true()/false()``;
    * on an Invoice document the CreditNote branch's line sum is empty, so it
      reduces to "an S/$rate AllowanceCharge exists somewhere AND the band
      holds against charges − allowances alone";
    * a missing/unparseable BT-116 empties the band comparison -> fires;
    * the official band arithmetic routes through xs:double (untyped − 1)
      before the xs:decimal cast; computed here in exact Decimal, which is
      indistinguishable off the representational edge of the strict ±1 band.

    CII (context ``//ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax/
    ram:CategoryCode[.='S']`` — note: NO TypeCode/VAT predicate)::

        every $rate in ../ram:RateApplicablePercent/xs:decimal(.) satisfies
          ../ram:BasisAmount =
              round2(Σ S/$rate line LineTotalAmount)
            + round2(Σ S/$rate header charges'   ActualAmount[1])
            - round2(Σ S/$rate header allowances' ActualAmount[1])

    EXACT equality against the PER-BUCKET fn:round 2-place sums (round2 =
    ``round(x*10*10) div 100``, the ``_xr2`` idiom) — no tolerance band; a
    missing BT-116 compares false and fires. The line/allowance predicates
    are conjunctions over the group's ApplicableTradeTax / CategoryTradeTax
    rows (CategoryCode='S' and xs:decimal(RateApplicablePercent)=$rate); the
    charge/allowance split is the boolean ``ChargeIndicator/udt:Indicator``.
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if inv.syntax == "cii":
                if st.category_id != "S":
                    continue
            elif not (st.category_id == "S"
                      and st.category_scheme_id == "VAT"):
                continue
            rate = _dec(st.percent)
            if rate is None:
                continue  # every $rate in () — vacuously true
            line_exists = False
            line_sum = Decimal("0")
            for ln in inv.lines:
                cats = ln.item_tax_categories
                if (any(cat.id == "S" for cat in cats)
                        and any(_dec(cat.percent) == rate for cat in cats)):
                    line_exists = True
                    v = _dec(ln.line_extension_amount)
                    if v is not None:
                        line_sum += v
            charge_sum = Decimal("0")
            allowance_sum = Decimal("0")
            for ac in inv.doc_allowance_charges:
                if ac.is_charge is None:
                    continue
                cats = ac.tax_categories
                if not (any(cat.id == "S" for cat in cats)
                        and any(_dec(cat.percent) == rate for cat in cats)):
                    continue
                v = _dec(ac.amount_raw)
                if v is None:
                    continue
                if ac.is_charge:
                    charge_sum += v
                else:
                    allowance_sum += v
            taxable = _dec(st.taxable_amount)
            if inv.syntax == "cii":
                expected = (_xr2(line_sum) + _xr2(charge_sum)
                            - _xr2(allowance_sum))
                if taxable is not None and taxable == expected:
                    continue
            else:
                ac_exists = any(
                    (any(cat.id == "S" for cat in ac.tax_categories)
                     and any(_dec(cat.percent) == rate
                             for cat in ac.tax_categories))
                    for ac in inv.all_allowance_charges())

                def _band(expected):
                    return (taxable is not None
                            and taxable - 1 < expected
                            and taxable + 1 > expected)

                if (((line_exists or ac_exists)
                     and _band(line_sum + charge_sum - allowance_sum))
                        or (ac_exists and _band(charge_sum - allowance_sum))):
                    continue
            return Violation(
                "BR-S-08",
                "For each different value of VAT category rate (BT-119=%s) "
                "where the VAT category code (BT-118) is 'Standard rated', "
                "the VAT category taxable amount (BT-116=%s) in a VAT "
                "breakdown (BG-23) shall equal the sum of Invoice line net "
                "amounts plus document level charges minus document level "
                "allowances at that Standard rate."
                % (st.percent, st.taxable_amount or "(absent)"),
                "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount")
    return None


# Ordered ruleset (evaluation order = document flow: header -> lines -> codes
# -> arithmetic -> VAT-category consistency -> decimal precision).
ALL_RULES = [
    br_01, br_02, br_03, br_04, br_05, br_06, br_07, br_08,
    br_09, br_10, br_11,
    br_12, br_13, br_14, br_15,
    br_16, br_17, br_18, br_19, br_20,
    br_21, br_22, br_23, br_24, br_25, br_26, br_27, br_28, br_29, br_30,
    br_31, br_32, br_33, br_36, br_37, br_38,
    br_41, br_42, br_43, br_44,
    br_49, br_50, br_51, br_52, br_53, br_54, br_55, br_56, br_57,
    br_61, br_62, br_63, br_64, br_65,
    br_cl_01,
    br_cl_03, br_cl_04, br_cl_05, br_cl_13, br_cl_14,
    br_cl_16,
    br_cl_17, br_cl_18, br_cl_19, br_cl_20, br_cl_21, br_cl_22, br_cl_23,
    br_cl_24,
    br_co_03, br_co_04,
    br_co_09, br_co_10, br_co_11, br_co_12, br_co_13, br_co_14, br_co_15,
    br_co_16, br_co_17, br_co_18, br_co_19,
    br_co_20, br_co_21, br_co_22, br_co_23, br_co_24, br_co_26,
    br_45, br_46, br_47, br_48,
    br_s_01, br_z_01,
    br_s_02, br_s_03, br_s_04, br_s_05, br_s_06, br_s_07, br_s_08,
    br_s_09, br_s_10,
    br_z_02, br_z_03, br_z_04, br_z_05, br_z_06, br_z_07,
    br_z_08, br_z_09, br_z_10,
    br_e_02, br_e_03, br_e_04, br_e_05, br_e_06, br_e_07,
    br_e_08, br_e_09, br_e_10,
    br_ae_02, br_ae_03, br_ae_04, br_ae_05, br_ae_06, br_ae_07,
    br_ae_08, br_ae_09, br_ae_10,
    br_ic_02, br_ic_03, br_ic_04, br_ic_05, br_ic_06, br_ic_07,
    br_ic_08, br_ic_09, br_ic_10, br_ic_11, br_ic_12,
    br_g_02, br_g_03, br_g_04, br_g_05, br_g_06, br_g_07,
    br_g_08, br_g_09, br_g_10,
    br_o_02, br_o_03, br_o_04, br_o_05, br_o_06, br_o_07,
    br_o_08, br_o_09, br_o_10, br_o_11, br_o_12, br_o_13, br_o_14,
    br_af_01, br_af_02, br_af_03, br_af_04, br_af_05, br_af_06,
    br_af_07, br_af_08, br_af_09, br_af_10,
    br_ag_01, br_ag_02, br_ag_03, br_ag_04, br_ag_05, br_ag_06,
    br_ag_07, br_ag_08, br_ag_09, br_ag_10,
    br_b_01, br_b_02,
    br_ae_01, br_e_01, br_g_01, br_ic_01, br_o_01,
    br_dec_01, br_dec_02, br_dec_05, br_dec_06,
    br_dec_09, br_dec_10, br_dec_11, br_dec_12, br_dec_14,
    br_dec_16, br_dec_17, br_dec_18, br_dec_19, br_dec_20, br_dec_23,
    br_dec_24, br_dec_25, br_dec_27, br_dec_28,
]
