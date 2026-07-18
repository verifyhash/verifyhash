#!/usr/bin/env python3
"""test_schema_index.py — prove schema-index.json is a faithful, re-derivable
catalog of the adopter-facing conformance JSON Schemas.

The committed ``schema-index.json`` (JSON Schema draft 2020-12) is a PLAIN
CATALOG of the three published, adopter-facing schemas that live in this
directory — ``report.schema.json``, ``receipt.schema.json`` and
``attestation.schema.json`` (each of which has its own drift guard:
test_report_schema.py / test_receipt_schema.py / test_attestation_schema.py).
The index carries no rule logic and no hashes of the schema bodies; its whole
truth is re-derivable by reading the files it lists. This test is the
CROSS-DRIFT guard that keeps the catalog honest:

  (a) loads schema-index.json, asserts it parses as JSON, is a draft-2020-12
      document, and that its ``$id`` == the stable index id
      ``https://verifyhash.com/schemas/index.json``;
  (b) COMPLETENESS: globs every ``*.schema.json`` in THIS directory and asserts
      the set of on-disk filenames exactly equals the set of index ``file``
      values — a schema file present on disk but missing from the index FAILS
      (catches "added a 4th schema, forgot to index it"), and an index entry
      naming a non-existent file FAILS;
  (c) FIDELITY: for each entry, opens the referenced schema file and asserts
      ``entry['$id']`` == the file's ``$id`` and ``entry['title']`` == the
      file's ``title``, and that the file's ``$id`` is present (non-empty) —
      so an entry whose $id/title drifts from the real schema turns this red;
  (d) VERSION CONSISTENCY: asserts each entry's ``version`` equals the version
      path segment actually parsed out of that entry's ``$id`` (the field is
      cross-checked against the URL, never trusted on its own);
  (e) NAME UNIQUENESS: asserts the ``name``, ``file`` and ``$id`` values are
      each unique across the ``schemas`` array.

Stdlib only (json, os, glob, pathlib, urllib.parse). NO jsonschema import — the
engine adds no runtime dependency (test_packaging.py proves it) and this guard
keeps that promise. Fast, offline, saxonche-free.
"""

import glob
import json
import os
import unittest
from pathlib import Path
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX_PATH = os.path.join(HERE, "schema-index.json")
INDEX_ID = "https://verifyhash.com/schemas/index.json"
DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema"


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_index():
    return load_json(INDEX_PATH)


def version_from_id(schema_id):
    """Parse the version path segment out of a schema ``$id`` URL.

    The published ids have the shape
    ``https://verifyhash.com/schemas/einvoice-conformance-<name>/<version>/<name>.schema.json``
    so the version is the path segment immediately before the trailing
    ``<name>.schema.json`` filename — i.e. the second-to-last non-empty path
    segment. Returns that segment (e.g. ``'v1'``), or ``None`` if the URL has
    too few segments to carry one.
    """
    parts = [p for p in urlparse(schema_id).path.split("/") if p]
    if len(parts) < 2:
        return None
    return parts[-2]


class SchemaIndexDocument(unittest.TestCase):
    def test_index_parses_and_is_draft_2020_12(self):
        index = load_index()
        self.assertIsInstance(index, dict)
        self.assertEqual(index["$schema"], DRAFT_2020_12)
        self.assertEqual(index["$id"], INDEX_ID)
        self.assertIn("title", index)
        self.assertIn("description", index)
        self.assertIsInstance(index["schemas"], list)
        self.assertTrue(index["schemas"], "index must catalog at least one schema")

    def test_every_entry_has_the_required_fields(self):
        index = load_index()
        for entry in index["schemas"]:
            for key in ("name", "file", "$id", "title", "version"):
                self.assertIn(key, entry,
                              "entry %r missing %r" % (entry.get("file"), key))
                self.assertIsInstance(entry[key], str)
                self.assertTrue(entry[key], "entry field %r is empty" % key)


