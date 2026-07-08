"""First-slice EN 16931 + XRechnung business rules.

Each rule is a *pure function* taking the parsed :class:`~einvoice.parser.Invoice`
model and returning a :class:`Violation` when the rule is broken, or ``None`` when
it holds. Rule wording follows the vendored EN 16931 Schematron
(``corpus/cen-en16931/ubl/schematron/abstract/EN16931-model.sch``).

Standard library only.
"""

from __future__ import annotations

from collections import namedtuple
from decimal import Decimal, InvalidOperation, ROUND_FLOOR, ROUND_HALF_UP

Violation = namedtuple("Violation", ["rule_id", "message", "element"])

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


# ---------------------------------------------------------------------------
# Calculation / co-constraint (arithmetic integrity)
# ---------------------------------------------------------------------------
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


# Ordered ruleset (evaluation order = document flow: header -> lines -> codes
# -> arithmetic -> VAT-category consistency -> decimal precision).
ALL_RULES = [
    br_01, br_02, br_03, br_04, br_05, br_06, br_07, br_08,
    br_09, br_10, br_11,
    br_12, br_13, br_14, br_15,
    br_16, br_21, br_22, br_24, br_26,
    br_31, br_32, br_33, br_36, br_37, br_38,
    br_41, br_42, br_43, br_44,
    br_cl_01,
    br_co_10, br_co_13, br_co_14, br_co_15, br_co_16, br_co_17, br_co_18,
    br_s_01, br_z_01,
    br_ae_01, br_e_01, br_g_01, br_ic_01, br_o_01,
    br_dec_01, br_dec_02, br_dec_05, br_dec_06,
    br_dec_09, br_dec_10, br_dec_11, br_dec_12, br_dec_14,
    br_dec_16, br_dec_17, br_dec_18, br_dec_19, br_dec_20, br_dec_23,
]
