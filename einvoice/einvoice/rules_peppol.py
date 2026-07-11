"""PEPPOL-EN16931-R* rules — the Peppol-derived layer KoSIT ships INSIDE the
official XRechnung Schematron artifact.

Scope honesty (read this first): the KoSIT XRechnung Schematron
(``corpus/xrechnung-schematron/schematron/{ubl,cii}/…``, v2.5.0 / XRechnung
3.0.2) vendors a subset of the Peppol BIS Billing 3.0 rule family — 21
``PEPPOL-EN16931-R*`` canonical rule ids per binding — inside its
``peppol-*-pattern`` patterns. This module implements ALL 21 canonical rules
of that KoSIT-vendored family (batch 1: R001, R005, R008, R010, R020, R040,
R041, R042, R043, R044, R046; batch 2: R053, R054, R055, R061, R101, R110,
R111, R120, R121, R130), transcribed assert-by-assert from those vendored
artifacts and differential-proven against the compiled official XSLTs by
``differential.py`` (the KoSIT-UBL and KoSIT-CII legs). It is **NOT** full
Peppol BIS Billing 3.0 support: the OpenPeppol ruleset proper (its own
Schematron + test corpus) is a separate, not-vendored artifact, and no rule
here is claimed beyond what the KoSIT artifact carries. The family enumeration
stays machine-checked in ``coverage_matrix.json`` (``peppol_kosit_family``),
recomputed live by ``test_coverage_gap.py``.

Two bindings, two registries:

* ``UBL_RULES`` — pure functions over the parsed UBL *Invoice* root element
  (``xml.etree.ElementTree.Element``), like the BR-DE layer. The official UBL
  contexts also name ``ubl-creditnote:CreditNote`` branches; this engine
  validates UBL *Invoice* documents, so only the Invoice branches can ever
  match (transcription notes per rule).
* ``CII_RULES`` — pure functions over the RAW CrossIndustryInvoice root
  element (NOT the normalized model: rules like R008 constrain the literal
  document tree, which no normalized model carries).

Rule ids: every function carries the canonical family id in ``.rule_id`` (what
a Violation reports) and the official per-binding assert id in ``.assert_id``
(what the differential grades against the SVRL). They differ only for R043 in
CII, which the artifact splits into two asserts (``PEPPOL-EN16931-R043-1`` on
``ram:SpecifiedTradeAllowanceCharge`` and ``…-R043-2`` on
``ram:AppliedTradeAllowanceCharge``).

Semantics are derived from the official ``@test`` XPath, never from the prose;
where prose and XPath could be read differently, the XPath wins. Every rule is
flagged ``fatal`` in both vendored artifacts except R120, which both artifacts
flag ``warning``.

Standard library only.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from .rules_xrechnung import Violation, _nsp, _sv, NS_CAC, NS_CBC, NS

# CII (UN/CEFACT CrossIndustryInvoice) namespaces — same URIs as
# einvoice.parser_cii (kept literal here so this module stays import-light).
NS_RSM = ("urn:un:unece:uncefact:data:standard:"
          "CrossIndustryInvoice:100")
NS_RAM = ("urn:un:unece:uncefact:data:standard:"
          "ReusableAggregateBusinessInformationEntity:100")
NS_UDT = "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"
NSC = {"rsm": NS_RSM, "ram": NS_RAM, "udt": NS_UDT}


def _rule(rule_id, assert_id=None, severity="fatal"):
    """Register id + severity. Every PEPPOL-EN16931-R* assert in the vendored
    artifacts is flagged fatal except R120 (warning in BOTH bindings)."""
    def deco(fn):
        fn.rule_id = rule_id
        fn.assert_id = assert_id or rule_id
        fn.severity = severity
        return fn
    return deco


def _v(fn, message, element):
    return Violation(fn.rule_id, message, element, fn.severity)


def _text(el):
    """normalize-space(<el>/text()) — the official tests read the element's own
    text nodes (child ELEMENTS excluded). ElementTree merges the character data
    of a childless element into ``.text``; an absent element or text node
    normalizes to '' exactly like normalize-space(())."""
    if el is None:
        return ""
    return _nsp(el.text)


def _dec(text):
    """xs:decimal(<string>) or None when the cast would be a dynamic error.

    In the official transform an invalid xs:decimal aborts the WHOLE run (the
    differential harness then skips that document on the official side before
    ours is consulted), so returning None and treating the assert as holding
    never creates a graded divergence."""
    if text is None:
        return None
    try:
        d = Decimal(text.strip())
    except (InvalidOperation, ValueError):
        return None
    if not d.is_finite():
        return None
    return d


def _slack_value(is_huf):
    """The artifacts' $slackValue: 0.5 when BT-5 is HUF, else 0.02."""
    return Decimal("0.5") if is_huf else Decimal("0.02")


def _slack_holds(exp, val, slack):
    """u:slack($exp, $val, $slack): $exp+$slack >= $val and $exp-$slack <= $val."""
    return exp + slack >= val and exp - slack <= val


def _dbl(text):
    """The xs:double an untyped value is cast to inside an XPath 2.0 general
    comparison against a number, or None when the cast would be a dynamic
    error (which aborts the WHOLE official run — same skip-and-hold convention
    as :func:`_dec`). Accepts the XSD double lexical space Python also parses
    ('NaN', 'INF', scientific notation); NaN compares false everywhere, which
    matches XPath."""
    if text is None:
        return None
    s = text.strip()
    if not s or s.lower() in ("infinity", "+infinity", "-infinity"):
        # Python's float() accepts 'Infinity' spellings XSD does not.
        if s.upper() in ("INF", "+INF", "-INF"):
            pass
        else:
            return None
    try:
        return float(s)
    except ValueError:
        return None


def _fn_round(d):
    """XPath 2.0 fn:round over xs:decimal: nearest integer, ties towards
    positive infinity (round(2.5)=3, round(-2.5)=-2)."""
    from decimal import ROUND_FLOOR
    return (d + Decimal("0.5")).to_integral_value(rounding=ROUND_FLOOR)


_DATE_RE = None


def _date(text):
    """xs:date(<string>) as a comparable (y, m, d) tuple, or None when the cast
    would be a dynamic error (timezone suffixes are accepted and ignored — the
    vendored corpus carries none, and the implicit-timezone subtleties cannot
    change an equal-offset comparison)."""
    global _DATE_RE
    if _DATE_RE is None:
        import re
        _DATE_RE = re.compile(
            r"^(-?\d{4,})-(\d{2})-(\d{2})(Z|[+-]\d{2}:\d{2})?$")
    if text is None:
        return None
    m = _DATE_RE.match(text.strip())
    if not m:
        return None
    y, mo, dy = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1 <= mo <= 12 and 1 <= dy <= 31):
        return None
    return (y, mo, dy)


# ===========================================================================
# UBL binding (context paths from XRechnung-UBL-validation.sch, patterns
# peppol-ubl-pattern-1 / peppol-ubl-pattern-2).
# ===========================================================================
def _ubl_doc_and_line_allowance_charges(root):
    """The R040/R041/R042/R043 UBL context set for an Invoice document:
    document-level ``cac:AllowanceCharge`` + ``cac:InvoiceLine/cac:AllowanceCharge``
    (the official context union also names the CreditNote/CreditNoteLine
    branches, unreachable for a UBL Invoice root). Price-level allowances are
    NOT in this context — they have their own R044/R046 contexts."""
    out = list(root.findall("cac:AllowanceCharge", NS))
    for line in root.findall("cac:InvoiceLine", NS):
        out.extend(line.findall("cac:AllowanceCharge", NS))
    return out


def _ubl_price_allowance_charges(root):
    """R044/R046 context ``cac:Price/cac:AllowanceCharge`` (a pattern context —
    any Price anywhere in the document; in a UBL Invoice that is the line
    ``cac:InvoiceLine/cac:Price``). Yields (price, allowance_charge) pairs so
    R046 can resolve its ``../cbc:PriceAmount``."""
    for price in root.iter("{%s}Price" % NS_CAC):
        for ac in price.findall("cac:AllowanceCharge", NS):
            yield price, ac


