#!/usr/bin/env python3
"""test_deploy_script.py — STATIC safety test for tools/einvoice-deploy.sh.

Reads the deploy script's SOURCE TEXT and never executes it (the script is
SUPERVISOR-ONLY and requires sudo; the loop/engine must never run it — same
standing as REPUBLISH-PYPI.md). What is asserted, each mapped to a real
failure mode:

  1. BACKUP FIRST: the `cp -a` backup command appears BEFORE any rsync
     carrying `--delete` — a --delete rsync with no prior backup is
     unrecoverable if the dry-run was misread.
  2. SOURCE PINNED: the one rsync source is exactly the committed
     /home/loopdev/verifyhash/einvoice/www/ tree (trailing slash), via the
     SRC variable — never a staging dir, never public/.
  3. TARGET SCOPED: every rsync target is the webroot's einvoice/ SUBDIR
     (/var/www/verifyhash.com/html/einvoice/), never the webroot root —
     rsync --delete into /var/www/verifyhash.com/html/ is the exact
     wipe-the-whole-site scenario OWNER-GOLIVE.md Step 3 warns about.
  4. DRY-RUN FIRST: a --dry-run rsync appears before the non-dry-run rsync,
     with an interactive confirm between them.
  5. VERIFIED LIVE: the script invokes verify_live.py, checks its output for
     PASS, and exits nonzero on failure.
  6. MARKED: the SUPERVISOR-ONLY header marker is present.
  7. SHARE CARD CARRIED (T-VHSHARE.4): the link-preview image every generated
     page advertises via og:image is a NON-HTML file at the root of the
     rsynced tree, and it is the one asset whose absence is invisible to a
     human spot-check of the deployed site — no page links to it, so a live
     tree missing it looks perfect in a browser while every LinkedIn/XING/
     Reddit unfurl of the announce renders a blank tile. The announce is
     one-shot, so this is asserted rather than eyeballed: the card must exist
     inside the pinned SRC tree, and NO exclude pattern in the script — the
     legacy --exclude-validate one included — may match it.

Standard library only. Runs offline. No subprocess, no sudo, no execution
of the script under test.
"""

import fnmatch
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "tools", "einvoice-deploy.sh")

sys.path.insert(0, HERE)
import gen_site as _gen  # noqa: E402

EXPECTED_SRC = "/home/loopdev/verifyhash/einvoice/www/"
WEBROOT_ROOT = "/var/www/verifyhash.com/html/"
EXPECTED_DEST = "/var/www/verifyhash.com/html/einvoice/"

FAILURES = []


def check(cond, name, detail=""):
    status = "ok" if cond else "FAIL"
    print("  [%s] %s%s" % (status, name, (" — " + detail) if (detail and not cond) else ""))
    if not cond:
        FAILURES.append(name)


def command_lines(text):
    """(line_no, stripped_line) for non-comment, non-empty script lines."""
    out = []
    for i, raw in enumerate(text.splitlines(), 1):
        s = raw.strip()
        if s and not s.startswith("#"):
            out.append((i, s))
    return out


