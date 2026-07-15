#!/usr/bin/env python3
"""Zero-dependency CycloneDX 1.5 SBOM generator for verifyhash-einvoice.

Reads the package metadata (name, version, dependencies) straight from
`pyproject.toml` and emits a CycloneDX 1.5 JSON SBOM to `sbom/bom.json`.

The whole point of this SBOM is to make an HONEST, machine-readable claim
that the einvoice Python package carries ZERO third-party runtime
dependencies: `components` is empty, and the root component's dependency
edge (`dependencies[0].dependsOn`) is empty. We never invent transitive
components.

Stdlib only — no `toml` dependency. On Python 3.11+ `tomllib` is used to
read pyproject; on 3.8-3.10 a tiny fallback extracts exactly the three
fields we need (`[project].name`, `.version`, `.dependencies`).

Usage:
    python3 gen_sbom.py            # write sbom/bom.json
    python3 gen_sbom.py --check    # exit non-zero if bom.json is stale
"""
import hashlib
import json
import re
import sys
from pathlib import Path

try:  # Python 3.11+
    import tomllib  # type: ignore

    def _load_pyproject(text):
        return tomllib.loads(text)
except ModuleNotFoundError:  # Python 3.8 - 3.10: minimal fallback
    def _load_pyproject(text):
        """Extract only [project].name, .version, .dependencies.

        Deliberately tiny: it understands just the handful of TOML shapes
        this project's pyproject actually uses (a `[project]` table with
        double-quoted string scalars and a single-line or multi-line
        `dependencies` array). It is NOT a general TOML parser and does not
        pretend to be one — it exists so we avoid a toml dependency.
        """
        project = _slice_project_table(text)
        name = _find_string(project, "name")
        version = _find_string(project, "version")
        deps = _find_array(project, "dependencies")
        out = {"project": {}}
        if name is not None:
            out["project"]["name"] = name
        if version is not None:
            out["project"]["version"] = version
        if deps is not None:
            out["project"]["dependencies"] = deps
        return out

    def _slice_project_table(text):
        # Return the text of the [project] table only, so we don't pick up
        # keys from other tables (e.g. [build-system].requires).
        lines = text.splitlines()
        out = []
        in_project = False
        for line in lines:
            stripped = line.strip()
            if re.match(r"^\[[^\[]", stripped):  # a table header like [x]
                in_project = stripped == "[project]"
                continue
            if stripped.startswith("[["):  # array-of-tables header
                in_project = False
                continue
            if in_project:
                out.append(line)
        return "\n".join(out)

    def _find_string(text, key):
        m = re.search(
            r'^\s*' + re.escape(key) + r'\s*=\s*"([^"]*)"', text, re.MULTILINE
        )
        return m.group(1) if m else None

    def _find_array(text, key):
        # Match `key = [ ... ]`, possibly spanning multiple lines.
        m = re.search(
            r'^\s*' + re.escape(key) + r'\s*=\s*\[(.*?)\]',
            text,
            re.MULTILINE | re.DOTALL,
        )
        if not m:
            return None
        body = m.group(1)
        # Strip TOML comments then pull out double-quoted items.
        body = re.sub(r"#.*", "", body)
        return re.findall(r'"([^"]*)"', body)


HERE = Path(__file__).resolve().parent
PYPROJECT = HERE / "pyproject.toml"
BOM_PATH = HERE / "sbom" / "bom.json"
CORPUS_ROOT = HERE / "corpus"

