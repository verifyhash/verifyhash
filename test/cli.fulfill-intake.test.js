"use strict";

// cli/core/fulfill-intake.js tests — THE SELF-SERVE FULFILLMENT-INTAKE CORE (T-62.1).
//
// FUNCTION-LEVEL, PURE / OFFLINE. The module is pure (no fs / net / clock / key). The
// wall clock is INJECTED. The ONLY key/secret material is SYNTHETIC and EPHEMERAL:
//   * a SYNTHETIC webhook signing secret string ("whsec_TEST_...") — never a real one;
//   * SYNTHETIC provider events (hand-built real-shaped Stripe bodies);
//   * an in-process Wallet.createRandom() used ONLY to prove the whole pipeline
//     round-trips through the existing evidence buildLicense/verifyLicense gate.
// These tests prove the five acceptance seams:
//   (1) verifyProviderSignature ACCEPTS a correctly-signed `${t}.${rawBody}` and
//       REJECTS — with the specific reason — a missing header, a malformed header, a
//       forged v1, and a `t` outside toleranceSec; it never throws on hostile input
//       and compares in constant time;
//   (2) parseEvidenceEvent maps a real-shaped invoice.paid / checkout.session.completed
//       body to { provider, type, priceId, customer, periodEnd } and NAMED-rejects a
//       malformed / oversized / unknown-type / duplicate-field body;
//   (3) validateEvidencePriceBinding accepts a valid binding and rejects unknown-plan /
//       duplicate-price / malformed binding; resolveEvidencePlanId NAMED-rejects an
//       unmapped (provider, priceId);
//   (4) normalizeEvidenceEvent(parse(...), binding) fed to fulfillEvidenceOrder yields
//       a byte-identical license-params object across repeated runs (no clock leak),
//       paidThrough equals the canonical ISO of periodEnd, and the params round-trip
//       through evidence.buildLicense + evidence.verifyLicense;
//   (5) intakeDedupKey is stable for the same event and distinct for a different
//       customer / price / period.
// The module source is grepped for I/O / clock use (purity).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { expect } = require("chai");
const { Wallet } = require("ethers");

const intake = require("../cli/core/fulfill-intake");
const evidencePlans = require("../cli/core/evidence-plans");
const evidence = require("../cli/evidence");

const {
  FulfillIntakeError,
  SIGNATURE_REASONS,
  verifyProviderSignature,
  SUPPORTED_STRIPE_EVENT_TYPES,
  parseEvidenceEvent,
  EVIDENCE_PRICE_BINDING_KIND,
  EvidencePriceBindingError,
  validateEvidencePriceBinding,
  resolveEvidencePlanId,
  normalizeEvidenceEvent,
  intakeDedupKey,
} = intake;

// ---------------------------------------------------------------------------
// Fixtures: the bundled DRAFT evidence catalog + a hand-built price binding onto it.
// The TEST does the I/O; the modules stay pure.
// ---------------------------------------------------------------------------
const BASELINE_PATH = path.join(
  __dirname,
  "..",
  "cli",
  "core",
  "fixtures",
  "evidence-plans",
  "baseline.json"
);
const BASELINE_TEXT = fs.readFileSync(BASELINE_PATH, "utf8");

// A SYNTHETIC signing secret — never a real Stripe secret.
const SECRET = "whsec_TEST_0123456789abcdef0123456789abcdef";

// 1798761600 == 2027-01-01T00:00:00.000Z as a UNIX epoch in SECONDS.
const PERIOD_END_EPOCH = 1798761600;
const PERIOD_END_ISO = "2027-01-01T00:00:00.000Z";
const ISSUED = "2026-01-01T00:00:00.000Z";

function catalog() {
  return evidencePlans.validateEvidencePlanCatalog(JSON.parse(BASELINE_TEXT));
}

// A binding over the two DRAFT baseline plans.
function bindingObj() {
  return {
    kind: EVIDENCE_PRICE_BINDING_KIND,
    schemaVersion: 1,
    mappings: [
      {
        provider: "stripe",
        priceId: "price_evidence_signed_monthly",
        planId: "evidence-signed-monthly",
      },
      {
        provider: "stripe",
        priceId: "price_evidence_pro_annual",
        planId: "evidence-pro-annual",
      },
    ],
  };
}
function binding() {
  return validateEvidencePriceBinding(bindingObj(), catalog());
}

