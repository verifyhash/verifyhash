#!/usr/bin/env python3
"""test_provenance_anchor.py — bind the published-package identity across the
four surfaces a skeptical evaluator independently cross-checks, so version /
purl / distribution drift between them fails CLOSED.

pyproject.toml is the single source of truth for the package name and version.
This test derives (name, version) from it once and then asserts that all of:

  (a) attestation.json  — body['package'] carries name/version/purl/distribution
      matching pyproject (distribution == 'pypi', purl == pkg:pypi/<name>@<ver>);
  (b) sbom/bom.json      — the root component purl equals the attestation purl;
  (c) PROVENANCE.md      — contains the pyproject version, contains the exact
      purl string, and NO LONGER contains the stale 'not published to PyPI';
  (d) verify_attestation.py — exits 0 on the committed tree (subprocess);

agree. Any single-surface edit (a bumped pyproject version, a hand-tweaked
PROVENANCE row, a regenerated-but-not-committed attestation) breaks the anchor
here. Standard library only; exits 0 on the clean committed tree, non-zero with
a per-mismatch diagnostic otherwise.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

ATTESTATION_PATH = HERE / "attestation.json"
BOM_PATH = HERE / "sbom" / "bom.json"
PROVENANCE_PATH = HERE / "PROVENANCE.md"
PYPROJECT_PATH = HERE / "pyproject.toml"

STALE_DISTRIBUTION_CLAIM = "not published to PyPI"


def _pyproject_metadata():
    """Return (name, version) from pyproject.toml, the single source of truth.

    Reuses gen_sbom.read_metadata when importable (the SAME reader the SBOM and
    attestation use), with a tiny stdlib regex fallback so this test never
    depends on import path quirks.
    """
    try:
        import gen_sbom  # noqa: WPS433 (local import keeps this file standalone)

        name, version, _ = gen_sbom.read_metadata()
        return name, version
    except Exception:  # pragma: no cover - fallback path
        text = PYPROJECT_PATH.read_text(encoding="utf-8")
        name = re.search(r'^\s*name\s*=\s*"([^"]+)"', text, re.MULTILINE)
        version = re.search(r'^\s*version\s*=\s*"([^"]+)"', text, re.MULTILINE)
        if not name or not version:
            raise SystemExit(
                "test_provenance_anchor: could not read name/version from "
                "pyproject.toml"
            )
        return name.group(1), version.group(1)


def _check(errors, cond, msg):
    if not cond:
        errors.append(msg)


def main():
    errors = []

    name, version = _pyproject_metadata()
    expected_purl = "pkg:pypi/{}@{}".format(name, version)

    # (a) attestation.json body['package'] ---------------------------------
    att = json.loads(ATTESTATION_PATH.read_text(encoding="utf-8"))
    pkg = att.get("attestation", {}).get("package")
    if not isinstance(pkg, dict):
        errors.append("attestation.json: body has no 'package' section")
    else:
        _check(errors, pkg.get("name") == name,
               "attestation package.name %r != pyproject %r"
               % (pkg.get("name"), name))
        _check(errors, pkg.get("version") == version,
               "attestation package.version %r != pyproject %r"
               % (pkg.get("version"), version))
        _check(errors, pkg.get("purl") == expected_purl,
               "attestation package.purl %r != %r"
               % (pkg.get("purl"), expected_purl))
        _check(errors, pkg.get("distribution") == "pypi",
               "attestation package.distribution %r != 'pypi'"
               % (pkg.get("distribution"),))

    # (b) sbom/bom.json root component purl == attestation purl ------------
    bom = json.loads(BOM_PATH.read_text(encoding="utf-8"))
    bom_purl = bom.get("metadata", {}).get("component", {}).get("purl")
    _check(errors, bom_purl == expected_purl,
           "sbom root component purl %r != attestation purl %r"
           % (bom_purl, expected_purl))

    # (c) PROVENANCE.md agrees and is no longer self-contradicting ---------
    prov = PROVENANCE_PATH.read_text(encoding="utf-8")
    _check(errors, version in prov,
           "PROVENANCE.md does not contain the pyproject version %r" % version)
    _check(errors, expected_purl in prov,
           "PROVENANCE.md does not contain the exact purl %r" % expected_purl)
    _check(errors, STALE_DISTRIBUTION_CLAIM not in prov,
           "PROVENANCE.md still contains the stale claim %r"
           % STALE_DISTRIBUTION_CLAIM)

    # (d) verify_attestation.py exits 0 on the committed tree --------------
    proc = subprocess.run(
        [sys.executable, "verify_attestation.py"],
        cwd=str(HERE),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )
    _check(errors, proc.returncode == 0,
           "verify_attestation.py exited %d (stderr=%s)"
           % (proc.returncode, proc.stderr.strip()))

    if errors:
        print("SUMMARY: provenance anchor FAILED — %d mismatch(es): %s"
              % (len(errors), "; ".join(errors)))
        return 1

    print(
        "SUMMARY: provenance anchor OK — %s %s pinned to %s across "
        "pyproject/attestation/bom/PROVENANCE, verify_attestation.py exit 0"
        % (name, version, expected_purl)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
