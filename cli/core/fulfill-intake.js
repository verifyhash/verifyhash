"use strict";

// ---------------------------------------------------------------------------
// cli/core/fulfill-intake.js — THE SELF-SERVE FULFILLMENT-INTAKE CORE (T-62.1).
//
// The EVIDENCE vertical already ships the LAST link of the self-serve revenue
// chain — `fulfillEvidenceOrder(order, catalog)` (cli/core/evidence-plans.js), a
// PURE order -> license-params mapping. But between a raw billing-provider webhook
// (a Stripe `checkout.session.completed` / `invoice.paid` POST) and that call there
// are TWO pure seams that existed NOWHERE in the evidence tree, so a human wiring
// Stripe -> `vh evidence license fulfill` had to WRITE and SECURE them by hand:
//
//   SEAM 1 — AUTHENTICATE the raw request. Stripe signs each delivery with a
//     `Stripe-Signature: t=<unix>,v1=<hmac_sha256_hex>` header over `${t}.${rawBody}`
//     using the endpoint's signing secret. Verifying it (constant-time, inside a
//     replay window) is the ONLY thing standing between "a paid event" and "anyone
//     who can POST forges a license." `verifyProviderSignature` is that check.
//
//   SEAM 2 — MAP the provider's own vocabulary onto OUR order. A real webhook body
//     carries the PROVIDER's price id (`price_...`), a customer ref, and a period
//     end as a UNIX epoch in SECONDS — NOT our planId, NOT a canonical ISO instant.
//     `parseEvidenceEvent` flattens the real Stripe body to a normalized envelope;
//     `validateEvidencePriceBinding` / `resolveEvidencePlanId` route (provider,
//     priceId) -> OUR planId over the EVIDENCE catalog (mirroring the TrustLedger
//     price binding, but bound to THIS product's plans); `normalizeEvidenceEvent`
//     produces the EXACT `{ plan, customer, paidThrough, issuedAt }` order
//     `fulfillEvidenceOrder` consumes; `intakeDedupKey` is the retry-stable
//     idempotency key an at-least-once delivery dedupes on.
//
// DESIGN PROPERTIES (the whole module).
//   * PURE / I-O-FREE / DETERMINISTIC. NO filesystem, NO network, NO system clock,
//     NO key/secret held. The wall clock is INJECTED (`verifyProviderSignature`
//     takes `nowSec`; `normalizeEvidenceEvent` takes `issuedAt`) so the core is
//     deterministic under test and the same inputs always produce byte-identical
//     output. A grep finds no fs / http / Date.now / no-argument Date construction.
//   * ZERO NEW DEPENDENCY. Requires ONLY node-core `crypto` and this repo's
//     `./evidence-plans` (which is the EVIDENCE plan catalog + fulfill). The
//     canonical-ISO grammar + epoch->ISO math are inlined here over node-core Date,
//     so nothing new is pulled in.
//   * DEFENSIVE AGAINST HOSTILE INPUT. `verifyProviderSignature` NEVER throws on a
//     malformed/forged/absent header or body — it returns `{ ok:false, reason }`
//     with a specific, stable reason code, and compares digests in CONSTANT TIME.
//     `parseEvidenceEvent` reads the RAW body string with its OWN strict JSON parser
//     that bounds size + depth and REJECTS duplicate object keys (a JSON smuggling
//     vector `JSON.parse` silently last-wins), and builds prototype-free objects.
//   * NAMED, LOCALIZED REJECTS. Every failure is a NAMED error (or reason code)
//     stating the SPECIFIC cause on the FIRST defect — never a silent pass, never a
//     partial/last-wins accept.
//
// HONEST POSTURE. This module authenticates + maps an inbound event; it does NOT
// call any provider API, does NOT deploy, and holds NO real key/secret — the real
// signing secret + vendor key and the deploy stay HUMAN-owned. A license is an
// ACCESS credential for delivered software value: NOT a token, NOT tradeable, NOT
// an appreciating asset. The binding is an operator-maintained routing table and
// makes NO claim of regulatory compliance. The subscription agreement governs.
// ---------------------------------------------------------------------------

const crypto = require("crypto");
const evidencePlans = require("./evidence-plans");

// ===========================================================================
// SHARED: named error + the canonical-ISO / epoch grammar (inlined, node-core only).
// ===========================================================================

// One named error for the intake seams (parse + normalize + config misuse). The
// binding has its OWN error type (below) so a caller can catch the routing-table
// class distinctly, exactly as TrustLedger separates PriceBindingError.
class FulfillIntakeError extends Error {
  constructor(message) {
    super(message);
    this.name = "FulfillIntakeError";
  }
}

// The strict canonical-instant grammar the evidence license consumes: millis
// REQUIRED, no rolled-over/impossible fields. Identical to cli/core/license.js's
// ISO_INSTANT_RE — inlined here so this module needs only node-core + evidence-plans.
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

// Beyond this a Date's toISOString throws; guarding it keeps the *1000 ms math exact
// and inside JS's safe-integer window. == Date max (ms) / 1000.
const MAX_EPOCH_SECONDS = 8640000000000;

// value -> epoch-ms, or throw FulfillIntakeError naming `field`. Mirrors the
// evidence-plans _requireCanonicalInstant grammar so a downstream buildLicense never
// re-surfaces a buried date error.
function _requireCanonicalInstant(field, value) {
  if (typeof value !== "string" || !ISO_INSTANT_RE.test(value)) {
    throw new FulfillIntakeError(
      `${field} must be an ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS(.mmm)Z"), got: ${String(value)}`
    );
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== value) {
    throw new FulfillIntakeError(
      `${field} must be a CANONICAL ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS.mmmZ", millis required, ` +
        `no rolled-over/impossible fields), got: ${String(value)}`
    );
  }
  return ms;
}

