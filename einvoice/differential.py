#!/usr/bin/env python3
"""Differential-validation harness for EN 16931 (UBL).

Compares the fired-rule set of the OFFICIAL, NORMATIVE CEN artifact — the
compiled EN16931-UBL Schematron (shipped as an XSLT that emits SVRL) — against
the fired-rule set of OUR validator (``einvoice/`` package).

The official ruleset is the legal source of truth. For every invoice and for
every one of OUR implemented rule IDs (ALL_RULES in einvoice/rules.py) we ask
the same yes/no question of both engines — "does rule R fire on this
invoice?" — and record whether they AGREE.
A disagreement is, by definition, a place where OUR interpretation departs from
the legal document = our bug:

    * WE fire R, OFFICIAL does not  -> FALSE POSITIVE  (we over-reject)
    * OFFICIAL fires R, WE do not   -> MISS / FALSE NEGATIVE (we under-reject)

Official path:
    UBL Invoice XML
      --(Saxon Xslt30 transform through EN16931-UBL-validation.xslt)-->
    SVRL report --(parse <svrl:failed-assert> @id)--> set of fired rule IDs

Corpus (broad, real, and adversarial):
    * cen-en16931  Invoice-unit-UBL test set  (each <test> case split out)
    * cen-en16931  ubl/examples               (real-world sample invoices)
    * vendored/valid + vendored/invalid        (our own fixtures)
    * xrechnung-testsuite UBL Invoice files     (real German CIUS invoices)
    * GENERATED targeted mutations: one per implemented rule, each breaking
      exactly the field that rule guards, mutated off a known-clean invoice —
      so every rule is exercised in the FAILING direction.

Requirements:
    export PYTHONPATH="$HOME/.local/lib/python3.10/site-packages:$PYTHONPATH"
    (SaxonC-for-Python / `saxonche` must be importable)

Usage:
    python3 differential.py                 # FULL differential run over corpus
    python3 differential.py <invoice> ...   # ad-hoc per-invoice report
"""

from __future__ import annotations

import copy
import os
import sys
import tempfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# OUR validator, called in-process (no subprocess overhead over a large corpus).
from einvoice.validate import validate_file          # noqa: E402
from einvoice.parser import NotWellFormed            # noqa: E402
from einvoice import rules as _rules                  # noqa: E402

# The OFFICIAL normative artifact: the compiled EN16931-UBL Schematron.
OFFICIAL_XSLT = os.path.join(
    HERE, "corpus", "cen-en16931", "ubl", "xslt", "EN16931-UBL-validation.xslt"
)

# Namespaces.
NS_SVRL = "http://purl.oclc.org/dsdl/svrl"
NS_INV = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
NS_CN = "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
NS_CAC = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
NS_CBC = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
NS_DIFI = "http://difi.no/xsd/vefa/validator/1.0"


# --------------------------------------------------------------------------- #
# OUR rules — read straight from einvoice/rules.py (the ALL_RULES list).
# --------------------------------------------------------------------------- #
def _fn_to_rule_id(fn) -> str:
    """br_01 -> BR-01, br_cl_01 -> BR-CL-01, br_dec_09 -> BR-DEC-09, br_s_01 -> BR-S-01."""
    parts = fn.__name__.split("_")
    return "-".join(p.upper() for p in parts)


OUR_RULE_IDS = [_fn_to_rule_id(fn) for fn in _rules.ALL_RULES]
OUR_RULE_SET = set(OUR_RULE_IDS)
assert len(OUR_RULE_IDS) == 43, OUR_RULE_IDS


# --------------------------------------------------------------------------- #
# OFFICIAL side — compile the 895 KB XSLT ONCE, reuse across the whole corpus.
# --------------------------------------------------------------------------- #
def _rule_id_from_failed_assert(fa: ET.Element):
    rid = fa.get("id")
    if rid:
        return rid.strip()
    flag = fa.get("flag")
    if flag and flag.strip() and flag.strip().lower() not in ("fatal", "warning"):
        return flag.strip()
    text_el = fa.find(f"{{{NS_SVRL}}}text")
    if text_el is not None and text_el.text:
        t = text_el.text.strip()
        if t.startswith("[") and "]" in t:
            return t[1:t.index("]")].strip()
    return None


