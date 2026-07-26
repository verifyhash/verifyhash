"""Orchestration: parse -> structural checks -> business rules -> result.

This module is the validation entry point of the public API. It exposes the
two callables and the result type that embedders use:

    * :func:`validate_file` — validate a path (or a binary bytes buffer).
    * :func:`validate_root` — validate an already-parsed invoice root (UBL
      ``Invoice``/``CreditNote`` or UN/CEFACT ``CrossIndustryInvoice``).
    * :class:`Result` — the outcome, carrying ``.valid`` and ``.violations``.

Both callables return a :class:`Result`. Each entry in ``Result.violations``
is an :class:`einvoice.rules.Violation` namedtuple with the fields
``rule_id``, ``message``, ``element``, ``severity`` and the two optional,
mutually exclusive position fields: ``source_line`` (the 1-based line of the
offending element) and ``insertion_point_line`` (for an absence, the 1-based
line of the deepest element of the finding's path that the document HAS — where
the missing thing should go, not the site of an error). Both default to
``None``.
``validate_file`` raises :class:`einvoice.parser.NotWellFormed` on malformed
XML. Standard library only.
"""

from __future__ import annotations

import os
import re
import typing
import xml.etree.ElementTree as ET

from . import parser as _parser
from . import parser_cii as _parser_cii
from . import remediation as _remediation
from . import rules as _rules
from . import rules_xrechnung as _rules_xr
from .rules import Violation

#: Validation profiles. "en16931" = the EN 16931 core rules only;
#: "xrechnung" = core rules PLUS the German national CIUS layer (BR-DE-*).
PROFILES = ("en16931", "xrechnung")

#: The structural S-ROOT message for a generic (non-CII) unsupported root.
#: Text unchanged from the original single-message era; tests and goldens pin
#: it, so treat it as frozen.
S_ROOT_MESSAGE = (
    "Root element must be Invoice in the UBL Invoice-2 namespace, or "
    "CreditNote in the UBL CreditNote-2 namespace.")

#: Localname of the UN/CEFACT CII document root (Factur-X / ZUGFeRD /
#: XRechnung-CII). Matched WITHOUT the namespace, mirroring the dispatch the
#: PDF-container path has always used, so a CrossIndustryInvoice in a
#: wrong/blank namespace is graded by the CII engine (and fails on the real
#: mandatory-term rules) instead of being refused structurally.
CII_ROOT_LOCALNAME = "CrossIndustryInvoice"


def _severity(v):
    """Severity of a violation; core Violations carry none and are fatal."""
    return getattr(v, "severity", "fatal")


#: A path segment we are willing to walk: an optionally-prefixed XML name
#: (``cac:Party``, ``ram:SellerTradeParty``, ``BuyerReference``). Anything else
#: in a path — a predicate (``cac:InvoiceLine[2]``), a wildcard, an attribute
#: step, a function call, prose — makes the whole path UNWALKABLE and the
#: finding carries no insertion point. We never partially interpret a path we
#: do not fully understand.
_PATH_SEGMENT_RE = re.compile(r"^(?:[A-Za-z_][\w.\-]*:)?[A-Za-z_][\w.\-]*$")


def _segment_localname(segment):
    """Localname of a PATH segment, dropping its ``cac:``-style QName prefix.

    Note this is NOT :func:`einvoice.parser._localname`, which drops the
    ``{uri}`` ElementTree prepends to a parsed TAG. Finding paths are written
    with the conventional document prefixes (``cac:Party``) while the tree
    carries resolved namespace URIs (``{urn:…:CommonAggregateComponents-2}
    Party``), so the two sides need their own stripper and meet on the
    localname.
    """
    return segment.rsplit(":", 1)[-1]


