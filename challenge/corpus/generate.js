#!/usr/bin/env node
"use strict";

// challenge/corpus/generate.js — T-52.1: the versioned tamper-class taxonomy + the
// DETERMINISTIC poisoned-corpus generator.
//
// WHAT THIS IS
//   The 60-second challenge (challenge/) proves the seal catches ONE byte-edit. A cold buyer's
//   #1 objection, though, is broader: "does your verifier catch the OTHER ways an artifact gets
//   poisoned — a deleted row, a renamed file, a stripped license, a forged Merkle root, a
//   corrupted seal kind — across the kinds of packets MY business seals?" This generator answers
//   that mechanically. It emits a committed, versioned, self-auditing RED-TEAM CORPUS:
//
//     challenge/corpus/clean/       — honest CLEAN fixtures, grouped by business VERTICAL. Each
//                                     clean packet VERIFIES (exit 0) before any mutation — the
//                                     corpus is HONEST: the poison, not a broken fixture, is what
//                                     the verifier catches.
//     challenge/corpus/poisoned/    — one POISONED packet per tamper class: a byte-for-byte copy
//                                     of its clean source plus EXACTLY ONE documented mutation,
//                                     and the seal that mutation must trip.
//     challenge/corpus/manifest.json — the TAXONOMY: every class with a unique id, the vertical,
//                                     the clean fixture it derives from, the mutation in one line,
//                                     and the EXPECTED standalone-verifier exit (∈ {2, 3}).
//
// EXIT-CODE CONTRACT of the committed standalone verifier (verifier/dist/verify-vh-standalone.js),
// the SAME file the challenge ships and a prospect runs:
//     0 = VERIFIED · 3 = REJECTED (tamper: CHANGED / MISSING / forged root) · 2 = usage
//     (unrecognized artifact kind) · 1 = IO/parse error.
//   Every poisoned class in this corpus is built to trip exit 3 (a content / structural / crypto
//   rejection) or exit 2 (a structurally-unrecognized seal). Exit 1 (malformed JSON / missing
//   field) is a DEGENERATE input, not a tamper a verifier should "accept-or-reject", so it is
//   deliberately OUT of the taxonomy.
//
// DETERMINISM (the acceptance bar)
//   `node challenge/corpus/generate.js` is a PURE function of the constants in this file. It wipes
//   clean/, poisoned/ and manifest.json and re-emits them byte-for-byte every run (no timestamps,
//   no randomness, sorted keys, fixed seal note). test/challenge.corpus.test.js asserts re-running
//   the generator produces NO drift, that every clean fixture verifies CLEAN first, and that every
//   poisoned packet differs from its clean source in EXACTLY the documented way and trips EXACTLY
//   the documented exit.
//
//   The seal is built by SHELLING OUT to the committed, zero-dependency standalone SEALER
//   (verifier/dist/seal-vh-standalone.js) — the SAME artifact a free-tier prospect uses — so the
//   corpus's seals are byte-identical to a real one and this generator forks NO crypto. NO
//   production code is edited.
//
// Usage:
//   node challenge/corpus/generate.js          # re-emit the corpus (idempotent)
//   node challenge/corpus/generate.js --check   # emit to a temp dir and DIFF vs committed (no write)

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const HERE = __dirname; // challenge/corpus/
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SEALER = path.join(REPO_ROOT, "verifier", "dist", "seal-vh-standalone.js");

// Outputs land under HERE by default. A test/CI may set VH_CORPUS_OUT to regenerate into a temp
// directory (proving determinism) WITHOUT touching the committed tree; the SEALER is always resolved
// relative to this file's real repo location, so the override moves only the WRITE target.
const OUT_DIR = process.env.VH_CORPUS_OUT
  ? path.resolve(process.env.VH_CORPUS_OUT)
  : HERE;

const CLEAN_DIR = path.join(OUT_DIR, "clean");
const POISONED_DIR = path.join(OUT_DIR, "poisoned");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");

const CORPUS_VERSION = 1; // bump when the taxonomy's shape changes.

