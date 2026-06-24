"use strict";

// TrustLedger — server.js
//
// T-27.1: a MINIMAL, dependency-free web front-door over the EXISTING engine.
//
// EPIC-27's whole point: a property-management broker will never use a terminal,
// so the (complete, robust) CLI reconciliation engine is un-sellable as-is. This
// is the thin web door that turns "a tool I run in a terminal" into "a product a
// broker opens in a browser, drags three files into, and watches the balances tie
// out." It REUSES the engine VERBATIM — ingest -> match -> reconcile -> report —
// and adds NOTHING to the pipeline; it only transports bytes in over HTTP and the
// already-computed model + rendered packet back out as JSON.
//
// Pure Node `http` — NO new dependency. The browser reads the three files the
// broker drops and POSTs their TEXT CONTENTS as a JSON body, so there is NO
// multipart parsing here (that complexity lives in the browser's FileReader, not
// in a hand-rolled multipart parser on the server).
//
// Two routes:
//   GET  /               -> the static single-page upload UI (no framework, no CDN).
//   POST /api/reconcile  -> { bank, ledger, rentroll, state?, priorClose? } (file
//                           CONTENTS as text) -> runs the pipeline and returns
//                           { tiesOut, balances, exceptions, reportHtml, reportCsv }.
//
// STRICT + SAFE, matching the engine's posture:
//   * A malformed / ambiguous file raises a NAMED JSON error with HTTP 400 — never
//     a stack trace, never a silent coercion. The named error is the SAME engine
//     error (IngestError / ReportError / PolicyError / CloseError) so the broker
//     sees the exact located reason ("malformed amount ... (row 3, bank)").
//   * An oversized body is rejected with HTTP 413 (a named "payload_too_large")
//     before it is ever buffered fully into memory, so a hostile client cannot
//     exhaust the process.
//   * The server NEVER writes to cwd (or anywhere): the entire pipeline through
//     report.renderHTML / renderExceptionsCSV is PURE and I/O-free. No packet
//     file, no temp file, no receipt is ever written. It is safe to run anywhere.
//
// HONEST POSTURE inherited verbatim: the returned reportHtml carries the SAME
// custodian disclaimer the CLI packet does (it is the identical renderHTML output).
// The web door changes HOW the broker reaches the engine, not WHAT it claims — it
// AIDS reconciliation; the broker remains the responsible trust-account custodian.

const http = require("http");
const fs = require("fs");
const path = require("path");

const ingest = require("./ingest");
const report = require("./report");
const policy = require("./policy");
const close = require("./close");

// Hard cap on the POST body. Three monthly exports (bank CSV/OFX, QuickBooks CSV,
// rent roll CSV) are tiny — kilobytes to low single-digit megabytes. 16 MiB is a
// generous ceiling that still firmly bounds the memory a single request can pin,
// so a hostile or buggy client cannot stream an unbounded body into the process.
const MAX_BODY_BYTES = 16 * 1024 * 1024;

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

function reconcilePayload(payload, reportDate) {
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
  const report = ingest.diagnoseSource(source, payload.text, { columnMap });

  return {
    source: report.source,
    format: report.format,
    header: report.header,
    mapped: report.mapped,
    requiredMissing: report.requiredMissing,
    rowCount: report.rowCount,
    okCount: report.okCount,
    sample: report.sample,
    errors: report.errors,
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

// Read the request body with a HARD size cap enforced AS bytes arrive, so an
// oversized body is rejected (HttpError 413) before it is fully buffered. Resolves
// to the body string; rejects with an HttpError on overflow.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      fn(arg);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop accepting more bytes and reject; do not buffer the rest.
        req.destroy();
        finish(
          reject,
          new HttpError(
            413,
            "payload_too_large",
            `request body exceeds the ${MAX_BODY_BYTES}-byte limit`
          )
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(resolve, Buffer.concat(chunks).toString("utf8")));
    req.on("error", (e) =>
      finish(reject, new HttpError(400, "request_error", e.message))
    );
  });
}

// Write a JSON response with a stable shape. The body is always JSON (never an
// HTML error page or a stack trace), so a programmatic client can always parse it.
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // The browser page is served same-origin, so no CORS is needed; we set
    // nosniff to keep the JSON from being interpreted as anything else.
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  const code = err instanceof HttpError ? err.code : "internal_error";
  // NEVER leak a stack trace: send only the named code + the human message.
  const message =
    err instanceof HttpError ? err.message : "an internal error occurred";
  sendJson(res, status, { error: code, message });
}