def _insertion_point_line(root, path):
    """1-based line of the deepest element of ``path`` the document HAS.

    This is an INSERTION POINT, not an error site: for an absence finding
    (``cac:AccountingSupplierParty/cac:Party/cac:Contact`` on a document whose
    supplier party has no contact) it returns the line of the deepest ancestor
    that does exist — ``<cac:Party>`` — because that is the element the missing
    child would have to be inserted into. Nothing on that line is wrong.

    ``path`` may be ABSOLUTE (``/ubl:Invoice/cac:AccountingSupplierParty``, in
    which case the leading root segment must match ``root`` by localname) or
    RELATIVE to the root (``cac:AccountingSupplierParty/cac:Party/cac:Contact``,
    ``cbc:BuyerReference``). Segments are matched NAMESPACE-TOLERANTLY by
    localname, exactly as the rest of the engine dispatches (see
    :func:`einvoice.parser._localname`), because the finding paths are written
    with the conventional ``cac:``/``cbc:``/``ram:`` prefixes while the parsed
    tree carries resolved ``{uri}local`` tags.

    Returns ``None`` — carrying NOTHING rather than guessing — whenever:

    * the path is empty, unwalkable, or absolute with a non-matching root;
    * NO segment below the root resolves (``cbc:BuyerReference`` when that leaf
      is the only named segment and is absent; ``cac:Delivery/...`` when
      ``cac:Delivery`` itself is absent). The document root is never the
      answer: "insert it somewhere in the invoice" is not attribution;
    * the WHOLE path resolves — then the named element exists, the finding is
      not an absence, and a line for it would be an error site rather than an
      insertion point (that case is ``source_line``'s job);
    * a segment matches MORE THAN ONE child (e.g. ``cac:InvoiceLine/...`` on a
      multi-line invoice): which occurrence the finding meant is unknown, so
      the insertion point is ambiguous and is not emitted;
    * the resolved element carries no parser line stamp (a tree not produced by
      :mod:`einvoice._xmlsec`, e.g. one built in memory by a test).

    :param root: the parsed invoice root element.
    :param path: the finding's element path (or the catalog location hint).
    :returns: an int line, or ``None``.
    """
    if not path or not isinstance(path, str):
        return None
    raw = path.strip()
    if not raw:
        return None
    absolute = raw.startswith("/")
    if raw.startswith("//"):
        # A descendant-or-self step names no concrete parent chain.
        return None
    segments = [s for s in raw.split("/") if s]
    if not segments:
        return None
    if not all(_PATH_SEGMENT_RE.match(s) for s in segments):
        return None
    if absolute:
        if _segment_localname(segments[0]) != _parser._localname(root.tag):
            return None
        segments = segments[1:]
        if not segments:
            return None

    node = root
    depth = 0
    for segment in segments:
        want = _segment_localname(segment)
        matches = [child for child in node
                   if isinstance(child.tag, str)
                   and _parser._localname(child.tag) == want]
        if len(matches) > 1:
            # AMBIGUOUS: e.g. ``cac:TaxTotal/cac:TaxSubtotal/...`` on an invoice
            # with two VAT breakdowns, or any ``cac:InvoiceLine/...`` path on a
            # multi-line invoice. Which occurrence the finding meant is not
            # recoverable from the path, and pointing at the shared parent would
            # be a guess dressed up as attribution. Carry nothing.
            return None
        if not matches:
            # The absence we are anchoring: stop, and report the deepest
            # element that DID resolve (``node``).
            break
        node = matches[0]
        depth += 1
    else:
        # Every segment resolved: the named element EXISTS, so this is not an
        # absence and there is no insertion point to report.
        return None

    if depth == 0:
        # Nothing below the root resolved -> never fall back to the root.
        return None
    line = _parser._sourceline(node)
    # Belt and braces: only a real 1-based line is a position. An unstamped
    # element (None) or a degenerate 0 is silence, not attribution.
    if not isinstance(line, int) or isinstance(line, bool) or line < 1:
        return None
    return line


