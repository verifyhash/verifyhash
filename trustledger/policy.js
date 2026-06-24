"use strict";

// ---------------------------------------------------------------------------
// trustledger/policy.js — versioned, strictly-validated per-state trust-rule
// policy + a PURE applyPolicy() that overrides exception severities.
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS
// ---------------
// reconcile.js ships a single, hard-coded DEFAULT_SEVERITY baseline. But what
// counts as "out of trust" vs. "needs a human eye" is a matter of the STATE's
// trust-account statute (e.g. some states make an owner draw against tenant
// money a per-se ERROR; others treat an NSF reversal as merely a warning until
// it is re-deposited). A policy lets a CPA/broker pin each exception type to the
// severity their jurisdiction's rule demands, and to CITE the statute so the
// control is defensible in an audit.
//
// HONEST POSTURE / DISCLAIMER
// ---------------------------
// A policy file is an AID to reconciliation. Editing severities here does NOT
// make the result legal advice and does NOT discharge the broker's duty as the
// responsible legal custodian of trust funds, nor does it replace a CPA's
// review. The shipped fixtures are DRAFT / NOT-LEGAL-ADVICE skeletons a
// qualified human edits. This module makes NO claim of regulatory compliance.
//
// DESIGN PROPERTIES
// -----------------
//   * PURE: readPolicy/validatePolicy/applyPolicy have no clock, no I/O, no
//     hidden state; the same inputs always produce byte-identical output.
//   * STRICT: a wrong schemaVersion, an unknown exception type key, a severity
//     not in {info,warning,error}, or a malformed toleranceCents is a NAMED
//     hard error — never a silent no-op or partial accept.
//   * GROUNDED IN reconcile.js: the legal exception type strings and severity
//     values are REUSED from EXCEPTION/SEVERITY, so a typo'd type is a
//     validation error rather than a silently-ignored key.

const { EXCEPTION, SEVERITY } = require("./reconcile");

// Bump only on an INCOMPATIBLE schema change. readPolicy rejects anything else.
const SCHEMA_VERSION = 1;

// The set of legal exception type strings, derived from reconcile.js (NOT
// re-declared here) so the two can never drift.
const EXCEPTION_TYPES = Object.freeze(new Set(Object.values(EXCEPTION)));
// The set of legal severity strings, likewise derived.
const SEVERITY_VALUES = Object.freeze(new Set(Object.values(SEVERITY)));

class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "PolicyError";
  }
}

// ---------------------------------------------------------------------------
// readPolicy(textOrObj) -> validated, frozen policy object
// ---------------------------------------------------------------------------
//
// Accepts either a JSON string (e.g. a fixture file's contents) or an already
// parsed plain object. Parsing and validation are separated so callers can
// validate an in-memory object without serializing it. PURE: no file I/O here;
// the caller reads the file and passes the text.
function readPolicy(input) {
  let obj = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new PolicyError(`policy is not valid JSON: ${e.message}`);
    }
  }
  return validatePolicy(obj);
}

