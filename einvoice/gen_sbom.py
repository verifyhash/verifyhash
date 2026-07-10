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

    # HONEST representation of the zero-dependency contract: if pyproject
    # ever grows a runtime dependency, it would surface here as a component
    # and a dependsOn edge. Today both are empty on purpose.
    components = []
    depends_on = []
    for dep in deps:
        dep_purl = _dep_to_purl(dep)
        components.append(
            {
                "type": "library",
                "name": dep,
                "purl": dep_purl,
                "bom-ref": dep_purl,
            }
        )
        depends_on.append(dep_purl)

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