def _ubl_is_huf(root):
    """$documentCurrencyCode = 'HUF' — untrimmed string-value equality over
    /*/cbc:DocumentCurrencyCode."""
    return any(_sv(e) == "HUF"
               for e in root.findall("cbc:DocumentCurrencyCode", NS))


@_rule("PEPPOL-EN16931-R001")
def ubl_r001(root):
    """PEPPOL-EN16931-R001: Business process MUST be provided.

    Context ubl-invoice:Invoice (| ubl-creditnote:CreditNote); test
    ``cbc:ProfileID`` — element existence, emptiness irrelevant."""
    if root.find("cbc:ProfileID", NS) is None:
        return _v(ubl_r001, "Business process MUST be provided.",
                  "cbc:ProfileID")
    return None


@_rule("PEPPOL-EN16931-R005")
def ubl_r005(root):
    """PEPPOL-EN16931-R005: VAT accounting currency code MUST be different from
    invoice currency code when provided.

    Context cbc:TaxCurrencyCode; test
    ``not(normalize-space(text()) = normalize-space(../cbc:DocumentCurrencyCode/text()))``
    — fires when the two normalized codes are EQUAL (an absent sibling
    normalizes to '', so an empty TaxCurrencyCode next to an absent
    DocumentCurrencyCode also fires)."""
    pmap = {c: p for p in root.iter() for c in p}
    for tcc in root.iter("{%s}TaxCurrencyCode" % NS_CBC):
        parent = pmap.get(tcc)
        if parent is None:
            continue
        if _text(tcc) == _text(parent.find("cbc:DocumentCurrencyCode", NS)):
            return _v(ubl_r005, "VAT accounting currency code MUST be "
                      "different from invoice currency code when provided.",
                      "cbc:TaxCurrencyCode")
    return None


@_rule("PEPPOL-EN16931-R008")
def ubl_r008(root):
    """PEPPOL-EN16931-R008: Document MUST not contain empty elements.

    Context ``//*[not(*) and not(normalize-space())]`` with test ``false()`` —
    the assert fires for EVERY element (any namespace, the whole tree) that has
    no child elements and a whitespace-only string value. Attributes do not
    rescue an element."""
    for el in root.iter():
        if len(el) == 0 and not _nsp(el.text):
            return _v(ubl_r008, "Document MUST not contain empty elements.",
                      el.tag)
    return None


@_rule("PEPPOL-EN16931-R010")
def ubl_r010(root):
    """PEPPOL-EN16931-R010: Buyer electronic address MUST be provided.

    Context cac:AccountingCustomerParty/cac:Party; test ``cbc:EndpointID``
    (element existence)."""
    for acp in root.iter("{%s}AccountingCustomerParty" % NS_CAC):
        for party in acp.findall("cac:Party", NS):
            if party.find("cbc:EndpointID", NS) is None:
                return _v(ubl_r010, "Buyer electronic address MUST be provided",
                          "cac:AccountingCustomerParty/cac:Party/cbc:EndpointID")
    return None


@_rule("PEPPOL-EN16931-R020")
def ubl_r020(root):
    """PEPPOL-EN16931-R020: Seller electronic address MUST be provided.

    Context cac:AccountingSupplierParty/cac:Party; test ``cbc:EndpointID``."""
    for asp in root.iter("{%s}AccountingSupplierParty" % NS_CAC):
        for party in asp.findall("cac:Party", NS):
            if party.find("cbc:EndpointID", NS) is None:
                return _v(ubl_r020, "Seller electronic address MUST be provided",
                          "cac:AccountingSupplierParty/cac:Party/cbc:EndpointID")
    return None


@_rule("PEPPOL-EN16931-R040")
def ubl_r040(root):
    """PEPPOL-EN16931-R040: Allowance/charge amount must equal base amount *
    percentage/100 if base amount and percentage exists.

    Context = document + line AllowanceCharge; test
    ``not(cbc:MultiplierFactorNumeric and cbc:BaseAmount) or
    u:slack(if (cbc:Amount) then cbc:Amount else 0,
    (xs:decimal(cbc:BaseAmount) * xs:decimal(cbc:MultiplierFactorNumeric)) div 100,
    $slackValue)`` with $slackValue = 0.5 for HUF invoices, else 0.02."""
    slack = _slack_value(_ubl_is_huf(root))
    for ac in _ubl_doc_and_line_allowance_charges(root):
        mfn = ac.find("cbc:MultiplierFactorNumeric", NS)
        base = ac.find("cbc:BaseAmount", NS)
        if mfn is None or base is None:
            continue
        amount_el = ac.find("cbc:Amount", NS)
        amount = _dec(_sv(amount_el)) if amount_el is not None else Decimal(0)
        base_d, mfn_d = _dec(_sv(base)), _dec(_sv(mfn))
        if amount is None or base_d is None or mfn_d is None:
            continue  # official side dynamic-errors first; see _dec
        if not _slack_holds(amount, (base_d * mfn_d) / Decimal(100), slack):
            return _v(ubl_r040, "Allowance/charge amount must equal base "
                      "amount * percentage/100 if base amount and percentage "
                      "exists", "cac:AllowanceCharge/cbc:Amount")
    return None


@_rule("PEPPOL-EN16931-R041")
def ubl_r041(root):
    """PEPPOL-EN16931-R041: Allowance/charge base amount MUST be provided when
    allowance/charge percentage is provided.

    Context = document + line AllowanceCharge filtered on
    ``[cbc:MultiplierFactorNumeric and not(cbc:BaseAmount)]``, test ``false()``
    — fires for every such element."""
    for ac in _ubl_doc_and_line_allowance_charges(root):
        if (ac.find("cbc:MultiplierFactorNumeric", NS) is not None
                and ac.find("cbc:BaseAmount", NS) is None):
            return _v(ubl_r041, "Allowance/charge base amount MUST be provided "
                      "when allowance/charge percentage is provided.",
                      "cac:AllowanceCharge/cbc:BaseAmount")
    return None


@_rule("PEPPOL-EN16931-R042")
def ubl_r042(root):
    """PEPPOL-EN16931-R042: Allowance/charge percentage MUST be provided when
    allowance/charge base amount is provided.

    Context filter ``[not(cbc:MultiplierFactorNumeric) and cbc:BaseAmount]``,
    test ``false()``."""
    for ac in _ubl_doc_and_line_allowance_charges(root):
        if (ac.find("cbc:MultiplierFactorNumeric", NS) is None
                and ac.find("cbc:BaseAmount", NS) is not None):
            return _v(ubl_r042, "Allowance/charge percentage MUST be provided "
                      "when allowance/charge base amount is provided.",
                      "cac:AllowanceCharge/cbc:MultiplierFactorNumeric")
    return None


@_rule("PEPPOL-EN16931-R043")
def ubl_r043(root):
    """PEPPOL-EN16931-R043: Allowance/charge ChargeIndicator value MUST equal
    'true' or 'false'.

    Context = document + line AllowanceCharge; test
    ``normalize-space(cbc:ChargeIndicator/text()) = 'true' or … = 'false'`` —
    an ABSENT indicator normalizes to '' and fires."""
    for ac in _ubl_doc_and_line_allowance_charges(root):
        if _text(ac.find("cbc:ChargeIndicator", NS)) not in ("true", "false"):
            return _v(ubl_r043, "Allowance/charge ChargeIndicator value MUST "
                      "equal 'true' or 'false'",
                      "cac:AllowanceCharge/cbc:ChargeIndicator")
    return None


@_rule("PEPPOL-EN16931-R044")
def ubl_r044(root):
    """PEPPOL-EN16931-R044: Charge on price level is NOT allowed. Only value
    'false' allowed.

    Context cac:Price/cac:AllowanceCharge; test
    ``normalize-space(cbc:ChargeIndicator) = 'false'`` (string-VALUE here, not
    text(); identical for a childless indicator). Absent indicator -> '' ->
    fires."""
    for _price, ac in _ubl_price_allowance_charges(root):
        if _nsp(_sv(ac.find("cbc:ChargeIndicator", NS))) != "false":
            return _v(ubl_r044, "Charge on price level is NOT allowed. Only "
                      "value 'false' allowed.",
                      "cac:Price/cac:AllowanceCharge/cbc:ChargeIndicator")
    return None


