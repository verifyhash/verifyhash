"use strict";

// test/cli.core.agent-commit.test.js — DIRECT coverage of the PURE commit-claim core
// (cli/core/agent-commit.js, T-69.1): canonical claim payload, strict parser, the claim EVENT,
// disclosed-claim discovery, and the fact verifier.
//
// WHAT THIS PROVES (the T-69.1 acceptance criteria, each as an honest test):
//   (1) STATIC purity guard (same style as the agent-session/journal-log guards): the core's own
//       source requires ONLY ./agent-session — none of fs/child_process/http/https/net/dns/...,
//       no process.env (or `process` at all), no clock/randomness/key material, no inline crypto
//       — and the one allowed require is itself transitively clean (checked here as text too),
//       so nothing impure is REACHABLE from this core.
//   (2) DETERMINISM: the same facts yield BYTE-IDENTICAL payload strings across repeated calls
//       and across every key ordering of the input object; parse∘build and build∘parse both
//       round-trip; the exact canonical bytes are pinned as a literal.
//   (3) The built claim event passes agent-session validateEvent UNCHANGED, seals into a session
//       via the T-68.1 core, and the head is UNCHANGED when any OTHER event (or all of them) is
//       redacted — with the claim still findable (findCommitClaims), provable (proveEvent →
//       verifyEvent), and verifiable (verifyCommitClaim).
//   (4) TAMPER MATRIX: EVERY single-character edit of the canonical payload either draws a
//       specific NAMED reject or (a changed commit/gitRoot that stays well-formed) a named
//       oid-mismatch/root-mismatch from the verifier; hostile payloads (non-JSON, wrong
//       kind/version, extra fields, non-canonical bytes, huge strings, exotic objects) are
//       named rejects; NOTHING here ever throws.
//   (5) Reuse, not fork: cli/core/agent-session.js, cli/journal-log.js, cli/hash.js, cli/git.js
//       are byte-UNCHANGED by this task (the static guard forbids this core from redefining any
//       of their functions or referencing anything beyond the ./agent-session seam).
//
// PURITY OF THIS SUITE: no temp dirs, no sockets, no keys, no cwd side effects — the only fs use
// is reading core sources as TEXT for the static guard.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const core = require("../cli/core/agent-commit");
const {
  CLAIM_KIND,
  CLAIM_EVENT_TYPE,
  DEFAULT_ACTOR,
  MAX_SCOPE_LENGTH,
  MAX_PAYLOAD_LENGTH,
  REASONS,
  commitClaimPayload,
  parseCommitClaim,
  buildCommitClaimEvent,
  findCommitClaims,
  verifyCommitClaim,
} = core;

// The reused T-68.1 seam, imported DIRECTLY so acceptance-by-that-core is asserted verbatim.
const session = require("../cli/core/agent-session");

// ---------------------------------------------------------------------------------------------------
// Deterministic fixtures (no randomness — reruns are byte-identical).
// ---------------------------------------------------------------------------------------------------

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"; // 40-hex lowercase oid
const GIT_ROOT = "0x" + "0123456789abcdef".repeat(4); // 0x-bytes32 lowercase hex
const SCOPE = "cli/core";
const OTHER_COMMIT = "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OTHER_ROOT = "0x" + "fedcba9876543210".repeat(4);

// The pinned canonical bytes — the exact contract a future indexer/CLI can rely on.
const CANONICAL_PAYLOAD =
  '{"commit":"' + COMMIT + '","gitRoot":"' + GIT_ROOT + '","kind":"' + CLAIM_KIND + '","scope":"' + SCOPE + '"}';
const CANONICAL_PAYLOAD_NO_SCOPE =
  '{"commit":"' + COMMIT + '","gitRoot":"' + GIT_ROOT + '","kind":"' + CLAIM_KIND + '"}';

// Every reason code this core (or the reused session core, passed through) may name. The tamper
// loop asserts each reject's reason is drawn from this CLOSED set — "named, never generic".
const ALL_NAMED_REASONS = Object.freeze([
  ...Object.values(REASONS),
  ...Object.values(session.REASONS),
]);

function mkPlainEvent(i) {
  const e = {
    seq: i,
    ts: "2026-07-02T12:00:" + String(i % 60).padStart(2, "0") + "Z",
    actor: i % 2 === 0 ? "agent:assistant" : "tool:bash",
    type: session.EVENT_TYPES[i % session.EVENT_TYPES.length],
    payload: JSON.stringify({ i, text: "ordinary event #" + i + " — ünïcode ✓" }),
  };
  if (i % 3 === 0) e.meta = { step: i };
  return e;
}

// A 6-event session with the claim event at index `k` (default 2).
function sessionWithClaim(k = 2) {
  const events = [];
  for (let i = 0; i < 6; i++) {
    if (i === k) {
      const b = buildCommitClaimEvent({
        seq: i,
        ts: "2026-07-02T12:00:0" + i + "Z",
        actor: "agent:assistant",
        commit: COMMIT,
        gitRoot: GIT_ROOT,
        scope: SCOPE,
      });
      expect(b.ok, JSON.stringify(b)).to.equal(true);
      events.push(b.event);
    } else {
      events.push(mkPlainEvent(i));
    }
  }
  return events;
}