class Official:
    """Wraps a single compiled instance of the normative XSLT."""

    def __init__(self):
        from saxonche import PySaxonProcessor
        self._proc_cm = PySaxonProcessor(license=False)
        self._proc = self._proc_cm.__enter__()
        xp = self._proc.new_xslt30_processor()
        self._exe = xp.compile_stylesheet(stylesheet_file=OFFICIAL_XSLT)
        self._xp = xp

    def fired(self, invoice_path: str) -> set:
        svrl = self._exe.transform_to_string(source_file=invoice_path)
        if svrl is None:
            raise RuntimeError("Saxon returned no SVRL for %s: %s"
                               % (invoice_path, self._xp.error_message))
        root = ET.fromstring(svrl)
        fired = set()
        for fa in root.iter(f"{{{NS_SVRL}}}failed-assert"):
            rid = _rule_id_from_failed_assert(fa)
            if rid:
                fired.add(rid)
        return fired

    def close(self):
        try:
            self._proc_cm.__exit__(None, None, None)
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# OUR side — in-process.
# --------------------------------------------------------------------------- #
def our_fired(invoice_path: str) -> set:
    result = validate_file(invoice_path)
    return {v.rule_id for v in result.violations}


# --------------------------------------------------------------------------- #
# Ad-hoc, backwards-compatible per-invoice helpers (difi envelope unwrapping).
# --------------------------------------------------------------------------- #
def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _normalized_invoice_path(invoice_path: str):
    try:
        tree = ET.parse(invoice_path)
    except ET.ParseError:
        return invoice_path, (lambda: None)
    root = tree.getroot()
    root_ns = root.tag.split("}", 1)[0].lstrip("{") if "}" in root.tag else ""
    if root_ns != NS_DIFI:
        return invoice_path, (lambda: None)
    inner = None
    for el in root.iter():
        ns = el.tag.split("}", 1)[0].lstrip("{") if "}" in el.tag else ""
        if ns in (NS_INV, NS_CN):
            inner = el
            break
    if inner is None:
        return invoice_path, (lambda: None)
    fd, tmp = tempfile.mkstemp(suffix=".xml", prefix="diff-unwrapped-")
    os.close(fd)
    ET.ElementTree(inner).write(tmp, encoding="utf-8", xml_declaration=True)
    return tmp, (lambda: os.path.exists(tmp) and os.remove(tmp))


def official_fired_rules(invoice_path: str) -> set:
    """One-shot official run (compiles the XSLT); use Official() for batches."""
    path, cleanup = _normalized_invoice_path(invoice_path)
    try:
        return Official().fired(path)
    finally:
        cleanup()


def our_fired_rules(invoice_path: str) -> set:
    path, cleanup = _normalized_invoice_path(invoice_path)
    try:
        return our_fired(path)
    finally:
        cleanup()


# --------------------------------------------------------------------------- #
# Corpus assembly.
# --------------------------------------------------------------------------- #
def _register_ns():
    ET.register_namespace("", NS_INV)
    ET.register_namespace("cac", NS_CAC)
    ET.register_namespace("cbc", NS_CBC)


def _write_doc(elem: ET.Element, out_path: str):
    _register_ns()
    ET.ElementTree(elem).write(out_path, encoding="utf-8", xml_declaration=True)


def _root_ns(elem: ET.Element) -> str:
    return elem.tag.split("}", 1)[0].lstrip("{") if "}" in elem.tag else ""


