#!/usr/bin/env python3
"""Build the per-rule remediation catalog (``remediation_catalog.json``).

This is the SINGLE machine-readable source of truth for human-facing rule
remediation guidance — the report writer, RULES.md and a future ``--explain``
flag all read it via :func:`einvoice.remediation.load_catalog`.

Every string is DERIVED, never invented:

* ``id`` / ``severity`` / ``provenance.source`` come from the live engine
  (:mod:`einvoice.rules` + :mod:`einvoice.rules_xrechnung`) and the published
  ``coverage_matrix.json`` — the same ground truth ``gen_coverage.py`` uses.
* ``title`` is the engine-derived short name already carried in the coverage
  matrix (first line of each rule's docstring).
* ``provenance.assert`` is the verbatim assert sentence lifted straight out of
  the vendored official Schematron (``corpus/``) with an XML parser — the exact
  wording every other field paraphrases faithfully.
* ``requires`` restates that assert (English core/BR-CL asserts verbatim; the
  German KoSIT BR-DE/BR-DEX asserts via the engine's own committed English
  docstring, which is a faithful transcription of the same rule).
* ``bt_bg`` is the set of EN 16931 BT-/BG- business-term ids literally named in
  the assert text / title — parsed out, never guessed.
* ``location_hint`` is the Schematron ``rule/@context`` the assert binds to
  (for document-root contexts, refined with the target element read out of the
  assert's ``@test`` XPath).
* ``fix`` is a mechanical imperative composed from an action verb (chosen by
  rule family / test shape) + the location + the verbatim requirement.

Standard library only; no network.

    python3 gen_remediation.py            # write remediation_catalog.json
    python3 gen_remediation.py --check    # fail if the committed file is stale
"""

from __future__ import annotations

import json
import os
import re
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import rules as _rules              # noqa: E402
from einvoice import rules_xrechnung as _rules_xr  # noqa: E402
from einvoice import coverage as _coverage         # noqa: E402

OUT_PATH = os.path.join(HERE, "remediation_catalog.json")
SCH = "{http://purl.oclc.org/dsdl/schematron}"

# The official UBL Schematron artifacts every fireable rule can be read out of.
# (Every engine-fireable id fires on the UBL leg — the CII layer is a subset —
# so the UBL sources are the canonical provenance.)
CORE_VALIDATION = os.path.join(
    HERE, "corpus/cen-en16931/ubl/schematron/preprocessed/"
    "EN16931-UBL-validation-preprocessed.sch")
CORE_CODES = os.path.join(
    HERE, "corpus/cen-en16931/ubl/schematron/codelist/EN16931-UBL-codes.sch")
XR_VALIDATION = os.path.join(
    HERE, "corpus/xrechnung-schematron/schematron/ubl/XRechnung-UBL-validation.sch")


# --------------------------------------------------------------------------- #
# Schematron extraction.                                                       #
# --------------------------------------------------------------------------- #
def _clean(text):
    """Collapse whitespace and strip the ``[BR-XX]-`` id tag Schematron prefixes
    every assert message with."""
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"^\[[^\]]+\]\s*-?\s*", "", text).strip()
    return text


def _parse_sch(path):
    """id -> {context, test, flag, assert_text} for the FIRST assert of each id
    in a Schematron file (XML-parsed, so ``>`` inside @test is handled)."""
    root = ET.parse(path).getroot()
    out = {}
    for rule in root.iter(SCH + "rule"):
        ctx = rule.get("context")
        if ctx is None:
            continue
        for a in rule.findall(SCH + "assert"):
            rid = a.get("id")
            if not rid or rid in out:
                continue
            out[rid] = {
                "context": ctx.strip(),
                "test": a.get("test"),
                "flag": a.get("flag"),
                "assert_text": _clean("".join(a.itertext())),
            }
    return out


def load_schematron_index():
    """Merge the three UBL Schematron artifacts into one id -> assert record.
    Validation asserts win over the code-list file where both define an id."""
    idx = {}
    idx.update(_parse_sch(CORE_CODES))
    idx.update(_parse_sch(CORE_VALIDATION))
    idx.update(_parse_sch(XR_VALIDATION))
    return idx


# --------------------------------------------------------------------------- #
# Engine facts (severity + source key), mirrored from gen_coverage.py.         #
# --------------------------------------------------------------------------- #
def _core_fns():
    return {_coverage._core_rule_id(fn): fn for fn in _rules.ALL_RULES}


def _xr_fns():
    return {fn.rule_id: fn for fn in _rules_xr.ALL_RULES}


def _core_severity(fn):
    """Raw Schematron flag the core rule emits (fatal unless it passes a
    'warning'/'information' literal to Violation) — same read as gen_coverage."""
    import inspect
    src = inspect.getsource(fn)
    if re.search(r'["\']information["\']', src):
        return "information"
    if re.search(r',\s*["\']warning["\']\s*\)', src):
        return "warning"
    return "fatal"


def engine_severity(rid, core_fns, xr_fns):
    if rid in xr_fns:
        return xr_fns[rid].severity
    return _core_severity(core_fns[rid])


def source_key(rid):
    """The coverage-matrix schematron_sources key the wording is derived from."""
    if rid.startswith("BR-DE") or rid.startswith("BR-DEX"):
        return "xrechnung-ubl"
    return "en16931-ubl"


# --------------------------------------------------------------------------- #
# Field derivation.                                                            #
# --------------------------------------------------------------------------- #
_BT_BG_RE = re.compile(r"\b(B[TG]-(?:DEX-)?\d+[a-z]?)\b")


def derive_bt_bg(*texts):
    """Sorted, de-duplicated BT-/BG- ids literally named in the given texts."""
    found = set()
    for t in texts:
        if not t:
            continue
        found.update(_BT_BG_RE.findall(t))

    def key(tok):
        pref, rest = tok.split("-", 1)
        dex = rest.startswith("DEX-")
        num = rest[4:] if dex else rest
        m = re.match(r"(\d+)([a-z]?)", num)
        return (0 if pref == "BG" else 1, 1 if dex else 0,
                int(m.group(1)) if m else 0, m.group(2) if m else "")

    return sorted(found, key=key)


_DOC_ROOTS = {"/ubl:Invoice", "/ubl:Invoice/", "/*", "/*/"}

# Clean cac/cbc path at the head of an XPath test (presence checks etc.).
_LEAD_PATH = re.compile(
    r"^\s*(?:exists|normalize-space|count|string-length|not|boolean|number|"
    r"round|sum)?\(*\s*"
    r"((?:cac|cbc):[A-Za-z]+(?:/(?:cac|cbc):[A-Za-z]+)*)")
# A VAT category node keyed by its category letter, anywhere in the test.
_CAT_NODE = re.compile(
    r"(cac:(?:Classified)?TaxCategory)\[normalize-space\(cbc:ID\)\s*=\s*'([A-Z]+)'\]")
# Fallback: first cac/cbc path token anywhere in the test.
_ANY_PATH = re.compile(r"(?://)?((?:cac|cbc):[A-Za-z]+(?:/(?:cac|cbc):[A-Za-z]+)*)")


def canonical_context(ctx):
    """The UBL branch of a Schematron context, with extension predicates and the
    ``/*/`` wildcard normalised to a readable path."""
    part = ctx.split("|")[0].strip()
    part = part.replace("[$isExtension]", "")
    part = part.replace("/*/", "/ubl:Invoice/")
    return part.strip()


def derive_location(rid, rec):
    """The XML path/element the finding concerns.

    Uses the Schematron rule context; when that context is the whole document,
    reads the concrete target element out of the assert's @test XPath so the hint
    points at a real element rather than the document root."""
    canon = canonical_context(rec["context"])
    if canon not in _DOC_ROOTS:
        return canon
    test = rec.get("test") or ""
    # 1) a clean leading element path (presence-style tests)
    m = _LEAD_PATH.match(test)
    if m and not m.group(1).endswith(("exists", "count")):
        return m.group(1)
    # 2) a VAT-category node keyed by its category letter
    m = _CAT_NODE.search(test)
    if m:
        node = m.group(1)
        if node == "cac:TaxCategory":
            return "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='%s']" % m.group(2)
        return "cac:InvoiceLine/cac:Item/%s[cbc:ID='%s']" % (node, m.group(2))
    # 3) document-total rules concern the monetary total, not the first path
    #    token their currency-scoped test happens to name
    if rid.startswith("BR-CO"):
        return "cac:LegalMonetaryTotal"
    # 4) any cac/cbc path anywhere in the test
    m = _ANY_PATH.search(test)
    if m:
        return m.group(1)
    return "/ubl:Invoice (document level)"


