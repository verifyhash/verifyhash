"use strict";

// cli/core/trust-asof.js — the recipient-side TRUST-DECISION-AS-OF helper for verifyhash (EPIC-51 / T-51.2).
//
// WHY THIS EXISTS
//   T-51.1 gave a PRODUCER a way to SIGN "this key is revoked as of D" (cli/core/revocation.js). This module
//   is the RECIPIENT's other half: given the signer a signed artifact RECOVERS to, a set of producer
//   revocation statements, and a point in time the recipient cares about ("the moment this exhibit was
//   sealed", or "now"), it answers the only question that matters — "was that key trustworthy AS OF that
//   instant?". A key that was revoked BEFORE the as-of instant means the artifact was signed (or is being
//   relied upon) under a key its own holder had already declared dead: that downgrades the verdict to
//   REVOKED. A revocation dated AFTER the as-of leaves the verdict ACCEPTED but carries an INFORMATIONAL
//   "later-revoked" note (the key was fine then, but is revoked now — useful context, not a downgrade).
//
// THE LOAD-BEARING SAFETY INVARIANT — A REVOCATION CAN ONLY EVER REMOVE TRUST, NEVER ADD IT.
//   Every revocation statement is run through the EXISTING `verifyRevocation` core VERBATIM (no new crypto):
//   it must (1) recover to its own claimed signer AND (2) recover to its own embedded `vendorAddress` (the
//   self-control invariant — a key revokes ITSELF). A revocation that fails EITHER check — forged, tampered,
//   third-party, structurally malformed, or simply not parseable — is IGNORED with a WARNING and can NEVER
//   downgrade the verdict. So an attacker who plants a bogus "revocation" for a victim's key cannot grief a
//   recipient into rejecting a perfectly good artifact: a revocation only bites when it genuinely recovers to
//   the SAME key it claims to revoke, and only for the subject that key controls.
//
// SUBJECT-SCOPING — A REVOCATION ONLY BITES THE KEY IT NAMES.
//   The `subject` is the artifact's RECOVERED signer (the address `verify-signed`/`verify-attest`/`verify`
//   actually derived from the bytes, NOT the merely-claimed one). A revocation only affects the verdict when
//   its `vendorAddress` EQUALS that subject. A revocation for some OTHER key is simply not relevant — counted
//   as `irrelevant`, never as a downgrade. So a recipient can carry a whole pile of a vendor's revocations
//   and only the one(s) for the key that actually signed THIS artifact can change the verdict.
//
// PURE + I/O-FREE + KEY-FREE + CLOCK-FREE.
//   Every function here is pure: no filesystem (the file read is the CLI layer's job — this takes parsed JSON
//   text or already-parsed containers), no network, no key, no system clock (the `asOf` instant is a CALLER-
//   supplied argument; the CLI defaults it sanely, but the core never reads the wall clock, so the same
//   inputs always yield the same verdict). It REUSES `cli/core/revocation.js` (which reuses the shared
//   attestation core) VERBATIM — there is NO new signing/recovery path here.
//
// STRICTLY ADDITIVE / OPT-IN.
//   This helper runs ONLY when a caller passes `--revocations`. With NO revocations input the helper is never
//   invoked, so the four signed-verify commands produce byte-identical verdicts + exit codes to their
//   pre-EPIC baseline. That regression-safety is the whole point of keeping this OUT of the verify cores and
//   layering it at the edge.

const coreRevocation = require("./revocation");

// A strict ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS(.mmm)Z") — the SAME canonical instant grammar the
// revocation core pins `revokedAt` to, so the `asOf` the recipient supplies is compared on the same footing.
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

// A recovered-signer address: 0x + 40 LOWERCASE hex. The verify cores return the recovered signer in this
// form (or the "(unrecoverable)" sentinel, which can never match this and so is never a valid subject).
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

