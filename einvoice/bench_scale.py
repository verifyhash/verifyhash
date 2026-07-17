#!/usr/bin/env python3
"""Batch-scale measurement harness for the einvoice engine (T-VHPERF.1).

WHAT THIS IS
------------
A stdlib-only, report-only harness that synthesizes N valid invoices
(N in {1, 100, 1000}) for BOTH supported syntaxes — UBL ``Invoice`` and
UN/CEFACT CII ``CrossIndustryInvoice`` — in a tempdir, validates them
through the engine's real code paths, and prints a machine-readable JSON
summary of per-invoice wall-time at each N plus peak RSS. It asserts NO
absolute time or memory budget anywhere: the numbers feed T-VHPERF.2's
optimize-vs-drop decision, and the machine-independent scaling guard lives
in ``test_perf_scale.py`` (relative N=1000-vs-N=100 bound only).

THE THREE MEASURED SERIES (and why these code paths)
----------------------------------------------------
* ``ubl_single``  — :func:`einvoice.validate_file` per file: the stable
  public per-file API (rules only, no report projection).
* ``cii_single``  — ``einvoice.report._report_from_invoice_bytes`` per
  file: the engine's REAL CII path (``parser_cii.build_model`` +
  ``rules.ALL_RULES``), the exact shipped code a Factur-X/ZUGFeRD PDF
  exercises. HONEST LIMIT: the public per-file/report path does not
  natively dispatch a standalone CII *XML file* today (it short-circuits
  at the S-ROOT structural check in ~0.2 ms without running the CII rule
  engine), so timing it would measure nothing; this harness times the
  rule engine that actually validates CII content.
* ``batch``       — :func:`einvoice.validate_batch` (the stable public
  batch entry point from T-VHEMBED.1) over an interleaved UBL+CII file
  list (N/2 each). Composition note: per-file batch cost is dominated by
  the UBL report path's syntax-binding section (~75-80 ms/invoice —
  ``syntax_binding_eval.evaluate`` re-partitions and re-matches the
  ~740-entry CEN catalog per document), while an interleaved CII XML file
  short-circuits at S-ROOT (~1 ms), so the mixed per-invoice number is
  roughly the average of the two.

Fixture synthesis adapts the committed valid synthetic corpus invoices
(``corpus/synthetic/synth-{ubl,cii}-good-multiline.xml``) — each of the N
copies gets a unique document ID so files are distinct; amounts stay
untouched so arithmetic (VAT breakdown) validity is preserved. Profile is
``en16931`` (the fixtures are EN 16931 core-valid, not XRechnung-CIUS).
One warm-up validation per path runs before any timing so one-time
import/catalog-load cost cannot skew N=1. Peak RSS is read from
``resource.getrusage(RUSAGE_SELF).ru_maxrss`` (KiB on Linux) — REPORTED
only, never asserted.

MEASURED PICTURE (this box, Linux 5.15, Python 3.10, 2026-07-17)
----------------------------------------------------------------
per-invoice wall-time (median where reps > 1):

    series       N=1        N=100      N=1000     N=1000/N=100
    ubl_single   1.77 ms    1.64 ms    1.65 ms    1.01x
    cii_single   2.29 ms    2.47 ms    2.31 ms    0.93x
    batch        76.6 ms*   40.4 ms    40.7 ms    1.01x

    (*) the N=1 batch is a single UBL file through the full batch/report
        path (~77 ms); at N>=100 the interleaved batch per-invoice cost
        ~= avg(UBL report path ~79 ms, CII S-ROOT short-circuit ~1 ms).

LINEARITY VERDICT: linear. All three series hold per-invoice cost flat
from N=100 to N=1000 (ratios 0.93-1.01x) — no O(n^2) growth, no per-file
re-parse amplification with batch size. The interesting cost is the
CONSTANT: the batch/report path spends ~48x more per UBL invoice than
bare validate_file (79 ms vs 1.65 ms), almost entirely in the
per-document syntax-binding catalog evaluation — that constant, not
scaling, is T-VHPERF.2's real target. Peak RSS for the full 1+100+1000
run (both syntaxes + batch): ru_maxrss 29192 KiB (~28.5 MiB).

Usage:  python3 bench_scale.py          (exits 0; prints one JSON object)
"""

from __future__ import annotations

import json
import os
import resource
import statistics
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice  # noqa: E402
from einvoice import report as _report  # noqa: E402  (real CII engine path)

UBL_TEMPLATE = os.path.join(HERE, "corpus", "synthetic",
                            "synth-ubl-good-multiline.xml")
CII_TEMPLATE = os.path.join(HERE, "corpus", "synthetic",
                            "synth-cii-good-multiline.xml")
UBL_ID = "SYNTH-UBL-2024-0001"   # unique doc-ID marker in the UBL template
CII_ID = "SYNTH-CII-2024-0006"   # unique doc-ID marker in the CII template
PROFILE = "en16931"
SIZES = (1, 100, 1000)


