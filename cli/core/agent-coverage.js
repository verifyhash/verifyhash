"use strict";

// cli/core/agent-coverage.js — the PURE fleet-coverage core (T-71.1, EPIC-71 "AgentTrace coverage").
//
// WHAT THIS IS
//   The deterministic answer to the governance buyer's FLEET question: "across this commit range,
//   WHICH changes carry a verifiable agent-session record — and fail my pipeline when one doesn't."
//   This core evaluates coverage from CALLER-SUPPLIED facts ONLY:
//
//     - `commits`: the ORDERED commit list (what the caller's `git rev-list` returned — the T-71.2
//       CLI supplies it OLDEST-FIRST via `git rev-list --reverse`, and the `requireSince` policy
//       below is defined over THAT list order);
//     - `claims`: one row per DISCLOSED commit claim (what T-69.1 `findCommitClaims` extracted
//       from each sealed packet), each row carrying the caller's own verification verdicts:
//       `packetVerified` (did the FULL shipped packet-verify path accept the packet the claim came
//       from?) and `rootVerified` (did the caller RE-DERIVE the commit's tracked-set root — the
//       shipped `hashGit`, in their own clone — and compare it to the claim's `gitRoot`?
//       `null` = not re-derived in this run, e.g. a non-`--deep` run);
//     - `policy`: a small CLOSED shape, `{ requireAll?: boolean, requireSince?: <oid> }`.
//
//   It never runs git, reads a file, opens a socket, or looks at a clock — deriving the facts from
//   real packets and a real clone is the T-71.2 CLI's job. Same facts in, byte-identical report out.
//
// THE CLOSED VERDICT VOCABULARY
//   Per CLAIM (each claim row is judged on its own facts):
//     covered-verified        — claim from a VERIFIED packet, root re-derived and MATCHED
//                               (packetVerified: true, rootVerified: true);
//     covered-oid-only        — claim from a VERIFIED packet, root NOT re-derived this run
//                               (packetVerified: true, rootVerified: null);
//     claim-root-mismatch     — claim from a VERIFIED packet whose re-derived root did NOT match
//                               (packetVerified: true, rootVerified: false): an active discrepancy;
//     claim-unverified-packet — the packet did not verify (packetVerified: false). Such a claim
//                               NEVER counts as coverage, whatever its rootVerified says — an
//                               unverifiable packet proves nothing.
//   Per COMMIT (the same vocabulary plus `uncovered`): a commit with no claim is `uncovered`;
//   otherwise its status is the STRONGEST claim outcome by the fixed precedence
//       covered-verified > covered-oid-only > claim-root-mismatch > claim-unverified-packet
//   (a commit is covered when ANY verifiable claim covers it). A conflicting claim never hides:
//   EVERY claim row is listed under its commit with its OWN status, so a root-mismatch beside a
//   covering claim stays visible in the report even though the commit counts as covered.
//   Only `covered-verified` and `covered-oid-only` count as COVERED for policy purposes.
//
// THE POLICY VERDICT
//   `requireAll: true`  — every commit in the list must be covered;
//   `requireSince: oid` — the named commit (which must be IN the list) and every commit AFTER it
//                         in the supplied order must be covered (with the T-71.2 oldest-first
//                         ordering that reads "since that commit, inclusive").
//   The report's `verdict` is `{ pass, failures }`: one failure entry `{ oid, rule, status }` per
//   violating commit, in commit-list order, `rule` naming the violated policy ("require-all" wins
//   when both policies are set, since it subsumes "require-since"). No policy → `pass: true`
//   vacuously (report-only mode). Claims whose oid is not in `commits` are IGNORED by design
//   (out-of-range for this report; the CLI may warn separately).
//
// THE REPORT ARTIFACT (b): byte-diffable and SEALABLE — no new seal code
//   `serializeCoverageReport(report)` emits ONE canonical byte representation: sorted-key JSON,
//   no whitespace, versioned `kind: "vh-agent-coverage@1"`. Same facts → byte-identical artifact,
//   so two runs diff cleanly, and the string is a perfectly ordinary evidence file: write it to
//   disk and seal it with the EXISTING `vh evidence seal` (and verify it with the existing
//   verifier) exactly like any other artifact — this module deliberately adds NO sealing,
//   signing, or hashing code of its own. `parseCoverageReport` is the STRICT inverse: it accepts
//   ONLY the canonical bytes of an INTERNALLY CONSISTENT report (it re-evaluates the embedded
//   facts and re-serializes; unknown kind/version, extra/missing/malformed fields, non-canonical
//   bytes, or forged statuses/totals/verdicts are each a NAMED reject) — so a report that parses
//   is one this core could itself have produced.
//
// TRUST BOUNDARY (honest — carried into docs by T-71.3)
//   Coverage is an INVENTORY control, not an authorship detector: a covered commit means an
//   unaltered sealed session CONTAINS a disclosed claim to that oid (containment, NOT causation);
//   an uncovered commit proves NOTHING about how it was authored. `packetVerified`/`rootVerified`
//   are the CALLER's verdicts — this core faithfully aggregates them, it cannot re-check them.
//
// PURITY (a hard acceptance criterion, statically guarded by the test)
//   No fs / git / child_process / http / https / net / dns, no process.env, no clock, no
//   randomness, no signing material, NO new crypto and NO new dependency — this module requires
//   NOTHING at all (node-core-free, dependency-free). Every exported function is TOTAL: hostile
//   input yields a named `{ ok: false, reason }` verdict, never an exception, and results are
//   fully deterministic.

