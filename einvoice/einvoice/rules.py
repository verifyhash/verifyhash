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

    The rule's context node is the Seller PostalAddress itself, so it is only
    evaluated when that address is PRESENT (an absent address is BR-08's job,
    not this rule's). Given a present address, the country code must
    normalize-space to a non-empty string — an absent, empty or whitespace-only
    ``Country/IdentificationCode`` fires the assert.
    """
    if inv.seller_has_postal_address and not inv.seller_country_code:
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

    Symmetric to BR-09 for the Buyer: only evaluated when the Buyer postal
    address is present (absence is BR-10's job); given a present address, the
    country code must normalize-space to a non-empty string.
    """
    if inv.buyer_has_postal_address and not inv.buyer_country_code:
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
    """
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
    """
    cur = inv.document_currency_code
    if not cur:
        return None  # every $Currency in () satisfies ... -> vacuously true

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

    The official rule (context ``/ubl:Invoice``) is BIDIRECTIONAL — it holds iff::

        (items-have-S AND breakdown-has-S) OR (no-items-have-S AND breakdown-has-no-S)

    where "items-have-S" counts any Invoice line, Document level allowance or
    Document level charge whose VAT category code (BT-151/BT-95/BT-102) is 'S',
    and "breakdown-has-S" counts a VAT breakdown category (BT-118) of 'S'. So the
    assert fires whenever exactly ONE side carries 'S' — not only the
    "S item, no S breakdown" direction, but also an orphan 'S' breakdown with no
    corresponding 'S' line/allowance/charge (the misses the differential found).
    """
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
    must contain exactly one Zero rated category."""
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


def _breakdown_taxable_sum_mismatch(inv, code):
    """The BR-Z/E-08 shape (context ``/*/cac:TaxTotal/cac:TaxSubtotal/
    cac:TaxCategory[normalize-space(cbc:ID)=code][VAT]`` — TOP-LEVEL TaxTotals
    only). For an Invoice document the official test reduces to::

        exists(//cac:InvoiceLine) and
        xs:decimal(../cbc:TaxableAmount)
          = sum(/Invoice/cac:InvoiceLine[cac:Item/cac:ClassifiedTaxCategory/
                  normalize-space(cbc:ID)=code]/xs:decimal(cbc:LineExtensionAmount))
            + sum(charges with cac:TaxCategory[normalize-space(cbc:ID)=code])
            - sum(allowances with cac:TaxCategory[normalize-space(cbc:ID)=code])

    Three details the official XPath pins down:

    * the line/allowance/charge predicates are SCHEME-AGNOSTIC (no TaxScheme
      test — unlike this rule's own context);
    * the equality is EXACT xs:decimal equality — no rounding, no tolerance
      band (unlike BR-S-08/09);
    * with no ``cac:InvoiceLine`` in the document neither disjunct can hold,
      so the assert FIRES; a missing BT-116 casts to the empty sequence and
      fires too. Lines/allowances missing their amount contribute nothing.

    Returns ``(subtotal, expected_sum)`` for the first offending breakdown,
    or None when the rule holds.
    """
    for tt in inv.tax_totals:
        for st in tt.subtotals:
            if not (st.category_id == code
                    and st.category_scheme_id == "VAT"):
                continue
            expected = Decimal("0")
            for ln in inv.lines:
                if any(cat.id == code for cat in ln.item_tax_categories):
                    v = _dec(ln.line_extension_amount)
                    if v is not None:
                        expected += v
            for ac in inv.doc_allowance_charges:
                if ac.is_charge is None:
                    continue
                if any(cat.id == code for cat in ac.tax_categories):
                    v = _dec(ac.amount_raw)
                    if v is not None:
                        expected += v if ac.is_charge else -v
            taxable = _dec(st.taxable_amount)
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
    equal the exact sum of E line net amounts − E allowances + E charges."""
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
    """
    if "K" not in inv.breakdown_vat_category_codes():
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
    """
    if "K" not in inv.breakdown_vat_category_codes():
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
    (BT-116) shall equal the exact sum of G line nets − G allowances + G
    charges."""
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
    charges."""
    hit = _breakdown_taxable_sum_mismatch(inv, "O")
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

    Official (context ``/ubl:Invoice``): HOLDS iff either no O breakdown row
    exists, or an O row exists AND every top-level VAT breakdown category code
    equals 'O' (``count(cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory
    [normalize-space(cbc:ID)!='O'][VAT]) = 0``). Fires iff an O breakdown row
    coexists with any non-O VAT breakdown row.
    """
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

    Official (context ``/ubl:Invoice``): fires iff an O VAT breakdown row exists
    AND a line-item VAT ClassifiedTaxCategory with a non-O code exists
    (``count(//cac:ClassifiedTaxCategory[normalize-space(cbc:ID)!='O'][VAT])``).
    """
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

    Official (context ``/ubl:Invoice``): fires iff an O VAT breakdown row exists
    AND an allowance (``//cac:AllowanceCharge[cbc:ChargeIndicator=false()]``)
    carries a VAT TaxCategory with a non-O code.
    """
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

    Official (context ``/ubl:Invoice``): fires iff an O VAT breakdown row exists
    AND a charge (``//cac:AllowanceCharge[cbc:ChargeIndicator=true()]``) carries
    a VAT TaxCategory with a non-O code.
    """
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


def br_ae_01(inv):
    """BR-AE-01: 'Reverse charge' (AE) items require exactly one AE VAT
    breakdown (BG-23) row."""
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
    breakdown (BG-23) row."""
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
    breakdown (BG-23) row."""
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
    breakdown (BG-23) row."""
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
    breakdown (BG-23) row."""
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
    """
    for pp in inv.payee_parties:
        holds = (bool(pp.names)
                 and not any(n in pp.seller_names for n in pp.names)
                 and not any(i in pp.seller_ids for i in pp.ids))
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

    Only evaluated when that postal address is PRESENT (absence is BR-19's
    job); absent/empty/whitespace-only country code fires.
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
    """
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


# Ordered ruleset (evaluation order = document flow: header -> lines -> codes
# -> arithmetic -> VAT-category consistency -> decimal precision).
ALL_RULES = [
    br_01, br_02, br_03, br_04, br_05, br_06, br_07, br_08,
    br_09, br_10, br_11,
    br_12, br_13, br_14, br_15,
    br_16, br_17, br_18, br_19, br_20,
    br_21, br_22, br_24, br_25, br_26, br_27, br_28, br_29, br_30,
    br_31, br_32, br_33, br_36, br_37, br_38,
    br_41, br_42, br_43, br_44,
    br_49, br_50, br_51, br_55, br_57, br_61, br_62, br_63,
    br_cl_01,
    br_cl_03, br_cl_04, br_cl_05, br_cl_13, br_cl_14,
    br_cl_16,
    br_cl_17, br_cl_18, br_cl_19, br_cl_20, br_cl_21, br_cl_22, br_cl_23,
    br_cl_24,
    br_co_04,
    br_co_10, br_co_11, br_co_12, br_co_13, br_co_14, br_co_15, br_co_16,
    br_co_17, br_co_18,
    br_45, br_46, br_47, br_48,
    br_s_01, br_z_01,
    br_s_02, br_s_03, br_s_04, br_s_05, br_s_06, br_s_07, br_s_09, br_s_10,
    br_z_02, br_z_03, br_z_04, br_z_05, br_z_06, br_z_07,
    br_z_08, br_z_09, br_z_10,
    br_e_02, br_e_03, br_e_04, br_e_05, br_e_06, br_e_07,
    br_e_08, br_e_09, br_e_10,
    br_ae_02, br_ae_03, br_ae_04, br_ae_05, br_ae_06, br_ae_07,
    br_ae_08, br_ae_09, br_ae_10,
    br_ic_02, br_ic_03, br_ic_04, br_ic_05, br_ic_06, br_ic_07,
    br_ic_08, br_ic_09, br_ic_11, br_ic_12,
    br_g_02, br_g_03, br_g_04, br_g_05, br_g_06, br_g_07,
    br_g_08, br_g_09, br_g_10,
    br_o_02, br_o_03, br_o_04, br_o_05, br_o_06, br_o_07,
    br_o_08, br_o_09, br_o_10, br_o_11, br_o_12, br_o_13, br_o_14,
    br_ae_01, br_e_01, br_g_01, br_ic_01, br_o_01,
    br_dec_01, br_dec_02, br_dec_05, br_dec_06,
    br_dec_09, br_dec_10, br_dec_11, br_dec_12, br_dec_14,
    br_dec_16, br_dec_17, br_dec_18, br_dec_19, br_dec_20, br_dec_23,
]
