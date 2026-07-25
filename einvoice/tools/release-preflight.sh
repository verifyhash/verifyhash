#!/usr/bin/env bash
# release-preflight.sh — prove a BUILT WHEEL is the fixed engine, from a clean
# venv, BEFORE the irreversible PyPI upload.
#
# SUPERVISOR-ONLY. The loop/engine NEVER executes this script — it is a
# committed, reviewed runbook artifact with exactly the same standing as
# REPUBLISH-PYPI.md documenting `python3 -m twine upload`, and as
# tools/einvoice-deploy.sh: versioned instructions the human supervisor runs by
# hand at a run boundary. test_release_preflight.py checks this file
# STATICALLY (bash -n + text assertions) and never runs it.
#
# WHY THIS SCRIPT EXISTS
# ---------------------------------------------------------------------------
# PyPI versions are IMMUTABLE (see REPUBLISH-PYPI.md). 0.2.6 went out broken —
# `--format sarif` crashed, `--explain` crashed, every violation came back with
# null title/fix_hint/location — and none of that was visible in the source
# tree: the source tests were green the whole time. The defects lived in the
# ARTIFACT (remediation_catalog.json sat outside the packages=["einvoice"] dir,
# so a `pip install` user got a validator that names a broken rule and hands
# them nothing to fix it with).
#
# Then it happened a second way. At commit 7c0a0d8 an in-tree `python3 -m build`
# over a stale `build/lib/einvoice/` packaged THREE old modules (validate.py,
# report.py, coverage.py). setuptools copies sources into build/lib and leaves
# whatever is already there, so the wheel was named correctly, imported fine and
# reported the right --version — and rejected a VALID raw CII invoice with the
# pre-CII-fix S-ROOT fatal, exit 1. Same commit, same declared version 0.2.7,
# two different validators.
#
# Every one of those defect classes is invisible from the repo and obvious from
# the installed wheel. So this script installs the wheel into a throwaway venv,
# steps OUT of the repo (cwd = a temp dir, PYTHONPATH unset — otherwise the
# checkout shadows site-packages and you are testing the source tree again), and
# asserts seven things about the artifact you are about to make permanent.
#
# Checks (each prints `PASS <n> <name>` or `FAIL <n> <name>`; first failure
# exits nonzero and names itself):
#   1 version-and-rule-count      `einvoice --version` == expected version and
#                                 `einvoice info` reports rule_count: 297
#   2 shipped-artifacts           remediation_catalog.json AND attestation.json
#                                 are both in the INSTALLED package dir
#   3 formats-and-explain         every --format the artifact itself declares
#                                 (list read from `einvoice info` at runtime,
#                                 never hard-coded) plus `--explain <rule id>`
#                                 run traceback-free with non-empty output
#   4 remediation-fields          a violating invoice yields non-null title,
#                                 fix_hint and location in the JSON report
#   5 report-module-help          `python3 -m einvoice.report --help` exits 0
#   6 help-pointer-is-url         `einvoice --help` points at a URL, and names
#                                 no *.md file the wheel does not ship
#   7 cii-valid-and-broken-twin   a VALID raw CII invoice exits 0 and its broken
#                                 twin exits 1 (the T-VHCII3.1 contract — this
#                                 is the check that catches the stale build)
#
# It NEVER publishes, uploads, pushes, sudo's, or touches the network: the only
# install is `pip install --no-index` of the local wheel you name. Fixtures are
# written INLINE into its own temp dir — it reads nothing from the repo except
# the default expected version out of einvoice/pyproject.toml.
#
# Usage:
#   bash einvoice/tools/release-preflight.sh <path-to-wheel> [expected-version]
#
#   <path-to-wheel>     e.g. dist/verifyhash_einvoice-0.2.7-py3-none-any.whl
#   [expected-version]  defaults to the [project] version in
#                       einvoice/pyproject.toml (do not hard-code a version
#                       here — it rots)
#
# Exit status: 0 = all seven checks pass, safe to upload as far as the artifact
# is concerned; 1 = a check failed (DO NOT upload); 2 = bad invocation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_EINVOICE="$(dirname "$SCRIPT_DIR")"
PYPROJECT="$REPO_EINVOICE/pyproject.toml"

