"use strict";

// test/cli.core.agent-coverage.test.js — DIRECT coverage of the PURE fleet-coverage core
// (cli/core/agent-coverage.js, T-71.1): evaluateCoverage from caller-supplied facts, the canonical
// serializer, and the strict parser.
//
// WHAT THIS PROVES (the T-71.1 acceptance criteria, each as an honest test):
//   (1) STATIC purity guard (same style as the agent-session/agent-commit guards): the core's own
//       source requires NOTHING AT ALL — no fs/git/child_process/http/https/net/dns, no
//       process.env (or `process` at all), no clock/randomness/key material, no inline crypto, no
//       new dependency — and the module doc states the artifact is sealable by the EXISTING
//       `vh evidence seal` plus the honest containment-not-causation boundary.
//   (2) evaluateCoverage: the CLOSED verdict vocabulary hit exactly (covered-verified /
//       covered-oid-only / claim-unverified-packet — NEVER covered — / claim-root-mismatch /
//       uncovered), per-commit precedence, totals per status, and the policy verdict for
//       requireAll / requireSince (list-order, inclusive) — all DETERMINISTIC and TOTAL: every
//       hostile/malformed input is a named { ok:false, reason }, never a throw.
//   (3) serializeCoverageReport: ONE canonical sorted-key byte representation (pinned as a
//       literal), versioned kind:"vh-agent-coverage@1", byte-diffable, and STRICT — a report
//       whose statuses/totals/verdict do not follow from its own embedded facts is a named
//       REPORT_INCONSISTENT reject (so a forged "covered" from an unverified packet cannot even
//       be serialized).
//   (4) parseCoverageReport: the strict inverse — unknown kind/version, extra/missing/malformed
//       fields, forged values, oversize, non-JSON and NON-CANONICAL bytes are each named rejects;
//       parse∘serialize and serialize∘parse both round-trip; an exhaustive single-character
//       tamper sweep over the pinned bytes never throws and never silently accepts a lie.
//
// PURITY OF THIS SUITE: no temp dirs, no sockets, no keys, no cwd side effects — the only fs use
// is reading the core source as TEXT for the static guard.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const core = require("../cli/core/agent-coverage");
const {
  REPORT_KIND,
  COMMIT_STATUSES,
  CLAIM_STATUSES,
  COVERED_STATUSES,
  STATUS_PRECEDENCE,
  POLICY_RULES,
  MAX_COMMITS,
  MAX_CLAIMS,
  MAX_PACKET_LABEL_LENGTH,
  MAX_REPORT_LENGTH,
  REASONS,
  evaluateCoverage,
  serializeCoverageReport,
  parseCoverageReport,
} = core;

// ---------------------------------------------------------------------------------------------------
// Deterministic fixtures (no randomness — reruns are byte-identical).
// ---------------------------------------------------------------------------------------------------

function oid(n) {
  return n.toString(16).padStart(40, "0");
}
function root(n) {
  return "0x" + n.toString(16).padStart(64, "0");
}

const O1 = oid(0xa1);
const O2 = oid(0xa2);
const O3 = oid(0xa3);
const O4 = oid(0xa4);
const O5 = oid(0xa5);
const OUT_OF_RANGE_OID = oid(0xdead);
const R1 = root(0xb1);
const R2 = root(0xb2);
const LABEL = "s1.vhagent.json";

function commitsOf(...oids) {
  return oids.map((o) => ({ oid: o }));
}

// A canonical input claim; override any field via opts.
function claim(o, opts) {
  return Object.assign(
    { oid: o, gitRoot: R1, packetLabel: LABEL, packetVerified: true, rootVerified: null },
    opts || {}
  );
}

// The five-way fixture: one commit per verdict in the closed vocabulary.
function fiveWayInput() {
  return {
    commits: commitsOf(O1, O2, O3, O4, O5),
    claims: [
      claim(O1, { rootVerified: true }), // covered-verified
      claim(O2), // covered-oid-only (rootVerified: null = not re-derived)
      claim(O3, { packetVerified: false, rootVerified: true }), // claim-unverified-packet (rootVerified irrelevant)
      claim(O4, { rootVerified: false }), // claim-root-mismatch
      // O5: no claim -> uncovered
    ],
  };
}

function reportOf(input) {
  const r = evaluateCoverage(input);
  expect(r.ok, JSON.stringify(r)).to.equal(true);
  return r.report;
}

function jsonOf(report) {
  const s = serializeCoverageReport(report);
  expect(s.ok, JSON.stringify(s)).to.equal(true);
  return s.json;
}

// Deep copy for tamper tests (reports are JSON-shaped by construction).
function copy(report) {
  return JSON.parse(JSON.stringify(report));
}

// Test-local sorted-key canonical stringify — used ONLY to craft canonical-format bytes of
// deliberately INCONSISTENT values (which the core itself refuses to serialize).
function canon(v) {
  if (v === null) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canon(v[k]))
      .join(",") +
    "}"
  );
}

// The pinned canonical bytes — the exact artifact contract the T-71.2 CLI (and any seal/diff
// pipeline) can rely on: 2 commits, 1 verified claim, requireAll policy failing on the second.
const PIN_INPUT = Object.freeze({
  commits: commitsOf(O1, O2),
  claims: [claim(O1, { rootVerified: true })],
  policy: { requireAll: true },
});
const PIN_BYTES =
  '{"commits":[{"claims":[{"gitRoot":"' +
  R1 +
  '","packetLabel":"' +
  LABEL +
  '","packetVerified":true,"rootVerified":true,"status":"covered-verified"}],"oid":"' +
  O1 +
  '","status":"covered-verified"},{"claims":[],"oid":"' +
  O2 +
  '","status":"uncovered"}],"kind":"vh-agent-coverage@1","policy":{"requireAll":true,"requireSince":null},"totals":{"claim-root-mismatch":0,"claim-unverified-packet":0,"covered-oid-only":0,"covered-verified":1,"uncovered":1},"verdict":{"failures":[{"oid":"' +
  O2 +
  '","rule":"require-all","status":"uncovered"}],"pass":false}}';

