#!/usr/bin/env bash
# einvoice-deploy.sh — scoped redeploy of the committed einvoice/www/ tree
# into the live webroot's einvoice/ subdirectory.
#
# SUPERVISOR-ONLY. Requires sudo. The loop/engine NEVER executes this script —
# it is a committed, reviewed runbook artifact with the same standing as
# REPUBLISH-PYPI.md documenting `twine upload`: versioned instructions the
# human supervisor runs by hand at a run boundary.
#
# WHY THIS SCRIPT EXISTS (see /home/loopdev/loop2/state/OWNER-GOLIVE.md Step 3):
# the einvoice site is NOT part of the main verifyhash-deploy / site-release.js
# pipeline. Running the sudo-allowlisted `verifyhash-deploy` would rsync
# --delete from public/ (which contains no einvoice tree) into the webroot and
# DELETE the entire live /einvoice/ surface. The correct einvoice deploy is
# this scoped rsync of the committed einvoice/www/ into the webroot's
# einvoice/ subdir — never into the webroot root.
#
# Sequence (exactly the OWNER-GOLIVE.md Step 3 deploy-mechanics block):
#   1) timestamped `cp -a` backup of the live einvoice tree to
#      /var/www/verifyhash.com/einvoice-backup-<UTC ts>  (OUTSIDE the webroot)
#   2) rsync -ai --delete --dry-run  (output shown; interactive confirm)
#   3) the real rsync with the same flags
#   4) chown -R www-data:www-data of the deployed einvoice/ subdir
#   5) python3 verify_live.py from the repo einvoice dir — must print PASS,
#      otherwise this script exits nonzero.
#
# Usage:
#   bash einvoice/tools/einvoice-deploy.sh [--exclude-validate]
#
#   --exclude-validate  LEGACY option only. Adds --exclude 'validate/' to both
#                       rsyncs, reproducing the pre-44f26a8 behavior from when
#                       www/validate/ did not exist in the committed tree.
#                       The DEFAULT is NO exclude: www/validate/index.html is
#                       committed (44f26a8) and deploying it is the point of
#                       the next redeploy. Do not use this flag unless you are
#                       deliberately holding the in-browser validator back.

set -euo pipefail

# --- fixed paths (the committed source and the ONLY allowed rsync target) ---
SRC="/home/loopdev/verifyhash/einvoice/www/"          # committed tree (trailing / = contents)
DEST="/var/www/verifyhash.com/html/einvoice/"         # webroot's einvoice/ subdir — NEVER the webroot root
BACKUP="/var/www/verifyhash.com/einvoice-backup-$(date -u +%Y%m%dT%H%M%SZ)"  # outside the webroot
REPO_EINVOICE="/home/loopdev/verifyhash/einvoice"

# --- args ---
EXCLUDE_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --exclude-validate)
      EXCLUDE_ARGS=(--exclude 'validate/')
      echo "NOTE: legacy --exclude-validate active — validate/ will NOT be deployed." >&2
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--exclude-validate]" >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$SRC" ]; then
  echo "FATAL: committed source tree $SRC not found." >&2
  exit 1
fi

# --- 1) timestamped backup of the live tree, OUTSIDE the webroot ---
echo "== Step 1/5: backup live tree -> $BACKUP"
sudo cp -a "${DEST%/}" "$BACKUP"

# --- 2) dry-run rsync, output shown, explicit confirm before proceeding ---
echo "== Step 2/5: DRY-RUN (inspect for unexpected 'deleting' lines)"
sudo rsync -ai --delete ${EXCLUDE_ARGS[@]+"${EXCLUDE_ARGS[@]}"} --dry-run "$SRC" "$DEST"
printf 'Proceed with the REAL rsync into %s ? [y/N] ' "$DEST"
read -r reply
case "$reply" in
  y|Y|yes|YES) ;;
  *) echo "Aborted by operator; live tree untouched (backup kept at $BACKUP)."; exit 1 ;;
esac

# --- 3) the real rsync, same flags as the dry-run ---
echo "== Step 3/5: deploy"
sudo rsync -ai --delete ${EXCLUDE_ARGS[@]+"${EXCLUDE_ARGS[@]}"} "$SRC" "$DEST"

# --- 4) ownership of the deployed subdir ---
echo "== Step 4/5: chown"
sudo chown -R www-data:www-data "$DEST"

# --- 5) live verification: verify_live.py must print PASS ---
echo "== Step 5/5: verify_live.py (must print PASS)"
verify_rc=0
verify_output="$(cd "$REPO_EINVOICE" && python3 verify_live.py)" || verify_rc=$?
printf '%s\n' "$verify_output"
if [ "$verify_rc" -ne 0 ] || ! printf '%s\n' "$verify_output" | grep -q 'PASS'; then
  echo "FATAL: verify_live.py did not print PASS — live tree may not match committed www/." >&2
  echo "Backup of the pre-deploy tree is at: $BACKUP" >&2
  exit 1
fi

echo "DONE: einvoice deploy verified live (backup at $BACKUP — delete once satisfied)."