// ---------------------------------------------------------------------------------------------------
// Canonical schema constants.
// ---------------------------------------------------------------------------------------------------

// The versioned kind tag bound INSIDE the report bytes. Any schema change bumps the version; an
// unknown kind/version is a NAMED reject (REPORT_BAD_KIND), never silently accepted.
const REPORT_KIND = "vh-agent-coverage@1";

// The CLOSED per-commit verdict vocabulary (sorted; also the exact key set of `totals`).
const COMMIT_STATUSES = Object.freeze([
  "claim-root-mismatch",
  "claim-unverified-packet",
  "covered-oid-only",
  "covered-verified",
  "uncovered",
]);

// The CLOSED per-claim vocabulary: a claim row is never "uncovered" (it exists).
const CLAIM_STATUSES = Object.freeze([
  "claim-root-mismatch",
  "claim-unverified-packet",
  "covered-oid-only",
  "covered-verified",
]);

// The two statuses that COUNT as coverage. `claim-unverified-packet` NEVER counts as covered;
// neither does `claim-root-mismatch` (an active discrepancy is not coverage).
const COVERED_STATUSES = Object.freeze(["covered-verified", "covered-oid-only"]);

// Per-commit precedence when a commit has several claims: LOWER rank wins ("the strongest claim
// outcome"). A verified match beats an untested root beats a mismatch beats an unverifiable packet.
const STATUS_PRECEDENCE = Object.freeze({
  "covered-verified": 0,
  "covered-oid-only": 1,
  "claim-root-mismatch": 2,
  "claim-unverified-packet": 3,
});

// The CLOSED policy-rule vocabulary used in verdict failure entries.
const POLICY_RULES = Object.freeze(["require-all", "require-since"]);

// Exhaustive field sets (sorted — object keys serialize in this order). Any other key is a
// NAMED unknown-field reject; any absent key a NAMED missing-field/bad-field reject.
const EVAL_FIELDS = Object.freeze(["claims", "commits", "policy"]);
const COMMIT_INPUT_FIELDS = Object.freeze(["oid"]);
const CLAIM_INPUT_FIELDS = Object.freeze([
  "gitRoot",
  "oid",
  "packetLabel",
  "packetVerified",
  "rootVerified",
]);
const POLICY_FIELDS = Object.freeze(["requireAll", "requireSince"]);
const REPORT_TOP_FIELDS = Object.freeze(["commits", "kind", "policy", "totals", "verdict"]);
const REPORT_COMMIT_FIELDS = Object.freeze(["claims", "oid", "status"]);
const REPORT_CLAIM_FIELDS = Object.freeze([
  "gitRoot",
  "packetLabel",
  "packetVerified",
  "rootVerified",
  "status",
]);
const REPORT_VERDICT_FIELDS = Object.freeze(["failures", "pass"]);
const REPORT_FAILURE_FIELDS = Object.freeze(["oid", "rule", "status"]);

// Size caps that keep every entry point TOTAL and O(cap) on hostile input. 100k commits/claims is
// far beyond any realistic pipeline range; the report cap bounds parse work BEFORE JSON.parse and
// is enforced on serialize OUTPUT too, so serialize-success implies parseable.
const MAX_COMMITS = 100000;
const MAX_CLAIMS = 100000;
const MAX_PACKET_LABEL_LENGTH = 4096;
const MAX_REPORT_LENGTH = 64 * 1024 * 1024; // 64 MiB

