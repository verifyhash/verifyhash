"use strict";

// cli/fulfill-webhook-http.js — the loopback-only HTTP FULFILLMENT WEBHOOK for `vh fulfill-webhook` (T-62.2).
//
// WHAT THIS IS
//   A tiny, dependency-free (Node-core `http` ONLY) HTTP server that wires the PURE self-serve
//   fulfillment-INTAKE core (`cli/core/fulfill-intake.js`, T-62.1) to the shipped evidence license
//   fulfiller. It is the DROP-IN that removes the human's last CODE step between a billing provider's
//   webhook and a delivered evidence license: on each authenticated POST it AUTHENTICATES the raw event
//   (Stripe-style HMAC), MAPS the provider's price onto OUR plan via a validated price binding, MINTS the
//   signed license `vh evidence license fulfill` would mint, and DELIVERS it to `--out` — idempotently.
//
//   verifyProviderSignature -> parseEvidenceEvent -> normalizeEvidenceEvent -> fulfillEvidenceOrder ->
//   evidence.buildLicense. It invents NO crypto, NO plan logic, NO license format — every seam is the
//   shipped, tested core, reused VERBATIM. This file is only the HTTP transport + the idempotent delivery.
//
// FAIL CLOSED (the ONLY thing between "a paid event" and "anyone who can POST forges a license")
//   An UNSIGNED / FORGED / STALE / MALFORMED request is a 4xx with the localized reason and delivers
//   NOTHING. Signature verification runs FIRST, in constant time (the core), before ANY parse/mint/write.
//   A request that cannot be authenticated is never fulfilled.
//
// IDEMPOTENT (at-least-once delivery is the norm for webhooks)
//   Delivery is keyed on `intakeDedupKey(event)` — a hash of the event's retry-stable content (provider,
//   type, priceId, customer, periodEnd), NOT the wall clock. The license is written to a deterministic
//   `<dedup>.vhlicense.json` under `--out`; a RE-DELIVERED event returns the SAME licenseId (read back from
//   the existing file) with HTTP 200 and mints NO second license. The write is exclusive-create ('wx') so a
//   racing duplicate delivery collapses to one license, not two.
//
// KEY / SECRET HYGIENE (load-bearing, and grepped by the tests)
//   This transport HOLDS the vendor signing key IN MEMORY (as an ethers signer object) for the process
//   lifetime — a signing webhook must — and uses the signing secret ONLY to HMAC-verify the request. It
//   NEVER reads a key/secret from env or disk itself (the CLI layer does that from --key-env/--key-file/
//   --secret-env and hands in the objects), NEVER writes a key/secret to disk (a delivered license carries
//   ONLY public bytes: the signature + the signer ADDRESS), and NEVER logs one. It makes NO outbound
//   network request (no http.request/https/net/dns/fetch) — it only LISTENS.
//
// LOOPBACK BY DEFAULT (a human deploy step to expose)
//   The default bind host is 127.0.0.1. A non-loopback interface is NOT served unless the operator passes
//   --host. Exposing this publicly (your provider's REAL webhook secret, your REAL vendor key, your domain +
//   TLS) is an explicit HUMAN deploy step; it is NEVER auto-deployed.
//
// HONEST POSTURE
//   A delivered license is an ACCESS credential for delivered software value — NOT a token/coin/NFT, not
//   tradeable, and NOT a trusted timestamp (P-3). The `--binding` is an operator-maintained routing table
//   and makes NO claim of regulatory compliance; the subscription agreement governs.

const http = require("http");
const fs = require("fs");
const path = require("path");

const intake = require("./core/fulfill-intake");
const evidencePlans = require("./core/evidence-plans");
const evidence = require("./evidence");

// The default bind host is LOOPBACK. The default port is arbitrary-but-memorable and does NOT collide with
// the TrustLedger browser door (4173) or the serve-verify door (4180).
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4190;

// The wire-level body cap, enforced AS bytes arrive (a 413 before the body is ever fully buffered). Defaults
// to the intake core's own byte cap so the two layers agree; the operator may lower it via --max-body.
const DEFAULT_MAX_BODY_BYTES = intake.DEFAULT_MAX_BODY_BYTES;