@_rule("PEPPOL-EN16931-R046")
def ubl_r046(root):
    """PEPPOL-EN16931-R046: Item net price MUST equal (Gross price - Allowance
    amount) when gross price is provided.

    Context cac:Price/cac:AllowanceCharge; test ``not(cbc:BaseAmount) or
    xs:decimal(../cbc:PriceAmount) = xs:decimal(cbc:BaseAmount) -
    xs:decimal(cbc:Amount)``. An absent PriceAmount or Amount makes the XPath
    2.0 comparison involve the empty sequence -> false -> fires."""
    for price, ac in _ubl_price_allowance_charges(root):
        base = ac.find("cbc:BaseAmount", NS)
        if base is None:
            continue
        pa = price.find("cbc:PriceAmount", NS)
        amt = ac.find("cbc:Amount", NS)
        fires = True
        if pa is not None and amt is not None:
            pa_d, base_d, amt_d = _dec(_sv(pa)), _dec(_sv(base)), _dec(_sv(amt))
            if pa_d is None or base_d is None or amt_d is None:
                continue  # official dynamic error; see _dec
            fires = pa_d != base_d - amt_d
        if fires:
            return _v(ubl_r046, "Item net price MUST equal (Gross price - "
                      "Allowance amount) when gross price is provided.",
                      "cac:Price/cbc:PriceAmount")
    return None


@_rule("PEPPOL-EN16931-R053")
def ubl_r053(root):
    """PEPPOL-EN16931-R053: Only one tax total with tax subtotals MUST be
    provided.

    Context ubl-invoice:Invoice; test
    ``count(cac:TaxTotal[cac:TaxSubtotal]) = 1`` — zero or more than one
    subtotal-carrying cac:TaxTotal both fire."""
    n = sum(1 for tt in root.findall("cac:TaxTotal", NS)
            if tt.find("cac:TaxSubtotal", NS) is not None)
    if n != 1:
        return _v(ubl_r053, "Only one tax total with tax subtotals MUST be "
                  "provided.", "cac:TaxTotal")
    return None


@_rule("PEPPOL-EN16931-R054")
def ubl_r054(root):
    """PEPPOL-EN16931-R054: Only one tax total without tax subtotals MUST be
    provided when tax currency code is provided.

    Context ubl-invoice:Invoice; test
    ``count(cac:TaxTotal[not(cac:TaxSubtotal)]) =
    (if (cbc:TaxCurrencyCode) then 1 else 0)`` — with BT-6 present exactly one
    subtotal-free cac:TaxTotal is required; without BT-6, none is allowed."""
    n = sum(1 for tt in root.findall("cac:TaxTotal", NS)
            if tt.find("cac:TaxSubtotal", NS) is None)
    want = 1 if root.find("cbc:TaxCurrencyCode", NS) is not None else 0
    if n != want:
        return _v(ubl_r054, "Only one tax total without tax subtotals MUST "
                  "be provided when tax currency code is provided.",
                  "cac:TaxTotal")
    return None


@_rule("PEPPOL-EN16931-R055")
def ubl_r055(root):
    """PEPPOL-EN16931-R055: Invoice total VAT amount and Invoice total VAT
    amount in accounting currency MUST have the same operational sign.

    Context ubl-invoice:Invoice; test ``not(cbc:TaxCurrencyCode) or
    (cac:TaxTotal/cbc:TaxAmount[@currencyID=normalize-space(../../cbc:TaxCurrencyCode)] <= 0
     and …[@currencyID=normalize-space(../../cbc:DocumentCurrencyCode)] <= 0) or
    (… >= 0 and … >= 0)``. The ``<=``/``>=`` are XPath 2.0 GENERAL comparisons
    over node sequences (true iff SOME member satisfies; the empty sequence
    satisfies nothing — so a missing tax-currency amount fires). Untyped values
    are cast to xs:double for the comparison; an uncastable amount is an
    official dynamic error (skip-and-hold, see :func:`_dbl`)."""
    tccs = root.findall("cbc:TaxCurrencyCode", NS)
    if not tccs:
        return None
    dccs = root.findall("cbc:DocumentCurrencyCode", NS)
    if len(tccs) > 1 or len(dccs) > 1:
        return None  # normalize-space(seq>1) is an official dynamic error
    tcc = _nsp(_sv(tccs[0]))
    dcc = _nsp(_sv(dccs[0])) if dccs else ""
    tax_vals, doc_vals = [], []
    for tt in root.findall("cac:TaxTotal", NS):
        for ta in tt.findall("cbc:TaxAmount", NS):
            cur = ta.get("currencyID")
            if cur == tcc:
                tax_vals.append(_dbl(_sv(ta)))
            if cur == dcc:
                doc_vals.append(_dbl(_sv(ta)))
    if any(v is None for v in tax_vals + doc_vals):
        return None  # official dynamic error; see _dbl
    holds = ((any(v <= 0 for v in tax_vals) and any(v <= 0 for v in doc_vals))
             or (any(v >= 0 for v in tax_vals)
                 and any(v >= 0 for v in doc_vals)))
    if not holds:
        return _v(ubl_r055, "Invoice total VAT amount and Invoice total VAT "
                  "amount in accounting currency MUST have the same "
                  "operational sign", "cac:TaxTotal/cbc:TaxAmount")
    return None


@_rule("PEPPOL-EN16931-R061")
def ubl_r061(root):
    """PEPPOL-EN16931-R061: Mandate reference MUST be provided for direct
    debit.

    Context ``cac:PaymentMeans[some $code in tokenize('49 59', '\\s')
    satisfies normalize-space(cbc:PaymentMeansCode) = $code]``; test
    ``cac:PaymentMandate/cbc:ID``. More than one cbc:PaymentMeansCode makes
    the context predicate's normalize-space() an official dynamic error
    (skip-and-hold); zero codes normalize to '' and never match 49/59."""
    for pm in root.iter("{%s}PaymentMeans" % NS_CAC):
        codes = pm.findall("cbc:PaymentMeansCode", NS)
        if len(codes) != 1 or _nsp(_sv(codes[0])) not in ("49", "59"):
            continue
        if pm.find("cac:PaymentMandate/cbc:ID", NS) is None:
            return _v(ubl_r061, "Mandate reference MUST be provided for "
                      "direct debit.",
                      "cac:PaymentMeans/cac:PaymentMandate/cbc:ID")
    return None


@_rule("PEPPOL-EN16931-R101")
def ubl_r101(root):
    """PEPPOL-EN16931-R101: Element Document reference can only be used for
    Invoice line object.

    Context cac:InvoiceLine (| cac:CreditNoteLine); test
    ``(not(cac:DocumentReference) or
    (cac:DocumentReference/cbc:DocumentTypeCode='130'))`` — the ``=`` is a
    general comparison: holds when ANY DocumentTypeCode's untrimmed string
    value is exactly '130'."""
    for line in root.iter("{%s}InvoiceLine" % NS_CAC):
        drs = line.findall("cac:DocumentReference", NS)
        if not drs:
            continue
        if not any(_sv(dtc) == "130" for dr in drs
                   for dtc in dr.findall("cbc:DocumentTypeCode", NS)):
            return _v(ubl_r101, "Element Document reference can only be used "
                      "for Invoice line object",
                      "cac:InvoiceLine/cac:DocumentReference/"
                      "cbc:DocumentTypeCode")
    return None


def _ubl_doc_period_date(root, which):
    """The document-level ``cac:InvoicePeriod/cbc:StartDate|EndDate`` element
    set of the R110/R111 context filters (direct children of the root)."""
    return [d for p in root.findall("cac:InvoicePeriod", NS)
            for d in p.findall("cbc:%s" % which, NS)]


