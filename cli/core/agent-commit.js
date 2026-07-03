"use strict";

// cli/core/agent-commit.js — the PURE commit-claim core (T-69.1, EPIC-69).
//
// WHAT THIS IS
//   The canonical "this session claims commit X of tree-root R" payload, plus its strict
//   verifier, layered on the T-68.1 agent-session core. A commit claim is an ordinary
//   canonical session event (`type: "note"`) whose payload is ONE canonical JSON string:
//
//       {"commit":"<40-hex oid>","gitRoot":"0x<64-hex>","kind":"vh-agent-commit-claim@1"[,"scope":"<posix hint>"]}
//
//   Keys SORTED, no whitespace, lowercase hex — so the claim has exactly ONE byte
//   representation and the payload commitment (agent-session `payloadHash`) is reproducible
//   by anyone from the facts alone. Because the claim rides the T-68.1 redaction-safe leaf,
//   sealing a session that contains it and then redacting ANY OTHER event leaves the head
//   UNCHANGED and the claim still disclosed, findable and verifiable.
//
// WHAT THE FIELDS MEAN (all CALLER-SUPPLIED — this core never derives them)
//   - `commit`:  the git commit oid (40-hex lowercase; what `cli/git.js resolveCommit` returns).
//   - `gitRoot`: the 0x-bytes32 tracked-set root (what `cli/hash.js hashGit` returns).
//   - `scope`:   OPTIONAL repo-relative POSIX path hint (which subtree the session touched).
//     `scope` is an UNVERIFIED hint: verifyCommitClaim checks `commit` and `gitRoot` only.
//
// TRUST BOUNDARY (honest — carried into docs by T-69.3)
//   The core proves the sealed log CONTAINS an unaltered claim to exactly (commit, gitRoot).
//   It does NOT prove the session's events PRODUCED that commit (containment, not causation),
//   does not touch git, a clock, or the filesystem, and trusts the caller for every fact:
//   re-deriving the facts from a real clone is the T-69.2 CLI's job.
//
// PURITY (a hard acceptance criterion, statically guarded by the test)
//   No fs / git / child_process / http / https / net / dns, no process.env, no clock, no
//   randomness, no signing material, NO new crypto and NO new dependency. The ONLY require is
//   `./agent-session` (itself statically guarded pure), reused NOT forked: event validation and
//   the payload commitment come from that core verbatim. Every exported function is TOTAL:
//   hostile input yields a named `{ ok:false, reason }` verdict, never an exception.

const {
  validateEvent,
  validateSession,
  payloadHash: sessionPayloadHash,
} = require("./agent-session");

// ---------------------------------------------------------------------------------------------------
// Canonical schema constants.
// ---------------------------------------------------------------------------------------------------

// The versioned kind tag bound INSIDE the payload bytes. Any schema change bumps the version;
// an unknown kind/version is a NAMED reject (CLAIM_BAD_KIND), never silently accepted.
const CLAIM_KIND = "vh-agent-commit-claim@1";

// A commit claim is always a canonical `note` event — the self-describing payload plus the
// closed T-68.1 type set make the claim unambiguous without extending that schema.
const CLAIM_EVENT_TYPE = "note";

// Default `actor` for a built claim event when the caller does not name one.
const DEFAULT_ACTOR = "agent";

// The exhaustive field set of a canonical claim object (payload JSON). Sorted — this IS the
// serialization order. Any other key is CLAIM_UNKNOWN_FIELD.
const CLAIM_FIELDS = Object.freeze(["commit", "gitRoot", "kind", "scope"]);

// Size caps that keep parsing total and O(cap) on hostile input. A canonical claim is ~150
// bytes + the scope hint; JSON escaping can inflate a 4096-char scope at most 6x, so 32 KiB
// leaves generous headroom while rejecting megabyte "payloads" in O(1) BEFORE JSON.parse.
const MAX_SCOPE_LENGTH = 4096;
const MAX_PAYLOAD_LENGTH = 32768;