def _requires(rid, rec, xr_fns, title):
    """What the rule demands, in English.

    Core / BR-CL asserts are already English — use the verbatim assert sentence.
    The KoSIT BR-DE / BR-DEX asserts are German; use the engine's own committed
    English docstring (a faithful transcription of the same rule) instead."""
    if rid in xr_fns:
        doc = (xr_fns[rid].__doc__ or "").strip()
        para = doc.split("\n\n", 1)[0]
        para = re.sub(r"\s+", " ", para).strip()
        if para.startswith(rid + ":"):
            para = para[len(rid) + 1:].strip()
        elif para.startswith(rid):
            para = para[len(rid):].lstrip(":").strip()
        return para or title
    return rec["assert_text"] or title


_CODELIST_RE = re.compile(
    r"((?:ISO|UNCL|UN/ECE|CEF|UNTDID|MIME)[\w /.-]*?(?:code list|Recommendation "
    r"\d+|MIMEMediaType|alpha-3|4217|5305|4461|3166-1|6523|VATEX|EAS)[\w /.-]*)",
    re.IGNORECASE)


def derive_fix(rid, rec, requires, location, xr_fns):
    """A one-line, mechanically-composed imperative: an action verb chosen from
    the rule family / test shape, the target location, and the verbatim
    requirement. No rule meaning is invented — the requirement is the assert."""
    req = requires.rstrip(".")
    test = rec.get("test") or ""
    loc = "`%s`" % location

    if rid.startswith("BR-CL"):
        m = _CODELIST_RE.search(rec.get("assert_text") or requires)
        code = m.group(1).strip() if m else "the required code list"
        return "Encode %s using a valid value from %s." % (loc, code)
    if rid.startswith("BR-DEC"):
        return "Round the value at %s to the allowed number of decimals: %s." % (loc, req)
    if "=" in requires or "Σ" in requires or requires.lower().startswith("sum "):
        return "Correct the calculated amount at %s so that %s." % (loc, req)
    presence = bool(re.search(r"exists\(|!=\s*''|count\([^)]*\)\s*>\s*0", test)) \
        or " shall have " in requires or " shall contain " in requires \
        or "must contain" in requires.lower() or "must be transmitted" in requires.lower()
    if presence and (rid in xr_fns or not re.search(r"'[A-Z]{1,3}'", test)):
        return "Add the required element at %s: %s." % (loc, req)
    if rid.split("-")[1] in ("AE", "E", "G", "S", "Z", "O", "IC"):
        return "Adjust the VAT breakdown at %s so that %s." % (loc, req)
    return "Correct %s so that %s." % (loc, req)


# --------------------------------------------------------------------------- #
# German (de) remediation text -- see docs/SPEC and gen_remediation module doc. #
# Every German string is DERIVED, never invented: KoSIT-sourced rules take the  #
# German verbatim from the vendored Schematron assert; EN 16931 / codelist      #
# rules get a faithful German rendering of the SAME English requirement, built  #
# from a fixed BT/BG term glossary plus a closed set of sentence frames and     #
# exact-match entries (an unmatched requirement raises rather than guessing).   #
# --------------------------------------------------------------------------- #

GLOSSARY = {
    "BG-3": "Referenz auf die vorausgegangene Rechnung",
    "BG-4": "VERKÄUFER",
    "BG-5": "POSTANSCHRIFT DES VERKÄUFERS",
    "BG-8": "POSTANSCHRIFT DES ERWERBERS",
    "BG-10": "ZAHLUNGSEMPFÄNGER",
    "BG-11": "STEUERVERTRETER DES VERKÄUFERS",
    "BG-12": "POSTANSCHRIFT DES STEUERVERTRETERS DES VERKÄUFERS",
    "BG-14": "RECHNUNGSZEITRAUM",
    "BG-15": "LIEFERANSCHRIFT",
    "BG-16": "ZAHLUNGSANWEISUNGEN",
    "BG-17": "ÜBERWEISUNG",
    "BG-20": "NACHLÄSSE AUF DOKUMENTENEBENE",
    "BG-21": "ZUSCHLÄGE AUF DOKUMENTENEBENE",
    "BG-23": "UMSATZSTEUERAUFSCHLÜSSELUNG",
    "BG-24": "RECHNUNGSBEGRÜNDENDE UNTERLAGEN",
    "BG-25": "RECHNUNGSPOSITION",
    "BG-27": "NACHLÄSSE AUF EBENE DER RECHNUNGSPOSITION",
    "BG-28": "ZUSCHLÄGE AUF EBENE DER RECHNUNGSPOSITION",
    "BT-1": "Rechnungsnummer",
    "BT-2": "Rechnungsdatum",
    "BT-3": "Code für den Rechnungstyp",
    "BT-5": "Code für die Rechnungswährung",
    "BT-24": "Spezifikationskennung",
    "BT-25": "Kennung der vorausgegangenen Rechnung",
    "BT-27": "Name des Verkäufers",
    "BT-31": "Umsatzsteuer-Identifikationsnummer des Verkäufers",
    "BT-32": "Steuernummer des Verkäufers",
    "BT-34": "Elektronische Adresse des Verkäufers",
    "BT-40": "Ländercode des Verkäufers",
    "BT-44": "Name des Erwerbers",
    "BT-47": "Rechtliche Registrierungskennung des Erwerbers",
    "BT-48": "Umsatzsteuer-Identifikationsnummer des Erwerbers",
    "BT-49": "Elektronische Adresse des Erwerbers",
    "BT-55": "Ländercode des Erwerbers",
    "BT-59": "Name des Zahlungsempfängers",
    "BT-62": "Name des Steuervertreters des Verkäufers",
    "BT-63": "Umsatzsteuer-Identifikationsnummer des Steuervertreters des Verkäufers",
    "BT-69": "Ländercode des Steuervertreters",
    "BT-72": "Tatsächliches Lieferdatum",
    "BT-73": "Startdatum des Rechnungszeitraums",
    "BT-74": "Enddatum des Rechnungszeitraums",
    "BT-80": "Ländercode des Lieferorts",
    "BT-81": "Code für das Zahlungsmittel",
    "BT-84": "Kennung des Zahlungskontos",
    "BT-87": "Kartennummer (primäre Kontonummer der Zahlungskarte)",
    "BT-92": "Betrag des Nachlasses auf Dokumentenebene",
    "BT-93": "Grundbetrag des Nachlasses auf Dokumentenebene",
    "BT-95": "Code der Umsatzsteuerkategorie des Nachlasses auf Dokumentenebene",
    "BT-96": "Umsatzsteuersatz des Nachlasses auf Dokumentenebene",
    "BT-97": "Grund für den Nachlass auf Dokumentenebene",
    "BT-98": "Code für den Grund des Nachlasses auf Dokumentenebene",
    "BT-99": "Betrag des Zuschlags auf Dokumentenebene",
    "BT-100": "Grundbetrag des Zuschlags auf Dokumentenebene",
    "BT-102": "Code der Umsatzsteuerkategorie des Zuschlags auf Dokumentenebene",
    "BT-103": "Umsatzsteuersatz des Zuschlags auf Dokumentenebene",
    "BT-104": "Grund für den Zuschlag auf Dokumentenebene",
    "BT-105": "Code für den Grund des Zuschlags auf Dokumentenebene",
    "BT-106": "Summe der Nettobeträge der Rechnungspositionen",
    "BT-107": "Summe der Nachlässe auf Dokumentenebene",
    "BT-108": "Summe der Zuschläge auf Dokumentenebene",
    "BT-109": "Gesamtbetrag der Rechnung ohne Umsatzsteuer",
    "BT-110": "Gesamtbetrag der Umsatzsteuer",
    "BT-112": "Gesamtbetrag der Rechnung einschließlich Umsatzsteuer",
    "BT-113": "Bereits gezahlter Betrag",
    "BT-114": "Rundungsbetrag",
    "BT-115": "Fälliger Zahlungsbetrag",
    "BT-116": "Nach Umsatzsteuerkategorie zu versteuernder Betrag",
    "BT-117": "Umsatzsteuerbetrag der Umsatzsteuerkategorie",
    "BT-118": "Code der Umsatzsteuerkategorie",
    "BT-119": "Umsatzsteuersatz der Umsatzsteuerkategorie",
    "BT-120": "Text für den Grund der Umsatzsteuerbefreiung",
    "BT-122": "Kennung der rechnungsbegründenden Unterlage",
    "BT-121": "Code für den Grund der Umsatzsteuerbefreiung",
    "BT-126": "Kennung der Rechnungsposition",
    "BT-129": "In Rechnung gestellte Menge",
    "BT-131": "Nettobetrag der Rechnungsposition",
    "BT-134": "Startdatum des Rechnungspositionszeitraums",
    "BT-135": "Enddatum des Rechnungspositionszeitraums",
    "BT-136": "Betrag des Nachlasses auf Ebene der Rechnungsposition",
    "BT-137": "Grundbetrag des Nachlasses auf Ebene der Rechnungsposition",
    "BT-139": "Grund für den Nachlass auf Ebene der Rechnungsposition",
    "BT-140": "Code für den Grund des Nachlasses auf Ebene der Rechnungsposition",
    "BT-141": "Betrag des Zuschlags auf Ebene der Rechnungsposition",
    "BT-142": "Grundbetrag des Zuschlags auf Ebene der Rechnungsposition",
    "BT-146": "Nettopreis des Artikels",
    "BT-148": "Bruttopreis des Artikels",
    "BT-151": "Code der Umsatzsteuerkategorie des in Rechnung gestellten Artikels",
    "BT-152": "Umsatzsteuersatz des in Rechnung gestellten Artikels",
    "BT-153": "Artikelname",
}