# --- Vendored rule corpora -------------------------------------------------
#
# These are NOT runtime dependencies (the shipped wheel contains only the
# pure-Python `einvoice` package, never `corpus/` — see
# `[tool.setuptools] packages = ["einvoice"]`). They are version-pinned
# build-and-differential-test inputs, enumerated here as CycloneDX 1.5 `data`
# components so the SBOM is an honest inventory of *every* third-party artifact
# vendored into the repo, with a content hash that lets the drift guard
# (`gen_sbom.py --check`) fire on ANY added/changed/removed vendored file.
#
# Every field below is a pin traceable to committed provenance — nothing is
# invented:
#   * license / upstream repo: `PROVENANCE.md` "Rule corpus provenance" and
#     `SECURITY.md` "Vendored, pinned rule corpus".
#   * version: the pinned tag/version recorded either in `PROVENANCE.md`
#     (XRechnung Schematron v2.5.0) or, where PROVENANCE.md does not spell out
#     a tag, read verbatim from the vendored artifact's OWN self-declared
#     version marker (cited per-entry in `version_source`), so it can be
#     re-derived from the tree on disk.
CORPORA = (
    {
        # EN 16931 Schematron — CEN/TC 434 official validation artefacts.
        "name": "eInvoicing-EN16931",
        "path": "cen-en16931",
        "version": "1.3.16",
        "version_source": (
            "corpus/cen-en16931/ubl/schematron/preprocessed/"
            "EN16931-UBL-validation-preprocessed.sch header "
            "(<!--Schematron version 1.3.16 ...-->)"
        ),
        "license": "EUPL-1.2",
        "repo": "ConnectingEurope/eInvoicing-EN16931",
        "url": "https://github.com/ConnectingEurope/eInvoicing-EN16931",
    },
    {
        # XRechnung national CIUS Schematron (BR-DE-* ground truth).
        "name": "xrechnung-schematron",
        "path": "xrechnung-schematron",
        "version": "2.5.0",
        "version_source": (
            "PROVENANCE.md + corpus/xrechnung-schematron/VENDORED.md "
            "(release tag v2.5.0)"
        ),
        "license": "Apache-2.0",
        "repo": "itplr-kosit/xrechnung-schematron",
        "url": "https://github.com/itplr-kosit/xrechnung-schematron",
    },
    {
        # KoSIT official XRechnung test-document suite.
        "name": "xrechnung-testsuite",
        "path": "xrechnung-testsuite",
        "version": "2026-07-31-SNAPSHOT",
        "version_source": (
            "corpus/xrechnung-testsuite/build.xml "
            '(property testsuite.version.date = "2026-07-31-SNAPSHOT")'
        ),
        "license": "Apache-2.0",
        "repo": "itplr-kosit/xrechnung-testsuite",
        "url": "https://github.com/itplr-kosit/xrechnung-testsuite",
    },
)

# Generated/OS cruft that is never part of the vendored artifact; excluding it
# keeps the corpus hash a function of the real vendored files only (so the
# drift guard reacts to genuine corpus changes, not stray build noise).
_HASH_SKIP_NAMES = {"__pycache__", ".DS_Store"}
_HASH_SKIP_SUFFIXES = (".pyc", ".pyo")


def _iter_corpus_files(root):
    """Yield (posix_relpath, absolute_path) for every vendored file under root.

    Sorted by relative POSIX path so the walk order is deterministic across
    machines and filesystems. Skips generated cruft (see _HASH_SKIP_*).
    """
    files = []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(root)
        parts = set(rel.parts)
        if parts & _HASH_SKIP_NAMES:
            continue
        if p.suffix in _HASH_SKIP_SUFFIXES:
            continue
        files.append((rel.as_posix(), p))
    files.sort(key=lambda item: item[0])
    return files


def corpus_sha256(root):
    """Deterministic SHA-256 over a vendored corpus's whole file tree.

    Each file contributes BOTH its relative path and its bytes to a single
    running hash, with length-delimited framing, so adding, removing, renaming,
    or editing any vendored file necessarily changes the digest. Files are
    streamed in fixed-size chunks — no whole-file reads — so this stays cheap
    even on the ~500-file EN 16931 corpus. Returns a lowercase hex digest.
    """
    h = hashlib.sha256()
    for rel, path in _iter_corpus_files(root):
        rel_bytes = rel.encode("utf-8")
        # Length-prefix the path so "a/b" + "c" can never collide with
        # "a" + "b/c" (framing removes concatenation ambiguity).
        h.update(str(len(rel_bytes)).encode("ascii"))
        h.update(b"\0")
        h.update(rel_bytes)
        h.update(b"\0")
        size = path.stat().st_size
        h.update(str(size).encode("ascii"))
        h.update(b"\0")
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 16), b""):
                h.update(chunk)
    return h.hexdigest()