// Stable, named reason codes — the verdict contract callers (and the T-71.2 CLI) rely on.
const REASONS = Object.freeze({
  EVAL_BAD_INPUT: "EVAL_BAD_INPUT",
  COMMITS_NOT_ARRAY: "COMMITS_NOT_ARRAY",
  COMMITS_TOO_MANY: "COMMITS_TOO_MANY",
  COMMIT_NOT_OBJECT: "COMMIT_NOT_OBJECT",
  COMMIT_UNKNOWN_FIELD: "COMMIT_UNKNOWN_FIELD",
  COMMIT_BAD_OID: "COMMIT_BAD_OID",
  COMMITS_DUPLICATE_OID: "COMMITS_DUPLICATE_OID",
  CLAIMS_NOT_ARRAY: "CLAIMS_NOT_ARRAY",
  CLAIMS_TOO_MANY: "CLAIMS_TOO_MANY",
  CLAIM_NOT_OBJECT: "CLAIM_NOT_OBJECT",
  CLAIM_UNKNOWN_FIELD: "CLAIM_UNKNOWN_FIELD",
  CLAIM_BAD_OID: "CLAIM_BAD_OID",
  CLAIM_BAD_GIT_ROOT: "CLAIM_BAD_GIT_ROOT",
  CLAIM_BAD_PACKET_LABEL: "CLAIM_BAD_PACKET_LABEL",
  CLAIM_BAD_PACKET_VERIFIED: "CLAIM_BAD_PACKET_VERIFIED",
  CLAIM_BAD_ROOT_VERIFIED: "CLAIM_BAD_ROOT_VERIFIED",
  POLICY_NOT_OBJECT: "POLICY_NOT_OBJECT",
  POLICY_UNKNOWN_FIELD: "POLICY_UNKNOWN_FIELD",
  POLICY_BAD_REQUIRE_ALL: "POLICY_BAD_REQUIRE_ALL",
  POLICY_BAD_REQUIRE_SINCE: "POLICY_BAD_REQUIRE_SINCE",
  POLICY_SINCE_NOT_IN_RANGE: "POLICY_SINCE_NOT_IN_RANGE",
  REPORT_NOT_STRING: "REPORT_NOT_STRING",
  REPORT_TOO_LARGE: "REPORT_TOO_LARGE",
  REPORT_NOT_JSON: "REPORT_NOT_JSON",
  REPORT_NOT_OBJECT: "REPORT_NOT_OBJECT",
  REPORT_BAD_KIND: "REPORT_BAD_KIND",
  REPORT_UNKNOWN_FIELD: "REPORT_UNKNOWN_FIELD",
  REPORT_MISSING_FIELD: "REPORT_MISSING_FIELD",
  REPORT_BAD_FIELD: "REPORT_BAD_FIELD",
  REPORT_INCONSISTENT: "REPORT_INCONSISTENT",
  REPORT_NOT_CANONICAL: "REPORT_NOT_CANONICAL",
  HOSTILE_INPUT: "HOSTILE_INPUT",
});

// STRICT lowercase — `git rev-list` and `hashGit` both emit lowercase, and accepting a case
// variant would mint a second byte representation of the "same" fact (same discipline as the
// T-69.1 claim core).
const OID_RE = /^[0-9a-f]{40}$/;
const GIT_ROOT_RE = /^0x[0-9a-f]{64}$/;

// A lone/unpaired UTF-16 surrogate: a legal JS string with no UTF-8 encoding. Rejected in
// packetLabel so the serialized artifact is always clean UTF-8 for the existing seal path.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// A "plain" object: prototype is Object.prototype or null (same discipline as the sibling cores —
// what we serialize is exactly the JSON-shaped data the caller could write and read back).
function _isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function _isOid(v) {
  return typeof v === "string" && OID_RE.test(v);
}