# VAT category literal (English, as written in the assert) -> German rendering.
CATEGORY_DE = {
    "Standard rated": "Regelbesteuerung",
    "Standard rate": "Regelbesteuerung",
    "Zero rated": "Nullsatz",
    "Exempt from VAT": "von der Umsatzsteuer befreit",
    "Reverse charge": "Umkehrung der Steuerschuldnerschaft (Reverse Charge)",
    "VAT reverse charge": "Umkehrung der Steuerschuldnerschaft (Reverse Charge)",
    "Export outside the EU": "Ausfuhr außerhalb der EU",
    "Intra-community supply": "innergemeinschaftliche Lieferung",
    "Intracommunity supply": "innergemeinschaftliche Lieferung",
    "Not subject to VAT": "nicht umsatzsteuerbar",
}


def T(idcode):
    de = GLOSSARY[idcode]
    return "„%s“ (%s)" % (de, idcode)


def C(lit):
    return "„%s“" % CATEGORY_DE[lit.strip()]


def headed(idcode):
    return ("das Element " if idcode.startswith("BT") else "die Gruppe ") + T(idcode)

_IDLIST_TERM = re.compile(r"(?:the|a|an|The)\s+[^,()]+?\s+\((B[TG]-\d+)\)")
def tr_idlist(s):
    s = _IDLIST_TERM.sub(lambda m: T(m.group(1)), s)
    s = s.replace(" and/or ", " und/oder ").replace(" and ", " und ").replace(" or ", " oder ")
    return s

CTX_ACC = {
    "an Invoice line": ("eine Rechnungsposition", "der"),
    "a Document level allowance": ("einen Nachlass auf Dokumentenebene", "dem"),
    "a Document level charge": ("einen Zuschlag auf Dokumentenebene", "dem"),
}
CTX_NOM = {
    "An Invoice line": ("Eine Rechnungsposition", "der"),
    "A Document level allowance": ("Ein Nachlass auf Dokumentenebene", "dem"),
    "A Document level charge": ("Ein Zuschlag auf Dokumentenebene", "dem"),
}
CTX_DAT = {
    "an Invoice line": ("einer Rechnungsposition", "der"),
    "a Document level allowance": ("einem Nachlass auf Dokumentenebene", "dem"),
    "a Document level charge": ("einem Zuschlag auf Dokumentenebene", "dem"),
}

# ---------------------------------------------------------------- frames -----
FRAMES = []
def frame(pat):
    rx = re.compile(pat)
    def deco(fn):
        FRAMES.append((rx, fn)); return fn
    return deco

ID = r"\((B[TG]-\d+)\)"

# at least one / at least have one
@frame(r'^An Invoice shall have at least one .+? %s\.?$' % ID)
def _f(m):
    return "Eine Rechnung muss mindestens einen Eintrag der Gruppe %s enthalten." % T(m.group(1))

@frame(r'^An Invoice shall at least have one .+? %s\.?$' % ID)
def _f(m):
    return "Eine Rechnung muss mindestens einen Eintrag der Gruppe %s enthalten." % T(m.group(1))

# simple presence: An Invoice shall have/contain X (id).
@frame(r'^An Invoice shall (?:have|contain)(?: the| a| an)? .+? %s\.?$' % ID)
def _f(m):
    return "Eine Rechnung muss %s enthalten." % headed(m.group(1))

# The <address> (BG?) shall contain a <term> (BT).
ADDR = {"Seller postal address": "Die POSTANSCHRIFT DES VERKÄUFERS (BG-5)",
        "Buyer postal address": "Die POSTANSCHRIFT DES ERWERBERS (BG-8)"}
@frame(r'^The (Seller postal address|Buyer postal address)(?: \(BG-\d+\))? shall contain a .+? %s\.?$' % ID)
def _f(m):
    return "%s muss %s enthalten." % (ADDR[m.group(1)], headed(m.group(2)))

# Each <group> (BG) shall have a X (BT) or a Y (BT).  (registered BEFORE the
# single-term frame so a two-alternative requirement is not truncated.)
@frame(r'^Each .+? \((BG-\d+)\) shall have (?:a |an )?.+? \((BT-\d+)\) or (?:a |an )?.+? \((BT-\d+)\)\.?$')
def _f(m):
    return "Jeder Eintrag der Gruppe %s muss %s oder %s enthalten." % (
        T(m.group(1)), T(m.group(2)), T(m.group(3)))

# Each <group> (BG) shall have/contain <term> (BT).
@frame(r'^Each .+? \((BG-\d+)\) shall (?:have|contain) (?:a |an |the )?.+? %s\.?$' % ID)
def _f(m):
    return "Jeder Eintrag der Gruppe %s muss %s enthalten." % (T(m.group(1)), headed(m.group(2)))

# BR-DEC: allowed maximum number of decimals.
@frame(r'^The allowed maximum number of decimals for the .+? %s is 2\.?$' % ID)
def _f(m):
    return "Die zulässige Höchstzahl an Nachkommastellen für %s beträgt 2." % T(m.group(1))

# ---- VAT category frames ----
# x-01
@frame(r'^An Invoice that contains an Invoice line \(BG-25\), a Document level allowance \(BG-20\) or a Document level charge \(BG-21\) where the VAT category code \(BT-151, BT-95 or BT-102\) is "([^"]+)" shall contain (.+)\.$')
def _f(m):
    cat, tail = m.group(1), m.group(2)
    quant = "mindestens einen" if "at least one" in tail else "genau einen"
    return ("Enthält eine Rechnung eine Rechnungsposition (BG-25), einen Nachlass auf "
            "Dokumentenebene (BG-20) oder einen Zuschlag auf Dokumentenebene (BG-21), bei "
            "der bzw. dem der Code der Umsatzsteuerkategorie (BT-151, BT-95 oder BT-102) %s "
            "lautet, so muss die Rechnung in der UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) %s Code "
            "der Umsatzsteuerkategorie (BT-118) mit dem Wert %s enthalten."
            % (C(cat), quant, C(cat)))

