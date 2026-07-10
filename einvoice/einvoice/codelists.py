"""Pinned EN 16931 code-list value sets — extracted VERBATIM from the vendored
CEN Schematron, never enumerated from memory.

Each set below is the exact inline value string from the ``@test`` of the named
``<assert>`` in the vendored CEN artifact, split on whitespace. The sets are
built ONCE at import time (module-level) so the rule functions do only an
O(1) membership test per invocation.

Provenance (each file carries the header comment
``Licensed under European Union Public Licence (EUPL) version 1.2.``):

  * CURRENCY_CODES (ISO 4217 alpha-3) and ITEM_CLASS_LIST_CODES (UNTDID 7143):
    corpus/cen-en16931/ubl/schematron/codelist/EN16931-UBL-codes.sch
    (asserts BR-CL-03 and BR-CL-13). The CII file
    corpus/cen-en16931/cii/schematron/codelist/EN16931-CII-codes.sch inlines
    the IDENTICAL currency (BR-CL-03/04/05) and item-classification (BR-CL-13)
    value strings — verified equal at extraction time — so one pinned set each
    serves both syntaxes.

  * UBL_COUNTRY_CODES (ISO 3166-1 alpha-2):
    corpus/cen-en16931/ubl/schematron/codelist/EN16931-UBL-codes.sch
    (assert BR-CL-14, context cac:Country/cbc:IdentificationCode).

  * CII_COUNTRY_CODES (ISO 3166-1 alpha-2):
    corpus/cen-en16931/cii/schematron/codelist/EN16931-CII-codes.sch
    (assert BR-CL-14, context ram:CountryID).

  The two country lists are NOT identical: the UBL list carries ``SS`` (South
  Sudan) but not ``AN``; the CII list carries ``AN`` (Netherlands Antilles,
  withdrawn) but not ``SS``. They are pinned SEPARATELY and selected per syntax
  so each rule matches its own official Schematron exactly.

  * VAT_CATEGORY_CODES (UNCL 5305 EN 16931 subset — the VAT category codes):
    corpus/cen-en16931/ubl/schematron/codelist/EN16931-UBL-codes.sch
    (asserts BR-CL-17, context cac:TaxCategory/cbc:ID, and BR-CL-18, context
    cac:ClassifiedTaxCategory/cbc:ID). The CII file
    corpus/cen-en16931/cii/schematron/codelist/EN16931-CII-codes.sch inlines the
    IDENTICAL value string for its BR-CL-17 (ram:CategoryTradeTax/ram:CategoryCode)
    and BR-CL-18 (ram:ApplicableTradeTax/ram:CategoryCode) asserts — verified
    equal at extraction time — so ONE pinned set serves both rules and both
    syntaxes. NOTE the vendored set is the TEN-code EN 16931 subset
    ``AE L M E S Z G O K B`` (Standard S, Zero-rated Z, Exempt E, Reverse-charge
    AE, IntraCommunity K, Free-export G, Out-of-scope O, Canary L, Ceuta/Melilla
    M, and B for the Italian split-payment domestic case), NOT the full UNCL 5305
    list — extracted verbatim, never typed from memory.

  * VATEX_CODES (CEF VATEX VAT-exemption-reason code list):
    corpus/cen-en16931/ubl/schematron/codelist/EN16931-UBL-codes.sch
    (assert BR-CL-22, context cbc:TaxExemptionReasonCode) and the CII file's
    BR-CL-22 (context ram:ExemptionReasonCode). Both official asserts test
    ``normalize-space(upper-case(.))`` against the SAME 88-entry string (verified
    identical across the two syntaxes), so one pinned set serves both; the rule
    upper-cases the value before the membership test to mirror ``upper-case(.)``.
"""

from __future__ import annotations

# --- ISO 4217 alpha-3 currency codes (UBL/CII BR-CL-03/04/05) ---
_CURRENCY = (
    "AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB "
    "BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNH CNY COP "
    "COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL "
    "GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD "
    "JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD "
    "MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN "
    "NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF "
    "SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STD SVC SYP SZL THB TJS "
    "TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VES VED "
    "VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT "
    "XSU XTS XUA XXX YER ZAR ZMW ZWG "
)

# --- UNTDID 7143 item-classification list identifiers (UBL/CII BR-CL-13) ---
_ITEM_CLASS = (
    "AA AB AC AD AE AF AG AH AI AJ AK AL AM AN AO AP AQ AR AS AT AU AV AW "
    "AX AY AZ BA BB BC BD BE BF BG BH BI BJ BK BL BM BN BO BP BQ BR BS BT "
    "BU BV BW BX BY BZ CC CG CL CR CV DR DW EC EF EMD EN FS GB GN GMN GS HS "
    "IB IN IS IT IZ MA MF MN MP NB ON PD PL PO PPI PV QS RC RN RU RY SA SG "
    "SK SN SRS SRT SRU SRV SRW SRX SRY SRZ SS SSA SSB SSC SSD SSE SSF SSG "
    "SSH SSI SSJ SSK SSL SSM SSN SSO SSP SSQ SSR SSS SST SSU SSV SSW SSX "
    "SSY SSZ ST STA STB STC STD STE STF STG STH STI STJ STK STL STM STN STO "
    "STP STQ STR STS STT STU STV STW STX STY STZ SUA SUB SUC SUD SUE SUF "
    "SUG SUH SUI SUJ SUK SUL SUM TG TSN TSO TSP TSQ TSR TSS TST TSU UA UP "
    "VN VP VS VX ZZZ "
)

