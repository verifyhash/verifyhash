#!/usr/bin/env python3
"""Freeze the public embedding API surface into ``api_contract.json``.

Task T-VHAPI.3: API.md ("Stability policy") promises that the eight public
names in :data:`einvoice.__all__` are back-compat within a report schema
version. This generator pins that promise as a committed, byte-reproducible
artifact — for every public name it records the exact live shape:

* **functions** — the exact ``str(inspect.signature(obj))``, so any change to
  a parameter name, default, annotation, or return annotation is a diff;
* **``Result``** — its ``__init__`` signature plus the sorted public member
  names (``first``, ``ok``, ``to_dict``, ``valid``, ``violations``) that make
  up the documented embedder-facing surface;
* **``NotWellFormed``** — its base-class name and (custom) ``__init__``
  signature;
* **the ``validate`` submodule** — its fully-qualified module name.

``test_api_contract.py`` recomputes all of this live on every run and asserts
byte/structural equality with the committed file, so signature drift cannot
ship silently. A mismatch there is a DELIBERATE-REGENERATION event: rerun

    python3 gen_api_contract.py

review the diff against API.md's stability policy, and document the change —
never loosen the test. Output is byte-reproducible: sorted keys, fixed
2-space indent, trailing newline, no timestamps or absolute paths
(``test_determinism.py`` regenerates it in a fresh tree and byte-compares).

Standard library only; no network.
"""

from __future__ import annotations

import inspect
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice  # noqa: E402  (the nested einvoice/einvoice/ package)

#: Bump ONLY on a deliberate, documented change to the public surface
#: (see API.md, "Stability policy").
CONTRACT_VERSION = 1

#: Where the human-readable rules of engagement live.
POLICY = (
    "API.md 'Stability policy': the eight names in einvoice.__all__ are the "
    "supported embedding API, back-compat within a report schema version. "
    "If test_api_contract.py reports drift, that is a deliberate-regeneration "
    "event: rerun `python3 gen_api_contract.py`, review the diff against the "
    "policy, and document the change in API.md — never loosen the test."
)


def _public_members(cls: type) -> list[str]:
    """Sorted public (non-underscore) members of ``cls``.

    The union of names defined in the class body (methods, properties,
    staticmethods) and its class-level ``__annotations__`` (declared instance
    attributes like ``Result.violations``). This is exactly the documented
    embedder-facing surface of :class:`einvoice.Result`.
    """
    names = {k for k in vars(cls) if not k.startswith("_")}
    names |= {k for k in getattr(cls, "__annotations__", {})
              if not k.startswith("_")}
    return sorted(names)


def shape_of(obj: object) -> dict:
    """The frozen contract shape of one public API object."""
    if inspect.ismodule(obj):
        return {"kind": "module", "module": obj.__name__}
    if inspect.isclass(obj):
        if issubclass(obj, BaseException):
            return {
                "kind": "exception",
                "base": obj.__mro__[1].__name__,
                "init": str(inspect.signature(obj.__init__)),
            }
        return {
            "kind": "class",
            "init": str(inspect.signature(obj.__init__)),
            "public_members": _public_members(obj),
        }
    # Plain callable (function).
    return {"kind": "function", "signature": str(inspect.signature(obj))}


def build_contract() -> dict:
    """The full contract document (pure function of the live package)."""
    return {
        "_contract": {
            "policy": POLICY,
            "version": CONTRACT_VERSION,
        },
        "api": {name: shape_of(getattr(einvoice, name))
                for name in sorted(einvoice.__all__)},
    }


def render_contract() -> str:
    """Byte-reproducible JSON text: sorted keys, 2-space indent, trailing \\n."""
    return json.dumps(build_contract(), sort_keys=True, indent=2,
                      ensure_ascii=False) + "\n"


def main() -> int:
    out = os.path.join(HERE, "api_contract.json")
    text = render_contract()
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    sys.stderr.write("wrote %s (%d names)\n"
                     % (os.path.basename(out), len(einvoice.__all__)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
