#!/usr/bin/env python3
"""conformance.py — run einvoice.py over EVERY vendored corpus vector and prove
the honest coverage numbers.

For every vector in ``corpus/vendored/`` this harness drives the *real* CLI
(``einvoice.py``) end-to-end as a subprocess and asserts:

  * every VALID vector            -> exit 0 (no false positive)
  * every COVERED INVALID vector  -> exit 1 AND the EXPECTED rule id is reported
                                     (correct detection, not just "some failure")
  * vectors whose expected rule is NOT-yet-implemented -> OUT-OF-SCOPE
                                     (counted, never failed)

The invalid vectors are Difi/VEFA ``<testSet>`` documents: each wraps several
``<test>`` blocks, and every block embeds a *minimal* ``<Invoice>`` fragment plus
an assertion — ``<error>RULE</error>`` (the fragment MUST fail RULE) or
``<success>RULE</success>`` (the fragment MUST pass RULE). We exercise every
embedded block, so the invalid corpus contributes far more assertions than files.

HARD FAILS (surfaced loudly, non-zero exit):
  * FALSE POSITIVE   — a valid vector, or a ``<success>`` fragment, gets its rule
                       flagged (a clean invoice rejected).
  * MISSED DETECTION — an ``<error>`` fragment for an implemented rule is not
                       caught at all (validator says valid).
  * WRONG RULE ID    — an ``<error>`` fragment fails, but the EXPECTED rule is not
                       among the reported violations.

Standard library only. Reads only ``corpus/vendored/``; runs only under the
einvoice project. Temp fragment files are written to an auto-deleted temp dir.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET


# --------------------------------------------------------------------------- #
# OPT-IN corpus sharding (default OFF — byte-identical output when unset).
# --------------------------------------------------------------------------- #
# Each conformance vector file is graded independently (a file's fragments are
# all driven together), so partitioning the valid/invalid file lists by a stable
# md5 of the filename partitions the hard-fails; summing the per-shard hard-fail
# counts reproduces the whole-corpus total exactly. ``prove.py`` uses this to run
# the corpus across CPU cores as independent subprocesses so the reproduce
# entrypoint fits the gate time budget WITHOUT weakening the check (every vector
# is still graded once, in exactly one shard; a shard only ever exercises a
# SUBSET of rule ids, so the coverage-matrix "undocumented rule fired" guard can
# never false-positive on a shard). When ``CONF_SHARD`` is unset the file lists
# are returned unchanged, so an ordinary ``python3 conformance.py`` gate run is
# byte-identical.
def _maybe_shard_files(files):
    spec = os.environ.get("CONF_SHARD")
    if not spec:
        return files
    i_str, _, n_str = spec.partition("/")
    i, n = int(i_str), int(n_str)
    if n <= 1:
        return files
    if not (0 <= i < n):
        raise ValueError("CONF_SHARD out of range: %r" % spec)
    return [f for f in files
            if int(hashlib.md5(f.encode("utf-8")).hexdigest(), 16) % n == i]

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "einvoice.py")
RULES_SRC = os.path.join(HERE, "einvoice", "rules.py")
XR_RULES_SRC = os.path.join(HERE, "einvoice", "rules_xrechnung.py")
VENDORED = os.path.join(HERE, "corpus", "vendored")
VALID_DIR = os.path.join(VENDORED, "valid")
INVALID_DIR = os.path.join(VENDORED, "invalid")
MANIFEST = os.path.join(VENDORED, "MANIFEST.tsv")

DIFI_NS = "http://difi.no/xsd/vefa/validator/1.0"
INVOICE_NS = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"

EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE = 0, 1, 2, 3


# --------------------------------------------------------------------------- #
# What does the validator actually implement?  (source of truth = rules.py)   #
# --------------------------------------------------------------------------- #
def implemented_rule_ids():
    src = open(RULES_SRC, encoding="utf-8").read()
    return set(re.findall(r'Violation\(\s*["\']([A-Z0-9-]+)["\']', src))


IMPLEMENTED = implemented_rule_ids()


# --------------------------------------------------------------------------- #
# Explicit calculation / rounding coverage manifest (EN 16931 document-level    #
# arithmetic invariants — T-VH.7/8/9/10 batches).                              #
#                                                                              #
# Each id below is asserted by einvoice/rules.py as a PURE ARITHMETIC INVARIANT #
# over the parsed UBL model AND proven equivalent to the official CEN           #
# Schematron across the differential corpus (differential.py green). It is      #
# listed here explicitly — independent of the auto-derived ``IMPLEMENTED`` set  #
# — so the coverage of the calculation/rounding family is auditable (and        #
# grep-able) at a glance. The consistency assert below guarantees the manifest  #
# can never claim a rule the validator does not actually implement.            #
#                                                                              #
# Rounding convention: EN 16931 monetary totals round to 2 decimals with the    #
# official ``round(x * 10 * 10) div 100`` idiom = fn:round() (halves toward     #
# +infinity), NOT banker's rounding; BR-CO-17 additionally allows a ±1-unit     #
# tolerance band on the per-category VAT amount (as the normative artifact      #
# does). See the rule docstrings in einvoice/rules.py for the exact per-rule    #
# transcription.                                                               #
CALCULATION_ROUNDING_COVERAGE = {
    "BR-CO-10": "Sum of Invoice line net amount (BT-106) = Σ line net (BT-131)",
    "BR-CO-11": "Sum of document allowances (BT-107) = Σ allowance amount (BT-92)",
    "BR-CO-12": "Sum of document charges (BT-108) = Σ charge amount (BT-99)",
    "BR-CO-13": "Total without VAT (BT-109) = line-net − allowances + charges",
    "BR-CO-14": "Total VAT (BT-110) = Σ VAT category tax amount (BT-117)",
    "BR-CO-15": "Total with VAT (BT-112) = total without VAT + total VAT",
    "BR-CO-16": "Amount due (BT-115) = total with VAT − paid + rounding",
    "BR-CO-17": "VAT category tax = taxable × rate/100 (rounded, ±1 tolerance)",
    # BR-DEC decimal-places rules for these monetary totals (max 2 decimals):
    "BR-DEC-09": "≤2 decimals: Sum of Invoice line net amount (BT-106)",
    "BR-DEC-10": "≤2 decimals: Sum of allowances on document level (BT-107)",
    "BR-DEC-11": "≤2 decimals: Sum of charges on document level (BT-108)",
    "BR-DEC-12": "≤2 decimals: Invoice total amount without VAT (BT-109)",
    "BR-DEC-14": "≤2 decimals: Invoice total amount with VAT (BT-112)",
    "BR-DEC-16": "≤2 decimals: Paid amount (BT-113)",
    "BR-DEC-17": "≤2 decimals: Rounding amount (BT-114)",
    "BR-DEC-18": "≤2 decimals: Amount due for payment (BT-115)",
    "BR-DEC-19": "≤2 decimals: VAT category taxable amount (BT-116)",
    "BR-DEC-20": "≤2 decimals: VAT category tax amount (BT-117)",
}

# BR-DEC-13 (BT-110, Invoice total VAT amount) and BR-DEC-15 (BT-111, VAT amount
# in accounting currency) are DELIBERATELY NOT asserted. In the vendored,
# normative CEN Schematron their test is
#
#     (//cac:TaxTotal/cbc:TaxAmount[@currencyID = cbc:DocumentCurrencyCode] and
#       string-length(substring-after(…,'.')) <= 2)
#     or not(//cac:TaxTotal/cbc:TaxAmount[@currencyID = cbc:DocumentCurrencyCode])
#
# where the predicate ``cbc:DocumentCurrencyCode`` (resp. ``cbc:TaxCurrencyCode``
# for BR-DEC-15) is a CHILD of the TaxAmount context node — an element that never
# exists there — so the predicate is always false, the selected node-set is
# always empty, and the assert ALWAYS HOLDS (it can never fire). Verified
# empirically against the official XSLT: a top-level VAT TaxAmount carrying three
# decimals in the document currency still produces NO BR-DEC-13 failed-assert.
# Implementing them as active 2-decimal checks would therefore be a FALSE
# POSITIVE against the legal artifact (the differential would go red); the only
# faithful transcription is a no-op, which has no violating test case. They are
# recorded here as a known-vacuous defect in the normative Schematron rather than
# shipped as an approximation.
CALCULATION_ROUNDING_VACUOUS = {
    "BR-DEC-13": "vacuous in official Schematron (predicate references a "
                 "non-existent child of cbc:TaxAmount) — never fires",
    "BR-DEC-15": "vacuous in official Schematron (same defect, TaxCurrencyCode) "
                 "— never fires",
}

# --------------------------------------------------------------------------- #
# XRechnung EXTENSION (BR-DEX-*) coverage manifest.                            #
#                                                                             #
# The KoSIT XRechnung Extension customization adds fourteen business rules on  #
# top of the CIUS (BR-DE-*) layer. Each is implemented in                      #
# einvoice/rules_xrechnung.py, gated behind the extension CustomizationID, and #
# proven equivalent to the official compiled KoSIT XSLT across the differential #
# corpus (differential.py, XRechnung leg, green — targeted mutations off the   #
# clean extension fixture business-cases/extension/04.02a). Listed here so the #
# extension coverage is auditable and grep-able; the assert below guarantees   #
# the manifest can never claim a rule the validator does not actually emit.    #
XRECHNUNG_EXTENSION_COVERAGE = {
    "BR-DEX-01": "Attached Document (BT-125) MIME code within the Extension set "
                 "(EN 8.2 list + application/xml)",
    "BR-DEX-02": "Invoice/sub line net amount (BT-131) = Σ nested sub-line net "
                 "amounts (warning)",
    "BR-DEX-03": "each SUB INVOICE LINE (BG-DEX-01) carries exactly one VAT "
                 "information (BG-DEX-06)",
    "BR-DEX-04": "Party identification scheme id (ISO 6523 ICD, or SEPA for "
                 "Seller/Payee)",
    "BR-DEX-05": "Legal registration id scheme (BT-30/BT-47) ISO 6523 ICD",
    "BR-DEX-06": "Item standard id scheme (BT-157) ISO 6523 ICD",
    "BR-DEX-07": "Endpoint id scheme (BT-34/BT-49) in the CEF EAS code list",
    "BR-DEX-08": "Deliver-to location id scheme (BT-71) ISO 6523 ICD",
    "BR-DEX-09": "Amount due (BT-115) = with-VAT − paid + rounding + Σ third "
                 "party payment amount (BT-DEX-002)",
    "BR-DEX-10": "Third party payment type (BT-DEX-001) present with BG-DEX-09",
    "BR-DEX-11": "Third party payment amount (BT-DEX-002) present with BG-DEX-09",
    "BR-DEX-12": "Third party payment description (BT-DEX-003) present with "
                 "BG-DEX-09",
    "BR-DEX-13": "Third party payment amount (BT-DEX-002) ≤ 2 decimal places",
    "BR-DEX-14": "Third party payment amount currency = Invoice currency (BT-5)",
}


def xrechnung_extension_rule_ids():
    """Rule ids the XRechnung layer actually emits (the @_rule('ID', …)
    decorators in einvoice/rules_xrechnung.py)."""
    src = open(XR_RULES_SRC, encoding="utf-8").read()
    return set(re.findall(r'@_rule\(\s*["\']([A-Z0-9-]+)["\']', src))


_XR_IMPLEMENTED = xrechnung_extension_rule_ids()

# The manifest may only claim BR-DEX rules the validator actually implements.
assert XRECHNUNG_EXTENSION_COVERAGE.keys() <= _XR_IMPLEMENTED, (
    "XRechnung extension coverage manifest names unimplemented rules: %s"
    % sorted(XRECHNUNG_EXTENSION_COVERAGE.keys() - _XR_IMPLEMENTED))
# All fourteen extension rules must be listed.
assert XRECHNUNG_EXTENSION_COVERAGE.keys() >= {
    "BR-DEX-%02d" % i for i in range(1, 15)}, (
    "XRechnung extension coverage manifest is missing BR-DEX ids")


# --------------------------------------------------------------------------- #
# German CIUS (BR-DE-*) coverage manifest.                                    #
#                                                                             #
# The KoSIT XRechnung CIUS (Core Invoice Usage Specification) narrows EN 16931 #
# for the German e-invoicing mandate: it is what makes a document a valid      #
# XRechnung on top of the European core. Every BR-DE-* rule below is           #
# implemented in einvoice/rules_xrechnung.py, unit-tested in test_xrechnung.py, #
# and proven equivalent to the official KoSIT XRechnung-UBL Schematron across   #
# the differential corpus (differential.py, CIUS leg, green). Severities match  #
# the normative artifact: 'fatal' errors reject the invoice, 'warning'/         #
# 'information' rules are advisory and never block. Listed here so the German   #
# CIUS coverage is auditable and grep-able at a glance — the exact machine-      #
# readable "which BR-DE rules run in your CI" differentiator. The consistency    #
# assert below guarantees this manifest can never silently drift from the        #
# @_rule decorators the validator actually registers.                          #
XRECHNUNG_CIUS_COVERAGE = {
    "BR-DE-1": "PAYMENT INSTRUCTIONS (BG-16) must be present (fatal)",
    "BR-DE-2": "SELLER CONTACT (BG-6) must be present (fatal)",
    "BR-DE-3": "Seller city (BT-37) must be present (fatal)",
    "BR-DE-4": "Seller post code (BT-38) must be present (fatal)",
    "BR-DE-5": "Seller contact point / name (BT-41) must be present (fatal)",
    "BR-DE-6": "Seller contact telephone number (BT-42) must be present (fatal)",
    "BR-DE-7": "Seller contact email address (BT-43) must be present (fatal)",
    "BR-DE-8": "Buyer city (BT-52) must be present (fatal)",
    "BR-DE-9": "Buyer post code (BT-53) must be present (fatal)",
    "BR-DE-10": "Deliver-to city (BT-77) required when DELIVER TO ADDRESS "
                "(BG-15) is present (fatal)",
    "BR-DE-11": "Deliver-to post code (BT-78) required when DELIVER TO ADDRESS "
                "(BG-15) is present (fatal)",
    "BR-DE-14": "VAT category rate (BT-119) present in every VAT breakdown row "
                "(fatal)",
    "BR-DE-15": "Buyer reference (BT-10) must be present (fatal)",
    "BR-DE-16": "with VAT category S/Z/E/AE/K/G/L/M, one of Seller VAT id "
                "(BT-31), tax registration id (BT-32) or SELLER TAX "
                "REPRESENTATIVE (BG-11) is required (fatal)",
    "BR-DE-17": "Invoice/credit-note type code (BT-3) within the XRechnung "
                "UNTDID 1001 subset 326/380/384/389/381/875/876/877 (warning)",
    "BR-DE-18": "Skonto entries in Payment terms (BT-20) follow the "
                "#SKONTO#TAGE=…#PROZENT=…# grammar with a trailing newline "
                "(fatal)",
    "BR-DE-19": "Payment account id (BT-84) is a valid IBAN when payment means "
                "code is 58 (SEPA credit transfer) (warning)",
    "BR-DE-20": "Debited account id (BT-91) is a valid IBAN when payment means "
                "code is 59 (SEPA direct debit) (warning)",
    "BR-DE-21": "Specification identifier (BT-24) matches an XRechnung "
                "CustomizationID (CIUS, extension or CVD) (warning)",
    "BR-DE-22": "EmbeddedDocumentBinaryObject filenames are unique across all "
                "attachments (fatal)",
    "BR-DE-23-a": "payment means code 30/58 requires CREDIT TRANSFER (BG-17) "
                  "(fatal)",
    "BR-DE-23-b": "payment means code 30/58 forbids PAYMENT CARD (BG-18) and "
                  "DIRECT DEBIT (BG-19) (fatal)",
    "BR-DE-24-a": "payment means code 48/54/55 requires PAYMENT CARD "
                  "INFORMATION (BG-18) (fatal)",
    "BR-DE-24-b": "payment means code 48/54/55 forbids CREDIT TRANSFER (BG-17) "
                  "and DIRECT DEBIT (BG-19) (fatal)",
    "BR-DE-25-a": "payment means code 59 requires DIRECT DEBIT (BG-19) (fatal)",
    "BR-DE-25-b": "payment means code 59 forbids CREDIT TRANSFER (BG-17) and "
                  "PAYMENT CARD (BG-18) (fatal)",
    "BR-DE-26": "type code 384 (Corrected invoice) should carry a PRECEDING "
                "INVOICE REFERENCE (BG-3) (warning)",
    "BR-DE-27": "Seller contact telephone (BT-42) should contain at least "
                "three digits (warning)",
    "BR-DE-28": "Seller contact email (BT-43) should look like an email "
                "address — exactly one '@' with valid flanks (warning)",
    "BR-DE-30": "DIRECT DEBIT (BG-19) requires the Bank assigned creditor "
                "identifier (BT-90, SEPA-scheme party id) (fatal)",
    "BR-DE-31": "DIRECT DEBIT (BG-19) requires the Debited account identifier "
                "(BT-91) (fatal)",
    "BR-DE-TMP-32": "invoice should state the delivery/service date via BT-72, "
                    "an Invoicing period (BG-14) or a per-line period (BG-26) "
                    "(information)",
    # Clean-Vehicle-Directive profile (gated behind the CVD CustomizationID).
    "BR-DE-CVD-01": "CVD invoice: Contract reference (BT-12) must be present "
                    "(fatal)",
    "BR-DE-CVD-02": "CVD invoice: Tender or lot reference (BT-17) must be "
                    "present (fatal)",
    "BR-DE-CVD-03": "CVD invoice: at least one line with a BT-158 scheme id "
                    "'CVD' AND a BT-160 item attribute 'cva' (fatal)",
    "BR-DE-CVD-04": "CVD invoice: a BT-158 with scheme id 'CVD' carries a "
                    "vehicle category M1/M2/M3/N1/N2/N3 (fatal)",
    "BR-DE-CVD-05": "CVD invoice: a 'cva' item attribute value (BT-161) is "
                    "'clean', 'zero-emission' or 'other' (fatal)",
    "BR-DE-CVD-06-a": "CVD invoice: a line with a 'CVD' BT-158 carries exactly "
                      "one 'cva' item attribute (fatal)",
    "BR-DE-CVD-06-b": "CVD invoice: a line with a 'cva' item attribute carries "
                      "exactly one 'CVD' BT-158 (fatal)",
}

# Temporary (BR-TMP-*) national rules — same KoSIT artifacts, ids outside the
# BR-DE- prefix. BR-TMP-3 exists ONLY in the CII binding (the vendored UBL
# artifact carries no such assert), so it is asserted on the CII layer only.
XRECHNUNG_TMP_COVERAGE = {
    "BR-TMP-2": "External document location (BT-124) is an absolute URL with "
                "a valid scheme (warning)",
    "BR-TMP-CVD-01": "CVD invoice: every BT-158 scheme identifier comes from "
                     "UNTDID 7143 (+ 'CVD') (fatal)",
    "BR-TMP-3": "gross/net Item price base quantity (BT-149) and unit "
                "(BT-150) are consistent — CII-only assert (fatal)",
}


def xrechnung_cius_rule_ids():
    """The German CIUS rule ids the XRechnung layer actually registers — the
    ``@_rule('BR-DE-…', …)`` decorators in einvoice/rules_xrechnung.py. The
    charset is broader than the BR-DEX extractor above because CIUS ids carry
    lowercase branch suffixes (e.g. BR-DE-23-a)."""
    src = open(XR_RULES_SRC, encoding="utf-8").read()
    ids = set(re.findall(r'@_rule\(\s*["\']([A-Za-z0-9-]+)["\']', src))
    return {rid for rid in ids if rid.startswith("BR-DE-")}


def xrechnung_tmp_rule_ids():
    """The temporary (BR-TMP-*) national rule ids registered in
    einvoice/rules_xrechnung.py — same ``@_rule`` scrape as the CIUS set. The
    scrape covers BOTH the UBL and the CII registries (BR-TMP-3 is registered
    on the CII layer only)."""
    src = open(XR_RULES_SRC, encoding="utf-8").read()
    ids = set(re.findall(r'@_rule\(\s*["\']([A-Za-z0-9-]+)["\']', src))
    return {rid for rid in ids if rid.startswith("BR-TMP-")}


_XR_CIUS_IMPLEMENTED = xrechnung_cius_rule_ids()
_XR_TMP_IMPLEMENTED = xrechnung_tmp_rule_ids()

# The CIUS manifest must match the implemented BR-DE rule set EXACTLY (in both
# directions) so it can never silently drift from the code: no manifest entry
# for a rule the validator does not register, and no registered BR-DE rule left
# undocumented.
assert XRECHNUNG_CIUS_COVERAGE.keys() == _XR_CIUS_IMPLEMENTED, (
    "XRechnung CIUS coverage manifest drifted from rules_xrechnung.py — "
    "manifest-only: %s ; code-only: %s"
    % (sorted(XRECHNUNG_CIUS_COVERAGE.keys() - _XR_CIUS_IMPLEMENTED),
       sorted(_XR_CIUS_IMPLEMENTED - XRECHNUNG_CIUS_COVERAGE.keys())))
# Same exact-match guarantee for the temporary (BR-TMP-*) manifest.
assert XRECHNUNG_TMP_COVERAGE.keys() == _XR_TMP_IMPLEMENTED, (
    "XRechnung TMP coverage manifest drifted from rules_xrechnung.py — "
    "manifest-only: %s ; code-only: %s"
    % (sorted(XRECHNUNG_TMP_COVERAGE.keys() - _XR_TMP_IMPLEMENTED),
       sorted(_XR_TMP_IMPLEMENTED - XRECHNUNG_TMP_COVERAGE.keys())))


# --------------------------------------------------------------------------- #
# CII-syntax (CrossIndustryInvoice) coverage manifest.                          #
#                                                                              #
# The SAME einvoice/rules.py core rule FUNCTIONS are run — unchanged — over the  #
# CII-normalized model (einvoice/parser_cii.build_model) and differentially      #
# proven equivalent to the official CEN EN16931-CII Schematron across the CII    #
# corpus (``differential.py cii`` green: 0 divergences). This manifest records   #
# which core rules reach that CII parity (auditable + grep-able), and which are  #
# deliberately NOT graded on CII because their CII Schematron binding differs     #
# from the UBL one (grading them under the unmodified UBL function would ship a   #
# divergence — see differential.CII_EXCLUDED_RULE_IDS for the per-rule reason).  #
# The single source of truth is differential.CII_GRADED_RULES; the assert below  #
# guarantees this manifest can never silently drift from that graded set.        #
CII_SYNTAX_COVERAGE = {
    "BR-01": "Specification identifier (BT-24) present",
    "BR-02": "Invoice number (BT-1) present",
    "BR-03": "Invoice issue date (BT-2) present",
    "BR-04": "Invoice type code (BT-3) present",
    "BR-05": "Invoice currency code (BT-5) present",
    "BR-06": "Seller name (BT-27) present",
    "BR-07": "Buyer name (BT-44) present",
    "BR-08": "Seller postal address (BG-5) present",
    "BR-09": "Seller country code (BT-40) present (CII binding: evaluated "
             "from the document root, even without a postal address)",
    "BR-10": "Buyer postal address (BG-8) present",
    "BR-11": "Buyer country code (BT-55) present (CII binding: evaluated "
             "from the document root, even without a postal address)",
    "BR-12": "Sum of Invoice line net amount (BT-106) present",
    "BR-13": "Invoice total without VAT (BT-109) present",
    "BR-14": "Invoice total with VAT (BT-112) present",
    "BR-15": "Amount due for payment (BT-115) present",
    "BR-16": "At least one Invoice line (BG-25)",
    "BR-17": "Payee name (BT-59) present when a Payee (BG-10) is given, and "
             "the Payee differs from the Seller (CII adds a legal-"
             "registration-id comparison)",
    "BR-18": "Seller tax representative name (BT-62) present when a "
             "representative (BG-11) is given",
    "BR-19": "Seller tax representative postal address (BG-12) present",
    "BR-20": "Tax representative country code (BT-69) present (CII binding: "
             "evaluated per party, even without a postal address)",
    "BR-21": "Invoice line identifier (BT-126) present",
    "BR-22": "Invoiced quantity (BT-129) present",
    "BR-23": "Invoiced quantity unit of measure code (BT-130) present",
    "BR-24": "Invoice line net amount (BT-131) present",
    "BR-25": "Item name (BT-153) present",
    "BR-26": "Item net price (BT-146) present",
    "BR-27": "Item net price (BT-146) not negative",
    "BR-28": "Item gross price (BT-148) not negative",
    "BR-29": "Invoicing period (BG-14) end date (BT-74) ≥ start date (BT-73)",
    "BR-30": "Invoice line period (BG-26) end date (BT-135) ≥ start date "
             "(BT-134)",
    "BR-31": "Document level allowance (BG-20) has an amount (BT-92)",
    "BR-32": "Document level allowance (BG-20) has a VAT category code "
             "(BT-95)",
    "BR-33": "Document level allowance (BG-20) has a reason (BT-97) or "
             "reason code (BT-98)",
    "BR-36": "Document level charge (BG-21) has an amount (BT-99)",
    "BR-37": "Document level charge (BG-21) has a VAT category code (BT-102)",
    "BR-38": "Document level charge (BG-21) has a reason (BT-104) or reason "
             "code (BT-105)",
    "BR-41": "Invoice line allowance (BG-27) has an amount (BT-136)",
    "BR-42": "Invoice line allowance (BG-27) has a reason (BT-139) or "
             "reason code (BT-140)",
    "BR-43": "Invoice line charge (BG-28) has an amount (BT-141)",
    "BR-44": "Invoice line charge (BG-28) has a reason (BT-144) or reason "
             "code (BT-145)",
    "BR-49": "Payment instruction (BG-16) has a payment means type code "
             "(BT-81)",
    "BR-50": "Credit-transfer account identifier (BT-84) non-empty",
    "BR-51": "Payment card number (BT-87) truncated to ≤10 characters",
    "BR-55": "Preceding invoice reference (BG-3) has a reference (BT-25) "
             "(CII binding: non-empty required)",
    "BR-57": "Deliver-to address (BG-15) has a country code (BT-80) (CII "
             "binding: one verdict per header trade delivery)",
    "BR-61": "Credit-transfer payment means has an account identifier "
             "(BT-84) (CII binding: per account group — a means with no "
             "account group fires nothing)",
    "BR-62": "Seller electronic address (BT-34) has a scheme identifier "
             "(CII binding: non-empty @schemeID on the first "
             "URIUniversalCommunication)",
    "BR-63": "Buyer electronic address (BT-49) has a scheme identifier "
             "(CII binding: non-empty @schemeID on the first "
             "URIUniversalCommunication)",
    "BR-AE-01": "Reverse charge (AE) categories ⇒ exactly one AE VAT "
                "breakdown row (CII binding: raw, VAT-scheme-unscoped "
                "counts; an orphan AE breakdown row fires)",
    "BR-AE-02": "Reverse charge (AE) line ⇒ Seller VAT/tax id AND Buyer "
                "VAT/legal registration id present",
    "BR-AE-03": "Reverse charge (AE) document allowance ⇒ Seller VAT/tax id "
                "AND Buyer VAT/legal registration id present",
    "BR-AE-04": "Reverse charge (AE) document charge ⇒ Seller VAT/tax id "
                "AND Buyer VAT/legal registration id present",
    "BR-AE-05": "Reverse charge (AE) line VAT rate (BT-152) = 0",
    "BR-AE-06": "Reverse charge (AE) document allowance VAT rate (BT-96) = 0",
    "BR-AE-07": "Reverse charge (AE) document charge VAT rate (BT-103) = 0",
    "BR-AE-08": "Reverse charge (AE) breakdown taxable (BT-116) = Σ AE line "
                "net + charges − allowances (CII binding: ±1 band around "
                "the round2 bucket sums)",
    "BR-AE-09": "Reverse charge (AE) breakdown tax amount (BT-117) = 0",
    "BR-AE-10": "Reverse charge (AE) breakdown has a VAT exemption reason "
                "code (BT-121) or text (BT-120)",
    "BR-IC-01": "Intra-community supply (K) categories ⇒ exactly one K VAT "
                "breakdown row (CII binding: raw, VAT-scheme-unscoped "
                "counts; an orphan K breakdown row fires)",
    "BR-IC-02": "Intra-community (K) line ⇒ Seller VAT id (BT-31) or tax-"
                "representative VAT id (BT-63) AND Buyer VAT id (BT-48) "
                "present (all VA-scoped — no FC / legal-org fallback)",
    "BR-IC-03": "Intra-community (K) document allowance ⇒ Seller VAT id or "
                "tax-representative VAT id AND Buyer VAT id present",
    "BR-IC-04": "Intra-community (K) document charge ⇒ Seller VAT id or "
                "tax-representative VAT id AND Buyer VAT id present",
    "BR-IC-05": "Intra-community (K) line VAT rate (BT-152) = 0",
    "BR-IC-06": "Intra-community (K) document allowance VAT rate (BT-96) = 0",
    "BR-IC-07": "Intra-community (K) document charge VAT rate (BT-103) = 0",
    "BR-IC-08": "Intra-community (K) breakdown taxable (BT-116) = Σ K line "
                "net + charges − allowances (CII binding: ±1 band around "
                "the round2 bucket sums)",
    "BR-IC-09": "Intra-community (K) breakdown tax amount (BT-117) = 0",
    "BR-IC-11": "Intra-community (K) breakdown ⇒ actual delivery date "
                "(BT-72) or invoicing period (BG-14) present (CII binding: "
                "pure node existence — a delivery DateTimeString or a "
                "billing-period Start/EndDateTime child)",
    "BR-IC-12": "Intra-community (K) breakdown ⇒ deliver-to country code "
                "(BT-80) present (CII binding: pure node existence of the "
                "ship-to PostalTradeAddress/CountryID)",
    "BR-O-01": "Not subject to VAT (O) breakdown row ⇒ exactly one such row "
               "AND an O item present (CII binding: not(header-O-rows) "
               "first disjunct — an O item with NO O header row officially "
               "holds, unlike UBL and every other -01 head)",
    "BR-O-02": "Not subject to VAT (O) line ⇒ NO Seller VAT id (BT-31), "
               "tax-representative VAT id (BT-63) or Buyer VAT id (BT-48) — "
               "a prohibition, all VA-scoped on CII",
    "BR-O-03": "Not subject to VAT (O) document allowance ⇒ NO Seller/tax-"
               "representative/Buyer VAT id (prohibition)",
    "BR-O-04": "Not subject to VAT (O) document charge ⇒ NO Seller/tax-"
               "representative/Buyer VAT id (prohibition)",
    "BR-O-05": "Not subject to VAT (O) line ⇒ NO VAT rate (BT-152): the "
               "RateApplicablePercent ELEMENT is forbidden (any value, even "
               "0, fires)",
    "BR-O-06": "Not subject to VAT (O) document allowance ⇒ NO VAT rate "
               "(BT-96) element",
    "BR-O-07": "Not subject to VAT (O) document charge ⇒ NO VAT rate "
               "(BT-103) element",
    "BR-O-08": "Not subject to VAT (O) breakdown taxable (BT-116) = Σ O "
               "line net + charges − allowances (CII binding: EXACT round2 "
               "equality — no ±1 band, no exists(//line) term)",
    "BR-O-09": "Not subject to VAT (O) breakdown tax amount (BT-117) = 0",
    "BR-O-10": "Not subject to VAT (O) breakdown has a VAT exemption reason "
               "code (BT-121) or text (BT-120)",
    "BR-O-11": "O breakdown row ⇒ no other VAT breakdown group (CII binding: "
               "raw not(//ram:ApplicableTradeTax[CategoryCode != 'O']) over "
               "header AND line rows — byte-identical to CII BR-O-12, the "
               "pair fires together)",
    "BR-O-12": "O breakdown row ⇒ no non-O line VAT category (CII binding: "
               "same shared raw trade-tax-row test as BR-O-11)",
    "BR-O-13": "O breakdown row ⇒ no non-O allowance VAT category (CII "
               "binding: raw not(//ram:CategoryTradeTax[CategoryCode != "
               "'O']), indicator-agnostic — byte-identical to CII BR-O-14, "
               "the pair fires together)",
    "BR-O-14": "O breakdown row ⇒ no non-O charge VAT category (CII binding: "
               "same shared raw CategoryTradeTax test as BR-O-13)",
    "BR-S-01": "Standard rated (S) items and the VAT breakdown must agree "
               "(CII binding: the official WEAK count formula — "
               "(count(line-S)+count(header-S)) >= 2 or not(line-S), "
               "repeated for CategoryTradeTax — transcribed exactly: one S "
               "item with no S breakdown row fires, but two S rows on the "
               "item side alone officially hold and an orphan S breakdown "
               "row never fires)",
    "BR-Z-01": "Zero rated (Z) categories ⇒ exactly one Z VAT breakdown row "
               "(CII binding: raw, VAT-scheme-unscoped counts; an orphan Z "
               "breakdown row fires — byte-identical to CII BR-E-01 with 'Z')",
    "BR-Z-02": "Zero rated (Z) line ⇒ Seller VAT/tax id present (CII binding: "
               "a VA-or-FC seller tax registration or a tax-representative "
               "VA id, exactly like BR-E-02)",
    "BR-Z-03": "Zero rated (Z) document allowance ⇒ Seller VAT/tax id present",
    "BR-Z-04": "Zero rated (Z) document charge ⇒ Seller VAT/tax id present",
    "BR-Z-05": "Zero rated (Z) line VAT rate (BT-152) = 0",
    "BR-Z-06": "Zero rated (Z) document allowance VAT rate (BT-96) = 0",
    "BR-Z-07": "Zero rated (Z) document charge VAT rate (BT-103) = 0",
    "BR-Z-08": "Zero rated (Z) breakdown taxable (BT-116) = Σ Z line net + "
               "charges − allowances (CII binding: ±1 band around the round2 "
               "bucket sums)",
    "BR-Z-09": "Zero rated (Z) breakdown tax amount (BT-117) = 0",
    "BR-Z-10": "Zero rated (Z) breakdown must NOT have a VAT exemption reason "
               "code (BT-121) or text (BT-120) — the presence-FORBIDDEN "
               "mirror of BR-E-10",
    "BR-CL-01": "Document type code (BT-3) in UNTDID 1001",
    "BR-CL-03": "currencyID (amount elements) in ISO 4217 alpha-3",
    "BR-CL-04": "Invoice currency code (BT-5) in ISO 4217 alpha-3",
    "BR-CL-05": "Tax currency code (BT-6) in ISO 4217 alpha-3",
    "BR-CL-13": "Item classification scheme id (@listID) in UNTDID 7143",
    "BR-CL-14": "Country codes (BT-40/55/…) in ISO 3166-1 alpha-2",
    "BR-CL-16": "Payment means code (BT-81) in UNCL 4461",
    "BR-CL-17": "Allowance/charge VAT category code in UNCL 5305 subset",
    "BR-CL-18": "Breakdown & line VAT category code in UNCL 5305 subset",
    "BR-CL-19": "Coded allowance reason (BT-98/BT-140) in UNCL 5189",
    "BR-CL-20": "Coded charge reason (BT-105/BT-145) in UNCL 7161",
    "BR-CL-21": "Item standard-id scheme (@schemeID) in ISO 6523 ICD",
    "BR-CL-22": "VAT exemption reason code (BT-121) in CEF VATEX list",
    "BR-CL-23": "Quantity/base-quantity unit code in UN/ECE Rec 20 + Rec 21",
    "BR-CL-24": "Attachment MIME code (BT-125-1) in the EN 16931 MIMEMediaType subset",
    "BR-52": "Supporting document reference (BT-122) present per BG-24",
    "BR-53": "VAT accounting currency (BT-6) present ⇒ VAT total in that "
             "currency (BT-111) provided",
    "BR-54": "Item attribute (BG-32) has name (BT-160) and value (BT-161)",
    "BR-56": "Seller tax representative VAT identifier (BT-63) present",
    "BR-64": "Item standard identifier (BT-157) has a scheme identifier",
    "BR-65": "Item classification identifier (BT-158) has a scheme identifier",
    "BR-CO-03": "VAT point date (BT-7) and VAT point date code (BT-8) "
                "mutually exclusive",
    "BR-CO-04": "Each line categorized with a VAT category code (BT-151)",
    "BR-CO-09": "Seller/tax-representative/buyer VAT identifier prefixed "
                "with an ISO 3166-1 alpha-2 country code (Greece: 'EL')",
    "BR-CO-10": "Sum of line net amount (BT-106) = Σ line net (BT-131)",
    "BR-CO-13": "Total without VAT (BT-109) = line-net − allowances + charges",
    "BR-CO-14": "Invoice total VAT amount (BT-110) = Σ VAT category tax "
                "(BT-117) (CII binding: context = the document-currency BT-110 "
                "element, so a no-VAT invoice omitting it does not fire)",
    "BR-CO-15": "Total with VAT (BT-112) = total without VAT (BT-109) + total "
                "VAT (BT-110) (CII binding: extra BT-112 = BT-109 disjunct for "
                "no-VAT invoices)",
    "BR-CO-16": "Amount due (BT-115) = total with VAT − paid + rounding",
    "BR-CO-17": "VAT category tax = taxable × rate/100 (±1 tolerance)",
    "BR-CO-18": "At least one VAT breakdown group (BG-23)",
    "BR-CO-19": "Invoicing period (BG-14) used ⇒ start (BT-73) or end "
                "(BT-74) date filled",
    "BR-CO-20": "Invoice line period (BG-26) used ⇒ start (BT-134) or end "
                "(BT-135) date filled",
    "BR-CO-21": "Document level allowance (BG-20) has a reason (BT-97) or "
                "reason code (BT-98)",
    "BR-CO-22": "Document level charge (BG-21) has a reason (BT-104) or "
                "reason code (BT-105)",
    "BR-CO-23": "Invoice line allowance (BG-27) has a reason (BT-139) or "
                "reason code (BT-140)",
    "BR-CO-24": "Invoice line charge (BG-28) has a reason (BT-144) or "
                "reason code (BT-145)",
    "BR-CO-26": "Seller identifier (BT-29), legal registration id (BT-30) "
                "and/or VAT identifier (BT-31) present",
    "BR-IC-10": "Intra-community (K) breakdown has a VAT exemption reason "
                "code (BT-121) or text (BT-120)",
    "BR-45": "VAT breakdown taxable amount (BT-116) present",
    "BR-46": "VAT breakdown tax amount (BT-117) present",
    "BR-47": "VAT breakdown VAT category code (BT-118) present",
    "BR-48": "VAT breakdown VAT category rate (BT-119) present unless 'O'",
    "BR-E-01": "Exempt from VAT (E) categories ⇒ exactly one E VAT "
               "breakdown row (CII binding: raw, VAT-scheme-unscoped "
               "counts; an orphan E breakdown row fires)",
    "BR-E-02": "Exempt (E) line ⇒ Seller VAT/tax id present (CII binding: "
               "a VA-or-FC seller tax registration or a tax-representative "
               "VA id)",
    "BR-E-03": "Exempt (E) document allowance ⇒ Seller VAT/tax id present",
    "BR-E-04": "Exempt (E) document charge ⇒ Seller VAT/tax id present",
    "BR-E-05": "Exempt (E) line VAT rate (BT-152) = 0",
    "BR-E-06": "Exempt (E) document allowance VAT rate (BT-96) = 0",
    "BR-E-07": "Exempt (E) document charge VAT rate (BT-103) = 0",
    "BR-E-08": "Exempt (E) breakdown taxable (BT-116) = Σ E line net + "
               "charges − allowances (CII binding: ±1 band around the "
               "round2 bucket sums)",
    "BR-E-09": "Exempt (E) breakdown tax amount (BT-117) = 0",
    "BR-E-10": "Exempt (E) breakdown has a VAT exemption reason code "
               "(BT-121) or text (BT-120)",
    "BR-G-01": "Export outside the EU (G) categories ⇒ exactly one G VAT "
               "breakdown row (CII binding: raw, VAT-scheme-unscoped "
               "counts; an orphan G breakdown row fires)",
    "BR-G-02": "Export (G) line ⇒ Seller VAT id (BT-31) or tax-"
               "representative VAT id (BT-63) present (VA only — no FC "
               "fallback, unlike BR-E-02)",
    "BR-G-03": "Export (G) document allowance ⇒ Seller VAT id or tax-"
               "representative VAT id present",
    "BR-G-04": "Export (G) document charge ⇒ Seller VAT id or tax-"
               "representative VAT id present",
    "BR-G-05": "Export (G) line VAT rate (BT-152) = 0",
    "BR-G-06": "Export (G) document allowance VAT rate (BT-96) = 0",
    "BR-G-07": "Export (G) document charge VAT rate (BT-103) = 0",
    "BR-G-08": "Export (G) breakdown taxable (BT-116) = Σ G line net + "
               "charges − allowances (CII binding: ±1 band around the "
               "round2 bucket sums)",
    "BR-G-09": "Export (G) breakdown tax amount (BT-117) = 0",
    "BR-G-10": "Export (G) breakdown has a VAT exemption reason code "
               "(BT-121) or text (BT-120)",
    "BR-S-02": "Standard-rated line ⇒ Seller VAT/tax id present",
    "BR-S-05": "Standard-rated line VAT rate (BT-152) > 0",
    "BR-S-08": "Standard-rated breakdown taxable (BT-116) = per-rate Σ line "
               "net + charges − allowances at that rate",
    "BR-S-09": "Standard-rated breakdown tax = taxable × rate (±1)",
    "BR-S-10": "Standard-rated breakdown has no VAT exemption reason",
    "BR-AF-01": "IGIC (L) items ⇔ an IGIC VAT breakdown row (BG-23)",
    "BR-AF-02": "IGIC line ⇒ Seller VAT/tax id present",
    "BR-AF-03": "IGIC document allowance ⇒ Seller VAT/tax id present",
    "BR-AF-04": "IGIC document charge ⇒ Seller VAT/tax id present",
    "BR-AF-05": "IGIC line VAT rate (BT-152) valid (CII binding: > 0)",
    "BR-AF-06": "IGIC document allowance VAT rate (BT-96) valid (CII: > 0)",
    "BR-AF-07": "IGIC document charge VAT rate (BT-103) valid (CII: > 0)",
    "BR-AF-10": "IGIC breakdown has no VAT exemption reason",
    "BR-AG-01": "IPSI (M) items ⇔ an IPSI VAT breakdown row (BG-23)",
    "BR-AG-02": "IPSI line ⇒ Seller VAT/tax id present",
    "BR-AG-03": "IPSI document allowance ⇒ Seller VAT/tax id present",
    "BR-AG-04": "IPSI document charge ⇒ Seller VAT/tax id present",
    "BR-AG-05": "IPSI line VAT rate (BT-152) ≥ 0 (both bindings)",
    "BR-AG-06": "IPSI document allowance VAT rate (BT-96) ≥ 0 (both bindings)",
    "BR-AG-07": "IPSI document charge VAT rate (BT-103) ≥ 0 (both bindings)",
    "BR-AG-10": "IPSI breakdown has no VAT exemption reason",
    "BR-B-01": "Split-payment (B) invoice must be domestic Italian (all "
               "country codes 'IT')",
    "BR-B-02": "Split-payment (B) and Standard-rated (S) categories must not "
               "coexist",
    "BR-DEC-09": "≤2 decimals: Sum of Invoice line net amount (BT-106)",
    "BR-DEC-12": "≤2 decimals: Invoice total amount without VAT (BT-109)",
    "BR-DEC-14": "≤2 decimals: Invoice total amount with VAT (BT-112)",
    "BR-DEC-18": "≤2 decimals: Amount due for payment (BT-115)",
    "BR-DEC-19": "≤2 decimals: VAT category taxable amount (BT-116)",
    "BR-DEC-20": "≤2 decimals: VAT category tax amount (BT-117)",
    "BR-DEC-23": "≤2 decimals: Invoice line net amount (BT-131)",
    "BR-DEC-24": "≤2 decimals: Invoice line allowance amount (BT-136)",
    "BR-DEC-25": "≤2 decimals: Invoice line allowance base amount (BT-137)",
    "BR-DEC-27": "≤2 decimals: Invoice line charge amount (BT-141)",
    "BR-DEC-28": "≤2 decimals: Invoice line charge base amount (BT-142)",
    # CII proof-parity batch 7 (T-VHCIIP.8).
    "BR-CO-11": "Sum of document allowances (BT-107) = Σ Document level "
                "allowance amounts (BT-92)",
    "BR-CO-12": "Sum of document charges (BT-108) = Σ Document level charge "
                "amounts (BT-99)",
    "BR-DEC-01": "≤2 decimals: Document level allowance amount (BT-92)",
    "BR-DEC-02": "≤2 decimals: Document level allowance base amount (BT-93)",
    "BR-DEC-05": "≤2 decimals: Document level charge amount (BT-99)",
    "BR-DEC-06": "≤2 decimals: Document level charge base amount (BT-100)",
    "BR-DEC-10": "≤2 decimals: Sum of allowances on document level (BT-107)",
    "BR-DEC-11": "≤2 decimals: Sum of charges on document level (BT-108)",
    "BR-DEC-16": "≤2 decimals: Paid amount (BT-113)",
    "BR-DEC-17": "≤2 decimals: Rounding amount (BT-114)",
    "BR-S-03": "Standard-rated document allowance (BT-95) requires a Seller "
               "VAT identifier (BT-31/BT-32/BT-63)",
    "BR-S-04": "Standard-rated document charge (BT-102) requires a Seller VAT "
               "identifier (BT-31/BT-32/BT-63)",
    "BR-S-06": "Standard-rated document allowance VAT rate (BT-96) > 0",
    "BR-S-07": "Standard-rated document charge VAT rate (BT-103) > 0",
}

# Rules deliberately NOT graded on CII (the CII Schematron binds them with
# different semantics than the UBL binding; grading under the unmodified UBL
# function would ship a divergence). Kept here so the exclusion is auditable.
CII_SYNTAX_EXCLUDED = {
    "BR-AF-08": "the CII artifact binds the assert to the ApplicableTradeTax "
                "ROW (not its CategoryCode child like BR-S-08), so its "
                "../ram:RateApplicablePercent is empty and 'every $rate in ()' "
                "is vacuously true — the shipped assert can never fire; the "
                "engine asserts the intended per-rate bucket sum anyway",
    "BR-AF-09": "the official CII artifact ships this assert as test=\"true()\" "
                "— a tautology that can never fire; the engine asserts the real "
                "taxable × rate arithmetic on both syntaxes instead",
    "BR-AG-08": "the CII artifact repeats the BR-AF-08 defect for the IPSI "
                "family (assert bound to the ApplicableTradeTax ROW, so "
                "'every $rate in ()' is vacuously true and it can never "
                "fire); the engine asserts the intended per-rate bucket sum "
                "anyway",
    "BR-AG-09": "the official CII artifact ships this assert as test=\"true()\" "
                "— the same never-firing tautology as BR-AF-09; the engine "
                "asserts the real taxable × rate arithmetic on both syntaxes "
                "instead",
}


# --------------------------------------------------------------------------- #
# CII-syntax German-CIUS (BR-DE-*) coverage manifest.                           #
#                                                                              #
# The national BR-DE-* layer runs over the CII normalized model                 #
# (einvoice.parser_cii.build_model) via einvoice.rules_xrechnung.CII_DE_RULES,   #
# differentially proven equivalent to the official KoSIT XRechnung-CII           #
# Schematron across the CII corpus (``differential.py xrechnung-cii`` green: 0   #
# divergences). This manifest records which BR-DE rules reach that CII parity     #
# (auditable + grep-able) and which are deliberately NOT graded on CII because    #
# their CII binding needs document structure the EN 16931 core model does not     #
# carry (payment-means / IBAN / skonto / attachment / extension) — excluded, not  #
# approximated. The single source of truth is differential.CII_XR_RULE_IDS; the   #
# assert below guarantees this manifest can never silently drift from it.         #
_CII_XR_ADMITTED_IDS = (
    "BR-DE-1", "BR-DE-2", "BR-DE-3", "BR-DE-4", "BR-DE-5", "BR-DE-6", "BR-DE-7",
    "BR-DE-8", "BR-DE-9", "BR-DE-10", "BR-DE-11", "BR-DE-14", "BR-DE-15",
    "BR-DE-16", "BR-DE-17", "BR-DE-21", "BR-DE-26", "BR-DE-27", "BR-DE-28",
    "BR-DE-TMP-32",
    # CVD/TMP family — the CII artifact carries all nine UBL family asserts
    # plus the CII-only BR-TMP-3.
    "BR-TMP-2", "BR-TMP-3",
    "BR-DE-CVD-01", "BR-DE-CVD-02", "BR-DE-CVD-03", "BR-DE-CVD-04",
    "BR-DE-CVD-05", "BR-DE-CVD-06-a", "BR-DE-CVD-06-b", "BR-TMP-CVD-01",
)
# Descriptions are reused verbatim from the UBL CIUS/TMP manifests — the rule
# SEMANTICS are identical across syntaxes; only the bound syntax differs.
CII_XRECHNUNG_CIUS_COVERAGE = {
    rid: {**XRECHNUNG_CIUS_COVERAGE, **XRECHNUNG_TMP_COVERAGE}[rid]
    for rid in _CII_XR_ADMITTED_IDS
}
CII_XRECHNUNG_CIUS_EXCLUDED = {
    "BR-DE-18": "Skonto grammar in BT-20 (free-text payment-terms structure not "
                "in the core model)",
    "BR-DE-19": "BT-84 IBAN mod-97 (SEPA credit-transfer payment-means detail)",
    "BR-DE-20": "BT-91 IBAN mod-97 (SEPA direct-debit payment-means detail)",
    "BR-DE-22": "EmbeddedDocumentBinaryObject filename uniqueness (attachment "
                "surface not in the core model)",
    "BR-DE-23-a": "payment-means type-code 30/58 requires CREDIT TRANSFER",
    "BR-DE-23-b": "payment-means type-code 30/58 forbids card / direct debit",
    "BR-DE-24-a": "payment-means type-code 48/54/55 requires PAYMENT CARD",
    "BR-DE-24-b": "payment-means type-code 48/54/55 forbids transfer / debit",
    "BR-DE-25-a": "payment-means type-code 59 requires DIRECT DEBIT",
    "BR-DE-25-b": "payment-means type-code 59 forbids transfer / card",
    "BR-DE-30": "Bank assigned creditor id (BT-90) with BG-19 (semantic BG-19 "
                "reconstruction not in the core model)",
    "BR-DE-31": "Debited account id (BT-91) with BG-19 (same)",
}


def _all_asserted_rule_ids():
    """Every rule id the validator can actually emit — both the direct
    ``Violation("ID", …)`` calls (the ``IMPLEMENTED`` set) and the ids raised
    through the ``_dec_violation("BR-DEC-…", …)`` helper (which the ``IMPLEMENTED``
    regex intentionally leaves out because those ids never appear as a literal
    first argument to ``Violation``). Used only to audit the coverage manifest,
    so it does not perturb the grading ``IMPLEMENTED`` set above."""
    src = open(RULES_SRC, encoding="utf-8").read()
    ids = set(re.findall(r'Violation\(\s*["\']([A-Z0-9-]+)["\']', src))
    ids |= set(re.findall(r'_dec_violation\(\s*["\']([A-Z0-9-]+)["\']', src))
    # The document-total BR-DEC rules raise through _dec_lmt(inv, "BR-DEC-…", …).
    ids |= set(re.findall(r'_dec_lmt\(\s*inv,\s*["\']([A-Z0-9-]+)["\']', src))
    return ids


_ASSERTED = _all_asserted_rule_ids()

# The manifest may only claim rules the validator actually implements.
assert CALCULATION_ROUNDING_COVERAGE.keys() <= _ASSERTED, (
    "calculation/rounding coverage manifest names unimplemented rules: %s"
    % sorted(CALCULATION_ROUNDING_COVERAGE.keys() - _ASSERTED))
# The vacuous set must NOT be implemented (asserting them would be a false
# positive against the official Schematron).
assert not (CALCULATION_ROUNDING_VACUOUS.keys() & _ASSERTED), (
    "a known-vacuous rule is being asserted (false positive risk): %s"
    % sorted(CALCULATION_ROUNDING_VACUOUS.keys() & _ASSERTED))

# The CII-syntax manifest may only claim core rules the validator implements,
# and must match differential.CII_GRADED_RULES EXACTLY (single source of truth),
# so it can never silently drift from the graded set the differential proves.
assert CII_SYNTAX_COVERAGE.keys() <= _ASSERTED, (
    "CII-syntax coverage manifest names unimplemented rules: %s"
    % sorted(CII_SYNTAX_COVERAGE.keys() - _ASSERTED))
try:
    import differential as _differential
    _CII_GRADED = set(_differential.CII_RULE_IDS)
    _CII_EXCLUDED = set(_differential.CII_EXCLUDED_RULE_IDS)
    assert CII_SYNTAX_COVERAGE.keys() == _CII_GRADED, (
        "CII-syntax coverage manifest drifted from differential.CII_GRADED_RULES "
        "— manifest-only: %s ; graded-only: %s"
        % (sorted(CII_SYNTAX_COVERAGE.keys() - _CII_GRADED),
           sorted(_CII_GRADED - CII_SYNTAX_COVERAGE.keys())))
    assert CII_SYNTAX_EXCLUDED.keys() == _CII_EXCLUDED, (
        "CII-syntax excluded manifest drifted from "
        "differential.CII_EXCLUDED_RULE_IDS — manifest-only: %s ; code-only: %s"
        % (sorted(CII_SYNTAX_EXCLUDED.keys() - _CII_EXCLUDED),
           sorted(_CII_EXCLUDED - CII_SYNTAX_EXCLUDED.keys())))
    _CII_XR_GRADED = set(_differential.CII_XR_RULE_IDS)
    _CII_XR_EXCLUDED = set(_differential.CII_XR_EXCLUDED_RULE_IDS)
    assert CII_XRECHNUNG_CIUS_COVERAGE.keys() == _CII_XR_GRADED, (
        "CII BR-DE coverage manifest drifted from differential.CII_XR_RULE_IDS "
        "— manifest-only: %s ; graded-only: %s"
        % (sorted(CII_XRECHNUNG_CIUS_COVERAGE.keys() - _CII_XR_GRADED),
           sorted(_CII_XR_GRADED - CII_XRECHNUNG_CIUS_COVERAGE.keys())))
    assert CII_XRECHNUNG_CIUS_EXCLUDED.keys() == _CII_XR_EXCLUDED, (
        "CII BR-DE excluded manifest drifted from "
        "differential.CII_XR_EXCLUDED_RULE_IDS — manifest-only: %s ; code-only: %s"
        % (sorted(CII_XRECHNUNG_CIUS_EXCLUDED.keys() - _CII_XR_EXCLUDED),
           sorted(_CII_XR_EXCLUDED - CII_XRECHNUNG_CIUS_EXCLUDED.keys())))
    # Admitted CII national set must be a subset of the rules registered in
    # rules_xrechnung.py (BR-DE-* via the CIUS scrape, BR-TMP-* via the same
    # @_rule scrape — BR-TMP-3 is registered on the CII layer only, which the
    # source scrape covers; differential.CII_ONLY_XR_RULE_IDS documents it).
    assert CII_XRECHNUNG_CIUS_COVERAGE.keys() <= (
        _XR_CIUS_IMPLEMENTED | _XR_TMP_IMPLEMENTED), (
        "CII coverage names rules not implemented in rules_xrechnung.py: %s"
        % sorted(CII_XRECHNUNG_CIUS_COVERAGE.keys()
                 - _XR_CIUS_IMPLEMENTED - _XR_TMP_IMPLEMENTED))
except ImportError:  # pragma: no cover - differential harness always co-located
    pass


# --------------------------------------------------------------------------- #
# Driving the real CLI                                                         #
# --------------------------------------------------------------------------- #
def run_cli(path):
    """Run `einvoice.py validate <path> --json`. Return (exit_code, violation_ids,
    raw_stdout). violation_ids is the set of rule ids the validator reported."""
    proc = subprocess.run(
        [sys.executable, CLI, "validate", path, "--json"],
        capture_output=True, text=True,
    )
    ids = set()
    try:
        data = json.loads(proc.stdout)
        for v in data.get("violations", []):
            ids.add(v.get("rule"))
    except (ValueError, AttributeError):
        pass
    return proc.returncode, ids, proc.stdout


# --------------------------------------------------------------------------- #
# testSet parsing                                                             #
# --------------------------------------------------------------------------- #
def _q(tag):
    return "{%s}%s" % (DIFI_NS, tag)


def load_manifest():
    rows = {}
    with open(MANIFEST, encoding="utf-8") as fh:
        header = fh.readline()
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                continue
            parts = line.split("\t")
            rel, expectation, rule_id = parts[0], parts[1], parts[2]
            rows[rel] = (expectation, rule_id)
    return rows


def iter_test_blocks(testset_path):
    """Yield (kind, rule_id, invoice_element) for each <test> block.

    kind is 'error' or 'success'. invoice_element is the embedded <Invoice>.
    """
    tree = ET.parse(testset_path)
    root = tree.getroot()
    for test in root.findall(_q("test")):
        assert_el = test.find(_q("assert"))
        kind = rule = None
        if assert_el is not None:
            err = assert_el.find(_q("error"))
            suc = assert_el.find(_q("success"))
            if err is not None and (err.text or "").strip():
                kind, rule = "error", err.text.strip()
            elif suc is not None and (suc.text or "").strip():
                kind, rule = "success", suc.text.strip()
        invoice = test.find("{%s}Invoice" % INVOICE_NS)
        if kind is None or invoice is None:
            continue
        yield kind, rule, invoice


def write_fragment(invoice_el, tmpdir, name):
    """Serialize an embedded <Invoice> subtree to its own file so the real CLI
    can validate it exactly as a standalone document."""
    # ElementTree resolves elements by namespace URI (not prefix), and the CLI's
    # parser does the same, so ns0/ns1 auto-prefixes are fine.
    path = os.path.join(tmpdir, name)
    xml = ET.tostring(invoice_el, encoding="unicode")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write('<?xml version="1.0" encoding="UTF-8"?>\n')
        fh.write(xml)
    return path


# --------------------------------------------------------------------------- #
# Result accumulators                                                          #
# --------------------------------------------------------------------------- #
class Tally:
    def __init__(self):
        self.hard_fails = []   # list[str]  loud
        self.notes = []        # list[str]  informational (out-of-scope etc.)


def main():
    if not os.path.isdir(VENDORED):
        sys.stderr.write("error: vendored corpus not found at %s\n" % VENDORED)
        return 2

    manifest = load_manifest()
    tally = Tally()
    # Every rule id the validator actually FIRES anywhere in the corpus run.
    # Used below to prove the published coverage matrix documents them, and — via
    # the full engine registry — that the matrix never drifts from the engine.
    exercised = set()

    # ---- 1. VALID vectors: must exit 0 -----------------------------------
    valid_files = _maybe_shard_files(sorted(
        f for f in os.listdir(VALID_DIR) if f.endswith(".xml")))
    valid_total = len(valid_files)
    valid_pass = 0
    valid_rows = []
    for f in valid_files:
        path = os.path.join(VALID_DIR, f)
        code, ids, _ = run_cli(path)
        exercised |= set(ids)
        ok = (code == EXIT_OK and not ids)
        if ok:
            valid_pass += 1
            valid_rows.append(("PASS", f, ""))
        else:
            detail = "exit=%d flagged=%s" % (code, ",".join(sorted(ids)) or "-")
            valid_rows.append(("FALSE-POS", f, detail))
            tally.hard_fails.append(
                "FALSE POSITIVE: valid vector rejected -> %s (%s)" % (f, detail))

    # ---- 2. INVALID vectors: driven at the embedded-block level ----------
    invalid_files = _maybe_shard_files(sorted(
        f for f in os.listdir(INVALID_DIR) if f.endswith(".xml")))

    # file-level (one row per MANIFEST invalid vector)
    file_rows = []
    file_covered = 0
    file_detected = 0
    file_oos = 0

    # block-level aggregates
    err_total = err_detected = err_missed = err_wrong = err_oos = 0
    suc_total = suc_clean = suc_falsepos = suc_oos = 0

    tmpdir = tempfile.mkdtemp(prefix="einvoice-conf-")
    try:
        for f in invalid_files:
            path = os.path.join(INVALID_DIR, f)
            expected_file_rule = manifest.get("invalid/" + f, ("invalid", None))[1]
            file_impl = expected_file_rule in IMPLEMENTED

            blocks = list(iter_test_blocks(path))
            file_err_blocks = [b for b in blocks if b[0] == "error"]
            file_err_detected = 0
            file_err_present = 0

            for idx, (kind, rule, inv_el) in enumerate(blocks):
                frag = write_fragment(
                    inv_el, tmpdir, "%s.%d.xml" % (f[:-4], idx))
                code, ids, _ = run_cli(frag)
                exercised |= set(ids)

                if kind == "error":
                    err_total += 1
                    if rule not in IMPLEMENTED:
                        err_oos += 1
                        continue
                    file_err_present += 1
                    if code == EXIT_OK:
                        err_missed += 1
                        tally.hard_fails.append(
                            "MISSED DETECTION: %s block#%d expected %s to fire, "
                            "but validator returned VALID (exit 0)."
                            % (f, idx, rule))
                    elif rule in ids:
                        err_detected += 1
                        file_err_detected += 1
                    else:
                        err_wrong += 1
                        tally.hard_fails.append(
                            "WRONG RULE ID: %s block#%d expected %s; validator "
                            "failed with %s (exit %d) but %s not among them."
                            % (f, idx, rule, ",".join(sorted(ids)) or "-",
                               code, rule))
                else:  # success block: fragment MUST pass its rule
                    suc_total += 1
                    if rule not in IMPLEMENTED:
                        suc_oos += 1
                        continue
                    if rule in ids:
                        suc_falsepos += 1
                        tally.hard_fails.append(
                            "FALSE POSITIVE: %s success-block#%d must PASS %s, "
                            "but validator flagged %s."
                            % (f, idx, rule, rule))
                    else:
                        suc_clean += 1

            # file-level verdict: labeled rule detected on >=1 of its <error> blocks
            if not file_impl:
                file_oos += 1
                file_rows.append(("OOS", f, expected_file_rule,
                                  "rule not implemented"))
            else:
                file_covered += 1
                if file_err_present and file_err_detected == file_err_present:
                    file_detected += 1
                    file_rows.append(("DETECT", f, expected_file_rule,
                                      "%d/%d error-frags" %
                                      (file_err_detected, file_err_present)))
                elif file_err_detected > 0:
                    file_detected += 1
                    file_rows.append(("DETECT*", f, expected_file_rule,
                                      "%d/%d error-frags (partial)" %
                                      (file_err_detected, file_err_present)))
                else:
                    file_rows.append(("FAIL", f, expected_file_rule,
                                      "0/%d error-frags detected" %
                                      file_err_present))
    finally:
        for n in os.listdir(tmpdir):
            os.remove(os.path.join(tmpdir, n))
        os.rmdir(tmpdir)

    # ------------------------------------------------------------------ #
    # Coverage-matrix consistency (published trust artifact)             #
    #                                                                    #
    # The machine-readable coverage_matrix.json is the artifact a buyer  #
    # reads to trust "it runs the rules my CI needs". Cross-check it two  #
    # ways so a matrix/engine drift fails THIS standing gate:            #
    #   (a) its rule-id set == the engine's full fireable registry, and   #
    #   (b) every rule the corpus run actually fired is documented in it.  #
    # ------------------------------------------------------------------ #
    try:
        from einvoice import coverage as _coverage
        _matrix = _coverage.load_matrix()
        _matrix_ids = _coverage.matrix_rule_ids(_matrix)
        _engine_ids = _coverage.engine_fireable_ids()
        if _matrix_ids != _engine_ids:
            tally.hard_fails.append(
                "COVERAGE MATRIX DRIFT: coverage_matrix.json rule-id set != the "
                "engine's fireable registry — matrix-only: %s ; engine-only: %s"
                % (sorted(_matrix_ids - _engine_ids),
                   sorted(_engine_ids - _matrix_ids)))
        _undoc = sorted(exercised - _matrix_ids)
        if _undoc:
            tally.hard_fails.append(
                "COVERAGE MATRIX GAP: the corpus run fired rules absent from "
                "coverage_matrix.json: %s" % _undoc)
    except Exception as _e:  # pragma: no cover - matrix/helper must be present
        tally.hard_fails.append(
            "COVERAGE MATRIX: could not verify coverage_matrix.json (%s)" % _e)

    # ------------------------------------------------------------------ #
    # Report                                                             #
    # ------------------------------------------------------------------ #
    out = sys.stdout.write

    def pct(n, d):
        return "100.0%" if d and n == d else ("%.1f%%" % (100.0 * n / d) if d else "n/a")

    out("\n")
    out("=" * 70 + "\n")
    out("  einvoice CONFORMANCE — vendored corpus vs. the real CLI\n")
    out("=" * 70 + "\n")
    out("  validator implements %d business rules: %s\n"
        % (len(IMPLEMENTED), ", ".join(sorted(IMPLEMENTED))))
    out("\n")
    out("  calculation/rounding invariants covered (%d), differentially proven:\n"
        % len(CALCULATION_ROUNDING_COVERAGE))
    for rid in sorted(CALCULATION_ROUNDING_COVERAGE):
        out("     %-11s %s\n" % (rid, CALCULATION_ROUNDING_COVERAGE[rid]))
    out("  known-vacuous in the normative Schematron (not asserted):\n")
    for rid in sorted(CALCULATION_ROUNDING_VACUOUS):
        out("     %-11s %s\n" % (rid, CALCULATION_ROUNDING_VACUOUS[rid]))
    out("\n")
    out("  German CIUS (BR-DE-*) rules covered (%d), differentially proven vs\n"
        "  the official KoSIT XRechnung-UBL Schematron (CIUS layer):\n"
        % len(XRECHNUNG_CIUS_COVERAGE))
    for rid in sorted(XRECHNUNG_CIUS_COVERAGE):
        out("     %-13s %s\n" % (rid, XRECHNUNG_CIUS_COVERAGE[rid]))
    out("\n")
    out("  XRechnung EXTENSION rules covered (%d), differentially proven vs the\n"
        "  official KoSIT XSLT (extension CustomizationID only):\n"
        % len(XRECHNUNG_EXTENSION_COVERAGE))
    for rid in sorted(XRECHNUNG_EXTENSION_COVERAGE):
        out("     %-11s %s\n" % (rid, XRECHNUNG_EXTENSION_COVERAGE[rid]))
    out("\n")
    out("  CII-syntax (Factur-X/ZUGFeRD) core rules covered (%d), the SAME rule\n"
        "  functions run over the CII model, differentially proven vs the official\n"
        "  CEN EN16931-CII Schematron (differential.py cii green, 0 divergences):\n"
        % len(CII_SYNTAX_COVERAGE))
    for rid in sorted(CII_SYNTAX_COVERAGE):
        out("     %-11s %s\n" % (rid, CII_SYNTAX_COVERAGE[rid]))
    out("  not graded on CII (CII Schematron binds these differently; excluded\n"
        "  rather than approximated — still graded on the UBL EN/XRechnung legs):\n")
    for rid in sorted(CII_SYNTAX_EXCLUDED):
        out("     %-11s %s\n" % (rid, CII_SYNTAX_EXCLUDED[rid]))
    out("\n")
    out("  CII-syntax German CIUS (BR-DE-*) rules covered (%d), the SAME national\n"
        "  rules run over the CII model, differentially proven vs the official\n"
        "  KoSIT XRechnung-CII Schematron (differential.py xrechnung-cii green):\n"
        % len(CII_XRECHNUNG_CIUS_COVERAGE))
    for rid in sorted(CII_XRECHNUNG_CIUS_COVERAGE):
        out("     %-13s %s\n" % (rid, CII_XRECHNUNG_CIUS_COVERAGE[rid]))
    out("  not graded on CII (CII binding needs payment-means / IBAN / skonto /\n"
        "  attachment structure the core model omits; excluded, not approximated):\n")
    for rid in sorted(CII_XRECHNUNG_CIUS_EXCLUDED):
        out("     %-13s %s\n" % (rid, CII_XRECHNUNG_CIUS_EXCLUDED[rid]))
    out("\n")

    # Per valid vector
    out("-- VALID vectors (must exit 0) " + "-" * 38 + "\n")
    for status, f, detail in valid_rows:
        mark = "ok " if status == "PASS" else "!! "
        out("  %s%-9s %-34s %s\n" % (mark, status, f, detail))
    out("\n")

    # Per invalid file
    out("-- INVALID vectors (labeled rule must fire on its <error> fragments) "
        + "-" * 1 + "\n")
    for status, f, rule, detail in file_rows:
        mark = "!! " if status == "FAIL" else "ok "
        out("  %s%-8s %-14s %-16s %s\n" % (mark, status, rule, f, detail))
    out("\n")

    # Matrix
    out("=" * 70 + "\n")
    out("  MATRIX\n")
    out("=" * 70 + "\n")
    total_vectors = valid_total + len(invalid_files)
    out("  total vendored vectors ............. %d "
        "(%d valid + %d invalid)\n"
        % (total_vectors, valid_total, len(invalid_files)))
    out("  German CIUS (BR-DE-*) rules covered  %d\n"
        % len(XRECHNUNG_CIUS_COVERAGE))
    out("  XRechnung EXTENSION rules covered .. %d\n"
        % len(XRECHNUNG_EXTENSION_COVERAGE))
    out("  calc/rounding invariants covered ... %d\n"
        % len(CALCULATION_ROUNDING_COVERAGE))
    out("  CII-syntax core rules covered ...... %d  (%d excluded, documented)\n"
        % (len(CII_SYNTAX_COVERAGE), len(CII_SYNTAX_EXCLUDED)))
    out("  CII-syntax BR-DE rules covered ..... %d  (%d excluded, documented)\n"
        % (len(CII_XRECHNUNG_CIUS_COVERAGE), len(CII_XRECHNUNG_CIUS_EXCLUDED)))
    out("\n")
    out("  VALID-vector pass rate ............. %d/%d   %s\n"
        % (valid_pass, valid_total, pct(valid_pass, valid_total)))
    out("     (a miss here = FALSE POSITIVE, hard fail)\n")
    out("\n")
    out("  COVERED-INVALID detection rate ..... %d/%d   %s\n"
        % (file_detected, file_covered, pct(file_detected, file_covered)))
    out("     (labeled rule correctly fired, correct rule id)\n")
    out("  OUT-OF-SCOPE invalid vectors ....... %d\n" % file_oos)
    out("\n")
    out("  -- embedded-block detail (Difi testSet assertions) --\n")
    out("  <error>   fragments ................ %d total\n" % err_total)
    out("     detected (expected rule fired) .. %d   %s\n"
        % (err_detected, pct(err_detected,
                             err_total - err_oos)))
    out("     missed (validator said valid) ... %d\n" % err_missed)
    out("     wrong rule id ................... %d\n" % err_wrong)
    out("     out-of-scope .................... %d\n" % err_oos)
    out("  <success> fragments ................ %d total\n" % suc_total)
    out("     clean (rule correctly not fired)  %d   %s\n"
        % (suc_clean, pct(suc_clean, suc_total - suc_oos)))
    out("     FALSE POSITIVE (rule flagged) ... %d\n" % suc_falsepos)
    out("     out-of-scope .................... %d\n" % suc_oos)
    out("\n")

    # Hard fails
    out("=" * 70 + "\n")
    if tally.hard_fails:
        out("  HARD FAILS: %d  <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n"
            % len(tally.hard_fails))
        out("=" * 70 + "\n")
        for msg in tally.hard_fails:
            out("  !! " + msg + "\n")
        out("\n")
        out("  RESULT: FAIL — the credibility contract is broken above.\n")
        return 1
    else:
        out("  HARD FAILS: 0\n")
        out("=" * 70 + "\n")
        out("  RESULT: PASS — no false positives, every covered invalid vector\n"
            "  is detected with the correct rule id, scope honestly reported.\n")
        return 0


if __name__ == "__main__":
    sys.exit(main())