// Real-shaped Stripe `invoice.paid` body -> price_evidence_pro_annual.
function invoicePaidBody(over = {}) {
  const body = {
    id: "evt_invoice_1",
    object: "event",
    type: "invoice.paid",
    created: 1735689600,
    data: {
      object: {
        id: "in_123",
        object: "invoice",
        customer: over.customer || "cus_ACME",
        lines: {
          object: "list",
          data: [
            {
              id: "il_1",
              price: { id: over.priceId || "price_evidence_pro_annual", object: "price" },
              period: { start: 1735689600, end: over.periodEnd || PERIOD_END_EPOCH },
            },
          ],
        },
      },
    },
  };
  return JSON.stringify(body);
}

// Real-shaped Stripe `checkout.session.completed` body (subscription EXPANDED)
// -> price_evidence_signed_monthly.
function checkoutCompletedBody(over = {}) {
  const body = {
    id: "evt_checkout_1",
    object: "event",
    type: "checkout.session.completed",
    created: 1735689600,
    data: {
      object: {
        id: "cs_123",
        object: "checkout.session",
        customer: over.customer || "cus_BETA",
        mode: "subscription",
        subscription: {
          id: "sub_123",
          object: "subscription",
          current_period_end: over.periodEnd || PERIOD_END_EPOCH,
          items: {
            object: "list",
            data: [
              {
                id: "si_1",
                price: {
                  id: over.priceId || "price_evidence_signed_monthly",
                  object: "price",
                },
              },
            ],
          },
        },
      },
    },
  };
  return JSON.stringify(body);
}

// MODERN (Basil, 2025-03-31+) `invoice.paid` body: the line item's price lives at
// `pricing.price_details.price` (a bare id string), NOT `price.id`.
function invoicePaidBodyModern(over = {}) {
  const body = {
    id: "evt_invoice_modern",
    object: "event",
    type: "invoice.paid",
    created: 1735689600,
    data: {
      object: {
        id: "in_modern",
        object: "invoice",
        customer: over.customer || "cus_MODERN",
        lines: {
          object: "list",
          data: [
            {
              id: "il_modern",
              pricing: {
                type: "price_details",
                price_details: {
                  price: over.priceId || "price_evidence_pro_annual",
                  product: "prod_x",
                },
              },
              period: { start: 1735689600, end: over.periodEnd || PERIOD_END_EPOCH },
            },
          ],
        },
      },
    },
  };
  return JSON.stringify(body);
}

// MODERN checkout body: NO top-level subscription.current_period_end; the cycle end
// lives PER-ITEM at subscription.items.data[i].current_period_end.
function checkoutCompletedBodyModern(over = {}) {
  const body = {
    id: "evt_checkout_modern",
    object: "event",
    type: "checkout.session.completed",
    created: 1735689600,
    data: {
      object: {
        id: "cs_modern",
        object: "checkout.session",
        customer: over.customer || "cus_MODERNC",
        mode: "subscription",
        subscription: {
          id: "sub_modern",
          object: "subscription",
          // deliberately NO top-level current_period_end (modern API moved it per-item)
          items: {
            object: "list",
            data: [
              {
                id: "si_modern",
                current_period_end: over.periodEnd || PERIOD_END_EPOCH,
                price: {
                  id: over.priceId || "price_evidence_signed_monthly",
                  object: "price",
                },
              },
            ],
          },
        },
      },
    },
  };
  return JSON.stringify(body);
}

// A single invoice line for building multi-line fixtures.
function invoiceLine(priceId, end) {
  return { id: `il_${priceId}`, price: { id: priceId }, period: { start: 1, end } };
}
// A multi-line `invoice.paid` body from an explicit list of lines.
function invoiceMultiLineBody(lines, over = {}) {
  const body = {
    type: "invoice.paid",
    data: {
      object: {
        customer: over.customer || "cus_MULTI",
        lines: { object: "list", data: lines },
      },
    },
  };
  return JSON.stringify(body);
}

