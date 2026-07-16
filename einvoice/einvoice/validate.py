"""Orchestration: parse -> structural checks -> business rules -> result.

This module is the validation entry point of the public API. It exposes the
two callables and the result type that embedders use:

    * :func:`validate_file` — validate a path (or a binary bytes buffer).
    * :func:`validate_root` — validate an already-parsed UBL Invoice root.
    * :class:`Result` — the outcome, carrying ``.valid`` and ``.violations``.

Both callables return a :class:`Result`. Each entry in ``Result.violations``
is an :class:`einvoice.rules.Violation` namedtuple with the fields
``rule_id``, ``message``, ``element``, ``severity`` and the optional
``source_line`` (the 1-based line of the offending element, or ``None``).
``validate_file`` raises :class:`einvoice.parser.NotWellFormed` on malformed
XML. Standard library only.
"""

from __future__ import annotations

import os
import typing
import xml.etree.ElementTree as ET

from . import parser as _parser
from . import rules as _rules
from . import rules_xrechnung as _rules_xr
from .rules import Violation

#: Validation profiles. "en16931" = the EN 16931 core rules only;
#: "xrechnung" = core rules PLUS the German national CIUS layer (BR-DE-*).
PROFILES = ("en16931", "xrechnung")


def _severity(v):
    """Severity of a violation; core Violations carry none and are fatal."""
    return getattr(v, "severity", "fatal")


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
      (``"fatal"`` / ``"warning"`` / ``"information"``) and the optional
      ``source_line`` (1-based line of the offending element, or ``None``).
    * ``first`` — the first violation, or ``None`` when the list is empty.

    ``to_dict(source=None)`` projects the result into the stable JSON record
    (keys ``valid`` and a ``violations`` list of
    ``{rule, message, element, severity[, source_line]}`` dicts) used by the
    ``--json`` report; the report format is unchanged by this class.
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
        return {
            "source": source,
            "valid": self.ok,
            "violation_count": len(self.violations),
            "violations": [self._violation_dict(v) for v in self.violations],
        }

    @staticmethod
    def _violation_dict(v):
        """Project one Violation into the --json record.

        The four identity keys are unchanged. ``source_line`` (the optional
        1-based parser line of the offending element) is added ONLY when the
        violation actually carries one — an absence/document-level violation, or
        any finding without a proven element position, omits the key entirely so
        existing consumers see a byte-identical record.
        """
        rec = {"rule": v.rule_id, "message": v.message, "element": v.element,
               "severity": _severity(v)}
        source_line = getattr(v, "source_line", None)
        if source_line is not None:
            rec["source_line"] = source_line
        return rec


def validate_root(root: ET.Element, profile: str = "en16931") -> Result:
    """Run structural + business rules over a parsed UBL Invoice root.

    :param root: a parsed UBL ``Invoice`` element (an ``xml.etree`` Element),
        e.g. from ``einvoice.parser.parse_file(...)``.
    :param profile: ``"en16931"`` for the EN 16931 core rules only, or
        ``"xrechnung"`` to also apply the German CIUS layer (BR-DE-*).
        Any other value raises :class:`ValueError`.
    :returns: a :class:`Result` (``.valid`` flag + ``.violations`` list).
    """
    if profile not in PROFILES:
        raise ValueError("unknown profile: %r (choose from %s)"
                         % (profile, ", ".join(PROFILES)))
    violations = []

    # Layer S — structural.
    inv = _parser.build_model(root)
    if not (inv.root_is_ubl_invoice or inv.is_creditnote):
        violations.append(Violation(
            "S-ROOT",
            "Root element must be Invoice in the UBL Invoice-2 namespace, or "
            "CreditNote in the UBL CreditNote-2 namespace.",
            _parser._localname(root.tag)))
        # Without a supported UBL root the business rules are meaningless.
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

    return Result(violations)


def validate_file(
    path: str | os.PathLike[str] | typing.BinaryIO,
    profile: str = "en16931",
) -> Result:
    """Parse an invoice and validate it.

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
