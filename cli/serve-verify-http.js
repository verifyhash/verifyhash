"use strict";

// cli/serve-verify-http.js — the loopback-only HTTP transport for `vh serve-verify` (T-59.2).
//
// WHAT THIS IS
//   A tiny, dependency-free (Node-core `http` ONLY) HTTP server that fronts the PURE, transport-agnostic
//   verify core (`cli/serve-verify.js › verifyRequest`). It transports a request body IN over HTTP, hands
//   the already-parsed object to `verifyRequest`, and maps the returned verdict to a CI-mappable HTTP
//   status + JSON body OUT. It invents NO verify logic, NO crypto, NO verdict vocabulary — every ACCEPT/
//   REJECT/ERROR answer is the core's, byte-for-byte in `detail`.
//
// VERIFY-ONLY / NO KEY / NO FILE WRITES
//   This server VERIFIES; it never SIGNS. It holds NO private key (it never constructs a Wallet, never
//   reads a key, never calls signMessage/signSealWith). It writes NOTHING to disk — the whole request path
//   (readBody -> JSON.parse -> verifyRequest -> sendJson) is I/O-free except the network socket. A verify
//   therefore leaves the filesystem untouched, and the process holds no secret at any point.
//
// LOOPBACK BY DEFAULT (a human deploy step to expose)
//   The default bind host is `127.0.0.1` (loopback). A request arriving on a non-loopback interface is NOT
//   served by the default bind — the socket simply is not listening there. Exposing this publicly (behind
//   YOUR nginx/Cloudflare, on YOUR domain, with TLS) is an explicit HUMAN deploy step; it is NEVER
//   auto-deployed and NEVER binds a public interface on its own. (An operator MAY pass `--host 0.0.0.0` to
//   bind all interfaces — that is their explicit, deliberate choice, printed back with a warning.)
//
// STATUS MAPPING (CI-mappable — a build can gate on the code alone)
//   POST /verify:
//     verdict ACCEPTED -> 200   (the seal/container verified)
//     verdict REJECTED -> 422   (a well-formed request that did NOT verify — Unprocessable Entity)
//     verdict ERROR    -> 400   (a malformed/unknown request the core evaluated to ERROR — the body is bad)
//   A wire body larger than --max-body is refused with 413 (Payload Too Large) BEFORE it is fully buffered —
//   a DISTINCT code from the 400 bucket, so a CI gate can tell "too big" apart from "malformed/unknown".
//   GET /healthz -> 200 { ok:true }
//   Anything else (wrong method / wrong path) -> 404 (or 405 for a known path, wrong method).
//
// FAIL CLOSED
//   Invalid JSON, an oversized body, an unknown route, or ANY unexpected internal error becomes a clean
//   named JSON error with a 4xx/5xx status — NEVER a stack trace, NEVER a silent 200, NEVER a crash of the
//   process. A caller that cannot be verified is never treated as verified.

const http = require("http");

const serveVerify = require("./serve-verify");

// The default bind host is LOOPBACK: a non-loopback interface is NOT served unless the operator explicitly
// asks for a different --host. The default port is arbitrary-but-memorable and does NOT collide with the
// TrustLedger browser door (4173).
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4180;

// The wire-level body cap enforced AS bytes arrive, so a hostile/accidental giant body is refused (413)
// before it is ever fully buffered. Defaults to the CORE's own byte cap so the two layers agree; an
// operator may lower it via --max-body. (The core ALSO re-checks the parsed size — belt and braces.)
const DEFAULT_MAX_BODY_BYTES = serveVerify.MAX_BODY_BYTES;

// The single verify route + the health route.
const VERIFY_PATH = "/verify";
const HEALTH_PATH = "/healthz";

// HTTP status codes we map onto. 422 (Unprocessable Entity) is the RIGHT code for "well-formed request the
// server understood, but the content did NOT verify" — distinct from 400 ("the request itself is bad").
const STATUS = Object.freeze({
  OK: 200,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  UNPROCESSABLE: 422,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
});