const ALL_NAMED_REASONS = Object.freeze(Object.values(REASONS));

describe("cli/core/agent-coverage.js — pure fleet-coverage core (T-71.1)", function () {
  // =================================================================================================
  describe("(1) STATIC purity guard: requires NOTHING; no fs/git/net/env/clock/keys; honest module doc", function () {
    let raw;
    let src; // comments stripped, so prose can neither hide nor fake a dependency
    before(function () {
      raw = fs.readFileSync(path.join(__dirname, "..", "cli", "core", "agent-coverage.js"), "utf8");
      src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    });

    it("contains NO require() at all — node-core-free, dependency-free (NO new dependency by construction)", function () {
      expect(/\brequire\s*\(/.test(src), "must not require anything").to.equal(false);
      expect(/\bimport\s/.test(src), "must not import anything").to.equal(false);
    });

    it("never touches process (so no process.env, argv, exit, hrtime, ...)", function () {
      expect(/\bprocess\s*[.[]/.test(src), "must not reference process").to.equal(false);
    });

    it("has no clock or randomness (pure, deterministic)", function () {
      expect(
        /Date\.now|new Date\b|Math\.random|randomBytes|performance\.now|hrtime/.test(src)
      ).to.equal(false);
    });

    it("does no signer/keyfile/fs/git/network work (facts are CALLER-SUPPLIED)", function () {
      expect(
        /\bWallet\b|privateKey|PRIVATE_KEY|readFileSync|writeFileSync|openSync|execSync|spawn|fetch\(|http|resolveCommit|runGit|repoRoot|listTrackedFiles|hashGit|hashFile|hashDir/.test(
          src
        )
      ).to.equal(false);
    });

    it("inlines no crypto primitive (evaluation and serialization only — sealing stays with the existing tools)", function () {
      expect(/keccak|sha-?3|sha-?256|createHash|Signature|signMessage/i.test(src)).to.equal(false);
    });

    it("the module doc states sealability via the EXISTING `vh evidence seal` (no new seal code) and the honest boundary", function () {
      expect(raw).to.include("vh evidence seal");
      expect(raw).to.include("no new seal code");
      expect(raw).to.include("containment, NOT causation");
      expect(raw).to.include("not an authorship detector");
    });

    it("exports the closed schema contract", function () {
      expect(REPORT_KIND).to.equal("vh-agent-coverage@1");
      expect(COMMIT_STATUSES).to.deep.equal([
        "claim-root-mismatch",
        "claim-unverified-packet",
        "covered-oid-only",
        "covered-verified",
        "uncovered",
      ]);
      expect(CLAIM_STATUSES).to.deep.equal([
        "claim-root-mismatch",
        "claim-unverified-packet",
        "covered-oid-only",
        "covered-verified",
      ]);
      expect(COVERED_STATUSES).to.deep.equal(["covered-verified", "covered-oid-only"]);
      expect(POLICY_RULES).to.deep.equal(["require-all", "require-since"]);
      expect(Object.keys(STATUS_PRECEDENCE)).to.have.length(4);
      expect(Object.isFrozen(COMMIT_STATUSES)).to.equal(true);
      expect(Object.isFrozen(REASONS)).to.equal(true);
    });
  });

  // =================================================================================================
  describe("(2a) evaluateCoverage: the CLOSED vocabulary, hit exactly once each", function () {
    it("five commits -> the five statuses in order; totals 1 each; claims listed under their commit", function () {
      const report = reportOf(fiveWayInput());
      expect(report.kind).to.equal(REPORT_KIND);
      expect(report.commits.map((c) => c.oid)).to.deep.equal([O1, O2, O3, O4, O5]);
      expect(report.commits.map((c) => c.status)).to.deep.equal([
        "covered-verified",
        "covered-oid-only",
        "claim-unverified-packet",
        "claim-root-mismatch",
        "uncovered",
      ]);
      expect(report.totals).to.deep.equal({
        "claim-root-mismatch": 1,
        "claim-unverified-packet": 1,
        "covered-oid-only": 1,
        "covered-verified": 1,
        uncovered: 1,
      });
      // every claim row carries its OWN status; the uncovered commit has none
      expect(report.commits[0].claims).to.have.length(1);
      expect(report.commits[0].claims[0].status).to.equal("covered-verified");
      expect(report.commits[1].claims[0].status).to.equal("covered-oid-only");
      expect(report.commits[2].claims[0].status).to.equal("claim-unverified-packet");
      expect(report.commits[3].claims[0].status).to.equal("claim-root-mismatch");
      expect(report.commits[4].claims).to.deep.equal([]);
      // no policy -> vacuous pass
      expect(report.policy).to.deep.equal({ requireAll: false, requireSince: null });
      expect(report.verdict).to.deep.equal({ pass: true, failures: [] });
      // totals always sum to the commit count
      const sum = Object.values(report.totals).reduce((a, b) => a + b, 0);
      expect(sum).to.equal(report.commits.length);
    });

    it("a claim from an UNVERIFIED packet NEVER counts as covered — even with rootVerified:true", function () {
      const input = {
        commits: commitsOf(O1),
        claims: [claim(O1, { packetVerified: false, rootVerified: true })],
        policy: { requireAll: true },
      };
      const report = reportOf(input);
      expect(report.commits[0].status).to.equal("claim-unverified-packet");
      expect(report.commits[0].claims[0].status).to.equal("claim-unverified-packet");
      expect(report.verdict.pass).to.equal(false);
      expect(report.verdict.failures).to.deep.equal([
        { oid: O1, rule: "require-all", status: "claim-unverified-packet" },
      ]);
    });

    it("rootVerified:false from a verified packet is claim-root-mismatch — an active discrepancy, not coverage", function () {
      const report = reportOf({
        commits: commitsOf(O1),
        claims: [claim(O1, { rootVerified: false })],
        policy: { requireAll: true },
      });
      expect(report.commits[0].status).to.equal("claim-root-mismatch");
      expect(report.verdict.failures[0].status).to.equal("claim-root-mismatch");
    });

    it("empty range: empty commits + claims -> all-zero totals, vacuous pass, round-trips", function () {
      const report = reportOf({ commits: [], claims: [] });
      expect(report.commits).to.deep.equal([]);
      expect(Object.values(report.totals)).to.deep.equal([0, 0, 0, 0, 0]);
      expect(report.verdict).to.deep.equal({ pass: true, failures: [] });
      const s = jsonOf(report);
      const p = parseCoverageReport(s);
      expect(p.ok).to.equal(true);
      expect(p.report).to.deep.equal(report);
    });
  });

  // =================================================================================================
  describe("(2b) precedence, multiple claims, ordering, aliasing", function () {
    it("per-commit status is the STRONGEST claim outcome: verified > oid-only > mismatch > unverified", function () {
      const cases = [
        // [claim opt list, expected commit status]
        [[{ packetVerified: false }, { rootVerified: true }], "covered-verified"],
        [[{ rootVerified: null }, { rootVerified: true }], "covered-verified"],
        [[{ rootVerified: false }, { rootVerified: null }], "covered-oid-only"],
        [[{ rootVerified: false }, { packetVerified: false }], "claim-root-mismatch"],
        [[{ packetVerified: false }, { packetVerified: false, rootVerified: false }], "claim-unverified-packet"],
      ];
      for (const [opts, expected] of cases) {
        const report = reportOf({
          commits: commitsOf(O1),
          claims: opts.map((o) => claim(O1, o)),
        });
        expect(report.commits[0].status, JSON.stringify(opts)).to.equal(expected);
        // conflicting claims never hide: every row is listed with its OWN status
        expect(report.commits[0].claims).to.have.length(opts.length);
      }
    });

    it("a root-mismatch beside a covering claim stays VISIBLE while the commit counts as covered", function () {
      const report = reportOf({
        commits: commitsOf(O1),
        claims: [claim(O1, { rootVerified: false, gitRoot: R2 }), claim(O1, { rootVerified: true })],
        policy: { requireAll: true },
      });
      expect(report.commits[0].status).to.equal("covered-verified");
      expect(report.commits[0].claims.map((c) => c.status)).to.deep.equal([
        "claim-root-mismatch",
        "covered-verified",
      ]);
      expect(report.verdict.pass).to.equal(true); // covered for policy purposes
    });

    it("claims keep claims-list order under their commit (interleaved input)", function () {
      const report = reportOf({
        commits: commitsOf(O1, O2),
        claims: [
          claim(O2, { gitRoot: R1 }),
          claim(O1),
          claim(O2, { gitRoot: R2 }),
        ],
      });
      expect(report.commits[1].claims.map((c) => c.gitRoot)).to.deep.equal([R1, R2]);
      expect(report.commits[0].claims).to.have.length(1);
    });

    it("claims naming an oid OUTSIDE the range are ignored by design (report byte-identical)", function () {
      const base = fiveWayInput();
      const withNoise = {
        commits: base.commits,
        claims: base.claims.concat([claim(OUT_OF_RANGE_OID, { rootVerified: true })]),
      };
      expect(jsonOf(reportOf(withNoise))).to.equal(jsonOf(reportOf(base)));
    });

    it("the report aliases NO caller-mutable state (later input mutation cannot rewrite it)", function () {
      const input = fiveWayInput();
      const report = reportOf(input);
      input.claims[0].packetVerified = false;
      input.commits[0].oid = OUT_OF_RANGE_OID;
      expect(report.commits[0].oid).to.equal(O1);
      expect(report.commits[0].claims[0].packetVerified).to.equal(true);
    });

    it("DETERMINISTIC: permuted input key orders and repeated calls yield byte-identical artifacts", function () {
      const a = {
        commits: commitsOf(O1, O2),
        claims: [{ oid: O1, gitRoot: R1, packetLabel: LABEL, packetVerified: true, rootVerified: true }],
        policy: { requireAll: true },
      };
      const b = {
        policy: { requireAll: true },
        claims: [{ rootVerified: true, packetVerified: true, packetLabel: LABEL, gitRoot: R1, oid: O1 }],
        commits: commitsOf(O1, O2),
      };
      const bytes = jsonOf(reportOf(a));
      for (let rep = 0; rep < 3; rep++) {
        expect(jsonOf(reportOf(a))).to.equal(bytes);
        expect(jsonOf(reportOf(b))).to.equal(bytes);
      }
    });
  });

  // =================================================================================================
  describe("(2c) the policy verdict: requireAll / requireSince over list order", function () {
    // O1 covered-verified, O2 uncovered, O3 covered-oid-only, O4 uncovered.
    function policyInput(policy) {
      return {
        commits: commitsOf(O1, O2, O3, O4),
        claims: [claim(O1, { rootVerified: true }), claim(O3)],
        policy,
      };
    }

    it("requireAll: every non-covered commit fails, in commit order, rule 'require-all'", function () {
      const report = reportOf(policyInput({ requireAll: true }));
      expect(report.policy).to.deep.equal({ requireAll: true, requireSince: null });
      expect(report.verdict.pass).to.equal(false);
      expect(report.verdict.failures).to.deep.equal([
        { oid: O2, rule: "require-all", status: "uncovered" },
        { oid: O4, rule: "require-all", status: "uncovered" },
      ]);
    });

    it("requireAll passes when everything is covered (oid-only coverage counts)", function () {
      const report = reportOf({
        commits: commitsOf(O1, O2),
        claims: [claim(O1, { rootVerified: true }), claim(O2)], // verified + oid-only
        policy: { requireAll: true },
      });
      expect(report.verdict).to.deep.equal({ pass: true, failures: [] });
    });

    it("requireSince: only the named commit and LATER (list order) must be covered — inclusive", function () {
      // since O2: O2 and O4 fail; O1 is BEFORE the anchor and exempt
      const r2 = reportOf(policyInput({ requireSince: O2 }));
      expect(r2.policy).to.deep.equal({ requireAll: false, requireSince: O2 });
      expect(r2.verdict.failures).to.deep.equal([
        { oid: O2, rule: "require-since", status: "uncovered" },
        { oid: O4, rule: "require-since", status: "uncovered" },
      ]);
      // since O3 (covered): only O4 fails — the earlier uncovered O2 is exempt
      const r3 = reportOf(policyInput({ requireSince: O3 }));
      expect(r3.verdict.failures).to.deep.equal([
        { oid: O4, rule: "require-since", status: "uncovered" },
      ]);
      // since the LAST commit, uncovered: it fails (inclusive)
      const r4 = reportOf(policyInput({ requireSince: O4 }));
      expect(r4.verdict.failures).to.deep.equal([
        { oid: O4, rule: "require-since", status: "uncovered" },
      ]);
    });

    it("both policies set: 'require-all' wins (it subsumes 'require-since')", function () {
      const report = reportOf(policyInput({ requireAll: true, requireSince: O3 }));
      expect(report.verdict.failures.map((f) => f.rule)).to.deep.equal([
        "require-all",
        "require-all",
      ]);
      expect(report.verdict.failures.map((f) => f.oid)).to.deep.equal([O2, O4]);
    });

    it("requireAll:false and absent policy normalize identically", function () {
      const explicit = reportOf(policyInput({ requireAll: false }));
      const absent = reportOf({ commits: policyInput().commits, claims: policyInput().claims });
      expect(jsonOf(explicit)).to.equal(jsonOf(absent));
      expect(explicit.verdict.pass).to.equal(true);
    });

    it("requireSince naming an oid NOT in the range is a named INPUT reject", function () {
      const r = evaluateCoverage(policyInput({ requireSince: OUT_OF_RANGE_OID }));
      expect(r.ok).to.equal(false);
      expect(r.reason).to.equal(REASONS.POLICY_SINCE_NOT_IN_RANGE);
      expect(r.field).to.equal("requireSince");
      // ... including over an empty range
      const empty = evaluateCoverage({ commits: [], claims: [], policy: { requireSince: O1 } });
      expect(empty.reason).to.equal(REASONS.POLICY_SINCE_NOT_IN_RANGE);
    });
  });

  // =================================================================================================
  describe("(2d) TOTAL on hostile input: every malformed field is a NAMED reject; nothing throws", function () {
    it("args shape: non-objects, exotica, unknown keys", function () {
      for (const bad of [null, undefined, 42, "str", [], new Date(0), new Map()]) {
        const r = evaluateCoverage(bad);
        expect(r.ok).to.equal(false);
        expect(r.reason).to.equal(REASONS.EVAL_BAD_INPUT);
      }
      const unknown = evaluateCoverage({ commits: [], claims: [], sneaky: 1 });
      expect(unknown.reason).to.equal(REASONS.EVAL_BAD_INPUT);
      expect(unknown.field).to.equal("sneaky");
    });

    it("commits: each malformation named and LOCATED", function () {
      const cases = [
        [{ claims: [] }, REASONS.COMMITS_NOT_ARRAY, undefined],
        [{ commits: "x", claims: [] }, REASONS.COMMITS_NOT_ARRAY, undefined],
        [{ commits: [null], claims: [] }, REASONS.COMMIT_NOT_OBJECT, 0],
        [{ commits: ["x"], claims: [] }, REASONS.COMMIT_NOT_OBJECT, 0],
        [{ commits: [new Date(0)], claims: [] }, REASONS.COMMIT_NOT_OBJECT, 0],
        [{ commits: [{ oid: O1, extra: 1 }], claims: [] }, REASONS.COMMIT_UNKNOWN_FIELD, 0],
        [{ commits: [{}], claims: [] }, REASONS.COMMIT_BAD_OID, 0],
        [{ commits: [{ oid: O1.slice(0, 39) }], claims: [] }, REASONS.COMMIT_BAD_OID, 0],
        [{ commits: [{ oid: O1 + "a" }], claims: [] }, REASONS.COMMIT_BAD_OID, 0],
        [{ commits: [{ oid: O1.toUpperCase() }], claims: [] }, REASONS.COMMIT_BAD_OID, 0],
        [{ commits: [{ oid: "0x" + O1.slice(2) }], claims: [] }, REASONS.COMMIT_BAD_OID, 0],
        [{ commits: [{ oid: 42 }], claims: [] }, REASONS.COMMIT_BAD_OID, 0],
        [{ commits: [{ oid: O1 }, { oid: O2 }, { oid: O1 }], claims: [] }, REASONS.COMMITS_DUPLICATE_OID, 2],
      ];
      for (const [input, reason, index] of cases) {
        const r = evaluateCoverage(input);
        expect(r.ok, JSON.stringify(input)).to.equal(false);
        expect(r.reason, JSON.stringify(input)).to.equal(reason);
        if (index !== undefined) expect(r.index, JSON.stringify(input)).to.equal(index);
      }
    });

    it("claims: each of the five fields strictly validated BY NAME (rootVerified: false and null are VALID)", function () {
      const C = commitsOf(O1);
      const cases = [
        [{ commits: C }, REASONS.CLAIMS_NOT_ARRAY],
        [{ commits: C, claims: {} }, REASONS.CLAIMS_NOT_ARRAY],
        [{ commits: C, claims: [null] }, REASONS.CLAIM_NOT_OBJECT],
        [{ commits: C, claims: [new Map()] }, REASONS.CLAIM_NOT_OBJECT],
        [{ commits: C, claims: [claim(O1, { extra: 1 })] }, REASONS.CLAIM_UNKNOWN_FIELD],
        [{ commits: C, claims: [claim(O1, { scope: "cli" })] }, REASONS.CLAIM_UNKNOWN_FIELD],
        [{ commits: C, claims: [claim("nope")] }, REASONS.CLAIM_BAD_OID],
        [{ commits: C, claims: [claim(O1.toUpperCase())] }, REASONS.CLAIM_BAD_OID],
        [{ commits: C, claims: [(() => { const c = claim(O1); delete c.oid; return c; })()] }, REASONS.CLAIM_BAD_OID],
        [{ commits: C, claims: [claim(O1, { gitRoot: R1.slice(2) })] }, REASONS.CLAIM_BAD_GIT_ROOT],
        [{ commits: C, claims: [claim(O1, { gitRoot: R1.toUpperCase() })] }, REASONS.CLAIM_BAD_GIT_ROOT],
        [{ commits: C, claims: [claim(O1, { gitRoot: O1 })] }, REASONS.CLAIM_BAD_GIT_ROOT],
        [{ commits: C, claims: [claim(O1, { gitRoot: undefined })] }, REASONS.CLAIM_BAD_GIT_ROOT],
        [{ commits: C, claims: [claim(O1, { packetLabel: "" })] }, REASONS.CLAIM_BAD_PACKET_LABEL],
        [{ commits: C, claims: [claim(O1, { packetLabel: "a\nb" })] }, REASONS.CLAIM_BAD_PACKET_LABEL],
        [{ commits: C, claims: [claim(O1, { packetLabel: "a\u0000b" })] }, REASONS.CLAIM_BAD_PACKET_LABEL],
        [{ commits: C, claims: [claim(O1, { packetLabel: "lone\ud800surrogate" })] }, REASONS.CLAIM_BAD_PACKET_LABEL],
        [{ commits: C, claims: [claim(O1, { packetLabel: "a".repeat(MAX_PACKET_LABEL_LENGTH + 1) })] }, REASONS.CLAIM_BAD_PACKET_LABEL],
        [{ commits: C, claims: [claim(O1, { packetLabel: 7 })] }, REASONS.CLAIM_BAD_PACKET_LABEL],
        [{ commits: C, claims: [claim(O1, { packetVerified: 1 })] }, REASONS.CLAIM_BAD_PACKET_VERIFIED],
        [{ commits: C, claims: [claim(O1, { packetVerified: "true" })] }, REASONS.CLAIM_BAD_PACKET_VERIFIED],
        [{ commits: C, claims: [claim(O1, { packetVerified: null })] }, REASONS.CLAIM_BAD_PACKET_VERIFIED],
        [{ commits: C, claims: [claim(O1, { packetVerified: undefined })] }, REASONS.CLAIM_BAD_PACKET_VERIFIED],
        [{ commits: C, claims: [claim(O1, { rootVerified: "yes" })] }, REASONS.CLAIM_BAD_ROOT_VERIFIED],
        [{ commits: C, claims: [claim(O1, { rootVerified: 0 })] }, REASONS.CLAIM_BAD_ROOT_VERIFIED],
        [{ commits: C, claims: [claim(O1, { rootVerified: undefined })] }, REASONS.CLAIM_BAD_ROOT_VERIFIED],
        [{ commits: C, claims: [(() => { const c = claim(O1); delete c.rootVerified; return c; })()] }, REASONS.CLAIM_BAD_ROOT_VERIFIED],
      ];
      for (const [input, reason] of cases) {
        const r = evaluateCoverage(input);
        expect(r.ok, JSON.stringify(input)).to.equal(false);
        expect(r.reason, JSON.stringify(input)).to.equal(reason);
      }
      // an out-of-range claim is still STRICTLY validated (ignored only if well-formed)
      const bad = evaluateCoverage({
        commits: C,
        claims: [claim(OUT_OF_RANGE_OID, { packetVerified: "x" })],
      });
      expect(bad.reason).to.equal(REASONS.CLAIM_BAD_PACKET_VERIFIED);
      // maximal VALID label accepted
      const okMax = evaluateCoverage({
        commits: C,
        claims: [claim(O1, { packetLabel: "a".repeat(MAX_PACKET_LABEL_LENGTH) })],
      });
      expect(okMax.ok).to.equal(true);
    });

    it("policy: closed shape, strictly typed, named rejects", function () {
      const base = { commits: commitsOf(O1), claims: [] };
      const cases = [
        [null, REASONS.POLICY_NOT_OBJECT],
        [[], REASONS.POLICY_NOT_OBJECT],
        ["all", REASONS.POLICY_NOT_OBJECT],
        [{ requireEverything: true }, REASONS.POLICY_UNKNOWN_FIELD],
        [{ requireAll: "yes" }, REASONS.POLICY_BAD_REQUIRE_ALL],
        [{ requireAll: 1 }, REASONS.POLICY_BAD_REQUIRE_ALL],
        [{ requireAll: undefined }, REASONS.POLICY_BAD_REQUIRE_ALL],
        [{ requireSince: O1.toUpperCase() }, REASONS.POLICY_BAD_REQUIRE_SINCE],
        [{ requireSince: 42 }, REASONS.POLICY_BAD_REQUIRE_SINCE],
        [{ requireSince: undefined }, REASONS.POLICY_BAD_REQUIRE_SINCE],
        [{ requireSince: "0x" + O1 }, REASONS.POLICY_BAD_REQUIRE_SINCE],
      ];
      for (const [policy, reason] of cases) {
        const r = evaluateCoverage(Object.assign({}, base, { policy }));
        expect(r.ok, JSON.stringify(policy)).to.equal(false);
        expect(r.reason, JSON.stringify(policy)).to.equal(reason);
      }
    });

    it("size caps: commits/claims beyond the cap are O(1) named rejects", function () {
      const manyCommits = Array.from({ length: MAX_COMMITS + 1 }, (_, i) => ({ oid: oid(i) }));
      const r1 = evaluateCoverage({ commits: manyCommits, claims: [] });
      expect(r1.ok).to.equal(false);
      expect(r1.reason).to.equal(REASONS.COMMITS_TOO_MANY);
      const manyClaims = new Array(MAX_CLAIMS + 1).fill(claim(O1));
      const r2 = evaluateCoverage({ commits: commitsOf(O1), claims: manyClaims });
      expect(r2.ok).to.equal(false);
      expect(r2.reason).to.equal(REASONS.CLAIMS_TOO_MANY);
    });

    it("hostile exotica (throwing getters) are contained: HOSTILE_INPUT, never a throw", function () {
      const trap = {};
      Object.defineProperty(trap, "commits", {
        enumerable: true,
        get() {
          throw new Error("boom");
        },
      });
      expect(evaluateCoverage(trap).reason).to.equal(REASONS.HOSTILE_INPUT);

      const trapCommit = {};
      Object.defineProperty(trapCommit, "oid", {
        enumerable: true,
        get() {
          throw new Error("boom");
        },
      });
      expect(
        evaluateCoverage({ commits: [trapCommit], claims: [] }).reason
      ).to.equal(REASONS.HOSTILE_INPUT);
    });

    it("every evaluate reject reason is drawn from the CLOSED named set", function () {
      const hostiles = [
        null,
        [],
        { commits: [{ oid: "zz" }], claims: [] },
        { commits: commitsOf(O1), claims: [{ oid: O1 }] },
        { commits: commitsOf(O1), claims: [], policy: { requireSince: O2 } },
      ];
      for (const h of hostiles) {
        const r = evaluateCoverage(h);
        expect(r.ok).to.equal(false);
        expect(ALL_NAMED_REASONS).to.include(r.reason);
      }
    });
  });

  // =================================================================================================
  describe("(3) serializeCoverageReport: pinned canonical bytes; strict; byte-diffable; sealable", function () {
    it("pins the EXACT canonical bytes (sorted keys, no whitespace, versioned kind)", function () {
      expect(jsonOf(reportOf(PIN_INPUT))).to.equal(PIN_BYTES);
      expect(PIN_BYTES).to.include('"kind":"vh-agent-coverage@1"');
    });

    it("keys are SORTED at every level (the artifact is canonical whatever the object insertion order)", function () {
      const report = reportOf(PIN_INPUT);
      // rebuild the report with hostile key insertion orders; bytes must not move
      const shuffled = {
        verdict: { pass: report.verdict.pass, failures: report.verdict.failures.map((f) => ({ status: f.status, rule: f.rule, oid: f.oid })) },
        totals: Object.fromEntries(Object.entries(report.totals).reverse()),
        policy: { requireSince: report.policy.requireSince, requireAll: report.policy.requireAll },
        kind: report.kind,
        commits: report.commits.map((c) => ({
          status: c.status,
          oid: c.oid,
          claims: c.claims.map((cl) => ({
            status: cl.status,
            rootVerified: cl.rootVerified,
            packetVerified: cl.packetVerified,
            packetLabel: cl.packetLabel,
            gitRoot: cl.gitRoot,
          })),
        })),
      };
      expect(jsonOf(shuffled)).to.equal(PIN_BYTES);
    });

    it("byte-diffable: one changed fact -> one localized byte difference, deterministically", function () {
      const a = jsonOf(reportOf(PIN_INPUT));
      const b = jsonOf(
        reportOf({
          commits: PIN_INPUT.commits,
          claims: [claim(O1, { rootVerified: null })], // the ONE fact that changed
          policy: PIN_INPUT.policy,
        })
      );
      expect(a).to.not.equal(b);
      expect(b).to.include('"rootVerified":null');
      expect(b).to.include('"status":"covered-oid-only"');
    });

    it("shape rejects are NAMED: non-object, bad kind, unknown/missing fields (at every level)", function () {
      for (const bad of [null, undefined, 42, "x", [], new Map()]) {
        expect(serializeCoverageReport(bad).reason).to.equal(REASONS.REPORT_NOT_OBJECT);
      }
      const report = reportOf(PIN_INPUT);

      const wrongKind = copy(report);
      wrongKind.kind = "vh-agent-coverage@2";
      expect(serializeCoverageReport(wrongKind).reason).to.equal(REASONS.REPORT_BAD_KIND);

      const extraTop = copy(report);
      extraTop.note = "hi";
      const r1 = serializeCoverageReport(extraTop);
      expect(r1.reason).to.equal(REASONS.REPORT_UNKNOWN_FIELD);
      expect(r1.field).to.equal("note");

      const missingTop = copy(report);
      delete missingTop.totals;
      const r2 = serializeCoverageReport(missingTop);
      expect(r2.reason).to.equal(REASONS.REPORT_MISSING_FIELD);
      expect(r2.field).to.equal("totals");

      const extraCommit = copy(report);
      extraCommit.commits[0].note = 1;
      expect(serializeCoverageReport(extraCommit).reason).to.equal(REASONS.REPORT_UNKNOWN_FIELD);

      const missingClaimField = copy(report);
      delete missingClaimField.commits[0].claims[0].rootVerified;
      const r3 = serializeCoverageReport(missingClaimField);
      expect(r3.reason).to.equal(REASONS.REPORT_MISSING_FIELD);
      expect(r3.field).to.equal("commits[0].claims[0].rootVerified");

      const badFacts = copy(report);
      badFacts.commits[0].claims[0].gitRoot = "nope";
      const r4 = serializeCoverageReport(badFacts);
      expect(r4.reason).to.equal(REASONS.CLAIM_BAD_GIT_ROOT);
      expect(r4.field).to.equal("commits[0].claims[0].gitRoot");

      const badStatus = copy(report);
      badStatus.commits[0].status = "blessed";
      expect(serializeCoverageReport(badStatus).reason).to.equal(REASONS.REPORT_BAD_FIELD);

      const claimUncovered = copy(report);
      claimUncovered.commits[0].claims[0].status = "uncovered"; // a CLAIM is never "uncovered"
      expect(serializeCoverageReport(claimUncovered).reason).to.equal(REASONS.REPORT_BAD_FIELD);

      const badTotalsKey = copy(report);
      badTotalsKey.totals.extra = 0;
      expect(serializeCoverageReport(badTotalsKey).reason).to.equal(REASONS.REPORT_UNKNOWN_FIELD);

      const badTotalsValue = copy(report);
      badTotalsValue.totals.uncovered = -1;
      expect(serializeCoverageReport(badTotalsValue).reason).to.equal(REASONS.REPORT_BAD_FIELD);

      const badRule = copy(report);
      badRule.verdict.failures[0].rule = "require-most";
      expect(serializeCoverageReport(badRule).reason).to.equal(REASONS.REPORT_BAD_FIELD);
    });

    it("INTERNAL CONSISTENCY is enforced: forged statuses/totals/verdicts are REPORT_INCONSISTENT", function () {
      const report = reportOf(PIN_INPUT);

      const flippedPass = copy(report);
      flippedPass.verdict.pass = true;
      expect(serializeCoverageReport(flippedPass).reason).to.equal(REASONS.REPORT_INCONSISTENT);

      const cookedTotals = copy(report);
      cookedTotals.totals.uncovered = 0;
      cookedTotals.totals["covered-verified"] = 2;
      expect(serializeCoverageReport(cookedTotals).reason).to.equal(REASONS.REPORT_INCONSISTENT);

      const flippedStatus = copy(report);
      flippedStatus.commits[1].status = "covered-verified"; // no claim backs this
      expect(serializeCoverageReport(flippedStatus).reason).to.equal(REASONS.REPORT_INCONSISTENT);

      const droppedFailure = copy(report);
      droppedFailure.verdict.failures = [];
      expect(serializeCoverageReport(droppedFailure).reason).to.equal(REASONS.REPORT_INCONSISTENT);

      const relabeledPolicy = copy(report);
      relabeledPolicy.policy.requireAll = false; // failures would then be wrong
      expect(serializeCoverageReport(relabeledPolicy).reason).to.equal(REASONS.REPORT_INCONSISTENT);

      const dupCommits = copy(report);
      dupCommits.commits[1] = copy(dupCommits.commits[0]);
      const dup = serializeCoverageReport(dupCommits);
      expect(dup.reason).to.equal(REASONS.REPORT_INCONSISTENT);
      expect(dup.detail).to.equal(REASONS.COMMITS_DUPLICATE_OID);
    });

    it("the 'unverified packet NEVER covered' rule holds even against a FULLY cooked report", function () {
      // Forge coverage from an unverified packet AND cook every dependent value to look consistent.
      const base = reportOf({
        commits: commitsOf(O1),
        claims: [claim(O1, { packetVerified: false, rootVerified: true })],
        policy: { requireAll: true },
      });
      const forged = copy(base);
      forged.commits[0].status = "covered-verified";
      forged.commits[0].claims[0].status = "covered-verified";
      forged.totals["claim-unverified-packet"] = 0;
      forged.totals["covered-verified"] = 1;
      forged.verdict = { pass: true, failures: [] };
      const r = serializeCoverageReport(forged);
      expect(r.ok).to.equal(false);
      expect(r.reason).to.equal(REASONS.REPORT_INCONSISTENT);
    });

    it("hostile exotica are contained: HOSTILE_INPUT, never a throw", function () {
      // a COMPLETE report whose commits field detonates only when actually read
      const trap = copy(reportOf(PIN_INPUT));
      Object.defineProperty(trap, "commits", {
        enumerable: true,
        get() {
          throw new Error("boom");
        },
      });
      expect(serializeCoverageReport(trap).reason).to.equal(REASONS.HOSTILE_INPUT);
    });
  });

  // =================================================================================================
  describe("(4) parseCoverageReport: the strict inverse", function () {
    it("round-trips: parse ∘ serialize is identity (deep-equal) and serialize ∘ parse is identity (bytes ===)", function () {
      const inputs = [
        PIN_INPUT,
        fiveWayInput(),
        { commits: [], claims: [] },
        {
          commits: commitsOf(O1, O2, O3, O4),
          claims: [claim(O1, { rootVerified: true }), claim(O3)],
          policy: { requireSince: O2 },
        },
      ];
      for (const input of inputs) {
        const report = reportOf(input);
        const s = jsonOf(report);
        const p = parseCoverageReport(s);
        expect(p.ok, s.slice(0, 80)).to.equal(true);
        expect(p.report).to.deep.equal(report);
        expect(jsonOf(p.report)).to.equal(s);
        // the parsed report is FRESH: mutating it cannot corrupt a later parse of the same bytes
        p.report.verdict.pass = !p.report.verdict.pass;
        expect(parseCoverageReport(s).report.verdict.pass).to.not.equal(p.report.verdict.pass);
      }
    });

    it("non-strings, oversize, non-JSON and non-object payloads: named, O(cap), never a throw", function () {
      for (const bad of [42, null, undefined, {}, [PIN_BYTES], Symbol("x")]) {
        expect(parseCoverageReport(bad).reason).to.equal(REASONS.REPORT_NOT_STRING);
      }
      expect(parseCoverageReport("x".repeat(MAX_REPORT_LENGTH + 1)).reason).to.equal(
        REASONS.REPORT_TOO_LARGE // length-checked BEFORE JSON.parse
      );
      for (const bad of ["", "not json", "{truncated", PIN_BYTES.slice(0, -1)]) {
        expect(parseCoverageReport(bad).reason).to.equal(REASONS.REPORT_NOT_JSON);
      }
      for (const bad of ["[]", "null", "42", '"a string"']) {
        expect(parseCoverageReport(bad).reason).to.equal(REASONS.REPORT_NOT_OBJECT);
      }
    });

    it("unknown kind/VERSION, extra and missing fields: each a NAMED reject", function () {
      // version bump and kind variants
      for (const badKind of ["vh-agent-coverage@2", "vh-agent-coverage@10", "vh-AGENT-coverage@1", "x@1"]) {
        const r = parseCoverageReport(PIN_BYTES.replace(REPORT_KIND, badKind));
        expect(r.ok, badKind).to.equal(false);
        expect(r.reason, badKind).to.equal(REASONS.REPORT_BAD_KIND);
      }
      // kind absent entirely
      const noKind = copy(reportOf(PIN_INPUT));
      delete noKind.kind;
      expect(parseCoverageReport(canon(noKind)).reason).to.equal(REASONS.REPORT_BAD_KIND);
      // extra top-level field (canonical-format bytes, so the SHAPE check is what fires)
      const extra = copy(reportOf(PIN_INPUT));
      extra.zz = 1;
      const r1 = parseCoverageReport(canon(extra));
      expect(r1.reason).to.equal(REASONS.REPORT_UNKNOWN_FIELD);
      expect(r1.field).to.equal("zz");
      // missing top-level field
      const missing = copy(reportOf(PIN_INPUT));
      delete missing.verdict;
      const r2 = parseCoverageReport(canon(missing));
      expect(r2.reason).to.equal(REASONS.REPORT_MISSING_FIELD);
      expect(r2.field).to.equal("verdict");
      // missing nested field
      const missingNested = copy(reportOf(PIN_INPUT));
      delete missingNested.commits[0].claims[0].packetVerified;
      expect(parseCoverageReport(canon(missingNested)).reason).to.equal(REASONS.REPORT_MISSING_FIELD);
      // "__proto__" arrives as an ordinary own key and is a named unknown field, not pollution
      const proto = parseCoverageReport(
        PIN_BYTES.slice(0, -1) + ',"__proto__":{"polluted":1}}'
      );
      expect(proto.ok).to.equal(false);
      expect(proto.reason).to.equal(REASONS.REPORT_UNKNOWN_FIELD);
      expect(({}).polluted).to.equal(undefined);
    });

    it("NON-CANONICAL byte representations of the SAME report are rejected (one report, one byte string)", function () {
      const variants = [
        " " + PIN_BYTES, // leading whitespace
        PIN_BYTES + "\n", // trailing newline
        PIN_BYTES.replace('"kind":', '"kind": '), // inner space
        // reordered keys (same JSON value, different bytes)
        '{"kind":"' + REPORT_KIND + '",' + PIN_BYTES.slice(1).replace(',"kind":"' + REPORT_KIND + '"', ""),
        // escape-sequence variant of the same string value ("v" === "v")
        PIN_BYTES.replace('"vh-agent-coverage@1"', '"\\u0076h-agent-coverage@1"'),
      ];
      for (const v of variants) {
        const r = parseCoverageReport(v);
        expect(r.ok, v.slice(0, 80)).to.equal(false);
        expect(r.reason, v.slice(0, 80)).to.equal(REASONS.REPORT_NOT_CANONICAL);
      }
    });

    it("FORGED but canonical-format bytes are REPORT_INCONSISTENT (pass, totals, and cooked coverage)", function () {
      const forgedPass = PIN_BYTES.replace('"pass":false', '"pass":true');
      expect(parseCoverageReport(forgedPass).reason).to.equal(REASONS.REPORT_INCONSISTENT);

      const forgedTotals = PIN_BYTES.replace('"uncovered":1', '"uncovered":0');
      expect(parseCoverageReport(forgedTotals).reason).to.equal(REASONS.REPORT_INCONSISTENT);

      // the parse-side of "unverified packet NEVER covered": cook a full report by hand
      const base = reportOf({
        commits: commitsOf(O1),
        claims: [claim(O1, { packetVerified: false, rootVerified: true })],
      });
      const forged = copy(base);
      forged.commits[0].status = "covered-verified";
      forged.commits[0].claims[0].status = "covered-verified";
      forged.totals["claim-unverified-packet"] = 0;
      forged.totals["covered-verified"] = 1;
      const r = parseCoverageReport(canon(forged));
      expect(r.ok).to.equal(false);
      expect(r.reason).to.equal(REASONS.REPORT_INCONSISTENT);
    });

    it("EXHAUSTIVE single-character tamper sweep: every edit is a named reject or an HONESTLY different report", function () {
      for (let i = 0; i < PIN_BYTES.length; i++) {
        const repl = PIN_BYTES[i] === "a" ? "b" : "a";
        const mutated = PIN_BYTES.slice(0, i) + repl + PIN_BYTES.slice(i + 1);
        const r = parseCoverageReport(mutated); // must never throw
        if (!r.ok) {
          expect(ALL_NAMED_REASONS, "pos " + i + ": " + r.reason).to.include(r.reason);
          continue;
        }
        // the edit produced a DIFFERENT valid report (e.g. a hex digit inside an oid/root that
        // appears exactly once): it must re-serialize to exactly the mutated bytes — the parser
        // never "repairs" input — and must NOT equal the original report.
        expect(jsonOf(r.report), "pos " + i).to.equal(mutated);
        expect(canon(r.report)).to.not.equal(PIN_BYTES);
      }
    });

    it("hostile parse input is contained: HOSTILE_INPUT or a named reject, never a throw", function () {
      // deep-nested arrays are structurally invalid long before any recursion could matter
      const deep = "[".repeat(1000) + "]".repeat(1000);
      expect(parseCoverageReport(deep).reason).to.equal(REASONS.REPORT_NOT_OBJECT);
    });
  });
});
