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
# ``raw_id`` is the UN-normalized category-code text (whitespace preserved):
# BR-AF-04's official last disjunct gates on the RAW ``cbc:ID = 'L'`` node set
# (no normalize-space — an artifact quirk), so that rule must see it.
ItemTaxCategory = namedtuple("ItemTaxCategory",
                             ["id", "scheme_id", "percent", "raw_id"],
                             defaults=(None,))

# One cac:InvoicePeriod (BG-14 document level / BG-26 line level): the stripped
# StartDate/EndDate text, or None when the element is ABSENT ("" = present but
# empty — the official BR-29/BR-30 exists() tests distinguish the two).
Period = namedtuple("Period", ["start", "end"])

# One cac:PayeeParty (BG-10) — BR-17's context node. ``names``/``ids`` carry the
# RAW string values (xs:string atomization, no strip) of the payee's
# cac:PartyName/cbc:Name and cac:PartyIdentification/cbc:ID elements;
# ``seller_names``/``seller_ids`` the same node sets under the PARENT's
# ``cac:AccountingSupplierParty/cac:Party`` (the official test's ``..`` axis).
PayeeParty = namedtuple(
    "PayeeParty", ["names", "ids", "seller_names", "seller_ids"])

# One cac:TaxRepresentativeParty (BG-11) — BR-18/BR-19's context node.
# ``name`` = string value of the first cac:PartyName/cbc:Name (None = element
# absent); ``has_postal_address`` = exists(cac:PostalAddress).
TaxRepresentative = namedtuple(
    "TaxRepresentative", ["name", "has_postal_address"])

# One cac:PaymentMeans (BG-16) — BR-49/BR-50/BR-61's context subtree.
# ``has_code``    exists(cbc:PaymentMeansCode)                     (BR-49)
# ``code_norm``   normalize-space of the first code ('' if absent) (BR-61)
# ``codes_raw``   RAW string values of every code — BR-50's context predicate
#                 [cbc:PaymentMeansCode='30' or ...='58'] is a general
#                 comparison over the UNNORMALIZED string values
# ``has_account_id``    exists(cac:PayeeFinancialAccount/cbc:ID)   (BR-61)
# ``account_first_ids`` per cac:PayeeFinancialAccount child: string value of
#                 its first cbc:ID, or None when absent            (BR-50)
PaymentMeans = namedtuple(
    "PaymentMeans", ["has_code", "code_norm", "codes_raw",
                     "has_account_id", "account_first_ids"])

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


def _strval(el):
    """XPath string value of an element (ALL descendant text, unstripped).

    The official general comparisons (BR-17's name/id equality, BR-50's
    PaymentMeansCode context predicate) atomize the node to its full string
    value — no strip, no normalize-space — so those rules must see it raw.
    """
    return "".join(el.itertext())


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

    __slots__ = ("id", "quantity", "has_quantity_unit_code",
                 "line_extension_amount",
                 "line_extension_amount_raw", "price_amount",
                 "price_base_amounts", "periods",
                 "item_name", "tax_category_ids", "item_tax_categories",
                 "allowance_charges", "index")

    def __init__(self, index):
        self.index = index
        self.id = None                    # BT-126
        self.quantity = None              # BT-129 (text)
        # BT-130 Invoiced quantity unit of measure: does any quantity element
        # of the line CARRY a @unitCode attribute? (BR-23 is attribute
        # EXISTENCE on both bindings — an empty unitCode="" satisfies it.)
        self.has_quantity_unit_code = False
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
            _text(cat_el.find("cbc:Percent", NS)),
            _rawtext(cat_el.find("cbc:ID", NS))))
    ac.has_reason = (
        ac_el.find("cbc:AllowanceChargeReason", NS) is not None
        or ac_el.find("cbc:AllowanceChargeReasonCode", NS) is not None)
    return ac


def _build_period(period_el):
    """Parse one ``cac:InvoicePeriod`` into a :class:`Period` (None = absent)."""
    return Period(_text(period_el.find("cbc:StartDate", NS)),
                  _text(period_el.find("cbc:EndDate", NS)))


def _party_has_vat_company_id(party_el):
    """True iff ``party_el`` carries a ``cac:PartyTaxScheme`` whose
    ``cac:TaxScheme/cbc:ID`` normalizes to 'VAT' (case-insensitive) and which
    has a ``cbc:CompanyID`` child — the VAT-scoped party-id disjunct shared by
    BR-IC-02..04 (Seller BT-31 / Buyer BT-48). Returns False for a None party."""
    if party_el is None:
        return False
    for pts_el in party_el.findall("cac:PartyTaxScheme", NS):
        scheme = _norm_space(_text(pts_el.find("cac:TaxScheme/cbc:ID", NS)))
        if (scheme and scheme.upper() == "VAT"
                and pts_el.find("cbc:CompanyID", NS) is not None):
            return True
    return False