// The single fulfillment route + a liveness route. A provider posts each event to FULFILL_PATH.
const FULFILL_PATH = "/fulfill";
const HEALTH_PATH = "/healthz";

// The request header a Stripe-compatible provider signs each delivery with (Node lowercases header names).
const SIGNATURE_HEADER = "stripe-signature";

// HTTP status codes we map onto. 422 (Unprocessable Entity) is the RIGHT code for "authenticated event the
// server understood, but it maps to NO sellable plan" — distinct from 400 (the request body itself is bad).
const STATUS = Object.freeze({
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE: 422,
  INTERNAL: 500,
});

// Map each localized signature-reason code to a 4xx. A missing/forged/stale signature is an authentication
// failure (401); a malformed header is a bad request (400). EVERY signature reject is a 4xx that delivers
// nothing — fail closed.
const SIGNATURE_REASON_STATUS = Object.freeze({
  [intake.SIGNATURE_REASONS.MISSING_HEADER]: STATUS.UNAUTHORIZED,
  [intake.SIGNATURE_REASONS.MALFORMED_HEADER]: STATUS.BAD_REQUEST,
  [intake.SIGNATURE_REASONS.SIGNATURE_MISMATCH]: STATUS.UNAUTHORIZED,
  [intake.SIGNATURE_REASONS.TIMESTAMP_OUT_OF_TOLERANCE]: STATUS.UNAUTHORIZED,
});

// A localized, human message per signature reason (the reason CODE is the machine-stable localization; this
// is the operator-facing prose). Every one states that NOTHING was delivered.
const SIGNATURE_REASON_MESSAGE = Object.freeze({
  [intake.SIGNATURE_REASONS.MISSING_HEADER]:
    "no Stripe-Signature header: the request is UNSIGNED — delivering nothing (fail-closed)",
  [intake.SIGNATURE_REASONS.MALFORMED_HEADER]:
    "the Stripe-Signature header is malformed (expected t=<unix>,v1=<hmac>) — delivering nothing (fail-closed)",
  [intake.SIGNATURE_REASONS.SIGNATURE_MISMATCH]:
    "the signature does NOT match the signing secret (forged or wrong secret) — delivering nothing (fail-closed)",
  [intake.SIGNATURE_REASONS.TIMESTAMP_OUT_OF_TOLERANCE]:
    "the signature timestamp is outside the replay window (stale/replayed) — delivering nothing (fail-closed)",
});

// The verbatim caveat block the CLI banner AND the /healthz body carry. These lines are the acceptance-pinned
// posture: authenticate+deliver, loopback, fail-closed, access-credential-not-a-token, human-deploy. Kept as
// an array of exact strings so a test can assert each line VERBATIM and the wording can never silently drift.
const CAVEATS = Object.freeze([
  "fulfillment webhook: it AUTHENTICATES a signed provider event and DELIVERS a signed license to --out; it holds the vendor signing key IN MEMORY and writes NO key/secret to disk or logs.",
  "loopback by default: it binds 127.0.0.1 — a non-loopback interface is NOT served unless you pass --host.",
  "fail-closed: an UNSIGNED / FORGED / STALE / MALFORMED request is a 4xx with the localized reason and delivers NOTHING.",
  "a delivered license is an ACCESS credential for delivered software value — NOT a token/coin/NFT, not tradeable, and NOT a trusted timestamp (P-3).",
  "exposing it publicly (your provider's real webhook secret, your real vendor key, your domain + TLS) is a HUMAN deploy step — never auto-deployed.",
]);

// ---------------------------------------------------------------------------------------------------
// A named, HTTP-status-bearing error for the request layer (mirrors serve-verify-http.js).
// ---------------------------------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

// A hard ceiling on how many bytes we DRAIN past the cap before tearing the socket down (bounded memory).
const OVERSIZE_DRAIN_LIMIT = 4 * 1024 * 1024;

