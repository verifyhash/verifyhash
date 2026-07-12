#!/usr/bin/env python3
"""gen_sb_fixtures.py — synthesize the targeted, per-id VIOLATING UBL fixtures for
the newly-implemented syntax-binding shape classes (cardinality-count +
existence), one `sb-viol-<id>_ubl.xml` per implemented id under
corpus/vendored/syntax-binding/.

Each fixture is the committed valid base invoice (`sb-pass-clean_ubl.xml`) with a
SINGLE mechanical mutation that makes exactly the target assert FIRE, derived from
the compiled catalog entry (its rule @context + @test) — never hand-tuned per id.
The base already serves as the PASSING shape for every id (it clears all of them),
so only the firing direction needs a dedicated fixture.

  - cardinality-count: inject `n+1` fresh copies of the counted path into a node
    matching the rule context, so the count exceeds (or, for `= n`, misses) the
    cap. For the `not(P) or count(P)=1` shape this also makes P present, so the
    assert fires on both conjuncts.
  - existence: append a FRESH, empty context node so every required existence
    term selects an empty node-set.

Run:  python3 gen_sb_fixtures.py
The differential leg (`differential.py`, sb leg) then grades every id against the
official CEN Schematron over these fixtures + the broad EN corpus at 0 divergence.
"""

from __future__ import annotations

import os
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import syntax_binding_eval as sbe  # noqa: E402

FIXTURE_DIR = os.path.join(HERE, "corpus", "vendored", "syntax-binding")
BASE = os.path.join(FIXTURE_DIR, "sb-pass-clean_ubl.xml")

# Implemented caps whose FIRING direction crashes the official XSLT (see the
# authoritative note on einvoice.syntax_binding_eval.FIRING_UNOBSERVABLE): no
# self-crashing firing fixture is shipped for them.
FIRING_UNOBSERVABLE = sbe.FIRING_UNOBSERVABLE

for _pfx, _uri in sbe.NSMAP.items():
    # Map the default namespace (UBL Invoice-2) to '' so <Invoice> stays
    # unprefixed; the rest keep their catalog prefixes.
    ET.register_namespace("" if _pfx == "ubl" else _pfx, _uri)


def _parents(root):
    return {id(c): p for p in root.iter() for c in p}


def _leaf_tag(step):
    """A single concrete element tag for a path step (union groups -> first)."""
    return sorted(step.tags)[0]


def _add_path_instance(parent, path):
    """Build ONE fresh instance of a restricted count/existence location path as
    a nested element chain under ``parent``; a trailing @attr step is applied as
    an attribute on the deepest element."""
    cur = parent
    for st in path.steps:
        if isinstance(st, sbe._AttrStep):
            cur.set(st.key, "x")            # attribute presence (count of @attr)
        else:
            cur = ET.SubElement(cur, _leaf_tag(st))
    return cur


def _make_context(root, branch):
    """Materialize a node matching one restricted context branch. A rooted branch
    is the document root itself; otherwise build the element chain under root and
    return the deepest (self) element."""
    if branch.rooted:
        return root
    cur = root
    for tag in branch.tags:
        cur = ET.SubElement(cur, tag)
    return cur


def _target_context(root, entry, create_missing):
    parents = _parents(root)
    nodes = entry.ctx.match(root, parents)
    if nodes and not create_missing:
        return nodes[0]
    if nodes and create_missing:
        return nodes[0]
    return _make_context(root, entry.ctx.branches[0])


def _mutate(entry):
    tree = ET.parse(BASE)
    root = tree.getroot()

    if entry.shape == "existence":
        # A FRESH, empty context node fails every required existence term.
        _make_context(root, entry.ctx.branches[0])
        return tree

    # cardinality-count: reach a count that violates the cap on one context node.
    comp = entry.compiled
    path = comp.q if comp.kind == "not_or_count" else comp.p
    target = _target_context(root, entry, create_missing=False)
    for _ in range(comp.n + 1):
        _add_path_instance(target, path)
    return tree


def main():
    written = []
    for entry in sbe.implemented_entries():
        if entry.shape not in ("cardinality-count", "existence"):
            continue
        if entry.id in FIRING_UNOBSERVABLE:
            # Would crash the official XSLT (see FIRING_UNOBSERVABLE) — no fixture.
            out = os.path.join(FIXTURE_DIR, "sb-viol-%s_ubl.xml" % entry.id)
            if os.path.exists(out):
                os.remove(out)
            continue
        tree = _mutate(entry)
        out = os.path.join(FIXTURE_DIR, "sb-viol-%s_ubl.xml" % entry.id)
        tree.write(out, encoding="utf-8", xml_declaration=True)
        written.append(entry.id)
    # Self-check: every generated fixture must FIRE its target id in our evaluator.
    from einvoice.parser import parse_file  # noqa: E402
    bad = []
    for rid in written:
        path = os.path.join(FIXTURE_DIR, "sb-viol-%s_ubl.xml" % rid)
        if rid not in sbe.fired_ids(parse_file(path)):
            bad.append(rid)
    if bad:
        sys.stderr.write("FIXTURES THAT DO NOT FIRE THEIR ID: %s\n" % bad)
        return 1
    print("wrote %d targeted sb-viol fixtures; all fire their id in the "
          "restricted evaluator." % len(written))
    return 0


if __name__ == "__main__":
    sys.exit(main())
