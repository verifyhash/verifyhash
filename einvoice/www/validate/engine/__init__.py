"""einvoice — first-slice XRechnung / EN 16931 UBL Invoice validator.

Standard library only. See SPEC.md for scope and API.md for the stable
embedding contract.

Supported public API (the names in :data:`__all__`, back-compat within a
report ``schemaVersion``):

    * :mod:`einvoice.validate` — the validation orchestration module.
    * :func:`einvoice.validate_file` — validate a path or binary bytes buffer.
    * :func:`einvoice.validate_root` — validate an already-parsed UBL root.
    * :class:`einvoice.Result` — the validation outcome (``.valid`` +
      ``.violations``).
    * :class:`einvoice.NotWellFormed` — raised on malformed XML input.
    * :func:`einvoice.validate_batch` — validate a list of invoice files and
      get the aggregate batch report dict (the ``validate-batch`` engine).
    * :func:`einvoice.fails_at` — the CLI ``--fail-on`` severity-threshold
      predicate over a :class:`Result`.
    * :func:`einvoice.capabilities` — what THIS build contains, as a dict
      (the ``einvoice info --json`` payload).
    * :func:`einvoice.validate_bytes` — validate raw invoice bytes (UBL,
      UN/CEFACT CII, or a Factur-X/ZUGFeRD PDF container) and get the
      machine-readable report dict; the public entry the CII conformance
      headline reproduces through.

Everything else (``parser``, ``rules``, ``rules_xrechnung``, ``codelists``,
``report`` and friends) stays importable but is internal and may change
without notice.
"""

from __future__ import annotations

import os as _os
import typing as _typing

from . import validate  # noqa: F401  (submodule kept importable; see API.md)
from .validate import validate_file, validate_root, Result  # noqa: F401
from .parser import NotWellFormed  # noqa: F401

#: Kept in lock-step with ``pyproject.toml`` (test_packaging.py enforces it).
__version__ = "0.2.8"

#: The supported, back-compat public API. Exactly these nine names are the
#: embedding contract documented in API.md; ``test_api_example.py`` guards it.
__all__ = ["validate", "validate_file", "validate_root", "Result",
           "NotWellFormed", "validate_batch", "fails_at", "capabilities",
           "validate_bytes"]


def validate_batch(
    paths: _typing.Iterable[str | _os.PathLike[str]],
    profile: str = "xrechnung",
) -> dict:
    """Validate every file in ``paths`` and return the aggregate batch report.

    Thin, stable wrapper around the SAME batch engine the
    ``einvoice validate-batch`` CLI drives
    (:func:`einvoice.report.build_batch_report_from_files`) — it adds no rule
    logic and changes no verdict. Each entry in the returned dict's ``files``
    array is the plain single-file report, byte-identical to validating that
    file on its own; files are validated in the order given (pass a sorted
    list for deterministic output). See API.md for the stable fields of the
    returned dict. An empty ``paths`` yields ``file_count == 0`` plus an
    explicit ``note`` — never an exception, never a fabricated pass.

    :param paths: iterable of invoice file paths (``str`` or path-like).
    :param profile: ``"xrechnung"`` (default) or ``"en16931"``.
    :returns: the aggregate batch dict (schema ``einvoice-conformance-batch/v1``).
    """
    # Lazy import: keeps ``import einvoice`` as light as before (measured —
    # cli/report only load when a batch is actually requested).
    from .report import build_batch_report_from_files
    return build_batch_report_from_files(
        [_os.fspath(p) for p in paths], profile=profile)


def fails_at(result: Result, level: str) -> bool:
    """True iff ``result`` trips the given severity threshold.

    The EXACT ``--fail-on`` semantics of the CLI, as a pure predicate: a
    :class:`Result` fails at ``level`` iff at least one of its violations has
    severity >= that level (``information`` < ``warning`` < ``fatal``). So
    ``fails_at(r, "fatal")`` is ``not r.valid`` (today's default exit rule),
    ``"warning"`` also trips on warnings, ``"information"`` on any finding at
    all. Delegates to the same threshold code the CLI exit path runs — the two
    can never disagree.

    :param result: a :class:`Result` from ``validate_file`` / ``validate_root``.
    :param level: ``"fatal"``, ``"warning"`` or ``"information"``.
    :returns: ``True`` when at least one finding crosses the threshold.
    :raises ValueError: on an unknown ``level`` (same accepted values as the
        CLI ``--fail-on`` flag; the message names the valid choices).
    """
    from .cli import FAIL_ON_LEVELS, EXIT_FAIL, _result_exit_code
    if level not in FAIL_ON_LEVELS:
        raise ValueError(
            "unknown fail-on level %r (choose from %s)"
            % (level, ", ".join(FAIL_ON_LEVELS)))
    return _result_exit_code(result, level) == EXIT_FAIL


