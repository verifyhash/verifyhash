"""First-slice EN 16931 + XRechnung business rules.

Each rule is a *pure function* taking the parsed :class:`~einvoice.parser.Invoice`
model and returning a :class:`Violation` when the rule is broken, or ``None`` when
it holds. Rule wording follows the vendored EN 16931 Schematron
(``corpus/cen-en16931/ubl/schematron/abstract/EN16931-model.sch``).

Standard library only.
"""

from __future__ import annotations

from collections import namedtuple
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

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
    """Parse a numeric text field to Decimal, or None if absent/unparseable."""
    if text is None or text == "":
        return None
    try:
        return Decimal(text)
    except (InvalidOperation, ValueError):
        return None


def _q(value):
    """Quantize a Decimal to 2 places, EN 16931 half-up rounding."""
    return value.quantize(_CENT, rounding=ROUND_HALF_UP)


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


# Ordered ruleset (evaluation order = document flow: header -> lines -> codes
# -> arithmetic -> VAT-category consistency).
ALL_RULES = [
    br_01, br_02, br_03, br_04, br_05, br_06, br_07, br_08,
    br_16, br_21, br_22, br_24, br_26,
    br_cl_01,
    br_co_10, br_co_13, br_co_14, br_co_15,
    br_s_01, br_z_01,
]