// A dedicated error type for the HARD input errors of THIS helper (a malformed asOf, a non-array revocations
// input, a bad subject). An individual BOGUS revocation is NEVER thrown — it is collected as an ignored
// warning so one bad entry can never abort the evaluation of the good ones.
class TrustAsOfError extends Error {
  constructor(message) {
    super(message);
    this.name = "TrustAsOfError";
  }
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parse + strictly validate a recipient-supplied `asOf` instant into epoch-millis. PURE. A malformed/
 * non-canonical instant is a HARD TrustAsOfError (named, no silent coercion) — the as-of is the pivot of the
 * whole decision, so it must be exactly one canonical instant. Mirrors the revocation core's revokedAt grammar.
 * @param {string} asOf an ISO-8601 UTC instant
 * @returns {number} epoch milliseconds
 */
function parseAsOf(asOf) {
  if (typeof asOf !== "string" || !ISO_INSTANT_RE.test(asOf)) {
    throw new TrustAsOfError(
      `--as-of must be an ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS(.mmm)Z"), got: ${String(asOf)}`
    );
  }
  const ms = Date.parse(asOf);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== asOf) {
    throw new TrustAsOfError(
      `--as-of must be a canonical ISO-8601 UTC instant (no rolled-over/impossible fields), got: ${String(asOf)}`
    );
  }
  return ms;
}

/**
 * Normalize the `revocations` input into a flat array of items to evaluate. PURE. Accepts:
 *   - an ARRAY of already-parsed signed-revocation container objects (or JSON strings), OR
 *   - a single signed-revocation container object, OR
 *   - a JSON STRING that parses to either of the above (a bundle file is a JSON ARRAY of containers, or a
 *     single container object).
 * Each element is normalized to a parsed object (a JSON string is parsed; a parse failure becomes a bogus
 * entry marked with `_parseError` so the caller IGNORES it with a warning, never throws). This keeps the
 * file-format flexible (one revocation, or a bundle) while the file READ stays the CLI layer's job.
 * @param {any} revocations
 * @returns {Array<object|{_parseError:string,_raw:any}>}
 */
function normalizeRevocationsInput(revocations) {
  // A JSON string: parse it, then recurse on the parsed value.
  if (typeof revocations === "string") {
    let parsed;
    try {
      parsed = JSON.parse(revocations);
    } catch (e) {
      // A whole-file parse failure is a HARD input error (the caller handed us bytes that aren't JSON at
      // all) — distinct from a single bad entry inside a valid array.
      throw new TrustAsOfError(`revocations input is not valid JSON: ${e.message}`);
    }
    return normalizeRevocationsInput(parsed);
  }
  if (Array.isArray(revocations)) {
    return revocations.map((el) => {
      if (typeof el === "string") {
        try {
          return JSON.parse(el);
        } catch (e) {
          return { _parseError: `entry is not valid JSON: ${e.message}`, _raw: el };
        }
      }
      return el;
    });
  }
  if (isPlainObject(revocations)) {
    return [revocations];
  }
  throw new TrustAsOfError(
    "revocations input must be a signed-revocation container, an array of them, or JSON text of either"
  );
}

/**
 * Evaluate one already-parsed revocation entry against the subject. PURE. Returns a small classification:
 *   { kind: "applies"|"later"|"irrelevant"|"ignored", ... }
 *   - "ignored":   the entry is forged/tampered/third-party/structurally-bogus — verifyRevocation REJECTED
 *                  it (or it threw on a malformed container, or it failed to parse). Carries a `warning`.
 *                  NEVER downgrades the verdict.
 *   - "irrelevant":a SOUND revocation, but for a DIFFERENT key than the subject. Counted, never a downgrade.
 *   - "later":     a SOUND, subject-matching revocation whose revokedAt is AFTER asOf — the key was still
 *                  good as of the instant; this is INFORMATIONAL context, not a downgrade.
 *   - "applies":   a SOUND, subject-matching revocation whose revokedAt is AT OR BEFORE asOf — the key was
 *                  ALREADY revoked as of the instant; this DOWNGRADES the verdict to REVOKED.
 * The revokedAt comparison is `revokedAtMs <= asOfMs` (a revocation effective exactly at the as-of instant
 * counts as revoked — the boundary is inclusive on the revoked side, matching "revoked AS OF D").
 */
