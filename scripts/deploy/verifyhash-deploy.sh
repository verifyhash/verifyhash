#!/usr/bin/env bash
# verifyhash-deploy — the ONLY sudo-permitted publish path for verifyhash.com.
#
# WHAT IT DOES (runbook docs/DEPLOY-PUBLIC-SITE.md §3a, codified):
#   verify the staged release against its own RELEASE-MANIFEST.json -> back up the live webroot ->
#   rsync --delete the release into the webroot -> chown www-data -> re-verify the webroot per-file.
#   Exits non-zero (and touches nothing / leaves the backup) on ANY mismatch.
#
# SECURITY MODEL — read before installing:
#   * Install ROOT-OWNED at /usr/local/bin/verifyhash-deploy (0755). The copy in the repo is the
#     REFERENCE ONLY: the autonomous loop can edit the repo, but it can NOT edit the installed copy,
#     so what sudo runs is always the version a human installed.
#   * Takes NO arguments and hardcodes SRC/WEBROOT — there is nothing to inject or redirect.
#   * Refuses symlinks anywhere in the release (nothing can point outside the staged tree).
#   * The sudoers grant is exactly one line, for exactly this file (see INSTALL below).
#   * The loop ENGINE never calls this. Only the supervising session does, at park points.
#
# INSTALL (one-time, human):
#   sudo install -o root -g root -m 755 /home/loopdev/verifyhash/scripts/deploy/verifyhash-deploy.sh /usr/local/bin/verifyhash-deploy
#   echo 'loopdev ALL=(root) NOPASSWD: /usr/local/bin/verifyhash-deploy' | sudo tee /etc/sudoers.d/verifyhash-deploy
#   sudo chmod 440 /etc/sudoers.d/verifyhash-deploy
#
# USE (supervisor, at a park point):
#   node scripts/site-release.js && node scripts/site-release.js --check   # assemble + gate (as loopdev)
#   sudo -n /usr/local/bin/verifyhash-deploy                               # publish (this script)
#   node scripts/site-release.js --mark-deployed                           # record what went live (as loopdev)
set -euo pipefail

SRC="/home/loopdev/verifyhash/public"
WEBROOT="/var/www/verifyhash.com/html"
MANIFEST="RELEASE-MANIFEST.json"

[ "$#" -eq 0 ] || { echo "verifyhash-deploy: takes no arguments" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "verifyhash-deploy: run via sudo" >&2; exit 2; }
[ -d "$SRC" ] || { echo "verifyhash-deploy: missing staging dir $SRC" >&2; exit 1; }
[ -f "$SRC/$MANIFEST" ] || { echo "verifyhash-deploy: no $MANIFEST in staging — run: node scripts/site-release.js" >&2; exit 1; }
[ -d "$WEBROOT" ] || { echo "verifyhash-deploy: missing webroot $WEBROOT" >&2; exit 1; }

if find "$SRC" -type l | grep -q .; then
  echo "verifyhash-deploy: symlink(s) found in staging — refusing" >&2
  find "$SRC" -type l >&2
  exit 1
fi

# Per-file sha256 verify of a tree against the manifest INSIDE it (same check as runbook §3a step 5).
verify_tree() {
  ( cd "$1" && node -e '
    const fs=require("fs"),c=require("crypto");
    const m=JSON.parse(fs.readFileSync("RELEASE-MANIFEST.json","utf8"));let bad=0;
    for(const f of m.files){
      let h; try{h=c.createHash("sha256").update(fs.readFileSync(f.path)).digest("hex");}catch(e){h="(unreadable)";}
      if(h!==f.sha256){bad++;console.error("MISMATCH "+f.path);}
    }
    console.log((bad?"BROKEN":"verified")+": "+(m.files.length-bad)+"/"+m.files.length+" files match RELEASE-MANIFEST.json");
    process.exit(bad?1:0);' )
}

echo "verifyhash-deploy: verifying STAGED release at $SRC ..."
verify_tree "$SRC" || { echo "verifyhash-deploy: staging does not match its manifest — NOT deploying" >&2; exit 1; }

BACKUP="/var/www/verifyhash.com/html.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$WEBROOT" "$BACKUP"
echo "verifyhash-deploy: old site backed up to $BACKUP"

rsync -a --delete "$SRC"/ "$WEBROOT"/
chown -R www-data:www-data "$WEBROOT"

echo "verifyhash-deploy: verifying UPLOADED webroot at $WEBROOT ..."
verify_tree "$WEBROOT" || { echo "verifyhash-deploy: UPLOAD BROKEN — restore from $BACKUP" >&2; exit 1; }

echo "verifyhash-deploy: DEPLOYED. Now record it (as loopdev): node scripts/site-release.js --mark-deployed"