// A valid packet label: the caller's non-empty, capped, control-character-free, UTF-8-encodable
// name for the packet the claim came from (typically the packet file's basename or relative path).
function _isValidPacketLabel(s) {
  if (typeof s !== "string") return false;
  if (s.length === 0 || s.length > MAX_PACKET_LABEL_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (LONE_SURROGATE_RE.test(s)) return false;
  return true;
}

// Validate the four claim FACT fields shared by evaluate-input claims and in-report claim entries.
function _validateClaimFacts(cl) {
  if (typeof cl.gitRoot !== "string" || !GIT_ROOT_RE.test(cl.gitRoot)) {
    return { ok: false, reason: REASONS.CLAIM_BAD_GIT_ROOT, field: "gitRoot" };
  }
  if (!_isValidPacketLabel(cl.packetLabel)) {
    return { ok: false, reason: REASONS.CLAIM_BAD_PACKET_LABEL, field: "packetLabel" };
  }
  if (typeof cl.packetVerified !== "boolean") {
    return { ok: false, reason: REASONS.CLAIM_BAD_PACKET_VERIFIED, field: "packetVerified" };
  }
  if (!(cl.rootVerified === null || typeof cl.rootVerified === "boolean")) {
    return { ok: false, reason: REASONS.CLAIM_BAD_ROOT_VERIFIED, field: "rootVerified" };
  }
  return { ok: true };
}

// The per-claim verdict from validated facts. An unverified packet dominates EVERYTHING —
// a claim from a packet that did not verify never counts as coverage, whatever it asserts.
function _claimStatus(cl) {
  if (cl.packetVerified !== true) return "claim-unverified-packet";
  if (cl.rootVerified === true) return "covered-verified";
  if (cl.rootVerified === null) return "covered-oid-only";
  return "claim-root-mismatch"; // rootVerified === false
}

// ---------------------------------------------------------------------------------------------------
// Canonical JSON — the ONE byte representation of a report. Only ever called on shape-validated
// data (null / booleans / safe integers / strings / arrays / plain objects), so it is total there:
// objects serialize with keys SORTED (UTF-16 code-unit order), arrays in order, no whitespace.
// ---------------------------------------------------------------------------------------------------

function _canon(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean" || t === "number" || t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) parts.push(_canon(item));
    return "[" + parts.join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) parts.push(JSON.stringify(k) + ":" + _canon(value[k]));
  return "{" + parts.join(",") + "}";
}

// ---------------------------------------------------------------------------------------------------
// (a) evaluateCoverage — the deterministic report from caller-supplied facts.
// ---------------------------------------------------------------------------------------------------

/**
 * Evaluate fleet coverage. TOTAL: every failure is a named `{ ok: false, reason, index?, field? }`;
 * never throws. DETERMINISTIC: the same facts yield a deep-equal report (and byte-identical
 * serialization) on every call, regardless of input-object key order.
 *
 * @param {{
 *   commits: { oid: string }[],            // ordered (oldest-first per the T-71.2 CLI); 40-hex lowercase, strict; no duplicates
 *   claims: { oid: string, gitRoot: string, packetLabel: string,
 *             packetVerified: boolean, rootVerified: boolean|null }[],
 *   policy?: { requireAll?: boolean, requireSince?: string }  // CLOSED shape; requireSince must name an oid IN `commits`
 * }} args
 * @returns {{ ok: true, report: object } | { ok: false, reason: string, index?: number, field?: string }}
 *   On ok, `report` is:
 *     { kind: "vh-agent-coverage@1",
 *       commits: [ { oid, status, claims: [ { gitRoot, packetLabel, packetVerified, rootVerified, status } ] } ],
 *       policy:  { requireAll: boolean, requireSince: string|null },       // normalized
 *       totals:  { <each of the five commit statuses>: count },            // always all five keys
 *       verdict: { pass: boolean, failures: [ { oid, rule, status } ] } }
 *   Commits keep input order; each commit's claims keep the claims-list order. Claims naming an
 *   oid outside `commits` are ignored. The report aliases NO caller-mutable state.
 */