# x-02/03/04 (and O-02/03/04 negated): contains <ctx> where <code> is C shall [not] contain <idlist>
@frame(r'^An Invoice that contains (an Invoice line|a Document level allowance|a Document level charge)(?: \(BG-\d+\))? where the (.+? VAT category code) \((BT-\d+)\) is "([^"]+)" shall (not )?contain (.+)\.$')
def _f(m):
    ctx, code_bt, cat, neg, idlist = m.group(1), m.group(3), m.group(4), m.group(5), m.group(6)
    de_ctx, rel = CTX_ACC[ctx]
    body = ("so darf die Rechnung %s nicht enthalten." % tr_idlist(idlist)) if neg \
        else ("so muss die Rechnung %s enthalten." % tr_idlist(idlist))
    return ("Enthält eine Rechnung %s (%s), bei %s der %s (%s) %s lautet, %s"
            % (de_ctx, _bg_of(ctx), rel, GLOSSARY[code_bt], code_bt, C(cat), body))

def _bg_of(ctx):
    return {"an Invoice line": "BG-25", "a Document level allowance": "BG-20",
            "a Document level charge": "BG-21"}[ctx]

# x-05/06/07: In <ctx> where <code> is C the <rate> shall be 0 / greater than zero
@frame(r'^In (an Invoice line|a Document level allowance|a Document level charge) \(BG-\d+\) where (?:the )?(.+? VAT category code) \((BT-\d+)\) is "([^"]+)",? the (.+? VAT rate) \((BT-\d+)\) shall be (0 \(zero\)|greater than zero)\.$')
def _f(m):
    ctx, code_bt, cat, rate_bt, val = m.group(1), m.group(3), m.group(4), m.group(6), m.group(7)
    de_ctx, rel = CTX_DAT[ctx]
    if val == "greater than zero":
        tail = "muss der %s (%s) größer als null sein." % (GLOSSARY[rate_bt], rate_bt)
    else:
        tail = "muss der %s (%s) 0 (null) betragen." % (GLOSSARY[rate_bt], rate_bt)
    return ("Bei %s (%s), bei %s der %s (%s) %s lautet, %s"
            % (de_ctx, _bg_of(ctx), rel, GLOSSARY[code_bt], code_bt, C(cat), tail))

# O-05/06/07: <ctx-nom> where VAT category code is C shall not contain a <rate>
@frame(r'^(An Invoice line|A Document level allowance|A Document level charge) \((BG-\d+)\) where (?:the )?VAT category code \((BT-\d+)\) is "([^"]+)" shall not contain (?:an |a )?.+? \((BT-\d+)\)\.$')
def _f(m):
    ctx, bg, code_bt, cat, rate_bt = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
    de_ctx, rel = CTX_NOM[ctx]
    return ("%s (%s), bei %s der Code der Umsatzsteuerkategorie (%s) %s lautet, darf den %s (%s) "
            "nicht enthalten." % (de_ctx, bg, rel, code_bt, C(cat), GLOSSARY[rate_bt], rate_bt))

# x-08: taxable amount equals sum ...
@frame(r'^In a VAT breakdown \(BG-23\) where (?:the )?VAT category code \(BT-118\) is "([^"]+)" the VAT category taxable amount \(BT-116\) shall equal the sum of Invoice line net amounts? \(BT-131\) minus the sum of Document level allowance amounts \(BT-92\) plus the sum of Document level charge amounts \(BT-99\) where the VAT category codes \(BT-151, BT-95, BT-102\) are "([^"]+)"\.$')
def _f(m):
    cat = m.group(1)
    return ("In einer UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23), bei der der Code der "
            "Umsatzsteuerkategorie (BT-118) %s lautet, muss der nach Umsatzsteuerkategorie "
            "zu versteuernde Betrag (BT-116) gleich der Summe der Nettobeträge der "
            "Rechnungspositionen (BT-131) abzüglich der Summe der Beträge der Nachlässe auf "
            "Dokumentenebene (BT-92) zuzüglich der Summe der Beträge der Zuschläge auf "
            "Dokumentenebene (BT-99) sein, für die der Code der Umsatzsteuerkategorie "
            "(BT-151, BT-95, BT-102) %s lautet." % (C(cat), C(cat)))

# x-09: tax amount shall be/equal 0
@frame(r'^The VAT category tax amount \(BT-117\) [Ii]n a VAT breakdown \(BG-23\) where (?:the )?VAT category code \(BT-118\) (?:is|equals) "([^"]+)" shall (?:be|equal) 0 \(zero\)\.$')
def _f(m):
    cat = m.group(1)
    return ("Der Umsatzsteuerbetrag der Umsatzsteuerkategorie (BT-117) in einer "
            "UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23), bei der der Code der Umsatzsteuerkategorie "
            "(BT-118) %s lautet, muss 0 (null) betragen." % C(cat))

# ---- BR-CO arithmetic/aggregation formulas ----
_CO_TERM = re.compile(r"([A-Za-z][A-Za-z ]*?) \((BT-\d+)\)")
def co_formula(text):
    g = _CO_TERM.sub(lambda m: T(m.group(2)), text.strip())
    g = g.replace("rounded to two decimals", "auf zwei Nachkommastellen gerundet")
    return g

CO_FORMULA_IDS = {"BR-CO-10", "BR-CO-11", "BR-CO-12", "BR-CO-13", "BR-CO-14",
                  "BR-CO-15", "BR-CO-16", "BR-CO-17"}