function classifyRevocation(entry, subject, asOfMs) {
  // A failed-to-parse entry: ignore with a warning (never throw, never downgrade).
  if (entry && entry._parseError) {
    return { kind: "ignored", warning: `ignored an unparseable revocation entry (${entry._parseError})` };
  }
  // Run the SOUNDNESS check through the EXISTING revocation core VERBATIM. A structurally-malformed/foreign
  // container throws inside verifyRevocation (RevocationError) — we CATCH it and treat it as ignored, so a
  // single bad entry can never abort the whole evaluation or downgrade the verdict.
  let v;
  try {
    v = coreRevocation.verifyRevocation({ container: entry });
  } catch (e) {
    return { kind: "ignored", warning: `ignored a malformed/foreign revocation (${e.message})` };
  }
  // A SOUND container whose signature does NOT back its claims (forged/tampered/third-party) is a clean
  // REJECTED verdict — IGNORE it with a warning. This is the load-bearing anti-grief invariant: a revocation
  // only ever bites when it genuinely recovers to the key it claims to revoke.
  if (!v.accepted) {
    return {
      kind: "ignored",
      warning:
        `ignored a revocation that does not verify (failed: ${v.failedChecks.join(", ")}; ` +
        `vendorAddress ${v.vendorAddress}) — a forged/tampered/third-party revocation never downgrades trust`,
    };
  }
  // SOUND. Is it for THIS subject? A revocation for some other key is simply irrelevant to this artifact.
  if (v.vendorAddress !== subject) {
    return { kind: "irrelevant", vendorAddress: v.vendorAddress };
  }
  // SOUND + subject-matching. Compare its self-asserted revokedAt to the as-of pivot.
  const revokedAtMs = Date.parse(v.revokedAt); // validated canonical inside verifyRevocation
  const detail = {
    vendorAddress: v.vendorAddress,
    reason: v.reason,
    revokedAt: v.revokedAt,
    supersededBy: v.supersededBy, // null when absent (the revocation core normalizes this)
  };
  if (revokedAtMs <= asOfMs) {
    return { kind: "applies", ...detail };
  }
  return { kind: "later", ...detail };
}

/**
 * THE RECIPIENT-SIDE TRUST-DECISION-AS-OF. PURE / OFFLINE / KEY-FREE / I/O-FREE / CLOCK-FREE.
 *
 * Given the artifact's RECOVERED signer (`subject`), a set of producer revocation statements (`revocations`),
 * and the instant the recipient cares about (`asOf`), decide whether the subject key was trustworthy AS OF
 * that instant. It NEVER signs, reads a file, or touches the clock — it only re-runs the existing
 * `verifyRevocation` core over already-in-hand bytes and compares dates.
 *
 * VERDICT (the `status` field):
 *   - "REVOKED":      at least one SOUND, subject-matching revocation has `revokedAt <= asOf` — the key was
 *                     ALREADY revoked as of the instant. This is the ONLY downgrading outcome. The verdict
 *                     names the GOVERNING revocation (the EARLIEST applicable one) — its reason + revokedAt
 *                     (+ supersededBy when set).
 *   - "OK":           no SOUND, subject-matching revocation is effective at-or-before the as-of instant. If a
 *                     SOUND, subject-matching revocation exists but is dated AFTER the as-of, `laterRevoked`
 *                     is populated (an INFORMATIONAL "this key is revoked NOW, but was fine then" note) — the
 *                     status STAYS "OK".
 *   - "UNEVALUABLE":  the subject is the "(unrecoverable)" sentinel (or otherwise not a real address) — there
 *                     is no key to evaluate revocations against. This is NEVER a downgrade by itself (the
 *                     artifact's own verify verdict already handles an unrecoverable signature); it just
 *                     reports that revocation evaluation could not bind to a subject.
 *
 * `revoked` is a convenience boolean (status === "REVOKED"). `ignored` carries the warnings for every entry
 * that did not verify (forged/tampered/third-party/malformed/unparseable) — surfaced so a recipient SEES that
 * a planted revocation was discarded, rather than it silently vanishing.
 *
 * @param {object} params
 * @param {string} params.subject     the artifact's RECOVERED signer (lowercase 0x-address, or the
 *                                     "(unrecoverable)" sentinel)
 * @param {string} params.asOf        the recipient's decision instant (ISO-8601 UTC)
 * @param {any}    params.revocations a signed-revocation container, an array of them, or JSON text of either
 * @returns {{
 *   status: "OK"|"REVOKED"|"UNEVALUABLE",
 *   revoked: boolean,
 *   subject: string,
 *   asOf: string,
 *   governing: null | { vendorAddress, reason, revokedAt, supersededBy },
 *   laterRevoked: null | { vendorAddress, reason, revokedAt, supersededBy },
 *   counts: { total, applicable, later, irrelevant, ignored },
 *   ignored: string[],
 * }}
 */
