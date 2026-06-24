"use strict";

const { expect } = require("chai");

const {
  reconcile,
  MatchError,
  DEFAULTS,
  dayDiff,
  memoSimilarity,
} = require("../trustledger/match");

// Build a normalized-ish record. The matcher only needs {date, amount, memo};
// we mirror the ingest shape so these are drop-in with real ingested rows.
function rec(date, amount, memo = "", extra = {}) {
  return { date, amount, memo, kind: "other", party: "", source: "bank", ...extra };
}

// Deep structural compare that ignores order, for order-independence proofs.
function canonical(result) {
  const key = (r) => JSON.stringify([r.date, r.amount, r.memo]);
  const keyOf = (x) => (Array.isArray(x) ? x.map(key).sort().join("|") : key(x));
  return {
    matched: result.matched
      .map((m) => ({
        a: keyOf(m.a),
        b: keyOf(m.b),
        confidence: m.confidence,
        kind: m.kind,
      }))
      .sort((p, q) =>
        (p.a + p.b + p.kind).localeCompare(q.a + q.b + q.kind)
      ),
    unmatchedA: result.unmatchedA.map(key).sort(),
    unmatchedB: result.unmatchedB.map(key).sort(),
  };
}

describe("trustledger/match: helpers", function () {
  it("dayDiff is absolute calendar-day distance, leap-correct", function () {
    expect(dayDiff("2026-02-01", "2026-02-01")).to.equal(0);
    expect(dayDiff("2026-02-01", "2026-02-03")).to.equal(2);
    expect(dayDiff("2026-02-03", "2026-02-01")).to.equal(2);
    // Across a leap day (2024 is a leap year).
    expect(dayDiff("2024-02-28", "2024-03-01")).to.equal(2);
    // Across a non-leap year boundary.
    expect(dayDiff("2025-02-28", "2025-03-01")).to.equal(1);
  });

  it("memoSimilarity: blank/blank neutral-high, disjoint zero, partial in (0,1)", function () {
    expect(memoSimilarity("", "")).to.equal(1);
    expect(memoSimilarity("rent unit 4", "")).to.equal(0);
    expect(memoSimilarity("Rent - Unit 4!", "rent unit 4")).to.equal(1);
    const s = memoSimilarity("rent payment smith", "rent payment jones");
    expect(s).to.be.greaterThan(0).and.lessThan(1);
  });
});

describe("trustledger/match: exact pass", function () {
  it("matches same amount + same date exactly, confidence ~1", function () {
    const A = [rec("2026-03-01", 150000, "Rent Smith")];
    const B = [rec("2026-03-01", 150000, "Rent Smith")];
    const r = reconcile(A, B);
    expect(r.matched).to.have.length(1);
    expect(r.matched[0].kind).to.equal("exact");
    expect(r.matched[0].confidence).to.equal(1);
    expect(r.unmatchedA).to.be.empty;
    expect(r.unmatchedB).to.be.empty;
  });

  it("prefers an EXACT same-day match over an in-window one of equal amount", function () {
    // Two bank lines of the same amount; only one ledger line. The same-day
    // pairing must win so the in-window one is left for the other bank line.
    const A = [rec("2026-03-01", 50000, "x"), rec("2026-03-04", 50000, "y")];
    const B = [rec("2026-03-01", 50000, "z")];
    const r = reconcile(A, B, { dateToleranceDays: 3 });
    expect(r.matched).to.have.length(1);
    expect(r.matched[0].kind).to.equal("exact");
    // The 03-01 A row matched; the 03-04 A row is the leftover.
    expect(r.unmatchedA).to.have.length(1);
    expect(r.unmatchedA[0].date).to.equal("2026-03-04");
  });
});

