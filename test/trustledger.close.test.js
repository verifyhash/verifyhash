"use strict";

// TrustLedger — close.js tests (T-24.1).
//
// Proves the period-close artifact + pure build/read/validate and the pure
// roll-forward continuity check:
//   * round-trip: buildClose -> readClose reproduces the fields;
//   * EVERY validation-rejection branch (bad version, each missing field,
//     non-integer cents, malformed digest);
//   * buildClose from a known packet model yields the expected ending/subledger
//     and a deterministic, reproducible digest;
//   * checkContinuity: ok=true when prior ending == this opening, a non-zero
//     bankGap/bookGap (ok=false) when it does not, and ok=true for a null prior;
//   * byte-determinism of buildClose for a fixed model.

const { expect } = require("chai");
const crypto = require("crypto");

const close = require("../trustledger/close");
const report = require("../trustledger/report");

const {
  SCHEMA_VERSION,
  CloseError,
  buildClose,
  readClose,
  validateClose,
  checkContinuity,
} = close;

// A normalized-record helper mirroring ingest.js shape (same as the other
// trustledger tests use).
function rec(date, amount, extra = {}) {
  return {
    date,
    amount,
    memo: extra.memo || "",
    kind: extra.kind || "other",
    party: extra.party || "",
    source: extra.source || "bank",
  };
}

const DATE = "2026-06-24";

// A clean, tying-out packet model built through the real report pipeline so the
// close is exercised against a REAL-shaped model, not a hand-faked one.
function cleanModel(opening) {
  const bank = [rec("2026-06-01", 150000, { source: "bank", memo: "rent dep" })];
  const book = [rec("2026-06-01", 150000, { source: "quickbooks", memo: "rent dep" })];
  const rentroll = [
    rec("2026-06-01", 150000, { source: "rentroll", party: "Unit 1", memo: "rent" }),
  ];
  return report.buildPacket({
    bank,
    book,
    rentroll,
    reportDate: DATE,
    period: "2026-06",
    opening: opening || { bank: 0, book: 0 },
  });
}

// A fully-valid close object, used as the mutation base for the rejection tests.
function validClose() {
  return buildClose(cleanModel());
}

describe("trustledger/close: buildClose derives a close PURELY from the model", function () {
  it("reuses opening/balances/period/reportDate and sets ending/subledger", function () {
    const model = cleanModel({ bank: 100000, book: 100000 });
    const c = buildClose(model);

    expect(c.schemaVersion).to.equal(SCHEMA_VERSION);
    expect(c.period).to.equal("2026-06");
    expect(c.reportDate).to.equal(DATE);
    expect(c.opening).to.eql({ bank: 100000, book: 100000 });
    // ending = { bank: model.balances.bank, book: model.balances.book }
    expect(c.ending).to.eql({
      bank: model.balances.bank,
      book: model.balances.book,
    });
    // subledger = model.balances.subledger
    expect(c.subledger).to.equal(model.balances.subledger);
    expect(c.tiesOut).to.equal(model.tiesOut);
    expect(c.pass).to.equal(model.pass);
    expect(c.inputsDigest).to.match(/^[0-9a-f]{64}$/);
  });

  it("computes the expected ending/subledger/digest for a KNOWN model", function () {
    // opening bank/book 100000, plus one 150000 deposit on each side => ending
    // 250000; one 150000 rent-roll row => subledger 150000.
    const model = cleanModel({ bank: 100000, book: 100000 });
    const c = buildClose(model);
    expect(c.ending).to.eql({ bank: 250000, book: 250000 });
    expect(c.subledger).to.equal(150000);

    // The digest is a SHA-256 over the SAME canonical projection close.js hashes;
    // recompute it independently here to prove it is bound to the summarized data
    // and is not an opaque/arbitrary value.
    const canonical = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      period: "2026-06",
      reportDate: DATE,
      opening: { bank: 100000, book: 100000 },
      ending: { bank: 250000, book: 250000 },
      subledger: 150000,
      tiesOut: c.tiesOut,
      pass: c.pass,
      inputs: {
        bankRecords: model.inputs.bankRecords,
        bookRecords: model.inputs.bookRecords,
        rentrollRecords: model.inputs.rentrollRecords,
      },
    });
    const expected = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
    expect(c.inputsDigest).to.equal(expected);
  });

  it("is byte-deterministic: same model => byte-identical close", function () {
    const a = buildClose(cleanModel({ bank: 100000, book: 100000 }));
    const b = buildClose(cleanModel({ bank: 100000, book: 100000 }));
    expect(JSON.stringify(a)).to.equal(JSON.stringify(b));
  });

  it("the digest CHANGES when a summarized fact changes", function () {
    const a = buildClose(cleanModel({ bank: 100000, book: 100000 }));
    const b = buildClose(cleanModel({ bank: 200000, book: 200000 }));
    expect(a.inputsDigest).to.not.equal(b.inputsDigest);
  });

  it("rejects a non-model argument", function () {
    expect(() => buildClose(null)).to.throw(CloseError);
    expect(() => buildClose("nope")).to.throw(CloseError);
    expect(() => buildClose({ reportDate: "bad" })).to.throw(CloseError);
  });

  it("rejects a model whose opening is present but garbled", function () {
    const model = cleanModel();
    model.opening = { bank: 100000.5, book: 0 }; // non-integer cents
    expect(() => buildClose(model)).to.throw(CloseError);
  });
});

