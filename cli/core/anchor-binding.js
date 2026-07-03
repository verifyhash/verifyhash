"use strict";

// cli/core/anchor-binding.js — the PURE ANCHOR-BINDING core (T-70.1, EPIC-70 "chain-anchor bridge").
//
// WHAT THIS IS
//   The one place that knows how to turn ANY sealed product artifact into the single canonical
//   32-byte digest a chain registry record can bind — and how to verify, OFFLINE, that an
//   anchored receipt really is about the exact artifact bytes in hand. Three functions:
//
//     (a) artifactDigest(artifact)      — strict dispatch over a CLOSED, frozen kind table; each
//                                         leg REUSES the artifact's SHIPPED validator VERBATIM
//                                         before extracting its digest. Returns
//                                         { ok:true, digest, kind, how } or a NAMED
//                                         { ok:false, reason, detail? }. TOTAL: never throws.
//     (b) buildAnchoredReceipt(params)  — the canonical, versioned, SORTED-KEY
//                                         `kind:"vh-anchored-receipt@1"` container embedding the
//                                         digest + derivation rule + chain facts + the honest
//                                         trust note VERBATIM. Strict field validation, named
//                                         rejects.
//     (c) verifyAnchoredReceipt(args)   — parse+validate the receipt strictly, recompute
//                                         artifactDigest(artifact) via the SAME closed table, and
//                                         return { ok:true, digest, chain } on match or the
//                                         SPECIFIC named mismatch. NEVER consults a network — the
//                                         on-chain read-back is T-70.2's `--rpc` mode.
//
// THE CLOSED KIND TABLE (extending it is a deliberate edit here + in the test, never implicit)
//   kind string                          shipped validator REUSED VERBATIM          digest
//   -----------------------------------  -----------------------------------------  ------------------
//   vh.evidence-seal                     cli/evidence.js readSeal                    seal `root`
//   vh.agent-session-packet              cli/agent.js validatePacketShape +          verified head root
//                                        verifyPacket (which delegates every event
//                                        leaf/head recompute to the T-68.1 core
//                                        cli/core/agent-session.js)
//   vh.journal-tree-head                 cli/journal-log.js head shape { size,       head `root`
//                                        root } (the Signed-Tree-Head-SHAPED
//                                        commitment `vh journal tree-head` prints)
//                                        + its exported EMPTY_ROOT constant
//   trustledger.reconcile-seal           trustledger/seal.js readSeal                seal `root`
//   verifyhash.dataset-attestation       cli/dataset.js serializeAttestation         0x + sha256 over
//                                        (validates first)                           the canonical bytes
//   verifyhash.parcel-attestation        cli/parcel.js serializeParcelAttestation    0x + sha256 over
//                                        (validates first)                           the canonical bytes
//
//   The attestation digests are computed with cli/core/timestamp.js `sha256Hex` — the EXACT
//   function `vh dataset timestamp-request` / `vh parcel timestamp-request` use — so the anchored
//   digest for an attestation is 0x + the very digest the owner's RFC-3161 TSA flow already
//   stamps (one digest per artifact, never two).
//
// THE JOURNAL TREE-HEAD LEG (why `how` carries the size)
//   A journal tree head is the bare RFC-6962 commitment { size, root } (cli/journal-log.js's own
//   head shape — `vh journal tree-head` prints exactly these two facts; a kind-tagged twin
//   { kind:"vh.journal-tree-head", size, root } is also accepted so the artifact can be
//   self-describing on disk). The digest is the `root`; the `size` is part of the RFC-6962 head
//   SEMANTICS but is NOT derivable from the root alone, so this leg binds it into the receipt via
//   the derivation-rule string (`how`), and verifyAnchoredReceipt compares the FULL recomputed
//   { digest, kind, how } triple — an edited size is a NAMED `how-mismatch`, never a silent pass.
//
// CASE NORMALIZATION
//   The packetseal-family validators accept mixed-case hex and compare case-insensitively; the
//   receipt digest is canonical LOWERCASE (one logical value, one wire encoding — the family's
//   byte-determinism discipline), so seal roots are lowercased on extraction. All shipped builders
//   already emit lowercase.
//
// TRUST BOUNDARY (embedded VERBATIM in every receipt as `note`; pinned by the test and by T-70.3)
//   See ANCHOR_TRUST_NOTE below. The load-bearing honesty: a local dev chain proves mechanism
//   only; a public-chain record is as trustworthy as the chain + YOUR pinned contract address; the
//   binding proves existence-by-block-time of the digest, never the artifact's truth. The `chain`
//   facts inside a receipt are the ANCHORER'S CLAIM until re-checked against the chain — this pure
//   core validates their FORM strictly but cannot (and does not pretend to) confirm them; that is
//   T-70.2's `--rpc` read-back.
//
// PURITY (a hard acceptance criterion, statically guarded by the test)
//   This module's own source requires NO fs / http / https / net / dns / tls / dgram /
//   child_process, touches NO process.env, reads NO clock (no Date), has NO randomness and NO key
//   material, and invents NO crypto: every hash it returns was computed by a shipped, already-
//   tested validator/serializer, reused verbatim. Every exported function is TOTAL on hostile
//   input: a failure is a NAMED { ok:false, reason } verdict, never an exception.