// UNIX epoch SECONDS -> canonical ISO. STRICT: a non-integer / negative /
// out-of-range epoch is a NAMED reject, never coerced or rounded.
function _epochSecondsToCanonicalISO(field, epochSeconds) {
  if (
    typeof epochSeconds !== "number" ||
    !Number.isInteger(epochSeconds) ||
    epochSeconds < 0 ||
    epochSeconds > MAX_EPOCH_SECONDS
  ) {
    throw new FulfillIntakeError(
      `${field} must be a non-negative INTEGER UNIX epoch in SECONDS (0..${MAX_EPOCH_SECONDS}), got: ${String(epochSeconds)}`
    );
  }
  return new Date(epochSeconds * 1000).toISOString();
}

// ===========================================================================
// SEAM 1 — verifyProviderSignature: authenticate the raw Stripe webhook.
// ===========================================================================
//
// Stripe (and Stripe-compatible providers) sign each delivery with a header
//   `Stripe-Signature: t=<unix-seconds>,v1=<hex>[,v1=<hex>...][,v0=<...>]`
// where each `v1` is `HMAC_SHA256(secret, "<t>.<rawBody>")` in lowercase hex. During
// a secret rotation MULTIPLE `v1`s can be present; ANY match authenticates. Verify:
//   1. the header is present + parseable into an integer `t` and >=1 `v1`;
//   2. some provided `v1` equals our recomputed HMAC (CONSTANT-TIME compare);
//   3. `t` is inside the replay window `|nowSec - t| <= toleranceSec`.
//
// `nowSec` is INJECTED (never read from the system clock) so the check is
// deterministic under test. On ANY malformed/forged/absent/expired input this NEVER
// throws — it returns `{ ok:false, reason }` with a stable, specific reason code.
// (Config misuse — a missing secret / non-integer nowSec — DOES throw, since that is
// a programmer error, not hostile network input.)

const DEFAULT_TOLERANCE_SEC = 300; // Stripe's own default replay window (5 minutes).

// Stable reason codes. "Localized" = a SPECIFIC cause per failure, not a generic
// "bad signature"; a caller/UI maps these to a message + a fixed exit posture.
const SIGNATURE_REASONS = Object.freeze({
  OK: "ok",
  MISSING_HEADER: "missing_signature_header",
  MALFORMED_HEADER: "malformed_signature_header",
  SIGNATURE_MISMATCH: "signature_mismatch",
  TIMESTAMP_OUT_OF_TOLERANCE: "timestamp_out_of_tolerance",
});

// Constant-time hex compare. timingSafeEqual requires equal-length buffers, so an
// unequal length is a definite non-match (the expected length — 64 for sha256 hex —
// is not secret). Never throws.
function _timingSafeHexEqual(aHex, bHex) {
  if (typeof aHex !== "string" || typeof bHex !== "string") return false;
  const a = Buffer.from(aHex, "utf8");
  const b = Buffer.from(bHex, "utf8");
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch (_e) {
    return false;
  }
}

// Parse `t=..,v1=..,v1=..` -> { t, v1s, dupT }. Collects ALL `v1`s. A DUPLICATE `t=`
// is flagged (`dupT`) so the caller can treat it as MALFORMED — mirroring the strict
// JSON parser's duplicate-key rejection instead of silently first-winning an ambiguous
// timestamp (a wrong `t` would only ever yield a mismatch, but ambiguity is a defect,
// not an accept path).
function _parseSignatureHeader(header) {
  let t = null;
  let dupT = false;
  const v1s = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") {
      if (t === null) t = v;
      else dupT = true;
    } else if (k === "v1") {
      if (v.length > 0) v1s.push(v);
    }
  }
  return { t, v1s, dupT };
}

/**
 * verifyProviderSignature(rawBody, sigHeader, secret, opts) — authenticate a raw
 * provider webhook. PURE + constant-time; NEVER throws on hostile header/body.
 *
 * @param {string|Buffer} rawBody  the EXACT raw request body the signature covers
 * @param {string} sigHeader       the `Stripe-Signature` header value (`t=..,v1=..`)
 * @param {string} secret          the endpoint signing secret (HMAC key)
 * @param {object} opts
 *   @param {number} opts.nowSec           REQUIRED current time as UNIX epoch SECONDS (injected clock)
 *   @param {number} [opts.toleranceSec]   replay window in seconds (default 300)
 * @returns {{ ok: boolean, reason: string, timestamp?: number }}
 */