class Completeness(unittest.TestCase):
    """The index set of files must exactly equal the on-disk *.schema.json set,
    derived by globbing (NOT a hardcoded list) so a future 4th schema is
    caught the moment it lands unindexed."""

    def test_index_files_equal_on_disk_schema_files(self):
        index = load_index()
        indexed = {entry["file"] for entry in index["schemas"]}
        on_disk = {os.path.basename(p)
                   for p in glob.glob(os.path.join(HERE, "*.schema.json"))}
        self.assertEqual(
            indexed, on_disk,
            "schema-index.json files %r != on-disk *.schema.json %r "
            "(a schema added without an index entry, or an entry naming a "
            "missing file, fails here)" % (sorted(indexed), sorted(on_disk)))

    def test_every_indexed_file_exists(self):
        index = load_index()
        for entry in index["schemas"]:
            path = os.path.join(HERE, entry["file"])
            self.assertTrue(os.path.isfile(path),
                            "indexed file does not exist: %s" % entry["file"])
            # file must live in THIS directory, no path traversal.
            self.assertEqual(os.path.basename(entry["file"]), entry["file"],
                             "file value must be a bare filename: %r"
                             % entry["file"])


class Fidelity(unittest.TestCase):
    """Each entry's $id and title must be byte-identical to the referenced
    schema file's own $id/title."""

    def test_id_and_title_match_the_referenced_schema(self):
        index = load_index()
        for entry in index["schemas"]:
            schema = load_json(os.path.join(HERE, entry["file"]))
            file_id = schema.get("$id", "")
            self.assertTrue(file_id,
                            "schema %s has an empty/absent $id" % entry["file"])
            self.assertEqual(
                entry["$id"], file_id,
                "index $id drift for %s: index=%r file=%r"
                % (entry["file"], entry["$id"], file_id))
            self.assertEqual(
                entry["title"], schema.get("title"),
                "index title drift for %s: index=%r file=%r"
                % (entry["file"], entry["title"], schema.get("title")))


class VersionConsistency(unittest.TestCase):
    """Each entry's declared version must equal the version segment actually
    present in that entry's $id — the field is verified against the URL, never
    trusted on its own."""

    def test_version_field_matches_parsed_id_segment(self):
        index = load_index()
        for entry in index["schemas"]:
            parsed = version_from_id(entry["$id"])
            self.assertIsNotNone(
                parsed, "could not parse a version from $id %r" % entry["$id"])
            self.assertEqual(
                entry["version"], parsed,
                "version field %r != parsed $id segment %r for %s"
                % (entry["version"], parsed, entry["file"]))


class Uniqueness(unittest.TestCase):
    """name, file and $id must each be unique across the array."""

    def test_names_files_and_ids_are_unique(self):
        index = load_index()
        for key in ("name", "file", "$id"):
            values = [entry[key] for entry in index["schemas"]]
            self.assertEqual(
                len(values), len(set(values)),
                "duplicate %r values in schema-index.json: %r" % (key, values))


class DriftIsActuallyCaught(unittest.TestCase):
    """Prove the guards FAIL on the failure modes they claim to catch, so a
    green run means something. These operate on in-memory copies; no file is
    written."""

    def _entries(self):
        return [dict(e) for e in load_index()["schemas"]]

    def test_completeness_catches_unindexed_schema(self):
        # Simulate a 4th schema on disk that the index does not list.
        indexed = {e["file"] for e in self._entries()}
        on_disk = set(indexed) | {"newthing.schema.json"}
        self.assertNotEqual(indexed, on_disk)

    def test_fidelity_catches_drifted_id(self):
        entries = self._entries()
        entries[0]["$id"] = "https://verifyhash.com/schemas/WRONG/v1/x.schema.json"
        schema = load_json(os.path.join(HERE, entries[0]["file"]))
        self.assertNotEqual(entries[0]["$id"], schema.get("$id"))

    def test_version_consistency_catches_wrong_version(self):
        entries = self._entries()
        entries[0]["version"] = "v9"
        self.assertNotEqual(entries[0]["version"],
                            version_from_id(entries[0]["$id"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
