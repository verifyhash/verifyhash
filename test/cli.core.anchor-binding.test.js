"use strict";

// test/cli.core.anchor-binding.test.js — honest acceptance tests for the PURE anchor-binding core
// (cli/core/anchor-binding.js, T-70.1): closed-table digest extraction, the anchored-receipt
// container, and the offline binding verify.
//
// WHAT THIS PROVES (the T-70.1 acceptance criteria, each as a test):
//   (1) For EACH kind in the closed table a deterministic fixture yields a STABLE, DOCUMENTED digest
//       (pinned hex below) and build -> verify round-trips to ok:true. The digest equals a DIRECT
//       computation through the shipped validator (reuse, not fork).
//   (2) Tamper matrix per kind: EVERY primitive value byte of every fixture artifact is mutated one
//       at a time — each mutation is either the artifact's OWN named validation reject or a named
//       receipt-binding reject (digest-mismatch; how-mismatch for the journal head size, which is
//       bound into the derivation rule because it is not derivable from the root) — NEVER ok:true
//       against the original receipt. Receipt-side: one-byte tampers of digest/kind/artifactKind/
//       how/note/chain fields are the SPECIFIC named rejects; an unknown artifact `kind` string is
//       a named reject.
//   (3) Purity: a grep-based static guard proves the module's OWN source requires none of
//       fs/http/https/net/dns/tls/dgram/child_process, reads no clock, and requires EXACTLY the
//       seven shipped seams; a fuzz over hostile shapes shows every failure is a named
//       { ok:false, reason }, never a throw.
//   (4) The trust-note sentences are embedded VERBATIM in every built receipt (the full note is
//       pinned below, including the two load-bearing fragments).
//   (5) No shipped validator is edited (this suite only REQUIRES them) and the full suite stays
//       green — the Verifier's `npx hardhat test` run is the authoritative gate for that half.
//
// PURITY OF THIS SUITE: no temp dirs, no sockets, no keys, no clock — the only fs use is reading
// cli/core/anchor-binding.js as TEXT for the static guard. All fixtures are built in memory with
// the SHIPPED builders, so the pinned digests double as regression pins on those builders.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const ab = require("../cli/core/anchor-binding");
const {
  ANCHORED_RECEIPT_KIND,
  ANCHOR_TRUST_NOTE,
  ARTIFACT_KINDS,
  JOURNAL_TREE_HEAD_KIND,
  REASONS,
  artifactDigest,
  buildAnchoredReceipt,
  verifyAnchoredReceipt,
} = ab;

// The reused seams, imported DIRECTLY so digest extraction can be asserted equal to a direct
// shipped-validator computation (reuse-not-fork, criterion 1/5).
const evidence = require("../cli/evidence");
const agent = require("../cli/agent");
const journalLog = require("../cli/journal-log");
const dataset = require("../cli/dataset");
const parcel = require("../cli/parcel");
const tlSeal = require("../trustledger/seal");
const coreTimestamp = require("../cli/core/timestamp");
const { hashBytes, hashEntries } = require("../cli/hash");
const { toUtf8Bytes } = require("ethers");

// ---------------------------------------------------------------------------------------------------
// The PINNED digests (criterion 1). These are the stable, documented digests of the fixtures below;
// they change ONLY if a shipped builder/validator changes its bytes — which is exactly what the pin
// is for. EMPTY_ROOT is journal-log's documented empty-tree constant, re-pinned here.
// ---------------------------------------------------------------------------------------------------

const PINNED = Object.freeze({
  "vh.evidence-seal": "0xb770390543f4610507e8533d832f518539ac9823b592efc31103b3d8baa7a6b0",
  "vh.agent-session-packet": "0x485feb4542ee9543d8ff2dec6426d62f51754db6679e1a51b1b64d39c5656c1e",
  "vh.journal-tree-head": "0xbe31e404549b22e238808a4f7f4c18b892bb3241c5cca0a4ea8fcfcd5dc7acd7",
  "trustledger.reconcile-seal": "0xd8f963604b6525ad5b58bd51bbf9c909e1def3a31bff92727879e832c3c7c034",
  "verifyhash.dataset-attestation": "0x75fe17b726fc48593a23faaed4d3648c5a66e45be7038013549b0b4e0f9af546",
  "verifyhash.parcel-attestation": "0x08c7e99ad897fbb005d53c03ad615501b91f2237c59695a31a2db9debf6a1e19",
});

const PINNED_EMPTY_ROOT = "0xf5ae2a92976d7173fab7a9152971adb0125db4f0d360172e39c892cb61c5fe5a";

// The full trust note, pinned VERBATIM (criterion 4). If this fails, the in-band honesty drifted.
const PINNED_TRUST_NOTE =
  "This anchored receipt binds the artifact digest above to an on-chain registry record. A receipt " +
  "from a LOCAL dev chain proves MECHANISM only and is worth NOTHING publicly until a human deploys " +
  "the registry (STRATEGY.md P-2). On a public chain it proves ONLY that an on-chain record binds " +
  "this exact digest at a block whose timestamp BOUNDS existence — as trustworthy as the chain + " +
  "YOUR pinned contract address — NOT the artifact's truth, NOT faithful recording, NOT attribution " +
  "beyond the anchoring key. The `chain` facts in this receipt are the anchorer's claim until " +
  "re-checked against the chain (`vh verify-anchored --rpc`).";

