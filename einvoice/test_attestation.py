"""Tests for the conformance-claim attestation (gen_attestation + verify).

Proves the three properties that make the attestation trustworthy to an
independent evaluator:

  (a) BYTE-REPRODUCIBILITY -- gen_attestation regenerates attestation.json
      byte-for-byte identically to the committed file (determinism is the
      product; no wall-clock timestamp leaks into the hashed body).
  (b) CLEAN VERIFY -- the verify path exits 0 on the committed tree.
  (c) TAMPER DETECTION -- perturbing a recorded corpus sha, a rule count, or a
      pass rate (each in an isolated temp copy, never the committed sources)
      makes the verify path exit non-zero.

Standard library only.
"""

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

import gen_attestation


# Small source/tool files copied into each isolated temp tree. The (large,
# read-only) corpus/ tree is symlinked instead of copied so tamper tests stay
# fast; it is never mutated.
_TREE_FILES = [
    "gen_attestation.py",
    "gen_sbom.py",
    "verify_attestation.py",
    "attestation.json",
    "testsuite_conformance.json",
    "export/rules.json",
    "export/coverage.json",
    "sbom/bom.json",
]


def _make_tree(dst):
    """Populate ``dst`` with a runnable copy of the attestation toolchain."""
    dst = Path(dst)
    for rel in _TREE_FILES:
        src = HERE / rel
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
    # corpus/ is only read (check 2 re-walks it); symlink to the real tree.
    os.symlink(HERE / "corpus", dst / "corpus")
    return dst


def _run_verify(cwd):
    """Run verify_attestation.py in ``cwd``; return the CompletedProcess."""
    return subprocess.run(
        [sys.executable, "verify_attestation.py"],
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )


def _rewrite_json(path, mutate):
    """Load JSON at ``path``, apply ``mutate(obj)`` in place, write it back."""
    with open(path, "r", encoding="utf-8") as fh:
        obj = json.load(fh)
    mutate(obj)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)


class TestByteReproducibility(unittest.TestCase):
    def test_regenerates_byte_identically(self):
        committed = (HERE / "attestation.json").read_bytes()
        regenerated = gen_attestation.attestation_json().encode("utf-8")
        self.assertEqual(
            regenerated,
            committed,
            "gen_attestation must regenerate attestation.json byte-for-byte; "
            "regenerate with `python3 gen_attestation.py` and commit.",
        )

    def test_regeneration_is_stable_across_two_runs(self):
        a = gen_attestation.attestation_json()
        b = gen_attestation.attestation_json()
        self.assertEqual(a, b)

    def test_no_timestamp_in_hashed_body(self):
        doc = gen_attestation.build_attestation()
        blob = json.dumps(doc)
        for banned in ("issued_at", "timestamp", "generated_at", "date"):
            self.assertNotIn(banned, blob)

    def test_content_hash_covers_body(self):
        doc = gen_attestation.build_attestation()
        import hashlib
        expected = hashlib.sha256(
            gen_attestation.canonical_json(doc["attestation"]).encode("utf-8")
        ).hexdigest()
        self.assertEqual(doc["content_sha256"], expected)

    def test_attestation_records_all_required_facts(self):
        body = gen_attestation.build_attestation()["attestation"]
        # rule counts
        self.assertEqual(body["rules"]["count"], 286)
        self.assertIn("by_family", body["rules"])
        self.assertTrue(body["rules"]["rulesets"])
        # coverage headline
        sb = body["coverage"]["syntax_binding"]
        self.assertEqual(sb["ubl"], {"proven": 741, "total": 756})
        self.assertEqual(sb["cii"], {"proven": 554, "total": 583})
        # UBL + CII in-scope pass rates
        self.assertEqual(body["testsuite_conformance"]["ubl"]["total"], 39)
        self.assertEqual(body["testsuite_conformance"]["cii"]["total"], 39)
        # per-corpus pinned sha256 set
        self.assertEqual(len(body["corpus"]), 3)
        for entry in body["corpus"]:
            self.assertEqual(len(entry["sha256"]), 64)
            int(entry["sha256"], 16)  # hex


class TestCleanVerify(unittest.TestCase):
    def test_verify_exits_zero_on_committed_tree(self):
        proc = _run_verify(HERE)
        self.assertEqual(
            proc.returncode, 0,
            "verify must pass on the clean committed tree.\n"
            "stdout=%s\nstderr=%s" % (proc.stdout, proc.stderr),
        )


