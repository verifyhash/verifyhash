"use strict";

// TrustLedger — door-core.js
//
// T-65.2: the PURE payload→result core of the web door, factored out of server.js
// so that BOTH surfaces call the SAME functions and can never drift:
//   * trustledger/server.js (the HTTP door) routes /api/reconcile and /api/inspect
//     straight into reconcilePayload / inspectPayload below, exactly as before —
//     behavior, error names, statuses, and bytes UNCHANGED by the factoring;
//   * trustledger/build-standalone.js inlines THIS FILE VERBATIM into the offline
//     single-file app (trustledger/dist/trustledger-standalone.html), where the
//     page's transport seams call the same two functions directly in-page.
//
// EVERYTHING here is PURE and I/O-free: no fs, no http, no clock (the caller
// injects `reportDate`), no writes. The ONLY module dependencies are the engine
// modules (ingest / report / policy / close) and the license verifier — all
// required at top level with plain relative specifiers so the standalone bundler
// can rewrite them against its own module registry (the license module is swapped
// there for a FAIL-CLOSED offline shim; the gate below is inlined verbatim and is
// therefore REUSED, never re-implemented and never weakened).
//
// The prose below is moved verbatim from server.js (T-27.1 / T-28.1 / T-28.2 /
// T-29.3) — the contracts are unchanged; only the file they live in moved.

const ingest = require("./ingest");
const report = require("./report");
const policy = require("./policy");
const close = require("./close");
const license = require("./license");

// ---------------------------------------------------------------------------
// A named, HTTP-status-bearing error for the request layer. Carries a stable
// machine `error` code (snake_case) plus the human `message`, so the JSON body
// is { error, message } — a named error, never a stack trace.
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

// Map an engine error to a stable snake_case machine code. The engine's own
// named errors (IngestError / ReportError / PolicyError / CloseError) carry the
// precise, already-located human message; we only need a coarse machine label.
function engineErrorCode(err) {
  switch (err && err.name) {
    case "IngestError":
      return "ingest_error";
    case "ReportError":
      return "report_error";
    case "PolicyError":
      return "policy_error";
    case "CloseError":
      return "close_error";
    default:
      return "reconcile_error";
  }
}

// ---------------------------------------------------------------------------
// T-29.3: the WEB door's LICENSE GATE — the SAME gate the CLI `gateReconcile`
// applies, threaded through HTTP. A request that asks for a PAID surface
// (`state`/`policy` => multi-state policy packs, or `seal` => the reconciliation
// seal) WITHOUT a valid, vendor-pinned license is REFUSED with a NAMED 4xx; the
// FREE inspect + baseline reconcile routes stay open and behave byte-for-byte as
// before. The server holds NO key and verifies OFFLINE: `verifyLicense` needs only
// the pinned vendor ADDRESS + the supplied container (no network, no signing key).
//
// The flag->entitlement mapping is the SAME contract the CLI uses (so the two gates
// can never drift): `state`/`policy` need `multi_state_policy`; `seal` needs `seal`.
// A refusal carries the PRECISE reason verifyLicense returns (wrong_issuer /
// expired / not_yet_valid / bad_signature / malformed), so a wrong/expired license
// NEVER silently downgrades to a free run — it is reported, not ignored.
// ---------------------------------------------------------------------------

// Which entitlement each paid WEB surface requires. Mirrors the CLI's
// PAID_FEATURE_ENTITLEMENTS exactly (state/policy => multi_state_policy; seal =>
// seal), keyed off the request payload's own field names.
const WEB_PAID_FEATURE_ENTITLEMENTS = Object.freeze([
  {
    requested: (p) =>
      (p.state != null && String(p.state).trim() !== "") ||
      (p.policy != null && String(p.policy).trim() !== ""),
    entitlement: "multi_state_policy",
    label: "multi-state policy packs (state)",
  },
  {
    requested: (p) => p.seal === true,
    entitlement: "seal",
    label: "the tamper-evident reconciliation seal (seal)",
  },
]);

