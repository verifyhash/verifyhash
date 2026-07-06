"use strict";

// cli/agent.js — `vh agent` (T-68.2, EPIC-68 "AgentTrace"): the CLI surface over the PURE
// agent-session core (cli/core/agent-session.js, T-68.1).
//
// THE PRODUCT (the agent-evidence vertical on the provenance core).
//   `vh agent seal <session.jsonl>` turns an ORDERED log of AI-agent session events (prompts,
//   completions, tool calls/results, notes) into ONE tamper-evident, selectively-REDACTABLE
//   `*.vhagent.json` packet: an RFC-6962-style Merkle `head` { size, root } over redaction-safe
//   event leaves, the canonical event list (full and/or redacted), per-event leaf expectations,
//   counts, and the in-band trust note. Then:
//     * `vh agent verify <packet>`        RE-DERIVES every leaf (recomputing each full payload's hash
//                                         commitment; checking the carried commitment when redacted)
//                                         and the root — a REJECT NAMES the first offending event seq;
//     * `vh agent redact <packet> --seq`  withholds chosen payloads behind their hash commitments —
//                                         the redacted copy STILL VERIFIES (identical leaves + root);
//     * `vh agent prove / verify-proof`   disclose + check ONE event OFFLINE against the head;
//     * `vh agent checkpoint`             print/emit the head so far (a mid-session commitment);
//     * `vh agent verify-growth`          prove a later packet is an APPEND-ONLY extension of an
//                                         earlier checkpoint/packet head (rewritten past = REJECT);
//     * `vh agent commit-claim`           emit ONE canonical JSONL claim event binding the session to
//                                         a git commit oid + tracked-set root derived from YOUR work
//                                         tree (T-69.2, over the pure cli/core/agent-commit.js core);
//     * `vh agent verify-commit`          the AUDITOR leg: full packet verify FIRST, then re-derive
//                                         oid + root from THEIR OWN clone and match a DISCLOSED claim
//                                         (containment, not causation — see COMMIT_CLAIM_TRUST_NOTE);
//     * `vh agent coverage`               the FLEET gate (T-71.2, over the pure T-71.1 core): which
//                                         commits in a rev-range carry a verifiable session claim —
//                                         report-only by default, a CI exit-3 gate under
//                                         --require-all/--require-since (see COVERAGE_TRUST_NOTE).
//
// FREE vs PAID (the same posture as `vh evidence`).
//   Sealing, verifying, redacting, proving, checkpointing and growth-verifying are FREE — the whole
//   read/verify surface stays open so any third party can check a packet without paying anyone.
//   The PAID surface is `--sign`: wrapping the packet's HEAD in a detached EIP-191 attestation (the
//   operator vouches for THIS session head). It is gated OFFLINE behind a valid
//   `--license <f>` carrying the DRAFT `agent_signed` capability (verified against the CANONICAL
//   vendor identity — cli/core/vendor-identity.js — never a caller-supplied `--vendor`; T-75.3)
//   (cli/core/evidence-plans.js), through the SAME license mechanism `vh evidence seal --sign`
//   uses — cli/core/license.js reused VERBATIM under the SAME `vh-evidence-license` kind, with the
//   entitlement table extended (a strict SUPERSET) by the agent capability. Fail-closed: a missing/
//   invalid/wrong-issuer license, or a valid license that does not CARRY `agent_signed`, is REFUSED
//   with the same named-refusal shape the evidence gate emits — never silently downgraded.
//
// WHY THE SIGNATURE WRAPS THE HEAD (not the packet bytes).
//   Event leaves are REDACTION-SAFE (T-68.1): a full event and its redacted twin derive the
//   IDENTICAL leaf, so redaction changes neither leaves nor root. Signing the HEAD { size, root }
//   therefore keeps ONE signature valid across every redacted copy of the same sealed session —
//   which is the whole point of redactable evidence. Signing the raw packet bytes would break the
//   signature the moment a payload was (legitimately) withheld.
//
// TRUST BOUNDARY (the one-liner every output LEADS with — see AGENT_TRUST_NOTE).
//   The packet proves the LOG is unaltered since seal and append-only across checkpoints; any
//   disclosed event is verbatim as recorded; redaction can WITHHOLD, never silently ALTER. It does
//   NOT prove the log faithfully records what the agent ACTUALLY did (garbage-in is out of scope),
//   `ts` fields are SELF-ASSERTED, and nothing here is a trusted timestamp (P-3) or a legal opinion.
//
// PURE CORES + a THIN CLI. All leaf/root/proof math lives in cli/core/agent-session.js (which reuses
// cli/journal-log.js + cli/hash.js verbatim); all signing/recovery lives in cli/core/attestation.js;
// all license verification lives in cli/core/license.js. This file is the product framing (packet/
// head/proof/checkpoint shapes + the gate) plus the I/O-bearing run functions. Output shape and exit
// codes are a stable contract: 0 ok/ACCEPTED / 3 named REJECT or gate-fail / 2 usage / 1 IO or a
// structurally invalid artifact. Side-effect files land ONLY at an explicit --out path — never cwd.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { getAddress } = require("ethers");

const agentSession = require("./core/agent-session");
const agentCommit = require("./core/agent-commit");
const agentCoverage = require("./core/agent-coverage");
const coreAttestation = require("./core/attestation");
const coreLicense = require("./core/license");
const evidencePlans = require("./core/evidence-plans");
const evidence = require("./evidence");
const git = require("./git");
const { hashGit } = require("./hash");

const {
  REASONS,
  validateEvent,
  validateSession,
  eventLeaf,
  redactEvent,
  sessionHead,
  proveEvent,
  verifyEvent,
  proveGrowth,
  verifyGrowth,
} = agentSession;

// Exit contract (shared with the whole family): 0 ok / 1 IO or invalid artifact / 2 usage /
// 3 named gate-fail (verify REJECTED, license refused, redact/prove on a broken packet).
const EXIT = evidence.EXIT;

// ---------------------------------------------------------------------------
// THE PACKET / HEAD / PROOF / CHECKPOINT product framing — kind-disjoint via the SAME config
// discipline cli/core/packetseal.js established for the family: a distinct `kind` per artifact, a
// schemaVersion + supported list, an in-band trust note, and STRICT validation (a malformed or
// foreign artifact raises a NAMED error, never a half-accept). No artifact here can be mistaken for
// an evidence seal, a dataset manifest, or a journal proof — and vice versa.
// ---------------------------------------------------------------------------

const PACKET_KIND = "vh.agent-session-packet";
const PACKET_SCHEMA_VERSION = 1;
const SUPPORTED_PACKET_SCHEMA_VERSIONS = Object.freeze([1]);

const AGENT_HEAD_KIND = "vh.agent-head";
const AGENT_HEAD_SCHEMA_VERSION = 1;

const SIGNED_HEAD_KIND = "vh.agent-head-signed";
const SIGNED_HEAD_SCHEMA_VERSION = 1;
const SUPPORTED_SIGNED_HEAD_SCHEMA_VERSIONS = Object.freeze([1]);

const CHECKPOINT_KIND = "vh.agent-checkpoint";
const CHECKPOINT_SCHEMA_VERSION = 1;
const SUPPORTED_CHECKPOINT_SCHEMA_VERSIONS = Object.freeze([1]);

const PROOF_KIND = "vh.agent-event-proof";
const PROOF_SCHEMA_VERSION = 1;
const SUPPORTED_PROOF_SCHEMA_VERSIONS = Object.freeze([1]);

// The size ceiling (bytes) for ANY input artifact this CLI reads (session logs, packets, proofs,
// checkpoints). A hostile oversized file is a NAMED reject BEFORE it is read into memory — never an
// OOM. Generous for real transcripts; bump deliberately, never implicitly.
const MAX_INPUT_BYTES = 64 * 1024 * 1024; // 64 MiB

// The TRUST-BOUNDARIES one-liner every output LEADS with — stated ONCE so the human, JSON, and
// in-band packet paths agree and the caveat can never drift. It is the load-bearing honesty of the
// artifact (the T-68.1 core's documented boundary, carried in-band).
// FROZEN WIRE BYTES (T-78.2): this note is embedded VERBATIM in every packet (`note`) and pinned
// byte-for-byte at verify time (see the `obj.note !== AGENT_TRUST_NOTE` checks below and the shipped
// dist bundles) — repointing its internal "STRATEGY.md P-3" reference would invalidate every
// already-issued packet. The pointer's public, stable target is
// docs/TRUST-BOUNDARIES.md#p-3-trust-root ("Human-owned steps"); new prose must point THERE.
const AGENT_TRUST_NOTE =
  "This agent-session packet is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp and " +
  "NOT a claim the agent behaved well. Its ordered Merkle `head` {size, root} (RFC-6962-style, " +
  "position-bound) commits to every event: verify RE-DERIVES each event leaf — recomputing the " +
  "payload hash commitment for a FULL event, checking the carried commitment for a REDACTED one — " +
  "and the root from the events you hold, and a REJECT names the first offending event seq. " +
  "Redaction WITHHOLDS a payload behind its hash commitment without changing any leaf or the root: " +
  "it can hide, never silently alter. Event `ts` fields are SELF-ASSERTED metadata (recorded, never " +
  'verified against any clock); "sealed at time T" rides the human-owned signing/timestamp ' +
  "trust-root (STRATEGY.md P-3). Garbage-in is out of scope: the head proves the LOG is intact and " +
  "append-only, not that the log faithfully records what the agent actually did. The packet is an " +
  "UNTRUSTED transport container: verify never trusts the packet's own stored hashes.";

const SIGNED_HEAD_TRUST_NOTE =
  "This is a SIGNED agent-session HEAD attestation: it WRAPS (never edits) the EXACT canonical head " +
  "bytes in `attestation` and attaches a detached EIP-191 signature. It asserts the holder of the " +
  "`signer` key vouched for THIS session head {size, root} at signing time. Because event leaves " +
  "are redaction-safe, the SAME signature stays valid for every redacted copy of the sealed session " +
  "(redaction changes neither leaves nor root). It does NOT prove a timestamp (no \"sealed since " +
  "T\" — still the human trust-root P-3) and is NOT a legal opinion. Every caveat of the packet " +
  "applies. " +
  AGENT_TRUST_NOTE;

// The commit-claim trust line (T-69.2) — stated ONCE so the producer verb, the auditor verb, and
// their --json envelopes agree and the caveat can never drift. The load-bearing honesty:
// CONTAINMENT, not CAUSATION (the T-69.1 core's documented boundary, carried into every output).
const COMMIT_CLAIM_TRUST_NOTE =
  "A commit-claim is an ORDINARY session event binding a claim to EXACTLY one git commit oid and " +
  "its tracked-set root (the `vh hash --git` work-tree root over the files git tracks at that " +
  "commit). Sealed into a packet it proves CONTAINMENT, NOT CAUSATION: the unaltered log CONTAINS " +
  "this claim — it does NOT prove the session's events PRODUCED that commit. The auditor re-derives " +
  "BOTH facts from THEIR OWN clone via `vh agent verify-commit` (free, read-only, key-less); " +
  "because hashGit reads WORK-TREE bytes, a dirty checkout is an HONEST root mismatch, never a " +
  "false ACCEPT. `scope` is an UNVERIFIED hint; `ts` is SELF-ASSERTED metadata like every event " +
  "ts. Every caveat of the agent-session packet applies (see `vh agent verify`).";

// A dedicated, NAMED error type for malformed/foreign agent artifacts (the packetseal discipline:
// strict validation raises a named error, callers map it to a named CLI reject — never a throw that
// escapes to the user as a stack trace).
class AgentPacketError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentPacketError";
  }
}

// Canonical-case hex: lowercase-only, for the SAME byte-determinism reason the attestation core
// rejects mixed-case signatures — one logical value must have exactly one wire encoding.
const HEX32_LC_RE = /^0x[0-9a-f]{64}$/;

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// THE AGENT LICENSE framing — the EXISTING evidence license mechanism REUSED VERBATIM
// (cli/core/license.js + the SAME `vh-evidence-license` kind/notes/vendor key: NO new license kind,
// NO new key, NO new needs-human step), with the entitlement table extended — a strict SUPERSET —
// by the DRAFT `agent_signed` capability declared in cli/core/evidence-plans.js. An existing
// evidence license validates under this framing unchanged; it simply does not CARRY `agent_signed`,
// so the gate refuses it (fail-closed). The evidence product's own cfg is untouched.
// ---------------------------------------------------------------------------

const AGENT_LICENSE_CFG = Object.freeze({
  ...evidence.LICENSE_CFG,
  entitlements: Object.freeze({
    ...evidence.LICENSE_CFG.entitlements,
    ...evidencePlans.AGENT_CAPABILITIES,
  }),
});

const AGENT_SIGNED_CAPABILITY = evidencePlans.AGENT_SIGNED_CAPABILITY;

// ---------------------------------------------------------------------------
// The signed-HEAD attestation framing — handed to cli/core/attestation.js (the SAME shared envelope
// `vh evidence seal --sign` uses; no new crypto, no new scheme).
// ---------------------------------------------------------------------------

