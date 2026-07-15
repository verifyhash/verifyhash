#!/usr/bin/env python3
"""gen_sb_fixtures.py — synthesize the targeted, per-id VIOLATING UBL fixtures for
the newly-implemented syntax-binding shape classes (cardinality-count, existence,
and the decimal-cap datatype-regex UBL-DT-01), one `sb-viol-<id>_ubl.xml` per
implemented id under corpus/vendored/syntax-binding/.

Each fixture is the committed valid base invoice (`sb-pass-clean_ubl.xml`) with a
SINGLE mechanical mutation that makes exactly the target assert FIRE, derived from
the compiled catalog entry (its rule @context + @test) — never hand-tuned per id.
The base already serves as the PASSING shape for every id (it clears all of them),
so only the firing direction needs a dedicated fixture.

  - cardinality-count: inject `n+1` fresh copies of the counted path into a node
    matching the rule context, so the count exceeds (or, for `= n`, misses) the
    cap. For the `not(P) or count(P)=1` shape this also makes P present, so the
    assert fires on both conjuncts. The difference-of-counts shape (UBL-DT-18)
    adds one node counted by P1 but not P2; the `and`-conjoined shape
    (UBL-SR-19/21) builds one A instance valued EQUAL to B so `(A) != (B)` is
    false while the cap stays satisfied (no plural-leaf XSLT crash).
  - existence: append a FRESH, empty context node so every required existence
    term selects an empty node-set.
  - datatype-regex (UBL-DT-01): give a context-matching amount `n+1` decimal
    places so `string-length(substring-after(., '.')) > n`.

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

# CII leg (T-VHSBL.4): fixtures live in einvoice/fixtures/ (a dedicated dir NOT
# swept by the UBL sb leg's corpus/vendored/syntax-binding/). The clean CII base
# is a re-serialization of the CEN CII_example1 (a 20-line S-rated grocery
# invoice that fires NOTHING on the official CEN EN16931-CII Schematron).
CII_FIXTURE_DIR = os.path.join(HERE, "fixtures")
CII_SOURCE_BASE = os.path.join(HERE, "corpus", "cen-en16931", "cii", "examples",
                               "CII_example1.xml")
CII_BASE = os.path.join(CII_FIXTURE_DIR, "sb-pass-clean_cii.xml")

# Implemented caps whose FIRING direction crashes the official XSLT (see the
# authoritative note on einvoice.syntax_binding_eval.FIRING_UNOBSERVABLE): no
# self-crashing firing fixture is shipped for them.
FIRING_UNOBSERVABLE = sbe.FIRING_UNOBSERVABLE

for _pfx, _uri in sbe.NSMAP.items():
    # Map the default namespace (UBL Invoice-2) to '' so <Invoice> stays
    # unprefixed; the rest keep their catalog prefixes.
    ET.register_namespace("" if _pfx == "ubl" else _pfx, _uri)

for _pfx, _uri in sbe.CII_NSMAP.items():
    # CII keeps its catalog prefixes (rsm/ram/udt/qdt) — the CrossIndustryInvoice
    # root is rsm-prefixed, so nothing maps to the default namespace here.
    ET.register_namespace(_pfx, _uri)


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
    is the document root itself; an element-suffix branch (T-VHSBL.6) becomes a
    fresh representative element whose local name IS the required suffix (so the
    official //X[ends-with(name(), 'suffix')] rule claims it, unmatched by any
    earlier rule); otherwise build the element chain under root and return the
    deepest (self) element."""
    if isinstance(branch, sbe._SuffixBranch):
        uri = branch.ns_uri or sbe.NSMAP["cbc"]
        return ET.SubElement(root, "{%s}%s" % (uri, branch.suffix))
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

    comp = entry.compiled

    if comp.kind == "decimal_le":
        # datatype-regex decimal cap (UBL-DT-01): give a context-matching amount
        # exactly n+1 decimal places so string-length(substring-after(.,'.')) > n.
        parents = _parents(root)
        nodes = entry.ctx.match(root, parents)
        node = nodes[0] if nodes else _make_context(root, entry.ctx.branches[0])
        txt = (node.text or "").strip()
        intpart = txt.split(".", 1)[0] if "." in txt else (txt or "0")
        node.text = (intpart or "0") + "." + ("0" * (comp.n + 1))
        return tree

    if comp.kind == "count_diff":
        # difference-of-counts (UBL-DT-18 `count(//@name) - count(//PMC/@name)`):
        # add ONE node counted by P1 but NOT P2 — a fresh carrier element under
        # root carrying the P1 attribute — so the difference exceeds the bound.
        carrier = ET.SubElement(root, "{%s}Note" % sbe.NSMAP["cbc"])
        _add_path_instance(carrier, comp.p)
        return tree

    if comp.kind == "and_count_ne":
        # and-conjoined cap + node-set inequality (UBL-SR-19/21): fire the RIGHT
        # conjunct — build ONE instance of A valued EQUAL to B, so `(A) != (B)` is
        # false while the count stays within the cap (no plural-leaf XSLT crash).
        parents = _parents(root)
        nodes = entry.ctx.match(root, parents)
        target = nodes[0] if nodes else _make_context(root,
                                                      entry.ctx.branches[0])
        a_leaf = _add_path_instance(target, comp.a_path)
        parents = _parents(root)
        b_nodes = sbe._select(comp.b_path, target, root, parents)
        a_leaf.text = sbe._string_value(b_nodes[0]) if b_nodes else ""
        return tree

    # cardinality-count: reach a count that violates the cap on one context node.
    path = comp.q if comp.kind == "not_or_count" else comp.p
    target = _target_context(root, entry, create_missing=False)
    for _ in range(comp.n + 1):
        _add_path_instance(target, path)
    return tree