// Independent (module-agnostic) signer: compute the Stripe `t=..,v1=..` header the
// SAME way Stripe does, so acceptance is proven against an EXTERNAL construction.
function signHeader(rawBody, secret, t) {
  const v1 = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

// ===========================================================================
// (1) verifyProviderSignature — authenticate the raw webhook.
// ===========================================================================
describe("fulfill-intake T-62.1 (1): verifyProviderSignature", () => {
  const NOW = 1735689600; // an injected clock, epoch seconds
  const body = invoicePaidBody();

  it("ACCEPTS a correctly-signed `${t}.${rawBody}` inside the tolerance window", () => {
    const header = signHeader(body, SECRET, NOW);
    const res = verifyProviderSignature(body, header, SECRET, { nowSec: NOW });
    expect(res.ok).to.equal(true);
    expect(res.reason).to.equal(SIGNATURE_REASONS.OK);
    expect(res.timestamp).to.equal(NOW);
  });

  it("accepts when signed at the exact tolerance edge and rejects one second past it", () => {
    const t = NOW - 300; // exactly toleranceSec away (default 300)
    const header = signHeader(body, SECRET, t);
    expect(verifyProviderSignature(body, header, SECRET, { nowSec: NOW }).ok).to.equal(true);
    // 301s away — correctly signed but OUTSIDE the replay window.
    const t2 = NOW - 301;
    const header2 = signHeader(body, SECRET, t2);
    const res = verifyProviderSignature(body, header2, SECRET, { nowSec: NOW });
    expect(res.ok).to.equal(false);
    expect(res.reason).to.equal(SIGNATURE_REASONS.TIMESTAMP_OUT_OF_TOLERANCE);
  });

  it("REJECTS a missing header (null / undefined / empty / blank) as missing_signature_header", () => {
    for (const h of [null, undefined, "", "   "]) {
      const res = verifyProviderSignature(body, h, SECRET, { nowSec: NOW });
      expect(res.ok, `header=${JSON.stringify(h)}`).to.equal(false);
      expect(res.reason).to.equal(SIGNATURE_REASONS.MISSING_HEADER);
    }
  });

  it("REJECTS a malformed header (no t / no v1 / non-integer t / junk) as malformed_signature_header", () => {
    const malformed = [
      "not-a-signature-header",
      "v1=deadbeef", // no t
      `t=${NOW}`, // no v1
      "t=notanumber,v1=deadbeef", // non-integer t
      "t=,v1=deadbeef", // empty t
      "=,=", // no keys
    ];
    for (const h of malformed) {
      const res = verifyProviderSignature(body, h, SECRET, { nowSec: NOW });
      expect(res.ok, `header=${JSON.stringify(h)}`).to.equal(false);
      expect(res.reason, `header=${JSON.stringify(h)}`).to.equal(
        SIGNATURE_REASONS.MALFORMED_HEADER
      );
    }
  });

  it("treats a DUPLICATE t= in the signature header as MALFORMED_HEADER (strict-parse consistency)", () => {
    // The strict JSON parser rejects a duplicate key; the signature-header parser is
    // now consistent — an ambiguous, repeated `t=` is MALFORMED, not silently first-won.
    const good = crypto.createHmac("sha256", SECRET).update(`${NOW}.${body}`).digest("hex");
    const header = `t=${NOW},t=${NOW},v1=${good}`;
    const res = verifyProviderSignature(body, header, SECRET, { nowSec: NOW });
    expect(res.ok).to.equal(false);
    expect(res.reason).to.equal(SIGNATURE_REASONS.MALFORMED_HEADER);
    // Even a duplicate t whose FIRST value would validate is rejected (no first-win accept).
    const header2 = `t=${NOW},t=99,v1=${good}`;
    expect(verifyProviderSignature(body, header2, SECRET, { nowSec: NOW }).reason).to.equal(
      SIGNATURE_REASONS.MALFORMED_HEADER
    );
  });

  it("REJECTS a forged v1 (wrong secret, SAME-length hex) as signature_mismatch (constant-time path)", () => {
    // Signed with a DIFFERENT secret -> a well-formed, 64-char hex v1 that does NOT
    // match; exercises the equal-length timingSafeEqual branch.
    const forged = signHeader(body, "whsec_TEST_WRONG_SECRET", NOW);
    const res = verifyProviderSignature(body, forged, SECRET, { nowSec: NOW });
    expect(res.ok).to.equal(false);
    expect(res.reason).to.equal(SIGNATURE_REASONS.SIGNATURE_MISMATCH);
  });

  it("REJECTS a tampered body under an otherwise-valid signature (signature_mismatch)", () => {
    const header = signHeader(body, SECRET, NOW);
    const tampered = body.replace("cus_ACME", "cus_ATTACKER");
    const res = verifyProviderSignature(tampered, header, SECRET, { nowSec: NOW });
    expect(res.ok).to.equal(false);
    expect(res.reason).to.equal(SIGNATURE_REASONS.SIGNATURE_MISMATCH);
  });

  it("accepts when ANY of several v1 candidates matches (rotation-friendly)", () => {
    const good = crypto.createHmac("sha256", SECRET).update(`${NOW}.${body}`).digest("hex");
    const header = `t=${NOW},v1=${"0".repeat(64)},v1=${good}`;
    const res = verifyProviderSignature(body, header, SECRET, { nowSec: NOW });
    expect(res.ok).to.equal(true);
  });

  it("honors a custom toleranceSec", () => {
    const t = NOW - 10;
    const header = signHeader(body, SECRET, t);
    // tolerance 5 -> 10s away is rejected
    expect(
      verifyProviderSignature(body, header, SECRET, { nowSec: NOW, toleranceSec: 5 }).reason
    ).to.equal(SIGNATURE_REASONS.TIMESTAMP_OUT_OF_TOLERANCE);
    // tolerance 60 -> accepted
    expect(
      verifyProviderSignature(body, header, SECRET, { nowSec: NOW, toleranceSec: 60 }).ok
    ).to.equal(true);
  });

  it("NEVER throws on hostile header/body input (returns a reject instead)", () => {
    const hostile = [
      "t=1,v1=" + "z".repeat(64), // non-hex, same length
      "t=1,v1=", // empty v1 value
      "t=9999999999999999999999,v1=deadbeef", // absurd (unsafe-integer) t
      "t=1,t=2,v1=deadbeef", // duplicate t
      "   ",
      "t=1;v1=deadbeef", // wrong delimiter
      "🙈".repeat(50),
    ];
    for (const h of hostile) {
      expect(() =>
        verifyProviderSignature(body, h, SECRET, { nowSec: NOW })
      ).to.not.throw();
      const res = verifyProviderSignature(body, h, SECRET, { nowSec: NOW });
      expect(res.ok, `header=${JSON.stringify(h)}`).to.equal(false);
    }
    // A Buffer body is accepted verbatim (the signed bytes are covered).
    const buf = Buffer.from(body, "utf8");
    const header = signHeader(body, SECRET, NOW);
    expect(verifyProviderSignature(buf, header, SECRET, { nowSec: NOW }).ok).to.equal(true);
  });

  it("THROWS a NAMED error on CONFIG misuse (missing secret / non-integer nowSec)", () => {
    const header = signHeader(body, SECRET, NOW);
    expect(() => verifyProviderSignature(body, header, "", { nowSec: NOW })).to.throw(
      FulfillIntakeError
    );
    expect(() => verifyProviderSignature(body, header, SECRET, {})).to.throw(
      FulfillIntakeError
    );
    expect(() =>
      verifyProviderSignature(body, header, SECRET, { nowSec: 1.5 })
    ).to.throw(FulfillIntakeError);
  });
});

// ===========================================================================
// (2) parseEvidenceEvent — real Stripe body -> normalized envelope.
// ===========================================================================
describe("fulfill-intake T-62.1 (2): parseEvidenceEvent", () => {
  it("maps a real-shaped invoice.paid body to the normalized envelope", () => {
    const env = parseEvidenceEvent(invoicePaidBody());
    expect(env).to.deep.equal({
      provider: "stripe",
      type: "invoice.paid",
      priceId: "price_evidence_pro_annual",
      customer: "cus_ACME",
      periodEnd: PERIOD_END_EPOCH,
    });
  });

  it("maps a real-shaped checkout.session.completed body (expanded subscription)", () => {
    const env = parseEvidenceEvent(checkoutCompletedBody());
    expect(env).to.deep.equal({
      provider: "stripe",
      type: "checkout.session.completed",
      priceId: "price_evidence_signed_monthly",
      customer: "cus_BETA",
      periodEnd: PERIOD_END_EPOCH,
    });
  });

  it("NAMED-rejects malformed JSON", () => {
    expect(() => parseEvidenceEvent("{ not json ")).to.throw(FulfillIntakeError, /invalid webhook JSON/);
    expect(() => parseEvidenceEvent("")).to.throw(FulfillIntakeError);
    expect(() => parseEvidenceEvent("[1,2,3]")).to.throw(FulfillIntakeError, /must be a JSON object/);
  });

  it("NAMED-rejects a non-string body", () => {
    expect(() => parseEvidenceEvent({ type: "invoice.paid" })).to.throw(
      FulfillIntakeError,
      /raw webhook body as a string/
    );
  });

  it("NAMED-rejects an oversized body", () => {
    const big = invoicePaidBody();
    expect(() => parseEvidenceEvent(big, { maxBytes: 10 })).to.throw(
      FulfillIntakeError,
      /oversized/
    );
  });

  it("NAMED-rejects an unknown / unsupported event type", () => {
    const body = JSON.stringify({
      type: "customer.subscription.deleted",
      data: { object: { customer: "cus_X" } },
    });
    expect(() => parseEvidenceEvent(body)).to.throw(FulfillIntakeError, /unsupported event type/);
  });

  it("NAMED-rejects a DUPLICATE-field body (a JSON smuggling vector JSON.parse silently allows)", () => {
    // `type` appears twice; a naive JSON.parse would silently keep the last. Our strict
    // parser rejects it outright.
    const smuggled =
      '{"type":"account.updated","type":"invoice.paid","data":{"object":{"customer":"cus_X"}}}';
    expect(() => parseEvidenceEvent(smuggled)).to.throw(
      FulfillIntakeError,
      /duplicate object key/
    );
    // Prove the vector is real: JSON.parse would have accepted + last-won it.
    expect(JSON.parse(smuggled).type).to.equal("invoice.paid");
  });

  it("NAMED-rejects a missing customer / price / period (never a partial accept)", () => {
    // Missing customer
    const noCustomer = JSON.stringify({
      type: "invoice.paid",
      data: { object: { lines: { data: [{ price: { id: "p" }, period: { end: 1 } }] } } },
    });
    expect(() => parseEvidenceEvent(noCustomer)).to.throw(FulfillIntakeError, /customer/);

    // Missing price id
    const noPrice = JSON.stringify({
      type: "invoice.paid",
      data: { object: { customer: "cus_X", lines: { data: [{ period: { end: 1 } }] } } },
    });
    expect(() => parseEvidenceEvent(noPrice)).to.throw(FulfillIntakeError, /price\.id/);

    // Non-integer / fractional period end
    const badPeriod = invoicePaidBody().replace(String(PERIOD_END_EPOCH), "1798761600.5");
    expect(() => parseEvidenceEvent(badPeriod)).to.throw(FulfillIntakeError, /periodEnd|epoch/);

    // Negative period end
    const negPeriod = invoicePaidBody().replace(String(PERIOD_END_EPOCH), "-5");
    expect(() => parseEvidenceEvent(negPeriod)).to.throw(FulfillIntakeError, /periodEnd|epoch/);
  });

  it("NAMED-rejects a checkout body missing the expanded subscription", () => {
    const body = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { customer: "cus_X" } },
    });
    expect(() => parseEvidenceEvent(body)).to.throw(FulfillIntakeError, /subscription/);
  });

  it("rejects excessively deep nesting rather than blowing the stack", () => {
    let s = "1";
    for (let i = 0; i < 5000; i++) s = "[" + s + "]";
    expect(() => parseEvidenceEvent(s)).to.throw(FulfillIntakeError);
  });

  it("maps a MODERN (Basil, 2025-03-31+) invoice.paid body (pricing.price_details.price)", () => {
    // The current Stripe API exposes the line price at pricing.price_details.price
    // (a bare id string), NOT price.id. The bridge must accept it verbatim.
    const env = parseEvidenceEvent(invoicePaidBodyModern());
    expect(env).to.deep.equal({
      provider: "stripe",
      type: "invoice.paid",
      priceId: "price_evidence_pro_annual",
      customer: "cus_MODERN",
      periodEnd: PERIOD_END_EPOCH,
    });
  });

  it("maps a MODERN checkout body (per-item subscription.items.data[i].current_period_end)", () => {
    // The current API moved the cycle end from the top-level
    // subscription.current_period_end to the subscription ITEM. Accept both.
    const env = parseEvidenceEvent(checkoutCompletedBodyModern());
    expect(env).to.deep.equal({
      provider: "stripe",
      type: "checkout.session.completed",
      priceId: "price_evidence_signed_monthly",
      customer: "cus_MODERNC",
      periodEnd: PERIOD_END_EPOCH,
    });
  });

  it("a MODERN body flows end-to-end: parse -> normalize -> fulfill (byte-identical, correct plan)", () => {
    const cat = catalog();
    const b = binding();
    const order = normalizeEvidenceEvent(parseEvidenceEvent(invoicePaidBodyModern()), b, {
      issuedAt: ISSUED,
    });
    expect(order).to.deep.equal({
      plan: "evidence-pro-annual",
      customer: "cus_MODERN",
      paidThrough: PERIOD_END_ISO,
      issuedAt: ISSUED,
    });
    const params = evidencePlans.fulfillEvidenceOrder(order, cat);
    expect(params.expiresAt).to.equal(PERIOD_END_ISO);
  });

  it("MULTI-LINE with a binding: selects the BOUND line, not positional [0]", () => {
    // data[0] carries an UNBOUND add-on price; data[1] is the bound subscription line.
    // A blind [0] would mis-select; binding-aware selection picks the bound line.
    const body = invoiceMultiLineBody([
      invoiceLine("price_unbound_addon", PERIOD_END_EPOCH),
      invoiceLine("price_evidence_pro_annual", PERIOD_END_EPOCH),
    ]);
    const env = parseEvidenceEvent(body, { binding: binding() });
    expect(env.priceId).to.equal("price_evidence_pro_annual");
    expect(env.periodEnd).to.equal(PERIOD_END_EPOCH);
  });

  it("MULTI-LINE with >1 BOUND line: NAMED-rejects as AMBIGUOUS (never silently picks one)", () => {
    const body = invoiceMultiLineBody([
      invoiceLine("price_evidence_signed_monthly", PERIOD_END_EPOCH),
      invoiceLine("price_evidence_pro_annual", PERIOD_END_EPOCH),
    ]);
    expect(() => parseEvidenceEvent(body, { binding: binding() })).to.throw(
      FulfillIntakeError,
      /AMBIGUOUS/
    );
  });

  it("MULTI-LINE with a binding but NO bound line: NAMED-rejects (cannot select)", () => {
    const body = invoiceMultiLineBody([
      invoiceLine("price_x", PERIOD_END_EPOCH),
      invoiceLine("price_y", PERIOD_END_EPOCH),
    ]);
    expect(() => parseEvidenceEvent(body, { binding: binding() })).to.throw(
      FulfillIntakeError,
      /NONE carries a price bound/
    );
  });

  it("MULTI-LINE without a binding + DISTINCT prices: NAMED-rejects (asks for opts.binding)", () => {
    const body = invoiceMultiLineBody([
      invoiceLine("price_a", PERIOD_END_EPOCH),
      invoiceLine("price_b", PERIOD_END_EPOCH),
    ]);
    expect(() => parseEvidenceEvent(body)).to.throw(FulfillIntakeError, /distinct prices/);
  });

  it("MULTI-LINE without a binding but all ONE price: accepts (unambiguous)", () => {
    const body = invoiceMultiLineBody([
      invoiceLine("price_evidence_pro_annual", PERIOD_END_EPOCH),
      invoiceLine("price_evidence_pro_annual", PERIOD_END_EPOCH),
    ]);
    const env = parseEvidenceEvent(body);
    expect(env.priceId).to.equal("price_evidence_pro_annual");
  });

  it("rejects a non-binding opts.binding (config misuse) with a NAMED error", () => {
    expect(() =>
      parseEvidenceEvent(invoicePaidBody(), { binding: { not: "a binding" } })
    ).to.throw(FulfillIntakeError, /validated evidence price binding/);
  });

  it("SUPPORTED_STRIPE_EVENT_TYPES is exactly the two understood types", () => {
    expect([...SUPPORTED_STRIPE_EVENT_TYPES].sort()).to.deep.equal([
      "checkout.session.completed",
      "invoice.paid",
    ]);
  });
});