// ---------------------------------------------------------------------------
// CLEAN FIXTURES, grouped by business VERTICAL.
//
// Each vertical is a small, honest packet a real customer in that domain would seal. Content is
// fixed bytes (a trailing newline where a real file would have one) so the seal — and therefore
// the whole corpus — is reproducible. Every file's bytes are the GROUND TRUTH a mutation departs
// from; the test re-derives them to prove "differs in EXACTLY the documented way".
// ---------------------------------------------------------------------------

const CLEAN_FIXTURES = {
  // VERTICAL 1 — finance: an escrow / property-management reconciliation packet.
  finance: {
    "ledger.csv":
      "entry_id,date,account,debit_cents,credit_cents,memo\n" +
      "L-0001,2026-01-04,trust:operating,0,250000,deposit received\n" +
      "L-0002,2026-01-07,trust:operating,75000,0,vendor payout\n" +
      "L-0003,2026-01-11,trust:reserve,0,50000,security deposit\n",
    "reconciliation.json":
      JSON.stringify(
        {
          period: "2026-01",
          openingCents: 0,
          closingCents: 225000,
          bankStatementCents: 225000,
          inTrust: true,
        },
        null,
        2
      ) + "\n",
    "README.txt":
      "Escrow reconciliation packet for 2026-01.\n" +
      "ledger.csv is the trust sub-ledger; reconciliation.json is the bank tie-out.\n",
  },

  // VERTICAL 2 — ai-data: an AI training-data provenance packet (DataLedger).
  "ai-data": {
    "samples.jsonl":
      JSON.stringify({ id: "s-1", text: "the quick brown fox", label: "animal" }) +
      "\n" +
      JSON.stringify({ id: "s-2", text: "a slow green turtle", label: "animal" }) +
      "\n" +
      JSON.stringify({ id: "s-3", text: "a bright red apple", label: "fruit" }) +
      "\n",
    "LICENSE.txt":
      "Dataset license: CC-BY-4.0.\n" +
      "Source: curated public-domain corpus, attribution required.\n" +
      "Every sample in samples.jsonl is cleared for training under this license.\n",
    "provenance.json":
      JSON.stringify(
        {
          dataset: "demo-animals-fruit",
          sampleCount: 3,
          collectedBy: "data-team",
          license: "CC-BY-4.0",
        },
        null,
        2
      ) + "\n",
  },

  // VERTICAL 3 — software: a release / SBOM packet.
  software: {
    "sbom.json":
      JSON.stringify(
        {
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          components: [
            { name: "left-pad", version: "1.3.0", license: "WTFPL" },
            { name: "tiny-json", version: "2.1.4", license: "MIT" },
          ],
        },
        null,
        2
      ) + "\n",
    "RELEASE-NOTES.md":
      "# release v3.2.0\n\n" +
      "- fix: off-by-one in the pager\n" +
      "- chore: bump tiny-json to 2.1.4\n",
    "checksums.txt":
      "0000000000000000000000000000000000000000000000000000000000000001  app.bin\n" +
      "0000000000000000000000000000000000000000000000000000000000000002  app.wasm\n",
  },

  // VERTICAL 4 — legal: a signed-contract evidence packet.
  legal: {
    "agreement.txt":
      "MASTER SERVICES AGREEMENT\n\n" +
      "1. Term. This Agreement is effective for twelve (12) months.\n" +
      "2. Fees. Customer shall pay USD 10,000 per month, net 30.\n" +
      "3. Termination. Either party may terminate for cause on 30 days' notice.\n",
    "signature-page.txt":
      "SIGNATURE PAGE\n\n" +
      "ACME CORP            COUNTERPARTY LLC\n" +
      "By: /s/ A. Founder   By: /s/ B. Buyer\n" +
      "Date: 2026-01-15     Date: 2026-01-15\n",
    "exhibit-a.txt":
      "EXHIBIT A — STATEMENT OF WORK\n\n" +
      "Deliverable 1: the gizmo, delivered by 2026-03-01.\n",
  },
};