// A plausible local-hardhat chain-facts block (the classic first-deploy address + account #0, both
// canonical lowercase; values are the anchorer's claim — this pure core checks FORM only).
const CHAIN = Object.freeze({
  authorBound: true,
  blockNumber: 7,
  blockTime: 1767312000,
  chainId: 31337,
  contract: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  contributor: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  txHash: "0x" + "6f".repeat(32),
});

// ---------------------------------------------------------------------------------------------------
// Deterministic fixtures — built with the SHIPPED builders (never hand-forged), fresh per call so a
// mutation in one test can never leak into another.
// ---------------------------------------------------------------------------------------------------

function evidenceFixture() {
  return evidence.buildSeal([
    { relPath: "src/app.js", bytes: Buffer.from("console.log(1)\n") },
    { relPath: "README.md", bytes: Buffer.from("# demo\n") },
  ]);
}

function agentFixture() {
  const built = agent.buildPacket([
    { seq: 0, ts: "2026-01-01T00:00:00Z", actor: "user", type: "prompt", payload: "write the tests" },
    { seq: 1, ts: "2026-01-01T00:00:05Z", actor: "agent", type: "completion", payload: "done: 3 tests" },
    { seq: 2, ts: "2026-01-01T00:00:09Z", actor: "agent", type: "note", payload: "n/a", meta: { run: 1 } },
  ]);
  expect(built.ok).to.equal(true);
  return built.packet;
}

function journalFixture() {
  const head = journalLog.treeHead(["entry-0", "entry-1", "entry-2"].map((s) => hashBytes(toUtf8Bytes(s))));
  return { size: head.size, root: head.root }; // the bare cli/journal-log.js head shape
}

function trustledgerFixture() {
  const b = (s) => Buffer.from(s, "utf8");
  return tlSeal.buildSeal({
    files: {
      inputs: [
        { role: "bank", relPath: "sources/bank.csv", bytes: b("date,amount\n2026-05-31,270000\n") },
        { role: "book", relPath: "sources/ledger.csv", bytes: b("date,amount\n2026-05-31,270000\n") },
      ],
      outputs: [{ relPath: "reconciliation.html", bytes: b("<html>PASS</html>") }],
    },
    verdict: { pass: true, reportDate: "2026-05-31", period: "2026-05" },
  });
}

function datasetFixture() {
  const built = hashEntries([
    { path: "data/a.csv", content: Buffer.from("a,b\n1,2\n") },
    { path: "data/b.csv", content: Buffer.from("c,d\n3,4\n") },
  ]);
  return dataset.buildAttestation(dataset.buildManifest({ root: built.root, leaves: built.leaves }));
}

function parcelFixture() {
  const built = hashEntries([
    { path: "parcel/deed.pdf", content: Buffer.from("deed-bytes-v1") },
    { path: "parcel/survey.pdf", content: Buffer.from("survey-bytes-v1") },
  ]);
  return parcel.buildParcelAttestation(parcel.buildParcelManifest({ root: built.root, leaves: built.leaves }, {}));
}

// kind -> { make, direct } where `direct` computes the digest STRAIGHT through the shipped seam.
const FIXTURES = Object.freeze({
  "vh.evidence-seal": {
    make: evidenceFixture,
    direct: (a) => evidence.readSeal(a).root.toLowerCase(),
  },
  "vh.agent-session-packet": {
    make: agentFixture,
    direct: (a) => agent.verifyPacket(agent.validatePacketShape(a)).head.root,
  },
  "vh.journal-tree-head": {
    make: journalFixture,
    direct: (a) => a.root, // treeHead's own root — asserted against a direct treeHead below too
  },
  "trustledger.reconcile-seal": {
    make: trustledgerFixture,
    direct: (a) => tlSeal.readSeal(a).root.toLowerCase(),
  },
  "verifyhash.dataset-attestation": {
    make: datasetFixture,
    direct: (a) => "0x" + coreTimestamp.sha256Hex(dataset.serializeAttestation(a)),
  },
  "verifyhash.parcel-attestation": {
    make: parcelFixture,
    direct: (a) => "0x" + coreTimestamp.sha256Hex(parcel.serializeParcelAttestation(a)),
  },
});

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function buildReceiptFor(artifact, label) {
  const d = artifactDigest(artifact);
  expect(d.ok, `fixture must extract: ${JSON.stringify(d)}`).to.equal(true);
  const built = buildAnchoredReceipt({
    digest: d.digest,
    kind: d.kind,
    how: d.how,
    ...(label === undefined ? {} : { artifactLabel: label }),
    chain: CHAIN,
  });
  expect(built.ok, `fixture receipt must build: ${JSON.stringify(built)}`).to.equal(true);
  return built.receipt;
}