function evaluateCoverage(args) {
  try {
    if (!_isPlainObject(args)) return { ok: false, reason: REASONS.EVAL_BAD_INPUT };
    for (const k of Object.keys(args)) {
      if (!EVAL_FIELDS.includes(k)) {
        return { ok: false, reason: REASONS.EVAL_BAD_INPUT, field: k };
      }
    }

    // --- commits: ordered, strict, duplicate-free ---
    const commits = args.commits;
    if (!Array.isArray(commits)) {
      return { ok: false, reason: REASONS.COMMITS_NOT_ARRAY, field: "commits" };
    }
    if (commits.length > MAX_COMMITS) {
      return { ok: false, reason: REASONS.COMMITS_TOO_MANY, field: "commits" };
    }
    const oidIndex = new Map(); // oid -> position in the ordered list
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      if (!_isPlainObject(c)) return { ok: false, reason: REASONS.COMMIT_NOT_OBJECT, index: i };
      for (const k of Object.keys(c)) {
        if (!COMMIT_INPUT_FIELDS.includes(k)) {
          return { ok: false, reason: REASONS.COMMIT_UNKNOWN_FIELD, index: i, field: k };
        }
      }
      if (!_isOid(c.oid)) {
        return { ok: false, reason: REASONS.COMMIT_BAD_OID, index: i, field: "oid" };
      }
      if (oidIndex.has(c.oid)) {
        // `git rev-list` never repeats an oid; a duplicate would make per-commit statuses and
        // requireSince ambiguous, so it is a named reject rather than a silent merge.
        return { ok: false, reason: REASONS.COMMITS_DUPLICATE_OID, index: i, field: "oid" };
      }
      oidIndex.set(c.oid, i);
    }

    // --- claims: strict per-field validation; grouped per in-range oid, order preserved ---
    const claims = args.claims;
    if (!Array.isArray(claims)) {
      return { ok: false, reason: REASONS.CLAIMS_NOT_ARRAY, field: "claims" };
    }
    if (claims.length > MAX_CLAIMS) {
      return { ok: false, reason: REASONS.CLAIMS_TOO_MANY, field: "claims" };
    }
    const byOid = new Map(); // oid -> claim entries in claims-list order
    for (let i = 0; i < claims.length; i++) {
      const cl = claims[i];
      if (!_isPlainObject(cl)) return { ok: false, reason: REASONS.CLAIM_NOT_OBJECT, index: i };
      for (const k of Object.keys(cl)) {
        if (!CLAIM_INPUT_FIELDS.includes(k)) {
          return { ok: false, reason: REASONS.CLAIM_UNKNOWN_FIELD, index: i, field: k };
        }
      }
      if (!_isOid(cl.oid)) {
        return { ok: false, reason: REASONS.CLAIM_BAD_OID, index: i, field: "oid" };
      }
      const f = _validateClaimFacts(cl);
      if (!f.ok) return { ok: false, reason: f.reason, index: i, field: f.field };
      if (!oidIndex.has(cl.oid)) continue; // out-of-range claim: ignored by design (see module doc)
      const entry = {
        gitRoot: cl.gitRoot,
        packetLabel: cl.packetLabel,
        packetVerified: cl.packetVerified,
        rootVerified: cl.rootVerified,
        status: _claimStatus(cl),
      };
      if (!byOid.has(cl.oid)) byOid.set(cl.oid, []);
      byOid.get(cl.oid).push(entry);
    }

    // --- policy: the CLOSED shape ---
    const p = args.policy === undefined ? {} : args.policy;
    if (!_isPlainObject(p)) return { ok: false, reason: REASONS.POLICY_NOT_OBJECT, field: "policy" };
    for (const k of Object.keys(p)) {
      if (!POLICY_FIELDS.includes(k)) {
        return { ok: false, reason: REASONS.POLICY_UNKNOWN_FIELD, field: k };
      }
    }
    if ("requireAll" in p && typeof p.requireAll !== "boolean") {
      return { ok: false, reason: REASONS.POLICY_BAD_REQUIRE_ALL, field: "requireAll" };
    }
    if ("requireSince" in p) {
      if (!_isOid(p.requireSince)) {
        return { ok: false, reason: REASONS.POLICY_BAD_REQUIRE_SINCE, field: "requireSince" };
      }
      if (!oidIndex.has(p.requireSince)) {
        // A since-oid outside the range cannot anchor the policy — an evaluation with it would
        // be meaningless, so this is a named INPUT reject, not a policy failure.
        return { ok: false, reason: REASONS.POLICY_SINCE_NOT_IN_RANGE, field: "requireSince" };
      }
    }
    const requireAll = p.requireAll === true;
    const requireSince = "requireSince" in p ? p.requireSince : null;

    // --- per-commit statuses + totals ---
    const totals = {};
    for (const s of COMMIT_STATUSES) totals[s] = 0;
    const commitEntries = [];
    for (let i = 0; i < commits.length; i++) {
      const oid = commits[i].oid;
      const claimEntries = byOid.get(oid) || [];
      let status = "uncovered";
      let best = Infinity;
      for (const ce of claimEntries) {
        const rank = STATUS_PRECEDENCE[ce.status];
        if (rank < best) {
          best = rank;
          status = ce.status;
        }
      }
      totals[status] += 1;
      commitEntries.push({ oid, status, claims: claimEntries });
    }

    // --- policy verdict ---
    const sinceIndex = requireSince === null ? -1 : oidIndex.get(requireSince);
    const failures = [];
    for (let i = 0; i < commitEntries.length; i++) {
      const e = commitEntries[i];
      if (COVERED_STATUSES.includes(e.status)) continue;
      if (requireAll) {
        failures.push({ oid: e.oid, rule: "require-all", status: e.status });
      } else if (sinceIndex >= 0 && i >= sinceIndex) {
        failures.push({ oid: e.oid, rule: "require-since", status: e.status });
      }
    }

    return {
      ok: true,
      report: {
        kind: REPORT_KIND,
        commits: commitEntries,
        policy: { requireAll, requireSince },
        totals,
        verdict: { pass: failures.length === 0, failures },
      },
    };
  } catch (_) {
    // Hostile exotica (throwing getters, etc.) must never escape as an exception.
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

// ---------------------------------------------------------------------------------------------------
// Report shape validation (shared by serialize and parse): every key set exact, every value typed,
// every enum drawn from its closed vocabulary. Value-level CONSISTENCY (statuses/totals/verdict
// actually following from the embedded facts) is then enforced by re-evaluation + byte comparison.
// ---------------------------------------------------------------------------------------------------

function _validateReportShape(report) {
  if (!_isPlainObject(report)) return { ok: false, reason: REASONS.REPORT_NOT_OBJECT };
  if (report.kind !== REPORT_KIND) {
    // Covers missing kind, unknown kind AND unknown version (the version lives in the kind string).
    return { ok: false, reason: REASONS.REPORT_BAD_KIND, field: "kind" };
  }
  for (const k of Object.keys(report)) {
    if (!REPORT_TOP_FIELDS.includes(k)) {
      return { ok: false, reason: REASONS.REPORT_UNKNOWN_FIELD, field: k };
    }
  }
  for (const k of REPORT_TOP_FIELDS) {
    if (!(k in report)) return { ok: false, reason: REASONS.REPORT_MISSING_FIELD, field: k };
  }

  // commits
  if (!Array.isArray(report.commits)) {
    return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: "commits" };
  }
  if (report.commits.length > MAX_COMMITS) {
    return { ok: false, reason: REASONS.COMMITS_TOO_MANY, field: "commits" };
  }
  let claimCount = 0;
  for (let i = 0; i < report.commits.length; i++) {
    const c = report.commits[i];
    const where = "commits[" + i + "]";
    if (!_isPlainObject(c)) return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: where };
    for (const k of Object.keys(c)) {
      if (!REPORT_COMMIT_FIELDS.includes(k)) {
        return { ok: false, reason: REASONS.REPORT_UNKNOWN_FIELD, field: where + "." + k };
      }
    }
    for (const k of REPORT_COMMIT_FIELDS) {
      if (!(k in c)) return { ok: false, reason: REASONS.REPORT_MISSING_FIELD, field: where + "." + k };
    }
    if (!_isOid(c.oid)) return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: where + ".oid" };
    if (!COMMIT_STATUSES.includes(c.status)) {
      return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: where + ".status" };
    }
    if (!Array.isArray(c.claims)) {
      return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: where + ".claims" };
    }
    claimCount += c.claims.length;
    if (claimCount > MAX_CLAIMS) {
      return { ok: false, reason: REASONS.CLAIMS_TOO_MANY, field: where + ".claims" };
    }
    for (let j = 0; j < c.claims.length; j++) {
      const cl = c.claims[j];
      const cwhere = where + ".claims[" + j + "]";
      if (!_isPlainObject(cl)) return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: cwhere };
      for (const k of Object.keys(cl)) {
        if (!REPORT_CLAIM_FIELDS.includes(k)) {
          return { ok: false, reason: REASONS.REPORT_UNKNOWN_FIELD, field: cwhere + "." + k };
        }
      }
      for (const k of REPORT_CLAIM_FIELDS) {
        if (!(k in cl)) {
          return { ok: false, reason: REASONS.REPORT_MISSING_FIELD, field: cwhere + "." + k };
        }
      }
      const f = _validateClaimFacts(cl);
      if (!f.ok) return { ok: false, reason: f.reason, field: cwhere + "." + f.field };
      if (!CLAIM_STATUSES.includes(cl.status)) {
        return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: cwhere + ".status" };
      }
    }
  }

  // policy (normalized form: both keys always present, requireSince oid-or-null)
  const p = report.policy;
  if (!_isPlainObject(p)) return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: "policy" };
  for (const k of Object.keys(p)) {
    if (!POLICY_FIELDS.includes(k)) {
      return { ok: false, reason: REASONS.REPORT_UNKNOWN_FIELD, field: "policy." + k };
    }
  }
  for (const k of POLICY_FIELDS) {
    if (!(k in p)) return { ok: false, reason: REASONS.REPORT_MISSING_FIELD, field: "policy." + k };
  }
  if (typeof p.requireAll !== "boolean") {
    return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: "policy.requireAll" };
  }
  if (!(p.requireSince === null || _isOid(p.requireSince))) {
    return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: "policy.requireSince" };
  }

  // totals (exactly the five closed statuses, each a non-negative safe integer)
  const t = report.totals;
  if (!_isPlainObject(t)) return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: "totals" };
  for (const k of Object.keys(t)) {
    if (!COMMIT_STATUSES.includes(k)) {
      return { ok: false, reason: REASONS.REPORT_UNKNOWN_FIELD, field: "totals." + k };
    }
  }
  for (const k of COMMIT_STATUSES) {
    if (!(k in t)) return { ok: false, reason: REASONS.REPORT_MISSING_FIELD, field: "totals." + k };
    if (!Number.isSafeInteger(t[k]) || t[k] < 0) {
      return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: "totals." + k };
    }
  }

  // verdict
  const v = report.verdict;
  if (!_isPlainObject(v)) return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: "verdict" };
  for (const k of Object.keys(v)) {
    if (!REPORT_VERDICT_FIELDS.includes(k)) {
      return { ok: false, reason: REASONS.REPORT_UNKNOWN_FIELD, field: "verdict." + k };
    }
  }
  for (const k of REPORT_VERDICT_FIELDS) {
    if (!(k in v)) return { ok: false, reason: REASONS.REPORT_MISSING_FIELD, field: "verdict." + k };
  }
  if (typeof v.pass !== "boolean") {
    return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: "verdict.pass" };
  }
  if (!Array.isArray(v.failures) || v.failures.length > MAX_COMMITS) {
    return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: "verdict.failures" };
  }
  for (let i = 0; i < v.failures.length; i++) {
    const f = v.failures[i];
    const where = "verdict.failures[" + i + "]";
    if (!_isPlainObject(f)) return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: where };
    for (const k of Object.keys(f)) {
      if (!REPORT_FAILURE_FIELDS.includes(k)) {
        return { ok: false, reason: REASONS.REPORT_UNKNOWN_FIELD, field: where + "." + k };
      }
    }
    for (const k of REPORT_FAILURE_FIELDS) {
      if (!(k in f)) return { ok: false, reason: REASONS.REPORT_MISSING_FIELD, field: where + "." + k };
    }
    if (!_isOid(f.oid)) return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: where + ".oid" };
    if (!POLICY_RULES.includes(f.rule)) {
      return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: where + ".rule" };
    }
    if (!COMMIT_STATUSES.includes(f.status)) {
      return { ok: false, reason: REASONS.REPORT_BAD_FIELD, field: where + ".status" };
    }
  }

  return { ok: true };
}

