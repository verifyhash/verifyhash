#!/usr/bin/env python3
"""Golden-corpus snapshot regression harness for einvoice.report.

WHAT THIS IS
------------
This freezes the CURRENT einvoice conformance output for a small, curated set
of real corpus invoices in BOTH syntaxes (UBL + CII), and fails on ANY drift.
For each fixture it recomputes a NORMALIZED, deterministic projection of the
engine's outcome and asserts it equals a committed golden file byte-for-byte
(modulo JSON key order, which is forced with ``sort_keys=True``).

WHAT IT PROVES (and what it does NOT)
-------------------------------------
It proves STABILITY, not CORRECTNESS. The snapshot captures whatever the rule
engine fires TODAY; it does not know whether that is the "right" answer. Judging
whether the fired rules are correct against reference validators is the job of
``differential.py`` (the differential gate). This harness only guards against
UNINTENDED changes: if a refactor silently makes a rule stop firing (or a new
rule start firing) on a known invoice, this test goes red so a human decides
whether the change was intended.

THE PROJECTION (deterministic by construction)
----------------------------------------------
Per fixture we keep only:
  * ``valid``      — bool, the engine's overall verdict (no fatal violations).
  * ``exit_code``  — 0 (valid) / 1 (>=1 fatal) / 3 (input not well-formed XML),
                     mirroring ``python3 -m einvoice.report``'s exit contract.
  * ``rules``      — the SORTED list of fired rule ids, each with its severity
                     (``fatal`` | ``warning`` | ``information``).
Nondeterministic or environment-specific fields are DELIBERATELY excluded:
no timestamps, no absolute paths (``report``'s ``source`` field is dropped),
no tool/version strings, and no free-text rule messages (which can embed
document values). Sorting by (rule, severity) makes the projection independent
of internal rule-evaluation order, so re-running yields identical output.

CODE PATH (no re-implemented rule logic)
----------------------------------------
UBL fixtures go through ``einvoice.report.build_report`` verbatim — the exact
code path behind ``python3 -m einvoice.report``. CII is NOT natively dispatched
by ``report``/``validate`` today (they parse UBL only, so a CII file there just
trips the S-ROOT structural check). To snapshot CII meaningfully we invoke the
engine's real CII path — ``parser_cii.build_model`` + the same ``rules.ALL_RULES``
core rules + ``rules_xrechnung.evaluate_cii`` for the German CIUS layer, exactly
as ``test_rules_cii.py`` does — and reuse ``report._record`` for the identical
violation->record mapping. No rule logic is duplicated here.

REGENERATION (never automatic)
------------------------------
The default run NEVER rewrites goldens. To deliberately adopt a new baseline
after an INTENTIONAL rule change, run one of:
    python3 test_golden_snapshot.py --update
    REGEN=1 python3 test_golden_snapshot.py
and commit the resulting ``golden/*.json`` diff as a reviewed decision.

Standard library only. No network. Runs in well under a second.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

from einvoice import report
from einvoice import parser_cii
from einvoice import rules
from einvoice import rules_xrechnung
from einvoice.parser import NotWellFormed
from einvoice.receipt import build_receipt, receipt_json, canonical_json

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN_DIR = os.path.join(HERE, "golden")

# --------------------------------------------------------------------------
# Curated fixtures. Every path is an existing corpus invoice the engine already
# parses (nothing is fabricated). Each entry pins an exact relative path plus
# the profile to validate under. "syntax" selects the code path (UBL via
# report.build_report; CII via the engine's CII path). Coverage: >=1 known-good
# and >=1 known-bad in EACH syntax.
# --------------------------------------------------------------------------
FIXTURES = [
    # ---- UBL, good ----
    {
        "name": "ubl-good-en16931-bis3-positive",
        "path": "corpus/cen-en16931/ubl/examples/BIS3_Invoice_positive.XML",
        "syntax": "UBL",
        "profile": "en16931",
        "note": "Reference BIS Billing 3.0 invoice; valid EN 16931 core.",
    },
    {
        "name": "ubl-good-xrechnung-xr-01.01a",
        "path": "corpus/vendored/valid/xr-01.01a_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "XRechnung conformance sample; passes German CIUS (one info note).",
    },
    # ---- UBL, bad ----
    {
        "name": "ubl-bad-xrechnung-bis3-positive",
        "path": "corpus/vendored/valid/cen-bis3-positive_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "Valid EN 16931 but NOT XRechnung-conformant: missing German "
                "mandatory data trips BR-DE-2 (fatal) plus BR-DE warnings.",
    },
    {
        "name": "ubl-good-en16931-creditnote",
        "path": "corpus/cen-en16931/test/testfiles/CreditNote-Max_content.xml",
        "syntax": "UBL",
        "profile": "en16931",
        "note": "A UBL 2.1 CreditNote (root CreditNote-2:CreditNote), really "
                "validated through the shared EN 16931 engine (T-VHCN.2): it is "
                "business-rule clean and passes with no fatal.",
    },
    {
        "name": "ubl-bad-en16931-creditnote-typecode",
        "path": "fixtures/creditnote-invalid-typecode_ubl.xml",
        "syntax": "UBL",
        "profile": "en16931",
        "note": "A UBL CreditNote with BT-3 CreditNoteTypeCode=999 (off the "
                "UNTDID 1001 credit-note sub-list): the shared engine fires the "
                "real BR-CL-01 fatal, proving CreditNote content is validated.",
    },
    # ---- CII, good core / bad XRechnung-TMP ----
    {
        "name": "cii-good-xrechnung-example5",
        "path": "corpus/cen-en16931/cii/examples/CII_example5.xml",
        "syntax": "CII",
        "profile": "xrechnung",
        "note": "CII invoice passing the EN core; under the xrechnung profile "
                "it fires BR-DE-21 (warning) and, since the CVD/TMP family "
                "landed, the fatal BR-TMP-3: its gross BasisQuantity '1.1' != "
                "net '1' (string comparison, mirroring the official KoSIT CII "
                "artifact, which fires BR-TMP-3 on this file too).",
    },
    {
        "name": "cii-good-xrechnung-huf",
        "path": "corpus/cen-en16931/cii/examples/huf_example_cii.xml",
        "syntax": "CII",
        "profile": "xrechnung",
        "note": "CII invoice in HUF; passes with a single BR-DE-21 warning.",
    },
    # ---- CII, bad ----
    {
        "name": "cii-bad-xrechnung-business-example-02",
        "path": "corpus/cen-en16931/cii/examples/CII_business_example_02.xml",
        "syntax": "CII",
        "profile": "xrechnung",
        "note": "CII invoice failing multiple German CIUS rules (BR-DE-5/6/27/28).",
    },
    {
        "name": "cii-bad-xrechnung-example6",
        "path": "corpus/cen-en16931/cii/examples/CII_example6.xml",
        "syntax": "CII",
        "profile": "xrechnung",
        "note": "CII invoice failing many mandatory-field rules (BR-DE-1..4 etc.).",
    },
    # ======================================================================
    # SYNTHETIC real-SHAPE corpus (corpus/synthetic/). Ten hand-authored,
    # fully FICTIONAL invoices (Muster GmbH / DE000000000 / placeholder IBAN)
    # with realistic multi-line, multi-VAT-rate structure, document-level
    # allowances/charges and payment terms. >=3 UBL + >=3 CII, each syntax
    # carrying at least one VALID (passes its profile) and one INTENTIONALLY
    # BROKEN (a known fatal fires) fixture. Goldens are the engine's own
    # projection — regenerate with `python3 test_golden_snapshot.py --update`.
    # ======================================================================
    # ---- synthetic UBL, good ----
    {
        "name": "synth-ubl-good-multiline",
        "path": "corpus/synthetic/synth-ubl-good-multiline.xml",
        "syntax": "UBL",
        "profile": "en16931",
        "note": "Valid EN 16931 UBL: 3 lines, two standard rates (19%/7%), a "
                "document allowance + charge; all totals reconcile.",
    },
    {
        "name": "synth-ubl-good-xrechnung",
        "path": "corpus/synthetic/synth-ubl-good-xrechnung.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "Valid XRechnung 3.0 UBL: two S-rated lines + discount, German "
                "mandatory data present (BuyerReference, seller contact, VAT id).",
    },
    # ---- synthetic UBL, bad ----
    {
        "name": "synth-ubl-bad-vat-mismatch",
        "path": "corpus/synthetic/synth-ubl-bad-vat-mismatch.xml",
        "syntax": "UBL",
        "profile": "en16931",
        "note": "Document VAT total (BT-110) 300.00 != Σ breakdown 289.50 -> "
                "BR-CO-14 fatal (VAT-total mismatch).",
    },
    {
        "name": "synth-ubl-bad-missing-buyerref",
        "path": "corpus/synthetic/synth-ubl-bad-missing-buyerref.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "XRechnung invoice with the Buyer reference (BT-10) dropped -> "
                "BR-DE-15 fatal (a German-mandatory field is missing).",
    },
    {
        "name": "synth-ubl-bad-exempt-noreason",
        "path": "corpus/synthetic/synth-ubl-bad-exempt-noreason.xml",
        "syntax": "UBL",
        "profile": "en16931",
        "note": "Exempt (E) line + breakdown with no exemption reason "
                "(BT-120/121) -> BR-E-10 fatal (invalid tax-category state).",
    },
    # ---- synthetic CII, good ----
    {
        "name": "synth-cii-good-multiline",
        "path": "corpus/synthetic/synth-cii-good-multiline.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "Valid EN 16931 CII: 3 lines, two standard rates (19%/7%), a "
                "header allowance + charge; breakdown and totals reconcile.",
    },
    {
        "name": "synth-cii-good-zero-rated",
        "path": "corpus/synthetic/synth-cii-good-zero-rated.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "Valid EN 16931 CII mixing a standard-rated (S 19%) and a "
                "zero-rated (Z 0%) line; seller VAT id present, Z reasonless.",
    },
    # ---- synthetic CII, bad ----
    {
        "name": "synth-cii-bad-vat-mismatch",
        "path": "corpus/synthetic/synth-cii-bad-vat-mismatch.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "Header VAT total (BT-110) 230.00 != Σ breakdown 218.60 -> "
                "BR-CO-14 fatal (VAT-total mismatch).",
    },
    {
        "name": "synth-cii-bad-missing-seller-vat",
        "path": "corpus/synthetic/synth-cii-bad-missing-seller-vat.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "Seller VAT registration (BT-31) removed while S-rated items "
                "remain -> BR-S-02 fatal (+ related seller-id rules).",
    },
    {
        "name": "synth-cii-bad-xrechnung-nocontact",
        "path": "corpus/synthetic/synth-cii-bad-xrechnung-nocontact.xml",
        "syntax": "CII",
        "profile": "xrechnung",
        "note": "XRechnung CII with the seller contact (BG-6) removed -> "
                "BR-DE-2 fatal (German-mandatory contact point missing).",
    },
    # ======================================================================
    # SYNTHETIC EDGE-BREADTH corpus (T-VHR.15). Five more fully fictional
    # fixtures covering shapes the set above under-covers: per-rate multi-VAT
    # aggregation (good + an isolated per-rate arithmetic error), all three
    # allowance/charge groups at once (BG-20 + BG-21 + line-level BG-27),
    # foreign document currency with a VAT accounting currency (BT-5 USD +
    # BT-6 EUR + BT-111), and an exact half-cent rounding boundary. Goldens
    # regenerate the same way: `python3 test_golden_snapshot.py --update`.
    # ======================================================================
    {
        "name": "synth-ubl-good-multivat",
        "path": "corpus/synthetic/synth-ubl-good-multivat.xml",
        "syntax": "UBL",
        "profile": "en16931",
        "note": "Valid EN 16931 UBL: 4 lines, TWO lines per rate (19%/7%), so "
                "each per-rate TaxSubtotal aggregates multiple lines; no "
                "document allowance/charge (that's multiline's shape).",
    },
    {
        "name": "synth-ubl-bad-multivat-subtotal",
        "path": "corpus/synthetic/synth-ubl-bad-multivat-subtotal.xml",
        "syntax": "UBL",
        "profile": "en16931",
        "note": "Same multi-rate shape but the 7% subtotal's BT-117 is 19.00 "
                "where 200.00 x 7% = 14.00 (outside the official +/-1 band) "
                "-> BR-CO-17 + BR-S-09 fatals. BT-110/BT-112 are kept "
                "consistent with the WRONG subtotal so BR-CO-14/15 HOLD — the "
                "error is isolated to the per-rate rules, unlike the "
                "BR-CO-14-shaped synth-*-bad-vat-mismatch fixtures.",
    },
    {
        "name": "synth-ubl-good-allowance-charge",
        "path": "corpus/synthetic/synth-ubl-good-allowance-charge.xml",
        "syntax": "UBL",
        "profile": "en16931",
        "note": "Valid EN 16931 UBL with ALL THREE allowance/charge groups: a "
                "document allowance (BG-20) AND charge (BG-21) AND a "
                "line-level allowance (BG-27, the only fixture carrying one); "
                "BT-131 = 500 - 20, BT-109 = 600 - 50 + 30, totals reconcile.",
    },
    # ======================================================================
    # SINGLE-DOCUMENT ERP-SCALE mixed-category aggregation (T-VHR.24). ONE
    # realistic 24-line UBL invoice spanning THREE VAT categories together
    # (S 19% + Z 0% + E 0%), each with a matching TaxSubtotal, plus a
    # document-level allowance (BG-20) AND charge (BG-21) AND a line-level
    # allowance (BG-27) — so the whole total-aggregation / VAT-breakdown
    # BR-CO family (BR-CO-10..17) is exercised at ERP scale in one document,
    # distinct from R.15's small multi-VAT fixtures (4 lines) and VHPERF's
    # latency bench. Plus a negative twin with ONE isolated aggregation
    # defect. Goldens regenerate via `python3 test_golden_snapshot.py --update`.
    # ======================================================================
    {
        "name": "synth-ubl-good-large-mixed",
        "path": "corpus/synthetic/synth-ubl-good-large-mixed.xml",
        "syntax": "UBL",
        "profile": "en16931",
        "note": "Valid EN 16931 UBL at single-document ERP scale: 24 lines "
                "across THREE VAT categories together (S 19% x14, Z 0% x6, "
                "E 0% x4), each with its own TaxSubtotal; a document allowance "
                "(BG-20, 60.00) AND charge (BG-21, 40.00) both on S 19%, and a "
                "line-level allowance (BG-27, 25.00 on line 1). BT-106=4700.00, "
                "BT-109=4680.00, S taxable 2740.00 -> VAT 520.60, BT-112=5200.60 "
                "— all BR-CO-10..17 reconcile: valid=true, exit 0, zero rules.",
    },
    {
        "name": "synth-ubl-bad-large-mixed",
        "path": "corpus/synthetic/synth-ubl-bad-large-mixed.xml",
        "syntax": "UBL",
        "profile": "en16931",
        "note": "NEGATIVE TWIN of synth-ubl-good-large-mixed (T-VHR.24): "
                "byte-for-byte identical EXCEPT BT-106 "
                "(LineExtensionAmount) is stated 4600.00 where the 24 line net "
                "amounts sum to 4700.00. That one stated total no longer sums to "
                "its lines, firing exactly the two total-aggregation rules that "
                "consume BT-106: BR-CO-10 (BT-106 = Sigma BT-131) AND BR-CO-13 "
                "(BT-109 = BT-106 - BT-107 + BT-108, which reads the stated "
                "BT-106), both fatal. Every other field stays consistent so "
                "BR-CO-11/12/14/15/16/17 and the S/Z/E breakdown rules HOLD — "
                "the defect is isolated to the line-sum aggregation, distinct "
                "from bad-multivat-subtotal (BR-CO-17 + BR-S-09) and "
                "bad-fullshape (BR-CO-15): valid=false, exit 1.",
    },
    {
        "name": "synth-ubl-good-fullshape",
        "path": "fixtures/synth-ubl-good-fullshape_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "Valid XRechnung 3.0 UBL FULL-SHAPE invoice (T-VHR.18): the one "
                "fixture combining EVERY mandatory BG group in a single document "
                "— BG-4 seller + BG-6 contact + BT-31 VAT id, BG-7 buyer + BT-10 "
                "BuyerReference, BG-13 delivery date, 4 lines across TWO VAT "
                "rates (19%/7%), a BG-27 line allowance AND a BG-28 line charge, "
                "a BG-20 document allowance (19%) AND a BG-21 document charge "
                "(7%), and TWO BG-23 VAT breakdowns. BT-84 is the ISO 13616 "
                "example IBAN (valid check digits) so it validates CLEAN under "
                "the German CIUS: valid=true, exit 0, zero fired rules.",
    },
    {
        "name": "synth-ubl-bad-fullshape",
        "path": "fixtures/synth-ubl-bad-fullshape_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "NEGATIVE TWIN of synth-ubl-good-fullshape (T-VHR.19): byte-for-"
                "byte identical EXCEPT the document-level grand total is "
                "overstated — BT-112 (TaxInclusiveAmount) AND BT-115 "
                "(PayableAmount) both stated 990.60 instead of the reconciling "
                "780.00 + 120.60 = 900.60. The two grand-total fields move "
                "together, so BR-CO-16 (payable = grand total) stays satisfied "
                "and the ONLY fired rule is BR-CO-15 (fatal): invoice total with "
                "VAT must equal total-without-VAT + total-VAT. Every mandatory BG "
                "group is intact (still full-shape), isolating exactly one "
                "distinct fatal — distinct from the BR-CO-14 vat-mismatch and "
                "BR-DE-15 missing-buyerref pinned by the thin bad-synth goldens: "
                "valid=false, exit 1.",
    },
    {
        "name": "synth-ubl-good-reverse-charge",
        "path": "fixtures/synth-ubl-good-reverse-charge_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "Valid XRechnung 3.0 UBL REVERSE-CHARGE invoice (T-VHR.20): a "
                "domestic German § 13b UStG subcontractor invoice where the tax "
                "liability shifts to the recipient, so EVERY line carries BT-151 "
                "VAT category AE ('Reverse charge') at BT-152 rate 0 and the "
                "invoice shows ZERO VAT. Exercises the AE family the S-rated "
                "full-shape fixture never touches: BG-4 seller + BG-6 contact + "
                "BT-31 seller VAT id AND BG-7 buyer + BT-48 buyer VAT id (BR-AE-02 "
                "needs BOTH), 2 AE lines (BR-AE-05 rate 0), exactly one BG-23 AE "
                "breakdown with BT-116 = Σ AE nets = 15000.00 and BT-117 = 0.00 "
                "(BR-AE-01/08/09), and the mandated exemption reason on that "
                "breakdown — BT-121 code VATEX-EU-AE (on the CEF VATEX list, "
                "BR-CL-22) AND BT-120 text 'Reverse charge' (BR-AE-10). Clean "
                "under the German CIUS: valid=true, exit 0, zero fired rules.",
    },
    {
        "name": "synth-ubl-bad-reverse-charge",
        "path": "fixtures/synth-ubl-bad-reverse-charge_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "NEGATIVE TWIN of synth-ubl-good-reverse-charge (T-VHR.20): "
                "byte-for-byte identical EXCEPT the sole AE VAT breakdown carries "
                "NO exemption reason — both the BT-121 code (VATEX-EU-AE) AND the "
                "BT-120 text ('Reverse charge') are removed. The arithmetic is "
                "untouched (VAT total 0.00, taxable = Σ AE nets, tax inclusive = "
                "tax exclusive all still reconcile) so NO BR-CO totals rule and "
                "no other AE rule fires: the ONLY fired rule is BR-AE-10 (fatal) "
                "— an AE breakdown SHALL carry a BT-121 code or BT-120 text "
                "meaning 'Reverse charge'. Exactly one distinct fatal, isolating "
                "the BR-AE-10 shape distinct from the BR-CO-15/14 and BR-DE-15 "
                "fatals pinned by the other bad-synth goldens: valid=false, "
                "exit 1.",
    },
    {
        "name": "synth-ubl-good-intra-community",
        "path": "fixtures/synth-ubl-good-intra-community_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "Valid XRechnung 3.0 UBL INTRA-COMMUNITY-SUPPLY invoice "
                "(T-VHR.21): a German seller invoicing a VAT-registered business "
                "in another EU member state (France) for goods shipped across "
                "the border — an innergemeinschaftliche Lieferung (§ 4 Nr. 1b / "
                "§ 6a UStG) exempt under VAT category K, so EVERY line carries "
                "BT-151 category K at BT-152 rate 0 and the invoice shows ZERO "
                "VAT. Exercises the K family no other fixture touches — DISTINCT "
                "from the AE reverse-charge (T-VHR.20) and the S/Z/E shapes: "
                "BG-4 seller + BT-31 VAT-scoped seller VAT id AND BG-7 buyer + "
                "BT-48 buyer VAT id (BR-IC-02 needs BOTH), 2 K lines (BR-IC-05 "
                "rate 0), exactly one BG-23 K breakdown with BT-116 = Σ K nets = "
                "10500.00 and BT-117 = 0.00 (BR-IC-01/08/09), the mandated "
                "exemption reason — BT-121 code VATEX-EU-IC (on the CEF VATEX "
                "list, BR-CL-22) AND BT-120 text (BR-IC-10), plus the K-only "
                "document requirements BR-IC-11 (BT-72 actual delivery date) "
                "and BR-IC-12 (BT-80 deliver-to country FR). Clean under the "
                "German CIUS: valid=true, exit 0, zero fired rules.",
    },
    {
        "name": "synth-ubl-bad-intra-community",
        "path": "fixtures/synth-ubl-bad-intra-community_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "NEGATIVE TWIN of synth-ubl-good-intra-community (T-VHR.21): "
                "byte-for-byte identical EXCEPT the Buyer VAT identifier (BT-48) "
                "is removed — the customer's cac:PartyTaxScheme[VAT]/CompanyID "
                "(FR00000000000) is deleted. For an intra-community supply "
                "BR-IC-02 mandates a VAT-scoped Seller identifier AND the Buyer "
                "VAT identifier on any invoice carrying a K line; with BT-48 "
                "gone that conjunction is broken. The arithmetic is untouched "
                "(VAT total 0.00, taxable = Σ K nets, tax inclusive = tax "
                "exclusive all still reconcile) and the K exemption reason, "
                "delivery date and deliver-to country are all intact, so no "
                "BR-CO totals rule and no other BR-IC rule fires: the ONLY "
                "fired rule is BR-IC-02 (fatal). Exactly one distinct fatal, "
                "isolating the BR-IC-02 shape distinct from the BR-AE-10, "
                "BR-CO-15/14 and BR-DE-15 fatals pinned by the other bad-synth "
                "goldens: valid=false, exit 1.",
    },
    {
        "name": "synth-ubl-good-export",
        "path": "fixtures/synth-ubl-good-export_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "Valid XRechnung 3.0 UBL EXPORT-OUTSIDE-THE-EU invoice "
                "(T-VHR.22): a German seller invoicing a business in a NON-EU "
                "third country (Switzerland) for goods physically exported out "
                "of the Union — a steuerfreie Ausfuhrlieferung (§ 4 Nr. 1a / § 6 "
                "UStG) exempt under VAT category G, so EVERY line carries BT-151 "
                "category G at BT-152 rate 0 and the invoice shows ZERO VAT. "
                "Exercises the G family no other fixture touches — DISTINCT from "
                "the AE reverse-charge (T-VHR.20), the K intra-community "
                "(T-VHR.21) and the S/Z/E shapes: BG-4 seller + BT-31 "
                "VAT-scoped seller VAT id (BR-G-02 needs a VAT-SCOPED seller id "
                "like BR-IC-02 but with NO buyer-VAT-id conjunct — the export "
                "buyer in a third country carries none), 2 G lines (BR-G-05 rate "
                "0), exactly one BG-23 G breakdown with BT-116 = Σ G nets = "
                "11400.00 and BT-117 = 0.00 (BR-G-08/09), plus the mandated "
                "exemption reason — BT-121 code VATEX-EU-G (on the CEF VATEX "
                "list, BR-CL-22) AND BT-120 text (BR-G-10). Clean under the "
                "German CIUS: valid=true, exit 0, zero fired rules.",
    },
    {
        "name": "synth-ubl-bad-export",
        "path": "fixtures/synth-ubl-bad-export_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "NEGATIVE TWIN of synth-ubl-good-export (T-VHR.22): byte-for-"
                "byte identical EXCEPT the mandated exemption reason is stripped "
                "from the single G VAT breakdown — BOTH the BT-121 code "
                "(VATEX-EU-G) and the BT-120 text are deleted. For an Export "
                "outside the EU BR-G-10 mandates a VAT exemption reason code OR "
                "text on any G breakdown; with both gone that disjunction is "
                "broken. The seller VAT id keeps BR-G-02 satisfied, the G line "
                "rates are still 0 (BR-G-05), the breakdown taxable still equals "
                "Σ G nets (BR-G-08) and its tax is still 0.00 (BR-G-09), and the "
                "arithmetic is untouched (VAT total 0.00, tax inclusive = tax "
                "exclusive all reconcile), so no BR-CO totals rule and no other "
                "BR-G rule fires: the ONLY fired rule is BR-G-10 (fatal). "
                "Exactly one distinct fatal, isolating the BR-G-10 shape "
                "distinct from the BR-AE-10, BR-IC-02, BR-CO-15/14 and BR-DE-15 "
                "fatals pinned by the other bad-synth goldens: valid=false, "
                "exit 1.",
    },
    {
        "name": "synth-ubl-good-not-subject",
        "path": "fixtures/synth-ubl-good-not-subject_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "Valid XRechnung 3.0 UBL NOT-SUBJECT-TO-VAT invoice (T-VHR.22): "
                "a German consultancy invoicing for a supply OUTSIDE the scope "
                "of VAT (a nicht steuerbarer Umsatz — place of supply outside "
                "the Union) under VAT category O, ZERO VAT. Category O is the "
                "structural ODD ONE OUT — its BR-O family is PROHIBITIONS, so "
                "this fixture deliberately OMITS what every other category "
                "requires: NO VAT id anywhere (BR-O-02 forbids Seller BT-31 / "
                "tax-rep BT-63 / Buyer BT-48; the seller is identified by its "
                "BT-30 legal registration id alone, satisfying BR-CO-26, and "
                "since O is NOT in the BR-DE-16 trigger set the missing seller "
                "tax id does not trip BR-DE-16), NO line VAT rate (BR-O-05). The "
                "single BG-23 O breakdown still carries BT-119 = 0 (the German "
                "BR-DE-14 mandates a breakdown rate with no O carve-out), is "
                "O-only (BR-O-11/12/13/14 exclusivity), has BT-116 = Σ O nets = "
                "7500.00 and BT-117 = 0.00 (BR-O-08/09), plus the mandated "
                "exemption reason — BT-121 code VATEX-EU-O (BR-CL-22) AND BT-120 "
                "text (BR-O-10). Clean under the German CIUS: valid=true, exit "
                "0, zero fired rules.",
    },
    {
        "name": "synth-ubl-bad-not-subject",
        "path": "fixtures/synth-ubl-bad-not-subject_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "NEGATIVE TWIN of synth-ubl-good-not-subject (T-VHR.22): byte-"
                "for-byte identical EXCEPT a VAT-scheme Seller "
                "PartyTaxScheme/CompanyID (BT-31, DE000000000) is ADDED back to "
                "the Seller. Category O's BR-O-02 is a PROHIBITION (inverse "
                "polarity of every other family's -02): an O invoice SHALL NOT "
                "contain a Seller/tax-representative/Buyer VAT identifier, so "
                "re-introducing the seller VAT id makes BR-O-02 fire. The O "
                "lines still carry no line rate (BR-O-05), the O breakdown still "
                "has BT-119 = 0, tax 0.00, the VATEX-EU-O reason and O-only "
                "exclusivity, and the arithmetic is untouched, so no BR-CO rule "
                "and no other BR-O rule fires; the added VAT id is format-clean "
                "and O is not in the BR-DE-16 trigger set, so nothing else "
                "fires: the ONLY fired rule is BR-O-02 (fatal). Exactly one "
                "distinct fatal, isolating the BR-O-02 prohibition shape "
                "distinct from the BR-G-10, BR-AE-10, BR-IC-02 and BR-CO fatals "
                "pinned by the other bad-synth goldens: valid=false, exit 1.",
    },
    # ---- synthetic UBL, document-TYPE axis: corrected (384) + self-billed
    #      (389) + their broken twins (T-VHR.26) ----
    {
        "name": "synth-ubl-good-corrected",
        "path": "fixtures/synth-ubl-good-corrected_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "Valid XRechnung 3.0 UBL CORRECTED invoice (T-VHR.26): the "
                "full-shape body but issued as a correction — BT-3 "
                "InvoiceTypeCode 384 (Corrected invoice) instead of 380. "
                "Exercises the document-TYPE axis (distinct from the "
                "VAT-category and UBL-vs-CII axes). Because BT-3 is 384, "
                "XRechnung BR-DE-26 requires a PRECEDING INVOICE REFERENCE "
                "(BG-3/BT-25); this fixture supplies it via "
                "cac:BillingReference/cac:InvoiceDocumentReference (Preceding "
                "Invoice reference SYNTH-UBL-XR-2024-0021 + issue date), so "
                "BR-DE-26 is satisfied and the invoice validates CLEAN: "
                "valid=true, exit 0, zero fired rules. Differential-proven "
                "0-divergence against BOTH the EN16931-UBL and XRechnung-UBL "
                "official Schematron.",
    },
    {
        "name": "synth-ubl-bad-corrected",
        "path": "fixtures/synth-ubl-bad-corrected_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "NEGATIVE TWIN of synth-ubl-good-corrected (T-VHR.26): "
                "byte-for-byte identical EXCEPT the cac:BillingReference "
                "(BG-3/BT-25 preceding-invoice reference) is DROPPED while BT-3 "
                "stays 384, so XRechnung BR-DE-26 fires. HONEST pin: BR-DE-26 "
                "is a WARNING, not a fatal, so the verdict does NOT flip — the "
                "engine emits valid=true, exit 0, with exactly one fired rule "
                "BR-DE-26 (warning). The official XRechnung Schematron "
                "independently fires exactly BR-DE-26 on this document "
                "(differential 0-divergence), so the golden pins the real "
                "engine output, not a guessed FAIL.",
    },
    {
        "name": "synth-ubl-good-selfbilled",
        "path": "fixtures/synth-ubl-good-selfbilled_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "Valid XRechnung 3.0 UBL SELF-BILLED invoice (T-VHR.26): the "
                "full-shape body issued under the self-billing "
                "(Gutschriftverfahren) arrangement — BT-3 InvoiceTypeCode 389 "
                "(Self-billed invoice) instead of 380. XRechnung BR-DE-17 "
                "admits 389 and no other rule keys on it, so an otherwise "
                "full-shape self-billed invoice validates CLEAN: valid=true, "
                "exit 0, zero fired rules. Differential-proven 0-divergence "
                "against BOTH the EN16931-UBL and XRechnung-UBL official "
                "Schematron.",
    },
    {
        "name": "synth-ubl-bad-selfbilled",
        "path": "fixtures/synth-ubl-bad-selfbilled_ubl.xml",
        "syntax": "UBL",
        "profile": "xrechnung",
        "note": "NEGATIVE TWIN of synth-ubl-good-selfbilled (T-VHR.26): "
                "byte-for-byte identical EXCEPT BT-3 InvoiceTypeCode is 71 "
                "instead of 389. Code 71 is a valid UNTDID 1001 Invoice code "
                "(EN 16931 BR-CL-01 stays clear) but is NOT in the "
                "XRechnung-allowed BT-3 subset (326/380/384/389/381/875/876/"
                "877), so XRechnung BR-DE-17 fires. HONEST pin: BR-DE-17 is a "
                "WARNING, so the verdict does NOT flip — the engine emits "
                "valid=true, exit 0, with exactly one fired rule BR-DE-17 "
                "(warning). The official XRechnung Schematron independently "
                "fires exactly BR-DE-17 on this document (differential "
                "0-divergence).",
    },
    {
        "name": "synth-cii-good-foreign-currency",
        "path": "corpus/synthetic/synth-cii-good-foreign-currency.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "Valid EN 16931 CII in USD (BT-5) with VAT accounting currency "
                "EUR (BT-6): two ram:TaxTotalAmount — 190.00 USD (BT-110) and "
                "176.70 EUR (BT-111) — satisfying BR-53's BT-6-present branch. "
                "The only fixture with a BT-6 at all.",
    },
    {
        "name": "synth-cii-good-rounding-boundary",
        "path": "corpus/synthetic/synth-cii-good-rounding-boundary.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "Valid EN 16931 CII whose S-19% breakdown sits exactly on a "
                "half-cent: 50.50 x 19% = 9.595, stated as fn:round's "
                "toward-+inf result 9.60; BT-110 = Σ BT-117 and BT-112 = "
                "50.50 + 9.60 must then hold EXACTLY (BR-CO-14/15 have no "
                "tolerance band, unlike BR-CO-17).",
    },
    # ---- synthetic CII, FULL-SHAPE good + broken twin (T-VHCII2.1) ----
    {
        "name": "synth-cii-good-fullshape",
        "path": "corpus/synthetic/synth-cii-good-fullshape.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "Valid EN 16931 CII (ZUGFeRD/Factur-X-shaped) FULL-SHAPE "
                "invoice — the CII-syntax parity of synth-ubl-good-fullshape: "
                "the one CII fixture combining BG-4 seller (address + BT-31 VAT "
                "id + BG-6 contact) AND BG-7 buyer (address + BT-48 VAT id), "
                "three lines across TWO standard rates (19%/7%), a BG-27 "
                "line-level allowance AND a BG-28 line-level charge, a BG-20 "
                "document allowance (19%) AND a BG-21 document charge (19%), and "
                "TWO BG-23 VAT breakdowns; every total reconciles so it "
                "validates CLEAN: valid=true, exit 0, zero fired rules.",
    },
    {
        "name": "synth-cii-bad-fullshape",
        "path": "corpus/synthetic/synth-cii-bad-fullshape.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "NEGATIVE TWIN of synth-cii-good-fullshape (mirrors R.19's "
                "shape in CII): byte-for-byte identical EXCEPT the document "
                "grand total is overstated — ram:GrandTotalAmount (BT-112) AND "
                "ram:DuePayableAmount (BT-115) both state 1991.80 instead of the "
                "reconciling 1620.00 + 271.80 = 1891.80. The two fields move "
                "together so BR-CO-16 (amount due = grand total) stays satisfied "
                "and the CII BR-CO-15 disjunct GrandTotal=TaxBasisTotal is also "
                "broken, so the ONLY fired rule is BR-CO-15 (fatal): total with "
                "VAT must equal total-without-VAT + total-VAT. One distinct "
                "fatal, distinct from the BR-CO-14 / BR-S-02 / BR-DE-2 fatals "
                "pinned by the other bad-synth CII goldens: valid=false, exit 1.",
    },
    # ---- synthetic CII, REVERSE-CHARGE (AE) good + broken twin (T-VHCII2.2) ----
    {
        "name": "synth-cii-good-reverse-charge",
        "path": "corpus/synthetic/synth-cii-good-reverse-charge.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "Valid EN 16931 CII (ZUGFeRD/Factur-X-shaped) REVERSE-CHARGE "
                "invoice (T-VHCII2.2) — the CII-syntax parity of the UBL "
                "synth-ubl-good-reverse-charge (R.20): a domestic § 13b UStG "
                "reverse-charge document where EVERY line is VAT category AE at "
                "rate 0 and the invoice shows ZERO VAT. Exercises the AE family "
                "the S/Z/E CII fixtures do not: BT-31 seller VAT id AND BT-48 "
                "buyer VAT id both present (BR-AE-02 needs BOTH), 2 AE lines at "
                "rate 0 (BR-AE-05), exactly one AE VAT breakdown (BR-AE-01) with "
                "BT-116 = Σ AE nets = 700.00 and BT-117 = 0.00 (BR-AE-08/09), and "
                "the mandated exemption reason on that breakdown — BT-121 code "
                "VATEX-EU-AE (on the CEF VATEX list, BR-CL-22) AND BT-120 text "
                "'Reverse charge' (BR-AE-10). Arithmetic reconciles so it "
                "validates CLEAN: valid=true, exit 0, zero fired rules.",
    },
    {
        "name": "synth-cii-bad-reverse-charge",
        "path": "corpus/synthetic/synth-cii-bad-reverse-charge.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "NEGATIVE TWIN of synth-cii-good-reverse-charge (T-VHCII2.2): "
                "byte-for-byte identical EXCEPT the sole AE VAT breakdown carries "
                "NO exemption reason — both the BT-120 text (ram:ExemptionReason "
                "'Reverse charge') AND the BT-121 code (ram:ExemptionReasonCode "
                "VATEX-EU-AE) are removed. The arithmetic is untouched (VAT total "
                "0.00, taxable = Σ AE nets = 700.00) and both party VAT ids stay "
                "present, so no other AE rule fires: the ONLY fired rule is "
                "BR-AE-10 (fatal) — an AE breakdown SHALL carry a BT-121 code or "
                "BT-120 text meaning 'Reverse charge'. Exactly one distinct fatal, "
                "isolating the CII binding of the BR-AE-10 shape (parser_cii "
                "ram:ExemptionReason/Code → TaxSubtotal) distinct from the "
                "BR-CO-15 / BR-CO-14 / BR-S-02 fatals pinned by the other "
                "bad-synth CII goldens: valid=false, exit 1.",
    },
    # ---- synthetic CII, INTRA-COMMUNITY (K) good + broken twin (T-VHCII2.3) ----
    {
        "name": "synth-cii-good-intra-community",
        "path": "corpus/synthetic/synth-cii-good-intra-community.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "Valid EN 16931 CII (ZUGFeRD/Factur-X-shaped) INTRA-COMMUNITY-"
                "SUPPLY invoice (T-VHCII2.3) — the CII-syntax parity of the UBL "
                "synth-ubl-good-intra-community (R.21): a German seller invoicing "
                "a VAT-registered business in another EU member state (France) "
                "for goods shipped across the border, an innergemeinschaftliche "
                "Lieferung (Sec.4 Nr.1b / Sec.6a UStG) exempt under VAT category "
                "K, so EVERY line carries ram:CategoryCode K at rate 0 and the "
                "invoice shows ZERO VAT. Exercises the K family no other CII "
                "fixture touches — DISTINCT from the AE reverse-charge (T-VHCII2.2) "
                "and the S/Z/E shapes: BT-31 seller VAT id (VAT-scoped "
                "SpecifiedTaxRegistration schemeID 'VA') AND BT-48 buyer VAT id "
                "both present (BR-IC-02 needs BOTH), 2 K lines at rate 0 "
                "(BR-IC-05), exactly one K VAT breakdown (BR-IC-01) with "
                "BT-116 = Σ K nets = 10500.00 and BT-117 = 0.00 (BR-IC-08/09), "
                "the mandated exemption reason — BT-121 code VATEX-EU-IC (on the "
                "CEF VATEX list, BR-CL-22) AND BT-120 text (BR-IC-10) — plus the "
                "two K-only document requirements the AE family has no analogue "
                "for: BR-IC-11 (BT-72 actual delivery date via "
                "ram:ActualDeliverySupplyChainEvent/ram:OccurrenceDateTime/"
                "udt:DateTimeString) and BR-IC-12 (BT-80 deliver-to country FR "
                "via ram:ShipToTradeParty/ram:PostalTradeAddress/ram:CountryID). "
                "Arithmetic reconciles so it validates CLEAN: valid=true, exit 0, "
                "zero fired rules.",
    },
    {
        "name": "synth-cii-bad-intra-community",
        "path": "corpus/synthetic/synth-cii-bad-intra-community.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "NEGATIVE TWIN of synth-cii-good-intra-community (T-VHCII2.3): "
                "byte-for-byte identical EXCEPT the Buyer VAT identifier (BT-48) "
                "is deleted — the buyer trade party's whole "
                "ram:SpecifiedTaxRegistration (ID schemeID 'VA' = FR00000000000) "
                "is removed. For an intra-community supply (K) BR-IC-02 mandates "
                "a VAT-scoped Seller identifier (still present) AND the Buyer VAT "
                "identifier on any invoice carrying a K line; with BT-48 gone "
                "that conjunction is broken. The arithmetic is untouched (VAT "
                "total 0.00, taxable = Σ K nets = 10500.00, all totals "
                "reconcile) and the K exemption reason, the actual delivery date "
                "(BR-IC-11) and the deliver-to country FR (BR-IC-12) are all "
                "intact, so no BR-CO totals rule and no other BR-IC rule fires: "
                "the ONLY fired rule is BR-IC-02 (fatal). Exactly one distinct "
                "fatal, isolating the CII binding of the BR-IC-02 shape "
                "(parser_cii buyer VAT SpecifiedTaxRegistration → "
                "buyer_has_vat_scheme_company_id) distinct from the BR-AE-10, "
                "BR-CO-15/14 and BR-S-02 fatals pinned by the other bad-synth "
                "CII goldens: valid=false, exit 1.",
    },
    # ---- synthetic CII, EXPORT-OUTSIDE-EU (G) good + broken twin (T-VHCII2.3) --
    {
        "name": "synth-cii-good-export",
        "path": "corpus/synthetic/synth-cii-good-export.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "Valid EN 16931 CII (ZUGFeRD/Factur-X-shaped) EXPORT-OUTSIDE-THE-"
                "EU invoice (T-VHCII2.3) — the CII-syntax parity of the UBL "
                "synth-ubl-good-export (R.22): a German seller invoicing a "
                "business in a NON-EU third country (Switzerland) for goods "
                "physically exported out of the Union, a steuerfreie "
                "Ausfuhrlieferung (Sec.4 Nr.1a / Sec.6 UStG) exempt under VAT "
                "category G, so EVERY line carries ram:CategoryCode G at rate 0 "
                "and the invoice shows ZERO VAT. Exercises the G family no other "
                "CII fixture touches — DISTINCT from the AE reverse-charge "
                "(T-VHCII2.2), the K intra-community and the S/Z/E shapes: BT-31 "
                "seller VAT id VAT-scoped (BR-G-02 needs a VAT-SCOPED seller id "
                "BT-31/BT-63, the SAME scoping as BR-IC-02 but with NO buyer-VAT-"
                "id conjunct — the export buyer in a third country carries none, "
                "so the Swiss BuyerTradeParty has no SpecifiedTaxRegistration), "
                "2 G lines at rate 0 (BR-G-05), exactly one G VAT breakdown "
                "(BR-G-01) with BT-116 = Σ G nets = 11400.00 and BT-117 = 0.00 "
                "(BR-G-08/09), plus the mandated exemption reason — BT-121 code "
                "VATEX-EU-G (on the CEF VATEX list, BR-CL-22) AND BT-120 text "
                "(BR-G-10). Arithmetic reconciles so it validates CLEAN: "
                "valid=true, exit 0, zero fired rules.",
    },
    {
        "name": "synth-cii-bad-export",
        "path": "corpus/synthetic/synth-cii-bad-export.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "NEGATIVE TWIN of synth-cii-good-export (T-VHCII2.3): byte-for-"
                "byte identical EXCEPT the mandated exemption reason is stripped "
                "from the single G VAT breakdown — BOTH the BT-121 code "
                "(ram:ExemptionReasonCode VATEX-EU-G) AND the BT-120 text "
                "(ram:ExemptionReason) are removed. For an Export outside the EU "
                "(G) BR-G-10 mandates a VAT exemption reason code OR text on any "
                "G breakdown; with both gone that disjunction is broken. The "
                "seller VAT id keeps BR-G-02 satisfied, the G line rates are "
                "still 0 (BR-G-05), the breakdown taxable still equals Σ G nets "
                "= 11400.00 (BR-G-08) and its tax is still 0.00 (BR-G-09), and "
                "the arithmetic is untouched (all totals reconcile), so no BR-CO "
                "totals rule and no other BR-G rule fires: the ONLY fired rule "
                "is BR-G-10 (fatal). Exactly one distinct fatal, isolating the "
                "CII binding of the BR-G-10 shape (parser_cii ram:ExemptionReason"
                "/Code → TaxSubtotal) distinct from the BR-IC-02, BR-AE-10 and "
                "BR-CO-15 fatals pinned by the other bad-synth CII goldens: "
                "valid=false, exit 1.",
    },
    # ---- CII full-shape THROUGH THE PDF-CONTAINER path (T-VHR.23) ----
    {
        "name": "pdf-container-cii-good-fullshape",
        "path": "corpus/pdf/facturx-fullshape.pdf",
        "syntax": "PDF-CONTAINER",
        "profile": "en16931",
        "note": "The SAME full-shape EN 16931 CII invoice as "
                "synth-cii-good-fullshape, but wrapped in a MATCHING Factur-X "
                "PDF container (corpus/pdf/facturx-fullshape.pdf, byte-repro "
                "from make_pdf_fixtures.py) and validated END-TO-END through the "
                "PDF-container path: report.build_report detects the %PDF magic, "
                "extracts the embedded CrossIndustryInvoice zero-dep and runs it "
                "through the same CII engine. The container is conformant (XMP EN "
                "16931 profile + PDF/A-3 pdfaid identity + /AFRelationship + /AF) "
                "so NO FX-CONTAINER-*/FX-PDFA3-* finding fires and the extracted "
                "verdict is IDENTICAL to validating the raw inner XML directly: "
                "valid=true, exit 0, zero fired rules. Pins the container promise "
                "over the full-shape invoice — the projection here must stay "
                "identical to the synth-cii-good-fullshape raw-CII golden.",
    },
    # ======================================================================
    # CII credit notes (Gutschrift, BT-3 ram:TypeCode 381). Committed
    # synthetic fixtures from T-VHCNCII.1, differentially PROVEN at 0
    # divergences against the official CEN EN16931-CII Schematron under the
    # en16931 profile (see test_cii_creditnote.py for the pinned sha256s and
    # the full proof record). Snapshotting them here freezes the proven
    # verdicts against silent drift.
    # ======================================================================
    {
        "name": "cii-good-creditnote-381",
        "path": "fixtures/creditnote-valid_cii.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "Business-rule-clean CII credit note (BT-3=381): validates "
                "CLEAN — 381 is on the official merged CII BR-CL-01 list. "
                "Differential proof: OFFICIAL (none) vs OURS (none).",
    },
    {
        "name": "cii-bad-creditnote-381",
        "path": "fixtures/creditnote-invalid_cii.xml",
        "syntax": "CII",
        "profile": "en16931",
        "note": "The same 381 credit note with BT-5 (InvoiceCurrencyCode) "
                "removed: exactly the real BR-05 fatal fires, never a "
                "fabricated rule. Differential proof: OFFICIAL BR-05 vs "
                "OURS BR-05.",
    },
]


# ==========================================================================
# Unsupported-container CLI machine-format goldens (T-VHPDFZ.2)
# ==========================================================================
# The hostile-PDF discipline is verdict-pinned at the MACHINE-FORMAT level:
# for the canonical corrupted-container fixture (corpus/pdf/
# facturx-truncated.pdf — a deterministic 1024-byte truncation of the valid
# Factur-X container, committed bytes reproducible from corpus/pdf/
# make_pdf_fixtures.py), the REAL `python3 -m einvoice.report --format <fmt>`
# CLI is driven for every machine format below and its ENTIRE stdout is
# asserted byte-identical to a committed golden file, alongside the measured,
# documented exit code 3 (EXIT_PARSE — the "could not reduce the input to a
# validatable invoice" error family, see EXIT-CODES.md) and the
# error='unsupported-container' non-pass shape. This freezes the honest
# container-failure contract: NEVER a false pass, NEVER a traceback, NEVER a
# silently drifting error document.
#
# Path normalization: the fixture path is passed RELATIVE with cwd=HERE, and
# the report CLI echoes the input path exactly as supplied (the measured
# path-echo rule pinned by test_path_invariance.py), so the emitted bytes are
# independent of where this checkout lives. json/junit/sarif emitters are
# already deterministic (sort_keys / fixed layout); no other normalization is
# needed or applied.
#
# T-VHPDFZ.1 NOTE (explicitly skipped spec leg, not fabricated): .1 (commit
# 1af8320) was a PURE test addition — test_fuzz_pdf_container.py, a
# deterministic fixed-seed fuzz harness — with ZERO source changes and ZERO
# real defects found, so there is NO ".1 regression fixture" to golden-pin.
# That leg is moot and deliberately skipped; the canonical fixture pinned here
# is a fresh deterministic truncation, not a fuzz-derived artifact.
CONTAINER_FIXTURE_PATH = os.path.join("corpus", "pdf", "facturx-truncated.pdf")

#: The three machine formats golden-pinned for the container-failure verdict,
#: each with the measured, documented exit code (3 = EXIT_PARSE for ALL of
#: them: report.py returns EXIT_PARSE whenever the report carries an `error`
#: field, regardless of format).
CONTAINER_FORMATS = ("json", "junit", "sarif")
CONTAINER_EXIT_CODE = 3

#: Golden file per format, following the existing golden/ conventions
#: (committed, regenerated only via --update / REGEN=1 as a reviewed decision).
CONTAINER_GOLDEN_NAMES = {
    "json": "container-unsupported-truncated.validate.json",
    "junit": "container-unsupported-truncated.validate.junit.xml",
    "sarif": "container-unsupported-truncated.validate.sarif.json",
}


def _container_cli(fmt):
    """Drive the REAL report CLI on the corrupted-container fixture with a
    RELATIVE path from HERE (path-echo determinism). Returns (rc, stdout
    bytes, stderr bytes)."""
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice.report", "--format", fmt,
         CONTAINER_FIXTURE_PATH],
        cwd=HERE, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return proc.returncode, proc.stdout, proc.stderr


def _container_shape_failures(fmt, rc, out, err):
    """Assert the error='unsupported-container' non-pass SHAPE (beyond byte
    identity, so a golden regenerated over a regression cannot hide it).
    Returns a list of human-readable failure lines (empty = shape OK)."""
    fails = []
    if rc != CONTAINER_EXIT_CODE:
        fails.append("  exit code: documented=%d got=%d"
                     % (CONTAINER_EXIT_CODE, rc))
    if err != b"":
        fails.append("  stderr not empty (traceback/diagnostic leak?): %r"
                     % err[:200])
    try:
        if fmt == "json":
            doc = json.loads(out.decode("utf-8"))
            if doc.get("error") != "unsupported-container":
                fails.append("  json error field: %r != 'unsupported-container'"
                             % doc.get("error"))
            if doc.get("valid") is not False:
                fails.append("  json valid: %r (must be false — never a "
                             "false pass)" % doc.get("valid"))
            if doc.get("violations") != []:
                fails.append("  json violations not empty")
        elif fmt == "junit":
            root = ET.fromstring(out.decode("utf-8"))
            if root.tag != "testsuites" or root.get("errors") != "1":
                fails.append("  junit: expected <testsuites errors=\"1\">, "
                             "got tag=%r errors=%r"
                             % (root.tag, root.get("errors")))
            cases = root.findall("./testsuite/testcase")
            if (len(cases) != 1
                    or cases[0].get("name") != "unsupported-container"
                    or cases[0].find("error") is None):
                fails.append("  junit: expected one "
                             "<testcase name='unsupported-container'> with an "
                             "<error> child")
        elif fmt == "sarif":
            doc = json.loads(out.decode("utf-8"))
            results = doc["runs"][0]["results"]
            if (len(results) != 1
                    or results[0].get("ruleId") != "unsupported-container"
                    or results[0].get("level") != "error"):
                fails.append("  sarif: expected one result with "
                             "ruleId='unsupported-container' level='error', "
                             "got %r" % results)
    except Exception as exc:  # noqa: BLE001 — any parse failure IS the finding
        fails.append("  %s output does not parse as a complete machine "
                     "document: %s" % (fmt, exc))
    return fails


def _container_golden_path(fmt):
    return os.path.join(GOLDEN_DIR, CONTAINER_GOLDEN_NAMES[fmt])


def write_container_goldens():
    """Regenerate the container-failure CLI goldens (only via --update)."""
    if not os.path.isdir(GOLDEN_DIR):
        os.makedirs(GOLDEN_DIR)
    for fmt in CONTAINER_FORMATS:
        rc, out, err = _container_cli(fmt)
        shape = _container_shape_failures(fmt, rc, out, err)
        if shape:
            raise SystemExit(
                "refusing to regenerate a golden over a BROKEN "
                "container-failure shape (--format %s):\n%s"
                % (fmt, "\n".join(shape)))
        with open(_container_golden_path(fmt), "wb") as fh:
            fh.write(out)
    return len(CONTAINER_FORMATS)


def check_container(failures):
    """Byte-compare each machine format against its committed golden AND
    assert the non-pass shape + exit code. Appends to `failures` in the same
    (headline, lines) form the fixture check uses."""
    for fmt in CONTAINER_FORMATS:
        name = "container-unsupported-truncated --format %s" % fmt
        gpath = _container_golden_path(fmt)
        rc, out, err = _container_cli(fmt)
        lines = _container_shape_failures(fmt, rc, out, err)
        if not os.path.isfile(gpath):
            failures.append(("MISSING golden for %r (run --update to create "
                             "it)." % name, [name]))
            continue
        with open(gpath, "rb") as fh:
            golden = fh.read()
        if out != golden:
            lines.append("  stdout drifted from committed golden %s "
                         "(golden %d bytes, now %d bytes)"
                         % (os.path.basename(gpath), len(golden), len(out)))
        if lines:
            failures.append((None, ["DRIFT in %r:" % name] + lines))


# ==========================================================================
# Conformance-RECEIPT goldens (T-VHR.16): the tamper-evidence bridge, pinned.
# ==========================================================================
# test_receipt.py proves the receipt's BEHAVIOURAL properties (determinism,
# honest pass, tamper-evidence, content-hash = f(body)); it does NOT pin the
# receipt BYTES against committed golden files, so a canonicalization or
# schema drift in einvoice/einvoice/receipt.py could silently change the
# emitted receipt with no failing test. This section closes that gap by
# freezing the EXACT `einvoice receipt` CLI stdout for five committed
# fixtures — no new invoice fixtures are introduced.
#
# CODE PATH (identical to the CLI): the `receipt` subcommand emits
# `canonical_json(build_receipt(path, profile=profile)) + "\n"` (cli.py). We
# pin exactly that: `receipt_json(path, profile) + "\n"` IS the CLI's stdout
# byte-for-byte. The receipt is deterministic by construction (no wall-clock
# unless an explicit issued_at is passed — we never pass one), so the bytes
# are stable across runs, paths and time.
#
# HONEST NOTE on the CII fixtures: build_receipt validates through the UBL
# validator (validate_file), which is what the shipping `receipt` subcommand
# actually does — it does NOT dispatch CII natively. A CII document is
# well-formed XML with a non-UBL root, so every CII fixture below yields a
# deterministic FAIL receipt whose sole fatal is the real structural S-ROOT
# check, exactly as `einvoice receipt <cii.xml>` prints today. We pin that
# true output rather than a prettier fiction; the five receipts still differ
# byte-for-byte (each carries its own input_sha256), so the pin catches any
# canonicalization / format / self-hash drift per fixture. This is PURE
# pinning of existing output — receipt.py is not touched.
#
# TWO independent assertions per fixture (so BOTH a body drift and a
# hash-field drift are caught):
#   (i)  byte-identity of the freshly built receipt vs the committed golden;
#   (ii) the embedded content_sha256 RECOMPUTES from the receipt body, checked
#        on BOTH the freshly built receipt AND the committed golden file (so a
#        hand-edited golden whose hash no longer matches its body also fails).
#
# Regeneration is the SAME one-command, reviewable convention as every other
# golden here: `python3 test_golden_snapshot.py --update` (or REGEN=1).
RECEIPT_FIXTURES = [
    # ---- (a) valid UBL ----
    {
        "name": "receipt-ubl-valid-xr-01.01a",
        "path": "corpus/vendored/valid/xr-01.01a_ubl.xml",
        "profile": "en16931",
        "note": "Valid EN 16931 UBL -> PASS receipt, failed_fatal_rules empty.",
    },
    # ---- (b) invalid UBL ----
    {
        "name": "receipt-ubl-invalid-creditnote-typecode",
        "path": "fixtures/creditnote-invalid-typecode_ubl.xml",
        "profile": "en16931",
        "note": "UBL CreditNote with BT-3=999 -> FAIL receipt, one BR-CL-01 "
                "fatal (the real rule, validated through the shared engine).",
    },
    # ---- (c) valid CII ----
    {
        "name": "receipt-cii-valid-example5",
        "path": "corpus/cen-en16931/cii/examples/CII_example5.xml",
        "profile": "en16931",
        "note": "Reference EN 16931 CII invoice. Through the UBL-only receipt "
                "code path it yields the deterministic S-ROOT FAIL receipt the "
                "`receipt` CLI prints for any CII file today.",
    },
    # ---- (d) invalid CII ----
    {
        "name": "receipt-cii-invalid-vat-mismatch",
        "path": "corpus/synthetic/synth-cii-bad-vat-mismatch.xml",
        "profile": "en16931",
        "note": "Synthetic CII with a VAT-total mismatch; via the receipt code "
                "path it is the deterministic S-ROOT FAIL receipt (distinct "
                "bytes: its own input_sha256).",
    },
    # ---- (e) the CII-381 credit note ----
    {
        "name": "receipt-cii-creditnote-381",
        "path": "fixtures/creditnote-valid_cii.xml",
        "profile": "en16931",
        "note": "CII credit note (BT-3 ram:TypeCode 381); via the receipt code "
                "path it is the deterministic S-ROOT FAIL receipt with its own "
                "input_sha256, pinning the tamper-evidence bytes for the 381 "
                "credit-note fixture.",
    },
    # ---- (e2) the reverse-charge (AE) CII invoice + twin (T-VHCII2.2) ----
    {
        "name": "receipt-cii-good-reverse-charge",
        "path": "corpus/synthetic/synth-cii-good-reverse-charge.xml",
        "profile": "en16931",
        "note": "The T-VHCII2.2 reverse-charge (AE) CII invoice through the "
                "`einvoice receipt` code path. HONEST LIMIT pinned (identical to "
                "every other receipt-cii-* entry): build_receipt validates through "
                "the UBL-only validate_file, so a CrossIndustryInvoice — "
                "well-formed XML with a non-UBL root — yields the deterministic "
                "S-ROOT FAIL receipt the `receipt` subcommand prints for any CII "
                "file today (it does NOT dispatch CII natively). The AE document's "
                "genuine PASS is pinned separately on the native CII validate path "
                "by the synth-cii-good-reverse-charge FIXTURES golden; this entry "
                "pins the tamper-evidence receipt bytes (its own input_sha256 over "
                "the committed fixture) so any receipt-path drift over the AE "
                "document surfaces here.",
    },
    {
        "name": "receipt-cii-bad-reverse-charge",
        "path": "corpus/synthetic/synth-cii-bad-reverse-charge.xml",
        "profile": "en16931",
        "note": "The T-VHCII2.2 reverse-charge negative twin through the "
                "`einvoice receipt` code path: the same deterministic S-ROOT FAIL "
                "receipt (distinct bytes: its own input_sha256 over the twin). The "
                "twin's engine-level defect (only BR-AE-10 fires) is pinned on the "
                "native CII validate path by the synth-cii-bad-reverse-charge "
                "FIXTURES golden; this pins the receipt bytes for the twin.",
    },
    # ---- (f) the full-shape XRechnung invoice (T-VHR.18), end-to-end ----
    {
        "name": "receipt-ubl-fullshape",
        "path": "fixtures/synth-ubl-good-fullshape_ubl.xml",
        "profile": "xrechnung",
        "note": "The T-VHR.18 full-shape XRechnung UBL invoice through the "
                "per-document attestation path: a PASS receipt "
                "(failed_fatal_rules empty) under the German profile, proving "
                "the whole product path (validate -> receipt) over the one "
                "document that exercises every mandatory BG group together. The "
                "SAME committed golden is byte-pinned by test_receipt.py.",
    },
    # ---- (g) the full-shape negative twin (T-VHR.19), end-to-end ----
    {
        "name": "receipt-ubl-bad-fullshape",
        "path": "fixtures/synth-ubl-bad-fullshape_ubl.xml",
        "profile": "xrechnung",
        "note": "The T-VHR.19 full-shape XRechnung negative twin through the "
                "per-document attestation path: a FAIL receipt "
                "(failed_fatal_rules contains BR-CO-15) under the German "
                "profile, proving validate -> receipt end-to-end over a "
                "full-shape invoice whose only defect is an overstated "
                "grand total. Mirrors the receipt-ubl-fullshape PASS entry.",
    },
    # ---- (g2) the ERP-scale mixed-category invoice (T-VHR.24), end-to-end ----
    {
        "name": "receipt-ubl-good-large-mixed",
        "path": "corpus/synthetic/synth-ubl-good-large-mixed.xml",
        "profile": "en16931",
        "note": "The T-VHR.24 single-document ERP-scale mixed-category (S/Z/E, "
                "24 lines) XRechnung-free EN 16931 UBL invoice through the "
                "per-document attestation path: a PASS receipt "
                "(failed_fatal_rules empty) under the en16931 profile, proving "
                "the whole product path (validate -> receipt) over the one "
                "large document that exercises the total-aggregation / "
                "VAT-breakdown BR-CO family (BR-CO-10..17) at scale. Pins the "
                "tamper-evidence receipt bytes (its own input_sha256 over the "
                "committed fixture).",
    },
    # ---- (h) the reverse-charge (AE) invoice (T-VHR.20), end-to-end ----
    {
        "name": "receipt-ubl-good-reverse-charge",
        "path": "fixtures/synth-ubl-good-reverse-charge_ubl.xml",
        "profile": "xrechnung",
        "note": "The T-VHR.20 reverse-charge (AE) XRechnung UBL invoice through "
                "the per-document attestation path: a PASS receipt "
                "(failed_fatal_rules empty) under the German profile, proving the "
                "whole product path (validate -> receipt) over a § 13b "
                "reverse-charge document where every line is VAT category AE at "
                "zero VAT.",
    },
    # ---- (i) the reverse-charge (AE) negative twin (T-VHR.20), end-to-end ----
    {
        "name": "receipt-ubl-bad-reverse-charge",
        "path": "fixtures/synth-ubl-bad-reverse-charge_ubl.xml",
        "profile": "xrechnung",
        "note": "The T-VHR.20 reverse-charge negative twin through the "
                "per-document attestation path: a FAIL receipt "
                "(failed_fatal_rules contains BR-AE-10) under the German profile, "
                "proving validate -> receipt end-to-end over an AE invoice whose "
                "only defect is a missing exemption reason on the AE breakdown. "
                "Mirrors the receipt-ubl-good-reverse-charge PASS entry.",
    },
    # ---- (i2) the document-TYPE axis (T-VHR.26), end-to-end ----
    {
        "name": "receipt-ubl-good-corrected",
        "path": "fixtures/synth-ubl-good-corrected_ubl.xml",
        "profile": "xrechnung",
        "note": "The T-VHR.26 CORRECTED (BT-3 384) XRechnung UBL invoice "
                "through the per-document attestation path: a PASS receipt "
                "(failed_fatal_rules empty) under the German profile, proving "
                "validate -> receipt end-to-end over a correction that carries "
                "its mandated preceding-invoice reference (BR-DE-26 satisfied).",
    },
    {
        "name": "receipt-ubl-bad-corrected",
        "path": "fixtures/synth-ubl-bad-corrected_ubl.xml",
        "profile": "xrechnung",
        "note": "The T-VHR.26 corrected-invoice twin (BT-3 384, preceding "
                "reference dropped) through the per-document attestation path. "
                "BR-DE-26 is a WARNING, so this is STILL a PASS receipt "
                "(failed_fatal_rules empty) — the receipt records the fatal "
                "verdict, and the sole fired rule is the non-fatal BR-DE-26. "
                "Pins the real receipt bytes for the twin.",
    },
    {
        "name": "receipt-ubl-good-selfbilled",
        "path": "fixtures/synth-ubl-good-selfbilled_ubl.xml",
        "profile": "xrechnung",
        "note": "The T-VHR.26 SELF-BILLED (BT-3 389) XRechnung UBL invoice "
                "through the per-document attestation path: a PASS receipt "
                "(failed_fatal_rules empty) under the German profile, proving "
                "validate -> receipt end-to-end over a self-billed document.",
    },
    {
        "name": "receipt-ubl-bad-selfbilled",
        "path": "fixtures/synth-ubl-bad-selfbilled_ubl.xml",
        "profile": "xrechnung",
        "note": "The T-VHR.26 self-billed twin (BT-3 71, outside the XRechnung "
                "subset) through the per-document attestation path. BR-DE-17 is "
                "a WARNING, so this is STILL a PASS receipt (failed_fatal_rules "
                "empty) — the sole fired rule is the non-fatal BR-DE-17. Pins "
                "the real receipt bytes for the twin.",
    },
    # ---- (j) the export (G) invoice (T-VHR.22), end-to-end ----
    {
        "name": "receipt-ubl-good-export",
        "path": "fixtures/synth-ubl-good-export_ubl.xml",
        "profile": "xrechnung",
        "note": "The T-VHR.22 export-outside-the-EU (G) XRechnung UBL invoice "
                "through the per-document attestation path: a PASS receipt "
                "(failed_fatal_rules empty) under the German profile, proving "
                "the whole product path (validate -> receipt) over a § 6 UStG "
                "Ausfuhrlieferung where every line is VAT category G at zero "
                "VAT.",
    },
    # ---- (k) the export (G) negative twin (T-VHR.22), end-to-end ----
    {
        "name": "receipt-ubl-bad-export",
        "path": "fixtures/synth-ubl-bad-export_ubl.xml",
        "profile": "xrechnung",
        "note": "The T-VHR.22 export (G) negative twin through the per-document "
                "attestation path: a FAIL receipt (failed_fatal_rules contains "
                "BR-G-10) under the German profile, proving validate -> receipt "
                "end-to-end over a G invoice whose only defect is a missing "
                "exemption reason on the G breakdown. Mirrors the "
                "receipt-ubl-good-export PASS entry.",
    },
    # ---- (l) the not-subject (O) invoice (T-VHR.22), end-to-end ----
    {
        "name": "receipt-ubl-good-not-subject",
        "path": "fixtures/synth-ubl-good-not-subject_ubl.xml",
        "profile": "xrechnung",
        "note": "The T-VHR.22 not-subject-to-VAT (O) XRechnung UBL invoice "
                "through the per-document attestation path: a PASS receipt "
                "(failed_fatal_rules empty) under the German profile, proving "
                "the whole product path (validate -> receipt) over an "
                "out-of-scope (nicht steuerbar) document where every line is "
                "VAT category O.",
    },
    # ---- (m) the not-subject (O) negative twin (T-VHR.22), end-to-end ----
    {
        "name": "receipt-ubl-bad-not-subject",
        "path": "fixtures/synth-ubl-bad-not-subject_ubl.xml",
        "profile": "xrechnung",
        "note": "The T-VHR.22 not-subject (O) negative twin through the "
                "per-document attestation path: a FAIL receipt "
                "(failed_fatal_rules contains BR-O-02) under the German "
                "profile, proving validate -> receipt end-to-end over an O "
                "invoice whose only defect is a Seller VAT id that category O "
                "prohibits. Mirrors the receipt-ubl-good-not-subject PASS "
                "entry.",
    },
    # ---- (n) the full-shape Factur-X PDF CONTAINER (T-VHR.23), end-to-end ----
    {
        "name": "receipt-pdf-container-fullshape",
        "path": "corpus/pdf/facturx-fullshape.pdf",
        "profile": "en16931",
        "note": "The full-shape Factur-X PDF container "
                "(corpus/pdf/facturx-fullshape.pdf) through the `einvoice "
                "receipt` code path. HONEST LIMIT pinned: build_receipt "
                "validates through validate_file (the UBL/XML path), which reads "
                "the raw file bytes as XML — a PDF's %PDF-1.7 header is NOT "
                "well-formed XML, so `einvoice receipt <pdf>` yields the "
                "deterministic S-WF FAIL receipt it prints for any PDF today "
                "(the receipt subcommand does not container-dispatch, unlike "
                "`validate`, which does — see the pdf-container-cii-good-"
                "fullshape validate golden that PASSES over the SAME file). This "
                "pins that true, byte-stable output (its own input_sha256 over "
                "the committed fixture bytes) so any future change to the receipt "
                "path over a container surfaces here for review.",
    },
]


def _receipt_golden_path(fixture):
    return os.path.join(GOLDEN_DIR, fixture["name"] + ".json")


def _built_receipt_bytes(fixture):
    """The EXACT `einvoice receipt` stdout for the fixture: the canonical
    receipt JSON followed by a trailing newline (cli.py writes
    ``canonical_json(build_receipt(...)) + "\\n"``). Deterministic."""
    abs_path = os.path.join(HERE, fixture["path"])
    return (receipt_json(abs_path, profile=fixture["profile"]) + "\n").encode("utf-8")


def _selfhash_failures_for_doc(doc):
    """Return failure lines if ``doc``'s embedded content_sha256 does not
    recompute from its receipt body (empty list = self-hash is intact)."""
    fails = []
    try:
        body = doc["receipt"]
        embedded = doc["content_sha256"]
    except (KeyError, TypeError) as exc:
        return ["  receipt document missing receipt/content_sha256: %s" % exc]
    recomputed = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    if embedded != recomputed:
        fails.append("  content_sha256 does not recompute from body: "
                     "embedded=%r recomputed=%r" % (embedded, recomputed))
    return fails


def write_receipt_goldens():
    """Regenerate the conformance-receipt goldens (only via --update)."""
    if not os.path.isdir(GOLDEN_DIR):
        os.makedirs(GOLDEN_DIR)
    for fixture in RECEIPT_FIXTURES:
        abs_path = os.path.join(HERE, fixture["path"])
        doc = build_receipt(abs_path, profile=fixture["profile"])
        selfhash = _selfhash_failures_for_doc(doc)
        if selfhash:
            raise SystemExit(
                "refusing to regenerate a golden over a BROKEN receipt "
                "self-hash (%s):\n%s"
                % (fixture["name"], "\n".join(selfhash)))
        with open(_receipt_golden_path(fixture), "wb") as fh:
            fh.write(_built_receipt_bytes(fixture))
    return len(RECEIPT_FIXTURES)


def check_receipts(failures):
    """For each receipt fixture assert (i) byte-identity of the freshly built
    receipt vs the committed golden AND (ii) the embedded content_sha256
    recomputes from the body — checked on BOTH the fresh receipt and the
    committed golden. Appends to `failures` in the same (headline, lines)
    form the fixture check uses."""
    for fixture in RECEIPT_FIXTURES:
        name = "receipt %s" % fixture["name"]
        gpath = _receipt_golden_path(fixture)
        abs_path = os.path.join(HERE, fixture["path"])

        # (ii) freshly built receipt: self-hash must recompute from its body.
        fresh_doc = build_receipt(abs_path, profile=fixture["profile"])
        lines = _selfhash_failures_for_doc(fresh_doc)

        built = _built_receipt_bytes(fixture)
        if not os.path.isfile(gpath):
            failures.append(("MISSING golden for %r (run --update to create "
                             "it)." % name, [name]))
            continue
        with open(gpath, "rb") as fh:
            golden = fh.read()
        # (i) byte-identity against the committed golden.
        if built != golden:
            lines.append("  receipt bytes drifted from committed golden %s "
                         "(golden %d bytes, now %d bytes)"
                         % (os.path.basename(gpath), len(golden), len(built)))
        # (ii, again) the committed golden's OWN self-hash must recompute too,
        # so a hand-edited golden body (or hash field) is caught even if the
        # code path were somehow made to agree with it.
        try:
            golden_doc = json.loads(golden.decode("utf-8"))
        except ValueError as exc:
            lines.append("  committed golden is not valid JSON: %s" % exc)
        else:
            lines.extend("  (committed golden)" + ln
                         for ln in _selfhash_failures_for_doc(golden_doc))
        if lines:
            failures.append((None, ["DRIFT in %r:" % name] + lines))


# ==========================================================================
# validate-batch AGGREGATE goldens (T-VHR.17): the batch report, byte-pinned.
# ==========================================================================
# test_cli_batch.py proves the ``einvoice validate-batch`` subcommand's
# BEHAVIOUR (per-file verdicts, exit-code precedence, glob==dir equivalence,
# --json/--quiet flags) but it never freezes the aggregate output BYTES against
# a committed golden — so a formatting or schema drift in build_batch_text /
# build_batch_report (report.py) could silently change what the batch prints
# with no failing test. This section closes that gap: it drives the REAL
# ``python3 -m einvoice validate-batch`` CLI over a COMMITTED mixed fixture set
# in BOTH the human-summary and the --json machine form, path-normalizes the
# volatile tmp prefix to stable basenames, and asserts the whole stdout is
# byte-identical to a committed golden alongside the measured aggregate exit
# code. It adds NO new corpus and no rule logic — pure pinning of existing
# output; cli.py / report.py are not touched.
#
# THE FIXTURE SET (existing committed fixtures only): three files are copied
# into a tmp dir under STABLE relative basenames so both the directory walk and
# a ``*.xml`` glob would collect exactly this set, and the snapshot is
# reproducible on any host:
#   * a-valid.xml       — corpus/vendored/valid/cen-bis3-positive_ubl.xml, a
#                         business-rule-clean UBL invoice -> PASS under en16931.
#   * b-invalid.xml     — fixtures/creditnote-invalid-typecode_ubl.xml, a UBL
#                         CreditNote with BT-3=999 -> the real BR-CL-01 fatal
#                         -> FAIL.
#   * c-unsupported.xml — fixtures/creditnote-invalid_cii.xml, a CII document
#                         fed through the UBL-only validate path: well-formed
#                         XML with a non-UBL root -> the deterministic S-ROOT
#                         "unsupported root" fatal (the batch's unsupported
#                         leg), exactly as validate-batch prints for a CII file
#                         today.
# So the aggregate is 1 pass + 2 fatal-failing files -> EXIT_FAIL (1).
#
# PATH NORMALIZATION (host-independence): the batch echoes the walked directory
# as ``root`` and each file's absolute path as ``source``. Both carry the
# volatile tmp prefix, so the captured bytes are normalized down to the stable
# basename (source ``/tmp/xxx/a-valid.xml`` -> ``a-valid.xml``) and the bare
# root -> a fixed ``<BATCH_ROOT>`` token, mirroring how the container golden
# keeps its input path host-independent. After normalization the bytes depend
# only on the committed fixtures, never on where the checkout or $TMPDIR lives.
#
# Regeneration is the SAME reviewed one-command convention as every other
# golden here: ``python3 test_golden_snapshot.py --update`` (or REGEN=1), and
# the refuse-over-a-BROKEN-output guard below means a golden can never be
# regenerated over a regression (a false pass, a wrong exit code, a stderr
# leak, or an un-normalized path).

#: (stable basename, committed source relative path) — existing fixtures only.
BATCH_FIXTURES = [
    ("a-valid.xml", os.path.join("corpus", "vendored", "valid",
                                 "cen-bis3-positive_ubl.xml")),
    ("b-invalid.xml", os.path.join("fixtures",
                                   "creditnote-invalid-typecode_ubl.xml")),
    ("c-unsupported.xml", os.path.join("fixtures",
                                       "creditnote-invalid_cii.xml")),
]

#: The measured, documented aggregate exit code: EXIT_FAIL (1) because at least
#: one batched file carries a fatal (batch_exit_code's fatal-outranks-parse
#: precedence). Pinned alongside the byte-identity so a golden regenerated over
#: a regression that changed the verdict cannot hide it.
BATCH_EXIT_CODE = 1

#: The two golden forms: the human per-file summary and exactly ONE machine
#: format (--json). Filenames carry "batch" and follow the golden/ conventions.
BATCH_GOLDEN_NAMES = {
    "text": "batch-mixed.summary.txt",
    "json": "batch-mixed.json",
}

#: The stable basenames, in the deterministic collect/sort order the batch
#: emits them (used by the shape guard to prove path normalization + ordering).
BATCH_BASENAMES = [base for base, _ in BATCH_FIXTURES]


def _batch_stage(tmp):
    """Copy the committed mixed fixture set into ``tmp`` under stable basenames."""
    for base, rel in BATCH_FIXTURES:
        with open(os.path.join(HERE, rel), "rb") as fh:
            data = fh.read()
        with open(os.path.join(tmp, base), "wb") as out:
            out.write(data)


def _batch_cli(tmp, as_json):
    """Drive the REAL ``einvoice validate-batch <dir>`` CLI over ``tmp``.
    Returns (rc, stdout bytes, stderr bytes)."""
    args = [sys.executable, "-m", "einvoice", "validate-batch"]
    if as_json:
        args.append("--json")
    args.append(tmp)
    proc = subprocess.run(args, cwd=HERE, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE)
    return proc.returncode, proc.stdout, proc.stderr


def _batch_normalize(out, tmp):
    """Normalize the volatile tmp prefix in the captured bytes down to stable
    basenames (source paths) and a fixed ``<BATCH_ROOT>`` token (the walked
    root), so the snapshot is host- and $TMPDIR-independent. The longer
    ``tmp + sep`` prefix is stripped first, leaving the bare ``tmp`` root to
    become the token."""
    out = out.replace((tmp + os.sep).encode("utf-8"), b"")
    out = out.replace(tmp.encode("utf-8"), b"<BATCH_ROOT>")
    return out


def _batch_golden_path(form):
    return os.path.join(GOLDEN_DIR, BATCH_GOLDEN_NAMES[form])


def _batch_shape_failures(form, rc, norm, err):
    """Assert the aggregate's non-fabricated SHAPE on the NORMALIZED output
    (beyond byte identity, so a golden regenerated over a regression cannot
    hide a false pass, a wrong exit code, a stderr leak, or an un-normalized
    path). Returns a list of human-readable failure lines (empty = shape OK)."""
    fails = []
    if rc != BATCH_EXIT_CODE:
        fails.append("  exit code: documented=%d got=%d"
                     % (BATCH_EXIT_CODE, rc))
    if err != b"":
        fails.append("  stderr not empty (traceback/diagnostic leak?): %r"
                     % err[:200])
    text = norm.decode("utf-8", "replace")
    # Path normalization must have stripped every tmp prefix: no OS-absolute
    # path may survive in the pinned bytes.
    if os.sep == "/" and "/tmp" in text:
        fails.append("  an absolute /tmp path survived normalization")
    try:
        if form == "json":
            doc = json.loads(norm.decode("utf-8"))
            if doc.get("schema") != "einvoice-conformance-batch/v1":
                fails.append("  json schema: %r != "
                             "'einvoice-conformance-batch/v1'"
                             % doc.get("schema"))
            if doc.get("root") != "<BATCH_ROOT>":
                fails.append("  json root not normalized: %r" % doc.get("root"))
            if doc.get("file_count") != 3:
                fails.append("  json file_count: %r != 3"
                             % doc.get("file_count"))
            if doc.get("fatal_count", 0) < 1:
                fails.append("  json fatal_count < 1 (must not be a false "
                             "all-pass): %r" % doc.get("fatal_count"))
            if doc.get("failed_file_count") != 2:
                fails.append("  json failed_file_count: %r != 2"
                             % doc.get("failed_file_count"))
            files = doc.get("files", [])
            sources = [f.get("source") for f in files]
            if sources != BATCH_BASENAMES:
                fails.append("  json file sources not normalized/ordered: %r "
                             "!= %r" % (sources, BATCH_BASENAMES))
            valids = [f.get("valid") for f in files]
            if valids != [True, False, False]:
                fails.append("  json per-file valid verdicts: %r != "
                             "[True, False, False]" % valids)
        else:  # human summary
            for token in ("PASS  a-valid.xml", "FAIL  b-invalid.xml",
                          "FAIL  c-unsupported.xml",
                          "3 files: 1 passed, 2 failed"):
                if token not in text:
                    fails.append("  human summary missing %r" % token)
    except Exception as exc:  # noqa: BLE001 — any parse failure IS the finding
        fails.append("  %s output does not parse as a complete batch "
                     "document: %s" % (form, exc))
    return fails


def write_batch_goldens():
    """Regenerate the validate-batch aggregate goldens (only via --update)."""
    if not os.path.isdir(GOLDEN_DIR):
        os.makedirs(GOLDEN_DIR)
    with tempfile.TemporaryDirectory() as tmp:
        _batch_stage(tmp)
        for form in ("text", "json"):
            rc, out, err = _batch_cli(tmp, as_json=(form == "json"))
            norm = _batch_normalize(out, tmp)
            shape = _batch_shape_failures(form, rc, norm, err)
            if shape:
                raise SystemExit(
                    "refusing to regenerate a golden over a BROKEN "
                    "validate-batch aggregate (%s form):\n%s"
                    % (form, "\n".join(shape)))
            with open(_batch_golden_path(form), "wb") as fh:
                fh.write(norm)
    return len(BATCH_GOLDEN_NAMES)


def check_batch(failures):
    """Byte-compare each batch form against its committed golden AND assert the
    aggregate exit code + non-fabricated shape on the normalized output.
    Appends to `failures` in the same (headline, lines) form the fixture check
    uses."""
    with tempfile.TemporaryDirectory() as tmp:
        _batch_stage(tmp)
        for form in ("text", "json"):
            name = "validate-batch mixed (%s)" % form
            gpath = _batch_golden_path(form)
            rc, out, err = _batch_cli(tmp, as_json=(form == "json"))
            norm = _batch_normalize(out, tmp)
            lines = _batch_shape_failures(form, rc, norm, err)
            if not os.path.isfile(gpath):
                failures.append(("MISSING golden for %r (run --update to "
                                 "create it)." % name, [name]))
                continue
            with open(gpath, "rb") as fh:
                golden = fh.read()
            if norm != golden:
                lines.append("  stdout drifted from committed golden %s "
                             "(golden %d bytes, now %d bytes)"
                             % (os.path.basename(gpath), len(golden),
                                len(norm)))
            if lines:
                failures.append((None, ["DRIFT in %r:" % name] + lines))


# --------------------------------------------------------------------------
# Engine invocation
# --------------------------------------------------------------------------
def _cii_report(path, profile):
    """Return a report-shaped dict for a CII invoice using the engine's CII path.

    Mirrors :func:`einvoice.report.build_report` (same dict shape, same
    ``report._record`` violation mapping) but sources violations from the CII
    parser + core rules + the CII CIUS layer, because ``report``/``validate``
    do not dispatch CII natively. Re-implements NO rule logic.
    """
    try:
        root = parser_cii.parse_file(path)
    except NotWellFormed as exc:
        return {
            "profile": profile,
            "valid": False,
            "error": "not-well-formed",
            "message": str(exc),
            "fatal_count": 0,
            "violations": [],
        }
    inv = parser_cii.build_model(root)
    violations = []
    for fn in rules.ALL_RULES:
        v = fn(inv)
        if v is not None:
            violations.append(v)
    if profile == "xrechnung":
        violations.extend(rules_xrechnung.evaluate_cii(inv))
    records = [report._record(v) for v in violations]
    fatal_count = sum(1 for r in records if r["severity"] == "fatal")
    return {
        "profile": profile,
        "valid": fatal_count == 0,
        "fatal_count": fatal_count,
        "violations": records,
    }


def _engine_report(fixture):
    """Run the appropriate engine code path and return a report-shaped dict."""
    abs_path = os.path.join(HERE, fixture["path"])
    if fixture["syntax"] == "UBL":
        return report.build_report(abs_path, profile=fixture["profile"])
    if fixture["syntax"] == "CII":
        return _cii_report(abs_path, profile=fixture["profile"])
    if fixture["syntax"] == "PDF-CONTAINER":
        # The Factur-X / ZUGFeRD PDF-container path: report.build_report detects
        # the %PDF magic, extracts the embedded CrossIndustryInvoice zero-dep via
        # einvoice.pdf_container and validates it through the SAME CII engine. No
        # re-implemented logic — the exact code path behind
        # `python3 -m einvoice.report <invoice.pdf>`.
        return report.build_report(abs_path, profile=fixture["profile"])
    raise ValueError("unknown syntax: %r" % fixture["syntax"])


def _exit_code(rep):
    """Mirror `python3 -m einvoice.report`'s exit contract from a report dict."""
    if rep.get("error") == "not-well-formed":
        return 3
    return 0 if rep.get("fatal_count", 0) == 0 else 1