# ---- exact-match German for irregular one-off requirements ----
SPECIAL = {
    "An Invoice shall contain the Seller postal address.":
        "Eine Rechnung muss die POSTANSCHRIFT DES VERKÄUFERS (BG-5) enthalten.",
    "The Payee name (BT-59) shall be provided in the Invoice, if the Payee (BG-10) is different from the Seller (BG-4)":
        "Das Element „Name des Zahlungsempfängers“ (BT-59) ist in der Rechnung anzugeben, "
        "wenn der ZAHLUNGSEMPFÄNGER (BG-10) vom VERKÄUFER (BG-4) abweicht.",
    "The Seller tax representative name (BT-62) shall be provided in the Invoice, if the Seller (BG-4) has a Seller tax representative party (BG-11)":
        "Das Element „Name des Steuervertreters des Verkäufers“ (BT-62) ist in der Rechnung "
        "anzugeben, wenn der VERKÄUFER (BG-4) einen STEUERVERTRETER DES VERKÄUFERS (BG-11) hat.",
    "The Seller tax representative postal address (BG-12) shall be provided in the Invoice, if the Seller (BG-4) has a Seller tax representative party (BG-11).":
        "Die Gruppe POSTANSCHRIFT DES STEUERVERTRETERS DES VERKÄUFERS (BG-12) ist in der "
        "Rechnung anzugeben, wenn der VERKÄUFER (BG-4) einen STEUERVERTRETER DES VERKÄUFERS "
        "(BG-11) hat.",
    "The Seller tax representative postal address (BG-12) shall contain a Tax representative country code (BT-69), if the Seller (BG-4) has a Seller tax representative party (BG-11).":
        "Die Gruppe POSTANSCHRIFT DES STEUERVERTRETERS DES VERKÄUFERS (BG-12) muss den "
        "Ländercode des Steuervertreters (BT-69) enthalten, wenn der VERKÄUFER (BG-4) einen "
        "STEUERVERTRETER DES VERKÄUFERS (BG-11) hat.",
    "The Item net price (BT-146) shall NOT be negative.":
        "Der Nettopreis des Artikels (BT-146) darf NICHT negativ sein.",
    "The Item gross price (BT-148) shall NOT be negative.":
        "Der Bruttopreis des Artikels (BT-148) darf NICHT negativ sein.",
    "If both Invoicing period start date (BT-73) and Invoicing period end date (BT-74) are given then the Invoicing period end date (BT-74) shall be later or equal to the Invoicing period start date (BT-73).":
        "Sind sowohl das Startdatum des Rechnungszeitraums (BT-73) als auch das Enddatum des "
        "Rechnungszeitraums (BT-74) angegeben, so muss das Enddatum des Rechnungszeitraums "
        "(BT-74) gleich dem Startdatum des Rechnungszeitraums (BT-73) sein oder danach liegen.",
    "If both Invoice line period start date (BT-134) and Invoice line period end date (BT-135) are given then the Invoice line period end date (BT-135) shall be later or equal to the Invoice line period start date (BT-134).":
        "Sind sowohl das Startdatum des Rechnungspositionszeitraums (BT-134) als auch das "
        "Enddatum des Rechnungspositionszeitraums (BT-135) angegeben, so muss das Enddatum "
        "des Rechnungspositionszeitraums (BT-135) gleich dem Startdatum des "
        "Rechnungspositionszeitraums (BT-134) sein oder danach liegen.",
    "Each Invoice line charge shall have an Invoice line charge reason or an invoice line allowance reason code.":
        "Jeder Zuschlag auf Ebene der Rechnungsposition muss einen Grund für den Zuschlag auf "
        "Ebene der Rechnungsposition oder einen Code für den Grund des Nachlasses auf Ebene "
        "der Rechnungsposition enthalten.",
    "Each VAT breakdown (BG-23) shall be defined through a VAT category code (BT-118).":
        "Jeder Eintrag der Gruppe UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) muss durch einen Code "
        "der Umsatzsteuerkategorie (BT-118) bestimmt werden.",
    "Each VAT breakdown (BG-23) shall have a VAT category rate (BT-119), except if the Invoice is not subject to VAT.":
        "Jeder Eintrag der Gruppe UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) muss einen "
        "Umsatzsteuersatz der Umsatzsteuerkategorie (BT-119) enthalten, es sei denn, die "
        "Rechnung unterliegt nicht der Umsatzsteuer.",
    "A Payment instruction (BG-16) shall specify the Payment means type code (BT-81).":
        "Eine ZAHLUNGSANWEISUNG (BG-16) muss den Code für das Zahlungsmittel (BT-81) angeben.",
    "A Payment account identifier (BT-84) shall be present if Credit transfer (BG-17) information is provided in the Invoice.":
        "Eine Kennung des Zahlungskontos (BT-84) muss vorhanden sein, wenn in der Rechnung "
        "Angaben zur ÜBERWEISUNG (BG-17) gemacht werden.",
    "In accordance with card payments security standards an invoice should never include a full card primary account number (BT-87). At the moment PCI Security Standards Council has defined that the first 6 digits and last 4 digits are the maximum number of digits to be shown.":
        "Gemäß den Sicherheitsstandards für Kartenzahlungen darf eine Rechnung niemals eine "
        "vollständige Kartennummer (primäre Kontonummer der Zahlungskarte) (BT-87) enthalten. "
        "Derzeit hat das PCI Security Standards Council festgelegt, dass höchstens die ersten "
        "6 und die letzten 4 Ziffern angezeigt werden dürfen.",
    "If the Payment means type code (BT-81) means SEPA credit transfer, Local credit transfer or Non-SEPA international credit transfer, the Payment account identifier (BT-84) shall be present.":
        "Wenn der Code für das Zahlungsmittel (BT-81) eine SEPA-Überweisung, eine nationale "
        "Überweisung oder eine internationale Nicht-SEPA-Überweisung bezeichnet, muss die "
        "Kennung des Zahlungskontos (BT-84) vorhanden sein.",
    "The Seller electronic address (BT-34) shall have a Scheme identifier.":
        "Die Elektronische Adresse des Verkäufers (BT-34) muss eine Schema-Kennung aufweisen.",
    "The Buyer electronic address (BT-49) shall have a Scheme identifier.":
        "Die Elektronische Adresse des Erwerbers (BT-49) muss eine Schema-Kennung aufweisen.",
    "Each Invoice line (BG-25) shall be categorized with an Invoiced item VAT category code (BT-151).":
        "Jeder Eintrag der Gruppe RECHNUNGSPOSITION (BG-25) muss mit einem Code der "
        "Umsatzsteuerkategorie des in Rechnung gestellten Artikels (BT-151) kategorisiert werden.",
    'A VAT breakdown (BG-23) with VAT Category code (BT-118) "Reverse charge" shall have a VAT exemption reason code (BT-121), meaning "Reverse charge" or the VAT exemption reason text (BT-120) "Reverse charge" (or the equivalent standard text in another language).':
        "Eine UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) mit dem Code der Umsatzsteuerkategorie "
        "(BT-118) „Umkehrung der Steuerschuldnerschaft (Reverse Charge)“ muss einen Code für "
        "den Grund der Umsatzsteuerbefreiung (BT-121) mit der Bedeutung „Reverse charge“ oder "
        "den Text für den Grund der Umsatzsteuerbefreiung (BT-120) „Reverse charge“ (oder den "
        "entsprechenden Standardtext in einer anderen Sprache) enthalten.",
    'A VAT breakdown (BG-23) with VAT Category code (BT-118) "Exempt from VAT" shall have a VAT exemption reason code (BT-121) or a VAT exemption reason text (BT-120).':
        "Eine UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) mit dem Code der Umsatzsteuerkategorie "
        "(BT-118) „von der Umsatzsteuer befreit“ muss einen Code für den Grund der "
        "Umsatzsteuerbefreiung (BT-121) oder einen Text für den Grund der "
        "Umsatzsteuerbefreiung (BT-120) enthalten.",
    'A VAT breakdown (BG-23) with the VAT Category code (BT-118) "Export outside the EU" shall have a VAT exemption reason code (BT-121), meaning "Export outside the EU" or the VAT exemption reason text (BT-120) "Export outside the EU" (or the equivalent standard text in another language).':
        "Eine UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) mit dem Code der Umsatzsteuerkategorie "
        "(BT-118) „Ausfuhr außerhalb der EU“ muss einen Code für den Grund der "
        "Umsatzsteuerbefreiung (BT-121) mit der Bedeutung „Export outside the EU“ oder den "
        "Text für den Grund der Umsatzsteuerbefreiung (BT-120) „Export outside the EU“ (oder "
        "den entsprechenden Standardtext in einer anderen Sprache) enthalten.",
    'A VAT breakdown (BG-23) with VAT Category code (BT-118) " Not subject to VAT" shall have a VAT exemption reason code (BT-121), meaning " Not subject to VAT" or a VAT exemption reason text (BT-120) " Not subject to VAT" (or the equivalent standard text in another language).':
        "Eine UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) mit dem Code der Umsatzsteuerkategorie "
        "(BT-118) „nicht umsatzsteuerbar“ muss einen Code für den Grund der "
        "Umsatzsteuerbefreiung (BT-121) mit der Bedeutung „Not subject to VAT“ oder einen "
        "Text für den Grund der Umsatzsteuerbefreiung (BT-120) „Not subject to VAT“ (oder den "
        "entsprechenden Standardtext in einer anderen Sprache) enthalten.",
    'In an Invoice with a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Intra-community supply" the Actual delivery date (BT-72) or the Invoicing period (BG-14) shall not be blank.':
        "In einer Rechnung mit einer UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23), bei der der Code der "
        "Umsatzsteuerkategorie (BT-118) „innergemeinschaftliche Lieferung“ lautet, darf das "
        "Tatsächliche Lieferdatum (BT-72) oder der RECHNUNGSZEITRAUM (BG-14) nicht leer sein.",
    'In an Invoice with a VAT breakdown (BG-23) where the VAT category code (BT-118) is "Intra-community supply" the Deliver to country code (BT-80) shall not be blank.':
        "In einer Rechnung mit einer UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23), bei der der Code der "
        "Umsatzsteuerkategorie (BT-118) „innergemeinschaftliche Lieferung“ lautet, darf der "
        "Ländercode des Lieferorts (BT-80) nicht leer sein.",
    'An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain other VAT breakdown groups (BG-23).':
        "Enthält eine Rechnung eine UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) mit einem Code der "
        "Umsatzsteuerkategorie (BT-118) „nicht umsatzsteuerbar“, so darf sie keine weiteren "
        "Gruppen UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) enthalten.",
    'An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain an Invoice line (BG-25) where the Invoiced item VAT category code (BT-151) is not "Not subject to VAT".':
        "Enthält eine Rechnung eine UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) mit einem Code der "
        "Umsatzsteuerkategorie (BT-118) „nicht umsatzsteuerbar“, so darf sie keine "
        "RECHNUNGSPOSITION (BG-25) enthalten, bei der der Code der Umsatzsteuerkategorie des "
        "in Rechnung gestellten Artikels (BT-151) nicht „nicht umsatzsteuerbar“ lautet.",
    'An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain Document level allowances (BG-20) where Document level allowance VAT category code (BT-95) is not "Not subject to VAT".':
        "Enthält eine Rechnung eine UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) mit einem Code der "
        "Umsatzsteuerkategorie (BT-118) „nicht umsatzsteuerbar“, so darf sie keine NACHLÄSSE "
        "AUF DOKUMENTENEBENE (BG-20) enthalten, bei denen der Code der Umsatzsteuerkategorie "
        "des Nachlasses auf Dokumentenebene (BT-95) nicht „nicht umsatzsteuerbar“ lautet.",
    'An Invoice that contains a VAT breakdown group (BG-23) with a VAT category code (BT-118) "Not subject to VAT" shall not contain Document level charges (BG-21) where Document level charge VAT category code (BT-102) is not "Not subject to VAT".':
        "Enthält eine Rechnung eine UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) mit einem Code der "
        "Umsatzsteuerkategorie (BT-118) „nicht umsatzsteuerbar“, so darf sie keine ZUSCHLÄGE "
        "AUF DOKUMENTENEBENE (BG-21) enthalten, bei denen der Code der Umsatzsteuerkategorie "
        "des Zuschlags auf Dokumentenebene (BT-102) nicht „nicht umsatzsteuerbar“ lautet.",
    'The VAT category tax amount (BT-117) in a VAT breakdown (BG-23) where VAT category code (BT-118) is "Standard rated" shall equal the VAT category taxable amount (BT-116) multiplied by the VAT category rate (BT-119).':
        "Der Umsatzsteuerbetrag der Umsatzsteuerkategorie (BT-117) in einer "
        "UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23), bei der der Code der Umsatzsteuerkategorie "
        "(BT-118) „Regelbesteuerung“ lautet, muss gleich dem nach Umsatzsteuerkategorie zu "
        "versteuernden Betrag (BT-116) multipliziert mit dem Umsatzsteuersatz der "
        "Umsatzsteuerkategorie (BT-119) sein.",
    'A VAT breakdown (BG-23) with VAT Category code (BT-118) "Standard rate" shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).':
        "Eine UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) mit dem Code der Umsatzsteuerkategorie "
        "(BT-118) „Regelbesteuerung“ darf keinen Code für den Grund der Umsatzsteuerbefreiung "
        "(BT-121) und keinen Text für den Grund der Umsatzsteuerbefreiung (BT-120) enthalten.",
    'A VAT breakdown (BG-23) with VAT Category code (BT-118) "Zero rated" shall not have a VAT exemption reason code (BT-121) or VAT exemption reason text (BT-120).':
        "Eine UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) mit dem Code der Umsatzsteuerkategorie "
        "(BT-118) „Nullsatz“ darf keinen Code für den Grund der Umsatzsteuerbefreiung (BT-121) "
        "und keinen Text für den Grund der Umsatzsteuerbefreiung (BT-120) enthalten.",
    # ---- BR-CL code-list rules ----
    "The document type code MUST be coded by the invoice and credit note related code lists of UNTDID 1001.":
        "Der Code für den Dokumententyp MUSS anhand der für Rechnungen und Gutschriften "
        "vorgesehenen Codelisten aus UNTDID 1001 codiert werden.",
    "currencyID MUST be coded using ISO code list 4217 alpha-3":
        "Die Währungskennung (currencyID) MUSS anhand der ISO-Codeliste 4217 Alpha-3 codiert werden.",
    "Invoice currency code MUST be coded using ISO code list 4217 alpha-3":
        "Der Code für die Rechnungswährung MUSS anhand der ISO-Codeliste 4217 Alpha-3 codiert werden.",
    "Tax currency code MUST be coded using ISO code list 4217 alpha-3":
        "Der Code für die Steuerwährung MUSS anhand der ISO-Codeliste 4217 Alpha-3 codiert werden.",
    "Item classification identifier identification scheme identifier MUST be coded using one of the UNTDID 7143 list.":
        "Die Kennung des Schemas der Artikel-Klassifizierungskennung MUSS anhand eines Wertes "
        "der Liste UNTDID 7143 codiert werden.",
    "Country codes in an invoice MUST be coded using ISO code list 3166-1":
        "Ländercodes in einer Rechnung MÜSSEN anhand der ISO-Codeliste 3166-1 codiert werden.",
    "Payment means in an invoice MUST be coded using UNCL4461 code list":
        "Zahlungsmittel in einer Rechnung MÜSSEN anhand der Codeliste UNCL4461 codiert werden.",
    "Invoice tax categories MUST be coded using UNCL5305 code list":
        "Umsatzsteuerkategorien der Rechnung MÜSSEN anhand der Codeliste UNCL5305 codiert werden.",
    "Coded allowance reasons MUST belong to the UNCL 5189 code list":
        "Codierte Nachlassgründe MÜSSEN der Codeliste UNCL 5189 angehören.",
    "Coded charge reasons MUST belong to the UNCL 7161 code list":
        "Codierte Zuschlagsgründe MÜSSEN der Codeliste UNCL 7161 angehören.",
    "Item standard identifier scheme identifier MUST belong to the ISO 6523 ICD code list":
        "Die Kennung des Schemas der Artikel-Standardkennung MUSS der Codeliste ISO 6523 ICD angehören.",
    "Tax exemption reason code identifier scheme identifier MUST belong to the CEF VATEX code list":
        "Die Kennung des Schemas des Codes für den Grund der Umsatzsteuerbefreiung MUSS der "
        "Codeliste CEF VATEX angehören.",
    "Unit code MUST be coded according to the UN/ECE Recommendation 20 with Rec 21 extension":
        "Der Einheiten-Code MUSS gemäß der UN/ECE-Empfehlung 20 mit der Erweiterung Rec 21 "
        "codiert werden.",
    "For Mime code in attribute use MIMEMediaType.":
        "Für den MIME-Code im Attribut ist MIMEMediaType zu verwenden.",
    # ---- BR-DEX extension rules whose vendored KoSIT assert is English ----
    "any scheme identifier on a Party identifier (cac:Party Identification/cbc:ID) must be an ISO 6523 ICD (extension) code — or 'SEPA' when the identifier belongs to the Seller or the Payee.":
        "Jede Schema-Kennung einer Beteiligtenkennung (cac:PartyIdentification/cbc:ID) muss "
        "ein ISO-6523-ICD-Code (Extension) sein – oder 'SEPA', wenn die Kennung zum Verkäufer "
        "oder zum Zahlungsempfänger gehört.",
    "any scheme identifier on a legal registration identifier (cac:PartyLegalEntity/cbc:CompanyID, BT-30/BT-47) must be an ISO 6523 ICD (extension) code.":
        "Jede Schema-Kennung einer rechtlichen Registrierungskennung "
        "(cac:PartyLegalEntity/cbc:CompanyID, BT-30/BT-47) muss ein ISO-6523-ICD-Code "
        "(Extension) sein.",
    "any scheme identifier on an item standard identifier (cac:StandardItemIdentification/cbc:ID, BT-157) must be an ISO 6523 ICD (extension) code.":
        "Jede Schema-Kennung einer Artikel-Standardkennung "
        "(cac:StandardItemIdentification/cbc:ID, BT-157) muss ein ISO-6523-ICD-Code "
        "(Extension) sein.",
    "any scheme identifier on an Endpoint identifier (cbc:Endpoint ID, BT-34/BT-49) must belong to the CEF EAS (extension) code list.":
        "Jede Schema-Kennung einer Endpunktkennung (cbc:EndpointID, BT-34/BT-49) muss der "
        "CEF-EAS-Codeliste (Extension) angehören.",
    "any scheme identifier on a Deliver-to location identifier (cac:DeliveryLocation/cbc:ID, BT-71) must be an ISO 6523 ICD (extension) code.":
        "Jede Schema-Kennung einer Kennung des Lieferorts (cac:DeliveryLocation/cbc:ID, BT-71) "
        "muss ein ISO-6523-ICD-Code (Extension) sein.",
    # ---- Supporting-document / item-metadata / VAT-point batch (2026-07) ----
    "An Invoice line (BG-25) shall have an Invoiced quantity unit of measure code (BT-130).":
        "Jede Rechnungsposition (BG-25) muss den Code der Maßeinheit der in Rechnung "
        "gestellten Menge (BT-130) enthalten.",
    "If the VAT accounting currency code (BT-6) is present, then the Invoice total VAT amount in accounting currency (BT-111) shall be provided.":
        "Wenn der Code der Währung der Umsatzsteuerabrechnung (BT-6) angegeben ist, muss "
        "der Gesamtbetrag der Umsatzsteuer in der Abrechnungswährung (BT-111) angegeben "
        "werden.",
    "Each Item attribute (BG-32) shall contain an Item attribute name (BT-160) and an Item attribute value (BT-161).":
        "Jeder Eintrag der Gruppe „ARTIKELATTRIBUTE“ (BG-32) muss die Bezeichnung des "
        "Artikelattributs (BT-160) und den Wert des Artikelattributs (BT-161) enthalten.",
    "The Item standard identifier (BT-157) shall have a Scheme identifier.":
        "Die Kennung eines Artikels nach registriertem Schema (BT-157) muss eine "
        "Schema-Kennung enthalten.",
    "The Item classification identifier (BT-158) shall have a Scheme identifier.":
        "Die Klassifikationskennung des Artikels (BT-158) muss eine Schema-Kennung "
        "enthalten.",
    "Value added tax point date (BT-7) and Value added tax point date code (BT-8) are mutually exclusive.":
        "Das Datum der Steuerfälligkeit (BT-7) und der Code für das Datum der "
        "Steuerfälligkeit (BT-8) schließen sich gegenseitig aus.",
    "The Seller VAT identifier (BT-31), the Seller tax representative VAT identifier (BT-63) and the Buyer VAT identifier (BT-48) shall have a prefix in accordance with ISO code ISO 3166-1 alpha-2 by which the country of issue may be identified. Nevertheless, Greece may use the prefix ‘EL’.":
        "Der Umsatzsteuer-Identifikationsnummer des Verkäufers (BT-31), der "
        "Umsatzsteuer-Identifikationsnummer des Steuervertreters des Verkäufers (BT-63) "
        "und der Umsatzsteuer-Identifikationsnummer des Erwerbers (BT-48) muss ein "
        "Präfix gemäß ISO 3166-1 Alpha-2 vorangestellt sein, anhand dessen das Land "
        "der Ausstellung bestimmt werden kann. Griechenland darf dennoch das Präfix "
        "„EL“ verwenden.",
    "If Invoicing period (BG-14) is used, the Invoicing period start date (BT-73) or the Invoicing period end date (BT-74) shall be filled, or both.":
        "Wenn die Gruppe „RECHNUNGSZEITRAUM“ (BG-14) verwendet wird, müssen das "
        "Startdatum des Rechnungszeitraums (BT-73) oder das Enddatum des "
        "Rechnungszeitraums (BT-74) oder beide angegeben werden.",
    "Amount due for payment (BT-115) = Invoice total amount with VAT (BT-112) - Paid amount (BT-113) + Rounding amount (BT-114) + Σ Third party payment amount (BT-DEX-002).":
        "Fälliger Zahlungsbetrag (BT-115) = Gesamtbetrag der Rechnung einschließlich "
        "Umsatzsteuer (BT-112) - Bereits gezahlter Betrag (BT-113) + Rundungsbetrag (BT-114) "
        "+ Σ Betrag der Zahlung durch Dritte (BT-DEX-002).",
    # ---- Core/decimals/VAT gap batch A (2026-07) ----
    "If Invoice line period (BG-26) is used, the Invoice line period start date (BT-134) or the Invoice line period end date (BT-135) shall be filled, or both.":
        "Wenn die Gruppe „RECHNUNGSPOSITIONSZEITRAUM“ (BG-26) verwendet wird, müssen das "
        "Startdatum des Rechnungspositionszeitraums (BT-134) oder das Enddatum des "
        "Rechnungspositionszeitraums (BT-135) oder beide angegeben werden.",
    "Each Document level allowance (BG-20) shall contain a Document level allowance reason (BT-97) or a Document level allowance reason code (BT-98), or both.":
        "Jeder NACHLASS AUF DOKUMENTENEBENE (BG-20) muss einen Grund für den Nachlass auf "
        "Dokumentenebene (BT-97) oder einen Code für den Grund des Nachlasses auf "
        "Dokumentenebene (BT-98) oder beides enthalten.",
    "Each Document level charge (BG-21) shall contain a Document level charge reason (BT-104) or a Document level charge reason code (BT-105), or both.":
        "Jeder ZUSCHLAG AUF DOKUMENTENEBENE (BG-21) muss einen Grund für den Zuschlag auf "
        "Dokumentenebene (BT-104) oder einen Code für den Grund des Zuschlags auf "
        "Dokumentenebene (BT-105) oder beides enthalten.",
    "Each Invoice line allowance (BG-27) shall contain an Invoice line allowance reason (BT-139) or an Invoice line allowance reason code (BT-140), or both.":
        "Jeder NACHLASS AUF EBENE DER RECHNUNGSPOSITION (BG-27) muss einen Grund für den "
        "Nachlass auf Ebene der Rechnungsposition (BT-139) oder einen Code für den Grund "
        "des Nachlasses auf Ebene der Rechnungsposition (BT-140) oder beides enthalten.",
    "Each Invoice line charge (BG-28) shall contain an Invoice line charge reason (BT-144) or an Invoice line charge reason code (BT-145), or both.":
        "Jeder ZUSCHLAG AUF EBENE DER RECHNUNGSPOSITION (BG-28) muss einen Grund für den "
        "Zuschlag auf Ebene der Rechnungsposition (BT-144) oder einen Code für den Grund "
        "des Zuschlags auf Ebene der Rechnungsposition (BT-145) oder beides enthalten.",
    "In order for the buyer to automatically identify a supplier, the Seller identifier (BT-29), the Seller legal registration identifier (BT-30) and/or the Seller VAT identifier (BT-31) shall be present.":
        "Damit der Erwerber den Lieferanten automatisch identifizieren kann, müssen die "
        "Kennung des Verkäufers (BT-29), die Rechtliche Registrierungskennung des "
        "Verkäufers (BT-30) und/oder die Umsatzsteuer-Identifikationsnummer des "
        "Verkäufers (BT-31) vorhanden sein.",
    'A VAT breakdown (BG-23) with the VAT Category code (BT-118) "Intra-community supply" shall have a VAT exemption reason code (BT-121), meaning "Intra-community supply" or the VAT exemption reason text (BT-120) "Intra-community supply" (or the equivalent standard text in another language).':
        "Eine UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) mit dem Code der Umsatzsteuerkategorie "
        "(BT-118) „innergemeinschaftliche Lieferung“ muss einen Code für den Grund der "
        "Umsatzsteuerbefreiung (BT-121) mit der Bedeutung „Intra-community supply“ oder "
        "den Text für den Grund der Umsatzsteuerbefreiung (BT-120) „Intra-community "
        "supply“ (oder den entsprechenden Standardtext in einer anderen Sprache) "
        "enthalten.",
    'For each different value of VAT category rate (BT-119) where the VAT category code (BT-118) is "Standard rated", the VAT category taxable amount (BT-116) in a VAT breakdown (BG-23) shall equal the sum of Invoice line net amounts (BT-131) plus the sum of document level charge amounts (BT-99) minus the sum of document level allowance amounts (BT-92) where the VAT category code (BT-151, BT-102, BT-95) is "Standard rated" and the VAT rate (BT-152, BT-103, BT-96) equals the VAT category rate (BT-119).':
        "Für jeden einzelnen Wert des Umsatzsteuersatzes der Umsatzsteuerkategorie "
        "(BT-119), bei dem der Code der Umsatzsteuerkategorie (BT-118) „Regelbesteuerung“ "
        "lautet, muss der nach Umsatzsteuerkategorie zu versteuernde Betrag (BT-116) in "
        "einer UMSATZSTEUERAUFSCHLÜSSELUNG (BG-23) gleich der Summe der Nettobeträge der "
        "Rechnungspositionen (BT-131) zuzüglich der Summe der Beträge der Zuschläge auf "
        "Dokumentenebene (BT-99) abzüglich der Summe der Beträge der Nachlässe auf "
        "Dokumentenebene (BT-92) sein, für die der Code der Umsatzsteuerkategorie "
        "(BT-151, BT-102, BT-95) „Regelbesteuerung“ lautet und der Umsatzsteuersatz "
        "(BT-152, BT-103, BT-96) gleich dem Umsatzsteuersatz der Umsatzsteuerkategorie "
        "(BT-119) ist.",
}