def main():
    print("test_deploy_script.py — static analysis of %s" % os.path.relpath(SCRIPT, HERE))
    if not os.path.isfile(SCRIPT):
        print("FAIL: script not found at %s" % SCRIPT)
        return 1
    with open(SCRIPT, encoding="utf-8") as f:
        text = f.read()
    lines = command_lines(text)

    # --- classify the interesting command lines by position ------------------
    # an rsync INVOCATION is `rsync` followed by flags — not the word "rsync"
    # appearing in a prompt or message string
    rsync_lines = [(n, s) for n, s in lines if re.search(r"\brsync\s+-", s)]
    delete_rsyncs = [(n, s) for n, s in rsync_lines if "--delete" in s]
    dry_rsyncs = [(n, s) for n, s in rsync_lines if "--dry-run" in s]
    real_rsyncs = [(n, s) for n, s in rsync_lines if "--dry-run" not in s]
    backup_lines = [(n, s) for n, s in lines if re.search(r"\bcp\s+-a\b", s)]

    # (6) SUPERVISOR-ONLY header marker
    check("SUPERVISOR-ONLY" in text, "SUPERVISOR-ONLY marker present")
    check("set -euo pipefail" in text, "set -euo pipefail present")

    # sanity: the shapes we are about to reason over actually exist
    check(len(backup_lines) == 1, "exactly one cp -a backup command",
          "found %d" % len(backup_lines))
    check(len(rsync_lines) == 2, "exactly two rsync invocations (dry + real)",
          "found %d" % len(rsync_lines))
    check(len(dry_rsyncs) == 1, "exactly one --dry-run rsync",
          "found %d" % len(dry_rsyncs))
    check(len(real_rsyncs) == 1, "exactly one non-dry-run rsync",
          "found %d" % len(real_rsyncs))
    check(len(delete_rsyncs) == len(rsync_lines),
          "every rsync carries --delete (flags identical dry vs real)")

    # (1) backup precedes any --delete rsync
    if backup_lines and delete_rsyncs:
        check(backup_lines[0][0] < min(n for n, _ in delete_rsyncs),
              "cp -a backup appears BEFORE any --delete rsync",
              "backup at line %d, first --delete rsync at line %d"
              % (backup_lines[0][0], min(n for n, _ in delete_rsyncs)))
    # backup lands OUTSIDE the webroot, with a timestamp marker
    check("einvoice-backup-" in text, "timestamped einvoice-backup- name present")
    m = re.search(r'BACKUP="([^"$]*)einvoice-backup-', text)
    check(m is not None and m.group(1) == "/var/www/verifyhash.com/",
          "backup destination is /var/www/verifyhash.com/ (outside the webroot html/)",
          "BACKUP prefix resolved to %r" % (m.group(1) if m else None))

    # (2) rsync source is exactly the committed einvoice/www/ tree
    m = re.search(r'^SRC="([^"]*)"', text, re.M)
    check(m is not None and m.group(1) == EXPECTED_SRC,
          "SRC pinned to the committed %s" % EXPECTED_SRC,
          "SRC=%r" % (m.group(1) if m else None))
    for n, s in rsync_lines:
        check('"$SRC" "$DEST"' in s,
              'rsync line %d uses "$SRC" "$DEST" (pinned source and target)' % n, s)

    # (3) every rsync target is the webroot's einvoice/ SUBDIR, never the root
    m = re.search(r'^DEST="([^"]*)"', text, re.M)
    check(m is not None and m.group(1) == EXPECTED_DEST,
          "DEST pinned to the webroot einvoice/ subdir %s" % EXPECTED_DEST,
          "DEST=%r" % (m.group(1) if m else None))
    # the wipe scenario: the webroot root path must never appear except as the
    # einvoice/-suffixed DEST (i.e. every occurrence is followed by 'einvoice')
    bare_root = [i for i in range(len(text))
                 if text.startswith(WEBROOT_ROOT, i)
                 and not text.startswith(WEBROOT_ROOT + "einvoice", i)]
    check(not bare_root,
          "webroot root %s never referenced except via its einvoice/ subdir" % WEBROOT_ROOT,
          "bare webroot-root reference at char offset(s) %s" % bare_root)

    # (4) dry-run precedes the real rsync, with a confirm prompt between them
    if dry_rsyncs and real_rsyncs:
        dn, rn = dry_rsyncs[0][0], real_rsyncs[0][0]
        check(dn < rn, "--dry-run rsync (line %d) precedes real rsync (line %d)" % (dn, rn))
        between = [s for n, s in lines if dn < n < rn]
        check(any(re.search(r"\bread\s+-r\b", s) for s in between),
              "interactive confirm (read -r) sits between dry-run and real rsync")

    # (5) verify_live.py invoked, PASS checked, nonzero exit on failure
    check("verify_live.py" in text, "verify_live.py is invoked")
    check(re.search(r"grep -q .PASS.", text) is not None,
          "output is checked for PASS")
    # the PASS check must be able to exit nonzero: an exit 1 inside the
    # failure branch that follows the grep
    m = re.search(r"grep -q .PASS.[^\0]*?exit 1", text)
    check(m is not None, "PASS-check failure branch exits nonzero (exit 1)")

    # default deploys validate/: no unconditional --exclude on the rsync lines;
    # the exclude may exist ONLY behind the --exclude-validate flag
    for n, s in rsync_lines:
        check("--exclude " not in s.replace("EXCLUDE_ARGS", ""),
              "rsync line %d has no hardcoded --exclude (default deploys validate/)" % n, s)
    check("--exclude-validate" in text, "optional --exclude-validate flag documented")

    # --- (7) the share card rides along with the deploy ---------------------
    # The filename is READ from the generator (gen_site.CARD_FILENAME), never
    # typed here, so renaming the card cannot leave this test guarding a name
    # nothing emits any more.
    card = _gen.CARD_FILENAME
    card_src = os.path.join(HERE, "www", card)
    check(os.path.isfile(card_src),
          "share card www/%s exists inside the pinned SRC tree" % card,
          "expected the og:image target at %s — the pages advertise a URL "
          "the rsync would have nothing to copy for" % card_src)
    # It must sit at the ROOT of www/, because SRC is www/ and the live URL
    # the pages emit is BASE_URL + "/" + CARD_FILENAME with no intermediate
    # directory; a card nested one level down would deploy to a path nothing
    # references.
    check(os.path.dirname(os.path.relpath(card_src, os.path.join(HERE, "www")))
          == "",
          "share card sits at the root of www/ (matches the advertised "
          "BASE_URL/%s)" % card)
    # No exclude pattern may swallow it. Every --exclude value in the script —
    # whether hardcoded on an rsync line or parked in EXCLUDE_ARGS behind the
    # legacy flag — is fnmatch'd against the card's name and its live path.
    excludes = re.findall(r"--exclude\s+'([^']*)'", text)
    excludes += re.findall(r'--exclude\s+"([^"]*)"', text)
    check(bool(excludes) or "--exclude" not in text,
          "every --exclude in the script is a parseable quoted pattern",
          "found an --exclude whose value this test could not read; it must "
          "be quoted so the card-safety check below can see it")
    swallowed = [pat for pat in excludes
                 if fnmatch.fnmatch(card, pat.rstrip("/"))
                 or fnmatch.fnmatch("/" + card, pat.rstrip("/"))]
    check(not swallowed,
          "no --exclude pattern in the script drops the share card %s" % card,
          "pattern(s) %s would exclude the og:image asset from the deploy, "
          "so every social unfurl of the announce would render a blank tile"
          % swallowed)

    if FAILURES:
        print("FAIL: %d assertion(s) failed: %s" % (len(FAILURES), "; ".join(FAILURES)))
        return 1
    print("PASS: tools/einvoice-deploy.sh static safety checks all hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