# --------------------------------------------------------------------------- #
# CII fixture synthesis (T-VHSBL.4).                                            #
# --------------------------------------------------------------------------- #
def _cii_find_child(parent, tag):
    for ch in parent:
        if ch.tag == tag:
            return ch
    return None


def _cii_materialize_context(root, branch):
    """Return the deepest element of ONE restricted context branch, creating any
    missing ancestor under ``root`` and REUSING existing nodes where they exist
    (so a fresh context is only built when the base lacks it). A rooted branch's
    outermost step is the document root itself."""
    cur = root
    tags = branch.tags[1:] if branch.rooted else branch.tags
    for tag in tags:
        child = _cii_find_child(cur, tag)
        if child is None:
            child = ET.SubElement(cur, tag)
        cur = child
    return cur


def _cii_fresh_context(root, branch):
    """Always build a FRESH context node (never reuse) — used for the existence
    class so every required existence term selects an empty node-set."""
    cur = root
    tags = branch.tags[1:] if branch.rooted else branch.tags
    for i, tag in enumerate(tags):
        # Reuse ancestors but force a fresh LEAF context element.
        if i == len(tags) - 1:
            cur = ET.SubElement(cur, tag)
        else:
            child = _cii_find_child(cur, tag)
            cur = child if child is not None else ET.SubElement(cur, tag)
    if not tags:                       # rooted single-step (== root) — cannot fresh
        return root
    return cur


def _cii_suffix_context_node(root, branch):
    """A FRESH representative context element for an element-suffix branch
    (T-VHSBL.6): local name == the required suffix, in the branch namespace (ram
    for a ``//ram:*`` head, ram by default for ``//*``), appended under the
    document root. Its name ends with the suffix so the official
    ``//X[ends-with(name(), 'suffix')]`` rule claims it, while no earlier specific
    rule matches a stray element of that name — so exactly the target assert fires
    once the forbidden path is added."""
    uri = branch.ns_uri or sbe.CII_NSMAP["ram"]
    return ET.SubElement(root, "{%s}%s" % (uri, branch.suffix))