def translate_requirement(rid, text):
    t = text.strip()
    if t in SPECIAL:
        return SPECIAL[t]
    if rid in CO_FORMULA_IDS:
        return co_formula(t)
    for rx, fn in FRAMES:
        m = rx.match(t)
        if m:
            return fn(m)
    return None


# German assert detection: which vendored KoSIT asserts are actually German.
_DE_WORDS = re.compile(
    r"(?:[\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df]|\b(?:muss|m\u00fcssen|enthalten|"
    r"\u00fcbermittelt|Rechnung|Element|Gruppe|werden|entsprechen|Angaben?|Wenn|"
    r"zul\u00e4ssig|benutzt|Falle|darf|zus\u00e4tzlich|nicht)\b)")


def assert_is_german(text):
    """True iff the vendored Schematron assert string is German prose (the ~40
    BR-DE / BR-DE-TMP / German BR-DEX asserts). Six BR-DEX extension asserts are
    written in English in the KoSIT sources and are handled as translations."""
    return bool(_DE_WORDS.search(text or ""))


def _fix_family(rid, rec, requires):
    """Family key mirroring derive_fix's branch selection. Reads only the id, the
    English requirement and the Schematron @test (all language-neutral), so the
    German fix picks the same imperative verb the English fix does."""
    test = rec.get("test") or ""
    if rid.startswith("BR-CL"):
        return "codelist"
    if rid.startswith("BR-DEC"):
        return "decimals"
    if "=" in requires or "\u03a3" in requires or requires.lower().startswith("sum "):
        return "calc"
    presence = bool(re.search(r"exists\(|!=\s*''|count\([^)]*\)\s*>\s*0", test)) \
        or " shall have " in requires or " shall contain " in requires \
        or "must contain" in requires.lower() or "must be transmitted" in requires.lower()
    if presence:
        return "presence"
    if rid.split("-")[1] in ("AE", "E", "G", "S", "Z", "O", "IC"):
        return "vat"
    return "correct"