// ---------------------------------------------------------------------------
// THE TAMPER-CLASS TAXONOMY.
//
// One entry per poisoned class. `mutate(packetDir, sealPath)` applies EXACTLY ONE documented
// change — either to a packet file (content/structural classes, exit 3) or to the seal JSON
// (crypto/structural-seal classes, exits 3 and 2) — leaving everything else byte-identical to the
// clean source. The 1-line `mutation` string is the human label the manifest publishes.
//
// Each `mutate` returns a small DESCRIPTOR the test cross-checks against the actual on-disk diff,
// so "differs in EXACTLY the documented way" is asserted, not asserted-by-comment:
//   { target, op }  op ∈ "edit-content" | "delete-file" | "rename-file" | "truncate-file" |
//                        "edit-seal-root" | "edit-seal-kind"
//   - edit-content : packet file `target` differs from clean (same path still present)
//   - truncate-file: packet file `target` is now empty (a content edit special-case)
//   - delete-file  : packet file `target` is gone (path no longer present)
//   - rename-file  : packet file `target` is gone; `renamedTo` is present (unknown to the seal)
//   - edit-seal-*  : NO packet file changed; only the named seal field differs from a clean seal
// ---------------------------------------------------------------------------

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeSealJSON(p, obj) {
  // The standalone sealer emits compact (no-pretty) JSON; preserve that so a clean re-seal and a
  // mutated seal differ ONLY in the mutated field, never in formatting.
  fs.writeFileSync(p, JSON.stringify(obj));
}