// ===========================================================================
// (3) validateEvidencePriceBinding / resolveEvidencePlanId.
// ===========================================================================
describe("fulfill-intake T-62.1 (3): evidence price binding", () => {
  it("validateEvidencePriceBinding ACCEPTS a valid binding and freezes it", () => {
    const b = binding();
    expect(b.kind).to.equal(EVIDENCE_PRICE_BINDING_KIND);
    expect(Object.isFrozen(b)).to.equal(true);
    expect(Object.isFrozen(b.mappings)).to.equal(true);
    // mappings are emitted in canonical (provider, priceId)-sorted order.
    const keys = b.mappings.map((m) => `${m.provider} ${m.priceId}`);
    expect(keys).to.deep.equal([...keys].sort());
    // The internal lookup index is NOT enumerable (never leaks onto the serialized surface).
    expect(Object.keys(b)).to.deep.equal(["kind", "schemaVersion", "mappings"]);
  });

  it("resolveEvidencePlanId resolves a bound (provider, priceId) to OUR planId", () => {
    const b = binding();
    expect(resolveEvidencePlanId(b, "stripe", "price_evidence_pro_annual")).to.equal(
      "evidence-pro-annual"
    );
    expect(resolveEvidencePlanId(b, "stripe", "price_evidence_signed_monthly")).to.equal(
      "evidence-signed-monthly"
    );
  });

  it("resolveEvidencePlanId NAMED-rejects an UNMAPPED (provider, priceId)", () => {
    const b = binding();
    expect(() => resolveEvidencePlanId(b, "stripe", "price_nope")).to.throw(
      EvidencePriceBindingError,
      /no evidence plan bound/
    );
    expect(() => resolveEvidencePlanId(b, "paddle", "price_evidence_pro_annual")).to.throw(
      EvidencePriceBindingError,
      /no evidence plan bound/
    );
  });

  it("rejects a binding pointing at an UNKNOWN plan (the catalog is the authority)", () => {
    const obj = bindingObj();
    obj.mappings[0].planId = "evidence-does-not-exist";
    expect(() => validateEvidencePriceBinding(obj, catalog())).to.throw(
      EvidencePriceBindingError,
      /NOT in the supplied evidence catalog/
    );
  });

  it("rejects a DUPLICATE (provider, priceId) mapping (never last-wins)", () => {
    const obj = bindingObj();
    obj.mappings.push({
      provider: "stripe",
      priceId: "price_evidence_pro_annual", // dup of mappings[1]
      planId: "evidence-signed-monthly",
    });
    expect(() => validateEvidencePriceBinding(obj, catalog())).to.throw(
      EvidencePriceBindingError,
      /duplicate \(provider, priceId\)/
    );
  });

  it("rejects a MALFORMED binding (wrong kind / bad schema / empty / blank fields)", () => {
    const cat = catalog();
    const wrongKind = bindingObj();
    wrongKind.kind = "trustledger-price-binding";
    expect(() => validateEvidencePriceBinding(wrongKind, cat)).to.throw(
      EvidencePriceBindingError,
      /wrong kind/
    );

    const badSchema = bindingObj();
    badSchema.schemaVersion = 99;
    expect(() => validateEvidencePriceBinding(badSchema, cat)).to.throw(
      EvidencePriceBindingError,
      /unsupported .* schemaVersion/
    );

    const empty = bindingObj();
    empty.mappings = [];
    expect(() => validateEvidencePriceBinding(empty, cat)).to.throw(
      EvidencePriceBindingError,
      /non-empty array/
    );

    const blankProvider = bindingObj();
    blankProvider.mappings[0].provider = "  ";
    expect(() => validateEvidencePriceBinding(blankProvider, cat)).to.throw(
      EvidencePriceBindingError,
      /provider must be a non-empty string/
    );

    expect(() => validateEvidencePriceBinding(bindingObj(), null)).to.throw(
      EvidencePriceBindingError,
      /validated evidence plan catalog/
    );
    expect(() => validateEvidencePriceBinding("nope", cat)).to.throw(
      EvidencePriceBindingError,
      /must be a JSON object/
    );
  });
});