def _stamp_insertion_points(root, violations):
    """Return ``violations`` with :data:`insertion_point_line` filled in.

    THE single seam (see ``einvoice.rules.Violation``): both arms of
    :func:`validate_root` — the UBL model and the CII engine — pass through
    here, so the two syntaxes cannot drift into attributing absences
    differently. It is a post-pass rather than a rule change because the parsed
    tree and the finished finding list are only both in scope here; no rule
    constructor is touched.

    Per finding: a violation that already carries a ``source_line`` is returned
    UNCHANGED (the two fields are mutually exclusive — a finding never claims
    both an error site and an insertion point). Otherwise the finding's
    ``element`` path is resolved against ``root``; when ``element`` is empty the
    remediation catalog's ``location`` hint for the rule id is used instead.
    When nothing resolves, the violation is returned unchanged and the field
    stays ``None``.
    """
    catalog = None
    out = []
    for v in violations:
        if getattr(v, "source_line", None) is not None:
            out.append(v)
            continue
        path = getattr(v, "element", None)
        if not (path or "").strip():
            if catalog is None:
                catalog = _remediation.cached_catalog()
            path = _remediation.remediation_fields(
                getattr(v, "rule_id", None), catalog).get("location")
        line = _insertion_point_line(root, path)
        if line is None or not hasattr(v, "_replace"):
            out.append(v)
            continue
        out.append(v._replace(insertion_point_line=line))
    return out


class Result:
    """Outcome of validating one invoice.

    Attributes / properties:

    * ``valid`` (bool) — ``True`` iff the document carries no ``fatal``
      violation. This is the headline pass/fail flag; it follows the official
      Schematron ``flag`` semantics, so ``warning`` / ``information``
      violations (XRechnung profile) are reported but do NOT make ``valid``
      false. ``ok`` is a back-compat alias of ``valid``.
    * ``violations`` (list) — every finding, in evaluation order. Each item is
      an :class:`einvoice.rules.Violation` namedtuple with fields
      ``rule_id`` (e.g. ``"BR-02"``), ``message``, ``element``, ``severity``
      (``"fatal"`` / ``"warning"`` / ``"information"``) and the two optional,
      mutually exclusive position fields ``source_line`` (1-based line of the
      offending element) and ``insertion_point_line`` (1-based line of the
      deepest existing element of the finding's path — the insertion point for
      an absence, never an error site). Both are ``None`` when unknown.
    * ``first`` — the first violation, or ``None`` when the list is empty.

    ``to_dict(source=None)`` projects the result into the stable JSON record
    (keys ``valid`` and a ``violations`` list of
    ``{rule, message, element, severity, field, title, fix_hint, terms,
    location[, source_line | insertion_point_line]}`` dicts) used by the
    ``--json`` report. The four
    leading identity keys are frozen for backward compatibility; ``field`` is
    ``element`` under the report writer's name and the remaining four are
    relayed from the committed remediation catalog (see
    :meth:`_violation_dict`).
    """

    #: Every finding, in evaluation order (see the class docstring).
    violations: list[Violation]

    def __init__(self, violations: typing.Iterable[Violation]) -> None:
        self.violations = list(violations)

    @property
    def ok(self) -> bool:
        return not any(_severity(v) == "fatal" for v in self.violations)

    @property
    def valid(self) -> bool:
        """True iff there is no ``fatal`` violation (alias of :attr:`ok`)."""
        return self.ok

    @property
    def first(self) -> Violation | None:
        return self.violations[0] if self.violations else None

    def to_dict(self, source: str | None = None) -> dict:
        # The remediation catalog is resolved ONCE here and threaded into every
        # record, so projecting a 5000-violation batch costs one catalog lookup
        # setup, not one per finding.
        catalog = _remediation.cached_catalog()
        return {
            "source": source,
            "valid": self.ok,
            "violation_count": len(self.violations),
            "violations": [self._violation_dict(v, catalog)
                           for v in self.violations],
        }

    @staticmethod
    def _violation_dict(v, catalog=None):
        """Project one Violation into the --json record.

        The four identity keys (``rule``/``message``/``element``/``severity``)
        are unchanged in name, order and value — a consumer written against the
        original record keeps reading exactly what it read before.

        Five keys are ADDED, so the surface an ERP developer automates against
        (``einvoice validate --json``) finally carries the same actionable half
        the ``einvoice.report`` writer has always emitted:

        * ``field`` — the same datum as ``element`` under the report's name.
          Not a rename: both are present, always equal, so one consumer can
          read either surface with one code path.
        * ``title`` / ``fix_hint`` / ``terms`` / ``location`` — RELAYED from
          the committed remediation catalog through the shared
          :func:`einvoice.remediation.remediation_fields` helper that
          ``report._record`` also calls. Nothing here is authored locally, and
          there is no second catalog: one file, one loader, one cache.

        A rule id the catalog does not cover still emits all four, as
        ``None``/``[]`` — present-and-empty, never absent, so the record shape
        is unconditional. (``einvoice.remediation`` is imported directly rather
        than ``einvoice.report``: report imports THIS module, so relaying via
        it would be a circular import.)

        ``source_line`` (the optional 1-based parser line of the offending
        element) is still added ONLY when the violation actually carries one —
        an absence/document-level violation, or any finding without a proven
        element position, omits the key entirely, exactly as before.

        ``insertion_point_line`` is the same kind of optional, appended-last
        addition for the OTHER half of the findings: the 1-based line of the
        deepest element of the finding's path the document actually has — where
        the missing thing has to GO, not a place where something is wrong. It
        is never emitted together with ``source_line`` and never guesses (see
        :func:`_insertion_point_line`). Both keys come after every existing key,
        so a consumer byte-comparing the old record is unaffected.

        :param catalog: optional pre-loaded ``rule_id -> entry`` mapping;
            :meth:`to_dict` passes one for the whole result so a large batch
            resolves the catalog once rather than per violation.
        """
        rec = {"rule": v.rule_id, "message": v.message, "element": v.element,
               "severity": _severity(v), "field": v.element}
        rec.update(_remediation.remediation_fields(v.rule_id, catalog))
        source_line = getattr(v, "source_line", None)
        if source_line is not None:
            rec["source_line"] = source_line
        insertion_point_line = getattr(v, "insertion_point_line", None)
        if insertion_point_line is not None:
            rec["insertion_point_line"] = insertion_point_line
        return rec


