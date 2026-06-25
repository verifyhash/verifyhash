"use strict";

// TrustLedger — the event -> order normalizer + idempotency key (T-38.2).
//
// EPIC-37 built order -> license (fulfillOrder). T-38.1 built the price -> plan
// BINDING. This task finishes the pipeline: normalizeEvent maps a NORMALIZED
// provider event envelope (a Stripe/Paddle "payment succeeded / renewed" event,
// already flattened to one canonical shape) onto the EXACT
// `{ plan, customer, paidThrough, issuedAt }` order fulfillOrder already consumes,
// and orderKey produces the DETERMINISTIC `LIC-<issuedAt>-<plan>` idempotency seed.
//
// These tests prove:
//   * normalizeEvent resolves OUR planId from the PROVIDER's (provider, priceId)
//     via the catalog-validated binding, converts the period-end UNIX EPOCH SECONDS
//     to the canonical ISO `paidThrough`, derives customer, and reads issuedAt from
//     the event or opts (NO hidden clock);
//   * it is PURE + DETERMINISTIC — the same rawEvent + binding yields a
//     byte-identical order, and fulfillOrder(normalizeEvent(...)) mints a license
//     whose plan/entitlements/window EXACTLY equal the bound plan's;
//   * an unmapped priceId / missing customer / non-integer-or-negative/malformed
//     period-end / missing issuedAt each throw a NAMED LicenseError (never a silent
//     or wrong-tier order);
//   * orderKey is STABLE for a RETRIED/duplicate event — the SAME event twice yields
//     the identical orderKey AND, when fulfilled, a BYTE-IDENTICAL license;
//   * the module stays PURE — no clock/fs/http; issuedAt is always supplied.
//
// PURE / OFFLINE — no live node, no key material in PART 1/2/3 (normalizeEvent is
// pure). PART 4 mints a real signed license with an EPHEMERAL in-process
// Wallet.createRandom() key (TEST-ONLY) to prove a retried event re-mints the
// byte-identical signed bytes.

const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { Wallet } = require("ethers");

const license = require("../trustledger/license");
const plans = require("../trustledger/plans");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures", "plans");
const BASELINE_TEXT = fs.readFileSync(path.join(FIX, "baseline.json"), "utf8");
const BINDING_TEXT = fs.readFileSync(
  path.join(FIX, "price-binding.example.json"),
  "utf8"
);

// A FRESH validated catalog/binding per use (the modules are pure; the test does I/O).
function catalog() {
  return plans.validatePlanCatalog(JSON.parse(BASELINE_TEXT));
}
function binding() {
  return plans.validatePriceBinding(JSON.parse(BINDING_TEXT), catalog());
}

const ISSUED = "2026-01-01T00:00:00.000Z";
// 1798761600 == 2027-01-01T00:00:00.000Z as a UNIX epoch in SECONDS.
const PERIOD_END_EPOCH = 1798761600;
const PERIOD_END_ISO = "2027-01-01T00:00:00.000Z";

// A real-shaped, already-normalized provider event envelope: the PROVIDER's
// (provider, priceId), a customer, a UNIX-epoch-seconds period end, an issuedAt.
function rawEvent(extra = {}) {
  return Object.assign(
    {
      provider: "stripe",
      type: "invoice.paid",
      priceId: "price_pro_annual_usd", // -> pro-annual in the bundled binding
      customer: "Acme Realty LLC",
      periodEnd: PERIOD_END_EPOCH,
      issuedAt: ISSUED,
    },
    extra
  );
}

// ===========================================================================
// PART 1 — normalizeEvent: the happy path maps onto the EXACT fulfillOrder order.
// ===========================================================================