describe("trustledger/close: round-trip buildClose -> readClose", function () {
  it("readClose(text) reproduces every field", function () {
    const c = buildClose(cleanModel({ bank: 100000, book: 100000 }));
    const text = JSON.stringify(c);
    const back = readClose(text);
    expect(back).to.eql(c);
  });

  it("readClose(obj) validates and returns the object", function () {
    const c = buildClose(cleanModel());
    expect(readClose(c)).to.eql(c);
  });

  it("readClose rejects non-JSON text with a named error (not a SyntaxError)", function () {
    expect(() => readClose("{not json")).to.throw(CloseError, /not valid JSON/);
  });

  it("readClose rejects a non-string/non-object input", function () {
    expect(() => readClose(42)).to.throw(CloseError);
  });
});

describe("trustledger/close: validateClose is STRICT (every rejection branch)", function () {
  it("accepts a well-formed close (the base used below)", function () {
    expect(validateClose(validClose())).to.be.an("object");
  });

  it("rejects a non-object", function () {
    expect(() => validateClose(null)).to.throw(CloseError, /must be an object/);
    expect(() => validateClose([])).to.throw(CloseError, /must be an object/);
  });

  it("rejects a WRONG schemaVersion", function () {
    const c = validClose();
    c.schemaVersion = "trustledger.period-close/v2";
    expect(() => validateClose(c)).to.throw(CloseError, /schemaVersion/);
  });

  it("rejects a missing schemaVersion", function () {
    const c = validClose();
    delete c.schemaVersion;
    expect(() => validateClose(c)).to.throw(CloseError, /schemaVersion/);
  });

  it("rejects a missing period key", function () {
    const c = validClose();
    delete c.period;
    expect(() => validateClose(c)).to.throw(CloseError, /period/);
  });

  it("rejects a garbled (non-string) period", function () {
    const c = validClose();
    c.period = { month: 6 };
    expect(() => validateClose(c)).to.throw(CloseError, /period/);
  });

  it("rejects a missing/garbled reportDate", function () {
    const c = validClose();
    delete c.reportDate;
    expect(() => validateClose(c)).to.throw(CloseError, /reportDate/);
    const c2 = validClose();
    c2.reportDate = "06/24/2026";
    expect(() => validateClose(c2)).to.throw(CloseError, /reportDate/);
  });

  it("rejects a missing opening", function () {
    const c = validClose();
    delete c.opening;
    expect(() => validateClose(c)).to.throw(CloseError, /opening/);
  });

  it("rejects a non-integer-cents opening balance", function () {
    const c = validClose();
    c.opening = { bank: 100000.5, book: 0 };
    expect(() => validateClose(c)).to.throw(CloseError, /opening/);
  });

  it("rejects a missing ending", function () {
    const c = validClose();
    delete c.ending;
    expect(() => validateClose(c)).to.throw(CloseError, /ending/);
  });

  it("rejects a non-integer-cents ending balance", function () {
    const c = validClose();
    c.ending = { bank: 250000, book: "250000" };
    expect(() => validateClose(c)).to.throw(CloseError, /ending/);
  });

  it("rejects a missing subledger", function () {
    const c = validClose();
    delete c.subledger;
    expect(() => validateClose(c)).to.throw(CloseError, /subledger/);
  });

  it("rejects a non-integer-cents subledger", function () {
    const c = validClose();
    c.subledger = 150000.25;
    expect(() => validateClose(c)).to.throw(CloseError, /subledger/);
  });

  it("rejects a non-boolean tiesOut / pass", function () {
    const c = validClose();
    c.tiesOut = "true";
    expect(() => validateClose(c)).to.throw(CloseError, /tiesOut/);
    const c2 = validClose();
    c2.pass = 1;
    expect(() => validateClose(c2)).to.throw(CloseError, /pass/);
  });

  it("rejects a missing/garbled inputs record-count block", function () {
    const c = validClose();
    delete c.inputs;
    expect(() => validateClose(c)).to.throw(CloseError, /inputs/);
    const c2 = validClose();
    c2.inputs = { bankRecords: -1, bookRecords: 1, rentrollRecords: 1 };
    expect(() => validateClose(c2)).to.throw(CloseError, /bankRecords/);
  });

  it("rejects a malformed inputsDigest", function () {
    const c = validClose();
    c.inputsDigest = "not-a-digest";
    expect(() => validateClose(c)).to.throw(CloseError, /inputsDigest/);
    const c2 = validClose();
    c2.inputsDigest = "ABCDEF"; // uppercase + too short
    expect(() => validateClose(c2)).to.throw(CloseError, /inputsDigest/);
    const c3 = validClose();
    delete c3.inputsDigest;
    expect(() => validateClose(c3)).to.throw(CloseError, /inputsDigest/);
  });
});