def cii_violations(root: ET.Element, profile: str = "en16931") -> list:
    """Grade a parsed UN/CEFACT CII root and return its violations.

    THE single CII evaluation seam. Every shipped surface that grades a
    ``CrossIndustryInvoice`` — the raw-XML CLI (``validate`` /
    ``validate-batch``), ``einvoice.report.build_report``,
    ``einvoice.receipt.build_receipt``, the Factur-X/ZUGFeRD embedded-XML path
    in ``einvoice.report._report_from_invoice_bytes``, and the public
    ``einvoice.validate_bytes`` — reaches the CII engine through this one
    function, so those surfaces cannot drift into disagreeing verdicts again.
    (They did: until 0.2.7 the raw-XML surfaces answered a valid XRechnung-CII
    invoice with a structural ``S-ROOT`` fatal while the container path graded
    the identical bytes clean.)

    It re-implements NO rule logic: it feeds the CII model to the same
    syntax-agnostic core rules the UBL leg runs, plus the admitted CII BR-DE
    layer on the ``xrechnung`` profile.

    :param root: a parsed CII ``CrossIndustryInvoice`` element.
    :param profile: ``"en16931"`` (core only) or ``"xrechnung"`` (core plus
        the German ``BR-DE-*`` CIUS layer admitted for CII).
    :returns: the list of :class:`~einvoice.rules.Violation` that fired, in
        evaluation order.
    """
    inv = _parser_cii.build_model(root)
    violations = [v for v in (fn(inv) for fn in _rules.ALL_RULES)
                  if v is not None]
    if profile == "xrechnung":
        violations.extend(_rules_xr.evaluate_cii(inv))
    return violations