// ---------------------------------------------------------------------------------------------------
// The one-byte tamper engine (criterion 2). Enumerates a mutation of EVERY primitive value in the
// object graph: each character of every string (hex digits cycle to the NEXT hex digit so the value
// stays canonical-lowercase and the change is always SEMANTIC — the shipped validators treat hex
// case-insensitively, so a pure case-flip would not change the committed value and is out of scope),
// every number +1, every boolean negated, every null replaced. Key-name and JSON-syntax bytes are
// covered by the strict validators' unknown-field/missing-field rejects, exercised separately.
// ---------------------------------------------------------------------------------------------------

const HEXCHARS = "0123456789abcdef";

function listMutations(fixture) {
  const out = [];
  (function walk(v, p) {
    if (typeof v === "string") {
      const isHex = /^0x[0-9a-f]+$/.test(v);
      for (let i = 0; i < v.length; i++) {
        let repl;
        if (isHex && i >= 2) repl = HEXCHARS[(HEXCHARS.indexOf(v[i]) + 1) % 16];
        else if (isHex) repl = "z"; // break the 0x prefix
        else repl = v[i] === "x" ? "y" : "x";
        out.push({ where: `${p.join(".")}[${i}]`, path: p.slice(), value: v.slice(0, i) + repl + v.slice(i + 1) });
      }
    } else if (typeof v === "number") {
      out.push({ where: p.join("."), path: p.slice(), value: v + 1 });
    } else if (typeof v === "boolean") {
      out.push({ where: p.join("."), path: p.slice(), value: !v });
    } else if (v === null) {
      out.push({ where: p.join("."), path: p.slice(), value: "tampered" });
    } else if (Array.isArray(v)) {
      v.forEach((el, i) => walk(el, p.concat(i)));
    } else if (v && typeof v === "object") {
      for (const k of Object.keys(v)) walk(v[k], p.concat(k));
    }
  })(fixture, []);
  return out;
}

function applyMutation(fixture, m) {
  const c = clone(fixture);
  let o = c;
  for (let i = 0; i < m.path.length - 1; i++) o = o[m.path[i]];
  o[m.path[m.path.length - 1]] = m.value;
  return c;
}