def _gather_bare_invoices():
    """(label, abs_path) for every bare-UBL *Invoice* file across the corpus."""
    out = []
    dirs = [
        ("cen-ex",     os.path.join(HERE, "corpus", "cen-en16931", "ubl", "examples")),
        ("vend-valid", os.path.join(HERE, "corpus", "vendored", "valid")),
        ("vend-inval", os.path.join(HERE, "corpus", "vendored", "invalid")),
    ]
    for tag, d in dirs:
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.lower().endswith(".xml"):
                continue
            p = os.path.join(d, name)
            try:
                root = ET.parse(p).getroot()
            except ET.ParseError:
                continue
            if _root_ns(root) != NS_INV:      # Invoice documents only
                continue
            out.append(("%s/%s" % (tag, name), p))

    # xrechnung-testsuite: real German CIUS invoices, scattered under src/test.
    xr = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test")
    if os.path.isdir(xr):
        for dirpath, _dirs, files in os.walk(xr):
            for name in sorted(files):
                if not name.lower().endswith(".xml"):
                    continue
                p = os.path.join(dirpath, name)
                try:
                    root = ET.parse(p).getroot()
                except ET.ParseError:
                    continue
                if _root_ns(root) != NS_INV:
                    continue
                rel = os.path.relpath(p, xr)
                out.append(("xr/%s" % rel, p))
    return out


def _split_cen_testsets(scratch: str):
    """Split every difi <testSet> Invoice case into its own standalone file.

    Each <test> in a CEN unit-test file is an independent invoice with a known
    ground-truth expectation; the official Schematron is still the arbiter.
    Returns [(label, abs_path)].
    """
    src = os.path.join(HERE, "corpus", "cen-en16931", "test", "Invoice-unit-UBL")
    out = []
    if not os.path.isdir(src):
        return out
    dst = os.path.join(scratch, "cen-split")
    os.makedirs(dst, exist_ok=True)
    for name in sorted(os.listdir(src)):
        if not name.lower().endswith(".xml"):
            continue
        try:
            root = ET.parse(os.path.join(src, name)).getroot()
        except ET.ParseError:
            continue
        if _root_ns(root) != NS_DIFI:
            continue
        idx = 0
        for test in root.iter("{%s}test" % NS_DIFI):
            inner = None
            for el in test:
                if _root_ns(el) == NS_INV:
                    inner = el
                    break
            if inner is None:
                continue
            base = name[:-4]
            out_path = os.path.join(dst, "%s__t%d.xml" % (base, idx))
            _write_doc(inner, out_path)
            out.append(("cen-unit/%s#t%d" % (base, idx), out_path))
            idx += 1
    return out


# ------- generated mutations: break exactly the field each rule guards ------ #
def _q(ns, local):
    return "{%s}%s" % (ns, local)


def _parent_map(root):
    return {c: p for p in root.iter() for c in p}


def _child(root, ns, local):
    for c in root:
        if c.tag == _q(ns, local):
            return c
    return None


def _remove(root, elem):
    _parent_map(root)[elem].remove(elem)


def _first_line(root):
    # In UBL, InvoiceLine lives in the cac namespace (cac:InvoiceLine).
    return next((c for c in root if c.tag == _q(NS_CAC, "InvoiceLine")), None)


def _supplier_party(r):
    return _child(_child(r, NS_CAC, "AccountingSupplierParty"), NS_CAC, "Party")


def _customer_party(r):
    return _child(_child(r, NS_CAC, "AccountingCustomerParty"), NS_CAC, "Party")


def _mut_br01(r): _remove(r, _child(r, NS_CBC, "CustomizationID"))
def _mut_br02(r): _remove(r, _child(r, NS_CBC, "ID"))
def _mut_br03(r): _remove(r, _child(r, NS_CBC, "IssueDate"))
def _mut_br04(r): _remove(r, _child(r, NS_CBC, "InvoiceTypeCode"))
def _mut_br05(r): _remove(r, _child(r, NS_CBC, "DocumentCurrencyCode"))


def _mut_br06(r):
    ple = _child(_supplier_party(r), NS_CAC, "PartyLegalEntity")
    ple.remove(_child(ple, NS_CBC, "RegistrationName"))


def _mut_br07(r):
    ple = _child(_customer_party(r), NS_CAC, "PartyLegalEntity")
    ple.remove(_child(ple, NS_CBC, "RegistrationName"))