function evaluateTrustAsOf(params) {
  if (!isPlainObject(params)) {
    throw new TrustAsOfError("evaluateTrustAsOf requires { subject, asOf, revocations }");
  }
  const { subject, asOf, revocations } = params;

  if (typeof subject !== "string" || subject.length === 0) {
    throw new TrustAsOfError("evaluateTrustAsOf requires a string `subject` (the artifact's recovered signer)");
  }
  const asOfMs = parseAsOf(asOf); // HARD-errors on a malformed asOf

  const entries = normalizeRevocationsInput(revocations); // HARD-errors on a non-JSON / wrong-type input

  // A non-address subject (the "(unrecoverable)" sentinel, or any non-0x value) cannot be matched by any
  // revocation's vendorAddress. We still evaluate every entry (so forged ones are still reported as ignored),
  // but no SOUND revocation can ever apply, so the status is UNEVALUABLE — a clear "no key to bind to", never
  // a silent OK that hides the fact that revocation evaluation could not run.
  const subjectIsAddress = ADDRESS_RE.test(subject);

  const applicable = []; // SOUND, subject-matching, revokedAt <= asOf
  const later = []; // SOUND, subject-matching, revokedAt > asOf
  let irrelevant = 0; // SOUND, different key
  const ignored = []; // warnings for every entry that did not verify

  for (const entry of entries) {
    const c = classifyRevocation(entry, subject, asOfMs);
    if (c.kind === "ignored") {
      ignored.push(c.warning);
    } else if (c.kind === "irrelevant") {
      irrelevant += 1;
    } else if (c.kind === "later") {
      later.push(c);
    } else if (c.kind === "applies") {
      applicable.push(c);
    }
  }

  // The GOVERNING revocation is the EARLIEST applicable one (smallest revokedAt) — the instant from which the
  // key was no longer trustworthy. Tie-break deterministically on vendorAddress then reason so the chosen
  // record is stable. (For a single subject every applicable revocation shares the vendorAddress, but a
  // recipient may carry several revocations for the same key with different dates/reasons; the earliest one
  // is the one that actually downgraded trust as of the instant.)
  const sortByEffective = (a, b) =>
    Date.parse(a.revokedAt) - Date.parse(b.revokedAt) ||
    (a.vendorAddress < b.vendorAddress ? -1 : a.vendorAddress > b.vendorAddress ? 1 : 0) ||
    (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0);

  const govern = (arr) => {
    if (arr.length === 0) return null;
    const [g] = arr.slice().sort(sortByEffective);
    return {
      vendorAddress: g.vendorAddress,
      reason: g.reason,
      revokedAt: g.revokedAt,
      supersededBy: g.supersededBy,
    };
  };

  const governing = govern(applicable);
  // The earliest LATER revocation (the soonest the key WILL be / IS now considered revoked) — informational.
  const laterRevoked = governing ? null : govern(later);

  let status;
  if (governing) {
    status = "REVOKED";
  } else if (!subjectIsAddress) {
    status = "UNEVALUABLE";
  } else {
    status = "OK";
  }

  return {
    status,
    revoked: status === "REVOKED",
    subject,
    asOf,
    governing,
    laterRevoked,
    counts: {
      total: entries.length,
      applicable: applicable.length,
      later: later.length,
      irrelevant,
      ignored: ignored.length,
    },
    ignored,
  };
}

/**
 * Resolve the effective `--as-of` instant. PURE. When the recipient supplied one, use it (validated); when
 * they did not, default sanely to the recipient's CURRENT decision time (`nowISO`, injected so tests are
 * deterministic). The default answers the most common question — "is this key trustworthy RIGHT NOW?" — while
 * the explicit `--as-of` answers the stronger "was it trustworthy when this exhibit was sealed?". A
 * malformed explicit `--as-of` is a HARD TrustAsOfError (never silently coerced to now).
 * @param {string|undefined|null} asOf the caller's --as-of value, if any
 * @param {string} nowISO the recipient's current instant (ISO-8601 UTC) — injected; defaults to the wall clock
 * @returns {{ asOf: string, defaulted: boolean }}
 */