// Read the request body with a HARD byte cap enforced AS chunks arrive, so an oversized body never pins
// unbounded memory. Resolves to `{ raw }` (a Buffer, within the cap) or `{ tooLarge:true, maxBytes }` once
// the cap is exceeded (the caller maps that to a clean 413). Rejects with an HttpError on a transport error
// or a hostile client that keeps streaming far past the cap.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      fn(arg);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (!over && size > maxBytes) {
        over = true;
        chunks.length = 0; // drop what we have so memory can't grow past the cap
      }
      if (over) {
        if (size > maxBytes + OVERSIZE_DRAIN_LIMIT) {
          req.destroy();
          finish(
            reject,
            new HttpError(STATUS.PAYLOAD_TOO_LARGE, "payload_too_large", `request body exceeds the ${maxBytes}-byte limit`)
          );
        }
        return; // drop the chunk
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      finish(resolve, over ? { tooLarge: true, maxBytes } : { raw: Buffer.concat(chunks) })
    );
    req.on("error", (e) => finish(reject, new HttpError(STATUS.BAD_REQUEST, "request_error", e.message)));
  });
}

// Write a JSON response with a stable shape. The body is ALWAYS JSON (never an HTML page or a stack trace).
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

// Send a NAMED JSON error — never a stack trace. An HttpError carries its own status + code; anything else is
// a defensive 500 with a generic message (its .message is NOT leaked, since it could be unexpected).
function sendError(res, err) {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.code, message: err.message });
    return;
  }
  sendJson(res, STATUS.INTERNAL, { error: "internal_error", message: "an internal error occurred" });
}

// The dedup key is `vh-ev-intake:sha256:<hex>`; the hex tail is a filesystem-safe deterministic filename.
function outPathForDedupKey(outDir, dedupKey) {
  const hex = dedupKey.slice(dedupKey.lastIndexOf(":") + 1);
  return path.join(outDir, `${hex}.vhlicense.json`);
}

// Read an ALREADY-delivered license file back and return its licenseId (for an idempotent replay). The file
// is one we wrote, so it re-validates through the SAME strict reader the gate uses.
function licenseIdOfDelivered(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const container = evidence.readLicense(text);
  const payload = JSON.parse(container.attestation);
  return payload.licenseId;
}

// ---------------------------------------------------------------------------------------------------
// The core per-request fulfillment. PURE of module-level state except the injected `now` clock. Given the
// already-read raw body + signature header, it authenticates, maps, mints, and delivers idempotently, or
// throws an HttpError (never a stack trace) that the handler maps to a status. `wallet` is the signer object
// (held in memory); `secret` HMAC-verifies; neither is ever written or logged.
// ---------------------------------------------------------------------------------------------------