/** STRICT validation of an UNSIGNED head payload. Throws AgentPacketError on the first problem. */
function validateHeadPayload(obj) {
  if (!isPlainObject(obj)) {
    throw new AgentPacketError("agent-session head payload must be a JSON object");
  }
  const KNOWN = ["kind", "schemaVersion", "note", "head"];
  for (const k of Object.keys(obj)) {
    if (!KNOWN.includes(k)) {
      throw new AgentPacketError(`agent-session head payload has unknown field: ${JSON.stringify(k)}`);
    }
  }
  if (obj.kind !== AGENT_HEAD_KIND) {
    throw new AgentPacketError(
      `not an agent-session head payload (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(AGENT_HEAD_KIND)})`
    );
  }
  if (obj.schemaVersion !== AGENT_HEAD_SCHEMA_VERSION) {
    throw new AgentPacketError(
      `unsupported agent-session head schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands [${AGENT_HEAD_SCHEMA_VERSION}])`
    );
  }
  if (obj.note !== AGENT_TRUST_NOTE) {
    throw new AgentPacketError(
      "agent-session head payload `note` must be the standing trust note (caveat must not drift)"
    );
  }
  _validateHeadShape(obj.head, "agent-session head payload");
  return obj;
}

// The { size, root } head shape shared by packets, checkpoints, proofs and the head payload.
function _validateHeadShape(head, label) {
  if (!isPlainObject(head)) {
    throw new AgentPacketError(`${label} \`head\` must be a { size, root } object`);
  }
  for (const k of Object.keys(head)) {
    if (k !== "size" && k !== "root") {
      throw new AgentPacketError(`${label} head has unknown field: ${JSON.stringify(k)}`);
    }
  }
  if (!Number.isSafeInteger(head.size) || head.size < 0) {
    throw new AgentPacketError(`${label} head.size must be a non-negative integer, got: ${String(head.size)}`);
  }
  if (typeof head.root !== "string" || !HEX32_LC_RE.test(head.root)) {
    throw new AgentPacketError(
      `${label} head.root must be a LOWERCASE 0x-bytes32 hex string ` +
        `(one canonical encoding, byte-determinism), got: ${String(head.root)}`
    );
  }
}

/** Canonical, byte-deterministic serialization of an UNSIGNED head payload (newline-terminated). */
function serializeHeadPayload(obj) {
  validateHeadPayload(obj);
  return (
    JSON.stringify({
      kind: obj.kind,
      schemaVersion: obj.schemaVersion,
      note: obj.note,
      head: { size: obj.head.size, root: obj.head.root },
    }) + "\n"
  );
}

const SIGNED_HEAD_CFG = Object.freeze({
  kind: SIGNED_HEAD_KIND,
  schemaVersion: SIGNED_HEAD_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_SIGNED_HEAD_SCHEMA_VERSIONS,
  note: SIGNED_HEAD_TRUST_NOTE,
  label: "signed agent-session head",
  validateUnsigned: validateHeadPayload,
  serializeUnsigned: serializeHeadPayload,
});

// ---------------------------------------------------------------------------
// PACKET build / validate / serialize / verify — pure (the callers do all I/O).
// ---------------------------------------------------------------------------

/**
 * Build the canonical packet object from an ORDERED event array. PURE; never throws — a bad session
 * yields the core's NAMED, LOCATED reject. Each event is re-emitted in canonical form with its
 * payload hash commitment ALWAYS carried (so a later one-byte payload tamper is localized to its
 * seq by the commitment cross-check, exactly the packetseal per-file-expectation discipline), plus
 * a parallel per-event `leaves` expectation list. The recompute stays authoritative on verify.
 *
 * @param {object[]} events canonical events (full and/or redacted), seq-contiguous from 0.
 * @returns {{ ok:true, packet:object } | { ok:false, reason:string, index?:number, field?:string }}
 */
function buildPacket(events) {
  const s = validateSession(events);
  if (!s.ok) return s;
  const canon = [];
  const leaves = [];
  let redactedCount = 0;
  for (const e of events) {
    const v = validateEvent(e); // ok — validateSession already passed
    const c = { seq: e.seq, ts: e.ts, actor: e.actor, type: e.type };
    if (!v.redacted) c.payload = e.payload;
    c.payloadHash = v.payloadHash;
    if (v.redacted) {
      c.redacted = true;
      redactedCount++;
    }
    if (v.metaJson !== null) c.meta = JSON.parse(v.metaJson); // canonical deep copy
    canon.push(c);
    leaves.push(eventLeaf(c));
  }
  const head = sessionHead(canon);
  if (!head.ok) return head; // unreachable post-validation; kept total
  return {
    ok: true,
    packet: {
      kind: PACKET_KIND,
      schemaVersion: PACKET_SCHEMA_VERSION,
      note: AGENT_TRUST_NOTE,
      head: { size: head.size, root: head.root },
      counts: { events: canon.length, full: canon.length - redactedCount, redacted: redactedCount },
      events: canon,
      leaves,
    },
  };
}

/**
 * STRICT STRUCTURAL validation of a parsed packet (shape only — the per-event/leaf/root RECOMPUTE
 * is verifyPacket's job, so event-level tamper stays a NAMED verify VERDICT that names the seq, not
 * a structural throw). Throws AgentPacketError on the first problem: foreign/absent kind, unsupported
 * schemaVersion, a drifted note, an unknown top-level field (a `..`/path-shaped smuggled field is
 * rejected HERE by name — nothing in a packet is ever interpreted as a filesystem path), malformed
 * head/counts/events/leaves, or a malformed/foreign headAttestation container.
 */
function validatePacketShape(obj) {
  if (!isPlainObject(obj)) {
    throw new AgentPacketError("agent-session packet must be a JSON object");
  }
  const KNOWN = ["kind", "schemaVersion", "note", "head", "counts", "events", "leaves", "headAttestation"];
  for (const k of Object.keys(obj)) {
    if (!KNOWN.includes(k)) {
      throw new AgentPacketError(`agent-session packet has unknown field: ${JSON.stringify(k)}`);
    }
  }
  if (obj.kind !== PACKET_KIND) {
    throw new AgentPacketError(
      `not an agent-session packet (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(PACKET_KIND)})`
    );
  }
  if (!SUPPORTED_PACKET_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new AgentPacketError(
      `unsupported agent-session packet schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_PACKET_SCHEMA_VERSIONS)})`
    );
  }
  if (obj.note !== AGENT_TRUST_NOTE) {
    throw new AgentPacketError(
      "agent-session packet `note` must be the standing trust note (caveat must not drift)"
    );
  }
  _validateHeadShape(obj.head, "agent-session packet");
  if (!isPlainObject(obj.counts)) {
    throw new AgentPacketError("agent-session packet `counts` must be a { events, full, redacted } object");
  }
  for (const k of Object.keys(obj.counts)) {
    if (!["events", "full", "redacted"].includes(k)) {
      throw new AgentPacketError(`agent-session packet counts has unknown field: ${JSON.stringify(k)}`);
    }
  }
  for (const k of ["events", "full", "redacted"]) {
    if (!Number.isSafeInteger(obj.counts[k]) || obj.counts[k] < 0) {
      throw new AgentPacketError(
        `agent-session packet counts.${k} must be a non-negative integer, got: ${String(obj.counts[k])}`
      );
    }
  }
  if (!Array.isArray(obj.events)) {
    throw new AgentPacketError("agent-session packet `events` must be an array");
  }
  if (!Array.isArray(obj.leaves) || obj.leaves.length !== obj.events.length) {
    throw new AgentPacketError(
      "agent-session packet `leaves` must be an array with EXACTLY one leaf expectation per event"
    );
  }
  obj.leaves.forEach((l, i) => {
    if (typeof l !== "string" || !HEX32_LC_RE.test(l)) {
      throw new AgentPacketError(
        `agent-session packet leaves[${i}] must be a LOWERCASE 0x-bytes32 hex string, got: ${String(l)}`
      );
    }
  });
  if (obj.head.size !== obj.events.length) {
    throw new AgentPacketError(
      `agent-session packet head.size (${obj.head.size}) does not match the events length (${obj.events.length})`
    );
  }
  if (obj.counts.events !== obj.events.length || obj.counts.full + obj.counts.redacted !== obj.counts.events) {
    throw new AgentPacketError(
      "agent-session packet `counts` is internally inconsistent (events must equal the events length; full + redacted must equal events)"
    );
  }
  if (obj.headAttestation !== undefined) {
    // The signed-head container is validated by the SHARED attestation core (strict: canonical
    // embedded bytes, known scheme, lowercase signer/signature). Its message is re-tagged as an
    // AgentPacketError so callers catch ONE named artifact error.
    try {
      coreAttestation.validateSignedAttestation(obj.headAttestation, SIGNED_HEAD_CFG);
    } catch (e) {
      throw new AgentPacketError(`agent-session packet headAttestation is invalid: ${e.message}`);
    }
  }
  return obj;
}

/** Canonical, byte-deterministic packet serialization (fixed key order, newline-terminated). */
function serializePacket(packet) {
  validatePacketShape(packet);
  const out = {
    kind: packet.kind,
    schemaVersion: packet.schemaVersion,
    note: packet.note,
    head: { size: packet.head.size, root: packet.head.root },
    counts: {
      events: packet.counts.events,
      full: packet.counts.full,
      redacted: packet.counts.redacted,
    },
    events: packet.events.map((e) => {
      // Canonical event key order. Events are re-emitted from their own fields (already validated
      // canonical by build/verify paths); serialization never invents or drops a field.
      const c = { seq: e.seq, ts: e.ts, actor: e.actor, type: e.type };
      if ("payload" in e) c.payload = e.payload;
      if ("payloadHash" in e) c.payloadHash = e.payloadHash;
      if ("redacted" in e) c.redacted = e.redacted;
      if ("meta" in e) c.meta = e.meta;
      return c;
    }),
    leaves: packet.leaves.slice(),
  };
  if (packet.headAttestation !== undefined) {
    out.headAttestation = {
      kind: packet.headAttestation.kind,
      schemaVersion: packet.headAttestation.schemaVersion,
      note: packet.headAttestation.note,
      attestation: packet.headAttestation.attestation,
      signature: {
        scheme: packet.headAttestation.signature.scheme,
        signer: packet.headAttestation.signature.signer,
        signature: packet.headAttestation.signature.signature,
      },
    };
  }
  return JSON.stringify(out) + "\n";
}

/**
 * The AUTHORITATIVE, PURE packet verify. RE-DERIVES every event leaf (recomputing `payloadHash`
 * from `payload` for full events — the core cross-checks the carried commitment — and taking the
 * well-formed commitment for redacted ones) and the root, compares them against the packet's stored
 * EXPECTATIONS (leaves + head — the packet is an untrusted container), recounts full/redacted, and,
 * for a signed packet, recovers the head-attestation signer and (optionally) PINS it to
 * `vendorAddress`. Never throws; a REJECT carries a stable named `reason` and — whenever the fault
 * is event-local — the first offending event `seq`.
 *
 * Fail-closed pin: `vendorAddress` given + UNSIGNED packet => REJECTED (NOT_SIGNED); a stripped
 * signature can never pass a pinned verify.
 *
 * @param {object} packet a shape-validated packet (validatePacketShape).
 * @param {object} [opts] { vendorAddress?: lowercase 0x-address to pin the head signer to }
 * @returns {object} { verdict, accepted, reason, seq, head, counts, withheld, signed, signature }
 */