function resolveAsOf(asOf, nowISO) {
  if (asOf !== undefined && asOf !== null && asOf !== "") {
    parseAsOf(asOf); // validate shape; throws on malformed
    return { asOf, defaulted: false };
  }
  if (typeof nowISO !== "string") {
    throw new TrustAsOfError("resolveAsOf requires a nowISO instant when --as-of is not given");
  }
  parseAsOf(nowISO); // the injected/default now must itself be canonical
  return { asOf: nowISO, defaulted: true };
}

/**
 * Fold a TRUST-DECISION-AS-OF onto an existing signed-verify result, OFFLINE. PURE. This is the single shared
 * integration the FOUR verify commands call so the downgrade rule (a key revoked-before-as-of REVOKES the
 * artifact) and the informational later-revoked note are computed ONE way. It NEVER upgrades a verdict: if
 * the artifact's own verify already REJECTED, it stays rejected; the trust-as-of only ever ADDS a REVOKED
 * downgrade on top of an otherwise-ACCEPTED artifact.
 *
 * The `subject` is the artifact's RECOVERED signer. When the artifact's signature did not even recover (the
 * "(unrecoverable)" sentinel), no revocation can bind — the decision is UNEVALUABLE and never changes the
 * (already-REJECTED) verdict.
 *
 * @param {object} params
 * @param {object} params.result       the verify result (must carry `recoveredSigner` + `accepted`)
 * @param {any}    params.revocations  a signed-revocation container / array / JSON text (already in hand)
 * @param {string} params.asOf         the resolved decision instant (ISO-8601 UTC)
 * @returns {object} a NEW result object: the original fields PLUS `trustAsOf` (the evaluateTrustAsOf block),
 *   with `accepted`/`verdict`/`failedChecks` updated when the decision is REVOKED. The original is not mutated.
 */
function applyToVerifyResult(params) {
  if (!isPlainObject(params) || !isPlainObject(params.result)) {
    throw new TrustAsOfError("applyToVerifyResult requires { result, revocations, asOf }");
  }
  const { result, revocations, asOf } = params;
  const subject = result.recoveredSigner;
  if (typeof subject !== "string") {
    throw new TrustAsOfError("applyToVerifyResult: result.recoveredSigner must be a string");
  }

  const decision = evaluateTrustAsOf({ subject, asOf, revocations });

  // Build a NEW result (never mutate the caller's). The trustAsOf block is ALWAYS attached when revocations
  // were supplied (so a recipient sees the evaluation even when it changed nothing).
  const out = { ...result, trustAsOf: decision };

  if (decision.revoked) {
    // The ONLY downgrading path: an otherwise-ACCEPTED artifact whose signer was revoked-before-as-of becomes
    // REVOKED. We do NOT touch an already-REJECTED verdict's accepted=false; we DO flip an accepted one. The
    // headline verdict becomes "REVOKED" (distinct from the signature-failure "REJECTED") and a named pseudo-
    // check records WHY in failedChecks, so the existing `accepted ? 0 : 3` exit mapping yields exit 3.
    out.accepted = false;
    out.verdict = "REVOKED";
    out.failedChecks = Array.isArray(result.failedChecks) ? result.failedChecks.slice() : [];
    if (!out.failedChecks.includes("keyRevokedAsOf")) out.failedChecks.push("keyRevokedAsOf");
  }
  return out;
}

/**
 * Render the human-readable TRUST-DECISION-AS-OF lines a verify command appends to its report. PURE. Returns
 * an array of lines (no trailing blank) the caller joins/prints. Mirrors the family's per-check PASS/FAIL
 * idiom. Surfaces: the as-of instant, the verdict (REVOKED / OK / could-not-evaluate), the GOVERNING
 * revocation's reason + revokedAt (+ supersededBy), the informational later-revoked note, and a line PER
 * ignored (forged/tampered/malformed) revocation so a planted one is visibly discarded, never silent.
 * @param {object} decision the object evaluateTrustAsOf returns
 * @param {{ defaulted?: boolean, indent?: string }} [ctx]
 * @returns {string[]} lines
 */