class Invoice:
    """Normalized first-slice model of a UBL Invoice."""

    def __init__(self):
        self.root_is_ubl_invoice = False
        # Syntax discriminator ("ubl" | "cii"): the codelist rules pick the
        # matching pinned country set (the UBL and CII BR-CL-14 lists differ).
        self.syntax = "ubl"
        # Header
        self.customization_id = None      # BT-24
        self.id = None                    # BT-1
        self.issue_date = None            # BT-2
        self.invoice_type_code = None     # BT-3
        self.document_currency_code = None  # BT-5
        self.tax_currency_code = None     # BT-6 (normalize-space; None = absent)
        self.buyer_reference = None       # BT-10
        # Code-list rule inputs (BR-CL-03/13/14). Each is a list of the
        # normalized string values at exactly the context nodes the official
        # codelist Schematron matches, populated per-syntax by build_model.
        #   amount_currency_ids  — @currencyID on the amount elements (BR-CL-03)
        #   item_class_list_ids  — @listID on item-classification codes (BR-CL-13)
        #   country_codes        — country identification codes (BR-CL-14)
        #   taxcategory_id_codes — VAT category codes at the BR-CL-17 context
        #       (distinct from ``vat_category_codes`` below, which is the
        #       VAT-scheme-scoped set the BR-AE/E/G/IC/O family rules use)
        #   classified_tax_category_codes — VAT category codes at BR-CL-18 context
        #   tax_exemption_reason_codes — VATEX reason codes (BR-CL-22),
        #       already UPPER-CASED to mirror the official ``upper-case(.)``
        self.amount_currency_ids = []
        self.item_class_list_ids = []
        self.country_codes = []
        self.taxcategory_id_codes = []
        self.classified_tax_category_codes = []
        self.tax_exemption_reason_codes = []
        #   unit_codes — measurement unit codes at the BR-CL-23 context nodes
        #       (UBL: cbc:InvoicedQuantity|cbc:BaseQuantity|cbc:CreditedQuantity
        #        with @unitCode; CII: ram:BasisQuantity|ram:BilledQuantity with
        #        @unitCode), normalize-space'd like the official assert
        self.unit_codes = []
        #   payment_means_codes — payment-means codes at the BR-CL-16 context
        #       (UBL: cac:PaymentMeans/cbc:PaymentMeansCode; CII:
        #        ram:SpecifiedTradeSettlementPaymentMeans/ram:TypeCode),
        #        normalize-space'd like the official UNCL 4461 assert
        self.payment_means_codes = []
        #   allowance_reason_codes / charge_reason_codes — coded allowance/charge
        #       reason codes at the BR-CL-19 / BR-CL-20 contexts (the
        #       AllowanceCharge is split by its ChargeIndicator: false ->
        #       allowance/BR-CL-19, true -> charge/BR-CL-20). The context pattern
        #       matches an AllowanceCharge at ANY depth, so these carry the reason
        #       codes of BOTH document- and line-level allowances/charges.
        #       (UBL: cbc:AllowanceChargeReasonCode; CII: ram:ReasonCode)
        self.allowance_reason_codes = []
        self.charge_reason_codes = []
        #   item_std_id_scheme_ids — item standard-identifier @schemeID at the
        #       BR-CL-21 context (UBL: cac:StandardItemIdentification/cbc:ID
        #       @schemeID; CII: ram:SpecifiedTradeProduct/ram:GlobalID @schemeID),
        #       tested against the ISO 6523 ICD list
        self.item_std_id_scheme_ids = []
        #   mime_codes — attachment @mimeCode at the BR-CL-24 context (UBL:
        #       cbc:EmbeddedDocumentBinaryObject[@mimeCode]; CII:
        #       ram:AttachmentBinaryObject[@mimeCode]). Kept RAW (the official
        #       assert is a direct string equality, not a normalize-space'd list).
        self.mime_codes = []
        # Parties
        self.seller_name = None           # BT-27
        self.seller_has_postal_address = False  # BG-5
        self.seller_country_code = None   # BT-40 (normalize-space; None = no addr)
        # exists(//AccountingSupplierParty/Party/PartyTaxScheme/CompanyID) —
        # the Seller VAT/tax-registration id (BT-31/BT-32). NOTE: the official
        # BR-S-02/03/04 seller test is SCHEME-AGNOSTIC (any PartyTaxScheme with
        # a CompanyID satisfies it, not only the VAT one).
        self.seller_has_party_tax_scheme_company_id = False
        # exists(//AccountingSupplierParty/Party/PartyTaxScheme[VAT]/CompanyID) —
        # the VAT-scheme-SCOPED Seller VAT identifier (BT-31). The reverse-charge
        # rules BR-AE-02..04 accept the scheme-agnostic seller id above, but the
        # intra-community rules BR-IC-02..04 require the VAT scheme explicitly.
        self.seller_has_vat_scheme_company_id = False
        # exists(//TaxRepresentativeParty/PartyTaxScheme[VAT]/CompanyID) —
        # the Seller tax representative VAT id (BT-63); VAT scheme IS required
        # here, unlike the seller test above.
        self.taxrep_has_vat_company_id = False
        self.buyer_name = None            # BT-44
        self.buyer_has_postal_address = False  # BG-8
        self.buyer_country_code = None    # BT-55 (normalize-space; None = no addr)
        # exists(//AccountingCustomerParty/Party/PartyTaxScheme[VAT]/CompanyID) —
        # the Buyer VAT identifier (BT-48). Required by BR-AE-02..04 (as one
        # disjunct) and BR-IC-02..04.
        self.buyer_has_vat_scheme_company_id = False
        # exists(//AccountingCustomerParty/Party/PartyLegalEntity/CompanyID) —
        # the Buyer legal registration identifier (BT-47), the other disjunct of
        # the BR-AE-02..04 buyer test.
        self.buyer_has_legal_entity_company_id = False
        # Per Seller/Buyer cbc:EndpointID element (BT-34/BT-49): does it carry
        # a @schemeID attribute? — BR-62/BR-63 (attribute EXISTENCE; empty ok).
        self.seller_endpoints = []        # list[bool]
        self.buyer_endpoints = []         # list[bool]
        # Payee (BG-10): one entry per cac:PayeeParty anywhere — BR-17.
        self.payee_parties = []           # list[PayeeParty]
        # Seller tax representative (BG-11): one entry per
        # cac:TaxRepresentativeParty anywhere — BR-18/BR-19.
        self.tax_representatives = []     # list[TaxRepresentative]
        # Per cac:TaxRepresentativeParty/cac:PostalAddress (BG-12): string value
        # of the first cac:Country/cbc:IdentificationCode (None = absent) — BR-20.
        self.taxrep_postal_addresses = []  # list[str|None]
        # Payment instructions (BG-16): one entry per cac:PaymentMeans anywhere
        # — BR-49/BR-50/BR-61.
        self.payment_means = []           # list[PaymentMeans]
        # Card information (BT-87): string value of every cac:PaymentMeans/
        # cac:CardAccount/cbc:PrimaryAccountNumberID — BR-51.
        self.card_pans = []               # list[str]
        # Preceding invoice references (BG-3): per cac:BillingReference anywhere,
        # exists(cac:InvoiceDocumentReference/cbc:ID) — BR-55.
        self.billing_references = []      # list[bool]
        # Deliver-to addresses (BG-15): per cac:Delivery/cac:DeliveryLocation/
        # cac:Address anywhere, exists(cac:Country/cbc:IdentificationCode) — BR-57.
        self.delivery_addresses = []      # list[bool]
        # Document-level Delivery (BG-13, a direct child of the Invoice) facts
        # consumed by the intra-community rules BR-IC-11/BR-IC-12. RAW string
        # values (no normalize-space — the official tests use string-length()
        # over the literal string value), or None when the element is absent:
        #  * cac:Delivery/cbc:ActualDeliveryDate                (BT-72), and
        #  * cac:Delivery/cac:DeliveryLocation/cac:Address/
        #      cac:Country/cbc:IdentificationCode               (BT-80).
        self.doc_delivery_actual_date_raw = None
        self.doc_delivery_country_code_raw = None
        # exists(cac:InvoicePeriod/*) at the Invoice level — a document-level
        # Invoicing period (BG-14) carrying at least one child element (BR-IC-11).
        self.doc_invoice_period_has_child = False
        # --- Batch: BR-23/52/53/54/56/64/65/CO-03/CO-09/CO-19 extraction ----
        # BR-52: one entry per Additional supporting document group (BG-24 —
        # UBL cac:AdditionalDocumentReference / CII ram:AdditionalReferenced
        # Document, any depth): the normalize-space'd string value of its FIRST
        # document-reference child (UBL cbc:ID / CII ram:IssuerAssignedID), ''
        # when that child is absent — both official tests are
        # ``normalize-space(<ref>) != ''``.
        self.supporting_doc_refs = []      # list[str]
        # BR-53: RAW string values of the VAT accounting currency code (BT-6)
        # at the official BR-53 context (UBL: /Invoice/cbc:TaxCurrencyCode;
        # CII: .../ApplicableHeaderTradeSettlement/ram:TaxCurrencyCode). RAW —
        # the official comparisons atomize the untyped node without
        # normalize-space (unlike ``tax_currency_code`` above, which mirrors
        # BR-CL-05's normalize-space'd test).
        self.tax_currency_codes_raw = []   # list[str]
        # BR-53 (UBL leg): raw @currencyID of every //cac:TaxTotal/cbc:TaxAmount
        # that CARRIES the attribute — the official existence test is
        # ``exists(//cac:TaxTotal/cbc:TaxAmount[@currencyID=$taxcurrency])``.
        self.taxtotal_amount_currencies = []  # list[str]
        # BR-53 (CII leg): per header monetary summation (the CII BR-53 context
        # node), the raw @currencyID of its ram:TaxTotalAmount children; plus
        # the raw InvoiceCurrencyCode values the CII test's third conjunct
        # compares against. Both stay [] on the UBL side.
        self.cii_summation_taxtotal_currencies = []  # list[list[str]]
        self.cii_invoice_currency_codes_raw = []     # list[str]
        # BR-54: one (has_name, has_value) pair per Item attribute group
        # (BG-32 — UBL //cac:AdditionalItemProperty / CII
        # //ram:ApplicableProductCharacteristic); both official tests are pure
        # child-element existence.
        self.item_attributes = []          # list[(bool, bool)]
        # BR-56: one bool per Seller tax representative party (BG-11): does it
        # carry a usable VAT identifier (BT-63)? UBL = exists(VAT-scheme
        # cac:PartyTaxScheme/cbc:CompanyID) (pure existence); CII =
        # normalize-space(ram:SpecifiedTaxRegistration/ram:ID[@schemeID='VA'])
        # != '' (non-empty required) — each parser bakes ITS binding's
        # semantics into the bool.
        self.taxrep_vat_ids_ok = []        # list[bool]
        # BR-64 / BR-65: one bool per Item standard identifier (BT-157) /
        # Item classification identifier (BT-158) context node — True when the
        # identifier carries its scheme per that syntax's official test
        # (UBL: exists(@schemeID) / exists(@listID), empty attribute ok;
        # CII: normalize-space of the attribute != '', per line/classification
        # group with the not(exists(...)) guard applied by the parser).
        self.item_std_ids_scheme_ok = []   # list[bool]
        self.item_class_ids_scheme_ok = []  # list[bool]
        # BR-CO-03: existence of the Value added tax point date (BT-7) and the
        # VAT point date code (BT-8) at the official context nodes
        # (UBL: /Invoice/cbc:TaxPointDate + cac:InvoicePeriod/cbc:DescriptionCode;
        # CII: //ram:TaxPointDate + //ram:DueDateTypeCode).
        self.has_tax_point_date = False
        self.has_tax_point_date_code = False
        # BR-CO-09: the raw first-two-characters (XPath substring(., 1, 2) /
        # substring(cbc:CompanyID, 1, 2)) of each VAT identifier at the
        # official context (UBL: //cac:PartyTaxScheme[VAT]/cbc:CompanyID;
        # CII: //ram:SpecifiedTaxRegistration/ram:ID[@schemeID='VA']); '' when
        # the UBL CompanyID child is absent (substring of the empty sequence).
        self.vat_id_prefixes = []          # list[str]
        # BR-CO-19: one bool per document-level Invoicing period (BG-14): True
        # when the period is "filled" per that syntax's official test (UBL:
        # exists StartDate/EndDate/DescriptionCode; CII: StartDateTime or
        # EndDateTime present).
        self.invoice_period_filled = []    # list[bool]
        # BR-CO-20: one bool per Invoice line period (BG-26) context node —
        # True when the period carries a start or an end date (UBL:
        # exists(cbc:StartDate) or exists(cbc:EndDate) per
        # cac:InvoiceLine/cac:InvoicePeriod; CII: (ram:StartDateTime) or
        # (ram:EndDateTime) per //ram:SpecifiedLineTradeSettlement/
        # ram:BillingSpecifiedPeriod). Existence only; empty elements count.
        self.line_period_filled = []       # list[bool]
        # BR-CO-26: one bool per Seller party context node — True when the
        # seller is identifiable per that syntax's official disjuncts (UBL,
        # per cac:AccountingSupplierParty: a VAT-scheme PartyTaxScheme
        # CompanyID, a non-SEPA PartyIdentification/ID, or a PartyLegalEntity
        # CompanyID; CII, per //ram:SellerTradeParty: ram:ID, ram:GlobalID,
        # SpecifiedLegalOrganization/ram:ID, or a raw @schemeID='VA'
        # SpecifiedTaxRegistration/ram:ID).
        self.seller_identification_ok = []  # list[bool]
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
    inv.tax_currency_code = _norm_space(_text(root.find("cbc:TaxCurrencyCode", NS)))
    inv.buyer_reference = _text(root.find("cbc:BuyerReference", NS))

    # --- Code-list rule inputs (BR-CL-03/13/14) ---------------------------- #
    # BR-CL-03 context = each monetary amount element; the rule tests its
    # @currencyID (an ABSENT @currencyID normalize-spaces to '' and fails the
    # official assert, so a missing attribute is recorded as '' to fire too).
    _AMOUNT_TAGS = (
        "Amount", "BaseAmount", "PriceAmount", "TaxAmount", "TaxableAmount",
        "LineExtensionAmount", "TaxExclusiveAmount", "TaxInclusiveAmount",
        "AllowanceTotalAmount", "ChargeTotalAmount", "PrepaidAmount",
        "PayableRoundingAmount", "PayableAmount",
    )
    inv.amount_currency_ids = [
        _norm_space(el.get("currencyID")) or ""
        for tag in _AMOUNT_TAGS
        for el in root.findall(".//cbc:%s" % tag, NS)
    ]
    # BR-CL-13 context = cac:CommodityClassification/cbc:ItemClassificationCode
    # with a @listID (the [@listID] predicate); the rule tests that @listID.
    inv.item_class_list_ids = [
        _norm_space(el.get("listID"))
        for el in root.findall(
            ".//cac:CommodityClassification/cbc:ItemClassificationCode", NS)
        if el.get("listID") is not None
    ]
    # BR-CL-14 context = cac:Country/cbc:IdentificationCode (postal-address
    # countries: seller/buyer/deliver-to/tax-representative/payee). NOT
    # cac:OriginCountry (that is BR-CL-15). The rule tests each code's value.
    inv.country_codes = [
        _norm_space(_strval(el)) or ""
        for el in root.findall(".//cac:Country/cbc:IdentificationCode", NS)
    ]
    # BR-CL-17 context = cac:TaxCategory/cbc:ID (UBL) — the VAT breakdown
    # category (cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory) AND every
    # document/line allowance-charge tax category (cac:AllowanceCharge/
    # cac:TaxCategory). The rule tests each such ID against UNCL 5305.
    inv.taxcategory_id_codes = [
        _norm_space(_strval(el)) or ""
        for el in root.findall(".//cac:TaxCategory/cbc:ID", NS)
    ]
    # BR-CL-18 context = cac:ClassifiedTaxCategory/cbc:ID (UBL) — the line
    # item VAT category (cac:Item/cac:ClassifiedTaxCategory). Same code set.
    inv.classified_tax_category_codes = [
        _norm_space(_strval(el)) or ""
        for el in root.findall(".//cac:ClassifiedTaxCategory/cbc:ID", NS)
    ]
    # BR-CL-22 context = cbc:TaxExemptionReasonCode (UBL). The official assert
    # tests normalize-space(upper-case(.)) against the VATEX list, so the value
    # is stored UPPER-CASED here (the ' '-in-value check is upper-case-invariant).
    inv.tax_exemption_reason_codes = [
        (_norm_space(_strval(el)) or "").upper()
        for el in root.findall(".//cbc:TaxExemptionReasonCode", NS)
    ]
    # BR-CL-23 context (UBL) = cbc:InvoicedQuantity[@unitCode] |
    # cbc:BaseQuantity[@unitCode] | cbc:CreditedQuantity[@unitCode] — the
    # [@unitCode] predicate means only elements carrying that attribute are
    # context nodes; the rule tests normalize-space(@unitCode) against the
    # UN/ECE Rec 20 + Rec 21 unit-code list. (BaseQuantity here is the item
    # price base quantity BT-149; InvoicedQuantity is BT-129; CreditedQuantity
    # is the credit-note line quantity.)
    inv.unit_codes = [
        _norm_space(el.get("unitCode")) or ""
        for tag in ("InvoicedQuantity", "BaseQuantity", "CreditedQuantity")
        for el in root.findall(".//cbc:%s" % tag, NS)
        if el.get("unitCode") is not None
    ]
    # BR-CL-16 context = cac:PaymentMeans/cbc:PaymentMeansCode (UBL). The rule
    # tests normalize-space(.) against the UNCL 4461 payment-means list.
    inv.payment_means_codes = [
        _norm_space(_strval(el)) or ""
        for el in root.findall(".//cac:PaymentMeans/cbc:PaymentMeansCode", NS)
    ]
    # BR-CL-19 / BR-CL-20 context = cac:AllowanceCharge split by
    # cbc:ChargeIndicator: false() -> allowance reason (UNCL 5189, BR-CL-19),
    # true() -> charge reason (UNCL 7161, BR-CL-20). The pattern matches an
    # AllowanceCharge at ANY depth, so document- AND line-level are both covered.
    # An AllowanceCharge whose ChargeIndicator is neither true/1 nor false/0 is
    # in NEITHER context (matches the official xs:boolean cast), so its reason
    # code fires neither rule.
    for ac_el in root.findall(".//cac:AllowanceCharge", NS):
        ind = _norm_space(_text(ac_el.find("cbc:ChargeIndicator", NS)))
        codes = [_norm_space(_strval(el)) or ""
                 for el in ac_el.findall("cbc:AllowanceChargeReasonCode", NS)]
        if ind in ("true", "1"):
            inv.charge_reason_codes.extend(codes)
        elif ind in ("false", "0"):
            inv.allowance_reason_codes.extend(codes)
    # BR-CL-21 context = cac:StandardItemIdentification/cbc:ID[@schemeID] (UBL);
    # only elements CARRYING @schemeID are context nodes. The rule tests
    # normalize-space(@schemeID) against the ISO 6523 ICD list.
    inv.item_std_id_scheme_ids = [
        _norm_space(el.get("schemeID"))
        for el in root.findall(
            ".//cac:StandardItemIdentification/cbc:ID", NS)
        if el.get("schemeID") is not None
    ]
    # BR-CL-24 context = cbc:EmbeddedDocumentBinaryObject[@mimeCode] (UBL). The
    # official assert is a direct equality of the RAW @mimeCode against the six
    # MIME literals, so the value is kept raw (no normalize-space).
    inv.mime_codes = [
        el.get("mimeCode")
        for el in root.findall(".//cbc:EmbeddedDocumentBinaryObject", NS)
        if el.get("mimeCode") is not None
    ]

    # --- BR-23/52/53/54/64/65/CO-03/CO-09/CO-19 context extraction (UBL) --- #
    # BR-52 context = cac:AdditionalDocumentReference (a match pattern — any
    # depth; in UBL 2.1 Invoice they are document-level). Test:
    # ``normalize-space(cbc:ID) != ''`` over the FIRST cbc:ID child.
    for adr_el in root.iter("{%s}AdditionalDocumentReference" % NS_CAC):
        id_el = adr_el.find("cbc:ID", NS)
        inv.supporting_doc_refs.append(
            _norm_space(_strval(id_el)) if id_el is not None else "")
    # BR-53 (UBL): ``every $taxcurrency in cbc:TaxCurrencyCode satisfies
    # exists(//cac:TaxTotal/cbc:TaxAmount[@currencyID=$taxcurrency])`` —
    # context /Invoice, RAW string values on both sides of the comparison.
    inv.tax_currency_codes_raw = [
        _strval(el) for el in root.findall("cbc:TaxCurrencyCode", NS)]
    inv.taxtotal_amount_currencies = [
        el.get("currencyID")
        for el in root.findall(".//cac:TaxTotal/cbc:TaxAmount", NS)
        if el.get("currencyID") is not None]
    # BR-54 context = //cac:AdditionalItemProperty (BG-32). Test:
    # ``exists(cbc:Name) and exists(cbc:Value)`` — pure existence.
    for aip_el in root.iter("{%s}AdditionalItemProperty" % NS_CAC):
        inv.item_attributes.append(
            (aip_el.find("cbc:Name", NS) is not None,
             aip_el.find("cbc:Value", NS) is not None))
    # BR-64 context = cac:InvoiceLine/cac:Item/cac:StandardItemIdentification/
    # cbc:ID. Test: ``exists(@schemeID)`` — attribute existence (empty ok).
    inv.item_std_ids_scheme_ok = [
        "schemeID" in el.attrib
        for el in root.findall(
            ".//cac:InvoiceLine/cac:Item/"
            "cac:StandardItemIdentification/cbc:ID", NS)]
    # BR-65 context = cac:InvoiceLine/cac:Item/cac:CommodityClassification/
    # cbc:ItemClassificationCode. Test: ``exists(@listID)``.
    inv.item_class_ids_scheme_ok = [
        "listID" in el.attrib
        for el in root.findall(
            ".//cac:InvoiceLine/cac:Item/"
            "cac:CommodityClassification/cbc:ItemClassificationCode", NS)]
    # BR-CO-03 (UBL, context /Invoice): fires iff BOTH exist —
    # ``cbc:TaxPointDate`` (BT-7) and the document-level
    # ``cac:InvoicePeriod/cbc:DescriptionCode`` (BT-8).
    inv.has_tax_point_date = root.find("cbc:TaxPointDate", NS) is not None
    inv.has_tax_point_date_code = (
        root.find("cac:InvoicePeriod/cbc:DescriptionCode", NS) is not None)
    # BR-CO-09 context = //cac:PartyTaxScheme[cac:TaxScheme/
    # normalize-space(upper-case(cbc:ID))='VAT']. The tested value is
    # ``substring(cbc:CompanyID, 1, 2)`` — the RAW first two characters of the
    # first CompanyID child ('' when absent: substring of the empty sequence).
    for pts_el in root.iter("{%s}PartyTaxScheme" % NS_CAC):
        scheme_el = pts_el.find("cac:TaxScheme/cbc:ID", NS)
        scheme = (_norm_space(_strval(scheme_el).upper())
                  if scheme_el is not None else None)
        if scheme != "VAT":
            continue
        cid_el = pts_el.find("cbc:CompanyID", NS)
        inv.vat_id_prefixes.append(
            _strval(cid_el)[:2] if cid_el is not None else "")
    # BR-CO-26 context = cac:AccountingSupplierParty (a match pattern — any
    # depth). Test (three disjuncts): a VAT-scheme PartyTaxScheme CompanyID
    # (BT-31), a PartyIdentification/ID whose RAW @schemeID is not 'SEPA'
    # (BT-29 — an ID with no @schemeID counts: not(() = 'SEPA') is true), or
    # a PartyLegalEntity CompanyID (BT-30). Pure existence on each.
    for asp_el in root.iter("{%s}AccountingSupplierParty" % NS_CAC):
        party_el = asp_el.find("cac:Party", NS)
        ok = False
        if party_el is not None:
            ok = (_party_has_vat_company_id(party_el)
                  or any(id_el.get("schemeID") != "SEPA"
                         for id_el in party_el.findall(
                             "cac:PartyIdentification/cbc:ID", NS))
                  or party_el.find(
                      "cac:PartyLegalEntity/cbc:CompanyID", NS) is not None)
        inv.seller_identification_ok.append(ok)

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
        # exists(cac:PartyTaxScheme[VAT]/cbc:CompanyID) — VAT-scoped (BR-IC-02..04).
        inv.seller_has_vat_scheme_company_id = _party_has_vat_company_id(supplier)
        # BR-62: per Seller cbc:EndpointID, exists(@schemeID).
        inv.seller_endpoints = [
            "schemeID" in el.attrib
            for el in supplier.findall("cbc:EndpointID", NS)]

    # TaxRepresentativeParty (anywhere — BG-11, the BR-18/BR-19 context):
    # capture the representative's name + postal address facts, its postal
    # addresses' country codes (BR-20), and whether a VAT-scheme PartyTaxScheme
    # with a CompanyID exists (the seller disjunct of BR-S-02..04).
    for trp_el in root.iter("{%s}TaxRepresentativeParty" % NS_CAC):
        for pts_el in trp_el.findall("cac:PartyTaxScheme", NS):
            scheme = _norm_space(_text(pts_el.find("cac:TaxScheme/cbc:ID", NS)))
            if (scheme and scheme.upper() == "VAT"
                    and pts_el.find("cbc:CompanyID", NS) is not None):
                inv.taxrep_has_vat_company_id = True
                break
        # BR-56 (UBL test, per representative party): exists(cac:PartyTaxScheme
        # [VAT scheme]/cbc:CompanyID) — pure existence, empty CompanyID ok.
        inv.taxrep_vat_ids_ok.append(_party_has_vat_company_id(trp_el))
        name_el = trp_el.find("cac:PartyName/cbc:Name", NS)
        inv.tax_representatives.append(TaxRepresentative(
            _strval(name_el) if name_el is not None else None,
            trp_el.find("cac:PostalAddress", NS) is not None))
        for pa_el in trp_el.findall("cac:PostalAddress", NS):
            cc_el = pa_el.find("cac:Country/cbc:IdentificationCode", NS)
            inv.taxrep_postal_addresses.append(
                _strval(cc_el) if cc_el is not None else None)

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
        # BT-48 (VAT-scoped) and BT-47 (legal registration id) — the two buyer
        # disjuncts of BR-AE-02..04 / BR-IC-02..04.
        inv.buyer_has_vat_scheme_company_id = _party_has_vat_company_id(customer)
        inv.buyer_has_legal_entity_company_id = (
            customer.find("cac:PartyLegalEntity/cbc:CompanyID", NS) is not None)
        # BR-63: per Buyer cbc:EndpointID, exists(@schemeID).
        inv.buyer_endpoints = [
            "schemeID" in el.attrib
            for el in customer.findall("cbc:EndpointID", NS)]

    # Payee (BG-10) — BR-17's context is ``cac:PayeeParty`` (a pattern match:
    # any depth). Its test reads the SELLER party via the parent axis (``..``),
    # so seller names/ids are gathered relative to each PayeeParty's parent.
    _payee_tag = "{%s}PayeeParty" % NS_CAC
    for parent in root.iter():
        for el in parent:
            if el.tag != _payee_tag:
                continue
            inv.payee_parties.append(PayeeParty(
                [_strval(e) for e in el.findall("cac:PartyName/cbc:Name", NS)],
                [_strval(e) for e in el.findall(
                    "cac:PartyIdentification/cbc:ID", NS)],
                [_strval(e) for e in parent.findall(
                    "cac:AccountingSupplierParty/cac:Party/"
                    "cac:PartyName/cbc:Name", NS)],
                [_strval(e) for e in parent.findall(
                    "cac:AccountingSupplierParty/cac:Party/"
                    "cac:PartyIdentification/cbc:ID", NS)]))

    # Payment instructions (BG-16) — BR-49/BR-50/BR-51/BR-61 contexts.
    for pm_el in root.iter("{%s}PaymentMeans" % NS_CAC):
        code_els = pm_el.findall("cbc:PaymentMeansCode", NS)
        codes_raw = [_strval(e) for e in code_els]
        account_first_ids = []
        for acct_el in pm_el.findall("cac:PayeeFinancialAccount", NS):
            id_el = acct_el.find("cbc:ID", NS)
            account_first_ids.append(
                _strval(id_el) if id_el is not None else None)
        inv.payment_means.append(PaymentMeans(
            bool(code_els),
            _norm_space(codes_raw[0]) if codes_raw else "",
            codes_raw,
            pm_el.find("cac:PayeeFinancialAccount/cbc:ID", NS) is not None,
            account_first_ids))
        for pan_el in pm_el.findall(
                "cac:CardAccount/cbc:PrimaryAccountNumberID", NS):
            inv.card_pans.append(_strval(pan_el))

    # Preceding invoice references (BG-3) — BR-55's context is
    # ``cac:BillingReference`` (any depth; UBL also allows line-level ones).
    for br_el in root.iter("{%s}BillingReference" % NS_CAC):
        inv.billing_references.append(
            br_el.find("cac:InvoiceDocumentReference/cbc:ID", NS) is not None)

    # Deliver-to addresses (BG-15) — BR-57's context is
    # ``cac:Delivery/cac:DeliveryLocation/cac:Address`` (any depth; line-level
    # Delivery groups match the pattern too).
    for d_el in root.iter("{%s}Delivery" % NS_CAC):
        for addr_el in d_el.findall("cac:DeliveryLocation/cac:Address", NS):
            inv.delivery_addresses.append(
                addr_el.find("cac:Country/cbc:IdentificationCode", NS)
                is not None)

    # Document-level Delivery (BG-13, direct child of the Invoice) — the BR-IC-11
    # actual-delivery-date (BT-72) and BR-IC-12 deliver-to country code (BT-80)
    # are read relative to /ubl:Invoice, so only the FIRST such Delivery counts.
    doc_delivery = root.find("cac:Delivery", NS)
    if doc_delivery is not None:
        add_el = doc_delivery.find("cbc:ActualDeliveryDate", NS)
        if add_el is not None:
            inv.doc_delivery_actual_date_raw = _strval(add_el)
        cc_el = doc_delivery.find(
            "cac:DeliveryLocation/cac:Address/cac:Country/cbc:IdentificationCode",
            NS)
        if cc_el is not None:
            inv.doc_delivery_country_code_raw = _strval(cc_el)

    # exists(cac:InvoicePeriod/*) at the Invoice level — a document-level
    # Invoicing period carrying at least one child element (BR-IC-11's second
    # disjunct). Only direct children of the Invoice qualify.
    inv.doc_invoice_period_has_child = any(
        len(p_el) > 0 for p_el in root.findall("cac:InvoicePeriod", NS))

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
                # BR-CO-19 (UBL test, same context node set as BR-29):
                # exists(cbc:StartDate) or exists(cbc:EndDate)
                #   or (exists(cbc:DescriptionCode) and not(StartDate) and
                #       not(EndDate))
                # — logically equivalent to "any of the three exists".
                inv.invoice_period_filled.append(
                    el.find("cbc:StartDate", NS) is not None
                    or el.find("cbc:EndDate", NS) is not None
                    or el.find("cbc:DescriptionCode", NS) is not None)

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
        # BR-23 (UBL test, per line): exists(cbc:InvoicedQuantity/@unitCode)
        # or exists(cbc:CreditedQuantity/@unitCode) — attribute existence.
        ln.has_quantity_unit_code = any(
            q_el.get("unitCode") is not None
            for tag in ("InvoicedQuantity", "CreditedQuantity")
            for q_el in ln_el.findall("cbc:%s" % tag, NS))
        lea_el = ln_el.find("cbc:LineExtensionAmount", NS)
        ln.line_extension_amount = _text(lea_el)
        ln.line_extension_amount_raw = _rawtext(lea_el)
        ln.price_amount = _text(ln_el.find("cac:Price/cbc:PriceAmount", NS))
        ln.price_base_amounts = [
            _text(el) for el in ln_el.findall(
                "cac:Price/cac:AllowanceCharge/cbc:BaseAmount", NS)]
        for period_el in ln_el.findall("cac:InvoicePeriod", NS):
            ln.periods.append(_build_period(period_el))
            # BR-CO-20 (UBL test, context = each line cac:InvoicePeriod):
            # exists(cbc:StartDate) or exists(cbc:EndDate) — existence, so a
            # present-but-empty date element ('' in the Period) satisfies it.
            inv.line_period_filled.append(
                period_el.find("cbc:StartDate", NS) is not None
                or period_el.find("cbc:EndDate", NS) is not None)
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
                _text(cat_el.find("cbc:Percent", NS)),
                _rawtext(cat_el.find("cbc:ID", NS))))
        # Invoice line allowance/charge (BG-27/BG-28) — the official context is
        # //cac:InvoiceLine/cac:AllowanceCharge, i.e. AllowanceCharge children of
        # the line (UBL InvoiceLines are direct children of the Invoice root).
        for ac_el in ln_el.findall("cac:AllowanceCharge", NS):
            ln.allowance_charges.append(_build_allowance_charge(ac_el))
        inv.lines.append(ln)

    return inv