# --- ISO 3166-1 alpha-2 country codes, UBL binding (BR-CL-14; has SS, no AN) ---
_UBL_COUNTRY = (
    "1A AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG "
    "BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK "
    "CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES "
    "ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT "
    "GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP "
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA "
    "MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA "
    "NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS "
    "PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO "
    "SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ "
    "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XI YE YT ZA ZM ZW "
)

# --- ISO 3166-1 alpha-2 country codes, CII binding (BR-CL-14; has AN, no SS) ---
_CII_COUNTRY = (
    "1A AD AE AF AG AI AL AM AN AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF "
    "BG BH BI BL BJ BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI "
    "CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER "
    "ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS "
    "GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO "
    "JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY "
    "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ "
    "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR "
    "PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN "
    "SO SR ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ "
    "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XI YE YT ZA ZM ZW "
)

# --- UNCL 5305 EN 16931 VAT category codes (UBL/CII BR-CL-17 & BR-CL-18) ---
# Exact inline string of the BR-CL-17/18 asserts (order preserved verbatim).
_VAT_CATEGORY = "AE L M E S Z G O K B "

# --- CEF VATEX VAT-exemption-reason codes (UBL/CII BR-CL-22) ---
# Exact inline string of the BR-CL-22 assert; the rule upper-cases before test.
_VATEX = (
    "VATEX-EU-79-C VATEX-EU-132 VATEX-EU-132-1A VATEX-EU-132-1B VATEX-EU-132-1C VATEX-EU-132-1D "
    "VATEX-EU-132-1E VATEX-EU-132-1F VATEX-EU-132-1G VATEX-EU-132-1H VATEX-EU-132-1I VATEX-EU-132-1J "
    "VATEX-EU-132-1K VATEX-EU-132-1L VATEX-EU-132-1M VATEX-EU-132-1N VATEX-EU-132-1O VATEX-EU-132-1P "
    "VATEX-EU-132-1Q VATEX-EU-135-1 VATEX-EU-143 VATEX-EU-143-1A VATEX-EU-143-1B VATEX-EU-143-1C "
    "VATEX-EU-143-1D VATEX-EU-143-1E VATEX-EU-143-1F VATEX-EU-143-1FA VATEX-EU-143-1G VATEX-EU-143-1H "
    "VATEX-EU-143-1I VATEX-EU-143-1J VATEX-EU-143-1K VATEX-EU-143-1L VATEX-EU-144 VATEX-EU-146-1E "
    "VATEX-EU-159 VATEX-EU-309 VATEX-EU-148 VATEX-EU-148-A VATEX-EU-148-B VATEX-EU-148-C "
    "VATEX-EU-148-D VATEX-EU-148-E VATEX-EU-148-F VATEX-EU-148-G VATEX-EU-151 VATEX-EU-151-1A "
    "VATEX-EU-151-1AA VATEX-EU-151-1B VATEX-EU-151-1C VATEX-EU-151-1D VATEX-EU-151-1E VATEX-EU-G "
    "VATEX-EU-O VATEX-EU-IC VATEX-EU-AE VATEX-EU-D VATEX-EU-F VATEX-EU-I "
    "VATEX-EU-J VATEX-FR-FRANCHISE VATEX-FR-CNWVAT VATEX-EU-153 VATEX-FR-CGI261-1 VATEX-FR-CGI261-2 "
    "VATEX-FR-CGI261-3 VATEX-FR-CGI261-4 VATEX-FR-CGI261-5 VATEX-FR-CGI261-7 VATEX-FR-CGI261-8 VATEX-FR-CGI261A "
    "VATEX-FR-CGI261B VATEX-FR-CGI261C-1 VATEX-FR-CGI261C-2 VATEX-FR-CGI261C-3 VATEX-FR-CGI261D-1 VATEX-FR-CGI261D-1BIS "
    "VATEX-FR-CGI261D-2 VATEX-FR-CGI261D-3 VATEX-FR-CGI261D-4 VATEX-FR-CGI261E-1 VATEX-FR-CGI261E-2 VATEX-FR-CGI277A "
    "VATEX-FR-CGI275 VATEX-FR-298SEXDECIESA VATEX-FR-CGI295 VATEX-FR-AE "
)

CURRENCY_CODES = frozenset(_CURRENCY.split())
ITEM_CLASS_LIST_CODES = frozenset(_ITEM_CLASS.split())
UBL_COUNTRY_CODES = frozenset(_UBL_COUNTRY.split())
CII_COUNTRY_CODES = frozenset(_CII_COUNTRY.split())
VAT_CATEGORY_CODES = frozenset(_VAT_CATEGORY.split())
# VATEX codes are pinned already upper-cased (they are in the vendored string);
# the rule compares upper_case(value) so the set must be the upper-cased form.
VATEX_CODES = frozenset(_VATEX.split())

# Fail fast if an edit corrupts a pinned list (counts match the vendored .sch).
assert len(CURRENCY_CODES) == 178, len(CURRENCY_CODES)
assert len(ITEM_CLASS_LIST_CODES) == 185, len(ITEM_CLASS_LIST_CODES)
assert len(UBL_COUNTRY_CODES) == 251, len(UBL_COUNTRY_CODES)
assert len(CII_COUNTRY_CODES) == 251, len(CII_COUNTRY_CODES)
assert len(VAT_CATEGORY_CODES) == 10, len(VAT_CATEGORY_CODES)
assert len(VATEX_CODES) == 88, len(VATEX_CODES)