function renderTrustAsOf(decision, ctx = {}) {
  const I = ctx.indent || "";
  const L = [];
  const asOfNote = ctx.defaulted ? " (defaulted to now; pass --as-of <ISO> to pin the decision instant)" : "";
  L.push(`${I}revocation check (as of ${decision.asOf})${asOfNote}:`);
  if (decision.status === "REVOKED") {
    const g = decision.governing;
    L.push(
      `${I}  [REVOKED] the signing key (${g.vendorAddress}) was REVOKED as of ${g.revokedAt} ` +
        `(reason: ${g.reason})${g.supersededBy ? `, superseded by ${g.supersededBy}` : ""} — at or before ` +
        `the as-of instant. This artifact is NOT trustworthy as of ${decision.asOf}.`
    );
  } else if (decision.status === "UNEVALUABLE") {
    L.push(
      `${I}  [skip] the signature did not recover to a key — no subject to evaluate revocations against.`
    );
  } else {
    L.push(`${I}  [OK] no applicable revocation: the signing key was not revoked as of ${decision.asOf}.`);
    if (decision.laterRevoked) {
      const lr = decision.laterRevoked;
      L.push(
        `${I}  [note] this key (${lr.vendorAddress}) IS revoked as of ${lr.revokedAt} ` +
          `(reason: ${lr.reason})${lr.supersededBy ? `, superseded by ${lr.supersededBy}` : ""} — AFTER your ` +
          `as-of instant, so it does NOT downgrade THIS decision (informational).`
      );
    }
  }
  for (const w of decision.ignored) {
    L.push(`${I}  [warning] ${w}`);
  }
  return L;
}

/**
 * The ONE shared CLI integration the four signed-verify commands call. It is the single place the
 * --revocations file is read, the --as-of is resolved (defaulting to `nowISO`), the decision is computed, and
 * folded onto the verify result. Keeping the file READ here (behind an injectable `readFile`) — rather than
 * in each command — means the four commands stay byte-identical in behavior.
 *
 * It runs ONLY when `revocationsPath` is truthy; with no path it returns the result UNCHANGED and a null
 * decision (the regression-safety contract: with no --revocations the verify commands are pre-EPIC identical).
 *
 * @param {object} params
 * @param {object} params.result          the verify result (carries recoveredSigner + accepted)
 * @param {string|undefined} params.revocationsPath the --revocations file path (or falsy to skip entirely)
 * @param {string|undefined} params.asOf  the --as-of instant (or falsy to default to nowISO)
 * @param {string} params.nowISO          the recipient's current instant (injectable; default wall clock)
 * @param {(p:string)=>string} params.readFile reads the revocations file to text (injectable for tests)
 * @returns {{ result: object, decision: object|null, defaulted: boolean }}
 * @throws {TrustAsOfError} on a malformed --as-of or a non-JSON revocations file
 * @throws the underlying read error when the revocations file cannot be read
 */
function loadAndApply(params) {
  if (!isPlainObject(params) || !isPlainObject(params.result)) {
    throw new TrustAsOfError("loadAndApply requires { result, revocationsPath, asOf, nowISO, readFile }");
  }
  const { result, revocationsPath, asOf, nowISO, readFile } = params;
  if (!revocationsPath) {
    return { result, decision: null, defaulted: false };
  }
  const { asOf: effectiveAsOf, defaulted } = resolveAsOf(asOf, nowISO);
  const text = readFile(revocationsPath); // the ONLY I/O; the caller injects fs.readFileSync
  const out = applyToVerifyResult({ result, revocations: text, asOf: effectiveAsOf });
  return { result: out, decision: out.trustAsOf, defaulted };
}

module.exports = {
  TrustAsOfError,
  ISO_INSTANT_RE,
  parseAsOf,
  resolveAsOf,
  normalizeRevocationsInput,
  classifyRevocation,
  evaluateTrustAsOf,
  applyToVerifyResult,
  renderTrustAsOf,
  loadAndApply,
};