def _ubl_line_period_check(root, which, cmp_ok):
    """Shared R110/R111 walk. Context
    ``ubl-invoice:Invoice[cac:InvoicePeriod/cbc:<which>]/cac:InvoiceLine/
    cac:InvoicePeriod/cbc:<which>``; test ``xs:date(text()) >=|<=
    xs:date(../../../cac:InvoicePeriod/cbc:<which>)``. An empty line date
    (no text node) makes the LHS the empty sequence -> comparison false ->
    fires; an uncastable date on either side is an official dynamic error
    (skip-and-hold)."""
    doc_dates = _ubl_doc_period_date(root, which)
    if not doc_dates:
        return False, None  # context filter not satisfied
    if len(doc_dates) > 1:
        return False, None  # xs:date(seq>1): official dynamic error
    doc = _date(_sv(doc_dates[0]))
    if doc is None:
        return False, None  # official dynamic error
    for line in root.findall("cac:InvoiceLine", NS):
        for period in line.findall("cac:InvoicePeriod", NS):
            for d in period.findall("cbc:%s" % which, NS):
                if d.text is None:
                    return True, d  # xs:date(()) -> () -> false -> fires
                val = _date(d.text)
                if val is None:
                    return False, None  # official dynamic error
                if not cmp_ok(val, doc):
                    return True, d
    return False, None


@_rule("PEPPOL-EN16931-R110")
def ubl_r110(root):
    """PEPPOL-EN16931-R110: Start date of line period MUST be within invoice
    period. (Line start >= document invoice-period start.)"""
    fired, _el = _ubl_line_period_check(root, "StartDate",
                                        lambda line, doc: line >= doc)
    if fired:
        return _v(ubl_r110, "Start date of line period MUST be within "
                  "invoice period.",
                  "cac:InvoiceLine/cac:InvoicePeriod/cbc:StartDate")
    return None


@_rule("PEPPOL-EN16931-R111")
def ubl_r111(root):
    """PEPPOL-EN16931-R111: End date of line period MUST be within invoice
    period. (Line end <= document invoice-period end.)"""
    fired, _el = _ubl_line_period_check(root, "EndDate",
                                        lambda line, doc: line <= doc)
    if fired:
        return _v(ubl_r111, "End date of line period MUST be within invoice "
                  "period.",
                  "cac:InvoiceLine/cac:InvoicePeriod/cbc:EndDate")
    return None


def _ubl_single_dec(parent, path, default):
    """``if (<path>) then xs:decimal(<path>) else <default>`` with the
    official dynamic-error convention: (found, value); value None = dynamic
    error (multiple nodes or uncastable) -> hold."""
    els = parent.findall(path, NS)
    if not els:
        return False, default
    if len(els) > 1:
        return True, None
    return True, _dec(_sv(els[0]))


def _ubl_ac_sum(line, indicator):
    """``round(sum(cac:AllowanceCharge[normalize-space(cbc:ChargeIndicator) =
    '<indicator>']/cbc:Amount/xs:decimal(.)) * 10 * 10) div 100`` (0 when no
    such AllowanceCharge exists). Returns None on an official dynamic error
    (uncastable Amount)."""
    matched = []
    for ac in line.findall("cac:AllowanceCharge", NS):
        inds = ac.findall("cbc:ChargeIndicator", NS)
        if len(inds) > 1:
            return None  # normalize-space(seq>1): official dynamic error
        ind = _nsp(_sv(inds[0])) if inds else ""
        if ind == indicator:
            matched.append(ac)
    if not matched:
        return Decimal(0)
    total = Decimal(0)
    for ac in matched:
        for amt in ac.findall("cbc:Amount", NS):
            d = _dec(_sv(amt))
            if d is None:
                return None
            total += d
    return _fn_round(total * 100) / Decimal(100)


@_rule("PEPPOL-EN16931-R120", severity="warning")
def ubl_r120(root):
    """PEPPOL-EN16931-R120: Invoice line net amount MUST equal (Invoiced
    quantity * (Item net price/item price base quantity) + Sum of invoice line
    charge amount - sum of invoice line allowance amount.

    Context cac:InvoiceLine; test ``u:slack($lineExtensionAmount,
    ($quantity * ($priceAmount div $baseQuantity)) + $chargesTotal -
    $allowancesTotal, $slackValue)`` with the rule's own lets: missing
    LineExtensionAmount/PriceAmount default to 0, missing InvoicedQuantity to
    1, and a missing-or-zero BaseQuantity to 1; allowance/charge totals are
    the fn:round-to-2-decimals sums of the 'false'/'true'-indicated
    cac:AllowanceCharge/cbc:Amount casts. Flagged WARNING in the artifact."""
    slack = _slack_value(_ubl_is_huf(root))
    for line in root.iter("{%s}InvoiceLine" % NS_CAC):
        _f, lea = _ubl_single_dec(line, "cbc:LineExtensionAmount", Decimal(0))
        _f, qty = _ubl_single_dec(line, "cbc:InvoicedQuantity", Decimal(1))
        _f, price = _ubl_single_dec(line, "cac:Price/cbc:PriceAmount",
                                    Decimal(0))
        found, bq = _ubl_single_dec(line, "cac:Price/cbc:BaseQuantity",
                                    Decimal(1))
        if None in (lea, qty, price, bq):
            continue  # official dynamic error; see _ubl_single_dec
        if found and bq == 0:
            bq = Decimal(1)
        allowances = _ubl_ac_sum(line, "false")
        charges = _ubl_ac_sum(line, "true")
        if allowances is None or charges is None:
            continue  # official dynamic error
        val = qty * (price / bq) + charges - allowances
        if not _slack_holds(lea, val, slack):
            return _v(ubl_r120, "Invoice line net amount MUST equal (Invoiced "
                      "quantity * (Item net price/item price base quantity) "
                      "+ Sum of invoice line charge amount - sum of invoice "
                      "line allowance amount",
                      "cac:InvoiceLine/cbc:LineExtensionAmount")
    return None


@_rule("PEPPOL-EN16931-R121")
def ubl_r121(root):
    """PEPPOL-EN16931-R121: Base quantity MUST be a positive number above
    zero.

    Context cac:InvoiceLine; test ``not(cac:Price/cbc:BaseQuantity) or
    xs:decimal(cac:Price/cbc:BaseQuantity) > 0``."""
    for line in root.iter("{%s}InvoiceLine" % NS_CAC):
        bqs = line.findall("cac:Price/cbc:BaseQuantity", NS)
        if not bqs:
            continue
        if len(bqs) > 1:
            continue  # xs:decimal(seq>1): official dynamic error
        d = _dec(_sv(bqs[0]))
        if d is None:
            continue  # official dynamic error
        if not d > 0:
            return _v(ubl_r121, "Base quantity MUST be a positive number "
                      "above zero.", "cac:InvoiceLine/cac:Price/"
                      "cbc:BaseQuantity")
    return None


@_rule("PEPPOL-EN16931-R130")
def ubl_r130(root):
    """PEPPOL-EN16931-R130: Unit code of price base quantity MUST be same as
    invoiced quantity.

    Context cac:Price/cbc:BaseQuantity[@unitCode] with lets ``$hasQuantity =
    ../../cbc:InvoicedQuantity or ../../cbc:CreditedQuantity`` and
    ``$quantity = ../../cbc:InvoicedQuantity`` (the Invoice branch); test
    ``not($hasQuantity) or @unitCode = $quantity/@unitCode`` — a general
    comparison over the sibling quantities' @unitCode attributes (untrimmed
    string equality; a quantity without @unitCode contributes nothing)."""
    pmap = {c: p for p in root.iter() for c in p}
    for price in root.iter("{%s}Price" % NS_CAC):
        line = pmap.get(price)
        if line is None:
            continue
        quantities = line.findall("cbc:InvoicedQuantity", NS)
        if not quantities and line.find("cbc:CreditedQuantity", NS) is None:
            continue  # not($hasQuantity) -> holds
        unit_codes = [q.get("unitCode") for q in quantities]
        for bq in price.findall("cbc:BaseQuantity", NS):
            uc = bq.get("unitCode")
            if uc is None:
                continue  # context requires @unitCode
            if not any(u == uc for u in unit_codes if u is not None):
                return _v(ubl_r130, "Unit code of price base quantity MUST "
                          "be same as invoiced quantity.",
                          "cac:Price/cbc:BaseQuantity/@unitCode")
    return None


UBL_RULES = [
    ubl_r001, ubl_r005, ubl_r008, ubl_r010, ubl_r020,
    ubl_r040, ubl_r041, ubl_r042, ubl_r043, ubl_r044, ubl_r046,
    ubl_r053, ubl_r054, ubl_r055, ubl_r061, ubl_r101,
    ubl_r110, ubl_r111, ubl_r120, ubl_r121, ubl_r130,
]