describe("trustledger/match: ACCEPTANCE — the four required cases", function () {
  it("(1) NSF reversal: a bounced deposit's equal-and-opposite reversal matches", function () {
    // Ledger recorded a $1,200 tenant payment on the 5th. It bounced; the bank
    // posted a -$1,200 NSF reversal on the 6th. The reversal must reconcile to
    // the original payment, flagged as an NSF reversal (not silently dropped).
    const bank = [
      rec("2026-04-05", 120000, "DEPOSIT"),
      rec("2026-04-06", -120000, "NSF RETURNED ITEM"),
    ];
    const ledger = [
      rec("2026-04-05", 120000, "Rent payment - Unit 2", { source: "quickbooks" }),
      rec("2026-04-06", -120000, "NSF reversal Unit 2", { source: "quickbooks" }),
    ];
    const r = reconcile(bank, ledger, { dateToleranceDays: 3 });
    // Both the deposit and its reversal reconcile -> nothing left over.
    expect(r.unmatchedA).to.be.empty;
    expect(r.unmatchedB).to.be.empty;
    expect(r.matched).to.have.length(2);

    // The engine can ALSO recognize an EQUAL-AND-OPPOSITE NSF when only one side
    // carries an explicit reversal row. Here the bank shows just the -$1,200 NSF
    // reversal (the original deposit cleared in a prior file), while the ledger
    // still carries the +$1,200 payment that bounced. They must reconcile as an
    // nsf-reversal, not be left as two phantom exceptions.
    const bank2 = [rec("2026-04-08", -120000, "NSF returned item")];
    const ledger2 = [
      rec("2026-04-05", 120000, "Rent Unit 9", { source: "quickbooks" }),
    ];
    const r2 = reconcile(bank2, ledger2, { dateToleranceDays: 5 });
    const nsf = r2.matched.find((m) => m.kind === "nsf-reversal");
    expect(nsf, "an nsf-reversal pairing exists").to.exist;
    expect(nsf.a.amount).to.equal(-120000);
    expect(nsf.b.amount).to.equal(120000);
    // Nothing genuinely lost.
    expect(r2.unmatchedA).to.be.empty;
    expect(r2.unmatchedB).to.be.empty;
  });

  it("(2) split deposit: one bank line == sum of several ledger lines", function () {
    // Manager deposited three rent checks together; the bank shows one $4,500
    // credit while the ledger has three separate $1,500 tenant payments.
    const bank = [rec("2026-05-02", 450000, "Branch deposit")];
    const ledger = [
      rec("2026-05-01", 150000, "Rent Unit A", { source: "quickbooks" }),
      rec("2026-05-01", 150000, "Rent Unit B", { source: "quickbooks" }),
      rec("2026-05-01", 150000, "Rent Unit C", { source: "quickbooks" }),
    ];
    const r = reconcile(bank, ledger, { dateToleranceDays: 3 });
    expect(r.unmatchedA).to.be.empty;
    expect(r.unmatchedB).to.be.empty;
    expect(r.matched).to.have.length(1);
    const m = r.matched[0];
    expect(m.kind).to.equal("split");
    // The single bank line is on side `a`; the three ledger lines are an array.
    expect(Array.isArray(m.a)).to.equal(false);
    expect(m.a.amount).to.equal(450000);
    expect(Array.isArray(m.b)).to.equal(true);
    expect(m.b).to.have.length(3);
    const sum = m.b.reduce((acc, x) => acc + x.amount, 0);
    expect(sum).to.equal(450000);
  });

  it("(2b) split works the OTHER direction: one ledger line == several bank lines", function () {
    const bank = [
      rec("2026-05-10", 100000, "ACH 1"),
      rec("2026-05-11", 250000, "ACH 2"),
    ];
    const ledger = [rec("2026-05-10", 350000, "Owner sweep", { source: "quickbooks" })];
    const r = reconcile(bank, ledger, { dateToleranceDays: 3 });
    expect(r.unmatchedA).to.be.empty;
    expect(r.unmatchedB).to.be.empty;
    expect(r.matched).to.have.length(1);
    const m = r.matched[0];
    expect(m.kind).to.equal("split");
    expect(Array.isArray(m.a)).to.equal(true); // the two bank lines
    expect(m.b.amount).to.equal(350000); // the single ledger line
  });

  it("(3) 1-day timing gap: ledger 1st, bank clears 2nd, still matches", function () {
    const bank = [rec("2026-06-02", 90000, "Deposit")];
    const ledger = [rec("2026-06-01", 90000, "Rent Unit 7", { source: "quickbooks" })];
    const r = reconcile(bank, ledger, { dateToleranceDays: 3 });
    expect(r.matched).to.have.length(1);
    expect(r.matched[0].kind).to.equal("amount+window");
    expect(r.matched[0].confidence).to.be.greaterThan(0).and.at.most(1);
    expect(r.unmatchedA).to.be.empty;
    expect(r.unmatchedB).to.be.empty;
  });

  it("(4) a genuinely missing item stays unmatched", function () {
    // Bank shows a $777 fee the ledger never recorded; ledger shows a $555
    // payment that never hit the bank. Neither may be paired with anything.
    const bank = [
      rec("2026-06-03", 120000, "Rent Smith"),
      rec("2026-06-03", -7700, "Wire fee"),
    ];
    const ledger = [
      rec("2026-06-03", 120000, "Rent Smith", { source: "quickbooks" }),
      rec("2026-06-03", 55500, "Rent Jones uncleared", { source: "quickbooks" }),
    ];
    const r = reconcile(bank, ledger, { dateToleranceDays: 3 });
    // The Smith rent reconciles; the fee and the uncleared payment do not.
    expect(r.matched).to.have.length(1);
    expect(r.matched[0].a.memo).to.match(/Smith/);
    expect(r.unmatchedA.map((x) => x.amount)).to.deep.equal([-7700]);
    expect(r.unmatchedB.map((x) => x.amount)).to.deep.equal([55500]);
  });
});