// The verbatim caveat block the CLI banner AND (a machine-readable copy) the /healthz body carry. These
// four lines are the acceptance-pinned posture: verify-only, loopback, P-3, human-deploy. Kept as an array
// of exact strings so a test can assert each line VERBATIM and the wording can never silently drift.
const CAVEATS = Object.freeze([
  "verify-only: this server VERIFIES seals; it never signs, holds NO private key, and writes NO file.",
  "loopback by default: it binds 127.0.0.1 — a non-loopback interface is NOT served unless you pass --host.",
  "NOT a timestamp: a verified seal proves set-membership / a signer vouched, NOT \"sealed since date T\" (P-3).",
  "exposing it publicly is a HUMAN deploy step (your nginx/Cloudflare, your domain, TLS) — never auto-deployed.",
]);

// ---------------------------------------------------------------------------------------------------
// Body reader with a HARD size cap enforced as bytes arrive (never buffers past the cap).
// ---------------------------------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

// A hard ceiling on how many bytes we will DRAIN past the cap before forcibly tearing the socket down. Once
// the body exceeds `maxBytes` we STOP buffering (memory stays bounded at the cap) but keep DRAINING incoming
// chunks so we can still send a clean 400 back to a merely-too-big (not hostile) client. If a truly hostile
// client keeps streaming far beyond the cap, we destroy the socket rather than drain forever.
const OVERSIZE_DRAIN_LIMIT = 4 * 1024 * 1024;

// Read the request body with a HARD byte cap enforced AS chunks arrive, so an oversized body never pins
// unbounded memory. Resolves to `{ body }` on a body within the cap, or `{ tooLarge:true }` once the cap is
// exceeded (the caller maps that to a clean 413 — never a silent ACCEPT). Rejects with an HttpError only on
// a transport error or a hostile client that keeps streaming far past the cap (socket torn down, also 413).
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
        // Cap exceeded: stop buffering (drop what we have so memory can't grow past the cap) and mark the
        // request too-large. We keep draining to `end` so a clean 413 reaches a merely-oversized client.
        over = true;
        chunks.length = 0;
      }
      if (over) {
        if (size > maxBytes + OVERSIZE_DRAIN_LIMIT) {
          // A hostile client streaming far past the cap: tear the socket down rather than drain forever.
          req.destroy();
          finish(reject, new HttpError(STATUS.PAYLOAD_TOO_LARGE, "payload_too_large", `request body exceeds the ${maxBytes}-byte limit`));
        }
        return; // drop the chunk; do not buffer
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      finish(resolve, over ? { tooLarge: true, maxBytes } : { body: Buffer.concat(chunks).toString("utf8") })
    );
    req.on("error", (e) => finish(reject, new HttpError(STATUS.BAD_REQUEST, "request_error", e.message)));
  });
}

// Write a JSON response with a stable shape. The body is ALWAYS JSON (never an HTML page or a stack trace),
// so a programmatic CI client can always parse it. `nosniff` keeps it from being reinterpreted.
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

// Send a NAMED JSON error — never a stack trace. An HttpError carries its own status + code; anything else
// is a defensive 500 with a generic message (its .message is NOT leaked, since it could be unexpected).
function sendError(res, err) {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.code, message: err.message });
    return;
  }
  sendJson(res, STATUS.INTERNAL, { error: "internal_error", message: "an internal error occurred" });
}

// Map the core verdict envelope to a CI-mappable HTTP status. ACCEPTED->200, REJECTED->422, ERROR->400.
// Anything unexpected (should be impossible — verifyRequest returns only those three) is a defensive 500.
function statusForVerdict(verdict) {
  switch (verdict) {
    case serveVerify.VERDICT.ACCEPTED:
      return STATUS.OK;
    case serveVerify.VERDICT.REJECTED:
      return STATUS.UNPROCESSABLE;
    case serveVerify.VERDICT.ERROR:
      return STATUS.BAD_REQUEST;
    default:
      return STATUS.INTERNAL;
  }
}

// ---------------------------------------------------------------------------------------------------
// The request handler. Routes on method + path; delegates ALL verify logic to the pure core.
// ---------------------------------------------------------------------------------------------------