function headOf(events) {
  const h = session.sessionHead(events);
  expect(h.ok, "fixture session must derive a head: " + JSON.stringify(h)).to.equal(true);
  return h;
}

function redactedTwin(e) {
  const r = session.redactEvent(e);
  expect(r.ok, JSON.stringify(r)).to.equal(true);
  return r.event;
}

describe("cli/core/agent-commit.js — pure commit-claim core (T-69.1)", function () {
  // =================================================================================================
  describe("(1) STATIC purity guard: no fs/git/net/env/clock/keys reachable; reuse, not fork", function () {
    let raw;
    let src; // comments stripped, so prose can neither hide nor fake a dependency
    before(function () {
      raw = fs.readFileSync(path.join(__dirname, "..", "cli", "core", "agent-commit.js"), "utf8");
      src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    });

    it("every require() takes a string literal (no dynamic-require hole in this guard)", function () {
      const re = /\brequire\s*\(/g;
      let m;
      let count = 0;
      while ((m = re.exec(src)) !== null) {
        const rest = src.slice(m.index + m[0].length);
        expect(rest, "non-literal require()").to.match(/^\s*["'][^"']+["']\s*\)/);
        count++;
      }
      expect(count).to.be.greaterThan(0);
    });

    it("requires NONE of fs/http/https/net/dns/tls/dgram/child_process/os/zlib/vm/worker_threads/cluster/readline", function () {
      for (const mod of [
        "fs", "http", "https", "net", "dns", "tls", "dgram", "child_process",
        "os", "zlib", "vm", "worker_threads", "cluster", "readline",
      ]) {
        const re = new RegExp("require\\(\\s*['\"](node:)?" + mod + "['\"]\\s*\\)");
        expect(re.test(src), "must not require '" + mod + "'").to.equal(false);
      }
    });

    it("never touches process (so no process.env, argv, exit, hrtime, ...)", function () {
      expect(/\bprocess\s*[.[]/.test(src), "must not reference process").to.equal(false);
    });

    it("requires ONLY ./agent-session (all git-derived facts are CALLER-SUPPLIED)", function () {
      const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
      expect(requires.length).to.be.greaterThan(0);
      for (const r of requires) {
        expect(["./agent-session"], "unexpected require('" + r + "')").to.include(r);
      }
    });

    it("never references git plumbing or fs-walking hash helpers (facts come from the caller)", function () {
      expect(
        /resolveCommit|runGit|repoRoot|listTrackedFiles|gitProvenance|hashGit|hashFile|hashDir|hashPath|hashEntries|listFiles/.test(
          src
        ),
        "must not reference cli/git.js or cli/hash.js file/git helpers"
      ).to.equal(false);
    });

    it("has no clock or randomness (pure, deterministic)", function () {
      expect(/Date\.now|new Date\b|Math\.random|randomBytes|performance\.now|hrtime/.test(src)).to.equal(
        false
      );
    });

    it("does no signer/keyfile work (no Wallet, no private key, no fs read/write)", function () {
      expect(/\bWallet\b|privateKey|PRIVATE_KEY|readFileSync|writeFileSync|openSync/.test(src)).to.equal(
        false
      );
    });

    it("REUSES the session core — forks nothing (no local event/tree/hash reimplementation)", function () {
      expect(
        /function\s+(validateEvent|validateSession|eventLeaf|redactEvent|sessionHead|proveEvent|verifyEvent|treeHead|inclusionProof|verifyInclusion|consistencyProof|verifyConsistency|leafHash|nodeHash)\b/.test(
          src
        ),
        "must not redefine any agent-session/journal-log function"
      ).to.equal(false);
      expect(/keccak|sha-?3|sha-?256/i.test(src), "must not inline a hash primitive").to.equal(false);
    });

    it("the ONE allowed require is transitively clean: agent-session still requires only ../hash, ../journal-log, ethers", function () {
      // Closes the "reachable from the core" loop WITHIN this suite: agent-commit reaches only
      // agent-session, which reaches only the two audited pure seams plus the ethers byte helper
      // (each with its own standing guard).
      const sess = fs
        .readFileSync(path.join(__dirname, "..", "cli", "core", "agent-session.js"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const requires = [...sess.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
      expect(requires.length).to.be.greaterThan(0);
      for (const r of requires) {
        expect(["../hash", "../journal-log", "ethers"], "unexpected require('" + r + "')").to.include(r);
      }
      for (const mod of ["fs", "http", "https", "net", "dns", "child_process"]) {
        const re = new RegExp("require\\(\\s*['\"](node:)?" + mod + "['\"]\\s*\\)");
        expect(re.test(sess), "agent-session must not require '" + mod + "'").to.equal(false);
      }
    });
  });

  // =================================================================================================
  describe("(2) commitClaimPayload / parseCommitClaim: determinism, canonical bytes, round-trips", function () {
    it("pins the EXACT canonical bytes (sorted keys, no whitespace, lowercase hex)", function () {
      const withScope = commitClaimPayload({ commit: COMMIT, gitRoot: GIT_ROOT, scope: SCOPE });
      expect(withScope.ok).to.equal(true);
      expect(withScope.payload).to.equal(CANONICAL_PAYLOAD);
      const noScope = commitClaimPayload({ commit: COMMIT, gitRoot: GIT_ROOT });
      expect(noScope.ok).to.equal(true);
      expect(noScope.payload).to.equal(CANONICAL_PAYLOAD_NO_SCOPE);
    });

    it("BYTE-IDENTICAL output across repeated calls and across every input key ordering", function () {
      const orderings = [
        { commit: COMMIT, gitRoot: GIT_ROOT, scope: SCOPE },
        { scope: SCOPE, gitRoot: GIT_ROOT, commit: COMMIT },
        { gitRoot: GIT_ROOT, scope: SCOPE, commit: COMMIT },
        { scope: SCOPE, commit: COMMIT, gitRoot: GIT_ROOT },
        { kind: CLAIM_KIND, scope: SCOPE, commit: COMMIT, gitRoot: GIT_ROOT }, // explicit kind ok
      ];
      for (const input of orderings) {
        for (let rep = 0; rep < 3; rep++) {
          const r = commitClaimPayload(input);
          expect(r.ok, JSON.stringify(input)).to.equal(true);
          expect(r.payload).to.equal(CANONICAL_PAYLOAD);
        }
      }
    });

    it("parse ∘ build round-trips (claim deep-equals) and build ∘ parse round-trips (bytes ===)", function () {
      for (const input of [
        { commit: COMMIT, gitRoot: GIT_ROOT, scope: SCOPE },
        { commit: COMMIT, gitRoot: GIT_ROOT },
        { commit: COMMIT, gitRoot: GIT_ROOT, scope: "a/b/c.sol" },
        { commit: COMMIT, gitRoot: GIT_ROOT, scope: "päth/ünïcode ✓" }, // non-ASCII scope is legal
      ]) {
        const built = commitClaimPayload(input);
        expect(built.ok).to.equal(true);
        const parsed = parseCommitClaim(built.payload);
        expect(parsed.ok, built.payload).to.equal(true);
        expect(parsed.claim).to.deep.equal(built.claim);
        expect(parsed.claim.kind).to.equal(CLAIM_KIND);
        // a parsed claim feeds STRAIGHT back through the builder to the same bytes
        const rebuilt = commitClaimPayload(parsed.claim);
        expect(rebuilt.ok).to.equal(true);
        expect(rebuilt.payload).to.equal(built.payload);
      }
    });

    it("builder rejects each malformed field BY NAME (strict lowercase hex, POSIX scope)", function () {
      const cases = [
        [{ gitRoot: GIT_ROOT }, REASONS.CLAIM_BAD_COMMIT], // commit missing
        [{ commit: COMMIT.slice(0, 39), gitRoot: GIT_ROOT }, REASONS.CLAIM_BAD_COMMIT], // 39 hex
        [{ commit: COMMIT + "a", gitRoot: GIT_ROOT }, REASONS.CLAIM_BAD_COMMIT], // 41 hex
        [{ commit: COMMIT.toUpperCase(), gitRoot: GIT_ROOT }, REASONS.CLAIM_BAD_COMMIT], // uppercase
        [{ commit: "0x" + COMMIT.slice(2), gitRoot: GIT_ROOT }, REASONS.CLAIM_BAD_COMMIT], // 0x-prefixed oid
        [{ commit: 42, gitRoot: GIT_ROOT }, REASONS.CLAIM_BAD_COMMIT],
        [{ commit: null, gitRoot: GIT_ROOT }, REASONS.CLAIM_BAD_COMMIT],
        [{ commit: COMMIT }, REASONS.CLAIM_BAD_GIT_ROOT], // gitRoot missing
        [{ commit: COMMIT, gitRoot: GIT_ROOT.slice(2) }, REASONS.CLAIM_BAD_GIT_ROOT], // no 0x
        [{ commit: COMMIT, gitRoot: GIT_ROOT.slice(0, 65) }, REASONS.CLAIM_BAD_GIT_ROOT], // short
        [{ commit: COMMIT, gitRoot: GIT_ROOT.toUpperCase() }, REASONS.CLAIM_BAD_GIT_ROOT], // uppercase
        [{ commit: COMMIT, gitRoot: COMMIT }, REASONS.CLAIM_BAD_GIT_ROOT], // an oid is not a root
        [{ commit: COMMIT, gitRoot: GIT_ROOT, scope: "" }, REASONS.CLAIM_BAD_SCOPE],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, scope: "/abs/path" }, REASONS.CLAIM_BAD_SCOPE],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, scope: "dir/" }, REASONS.CLAIM_BAD_SCOPE],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, scope: "a//b" }, REASONS.CLAIM_BAD_SCOPE],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, scope: "../up" }, REASONS.CLAIM_BAD_SCOPE],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, scope: "a/./b" }, REASONS.CLAIM_BAD_SCOPE],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, scope: "win\\path" }, REASONS.CLAIM_BAD_SCOPE],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, scope: "has\nnewline" }, REASONS.CLAIM_BAD_SCOPE],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, scope: "a".repeat(MAX_SCOPE_LENGTH + 1) }, REASONS.CLAIM_BAD_SCOPE],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, scope: "lone\ud800surrogate" }, REASONS.CLAIM_BAD_SCOPE],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, scope: 7 }, REASONS.CLAIM_BAD_SCOPE],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, scope: undefined }, REASONS.CLAIM_BAD_SCOPE], // present-but-undefined
        [{ commit: COMMIT, gitRoot: GIT_ROOT, kind: "vh-agent-commit-claim@2" }, REASONS.CLAIM_BAD_KIND],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, kind: "something-else@1" }, REASONS.CLAIM_BAD_KIND],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, extra: 1 }, REASONS.CLAIM_UNKNOWN_FIELD],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, signature: "0xabc" }, REASONS.CLAIM_UNKNOWN_FIELD],
      ];
      for (const [input, reason] of cases) {
        const r = commitClaimPayload(input);
        expect(r.ok, JSON.stringify(input)).to.equal(false);
        expect(r.reason, JSON.stringify(input)).to.equal(reason);
        expect(r.field).to.be.a("string");
      }
    });

    it("builder is TOTAL on hostile input (non-objects, exotica, throwing getters): named reject, never throws", function () {
      for (const bad of [null, undefined, 42, "str", [], new Date(0), new Map(), Symbol("x"), () => {}]) {
        const r = commitClaimPayload(bad);
        expect(r.ok).to.equal(false);
        expect(r.reason).to.equal(REASONS.CLAIM_NOT_OBJECT);
      }
      const trap = {};
      Object.defineProperty(trap, "commit", {
        enumerable: true,
        get() {
          throw new Error("boom");
        },
      });
      const r = commitClaimPayload(trap);
      expect(r.ok).to.equal(false);
      expect(r.reason).to.equal(REASONS.HOSTILE_INPUT);
    });

    it("valid scopes are accepted: single file, nested dir, dotfiles, unicode", function () {
      for (const scope of ["a", "a/b", "cli/core/agent-commit.js", ".github/workflows", "docs/ünïcode ✓.md"]) {
        const r = commitClaimPayload({ commit: COMMIT, gitRoot: GIT_ROOT, scope });
        expect(r.ok, scope).to.equal(true);
        const p = parseCommitClaim(r.payload);
        expect(p.ok, scope).to.equal(true);
        expect(p.claim.scope).to.equal(scope);
      }
    });
  });

  // =================================================================================================
  describe("(3) buildCommitClaimEvent + the T-68.1 session: seal, redact OTHERS, head UNCHANGED", function () {
    it("the built event passes agent-session validateEvent UNCHANGED and is a canonical full note", function () {
      const b = buildCommitClaimEvent({
        seq: 0,
        ts: "2026-07-02T12:00:00Z",
        commit: COMMIT,
        gitRoot: GIT_ROOT,
        scope: SCOPE,
      });
      expect(b.ok).to.equal(true);
      expect(b.event.type).to.equal(CLAIM_EVENT_TYPE);
      expect(b.event.actor).to.equal(DEFAULT_ACTOR); // default actor when unnamed
      expect(b.event.payload).to.equal(CANONICAL_PAYLOAD);
      expect(b.payload).to.equal(CANONICAL_PAYLOAD);
      expect(b.claim).to.deep.equal({ kind: CLAIM_KIND, commit: COMMIT, gitRoot: GIT_ROOT, scope: SCOPE });
      const v = session.validateEvent(b.event);
      expect(v.ok).to.equal(true);
      expect(v.redacted).to.equal(false);
      // deterministic: rebuild -> identical event object
      const b2 = buildCommitClaimEvent({
        seq: 0,
        ts: "2026-07-02T12:00:00Z",
        commit: COMMIT,
        gitRoot: GIT_ROOT,
        scope: SCOPE,
      });
      expect(b2.event).to.deep.equal(b.event);
      // named actor respected
      const b3 = buildCommitClaimEvent({
        seq: 0,
        ts: "2026-07-02T12:00:00Z",
        actor: "agent:assistant",
        commit: COMMIT,
        gitRoot: GIT_ROOT,
      });
      expect(b3.ok).to.equal(true);
      expect(b3.event.actor).to.equal("agent:assistant");
    });

    it("bad seq/ts/actor pass through as the SESSION core's own named rejects; claim-side faults keep claim names", function () {
      const good = { seq: 0, ts: "t", commit: COMMIT, gitRoot: GIT_ROOT };
      const cases = [
        [{ ...good, seq: -1 }, session.REASONS.EVENT_BAD_SEQ],
        [{ ...good, seq: 1.5 }, session.REASONS.EVENT_BAD_SEQ],
        [(() => { const c = { ...good }; delete c.seq; return c; })(), session.REASONS.EVENT_BAD_SEQ],
        [{ ...good, ts: 1751457600 }, session.REASONS.EVENT_BAD_TS],
        [(() => { const c = { ...good }; delete c.ts; return c; })(), session.REASONS.EVENT_BAD_TS],
        [{ ...good, actor: "" }, session.REASONS.EVENT_BAD_ACTOR],
        [{ ...good, actor: 7 }, session.REASONS.EVENT_BAD_ACTOR],
        [{ ...good, commit: "nope" }, REASONS.CLAIM_BAD_COMMIT],
        [{ ...good, gitRoot: "nope" }, REASONS.CLAIM_BAD_GIT_ROOT],
        [{ ...good, scope: "/abs" }, REASONS.CLAIM_BAD_SCOPE],
        [{ ...good, kind: "wrong@9" }, REASONS.CLAIM_BAD_KIND],
        [{ ...good, payload: "smuggled" }, REASONS.CLAIM_UNKNOWN_FIELD],
        [{ ...good, meta: { a: 1 } }, REASONS.CLAIM_UNKNOWN_FIELD],
      ];
      for (const [input, reason] of cases) {
        const r = buildCommitClaimEvent(input);
        expect(r.ok, JSON.stringify(input)).to.equal(false);
        expect(r.reason, JSON.stringify(input)).to.equal(reason);
      }
      expect(buildCommitClaimEvent(null).reason).to.equal(REASONS.CLAIM_NOT_OBJECT);
    });

    it("head UNCHANGED when any OTHER single event is redacted — claim still found, proven, verified", function () {
      const k = 2;
      const events = sessionWithClaim(k);
      const fullHead = headOf(events);

      for (let i = 0; i < events.length; i++) {
        if (i === k) continue;
        const withOneRedacted = events.map((e, j) => (j === i ? redactedTwin(e) : e));
        const h = headOf(withOneRedacted);
        expect(h.root, "redacting event " + i + " must not move the head").to.equal(fullHead.root);
        expect(h.size).to.equal(fullHead.size);

        const found = findCommitClaims(withOneRedacted);
        expect(found.ok).to.equal(true);
        expect(found.claims).to.have.length(1);
        expect(found.claims[0].index).to.equal(k);
        expect(found.claims[0].seq).to.equal(k);
        expect(found.claims[0].claim.commit).to.equal(COMMIT);

        const pv = session.proveEvent(withOneRedacted, k);
        expect(pv.ok).to.equal(true);
        const ve = session.verifyEvent(pv.proof, fullHead);
        expect(ve.ok).to.equal(true);

        const vc = verifyCommitClaim({ event: pv.proof.event, expected: { commit: COMMIT, gitRoot: GIT_ROOT } });
        expect(vc.ok).to.equal(true);
        expect(vc.seq).to.equal(k);
        expect(vc.claim.gitRoot).to.equal(GIT_ROOT);
      }
    });

    it("head UNCHANGED when ALL other events are redacted at once (redact-all-but-claim disclosure)", function () {
      const k = 2;
      const events = sessionWithClaim(k);
      const fullHead = headOf(events);
      const allOthersRedacted = events.map((e, j) => (j === k ? e : redactedTwin(e)));
      const h = headOf(allOthersRedacted);
      expect(h.root).to.equal(fullHead.root);

      const found = findCommitClaims(allOthersRedacted);
      expect(found.ok).to.equal(true);
      expect(found.claims).to.have.length(1);
      expect(found.claims[0].payload).to.equal(CANONICAL_PAYLOAD);
      // the returned event is a DEEP COPY, never aliasing caller state
      found.claims[0].event.payload = "mutated";
      expect(allOthersRedacted[k].payload).to.equal(CANONICAL_PAYLOAD);

      const pv = session.proveEvent(allOthersRedacted, k);
      const ve = session.verifyEvent(pv.proof, fullHead);
      expect(ve.ok).to.equal(true);
      expect(verifyCommitClaim({ event: pv.proof.event, expected: { commit: COMMIT, gitRoot: GIT_ROOT } }).ok).to.equal(true);
    });

    it("a REDACTED claim keeps the head but is no longer disclosed: not found, and verify names it", function () {
      const k = 2;
      const events = sessionWithClaim(k);
      const fullHead = headOf(events);
      const claimRedacted = events.map((e, j) => (j === k ? redactedTwin(e) : e));
      expect(headOf(claimRedacted).root).to.equal(fullHead.root); // redaction never moves the head

      const found = findCommitClaims(claimRedacted);
      expect(found.ok).to.equal(true);
      expect(found.claims).to.have.length(0); // withheld bytes are not disclosable

      const vc = verifyCommitClaim({ event: claimRedacted[k], expected: { commit: COMMIT, gitRoot: GIT_ROOT } });
      expect(vc.ok).to.equal(false);
      expect(vc.reason).to.equal(REASONS.BAD_CLAIM);
      expect(vc.detail).to.equal(REASONS.CLAIM_REDACTED);
    });

    it("tampering the SEALED claim event moves the head (payload, seq, ts each bind)", function () {
      const k = 2;
      const events = sessionWithClaim(k);
      const fullHead = headOf(events);
      // payload byte flip
      const flipped = events.map((e, j) =>
        j === k ? { ...e, payload: e.payload.replace(COMMIT, OTHER_COMMIT) } : e
      );
      expect(headOf(flipped).root).to.not.equal(fullHead.root);
      // ts edit
      const tsEdit = events.map((e, j) => (j === k ? { ...e, ts: e.ts.replace("12", "13") } : e));
      expect(headOf(tsEdit).root).to.not.equal(fullHead.root);
      // actor edit
      const actorEdit = events.map((e, j) => (j === k ? { ...e, actor: "agent:other" } : e));
      expect(headOf(actorEdit).root).to.not.equal(fullHead.root);
    });

    it("findCommitClaims: strict discovery — only canonical `note` payloads count; multiples all found", function () {
      // a claim-shaped payload on a NON-note event is NOT a canonical claim
      const disguised = [
        { seq: 0, ts: "t", actor: "a", type: "completion", payload: CANONICAL_PAYLOAD },
        { seq: 1, ts: "t", actor: "a", type: "note", payload: " " + CANONICAL_PAYLOAD }, // non-canonical bytes
        { seq: 2, ts: "t", actor: "a", type: "note", payload: "just a note" },
      ];
      const f1 = findCommitClaims(disguised);
      expect(f1.ok).to.equal(true);
      expect(f1.claims).to.have.length(0);

      // two claims (e.g. a re-claim after an amend) are BOTH returned, in order
      const two = sessionWithClaim(1);
      const b = buildCommitClaimEvent({
        seq: 4,
        ts: "2026-07-02T12:00:04Z",
        commit: OTHER_COMMIT,
        gitRoot: OTHER_ROOT,
      });
      expect(b.ok).to.equal(true);
      two[4] = b.event;
      const f2 = findCommitClaims(two);
      expect(f2.ok).to.equal(true);
      expect(f2.claims.map((c) => c.index)).to.deep.equal([1, 4]);
      expect(f2.claims[0].claim.commit).to.equal(COMMIT);
      expect(f2.claims[1].claim.commit).to.equal(OTHER_COMMIT);

      // an INVALID session is the session core's own named, LOCATED reject — passed through
      const broken = sessionWithClaim(2);
      broken[3] = { ...broken[3], seq: 9 };
      const f3 = findCommitClaims(broken);
      expect(f3.ok).to.equal(false);
      expect(f3.reason).to.equal(session.REASONS.SESSION_SEQ_NOT_CONTIGUOUS);
      expect(f3.index).to.equal(3);

      expect(findCommitClaims("not an array").reason).to.equal(session.REASONS.SESSION_NOT_ARRAY);
      expect(findCommitClaims(null).reason).to.equal(session.REASONS.SESSION_NOT_ARRAY);
    });
  });

  // =================================================================================================
  describe("(4) tamper matrix: every byte edit and every hostile payload draws a NAMED reject", function () {
    it("EVERY single-character edit of the canonical payload is caught BY NAME (exhaustive sweep)", function () {
      const expected = { commit: COMMIT, gitRoot: GIT_ROOT };
      for (let i = 0; i < CANONICAL_PAYLOAD.length; i++) {
        const repl = CANONICAL_PAYLOAD[i] === "a" ? "b" : "a";
        const mutated = CANONICAL_PAYLOAD.slice(0, i) + repl + CANONICAL_PAYLOAD.slice(i + 1);
        const r = parseCommitClaim(mutated); // must never throw
        if (!r.ok) {
          // structural/kind/hex-breaking edits: a SPECIFIC named reason from the closed set
          expect(ALL_NAMED_REASONS, "pos " + i + ": " + r.reason).to.include(r.reason);
          continue;
        }
        // the edit produced a DIFFERENT well-formed claim: the verifier must name any fact drift
        const v = verifyCommitClaim({ payloadString: mutated, expected });
        if (r.claim.commit !== COMMIT) {
          expect(v.ok, "pos " + i).to.equal(false);
          expect(v.reason).to.equal("oid-mismatch");
          expect(v.field).to.equal("commit");
          expect(v.claimed).to.equal(r.claim.commit);
          expect(v.expected).to.equal(COMMIT);
        } else if (r.claim.gitRoot !== GIT_ROOT) {
          expect(v.ok, "pos " + i).to.equal(false);
          expect(v.reason).to.equal("root-mismatch");
          expect(v.field).to.equal("gitRoot");
        } else {
          // only the UNVERIFIED scope hint changed — facts intact, verifier accepts (documented)
          expect(r.claim.scope, "pos " + i).to.not.equal(SCOPE);
          expect(v.ok).to.equal(true);
        }
      }
    });

    it("oid edit -> oid-mismatch; root edit -> root-mismatch; kind/version edit -> CLAIM_BAD_KIND", function () {
      const expected = { commit: COMMIT, gitRoot: GIT_ROOT };
      const oid = verifyCommitClaim({
        payloadString: CANONICAL_PAYLOAD.replace(COMMIT, OTHER_COMMIT),
        expected,
      });
      expect(oid.ok).to.equal(false);
      expect(oid.reason).to.equal("oid-mismatch");

      const root = verifyCommitClaim({
        payloadString: CANONICAL_PAYLOAD.replace(GIT_ROOT, OTHER_ROOT),
        expected,
      });
      expect(root.ok).to.equal(false);
      expect(root.reason).to.equal("root-mismatch");

      for (const badKind of ["vh-agent-commit-claim@2", "vh-agent-commit-claim@10", "vh-agent-COMMIT-claim@1", "x@1"]) {
        const p = parseCommitClaim(CANONICAL_PAYLOAD.replace(CLAIM_KIND, badKind));
        expect(p.ok, badKind).to.equal(false);
        expect(p.reason, badKind).to.equal(REASONS.CLAIM_BAD_KIND);
        const v = verifyCommitClaim({ payloadString: CANONICAL_PAYLOAD.replace(CLAIM_KIND, badKind), expected });
        expect(v.ok).to.equal(false);
        expect(v.reason).to.equal("bad-claim");
        expect(v.detail).to.equal(REASONS.CLAIM_BAD_KIND);
      }
    });

    it("hostile payload strings: non-JSON / non-object / extra fields / missing fields / dupes / huge — each named, never a throw", function () {
      const cases = [
        [42, REASONS.PAYLOAD_NOT_STRING],
        [null, REASONS.PAYLOAD_NOT_STRING],
        [undefined, REASONS.PAYLOAD_NOT_STRING],
        [{}, REASONS.PAYLOAD_NOT_STRING],
        [[CANONICAL_PAYLOAD], REASONS.PAYLOAD_NOT_STRING],
        ["", REASONS.PAYLOAD_NOT_JSON],
        ["not json at all", REASONS.PAYLOAD_NOT_JSON],
        ["{truncated", REASONS.PAYLOAD_NOT_JSON],
        [CANONICAL_PAYLOAD.slice(0, -1), REASONS.PAYLOAD_NOT_JSON],
        ["[]", REASONS.CLAIM_NOT_OBJECT],
        ["null", REASONS.CLAIM_NOT_OBJECT],
        ["42", REASONS.CLAIM_NOT_OBJECT],
        ['"a string"', REASONS.CLAIM_NOT_OBJECT],
        ["{}", REASONS.CLAIM_BAD_KIND], // kind absent
        ['{"commit":"' + COMMIT + '","gitRoot":"' + GIT_ROOT + '"}', REASONS.CLAIM_BAD_KIND],
        [CANONICAL_PAYLOAD_NO_SCOPE.slice(0, -1) + ',"extra":1}', REASONS.CLAIM_UNKNOWN_FIELD],
        [CANONICAL_PAYLOAD_NO_SCOPE.slice(0, -1) + ',"__proto__":{"polluted":1}}', REASONS.CLAIM_UNKNOWN_FIELD],
        ['{"gitRoot":"' + GIT_ROOT + '","kind":"' + CLAIM_KIND + '"}', REASONS.CLAIM_BAD_COMMIT],
        ['{"commit":"' + COMMIT + '","kind":"' + CLAIM_KIND + '"}', REASONS.CLAIM_BAD_GIT_ROOT],
        ["x".repeat(MAX_PAYLOAD_LENGTH + 1), REASONS.PAYLOAD_TOO_LARGE],
        ['{"commit":"' + "a".repeat(10 * MAX_PAYLOAD_LENGTH) + '"}', REASONS.PAYLOAD_TOO_LARGE], // O(1), pre-parse
      ];
      for (const [input, reason] of cases) {
        const r = parseCommitClaim(input);
        expect(r.ok, String(input).slice(0, 60)).to.equal(false);
        expect(r.reason, String(input).slice(0, 60)).to.equal(reason);
      }
    });

    it("NON-CANONICAL byte representations of a VALID claim are rejected (one claim, one byte string)", function () {
      const variants = [
        " " + CANONICAL_PAYLOAD, // leading whitespace
        CANONICAL_PAYLOAD + "\n", // trailing newline
        CANONICAL_PAYLOAD.replace('","gitRoot"', '", "gitRoot"'), // inner space
        // reordered keys (same JSON value, different bytes)
        '{"kind":"' + CLAIM_KIND + '","commit":"' + COMMIT + '","gitRoot":"' + GIT_ROOT + '","scope":"' + SCOPE + '"}',
        // duplicate key, last one canonical-valued
        '{"commit":"' + OTHER_COMMIT + '","commit":"' + COMMIT + '","gitRoot":"' + GIT_ROOT + '","kind":"' + CLAIM_KIND + '"}',
        // escape-sequence variant of the same string value ("v" === "v")
        CANONICAL_PAYLOAD.replace('"vh-agent', '"\\u0076h-agent'),
      ];
      for (const v of variants) {
        const r = parseCommitClaim(v);
        expect(r.ok, v.slice(0, 80)).to.equal(false);
        expect(r.reason, v.slice(0, 80)).to.equal(REASONS.PAYLOAD_NOT_CANONICAL);
      }
    });

    it("verifyCommitClaim is strict about its OWN call shape (named, never a throw)", function () {
      const expected = { commit: COMMIT, gitRoot: GIT_ROOT };
      const event = sessionWithClaim(2)[2];
      // malformed args object
      for (const bad of [null, undefined, 42, "x", []]) {
        expect(verifyCommitClaim(bad).reason).to.equal(REASONS.VERIFY_BAD_INPUT);
      }
      // neither or both sources
      expect(verifyCommitClaim({ expected }).reason).to.equal(REASONS.VERIFY_BAD_INPUT);
      expect(
        verifyCommitClaim({ event, payloadString: CANONICAL_PAYLOAD, expected }).reason
      ).to.equal(REASONS.VERIFY_BAD_INPUT);
      // unknown arg key
      expect(verifyCommitClaim({ payloadString: CANONICAL_PAYLOAD, expected, sneaky: 1 }).reason).to.equal(
        REASONS.VERIFY_BAD_INPUT
      );
      // malformed expected: missing/extra/uppercase/non-object
      for (const [badExpected, field] of [
        [undefined, "expected"],
        [null, "expected"],
        ["x", "expected"],
        [{ commit: COMMIT }, "gitRoot"],
        [{ gitRoot: GIT_ROOT }, "commit"],
        [{ commit: COMMIT.toUpperCase(), gitRoot: GIT_ROOT }, "commit"],
        [{ commit: COMMIT, gitRoot: GIT_ROOT.toUpperCase() }, "gitRoot"],
        [{ commit: COMMIT, gitRoot: GIT_ROOT, scope: SCOPE }, "scope"], // scope is NOT a verifiable fact
      ]) {
        const r = verifyCommitClaim({ payloadString: CANONICAL_PAYLOAD, expected: badExpected });
        expect(r.ok, JSON.stringify(badExpected)).to.equal(false);
        expect(r.reason).to.equal(REASONS.VERIFY_BAD_EXPECTED);
        expect(r.field).to.equal(field);
      }
    });

    it("event-mode strictness: invalid event / wrong type / redacted -> bad-claim with the underlying detail", function () {
      const expected = { commit: COMMIT, gitRoot: GIT_ROOT };
      const good = sessionWithClaim(2)[2];

      const extraField = verifyCommitClaim({ event: { ...good, sig: "0x" }, expected });
      expect(extraField.reason).to.equal(REASONS.BAD_CLAIM);
      expect(extraField.detail).to.equal(session.REASONS.EVENT_UNKNOWN_FIELD);

      const wrongType = verifyCommitClaim({ event: { ...good, type: "completion" }, expected });
      expect(wrongType.reason).to.equal(REASONS.BAD_CLAIM);
      expect(wrongType.detail).to.equal(REASONS.CLAIM_BAD_EVENT_TYPE);

      const notAClaim = verifyCommitClaim({ event: mkPlainEvent(4), expected });
      expect(notAClaim.reason).to.equal(REASONS.BAD_CLAIM);
      expect([REASONS.PAYLOAD_NOT_CANONICAL, REASONS.PAYLOAD_NOT_JSON, REASONS.CLAIM_NOT_OBJECT, REASONS.CLAIM_BAD_KIND]).to.include(
        notAClaim.detail
      );

      const hostileEvent = verifyCommitClaim({ event: "not an event", expected });
      expect(hostileEvent.reason).to.equal(REASONS.BAD_CLAIM);
      expect(hostileEvent.detail).to.equal(session.REASONS.EVENT_NOT_OBJECT);
    });
  });

  // =================================================================================================
  describe("(5) reuse, not fork: the shared seams are byte-level intact for this suite's assertions", function () {
    it("the claim event's leaf is REDACTION-SAFE exactly per the session core (leaf equality)", function () {
      const e = sessionWithClaim(2)[2];
      const leafFull = session.eventLeaf(e);
      const leafRedacted = session.eventLeaf(redactedTwin(e));
      expect(leafFull).to.match(/^0x[0-9a-f]{64}$/);
      expect(leafRedacted).to.equal(leafFull);
    });

    it("payload commitment of the claim is the session core's payloadHash of the canonical bytes", function () {
      const e = sessionWithClaim(2)[2];
      const v = session.validateEvent(e);
      expect(v.ok).to.equal(true);
      expect(v.payloadHash).to.equal(session.payloadHash(CANONICAL_PAYLOAD));
    });
  });
});