describe("trustledger/close: checkContinuity (pure roll-forward)", function () {
  it("null/undefined priorClose => { ok: true } (no prior period to chain from)", function () {
    expect(checkContinuity(null, { bank: 100000, book: 100000 })).to.eql({ ok: true });
    expect(checkContinuity(undefined, { bank: 0, book: 0 })).to.eql({ ok: true });
  });

  it("ok:true with zero gaps when the prior ending EQUALS this opening", function () {
    const prior = buildClose(cleanModel({ bank: 100000, book: 100000 }));
    // prior.ending is { bank: 250000, book: 250000 }
    const result = checkContinuity(prior, { bank: 250000, book: 250000 });
    expect(result).to.eql({ ok: true, bankGap: 0, bookGap: 0 });
  });

  it("ok:false with a non-zero bankGap when the bank roll-forward is off", function () {
    const prior = buildClose(cleanModel({ bank: 100000, book: 100000 }));
    // open the bank one cent HIGHER than the prior close => bankGap +1
    const result = checkContinuity(prior, { bank: 250001, book: 250000 });
    expect(result.ok).to.equal(false);
    expect(result.bankGap).to.equal(1);
    expect(result.bookGap).to.equal(0);
  });

  it("ok:false with a non-zero bookGap when the book roll-forward is off", function () {
    const prior = buildClose(cleanModel({ bank: 100000, book: 100000 }));
    // open the book LOWER than the prior close => bookGap negative
    const result = checkContinuity(prior, { bank: 250000, book: 240000 });
    expect(result.ok).to.equal(false);
    expect(result.bankGap).to.equal(0);
    expect(result.bookGap).to.equal(-10000);
  });

  it("accepts a prior close passed as JSON TEXT", function () {
    const prior = buildClose(cleanModel({ bank: 100000, book: 100000 }));
    const result = checkContinuity(JSON.stringify(prior), { bank: 250000, book: 250000 });
    expect(result).to.eql({ ok: true, bankGap: 0, bookGap: 0 });
  });

  it("does NOT throw on a gap — it reports it for the caller to surface", function () {
    const prior = buildClose(cleanModel());
    expect(() => checkContinuity(prior, { bank: 999999, book: 0 })).to.not.throw();
  });

  it("rejects a corrupt prior close (loud, not a silent pass)", function () {
    expect(() => checkContinuity({ schemaVersion: "wrong" }, { bank: 0, book: 0 })).to.throw(
      CloseError
    );
  });

  it("rejects a garbled opening", function () {
    const prior = buildClose(cleanModel());
    expect(() => checkContinuity(prior, { bank: 1.5, book: 0 })).to.throw(CloseError);
  });

  it("is side-effect free: does not mutate its arguments", function () {
    const prior = buildClose(cleanModel({ bank: 100000, book: 100000 }));
    const priorCopy = JSON.parse(JSON.stringify(prior));
    const opening = { bank: 250000, book: 250000 };
    checkContinuity(prior, opening);
    expect(prior).to.eql(priorCopy);
    expect(opening).to.eql({ bank: 250000, book: 250000 });
  });
});
