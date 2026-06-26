#!/usr/bin/env bash
# challenge/run.sh — VerifyHash 60-second cold-prospect challenge.
#
# WHAT THIS DOES (zero install — no `npm install`, no repo build, no account, no network):
#   1. VERIFIES a real, pre-sealed sample packet (challenge/sample-packet/) against its seal
#      (challenge/seal.vhevidence.json) using the committed, single-file standalone verifier.
#      A clean packet VERIFIES -> exit 0.
#   2. Tells you to tamper ONE byte (see TAMPER-ME.md) and run this again — the verifier then
#      RE-DERIVES the keccak Merkle root from the bytes YOU hold, REJECTS the packet (exit 3),
#      and POINTS at the exact file you changed. It never trusts the packet's own stored hashes.
#
# Requirements: just `node` (>=18) on PATH. The verifier is READ-ONLY and opens NO network.
# Exit codes are the verifier's own contract: 0 verified / 3 rejected (tamper found) / 2 usage / 1 IO.

set -euo pipefail

# Resolve this script's own directory so the challenge runs from anywhere (cwd-independent).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The committed, single-file, zero-dependency standalone verifier — referenced, NOT forked.
VERIFIER="$HERE/../verifier/dist/verify-vh-standalone.js"
SEAL="$HERE/seal.vhevidence.json"
PACKET="$HERE/sample-packet"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: this challenge needs 'node' (>=18) on your PATH. Install Node, then re-run ./run.sh" >&2
  exit 1
fi
if [ ! -f "$VERIFIER" ]; then
  echo "ERROR: standalone verifier not found at: $VERIFIER" >&2
  exit 1
fi

echo "=============================================================="
echo " VerifyHash challenge — verify a real sealed packet, offline"
echo "=============================================================="
echo
echo "Verifier : verifier/dist/verify-vh-standalone.js (single file, zero deps, read-only, offline)"
echo "Seal     : challenge/seal.vhevidence.json"
echo "Packet   : challenge/sample-packet/ (README.txt, ledger.csv, manifest.json)"
echo
echo "Running:  node verify-vh-standalone.js seal.vhevidence.json --dir sample-packet"
echo "--------------------------------------------------------------"

# Run the REAL standalone verifier. We do NOT use `set -e` to swallow its exit code: capture it so
# we can print a friendly summary AND propagate the verifier's own exit code unchanged.
set +e
node "$VERIFIER" "$SEAL" --dir "$PACKET"
code=$?
set -e

echo "--------------------------------------------------------------"
case "$code" in
  0)
    echo "RESULT: VERIFIED (exit 0). Every byte of the packet matches the seal."
    echo
    echo "Now TAMPER it: open challenge/TAMPER-ME.md and change ONE byte in"
    echo "challenge/sample-packet/ledger.csv, then run ./run.sh again."
    echo "The verifier will REJECT (exit 3) and name the file you changed."
    ;;
  3)
    echo "RESULT: REJECTED (exit 3). The packet no longer matches its seal."
    echo "The 'CHANGED' line above names the EXACT file whose bytes differ."
    echo
    echo "That is the whole point: tamper is detected and localized — offline,"
    echo "with no trust in the packet's own stored hashes. Restore the byte to"
    echo "make it VERIFY again (e.g. `git checkout challenge/sample-packet`)."
    ;;
  *)
    echo "RESULT: the verifier exited $code (2=usage, 1=IO). See the message above."
    ;;
esac

exit "$code"