function verifyProviderSignature(rawBody, sigHeader, secret, opts) {
  // ---- config validation (programmer error MAY throw) ----------------------
  if (typeof secret !== "string" || secret.length === 0) {
    throw new FulfillIntakeError(
      "verifyProviderSignature requires a non-empty signing secret string"
    );
  }
  if (opts == null || typeof opts !== "object" || Array.isArray(opts)) {
    throw new FulfillIntakeError(
      "verifyProviderSignature requires an opts object { nowSec, toleranceSec? }"
    );
  }
  if (typeof opts.nowSec !== "number" || !Number.isInteger(opts.nowSec)) {
    throw new FulfillIntakeError(
      "verifyProviderSignature requires an integer opts.nowSec (UNIX epoch seconds; the injected clock)"
    );
  }
  let toleranceSec = DEFAULT_TOLERANCE_SEC;
  if (opts.toleranceSec != null) {
    if (
      typeof opts.toleranceSec !== "number" ||
      !Number.isInteger(opts.toleranceSec) ||
      opts.toleranceSec < 0
    ) {
      throw new FulfillIntakeError(
        "verifyProviderSignature opts.toleranceSec, when given, must be a non-negative integer number of seconds"
      );
    }
    toleranceSec = opts.toleranceSec;
  }
  if (!(typeof rawBody === "string" || Buffer.isBuffer(rawBody))) {
    throw new FulfillIntakeError(
      "verifyProviderSignature requires rawBody to be a string or Buffer (the exact bytes the signature covers)"
    );
  }

  // ---- from here on, NEVER throw — hostile input yields { ok:false, reason } ----
  try {
    if (typeof sigHeader !== "string" || sigHeader.trim() === "") {
      return { ok: false, reason: SIGNATURE_REASONS.MISSING_HEADER };
    }
    const { t, v1s, dupT } = _parseSignatureHeader(sigHeader);
    if (dupT || t === null || !/^\d+$/.test(t) || v1s.length === 0) {
      return { ok: false, reason: SIGNATURE_REASONS.MALFORMED_HEADER };
    }
    const tNum = Number(t);
    if (!Number.isSafeInteger(tNum)) {
      return { ok: false, reason: SIGNATURE_REASONS.MALFORMED_HEADER };
    }

    // Recompute the expected HMAC over the signed payload `${t}.${rawBody}` and
    // compare against EVERY provided v1 in constant time (rotation-friendly). We
    // build the signed payload as bytes so a Buffer body is covered verbatim.
    const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
    const signedPayload = Buffer.concat([Buffer.from(`${t}.`, "utf8"), bodyBuf]);
    const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

    let matched = false;
    for (const candidate of v1s) {
      // OR-accumulate (no early break) so a match's position can't leak via timing.
      if (_timingSafeHexEqual(expected, candidate)) matched = true;
    }
    if (!matched) {
      return { ok: false, reason: SIGNATURE_REASONS.SIGNATURE_MISMATCH };
    }

    // Signature is authentic; enforce the replay window LAST so a forged event is
    // always a mismatch (never masqueraded as merely "expired").
    if (Math.abs(opts.nowSec - tNum) > toleranceSec) {
      return { ok: false, reason: SIGNATURE_REASONS.TIMESTAMP_OUT_OF_TOLERANCE };
    }

    return { ok: true, reason: SIGNATURE_REASONS.OK, timestamp: tNum };
  } catch (_e) {
    // Absolute belt-and-suspenders: any unexpected condition on hostile input is a
    // reject, never a throw and never a silent accept.
    return { ok: false, reason: SIGNATURE_REASONS.MALFORMED_HEADER };
  }
}

// ===========================================================================
// STRICT JSON PARSE — bounded size + depth, duplicate-key + prototype safe.
// ===========================================================================
//
// A webhook body is attacker-influenced. `JSON.parse` silently keeps the LAST value
// for a duplicated key (a smuggling vector: `{"type":"x","type":"invoice.paid"}`)
// and has no depth/size bound. This small recursive-descent parser closes those:
//   * REJECTS a body over `maxBytes` (measured on the raw string's UTF-8 length);
//   * REJECTS nesting deeper than `maxDepth` (adversarial stack blow-up);
//   * REJECTS a DUPLICATE key in ANY object (NAMED);
//   * builds objects with a NULL prototype so a `__proto__`/`constructor` key is an
//     inert own property, never prototype pollution.
// It accepts the standard JSON grammar (RFC 8259) and rejects trailing content.

const DEFAULT_MAX_BODY_BYTES = 256 * 1024; // generous vs. a real event (~a few KB).
const MAX_JSON_DEPTH = 64;