def _mut_br08(r):
    party = _supplier_party(r)
    party.remove(_child(party, NS_CAC, "PostalAddress"))


def _mut_br16(r):
    for ln in [c for c in r if c.tag == _q(NS_CAC, "InvoiceLine")]:
        r.remove(ln)


def _mut_br21(r):
    ln = _first_line(r)
    ln.remove(_child(ln, NS_CBC, "ID"))


def _mut_br22(r):
    ln = _first_line(r)
    ln.remove(_child(ln, NS_CBC, "InvoicedQuantity"))


def _mut_br24(r):
    ln = _first_line(r)
    ln.remove(_child(ln, NS_CBC, "LineExtensionAmount"))


def _mut_br26(r):
    ln = _first_line(r)
    price = _child(ln, NS_CAC, "Price")
    price.remove(_child(price, NS_CBC, "PriceAmount"))


def _mut_brcl01(r):
    _child(r, NS_CBC, "InvoiceTypeCode").text = "999"


def _lmt(r):
    return _child(r, NS_CAC, "LegalMonetaryTotal")


def _mut_brco10(r):
    _child(_lmt(r), NS_CBC, "LineExtensionAmount").text = "111111.11"


def _mut_brco13(r):
    _child(_lmt(r), NS_CBC, "TaxExclusiveAmount").text = "111111.11"


def _mut_brco14(r):
    tt = _child(r, NS_CAC, "TaxTotal")
    _child(tt, NS_CBC, "TaxAmount").text = "999.99"   # BT-110 != sum(BT-117)


def _mut_brco15(r):
    _child(_lmt(r), NS_CBC, "TaxInclusiveAmount").text = "111111.11"


def _mut_brs01(r):
    # S present on the line, but flip the VAT-breakdown category away from S.
    sub = _child(_child(r, NS_CAC, "TaxTotal"), NS_CAC, "TaxSubtotal")
    cat = _child(sub, NS_CAC, "TaxCategory")
    _child(cat, NS_CBC, "ID").text = "E"


def _set_line_category(r, code):
    """Flip the first line's ClassifiedTaxCategory code (breakdown stays 'S')."""
    item = _child(_first_line(r), NS_CAC, "Item")
    ctc = _child(item, NS_CAC, "ClassifiedTaxCategory")
    _child(ctc, NS_CBC, "ID").text = code


def _mut_brz01(r): _set_line_category(r, "Z")
def _mut_brae01(r): _set_line_category(r, "AE")
def _mut_bre01(r): _set_line_category(r, "E")
def _mut_brg01(r): _set_line_category(r, "G")
def _mut_bric01(r): _set_line_category(r, "K")
def _mut_bro01(r): _set_line_category(r, "O")


def _mut_brco16(r):
    _child(_lmt(r), NS_CBC, "PayableAmount").text = "111111.11"


def _mut_brco17(r):
    # Subtotal BT-117 more than 1 unit away from taxable x rate.
    st = _child(_child(r, NS_CAC, "TaxTotal"), NS_CAC, "TaxSubtotal")
    _child(st, NS_CBC, "TaxAmount").text = "99.99"


def _mut_brco18(r):
    # Remove the only VAT breakdown group.
    tt = _child(r, NS_CAC, "TaxTotal")
    tt.remove(_child(tt, NS_CAC, "TaxSubtotal"))


# ---- BR-DEC mutations: give exactly one monetary field a 3rd decimal. ----- #
def _sub_el(parent, ns, local, text=None, currency=False):
    el = ET.SubElement(parent, _q(ns, local))
    if text is not None:
        el.text = text
    if currency:
        el.set("currencyID", "DKK")
    return el