def capabilities() -> dict:
    """What THIS build contains, as a plain dict.

    Returns exactly the payload ``einvoice info --json`` prints (same source:
    :func:`einvoice.cli._info_payload`): ``version``, ``profiles``,
    ``formats``, ``rule_count``, ``coverage`` and ``attestation_sha256``.
    Every value is read at runtime from the package or its committed
    artifacts, never retyped. In an installed-package context the repo-root
    artifacts (``coverage_matrix.json``, ``syntax_binding_catalog.json``, the
    top-level ``attestation.json``) are not on disk, so the artifact-sourced
    fields (``rule_count``, parts of ``coverage``, ``attestation_sha256``) fall
    back to the ``attestation.json`` shipped INSIDE the wheel and self-report
    the same real numbers a source checkout produces.

    :returns: dict with the six documented keys (JSON-serialisable).
    """
    from .cli import _info_payload
    return _info_payload()


def validate_bytes(
    data: bytes,
    filename: str | None = None,
    profile: str = "xrechnung",
) -> dict:
    """Validate raw invoice bytes and return the conformance report dict.

    The programmatic counterpart to :func:`build_report`, but for an in-memory
    buffer instead of a path — this is the PUBLIC entry point the CII
    test-suite conformance headline (39/39 ``*_uncefact.xml`` accepted) is
    reproduced through, so an adopter can verify that number themselves without
    reaching into a private helper.

    A thin, verdict-preserving wrapper over the already-hardened private
    :func:`einvoice.report._report_from_invoice_bytes`. It adds NO rule logic
    and NO new parsing: it only dispatches on the input shape and forwards the
    bytes.

    * **UBL** (``Invoice`` root) — routed through the same core engine
      :func:`validate_root` drives.
    * **UN/CEFACT CII** (``CrossIndustryInvoice`` root — Factur-X / ZUGFeRD /
      CII XRechnung) — routed through ``parser_cii.build_model`` +
      ``rules.ALL_RULES`` + (``profile="xrechnung"``) ``rules_xrechnung`` for
      the German CIUS layer, exactly as the golden-snapshot and PDF-container
      paths do.
    * **Factur-X / ZUGFeRD PDF container** (``%PDF-`` magic) — the embedded
      invoice XML is extracted zero-dependency via
      :mod:`einvoice.pdf_container` (the SAME extractor :func:`build_report`
      uses) and the FX-CONTAINER-* container-declaration findings are appended
      to the report. A container the zero-dep extractor cannot open
      (encryption, xref streams, no ``/EmbeddedFiles`` tree) folds into an
      explicit ``error="unsupported-container"`` non-pass report — never a
      false pass, never a traceback.

    Untrusted bytes are always parsed through the XXE/DTD/entity-hardened
    ``_safe_fromstring`` guard (see :mod:`einvoice._xmlsec`); a hostile or
    ill-formed payload folds into a ``valid=False`` ``not-well-formed`` report
    rather than raising or expanding.

    :param data: the raw invoice bytes (UBL XML, CII XML, or a Factur-X /
        ZUGFeRD PDF).
    :param filename: optional label recorded as the report's ``source`` (for
        diagnostics only — it never changes the verdict, and no filesystem
        access happens). Defaults to ``"<bytes>"``.
    :param profile: ``"xrechnung"`` (default; core rules plus the German
        ``BR-DE-*`` CIUS layer) or ``"en16931"`` (EN 16931 core rules only).
    :returns: the report dict — keys ``valid``, ``fatal_count``,
        ``warning_count``, ``violations`` (plus the other
        :data:`einvoice.report.REPORT_SCHEMA` fields), byte-for-byte the same
        shape :func:`build_report` returns for the same document.
    """
    # Lazy import: keeps a bare ``import einvoice`` as light as it was before
    # (report/pdf_container only load when a validation is actually requested).
    from . import pdf_container
    from .report import _report_from_invoice_bytes, _error_report
    source = filename if filename is not None else "<bytes>"
    if pdf_container.looks_like_pdf(data):
        try:
            inspection = pdf_container.inspect_container_from_bytes(data)
        except pdf_container.UnsupportedContainer as exc:
            detail = str(exc)
            if detail.startswith("unsupported container:"):
                detail = detail[len("unsupported container:"):].strip()
            return _error_report(
                source, profile, "unsupported-container",
                "unsupported container — could not extract embedded invoice "
                "XML: %s" % detail)
        return _report_from_invoice_bytes(
            inspection.xml_bytes, source, profile,
            container_findings=inspection.findings)
    return _report_from_invoice_bytes(data, source, profile)