describe("trustledger T-38.2: normalizeEvent (event -> order, the exact fulfillOrder shape)", function () {
  it("maps a provider event onto the EXACT { plan, customer, paidThrough, issuedAt } order", function () {
    const order = license.normalizeEvent(rawEvent(), binding());
    // planId resolved from the PROVIDER's (provider, priceId), not the event.
    expect(order.plan).to.equal("pro-annual");
    expect(order.customer).to.equal("Acme Realty LLC");
    // period-end UNIX epoch SECONDS -> canonical ISO paidThrough.
    expect(order.paidThrough).to.equal(PERIOD_END_ISO);
    expect(order.issuedAt).to.equal(ISSUED);
    // Exactly the four order keys fulfillOrder consumes — no leaked provider fields.
    expect(Object.keys(order).sort()).to.deep.equal(
      ["customer", "issuedAt", "paidThrough", "plan"].sort()
    );
  });

  it("converts the period-end UNIX EPOCH SECONDS to the canonical ISO grammar fulfillOrder requires", function () {
    // A non-millis epoch still yields a canonical "....mmmZ" instant.
    const order = license.normalizeEvent(
      rawEvent({ periodEnd: 1717200000 }), // 2024-06-01T00:00:00.000Z
      binding()
    );
    expect(order.paidThrough).to.equal("2024-06-01T00:00:00.000Z");
    // Epoch 0 is the unix epoch itself.
    const z = license.normalizeEvent(rawEvent({ periodEnd: 0, issuedAt: "1969-01-01T00:00:00.000Z" }), binding());
    expect(z.paidThrough).to.equal("1970-01-01T00:00:00.000Z");
  });

  it("reads issuedAt from rawEvent.issuedAt, and opts.issuedAt WINS over it (NO clock)", function () {
    const fromEvent = license.normalizeEvent(rawEvent({ issuedAt: ISSUED }), binding());
    expect(fromEvent.issuedAt).to.equal(ISSUED);
    // opts.issuedAt overrides the event's value.
    const override = "2026-03-15T00:00:00.000Z";
    const fromOpts = license.normalizeEvent(rawEvent({ issuedAt: ISSUED }), binding(), {
      issuedAt: override,
    });
    expect(fromOpts.issuedAt).to.equal(override);
    // issuedAt absent on the event but supplied via opts is fine (no clock read).
    const ev = rawEvent();
    delete ev.issuedAt;
    const onlyOpts = license.normalizeEvent(ev, binding(), { issuedAt: override });
    expect(onlyOpts.issuedAt).to.equal(override);
  });

  it("resolves the planId via the binding for EVERY bundled mapping (provider + priceId, not the event)", function () {
    const b = binding();
    const cat = catalog();
    for (const m of b.mappings) {
      const order = license.normalizeEvent(
        rawEvent({ provider: m.provider, priceId: m.priceId }),
        b
      );
      expect(order.plan).to.equal(m.planId);
      // And the resolved plan is a real plan in the catalog.
      expect(cat.plansById).to.have.property(order.plan);
    }
  });
});

// ===========================================================================
// PART 2 — PURE + DETERMINISTIC, and end-to-end fulfill equals the BOUND plan.
// ===========================================================================

describe("trustledger T-38.2: normalizeEvent is PURE + DETERMINISTIC and feeds fulfillOrder exactly", function () {
  it("the SAME rawEvent + binding yields a BYTE-IDENTICAL order", function () {
    const ev = rawEvent();
    const a = JSON.stringify(license.normalizeEvent(ev, binding()));
    const c = JSON.stringify(license.normalizeEvent(ev, binding()));
    expect(a).to.equal(c);
  });

  it("does NOT mutate the input event", function () {
    const ev = rawEvent();
    const before = JSON.stringify(ev);
    license.normalizeEvent(ev, binding());
    expect(JSON.stringify(ev)).to.equal(before);
  });

  it("fulfillOrder(normalizeEvent(ev, binding), catalog) entitlements/window EXACTLY equal the bound plan's", function () {
    const b = binding();
    const cat = catalog();
    for (const m of b.mappings) {
      const order = license.normalizeEvent(
        rawEvent({ provider: m.provider, priceId: m.priceId }),
        b
      );
      const params = license.fulfillOrder(order, cat);
      const plan = cat.plansById[m.planId];
      // Entitlements come ONLY from the bound plan — verbatim, never re-typed.
      expect(params.entitlements).to.deep.equal(plan.entitlements);
      expect(params.plan).to.equal(m.planId);
      // The window: paidThrough is the period end; issuedAt is the event's.
      expect(params.issuedAt).to.equal(ISSUED);
      expect(params.expiresAt).to.equal(PERIOD_END_ISO);
      // And the params are a sound license the strict validator accepts.
      expect(() => license.buildLicensePayload(params)).to.not.throw();
    }
  });

  it("the default licenseId fulfillOrder derives EQUALS orderKey(order) (the idempotency seed)", function () {
    const order = license.normalizeEvent(rawEvent(), binding());
    const params = license.fulfillOrder(order, catalog());
    expect(params.licenseId).to.equal(license.orderKey(order));
  });
});

// ===========================================================================
// PART 3 — STRICT: each malformed/ambiguous field is a NAMED reject.
// ===========================================================================