usage() {
  cat <<'USAGE' >&2
Usage: release-preflight.sh <path-to-wheel> [expected-version]

  SUPERVISOR-ONLY. Installs the named wheel into a throwaway venv (offline,
  --no-index) and asserts the installed artifact is the fixed engine before an
  immutable PyPI upload. Run it between the build step and the upload step of
  REPUBLISH-PYPI.md.

  Example:
    bash tools/release-preflight.sh dist/verifyhash_einvoice-0.2.7-py3-none-any.whl
USAGE
}

# --- arguments -------------------------------------------------------------
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
  exit 2
fi
case "${1:-}" in
  -h|--help) usage; exit 2 ;;
esac

WHEEL_ARG="$1"
if [ ! -f "$WHEEL_ARG" ]; then
  echo "FATAL: no such wheel file: $WHEEL_ARG" >&2
  exit 2
fi
WHEEL="$(cd "$(dirname "$WHEEL_ARG")" && pwd)/$(basename "$WHEEL_ARG")"
case "$WHEEL" in
  *.whl) ;;
  *) echo "FATAL: not a wheel (*.whl): $WHEEL" >&2; exit 2 ;;
esac

EXPECTED_VERSION="${2:-}"
if [ -z "$EXPECTED_VERSION" ]; then
  if [ ! -f "$PYPROJECT" ]; then
    echo "FATAL: cannot read the default expected version: $PYPROJECT missing." >&2
    echo "       Pass the expected version explicitly as the second argument." >&2
    exit 2
  fi
  EXPECTED_VERSION="$(sed -n 's/^version *= *"\([^"]*\)".*/\1/p' "$PYPROJECT" | head -n 1)"
fi
if [ -z "$EXPECTED_VERSION" ]; then
  echo "FATAL: could not determine the expected version." >&2
  exit 2
fi

cat <<'BANNER'
===========================================================================
  release-preflight.sh — SUPERVISOR-ONLY WHEEL PREFLIGHT
  The loop never runs this. PyPI versions are IMMUTABLE: a red check here
  means DO NOT UPLOAD. Nothing below publishes, uploads or goes online.
===========================================================================
BANNER
echo "wheel            : $WHEEL"
echo "expected version : $EXPECTED_VERSION"
echo

# --- temp dirs (cleaned up on every exit path) -----------------------------
TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/vh-preflight-XXXXXX")"
trap 'rm -rf "$TMPROOT"' EXIT
VENV_DIR="$TMPROOT/venv"
WORK_DIR="$TMPROOT/work"
mkdir -p "$WORK_DIR"

# The whole point is to test the ARTIFACT, not the checkout: refuse to run the
# assertions from anywhere inside the repo, and take the repo off the import
# path entirely.
case "$WORK_DIR" in
  "$REPO_EINVOICE"*)
    echo "FATAL: work dir $WORK_DIR is inside the repo; refusing." >&2
    exit 2 ;;
esac
unset PYTHONPATH
export PYTHONNOUSERSITE=1

# --- check reporting -------------------------------------------------------
ok() {
  printf 'PASS %s %s\n' "$1" "$2"
}
fail() {
  printf 'FAIL %s %s\n' "$1" "$2"
  printf '\n' >&2
  printf 'FATAL: release-preflight FAILED at check %s (%s).\n' "$1" "$2" >&2
  printf '       %s\n' "${3:-no detail}" >&2
  printf 'DO NOT UPLOAD this wheel: the version would be spent on a bad artifact.\n' >&2
  exit 1
}

# --- install the wheel, and only the wheel, offline ------------------------
echo "== creating throwaway venv in $VENV_DIR"
python3 -m venv "$VENV_DIR"
PY="$VENV_DIR/bin/python3"
EI="$VENV_DIR/bin/einvoice"
echo "== installing ONLY the named wheel (offline: --no-index --no-deps)"
"$PY" -m pip install --quiet --no-index --no-deps --no-cache-dir \
  --disable-pip-version-check "$WHEEL"
if [ ! -x "$EI" ]; then
  echo "FATAL: the wheel did not install the 'einvoice' console script." >&2
  exit 1
fi
echo

cd "$WORK_DIR"
echo "== running checks from $WORK_DIR (cwd outside the repo, PYTHONPATH unset)"
echo

# --- inline fixtures (the script reads NO fixture from the repo) ------------
# GOOD: a minimal business-rule-clean raw CII (UN/CEFACT CrossIndustryInvoice)
# invoice — one line, 100.00 net + 19% VAT = 119.00. Verified to pass the
# en16931 profile with zero fatals. This is the shape the stale-build wheel
# false-failed with S-ROOT.
cat <<'CIIGOOD' > cii-good.xml
<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>PREFLIGHT-1</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">20260101</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>Widget</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>100.00</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="C62">1</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>S</ram:CategoryCode>
          <ram:RateApplicablePercent>19</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>100.00</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>Seller GmbH</ram:Name>
        <ram:PostalTradeAddress><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE123456789</ram:ID></ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>Buyer AG</ram:Name>
        <ram:PostalTradeAddress><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>30</ram:TypeCode></ram:SpecifiedTradeSettlementPaymentMeans>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>19.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>100.00</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>19</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradePaymentTerms><ram:DueDateDateTime><udt:DateTimeString format="102">20260131</udt:DateTimeString></ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>100.00</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>100.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">19.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>119.00</ram:GrandTotalAmount>
        <ram:DuePayableAmount>119.00</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
CIIGOOD

# BAD: the SAME document with exactly one element removed — BT-5
# (ram:InvoiceCurrencyCode) — which must fire BR-05. Derived from the good
# fixture so the pair can never drift apart.
grep -v 'ram:InvoiceCurrencyCode' cii-good.xml > cii-broken.xml || true
if cmp -s cii-good.xml cii-broken.xml; then
  echo "FATAL: broken twin is identical to the good fixture (BT-5 not removed)." >&2
  exit 1
fi

# ===========================================================================
# 1 version-and-rule-count
# ===========================================================================
rc=0
version_out="$("$EI" --version 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail 1 version-and-rule-count "einvoice --version exited $rc: $version_out"
fi
if ! printf '%s\n' "$version_out" | grep -qF "$EXPECTED_VERSION"; then
  fail 1 version-and-rule-count \
    "expected version $EXPECTED_VERSION, artifact reports: $version_out"
fi
rc=0
info_out="$("$EI" info 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail 1 version-and-rule-count "einvoice info exited $rc: $info_out"
fi
if ! printf '%s\n' "$info_out" | grep -qx 'rule_count: 297'; then
  fail 1 version-and-rule-count \
    "info did not report 'rule_count: 297' (a wheel that resolves its rule
       count from the source tree reports None — that was the T-VHPROOF.3
       defect). Got: $(printf '%s\n' "$info_out" | grep -F rule_count || true)"
