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

const fs = require("fs");
const path = require("path");

const { EXCEPTION, SEVERITY, compareExceptions } = require("./reconcile");

// Bump only on an INCOMPATIBLE schema change. readPolicy rejects anything else.
const SCHEMA_VERSION = 1;

// The set of legal exception type strings, derived from reconcile.js (NOT
// re-declared here) so the two can never drift. Because it is enum-derived, a
// new engine exception type (e.g. `ambiguous_deposit`) becomes an accepted
// `severities`/`citations` key automatically — no re-listing here — so a state
// can grade it (escalate the default WARNING to a hard ERROR) the day the
// engine learns to detect it.
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
// RE-SORT AFTER ESCALATION. reconcile.js sorts its exceptions errors-first, and
// the HTML/CSV renderers (and the human reading the signed packet) rely on that
// order so an out-of-trust ERROR sits at the top. Because a policy can ESCALATE
// a warning/info row to ERROR (or de-escalate), the input order is no longer
// valid for the new severities. We re-apply reconcile's exact stable comparator
// (compareExceptions, imported — not re-implemented — so the two cannot drift)
// so a freshly-escalated ERROR re-sorts to the top exactly as a natively
// detected one would. Order-only; the verdict/counts are order-independent.
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

  // Re-sort under the NEW (possibly escalated) severities, using reconcile's
  // own stable comparator. .sort is in-place on our freshly-built array (the
  // input result and its exceptions array are untouched), so this stays pure.
  exceptions.sort(compareExceptions);

  return {
    balances: reconcileResult.balances,
    tiesOut: reconcileResult.tiesOut,
    exceptions,
  };
}

// ---------------------------------------------------------------------------
// Bundled per-state fixture policies + `--state <code>` resolution.
// ---------------------------------------------------------------------------
//
// The product ships a small set of DRAFT / NOT-LEGAL-ADVICE skeleton policies
// under trustledger/fixtures/policy. `vh trust reconcile --state <code>` lets a
// broker pick one WITHOUT having to point at a file path, by naming the policy's
// `state` label (or, equivalently, the fixture filename). This is the ONLY part
// of this module that touches the filesystem, and it reads only from the
// package's own bundled fixtures directory — never a caller path — so the result
// stays deterministic and the rest of the module stays pure.

const BUNDLED_DIR = path.join(__dirname, "fixtures", "policy");

// Normalize a state code/label for comparison: lowercase, collapse runs of
// non-alphanumerics to a single space, trim. So "California", "california",
// and "CALIFORNIA  " all resolve alike, and a verbose label like
// "EXAMPLE-STATE (illustrative override)" can be addressed by its leading code.
function normStateCode(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// List the bundled fixture policies as { code, file, policy } entries, where
// `code` is the fixture filename without ".json". Validates each on load so a
// shipped fixture that drifts out of schema is a hard, named error rather than a
// silent miss. Deterministic (filenames are sorted).
function bundledPolicies() {
  let names;
  try {
    names = fs.readdirSync(BUNDLED_DIR).filter((n) => n.endsWith(".json"));
  } catch (e) {
    throw new PolicyError(`cannot read bundled policy directory: ${e.message}`);
  }
  return names
    .sort()
    .map((file) => {
      const full = path.join(BUNDLED_DIR, file);
      let policy;
      try {
        policy = readPolicy(fs.readFileSync(full, "utf8"));
      } catch (e) {
        throw new PolicyError(`bundled policy ${file} is invalid: ${e.message}`);
      }
      return { code: file.replace(/\.json$/, ""), file: full, policy };
    });
}

// Resolve a `--state <code>` to a validated bundled policy. A code matches when
// it equals (after normalization) EITHER the fixture filename code OR the
// policy's `state` label. An unknown code is a clear PolicyError that lists the
// codes that ARE available, so the usage error is actionable.
function resolveState(code) {
  const want = normStateCode(code);
  if (want === "") {
    throw new PolicyError("--state requires a non-empty state code");
  }
  const all = bundledPolicies();
  for (const entry of all) {
    if (
      normStateCode(entry.code) === want ||
      normStateCode(entry.policy.state) === want
    ) {
      return entry.policy;
    }
  }
  const codes = all.map((e) => e.code).sort().join(", ");
  throw new PolicyError(
    `unknown --state "${code}"; bundled states are: ${codes}`
  );
}

module.exports = {
  SCHEMA_VERSION,
  PolicyError,
  readPolicy,
  validatePolicy,
  applyPolicy,
  // bundled per-state fixtures + --state resolution
  BUNDLED_DIR,
  bundledPolicies,
  resolveState,
  normStateCode,
  // exported for focused tests / reuse
  EXCEPTION_TYPES,
  SEVERITY_VALUES,
};