_FIX_DE = {
    "codelist": "Codieren Sie %s mit einem g\u00fcltigen Wert aus der geforderten Codeliste: %s.",
    "decimals": "Runden Sie den Wert bei %s auf die zul\u00e4ssige Anzahl an Nachkommastellen: %s.",
    "calc": "Korrigieren Sie den berechneten Betrag bei %s, sodass gilt: %s.",
    "presence": "Erg\u00e4nzen Sie das erforderliche Element bei %s: %s.",
    "vat": "Passen Sie die Umsatzsteueraufschl\u00fcsselung bei %s an, sodass gilt: %s.",
    "correct": "Korrigieren Sie %s, sodass gilt: %s.",
}


def derive_fix_de(rid, rec, requires, location, req_de):
    """One-line German fix: the same family verb the English fix uses, the same
    (language-neutral) XML location, and the German requirement clause."""
    fam = _fix_family(rid, rec, requires)
    return _FIX_DE[fam] % ("`%s`" % location, req_de.rstrip("."))


def derive_german(rid, rec, requires, location):
    """Return ``(title_de, fix_de, de_source)`` for one rule.

    * ``de_source == "kosit"`` -- the vendored KoSIT XRechnung Schematron assert
      is itself German; the German title is that assert string verbatim (cleaned),
      never paraphrased from memory.
    * ``de_source == "translation"`` -- the only official wording is the English
      CEN (or an English KoSIT extension) assert; the German is a faithful,
      deterministic rendering of the catalog's English ``requires`` built from a
      fixed EN 16931 term glossary + a closed frame/exact-match set. Any English
      requirement that matches no frame raises (no silent guess)."""
    assert_text = rec["assert_text"]
    if assert_is_german(assert_text):
        return assert_text, derive_fix_de(rid, rec, requires, location, assert_text), "kosit"
    req_de = translate_requirement(rid, requires)
    if req_de is None:
        raise SystemExit(
            "no German rendering registered for translation rule %s: %r" % (rid, requires))
    return req_de, derive_fix_de(rid, rec, requires, location, req_de), "translation"