function _strictJsonParse(text, maxDepth) {
  let i = 0;
  const n = text.length;

  function err(msg) {
    return new FulfillIntakeError(`invalid webhook JSON: ${msg} at position ${i}`);
  }
  function skipWs() {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  }
  function parseValue(depth) {
    if (depth > maxDepth) throw err(`nesting exceeds max depth ${maxDepth}`);
    skipWs();
    if (i >= n) throw err("unexpected end of input");
    const c = text[i];
    if (c === "{") return parseObject(depth);
    if (c === "[") return parseArray(depth);
    if (c === '"') return parseString();
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    throw err(`unexpected token ${JSON.stringify(c)}`);
  }
  function parseObject(depth) {
    i++; // consume '{'
    const obj = Object.create(null);
    const seen = new Set();
    skipWs();
    if (text[i] === "}") {
      i++;
      return obj;
    }
    for (;;) {
      skipWs();
      if (text[i] !== '"') throw err("expected object key string");
      const key = parseString();
      if (seen.has(key)) {
        throw new FulfillIntakeError(
          `invalid webhook JSON: duplicate object key ${JSON.stringify(key)}`
        );
      }
      seen.add(key);
      skipWs();
      if (text[i] !== ":") throw err("expected ':' after object key");
      i++;
      const value = parseValue(depth + 1);
      // Own, enumerable, prototype-free assignment (null-proto obj => no pollution).
      Object.defineProperty(obj, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      skipWs();
      const ch = text[i];
      if (ch === ",") {
        i++;
        continue;
      }
      if (ch === "}") {
        i++;
        return obj;
      }
      throw err("expected ',' or '}' in object");
    }
  }
  function parseArray(depth) {
    i++; // consume '['
    const arr = [];
    skipWs();
    if (text[i] === "]") {
      i++;
      return arr;
    }
    for (;;) {
      arr.push(parseValue(depth + 1));
      skipWs();
      const ch = text[i];
      if (ch === ",") {
        i++;
        continue;
      }
      if (ch === "]") {
        i++;
        return arr;
      }
      throw err("expected ',' or ']' in array");
    }
  }
  function parseString() {
    i++; // consume opening quote
    let out = "";
    for (;;) {
      if (i >= n) throw err("unterminated string");
      const ch = text[i++];
      if (ch === '"') return out;
      if (ch === "\\") {
        if (i >= n) throw err("unterminated escape");
        const e = text[i++];
        if (e === '"') out += '"';
        else if (e === "\\") out += "\\";
        else if (e === "/") out += "/";
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "u") {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw err("invalid \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else throw err(`invalid escape \\${e}`);
      } else {
        const code = ch.charCodeAt(0);
        if (code < 0x20) throw err("unescaped control character in string");
        out += ch;
      }
    }
  }
  function parseNumber() {
    const start = i;
    if (text[i] === "-") i++;
    if (text[i] === "0") {
      i++;
    } else if (text[i] >= "1" && text[i] <= "9") {
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    } else {
      throw err("invalid number");
    }
    if (text[i] === ".") {
      i++;
      if (!(text[i] >= "0" && text[i] <= "9")) throw err("invalid fraction");
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (!(text[i] >= "0" && text[i] <= "9")) throw err("invalid exponent");
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    return Number(text.slice(start, i));
  }

  skipWs();
  const value = parseValue(0);
  skipWs();
  if (i !== n) throw err("unexpected trailing content");
  return value;
}

// Safe own-property read over a possibly null-prototype parsed object.
function _own(obj, key) {
  if (obj == null || typeof obj !== "object") return undefined;
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

// ===========================================================================
// SEAM 2a — parseEvidenceEvent: real Stripe body -> normalized envelope.
// ===========================================================================
//
// Maps a real-shaped Stripe event body to `{ provider, type, priceId, customer,
// periodEnd }`. Two event types are understood.
//
// STRIPE API-VERSION NOTE (why field extraction accepts TWO shapes). Stripe's
// 2025-03-31 ("Basil") API version MOVED two of the fields this bridge reads:
//   * a subscription's billing-cycle end moved from the single top-level
//     `subscription.current_period_end` to a PER-ITEM
//     `subscription.items.data[i].current_period_end`;
//   * an invoice line item's price moved from the expanded `line.price` object to
//     `line.pricing.price_details.price` (a bare price-id STRING).
// So a webhook endpoint on a MODERN default API version carries the new shapes, while
// an endpoint pinned to a pre-Basil version carries the legacy ones. To be a genuine
// DROP-IN bridge regardless of the account/endpoint's pinned `Stripe-Version`, the
// extractor below accepts BOTH; the operator does NOT have to pin an old API version.
//
//   * "invoice.paid"                  (a subscription renewal / first invoice)
//       priceId  <- line.price.id          (legacy)  OR
//                   line.pricing.price_details.price  (current, a bare id string)
//       periodEnd<- line.period.end        (epoch SECONDS; unchanged across versions)
//       customer <- data.object.customer
//     where `line` is the SELECTED line item (see line-selection note below), NOT
//     blindly data[0].
//
//   * "checkout.session.completed"    (with the subscription EXPANDED, as the
//                                       integrator configures `expand:['subscription']`)
//       priceId  <- item.price.id                     (legacy)  OR
//                   item.pricing.price_details.price   (current, a bare id string)
//       periodEnd<- item.current_period_end (current) OR
//                   subscription.current_period_end    (legacy)  (epoch SECONDS)
//       customer <- data.object.customer
//     where `item` is the SELECTED subscription item.
//
// LINE/ITEM SELECTION (why not positional [0]). A multi-item subscription or a
// proration invoice can carry MORE than one line; data[0] is not guaranteed to be the
// bound subscription line, so a blind [0] could silently mis-select the PLAN. When a
// list has >1 item this parser therefore: (a) with an `opts.binding`, selects the ONE
// item whose price is bound and NAMED-rejects if zero or more-than-one are bound
// (ambiguous); (b) without a binding, accepts only when every item shares one price
// and NAMED-rejects a mix of distinct prices (telling the operator to pass
// `opts.binding`). A single-item list is used directly (the common case).
//
// `provider` is fixed to "stripe" (this is the Stripe parser). The RAW body STRING
// is read (so size + duplicate-key defenses apply and the exact signed bytes are the
// thing parsed). NAMED-rejects an oversized body, malformed JSON, a duplicate key, an
// unknown/unsupported `type`, and any missing/mistyped required field.

const STRIPE_PROVIDER = "stripe";
const SUPPORTED_STRIPE_EVENT_TYPES = Object.freeze([
  "checkout.session.completed",
  "invoice.paid",
]);

function _requireEventString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new FulfillIntakeError(`event ${label} must be a non-empty string`);
  }
  return value;
}

// Navigate a Stripe list object (`{ object:'list', data:[...] }`) -> its non-empty
// `data` array, NAMED-rejecting a non-list, an empty list, or a non-object element.
function _requireListData(listObj, label) {
  const data = _own(listObj, "data");
  if (!Array.isArray(data) || data.length === 0) {
    throw new FulfillIntakeError(`event ${label} must be a non-empty { data: [...] } list`);
  }
  for (let idx = 0; idx < data.length; idx++) {
    const it = data[idx];
    if (it == null || typeof it !== "object" || Array.isArray(it)) {
      throw new FulfillIntakeError(`event ${label}.data[${idx}] must be an object`);
    }
  }
  return data;
}

// Extract a price id from a Stripe line item / subscription item, accepting BOTH the
// legacy `.price` (expanded object with an id, or a bare id string) shape AND the
// current (Basil, 2025-03-31+) `.pricing.price_details.price` (a bare id string)
// shape. Returns the id string, or null if none is present (a non-throwing probe used
// during multi-item scanning).
function _priceIdOf(node) {
  if (node == null || typeof node !== "object") return null;
  const price = _own(node, "price");
  if (price != null && typeof price === "object" && !Array.isArray(price)) {
    const id = _own(price, "id");
    if (typeof id === "string" && id.length > 0) return id;
  } else if (typeof price === "string" && price.length > 0) {
    return price;
  }
  const pricing = _own(node, "pricing");
  const details = _own(pricing, "price_details");
  const modern = _own(details, "price");
  if (typeof modern === "string" && modern.length > 0) return modern;
  return null;
}

// Same as _priceIdOf but NAMED-rejects a missing/mistyped price (the single-selected
// item path, where a good error message names the field).
function _requirePriceId(node, label) {
  const id = _priceIdOf(node);
  if (id == null) {
    throw new FulfillIntakeError(
      `event ${label} must carry a price id (either ${label}.price.id or ` +
        `${label}.pricing.price_details.price)`
    );
  }
  return id;
}

// Select the ONE relevant item from a (possibly multi-item) Stripe list, SAFELY —
// never a blind positional [0] when the choice is ambiguous. See the LINE/ITEM
// SELECTION note above for the rules.
function _selectBoundListItem(items, provider, binding, label) {
  if (items.length === 1) return items[0];
  const scanned = items.map((it) => ({ it, priceId: _priceIdOf(it) }));
  if (binding != null) {
    const bound = scanned.filter(
      (x) => x.priceId != null && _isBound(binding, provider, x.priceId)
    );
    if (bound.length === 1) return bound[0].it;
    if (bound.length === 0) {
      throw new FulfillIntakeError(
        `event ${label} has ${items.length} items but NONE carries a price bound in the ` +
          `supplied binding; cannot select the intended line`
      );
    }
    throw new FulfillIntakeError(
      `event ${label} has ${bound.length} items whose prices are ALL bound; the intended ` +
        `line is AMBIGUOUS — deliver one plan per event, or split the binding so only one ` +
        `price maps`
    );
  }
  const distinct = new Set(scanned.map((x) => x.priceId));
  if (distinct.size === 1 && !distinct.has(null)) return scanned[0].it;
  throw new FulfillIntakeError(
    `event ${label} has ${items.length} items spanning ${distinct.size} distinct prices; ` +
      `pass opts.binding so the intended (bound) line is selected unambiguously instead of ` +
      `positionally`
  );
}

// The subscription billing-cycle end, preferring the current PER-ITEM
// `current_period_end` and falling back to the legacy top-level one.
function _subscriptionPeriodEnd(sub, item) {
  const itemLevel = _own(item, "current_period_end");
  if (typeof itemLevel === "number") return itemLevel;
  const subLevel = _own(sub, "current_period_end");
  if (typeof subLevel === "number") return subLevel;
  throw new FulfillIntakeError(
    "event subscription period end is missing: expected either " +
      "`data.object.subscription.items.data[i].current_period_end` (current Stripe API) or " +
      "`data.object.subscription.current_period_end` (legacy API), as a UNIX epoch (seconds) number"
  );
}

/**
 * parseEvidenceEvent(rawBody, opts?) — real Stripe body STRING -> normalized envelope.
 *
 * @param {string} rawBody   the exact raw webhook body (the bytes the signature covers)
 * @param {object} [opts]
 *   @param {number} [opts.maxBytes]   reject a body larger than this (default 256 KiB)
 *   @param {object} [opts.binding]    a VALIDATED evidence price binding, used ONLY to
 *     disambiguate a MULTI-item invoice/subscription (select the bound line instead of
 *     positional [0]). Optional: a single-item body never needs it.
 * @returns {{ provider:'stripe', type:string, priceId:string, customer:string, periodEnd:number }}
 */
function parseEvidenceEvent(rawBody, opts) {
  if (typeof rawBody !== "string") {
    throw new FulfillIntakeError("parseEvidenceEvent requires the raw webhook body as a string");
  }
  let maxBytes = DEFAULT_MAX_BODY_BYTES;
  let binding = null;
  if (opts != null) {
    if (typeof opts !== "object" || Array.isArray(opts)) {
      throw new FulfillIntakeError("parseEvidenceEvent opts, when given, must be an object { maxBytes?, binding? }");
    }
    if (opts.maxBytes != null) {
      if (typeof opts.maxBytes !== "number" || !Number.isInteger(opts.maxBytes) || opts.maxBytes <= 0) {
        throw new FulfillIntakeError("parseEvidenceEvent opts.maxBytes must be a positive integer");
      }
      maxBytes = opts.maxBytes;
    }
    if (opts.binding != null) {
      if (
        typeof opts.binding !== "object" ||
        Array.isArray(opts.binding) ||
        opts.binding._byKey == null ||
        typeof opts.binding._byKey !== "object"
      ) {
        throw new FulfillIntakeError(
          "parseEvidenceEvent opts.binding, when given, must be a validated evidence price binding (from validateEvidencePriceBinding)"
        );
      }
      binding = opts.binding;
    }
  }

  const bodyBytes = Buffer.byteLength(rawBody, "utf8");
  if (bodyBytes > maxBytes) {
    throw new FulfillIntakeError(
      `webhook body is oversized: ${bodyBytes} bytes exceeds the ${maxBytes}-byte limit`
    );
  }

  const evt = _strictJsonParse(rawBody, MAX_JSON_DEPTH);
  if (evt == null || typeof evt !== "object" || Array.isArray(evt)) {
    throw new FulfillIntakeError("webhook body must be a JSON object");
  }

  const type = _own(evt, "type");
  if (typeof type !== "string" || type.length === 0) {
    throw new FulfillIntakeError("event `type` must be a non-empty string");
  }
  if (!SUPPORTED_STRIPE_EVENT_TYPES.includes(type)) {
    throw new FulfillIntakeError(
      `unsupported event type ${JSON.stringify(type)}; this handler understands: ${SUPPORTED_STRIPE_EVENT_TYPES.join(", ")}`
    );
  }

  const data = _own(evt, "data");
  const object = _own(data, "object");
  if (object == null || typeof object !== "object" || Array.isArray(object)) {
    throw new FulfillIntakeError("event `data.object` must be an object");
  }

  const customer = _requireEventString(_own(object, "customer"), "data.object.customer");

  let priceId;
  let periodEnd;
  if (type === "invoice.paid") {
    const lineItems = _requireListData(_own(object, "lines"), "data.object.lines");
    const line = _selectBoundListItem(lineItems, STRIPE_PROVIDER, binding, "data.object.lines");
    priceId = _requirePriceId(line, "data.object.lines.data[0]");
    const period = _own(line, "period");
    periodEnd = _own(period, "end");
    if (typeof periodEnd !== "number") {
      throw new FulfillIntakeError(
        "event `data.object.lines.data[0].period.end` must be a UNIX epoch (seconds) number"
      );
    }
  } else {
    // checkout.session.completed with the subscription expanded.
    const sub = _own(object, "subscription");
    if (sub == null || typeof sub !== "object" || Array.isArray(sub)) {
      throw new FulfillIntakeError(
        "event `data.object.subscription` must be an expanded subscription object " +
          "(configure Stripe Checkout with expand:['subscription'])"
      );
    }
    const subItems = _requireListData(_own(sub, "items"), "data.object.subscription.items");
    const item = _selectBoundListItem(
      subItems,
      STRIPE_PROVIDER,
      binding,
      "data.object.subscription.items"
    );
    priceId = _requirePriceId(item, "data.object.subscription.items.data[0]");
    periodEnd = _subscriptionPeriodEnd(sub, item);
  }

  // Validate the epoch grammar EAGERLY here (a fractional/negative/absurd epoch is a
  // NAMED reject at parse time, never carried forward to bite normalize).
  if (!Number.isInteger(periodEnd) || periodEnd < 0 || periodEnd > MAX_EPOCH_SECONDS) {
    throw new FulfillIntakeError(
      `event periodEnd must be a non-negative INTEGER UNIX epoch in SECONDS (0..${MAX_EPOCH_SECONDS}), got: ${String(periodEnd)}`
    );
  }

  return { provider: STRIPE_PROVIDER, type, priceId, customer, periodEnd };
}

// ===========================================================================
// SEAM 2b — the EVIDENCE price binding: (provider, priceId) -> OUR planId.
// ===========================================================================
//
// Mirrors trustledger/plans.js's price binding EXACTLY but is bound to the EVIDENCE
// catalog: every mapping's planId is checked against the SUPPLIED (validated) EVIDENCE
// plan catalog via evidencePlans.getEvidencePlan, so a price can NEVER resolve to a
// plan the catalog does not define, and the binding's OWN kind is disjoint from every
// other payload in the tree.

const EVIDENCE_PRICE_BINDING_KIND = "vh-evidence-price-binding";
const EVIDENCE_PRICE_BINDING_SCHEMA_VERSION = 1;
const SUPPORTED_EVIDENCE_PRICE_BINDING_SCHEMA_VERSIONS = Object.freeze([1]);

class EvidencePriceBindingError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvidencePriceBindingError";
  }
}