// Reconstruct evaluateCoverage inputs from a shape-valid report — the seam that lets serialize
// and parse enforce full internal consistency by simply RE-EVALUATING the embedded facts.
function _reconstructInputs(report) {
  const commits = [];
  const claims = [];
  for (const c of report.commits) {
    commits.push({ oid: c.oid });
    for (const cl of c.claims) {
      claims.push({
        oid: c.oid,
        gitRoot: cl.gitRoot,
        packetLabel: cl.packetLabel,
        packetVerified: cl.packetVerified,
        rootVerified: cl.rootVerified,
      });
    }
  }
  const policy = {};
  if (report.policy.requireAll === true) policy.requireAll = true;
  if (report.policy.requireSince !== null) policy.requireSince = report.policy.requireSince;
  return { commits, claims, policy };
}

// ---------------------------------------------------------------------------------------------------
// (b) serializeCoverageReport — the canonical bytes.
// ---------------------------------------------------------------------------------------------------

/**
 * Serialize a coverage report to its ONE canonical byte representation: sorted-key JSON, no
 * whitespace, versioned `kind: "vh-agent-coverage@1"`. The string is byte-diffable across runs
 * and is itself SEALABLE by the existing `vh evidence seal` (write it to a file and seal that
 * file — this module adds no seal code). STRICT: the report must be shape-valid AND internally
 * consistent (statuses, totals and verdict are re-derived from the embedded facts and must
 * match), so only reports this core could have produced serialize. TOTAL: every failure is a
 * named `{ ok: false, reason, field?, detail? }`; never throws.
 *
 * Round-trip invariants (tested):
 *   serializeCoverageReport(evaluateCoverage(x).report).ok === true
 *   parseCoverageReport(serializeCoverageReport(r).json).report  deep-equals  r
 *
 * @param {object} report an evaluateCoverage(...).report (or a deep-equal reconstruction).
 * @returns {{ ok: true, json: string } | { ok: false, reason: string, field?: string, detail?: string }}
 */