const evidence = require("../evidence");
const agent = require("../agent");
const journalLog = require("../journal-log");
const dataset = require("../dataset");
const parcel = require("../parcel");
const tlSeal = require("../../trustledger/seal");
const coreTimestamp = require("./timestamp");

// ---------------------------------------------------------------------------------------------------
// The receipt container framing.
// ---------------------------------------------------------------------------------------------------

// The container kind. The schema version rides IN the kind string ("@1") — a future breaking change
// is a NEW kind ("@2"), so an old verifier can never half-read a new receipt.
const ANCHORED_RECEIPT_KIND = "vh-anchored-receipt@1";

// The standing trust note, embedded VERBATIM in every built receipt (the T-70.1 acceptance pins it;
// T-70.3 carries the same sentences into docs). The two load-bearing sentences — "local dev chain
// proves MECHANISM only" and "as trustworthy as the chain + YOUR pinned contract address" — must
// never drift.
const ANCHOR_TRUST_NOTE =
  "This anchored receipt binds the artifact digest above to an on-chain registry record. A receipt " +
  "from a LOCAL dev chain proves MECHANISM only and is worth NOTHING publicly until a human deploys " +
  "the registry (STRATEGY.md P-2). On a public chain it proves ONLY that an on-chain record binds " +
  "this exact digest at a block whose timestamp BOUNDS existence — as trustworthy as the chain + " +
  "YOUR pinned contract address — NOT the artifact's truth, NOT faithful recording, NOT attribution " +
  "beyond the anchoring key. The `chain` facts in this receipt are the anchorer's claim until " +
  "re-checked against the chain (`vh verify-anchored --rpc`).";

// Stable, named reason codes — the verdict contract callers (and the T-70.2 CLI) rely on. Hyphenated
// lowercase, matching the backlog's documented `digest-mismatch` / `kind-mismatch` / `bad-receipt`.
const REASONS = Object.freeze({
  NOT_AN_OBJECT: "not-an-object",
  UNKNOWN_KIND: "unknown-kind",
  EVIDENCE_SEAL_INVALID: "evidence-seal-invalid",
  AGENT_PACKET_INVALID: "agent-packet-invalid",
  JOURNAL_TREE_HEAD_INVALID: "journal-tree-head-invalid",
  TRUSTLEDGER_SEAL_INVALID: "trustledger-seal-invalid",
  DATASET_ATTESTATION_INVALID: "dataset-attestation-invalid",
  PARCEL_ATTESTATION_INVALID: "parcel-attestation-invalid",
  BAD_ARGS: "bad-args",
  BAD_DIGEST: "bad-digest",
  BAD_HOW: "bad-how",
  BAD_LABEL: "bad-label",
  BAD_CHAIN: "bad-chain",
  BAD_RECEIPT: "bad-receipt",
  DIGEST_MISMATCH: "digest-mismatch",
  KIND_MISMATCH: "kind-mismatch",
  HOW_MISMATCH: "how-mismatch",
});