const _BINDING_KEY_SEP = "\u0000"; // NUL — forbidden in a provider/priceId below.
function _bindingKey(provider, priceId) {
  return `${provider}${_BINDING_KEY_SEP}${priceId}`;
}

// Non-throwing predicate: is (provider, priceId) present in a VALIDATED binding?
// Used by multi-item line selection to pick the bound line. A malformed provider/
// priceId simply isn't bound (false); the binding must already carry `_byKey`.
function _isBound(binding, provider, priceId) {
  if (
    binding == null ||
    typeof binding !== "object" ||
    binding._byKey == null ||
    typeof binding._byKey !== "object"
  ) {
    return false;
  }
  if (typeof provider !== "string" || provider.length === 0) return false;
  if (typeof priceId !== "string" || priceId.length === 0) return false;
  return Object.prototype.hasOwnProperty.call(binding._byKey, _bindingKey(provider, priceId));
}

function _validateEvidenceMapping(mapping, index, catalog) {
  const at = `mapping[${index}]`;
  if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw new EvidencePriceBindingError(`${at} must be an object`);
  }
  if (typeof mapping.provider !== "string" || mapping.provider.trim() === "") {
    throw new EvidencePriceBindingError(`${at}.provider must be a non-empty string`);
  }
  if (mapping.provider.includes(_BINDING_KEY_SEP)) {
    throw new EvidencePriceBindingError(`${at}.provider must not contain a NUL character`);
  }
  const provider = mapping.provider;

  if (typeof mapping.priceId !== "string" || mapping.priceId.trim() === "") {
    throw new EvidencePriceBindingError(
      `${at} (provider ${JSON.stringify(provider)}) priceId must be a non-empty string`
    );
  }
  if (mapping.priceId.includes(_BINDING_KEY_SEP)) {
    throw new EvidencePriceBindingError(
      `${at} (provider ${JSON.stringify(provider)}) priceId must not contain a NUL character`
    );
  }
  const priceId = mapping.priceId;

  if (typeof mapping.planId !== "string" || mapping.planId.trim() === "") {
    throw new EvidencePriceBindingError(
      `${at} (provider ${JSON.stringify(provider)}, priceId ${JSON.stringify(priceId)}) ` +
        `planId must be a non-empty string`
    );
  }
  const planId = mapping.planId;
  // The EVIDENCE catalog is the single authority for valid planIds.
  try {
    evidencePlans.getEvidencePlan(catalog, planId);
  } catch (_e) {
    const known = Object.keys(catalog.plansById).sort().join(", ");
    throw new EvidencePriceBindingError(
      `${at} (provider ${JSON.stringify(provider)}, priceId ${JSON.stringify(priceId)}) ` +
        `points at planId ${JSON.stringify(planId)} which is NOT in the supplied evidence catalog; ` +
        `known plans are: ${known}`
    );
  }

  return Object.freeze({ provider, priceId, planId });
}