def compute_projection(fixture):
    """Recompute the deterministic snapshot record for one fixture.

    The returned dict is exactly what is stored in the golden file: fixture
    identity (name/path/syntax/profile) plus the normalized projection
    (valid / exit_code / sorted rules). No timestamps, absolute paths, versions
    or free-text messages are included.
    """
    rep = _engine_report(fixture)
    fired = sorted(
        ({"rule": v["rule"], "severity": v["severity"]}
         for v in rep.get("violations", [])),
        key=lambda r: (r["rule"], r["severity"]),
    )
    record = {
        "name": fixture["name"],
        "path": fixture["path"],
        "syntax": fixture["syntax"],
        "profile": fixture["profile"],
        "valid": bool(rep["valid"]),
        "exit_code": _exit_code(rep),
        "rules": fired,
    }
    if rep.get("error"):
        record["error"] = rep["error"]
    return record


# --------------------------------------------------------------------------
# Golden IO + diffing
# --------------------------------------------------------------------------
def _golden_path(fixture):
    return os.path.join(GOLDEN_DIR, fixture["name"] + ".json")


def _dump(record):
    """Deterministic serialization used for both writing and comparison."""
    return json.dumps(record, sort_keys=True, indent=2) + "\n"


def write_goldens():
    """Regenerate every golden file from the current engine output."""
    if not os.path.isdir(GOLDEN_DIR):
        os.makedirs(GOLDEN_DIR)
    for fixture in FIXTURES:
        record = compute_projection(fixture)
        with open(_golden_path(fixture), "w", encoding="utf-8") as fh:
            fh.write(_dump(record))
    return (len(FIXTURES) + write_container_goldens()
            + write_receipt_goldens() + write_batch_goldens())