fi
ok 1 version-and-rule-count

# ===========================================================================
# 2 shipped-artifacts
# ===========================================================================
rc=0
PKG_DIR="$("$PY" -c 'import einvoice, os; print(os.path.dirname(os.path.abspath(einvoice.__file__)))' 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail 2 shipped-artifacts "could not import einvoice from the venv: $PKG_DIR"
fi
case "$PKG_DIR" in
  "$VENV_DIR"/*) ;;
  *) fail 2 shipped-artifacts \
       "einvoice resolved to $PKG_DIR, which is OUTSIDE the throwaway venv —
       the checks would be testing a source tree, not the wheel." ;;
esac
for artifact in remediation_catalog.json attestation.json; do
  if [ ! -f "$PKG_DIR/$artifact" ]; then
    fail 2 shipped-artifacts \
      "$artifact is NOT in the installed package dir $PKG_DIR — this is exactly
       the 0.2.6 packaging slip (declare it in [tool.setuptools.package-data])."
  fi
done
ok 2 shipped-artifacts

# ===========================================================================
# 3 formats-and-explain
# ===========================================================================
# The format list comes from the ARTIFACT's own self-report, never from a list
# baked into this script: if the wheel declares a format it cannot render, that
# is the defect we are hunting.
FORMATS="$(printf '%s\n' "$info_out" | sed -n 's/^formats: *//p' | tr ',' ' ' | tr -s ' ')"
if [ -z "$FORMATS" ]; then
  fail 3 formats-and-explain "einvoice info declared no 'formats:' line"