def validate_root(root: ET.Element, profile: str = "en16931") -> Result:
    """Run structural + business rules over a parsed invoice root.

    Dispatches on the root element, namespace-tolerantly by localname:

    * a UN/CEFACT ``CrossIndustryInvoice`` (Factur-X / ZUGFeRD / XRechnung-CII)
      is graded by the CII engine via :func:`cii_violations`;
    * a UBL ``Invoice`` / ``CreditNote`` runs the UBL model plus, on the
      ``xrechnung`` profile, ``rules_xrechnung.evaluate``;
    * anything else is the structural ``S-ROOT`` fatal (:data:`S_ROOT_MESSAGE`).

    :param root: a parsed invoice root element (an ``xml.etree`` Element),
        e.g. from ``einvoice.parser.parse_file(...)``.
    :param profile: ``"en16931"`` for the EN 16931 core rules only, or
        ``"xrechnung"`` to also apply the German CIUS layer (BR-DE-*).
        Any other value raises :class:`ValueError`.
    :returns: a :class:`Result` (``.valid`` flag + ``.violations`` list).
    """
    if profile not in PROFILES:
        raise ValueError("unknown profile: %r (choose from %s)"
                         % (profile, ", ".join(PROFILES)))

    # Layer S — structural. CII first: a CrossIndustryInvoice is a SUPPORTED
    # root, so it must never fall into the UBL model's S-ROOT arm.
    if _parser._localname(root.tag) == CII_ROOT_LOCALNAME:
        return Result(_stamp_insertion_points(
            root, cii_violations(root, profile)))

    violations = []
    inv = _parser.build_model(root)
    if not (inv.root_is_ubl_invoice or inv.is_creditnote):
        violations.append(
            Violation("S-ROOT", S_ROOT_MESSAGE, _parser._localname(root.tag)))
        # Without a supported root the business rules are meaningless.
        return Result(violations)

    # Layer S-XSD is deferred (no XSD validator in the standard library; see
    # SPEC section 6.5). Structural presence is exercised by the business rules.

    # Layer B — business rules (each pure, returns Violation or None).
    for rule in _rules.ALL_RULES:
        v = rule(inv)
        if v is not None:
            violations.append(v)

    # Layer C — national CIUS layer (XRechnung BR-DE-*), on top of the core.
    if profile == "xrechnung":
        violations.extend(_rules_xr.evaluate(root))

    # Layer P — post-pass: anchor the absence findings (see
    # :func:`_stamp_insertion_points`). Adds no finding, drops none, reorders
    # none; it only fills the optional ``insertion_point_line`` field.
    return Result(_stamp_insertion_points(root, violations))


def validate_file(
    path: str | os.PathLike[str] | typing.BinaryIO,
    profile: str = "en16931",
) -> Result:
    """Parse an invoice and validate it.

    Accepts either syntax of EN 16931 as raw XML: a UBL
    ``Invoice``/``CreditNote`` or a UN/CEFACT ``CrossIndustryInvoice``
    (ZUGFeRD / Factur-X / XRechnung-CII). The syntax is detected from the root
    element by :func:`validate_root`; a Factur-X/ZUGFeRD **PDF** container is a
    different input shape and goes through ``einvoice.report`` /
    :func:`einvoice.validate_bytes` instead.

    :param path: the invoice to read. Either a filesystem path (``str`` /
        ``os.PathLike``) or an already-open binary file-like object — anything
        with a ``read()`` method, e.g. ``io.BytesIO(payload_bytes)`` — so an
        invoice received in memory as bytes can be validated without a temp
        file.
    :param profile: ``"en16931"`` (core) or ``"xrechnung"`` (core + BR-DE-*);
        see :func:`validate_root`.
    :returns: a :class:`Result` (``.valid`` flag + ``.violations`` list).
    :raises einvoice.parser.NotWellFormed: if the input is not well-formed XML
        (this also folds in the hardened parser's XXE / resource-bound
        refusals), so a malformed payload is a single actionable exception
        rather than a traceback.
    """
    root = _parser.parse_file(path)
    return validate_root(root, profile=profile)