/**
 * validateEvidencePriceBinding(obj, catalog) -> validated, deeply-FROZEN binding.
 * `catalog` MUST be a validated EVIDENCE plan catalog (the authority for planIds).
 * Throws EvidencePriceBindingError on the FIRST defect. Never mutates either input.
 */
function validateEvidencePriceBinding(obj, catalog) {
  if (
    catalog === null ||
    typeof catalog !== "object" ||
    catalog.plansById === null ||
    typeof catalog.plansById !== "object"
  ) {
    throw new EvidencePriceBindingError(
      "validateEvidencePriceBinding requires a validated evidence plan catalog (the single source of valid planIds)"
    );
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new EvidencePriceBindingError("evidence price binding must be a JSON object");
  }
  if (obj.kind !== EVIDENCE_PRICE_BINDING_KIND) {
    throw new EvidencePriceBindingError(
      `evidence price binding has wrong kind ${JSON.stringify(obj.kind)}; ` +
        `expected ${JSON.stringify(EVIDENCE_PRICE_BINDING_KIND)}`
    );
  }
  if (!Object.prototype.hasOwnProperty.call(obj, "schemaVersion")) {
    throw new EvidencePriceBindingError("evidence price binding is missing required field: schemaVersion");
  }
  if (!SUPPORTED_EVIDENCE_PRICE_BINDING_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new EvidencePriceBindingError(
      `unsupported evidence price binding schemaVersion ${JSON.stringify(obj.schemaVersion)}; ` +
        `this build understands: ${SUPPORTED_EVIDENCE_PRICE_BINDING_SCHEMA_VERSIONS.join(", ")}`
    );
  }
  if (!Object.prototype.hasOwnProperty.call(obj, "mappings")) {
    throw new EvidencePriceBindingError("evidence price binding is missing required field: mappings");
  }
  if (!Array.isArray(obj.mappings)) {
    throw new EvidencePriceBindingError("evidence price binding mappings must be an array");
  }
  if (obj.mappings.length === 0) {
    throw new EvidencePriceBindingError("evidence price binding mappings must be a non-empty array");
  }

  const byKey = new Map();
  for (let idx = 0; idx < obj.mappings.length; idx++) {
    const mapping = _validateEvidenceMapping(obj.mappings[idx], idx, catalog);
    const key = _bindingKey(mapping.provider, mapping.priceId);
    if (byKey.has(key)) {
      throw new EvidencePriceBindingError(
        `evidence price binding has duplicate (provider, priceId) ` +
          `(${JSON.stringify(mapping.provider)}, ${JSON.stringify(mapping.priceId)})`
      );
    }
    byKey.set(key, mapping);
  }

  const sortedKeys = [...byKey.keys()].sort();
  const mappings = Object.freeze(sortedKeys.map((k) => byKey.get(k)));
  const byKeyObj = Object.freeze(
    sortedKeys.reduce((m, k) => {
      m[k] = byKey.get(k);
      return m;
    }, Object.create(null))
  );

  const result = {
    kind: EVIDENCE_PRICE_BINDING_KIND,
    schemaVersion: obj.schemaVersion,
    mappings,
  };
  // The NUL-keyed lookup index stays OFF the public/serialized surface.
  Object.defineProperty(result, "_byKey", {
    value: byKeyObj,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(result);
}

/**
 * resolveEvidencePlanId(binding, provider, priceId) -> the bound planId, or a NAMED
 * reject for an unmapped pair. PURE lookup against a VALIDATED binding.
 */
function resolveEvidencePlanId(binding, provider, priceId) {
  if (
    binding === null ||
    typeof binding !== "object" ||
    binding._byKey === null ||
    typeof binding._byKey !== "object"
  ) {
    throw new EvidencePriceBindingError("resolveEvidencePlanId requires a validated evidence price binding");
  }
  if (typeof provider !== "string" || provider.trim() === "") {
    throw new EvidencePriceBindingError("resolveEvidencePlanId requires a non-empty provider");
  }
  if (typeof priceId !== "string" || priceId.trim() === "") {
    throw new EvidencePriceBindingError("resolveEvidencePlanId requires a non-empty priceId");
  }
  const key = _bindingKey(provider, priceId);
  if (!Object.prototype.hasOwnProperty.call(binding._byKey, key)) {
    throw new EvidencePriceBindingError(
      `no evidence plan bound for (provider ${JSON.stringify(provider)}, ` +
        `priceId ${JSON.stringify(priceId)}); the price binding has no such mapping`
    );
  }
  return binding._byKey[key].planId;
}

// ===========================================================================
// SEAM 2c — normalizeEvidenceEvent + intakeDedupKey.
// ===========================================================================

/**
 * normalizeEvidenceEvent(event, binding, opts) — PURE, DETERMINISTIC map of a parsed
 * event envelope (parseEvidenceEvent output) onto the EXACT
 * `{ plan, customer, paidThrough, issuedAt }` order `fulfillEvidenceOrder` consumes.
 *
 * `issuedAt` is INJECTED via `opts.issuedAt` (the caller — who knows the wall clock —
 * supplies it); the core NEVER reads the system clock, so the same event + binding +
 * opts yields a byte-identical order every time. `paidThrough` is the canonical ISO of
 * the event's `periodEnd` (UNIX epoch seconds). An unmapped (provider, priceId) is a
 * NAMED reject naming the pair.
 *
 * @param {object} event   parseEvidenceEvent output { provider, priceId, customer, periodEnd, ... }
 * @param {object} binding a VALIDATED evidence price binding
 * @param {object} opts
 *   @param {string} opts.issuedAt  REQUIRED canonical ISO instant the license is issued at
 * @returns {{ plan:string, customer:string, paidThrough:string, issuedAt:string }}
 */
function normalizeEvidenceEvent(event, binding, opts) {
  if (event == null || typeof event !== "object" || Array.isArray(event)) {
    throw new FulfillIntakeError(
      "normalizeEvidenceEvent requires a parsed event { provider, priceId, customer, periodEnd }"
    );
  }
  if (opts == null || typeof opts !== "object" || Array.isArray(opts)) {
    throw new FulfillIntakeError(
      "normalizeEvidenceEvent requires an opts object { issuedAt } (the injected clock; the core never reads it)"
    );
  }

  if (typeof event.provider !== "string" || event.provider.trim() === "") {
    throw new FulfillIntakeError("event `provider` must be a non-empty string");
  }
  if (typeof event.priceId !== "string" || event.priceId.trim() === "") {
    throw new FulfillIntakeError("event `priceId` must be a non-empty string");
  }
  let planId;
  try {
    planId = resolveEvidencePlanId(binding, event.provider, event.priceId);
  } catch (e) {
    // Surface the binding's NAMED reason, but as a FulfillIntakeError so a handler
    // catches ONE error type across the normalize seam.
    throw new FulfillIntakeError(
      `cannot normalize event: ${e && e.message ? e.message : String(e)}`
    );
  }

  if (typeof event.customer !== "string" || event.customer.length === 0) {
    throw new FulfillIntakeError("event `customer` must be a non-empty string");
  }

  const paidThrough = _epochSecondsToCanonicalISO("periodEnd", event.periodEnd);

  if (opts.issuedAt == null) {
    throw new FulfillIntakeError(
      "normalizeEvidenceEvent requires opts.issuedAt (a canonical ISO instant); the core never reads the system clock"
    );
  }
  _requireCanonicalInstant("issuedAt", opts.issuedAt);

  // The EXACT order shape fulfillEvidenceOrder consumes; provider event `type` is
  // advisory and intentionally NOT carried into the (provider-agnostic) order.
  return {
    plan: planId,
    customer: event.customer,
    paidThrough,
    issuedAt: opts.issuedAt,
  };
}

/**
 * intakeDedupKey(event) — the retry-stable idempotency key for an at-least-once
 * delivery. Derived ONLY from the event's own retry-stable content (provider, type,
 * priceId, customer, periodEnd) — NOT from the injected issuedAt — so the SAME event
 * delivered twice yields the IDENTICAL key, while a different customer / price /
 * period yields a DISTINCT key. Fields are JSON-encoded before hashing so a value can
 * never smuggle a delimiter to collide with another event.
 *
 * @param {object} event  parseEvidenceEvent output
 * @returns {string} `vh-ev-intake:sha256:<hex>`
 */
function intakeDedupKey(event) {
  if (event == null || typeof event !== "object" || Array.isArray(event)) {
    throw new FulfillIntakeError("intakeDedupKey requires a parsed event object");
  }
  const provider = event.provider;
  const type = event.type;
  const priceId = event.priceId;
  const customer = event.customer;
  const periodEnd = event.periodEnd;
  if (typeof provider !== "string" || provider.length === 0) {
    throw new FulfillIntakeError("intakeDedupKey: event `provider` must be a non-empty string");
  }
  if (typeof priceId !== "string" || priceId.length === 0) {
    throw new FulfillIntakeError("intakeDedupKey: event `priceId` must be a non-empty string");
  }
  if (typeof customer !== "string" || customer.length === 0) {
    throw new FulfillIntakeError("intakeDedupKey: event `customer` must be a non-empty string");
  }
  if (typeof periodEnd !== "number" || !Number.isInteger(periodEnd)) {
    throw new FulfillIntakeError("intakeDedupKey: event `periodEnd` must be an integer epoch");
  }
  // Deterministic, injection-safe canonical form (JSON-encoded, fixed field order).
  const canonical = JSON.stringify([
    provider,
    typeof type === "string" ? type : null,
    priceId,
    customer,
    periodEnd,
  ]);
  const hex = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
  return `vh-ev-intake:sha256:${hex}`;
}

module.exports = {
  // shared
  FulfillIntakeError,
  // seam 1
  DEFAULT_TOLERANCE_SEC,
  SIGNATURE_REASONS,
  verifyProviderSignature,
  // seam 2a
  STRIPE_PROVIDER,
  SUPPORTED_STRIPE_EVENT_TYPES,
  DEFAULT_MAX_BODY_BYTES,
  parseEvidenceEvent,
  // seam 2b
  EVIDENCE_PRICE_BINDING_KIND,
  EVIDENCE_PRICE_BINDING_SCHEMA_VERSION,
  SUPPORTED_EVIDENCE_PRICE_BINDING_SCHEMA_VERSIONS,
  EvidencePriceBindingError,
  validateEvidencePriceBinding,
  resolveEvidencePlanId,
  // seam 2c
  normalizeEvidenceEvent,
  intakeDedupKey,
};