function makeHandler(opts = {}) {
  const maxBytes =
    opts.maxBodyBytes != null && Number.isFinite(opts.maxBodyBytes)
      ? opts.maxBodyBytes
      : DEFAULT_MAX_BODY_BYTES;

  return function handler(req, res) {
    // Route on the PATH only (ignore any query string).
    const url = req.url || "/";
    const pathOnly = url.split("?")[0];
    const method = req.method || "GET";

    // GET /healthz -> 200 { ok:true } (+ the machine-readable service metadata + caveats). A liveness/
    // readiness probe (k8s, a CI healthcheck) hits this; it holds no key and touches nothing.
    if (pathOnly === HEALTH_PATH) {
      if (method !== "GET") {
        sendError(
          res,
          new HttpError(STATUS.METHOD_NOT_ALLOWED, "method_not_allowed", `${HEALTH_PATH} accepts only GET`)
        );
        return;
      }
      sendJson(res, STATUS.OK, {
        ok: true,
        service: serveVerify.SERVICE_NAME,
        schema: serveVerify.VERIFY_REQUEST_SCHEMA,
        verifyOnly: true,
        holdsKey: false,
        writesFiles: false,
        caveats: CAVEATS,
      });
      return;
    }

    // POST /verify -> run the pure core, map the verdict to a status.
    if (pathOnly === VERIFY_PATH) {
      if (method !== "POST") {
        sendError(
          res,
          new HttpError(STATUS.METHOD_NOT_ALLOWED, "method_not_allowed", `${VERIFY_PATH} accepts only POST`)
        );
        return;
      }
      readBody(req, maxBytes)
        .then((raw) => {
          // An oversized body is a clean 413 (Payload Too Large) — a distinct, CI-gateable code, never a
          // crash, never an ACCEPT. 413 (not 400) is the RIGHT status: the request was well-formed at the
          // HTTP layer but its body exceeded the operator's --max-body cap.
          if (raw.tooLarge) {
            throw new HttpError(
              STATUS.PAYLOAD_TOO_LARGE,
              "payload_too_large",
              `request body exceeds the ${raw.maxBytes}-byte limit`
            );
          }
          let body;
          try {
            body = JSON.parse(raw.body);
          } catch (e) {
            // Malformed JSON is a clean 400 named error — never a crash, never a silent ACCEPT. (The core
            // never sees it; a non-parseable body is a request-layer fault, mapped like an ERROR verdict.)
            throw new HttpError(STATUS.BAD_REQUEST, "invalid_json", `request body is not valid JSON: ${e.message}`);
          }
          // The pure core does ALL verify work: it NEVER throws, holds no key, touches no fs/net. We only
          // map its top-level verdict to a status and send its envelope back VERBATIM.
          const verdict = serveVerify.verifyRequest(body);
          sendJson(res, statusForVerdict(verdict.verdict), verdict);
        })
        .catch((err) => sendError(res, err));
      return;
    }

    // Any other path/method: a named 404 (JSON, never an HTML error page).
    sendError(res, new HttpError(STATUS.NOT_FOUND, "not_found", `no route for ${method} ${pathOnly}`));
  };
}

// Build (but do NOT listen on) an http.Server. Keeping creation and listening separate lets a test bind an
// EPHEMERAL port (0) on 127.0.0.1 and close cleanly, and lets a real deploy choose its own port/host.
function createServer(opts = {}) {
  return http.createServer(makeHandler(opts));
}

// The verbatim CLI banner printed when the server starts. LEADS with the verify-only + loopback + P-3 +
// human-deploy caveats (each line VERBATIM from CAVEATS) so an operator sees the posture before use.
function banner(url, host) {
  const browseHint =
    host === "0.0.0.0" || host === "::"
      ? `  (${host} binds ALL interfaces — you chose to expose it; browse via your machine's own address.)\n`
      : "";
  return (
    `vh serve-verify listening on ${url}\n` +
    browseHint +
    `  POST ${VERIFY_PATH}   -> JSON verdict (200 ACCEPTED / 422 REJECTED / 400 bad request / 413 too large)\n` +
    `  GET  ${HEALTH_PATH}  -> { ok:true }\n` +
    CAVEATS.map((c) => `  - ${c}`).join("\n") +
    "\n" +
    "  Press Ctrl-C to stop.\n"
  );
}

module.exports = {
  createServer,
  makeHandler,
  banner,
  readBody,
  sendJson,
  sendError,
  statusForVerdict,
  HttpError,
  CAVEATS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_MAX_BODY_BYTES,
  VERIFY_PATH,
  HEALTH_PATH,
  STATUS,
};