function verifyPacket(packet, opts = {}) {
  const vendor = opts.vendorAddress || null;
  function reject(reason, extra = {}) {
    return {
      verdict: "REJECTED",
      accepted: false,
      reason,
      seq: extra.seq !== undefined ? extra.seq : null,
      head: extra.head || null,
      counts: null,
      withheld: null,
      signed: !!packet.headAttestation,
      signature: extra.signature || null,
      ...(extra.detail ? { detail: extra.detail } : {}),
    };
  }
  try {
    // (1) Every event must be a sound canonical event with contiguous seqs. The core's verdict is
    //     NAMED and LOCATED — a one-byte payload tamper lands here as EVENT_PAYLOAD_HASH_MISMATCH at
    //     the offending index (== seq in a well-formed packet).
    const s = validateSession(packet.events);
    if (!s.ok) {
      return reject(s.reason, { seq: s.index !== undefined ? s.index : null, detail: s.field });
    }
    // (2) Per-event leaf RECOMPUTE vs the stored expectation — localizes a bound-field tamper
    //     (ts/actor/type/meta) to its seq. The recompute is authoritative; the stored leaf is only
    //     the expectation checked against (the packetseal discipline).
    for (let i = 0; i < packet.events.length; i++) {
      const leaf = eventLeaf(packet.events[i]);
      if (leaf === null || leaf !== packet.leaves[i]) {
        return reject("EVENT_LEAF_MISMATCH", { seq: i });
      }
    }
    // (3) The ROOT recompute vs the declared head (size bound too).
    const derived = sessionHead(packet.events);
    if (!derived.ok) return reject(derived.reason, { seq: derived.index !== undefined ? derived.index : null });
    if (derived.size !== packet.head.size || derived.root !== packet.head.root) {
      return reject("HEAD_MISMATCH", {
        detail: `recomputed { size: ${derived.size}, root: ${derived.root} } != declared { size: ${packet.head.size}, root: ${packet.head.root} }`,
      });
    }
    // (4) Counts recount (presentation metadata, but a lying count is still a NAMED reject).
    const withheld = [];
    for (const e of packet.events) if (e.redacted === true) withheld.push(e.seq);
    const full = packet.events.length - withheld.length;
    if (packet.counts.full !== full || packet.counts.redacted !== withheld.length) {
      return reject("COUNTS_MISMATCH", {
        detail: `recounted { full: ${full}, redacted: ${withheld.length} } != declared { full: ${packet.counts.full}, redacted: ${packet.counts.redacted} }`,
      });
    }
    // (5) The signed head, when present (and the fail-closed vendor pin).
    let signature = null;
    if (packet.headAttestation === undefined) {
      if (vendor) {
        return reject("NOT_SIGNED", {
          detail: `--vendor pins the signer of a SIGNED packet, but this packet carries no headAttestation (a stripped signature never passes a pinned verify)`,
        });
      }
    } else {
      const container = packet.headAttestation;
      const embedded = JSON.parse(container.attestation); // canonical — validated by shape
      if (embedded.head.size !== derived.size || embedded.head.root !== derived.root) {
        return reject("HEAD_NOT_BOUND", {
          detail:
            `the headAttestation signs { size: ${embedded.head.size}, root: ${embedded.head.root} } ` +
            `but this packet's events derive { size: ${derived.size}, root: ${derived.root} } — the signature belongs to a DIFFERENT session`,
        });
      }
      const att = coreAttestation.verifySignedAttestation(
        vendor ? { container, expectedSigner: vendor } : { container }
      );
      signature = {
        signatureMatchesSigner: att.checks.signatureMatchesSigner,
        recoveredSigner: att.recoveredSigner,
        claimedSigner: att.claimedSigner,
        scheme: att.scheme,
        vendorPinned: vendor,
        signerMatchesVendor: att.checks.signerMatchesExpected,
      };
      if (!att.checks.signatureMatchesSigner) {
        return reject("SIGNATURE_FORGED", {
          signature,
          detail: `the container claims signer ${att.claimedSigner} but the signature recovers to ${att.recoveredSigner}`,
        });
      }
      if (vendor && att.checks.signerMatchesExpected !== true) {
        return reject("WRONG_VENDOR", {
          signature,
          detail: `the head signature recovers to ${att.recoveredSigner}, not the pinned vendor ${vendor}`,
        });
      }
    }
    return {
      verdict: "ACCEPTED",
      accepted: true,
      reason: null,
      seq: null,
      head: { size: derived.size, root: derived.root },
      counts: { events: packet.events.length, full, redacted: withheld.length },
      withheld,
      signed: !!packet.headAttestation,
      signature,
    };
  } catch (_) {
    return reject(REASONS.HOSTILE_INPUT);
  }
}

// ---------------------------------------------------------------------------
// I/O helpers — the ONLY filesystem-touching code, shared by every verb.
// ---------------------------------------------------------------------------

// Read a size-capped UTF-8 input file. An unreadable file or one over MAX_INPUT_BYTES raises a
// NAMED error carrying `.io = true` — callers map it to exit 1 with the message verbatim.
function readInputText(filePath, label) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    const err = new Error(`cannot read ${label} ${filePath}: ${e.message}`);
    err.io = true;
    throw err;
  }
  if (stat.size > MAX_INPUT_BYTES) {
    const err = new Error(
      `${label} ${filePath} is OVERSIZED (${stat.size} bytes > the ${MAX_INPUT_BYTES}-byte limit) — refusing to read it`
    );
    err.io = true;
    throw err;
  }
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) {
    const err = new Error(`cannot read ${label} ${filePath}: ${e.message}`);
    err.io = true;
    throw err;
  }
}

/**
 * Parse a session log: JSONL (one JSON event per line; blank lines ignored) or a whole-file JSON
 * array. A non-JSON line is a NAMED AgentPacketError naming the 1-based line. Parsing only — the
 * events are validated by the core (named, located rejects) in the caller.
 */