def evaluate_ubl(root):
    """Run the implemented KoSIT-vendored Peppol batch over a parsed UBL
    Invoice root. Returns the Violations that fire (at most one per rule,
    naming the first offending node — same convention as the other layers)."""
    out = []
    for rule in UBL_RULES:
        v = rule(root)
        if v is not None:
            out.append(v)
    return out


# ===========================================================================
# CII binding (context paths from XRechnung-CII-validation.sch, patterns
# peppol-cii-pattern-0-a / -0-b / -1). Functions take the RAW
# rsm:CrossIndustryInvoice root element.
# ===========================================================================
def _cii_gross_prices(root):
    """R044/R046 context rsm:SupplyChainTradeTransaction/
    ram:IncludedSupplyChainTradeLineItem/ram:SpecifiedLineTradeAgreement/
    ram:GrossPriceProductTradePrice — yielded with its parent agreement so
    ``../ram:NetPriceProductTradePrice`` can be resolved."""
    for line in root.findall("rsm:SupplyChainTradeTransaction/"
                             "ram:IncludedSupplyChainTradeLineItem", NSC):
        for agr in line.findall("ram:SpecifiedLineTradeAgreement", NSC):
            for gp in agr.findall("ram:GrossPriceProductTradePrice", NSC):
                yield agr, gp


def _cii_is_huf(root):
    """$documentCurrencyCode = 'HUF' over /rsm:CrossIndustryInvoice/
    rsm:SupplyChainTradeTransaction/ram:ApplicableHeaderTradeSettlement/
    ram:InvoiceCurrencyCode (untrimmed string-value equality)."""
    return any(_sv(e) == "HUF" for e in root.findall(
        "rsm:SupplyChainTradeTransaction/ram:ApplicableHeaderTradeSettlement/"
        "ram:InvoiceCurrencyCode", NSC))


def _indicator_text(ac):
    """normalize-space(ram:ChargeIndicator/udt:Indicator/text())."""
    return _text(ac.find("ram:ChargeIndicator/udt:Indicator", NSC))


@_rule("PEPPOL-EN16931-R001")
def cii_r001(root):
    """PEPPOL-EN16931-R001: Business process MUST be provided. CII context
    rsm:ExchangedDocumentContext; test
    ``ram:BusinessProcessSpecifiedDocumentContextParameter/ram:ID``."""
    for ctx in root.iter("{%s}ExchangedDocumentContext" % NS_RSM):
        if ctx.find("ram:BusinessProcessSpecifiedDocumentContextParameter/"
                    "ram:ID", NSC) is None:
            return _v(cii_r001, "Business process MUST be provided.",
                      "rsm:ExchangedDocumentContext/"
                      "ram:BusinessProcessSpecifiedDocumentContextParameter/ram:ID")
    return None


@_rule("PEPPOL-EN16931-R005")
def cii_r005(root):
    """PEPPOL-EN16931-R005: VAT accounting currency code MUST be different from
    invoice currency code when provided. CII context
    ram:ApplicableHeaderTradeSettlement; test ``not(ram:TaxCurrencyCode) or
    normalize-space(ram:TaxCurrencyCode/text()) !=
    normalize-space(ram:InvoiceCurrencyCode/text())`` — fires when a
    TaxCurrencyCode exists and the normalized codes are EQUAL."""
    for st in root.iter("{%s}ApplicableHeaderTradeSettlement" % NS_RAM):
        tcc = st.find("ram:TaxCurrencyCode", NSC)
        if tcc is None:
            continue
        if _text(tcc) == _text(st.find("ram:InvoiceCurrencyCode", NSC)):
            return _v(cii_r005, "VAT accounting currency code MUST be "
                      "different from invoice currency code when provided.",
                      "ram:ApplicableHeaderTradeSettlement/ram:TaxCurrencyCode")
    return None


@_rule("PEPPOL-EN16931-R008")
def cii_r008(root):
    """PEPPOL-EN16931-R008: Document MUST not contain empty elements. CII
    context ``//*[not(name() = 'ram:ApplicableHeaderTradeDelivery') and not(*)
    and not(normalize-space())]``, test ``false()``.

    The official name() test compares the PREFIXED QName as written in the
    source document; every vendored/real CII invoice binds the RAM namespace to
    the conventional ``ram:`` prefix, so the exception is transcribed as the
    namespace-qualified ApplicableHeaderTradeDelivery element (differentially
    proven on the corpus; a document using an exotic prefix would diverge and
    fail the harness loudly rather than silently)."""
    skip = "{%s}ApplicableHeaderTradeDelivery" % NS_RAM
    for el in root.iter():
        if el.tag == skip:
            continue
        if len(el) == 0 and not _nsp(el.text):
            return _v(cii_r008, "Document MUST not contain empty elements.",
                      el.tag)
    return None


@_rule("PEPPOL-EN16931-R010")
def cii_r010(root):
    """PEPPOL-EN16931-R010: Buyer electronic address MUST be provided. CII
    context ram:BuyerTradeParty; test
    ``ram:URIUniversalCommunication/ram:URIID``."""
    for party in root.iter("{%s}BuyerTradeParty" % NS_RAM):
        if party.find("ram:URIUniversalCommunication/ram:URIID", NSC) is None:
            return _v(cii_r010, "Buyer electronic address MUST be provided",
                      "ram:BuyerTradeParty/ram:URIUniversalCommunication/ram:URIID")
    return None


@_rule("PEPPOL-EN16931-R020")
def cii_r020(root):
    """PEPPOL-EN16931-R020: Seller electronic address MUST be provided. CII
    context ram:SellerTradeParty; test
    ``ram:URIUniversalCommunication/ram:URIID``."""
    for party in root.iter("{%s}SellerTradeParty" % NS_RAM):
        if party.find("ram:URIUniversalCommunication/ram:URIID", NSC) is None:
            return _v(cii_r020, "Seller electronic address MUST be provided",
                      "ram:SellerTradeParty/ram:URIUniversalCommunication/ram:URIID")
    return None


@_rule("PEPPOL-EN16931-R040")
def cii_r040(root):
    """PEPPOL-EN16931-R040: Allowance/charge amount must equal base amount *
    percentage/100 if base amount and percentage exists. CII context
    ram:SpecifiedTradeAllowanceCharge (header AND line level); test
    ``not(ram:CalculationPercent and ram:BasisAmount) or
    u:slack(if (ram:ActualAmount) then ram:ActualAmount else 0,
    (xs:decimal(ram:BasisAmount) * xs:decimal(ram:CalculationPercent)) div 100,
    $slackValue)``."""
    slack = _slack_value(_cii_is_huf(root))
    for ac in root.iter("{%s}SpecifiedTradeAllowanceCharge" % NS_RAM):
        pct = ac.find("ram:CalculationPercent", NSC)
        basis = ac.find("ram:BasisAmount", NSC)
        if pct is None or basis is None:
            continue
        actual_el = ac.find("ram:ActualAmount", NSC)
        actual = _dec(_sv(actual_el)) if actual_el is not None else Decimal(0)
        basis_d, pct_d = _dec(_sv(basis)), _dec(_sv(pct))
        if actual is None or basis_d is None or pct_d is None:
            continue  # official dynamic error; see _dec
        if not _slack_holds(actual, (basis_d * pct_d) / Decimal(100), slack):
            return _v(cii_r040, "Allowance/charge amount must equal base "
                      "amount * percentage/100 if base amount and percentage "
                      "exists", "ram:SpecifiedTradeAllowanceCharge/ram:ActualAmount")
    return None


@_rule("PEPPOL-EN16931-R041")
def cii_r041(root):
    """PEPPOL-EN16931-R041: Allowance/charge base amount MUST be provided when
    allowance/charge percentage is provided. CII context
    ``ram:SpecifiedTradeAllowanceCharge[ram:CalculationPercent and
    not(ram:BasisAmount)]``, test ``false()``."""
    for ac in root.iter("{%s}SpecifiedTradeAllowanceCharge" % NS_RAM):
        if (ac.find("ram:CalculationPercent", NSC) is not None
                and ac.find("ram:BasisAmount", NSC) is None):
            return _v(cii_r041, "Allowance/charge base amount MUST be provided "
                      "when allowance/charge percentage is provided.",
                      "ram:SpecifiedTradeAllowanceCharge/ram:BasisAmount")
    return None