// Stable, named reason codes — the verdict contract callers (and the T-69.2 CLI) rely on.
// The three verifyCommitClaim verdicts are the lowercase names the backlog fixes; note that
// findCommitClaims/buildCommitClaimEvent may also pass through agent-session REASONS codes
// (EVENT_*/SESSION_*) verbatim when the EVENT layer (not the claim) is what is malformed.
const REASONS = Object.freeze({
  CLAIM_NOT_OBJECT: "CLAIM_NOT_OBJECT",
  CLAIM_UNKNOWN_FIELD: "CLAIM_UNKNOWN_FIELD",
  CLAIM_BAD_KIND: "CLAIM_BAD_KIND",
  CLAIM_BAD_COMMIT: "CLAIM_BAD_COMMIT",
  CLAIM_BAD_GIT_ROOT: "CLAIM_BAD_GIT_ROOT",
  CLAIM_BAD_SCOPE: "CLAIM_BAD_SCOPE",
  CLAIM_REDACTED: "CLAIM_REDACTED",
  CLAIM_BAD_EVENT_TYPE: "CLAIM_BAD_EVENT_TYPE",
  PAYLOAD_NOT_STRING: "PAYLOAD_NOT_STRING",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  PAYLOAD_NOT_JSON: "PAYLOAD_NOT_JSON",
  PAYLOAD_NOT_CANONICAL: "PAYLOAD_NOT_CANONICAL",
  VERIFY_BAD_INPUT: "VERIFY_BAD_INPUT",
  VERIFY_BAD_EXPECTED: "VERIFY_BAD_EXPECTED",
  OID_MISMATCH: "oid-mismatch",
  ROOT_MISMATCH: "root-mismatch",
  BAD_CLAIM: "bad-claim",
  HOSTILE_INPUT: "HOSTILE_INPUT",
});

// STRICT lowercase — `git rev-parse` and `hashGit` both emit lowercase, and accepting a
// case-variant would mint a second byte representation of the "same" claim.
const COMMIT_RE = /^[0-9a-f]{40}$/;
const GIT_ROOT_RE = /^0x[0-9a-f]{64}$/;