function serializeCoverageReport(report) {
  try {
    const shape = _validateReportShape(report);
    if (!shape.ok) return shape;
    const re = evaluateCoverage(_reconstructInputs(report));
    if (!re.ok) {
      // e.g. duplicate commit oids inside the report: shape-valid but not evaluable.
      return { ok: false, reason: REASONS.REPORT_INCONSISTENT, detail: re.reason };
    }
    const canonical = _canon(re.report);
    if (_canon(report) !== canonical) {
      // Some status/total/verdict/policy value does not follow from the embedded facts
      // (this is also what makes a forged "covered" claim from an unverified packet un-serializable).
      return { ok: false, reason: REASONS.REPORT_INCONSISTENT };
    }
    if (canonical.length > MAX_REPORT_LENGTH) {
      return { ok: false, reason: REASONS.REPORT_TOO_LARGE };
    }
    return { ok: true, json: canonical };
  } catch (_) {
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

// ---------------------------------------------------------------------------------------------------
// (c) parseCoverageReport — the strict inverse.
// ---------------------------------------------------------------------------------------------------

/**
 * Parse and STRICTLY validate a serialized coverage report. Accepts ONLY the canonical bytes of
 * an internally consistent report: unknown kind/version, extra/missing/malformed fields, forged
 * statuses/totals/verdicts, oversize input, non-JSON, and any NON-CANONICAL byte representation
 * (reordered keys, whitespace, uppercase hex, duplicate keys, escape-sequence variants) are each
 * a NAMED reject. NEVER throws.
 *
 * Round-trip invariants (tested):
 *   parseCoverageReport(serializeCoverageReport(r).json).report  deep-equals  r
 *   serializeCoverageReport(parseCoverageReport(s).report).json  ===  s
 *
 * @param {string} s the serialized report bytes.
 * @returns {{ ok: true, report: object } | { ok: false, reason: string, field?: string, detail?: string }}
 *   On ok, `report` is a FRESH object (no aliasing of anything the caller handed in).
 */
function parseCoverageReport(s) {
  try {
    if (typeof s !== "string") return { ok: false, reason: REASONS.REPORT_NOT_STRING };
    if (s.length > MAX_REPORT_LENGTH) return { ok: false, reason: REASONS.REPORT_TOO_LARGE };
    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch (_) {
      return { ok: false, reason: REASONS.REPORT_NOT_JSON };
    }
    // JSON.parse yields plain objects only ("__proto__" arrives as an ordinary own key and is
    // caught by the exhaustive-field checks); kind is checked here too so the named reject for
    // an unknown kind/version fires before any deeper shape work.
    if (!_isPlainObject(parsed)) return { ok: false, reason: REASONS.REPORT_NOT_OBJECT };
    if (parsed.kind !== REPORT_KIND) {
      return { ok: false, reason: REASONS.REPORT_BAD_KIND, field: "kind" };
    }
    const ser = serializeCoverageReport(parsed);
    if (!ser.ok) return ser;
    if (ser.json !== s) {
      // Same value, different bytes: the ONLY accepted representation is the one this core emits.
      return { ok: false, reason: REASONS.REPORT_NOT_CANONICAL };
    }
    return { ok: true, report: JSON.parse(ser.json) };
  } catch (_) {
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

module.exports = {
  // Schema + verdict contract.
  REPORT_KIND,
  COMMIT_STATUSES,
  CLAIM_STATUSES,
  COVERED_STATUSES,
  STATUS_PRECEDENCE,
  POLICY_RULES,
  MAX_COMMITS,
  MAX_CLAIMS,
  MAX_PACKET_LABEL_LENGTH,
  MAX_REPORT_LENGTH,
  REASONS,
  // The core operations.
  evaluateCoverage,
  serializeCoverageReport,
  parseCoverageReport,
};