// ===========================================================================
// (4) normalizeEvidenceEvent -> fulfillEvidenceOrder: pure, byte-identical, round-trips.
// ===========================================================================
describe("fulfill-intake T-62.1 (4): normalizeEvidenceEvent -> fulfillEvidenceOrder", () => {
  it("maps a parsed event to the EXACT { plan, customer, paidThrough, issuedAt } order", () => {
    const b = binding();
    const order = normalizeEvidenceEvent(parseEvidenceEvent(invoicePaidBody()), b, {
      issuedAt: ISSUED,
    });
    expect(order).to.deep.equal({
      plan: "evidence-pro-annual",
      customer: "cus_ACME",
      paidThrough: PERIOD_END_ISO, // canonical ISO of periodEnd
      issuedAt: ISSUED,
    });
    // paidThrough equals the canonical ISO of the event's periodEnd.
    expect(order.paidThrough).to.equal(new Date(PERIOD_END_EPOCH * 1000).toISOString());
  });

  it("is PURE + DETERMINISTIC: repeated runs yield a BYTE-IDENTICAL license-params object", () => {
    const cat = catalog();
    const b = binding();
    const run = () => {
      const order = normalizeEvidenceEvent(parseEvidenceEvent(invoicePaidBody()), b, {
        issuedAt: ISSUED,
      });
      return evidencePlans.fulfillEvidenceOrder(order, cat);
    };
    const a = run();
    const c = run();
    expect(JSON.stringify(a)).to.equal(JSON.stringify(c)); // byte-identical
    expect(a.entitlements).to.deep.equal(
      cat.plansById["evidence-pro-annual"].entitlements
    );
    expect(a.expiresAt).to.equal(PERIOD_END_ISO); // paidThrough flows into expiresAt
  });

  it("requires an injected issuedAt (the core NEVER reads the system clock)", () => {
    const b = binding();
    const env = parseEvidenceEvent(invoicePaidBody());
    expect(() => normalizeEvidenceEvent(env, b, {})).to.throw(
      FulfillIntakeError,
      /issuedAt/
    );
    expect(() => normalizeEvidenceEvent(env, b, { issuedAt: "not-an-instant" })).to.throw(
      FulfillIntakeError
    );
  });

  it("surfaces the binding's NAMED reason for an unmapped price (wrong-tier is impossible)", () => {
    const b = binding();
    const env = parseEvidenceEvent(invoicePaidBody({ priceId: "price_unmapped" }));
    expect(() => normalizeEvidenceEvent(env, b, { issuedAt: ISSUED })).to.throw(
      FulfillIntakeError,
      /cannot normalize event/
    );
  });

  it("the params ROUND-TRIP through evidence.buildLicense + verifyLicense (whole pipeline)", async () => {
    const cat = catalog();
    const b = binding();
    const wallet = Wallet.createRandom(); // EPHEMERAL, test-only — never a real key

    // raw body -> verify sig -> parse -> normalize -> fulfill -> sign -> verify
    const body = invoicePaidBody();
    const NOW = 1735689600;
    const sig = signHeader(body, SECRET, NOW);
    expect(verifyProviderSignature(body, sig, SECRET, { nowSec: NOW }).ok).to.equal(true);

    const order = normalizeEvidenceEvent(parseEvidenceEvent(body), b, { issuedAt: ISSUED });
    const params = evidencePlans.fulfillEvidenceOrder(order, cat);
    const container = await evidence.buildLicense(params, wallet);

    const verdict = evidence.verifyLicense(container, {
      now: "2026-06-01T00:00:00.000Z", // between ISSUED and PERIOD_END
      vendorAddress: wallet.address,
    });
    expect(verdict.valid).to.equal(true);
    expect(verdict.reason).to.equal(null);
    for (const flag of cat.plansById["evidence-pro-annual"].entitlements) {
      expect(evidence.hasEntitlement(verdict, flag)).to.equal(true);
    }
    expect(verdict.payload.customer).to.equal("cus_ACME");
    expect(verdict.payload.expiresAt).to.equal(PERIOD_END_ISO);
  });
});

