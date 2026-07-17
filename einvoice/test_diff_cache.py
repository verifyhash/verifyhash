#!/usr/bin/env python3
"""test_diff_cache.py — T-VHDIFFC.1 + T-VHDIFFC.2: pin the proof-cache
honesty contract between prove.py and differential.py's persistent
content-addressed cache (added in fd9bbb3).

MEASURE-FIRST FINDINGS (grepped 2026-07-17, BEFORE this file was written):
``grep -ln 'DIFF_NO_CACHE|_disk_cache|official-cache|_flush_delta|_our_salt'
test_*.py conformance.py`` returned ZERO files — none of the five legs below
was pinned anywhere, so all five are asserted fresh here (no verify-and-close
against an existing sibling applies).

What this file binds (stdlib only — NO Saxon, NO subprocess of a differential
leg; importing differential.py is cheap because saxonche is imported lazily
inside the Official class, never at module import):

  1. THE HONESTY PIN (T-VHDIFFC.1): ``prove._child_env()`` — with and without
     a shard argument — carries ``DIFF_NO_CACHE == "1"``, so EVERY child the
     buyer-facing reproduce entrypoint spawns bypasses the persistent proof
     cache and re-proves fully live, even on a warm dev box whose
     ``.official-cache/`` holds memoized official-side verdicts.
  2. ``differential._disk_cache_dir()`` returns ``None`` under
     ``DIFF_NO_CACHE=1`` — the bypass is total, not partial.
  3. Poisoned cache files are silent MISSES: a non-JSON garbage file and a
     wrong-schema file ({"schema": 999, ...}) in the cache dir must neither
     raise nor leak their entries out of ``_load_disk_cache()`` (the cache can
     never FAIL the proof, per its own docstring).
  4. ``_our_salt()`` / ``_extraction_salt()`` are deterministic across calls,
     and BOTH are sensitive to ``_DISK_CACHE_SCHEMA``: both salts are lazily
     memoized in module globals (``_OUR_SALT`` / ``_EXTRACTION_SALT``, NOT
     computed at import time), so this test clears those memos and bumps the
     schema int, then asserts both salts change (a schema bump must invalidate
     everything ever cached under the old schema).
  5. Delta round-trip: fresh verdicts staged in ``_DELTA`` survive
     ``_flush_delta()`` -> ``_load_disk_cache()``, and
     ``_consolidate_disk_cache()`` folds multiple delta files into exactly one
     ``cache.json`` holding the merged entries.

Every leg runs against a TEMP dir wired in via the ``DIFF_OFFICIAL_CACHE``
env var — the real ``einvoice/.official-cache/`` is never read or written —
and os.environ plus every touched differential module global is saved and
restored around each leg.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import differential  # noqa: E402
import prove  # noqa: E402

#: The differential.py module globals that memoize cache state. Each test
#: snapshots and restores ALL of them so no leg can leak into another (or
#: into any other test file sharing the process).
_MEMO_GLOBALS = ("_DISK_CACHE", "_EXTRACTION_SALT", "_OUR_SALT", "_DELTA",
                 "_DISK_CACHE_SCHEMA")
_ENV_KEYS = ("DIFF_NO_CACHE", "DIFF_OFFICIAL_CACHE")


class DiffCacheTest(unittest.TestCase):

    def setUp(self):
        self._env_saved = {k: os.environ.get(k) for k in _ENV_KEYS}
        self._globals_saved = {g: getattr(differential, g)
                               for g in _MEMO_GLOBALS}
        # Every leg starts from a clean slate: no bypass, no memoized cache.
        for k in _ENV_KEYS:
            os.environ.pop(k, None)
        differential._DISK_CACHE = None
        differential._DELTA = {}

    def tearDown(self):
        for k, v in self._env_saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        for g, v in self._globals_saved.items():
            setattr(differential, g, v)

    # -- leg 1: the T-VHDIFFC.1 honesty pin ---------------------------------

    def test_child_env_forces_no_cache(self):
        """prove._child_env() must set DIFF_NO_CACHE=1 unconditionally (with
        and without a shard), so every prove.py child re-proves fully live."""
        env = prove._child_env()
        self.assertEqual(env.get("DIFF_NO_CACHE"), "1")
        env_sharded = prove._child_env(shard="0/2")
        self.assertEqual(env_sharded.get("DIFF_NO_CACHE"), "1")
        self.assertEqual(env_sharded.get("DIFF_SHARD"), "0/2")

    def test_child_env_overrides_caller_env(self):
        """Even a caller that explicitly unset/set the variable cannot turn
        the cache back on for a prove.py child."""
        os.environ["DIFF_NO_CACHE"] = ""  # falsy value would ENABLE the cache
        self.assertEqual(prove._child_env().get("DIFF_NO_CACHE"), "1")

    # -- leg 2: the bypass is total ------------------------------------------

    def test_no_cache_env_disables_cache_dir(self):
        os.environ["DIFF_NO_CACHE"] = "1"
        # Even with an explicit cache dir configured, the bypass wins.
        os.environ["DIFF_OFFICIAL_CACHE"] = os.path.join(
            tempfile.gettempdir(), "never-created-diff-cache")
        self.assertIsNone(differential._disk_cache_dir())
        differential._DISK_CACHE = None
        self.assertEqual(differential._load_disk_cache(), {})

    def test_official_cache_env_relocates_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["DIFF_OFFICIAL_CACHE"] = tmp
            self.assertEqual(differential._disk_cache_dir(), tmp)

    # -- leg 3: poisoned cache files are non-raising misses ------------------

    def test_corrupt_and_wrong_schema_files_are_misses(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["DIFF_OFFICIAL_CACHE"] = tmp
            with open(os.path.join(tmp, "corrupt.json"), "wb") as f:
                f.write(b"\x00\xffthis is definitely {{{ not JSON")
            with open(os.path.join(tmp, "wrongschema.json"), "w",
                      encoding="utf-8") as f:
                json.dump({"schema": 999,
                           "entries": {"poison-key": ["BR-XX"]}}, f)
            differential._DISK_CACHE = None
            loaded = differential._load_disk_cache()  # must not raise
            self.assertIsInstance(loaded, dict)
            self.assertNotIn("poison-key", loaded)
            self.assertEqual(loaded, {})

    def test_valid_entries_survive_alongside_poison(self):
        """A good file next to the poisoned ones still loads — proving leg 3
        exercises per-file miss handling, not an accidentally empty dir."""
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["DIFF_OFFICIAL_CACHE"] = tmp
            with open(os.path.join(tmp, "corrupt.json"), "wb") as f:
                f.write(b"not json at all")
            with open(os.path.join(tmp, "good.json"), "w",
                      encoding="utf-8") as f:
                json.dump({"schema": differential._DISK_CACHE_SCHEMA,
                           "entries": {"good-key": ["BR-01", "BR-02"]}}, f)
            differential._DISK_CACHE = None
            loaded = differential._load_disk_cache()
            self.assertEqual(loaded, {"good-key": frozenset(["BR-01",
                                                             "BR-02"])})

    # -- leg 4: salt determinism + schema-version sensitivity ----------------

    def test_salts_deterministic_and_schema_sensitive(self):
        # Determinism: two calls agree (both salts are memoized in the module
        # globals _OUR_SALT / _EXTRACTION_SALT — lazy, not import-time — so
        # clear the memos first to prove the COMPUTATION is deterministic,
        # not merely that the memo returns itself).
        differential._OUR_SALT = None
        differential._EXTRACTION_SALT = None
        our_a = differential._our_salt()
        ext_a = differential._extraction_salt()
        differential._OUR_SALT = None
        differential._EXTRACTION_SALT = None
        self.assertEqual(differential._our_salt(), our_a)
        self.assertEqual(differential._extraction_salt(), ext_a)

        # Schema sensitivity: bump _DISK_CACHE_SCHEMA to a different int,
        # clear the memos, and require BOTH salts to change (tearDown
        # restores the schema constant and both memo globals).
        differential._DISK_CACHE_SCHEMA = (
            self._globals_saved["_DISK_CACHE_SCHEMA"] + 987654)
        differential._OUR_SALT = None
        differential._EXTRACTION_SALT = None
        self.assertNotEqual(differential._our_salt(), our_a)
        self.assertNotEqual(differential._extraction_salt(), ext_a)

    # -- leg 5: flush -> load -> consolidate round-trip -----------------------

    def test_delta_flush_load_consolidate_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["DIFF_OFFICIAL_CACHE"] = tmp

            # Two separate flushes -> two uniquely-named delta files, exactly
            # like two shard subprocesses writing side by side.
            differential._DELTA = {"ours:salt1:fn:sha-a": ["BR-01"]}
            differential._flush_delta()
            self.assertEqual(differential._DELTA, {})  # flush drains it
            differential._DELTA = {"salt2:xslt-sha:sha-b": ["BR-02", "BR-03"]}
            differential._flush_delta()

            deltas = sorted(n for n in os.listdir(tmp)
                            if n.endswith(".json"))
            self.assertEqual(len(deltas), 2, deltas)

            # A fresh load merges both delta files.
            differential._DISK_CACHE = None
            loaded = differential._load_disk_cache()
            self.assertEqual(loaded, {
                "ours:salt1:fn:sha-a": frozenset(["BR-01"]),
                "salt2:xslt-sha:sha-b": frozenset(["BR-02", "BR-03"]),
            })

            # Consolidation folds everything into exactly one cache.json ...
            differential._consolidate_disk_cache()
            remaining = sorted(n for n in os.listdir(tmp)
                               if n.endswith(".json"))
            self.assertEqual(remaining, ["cache.json"])
            with open(os.path.join(tmp, "cache.json"),
                      encoding="utf-8") as f:
                data = json.load(f)
            self.assertEqual(data["schema"], differential._DISK_CACHE_SCHEMA)
            self.assertEqual(data["entries"], {
                "ours:salt1:fn:sha-a": ["BR-01"],
                "salt2:xslt-sha:sha-b": ["BR-02", "BR-03"],
            })

            # ... and a fresh load of the consolidated file sees the same
            # merged entries.
            differential._DISK_CACHE = None
            self.assertEqual(differential._load_disk_cache(), loaded)


def main() -> int:
    result = unittest.main(module=__name__, exit=False,
                           verbosity=2).result
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