fi
fmt_count=0
for fmt in $FORMATS; do
  fmt_count=$((fmt_count + 1))
done
if [ "$fmt_count" -ne 9 ]; then
  fail 3 formats-and-explain \
    "the artifact declares $fmt_count report formats; 0.2.7 declares 9
       ($FORMATS). A shrunken declared surface before an immutable upload is
       itself a stop sign — re-read it before overriding."
fi
for fmt in $FORMATS; do
  rc=0
  fmt_out="$("$PY" -m einvoice.report --format "$fmt" cii-broken.xml 2>&1)" || rc=$?
  # exit 1 == findings, which is the expected verdict for the broken twin;
  # anything above that is a crash.
  if [ "$rc" -gt 1 ]; then
    fail 3 formats-and-explain "--format $fmt exited $rc: $fmt_out"
  fi
  if printf '%s\n' "$fmt_out" | grep -q 'Traceback'; then
    fail 3 formats-and-explain "--format $fmt printed a traceback: $fmt_out"
  fi
  if [ -z "$(printf '%s' "$fmt_out" | tr -d '[:space:]')" ]; then
    fail 3 formats-and-explain "--format $fmt produced empty output"
  fi
done
echo "  (all $fmt_count declared formats rendered: $FORMATS)"
# The rule id for --explain is taken from the report the artifact just emitted,
# so it is always a rule this build can actually name. NOTE the two-step: the
# report exits 1 on findings (the expected verdict for the broken twin), and
# under `pipefail` a one-liner pipeline would inherit that 1.
rc=0
report_json="$("$PY" -m einvoice.report --format json cii-broken.xml 2>/dev/null)" || rc=$?
if [ "$rc" -gt 1 ]; then
  fail 3 formats-and-explain "the JSON report exited $rc"
fi
rc=0
explain_rule="$(printf '%s' "$report_json" \
  | "$PY" -c 'import json,sys; v=json.load(sys.stdin).get("violations") or [{}]; print(v[0].get("rule") or "")')" || rc=$?
if [ "$rc" -ne 0 ] || [ -z "$explain_rule" ]; then
  fail 3 formats-and-explain "could not read a rule id out of the JSON report"
fi
rc=0
explain_out="$("$EI" --explain "$explain_rule" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail 3 formats-and-explain "--explain $explain_rule exited $rc: $explain_out"
fi
if printf '%s\n' "$explain_out" | grep -q 'Traceback'; then
  fail 3 formats-and-explain "--explain $explain_rule printed a traceback"
fi
if ! printf '%s\n' "$explain_out" | grep -qF "$explain_rule"; then
  fail 3 formats-and-explain \
    "--explain $explain_rule did not echo the rule id (empty catalog lookup?)"
fi
echo "  (--explain $explain_rule answered from the packaged catalog)"
ok 3 formats-and-explain

# ===========================================================================
# 4 remediation-fields
# ===========================================================================
rc=0
"$PY" -m einvoice.report --format json cii-broken.xml > report.json 2>/dev/null || rc=$?
if [ "$rc" -gt 1 ]; then
  fail 4 remediation-fields "the JSON report exited $rc"
fi
rc=0
field_out="$("$PY" - report.json <<'PYFIELDS'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as fh:
    report = json.load(fh)
violations = report.get("violations") or []
if not violations:
    sys.exit("the broken twin produced NO violations (BT-5 removal must fire BR-05)")
missing = []
for v in violations:
    absent = [k for k in ("title", "fix_hint", "location") if not v.get(k)]
    if absent:
        missing.append("%s missing %s" % (v.get("rule"), "/".join(absent)))
if missing:
    sys.exit("hint-less violations (the 0.2.6 defect): " + "; ".join(missing))