@_rule("PEPPOL-EN16931-R042")
def cii_r042(root):
    """PEPPOL-EN16931-R042: Allowance/charge percentage MUST be provided when
    allowance/charge base amount is provided. CII context
    ``ram:SpecifiedTradeAllowanceCharge[not(ram:CalculationPercent) and
    ram:BasisAmount]``, test ``false()``."""
    for ac in root.iter("{%s}SpecifiedTradeAllowanceCharge" % NS_RAM):
        if (ac.find("ram:CalculationPercent", NSC) is None
                and ac.find("ram:BasisAmount", NSC) is not None):
            return _v(cii_r042, "Allowance/charge percentage MUST be provided "
                      "when allowance/charge base amount is provided.",
                      "ram:SpecifiedTradeAllowanceCharge/ram:CalculationPercent")
    return None


@_rule("PEPPOL-EN16931-R043", assert_id="PEPPOL-EN16931-R043-1")
def cii_r043_1(root):
    """PEPPOL-EN16931-R043 (CII assert -1): Allowance/charge ChargeIndicator
    value MUST equal 'true' or 'false'. Context
    ram:SpecifiedTradeAllowanceCharge; test
    ``normalize-space(ram:ChargeIndicator/udt:Indicator/text()) = 'true' or
    … = 'false'``."""
    for ac in root.iter("{%s}SpecifiedTradeAllowanceCharge" % NS_RAM):
        if _indicator_text(ac) not in ("true", "false"):
            return _v(cii_r043_1, "Allowance/charge ChargeIndicator value MUST "
                      "equal 'true' or 'false'",
                      "ram:SpecifiedTradeAllowanceCharge/ram:ChargeIndicator/"
                      "udt:Indicator")
    return None


@_rule("PEPPOL-EN16931-R043", assert_id="PEPPOL-EN16931-R043-2")
def cii_r043_2(root):
    """PEPPOL-EN16931-R043 (CII assert -2): the same ChargeIndicator constraint
    on the price-level context ram:AppliedTradeAllowanceCharge."""
    for ac in root.iter("{%s}AppliedTradeAllowanceCharge" % NS_RAM):
        if _indicator_text(ac) not in ("true", "false"):
            return _v(cii_r043_2, "Allowance/charge ChargeIndicator value MUST "
                      "equal 'true' or 'false'",
                      "ram:AppliedTradeAllowanceCharge/ram:ChargeIndicator/"
                      "udt:Indicator")
    return None


@_rule("PEPPOL-EN16931-R044")
def cii_r044(root):
    """PEPPOL-EN16931-R044: Charge on price level is NOT allowed. Only value
    'false' allowed. CII context …/ram:GrossPriceProductTradePrice; test
    ``not(ram:AppliedTradeAllowanceCharge/ram:ActualAmount) or
    ram:AppliedTradeAllowanceCharge/ram:ChargeIndicator/udt:Indicator = 'false'``
    — a node-set-to-string comparison: holds when ANY indicator's untrimmed
    string value is exactly 'false'."""
    for _agr, gp in _cii_gross_prices(root):
        if gp.find("ram:AppliedTradeAllowanceCharge/ram:ActualAmount",
                   NSC) is None:
            continue
        indicators = gp.findall(
            "ram:AppliedTradeAllowanceCharge/ram:ChargeIndicator/"
            "udt:Indicator", NSC)
        if not any(_sv(i) == "false" for i in indicators):
            return _v(cii_r044, "Charge on price level is NOT allowed. Only "
                      "value 'false' allowed.",
                      "ram:GrossPriceProductTradePrice/"
                      "ram:AppliedTradeAllowanceCharge/ram:ChargeIndicator/"
                      "udt:Indicator")
    return None


@_rule("PEPPOL-EN16931-R046")
def cii_r046(root):
    """PEPPOL-EN16931-R046: Item net price MUST equal (Gross price - Allowance
    amount) when gross price is provided. CII context
    …/ram:GrossPriceProductTradePrice; test ``not(ram:ChargeAmount) or
    xs:decimal(../ram:NetPriceProductTradePrice/ram:ChargeAmount) =
    xs:decimal(ram:ChargeAmount) -
    u:decimalOrZero(ram:AppliedTradeAllowanceCharge/ram:ActualAmount[1])`` —
    an absent net price makes the comparison involve the empty sequence ->
    false -> fires; an absent allowance ActualAmount counts as 0."""
    for agr, gp in _cii_gross_prices(root):
        charge = gp.find("ram:ChargeAmount", NSC)
        if charge is None:
            continue
        net = agr.find("ram:NetPriceProductTradePrice/ram:ChargeAmount", NSC)
        fires = True
        if net is not None:
            actual_el = gp.find(
                "ram:AppliedTradeAllowanceCharge/ram:ActualAmount", NSC)
            actual = (_dec(_sv(actual_el)) if actual_el is not None
                      else Decimal(0))
            net_d, charge_d = _dec(_sv(net)), _dec(_sv(charge))
            if actual is None or net_d is None or charge_d is None:
                continue  # official dynamic error; see _dec
            fires = net_d != charge_d - actual
        if fires:
            return _v(cii_r046, "Item net price MUST equal (Gross price - "
                      "Allowance amount) when gross price is provided.",
                      "ram:NetPriceProductTradePrice/ram:ChargeAmount")
    return None


def _cii_doc_currency_els(root, which):
    """The global $documentCurrencyCode / $taxCurrencyCode element sequences:
    /rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction/
    ram:ApplicableHeaderTradeSettlement/ram:{InvoiceCurrencyCode,
    TaxCurrencyCode}."""
    return root.findall(
        "rsm:SupplyChainTradeTransaction/ram:ApplicableHeaderTradeSettlement/"
        "ram:%s" % which, NSC)


def _cii_tax_totals_matching(settlement, codes, negate=False):
    """The ram:SpecifiedTradeSettlementHeaderMonetarySummation/
    ram:TaxTotalAmount elements whose @currencyID general-compares =
    (or != with ``negate``) the given code element string values. A missing
    @currencyID is the empty sequence: it satisfies neither ``=`` nor
    ``!=``."""
    vals = [_sv(c) for c in codes]
    out = []
    for tta in settlement.findall(
            "ram:SpecifiedTradeSettlementHeaderMonetarySummation/"
            "ram:TaxTotalAmount", NSC):
        cur = tta.get("currencyID")
        if cur is None:
            continue
        if negate:
            if any(cur != v for v in vals):
                out.append(tta)
        else:
            if any(cur == v for v in vals):
                out.append(tta)
    return out


@_rule("PEPPOL-EN16931-R053")
def cii_r053(root):
    """PEPPOL-EN16931-R053 (CII): No more than one tax total amount must be
    provided where currency id equals document currency code.

    Context ram:ApplicableHeaderTradeSettlement; test
    ``count(ram:SpecifiedTradeSettlementHeaderMonetarySummation/
    ram:TaxTotalAmount[@currencyID = $documentCurrencyCode]) <= 1``."""
    dcc = _cii_doc_currency_els(root, "InvoiceCurrencyCode")
    for st in root.iter("{%s}ApplicableHeaderTradeSettlement" % NS_RAM):
        if len(_cii_tax_totals_matching(st, dcc)) > 1:
            return _v(cii_r053, "No more than one tax total amount must be "
                      "provided where currency id equals document currency "
                      "code.",
                      "ram:SpecifiedTradeSettlementHeaderMonetarySummation/"
                      "ram:TaxTotalAmount")
    return None