// ===================================================================================================
describe("cli/core/anchor-binding.js — pure anchor-binding core (T-70.1)", function () {
  // =================================================================================================
  describe("(3a) STATIC purity guard: no fs/net/env/clock/keys; exactly the seven shipped seams", function () {
    let src;
    before(function () {
      const raw = fs.readFileSync(path.join(__dirname, "..", "cli", "core", "anchor-binding.js"), "utf8");
      // Strip comments so prose can neither hide nor fake a dependency.
      src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    });

    it("requires EXACTLY the seven audited seams (each a shipped validator/serializer), nothing else", function () {
      const required = [];
      const re = /require\(\s*["']([^"']+)["']\s*\)/g;
      let m;
      while ((m = re.exec(src)) !== null) required.push(m[1]);
      expect(required.sort()).to.deep.equal(
        [
          "../../trustledger/seal",
          "../agent",
          "../dataset",
          "../evidence",
          "../journal-log",
          "../parcel",
          "./timestamp",
        ].sort()
      );
      // No dynamic/computed require can smuggle a module past the list above.
      expect(src).to.not.match(/require\(\s*[^"')]/);
    });

    it("has no fs/net/process/clock/randomness/crypto surface of its own", function () {
      for (const bad of [
        /\bfs\b\s*\./,
        /child_process/,
        /\bprocess\b/,
        /\bDate\b/,
        /Math\.random/,
        /\bsetTimeout\b/,
        /\bsetInterval\b/,
        /createHash/,
        /keccak/,
        /\beval\(/,
      ]) {
        expect(src).to.not.match(bad, `forbidden token ${bad} found in the module's own source`);
      }
    });

    it("exports the documented closed table (six kinds, frozen) and the container framing", function () {
      expect(ANCHORED_RECEIPT_KIND).to.equal("vh-anchored-receipt@1");
      expect(Object.isFrozen(ARTIFACT_KINDS)).to.equal(true);
      expect(ARTIFACT_KINDS.slice().sort()).to.deep.equal(
        [
          "vh.evidence-seal",
          "vh.agent-session-packet",
          "vh.journal-tree-head",
          "trustledger.reconcile-seal",
          "verifyhash.dataset-attestation",
          "verifyhash.parcel-attestation",
        ].sort()
      );
      expect(JOURNAL_TREE_HEAD_KIND).to.equal("vh.journal-tree-head");
      // The table reuses the products' OWN kind constants — it can never drift from the artifacts.
      expect(ARTIFACT_KINDS).to.include(evidence.SEAL_KIND);
      expect(ARTIFACT_KINDS).to.include(agent.PACKET_KIND);
      expect(ARTIFACT_KINDS).to.include(tlSeal.SEAL_KIND);
      expect(ARTIFACT_KINDS).to.include(dataset.ATTESTATION_KIND);
      expect(ARTIFACT_KINDS).to.include(parcel.PARCEL_ATTESTATION_KIND);
    });
  });

  // =================================================================================================
  describe("(1) closed table: stable pinned digests + build -> verify round-trip, per kind", function () {
    for (const kind of Object.keys(FIXTURES)) {
      it(`${kind}: pinned digest, reuse-not-fork equality, and a full round-trip`, function () {
        const artifact = FIXTURES[kind].make();
        const d = artifactDigest(artifact);
        expect(d.ok).to.equal(true);
        expect(d.kind).to.equal(kind);
        expect(d.digest).to.equal(PINNED[kind]); // the stable, documented digest
        expect(d.digest).to.match(/^0x[0-9a-f]{64}$/); // canonical lowercase bytes32
        expect(d.how).to.be.a("string").with.length.greaterThan(20);
        // Reuse, not fork: the digest equals a DIRECT computation through the shipped seam.
        expect(d.digest).to.equal(FIXTURES[kind].direct(artifact));

        const receipt = buildReceiptFor(artifact, "fixture.json");
        expect(receipt.kind).to.equal(ANCHORED_RECEIPT_KIND);
        expect(receipt.artifactKind).to.equal(kind);
        expect(receipt.digest).to.equal(PINNED[kind]);
        expect(receipt.note).to.equal(ANCHOR_TRUST_NOTE);

        const v = verifyAnchoredReceipt({ receipt, artifact });
        expect(v).to.deep.equal({ ok: true, digest: PINNED[kind], chain: { ...CHAIN } });
      });
    }

    it("journal head: the bare { size, root } and the kind-tagged twin bind identically", function () {
      const bare = journalFixture();
      const tagged = { kind: JOURNAL_TREE_HEAD_KIND, size: bare.size, root: bare.root };
      const dBare = artifactDigest(bare);
      const dTagged = artifactDigest(tagged);
      expect(dBare).to.deep.equal(dTagged);
      // A direct treeHead recomputation over the same leaves yields the same pinned root.
      const direct = journalLog.treeHead(["entry-0", "entry-1", "entry-2"].map((s) => hashBytes(toUtf8Bytes(s))));
      expect(direct.root).to.equal(PINNED["vh.journal-tree-head"]);
      // One receipt verifies BOTH forms (same kind/digest/how).
      const receipt = buildReceiptFor(bare);
      expect(verifyAnchoredReceipt({ receipt, artifact: tagged }).ok).to.equal(true);
    });

    it("journal head: the EMPTY head (size 0) anchors journal-log's documented EMPTY_ROOT", function () {
      expect(journalLog.EMPTY_ROOT).to.equal(PINNED_EMPTY_ROOT);
      const d = artifactDigest({ size: 0, root: journalLog.EMPTY_ROOT });
      expect(d.ok).to.equal(true);
      expect(d.digest).to.equal(PINNED_EMPTY_ROOT);
      expect(d.how).to.include("over 0 entries");
    });

    it("the receipt is canonical: sorted keys at every level, so JSON.stringify IS the wire form", function () {
      const receipt = buildReceiptFor(evidenceFixture(), "packet.vhevidence.json");
      expect(Object.keys(receipt)).to.deep.equal(["artifactKind", "artifactLabel", "chain", "digest", "how", "kind", "note"]);
      expect(Object.keys(receipt.chain)).to.deep.equal([
        "authorBound",
        "blockNumber",
        "blockTime",
        "chainId",
        "contract",
        "contributor",
        "txHash",
      ]);
      expect(JSON.stringify(receipt).startsWith('{"artifactKind":"vh.evidence-seal"')).to.equal(true);
      // Without a label the optional key is OMITTED (never null-padded).
      const bare = buildReceiptFor(evidenceFixture());
      expect(Object.keys(bare)).to.deep.equal(["artifactKind", "chain", "digest", "how", "kind", "note"]);
    });
  });

  // =================================================================================================
  describe("(4) the trust note is embedded VERBATIM in every built receipt", function () {
    it("pins the full note byte-for-byte, including the two load-bearing sentences", function () {
      expect(ANCHOR_TRUST_NOTE).to.equal(PINNED_TRUST_NOTE);
      expect(ANCHOR_TRUST_NOTE).to.include("LOCAL dev chain proves MECHANISM only");
      expect(ANCHOR_TRUST_NOTE).to.include("as trustworthy as the chain + YOUR pinned contract address");
      for (const kind of Object.keys(FIXTURES)) {
        const receipt = buildReceiptFor(FIXTURES[kind].make());
        expect(receipt.note, `receipt for ${kind}`).to.equal(PINNED_TRUST_NOTE);
      }
    });

    it("a receipt whose note drifted by one byte is a named bad-receipt", function () {
      const receipt = buildReceiptFor(evidenceFixture());
      receipt.note = receipt.note.replace("MECHANISM", "MECHANISN");
      const v = verifyAnchoredReceipt({ receipt, artifact: evidenceFixture() });
      expect(v.ok).to.equal(false);
      expect(v.reason).to.equal(REASONS.BAD_RECEIPT);
      expect(v.field).to.equal("note");
    });
  });

  // =================================================================================================
  describe("(2) tamper matrix, artifact side: one mutated value byte is NEVER ok against the receipt", function () {
    // Every mutation must land in one of the named channels:
    //   - the artifact's OWN named validation reject (the shipped validator caught it), or
    //   - digest-mismatch (the committed value moved; the receipt no longer binds it), or
    //   - how-mismatch (journal head `size` ONLY: not derivable from the root, so it is bound into
    //     the receipt's derivation rule and an edit is caught THERE — see the module header).
    for (const kind of Object.keys(FIXTURES)) {
      it(`${kind}: full value-byte mutation sweep`, function () {
        this.timeout(120000);
        const artifact = FIXTURES[kind].make();
        const receipt = buildReceiptFor(artifact);
        const muts = listMutations(artifact);
        expect(muts.length).to.be.greaterThan(10); // the sweep is real
        for (const m of muts) {
          const tampered = applyMutation(artifact, m);
          const d = artifactDigest(tampered);
          if (!d.ok) {
            expect(d.reason, `${kind} @ ${m.where}: reject must be NAMED`).to.be.a("string").and.not.equal("");
            continue;
          }
          const v = verifyAnchoredReceipt({ receipt, artifact: tampered });
          expect(v.ok, `${kind} @ ${m.where}: tampered artifact must NOT verify (got ${JSON.stringify(v)})`).to.equal(false);
          expect([REASONS.DIGEST_MISMATCH, REASONS.HOW_MISMATCH]).to.include(
            v.reason,
            `${kind} @ ${m.where}: mismatch must be the named channel`
          );
        }
      });
    }

    it("names the artifact's OWN validation reject per kind (spot checks with reasons + detail)", function () {
      // evidence: root edit -> the seal's own re-derivation reject
      const ev = evidenceFixture();
      ev.root = ev.root.slice(0, -1) + (ev.root.endsWith("0") ? "1" : "0");
      let r = artifactDigest(ev);
      expect(r).to.include({ ok: false, reason: REASONS.EVIDENCE_SEAL_INVALID });
      expect(r.detail).to.match(/does not re-derive/);

      // agent: one payload byte -> the packet's own named EVENT_PAYLOAD_HASH_MISMATCH at its seq
      const ag = agentFixture();
      ag.events[1].payload = "done: 4 tests";
      r = artifactDigest(ag);
      expect(r).to.include({ ok: false, reason: REASONS.AGENT_PACKET_INVALID });
      expect(r.detail).to.include("EVENT_PAYLOAD_HASH_MISMATCH");
      // agent: stored head root edit -> the packet's own HEAD_MISMATCH
      const ag2 = agentFixture();
      ag2.head.root = ag2.head.root.slice(0, -1) + (ag2.head.root.endsWith("0") ? "1" : "0");
      r = artifactDigest(ag2);
      expect(r).to.include({ ok: false, reason: REASONS.AGENT_PACKET_INVALID });
      expect(r.detail).to.include("HEAD_MISMATCH");

      // trustledger: verdict flip -> the sealfile's own header-bound re-derivation reject
      const tl = trustledgerFixture();
      tl.verdict.pass = false;
      r = artifactDigest(tl);
      expect(r).to.include({ ok: false, reason: REASONS.TRUSTLEDGER_SEAL_INVALID });
      expect(r.detail).to.match(/verdict\/role header/);

      // dataset/parcel: a signed:true claim (or a non-null signature) is the attestation's own reject
      const ds = datasetFixture();
      ds.signed = true;
      r = artifactDigest(ds);
      expect(r).to.include({ ok: false, reason: REASONS.DATASET_ATTESTATION_INVALID });
      const pc = parcelFixture();
      pc.signature = "0xdeadbeef";
      r = artifactDigest(pc);
      expect(r).to.include({ ok: false, reason: REASONS.PARCEL_ATTESTATION_INVALID });

      // attestations: an unknown extra field would ride UNBOUND by the canonical bytes -> reject
      const ds2 = datasetFixture();
      ds2.extra = "smuggled";
      r = artifactDigest(ds2);
      expect(r).to.include({ ok: false, reason: REASONS.DATASET_ATTESTATION_INVALID });
      expect(r.detail).to.include("unknown field");

      // journal: the EMPTY_ROOT consistency is checkable both ways without the leaves
      expect(artifactDigest({ size: 0, root: PINNED["vh.journal-tree-head"] })).to.include({
        ok: false,
        reason: REASONS.JOURNAL_TREE_HEAD_INVALID,
      });
      expect(artifactDigest({ size: 2, root: journalLog.EMPTY_ROOT })).to.include({
        ok: false,
        reason: REASONS.JOURNAL_TREE_HEAD_INVALID,
      });
      // journal: an edited size is the documented how-mismatch (bound into the derivation rule)
      const jh = journalFixture();
      const receipt = buildReceiptFor(jh);
      const v = verifyAnchoredReceipt({ receipt, artifact: { size: jh.size + 1, root: jh.root } });
      expect(v.ok).to.equal(false);
      expect(v.reason).to.equal(REASONS.HOW_MISMATCH);
    });

    it("an unknown `kind` string is a NAMED reject, never a guess", function () {
      for (const bad of ["nope", "vh.evidence-seal2", "vh-anchored-receipt@1", "VH.EVIDENCE-SEAL", ""]) {
        const r = artifactDigest({ kind: bad, root: PINNED["vh.evidence-seal"] });
        expect(r.ok, JSON.stringify(bad)).to.equal(false);
        expect(r.reason).to.equal(REASONS.UNKNOWN_KIND);
      }
      // no kind and not a bare { size, root } head: not dispatchable
      expect(artifactDigest({ foo: 1 })).to.include({ ok: false, reason: REASONS.UNKNOWN_KIND });
      // a non-string kind can never dispatch
      expect(artifactDigest({ kind: 42 })).to.include({ ok: false, reason: REASONS.UNKNOWN_KIND });
    });
  });

  // =================================================================================================
  describe("(2) tamper matrix, receipt side: digest/kind/chain field tampers are SPECIFIC named rejects", function () {
    function freshPair() {
      const artifact = evidenceFixture();
      return { artifact, receipt: buildReceiptFor(artifact) };
    }

    it("receipt.digest: a semantic hex flip is digest-mismatch; a format break is bad-receipt", function () {
      const { artifact, receipt } = freshPair();
      const flipped = { ...receipt, digest: receipt.digest.slice(0, -1) + (receipt.digest.endsWith("0") ? "1" : "0") };
      let v = verifyAnchoredReceipt({ receipt: flipped, artifact });
      expect(v).to.include({ ok: false, reason: REASONS.DIGEST_MISMATCH });
      for (const bad of [
        receipt.digest.slice(0, -1) + "g", // non-hex byte
        receipt.digest.toUpperCase(), // non-canonical case
        receipt.digest.slice(0, -2), // wrong length
        42,
      ]) {
        v = verifyAnchoredReceipt({ receipt: { ...receipt, digest: bad }, artifact });
        expect(v).to.include({ ok: false, reason: REASONS.BAD_RECEIPT });
        expect(v.field).to.equal("digest");
      }
    });

    it("receipt.kind and receipt.artifactKind: one-byte tampers are bad-receipt; a wholesale kind swap is kind-mismatch", function () {
      const { artifact, receipt } = freshPair();
      let v = verifyAnchoredReceipt({ receipt: { ...receipt, kind: "vh-anchored-receipt@2" }, artifact });
      expect(v).to.include({ ok: false, reason: REASONS.BAD_RECEIPT });
      expect(v.field).to.equal("kind");
      v = verifyAnchoredReceipt({ receipt: { ...receipt, artifactKind: "vh.evidence-seaL" }, artifact });
      expect(v).to.include({ ok: false, reason: REASONS.BAD_RECEIPT });
      expect(v.field).to.equal("artifactKind");
      // A receipt legitimately built for ANOTHER kind, verified against this artifact: kind-mismatch.
      const other = buildReceiptFor(datasetFixture());
      v = verifyAnchoredReceipt({ receipt: other, artifact });
      expect(v).to.include({ ok: false, reason: REASONS.KIND_MISMATCH });
      // Same kind, different artifact: digest-mismatch.
      const otherEvidence = evidence.buildSeal([{ relPath: "src/app.js", bytes: Buffer.from("console.log(2)\n") }]);
      v = verifyAnchoredReceipt({ receipt, artifact: otherEvidence });
      expect(v).to.include({ ok: false, reason: REASONS.DIGEST_MISMATCH });
    });

    it("receipt.how: a drifted rule is bad-receipt; a journal size edit inside a well-formed rule is how-mismatch", function () {
      const { artifact, receipt } = freshPair();
      let v = verifyAnchoredReceipt({ receipt: { ...receipt, how: receipt.how.replace("root", "roou") }, artifact });
      expect(v).to.include({ ok: false, reason: REASONS.BAD_RECEIPT });
      expect(v.field).to.equal("how");
      // journal: the rule stays WELL-FORMED but claims a different size -> the named how-mismatch
      const jh = journalFixture();
      const jr = buildReceiptFor(jh);
      const jrTampered = { ...jr, how: jr.how.replace("over 3 entries", "over 4 entries") };
      v = verifyAnchoredReceipt({ receipt: jrTampered, artifact: jh });
      expect(v).to.include({ ok: false, reason: REASONS.HOW_MISMATCH });
    });

    it("chain fields: every format-breaking one-byte tamper is bad-receipt NAMING the field", function () {
      const { artifact, receipt } = freshPair();
      const cases = [
        ["chain.txHash", { txHash: receipt.chain.txHash.slice(0, -1) + "g" }],
        ["chain.txHash", { txHash: receipt.chain.txHash.toUpperCase() }],
        ["chain.contract", { contract: receipt.chain.contract.slice(0, -1) + "G" }],
        ["chain.contract", { contract: receipt.chain.contract.toUpperCase() }],
        ["chain.contributor", { contributor: receipt.chain.contributor + "00" }],
        ["chain.chainId", { chainId: 0 }],
        ["chain.chainId", { chainId: "31337" }],
        ["chain.chainId", { chainId: 1.5 }],
        ["chain.blockNumber", { blockNumber: -1 }],
        ["chain.blockNumber", { blockNumber: "7" }],
        ["chain.blockTime", { blockTime: 17673.5 }],
        ["chain.authorBound", { authorBound: 1 }],
        ["chain.authorBound", { authorBound: "true" }],
      ];
      for (const [field, patch] of cases) {
        const v = verifyAnchoredReceipt({ receipt: { ...receipt, chain: { ...receipt.chain, ...patch } }, artifact });
        expect(v.ok, field).to.equal(false);
        expect(v.reason, field).to.equal(REASONS.BAD_RECEIPT);
        expect(v.field, field).to.equal(field);
      }
      // missing / extra chain fields
      const missing = { ...receipt.chain };
      delete missing.txHash;
      let v = verifyAnchoredReceipt({ receipt: { ...receipt, chain: missing }, artifact });
      expect(v).to.include({ ok: false, reason: REASONS.BAD_RECEIPT });
      v = verifyAnchoredReceipt({ receipt: { ...receipt, chain: { ...receipt.chain, gasUsed: 21000 } }, artifact });
      expect(v).to.include({ ok: false, reason: REASONS.BAD_RECEIPT });
    });

    it("HONEST BOUNDARY: a numerically-plausible chain-VALUE edit is NOT offline-detectable — that is T-70.2's --rpc read-back", function () {
      // This pure core has no network: it pins the FORM of the chain facts and the artifact binding.
      // An anchorer-claimed blockNumber of 8 instead of 7 is a well-formed claim this function
      // CANNOT check; it returns the chain facts so the caller (the `--rpc` mode) re-checks them
      // against the chain. Documented here so the boundary can never silently drift.
      const { artifact, receipt } = freshPair();
      const v = verifyAnchoredReceipt({
        receipt: { ...receipt, chain: { ...receipt.chain, blockNumber: receipt.chain.blockNumber + 1 } },
        artifact,
      });
      expect(v.ok).to.equal(true);
      expect(v.chain.blockNumber).to.equal(CHAIN.blockNumber + 1); // the claim is HANDED BACK, not vouched for
    });

    it("receipt structure: unknown/missing fields and a malformed label are named bad-receipt rejects", function () {
      const { artifact, receipt } = freshPair();
      let v = verifyAnchoredReceipt({ receipt: { ...receipt, smuggled: 1 }, artifact });
      expect(v).to.include({ ok: false, reason: REASONS.BAD_RECEIPT });
      expect(v.field).to.equal("smuggled");
      for (const k of ["artifactKind", "chain", "digest", "how", "kind", "note"]) {
        const broken = { ...receipt };
        delete broken[k];
        v = verifyAnchoredReceipt({ receipt: broken, artifact });
        expect(v.ok, `missing ${k}`).to.equal(false);
        expect(v.reason, `missing ${k}`).to.equal(REASONS.BAD_RECEIPT);
      }
      v = verifyAnchoredReceipt({ receipt: { ...receipt, artifactLabel: "a\nb" }, artifact });
      expect(v).to.include({ ok: false, reason: REASONS.BAD_RECEIPT });
      expect(v.field).to.equal("artifactLabel");
    });

    it("DOCUMENTED BOUNDARY: artifactLabel is presentation-only (not digest-bound)", function () {
      const { artifact } = freshPair();
      const receipt = buildReceiptFor(artifact, "original-name.json");
      const v = verifyAnchoredReceipt({ receipt: { ...receipt, artifactLabel: "renamed.json" }, artifact });
      expect(v.ok).to.equal(true); // the label is a courtesy string; the digest/kind/how triple is the binding
    });
  });

  // =================================================================================================
  describe("(b) buildAnchoredReceipt: strict field validation with named rejects", function () {
    function goodParams() {
      const d = artifactDigest(evidenceFixture());
      return { digest: d.digest, kind: d.kind, how: d.how, chain: { ...CHAIN } };
    }

    it("rejects a malformed digest by name", function () {
      for (const bad of [undefined, null, 42, "0x12", PINNED["vh.evidence-seal"].toUpperCase(), "not-hex"]) {
        const r = buildAnchoredReceipt({ ...goodParams(), digest: bad });
        expect(r.ok, String(bad)).to.equal(false);
        expect(r.reason, String(bad)).to.equal(REASONS.BAD_DIGEST);
      }
    });

    it("rejects a kind outside the closed table by name", function () {
      for (const bad of [undefined, null, 7, "nope", "vh.evidence-seal "]) {
        const r = buildAnchoredReceipt({ ...goodParams(), kind: bad });
        expect(r.ok, String(bad)).to.equal(false);
        expect(r.reason, String(bad)).to.equal(REASONS.UNKNOWN_KIND);
      }
    });

    it("rejects a `how` that is not the documented derivation rule for the kind", function () {
      const p = goodParams();
      const dsHow = artifactDigest(datasetFixture()).how; // a VALID rule — for the WRONG kind
      for (const bad of [undefined, "", "made up", dsHow]) {
        const r = buildAnchoredReceipt({ ...p, how: bad });
        expect(r.ok, String(bad)).to.equal(false);
        expect(r.reason, String(bad)).to.equal(REASONS.BAD_HOW);
      }
    });

    it("rejects a malformed label and malformed chain facts by name, naming the chain field", function () {
      let r = buildAnchoredReceipt({ ...goodParams(), artifactLabel: "" });
      expect(r).to.include({ ok: false, reason: REASONS.BAD_LABEL });
      r = buildAnchoredReceipt({ ...goodParams(), artifactLabel: "x".repeat(201) });
      expect(r).to.include({ ok: false, reason: REASONS.BAD_LABEL });
      r = buildAnchoredReceipt({ ...goodParams(), chain: null });
      expect(r).to.include({ ok: false, reason: REASONS.BAD_CHAIN });
      r = buildAnchoredReceipt({ ...goodParams(), chain: { ...CHAIN, txHash: "0xnope" } });
      expect(r).to.include({ ok: false, reason: REASONS.BAD_CHAIN, field: "chain.txHash" });
      r = buildAnchoredReceipt({ ...goodParams(), chain: { ...CHAIN, contract: CHAIN.contract.toUpperCase() } });
      expect(r).to.include({ ok: false, reason: REASONS.BAD_CHAIN, field: "chain.contract" });
      const extra = { ...CHAIN, nonce: 1 };
      r = buildAnchoredReceipt({ ...goodParams(), chain: extra });
      expect(r).to.include({ ok: false, reason: REASONS.BAD_CHAIN, field: "chain.nonce" });
    });

    it("a built receipt never aliases the caller's chain object (mutation cannot reach the receipt)", function () {
      const p = goodParams();
      const built = buildAnchoredReceipt(p);
      expect(built.ok).to.equal(true);
      p.chain.blockNumber = 999999;
      expect(built.receipt.chain.blockNumber).to.equal(CHAIN.blockNumber);
    });
  });

  // =================================================================================================
  describe("(3b) TOTALITY: hostile shapes yield named verdicts from all three functions, never throws", function () {
    const HOSTILE = [
      undefined,
      null,
      0,
      42,
      "a string",
      true,
      [],
      [1, 2, 3],
      {},
      { kind: null },
      { kind: {} },
      { kind: ["vh.evidence-seal"] },
      { kind: "vh.evidence-seal" }, // right kind, nothing else
      { kind: "vh.agent-session-packet", events: "not-an-array" },
      { kind: "trustledger.reconcile-seal", root: 12 },
      { kind: "verifyhash.dataset-attestation", root: {} },
      { kind: "verifyhash.parcel-attestation", note: null },
      { size: -1, root: "0x00" },
      { size: 1.5, root: PINNED["vh.journal-tree-head"] },
      { size: 3, root: PINNED["vh.journal-tree-head"].toUpperCase() },
      { size: 3, root: PINNED["vh.journal-tree-head"], extra: 1 },
      { root: PINNED["vh.journal-tree-head"] }, // journal-shaped but sizeless
      Object.assign(Object.create(null), { kind: "vh.evidence-seal" }),
      { kind: "vh.evidence-seal", files: [{}], root: null, note: 0, schemaVersion: "1" },
      // a throwing getter — the fail-closed belt must still return a named verdict
      Object.defineProperty({}, "kind", {
        get() {
          throw new Error("boom");
        },
        enumerable: true,
      }),
    ];

    // A label that never itself throws (String() cannot convert a null-prototype object).
    function tag(h, i) {
      try {
        return `HOSTILE[${i}] ${JSON.stringify(h)}`;
      } catch (_) {
        return `HOSTILE[${i}]`;
      }
    }

    it("artifactDigest is total", function () {
      HOSTILE.forEach((h, i) => {
        let r;
        expect(() => (r = artifactDigest(h)), tag(h, i)).to.not.throw();
        expect(r.ok, tag(h, i)).to.equal(false);
        expect(r.reason, tag(h, i)).to.be.a("string").and.not.equal("");
      });
    });

    it("buildAnchoredReceipt is total", function () {
      HOSTILE.forEach((h, i) => {
        let r;
        expect(() => (r = buildAnchoredReceipt(h)), tag(h, i)).to.not.throw();
        expect(r.ok, tag(h, i)).to.equal(false);
        expect(r.reason, tag(h, i)).to.be.a("string").and.not.equal("");
      });
    });

    it("verifyAnchoredReceipt is total (hostile args, hostile receipts, hostile artifacts)", function () {
      const artifact = evidenceFixture();
      const receipt = buildReceiptFor(artifact);
      for (const h of HOSTILE) {
        for (const args of [h, { receipt: h, artifact }, { receipt, artifact: h }]) {
          let r;
          expect(() => (r = verifyAnchoredReceipt(args))).to.not.throw();
          expect(r.ok).to.equal(false);
          expect(r.reason).to.be.a("string").and.not.equal("");
        }
      }
      // and the artifact's own named reject PROPAGATES through verify
      const broken = evidenceFixture();
      broken.note = "drifted";
      const v = verifyAnchoredReceipt({ receipt, artifact: broken });
      expect(v).to.include({ ok: false, reason: REASONS.EVIDENCE_SEAL_INVALID });
    });
  });
});