class TestDocReflectsAttestation(unittest.TestCase):
    """The buyer-facing doc section must state ONLY numbers the attestation
    pins, must name the one-command verifier, and that command must exit 0 --
    so doc-drift (a stale number) or a broken verifier fails a fast gate."""

    @staticmethod
    def _norm(text):
        # collapse markdown bold + line wraps so "**554 of\n  583 CII**"
        # matches the canonical "554 of 583 CII".
        import re
        return re.sub(r"\s+", " ", text.replace("*", ""))

    def _load(self):
        att = json.loads((HERE / "attestation.json").read_text(encoding="utf-8"))
        body = att["attestation"]
        readme = self._norm((HERE / "README.md").read_text(encoding="utf-8"))
        return body, readme

    def test_doc_names_the_verifier(self):
        readme = (HERE / "README.md").read_text(encoding="utf-8")
        self.assertIn("verify_attestation.py", readme)
        self.assertIn(
            "python3 verify_attestation.py", readme,
            "the doc must state the exact one-command buyer verify.",
        )

    def test_prove_points_to_the_verifier(self):
        prove = (HERE / "prove.py").read_text(encoding="utf-8")
        self.assertIn("verify_attestation.py", prove)

    def test_every_doc_number_equals_attestation(self):
        body, readme = self._load()

        rules = body["rules"]["count"]
        self.assertIn("%d business rules" % rules, readme,
                      "rule count in the doc must equal attestation.json")

        sb = body["coverage"]["syntax_binding"]
        self.assertIn("%d of %d UBL" % (sb["ubl"]["proven"], sb["ubl"]["total"]),
                      readme)
        self.assertIn("%d of %d CII" % (sb["cii"]["proven"], sb["cii"]["total"]),
                      readme)

        ts = body["testsuite_conformance"]
        self.assertIn("%d of %d UBL" % (ts["ubl"]["accepted"], ts["ubl"]["total"]),
                      readme)
        self.assertIn("%d of %d CII" % (ts["cii"]["accepted"], ts["cii"]["total"]),
                      readme)

        # the doc claims a corpus count; it must equal the pinned set size.
        self.assertIn("%d vendored official corpora" % len(body["corpus"]),
                      readme)

    def test_verifier_exits_zero_so_doc_claim_holds(self):
        proc = _run_verify(HERE)
        self.assertEqual(
            proc.returncode, 0,
            "the one-command buyer verify the doc advertises must exit 0 on the "
            "clean tree.\nstdout=%s\nstderr=%s" % (proc.stdout, proc.stderr),
        )


class TestTamperDetection(unittest.TestCase):
    def _assert_tamper_detected(self, mutate_rel, mutate):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tree = _make_tree(tmp)
            # sanity: the clean temp copy verifies before we tamper.
            clean = _run_verify(tree)
            self.assertEqual(
                clean.returncode, 0,
                "temp copy should verify clean before tampering.\n"
                "stderr=%s" % clean.stderr,
            )
            _rewrite_json(tree / mutate_rel, mutate)
            tampered = _run_verify(tree)
            self.assertNotEqual(
                tampered.returncode, 0,
                "verify must FAIL after tampering with %s.\nstdout=%s\n"
                "stderr=%s" % (mutate_rel, tampered.stdout, tampered.stderr),
            )
            return tampered

    def test_perturbing_rule_count_is_detected(self):
        def mutate(obj):
            obj["rule_count"] = obj["rule_count"] - 1
        self._assert_tamper_detected("export/rules.json", mutate)

    def test_perturbing_pass_rate_is_detected(self):
        def mutate(obj):
            obj["summary"]["in_scope_ubl_accepted"] -= 1
        self._assert_tamper_detected("testsuite_conformance.json", mutate)

    def test_perturbing_recorded_corpus_sha_is_detected(self):
        def mutate(obj):
            comp = obj["components"][0]
            h = comp["hashes"][0]["content"]
            # flip the first hex nibble
            flipped = ("f" if h[0] != "f" else "0") + h[1:]
            comp["hashes"][0]["content"] = flipped
        self._assert_tamper_detected("sbom/bom.json", mutate)

    def test_perturbing_coverage_headline_is_detected(self):
        def mutate(obj):
            obj["syntax_binding"]["ubl"]["proven"] -= 1
        self._assert_tamper_detected("export/coverage.json", mutate)

    def test_perturbing_actual_corpus_bytes_is_detected(self):
        """Editing a real corpus file (without regenerating the SBOM) is caught
        by the corpus-bytes binding check, even though the recorded shas and all
        source JSONs are untouched."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tree = Path(tmp) / "einv"
            tree.mkdir()
            for rel in _TREE_FILES:
                target = tree / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(HERE / rel, target)
            # a REAL copy of corpus this time, so we can mutate a byte.
            shutil.copytree(HERE / "corpus", tree / "corpus")
            clean = _run_verify(tree)
            self.assertEqual(clean.returncode, 0, clean.stderr)
            # append a byte to some vendored file.
            victim = next(
                p for p in (tree / "corpus").rglob("*")
                if p.is_file() and p.suffix not in (".pyc", ".pyo")
            )
            with open(victim, "ab") as fh:
                fh.write(b"\n<!-- tamper -->\n")
            tampered = _run_verify(tree)
            self.assertNotEqual(
                tampered.returncode, 0,
                "editing a corpus byte must fail the corpus-bytes binding.\n"
                "stderr=%s" % tampered.stderr,
            )


if __name__ == "__main__":
    unittest.main()