// A "plain" object: prototype is Object.prototype or null (same discipline as agent-session —
// what we serialize is exactly the JSON-shaped data the caller could write and read back).
function _isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// A valid repo-relative POSIX scope hint: non-empty, capped, forward slashes only, no
// control characters, no empty/"."/".." segments (so no absolute paths, no traversal, no
// trailing slash), and UTF-8-encodable (a lone UTF-16 surrogate — checked via the REUSED
// agent-session payloadHash, which returns null exactly for unencodable strings).
function _isValidScope(s) {
  if (typeof s !== "string") return false;
  if (s.length === 0 || s.length > MAX_SCOPE_LENGTH) return false;
  if (s.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (sessionPayloadHash(s) === null) return false;
  for (const seg of s.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

// Validate the claim FIELDS of a plain object (builder input or parsed payload alike).
// Returns { ok:true, claim } with the canonical claim object, or the named reject.
// `kind` is optional on input (a parsed claim carries it; a fresh build may omit it) but,
// when present, MUST be exactly CLAIM_KIND — that one check covers both "unknown kind"
// and "unknown version" since the version lives inside the kind string.
function _validateClaimFields(input, extraAllowedKeys) {
  if (!_isPlainObject(input)) return { ok: false, reason: REASONS.CLAIM_NOT_OBJECT };
  if ("kind" in input && input.kind !== CLAIM_KIND) {
    return { ok: false, reason: REASONS.CLAIM_BAD_KIND, field: "kind" };
  }
  for (const k of Object.keys(input)) {
    if (!CLAIM_FIELDS.includes(k) && !extraAllowedKeys.includes(k)) {
      return { ok: false, reason: REASONS.CLAIM_UNKNOWN_FIELD, field: k };
    }
  }
  if (typeof input.commit !== "string" || !COMMIT_RE.test(input.commit)) {
    return { ok: false, reason: REASONS.CLAIM_BAD_COMMIT, field: "commit" };
  }
  if (typeof input.gitRoot !== "string" || !GIT_ROOT_RE.test(input.gitRoot)) {
    return { ok: false, reason: REASONS.CLAIM_BAD_GIT_ROOT, field: "gitRoot" };
  }
  if ("scope" in input && !_isValidScope(input.scope)) {
    return { ok: false, reason: REASONS.CLAIM_BAD_SCOPE, field: "scope" };
  }
  const claim = { kind: CLAIM_KIND, commit: input.commit, gitRoot: input.gitRoot };
  if ("scope" in input) claim.scope = input.scope;
  return { ok: true, claim };
}

// The ONE byte representation of a claim: keys in sorted (CLAIM_FIELDS) order, JSON string
// escaping, no whitespace. Assumes a validated claim object.
function _serializeClaim(claim) {
  const parts = [];
  for (const k of CLAIM_FIELDS) {
    if (k in claim) parts.push(JSON.stringify(k) + ":" + JSON.stringify(claim[k]));
  }
  return "{" + parts.join(",") + "}";
}

// ---------------------------------------------------------------------------------------------------
// (a) commitClaimPayload — build the canonical claim string.
// ---------------------------------------------------------------------------------------------------

/**
 * Build the canonical commit-claim payload STRING from caller-supplied git facts.
 * DETERMINISTIC: the same facts yield BYTE-IDENTICAL output regardless of the input object's
 * key insertion order, on every call. TOTAL: every failure is a named reject; never throws.
 *
 * @param {{ commit: string, gitRoot: string, scope?: string, kind?: string }} input
 *        `commit` 40-hex lowercase oid; `gitRoot` 0x-bytes32 lowercase hex (the hashGit root);
 *        `scope` optional repo-relative POSIX hint; `kind` optional but must equal CLAIM_KIND
 *        when present (so a parsed claim round-trips straight back through this builder).
 * @returns {{ ok: true, payload: string, claim: object } | { ok: false, reason: string, field?: string }}
 *        On ok: `payload` is the canonical string; `claim` the canonical claim object
 *        ({ kind, commit, gitRoot, scope? }) — parseCommitClaim(payload).claim deep-equals it.
 */
function commitClaimPayload(input) {
  try {
    const v = _validateClaimFields(input, []);
    if (!v.ok) return v;
    return { ok: true, payload: _serializeClaim(v.claim), claim: v.claim };
  } catch (_) {
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

// ---------------------------------------------------------------------------------------------------
// (b) parseCommitClaim — the strict inverse.
// ---------------------------------------------------------------------------------------------------

/**
 * Parse and STRICTLY validate a claim payload string. Accepts ONLY the canonical bytes:
 * unknown kind/version, extra/missing/malformed fields, oversize input, non-JSON, and any
 * NON-CANONICAL byte representation (reordered keys, whitespace, uppercase hex, duplicate
 * keys, escape-sequence variants) are each a NAMED reject. NEVER throws.
 *
 * Round-trip invariants (tested):
 *   parseCommitClaim(commitClaimPayload(x).payload).claim  deep-equals  commitClaimPayload(x).claim
 *   commitClaimPayload(parseCommitClaim(s).claim).payload  ===  s
 *
 * @param {string} payloadString
 * @returns {{ ok: true, claim: { kind: string, commit: string, gitRoot: string, scope?: string } }
 *         | { ok: false, reason: string, field?: string }}
 */
function parseCommitClaim(payloadString) {
  try {
    if (typeof payloadString !== "string") {
      return { ok: false, reason: REASONS.PAYLOAD_NOT_STRING };
    }
    if (payloadString.length > MAX_PAYLOAD_LENGTH) {
      return { ok: false, reason: REASONS.PAYLOAD_TOO_LARGE };
    }
    let parsed;
    try {
      parsed = JSON.parse(payloadString);
    } catch (_) {
      return { ok: false, reason: REASONS.PAYLOAD_NOT_JSON };
    }
    // JSON.parse yields plain objects only ("__proto__" arrives as an ordinary own key and is
    // caught by the exhaustive-field check); `kind` here is REQUIRED, not optional.
    if (!_isPlainObject(parsed)) return { ok: false, reason: REASONS.CLAIM_NOT_OBJECT };
    if (parsed.kind !== CLAIM_KIND) {
      return { ok: false, reason: REASONS.CLAIM_BAD_KIND, field: "kind" };
    }
    const v = _validateClaimFields(parsed, []);
    if (!v.ok) return v;
    // Canonical-bytes check: the ONLY accepted representation is the one this core emits.
    if (_serializeClaim(v.claim) !== payloadString) {
      return { ok: false, reason: REASONS.PAYLOAD_NOT_CANONICAL };
    }
    return { ok: true, claim: v.claim };
  } catch (_) {
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

// ---------------------------------------------------------------------------------------------------
// (c) buildCommitClaimEvent — the canonical T-68.1 event carrying the claim.
// ---------------------------------------------------------------------------------------------------

/**
 * Build the canonical claim EVENT: a full (disclosed) `note` event whose payload is the
 * canonical claim string, ready to append to a session log and seal via the T-68.1 core.
 * The returned event is asserted through agent-session `validateEvent` (REUSED verbatim)
 * before it is handed back, so what this returns is BY CONSTRUCTION a canonical event —
 * bad seq/ts/actor surface as that core's own named rejects (EVENT_BAD_SEQ, ...), and the
 * event's leaf enjoys every T-68.1 guarantee (in particular: redacting any OTHER event in
 * the session leaves the head unchanged and this claim disclosed). Never throws.
 *
 * @param {{ seq: number, ts: string, actor?: string, commit: string, gitRoot: string, scope?: string }} input
 *        `seq`/`ts` as in the T-68.1 schema (`ts` SELF-ASSERTED, untrusted); `actor`
 *        defaults to DEFAULT_ACTOR; git facts as in commitClaimPayload.
 * @returns {{ ok: true, event: object, payload: string, claim: object }
 *         | { ok: false, reason: string, field?: string }}
 */
function buildCommitClaimEvent(input) {
  try {
    const v = _validateClaimFields(input, ["seq", "ts", "actor"]);
    if (!v.ok) return v;
    const event = {
      seq: input.seq,
      ts: input.ts,
      actor: "actor" in input ? input.actor : DEFAULT_ACTOR,
      type: CLAIM_EVENT_TYPE,
      payload: _serializeClaim(v.claim),
    };
    const ev = validateEvent(event);
    if (!ev.ok) return { ok: false, reason: ev.reason, field: ev.field };
    return { ok: true, event, payload: event.payload, claim: v.claim };
  } catch (_) {
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

// ---------------------------------------------------------------------------------------------------
// (d) findCommitClaims — every DISCLOSED claim in a session.
// ---------------------------------------------------------------------------------------------------

/**
 * Scan a VALID session (agent-session `validateSession`, reused verbatim — an invalid session
 * is that core's own named, located reject) for every DISCLOSED commit claim: a `note` event
 * whose full payload parses as a canonical claim. A REDACTED claim event is by definition not
 * disclosable — its payload bytes are withheld, only the commitment remains — so it is
 * deliberately NOT returned here (the holder re-discloses by including the full event).
 * Non-claim notes and unparseable payloads are simply skipped, never errors. Never throws.
 *
 * @param {object[]} events the session (full or partially redacted).
 * @returns {{ ok: true, claims: { index: number, seq: number, claim: object, payload: string, event: object }[] }
 *         | { ok: false, reason: string, index?: number, field?: string }}
 *        `index` === `seq` === the event's tree position (what proveEvent/verifyEvent bind);
 *        `event` is a deep copy — the result never aliases caller-mutable state.
 */
function findCommitClaims(events) {
  try {
    const s = validateSession(events);
    if (!s.ok) return s;
    const claims = [];
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type !== CLAIM_EVENT_TYPE) continue;
      if (typeof e.payload !== "string") continue; // redacted or absent: not disclosed
      const p = parseCommitClaim(e.payload);
      if (!p.ok) continue;
      claims.push({
        index: i,
        seq: e.seq,
        claim: p.claim,
        payload: e.payload,
        event: JSON.parse(JSON.stringify(e)),
      });
    }
    return { ok: true, claims };
  } catch (_) {
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

// ---------------------------------------------------------------------------------------------------
// (e) verifyCommitClaim — the strict verifier.
// ---------------------------------------------------------------------------------------------------

/**
 * Verify ONE disclosed claim against the EXPECTED facts the auditor re-derived themselves
 * (oid from their own clone, root from their own hashGit run — this core never derives them).
 *
 * Give EXACTLY ONE of:
 *   - `event`: a canonical claim event (validated via agent-session `validateEvent` verbatim;
 *     a redacted event is `bad-claim`/CLAIM_REDACTED — withheld bytes cannot be verified;
 *     a non-`note` type is `bad-claim`/CLAIM_BAD_EVENT_TYPE), or
 *   - `payloadString`: the raw canonical claim string.
 *
 * Verdicts (never a throw):
 *   { ok:true, claim, seq? }                                    — facts match exactly;
 *   { ok:false, reason:"oid-mismatch",  field:"commit",  claimed, expected }
 *   { ok:false, reason:"root-mismatch", field:"gitRoot", claimed, expected }
 *   { ok:false, reason:"bad-claim",     detail, field? }        — the claim itself is invalid
 *                                                                 (detail = the underlying code);
 *   { ok:false, reason:"VERIFY_BAD_INPUT"|"VERIFY_BAD_EXPECTED", field? } — malformed CALL.
 *
 * NOTE `scope` is a hint and is NOT verified — only `commit` and `gitRoot` are facts.
 * Mismatches are reported oid-first; both fields may of course differ.
 *
 * @param {{ event?: object, payloadString?: string, expected: { commit: string, gitRoot: string } }} args
 * @returns {{ ok: true, claim: object, seq?: number } | { ok: false, reason: string, [k: string]: any }}
 */
function verifyCommitClaim(args) {
  try {
    if (!_isPlainObject(args)) return { ok: false, reason: REASONS.VERIFY_BAD_INPUT };
    for (const k of Object.keys(args)) {
      if (!["event", "payloadString", "expected"].includes(k)) {
        return { ok: false, reason: REASONS.VERIFY_BAD_INPUT, field: k };
      }
    }
    const hasEvent = "event" in args;
    const hasPayload = "payloadString" in args;
    if (hasEvent === hasPayload) {
      // neither, or both: ambiguous call
      return { ok: false, reason: REASONS.VERIFY_BAD_INPUT, field: "event" };
    }

    const exp = args.expected;
    if (!_isPlainObject(exp)) {
      return { ok: false, reason: REASONS.VERIFY_BAD_EXPECTED, field: "expected" };
    }
    for (const k of Object.keys(exp)) {
      if (!["commit", "gitRoot"].includes(k)) {
        return { ok: false, reason: REASONS.VERIFY_BAD_EXPECTED, field: k };
      }
    }
    if (typeof exp.commit !== "string" || !COMMIT_RE.test(exp.commit)) {
      return { ok: false, reason: REASONS.VERIFY_BAD_EXPECTED, field: "commit" };
    }
    if (typeof exp.gitRoot !== "string" || !GIT_ROOT_RE.test(exp.gitRoot)) {
      return { ok: false, reason: REASONS.VERIFY_BAD_EXPECTED, field: "gitRoot" };
    }

    let payload;
    let seq;
    if (hasEvent) {
      const ev = validateEvent(args.event);
      if (!ev.ok) {
        return { ok: false, reason: REASONS.BAD_CLAIM, detail: ev.reason, field: ev.field };
      }
      if (ev.redacted) {
        return { ok: false, reason: REASONS.BAD_CLAIM, detail: REASONS.CLAIM_REDACTED };
      }
      if (args.event.type !== CLAIM_EVENT_TYPE) {
        return {
          ok: false,
          reason: REASONS.BAD_CLAIM,
          detail: REASONS.CLAIM_BAD_EVENT_TYPE,
          field: "type",
        };
      }
      payload = args.event.payload;
      seq = args.event.seq;
    } else {
      payload = args.payloadString;
    }

    const p = parseCommitClaim(payload);
    if (!p.ok) {
      return { ok: false, reason: REASONS.BAD_CLAIM, detail: p.reason, field: p.field };
    }
    if (p.claim.commit !== exp.commit) {
      return {
        ok: false,
        reason: REASONS.OID_MISMATCH,
        field: "commit",
        claimed: p.claim.commit,
        expected: exp.commit,
      };
    }
    if (p.claim.gitRoot !== exp.gitRoot) {
      return {
        ok: false,
        reason: REASONS.ROOT_MISMATCH,
        field: "gitRoot",
        claimed: p.claim.gitRoot,
        expected: exp.gitRoot,
      };
    }
    const out = { ok: true, claim: p.claim };
    if (seq !== undefined) out.seq = seq;
    return out;
  } catch (_) {
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

module.exports = {
  // Schema + verdict contract.
  CLAIM_KIND,
  CLAIM_EVENT_TYPE,
  CLAIM_FIELDS,
  DEFAULT_ACTOR,
  MAX_SCOPE_LENGTH,
  MAX_PAYLOAD_LENGTH,
  REASONS,
  // The core operations.
  commitClaimPayload,
  parseCommitClaim,
  buildCommitClaimEvent,
  findCommitClaims,
  verifyCommitClaim,
};