// ===========================================================================
// (5) intakeDedupKey — retry-stable, order-distinct idempotency key.
// ===========================================================================
describe("fulfill-intake T-62.1 (5): intakeDedupKey", () => {
  it("is STABLE for the same event delivered twice (at-least-once retry)", () => {
    const k1 = intakeDedupKey(parseEvidenceEvent(invoicePaidBody()));
    const k2 = intakeDedupKey(parseEvidenceEvent(invoicePaidBody()));
    expect(k1).to.equal(k2);
    expect(k1).to.match(/^vh-ev-intake:sha256:[0-9a-f]{64}$/);
  });

  it("is DISTINCT for a different customer", () => {
    const a = intakeDedupKey(parseEvidenceEvent(invoicePaidBody()));
    const b = intakeDedupKey(parseEvidenceEvent(invoicePaidBody({ customer: "cus_OTHER" })));
    expect(a).to.not.equal(b);
  });

  it("is DISTINCT for a different price", () => {
    const a = intakeDedupKey(parseEvidenceEvent(invoicePaidBody()));
    const b = intakeDedupKey(
      parseEvidenceEvent(invoicePaidBody({ priceId: "price_evidence_signed_monthly" }))
    );
    expect(a).to.not.equal(b);
  });

  it("is DISTINCT for a different period", () => {
    const a = intakeDedupKey(parseEvidenceEvent(invoicePaidBody()));
    const b = intakeDedupKey(parseEvidenceEvent(invoicePaidBody({ periodEnd: 1800000000 })));
    expect(a).to.not.equal(b);
  });

  it("NAMED-rejects a non-event input", () => {
    expect(() => intakeDedupKey(null)).to.throw(FulfillIntakeError);
    expect(() => intakeDedupKey({ provider: "stripe" })).to.throw(FulfillIntakeError);
  });
});

// ===========================================================================
// PURITY — the module reads no fs / net / clock.
// ===========================================================================
describe("fulfill-intake T-62.1: the module is PURE (no fs / net / clock)", () => {
  it("a source grep finds no fs/http/net require, no Date.now, no bare new Date()", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "cli", "core", "fulfill-intake.js"),
      "utf8"
    );
    expect(src).to.not.match(/require\(['"](fs|http|https|net|tls|dns|child_process)['"]\)/);
    expect(src).to.not.match(/require\(['"]ethers['"]\)/);
    expect(src).to.not.match(/Date\.now\s*\(/);
    expect(src).to.not.match(/new Date\(\s*\)/); // no hidden clock read
  });

  it("writes NO file to the working tree (pure core — nothing to isolate)", () => {
    const before = fs.readdirSync(process.cwd()).sort();
    parseEvidenceEvent(invoicePaidBody());
    verifyProviderSignature(invoicePaidBody(), signHeader(invoicePaidBody(), SECRET, 1735689600), SECRET, {
      nowSec: 1735689600,
    });
    intakeDedupKey(parseEvidenceEvent(invoicePaidBody()));
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(before);
  });
});