def _mutate_cii(entry):
    """Build a targeted violating CII fixture for one implemented CII entry —
    a SINGLE mechanical mutation of the clean CII base derived from the compiled
    catalog entry (its rule @context + @test), never hand-tuned per id.

      * absence-restriction (kind 'not' / 'not_or_eq'): add ONE fresh instance of
        the forbidden path P under a context node — the base clears every id, so
        P is absent; on a fresh element-suffix context the equality guard Q is
        likewise absent/empty (!= the literal), so 'not_or_eq' fires too.
      * cardinality-count: inject n+1 fresh copies of the counted path into a
        context node so the count exceeds (or, for '= n', misses) the cap.
      * existence: append a FRESH empty context node so every required term is
        absent."""
    tree = ET.parse(CII_BASE)
    root = tree.getroot()
    comp = entry.compiled
    first = entry.ctx.branches[0]
    suffix_ctx = isinstance(first, sbe._SuffixBranch)

    if comp.kind == "exists_all":
        if suffix_ctx:
            _cii_suffix_context_node(root, first)
        else:
            _cii_fresh_context(root, first)
        return tree

    if suffix_ctx:
        target = _cii_suffix_context_node(root, first)
    else:
        parents = _parents(root)
        nodes = entry.ctx.match(root, parents)
        target = nodes[0] if nodes else _cii_materialize_context(root, first)

    if comp.kind in ("not", "not_or_eq"):
        _add_path_instance(target, comp.p)
        return tree

    # cardinality-count: exceed the cap on one context node.
    path = comp.q if comp.kind == "not_or_count" else comp.p
    for _ in range(comp.n + 1):
        _add_path_instance(target, path)
    return tree


def main_cii():
    """Write sb-pass-clean_cii.xml + one sb-viol-<id>_cii.xml per implemented CII
    id under einvoice/fixtures/, then self-check each fires its id in-evaluator."""
    os.makedirs(CII_FIXTURE_DIR, exist_ok=True)
    # (Re)materialize the clean base from the CEN example so the whole fixture
    # family shares one serialization.
    base_tree = ET.parse(CII_SOURCE_BASE)
    base_tree.write(CII_BASE, encoding="utf-8", xml_declaration=True)

    from einvoice.parser import parse_file  # noqa: E402
    # Sanity: the clean base must fire NOTHING in our CII evaluator.
    if sbe.cii_fired_ids(parse_file(CII_BASE)):
        sys.stderr.write("CII clean base wrongly fires ids: %s\n"
                         % sorted(sbe.cii_fired_ids(parse_file(CII_BASE))))
        return 1

    # Purge any stale sb-viol fixtures (e.g. for an id that just became
    # known-open via claim-shadowing) so the committed set is EXACTLY the
    # implemented ids.
    for name in os.listdir(CII_FIXTURE_DIR):
        if name.startswith("sb-viol-") and name.endswith("_cii.xml"):
            os.remove(os.path.join(CII_FIXTURE_DIR, name))

    written = []
    for entry in sbe.cii_implemented_entries():
        tree = _mutate_cii(entry)
        out = os.path.join(CII_FIXTURE_DIR, "sb-viol-%s_cii.xml" % entry.id)
        tree.write(out, encoding="utf-8", xml_declaration=True)
        written.append(entry.id)

    bad = []
    for rid in written:
        path = os.path.join(CII_FIXTURE_DIR, "sb-viol-%s_cii.xml" % rid)
        if rid not in sbe.cii_fired_ids(parse_file(path)):
            bad.append(rid)
    if bad:
        sys.stderr.write("CII FIXTURES THAT DO NOT FIRE THEIR ID: %s\n" % bad[:40])
        return 1
    print("wrote %d targeted sb-viol CII fixtures + clean base; all fire their id "
          "in the restricted CII evaluator." % len(written))
    return 0


def main():
    written = []
    for entry in sbe.implemented_entries():
        if entry.shape not in ("cardinality-count", "existence",
                               "datatype-regex"):
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
    rc = main()
    if rc == 0:
        rc = main_cii()
    sys.exit(rc)