// Apply the license gate to an already-parsed request payload. Returns silently
// when the request is permitted (free tier, or a valid license covering every
// requested paid feature). Throws a NAMED HttpError otherwise:
//   * license_required (402) — a paid surface was requested with NO license at all
//   * license_invalid  (403) — a license WAS supplied but is invalid for this run
//       (malformed / bad_signature / wrong_issuer / expired / not_yet_valid, a
//        valid license that does not carry the required entitlement, OR a
//        vendorAddress assertion that does not EQUAL the canonical identity)
// `now` is the injected report date so the verdict is deterministic. The license
// container comes from the request body; the server holds no key.
//
// THE PIN (T-75.3): verification pins to the CANONICAL vendor identity (`canonicalVendor`, resolved
// server-side OUTSIDE the request body — io.canonicalVendor / VH_CANONICAL_VENDOR / committed default),
// NEVER against `payload.vendorAddress`. This is the textbook "free-ride a HOSTED vendor" surface: a gate
// that pinned to the request body's own vendorAddress would let anyone POST a self-minted license (signed
// by their own key, naming their own address) and unlock the paid web surface for free. `vendorAddress`
// is now OPTIONAL and accepted only as an assertion that must EQUAL the canonical identity (a mismatch is
// a NAMED license_invalid, never a silent re-pin).
function gatePayload(payload, now, canonicalVendor) {
  const needed = WEB_PAID_FEATURE_ENTITLEMENTS.filter((f) => f.requested(payload));
  if (needed.length === 0) {
    // FREE TIER: no paid surface requested — proceed unchanged. A stray
    // license/vendorAddress with no paid feature costs nothing and is ignored.
    return;
  }

  const featureList = needed.map((f) => f.label).join(" and ");

  // A paid surface REQUIRES a license. vendorAddress is OPTIONAL now: the gate pins to the CANONICAL
  // identity (below), not to a caller-chosen address, so a bare vendorAddress is nothing to verify.
  if (payload.license == null) {
    throw new HttpError(
      402,
      "license_required",
      `${featureList} ${needed.length > 1 ? "are" : "is"} a paid feature and requires a license; ` +
        "supply { license } in the request body. Licenses are verified OFFLINE against the CANONICAL " +
        "vendor identity — only a license minted by that vendor key unlocks the paid surface. " +
        "The free tier — baseline-policy reconcile + file inspect — needs no license."
    );
  }

  // Parse + validate the supplied container (a JSON string OR an already-parsed object) FIRST. A
  // malformed container is a license_invalid 403 — never half-trusted. NOTE: readLicense precedes pin
  // resolution BY DESIGN — in the OFFLINE standalone bundle the license module is a fail-closed shim
  // whose readLicense throws here (the named license_invalid pointing at the installed product), so the
  // gate never reaches the pin resolution offline and stays fail-closed + REUSED (never weakened).
  let container;
  try {
    container = license.readLicense(payload.license);
  } catch (e) {
    throw new HttpError(
      403,
      "license_invalid",
      `the supplied license is not a valid signed license container: ${e.message}`
    );
  }

  // Resolve the ONE pin the gate verifies against — the CANONICAL vendor identity, NEVER the request
  // body. An optional payload.vendorAddress is accepted only as an assertion that must EQUAL the
  // canonical identity; a mismatch (the free-ride re-pin) or a garbage address is a NAMED license_invalid
  // refusal from the core, never a silent re-pin.
  let pin;
  try {
    pin = license.resolveVendorPin(payload.vendorAddress, canonicalVendor);
  } catch (e) {
    throw new HttpError(403, "license_invalid", e.message);
  }

  // Verify OFFLINE against the CANONICAL pin, dated at the run's reportDate. verifyLicense throws only
  // for a garbage `now` (server-injected, always valid) — a request bug if it ever fires.
  let verdict;
  try {
    verdict = license.verifyLicense(container, { now, vendorAddress: pin });
  } catch (e) {
    throw new HttpError(400, "bad_request", e.message);
  }

  if (!verdict.valid) {
    // Report the PRECISE reason — never silently downgrade to a free run. A wrong_issuer here is the
    // self-mint / free-ride case: a license signed by a NON-canonical key never unlocks the paid surface.
    const selfMintNote =
      verdict.reason === "wrong_issuer"
        ? " Paid entitlements unlock ONLY with a license minted by the canonical vendor key; a " +
          "self-minted license signed by any other key is refused."
        : "";
    throw new HttpError(
      403,
      "license_invalid",
      `${featureList} requires a valid license, but the supplied license is invalid ` +
        `(reason: ${verdict.reason}); the free baseline reconcile remains available without state/policy/seal.${selfMintNote}`
    );
  }

  // Valid + in-window + correct issuer. Require EACH requested feature's
  // entitlement to actually be granted — a license never grants what it was not sold.
  for (const f of needed) {
    if (!license.hasEntitlement(verdict, f.entitlement)) {
      throw new HttpError(
        403,
        "license_invalid",
        `the supplied license is valid but does not include the "${f.entitlement}" entitlement ` +
          `needed for ${f.label}; this license grants only [${verdict.entitlements.join(", ")}]. ` +
          "The free baseline reconcile remains available."
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The pure core: take the already-parsed request payload (strings + optional
// state/priorClose) and produce the response shape. NO I/O. Throws HttpError on
// any bad input (a malformed file, an unknown state, a bad prior-close) so the
// caller maps it straight to an HTTP status + named JSON body. `reportDate` is
// injected (the caller supplies today) so this function stays deterministic.
// ---------------------------------------------------------------------------

// Read the OPTIONAL per-file `maps` object (T-28.2). Returns a frozen
// { bank, ledger, rentroll } where each entry is either a plain object (the
// `columnMap` to thread into that file's strict parser) or `undefined` (so the
// parser is called with `columnMap: undefined` — the byte-identical no-map path).
// STRICT on shape: `maps` (when present) must be a plain object, and each named
// per-file entry (when present) must be a plain object — anything else is a named
// 400, never a coercion. Unknown keys inside `maps` are ignored (only the three
// file keys are honoured), and the deep validity of each map (unknown logical
// field, or a header absent from the file) is left to the strict parser, which
// raises the SAME located IngestError it always would.
function readOptionalMaps(raw) {
  const empty = Object.freeze({ bank: undefined, ledger: undefined, rentroll: undefined });
  if (raw == null) return empty;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(
      400,
      "invalid_maps",
      '"maps" must be an object of { bank?, ledger?, rentroll? } column maps'
    );
  }
  const out = {};
  for (const key of ["bank", "ledger", "rentroll"]) {
    const m = raw[key];
    if (m == null) {
      out[key] = undefined;
      continue;
    }
    if (typeof m !== "object" || Array.isArray(m)) {
      throw new HttpError(
        400,
        "invalid_maps",
        `"maps.${key}" must be an object of { <logicalField>: <headerName> }`
      );
    }
    out[key] = m;
  }
  return Object.freeze(out);
}

function reconcilePayload(payload, reportDate, canonicalVendor) {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "bad_request", "request body must be a JSON object");
  }

  // The three file CONTENTS are REQUIRED and must be strings. A missing or
  // non-string field is a named 400 — never a coercion of, say, a number to "".
  for (const key of ["bank", "ledger", "rentroll"]) {
    if (typeof payload[key] !== "string") {
      throw new HttpError(
        400,
        "missing_file",
        `"${key}" is required and must be the file contents as a text string`
      );
    }
  }

  // LICENSE GATE (T-29.3). Apply the SAME paid-surface gate the CLI uses BEFORE any
  // paid feature is resolved, so a gated request (state/policy/seal) without a valid
  // license is refused with a NAMED license_required/license_invalid — never folded
  // into a downstream policy_error and never silently downgraded to a free run. The pin is the CANONICAL
  // vendor identity resolved OUTSIDE the request body (canonicalVendor), never payload.vendorAddress.
  gatePayload(payload, reportDate, canonicalVendor);

  // Optional per-state policy. An unknown code is a named 400 (PolicyError's
  // message names the available codes), not a silent fall-through to baseline.
  let activePolicy = null;
  if (payload.state != null && String(payload.state).trim() !== "") {
    try {
      activePolicy = policy.resolveState(String(payload.state));
    } catch (e) {
      throw new HttpError(400, "policy_error", e.message);
    }
  }

  // Optional roll-forward from a prior period's close artifact (its JSON TEXT).
  // Seeds this run's opening balances; a malformed close is a named 400.
  let priorClose = null;
  let opening = { bank: 0, book: 0 };
  if (payload.priorClose != null && String(payload.priorClose).trim() !== "") {
    try {
      priorClose = close.readClose(String(payload.priorClose));
    } catch (e) {
      throw new HttpError(400, "close_error", e.message);
    }
    opening = { bank: priorClose.ending.bank, book: priorClose.ending.book };
  }

  // Optional per-file column maps (T-28.2). A mapping the broker fixed in the
  // inspect flow is threaded back here so the REAL run honours it — the same
  // `{ <logicalField>: <headerName> }` shape the strict parsers' `columnMap`
  // already accepts, keyed by the SAME three file keys. When `maps` is absent (or
  // a per-file map is absent) behaviour is BYTE-FOR-BYTE the no-map path: each
  // parser is called with `columnMap: undefined`, exactly as before. A bad shape
  // (not a plain object, or a per-file entry that is not a plain object) is a
  // named 400 — never a silent coercion.
  const maps = readOptionalMaps(payload.maps);

  // Ingest the three files (STRICT — the first malformed row raises a located
  // IngestError, which we surface as a named 400 rather than dropping the row).
  let bank;
  let book;
  let rentroll;
  try {
    bank = ingest.parseBankStatement(payload.bank, { columnMap: maps.bank });
    book = ingest.parseQuickBooksCSV(payload.ledger, { columnMap: maps.ledger });
    rentroll = ingest.parseRentRollCSV(payload.rentroll, { columnMap: maps.rentroll });
  } catch (e) {
    throw new HttpError(400, engineErrorCode(e), e.message);
  }

  // Build the deterministic packet model (match + reconcile + report inside),
  // then render the SAME HTML + CSV artifacts the CLI emits — but keep them in
  // memory and return them in the JSON response. Nothing is written to disk.
  let model;
  let reportHtml;
  let reportCsv;
  try {
    model = report.buildPacket({
      bank,
      book,
      rentroll,
      reportDate,
      opening,
      policy: activePolicy,
      priorClose,
    });
    reportHtml = report.renderHTML(model);
    reportCsv = report.renderExceptionsCSV(model);
  } catch (e) {
    throw new HttpError(400, engineErrorCode(e), e.message);
  }

  return {
    tiesOut: model.tiesOut,
    pass: model.pass,
    balances: model.balances,
    exceptions: model.exceptions,
    summary: report.summaryLine(model),
    reportHtml,
    reportCsv,
  };
}

// ---------------------------------------------------------------------------
// T-28.1: the read-only DIAGNOSTIC core. Maps a broker-facing `source` spelling
// (the SAME file keys /api/reconcile uses, plus the `quickbooks` synonym) to the
// engine's SOURCE.*, then calls ingest.diagnoseSource VERBATIM and returns its
// report shape. UNLIKE reconcilePayload this does NOT fail closed: a well-formed
// file with unmatched columns returns 200 with `requiredMissing` populated — that
// is a self-service finding the UI renders, not a server error. It throws an
// HttpError 400 ONLY for a request that is itself malformed: an unknown source, a
// missing/non-string `text`, or a malformed `columnMap` (the SAME named IngestError
// the strict parser/indexHeader gives, raised EARLY via validateColumnMapForSource
// so a bad map is a 400 rather than being folded into the diagnose error list).
// PURE / I-O-free, exactly like reconcilePayload — the server never writes to disk.
// ---------------------------------------------------------------------------

// Broker-facing `source` spelling -> engine SOURCE.*. Accepts the SAME keys
// /api/reconcile uses for its three files (bank / ledger / rentroll) plus the
// natural `quickbooks` / `rent_roll` synonyms, so the door names sources the way
// the CLI's `--as` does without forcing the browser to know the engine's enum.
const INSPECT_SOURCE = Object.freeze({
  bank: ingest.SOURCE.BANK,
  ledger: ingest.SOURCE.QUICKBOOKS,
  quickbooks: ingest.SOURCE.QUICKBOOKS,
  rentroll: ingest.SOURCE.RENT_ROLL,
  rent_roll: ingest.SOURCE.RENT_ROLL,
});

function inspectPayload(payload) {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "bad_request", "request body must be a JSON object");
  }

  // The `source` selects which of the three logical types to diagnose. An unknown
  // (or missing) spelling is a named 400 that NAMES the accepted spellings, so the
  // caller can self-correct without reading source.
  const source = INSPECT_SOURCE[String(payload.source)];
  if (!source) {
    throw new HttpError(
      400,
      "unknown_source",
      `"source" must be one of: ${Object.keys(INSPECT_SOURCE).join(", ")}`
    );
  }

  // The file CONTENTS are REQUIRED and must be a string — a missing or non-string
  // `text` is a named 400, never a coercion (diagnoseSource treats a null text as
  // a file-level "no input" finding, but over the door an absent body field is a
  // client mistake, so we reject it up front with a clear message).
  if (typeof payload.text !== "string") {
    throw new HttpError(
      400,
      "missing_text",
      `"text" is required and must be the file contents as a text string`
    );
  }

  // Optional column-map override. Validate it EARLY against this file's real
  // header so a malformed map (unknown logical key, or a header absent from the
  // file) is a named 400 with the SAME IngestError message the strict parser gives
  // — rather than being folded into the diagnose report's error list. A bad shape
  // (not a plain object) is likewise a named 400.
  let columnMap = null;
  if (payload.columnMap != null) {
    if (typeof payload.columnMap !== "object" || Array.isArray(payload.columnMap)) {
      throw new HttpError(
        400,
        "invalid_column_map",
        '"columnMap" must be an object of { <logicalField>: <headerName> }'
      );
    }
    columnMap = payload.columnMap;
    try {
      ingest.validateColumnMapForSource(source, payload.text, columnMap);
    } catch (e) {
      throw new HttpError(400, engineErrorCode(e), e.message);
    }
  }

  // Call the EXISTING diagnostic VERBATIM (no re-implementation of parsing) and
  // return EXACTLY the diagnose report shape the CLI `vh trust inspect` consumes.
  // diagnoseSource is pure and only throws on an unknown source (already guarded);
  // every file/row problem is reported in the structure, not thrown.
  const rep = ingest.diagnoseSource(source, payload.text, { columnMap });

  return {
    source: rep.source,
    format: rep.format,
    header: rep.header,
    mapped: rep.mapped,
    requiredMissing: rep.requiredMissing,
    rowCount: rep.rowCount,
    okCount: rep.okCount,
    sample: rep.sample,
    errors: rep.errors,
  };
}

module.exports = {
  HttpError,
  engineErrorCode,
  WEB_PAID_FEATURE_ENTITLEMENTS,
  gatePayload,
  readOptionalMaps,
  reconcilePayload,
  INSPECT_SOURCE,
  inspectPayload,
};