const TAMPER_CLASSES = [
  // ----- finance -----
  {
    id: "finance-amount-edited",
    vertical: "finance",
    fixture: "finance",
    expectedExit: 3,
    mutation: "Flip one digit in a ledger credit amount (250000 -> 250100 cents).",
    mutate(packetDir) {
      const t = "ledger.csv";
      const p = path.join(packetDir, t);
      const before = fs.readFileSync(p, "utf8");
      const after = before.replace("0,250000,deposit received", "0,250100,deposit received");
      if (after === before) throw new Error("finance-amount-edited: pattern not found");
      fs.writeFileSync(p, after);
      return { target: t, op: "edit-content" };
    },
  },
  {
    id: "finance-tie-out-dropped",
    vertical: "finance",
    fixture: "finance",
    expectedExit: 3,
    mutation: "Delete the bank tie-out file (reconciliation.json) the seal still references.",
    mutate(packetDir) {
      const t = "reconciliation.json";
      fs.rmSync(path.join(packetDir, t));
      return { target: t, op: "delete-file" };
    },
  },

  // ----- ai-data -----
  {
    id: "ai-data-sample-swapped",
    vertical: "ai-data",
    fixture: "ai-data",
    expectedExit: 3,
    mutation: "Relabel one training sample in samples.jsonl (label animal -> fruit).",
    mutate(packetDir) {
      const t = "samples.jsonl";
      const p = path.join(packetDir, t);
      const before = fs.readFileSync(p, "utf8");
      const after = before.replace('"a slow green turtle","label":"animal"', '"a slow green turtle","label":"fruit"');
      if (after === before) throw new Error("ai-data-sample-swapped: pattern not found");
      fs.writeFileSync(p, after);
      return { target: t, op: "edit-content" };
    },
  },
  {
    id: "ai-data-license-stripped",
    vertical: "ai-data",
    fixture: "ai-data",
    expectedExit: 3,
    mutation: "Truncate LICENSE.txt to empty (strip the provenance license).",
    mutate(packetDir) {
      const t = "LICENSE.txt";
      fs.writeFileSync(path.join(packetDir, t), "");
      return { target: t, op: "truncate-file" };
    },
  },
  {
    id: "ai-data-file-renamed",
    vertical: "ai-data",
    fixture: "ai-data",
    expectedExit: 3,
    mutation: "Rename provenance.json -> provenance.bak (the sealed path is now MISSING).",
    mutate(packetDir) {
      const t = "provenance.json";
      const renamedTo = "provenance.bak";
      fs.renameSync(path.join(packetDir, t), path.join(packetDir, renamedTo));
      return { target: t, op: "rename-file", renamedTo };
    },
  },

  // ----- software -----
  {
    id: "software-sbom-injected",
    vertical: "software",
    fixture: "software",
    expectedExit: 3,
    mutation: "Inject an undeclared dependency line into sbom.json.",
    mutate(packetDir) {
      const t = "sbom.json";
      const p = path.join(packetDir, t);
      const before = fs.readFileSync(p, "utf8");
      const after = before.replace('"name": "left-pad"', '"name": "evil-pad"');
      if (after === before) throw new Error("software-sbom-injected: pattern not found");
      fs.writeFileSync(p, after);
      return { target: t, op: "edit-content" };
    },
  },
  {
    id: "software-checksum-edited",
    vertical: "software",
    fixture: "software",
    expectedExit: 3,
    mutation: "Alter one published artifact checksum digit in checksums.txt.",
    mutate(packetDir) {
      const t = "checksums.txt";
      const p = path.join(packetDir, t);
      const before = fs.readFileSync(p, "utf8");
      const after = before.replace(
        "0000000000000000000000000000000000000000000000000000000000000001  app.bin",
        "00000000000000000000000000000000000000000000000000000000000000ff  app.bin"
      );
      if (after === before) throw new Error("software-checksum-edited: pattern not found");
      fs.writeFileSync(p, after);
      return { target: t, op: "edit-content" };
    },
  },

  // ----- legal -----
  {
    id: "legal-clause-altered",
    vertical: "legal",
    fixture: "legal",
    expectedExit: 3,
    mutation: "Alter the fee amount in agreement.txt (USD 10,000 -> USD 1,000 per month).",
    mutate(packetDir) {
      const t = "agreement.txt";
      const p = path.join(packetDir, t);
      const before = fs.readFileSync(p, "utf8");
      const after = before.replace("pay USD 10,000 per month", "pay USD 1,000 per month");
      if (after === before) throw new Error("legal-clause-altered: pattern not found");
      fs.writeFileSync(p, after);
      return { target: t, op: "edit-content" };
    },
  },
  {
    id: "legal-signature-page-dropped",
    vertical: "legal",
    fixture: "legal",
    expectedExit: 3,
    mutation: "Delete the executed signature-page.txt the seal references.",
    mutate(packetDir) {
      const t = "signature-page.txt";
      fs.rmSync(path.join(packetDir, t));
      return { target: t, op: "delete-file" };
    },
  },

  // ----- cross-vertical SEAL tampers (the packet bytes stay clean; the SEAL is attacked) -----
  {
    id: "seal-root-forged",
    vertical: "finance",
    fixture: "finance",
    expectedExit: 3,
    mutation:
      "Forge the seal's Merkle root (packet bytes untouched); the verifier RE-DERIVES the root and rejects.",
    mutate(packetDir, sealPath) {
      // NO packet file changes. Replace the root with a well-formed but wrong 32-byte hex.
      const seal = readJSON(sealPath);
      seal.root = "0x" + "ab".repeat(32);
      writeSealJSON(sealPath, seal);
      return { target: null, op: "edit-seal-root" };
    },
  },
  {
    id: "seal-kind-corrupted",
    vertical: "software",
    fixture: "software",
    expectedExit: 2,
    mutation:
      "Corrupt the seal's `kind` to an unrecognized value; the verifier cannot classify it (usage error).",
    mutate(packetDir, sealPath) {
      // NO packet file changes. The seal is structurally a JSON object but not a kind verify-vh knows.
      const seal = readJSON(sealPath);
      seal.kind = "vh.NOT-A-REAL-KIND";
      writeSealJSON(sealPath, seal);
      return { target: null, op: "edit-seal-kind" };
    },
  },
];

// ---------------------------------------------------------------------------
// Generation.
// ---------------------------------------------------------------------------