def _add_doc_allowance_charge(r, charge, amount, base=None):
    """Insert a document-level AllowanceCharge before cac:TaxTotal."""
    ac = ET.Element(_q(NS_CAC, "AllowanceCharge"))
    _sub_el(ac, NS_CBC, "ChargeIndicator", "true" if charge else "false")
    _sub_el(ac, NS_CBC, "AllowanceChargeReason", "Adjustment")
    _sub_el(ac, NS_CBC, "Amount", amount, currency=True)
    if base is not None:
        _sub_el(ac, NS_CBC, "BaseAmount", base, currency=True)
    cat = _sub_el(ac, NS_CAC, "TaxCategory")
    _sub_el(cat, NS_CBC, "ID", "S")
    _sub_el(cat, NS_CBC, "Percent", "25")
    _sub_el(_sub_el(cat, NS_CAC, "TaxScheme"), NS_CBC, "ID", "VAT")
    r.insert(list(r).index(_child(r, NS_CAC, "TaxTotal")), ac)


def _mut_brdec01(r): _add_doc_allowance_charge(r, charge=False, amount="10.009")
def _mut_brdec02(r): _add_doc_allowance_charge(r, charge=False, amount="10.00",
                                               base="100.009")
def _mut_brdec05(r): _add_doc_allowance_charge(r, charge=True, amount="10.009")
def _mut_brdec06(r): _add_doc_allowance_charge(r, charge=True, amount="10.00",
                                               base="100.009")


def _mut_brdec09(r): _child(_lmt(r), NS_CBC, "LineExtensionAmount").text = "625743.549"
def _mut_brdec10(r): _sub_el(_lmt(r), NS_CBC, "AllowanceTotalAmount", "0.009",
                             currency=True)
def _mut_brdec11(r): _sub_el(_lmt(r), NS_CBC, "ChargeTotalAmount", "0.009",
                             currency=True)
def _mut_brdec12(r): _child(_lmt(r), NS_CBC, "TaxExclusiveAmount").text = "625743.549"
def _mut_brdec14(r): _child(_lmt(r), NS_CBC, "TaxInclusiveAmount").text = "782179.439"
def _mut_brdec16(r): _sub_el(_lmt(r), NS_CBC, "PrepaidAmount", "0.009", currency=True)
def _mut_brdec17(r): _sub_el(_lmt(r), NS_CBC, "PayableRoundingAmount", "0.006",
                             currency=True)
def _mut_brdec18(r): _child(_lmt(r), NS_CBC, "PayableAmount").text = "782179.439"


def _subtotal(r):
    return _child(_child(r, NS_CAC, "TaxTotal"), NS_CAC, "TaxSubtotal")


def _mut_brdec19(r): _child(_subtotal(r), NS_CBC, "TaxableAmount").text = "625743.549"
def _mut_brdec20(r): _child(_subtotal(r), NS_CBC, "TaxAmount").text = "156435.889"
def _mut_brdec23(r):
    _child(_first_line(r), NS_CBC, "LineExtensionAmount").text = "625743.549"


_MUTATIONS = {
    "BR-01": _mut_br01, "BR-02": _mut_br02, "BR-03": _mut_br03,
    "BR-04": _mut_br04, "BR-05": _mut_br05, "BR-06": _mut_br06,
    "BR-07": _mut_br07, "BR-08": _mut_br08, "BR-16": _mut_br16,
    "BR-21": _mut_br21, "BR-22": _mut_br22, "BR-24": _mut_br24,
    "BR-26": _mut_br26, "BR-CL-01": _mut_brcl01, "BR-CO-10": _mut_brco10,
    "BR-CO-13": _mut_brco13, "BR-CO-14": _mut_brco14, "BR-CO-15": _mut_brco15,
    "BR-CO-16": _mut_brco16, "BR-CO-17": _mut_brco17, "BR-CO-18": _mut_brco18,
    "BR-S-01": _mut_brs01, "BR-Z-01": _mut_brz01,
    "BR-AE-01": _mut_brae01, "BR-E-01": _mut_bre01, "BR-G-01": _mut_brg01,
    "BR-IC-01": _mut_bric01, "BR-O-01": _mut_bro01,
    "BR-DEC-01": _mut_brdec01, "BR-DEC-02": _mut_brdec02,
    "BR-DEC-05": _mut_brdec05, "BR-DEC-06": _mut_brdec06,
    "BR-DEC-09": _mut_brdec09, "BR-DEC-10": _mut_brdec10,
    "BR-DEC-11": _mut_brdec11, "BR-DEC-12": _mut_brdec12,
    "BR-DEC-14": _mut_brdec14, "BR-DEC-16": _mut_brdec16,
    "BR-DEC-17": _mut_brdec17, "BR-DEC-18": _mut_brdec18,
    "BR-DEC-19": _mut_brdec19, "BR-DEC-20": _mut_brdec20,
    "BR-DEC-23": _mut_brdec23,
}


