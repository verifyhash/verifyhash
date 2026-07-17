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
  6. CONCURRENCY (T-VHDIFFC.3, ``DiffCacheConcurrencyTest``): the writes were
     ALREADY atomic (unique tmp name + ``os.replace``) but nothing PINNED
     parallel safety. Forked worker PROCESSES (the real shard model — each
     child owns its own ``_DELTA``) hammer ``_flush_delta`` while one worker
     loops ``_consolidate_disk_cache`` and readers loop ``_load_disk_cache``:
     no exception anywhere, the final dir loads cleanly, every surviving
     entry is schema-valid and byte-exact, and a mid-consolidation reader
     sees an old-or-new view — never a partial or garbage entry. Measurement
     verdict: the single-consolidator design cannot even LOSE a committed
     delta (it deletes only files it merged), so the race test asserts FULL
     survival, strictly stronger than the lost-entry-tolerated minimum.
     differential.py needed NO fix and is byte-unchanged by this task.

Every leg runs against a TEMP dir wired in via the ``DIFF_OFFICIAL_CACHE``
env var — the real ``einvoice/.official-cache/`` is never read or written —
and os.environ plus every touched differential module global is saved and
restored around each leg.
"""

from __future__ import annotations

import json
import multiprocessing
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


# -- leg 6 (T-VHDIFFC.3): concurrency — parallel flush/consolidate/load ------
#
# Worker functions live at module level so multiprocessing can target them.
# Each worker re-asserts the env wiring itself (defensive: correct under both
# fork and spawn start methods, though the tests request fork explicitly —
# the real shard model IS forked/exec'd children, and fork gives every child
# its OWN copy of differential's module globals, so concurrent _DELTA staging
# is genuinely parallel instead of a fake shared-global fight).
#
# Failure protocol: any exception in a worker propagates out of the target
# function, which makes multiprocessing print the traceback and set a
# non-zero exitcode; the parent asserts exitcode == 0 for every worker.

_CONC_TIMEOUT = 60          # generous per-join timeout, seconds
_CONC_BARRIER_TIMEOUT = 30  # all workers must reach the start line by then


def _conc_key(worker_id: int, i: int) -> str:
    return "ours:concsalt:w%d:sha-%04d" % (worker_id, i)


def _conc_ids(worker_id: int, i: int) -> list:
    # Two rule ids per entry so a partially-deserialized value could never
    # accidentally equal the expected frozenset.
    return ["BR-%02d" % (i % 7), "BR-CO-%d" % worker_id]


def _conc_setup_env(cache_dir: str):
    os.environ.pop("DIFF_NO_CACHE", None)
    os.environ["DIFF_OFFICIAL_CACHE"] = cache_dir


def _mp_flush_worker(cache_dir, barrier, worker_id, n_flushes):
    """Stage one fresh entry at a time and _flush_delta() it — n_flushes
    uniquely-named delta files, exactly like a busy shard subprocess."""
    _conc_setup_env(cache_dir)
    import differential as d
    barrier.wait(timeout=_CONC_BARRIER_TIMEOUT)
    for i in range(n_flushes):
        d._DELTA = {_conc_key(worker_id, i): _conc_ids(worker_id, i)}
        d._flush_delta()
        assert d._DELTA == {}, "flush must drain _DELTA"


def _mp_consolidate_worker(cache_dir, barrier, stop, max_iters):
    """Loop _consolidate_disk_cache() concurrently with the flushers/readers.
    Bounded by BOTH the stop event (set by the parent once the flushers are
    joined) and a hard iteration cap — no sleeps, no unbounded spinning."""
    _conc_setup_env(cache_dir)
    import differential as d
    barrier.wait(timeout=_CONC_BARRIER_TIMEOUT)
    n = 0
    while n < max_iters and not stop.is_set():
        d._consolidate_disk_cache()
        n += 1


def _mp_reader_worker(cache_dir, barrier, stop, min_iters, max_iters,
                      expected, base_keys):
    """Repeatedly cold-load the cache mid-race and validate EVERY entry:
    each surviving key must belong to the expected universe with its exact
    expected value (never a partial/garbage entry), and the pre-seeded
    baseline entries must be visible in every view (old-or-new cache.json,
    both complete — os.replace leaves no third state)."""
    _conc_setup_env(cache_dir)
    expected = {k: frozenset(v) for k, v in expected.items()}
    base_keys = set(base_keys)
    import differential as d
    barrier.wait(timeout=_CONC_BARRIER_TIMEOUT)
    n = 0
    while (n < min_iters or not stop.is_set()) and n < max_iters:
        d._DISK_CACHE = None          # force a genuine re-read from disk
        view = d._load_disk_cache()   # must never raise
        assert isinstance(view, dict), type(view)
        for k, v in view.items():
            assert k in expected, "garbage key leaked: %r" % (k,)
            assert v == expected[k], \
                "partial/corrupt entry for %r: %r != %r" % (k, v, expected[k])
        missing = base_keys - set(view)
        assert not missing, \
            "reader saw a view missing baseline entries: %r" % (missing,)
        n += 1


class DiffCacheConcurrencyTest(unittest.TestCase):
    """T-VHDIFFC.3: parallel _flush_delta + _consolidate_disk_cache (+ cold
    _load_disk_cache readers) can never corrupt the differential proof cache.
    Everything runs against a temp DIFF_OFFICIAL_CACHE dir — the real
    .official-cache/ is never read or written."""

    def setUp(self):
        self._env_saved = {k: os.environ.get(k) for k in _ENV_KEYS}
        self._globals_saved = {g: getattr(differential, g)
                               for g in _MEMO_GLOBALS}
        for k in _ENV_KEYS:
            os.environ.pop(k, None)
        differential._DISK_CACHE = None
        differential._DELTA = {}
        self._ctx = multiprocessing.get_context("fork")

    def tearDown(self):
        for k, v in self._env_saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        for g, v in self._globals_saved.items():
            setattr(differential, g, v)

    def _join_all(self, procs):
        """Join every worker with a hard timeout, then require exit code 0.
        A hung worker is terminated so the suite itself stays bounded."""
        for p in procs:
            p.join(_CONC_TIMEOUT)
        hung = [p.name for p in procs if p.is_alive()]
        for p in procs:
            if p.is_alive():
                p.terminate()
                p.join(10)
        self.assertEqual(hung, [], "workers hung past %ds" % _CONC_TIMEOUT)
        for p in procs:
            self.assertEqual(p.exitcode, 0,
                             "%s died with exitcode %r (traceback on stderr)"
                             % (p.name, p.exitcode))

    def test_parallel_flush_and_consolidate_race_no_corruption(self):
        """4 forked flush workers (25 entries each) race one worker looping
        _consolidate_disk_cache. No exception anywhere; afterwards the dir
        loads cleanly and holds EXACTLY the 100 expected schema-valid entries
        — with a single consolidator not even a lost entry is possible, so
        full survival is asserted (strictly stronger than the
        lost-entry-tolerated minimum the contract requires)."""
        n_workers, n_flushes = 4, 25
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["DIFF_OFFICIAL_CACHE"] = tmp
            barrier = self._ctx.Barrier(n_workers + 2)  # workers+consol+us
            stop = self._ctx.Event()
            flushers = [
                self._ctx.Process(target=_mp_flush_worker,
                                  args=(tmp, barrier, w, n_flushes),
                                  name="flusher-%d" % w)
                for w in range(n_workers)]
            consolidator = self._ctx.Process(
                target=_mp_consolidate_worker,
                args=(tmp, barrier, stop, 5000), name="consolidator")
            procs = flushers + [consolidator]
            for p in procs:
                p.start()
            # Release everyone at once — real simultaneity, not sleep-luck.
            barrier.wait(timeout=_CONC_BARRIER_TIMEOUT)
            for p in flushers:
                p.join(_CONC_TIMEOUT)
            stop.set()  # consolidation overlapped the ENTIRE flush window
            self._join_all(procs)

            expected = {_conc_key(w, i): frozenset(_conc_ids(w, i))
                        for w in range(n_workers) for i in range(n_flushes)}
            # Final state loads cleanly (no exception) and byte-exactly.
            differential._DISK_CACHE = None
            self.assertEqual(differential._load_disk_cache(), expected)
            # A last consolidation folds every survivor into one cache.json
            # whose on-disk JSON is schema-valid, and a cold re-load still
            # sees the identical entries.
            differential._consolidate_disk_cache()
            leftovers = sorted(n for n in os.listdir(tmp)
                               if n.endswith(".json"))
            self.assertEqual(leftovers, ["cache.json"])
            with open(os.path.join(tmp, "cache.json"),
                      encoding="utf-8") as f:
                data = json.load(f)  # must be complete, well-formed JSON
            self.assertEqual(data["schema"], differential._DISK_CACHE_SCHEMA)
            self.assertEqual(
                {k: frozenset(v) for k, v in data["entries"].items()},
                expected)
            differential._DISK_CACHE = None
            self.assertEqual(differential._load_disk_cache(), expected)

    def test_concurrent_reader_race_old_or_new_view_never_partial(self):
        """Cold _load_disk_cache readers race the flushers AND the
        consolidator. Every view a reader gets must (a) never raise, (b)
        contain only exact expected entries — no partial/garbage value, and
        (c) always include the pre-seeded baseline cache.json entries: the
        old-or-new guarantee (a delta may legitimately appear as a miss
        before consolidation catches up, the baseline may not vanish)."""
        n_workers, n_flushes, n_readers = 3, 15, 2
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["DIFF_OFFICIAL_CACHE"] = tmp
            base = {"base:concsalt:sha-%d" % i: ["BR-B%d" % i, "BR-CO-B"]
                    for i in range(5)}
            with open(os.path.join(tmp, "cache.json"), "w",
                      encoding="utf-8") as f:
                json.dump({"schema": differential._DISK_CACHE_SCHEMA,
                           "entries": base}, f)
            expected = dict(base)
            expected.update({_conc_key(w, i): _conc_ids(w, i)
                             for w in range(n_workers)
                             for i in range(n_flushes)})

            barrier = self._ctx.Barrier(n_workers + 1 + n_readers + 1)
            stop = self._ctx.Event()
            flushers = [
                self._ctx.Process(target=_mp_flush_worker,
                                  args=(tmp, barrier, w, n_flushes),
                                  name="flusher-%d" % w)
                for w in range(n_workers)]
            consolidator = self._ctx.Process(
                target=_mp_consolidate_worker,
                args=(tmp, barrier, stop, 5000), name="consolidator")
            readers = [
                self._ctx.Process(target=_mp_reader_worker,
                                  args=(tmp, barrier, stop, 25, 10000,
                                        expected, sorted(base)),
                                  name="reader-%d" % r)
                for r in range(n_readers)]
            procs = flushers + [consolidator] + readers
            for p in procs:
                p.start()
            barrier.wait(timeout=_CONC_BARRIER_TIMEOUT)
            for p in flushers:
                p.join(_CONC_TIMEOUT)
            stop.set()
            self._join_all(procs)

            # And the post-race state is exact (baseline + every flush).
            differential._DISK_CACHE = None
            self.assertEqual(
                differential._load_disk_cache(),
                {k: frozenset(v) for k, v in expected.items()})


def main() -> int:
    result = unittest.main(module=__name__, exit=False,
                           verbosity=2).result
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