def _rule_pairs(record):
    return {(r["rule"], r["severity"]) for r in record.get("rules", [])}


def _diff_lines(name, golden, current):
    """Human-readable description of how `current` drifted from `golden`."""
    lines = ["DRIFT in fixture %r:" % name]
    for key in ("valid", "exit_code", "profile", "syntax", "path", "error"):
        gv = golden.get(key)
        cv = current.get(key)
        if gv != cv:
            lines.append("  %-9s golden=%r  now=%r" % (key + ":", gv, cv))

    g_pairs = _rule_pairs(golden)
    c_pairs = _rule_pairs(current)

    g_rules = {r for r, _ in g_pairs}
    c_rules = {r for r, _ in c_pairs}
    appeared = sorted(c_rules - g_rules)
    disappeared = sorted(g_rules - c_rules)
    for rid in appeared:
        sev = next(s for r, s in c_pairs if r == rid)
        lines.append("  + rule appeared:   %s (%s)" % (rid, sev))
    for rid in disappeared:
        sev = next(s for r, s in g_pairs if r == rid)
        lines.append("  - rule disappeared: %s (%s)" % (rid, sev))

    # Severity changes on rules present in both.
    common = g_rules & c_rules
    g_sev = dict(g_pairs)
    c_sev = dict(c_pairs)
    for rid in sorted(common):
        if g_sev.get(rid) != c_sev.get(rid):
            lines.append("  ~ severity changed: %s golden=%s now=%s"
                         % (rid, g_sev.get(rid), c_sev.get(rid)))

    if len(lines) == 1:
        # Structural mismatch not captured above (e.g. hand-mangled golden).
        lines.append("  golden JSON does not match the current projection "
                     "(hand-edited or structurally altered).")
    return lines