// The journal tree head carries no `kind` of its own (it is the bare { size, root } commitment), so
// the closed table names it here; the other five kinds are the products' OWN shipped constants,
// reused so the table can never drift from the artifacts.
const JOURNAL_TREE_HEAD_KIND = "vh.journal-tree-head";

// The CLOSED, frozen kind table (the six anchorable sealed-product artifacts).
const ARTIFACT_KINDS = Object.freeze([
  evidence.SEAL_KIND, // "vh.evidence-seal"
  agent.PACKET_KIND, // "vh.agent-session-packet"
  JOURNAL_TREE_HEAD_KIND, // "vh.journal-tree-head"
  tlSeal.SEAL_KIND, // "trustledger.reconcile-seal"
  dataset.ATTESTATION_KIND, // "verifyhash.dataset-attestation"
  parcel.PARCEL_ATTESTATION_KIND, // "verifyhash.parcel-attestation"
]);

// ---------------------------------------------------------------------------------------------------
// Small strict-shape helpers (no clock, no randomness — pure predicates).
// ---------------------------------------------------------------------------------------------------

const HEX32_LC_RE = /^0x[0-9a-f]{64}$/; // canonical lowercase bytes32
const ADDRESS_LC_RE = /^0x[0-9a-f]{40}$/; // canonical lowercase address
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function _detail(e) {
  return e && typeof e.message === "string" ? e.message : String(e);
}

// ---------------------------------------------------------------------------------------------------
// The per-kind derivation rules (`how`) — human-readable, deterministic, and BOUND into the receipt.
// For the five self-contained kinds the rule is a FIXED string; the journal leg interpolates the
// head size (see the module header for why). verifyAnchoredReceipt compares the recomputed rule
// against the receipt's, so a drifted rule (or an edited journal size) is a NAMED reject.
// ---------------------------------------------------------------------------------------------------

const HOW_FIXED = Object.freeze({
  [evidence.SEAL_KIND]:
    "digest = the evidence packet's `root` (sorted-pair Merkle root over its path-bound file leaves), " +
    "re-derived by cli/evidence.js readSeal before extraction",
  [agent.PACKET_KIND]:
    "digest = the agent-session packet's verified head `root` (RFC-6962 ordered Merkle root over the " +
    "event leaves), re-derived by cli/agent.js verifyPacket before extraction",
  [tlSeal.SEAL_KIND]:
    "digest = the TrustLedger sealfile's `root` (Merkle root over its committed input/output leaves + " +
    "verdict header), re-derived by trustledger/seal.js readSeal before extraction",
  [dataset.ATTESTATION_KIND]:
    "digest = 0x + sha256 over the canonical UNSIGNED dataset-attestation bytes, exactly as " +
    "`vh dataset timestamp-request` computes it (cli/core/timestamp.js sha256Hex)",
  [parcel.PARCEL_ATTESTATION_KIND]:
    "digest = 0x + sha256 over the canonical UNSIGNED parcel-attestation bytes, exactly as " +
    "`vh parcel timestamp-request` computes it (cli/core/timestamp.js sha256Hex)",
});

function _journalHow(size) {
  return (
    `digest = the journal tree head \`root\` (RFC-6962 ordered Merkle root, cli/journal-log.js ` +
    `treeHead) over ${size} entries; the head size is bound into this derivation rule`
  );
}

const JOURNAL_HOW_RE =
  /^digest = the journal tree head `root` \(RFC-6962 ordered Merkle root, cli\/journal-log\.js treeHead\) over (0|[1-9][0-9]*) entries; the head size is bound into this derivation rule$/;

/** Is `how` the valid derivation rule for `kind`? (kind must already be a table kind.) */
function _howValidFor(kind, how) {
  if (typeof how !== "string") return false;
  if (kind === JOURNAL_TREE_HEAD_KIND) {
    const m = JOURNAL_HOW_RE.exec(how);
    return m !== null && Number.isSafeInteger(Number(m[1]));
  }
  return how === HOW_FIXED[kind];
}

// ---------------------------------------------------------------------------------------------------
// (a) artifactDigest(artifact) — the closed-table digest extraction.
// ---------------------------------------------------------------------------------------------------