// Deterministic recursive copy (sorted), so a poisoned packet starts byte-identical to its clean
// fixture. We only ever copy regular files (the fixtures are flat, but this is future-proof).
function copyTree(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir).sort()) {
    const s = path.join(srcDir, name);
    const d = path.join(dstDir, name);
    const st = fs.lstatSync(s);
    if (st.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Build the seal over a directory using the COMMITTED standalone sealer (forks no crypto). Returns
// the seal as a parsed object AND writes it to `outPath`. NODE_PATH is cleared so the sealer runs
// exactly as a zero-install prospect would (it cannot reach this repo's node_modules).
function sealDir(dir, outPath) {
  const r = spawnSync(process.execPath, [SEALER, dir, "-o", outPath], {
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "" },
  });
  if (r.status !== 0) {
    throw new Error(
      `seal-vh-standalone failed for ${dir} (exit ${r.status}): ${r.stderr || r.stdout}`
    );
  }
  return readJSON(outPath);
}

// Write the clean fixtures from the in-code constants (deterministic bytes).
function emitCleanFixtures() {
  fs.rmSync(CLEAN_DIR, { recursive: true, force: true });
  for (const vertical of Object.keys(CLEAN_FIXTURES).sort()) {
    const vdir = path.join(CLEAN_DIR, vertical);
    fs.mkdirSync(vdir, { recursive: true });
    const files = CLEAN_FIXTURES[vertical];
    for (const rel of Object.keys(files).sort()) {
      fs.writeFileSync(path.join(vdir, rel), files[rel]);
    }
  }
}

// Emit poisoned packets + accumulate manifest rows. Returns the manifest `classes` array.
function emitPoisoned() {
  fs.rmSync(POISONED_DIR, { recursive: true, force: true });
  fs.mkdirSync(POISONED_DIR, { recursive: true });

  const rows = [];
  const seenIds = new Set();

  for (const cls of TAMPER_CLASSES) {
    if (seenIds.has(cls.id)) throw new Error(`duplicate tamper-class id: ${cls.id}`);
    seenIds.add(cls.id);

    const cleanFixtureDir = path.join(CLEAN_DIR, cls.fixture);
    if (!fs.existsSync(cleanFixtureDir)) {
      throw new Error(`class ${cls.id}: clean fixture "${cls.fixture}" does not exist`);
    }

    const outDir = path.join(POISONED_DIR, cls.id);
    const packetDir = path.join(outDir, "packet");
    const sealPath = path.join(outDir, "seal.vhevidence.json");

    // 1. Copy the clean fixture into the poisoned packet folder (byte-identical start).
    copyTree(cleanFixtureDir, packetDir);

    // 2. Seal the (still clean) packet — the seal commits to the HONEST bytes.
    sealDir(packetDir, sealPath);

    // 3. Apply EXACTLY ONE documented mutation (to the packet OR the seal).
    const descriptor = cls.mutate(packetDir, sealPath);

    rows.push({
      id: cls.id,
      vertical: cls.vertical,
      cleanFixture: path.posix.join("clean", cls.fixture),
      poisonedPacket: path.posix.join("poisoned", cls.id, "packet"),
      seal: path.posix.join("poisoned", cls.id, "seal.vhevidence.json"),
      mutation: cls.mutation,
      mutationOp: descriptor.op,
      mutationTarget: descriptor.target || null,
      ...(descriptor.renamedTo ? { renamedTo: descriptor.renamedTo } : {}),
      expectedExit: cls.expectedExit,
    });
  }
  return rows;
}

// Build the manifest object (the published taxonomy). Stable key order + sorted derived sets so the
// serialized bytes are reproducible.
function buildManifest(classRows) {
  const verticals = [...new Set(classRows.map((r) => r.vertical))].sort();
  return {
    kind: "vh.challenge-corpus",
    corpusVersion: CORPUS_VERSION,
    note:
      "Versioned adversarial CONFORMANCE corpus for the verifyhash standalone evidence-seal verifier " +
      "(verifier/dist/verify-vh-standalone.js). Each class is one CLEAN business packet plus EXACTLY ONE " +
      "documented mutation that the verifier must REJECT. `expectedExit` is the standalone verifier's own " +
      "contract: 3 = REJECTED (tamper: CHANGED / MISSING / forged root), 2 = usage (unrecognized seal kind). " +
      "Regenerate with `node challenge/corpus/generate.js`; the output is deterministic (byte-for-byte stable).",
    exitCodes: {
      "0": "VERIFIED",
      "2": "usage (unrecognized artifact kind)",
      "3": "REJECTED (tamper: CHANGED / MISSING / forged root)",
    },
    verticals,
    classCount: classRows.length,
    classes: classRows,
  };
}

function writeManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

// Generate the WHOLE corpus into the committed locations. Returns the manifest object.
function generate() {
  if (!fs.existsSync(SEALER)) {
    throw new Error(`standalone sealer not found at: ${SEALER}`);
  }
  emitCleanFixtures();
  const classRows = emitPoisoned();
  const manifest = buildManifest(classRows);
  writeManifest(manifest);
  return manifest;
}

// --check: regenerate into a TEMP output dir (via the VH_CORPUS_OUT override, in a child process so
// this run's constants aren't already bound) and diff it against the committed corpus WITHOUT
// touching the committed tree. Returns { ok, drifted }.
function snapshotOutputs(root) {
  const out = {};
  const walk = (abs, rel) => {
    if (!fs.existsSync(abs)) return;
    for (const name of fs.readdirSync(abs).sort()) {
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(a);
      if (st.isDirectory()) walk(a, r);
      else out[r] = fs.readFileSync(a).toString("hex");
    }
  };
  walk(path.join(root, "clean"), "clean");
  walk(path.join(root, "poisoned"), "poisoned");
  if (fs.existsSync(path.join(root, "manifest.json"))) {
    out["manifest.json"] = fs.readFileSync(path.join(root, "manifest.json")).toString("hex");
  }
  return out;
}

function checkNoDrift() {
  const committed = snapshotOutputs(HERE);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vh-corpus-check-"));
  try {
    const r = spawnSync(process.execPath, [__filename], {
      encoding: "utf8",
      env: { ...process.env, VH_CORPUS_OUT: tmp, NODE_PATH: "" },
    });
    if (r.status !== 0) {
      throw new Error(`regeneration for --check failed (exit ${r.status}): ${r.stderr || r.stdout}`);
    }
    const fresh = snapshotOutputs(tmp);
    const drifted = Object.keys({ ...committed, ...fresh }).filter((k) => committed[k] !== fresh[k]);
    return { ok: drifted.length === 0, drifted };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    const { ok, drifted } = checkNoDrift();
    if (ok) {
      console.log("challenge corpus: NO DRIFT — committed bytes match a fresh regeneration.");
      process.exit(0);
    } else {
      console.error("challenge corpus: DRIFT DETECTED in:\n  " + drifted.join("\n  "));
      console.error("Run `node challenge/corpus/generate.js` and commit the result.");
      process.exit(1);
    }
  } else {
    const manifest = generate();
    console.log(
      `challenge corpus regenerated: ${manifest.classCount} tamper classes across ` +
        `${manifest.verticals.length} verticals (${manifest.verticals.join(", ")}).`
    );
    console.log(`  clean fixtures : ${path.relative(REPO_ROOT, CLEAN_DIR)}/`);
    console.log(`  poisoned       : ${path.relative(REPO_ROOT, POISONED_DIR)}/`);
    console.log(`  manifest       : ${path.relative(REPO_ROOT, MANIFEST_PATH)}`);
  }
}

module.exports = {
  CORPUS_VERSION,
  HERE,
  CLEAN_DIR,
  POISONED_DIR,
  MANIFEST_PATH,
  SEALER,
  CLEAN_FIXTURES,
  TAMPER_CLASSES,
  generate,
  buildManifest,
};