def check(verbose=True):
    """Compare every fixture against its golden. Returns (ok, failures)."""
    failures = []
    for fixture in FIXTURES:
        name = fixture["name"]
        gpath = _golden_path(fixture)
        current = compute_projection(fixture)
        if not os.path.isfile(gpath):
            failures.append(("MISSING golden for %r (run --update to create "
                             "it)." % name, [name]))
            continue
        with open(gpath, "r", encoding="utf-8") as fh:
            try:
                golden = json.load(fh)
            except ValueError as exc:
                failures.append(("golden %r is not valid JSON: %s"
                                 % (os.path.basename(gpath), exc), [name]))
                continue
        if golden != current:
            failures.append((None, _diff_lines(name, golden, current)))

    # The unsupported-container CLI machine-format goldens (byte-identity +
    # exit code + non-pass shape, see the T-VHPDFZ.2 section above).
    check_container(failures)

    # Conformance-receipt goldens (byte-identity + embedded self-hash recompute,
    # see the T-VHR.16 section above).
    check_receipts(failures)

    # validate-batch aggregate goldens (byte-identity + exit code + non-pass
    # shape over the normalized output, see the T-VHR.17 section above).
    check_batch(failures)
    total = (len(FIXTURES) + len(CONTAINER_FORMATS) + len(RECEIPT_FIXTURES)
             + len(BATCH_GOLDEN_NAMES))

    if verbose:
        if not failures:
            sys.stdout.write("OK: %d golden snapshot(s) match.\n" % total)
        else:
            sys.stdout.write(
                "FAIL: %d of %d golden snapshot(s) drifted.\n"
                % (len(failures), total))
            for headline, lines in failures:
                if headline:
                    sys.stdout.write("  " + headline + "\n")
                else:
                    for ln in lines:
                        sys.stdout.write(ln + "\n")
            sys.stdout.write(
                "\nIf this change was INTENTIONAL, re-baseline with:\n"
                "  python3 test_golden_snapshot.py --update\n")
    return (not failures), failures


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    regen = ("--update" in argv) or (os.environ.get("REGEN") == "1")
    if regen:
        n = write_goldens()
        sys.stdout.write("Regenerated %d golden snapshot(s) in %s\n"
                         % (n, os.path.relpath(GOLDEN_DIR, HERE)))
        return 0
    ok, _ = check(verbose=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