def _gather_mutations(scratch: str):
    """One generated invoice per rule, each breaking exactly that rule's field."""
    base_path = os.path.join(HERE, "corpus", "vendored", "valid",
                             "cen-bis3-positive_ubl.xml")
    base_root = ET.parse(base_path).getroot()
    dst = os.path.join(scratch, "mutations")
    os.makedirs(dst, exist_ok=True)
    out = []
    for rid in OUR_RULE_IDS:
        mut = _MUTATIONS.get(rid)
        if mut is None:
            continue
        root = copy.deepcopy(base_root)
        try:
            mut(root)
        except Exception as e:  # pragma: no cover
            print("  [mutation %s FAILED to build: %s]" % (rid, e), file=sys.stderr)
            continue
        out_path = os.path.join(dst, "mut_%s.xml" % rid.replace("-", "_"))
        _write_doc(root, out_path)
        out.append(("MUT/%s" % rid, out_path))
    return out


def build_corpus(scratch: str):
    entries = []
    entries += _gather_bare_invoices()
    entries += _split_cen_testsets(scratch)
    entries += _gather_mutations(scratch)
    # De-dup by resolved path.
    seen, uniq = set(), []
    for label, path in entries:
        key = os.path.abspath(path)
        if key in seen:
            continue
        seen.add(key)
        uniq.append((label, path))
    return uniq


