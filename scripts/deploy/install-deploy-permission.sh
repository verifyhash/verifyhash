#!/usr/bin/env bash
# install-deploy-permission — ONE-TIME human setup so the verifyhash supervisor can publish the site
# via the narrow, vetted `verifyhash-deploy` script (and nothing else).
#
# RUN IT AS ROOT:
#     sudo bash /home/loopdev/verifyhash/scripts/deploy/install-deploy-permission.sh
#
# It (1) installs the deploy script root-owned at /usr/local/bin/verifyhash-deploy, (2) grants the
# loopdev user NOPASSWD sudo for THAT ONE command only, and (3) VALIDATES the sudoers snippet with
# `visudo -c` before activating it — so a malformed rule can never break sudo on this box.
set -euo pipefail

REPO="/home/loopdev/verifyhash"
SRC_SCRIPT="$REPO/scripts/deploy/verifyhash-deploy.sh"
DEST="/usr/local/bin/verifyhash-deploy"
SUDOERS="/etc/sudoers.d/verifyhash-deploy"
GRANT_USER="loopdev"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run me as root:  sudo bash $0" >&2
  exit 1
fi

[ -f "$SRC_SCRIPT" ] || { echo "ERROR: missing $SRC_SCRIPT" >&2; exit 1; }

echo "1/3  Installing deploy script -> $DEST (root-owned, 0755)"
install -o root -g root -m 755 "$SRC_SCRIPT" "$DEST"

echo "2/3  Preparing sudoers grant (validated before activation)"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
printf '%s ALL=(root) NOPASSWD: %s\n' "$GRANT_USER" "$DEST" > "$TMP"
# Validate the snippet in isolation. If visudo rejects it, we abort WITHOUT touching /etc/sudoers.d.
if ! visudo -c -f "$TMP" >/dev/null; then
  echo "ERROR: sudoers snippet failed validation — NOT installing. sudo is untouched." >&2
  exit 1
fi
install -o root -g root -m 440 "$TMP" "$SUDOERS"

echo "3/3  Verifying the whole sudoers config still parses"
visudo -c >/dev/null

echo
echo "DONE. The verifyhash supervisor can now publish with:  sudo -n verifyhash-deploy"
echo "Quick check (should print a usage/verify line, not a password prompt):"
echo "    sudo -n /usr/local/bin/verifyhash-deploy </dev/null || true"