async function fulfillRequest(rawBuf, sigHeader, cfg) {
  const { wallet, secret, binding, catalog, outDir, maxBytes, toleranceSec, now } = cfg;

  // One clock read per request, used for BOTH the replay-window check and the license issuedAt.
  const nowMs = now();
  const nowSec = Math.floor(nowMs / 1000);
  const issuedAt = new Date(nowMs).toISOString();

  const rawStr = rawBuf.toString("utf8");

  // (1) AUTHENTICATE FIRST — constant-time HMAC over the exact bytes, inside the replay window. An unsigned/
  //     forged/stale/malformed signature is a localized 4xx that delivers NOTHING (fail-closed).
  const sig = intake.verifyProviderSignature(rawStr, sigHeader, secret, { nowSec, toleranceSec });
  if (!sig.ok) {
    const status = SIGNATURE_REASON_STATUS[sig.reason] || STATUS.UNAUTHORIZED;
    const message = SIGNATURE_REASON_MESSAGE[sig.reason] || "signature rejected — delivering nothing";
    throw new HttpError(status, "signature_rejected", message);
  }

  // (2) PARSE the authenticated body -> normalized envelope. A malformed / unknown-type / duplicate-field
  //     body is a NAMED 400 (the request body itself is bad).
  let event;
  try {
    event = intake.parseEvidenceEvent(rawStr, { maxBytes, binding });
  } catch (e) {
    throw new HttpError(STATUS.BAD_REQUEST, "invalid_event", e && e.message ? e.message : String(e));
  }

  // (3) IDEMPOTENCY — key on the event's retry-stable content, NOT the clock. If we already delivered this
  //     event, return the SAME licenseId with 200 and mint NO second license.
  const dedupKey = intake.intakeDedupKey(event);
  const hex = dedupKey.slice(dedupKey.lastIndexOf(":") + 1);
  const outPath = path.join(outDir, `${hex}.vhlicense.json`);
  if (fs.existsSync(outPath)) {
    return {
      status: STATUS.OK,
      body: { delivered: true, idempotent: true, licenseId: licenseIdOfDelivered(outPath), out: outPath },
    };
  }

  // (4) MAP the event onto OUR order and MINT the license params. An event that maps to NO plan (unmapped
  //     price) is an authenticated-but-UNPROCESSABLE 422 that delivers nothing. The licenseId is derived
  //     DETERMINISTICALLY from the event's dedup key (NOT the clock) so it is STABLE across retries yet
  //     DISTINCT per (customer, price, period) — two different customers on the same plan never collide.
  let params;
  try {
    const order = intake.normalizeEvidenceEvent(event, binding, { issuedAt });
    order.licenseId = `LIC-${hex.slice(0, 24)}`;
    params = evidencePlans.fulfillEvidenceOrder(order, catalog);
  } catch (e) {
    throw new HttpError(STATUS.UNPROCESSABLE, "unfulfillable", e && e.message ? e.message : String(e));
  }

  // (5) SIGN the params into the SAME signed container the gate accepts, then DELIVER it. The key lives ONLY
  //     inside `wallet`; the written bytes carry only the signature + the signer ADDRESS (public).
  let canonical;
  let vendor;
  try {
    const container = await evidence.buildLicense(params, wallet);
    canonical = evidence.serializeSignedLicense(container);
    vendor = container.signature.signer; // validated lowercase 0x-address (public; NEVER the key)
  } catch (e) {
    throw new HttpError(STATUS.INTERNAL, "sign_error", "could not sign the license");
  }

  // Exclusive-create so a racing duplicate delivery collapses to ONE license: on EEXIST we read the winner
  // back and return its licenseId (still 200, still idempotent) rather than a duplicate.
  try {
    fs.writeFileSync(outPath, canonical, { flag: "wx" });
  } catch (e) {
    if (e && e.code === "EEXIST") {
      return {
        status: STATUS.OK,
        body: { delivered: true, idempotent: true, licenseId: licenseIdOfDelivered(outPath), out: outPath },
      };
    }
    throw new HttpError(STATUS.INTERNAL, "io_error", `could not write the license to --out: ${e.message}`);
  }

  return {
    status: STATUS.OK,
    body: {
      delivered: true,
      idempotent: false,
      licenseId: params.licenseId,
      plan: params.plan,
      customer: params.customer,
      vendor,
      out: outPath,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// The request handler. Routes on method + path; delegates ALL auth/map/mint to the shipped cores.
// ---------------------------------------------------------------------------------------------------

function makeHandler(opts = {}) {
  if (opts.wallet == null || typeof opts.wallet.signMessage !== "function") {
    throw new Error("fulfill-webhook handler requires a signer object (opts.wallet with signMessage())");
  }
  if (typeof opts.secret !== "string" || opts.secret.length === 0) {
    throw new Error("fulfill-webhook handler requires a non-empty signing secret (opts.secret)");
  }
  if (opts.binding == null || opts.binding._byKey == null) {
    throw new Error("fulfill-webhook handler requires a validated price binding (opts.binding)");
  }
  if (opts.catalog == null || opts.catalog.plansById == null) {
    throw new Error("fulfill-webhook handler requires a validated plan catalog (opts.catalog)");
  }
  if (typeof opts.outDir !== "string" || opts.outDir.length === 0) {
    throw new Error("fulfill-webhook handler requires an output directory (opts.outDir)");
  }
  const cfg = {
    wallet: opts.wallet,
    secret: opts.secret,
    binding: opts.binding,
    catalog: opts.catalog,
    outDir: opts.outDir,
    maxBytes:
      opts.maxBodyBytes != null && Number.isFinite(opts.maxBodyBytes) ? opts.maxBodyBytes : DEFAULT_MAX_BODY_BYTES,
    toleranceSec:
      opts.toleranceSec != null && Number.isFinite(opts.toleranceSec)
        ? opts.toleranceSec
        : intake.DEFAULT_TOLERANCE_SEC,
    // Injected clock (ms). Deterministic under test; the core NEVER reads the system clock itself.
    now: typeof opts.now === "function" ? opts.now : () => Date.now(),
  };

  return function handler(req, res) {
    const url = req.url || "/";
    const pathOnly = url.split("?")[0];
    const method = req.method || "GET";

    // GET /healthz -> 200 { ok:true } (+ honest metadata + the caveats). It signs, so holdsKey is TRUE; the
    // key is in memory only and never written/logged.
    if (pathOnly === HEALTH_PATH) {
      if (method !== "GET") {
        sendError(res, new HttpError(STATUS.METHOD_NOT_ALLOWED, "method_not_allowed", `${HEALTH_PATH} accepts only GET`));
        return;
      }
      sendJson(res, STATUS.OK, {
        ok: true,
        service: "vh-fulfill-webhook",
        holdsKey: true,
        writesKeyToDisk: false,
        makesOutboundRequest: false,
        caveats: CAVEATS,
      });
      return;
    }

    // POST /fulfill -> authenticate, map, mint, deliver (idempotent).
    if (pathOnly === FULFILL_PATH) {
      if (method !== "POST") {
        sendError(res, new HttpError(STATUS.METHOD_NOT_ALLOWED, "method_not_allowed", `${FULFILL_PATH} accepts only POST`));
        return;
      }
      readBody(req, cfg.maxBytes)
        .then((body) => {
          if (body.tooLarge) {
            // An oversized body is a clean 413 BEFORE any auth/mint — never a crash, never a delivery.
            throw new HttpError(STATUS.PAYLOAD_TOO_LARGE, "payload_too_large", `request body exceeds the ${body.maxBytes}-byte limit`);
          }
          const sigHeader = req.headers[SIGNATURE_HEADER];
          return fulfillRequest(body.raw, sigHeader, cfg).then((out) => sendJson(res, out.status, out.body));
        })
        .catch((err) => sendError(res, err));
      return;
    }

    // Any other path/method: a named 404 (JSON, never an HTML error page).
    sendError(res, new HttpError(STATUS.NOT_FOUND, "not_found", `no route for ${method} ${pathOnly}`));
  };
}

// Build (but do NOT listen on) an http.Server. Keeping creation + listening separate lets a test bind an
// EPHEMERAL port (0) on 127.0.0.1 and close cleanly, and lets a real deploy choose its own port/host.
function createServer(opts = {}) {
  return http.createServer(makeHandler(opts));
}

// The verbatim CLI banner printed when the server starts. LEADS with the caveats (each VERBATIM) so an
// operator sees the posture — and the honesty boundary — before use.
function banner(url, host, outDir) {
  const browseHint =
    host === "0.0.0.0" || host === "::"
      ? `  (${host} binds ALL interfaces — you chose to expose it; secure it with your own auth/TLS.)\n`
      : "";
  return (
    `vh fulfill-webhook listening on ${url}\n` +
    browseHint +
    `  POST ${FULFILL_PATH}  -> authenticate a signed event, deliver a signed *.vhlicense.json to ${outDir}\n` +
    `                    (200 { delivered, licenseId } / 401|400 unsigned|malformed / 422 unmappable / 413 too large)\n` +
    `  GET  ${HEALTH_PATH}  -> { ok:true }\n` +
    CAVEATS.map((c) => `  - ${c}`).join("\n") +
    "\n" +
    "  Press Ctrl-C to stop.\n"
  );
}

module.exports = {
  createServer,
  makeHandler,
  fulfillRequest,
  banner,
  readBody,
  sendJson,
  sendError,
  outPathForDedupKey,
  HttpError,
  CAVEATS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_MAX_BODY_BYTES,
  FULFILL_PATH,
  HEALTH_PATH,
  SIGNATURE_HEADER,
  SIGNATURE_REASON_STATUS,
  SIGNATURE_REASON_MESSAGE,
  STATUS,
};