// The canonical single-page upload UI lives in trustledger/public/index.html —
// ONE self-contained file (no framework, no CDN) a designer can edit without
// touching server code. The server serves THAT file verbatim; this embedded copy
// is a byte-faithful FALLBACK so the door still works if the file is ever missing
// (e.g. a partial deploy). Both read the three dropped files with the browser's
// FileReader, POST their text to /api/reconcile, and render the returned verdict,
// balances, exception table, and download links. Read once + cached: the file is
// immutable at deploy time, so this stays I/O-cheap and deterministic per process.
const PUBLIC_INDEX = path.join(__dirname, "public", "index.html");
let cachedIndexHtml = null;

function indexHtml() {
  if (cachedIndexHtml != null) return cachedIndexHtml;
  try {
    cachedIndexHtml = fs.readFileSync(PUBLIC_INDEX, "utf8");
  } catch (_) {
    cachedIndexHtml = embeddedIndexHtml();
  }
  return cachedIndexHtml;
}

// The byte-faithful fallback page (used only when public/index.html is absent).
function embeddedIndexHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TrustLedger — Three-Way Trust-Account Reconciliation</title>
<style>
  body { font: 15px/1.5 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
         color: #1a1a1a; max-width: 820px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  .note { color: #555; font-size: .9rem; }
  fieldset { border: 1px solid #ddd; border-radius: 6px; margin: 1rem 0; padding: 1rem; }
  legend { font-weight: 600; padding: 0 .4rem; }
  label { display: block; margin: .6rem 0 .2rem; font-weight: 600; }
  button { font: inherit; padding: .5rem 1rem; border-radius: 6px; border: 1px solid #0a6b2f;
           background: #0a6b2f; color: #fff; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .verdict { display: inline-block; padding: .4rem .8rem; border-radius: 6px; font-weight: 700; margin: 1rem 0; }
  .verdict.pass { background: #e6f4ea; color: #0a6b2f; border: 1px solid #0a6b2f; }
  .verdict.fail { background: #fdeaea; color: #b00020; border: 1px solid #b00020; }
  .err { color: #b00020; font-weight: 600; }
  iframe { width: 100%; height: 560px; border: 1px solid #ddd; border-radius: 6px; margin-top: 1rem; }
  .disclaimer { background: #fffbe6; border: 1px solid #e6d77a; border-radius: 6px;
                padding: .6rem .9rem; font-size: .85rem; margin: 1rem 0; }
</style>
</head>
<body>
<h1>TrustLedger — Three-Way Trust-Account Reconciliation</h1>
<p class="note">Drop your three monthly files. Your browser reads them and sends
their contents to this server; the reconciliation runs in memory and nothing is
stored on disk.</p>
<div class="disclaimer"><strong>Disclaimer.</strong> This tool AIDS reconciliation.
The broker remains the legal trust-account custodian and is solely responsible for
the accuracy of the trust-account records. It is tamper-evidence and a reconciliation
aid only — NOT a trusted timestamp, NOT legal, accounting, or audit advice, and NOT a
substitute for a CPA's review.</div>

<form id="f">
  <fieldset>
    <legend>The three files</legend>
    <label for="bank">Bank statement (CSV or OFX/QFX)</label>
    <input id="bank" type="file" accept=".csv,.ofx,.qfx,.txt" required>
    <label for="ledger">QuickBooks trust ledger (CSV)</label>
    <input id="ledger" type="file" accept=".csv,.txt" required>
    <label for="rentroll">Rent roll / tenant sub-ledger (CSV)</label>
    <input id="rentroll" type="file" accept=".csv,.txt" required>
  </fieldset>
  <button id="go" type="submit">Reconcile</button>
</form>

<div id="result"></div>

<script>
(function () {
  var form = document.getElementById("f");
  var result = document.getElementById("result");

  function read(input) {
    return new Promise(function (resolve, reject) {
      var file = input.files && input.files[0];
      if (!file) { reject(new Error("please choose the " + input.id + " file")); return; }
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error("could not read " + input.id)); };
      r.readAsText(file);
    });
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var go = document.getElementById("go");
    go.disabled = true;
    result.innerHTML = "<p>Reconciling…</p>";

    Promise.all([
      read(document.getElementById("bank")),
      read(document.getElementById("ledger")),
      read(document.getElementById("rentroll"))
    ]).then(function (texts) {
      return fetch("/api/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bank: texts[0], ledger: texts[1], rentroll: texts[2] })
      });
    }).then(function (resp) {
      return resp.json().then(function (data) { return { ok: resp.ok, data: data }; });
    }).then(function (r) {
      go.disabled = false;
      if (!r.ok) {
        result.innerHTML = "<p class='err'>Error (" +
          escapeHtml(r.data.error || "error") + "): " +
          escapeHtml(r.data.message || "") + "</p>";
        return;
      }
      var d = r.data;
      var cls = d.tiesOut ? "pass" : "fail";
      var verdict = d.pass ? "PASS — three-way reconciliation ties out"
                           : "FAIL — see exceptions";
      var frame = document.createElement("iframe");
      result.innerHTML = "<div class='verdict " + cls + "'>" + escapeHtml(verdict) + "</div>" +
        "<p>" + escapeHtml(d.summary || "") + "</p>";
      result.appendChild(frame);
      frame.srcdoc = d.reportHtml;
    }).catch(function (e) {
      go.disabled = false;
      result.innerHTML = "<p class='err'>" + escapeHtml(e.message || String(e)) + "</p>";
    });
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
})();
</script>
</body>
</html>
`;
}

// The request handler. Pure of any module-level state except `today` (injectable).
function makeHandler(opts = {}) {
  const today = opts.today || todayISO;
  return function handler(req, res) {
    // Parse the URL path only (ignore query); route on method + path.
    const url = req.url || "/";
    const pathOnly = url.split("?")[0];

    if (req.method === "GET" && (pathOnly === "/" || pathOnly === "/index.html")) {
      const body = indexHtml();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "x-content-type-options": "nosniff",
      });
      res.end(body);
      return;
    }

    if (req.method === "POST" && pathOnly === "/api/reconcile") {
      readBody(req)
        .then((raw) => {
          let payload;
          try {
            payload = JSON.parse(raw);
          } catch (e) {
            throw new HttpError(400, "invalid_json", `request body is not valid JSON: ${e.message}`);
          }
          const out = reconcilePayload(payload, today());
          sendJson(res, 200, out);
        })
        .catch((err) => sendError(res, err));
      return;
    }

    // T-28.1: the read-only per-file diagnostic. Additive + SEPARATE from
    // /api/reconcile: it parses WITHOUT failing closed and reports every failing
    // row (exactly as `vh trust inspect`), so a well-formed-but-unmatched file is
    // a 200 with `requiredMissing`, not an error. Same body transport + named
    // 400/413 posture; same no-cwd-write guarantee (diagnose is pure).
    if (req.method === "POST" && pathOnly === "/api/inspect") {
      readBody(req)
        .then((raw) => {
          let payload;
          try {
            payload = JSON.parse(raw);
          } catch (e) {
            throw new HttpError(400, "invalid_json", `request body is not valid JSON: ${e.message}`);
          }
          const out = inspectPayload(payload);
          sendJson(res, 200, out);
        })
        .catch((err) => sendError(res, err));
      return;
    }

    // Anything else: a named 404 (still JSON, never an HTML error page).
    sendError(res, new HttpError(404, "not_found", `no route for ${req.method} ${pathOnly}`));
  };
}

// Build (but do NOT listen on) an http.Server. The caller calls .listen(port).
// Keeping creation and listening separate lets tests bind an EPHEMERAL port (0)
// and close cleanly, and lets a real deploy choose its own port/host.
function createServer(opts = {}) {
  return http.createServer(makeHandler(opts));
}

// Real "today" as a UTC YYYY-MM-DD — the ONLY impure call, isolated + injectable
// so the pipeline core (reconcilePayload) stays deterministic under test.
function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// CLI entry: `node trustledger/server.js [port]` (or PORT env). Never invoked by
// the tests (they create + listen themselves on an ephemeral port).
if (require.main === module) {
  const port = Number(process.env.PORT || process.argv[2] || 8080);
  const host = process.env.HOST || "127.0.0.1";
  const srv = createServer();
  srv.listen(port, host, () => {
    process.stdout.write(
      `TrustLedger web door listening on http://${host}:${port}/ (in-memory; nothing is written to disk)\n`
    );
  });
}

module.exports = {
  createServer,
  makeHandler,
  reconcilePayload,
  inspectPayload,
  indexHtml,
  embeddedIndexHtml,
  PUBLIC_INDEX,
  HttpError,
  MAX_BODY_BYTES,
  todayISO,
};