// ---------------------------------------------------------------------------
// validatePolicy(obj) -> validated, frozen policy object
// ---------------------------------------------------------------------------
//
// Strictly validates and returns a NEW frozen, canonical policy object. Throws
// PolicyError on the first defect found. Never mutates the input.
function validatePolicy(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new PolicyError("policy must be a JSON object");
  }

  // ---- schemaVersion: must be present and exactly the supported integer ----
  if (!Object.prototype.hasOwnProperty.call(obj, "schemaVersion")) {
    throw new PolicyError("policy is missing required field: schemaVersion");
  }
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    throw new PolicyError(
      `unsupported policy schemaVersion ${JSON.stringify(
        obj.schemaVersion
      )}; this build understands schemaVersion ${SCHEMA_VERSION}`
    );
  }

  // ---- state: a non-empty human label --------------------------------------
  if (typeof obj.state !== "string" || obj.state.trim() === "") {
    throw new PolicyError("policy.state must be a non-empty string label");
  }

  // ---- severities: type -> severity override map ---------------------------
  if (!Object.prototype.hasOwnProperty.call(obj, "severities")) {
    throw new PolicyError("policy is missing required field: severities");
  }
  if (
    obj.severities === null ||
    typeof obj.severities !== "object" ||
    Array.isArray(obj.severities)
  ) {
    throw new PolicyError("policy.severities must be an object map");
  }
  const severities = {};
  for (const key of Object.keys(obj.severities)) {
    if (!EXCEPTION_TYPES.has(key)) {
      throw new PolicyError(
        `policy.severities has unknown exception type ${JSON.stringify(key)}; ` +
          `legal types are: ${[...EXCEPTION_TYPES].sort().join(", ")}`
      );
    }
    const val = obj.severities[key];
    if (!SEVERITY_VALUES.has(val)) {
      throw new PolicyError(
        `policy.severities[${JSON.stringify(key)}] has invalid severity ` +
          `${JSON.stringify(val)}; must be one of: ` +
          `${[...SEVERITY_VALUES].sort().join(", ")}`
      );
    }
    severities[key] = val;
  }

  // ---- citations: optional type -> statute/rule string map -----------------
  // Carried into the report so each severity override is grounded in the rule
  // it rests on. A citation for a type NOT present in severities is rejected:
  // citing a rule you do not actually apply is misleading in an audit.
  const citations = {};
  if (Object.prototype.hasOwnProperty.call(obj, "citations")) {
    if (
      obj.citations === null ||
      typeof obj.citations !== "object" ||
      Array.isArray(obj.citations)
    ) {
      throw new PolicyError("policy.citations must be an object map");
    }
    for (const key of Object.keys(obj.citations)) {
      if (!EXCEPTION_TYPES.has(key)) {
        throw new PolicyError(
          `policy.citations has unknown exception type ${JSON.stringify(key)}`
        );
      }
      if (!Object.prototype.hasOwnProperty.call(severities, key)) {
        throw new PolicyError(
          `policy.citations[${JSON.stringify(key)}] cites a rule for a type ` +
            "with no severity override; cite only the overrides you apply"
        );
      }
      const cite = obj.citations[key];
      if (typeof cite !== "string" || cite.trim() === "") {
        throw new PolicyError(
          `policy.citations[${JSON.stringify(key)}] must be a non-empty string`
        );
      }
      citations[key] = cite;
    }
  }

  // ---- toleranceCents: optional non-negative integer cents -----------------
  let toleranceCents;
  if (Object.prototype.hasOwnProperty.call(obj, "toleranceCents")) {
    const t = obj.toleranceCents;
    if (!Number.isInteger(t) || t < 0) {
      throw new PolicyError(
        `policy.toleranceCents must be a non-negative integer (cents); got ` +
          `${JSON.stringify(t)}`
      );
    }
    toleranceCents = t;
  }

  // Build a canonical, frozen result. Keys are inserted in a fixed order so the
  // object's own enumeration order is deterministic regardless of input order.
  const out = { schemaVersion: SCHEMA_VERSION, state: obj.state };
  out.severities = Object.freeze(sortedMap(severities));
  out.citations = Object.freeze(sortedMap(citations));
  if (toleranceCents !== undefined) out.toleranceCents = toleranceCents;
  return Object.freeze(out);
}

// Return a new object with the same entries in sorted-key order (deterministic
// enumeration; pure).
function sortedMap(m) {
  const out = {};
  for (const k of Object.keys(m).sort()) out[k] = m[k];
  return out;
}

// ---------------------------------------------------------------------------
// applyPolicy(reconcileResult, policy) -> NEW reconcile-shaped result
// ---------------------------------------------------------------------------
//
// Returns a NEW result whose exceptions have their `severity` replaced by the
// policy override when one is present for that type, and a `citation` attached
// when the policy supplies one. Records, amounts, labels, details, and balances
// are left untouched. Deterministic and side-effect-free: the input result is
// not mutated.
//
// When `policy` is null/undefined the INPUT is returned UNCHANGED (same object
// reference) — the no-policy path is byte-for-byte today's DEFAULT_SEVERITY
// baseline behaviour.
function applyPolicy(reconcileResult, policy) {
  if (policy === null || policy === undefined) {
    return reconcileResult;
  }
  // Defensive: a caller must hand us a validated policy. Re-validate cheaply by
  // checking the shape we depend on rather than trusting a foreign object.
  if (
    typeof policy !== "object" ||
    policy.severities === null ||
    typeof policy.severities !== "object"
  ) {
    throw new PolicyError("applyPolicy requires a validated policy object");
  }
  if (
    reconcileResult === null ||
    typeof reconcileResult !== "object" ||
    !Array.isArray(reconcileResult.exceptions)
  ) {
    throw new PolicyError(
      "applyPolicy requires a reconcile result with an exceptions array"
    );
  }

  const severities = policy.severities;
  const citations = policy.citations || {};

  const exceptions = reconcileResult.exceptions.map((ex) => {
    const hasOverride = Object.prototype.hasOwnProperty.call(
      severities,
      ex.type
    );
    const hasCitation = Object.prototype.hasOwnProperty.call(
      citations,
      ex.type
    );
    // No override and no citation: pass the exception through unchanged. We
    // still return a shallow copy so the result is a fresh tree (no aliasing
    // back into the input's array), keeping applyPolicy side-effect-free.
    const next = {
      type: ex.type,
      severity: hasOverride ? severities[ex.type] : ex.severity,
      amount: ex.amount,
      label: ex.label,
      detail: ex.detail,
      records: ex.records,
    };
    if (hasCitation) next.citation = citations[ex.type];
    return next;
  });

  return {
    balances: reconcileResult.balances,
    tiesOut: reconcileResult.tiesOut,
    exceptions,
  };
}

module.exports = {
  SCHEMA_VERSION,
  PolicyError,
  readPolicy,
  validatePolicy,
  applyPolicy,
  // exported for focused tests / reuse
  EXCEPTION_TYPES,
  SEVERITY_VALUES,
};