describe("trustledger T-38.2: normalizeEvent is STRICT (named rejects, never a silent/wrong-tier order)", function () {
  it("an UNMAPPED priceId throws a NAMED LicenseError naming the price (never a wrong-PLAN mis-grant)", function () {
    let caught;
    try {
      license.normalizeEvent(rawEvent({ priceId: "price_does_not_exist" }), binding());
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(license.LicenseError);
    expect(caught.message).to.match(/normalize event/i);
    expect(caught.message).to.include("price_does_not_exist");
  });

  it("a KNOWN priceId under the WRONG provider is unmapped (the key is the pair)", function () {
    expect(() =>
      license.normalizeEvent(
        rawEvent({ provider: "no-such-provider", priceId: "price_pro_annual_usd" }),
        binding()
      )
    ).to.throw(license.LicenseError, /normalize event/i);
  });

  it("a missing/blank provider or priceId throws a NAMED LicenseError", function () {
    expect(() =>
      license.normalizeEvent(rawEvent({ provider: "" }), binding())
    ).to.throw(license.LicenseError, /provider.*non-empty/i);
    const noPrice = rawEvent();
    delete noPrice.priceId;
    expect(() => license.normalizeEvent(noPrice, binding())).to.throw(
      license.LicenseError,
      /priceId.*non-empty/i
    );
  });

  it("a missing/blank customer throws a NAMED LicenseError (no holder => no license)", function () {
    const noCustomer = rawEvent();
    delete noCustomer.customer;
    expect(() => license.normalizeEvent(noCustomer, binding())).to.throw(
      license.LicenseError,
      /customer.*non-empty/i
    );
    expect(() =>
      license.normalizeEvent(rawEvent({ customer: "" }), binding())
    ).to.throw(license.LicenseError, /customer.*non-empty/i);
  });

  it("a missing periodEnd throws a NAMED LicenseError", function () {
    const noEnd = rawEvent();
    delete noEnd.periodEnd;
    expect(() => license.normalizeEvent(noEnd, binding())).to.throw(
      license.LicenseError,
      /missing required field: periodEnd/i
    );
  });

  it("a NON-INTEGER period-end epoch throws a NAMED LicenseError (never rounded/coerced)", function () {
    expect(() =>
      license.normalizeEvent(rawEvent({ periodEnd: 1798761600.5 }), binding())
    ).to.throw(license.LicenseError, /periodEnd.*INTEGER UNIX epoch/i);
    // A numeric-looking STRING is not a number — rejected, never coerced.
    expect(() =>
      license.normalizeEvent(rawEvent({ periodEnd: "1798761600" }), binding())
    ).to.throw(license.LicenseError, /periodEnd.*INTEGER UNIX epoch/i);
  });

  it("a NEGATIVE or out-of-range period-end epoch throws a NAMED LicenseError", function () {
    expect(() =>
      license.normalizeEvent(rawEvent({ periodEnd: -1 }), binding())
    ).to.throw(license.LicenseError, /periodEnd.*SECONDS/i);
    expect(() =>
      license.normalizeEvent(rawEvent({ periodEnd: Number.MAX_SAFE_INTEGER }), binding())
    ).to.throw(license.LicenseError, /periodEnd.*SECONDS/i);
    expect(() =>
      license.normalizeEvent(rawEvent({ periodEnd: NaN }), binding())
    ).to.throw(license.LicenseError, /periodEnd/i);
  });

  it("a MISSING issuedAt (neither event nor opts) throws a NAMED LicenseError (no clock fallback)", function () {
    const ev = rawEvent();
    delete ev.issuedAt;
    let caught;
    try {
      license.normalizeEvent(ev, binding());
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(license.LicenseError);
    expect(caught.message).to.match(/issuedAt.*required/i);
    expect(caught.message).to.match(/never reads the system clock/i);
  });

  it("a MALFORMED issuedAt (rolled-over / date-only) throws a NAMED LicenseError", function () {
    expect(() =>
      license.normalizeEvent(rawEvent({ issuedAt: "2026-02-30T00:00:00.000Z" }), binding())
    ).to.throw(license.LicenseError, /issuedAt/);
    expect(() =>
      license.normalizeEvent(rawEvent({ issuedAt: "2026-01-01" }), binding())
    ).to.throw(license.LicenseError, /issuedAt/);
  });

  it("a non-object event or opts throws a NAMED LicenseError", function () {
    expect(() => license.normalizeEvent(null, binding())).to.throw(
      license.LicenseError,
      /normalized event envelope/i
    );
    expect(() => license.normalizeEvent([], binding())).to.throw(
      license.LicenseError,
      /normalized event envelope/i
    );
    expect(() =>
      license.normalizeEvent(rawEvent(), binding(), [])
    ).to.throw(license.LicenseError, /opts.*must be an object/i);
  });
});

// ===========================================================================
// PART 4 — orderKey idempotency: a RETRIED event re-mints the BYTE-IDENTICAL license.
// ===========================================================================

describe("trustledger T-38.2: orderKey is the STABLE idempotency seed for a retried event", function () {
  it("orderKey returns the deterministic LIC-<issuedAt>-<plan> seed", function () {
    const order = license.normalizeEvent(rawEvent(), binding());
    expect(license.orderKey(order)).to.equal(`LIC-${ISSUED}-pro-annual`);
  });

  it("the SAME event delivered twice yields the IDENTICAL orderKey", function () {
    const b = binding();
    const ev = rawEvent();
    // Two independent normalizations of the same (retried) event.
    const k1 = license.orderKey(license.normalizeEvent(ev, b));
    const k2 = license.orderKey(license.normalizeEvent(ev, b));
    expect(k1).to.equal(k2);
  });

  it("a retried event, fulfilled + SIGNED with the same vendor key, is a BYTE-IDENTICAL license", async function () {
    // The webhook fires the SAME event twice (at-least-once delivery). A handler that
    // dedupes on orderKey re-mints the byte-identical signed license — never a second one.
    const cat = catalog();
    const b = binding();
    const ev = rawEvent();

    // The vendor key is an EPHEMERAL in-process test key (NEVER a real key/funds).
    const wallet = Wallet.createRandom();

    // First delivery.
    const order1 = license.normalizeEvent(ev, b);
    const key1 = license.orderKey(order1);
    const params1 = license.fulfillOrder(order1, cat);
    const lic1 = await license.buildLicense(params1, wallet);
    const bytes1 = license.serializeSignedLicense(lic1);

    // Retried delivery of the SAME event.
    const order2 = license.normalizeEvent(ev, b);
    const key2 = license.orderKey(order2);
    const params2 = license.fulfillOrder(order2, cat);
    const lic2 = await license.buildLicense(params2, wallet);
    const bytes2 = license.serializeSignedLicense(lic2);

    // Same idempotency key, and the SIGNED bytes are byte-identical (the signature is
    // deterministic over the same canonical payload + same key).
    expect(key1).to.equal(key2);
    expect(bytes2).to.equal(bytes1);

    // And the license's plan/entitlements/window exactly equal the BOUND plan's.
    const payload = JSON.parse(JSON.parse(bytes1).attestation);
    const plan = cat.plansById["pro-annual"];
    expect(payload.entitlements).to.deep.equal(plan.entitlements);
    expect(payload.issuedAt).to.equal(ISSUED);
    expect(payload.expiresAt).to.equal(PERIOD_END_ISO);
  });

  it("orderKey is STRICT — a missing plan / malformed issuedAt is a NAMED LicenseError", function () {
    expect(() => license.orderKey(null)).to.throw(license.LicenseError, /order object/i);
    expect(() => license.orderKey({ issuedAt: ISSUED })).to.throw(
      license.LicenseError,
      /plan.*non-empty/i
    );
    expect(() => license.orderKey({ plan: "pro-annual", issuedAt: "2026-01-01" })).to.throw(
      license.LicenseError,
      /issuedAt/
    );
  });
});

// ===========================================================================
// PART 5 — PURITY: normalizeEvent/orderKey read no clock/fs/http; issuedAt supplied.
// ===========================================================================

describe("trustledger T-38.2: PURITY (no clock fallback in the normalizer/orderKey paths)", function () {
  it("normalizeEvent NEVER reads Date.now (a missing issuedAt is a hard reject, not the clock)", function () {
    // Tripwire: if normalizeEvent ever falls back to the system clock, this would
    // pass silently. We assert it instead THROWS when issuedAt is absent.
    const ev = rawEvent();
    delete ev.issuedAt;
    const realNow = Date.now;
    let called = false;
    Date.now = function () {
      called = true;
      return realNow.call(Date);
    };
    try {
      expect(() => license.normalizeEvent(ev, binding())).to.throw(license.LicenseError);
    } finally {
      Date.now = realNow;
    }
    expect(called).to.equal(false);
  });

  it("the event -> order section of license.js reads no http/clock-fallback (issuedAt always supplied)", function () {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "trustledger", "license.js"),
      "utf8"
    );
    // No network anywhere in the module.
    expect(src).to.not.match(/require\(\s*["']http["']\s*\)/);
    expect(src).to.not.match(/require\(\s*["']https["']\s*\)/);
    // No Date.now clock read anywhere (the window math uses Date.parse/toISOString
    // on SUPPLIED instants/epochs, never the wall clock).
    expect(src).to.not.match(/Date\.now/);
  });
});