function _ok(digest, kind, how) {
  return { ok: true, digest, kind, how };
}

function _no(reason, detail) {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

// vh.evidence-seal — cli/evidence.js readSeal (strict structure + root re-derivation), then `root`.
function _evidenceDigest(artifact) {
  try {
    evidence.readSeal(artifact);
  } catch (e) {
    return _no(REASONS.EVIDENCE_SEAL_INVALID, _detail(e));
  }
  return _ok(artifact.root.toLowerCase(), evidence.SEAL_KIND, HOW_FIXED[evidence.SEAL_KIND]);
}

// vh.agent-session-packet — cli/agent.js validatePacketShape (strict container) + verifyPacket (the
// AUTHORITATIVE per-event leaf/head recompute, delegating to cli/core/agent-session.js), then the
// VERIFIED head root. Using verifyPacket (not the packet's own stored head) means a packet whose
// stored head, leaves, counts, or any event byte was edited is the packet's OWN named reject.
function _agentDigest(artifact) {
  try {
    agent.validatePacketShape(artifact);
  } catch (e) {
    return _no(REASONS.AGENT_PACKET_INVALID, _detail(e));
  }
  let v;
  try {
    v = agent.verifyPacket(artifact);
  } catch (e) {
    // verifyPacket is documented never to throw; fail CLOSED anyway.
    return _no(REASONS.AGENT_PACKET_INVALID, _detail(e));
  }
  if (!v || v.accepted !== true) {
    const seq = v && v.seq !== null && v.seq !== undefined ? ` at seq ${v.seq}` : "";
    return _no(REASONS.AGENT_PACKET_INVALID, `packet verify REJECTED: ${v ? v.reason : "no verdict"}${seq}`);
  }
  return _ok(v.head.root, agent.PACKET_KIND, HOW_FIXED[agent.PACKET_KIND]);
}

// vh.journal-tree-head — the bare { size, root } commitment (cli/journal-log.js's own head shape),
// or its kind-tagged twin. Strict: exact key set, canonical-lowercase root, non-negative safe-integer
// size, and the EMPTY_ROOT consistency both ways (size 0 <=> the exported domain-separated empty
// root — the ONE structural fact checkable without the journal's leaves).
function _journalHeadDigest(artifact, tagged) {
  const allowed = tagged ? ["kind", "size", "root"] : ["size", "root"];
  for (const k of Object.keys(artifact)) {
    if (!allowed.includes(k)) {
      return _no(REASONS.JOURNAL_TREE_HEAD_INVALID, `journal tree head has unknown field: ${JSON.stringify(k)}`);
    }
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) {
    return _no(
      REASONS.JOURNAL_TREE_HEAD_INVALID,
      `journal tree head size must be a non-negative integer, got: ${String(artifact.size)}`
    );
  }
  if (typeof artifact.root !== "string" || !HEX32_LC_RE.test(artifact.root)) {
    return _no(
      REASONS.JOURNAL_TREE_HEAD_INVALID,
      `journal tree head root must be a LOWERCASE 0x-bytes32 hex string, got: ${String(artifact.root)}`
    );
  }
  if (artifact.size === 0 && artifact.root !== journalLog.EMPTY_ROOT) {
    return _no(
      REASONS.JOURNAL_TREE_HEAD_INVALID,
      `an EMPTY journal tree head (size 0) must carry the documented empty root ${journalLog.EMPTY_ROOT}`
    );
  }
  if (artifact.size > 0 && artifact.root === journalLog.EMPTY_ROOT) {
    return _no(
      REASONS.JOURNAL_TREE_HEAD_INVALID,
      "a non-empty journal tree head cannot carry the domain-separated EMPTY root"
    );
  }
  return _ok(artifact.root, JOURNAL_TREE_HEAD_KIND, _journalHow(artifact.size));
}

// trustledger.reconcile-seal — trustledger/seal.js readSeal (strict structure + root re-derivation
// over files + the verdict/role header), then `root`.
function _trustledgerDigest(artifact) {
  try {
    tlSeal.readSeal(artifact);
  } catch (e) {
    return _no(REASONS.TRUSTLEDGER_SEAL_INVALID, _detail(e));
  }
  return _ok(artifact.root.toLowerCase(), tlSeal.SEAL_KIND, HOW_FIXED[tlSeal.SEAL_KIND]);
}

// The canonical UNSIGNED attestation field set (dataset and parcel share it). The shipped canonical
// serializers emit EXACTLY these keys and DROP anything else, so an unknown key would otherwise ride
// along unbound by the digest — reject it instead (defense on top of the shipped validator, which is
// still reused verbatim inside the serializer).
const ATTESTATION_FIELDS = Object.freeze([
  "kind",
  "schemaVersion",
  "note",
  "root",
  "fileCount",
  "manifestDigest",
  "signed",
  "signature",
]);

function _attestationDigest(artifact, serialize, kind, reason) {
  for (const k of Object.keys(artifact)) {
    if (!ATTESTATION_FIELDS.includes(k)) {
      return _no(
        reason,
        `attestation has unknown field ${JSON.stringify(k)} (the canonical bytes would not bind it)`
      );
    }
  }
  let canonical;
  try {
    canonical = serialize(artifact); // validates first (the shipped validator, reused verbatim)
  } catch (e) {
    return _no(reason, _detail(e));
  }
  let digest;
  try {
    digest = "0x" + coreTimestamp.sha256Hex(canonical);
  } catch (e) {
    return _no(reason, _detail(e)); // unreachable for a string; kept total
  }
  return _ok(digest, kind, HOW_FIXED[kind]);
}

/**
 * Extract the ONE canonical 32-byte digest a chain record binds for `artifact` — a caller-supplied
 * PARSED object (this core does no I/O; read + JSON.parse the file yourself, like every cli/core/*).
 * Strict dispatch over the CLOSED kind table; each leg reuses the shipped validator VERBATIM before
 * extracting. TOTAL: hostile input yields a named { ok:false, reason, detail? }, never a throw.
 *
 * @param {any} artifact a parsed sealed-product artifact (see the module-header table)
 * @returns {{ ok:true, digest:string, kind:string, how:string } |
 *           { ok:false, reason:string, detail?:string }}
 *          digest is a canonical LOWERCASE 0x-bytes32; `how` the human-readable derivation rule.
 */
function artifactDigest(artifact) {
  try {
    if (!isPlainObject(artifact)) {
      return _no(REASONS.NOT_AN_OBJECT, "artifact must be a parsed JSON object");
    }
    const kind = artifact.kind;
    if (kind === undefined) {
      // The bare journal tree head { size, root } is the ONE table entry that carries no kind of
      // its own (it is cli/journal-log.js's head shape verbatim). Anything else without a kind is
      // not dispatchable — a named reject, never a guess.
      if ("size" in artifact || "root" in artifact) {
        return _journalHeadDigest(artifact, false);
      }
      return _no(REASONS.UNKNOWN_KIND, "artifact carries no `kind` and is not a { size, root } journal tree head");
    }
    if (typeof kind !== "string") {
      return _no(REASONS.UNKNOWN_KIND, "artifact `kind` must be a string");
    }
    switch (kind) {
      case evidence.SEAL_KIND:
        return _evidenceDigest(artifact);
      case agent.PACKET_KIND:
        return _agentDigest(artifact);
      case JOURNAL_TREE_HEAD_KIND:
        return _journalHeadDigest(artifact, true);
      case tlSeal.SEAL_KIND:
        return _trustledgerDigest(artifact);
      case dataset.ATTESTATION_KIND:
        return _attestationDigest(
          artifact,
          dataset.serializeAttestation,
          dataset.ATTESTATION_KIND,
          REASONS.DATASET_ATTESTATION_INVALID
        );
      case parcel.PARCEL_ATTESTATION_KIND:
        return _attestationDigest(
          artifact,
          parcel.serializeParcelAttestation,
          parcel.PARCEL_ATTESTATION_KIND,
          REASONS.PARCEL_ATTESTATION_INVALID
        );
      default:
        return _no(
          REASONS.UNKNOWN_KIND,
          `unknown artifact kind ${JSON.stringify(kind)} (the closed table: ${ARTIFACT_KINDS.join(", ")})`
        );
    }
  } catch (e) {
    // The legs are individually total; this is the fail-CLOSED belt for truly hostile shapes.
    return _no(REASONS.NOT_AN_OBJECT, _detail(e));
  }
}

// ---------------------------------------------------------------------------------------------------
// Chain-facts validation, shared by build (reason bad-chain) and receipt validation (bad-receipt).
// STRICT FORM ONLY: this pure core has no network, so it pins types/canonical-case/ranges — whether
// the VALUES are true on chain is exactly what T-70.2's `--rpc` read-back re-checks.
// ---------------------------------------------------------------------------------------------------

const CHAIN_FIELDS = Object.freeze([
  "authorBound",
  "blockNumber",
  "blockTime",
  "chainId",
  "contract",
  "contributor",
  "txHash",
]);

function _checkChain(chain) {
  if (!isPlainObject(chain)) {
    return { ok: false, field: "chain", detail: "chain must be an object of the seven recorded chain facts" };
  }
  for (const k of Object.keys(chain)) {
    if (!CHAIN_FIELDS.includes(k)) {
      return { ok: false, field: `chain.${k}`, detail: `chain has unknown field: ${JSON.stringify(k)}` };
    }
  }
  for (const k of CHAIN_FIELDS) {
    if (!(k in chain)) {
      return { ok: false, field: `chain.${k}`, detail: `chain is missing required field: ${JSON.stringify(k)}` };
    }
  }
  if (typeof chain.authorBound !== "boolean") {
    return { ok: false, field: "chain.authorBound", detail: "authorBound must be a boolean" };
  }
  for (const k of ["blockNumber", "blockTime"]) {
    if (!Number.isSafeInteger(chain[k]) || chain[k] < 0) {
      return { ok: false, field: `chain.${k}`, detail: `${k} must be a non-negative integer, got: ${String(chain[k])}` };
    }
  }
  if (!Number.isSafeInteger(chain.chainId) || chain.chainId < 1) {
    return { ok: false, field: "chain.chainId", detail: `chainId must be a positive integer, got: ${String(chain.chainId)}` };
  }
  for (const k of ["contract", "contributor"]) {
    if (typeof chain[k] !== "string" || !ADDRESS_LC_RE.test(chain[k])) {
      return {
        ok: false,
        field: `chain.${k}`,
        detail: `${k} must be a LOWERCASE 0x-address (canonical case), got: ${String(chain[k])}`,
      };
    }
  }
  if (typeof chain.txHash !== "string" || !HEX32_LC_RE.test(chain.txHash)) {
    return {
      ok: false,
      field: "chain.txHash",
      detail: `txHash must be a LOWERCASE 0x-bytes32 hex string, got: ${String(chain.txHash)}`,
    };
  }
  return { ok: true };
}

function _checkLabel(label) {
  if (typeof label !== "string" || label.length === 0 || label.length > 200 || CONTROL_CHAR_RE.test(label)) {
    return {
      ok: false,
      detail: "artifactLabel, when present, must be a 1..200-char string with no control characters",
    };
  }
  return { ok: true };
}

/** A canonical chain-facts copy in sorted key order (build re-emits, never aliases caller state). */
function _canonicalChain(chain) {
  return {
    authorBound: chain.authorBound,
    blockNumber: chain.blockNumber,
    blockTime: chain.blockTime,
    chainId: chain.chainId,
    contract: chain.contract,
    contributor: chain.contributor,
    txHash: chain.txHash,
  };
}

// ---------------------------------------------------------------------------------------------------
// (b) buildAnchoredReceipt(params) — the canonical, versioned, sorted-key receipt container.
// ---------------------------------------------------------------------------------------------------

/**
 * Build the anchored-receipt container from a digest extraction ({ digest, kind, how } — normally
 * artifactDigest's own ok-result) plus the chain facts of the registry record that anchored it.
 * The result's keys are in SORTED order at every level, so `JSON.stringify(receipt) + "\n"` IS the
 * canonical byte serialization — no separate serializer to drift. TOTAL: named rejects, no throws.
 *
 * @param {object} params
 * @param {string}  params.digest        the anchored digest (LOWERCASE 0x-bytes32)
 * @param {string}  params.kind          the artifact's kind (one of the closed table)
 * @param {string}  params.how           the derivation rule artifactDigest returned for that kind
 * @param {string} [params.artifactLabel] optional presentation label (e.g. a file name) — NOT
 *                                        digest-bound; edits to it are not tamper-evident
 * @param {object}  params.chain         { authorBound, blockNumber, blockTime, chainId, contract,
 *                                         contributor, txHash } — strict form, see _checkChain
 * @returns {{ ok:true, receipt:object } | { ok:false, reason:string, field?:string, detail?:string }}
 */
function buildAnchoredReceipt(params) {
  try {
    if (!isPlainObject(params)) {
      return _no(REASONS.BAD_ARGS, "buildAnchoredReceipt requires { digest, kind, how, chain }");
    }
    if (typeof params.digest !== "string" || !HEX32_LC_RE.test(params.digest)) {
      return _no(REASONS.BAD_DIGEST, `digest must be a LOWERCASE 0x-bytes32 hex string, got: ${String(params.digest)}`);
    }
    if (typeof params.kind !== "string" || !ARTIFACT_KINDS.includes(params.kind)) {
      return _no(
        REASONS.UNKNOWN_KIND,
        `unknown artifact kind ${JSON.stringify(params.kind)} (the closed table: ${ARTIFACT_KINDS.join(", ")})`
      );
    }
    if (!_howValidFor(params.kind, params.how)) {
      return _no(
        REASONS.BAD_HOW,
        `\`how\` must be the documented derivation rule for ${params.kind} (pass artifactDigest's own \`how\` through)`
      );
    }
    if (params.artifactLabel !== undefined) {
      const l = _checkLabel(params.artifactLabel);
      if (!l.ok) return _no(REASONS.BAD_LABEL, l.detail);
    }
    const c = _checkChain(params.chain);
    if (!c.ok) return { ok: false, reason: REASONS.BAD_CHAIN, field: c.field, detail: c.detail };

    // Sorted-key assembly (artifactKind < artifactLabel < chain < digest < how < kind < note).
    const receipt = {};
    receipt.artifactKind = params.kind;
    if (params.artifactLabel !== undefined) receipt.artifactLabel = params.artifactLabel;
    receipt.chain = _canonicalChain(params.chain);
    receipt.digest = params.digest;
    receipt.how = params.how;
    receipt.kind = ANCHORED_RECEIPT_KIND;
    receipt.note = ANCHOR_TRUST_NOTE;
    return { ok: true, receipt };
  } catch (e) {
    return _no(REASONS.BAD_ARGS, _detail(e));
  }
}

// ---------------------------------------------------------------------------------------------------
// Receipt validation (strict; every deviation a named `bad-receipt` with the offending field).
// ---------------------------------------------------------------------------------------------------

const RECEIPT_FIELDS = Object.freeze(["artifactKind", "artifactLabel", "chain", "digest", "how", "kind", "note"]);
const RECEIPT_REQUIRED = Object.freeze(["artifactKind", "chain", "digest", "how", "kind", "note"]);

function _badReceipt(field, detail) {
  return { ok: false, reason: REASONS.BAD_RECEIPT, field, detail };
}

function _validateReceipt(receipt) {
  if (!isPlainObject(receipt)) {
    return _badReceipt("receipt", "receipt must be a parsed JSON object");
  }
  for (const k of Object.keys(receipt)) {
    if (!RECEIPT_FIELDS.includes(k)) {
      return _badReceipt(k, `receipt has unknown field: ${JSON.stringify(k)}`);
    }
  }
  for (const k of RECEIPT_REQUIRED) {
    if (!(k in receipt)) {
      return _badReceipt(k, `receipt is missing required field: ${JSON.stringify(k)}`);
    }
  }
  if (receipt.kind !== ANCHORED_RECEIPT_KIND) {
    return _badReceipt(
      "kind",
      `not an anchored receipt this build understands (kind: ${JSON.stringify(receipt.kind)}; expected ${JSON.stringify(ANCHORED_RECEIPT_KIND)})`
    );
  }
  if (receipt.note !== ANCHOR_TRUST_NOTE) {
    return _badReceipt("note", "receipt `note` must be the standing trust note VERBATIM (the caveat must not drift)");
  }
  if (typeof receipt.digest !== "string" || !HEX32_LC_RE.test(receipt.digest)) {
    return _badReceipt("digest", `receipt digest must be a LOWERCASE 0x-bytes32 hex string, got: ${String(receipt.digest)}`);
  }
  if (typeof receipt.artifactKind !== "string" || !ARTIFACT_KINDS.includes(receipt.artifactKind)) {
    return _badReceipt(
      "artifactKind",
      `receipt artifactKind ${JSON.stringify(receipt.artifactKind)} is not in the closed table (${ARTIFACT_KINDS.join(", ")})`
    );
  }
  if (!_howValidFor(receipt.artifactKind, receipt.how)) {
    return _badReceipt("how", `receipt \`how\` is not the documented derivation rule for ${receipt.artifactKind}`);
  }
  if (receipt.artifactLabel !== undefined) {
    const l = _checkLabel(receipt.artifactLabel);
    if (!l.ok) return _badReceipt("artifactLabel", l.detail);
  }
  const c = _checkChain(receipt.chain);
  if (!c.ok) return _badReceipt(c.field, c.detail);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------
// (c) verifyAnchoredReceipt({ receipt, artifact }) — the pure, offline binding check.
// ---------------------------------------------------------------------------------------------------

/**
 * Verify that `receipt` is a well-formed anchored receipt AND that it binds EXACTLY the supplied
 * `artifact`: the receipt is validated strictly, the digest is RECOMPUTED from the artifact via the
 * SAME closed table (never trusted from either side), and the full { kind, digest, how } triple must
 * match. NEVER consults a network — the receipt's chain facts are returned for the caller (T-70.2's
 * `--rpc` mode re-checks them against the chain). TOTAL: named rejects, no throws.
 *
 * @param {object} args { receipt, artifact } — both caller-supplied PARSED objects
 * @returns {{ ok:true, digest:string, chain:object } |
 *           { ok:false, reason:string, field?:string, detail?:string }}
 */
function verifyAnchoredReceipt(args) {
  try {
    if (!isPlainObject(args)) {
      return _no(REASONS.BAD_ARGS, "verifyAnchoredReceipt requires { receipt, artifact }");
    }
    const r = _validateReceipt(args.receipt);
    if (!r.ok) return r;
    const d = artifactDigest(args.artifact);
    if (!d.ok) return d; // the artifact's OWN named validation reject, propagated verbatim
    const receipt = args.receipt;
    if (d.kind !== receipt.artifactKind) {
      return _no(
        REASONS.KIND_MISMATCH,
        `receipt anchors a ${receipt.artifactKind} but the supplied artifact is a ${d.kind}`
      );
    }
    if (d.digest !== receipt.digest) {
      return _no(
        REASONS.DIGEST_MISMATCH,
        `recomputed digest ${d.digest} != receipt digest ${receipt.digest} — this receipt does not bind this artifact`
      );
    }
    if (d.how !== receipt.how) {
      // Same kind + same digest but a different derivation rule — for the journal leg this is
      // exactly an edited head `size` (bound into `how` because it is not derivable from the root).
      return _no(REASONS.HOW_MISMATCH, `recomputed derivation rule != receipt \`how\` (recomputed: ${d.how})`);
    }
    return { ok: true, digest: d.digest, chain: _canonicalChain(receipt.chain) };
  } catch (e) {
    return _no(REASONS.BAD_ARGS, _detail(e));
  }
}

module.exports = {
  // Container framing + the closed table.
  ANCHORED_RECEIPT_KIND,
  ANCHOR_TRUST_NOTE,
  ARTIFACT_KINDS,
  JOURNAL_TREE_HEAD_KIND,
  REASONS,
  // The three core operations.
  artifactDigest,
  buildAnchoredReceipt,
  verifyAnchoredReceipt,
};