print("%d violation(s), every one carrying title/fix_hint/location" % len(violations))
PYFIELDS
)" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail 4 remediation-fields "$field_out"
fi
echo "  ($field_out)"
ok 4 remediation-fields

# ===========================================================================
# 5 report-module-help
# ===========================================================================
rc=0
help_mod_out="$("$PY" -m einvoice.report --help 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail 5 report-module-help "python3 -m einvoice.report --help exited $rc: $help_mod_out"
fi
if [ -z "$(printf '%s' "$help_mod_out" | tr -d '[:space:]')" ]; then
  fail 5 report-module-help "python3 -m einvoice.report --help printed nothing"
fi
ok 5 report-module-help

# ===========================================================================
# 6 help-pointer-is-url
# ===========================================================================
rc=0
help_out="$("$EI" --help 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail 6 help-pointer-is-url "einvoice --help exited $rc: $help_out"
fi
if ! printf '%s\n' "$help_out" | grep -qE 'https?://[^[:space:]]+'; then
  fail 6 help-pointer-is-url \
    "--help names no http(s) documentation pointer — an installed wheel must
       point somewhere a stranger can actually reach."
fi
# A pointer at a document filename is only honest if the wheel ships it. Any
# *.md the help text names must exist in the installed package dir.
named_docs="$(printf '%s\n' "$help_out" | grep -oE '[A-Za-z0-9_.-]+\.md' | sort -u || true)"
for doc in $named_docs; do
  if [ ! -f "$PKG_DIR/$doc" ]; then
    fail 6 help-pointer-is-url \
      "--help points the user at '$doc', which the wheel does not ship
       (not present in $PKG_DIR) — a dead pointer in installed help."
  fi
done
echo "  (documentation pointer: $(printf '%s\n' "$help_out" | grep -oE 'https?://[^[:space:]]+' | head -n 1))"
ok 6 help-pointer-is-url

# ===========================================================================
# 7 cii-valid-and-broken-twin
# ===========================================================================
# The T-VHCII3.1 contract, and the one check that catches a stale build/lib:
# the wheel built at 7c0a0d8 answered this VALID invoice with an S-ROOT fatal.
rc=0
good_out="$("$EI" validate cii-good.xml 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail 7 cii-valid-and-broken-twin \
    "a VALID raw CII invoice exited $rc instead of 0 — if the output names
       S-ROOT this wheel carries the PRE-CII-FIX engine (stale build/lib: run
       'rm -rf build/ dist/ *.egg-info' and rebuild). Output: $good_out"
fi
if printf '%s\n' "$good_out" | grep -q 'S-ROOT'; then
  fail 7 cii-valid-and-broken-twin \
    "the valid CII invoice passed but the output still names S-ROOT: $good_out"
fi
if printf '%s\n' "$good_out" | grep -q 'Traceback'; then
  fail 7 cii-valid-and-broken-twin "validate printed a traceback: $good_out"
fi
rc=0
bad_out="$("$EI" validate cii-broken.xml 2>&1)" || rc=$?
if [ "$rc" -ne 1 ]; then
  fail 7 cii-valid-and-broken-twin \
    "the broken twin (BT-5 removed) exited $rc instead of 1: $bad_out"
fi
if printf '%s\n' "$bad_out" | grep -q 'S-ROOT'; then
  fail 7 cii-valid-and-broken-twin \
    "the broken twin failed on the structural S-ROOT refusal instead of the
       real business rule — the raw-CII dispatch is the pre-0.2.7 one:
       $bad_out"
fi
if printf '%s\n' "$bad_out" | grep -q 'Traceback'; then
  fail 7 cii-valid-and-broken-twin "validate printed a traceback: $bad_out"
fi
ok 7 cii-valid-and-broken-twin

echo
echo "==========================================================================="
echo "ALL 7 CHECKS PASSED for $(basename "$WHEEL") (version $EXPECTED_VERSION)."
echo "The installed artifact is the fixed engine. Nothing was uploaded or"
echo "published by this script — the upload step of REPUBLISH-PYPI.md is next,"
echo "and it is still yours to run by hand."
echo "==========================================================================="