describe("trustledger/match: determinism + order-independence", function () {
  function buildScenario() {
    const bank = [
      rec("2026-07-01", 150000, "Rent A"),
      rec("2026-07-02", 450000, "Batch deposit"), // splits B,C,D below
      rec("2026-07-05", -7700, "Wire fee"), // genuinely missing
      rec("2026-07-06", 90000, "Late rent"), // 1-day gap to ledger 07-05
      rec("2026-07-07", -120000, "NSF returned"), // reversal of ledger E
    ];
    const ledger = [
      rec("2026-07-01", 150000, "Rent A", { source: "quickbooks" }),
      rec("2026-07-01", 150000, "Rent B", { source: "quickbooks" }),
      rec("2026-07-01", 150000, "Rent C", { source: "quickbooks" }),
      rec("2026-07-01", 150000, "Rent D", { source: "quickbooks" }),
      rec("2026-07-05", 90000, "Late rent", { source: "quickbooks" }),
      rec("2026-07-05", 120000, "Rent E", { source: "quickbooks" }), // bounces
      rec("2026-07-09", 33300, "Uncleared", { source: "quickbooks" }), // missing
    ];
    return { bank, ledger };
  }

  it("produces the SAME result regardless of input order (10 shuffles)", function () {
    const { bank, ledger } = buildScenario();
    const base = canonical(reconcile(bank, ledger, { dateToleranceDays: 3 }));

    // A simple deterministic shuffler so the test itself is reproducible.
    const shuffle = (arr, seed) => {
      const a = arr.slice();
      let s = seed;
      for (let i = a.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const j = s % (i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    for (let seed = 1; seed <= 10; seed++) {
      const r = reconcile(
        shuffle(bank, seed),
        shuffle(ledger, seed * 7 + 1),
        { dateToleranceDays: 3 }
      );
      expect(canonical(r), `shuffle seed ${seed}`).to.deep.equal(base);
    }
  });

  it("the scenario reconciles every line it should and ONLY leaves true exceptions", function () {
    const { bank, ledger } = buildScenario();
    const r = reconcile(bank, ledger, { dateToleranceDays: 3 });
    // Genuinely missing: bank wire fee (-7700) and ledger uncleared (33300).
    expect(r.unmatchedA.map((x) => x.amount)).to.deep.equal([-7700]);
    expect(r.unmatchedB.map((x) => x.amount)).to.deep.equal([33300]);
    // Conservation: every input is either matched or explicitly unmatched.
    const flat = (x) => (Array.isArray(x) ? x : [x]);
    const matchedA = r.matched.flatMap((m) => flat(m.a));
    const matchedB = r.matched.flatMap((m) => flat(m.b));
    expect(matchedA.length + r.unmatchedA.length).to.equal(bank.length);
    expect(matchedB.length + r.unmatchedB.length).to.equal(ledger.length);
  });

  it("returns identical output on repeated identical calls (pure)", function () {
    const { bank, ledger } = buildScenario();
    const r1 = reconcile(bank, ledger, { dateToleranceDays: 3 });
    const r2 = reconcile(bank, ledger, { dateToleranceDays: 3 });
    expect(JSON.stringify(r1)).to.equal(JSON.stringify(r2));
  });

  it("does not mutate the caller's input records or arrays", function () {
    const { bank, ledger } = buildScenario();
    const bankCopy = JSON.parse(JSON.stringify(bank));
    const ledgerCopy = JSON.parse(JSON.stringify(ledger));
    reconcile(bank, ledger, { dateToleranceDays: 3 });
    expect(bank).to.deep.equal(bankCopy);
    expect(ledger).to.deep.equal(ledgerCopy);
  });
});

describe("trustledger/match: window + config behavior", function () {
  it("a gap LARGER than tolerance does NOT match", function () {
    const bank = [rec("2026-08-10", 90000, "Deposit")];
    const ledger = [rec("2026-08-01", 90000, "Rent", { source: "quickbooks" })];
    const r = reconcile(bank, ledger, { dateToleranceDays: 3 });
    expect(r.matched).to.be.empty;
    expect(r.unmatchedA).to.have.length(1);
    expect(r.unmatchedB).to.have.length(1);
  });

  it("dateToleranceDays:0 is same-day-only", function () {
    const bank = [rec("2026-08-02", 90000, "Deposit")];
    const ledger = [rec("2026-08-01", 90000, "Rent", { source: "quickbooks" })];
    expect(reconcile(bank, ledger, { dateToleranceDays: 0 }).matched).to.be.empty;
    expect(reconcile(bank, ledger, { dateToleranceDays: 1 }).matched).to.have.length(1);
  });

  it("respects maxSplitParts: a split needing more parts than allowed is left unmatched", function () {
    const bank = [rec("2026-09-01", 400, "Batch")];
    const ledger = [
      rec("2026-09-01", 100, "a", { source: "quickbooks" }),
      rec("2026-09-01", 100, "b", { source: "quickbooks" }),
      rec("2026-09-01", 100, "c", { source: "quickbooks" }),
      rec("2026-09-01", 100, "d", { source: "quickbooks" }),
    ];
    const blocked = reconcile(bank, ledger, { maxSplitParts: 3 });
    expect(blocked.matched).to.be.empty;
    const ok = reconcile(bank, ledger, { maxSplitParts: 4 });
    expect(ok.matched).to.have.length(1);
    expect(ok.matched[0].kind).to.equal("split");
  });
});

describe("trustledger/match: confidence blend is pinned per kind", function () {
  // A regression in the confidence blend math would otherwise slip past the
  // acceptance tests (which only pin exact=1 and a 0..1 range). These pin the
  // actual number each non-exact kind produces under known inputs.
  it("amount+window: 1-day gap, identical memo => exact blended value", function () {
    const bank = [rec("2026-06-02", 90000, "Rent Unit 7")];
    const ledger = [rec("2026-06-01", 90000, "Rent Unit 7", { source: "quickbooks" })];
    const r = reconcile(bank, ledger, { dateToleranceDays: 3 });
    expect(r.matched).to.have.length(1);
    expect(r.matched[0].kind).to.equal("amount+window");
    // dateComp = 1 - 0.5*(1/3) = 0.83333..., memoSim = 1 (same tokens),
    // memoWeight 0.25 => 0.75*0.833333 + 0.25*1 = 0.875.
    expect(r.matched[0].confidence).to.equal(0.875);
  });

  it("nsf-reversal: equal-and-opposite is capped at 0.95", function () {
    // Same-day, identical-ish memo would blend to ~1.0, but an NSF reversal is
    // deliberately capped below a clean match so a reviewer can spot it.
    const bank = [rec("2026-04-08", -120000, "NSF returned item")];
    const ledger = [rec("2026-04-08", 120000, "NSF returned item", { source: "quickbooks" })];
    const r = reconcile(bank, ledger, { dateToleranceDays: 5 });
    const nsf = r.matched.find((m) => m.kind === "nsf-reversal");
    expect(nsf, "an nsf-reversal pairing exists").to.exist;
    // Raw blend (same day, identical memo) is 1.0; the cap pulls it to 0.95.
    expect(nsf.confidence).to.equal(0.95);
  });

  it("split: same-day batched deposit, blank memos => capped 0.99", function () {
    const bank = [rec("2026-05-01", 450000, "")];
    const ledger = [
      rec("2026-05-01", 150000, "", { source: "quickbooks" }),
      rec("2026-05-01", 150000, "", { source: "quickbooks" }),
      rec("2026-05-01", 150000, "", { source: "quickbooks" }),
    ];
    const r = reconcile(bank, ledger, { dateToleranceDays: 3 });
    expect(r.matched).to.have.length(1);
    expect(r.matched[0].kind).to.equal("split");
    // maxDiff 0 => dateComp 1; blank/blank memoSim 1 => raw blend 1.0, capped 0.99.
    expect(r.matched[0].confidence).to.equal(0.99);
  });
});

describe("trustledger/match: breadth-heavy clustering can never blow up", function () {
  it("60+ same-date same-sign leftovers finish fast and stay unmatched (no combinatorial grind)", function () {
    // The pathological real-world shape: a single bank line that does NOT
    // reconcile, plus a large CLUSTER of unmatched same-sign ledger lines all on
    // ONE date inside the window. With only DEPTH bounded, findSubsetSum would
    // explore C(n, k) here and take minutes. The BREADTH cap must decline the
    // brute-force split and leave everything unmatched, quickly.
    const bank = [];
    const ledger = [];
    // One "deposit" whose amount is NOT any achievable subset sum of the cluster
    // (the cluster parts are all 100; target is a prime number of cents that no
    // small subset of 100s can hit), so even an unbounded search would find
    // nothing — but it must not SPEND time discovering that.
    // The cluster amounts are chosen so NO one-to-one pass can pair a bank line
    // with a ledger line (different magnitudes per side) and no small subset can
    // sum to the phantom target — the ONLY pass that would engage is the split
    // brute-force, which the breadth cap must decline.
    bank.push(rec("2026-07-03", 99991, "Phantom deposit"));
    for (let i = 0; i < 80; i++) {
      ledger.push(
        rec("2026-07-03", 10000, "fee " + i, { source: "quickbooks" })
      );
    }
    // Also exercise the reverse direction: a ledger single against a big bank
    // cluster, all same-sign, same-date. Use a DIFFERENT part magnitude (30000)
    // so these bank parts can't one-to-one match the 10000 ledger parts above.
    ledger.push(rec("2026-07-03", 88883, "Phantom ledger"));
    for (let i = 0; i < 80; i++) {
      bank.push(rec("2026-07-03", 30000, "bank fee " + i, { source: "bank" }));
    }

    const start = Date.now();
    const r = reconcile(bank, ledger, { dateToleranceDays: 3 });
    const elapsedMs = Date.now() - start;

    // Hard work bound: the as-shipped (breadth-unbounded) code measured ~16.7s
    // for a far SMALLER cluster; with the cap this must complete near-instantly.
    expect(elapsedMs, `reconcile took ${elapsedMs}ms`).to.be.lessThan(1000);

    // The two phantom singles cannot be reconciled; nothing should be matched.
    expect(r.matched).to.be.empty;
    // Conservation: every input is accounted for as an exception.
    expect(r.unmatchedA).to.have.length(bank.length);
    expect(r.unmatchedB).to.have.length(ledger.length);
  });

  it("a LEGITIMATE split still matches when the pool is within the breadth cap", function () {
    // Sanity: the cap must not break real splits. 3 parts in a small pool.
    const bank = [rec("2026-07-03", 450000, "Batch")];
    const ledger = [
      rec("2026-07-03", 150000, "a", { source: "quickbooks" }),
      rec("2026-07-03", 150000, "b", { source: "quickbooks" }),
      rec("2026-07-03", 150000, "c", { source: "quickbooks" }),
    ];
    const r = reconcile(bank, ledger, { dateToleranceDays: 3, maxSplitCandidates: 24 });
    expect(r.matched).to.have.length(1);
    expect(r.matched[0].kind).to.equal("split");
  });

  it("maxSplitCandidates is enforced: a split whose pool exceeds the cap is declined", function () {
    // 5 same-sign same-date candidates, cap of 4 => the windowed pool (5) > cap,
    // so the split is declined even though a valid 3-part subset exists.
    const bank = [rec("2026-07-03", 300, "Batch")];
    const ledger = [
      rec("2026-07-03", 100, "a", { source: "quickbooks" }),
      rec("2026-07-03", 100, "b", { source: "quickbooks" }),
      rec("2026-07-03", 100, "c", { source: "quickbooks" }),
      rec("2026-07-03", 700, "d", { source: "quickbooks" }),
      rec("2026-07-03", 900, "e", { source: "quickbooks" }),
    ];
    const declined = reconcile(bank, ledger, { maxSplitCandidates: 4 });
    expect(declined.matched).to.be.empty;
    // Raise the cap and the same input now reconciles the 3-part split.
    const ok = reconcile(bank, ledger, { maxSplitCandidates: 24 });
    expect(ok.matched).to.have.length(1);
    expect(ok.matched[0].kind).to.equal("split");
  });

  it("rejects a non-positive maxSplitCandidates", function () {
    expect(() => reconcile([], [], { maxSplitCandidates: 0 })).to.throw(
      MatchError,
      /maxSplitCandidates/
    );
  });
});

describe("trustledger/match: input validation", function () {
  it("rejects non-array inputs", function () {
    expect(() => reconcile(null, [])).to.throw(MatchError);
    expect(() => reconcile([], "nope")).to.throw(MatchError);
  });
  it("rejects non-integer amounts and bad dates", function () {
    expect(() => reconcile([rec("2026-01-01", 1.5, "x")], [])).to.throw(MatchError, /integer cents/);
    expect(() => reconcile([rec("01/01/2026", 100, "x")], [])).to.throw(MatchError, /YYYY-MM-DD/);
  });
  it("rejects a non-zero amount tolerance (money reconciles exactly)", function () {
    expect(() => reconcile([], [], { amountToleranceCents: 5 })).to.throw(MatchError, /exactly/);
  });
  it("exposes sane DEFAULTS", function () {
    expect(DEFAULTS.dateToleranceDays).to.be.a("number");
    expect(DEFAULTS.amountToleranceCents).to.equal(0);
    expect(DEFAULTS.maxSplitParts).to.be.greaterThan(1);
  });
});