# --------------------------------------------------------------------------- #
# Full differential run.
# --------------------------------------------------------------------------- #
def run_differential():
    scratch = os.environ.get("DIFF_SCRATCH") or tempfile.mkdtemp(prefix="diffcorpus-")
    os.makedirs(scratch, exist_ok=True)

    corpus = build_corpus(scratch)
    print("Corpus assembled: %d UBL Invoice documents" % len(corpus))
    print("  scratch dir: %s" % scratch)
    print("  restricting comparison to OUR %d implemented rules:" % len(OUR_RULE_IDS))
    print("    " + ", ".join(OUR_RULE_IDS))
    print()

    official = Official()

    # Per-rule tallies.
    agree = {r: 0 for r in OUR_RULE_IDS}          # verdicts that match
    both_fire = {r: 0 for r in OUR_RULE_IDS}      # true-positive agreements
    both_clear = {r: 0 for r in OUR_RULE_IDS}     # true-negative agreements
    false_pos = {r: [] for r in OUR_RULE_IDS}     # we fire, official doesn't
    misses = {r: [] for r in OUR_RULE_IDS}        # official fires, we don't

    errors = []
    graded = 0

    for label, path in corpus:
        try:
            off = official.fired(path) & OUR_RULE_SET
        except Exception as e:
            errors.append((label, "OFFICIAL", str(e)[:160]))
            continue
        try:
            ours = our_fired(path) & OUR_RULE_SET
        except NotWellFormed as e:
            errors.append((label, "OURS(not-well-formed)", str(e)[:160]))
            continue
        except Exception as e:
            errors.append((label, "OURS", str(e)[:160]))
            continue

        graded += 1
        for r in OUR_RULE_IDS:
            o, u = (r in off), (r in ours)
            if o and u:
                agree[r] += 1
                both_fire[r] += 1
            elif not o and not u:
                agree[r] += 1
                both_clear[r] += 1
            elif u and not o:
                false_pos[r].append(label)
            else:
                misses[r].append(label)

    official.close()

    total_cmp = graded * len(OUR_RULE_IDS)
    total_agree = sum(agree.values())

    # ----- per-rule agreement table ----- #
    print("=" * 82)
    print("PER-RULE AGREEMENT  (official EN16931-UBL Schematron  vs  our validator)")
    print("graded invoices: %d   |   comparisons: %d (invoices x %d rules)"
          % (graded, total_cmp, len(OUR_RULE_IDS)))
    print("=" * 82)
    print("%-10s %9s %9s %10s %10s %6s" %
          ("RULE", "agree", "both-fire", "both-clr", "false-pos", "miss"))
    print("-" * 82)
    for r in OUR_RULE_IDS:
        print("%-10s %6d/%-3d %9d %10d %10d %6d" % (
            r, agree[r], graded, both_fire[r], both_clear[r],
            len(false_pos[r]), len(misses[r])))
    print("-" * 82)
    tot_fp = sum(len(v) for v in false_pos.values())
    tot_miss = sum(len(v) for v in misses.values())
    print("%-10s %6d/%-3d %9s %10s %10d %6d" % (
        "TOTAL", total_agree, graded, "", "", tot_fp, tot_miss))
    rate = (100.0 * total_agree / total_cmp) if total_cmp else 0.0
    print()
    print("TOTAL AGREEMENT RATE: %d/%d = %.4f%%" % (total_agree, total_cmp, rate))
    print("  divergences: %d false-positives + %d misses = %d"
          % (tot_fp, tot_miss, tot_fp + tot_miss))
    print()

    # ----- full divergence list ----- #
    print("=" * 82)
    print("DIVERGENCES  (each = our interpretation disagreeing with the legal ruleset)")
    print("=" * 82)
    any_div = False
    for r in OUR_RULE_IDS:
        rows = ([("FALSE-POSITIVE (we fire, official clears)", inv) for inv in false_pos[r]] +
                [("MISS (official fires, we clear)", inv) for inv in misses[r]])
        if not rows:
            continue
        any_div = True
        print("\n%s  — %d divergence(s)" % (r, len(rows)))
        for kind, inv in rows:
            print("    [%s]  %s" % (kind, inv))
    if not any_div:
        print("\n  (none) — our validator matched the normative Schematron on every")
        print("  invoice for all %d implemented rules." % len(OUR_RULE_IDS))
    print()

    if errors:
        print("=" * 82)
        print("SKIPPED / ERRORS (%d) — excluded from the agreement counts" % len(errors))
        print("=" * 82)
        for label, side, msg in errors[:60]:
            print("    %-30s %-24s %s" % (label, side, msg))
        if len(errors) > 60:
            print("    ... (%d more)" % (len(errors) - 60))
    return 0


# --------------------------------------------------------------------------- #
# Ad-hoc per-invoice driver (kept for backward compatibility).
# --------------------------------------------------------------------------- #
def _print_report(invoice_path: str) -> None:
    rel = os.path.relpath(invoice_path, HERE)
    print("=" * 78)
    print("INVOICE:", rel)
    try:
        official = official_fired_rules(invoice_path) & OUR_RULE_SET
    except Exception as e:
        official = None
        print("  OFFICIAL: ERROR:", e)
    try:
        ours = our_fired_rules(invoice_path) & OUR_RULE_SET
    except Exception as e:
        ours = None
        print("  OURS:     ERROR:", e)
    if official is not None:
        print("  OFFICIAL fired (%d):" % len(official), ", ".join(sorted(official)) or "(none)")
    if ours is not None:
        print("  OURS     fired (%d):" % len(ours), ", ".join(sorted(ours)) or "(none)")
    if official is not None and ours is not None:
        print("  agree        :", ", ".join(sorted(official & ours)) or "(none)")
        print("  official-only:", ", ".join(sorted(official - ours)) or "(none)")
        print("  ours-only    :", ", ".join(sorted(ours - official)) or "(none)")


def main(argv: list) -> int:
    if not argv:
        return run_differential()
    for s in argv:
        if not os.path.exists(s):
            print("=" * 78)
            print("INVOICE:", s, "-> MISSING")
            continue
        _print_report(s)
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