# --------------------------------------------------------------------------- #
# Assembly.                                                                    #
# --------------------------------------------------------------------------- #
def build_catalog():
    matrix = _coverage.load_matrix()
    title_by_id = {r["id"]: r["title"] for r in matrix["rules"]}
    src_keys = set(matrix["schematron_sources"])

    idx = load_schematron_index()
    core_fns = _core_fns()
    xr_fns = _xr_fns()
    ids = sorted(_coverage.engine_fireable_ids(), key=_sort_key)

    catalog = {}
    for rid in ids:
        rec = idx.get(rid)
        if rec is None:
            raise SystemExit("no Schematron assert found for fireable rule %s" % rid)
        title = title_by_id[rid]
        requires = _requires(rid, rec, xr_fns, title)
        location = derive_location(rid, rec)
        skey = source_key(rid)
        if skey not in src_keys:
            raise SystemExit("source key %r not in coverage matrix" % skey)
        title_de, fix_de, de_source = derive_german(rid, rec, requires, location)
        entry = {
            "title": title,
            "requires": requires,
            "bt_bg": derive_bt_bg(title, requires, rec["assert_text"]),
            "location_hint": location,
            "fix": derive_fix(rid, rec, requires, location, xr_fns),
            "severity": engine_severity(rid, core_fns, xr_fns),
            "provenance": {
                "source": skey,
                "assert": rec["assert_text"],
            },
            "title_de": title_de,
            "fix_de": fix_de,
            "de_source": de_source,
        }
        catalog[rid] = entry
    return catalog


def _sort_key(rid):
    toks = rid.split("-")
    suffix = ""
    if toks[-1].isalpha() and len(toks[-1]) == 1:
        suffix = toks[-1]
        toks = toks[:-1]
    num = int(toks[-1]) if toks[-1].isdigit() else -1
    family = "-".join(toks[:-1]) if toks[-1].isdigit() else "-".join(toks)
    order = ["BR", "BR-CL", "BR-CO", "BR-DEC", "BR-AE", "BR-E", "BR-G",
             "BR-IC", "BR-O", "BR-S", "BR-Z", "BR-DE", "BR-DE-TMP", "BR-DEX"]
    rank = order.index(family) if family in order else len(order)
    return (rank, family, num, suffix)


def render(catalog):
    doc = {
        "artifact": "einvoice per-rule remediation catalog",
        "description": (
            "Human-facing remediation guidance for every EN 16931 / XRechnung "
            "rule the einvoice engine can fire. One entry per rule id "
            "(einvoice.coverage.engine_fireable_ids); every field is derived "
            "from the vendored official Schematron assert text (corpus/) and "
            "the EN 16931 BT/BG model, not authored from memory. This is the "
            "single source the report writer, RULES.md and --explain read. "
            "Each entry also carries German title_de/fix_de: de_source=='kosit' "
            "means the German is the vendored KoSIT XRechnung Schematron assert "
            "verbatim; de_source=='translation' means a faithful, deterministic "
            "German rendering of the same English EN 16931 / codelist requirement."),
        "generated_by": "gen_remediation.py",
        "rule_count": len(catalog),
        "rules": catalog,
    }
    return json.dumps(doc, ensure_ascii=False, indent=2) + "\n"


def main(argv):
    text = render(build_catalog())
    if "--check" in argv:
        cur = open(OUT_PATH, encoding="utf-8").read() if os.path.exists(OUT_PATH) else None
        if cur != text:
            sys.stderr.write("stale (re-run gen_remediation.py): %s\n"
                             % os.path.basename(OUT_PATH))
            return 1
        print("remediation catalog up to date")
        return 0
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        fh.write(text)
    n = json.loads(text)["rule_count"]
    print("wrote %s (%d rules)" % (os.path.basename(OUT_PATH), n))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