def synth_corpus(tmpdir, n):
    """Write ``n`` distinct valid invoices per syntax; return {syntax: paths}.

    Adapts the committed valid synthetic fixtures: each copy substitutes a
    unique document ID (invoice number), leaving every amount untouched so
    the arithmetic VAT-breakdown validity of the template is preserved.
    """
    out = {"ubl": [], "cii": []}
    for syntax, template, marker in (("ubl", UBL_TEMPLATE, UBL_ID),
                                     ("cii", CII_TEMPLATE, CII_ID)):
        with open(template, encoding="utf-8") as fh:
            body = fh.read()
        if marker not in body:
            raise RuntimeError("template %s lost its ID marker %r"
                               % (template, marker))
        for i in range(n):
            variant = body.replace(marker,
                                   "BENCH-%s-%06d" % (syntax.upper(), i))
            path = os.path.join(tmpdir, "bench-%s-%06d.xml" % (syntax, i))
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(variant)
            out[syntax].append(path)
    return out


def validate_ubl_single(paths):
    """Per-file single path, UBL: the stable public einvoice.validate_file."""
    for p in paths:
        einvoice.validate_file(p, profile=PROFILE)


def validate_cii_single(paths):
    """Per-file single path, CII: the engine's real CII rule path.

    ``_report_from_invoice_bytes`` is the shipped dispatcher that runs
    ``parser_cii.build_model`` + ``rules.ALL_RULES`` on a CrossIndustryInvoice
    root (the Factur-X embedded-XML route). File read is inside the timed
    region, matching what validate_file's I/O costs on the UBL side.
    """
    for p in paths:
        with open(p, "rb") as fh:
            _report._report_from_invoice_bytes(fh.read(), p, PROFILE)


def interleave(corpus, n):
    """First ``n`` of [ubl0, cii0, ubl1, cii1, ...] — the mixed batch input."""
    mixed = []
    for u, c in zip(corpus["ubl"], corpus["cii"]):
        mixed.append(u)
        mixed.append(c)
    return mixed[:n]


def validate_batch(paths):
    """Batch report path: the stable public einvoice.validate_batch."""
    batch = einvoice.validate_batch(paths, profile=PROFILE)
    if batch.get("file_count") != len(paths):
        raise RuntimeError("batch validated %r files, expected %d"
                           % (batch.get("file_count"), len(paths)))
    return batch


def _sanity_check(corpus):
    """Fail loudly if the synthesized workload is not genuinely valid.

    A timing number over accidentally-invalid invoices (early rule
    short-circuits) would mislead T-VHPERF.2, so verify one synthesized
    file per syntax really passes its engine before measuring. This is a
    workload-correctness check, NOT a performance assertion.
    """
    r = einvoice.validate_file(corpus["ubl"][0], profile=PROFILE)
    if not r.valid:
        raise RuntimeError("synthesized UBL invoice is not valid: %r"
                           % [v.rule for v in r.violations])
    with open(corpus["cii"][0], "rb") as fh:
        rep = _report._report_from_invoice_bytes(
            fh.read(), corpus["cii"][0], PROFILE)
    if not rep.get("valid"):
        raise RuntimeError("synthesized CII invoice is not valid: %r"
                           % [v.get("rule") for v in rep.get("violations", [])])


def measure(fn, paths, reps):
    """Median-of-``reps`` total wall-time for ``fn(paths)``, as a dict.

    Median over repetitions makes small-N numbers tolerant of scheduler
    noise on a loaded box; per-invoice cost is total / len(paths).
    """
    totals = []
    for _ in range(reps):
        t0 = time.perf_counter()
        fn(paths)
        totals.append(time.perf_counter() - t0)
    total_ms = statistics.median(totals) * 1000.0
    return {
        "n": len(paths),
        "reps": reps,
        "total_ms": round(total_ms, 3),
        "per_invoice_ms": round(total_ms / len(paths), 4),
    }


def default_reps(n):
    """More repetitions at small N (noise-prone), one pass at N=1000."""
    if n <= 1:
        return 7
    if n <= 100:
        return 3
    return 1


def run(sizes=SIZES, reps_for=default_reps):
    """Measure all three series at each size; return the full summary dict."""
    results = {"ubl_single": {}, "cii_single": {}, "batch": {}}
    with tempfile.TemporaryDirectory(prefix="einvoice-bench-") as tmpdir:
        corpus = synth_corpus(tmpdir, max(sizes))
        _sanity_check(corpus)
        # Warm-up: one validation through EVERY timed path so one-time
        # import/catalog/remediation-load cost cannot skew the N=1 numbers.
        validate_ubl_single(corpus["ubl"][:1])
        validate_cii_single(corpus["cii"][:1])
        validate_batch(interleave(corpus, 2))
        for n in sizes:
            reps = reps_for(n)
            results["ubl_single"][str(n)] = measure(
                validate_ubl_single, corpus["ubl"][:n], reps)
            results["cii_single"][str(n)] = measure(
                validate_cii_single, corpus["cii"][:n], reps)
            results["batch"][str(n)] = measure(
                validate_batch, interleave(corpus, n), reps)

    lo, hi = str(min(sizes)), str(max(sizes))
    scaling = {
        name: round(series[hi]["per_invoice_ms"]
                    / series[lo]["per_invoice_ms"], 3)
        for name, series in results.items()
    }
    return {
        "schema": "einvoice-bench-scale/v1",
        "profile": PROFILE,
        "sizes": list(sizes),
        "series": results,
        "per_invoice_ratio_max_vs_min_n": scaling,
        "peak_rss_ru_maxrss_kib": resource.getrusage(
            resource.RUSAGE_SELF).ru_maxrss,
        "note": ("report-only harness: no absolute time/RSS assertion; "
                 "the relative scaling guard is test_perf_scale.py"),
    }


def main():
    summary = run()
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
