"""Orchestration: parse -> structural checks -> business rules -> result.

Standard library only.
"""

from __future__ import annotations

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

    ``ok`` follows the official Schematron ``flag`` semantics: only ``fatal``
    violations make a document invalid; ``warning`` / ``information``
    violations (XRechnung profile) are reported but do not block.
    """

    def __init__(self, violations):
        self.violations = list(violations)

    @property
    def ok(self):
        return not any(_severity(v) == "fatal" for v in self.violations)

    @property
    def first(self):
        return self.violations[0] if self.violations else None

    def to_dict(self, source=None):
        return {
            "source": source,
            "valid": self.ok,
            "violation_count": len(self.violations),
            "violations": [
                {"rule": v.rule_id, "message": v.message, "element": v.element,
                 "severity": _severity(v)}
                for v in self.violations
            ],
        }


def validate_root(root, profile="en16931"):
    """Run structural + business rules over a parsed UBL Invoice root."""
    if profile not in PROFILES:
        raise ValueError("unknown profile: %r (choose from %s)"
                         % (profile, ", ".join(PROFILES)))
    violations = []

    # Layer S — structural.
    inv = _parser.build_model(root)
    if not inv.root_is_ubl_invoice:
        violations.append(Violation(
            "S-ROOT",
            "Root element must be Invoice in the UBL Invoice-2 namespace.",
            _parser._localname(root.tag)))
        # Without a UBL Invoice root the business rules are meaningless.
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


def validate_file(path, profile="en16931"):
    """Parse ``path`` and validate it. Raises NotWellFormed on parse error."""
    root = _parser.parse_file(path)
    return validate_root(root, profile=profile)
