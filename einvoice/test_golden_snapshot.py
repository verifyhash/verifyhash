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

import json
import os
import sys

from einvoice import report
from einvoice import parser_cii
from einvoice import rules
from einvoice import rules_xrechnung
from einvoice.parser import NotWellFormed

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
    return len(FIXTURES)


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

    if verbose:
        if not failures:
            sys.stdout.write("OK: %d golden snapshot(s) match.\n" % len(FIXTURES))
        else:
            sys.stdout.write(
                "FAIL: %d of %d golden snapshot(s) drifted.\n"
                % (len(failures), len(FIXTURES)))
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