function parseSessionText(text, label) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith("[")) {
    let arr;
    try {
      arr = JSON.parse(trimmed);
    } catch (e) {
      throw new AgentPacketError(`${label} is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(arr)) {
      throw new AgentPacketError(`${label} must be a JSON array of events or JSONL (one event per line)`);
    }
    return arr;
  }
  const events = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    try {
      events.push(JSON.parse(lines[i]));
    } catch (e) {
      throw new AgentPacketError(`${label} line ${i + 1} is not valid JSON: ${e.message}`);
    }
  }
  return events;
}

/** Read + parse + STRICT shape-validate a packet file. Named errors only (never a raw throw). */
function readPacketFile(filePath) {
  const text = readInputText(filePath, "agent-session packet");
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new AgentPacketError(`agent-session packet is not valid JSON: ${e.message}`);
  }
  return validatePacketShape(obj);
}

// Write the artifact to an explicit --out path (caller-chosen; NEVER cwd implicitly) or print it.
function emitArtifact(artifactStr, outOpt, write, writeErr) {
  if (outOpt) {
    const outAbs = path.resolve(outOpt);
    try {
      fs.writeFileSync(outAbs, artifactStr);
    } catch (e) {
      writeErr(`error: cannot write --out file ${outOpt}: ${e.message}\n`);
      return { code: EXIT.IO, outAbs: null };
    }
    return { code: EXIT.OK, outAbs };
  }
  write(artifactStr);
  return { code: EXIT.OK, outAbs: null };
}

// ---------------------------------------------------------------------------
// The license GATE for the paid agent surface — the SAME named-refusal shape (and exit codes) the
// evidence gate emits (cli/evidence.js gatePaid), evaluated OFFLINE against AGENT_LICENSE_CFG.
// Fail-closed: no license, an unreadable/malformed one, an invalid/wrong-issuer/expired one, or a
// VALID one that does not CARRY the capability is REFUSED — never silently downgraded to free.
//
// THE PIN (T-75.3, mirrors cli/evidence.js gatePaid): the license is verified against the CANONICAL
// vendor identity (`canonicalVendor`, resolved OUTSIDE argv), NEVER against the caller-supplied
// `--vendor` — a caller-chosen pin would let anyone self-mint a license and unlock the paid surface
// for free. `--vendor` is accepted only as an assertion that must EQUAL the canonical identity.
// ---------------------------------------------------------------------------

function gateAgentPaid(opts, requested, now, writeErr, canonicalVendor) {
  if (requested.length === 0) {
    return { ok: true, verdict: null }; // FREE tier
  }
  const featureList = requested.map((r) => r.label).join(" and ");

  if (opts.license == null) {
    // NOTE: this refusal stays ADDRESS-FREE (no 0x hex at all) so the "never echoes key material"
    // guard stays trivially auditable; the canonical identity itself is printed by `vh agent -h`.
    writeErr(
      `error: ${featureList} ${requested.length > 1 ? "are" : "is"} a PAID surface and ` +
        "requires a license; pass --license <file>. Licenses are verified OFFLINE against the " +
        "CANONICAL vendor identity (see `vh agent -h`) — only a license minted by that vendor key " +
        "unlocks the paid surface. " +
        "The FREE tier — unsigned seal + verify + redact + prove + verify-proof + checkpoint + " +
        "verify-growth — needs no license.\n"
    );
    return { ok: false, code: EXIT.USAGE };
  }

  // Resolve the ONE pin the gate verifies against (a --vendor mismatch / garbage address is a NAMED
  // usage refusal from the core — never a silent re-pin).
  const cfg =
    canonicalVendor === evidence.CANONICAL_VENDOR_ADDRESS
      ? AGENT_LICENSE_CFG
      : Object.freeze({ ...AGENT_LICENSE_CFG, canonicalVendor });
  let pin;
  try {
    pin = coreLicense.resolveVendorPin(cfg, opts.vendor);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return { ok: false, code: EXIT.USAGE };
  }

  // Read the license OFFLINE (an unreadable/garbled file is a usage error; there is no key in a license).
  let container;
  try {
    const text = fs.readFileSync(path.resolve(opts.license), "utf8");
    container = coreLicense.readLicense(text, AGENT_LICENSE_CFG);
  } catch (e) {
    writeErr(`error: cannot read --license file ${opts.license}: ${e.message}\n`);
    return { ok: false, code: EXIT.USAGE };
  }

  // Verify OFFLINE against the CANONICAL pin resolved above.
  let verdict;
  try {
    verdict = coreLicense.verifyLicense(container, {
      now,
      vendorAddress: pin,
      cfg: AGENT_LICENSE_CFG,
    });
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return { ok: false, code: EXIT.USAGE };
  }
  if (!verdict.valid) {
    const selfMintNote =
      verdict.reason === "wrong_issuer"
        ? " Paid entitlements unlock ONLY with a license minted by the canonical vendor key; a " +
          "self-minted license signed by any other key is refused. Running your OWN instance? Set " +
          "your OWN canonical vendor identity — see docs/LICENSING.md."
        : "";
    writeErr(
      `error: ${featureList} requires a VALID license, but the supplied license is ` +
        `${verdict.reason} (recovered ${verdict.recoveredSigner || "(unrecoverable)"}, ` +
        `pinned to ${verdict.vendorAddress}).${selfMintNote}\n`
    );
    return { ok: false, code: EXIT.FAIL };
  }

  // The license is valid — require it to actually CARRY each requested capability.
  for (const r of requested) {
    if (!coreLicense.hasEntitlement(verdict, r.entitlement)) {
      writeErr(
        `error: the supplied license is valid but does NOT include the "${r.entitlement}" ` +
          `entitlement needed for ${r.label}; it grants only ${JSON.stringify(verdict.entitlements)}.\n`
      );
      return { ok: false, code: EXIT.FAIL };
    }
  }
  return { ok: true, verdict };
}

// ---------------------------------------------------------------------------
// Argument parsing — one tiny strict parser per verb (unknown flag = usage error, mirrors the family).
// ---------------------------------------------------------------------------

function _mkNeed(argv, iRef) {
  return (flag) => {
    const v = argv[++iRef.i];
    if (v === undefined) {
      const e = new Error(`${flag} requires a value`);
      e.usage = true;
      throw e;
    }
    return v;
  };
}

function _parse(argv, spec, positionalMax, positionalNoun) {
  const opts = { json: false, _positionals: [] };
  for (const k of Object.keys(spec)) if (spec[k] !== true) opts[spec[k]] = undefined;
  const iRef = { i: 0 };
  const need = _mkNeed(argv, iRef);
  for (; iRef.i < argv.length; iRef.i++) {
    const a = argv[iRef.i];
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(spec, a)) {
      if (spec[a] === true) {
        opts[a.replace(/^--/, "").replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = true;
      } else {
        opts[spec[a]] = need(a);
      }
      continue;
    }
    if (a && a.startsWith("--")) {
      const e = new Error(`unknown flag: ${a}`);
      e.usage = true;
      throw e;
    }
    opts._positionals.push(a);
  }
  if (opts._positionals.length > positionalMax) {
    const e = new Error(
      `unexpected extra argument: ${opts._positionals[positionalMax]} (${positionalNoun})`
    );
    e.usage = true;
    throw e;
  }
  return opts;
}

function parseAgentSealArgs(argv) {
  const opts = _parse(
    argv,
    {
      "--out": "out",
      "--license": "license",
      "--vendor": "vendor",
      "--sign": true,
      "--key-env": "keyEnv",
      "--key-file": "keyFile",
    },
    1,
    "agent seal takes exactly one <session.jsonl>"
  );
  opts.session = opts._positionals[0];
  return opts;
}

function parseAgentVerifyArgs(argv) {
  const opts = _parse(argv, { "--vendor": "vendor" }, 1, "agent verify takes exactly one <packet>");
  opts.packet = opts._positionals[0];
  return opts;
}

function parseAgentRedactArgs(argv) {
  const opts = _parse(
    argv,
    { "--seq": "seq", "--out": "out" },
    1,
    "agent redact takes exactly one <packet>"
  );
  opts.packet = opts._positionals[0];
  return opts;
}

function parseAgentProveArgs(argv) {
  const opts = _parse(
    argv,
    { "--seq": "seq", "--out": "out" },
    1,
    "agent prove takes exactly one <packet>"
  );
  opts.packet = opts._positionals[0];
  return opts;
}

function parseAgentVerifyProofArgs(argv) {
  const opts = _parse(argv, { "--root": "root" }, 1, "agent verify-proof takes exactly one <proof>");
  opts.proof = opts._positionals[0];
  return opts;
}

function parseAgentCheckpointArgs(argv) {
  const opts = _parse(argv, { "--out": "out" }, 1, "agent checkpoint takes exactly one <session.jsonl>");
  opts.session = opts._positionals[0];
  return opts;
}

function parseAgentVerifyGrowthArgs(argv) {
  const opts = _parse(argv, {}, 2, "agent verify-growth takes exactly <earlier> <later>");
  opts.earlier = opts._positionals[0];
  opts.later = opts._positionals[1];
  return opts;
}

function parseAgentCommitClaimArgs(argv) {
  return _parse(
    argv,
    {
      "--repo": "repo",
      "--ref": "ref",
      "--seq": "seq",
      "--ts": "ts",
      "--actor": "actor",
      "--out": "out",
    },
    0,
    "agent commit-claim takes no positional arguments — the facts come from --repo/--ref"
  );
}

function parseAgentVerifyCommitArgs(argv) {
  const opts = _parse(
    argv,
    { "--repo": "repo", "--ref": "ref", "--vendor": "vendor" },
    1,
    "agent verify-commit takes exactly one <packet>"
  );
  opts.packet = opts._positionals[0];
  return opts;
}

function parseAgentCoverageArgs(argv) {
  return _parse(
    argv,
    {
      "--repo": "repo",
      "--range": "range",
      "--packets": "packets",
      "--deep": true,
      "--require-all": true,
      "--require-since": "requireSince",
      "--out": "out",
    },
    0,
    "agent coverage takes no positional arguments — the facts come from --repo/--range/--packets"
  );
}

// Normalize a --vendor flag to a lowercase 0x-address (accepts checksummed). Usage error on garbage.
function _normalizeVendorFlag(vendor) {
  if (vendor == null) return null;
  try {
    return getAddress(vendor).toLowerCase();
  } catch (_e) {
    const e = new Error(`--vendor must be a valid 0x-address, got: ${String(vendor)}`);
    e.usage = true;
    throw e;
  }
}

// Parse a --seq list ("4" or "1,3,5") into a deduped, sorted int array. Usage error on garbage.
function _parseSeqList(raw) {
  if (raw == null || String(raw).trim() === "") {
    const e = new Error("--seq requires a non-empty comma-separated list of event seqs (e.g. --seq 1,3)");
    e.usage = true;
    throw e;
  }
  const out = new Set();
  for (const part of String(raw).split(",")) {
    const t = part.trim();
    if (!/^\d+$/.test(t)) {
      const e = new Error(`--seq entries must be non-negative integers, got: ${JSON.stringify(part)}`);
      e.usage = true;
      throw e;
    }
    out.add(Number(t));
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// `vh agent seal <session.jsonl> [--out <p>] [--sign ...] [--json]`
// ---------------------------------------------------------------------------

async function runAgentSeal(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const now = io.now || new Date();

  if (!opts.session) {
    writeErr("error: `vh agent seal` requires a <session.jsonl>\n");
    return EXIT.USAGE;
  }

  // Gate the PAID surface FIRST (before any work) — fail-closed, offline.
  const requested = [];
  if (opts.sign) {
    requested.push({
      entitlement: AGENT_SIGNED_CAPABILITY,
      label: "the signed head attestation (--sign)",
    });
  }
  const gate = gateAgentPaid(opts, requested, now, writeErr, evidence.resolveCanonicalVendor(io));
  if (!gate.ok) return gate.code;

  // Read + parse the session log (named line-located parse errors; size-capped).
  let events;
  try {
    const text = readInputText(path.resolve(opts.session), "agent session log");
    events = parseSessionText(text, `agent session log ${opts.session}`);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }
  if (events.length === 0) {
    writeErr(`error: ${opts.session} contains no events to seal\n`);
    return EXIT.FAIL;
  }

  // Build the packet over the PURE core. A bad event/session is the core's NAMED, LOCATED reject.
  const built = buildPacket(events);
  if (!built.ok) {
    const at = built.index !== undefined ? ` at event seq ${built.index}` : "";
    const field = built.field ? ` (field: ${built.field})` : "";
    writeErr(`error: cannot seal agent session: ${built.reason}${at}${field}\n`);
    return EXIT.FAIL;
  }
  const packet = built.packet;

  // Optionally SIGN the head (the paid `agent_signed` surface, already gated above). The key is
  // read, used, and discarded inside loadSigningWallet — NEVER persisted or logged.
  let signedBy = null;
  if (opts.sign) {
    let wallet;
    try {
      ({ wallet } = coreAttestation.loadSigningWallet({ keyEnv: opts.keyEnv, keyFile: opts.keyFile }));
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    let container;
    try {
      const headPayload = {
        kind: AGENT_HEAD_KIND,
        schemaVersion: AGENT_HEAD_SCHEMA_VERSION,
        note: AGENT_TRUST_NOTE,
        head: { size: packet.head.size, root: packet.head.root },
      };
      container = await coreAttestation.signAttestation(
        { attestation: headPayload, signer: wallet },
        SIGNED_HEAD_CFG
      );
    } catch (e) {
      writeErr(`error: cannot sign agent-session head: ${e.message}\n`);
      return EXIT.FAIL;
    }
    packet.headAttestation = container;
    signedBy = coreAttestation.recoverSigner(container);
  }

  const artifactStr = serializePacket(packet);
  let outAbs = null;
  if (opts.out) {
    const emitted = emitArtifact(artifactStr, opts.out, write, writeErr);
    if (emitted.code !== EXIT.OK) return emitted.code;
    outAbs = emitted.outAbs;
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          note: AGENT_TRUST_NOTE,
          kind: PACKET_KIND,
          head: { size: packet.head.size, root: packet.head.root },
          counts: packet.counts,
          signed: !!signedBy,
          signer: signedBy,
          out: outAbs,
          // With NO --out the artifact rides in `artifact` so --json never drops it (family parity).
          artifact: outAbs ? null : artifactStr,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(AGENT_TRUST_NOTE + "\n\n");
    write(
      `sealed ${packet.counts.events} event${packet.counts.events === 1 ? "" : "s"} into ` +
        `${signedBy ? "a SIGNED agent-session packet" : "an agent-session packet"} — ` +
        `head { size: ${packet.head.size}, root: ${packet.head.root} }\n`
    );
    if (signedBy) write(`  signed by:    ${signedBy}\n`);
    if (outAbs) {
      write(`  written:      ${outAbs}\n`);
    } else {
      write(artifactStr);
    }
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// `vh agent verify <packet> [--vendor <0xaddr>] [--json]`
// ---------------------------------------------------------------------------

function runAgentVerify(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.packet) {
    writeErr("error: `vh agent verify` requires a <packet>\n");
    return EXIT.USAGE;
  }
  let vendor;
  try {
    vendor = _normalizeVendorFlag(opts.vendor);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  let packet;
  try {
    packet = readPacketFile(path.resolve(opts.packet));
  } catch (e) {
    writeErr(`error: invalid agent-session packet ${opts.packet}: ${e.message}\n`);
    return EXIT.IO;
  }

  const result = verifyPacket(packet, { vendorAddress: vendor });
  const code = result.accepted ? EXIT.OK : EXIT.FAIL;

  if (opts.json) {
    write(JSON.stringify({ ...result, note: AGENT_TRUST_NOTE, packet: opts.packet }, null, 2) + "\n");
    return code;
  }

  write(AGENT_TRUST_NOTE + "\n\n");
  write(`# vh agent verify — ${opts.packet}\n`);
  if (result.accepted) {
    write(`head:      { size: ${result.head.size}, root: ${result.head.root} }\n`);
    write(
      `events:    ${result.counts.events} (${result.counts.full} full, ${result.counts.redacted} redacted)\n`
    );
    write(
      `withheld:  ${result.withheld.length === 0 ? "(none — every payload disclosed)" : "seqs " + result.withheld.join(", ")}\n`
    );
    if (result.signed) {
      write(`signed by: ${result.signature.recoveredSigner}`);
      write(
        result.signature.vendorPinned
          ? ` — PINNED to vendor ${result.signature.vendorPinned}\n`
          : " — GENUINE but UNPINNED (pass --vendor <0xaddr> to pin the signer)\n"
      );
    } else {
      write("signed by: (unsigned packet)\n");
    }
    write("\nACCEPTED — every event leaf and the root re-derive from the events you hold.\n");
  } else {
    write(`\nREJECTED — ${result.reason}`);
    if (result.seq !== null) write(` at event seq ${result.seq}`);
    write("\n");
    if (result.detail) write(`  ${result.detail}\n`);
  }
  return code;
}

// ---------------------------------------------------------------------------
// `vh agent redact <packet> --seq <list> [--out <p>] [--json]`
// ---------------------------------------------------------------------------

function runAgentRedact(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.packet) {
    writeErr("error: `vh agent redact` requires a <packet>\n");
    return EXIT.USAGE;
  }
  let seqs;
  try {
    seqs = _parseSeqList(opts.seq);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  let packet;
  try {
    packet = readPacketFile(path.resolve(opts.packet));
  } catch (e) {
    writeErr(`error: invalid agent-session packet ${opts.packet}: ${e.message}\n`);
    return EXIT.IO;
  }

  // Only a packet that VERIFIES may be redacted — redaction must never launder a tampered packet.
  const pre = verifyPacket(packet);
  if (!pre.accepted) {
    writeErr(
      `error: refusing to redact a packet that does not verify: ${pre.reason}` +
        (pre.seq !== null ? ` at event seq ${pre.seq}` : "") +
        "\n"
    );
    return EXIT.FAIL;
  }
  for (const seq of seqs) {
    if (seq >= packet.head.size) {
      writeErr(`error: --seq ${seq} is out of range for a ${packet.head.size}-event session\n`);
      return EXIT.FAIL;
    }
  }

  // Redact via the PURE core (idempotent on already-redacted events), then REBUILD the packet so its
  // bytes stay canonical. The head is IDENTICAL by redaction-safety; the head attestation (when
  // present) is carried VERBATIM and stays valid for the redacted copy.
  const requested = new Set(seqs);
  const newEvents = packet.events.map((e) => {
    if (!requested.has(e.seq)) return e;
    const r = redactEvent(e);
    if (!r.ok) {
      // Unreachable post-verify; kept total + named.
      throw new AgentPacketError(`cannot redact event seq ${e.seq}: ${r.reason}`);
    }
    return r.event;
  });
  const rebuilt = buildPacket(newEvents);
  if (!rebuilt.ok) {
    writeErr(`error: cannot rebuild redacted packet: ${rebuilt.reason}\n`);
    return EXIT.FAIL;
  }
  const out = rebuilt.packet;
  if (out.head.root !== packet.head.root || out.head.size !== packet.head.size) {
    // Defensive: the redaction-safety invariant is core-tested; a mismatch here is a genuine fault.
    writeErr("error: internal invariant violated — redaction changed the head\n");
    return EXIT.FAIL;
  }
  if (packet.headAttestation !== undefined) out.headAttestation = packet.headAttestation;

  const withheld = out.events.filter((e) => e.redacted === true).map((e) => e.seq);
  const artifactStr = serializePacket(out);
  let outAbs = null;
  if (opts.out) {
    const emitted = emitArtifact(artifactStr, opts.out, write, writeErr);
    if (emitted.code !== EXIT.OK) return emitted.code;
    outAbs = emitted.outAbs;
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          note: AGENT_TRUST_NOTE,
          kind: PACKET_KIND,
          head: { size: out.head.size, root: out.head.root },
          counts: out.counts,
          withheld,
          signed: out.headAttestation !== undefined,
          out: outAbs,
          artifact: outAbs ? null : artifactStr,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(AGENT_TRUST_NOTE + "\n\n");
    write(
      `redacted ${seqs.length} event${seqs.length === 1 ? "" : "s"} (requested seqs ${seqs.join(", ")}) — ` +
        `the packet now WITHHOLDS seqs ${withheld.join(", ")}\n`
    );
    write(`  head (UNCHANGED): { size: ${out.head.size}, root: ${out.head.root} }\n`);
    if (outAbs) {
      write(`  written:          ${outAbs}\n`);
    } else {
      write(artifactStr);
    }
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// `vh agent prove <packet> --seq <n> [--out <p>] [--json]`
// ---------------------------------------------------------------------------

function runAgentProve(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.packet) {
    writeErr("error: `vh agent prove` requires a <packet>\n");
    return EXIT.USAGE;
  }
  let seqs;
  try {
    seqs = _parseSeqList(opts.seq);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }
  if (seqs.length !== 1) {
    writeErr("error: `vh agent prove` discloses exactly ONE event; pass a single --seq <n>\n");
    return EXIT.USAGE;
  }
  const seq = seqs[0];

  let packet;
  try {
    packet = readPacketFile(path.resolve(opts.packet));
  } catch (e) {
    writeErr(`error: invalid agent-session packet ${opts.packet}: ${e.message}\n`);
    return EXIT.IO;
  }

  const pre = verifyPacket(packet);
  if (!pre.accepted) {
    writeErr(
      `error: refusing to prove from a packet that does not verify: ${pre.reason}` +
        (pre.seq !== null ? ` at event seq ${pre.seq}` : "") +
        "\n"
    );
    return EXIT.FAIL;
  }

  const proved = proveEvent(packet.events, seq);
  if (!proved.ok) {
    writeErr(
      `error: cannot prove event seq ${seq}: ${proved.reason}` +
        (proved.reason === REASONS.INDEX_OUT_OF_RANGE
          ? ` (the session has ${packet.head.size} events, seqs 0..${packet.head.size - 1})`
          : "") +
        "\n"
    );
    return EXIT.FAIL;
  }

  const artifact = {
    kind: PROOF_KIND,
    schemaVersion: PROOF_SCHEMA_VERSION,
    note: AGENT_TRUST_NOTE,
    head: { size: packet.head.size, root: packet.head.root },
    proof: proved.proof,
  };
  const artifactStr = JSON.stringify(artifact) + "\n";
  let outAbs = null;
  if (opts.out) {
    const emitted = emitArtifact(artifactStr, opts.out, write, writeErr);
    if (emitted.code !== EXIT.OK) return emitted.code;
    outAbs = emitted.outAbs;
  }

  const disclosedRedacted = proved.proof.event.redacted === true;
  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          note: AGENT_TRUST_NOTE,
          kind: PROOF_KIND,
          head: artifact.head,
          seq,
          redacted: disclosedRedacted,
          out: outAbs,
          artifact: outAbs ? null : artifactStr,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(AGENT_TRUST_NOTE + "\n\n");
    write(
      `proved event seq ${seq} (${disclosedRedacted ? "REDACTED — payload withheld behind its commitment" : "full payload disclosed"}) ` +
        `against head { size: ${artifact.head.size}, root: ${artifact.head.root} }\n`
    );
    if (outAbs) {
      write(`  written:      ${outAbs}\n`);
    } else {
      write(artifactStr);
    }
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// `vh agent verify-proof <proof> [--root <hex>] [--json]`
// ---------------------------------------------------------------------------

/** STRICT shape validation of a proof artifact (deep proof math is verifyEvent's job). */
function validateProofArtifactShape(obj) {
  if (!isPlainObject(obj)) throw new AgentPacketError("agent event proof must be a JSON object");
  const KNOWN = ["kind", "schemaVersion", "note", "head", "proof"];
  for (const k of Object.keys(obj)) {
    if (!KNOWN.includes(k)) {
      throw new AgentPacketError(`agent event proof has unknown field: ${JSON.stringify(k)}`);
    }
  }
  if (obj.kind !== PROOF_KIND) {
    throw new AgentPacketError(
      `not an agent event proof (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(PROOF_KIND)})`
    );
  }
  if (!SUPPORTED_PROOF_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new AgentPacketError(
      `unsupported agent event proof schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_PROOF_SCHEMA_VERSIONS)})`
    );
  }
  if (obj.note !== AGENT_TRUST_NOTE) {
    throw new AgentPacketError("agent event proof `note` must be the standing trust note (caveat must not drift)");
  }
  _validateHeadShape(obj.head, "agent event proof");
  if (!isPlainObject(obj.proof)) {
    throw new AgentPacketError("agent event proof `proof` must be a { event, inclusion } object");
  }
  return obj;
}

function runAgentVerifyProof(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.proof) {
    writeErr("error: `vh agent verify-proof` requires a <proof>\n");
    return EXIT.USAGE;
  }
  let pinnedRoot = null;
  if (opts.root != null) {
    if (typeof opts.root !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(opts.root)) {
      writeErr(`error: --root must be a 0x-bytes32 hex string, got: ${String(opts.root)}\n`);
      return EXIT.USAGE;
    }
    pinnedRoot = opts.root.toLowerCase();
  }

  let artifact;
  try {
    const text = readInputText(path.resolve(opts.proof), "agent event proof");
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new AgentPacketError(`agent event proof is not valid JSON: ${e.message}`);
    }
    artifact = validateProofArtifactShape(obj);
  } catch (e) {
    writeErr(`error: invalid agent event proof ${opts.proof}: ${e.message}\n`);
    return EXIT.IO;
  }

  // The pin: the proof's carried head is SELF-ASSERTED; --root binds it to a root the CALLER trusts
  // (e.g. from a checkpoint, a signed packet, or a published head). A mismatch is a REJECT.
  function emit(result) {
    const code = result.accepted ? EXIT.OK : EXIT.FAIL;
    if (opts.json) {
      write(JSON.stringify({ ...result, note: AGENT_TRUST_NOTE, proof: opts.proof }, null, 2) + "\n");
      return code;
    }
    write(AGENT_TRUST_NOTE + "\n\n");
    write(`# vh agent verify-proof — ${opts.proof}\n`);
    write(`head:      { size: ${artifact.head.size}, root: ${artifact.head.root} }`);
    write(pinnedRoot ? ` — PINNED to --root\n` : " (SELF-ASSERTED — pass --root <hex> to pin it)\n");
    if (result.accepted) {
      write(
        `event:     seq ${result.seq} (${result.redacted ? "REDACTED — payload withheld behind its commitment" : "full payload disclosed"})\n`
      );
      write("\nACCEPTED — the disclosed event re-derives its leaf and is INCLUDED at its seq under the head.\n");
    } else {
      write(`\nREJECTED — ${result.reason}`);
      if (result.seq !== null && result.seq !== undefined) write(` at event seq ${result.seq}`);
      write("\n");
    }
    return code;
  }

  if (pinnedRoot && artifact.head.root !== pinnedRoot) {
    return emit({
      accepted: false,
      verdict: "REJECTED",
      reason: "ROOT_MISMATCH",
      seq: null,
      detail: `the proof carries head root ${artifact.head.root} but --root pins ${pinnedRoot}`,
    });
  }

  const v = verifyEvent(artifact.proof, artifact.head);
  if (!v.ok) {
    const claimedSeq = isPlainObject(artifact.proof.event) && Number.isSafeInteger(artifact.proof.event.seq)
      ? artifact.proof.event.seq
      : null;
    return emit({ accepted: false, verdict: "REJECTED", reason: v.reason, seq: claimedSeq });
  }
  return emit({
    accepted: true,
    verdict: "ACCEPTED",
    reason: null,
    seq: v.seq,
    redacted: v.redacted,
    head: { size: artifact.head.size, root: artifact.head.root },
    rootPinned: pinnedRoot !== null,
    event: artifact.proof.event,
  });
}

// ---------------------------------------------------------------------------
// `vh agent checkpoint <session.jsonl> [--out <p>] [--json]`
// ---------------------------------------------------------------------------

function runAgentCheckpoint(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.session) {
    writeErr("error: `vh agent checkpoint` requires a <session.jsonl>\n");
    return EXIT.USAGE;
  }
  let events;
  try {
    const text = readInputText(path.resolve(opts.session), "agent session log");
    events = parseSessionText(text, `agent session log ${opts.session}`);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }
  const head = sessionHead(events);
  if (!head.ok) {
    const at = head.index !== undefined ? ` at event seq ${head.index}` : "";
    writeErr(`error: cannot checkpoint agent session: ${head.reason}${at}\n`);
    return EXIT.FAIL;
  }

  const artifact = {
    kind: CHECKPOINT_KIND,
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    note: AGENT_TRUST_NOTE,
    head: { size: head.size, root: head.root },
  };
  const artifactStr = JSON.stringify(artifact) + "\n";
  let outAbs = null;
  if (opts.out) {
    const emitted = emitArtifact(artifactStr, opts.out, write, writeErr);
    if (emitted.code !== EXIT.OK) return emitted.code;
    outAbs = emitted.outAbs;
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          note: AGENT_TRUST_NOTE,
          kind: CHECKPOINT_KIND,
          head: artifact.head,
          out: outAbs,
          artifact: outAbs ? null : artifactStr,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(AGENT_TRUST_NOTE + "\n\n");
    write(`checkpoint head so far: { size: ${head.size}, root: ${head.root} }\n`);
    if (outAbs) {
      write(`  written:      ${outAbs}\n`);
    } else {
      write(artifactStr);
    }
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// `vh agent verify-growth <earlier-head-or-packet> <later-packet> [--json]`
// ---------------------------------------------------------------------------

// Read the EARLIER artifact: a checkpoint (head only) or a full packet (its head). Named errors.
function readEarlierHead(filePath) {
  const text = readInputText(filePath, "agent checkpoint/packet");
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new AgentPacketError(`agent checkpoint/packet is not valid JSON: ${e.message}`);
  }
  if (isPlainObject(obj) && obj.kind === CHECKPOINT_KIND) {
    const KNOWN = ["kind", "schemaVersion", "note", "head"];
    for (const k of Object.keys(obj)) {
      if (!KNOWN.includes(k)) {
        throw new AgentPacketError(`agent checkpoint has unknown field: ${JSON.stringify(k)}`);
      }
    }
    if (!SUPPORTED_CHECKPOINT_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
      throw new AgentPacketError(
        `unsupported agent checkpoint schemaVersion: ${JSON.stringify(obj.schemaVersion)}`
      );
    }
    if (obj.note !== AGENT_TRUST_NOTE) {
      throw new AgentPacketError("agent checkpoint `note` must be the standing trust note (caveat must not drift)");
    }
    _validateHeadShape(obj.head, "agent checkpoint");
    return { head: obj.head, kind: CHECKPOINT_KIND };
  }
  // Fall through to a full packet (strict shape validation names a foreign kind).
  const packet = validatePacketShape(obj);
  return { head: packet.head, kind: PACKET_KIND };
}

function runAgentVerifyGrowth(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.earlier || !opts.later) {
    writeErr("error: `vh agent verify-growth` requires <earlier-head-or-packet> <later-packet>\n");
    return EXIT.USAGE;
  }

  let earlier;
  try {
    earlier = readEarlierHead(path.resolve(opts.earlier));
  } catch (e) {
    writeErr(`error: invalid earlier head/packet ${opts.earlier}: ${e.message}\n`);
    return EXIT.IO;
  }
  let later;
  try {
    later = readPacketFile(path.resolve(opts.later));
  } catch (e) {
    writeErr(`error: invalid agent-session packet ${opts.later}: ${e.message}\n`);
    return EXIT.IO;
  }

  function emit(result) {
    const code = result.accepted ? EXIT.OK : EXIT.FAIL;
    if (opts.json) {
      write(
        JSON.stringify(
          {
            ...result,
            note: AGENT_TRUST_NOTE,
            earlier: { path: opts.earlier, head: earlier.head },
            later: { path: opts.later, head: later.head },
          },
          null,
          2
        ) + "\n"
      );
      return code;
    }
    write(AGENT_TRUST_NOTE + "\n\n");
    write(`# vh agent verify-growth — ${opts.earlier} -> ${opts.later}\n`);
    write(`earlier head: { size: ${earlier.head.size}, root: ${earlier.head.root} }\n`);
    write(`later head:   { size: ${later.head.size}, root: ${later.head.root} }\n\n`);
    if (result.accepted) {
      write(
        "ACCEPTED — the later packet is an APPEND-ONLY extension of the earlier head: no event at or " +
          "before the checkpoint was rewritten, reordered, dropped or inserted.\n"
      );
    } else {
      write(`REJECTED — ${result.reason}`);
      if (result.seq !== null && result.seq !== undefined) write(` at event seq ${result.seq}`);
      write("\n");
      if (result.detail) write(`  ${result.detail}\n`);
    }
    return code;
  }

  // The later packet must itself verify (its events re-derive its head) — growth is meaningless
  // against a packet whose own contents are tampered. Event-local faults keep their named seq.
  const pre = verifyPacket(later);
  if (!pre.accepted) {
    return emit({ accepted: false, verdict: "REJECTED", reason: pre.reason, seq: pre.seq, detail: pre.detail });
  }

  if (earlier.head.size === 0) {
    // The empty (pre-first-event) checkpoint: everything is trivially an append-only extension.
    return emit({ accepted: true, verdict: "ACCEPTED", reason: null, trivial: true });
  }
  if (earlier.head.size > later.head.size) {
    return emit({
      accepted: false,
      verdict: "REJECTED",
      reason: "GROWTH_RANGE",
      detail: `the later packet (${later.head.size} events) is SMALLER than the earlier head (${earlier.head.size} events) — history shrank`,
    });
  }

  // Build the consistency proof from the later packet's own (redaction-safe) leaves, then verify it
  // against BOTH full heads — the sizes are bound, so a lying head is rejected outright.
  const proved = proveGrowth(later.events, earlier.head.size, later.head.size);
  if (!proved.ok) {
    return emit({ accepted: false, verdict: "REJECTED", reason: proved.reason, seq: proved.index });
  }
  const grown = verifyGrowth(earlier.head, later.head, proved.proof);
  if (!grown.ok) {
    return emit({
      accepted: false,
      verdict: "REJECTED",
      reason: grown.reason,
      detail:
        "the earlier head is NOT a prefix of the later packet — an event at or before the checkpoint " +
        "was rewritten, reordered, dropped or inserted",
    });
  }
  return emit({ accepted: true, verdict: "ACCEPTED", reason: null });
}

// ---------------------------------------------------------------------------
// `vh agent commit-claim` / `vh agent verify-commit` (T-69.2) — the CLI verbs over the PURE
// commit-claim core (cli/core/agent-commit.js, T-69.1). Both FREE, read-only, key-less. The
// producer emits ONE canonical JSONL claim event whose git facts are derived from the operator's
// OWN work tree; the auditor re-derives BOTH facts from THEIR OWN clone and accepts only a packet
// that (a) fully verifies via the EXISTING verifyPacket path (signature/vendor-pin included) AND
// (b) discloses a claim matching the re-derived facts.
// ---------------------------------------------------------------------------

// A single non-negative safe-integer --seq (the claim event's position in the session log).
// Deliberately NOT the redact/prove list parser: a claim rides at exactly ONE seq.
function _parseClaimSeq(raw) {
  const t = String(raw == null ? "" : raw).trim();
  if (!/^\d+$/.test(t) || !Number.isSafeInteger(Number(t))) {
    const e = new Error(
      `--seq must be a single non-negative integer (the claim event's position in the session log), got: ${JSON.stringify(String(raw))}`
    );
    e.usage = true;
    throw e;
  }
  return Number(t);
}

/**
 * Derive the git facts BOTH verbs bind/check: the full commit oid (cli/git.js resolveCommit,
 * REUSED VERBATIM) and the tracked-set work-tree root + vantage-point scope (cli/hash.js hashGit,
 * REUSED VERBATIM — the same engine as `vh hash --git`, so the root is byte-identical to what any
 * clean checkout of the commit re-derives). Every failure is one of those modules' EXISTING named,
 * actionable errors (not a work tree, unknown ref, zero tracked files, tracked file missing) —
 * surfaced by the callers as an exit-1 IO error, never a stack trace.
 *
 * @param {string} repoAbs absolute path to (or inside) the work tree
 * @param {string|undefined} ref the ref to resolve (default HEAD)
 * @returns {{ commit: string, root: string, scope: string }}
 */
function deriveGitFacts(repoAbs, ref) {
  // hashGit first: its repoRoot guard yields the clear "not a git repository" error for a non-repo
  // --repo (resolveCommit alone would blame the ref). Then resolveCommit — the acceptance's named
  // oid source — with a cross-check: both resolve the same ref back-to-back, so a mismatch means
  // the repo moved mid-derivation (named, not silent).
  const derived = hashGit(repoAbs, { ref });
  const oid = git.resolveCommit(repoAbs, ref);
  if (oid !== derived.commit) {
    throw new Error(
      `the repository changed while deriving the git facts (${ref || "HEAD"} resolved to both ` +
        `${derived.commit} and ${oid}); re-run against a quiescent repo`
    );
  }
  return { commit: oid, root: derived.root, scope: derived.scope };
}

// ---------------------------------------------------------------------------
// `vh agent commit-claim --repo <dir> [--ref <ref>] --seq <n> [--ts <iso>] [--actor <s>]
//                        [--out <p>] [--json]`
// ---------------------------------------------------------------------------

function runAgentCommitClaim(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const now = io.now || new Date();

  if (!opts.repo) {
    writeErr(
      "error: `vh agent commit-claim` requires --repo <dir> — the git work tree the claim's facts are derived from\n"
    );
    return EXIT.USAGE;
  }
  if (opts.seq === undefined) {
    writeErr(
      "error: `vh agent commit-claim` requires --seq <n> — the claim event's position in the session log\n"
    );
    return EXIT.USAGE;
  }
  let seq;
  try {
    seq = _parseClaimSeq(opts.seq);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // Derive the facts from the operator's OWN work tree — resolveCommit + hashGit reused verbatim;
  // their existing named git errors surface as exit-1 IO errors, never a stack trace.
  let facts;
  try {
    facts = deriveGitFacts(path.resolve(opts.repo), opts.ref);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  // `ts` is SELF-ASSERTED metadata (recorded, never verified against any clock) — the same posture
  // as every event ts. --ts wins verbatim; otherwise the injectable clock stamps it.
  const ts = opts.ts !== undefined ? String(opts.ts) : now.toISOString();
  const base = { seq, ts, commit: facts.commit, gitRoot: facts.root };
  if (opts.actor !== undefined) base.actor = String(opts.actor);

  // Build the canonical claim EVENT via the PURE core. The vantage-point scope rides along as the
  // OPTIONAL unverified hint when --repo pointed inside a subtree ("." — the repo root — is not a
  // valid scope and simply means "no hint"); a scope the canonical schema cannot represent (e.g. a
  // control-character path segment) drops the HINT rather than blocking the FACTS.
  let built = agentCommit.buildCommitClaimEvent(
    facts.scope !== "." ? { ...base, scope: facts.scope } : base
  );
  if (!built.ok && built.reason === agentCommit.REASONS.CLAIM_BAD_SCOPE) {
    built = agentCommit.buildCommitClaimEvent(base);
  }
  if (!built.ok) {
    writeErr(
      `error: cannot build commit-claim event: ${built.reason}${built.field ? ` (field: ${built.field})` : ""}\n`
    );
    return EXIT.FAIL;
  }

  // ONE canonical JSONL event line, ready to append to the session log BEFORE `vh agent seal`.
  const line = JSON.stringify(built.event) + "\n";
  let outAbs = null;
  if (opts.out) {
    const emitted = emitArtifact(line, opts.out, write, writeErr);
    if (emitted.code !== EXIT.OK) return emitted.code;
    outAbs = emitted.outAbs;
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          note: COMMIT_CLAIM_TRUST_NOTE,
          kind: agentCommit.CLAIM_KIND,
          seq,
          ts,
          actor: built.event.actor,
          commit: facts.commit,
          gitRoot: facts.root,
          scope: "scope" in built.claim ? built.claim.scope : null,
          claim: built.claim,
          event: built.event,
          out: outAbs,
          // With NO --out the line rides in `artifact` so --json never drops it (family parity).
          artifact: outAbs ? null : line,
        },
        null,
        2
      ) + "\n"
    );
    return EXIT.OK;
  }

  const summary =
    `commit-claim event (seq ${seq}) — commit ${facts.commit}, tracked-set root ${facts.root}` +
    ("scope" in built.claim ? `, scope ${built.claim.scope}` : "") +
    "\n  append it to your session log BEFORE `vh agent seal`\n";
  if (outAbs) {
    write(COMMIT_CLAIM_TRUST_NOTE + "\n\n" + summary + `  written:      ${outAbs}\n`);
  } else {
    // stdout carries EXACTLY the one JSONL line (so `vh agent commit-claim ... >> session.jsonl`
    // appends cleanly); the trust note + summary ride stderr, never corrupting the stream.
    writeErr(COMMIT_CLAIM_TRUST_NOTE + "\n\n" + summary);
    write(line);
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// `vh agent verify-commit <packet> --repo <dir> [--ref <ref>] [--vendor <0xaddr>] [--json]`
// ---------------------------------------------------------------------------

function runAgentVerifyCommit(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.packet) {
    writeErr("error: `vh agent verify-commit` requires a <packet>\n");
    return EXIT.USAGE;
  }
  if (!opts.repo) {
    writeErr(
      "error: `vh agent verify-commit` requires --repo <dir> — the AUDITOR'S OWN clone the facts are re-derived from\n"
    );
    return EXIT.USAGE;
  }
  let vendor;
  try {
    vendor = _normalizeVendorFlag(opts.vendor);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  let packet;
  try {
    packet = readPacketFile(path.resolve(opts.packet));
  } catch (e) {
    writeErr(`error: invalid agent-session packet ${opts.packet}: ${e.message}\n`);
    return EXIT.IO;
  }

  const refLabel = opts.ref || "HEAD";
  function emit(result) {
    const code = result.accepted ? EXIT.OK : EXIT.FAIL;
    if (opts.json) {
      write(
        JSON.stringify(
          { ...result, note: COMMIT_CLAIM_TRUST_NOTE, packet: opts.packet, repo: opts.repo, ref: refLabel },
          null,
          2
        ) + "\n"
      );
      return code;
    }
    write(COMMIT_CLAIM_TRUST_NOTE + "\n\n");
    write(`# vh agent verify-commit — ${opts.packet} vs ${opts.repo} @ ${refLabel}\n`);
    if (result.expected) {
      write(`re-derived (YOUR clone): commit ${result.expected.commit}\n`);
      write(`                         root   ${result.expected.gitRoot}\n`);
    }
    if (result.accepted) {
      write(`packet:    ACCEPTED — head { size: ${result.head.size}, root: ${result.head.root} }`);
      if (result.signed) {
        write(
          `, signed by ${result.signature.recoveredSigner}` +
            (result.signature.vendorPinned ? ` (PINNED to vendor ${result.signature.vendorPinned})` : " (UNPINNED)")
        );
      } else {
        write(", unsigned");
      }
      write("\n");
      write(
        `claim:     seq ${result.matched.seq} — commit ${result.matched.claim.commit}, root ${result.matched.claim.gitRoot}` +
          ("scope" in result.matched.claim ? `, scope ${result.matched.claim.scope} (an UNVERIFIED hint)` : "") +
          "\n"
      );
      write(
        "\nACCEPTED — the sealed packet verifies AND a disclosed claim matches the facts re-derived from your own clone.\n"
      );
    } else {
      write(`\nREJECTED — ${result.reason}\n`);
      if (result.detail) write(`  ${result.detail}\n`);
    }
    return code;
  }

  // (1) FIRST: the FULL EXISTING packet verification, verbatim — every leaf + the root re-derived,
  //     counts recounted, and the signature/vendor-pin handling of `vh agent verify` (fail-closed:
  //     --vendor on an unsigned packet is NOT_SIGNED). A tampered/forged packet can NEVER reach the
  //     claim check.
  const pre = verifyPacket(packet, { vendorAddress: vendor });
  if (!pre.accepted) {
    return emit({
      verdict: "REJECTED",
      accepted: false,
      reason: "packet-invalid",
      packetReason: pre.reason,
      packetSeq: pre.seq,
      detail:
        `packet verification REJECTED: ${pre.reason}` +
        (pre.seq !== null ? ` at event seq ${pre.seq}` : "") +
        (pre.detail ? ` — ${pre.detail}` : ""),
      expected: null,
      claims: null,
      matched: null,
      head: null,
      counts: null,
      signed: pre.signed,
      signature: pre.signature,
    });
  }

  // (2) Re-derive the facts FROM THE AUDITOR'S OWN CLONE (resolveCommit + hashGit verbatim). The
  //     packet's own claim is never trusted as a fact source; git trouble is an IO error (exit 1).
  let facts;
  try {
    facts = deriveGitFacts(path.resolve(opts.repo), opts.ref);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }
  const expected = { commit: facts.commit, gitRoot: facts.root };

  // (3) Find every DISCLOSED claim (a REDACTED claim withholds its payload bytes and is by
  //     definition not disclosable) and accept only if one matches the re-derived facts.
  const found = agentCommit.findCommitClaims(packet.events);
  const common = {
    expected,
    head: pre.head,
    counts: pre.counts,
    signed: pre.signed,
    signature: pre.signature,
  };
  if (!found.ok) {
    // Unreachable after verifyPacket ACCEPTed (the session already validated); kept total + named.
    return emit({
      verdict: "REJECTED",
      accepted: false,
      reason: "packet-invalid",
      detail: `session re-validation failed: ${found.reason}`,
      claims: null,
      matched: null,
      ...common,
    });
  }
  const claims = found.claims.map((c) => ({ seq: c.seq, claim: c.claim }));
  if (found.claims.length === 0) {
    return emit({
      verdict: "REJECTED",
      accepted: false,
      reason: "no-disclosed-claim",
      detail:
        "the packet contains no DISCLOSED commit-claim event (a REDACTED claim is not disclosable — " +
        "ask the packet holder for a copy that discloses the claim event; redacting any OTHER event " +
        "leaves the head unchanged)",
      claims,
      matched: null,
      ...common,
    });
  }

  let rootMismatch = null;
  let oidMismatch = null;
  for (const c of found.claims) {
    const v = agentCommit.verifyCommitClaim({ event: c.event, expected });
    if (v.ok) {
      return emit({
        verdict: "ACCEPTED",
        accepted: true,
        reason: null,
        claims,
        matched: { seq: c.seq, claim: c.claim },
        ...common,
      });
    }
    if (v.reason === agentCommit.REASONS.ROOT_MISMATCH && rootMismatch === null) rootMismatch = { c, v };
    if (v.reason === agentCommit.REASONS.OID_MISMATCH && oidMismatch === null) oidMismatch = { c, v };
  }
  // root-mismatch (right commit, wrong bytes) is the most actionable verdict, so it wins the
  // naming when both kinds of near-miss exist across multiple claims.
  if (rootMismatch) {
    const { c, v } = rootMismatch;
    return emit({
      verdict: "REJECTED",
      accepted: false,
      reason: agentCommit.REASONS.ROOT_MISMATCH,
      detail:
        `the claim at seq ${c.seq} names commit ${c.claim.commit} (which matches your clone) but its ` +
        `tracked-set root ${v.claimed} does not match the re-derived root ${v.expected}. ` +
        "Check out the claimed commit in a CLEAN tree and re-run: hashGit reads WORK-TREE bytes, so " +
        "a dirty checkout is an HONEST mismatch, not a false ACCEPT.",
      claims,
      matched: null,
      ...common,
    });
  }
  if (oidMismatch) {
    const { c, v } = oidMismatch;
    return emit({
      verdict: "REJECTED",
      accepted: false,
      reason: agentCommit.REASONS.OID_MISMATCH,
      detail:
        `no disclosed claim names your clone's commit: the claim at seq ${c.seq} names ${v.claimed} ` +
        `but ${refLabel} re-resolves to ${v.expected}` +
        (found.claims.length > 1 ? ` (${found.claims.length} disclosed claims checked)` : "") +
        " — check out the claimed commit (e.g. `git checkout <oid>`) and re-run",
      claims,
      matched: null,
      ...common,
    });
  }
  // Unreachable: a disclosed, parseable claim can only match, oid-mismatch, or root-mismatch
  // against well-formed expected facts. Kept total + named.
  return emit({
    verdict: "REJECTED",
    accepted: false,
    reason: "packet-invalid",
    detail: "claim verification returned an unexpected verdict",
    claims,
    matched: null,
    ...common,
  });
}

// ---------------------------------------------------------------------------
// `vh agent coverage --repo <dir> --range <rev-range> --packets <dir> [--deep] [--require-all]
//                    [--require-since <oid>] [--out <report>] [--json]` (T-71.2)
//
// The FLEET gate over the PURE coverage core (cli/core/agent-coverage.js, T-71.1): "across this
// commit range, WHICH changes carry a verifiable agent-session record — and fail my pipeline when
// one doesn't." This verb derives the FACTS the pure core aggregates:
//   (a) the ORDERED commit list: cli/git.js listCommits — `git rev-list --reverse` (OLDEST-FIRST,
//       the order the core's requireSince policy is defined over); an unknown --range is that
//       helper's NAMED git error at exit 2 (the flag VALUE is what is wrong);
//   (b) the claims: every `*.vhagent.json` under --packets is FULLY verified through the SAME
//       shipped verifyPacket path `vh agent verify` runs, FIRST; a packet that VERIFIES has its
//       disclosed claims extracted via the T-69.1 agentCommit.findCommitClaims VERBATIM, while a
//       packet that does NOT verify proves nothing — its disclosed claims are still counted, but
//       ONLY as `claim-unverified-packet` (NEVER coverage), and the packet is NAMED in the report;
//   (c) --deep: for each claimed in-range oid (from a VERIFIED packet), the tracked-set root is
//       RE-DERIVED with the SHIPPED `vh hash --git` engine (hashGit, verbatim) inside ONE throwaway
//       LOCAL clone under the OS temp dir — fully offline (a local-path clone opens no network) —
//       and the temp clone is removed on EVERY exit path (success and failure, via try/finally);
//       without --deep no root is re-derived and a verified claim is `covered-oid-only` (the
//       human output SAYS so). A re-derived root that does not match the claim's gitRoot is the
//       NAMED `claim-root-mismatch` discrepancy — never coverage.
//
// FREE-SURFACE-BEGIN (vh agent coverage) — grep-guarded by the T-71.2 test: NOTHING between this
// marker and the matching END marker consults any paid gate. The whole verb is free, read-only,
// key-less.
// ---------------------------------------------------------------------------

// The coverage trust line — stated ONCE so the human and --json paths agree (the T-71.1 core's
// documented boundary, carried into every output; T-71.3 carries it into the docs).
const COVERAGE_TRUST_NOTE =
  "A coverage report is an INVENTORY control, NOT an authorship detector: a covered commit means an " +
  "UNALTERED sealed session packet CONTAINS a disclosed claim naming exactly that commit oid " +
  "(containment, NOT causation — it does not prove the session's events PRODUCED the commit), and an " +
  "uncovered commit proves NOTHING about how it was authored. Every packet is FIRST re-verified " +
  "through the FULL shipped `vh agent verify` path; a packet that does not verify proves nothing, so " +
  "its claims count ONLY as claim-unverified-packet (never coverage). Without --deep a claim's " +
  "tracked-set root is NOT re-derived (covered-oid-only); --deep re-derives it with the shipped " +
  "`vh hash --git` engine in a throwaway LOCAL clone (offline; removed on every exit path) and a " +
  "mismatch is the NAMED claim-root-mismatch discrepancy (never coverage). Event `ts` fields are " +
  "SELF-ASSERTED; nothing here is a trusted timestamp (P-3). Every caveat of the agent-session " +
  "packet applies (see `vh agent verify`).";

// How many per-commit / per-packet lines the HUMAN output lists verbatim before "... and N more"
// (the core's own text block caps its failure list the same way, at its MAX_LISTED_FAILURES).
const COVERAGE_MAX_LISTED = 50;

/**
 * Enumerate every `*.vhagent.json` under `dirAbs` (recursive), as SORTED dir-relative POSIX paths —
 * a deterministic packet inventory. lstat is used so a symlink is never followed out of the tree.
 * Throws a NAMED error (not a stack trace) when the directory cannot be read.
 */
function listCoveragePacketFiles(dirAbs) {
  let st;
  try {
    st = fs.statSync(dirAbs);
  } catch (e) {
    throw new Error(`cannot read --packets directory ${dirAbs}: ${e.message}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`--packets must name a DIRECTORY holding *.vhagent.json packets, got: ${dirAbs}`);
  }
  const found = [];
  const walk = (rel) => {
    const abs = rel === "" ? dirAbs : path.join(dirAbs, ...rel.split("/"));
    let names;
    try {
      names = fs.readdirSync(abs).sort(); // sorted: the inventory (and the report) is deterministic
    } catch (e) {
      throw new Error(`cannot read --packets directory ${abs}: ${e.message}`);
    }
    for (const name of names) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const childAbs = path.join(dirAbs, ...childRel.split("/"));
      const s = fs.lstatSync(childAbs);
      if (s.isDirectory()) walk(childRel);
      else if (s.isFile() && name.endsWith(".vhagent.json")) found.push(childRel);
    }
  };
  walk("");
  return found;
}

/**
 * Tolerant disclosed-claim scan for a packet that FAILED the full verify: findCommitClaims requires
 * a VALID session, which a tampered packet no longer is — but the acceptance still needs the gap
 * NAMED as `claim-unverified-packet` rather than dissolving into `uncovered`. So each event is
 * inspected individually: a `note` event whose string payload parses as a canonical claim (the
 * STRICT T-69.1 parseCommitClaim, reused verbatim) yields a claim row. The rows are counted ONLY
 * as `claim-unverified-packet` by the caller — an unverifiable packet proves nothing, whatever its
 * claims assert. Never throws; anything unparseable is simply skipped.
 */
function scanDisclosedClaims(events) {
  const rows = [];
  if (!Array.isArray(events)) return rows;
  for (const e of events) {
    if (!isPlainObject(e)) continue;
    if (e.type !== agentCommit.CLAIM_EVENT_TYPE) continue;
    if (typeof e.payload !== "string") continue;
    const p = agentCommit.parseCommitClaim(e.payload);
    if (!p.ok) continue;
    rows.push({ seq: Number.isSafeInteger(e.seq) ? e.seq : null, claim: p.claim });
  }
  return rows;
}

/**
 * --deep root re-derivation: clone the LOCAL repo path ONCE into a throwaway temp dir, then for
 * each oid `git checkout --detach` it and run the SHIPPED hashGit VERBATIM (the exact `vh hash
 * --git` engine, so the derived root is byte-identical to what any clean checkout re-derives).
 * Fully offline — a local-path clone opens no network. The temp dir is removed on EVERY exit path
 * (success and failure) by the try/finally. `io.onTempClone(tmpRoot)` is a test-observation hook
 * (it receives the temp path BEFORE any git work, so a test can both record it and inject a fault).
 *
 * @param {string} repoAbs absolute path to (or inside) the source work tree
 * @param {string[]} oids the FULL 40-hex commit oids to derive roots for
 * @param {{ onTempClone?: (tmpRoot: string) => void }} [io]
 * @returns {Map<string, string>} oid -> derived 0x-bytes32 tracked-set root
 */
function deriveRootsViaTempClone(repoAbs, oids, io = {}) {
  const roots = new Map();
  if (oids.length === 0) return roots;
  const srcRoot = git.repoRoot(repoAbs);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vh-agent-coverage-"));
  if (io.onTempClone) io.onTempClone(tmpRoot);
  try {
    const cloneDir = path.join(tmpRoot, "clone");
    // A LOCAL-PATH clone (argv array, no shell, no network) of the caller's own repo.
    git.runGit(srcRoot, ["clone", "--quiet", "--no-hardlinks", "--", srcRoot, cloneDir]);
    for (const oid of oids) {
      git.runGit(cloneDir, ["checkout", "--quiet", "--force", "--detach", oid]);
      roots.set(oid, hashGit(cloneDir, { ref: oid }).root);
    }
    return roots;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

function runAgentCoverage(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.repo) {
    writeErr(
      "error: `vh agent coverage` requires --repo <dir> — the git work tree the commit range is enumerated from\n"
    );
    return EXIT.USAGE;
  }
  if (!opts.range) {
    writeErr(
      "error: `vh agent coverage` requires --range <rev-range> — e.g. origin/main..HEAD, HEAD~5..HEAD, or a ref\n"
    );
    return EXIT.USAGE;
  }
  if (!opts.packets) {
    writeErr(
      "error: `vh agent coverage` requires --packets <dir> — the directory holding the sealed *.vhagent.json packets\n"
    );
    return EXIT.USAGE;
  }

  // (0) --repo must be inside a git work tree — the same named guard the sibling verbs use (exit 1).
  const repoAbs = path.resolve(opts.repo);
  try {
    git.repoRoot(repoAbs);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  // (a) Enumerate the range OLDEST-FIRST. An unknown --range is the NAMED git error at exit 2:
  //     the flag's VALUE is what is wrong (parity with every other bad-flag-value usage error).
  let oids;
  try {
    oids = git.listCommits(repoAbs, opts.range);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }
  const inRange = new Set(oids);

  // --require-since accepts any ref/short-oid and resolves it to the full oid (better DX than
  // demanding 40-hex); an unresolvable value is a usage error with the existing named git error.
  let requireSince = null;
  if (opts.requireSince !== undefined) {
    try {
      requireSince = git.resolveCommit(repoAbs, opts.requireSince);
    } catch (e) {
      writeErr(`error: --require-since: ${e.message}\n`);
      return EXIT.USAGE;
    }
  }

  // (b) Packet intake: FULL shipped verify FIRST, then claim extraction.
  const packetsAbs = path.resolve(opts.packets);
  let packetFiles;
  try {
    packetFiles = listCoveragePacketFiles(packetsAbs);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  const packets = []; // the per-packet inventory (NAMES every unverifiable packet)
  const claims = []; // the fact rows handed to the pure core
  for (const rel of packetFiles) {
    const abs = path.join(packetsAbs, ...rel.split("/"));
    let packet;
    try {
      packet = readPacketFile(abs);
    } catch (e) {
      // Not even a structurally valid packet: no claim can be extracted, but the file is still
      // NAMED in the inventory so the gap never disappears silently.
      packets.push({ packet: rel, verified: false, reason: "INVALID_ARTIFACT", seq: null, claims: 0, detail: e.message });
      continue;
    }
    const v = verifyPacket(packet);
    let rows;
    if (v.accepted) {
      const found = agentCommit.findCommitClaims(packet.events); // T-69.1, VERBATIM
      rows = found.ok ? found.claims : [];
    } else {
      rows = scanDisclosedClaims(packet.events);
    }
    for (const c of rows) {
      claims.push({
        oid: c.claim.commit,
        gitRoot: c.claim.gitRoot,
        packetLabel: rel,
        packetVerified: v.accepted,
        rootVerified: null,
      });
    }
    packets.push({
      packet: rel,
      verified: v.accepted,
      reason: v.accepted ? null : v.reason,
      seq: v.accepted ? null : v.seq,
      claims: rows.length,
    });
  }
  const ignoredClaims = claims.filter((c) => !inRange.has(c.oid)).length;

  // (c) --deep: re-derive each claimed in-range oid's tracked-set root in ONE throwaway clone.
  //     Claims from an UNVERIFIED packet are skipped: they can never count as coverage anyway, and
  //     deriving roots for them would spend git work to no verdict effect.
  if (opts.deep) {
    const need = [
      ...new Set(claims.filter((c) => c.packetVerified && inRange.has(c.oid)).map((c) => c.oid)),
    ];
    let derived;
    try {
      derived = deriveRootsViaTempClone(repoAbs, need, io);
    } catch (e) {
      writeErr(`error: --deep root re-derivation failed: ${e.message}\n`);
      return EXIT.IO;
    }
    for (const c of claims) {
      if (!c.packetVerified) continue;
      const root = derived.get(c.oid);
      if (root !== undefined) c.rootVerified = c.gitRoot === root;
    }
  }

  // (d) Evaluate via the PURE core, then serialize + summarize (both strict, both total).
  const policy = {};
  if (opts.requireAll) policy.requireAll = true;
  if (requireSince !== null) policy.requireSince = requireSince;
  const evaluated = agentCoverage.evaluateCoverage({
    commits: oids.map((oid) => ({ oid })),
    claims,
    policy,
  });
  if (!evaluated.ok) {
    if (evaluated.reason === agentCoverage.REASONS.POLICY_SINCE_NOT_IN_RANGE) {
      writeErr(
        `error: --require-since ${requireSince} is not IN the --range ${opts.range} — the policy ` +
          "cannot anchor to a commit outside the evaluated range\n"
      );
      return EXIT.USAGE;
    }
    if (
      evaluated.reason === agentCoverage.REASONS.COMMITS_TOO_MANY ||
      evaluated.reason === agentCoverage.REASONS.CLAIMS_TOO_MANY
    ) {
      writeErr(
        `error: the range/packet set is too large to evaluate (${evaluated.reason}: the coverage ` +
          `core caps at ${agentCoverage.MAX_COMMITS} commits / ${agentCoverage.MAX_CLAIMS} claims) — ` +
          "narrow --range\n"
      );
      return EXIT.USAGE;
    }
    writeErr(`error: cannot evaluate coverage: ${evaluated.reason}\n`);
    return EXIT.IO; // unexpected — kept total, never a stack trace
  }
  const report = evaluated.report;
  const ser = agentCoverage.serializeCoverageReport(report);
  const sum = ser.ok ? agentCoverage.summarizeCoverage(report) : ser;
  if (!ser.ok || !sum.ok) {
    // Unreachable for a report the core itself just produced; kept total + named.
    writeErr(`error: cannot serialize coverage report: ${(ser.ok ? sum : ser).reason}\n`);
    return EXIT.IO;
  }

  // --out writes EXACTLY the canonical report bytes (no trailing newline): the file byte-diffs
  // across runs, round-trips through parseCoverageReport, and is sealable with `vh evidence seal`.
  let outAbs = null;
  if (opts.out) {
    const emitted = emitArtifact(ser.json, opts.out, write, writeErr);
    if (emitted.code !== EXIT.OK) return emitted.code;
    outAbs = emitted.outAbs;
  }

  // The gate: report-only (no policy) ALWAYS exits 0; a set policy gates exit 3 on failure.
  const gated = report.policy.requireAll || report.policy.requireSince !== null;
  const code = !gated || report.verdict.pass ? EXIT.OK : EXIT.FAIL;

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: code === EXIT.OK,
          note: COVERAGE_TRUST_NOTE,
          kind: agentCoverage.REPORT_KIND,
          repo: repoAbs,
          range: opts.range,
          packetsDir: packetsAbs,
          deep: opts.deep === true,
          summary: sum.summary,
          packets,
          ignoredClaims,
          report,
          out: outAbs,
          // With NO --out the canonical report bytes ride in `artifact` (family parity).
          artifact: outAbs ? null : ser.json,
        },
        null,
        2
      ) + "\n"
    );
    return code;
  }

  write(COVERAGE_TRUST_NOTE + "\n\n");
  write(`# vh agent coverage — ${opts.range} in ${opts.repo} vs ${packetFiles.length} packet(s) under ${opts.packets}\n`);
  write(
    opts.deep
      ? "mode: DEEP — each claimed in-range commit's tracked-set root re-derived in a throwaway local clone (removed afterwards)\n"
      : "mode: OID-ONLY — roots NOT re-derived this run (a verified claim is covered-oid-only at best; pass --deep to re-derive each claimed commit's tracked-set root)\n"
  );
  write("\n" + sum.text + "\n");

  // The actionable per-commit lines: every commit that is NOT covered, capped like the core's list.
  const notCovered = report.commits.filter((c) => !agentCoverage.COVERED_STATUSES.includes(c.status));
  if (notCovered.length > 0) {
    write("\nnot covered:\n");
    const shown = Math.min(notCovered.length, COVERAGE_MAX_LISTED);
    for (let i = 0; i < shown; i++) {
      const c = notCovered[i];
      const labels = [...new Set(c.claims.map((cl) => cl.packetLabel))];
      write(`  - ${c.oid}  ${c.status}${labels.length > 0 ? `  (claimed by: ${labels.join(", ")})` : ""}\n`);
    }
    if (notCovered.length > shown) write(`  ... and ${notCovered.length - shown} more\n`);
  }

  // The packet inventory: every unverifiable packet is NAMED (it proves nothing).
  write(`\npackets (${packetFiles.length}):\n`);
  if (packetFiles.length === 0) {
    write("  (none — no *.vhagent.json under --packets, so every commit is uncovered)\n");
  } else {
    const shown = Math.min(packets.length, COVERAGE_MAX_LISTED);
    for (let i = 0; i < shown; i++) {
      const p = packets[i];
      write(
        p.verified
          ? `  - ${p.packet}  VERIFIED (${p.claims} disclosed claim${p.claims === 1 ? "" : "s"})\n`
          : `  - ${p.packet}  UNVERIFIABLE — ${p.reason}${p.seq !== null && p.seq !== undefined ? ` at event seq ${p.seq}` : ""} (its ${p.claims} claim${p.claims === 1 ? "" : "s"} count only as claim-unverified-packet, never coverage)\n`
      );
    }
    if (packets.length > shown) write(`  ... and ${packets.length - shown} more\n`);
  }
  if (ignoredClaims > 0) {
    write(`\nnote: ${ignoredClaims} disclosed claim(s) name commits OUTSIDE the range (ignored by this report)\n`);
  }
  if (outAbs) write(`\nreport written: ${outAbs}\n`);
  return code;
}

// ---------------------------------------------------------------------------
// FREE-SURFACE-END (vh agent coverage)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CLI dispatch: `vh agent <seal|verify|redact|prove|verify-proof|checkpoint|verify-growth|
//                          commit-claim|verify-commit|coverage> ...`.
// ---------------------------------------------------------------------------

async function cmdAgent(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const [sub, ...rest] = argv;
  const dispatch = {
    seal: [parseAgentSealArgs, runAgentSeal],
    verify: [parseAgentVerifyArgs, runAgentVerify],
    redact: [parseAgentRedactArgs, runAgentRedact],
    prove: [parseAgentProveArgs, runAgentProve],
    "verify-proof": [parseAgentVerifyProofArgs, runAgentVerifyProof],
    checkpoint: [parseAgentCheckpointArgs, runAgentCheckpoint],
    "verify-growth": [parseAgentVerifyGrowthArgs, runAgentVerifyGrowth],
    "commit-claim": [parseAgentCommitClaimArgs, runAgentCommitClaim],
    "verify-commit": [parseAgentVerifyCommitArgs, runAgentVerifyCommit],
    coverage: [parseAgentCoverageArgs, runAgentCoverage],
  };
  if (Object.prototype.hasOwnProperty.call(dispatch, sub)) {
    const [parse, run] = dispatch[sub];
    let opts;
    try {
      opts = parse(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    return run(opts, io);
  }
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    io.write ? io.write(agentUsage()) : process.stdout.write(agentUsage());
    return sub === undefined ? EXIT.USAGE : EXIT.OK;
  }
  writeErr(
    `error: unknown agent subcommand: ${sub} ` +
      "(expected: seal, verify, redact, prove, verify-proof, checkpoint, verify-growth, " +
      "commit-claim, verify-commit, coverage)\n"
  );
  return EXIT.USAGE;
}

function agentUsage() {
  return [
    "vh agent — tamper-evident, selectively-REDACTABLE agent-session evidence packets (AgentTrace)",
    "",
    "Usage:",
    "  vh agent seal <session.jsonl> [--out <p>] [--sign (--key-env <VAR>|--key-file <p>) --license <f>] [--json]",
    "  vh agent verify <packet> [--vendor <0xaddr>] [--json]",
    "  vh agent redact <packet> --seq <list> [--out <p>] [--json]",
    "  vh agent prove <packet> --seq <n> [--out <p>] [--json]",
    "  vh agent verify-proof <proof> [--root <hex>] [--json]",
    "  vh agent checkpoint <session.jsonl> [--out <p>] [--json]",
    "  vh agent verify-growth <earlier-head-or-packet> <later-packet> [--json]",
    "  vh agent commit-claim --repo <dir> [--ref <ref=HEAD>] --seq <n> [--ts <iso>] [--actor <s>] [--out <p>] [--json]",
    "  vh agent verify-commit <packet> --repo <dir> [--ref <ref=HEAD>] [--vendor <0xaddr>] [--json]",
    "  vh agent coverage --repo <dir> --range <rev-range> --packets <dir> [--deep] [--require-all] [--require-since <oid>] [--out <report>] [--json]",
    "",
    "A packet commits an ORDERED agent-session event log (JSONL: prompt/completion/tool_call/tool_result/note)",
    "under one RFC-6962-style Merkle head {size, root} with REDACTION-SAFE leaves: redacting a payload withholds",
    "it behind its hash commitment WITHOUT changing any leaf or the root, so a redacted copy still verifies.",
    "verify RE-DERIVES every leaf + the root from the events you hold — a REJECT names the first offending event",
    "seq; prove/verify-proof disclose + check ONE event offline; checkpoint prints the head so far and",
    "verify-growth proves a later packet extends it APPEND-ONLY (a rewritten past is REJECTED).",
    "",
    "commit-claim binds a session to a git commit: it derives the facts from YOUR work tree (cli/git.js",
    "resolveCommit + the `vh hash --git` engine hashGit, reused verbatim) and prints ONE canonical JSONL claim",
    "event — append it to the session log BEFORE `vh agent seal` (with no --out, stdout is EXACTLY the line, so",
    "`>> session.jsonl` appends cleanly; the trust note rides stderr). verify-commit FIRST re-runs the FULL",
    "packet verification (signature/vendor-pin handling included — a tampered/forged packet never reaches the",
    "claim check), THEN re-resolves the oid + RECOMPUTES the tracked-set root from the AUDITOR'S OWN clone and",
    "ACCEPTs only if a DISCLOSED claim matches; a REJECT names the failed check: packet-invalid /",
    "no-disclosed-claim / oid-mismatch / root-mismatch (root-mismatch => check out the claimed commit in a CLEAN",
    "tree: hashGit reads work-tree bytes, so a dirty checkout is an HONEST mismatch). CONTAINMENT, not causation:",
    "a matching claim does NOT prove the session's events PRODUCED the commit. Both verbs FREE, key-less.",
    "",
    "coverage is the FLEET gate: it enumerates the range's commits OLDEST-FIRST (git rev-list --reverse), FULLY",
    "verifies every *.vhagent.json under --packets through the SAME verify path as `vh agent verify` (an",
    "unverifiable packet's claims count ONLY as claim-unverified-packet — never coverage — and the packet is",
    "NAMED in the report), extracts the disclosed commit-claims, and reports each commit from the CLOSED",
    "vocabulary: covered-verified / covered-oid-only / claim-root-mismatch / claim-unverified-packet /",
    "uncovered. --deep re-derives each claimed commit's tracked-set root (the `vh hash --git` engine, hashGit)",
    "in a throwaway LOCAL clone — offline, removed on every exit path — so a lying gitRoot surfaces as the",
    "NAMED claim-root-mismatch; without --deep roots are NOT re-derived (covered-oid-only, and the output says",
    "so). Report-only default exits 0; --require-all / --require-since <oid> gate exit 3 when a required commit",
    "lacks a verifiable claim; an unknown --range is a NAMED usage error (exit 2). --out writes the canonical,",
    "byte-diffable vh-agent-coverage@1 report — sealable with the existing `vh evidence seal`. Coverage is an",
    "INVENTORY control, not an authorship detector — containment, NOT causation. FREE, read-only, key-less.",
    "CI recipes: verifier/ci/agent-coverage.generic.sh + verifier/ci/agent-coverage.github-actions.yml.",
    "",
    "FREE: seal (unsigned) + verify + redact + prove + verify-proof + checkpoint + verify-growth +",
    "  commit-claim + verify-commit + coverage.",
    "PAID (requires --license <f> carrying the DRAFT `agent_signed` capability): --sign — a detached",
    "  EIP-191 attestation over the HEAD, so ONE signature stays valid for every redacted copy. The gate is the",
    "  SAME offline license mechanism as `vh evidence seal --sign` (fail-closed; never silently downgraded),",
    "  verified against the CANONICAL vendor identity " + evidence.CANONICAL_VENDOR_ADDRESS + " — a caller",
    "  --vendor must EQUAL it, it can NOT re-pin the gate (self-mint defense; self-hosters set their own",
    "  identity via " + evidence.CANONICAL_VENDOR_ENV + " — docs/LICENSING.md).",
    "",
    "The packet proves the LOG is unaltered since seal and append-only across checkpoints — NOT that the log",
    "faithfully records what the agent actually did; `ts` is SELF-ASSERTED; not a trusted timestamp (P-3).",
    "Exit: 0 ok/ACCEPTED / 3 named REJECT or gate-fail / 2 usage / 1 IO or invalid artifact.",
    "",
  ].join("\n");
}

module.exports = {
  EXIT,
  // artifact framing (kinds, notes, caps)
  PACKET_KIND,
  PACKET_SCHEMA_VERSION,
  AGENT_HEAD_KIND,
  SIGNED_HEAD_KIND,
  CHECKPOINT_KIND,
  PROOF_KIND,
  MAX_INPUT_BYTES,
  AGENT_TRUST_NOTE,
  SIGNED_HEAD_TRUST_NOTE,
  COMMIT_CLAIM_TRUST_NOTE,
  COVERAGE_TRUST_NOTE,
  AgentPacketError,
  // license framing (the evidence mechanism, extended by the DRAFT agent capability)
  AGENT_LICENSE_CFG,
  AGENT_SIGNED_CAPABILITY,
  gateAgentPaid,
  // pure packet core
  buildPacket,
  validatePacketShape,
  serializePacket,
  verifyPacket,
  validateHeadPayload,
  serializeHeadPayload,
  SIGNED_HEAD_CFG,
  validateProofArtifactShape,
  parseSessionText,
  // CLI
  parseAgentSealArgs,
  parseAgentVerifyArgs,
  parseAgentRedactArgs,
  parseAgentProveArgs,
  parseAgentVerifyProofArgs,
  parseAgentCheckpointArgs,
  parseAgentVerifyGrowthArgs,
  parseAgentCommitClaimArgs,
  parseAgentVerifyCommitArgs,
  parseAgentCoverageArgs,
  runAgentSeal,
  runAgentVerify,
  runAgentRedact,
  runAgentProve,
  runAgentVerifyProof,
  runAgentCheckpoint,
  runAgentVerifyGrowth,
  runAgentCommitClaim,
  runAgentVerifyCommit,
  runAgentCoverage,
  deriveRootsViaTempClone,
  listCoveragePacketFiles,
  cmdAgent,
  agentUsage,
};