def build_corpus_components():
    """One CycloneDX 1.5 `data` component per vendored rule corpus.

    Deterministic and offline: name/version/license/URL are the committed pins
    from CORPORA; the hash is computed from the on-disk tree. These are data
    inventory entries only — they are deliberately NOT added to the dependency
    graph, because they are not runtime dependencies of the package.
    """
    components = []
    for corpus in CORPORA:
        root = CORPUS_ROOT / corpus["path"]
        if not root.is_dir():
            raise SystemExit(
                "gen_sbom: vendored corpus is missing: {}".format(root)
            )
        digest = corpus_sha256(root)
        components.append(
            {
                "type": "data",
                "bom-ref": "corpus:{}@{}".format(
                    corpus["name"], corpus["version"]
                ),
                "name": corpus["name"],
                "version": corpus["version"],
                "description": (
                    "Vendored, version-pinned rule corpus from {repo} "
                    "({lic}). Build/differential-test input only — NOT a "
                    "runtime dependency and NOT shipped in the wheel."
                ).format(repo=corpus["repo"], lic=corpus["license"]),
                "licenses": [{"license": {"id": corpus["license"]}}],
                "externalReferences": [
                    {"type": "vcs", "url": corpus["url"]}
                ],
                "hashes": [{"alg": "SHA-256", "content": digest}],
                "properties": [
                    {
                        "name": "verifyhash:corpus-path",
                        "value": "corpus/{}".format(corpus["path"]),
                    },
                    {
                        "name": "verifyhash:version-source",
                        "value": corpus["version_source"],
                    },
                ],
            }
        )
    return components


def read_metadata():
    """Return (name, version, dependencies list) from pyproject.toml."""
    data = _load_pyproject(PYPROJECT.read_text(encoding="utf-8"))
    project = data.get("project", {})
    name = project.get("name")
    version = project.get("version")
    deps = project.get("dependencies", [])
    if not name or not version:
        raise SystemExit(
            "gen_sbom: could not read name/version from pyproject.toml"
        )
    if deps is None:
        deps = []
    return name, version, list(deps)


def build_sbom():
    """Build the CycloneDX 1.5 SBOM dict (deterministic — no timestamps)."""
    name, version, deps = read_metadata()
    purl = "pkg:pypi/{}@{}".format(name, version)

    # HONEST representation of the zero-dependency contract: a runtime
    # dependency would surface here as a `type: library` component AND a
    # dependsOn edge. Today both stay empty on purpose — the vendored rule
    # corpora enumerated below are `type: data` inventory entries, never
    # runtime deps, so they are deliberately kept OUT of the dependency graph.
    library_components = []
    depends_on = []
    for dep in deps:
        dep_purl = _dep_to_purl(dep)
        library_components.append(
            {
                "type": "library",
                "name": dep,
                "purl": dep_purl,
                "bom-ref": dep_purl,
            }
        )
        depends_on.append(dep_purl)

    # library (runtime-dep) components first, then vendored-corpus data
    # components — the two never mix in the dependency graph.
    components = library_components + build_corpus_components()

    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "component": {
                "type": "library",
                "bom-ref": purl,
                "name": name,
                "version": version,
                "purl": purl,
                "description": (
                    "Zero-dependency EN 16931 / XRechnung (UBL) e-invoice "
                    "conformance validator (Python, stdlib only)."
                ),
                "licenses": [{"license": {"id": "Apache-2.0"}}],
            }
        },
        "components": components,
        "dependencies": [
            {
                "ref": purl,
                "dependsOn": depends_on,
            }
        ],
    }


def _dep_to_purl(dep):
    """Best-effort PURL for a PEP 508 dependency string.

    Only reached if pyproject ever declares a runtime dependency; today the
    list is empty so this never runs. Kept honest and simple: strip the
    version/extras/markers to the bare distribution name.
    """
    name = re.split(r"[<>=!~;\[\s]", dep.strip(), 1)[0]
    return "pkg:pypi/{}".format(name)


def render(sbom):
    """Deterministic pretty JSON with a trailing newline."""
    return json.dumps(sbom, indent=2, sort_keys=False) + "\n"


def main(argv):
    check = "--check" in argv[1:]
    sbom = build_sbom()
    rendered = render(sbom)

    if check:
        if not BOM_PATH.exists():
            print(
                "gen_sbom --check: {} is missing — run "
                "`python3 gen_sbom.py`".format(BOM_PATH),
                file=sys.stderr,
            )
            return 1
        current = BOM_PATH.read_text(encoding="utf-8")
        # Compare parsed structure (robust to trailing-whitespace noise) AND
        # exact text, so either kind of drift is caught.
        if json.loads(current) != sbom or current != rendered:
            print(
                "gen_sbom --check: {} is STALE — regenerate with "
                "`python3 gen_sbom.py`".format(BOM_PATH),
                file=sys.stderr,
            )
            return 1
        print("gen_sbom --check: sbom/bom.json is up to date.")
        return 0

    BOM_PATH.parent.mkdir(parents=True, exist_ok=True)
    BOM_PATH.write_text(rendered, encoding="utf-8")
    print("gen_sbom: wrote {}".format(BOM_PATH))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
