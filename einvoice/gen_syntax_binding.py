#!/usr/bin/env python3
"""gen_syntax_binding.py — regenerate ``syntax_binding_catalog.json`` from the
two vendored preprocessed CEN Schematron artifacts.

    python3 gen_syntax_binding.py          # write the catalog
    python3 gen_syntax_binding.py --check  # verify the committed file is fresh

The catalog is a MEASUREMENT + DESIGN artifact: it enumerates + mechanically
classifies the 756 UBL + 583 CII syntax-binding (non-BR) asserts. It does NOT
implement any assert evaluator and does NOT touch the business-rule matrix.
Standard library only.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import syntax_binding as _sb  # noqa: E402

OUT_PATH = os.path.join(HERE, "syntax_binding_catalog.json")


def render_json(catalog):
    return json.dumps(catalog, indent=2, ensure_ascii=False, sort_keys=False) + "\n"


def main(argv):
    catalog = _sb.build_catalog(HERE)
    text = render_json(catalog)
    if "--check" in argv:
        if not os.path.exists(OUT_PATH):
            sys.stderr.write("syntax_binding_catalog.json missing\n")
            return 1
        committed = open(OUT_PATH, encoding="utf-8").read()
        if committed != text:
            sys.stderr.write(
                "syntax_binding_catalog.json is stale — re-run "
                "gen_syntax_binding.py\n")
            return 1
        print("syntax_binding_catalog.json is fresh")
        return 0
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        fh.write(text)
    acct = catalog["accounting"]
    print("wrote %s: UBL %d + CII %d = %d syntax-binding asserts"
          % (os.path.basename(OUT_PATH), acct["ubl"]["total"],
             acct["cii"]["total"],
             acct["ubl"]["total"] + acct["cii"]["total"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
