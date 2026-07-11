"""PEPPOL-EN16931-R* rules — the Peppol-derived layer KoSIT ships INSIDE the
official XRechnung Schematron artifact.

Scope honesty (read this first): the KoSIT XRechnung Schematron
(``corpus/xrechnung-schematron/schematron/{ubl,cii}/…``, v2.5.0 / XRechnung
3.0.2) vendors a subset of the Peppol BIS Billing 3.0 rule family — 21
``PEPPOL-EN16931-R*`` canonical rule ids per binding — inside its
``peppol-*-pattern`` patterns. This module implements the FIRST BATCH of that
KoSIT-vendored family (R001, R005, R008, R010, R020, R040, R041, R042, R043,
R044, R046), transcribed assert-by-assert from those vendored artifacts and
differential-proven against the compiled official XSLTs by ``differential.py``
(the KoSIT-UBL and KoSIT-CII legs). It is **NOT** full Peppol BIS Billing 3.0
support: the OpenPeppol ruleset proper (its own Schematron + test corpus) is a
separate, not-vendored artifact, and no rule here is claimed beyond what the
KoSIT artifact carries. The rest of the vendored family is tracked as an
explicit known-open worklist in ``coverage_matrix.json``
(``peppol_kosit_family``), recomputed live by ``test_coverage_gap.py``.

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
where prose and XPath could be read differently, the XPath wins. All eleven
rules are flagged ``fatal`` in both vendored artifacts.

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


def _rule(rule_id, assert_id=None):
    """All PEPPOL-EN16931-R* asserts in the vendored artifacts are fatal."""
    def deco(fn):
        fn.rule_id = rule_id
        fn.assert_id = assert_id or rule_id
        fn.severity = "fatal"
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


UBL_RULES = [
    ubl_r001, ubl_r005, ubl_r008, ubl_r010, ubl_r020,
    ubl_r040, ubl_r041, ubl_r042, ubl_r043, ubl_r044, ubl_r046,
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


CII_RULES = [
    cii_r001, cii_r005, cii_r008, cii_r010, cii_r020,
    cii_r040, cii_r041, cii_r042, cii_r043_1, cii_r043_2, cii_r044, cii_r046,
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