@_rule("PEPPOL-EN16931-R054")
def cii_r054(root):
    """PEPPOL-EN16931-R054 (CII): Only one tax total amount must be provided
    where currency id equals tax currency code, if tax currency code (BT-6)
    is provided.

    Context ram:ApplicableHeaderTradeSettlement; test
    ``count(…/ram:TaxTotalAmount[@currencyID != $documentCurrencyCode]) =
    (if (ram:TaxCurrencyCode) then 1 else 0)`` — ``!=`` is a general
    comparison: the predicate holds when SOME document currency code differs
    from the attribute (with no InvoiceCurrencyCode at all it matches
    nothing)."""
    dcc = _cii_doc_currency_els(root, "InvoiceCurrencyCode")
    for st in root.iter("{%s}ApplicableHeaderTradeSettlement" % NS_RAM):
        n = len(_cii_tax_totals_matching(st, dcc, negate=True))
        want = 1 if st.find("ram:TaxCurrencyCode", NSC) is not None else 0
        if n != want:
            return _v(cii_r054, "Only one tax total amount must be provided "
                      "where currency id equals tax currency code, if tax "
                      "currency code (BT-6) is provided.",
                      "ram:SpecifiedTradeSettlementHeaderMonetarySummation/"
                      "ram:TaxTotalAmount")
    return None


@_rule("PEPPOL-EN16931-R055")
def cii_r055(root):
    """PEPPOL-EN16931-R055 (CII): Invoice total VAT amount and Invoice total
    VAT amount in accounting currency MUST have the same operational sign.

    Context ram:ApplicableHeaderTradeSettlement; test ``not(<global
    TaxCurrencyCode> and …TaxTotalAmount[@currencyID = $documentCurrencyCode])
    or (…[@currencyID = $taxCurrencyCode] < 0 and …[@currencyID =
    $documentCurrencyCode] < 0) or (… >= 0 and … >= 0)``. General
    comparisons over node sequences (note the FIRST alternative is strict
    ``< 0`` in this binding); untyped values cast to xs:double, an uncastable
    amount is an official dynamic error (skip-and-hold)."""
    tcc = _cii_doc_currency_els(root, "TaxCurrencyCode")
    dcc = _cii_doc_currency_els(root, "InvoiceCurrencyCode")
    for st in root.iter("{%s}ApplicableHeaderTradeSettlement" % NS_RAM):
        doc_els = _cii_tax_totals_matching(st, dcc)
        if not (tcc and doc_els):
            continue
        tax_els = _cii_tax_totals_matching(st, tcc)
        tax_vals = [_dbl(_sv(e)) for e in tax_els]
        doc_vals = [_dbl(_sv(e)) for e in doc_els]
        if any(v is None for v in tax_vals + doc_vals):
            continue  # official dynamic error; see _dbl
        holds = ((any(v < 0 for v in tax_vals)
                  and any(v < 0 for v in doc_vals))
                 or (any(v >= 0 for v in tax_vals)
                     and any(v >= 0 for v in doc_vals)))
        if not holds:
            return _v(cii_r055, "Invoice total VAT amount and Invoice total "
                      "VAT amount in accounting currency MUST have the same "
                      "operational sign",
                      "ram:SpecifiedTradeSettlementHeaderMonetarySummation/"
                      "ram:TaxTotalAmount")
    return None


@_rule("PEPPOL-EN16931-R061")
def cii_r061(root):
    """PEPPOL-EN16931-R061 (CII): Mandate reference MUST be provided for
    direct debit.

    Context ``ram:SpecifiedTradeSettlementPaymentMeans[some $code in
    tokenize('49 59', '\\s') satisfies normalize-space(ram:TypeCode) =
    $code]``; test ``../ram:SpecifiedTradePaymentTerms/
    ram:DirectDebitMandateID`` (a sibling under the settlement). More than
    one ram:TypeCode makes the predicate's normalize-space() an official
    dynamic error (skip-and-hold)."""
    pmap = {c: p for p in root.iter() for c in p}
    for pm in root.iter("{%s}SpecifiedTradeSettlementPaymentMeans" % NS_RAM):
        codes = pm.findall("ram:TypeCode", NSC)
        if len(codes) != 1 or _nsp(_sv(codes[0])) not in ("49", "59"):
            continue
        parent = pmap.get(pm)
        if parent is None:
            continue
        if parent.find("ram:SpecifiedTradePaymentTerms/"
                       "ram:DirectDebitMandateID", NSC) is None:
            return _v(cii_r061, "Mandate reference MUST be provided for "
                      "direct debit.",
                      "ram:SpecifiedTradePaymentTerms/"
                      "ram:DirectDebitMandateID")
    return None


@_rule("PEPPOL-EN16931-R101")
def cii_r101(root):
    """PEPPOL-EN16931-R101 (CII): Element Additional referenced document can
    only be used for Invoice line object.

    Context ram:IncludedSupplyChainTradeLineItem; test
    ``(not(ram:SpecifiedLineTradeSettlement/ram:AdditionalReferencedDocument)
    or (…/ram:TypeCode='130'))`` — general comparison: holds when ANY line
    AdditionalReferencedDocument TypeCode's untrimmed string value is
    '130'."""
    for li in root.iter("{%s}IncludedSupplyChainTradeLineItem" % NS_RAM):
        ards = li.findall("ram:SpecifiedLineTradeSettlement/"
                          "ram:AdditionalReferencedDocument", NSC)
        if not ards:
            continue
        if not any(_sv(tc) == "130" for a in ards
                   for tc in a.findall("ram:TypeCode", NSC)):
            return _v(cii_r101, "Element Additional referenced document can "
                      "only be used for Invoice line object.",
                      "ram:SpecifiedLineTradeSettlement/"
                      "ram:AdditionalReferencedDocument/ram:TypeCode")
    return None


def _cii_line_period_check(root, which, cmp_ok):
    """Shared R110/R111 walk. Context ``rsm:SupplyChainTradeTransaction[
    ram:ApplicableHeaderTradeSettlement/ram:BillingSpecifiedPeriod/
    ram:<which>]/ram:IncludedSupplyChainTradeLineItem/
    ram:SpecifiedLineTradeSettlement/ram:BillingSpecifiedPeriod/ram:<which>``;
    test ``udt:DateTimeString >=|<= ../../../../ram:ApplicableHeaderTrade
    Settlement/ram:BillingSpecifiedPeriod/ram:<which>/udt:DateTimeString``.
    BOTH sides are untyped node sequences, so the general comparison is a
    STRING comparison (format-102 YYYYMMDD strings order chronologically);
    an empty side satisfies nothing -> fires."""
    for tx in root.findall("rsm:SupplyChainTradeTransaction", NSC):
        heads = tx.findall("ram:ApplicableHeaderTradeSettlement/"
                           "ram:BillingSpecifiedPeriod/ram:%s" % which, NSC)
        if not heads:
            continue  # context filter not satisfied
        head_vals = [_sv(s) for h in heads
                     for s in h.findall("udt:DateTimeString", NSC)]
        for li in tx.findall("ram:IncludedSupplyChainTradeLineItem", NSC):
            for dt in li.findall("ram:SpecifiedLineTradeSettlement/"
                                 "ram:BillingSpecifiedPeriod/ram:%s" % which,
                                 NSC):
                line_vals = [_sv(s)
                             for s in dt.findall("udt:DateTimeString", NSC)]
                if not any(cmp_ok(lv, hv) for lv in line_vals
                           for hv in head_vals):
                    return True
    return False


@_rule("PEPPOL-EN16931-R110")
def cii_r110(root):
    """PEPPOL-EN16931-R110 (CII): Start date of line period MUST be within
    invoice period. (Line StartDateTime string >= header StartDateTime
    string.)"""
    if _cii_line_period_check(root, "StartDateTime",
                              lambda line, head: line >= head):
        return _v(cii_r110, "Start date of line period MUST be within "
                  "invoice period.",
                  "ram:SpecifiedLineTradeSettlement/"
                  "ram:BillingSpecifiedPeriod/ram:StartDateTime/"
                  "udt:DateTimeString")
    return None


@_rule("PEPPOL-EN16931-R111")
def cii_r111(root):
    """PEPPOL-EN16931-R111 (CII): End date of line period MUST be within
    invoice period. (Line EndDateTime string <= header EndDateTime
    string.)"""
    if _cii_line_period_check(root, "EndDateTime",
                              lambda line, head: line <= head):
        return _v(cii_r111, "End date of line period MUST be within invoice "
                  "period.",
                  "ram:SpecifiedLineTradeSettlement/"
                  "ram:BillingSpecifiedPeriod/ram:EndDateTime/"
                  "udt:DateTimeString")
    return None


def _cii_single_dec(parent, path, default):
    """``if (<path>) then xs:decimal(<path>) else <default>`` — (found,
    value); value None = official dynamic error (multiple nodes or
    uncastable) -> hold."""
    els = parent.findall(path, NSC)
    if not els:
        return False, default
    if len(els) > 1:
        return True, None
    return True, _dec(_sv(els[0]))


def _cii_ac_sum(li, indicator):
    """``round(sum(ram:SpecifiedLineTradeSettlement/
    ram:SpecifiedTradeAllowanceCharge[normalize-space(ram:ChargeIndicator/
    udt:Indicator) = '<indicator>']/ram:ActualAmount/xs:decimal(.)) * 10 *
    10) div 100`` (0 when no such allowance/charge exists). None = official
    dynamic error."""
    matched = []
    for ac in li.findall("ram:SpecifiedLineTradeSettlement/"
                         "ram:SpecifiedTradeAllowanceCharge", NSC):
        inds = ac.findall("ram:ChargeIndicator/udt:Indicator", NSC)
        if len(inds) > 1:
            return None  # normalize-space(seq>1): official dynamic error
        ind = _nsp(_sv(inds[0])) if inds else ""
        if ind == indicator:
            matched.append(ac)
    if not matched:
        return Decimal(0)
    total = Decimal(0)
    for ac in matched:
        for amt in ac.findall("ram:ActualAmount", NSC):
            d = _dec(_sv(amt))
            if d is None:
                return None
            total += d
    return _fn_round(total * 100) / Decimal(100)


@_rule("PEPPOL-EN16931-R120", severity="warning")
def cii_r120(root):
    """PEPPOL-EN16931-R120 (CII): Invoice line net amount MUST equal (Invoiced
    quantity * (Item net price/item price base quantity) + Sum of invoice
    line charge amount - sum of invoice line allowance amount.

    Context ram:IncludedSupplyChainTradeLineItem; test ``u:slack(…)`` with
    the rule's lets: LineTotalAmount (else 0), BilledQuantity (else 1),
    NetPriceProductTradePrice/ram:ChargeAmount (else 0), and the FIRST
    non-zero of Net then Gross price BasisQuantity (else 1); the line
    allowance/charge totals are the fn:round-to-2-decimals sums of the
    indicated ram:ActualAmount casts. Flagged WARNING in the artifact."""
    slack = _slack_value(_cii_is_huf(root))
    for li in root.iter("{%s}IncludedSupplyChainTradeLineItem" % NS_RAM):
        _f, lea = _cii_single_dec(
            li, "ram:SpecifiedLineTradeSettlement/"
            "ram:SpecifiedTradeSettlementLineMonetarySummation/"
            "ram:LineTotalAmount", Decimal(0))
        _f, qty = _cii_single_dec(
            li, "ram:SpecifiedLineTradeDelivery/ram:BilledQuantity",
            Decimal(1))
        _f, price = _cii_single_dec(
            li, "ram:SpecifiedLineTradeAgreement/"
            "ram:NetPriceProductTradePrice/ram:ChargeAmount", Decimal(0))
        if None in (lea, qty, price):
            continue  # official dynamic error
        net_found, net_bq = _cii_single_dec(
            li, "ram:SpecifiedLineTradeAgreement/"
            "ram:NetPriceProductTradePrice/ram:BasisQuantity", Decimal(1))
        if net_found and net_bq is None:
            continue  # official dynamic error
        if net_found and net_bq != 0:
            bq = net_bq
        else:
            gross_found, gross_bq = _cii_single_dec(
                li, "ram:SpecifiedLineTradeAgreement/"
                "ram:GrossPriceProductTradePrice/ram:BasisQuantity",
                Decimal(1))
            if gross_found and gross_bq is None:
                continue  # official dynamic error
            bq = gross_bq if (gross_found and gross_bq != 0) else Decimal(1)
        allowances = _cii_ac_sum(li, "false")
        charges = _cii_ac_sum(li, "true")
        if allowances is None or charges is None:
            continue  # official dynamic error
        val = qty * (price / bq) + charges - allowances
        if not _slack_holds(lea, val, slack):
            return _v(cii_r120, "Invoice line net amount MUST equal "
                      "(Invoiced quantity * (Item net price/item price base "
                      "quantity) + Sum of invoice line charge amount - sum "
                      "of invoice line allowance amount",
                      "ram:SpecifiedTradeSettlementLineMonetarySummation/"
                      "ram:LineTotalAmount")
    return None


_CII_PRICE_TAGS = ("NetPriceProductTradePrice", "GrossPriceProductTradePrice")


@_rule("PEPPOL-EN16931-R121")
def cii_r121(root):
    """PEPPOL-EN16931-R121 (CII): Base quantity MUST be a positive number
    above zero.

    Context ``ram:NetPriceProductTradePrice |
    ram:GrossPriceProductTradePrice``; test ``not(ram:BasisQuantity) or
    xs:decimal(ram:BasisQuantity) > 0``."""
    for tag in _CII_PRICE_TAGS:
        for price in root.iter("{%s}%s" % (NS_RAM, tag)):
            bqs = price.findall("ram:BasisQuantity", NSC)
            if not bqs:
                continue
            if len(bqs) > 1:
                continue  # xs:decimal(seq>1): official dynamic error
            d = _dec(_sv(bqs[0]))
            if d is None:
                continue  # official dynamic error
            if not d > 0:
                return _v(cii_r121, "Base quantity MUST be a positive number "
                          "above zero.", "ram:%s/ram:BasisQuantity" % tag)
    return None


@_rule("PEPPOL-EN16931-R130")
def cii_r130(root):
    """PEPPOL-EN16931-R130 (CII): Unit code of price base quantity MUST be
    same as invoiced quantity.

    Context ``ram:NetPriceProductTradePrice/ram:BasisQuantity[@unitCode] |
    ram:GrossPriceProductTradePrice/ram:BasisQuantity[@unitCode]``; test
    ``@unitCode = ../../../ram:SpecifiedLineTradeDelivery/ram:BilledQuantity/
    @unitCode`` — general comparison against the line's BilledQuantity
    @unitCode attributes (empty -> false -> fires)."""
    pmap = {c: p for p in root.iter() for c in p}
    for tag in _CII_PRICE_TAGS:
        for price in root.iter("{%s}%s" % (NS_RAM, tag)):
            for bq in price.findall("ram:BasisQuantity", NSC):
                uc = bq.get("unitCode")
                if uc is None:
                    continue  # context requires @unitCode
                agreement = pmap.get(price)
                li = pmap.get(agreement) if agreement is not None else None
                unit_codes = []
                if li is not None:
                    unit_codes = [
                        q.get("unitCode") for q in li.findall(
                            "ram:SpecifiedLineTradeDelivery/"
                            "ram:BilledQuantity", NSC)]
                if not any(u == uc for u in unit_codes if u is not None):
                    return _v(cii_r130, "Unit code of price base quantity "
                              "MUST be same as invoiced quantity.",
                              "ram:%s/ram:BasisQuantity/@unitCode" % tag)
    return None


CII_RULES = [
    cii_r001, cii_r005, cii_r008, cii_r010, cii_r020,
    cii_r040, cii_r041, cii_r042, cii_r043_1, cii_r043_2, cii_r044, cii_r046,
    cii_r053, cii_r054, cii_r055, cii_r061, cii_r101,
    cii_r110, cii_r111, cii_r120, cii_r121, cii_r130,
]


def evaluate_cii(root):
    """Run the implemented KoSIT-vendored Peppol batch over a RAW parsed
    CrossIndustryInvoice root element. Returns the Violations that fire."""
    out = []
    for rule in CII_RULES:
        v = rule(root)
        if v is not None:
            out.append(v)
    return out


def canonical_ubl_rule_ids():
    """Canonical family ids implemented in the UBL binding."""
    return {fn.rule_id for fn in UBL_RULES}


def canonical_cii_rule_ids():
    """Canonical family ids implemented in the CII binding (R043's two CII
    asserts collapse onto the one canonical id)."""
    return {fn.rule_id for fn in CII_RULES}
