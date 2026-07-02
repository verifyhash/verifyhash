"use strict";

// test/cli.core.agent-session.test.js — DIRECT coverage of the PURE agent-session core
// (cli/core/agent-session.js, T-68.1): canonical events, redaction-safe leaves, ordered head, proofs.
//
// WHAT THIS PROVES (the T-68.1 acceptance criteria, each as an honest test):
//   (1) STATIC purity guard (same style as the journal-log/browser-core guards): the core's own
//       source requires NONE of fs/http/https/net/dns/tls/dgram/child_process/..., never touches
//       process.env (or `process` at all), has no clock/randomness/key material, requires ONLY the
//       two audited pure seams (cli/hash.js — hashBytes alone — and cli/journal-log.js) plus the
//       ethers byte helper, and FORKS neither (no local tree/keccak implementation).
//   (2) Property-style tests over sessions of size 1..N: full and redacted twins derive IDENTICAL
//       leaves and IDENTICAL heads; ONE payload byte flipped, an event dropped/reordered/inserted,
//       or a seq/actor/type/ts (or meta) edit CHANGES the root — or, where the edit breaks seq
//       contiguity, is REJECTED BY NAME. Hostile input always yields named verdicts, never throws.
//   (3) proveEvent -> verifyEvent round-trips for every (size, index), full and redacted; a
//       fabricated/altered event, a tampered path, or a proof replayed against the wrong head is
//       REJECTED.
//   (4) verifyGrowth accepts every (m <= n) prefix pair and REJECTS a rewritten-history pair (an
//       edited past event between checkpoint m and head n).
//   (5) Reuse, not fork: sessionHead delegates to cli/journal-log.js treeHead VERBATIM (equality is
//       asserted against a direct journal-log computation over the same leaves), and the static
//       guard forbids any local reimplementation. (cli/journal-log.js and cli/hash.js themselves
//       are byte-unchanged by T-68.1 — nothing here patches or shadows them.)
//
// PURITY OF THIS SUITE: no temp dirs, no sockets, no keys, no cwd side effects — the only fs use is
// reading cli/core/agent-session.js as TEXT for the static guard.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const core = require("../cli/core/agent-session");
const {
  EVENT_TYPES,
  LEAF_DOMAIN,
  REASONS,
  payloadHash,
  validateEvent,
  eventLeaf,
  redactEvent,
  validateSession,
  sessionHead,
  proveEvent,
  verifyEvent,
  proveGrowth,
  verifyGrowth,
} = core;

// The reused seams, imported DIRECTLY so delegation can be asserted as equality (criterion 5).
const journalLog = require("../cli/journal-log");
const { hashBytes } = require("../cli/hash");
const { toUtf8Bytes } = require("ethers");

const HEX32 = /^0x[0-9a-f]{64}$/; // leaves/roots are normalized lowercase hex

// Largest session size for the exhaustive property loops. Crosses the power-of-two tree-shape
// boundaries (8, 15, 16) — the tree itself is exhaustively covered by journal-log.core.test.js;
// here the loops prove the SESSION layer preserves those guarantees.
const N = 16;

// ---------------------------------------------------------------------------------------------------
// Deterministic fixtures (no randomness — reruns are byte-identical).
// ---------------------------------------------------------------------------------------------------

function mkEvent(i, salt = "") {
  const e = {
    seq: i,
    ts: "2026-07-02T12:00:" + String(i % 60).padStart(2, "0") + "Z",
    actor: i % 2 === 0 ? "agent:assistant" : "tool:bash",
    type: EVENT_TYPES[i % EVENT_TYPES.length],
    payload: JSON.stringify({ i, salt, text: "payload #" + i + " — ünïcode ✓" }),
  };
  if (i % 3 === 0) e.meta = { step: i, model: "fable-5", tags: ["x", { deep: true }] };
  return e;
}

function session(n, salt = "") {
  const out = [];
  for (let i = 0; i < n; i++) out.push(mkEvent(i, salt));
  return out;
}

function headOf(events) {
  const h = sessionHead(events);
  expect(h.ok, "fixture session must derive a head: " + JSON.stringify(h)).to.equal(true);
  return h;
}

function redactedTwin(e) {
  const r = redactEvent(e);
  expect(r.ok, "fixture event must redact: " + JSON.stringify(r)).to.equal(true);
  return r.event;
}

// Flip one character (= one byte of the UTF-8 payload) at `pos`.
function flipChar(s, pos) {
  const c = s.charCodeAt(pos);
  return s.slice(0, pos) + String.fromCharCode(c === 35 ? 42 : 35) + s.slice(pos + 1);
}

// Restore seq contiguity after a structural edit (the "adversary covers their tracks" variant).
function renumber(events) {
  return events.map((e, i) => ({ ...e, seq: i }));
}

describe("cli/core/agent-session.js — pure agent-session core (T-68.1)", function () {
  // =================================================================================================
  describe("(1) STATIC purity guard: no fs/net/env/clock/keys reachable; reuse, not fork", function () {
    let raw;
    let src; // comments stripped, so prose can neither hide nor fake a dependency
    before(function () {
      raw = fs.readFileSync(path.join(__dirname, "..", "cli", "core", "agent-session.js"), "utf8");
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

    it("requires ONLY ../hash, ../journal-log, and ethers", function () {
      const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
      expect(requires.length).to.be.greaterThan(0);
      for (const r of requires) {
        expect(["../hash", "../journal-log", "ethers"], "unexpected require('" + r + "')").to.include(r);
      }
    });

    it("imports ONLY the pure hashBytes from ../hash and references none of its fs-walking helpers", function () {
      // The ../hash seam is on the allowlist because exactly ONE symbol crosses it: hashBytes, the
      // pure keccak over in-memory bytes (the same discipline cli/journal-log.js is guarded to).
      expect(src).to.match(/const\s*\{\s*hashBytes\s*\}\s*=\s*require\(\s*["']\.\.\/hash["']\s*\)/);
      expect(
        /hashFile|hashDir|hashGit|hashPath|hashEntries|listFiles|proofForIndex|buildTree/.test(src),
        "must not reference any filesystem-walking export of cli/hash.js"
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

    it("REUSES the tree and the hash — forks neither (no local tree functions, no inline keccak/sha)", function () {
      expect(
        /function\s+(treeHead|inclusionProof|verifyInclusion|consistencyProof|verifyConsistency|leafHash|nodeHash)\b/.test(
          src
        ),
        "must not redefine any journal-log tree function"
      ).to.equal(false);
      expect(/keccak|sha-?3|sha-?256/i.test(src), "must not inline a hash primitive").to.equal(false);
    });
  });

  // =================================================================================================
  describe("(2a) canonical event schema: strict validation, named rejects, never throws", function () {
    const full = () => mkEvent(0);

    it("accepts a valid FULL event and its valid REDACTED twin", function () {
      const e = full();
      const v = validateEvent(e);
      expect(v.ok).to.equal(true);
      expect(v.redacted).to.equal(false);
      expect(v.payloadHash).to.equal(payloadHash(e.payload));

      const r = redactedTwin(e);
      const vr = validateEvent(r);
      expect(vr.ok).to.equal(true);
      expect(vr.redacted).to.equal(true);
      expect(vr.payloadHash).to.equal(v.payloadHash);
    });

    it("every type in the CLOSED set is accepted; anything else is EVENT_BAD_TYPE", function () {
      expect(EVENT_TYPES).to.deep.equal(["prompt", "completion", "tool_call", "tool_result", "note"]);
      for (const t of EVENT_TYPES) {
        expect(validateEvent({ ...full(), type: t }).ok).to.equal(true);
      }
      for (const t of ["PROMPT", "tool-call", "toolcall", "", "message", 7, null, undefined]) {
        const v = validateEvent({ ...full(), type: t });
        expect(v.ok, String(t)).to.equal(false);
        expect(v.reason).to.equal(REASONS.EVENT_BAD_TYPE);
      }
    });

    it("missing / malformed / extra fields -> the NAMED reject for that field", function () {
      const cases = [
        // [mutate, expectedReason]
        [(e) => delete e.seq, REASONS.EVENT_BAD_SEQ],
        [(e) => (e.seq = -1), REASONS.EVENT_BAD_SEQ],
        [(e) => (e.seq = 1.5), REASONS.EVENT_BAD_SEQ],
        [(e) => (e.seq = "0"), REASONS.EVENT_BAD_SEQ],
        [(e) => delete e.ts, REASONS.EVENT_BAD_TS],
        [(e) => (e.ts = 1751457600), REASONS.EVENT_BAD_TS], // non-string ts (a unix number) rejected
        [(e) => (e.ts = null), REASONS.EVENT_BAD_TS],
        [(e) => delete e.actor, REASONS.EVENT_BAD_ACTOR],
        [(e) => (e.actor = ""), REASONS.EVENT_BAD_ACTOR],
        [(e) => (e.actor = { name: "x" }), REASONS.EVENT_BAD_ACTOR],
        [(e) => delete e.type, REASONS.EVENT_BAD_TYPE],
        [(e) => (e.payload = 42), REASONS.EVENT_BAD_PAYLOAD],
        [(e) => (e.payload = undefined), REASONS.EVENT_BAD_PAYLOAD], // present-but-undefined is malformed
        [(e) => (e.payloadHash = "0x123"), REASONS.EVENT_BAD_PAYLOAD_HASH],
        [(e) => (e.payloadHash = "deadbeef"), REASONS.EVENT_BAD_PAYLOAD_HASH],
        [(e) => (e.payloadHash = payloadHash("something else")), REASONS.EVENT_PAYLOAD_HASH_MISMATCH],
        [(e) => (e.redacted = "yes"), REASONS.EVENT_BAD_REDACTED_FLAG],
        [(e) => (e.extra = 1), REASONS.EVENT_UNKNOWN_FIELD],
        [(e) => (e.signature = "0xabc"), REASONS.EVENT_UNKNOWN_FIELD],
        [(e) => {
          delete e.payload; // no payload AND no commitment
        }, REASONS.EVENT_MISSING_PAYLOAD],
        [(e) => (e.redacted = true), REASONS.EVENT_REDACTED_WITH_PAYLOAD], // flagged but payload present
        [(e) => {
          // payload absent + commitment present but NOT flagged: redaction must be a declared act
          e.payloadHash = payloadHash(e.payload);
          delete e.payload;
        }, REASONS.EVENT_UNFLAGGED_REDACTION],
        [(e) => {
          // redacted:true but no commitment carried
          delete e.payload;
          e.payloadHash = payloadHash("x");
          e.redacted = true;
          delete e.payloadHash;
        }, REASONS.EVENT_MISSING_PAYLOAD],
        [(e) => (e.meta = { f: () => 1 }), REASONS.EVENT_BAD_META],
        [(e) => (e.meta = { x: NaN }), REASONS.EVENT_BAD_META],
        [(e) => (e.meta = { x: Infinity }), REASONS.EVENT_BAD_META],
        [(e) => (e.meta = { x: undefined }), REASONS.EVENT_BAD_META],
        [(e) => (e.meta = new Date(0)), REASONS.EVENT_BAD_META], // non-plain object
        [(e) => (e.meta = undefined), REASONS.EVENT_BAD_META],
      ];
      for (const [mutate, reason] of cases) {
        const e = full();
        mutate(e);
        let v;
        expect(() => (v = validateEvent(e)), JSON.stringify(e)).to.not.throw();
        expect(v.ok, JSON.stringify(e)).to.equal(false);
        expect(v.reason, JSON.stringify(e)).to.equal(reason);
      }
    });

    it("a FULL event MAY carry its matching payloadHash; the commitment is cross-checked", function () {
      const e = full();
      e.payloadHash = payloadHash(e.payload);
      const v = validateEvent(e);
      expect(v.ok).to.equal(true);
      // ... and an UPPERCASE (but matching) commitment is accepted and normalized.
      const up = { ...full(), payloadHash: payloadHash(full().payload).toUpperCase().replace(/^0X/, "0x") };
      const vu = validateEvent(up);
      expect(vu.ok).to.equal(true);
      expect(vu.payloadHash).to.equal(payloadHash(full().payload));
    });

    it("cyclic / too-deep / exotic meta is EVENT_BAD_META — detected, not a stack overflow", function () {
      const cyclic = {};
      cyclic.self = cyclic;
      let deep = {};
      let d = deep;
      for (let i = 0; i < 100; i++) {
        d.x = {};
        d = d.x;
      }
      for (const meta of [cyclic, deep, new Map(), Object.create({ evil: 1 })]) {
        let v;
        expect(() => (v = validateEvent({ ...full(), meta }))).to.not.throw();
        expect(v.ok).to.equal(false);
        expect(v.reason).to.equal(REASONS.EVENT_BAD_META);
      }
      // ...while a reasonably-nested plain-JSON meta is fine.
      expect(validateEvent({ ...full(), meta: { a: [1, "x", null, { b: true }] } }).ok).to.equal(true);
    });

    it("a lone/unpaired UTF-16 surrogate payload is TOTAL — null commitment, EVENT_BAD_PAYLOAD, null leaf (never throws)", function () {
      // These are LEGAL JS strings (truncated log fields, a \uD800 that survived JSON, UTF-16
      // slicing) with a LONE/UNPAIRED HIGH surrogate — no valid UTF-8 encoding, so ethers'
      // toUtf8Bytes throws INVALID_ARGUMENT on them. Every entry point must absorb that and return
      // a named verdict / null, never leak the throw.
      const badStrings = ["\uD800", "pre\uD834post", "lead\uDBFF", "a\uD800b\uDFFFc", "\uD834trail"];
      for (const s of badStrings) {
        let ph;
        expect(() => (ph = payloadHash(s)), JSON.stringify(s)).to.not.throw();
        expect(ph, JSON.stringify(s)).to.equal(null);

        const e = { seq: 0, ts: "t", actor: "a", type: "note", payload: s };
        let v;
        expect(() => (v = validateEvent(e)), JSON.stringify(s)).to.not.throw();
        expect(v.ok).to.equal(false);
        // Specific, LOCATED reject (not a coarse HOSTILE_INPUT): the payload is the culprit.
        expect(v.reason).to.equal(REASONS.EVENT_BAD_PAYLOAD);
        expect(v.field).to.equal("payload");

        let leaf;
        expect(() => (leaf = eventLeaf(e))).to.not.throw();
        expect(leaf).to.equal(null);

        // The same bad string as a self-asserted commitment is caught earlier as a bad hash, and a
        // whole session carrying such an event surfaces the located reject rather than throwing.
        const vs = validateSession([e]);
        expect(vs.ok).to.equal(false);
        expect(vs).to.deep.include({ reason: REASONS.EVENT_BAD_PAYLOAD, index: 0 });
        expect(sessionHead([e]).ok).to.equal(false);
      }
      // A VALID surrogate PAIR (a real astral code point) is fine — it is encodable UTF-8.
      expect(payloadHash("𝄞")).to.equal(hashBytes(toUtf8Bytes("𝄞")));
      expect(validateEvent({ seq: 0, ts: "t", actor: "a", type: "note", payload: "𝄞" }).ok).to.equal(true);
    });

    it("a SHARED-REFERENCE (DAG) meta is EVENT_BAD_META — bounded work, not a hang or OOM", function () {
      // O(k) objects but ~2^k naive visits: reuse ONE child twice per level. The DEPTH cap does NOT
      // catch this (the tree is only ~k deep); only the total-work budget does. Without the budget
      // this OOM-kills the process (uncatchable SIGKILL) — the antithesis of "always a named verdict".
      const mkDag = (levels) => {
        let n = { leaf: 1 };
        for (let i = 0; i < levels; i++) n = { a: n, b: n };
        return n;
      };
      for (const levels of [24, 40, 64]) {
        const started = Date.now();
        let v;
        expect(() => (v = validateEvent({ ...full(), meta: mkDag(levels) })), "levels " + levels).to.not.throw();
        expect(v.ok, "levels " + levels).to.equal(false);
        expect(v.reason).to.equal(REASONS.EVENT_BAD_META);
        expect(v.field).to.equal("meta");
        // Bounded work: the budget short-circuits well under a second (empirically ~40ms).
        expect(Date.now() - started, "canonicalization must be bounded, not a hang").to.be.lessThan(5000);
      }
      // The blowup is reachable through the untrusted proof boundary too (verifyEvent validates the
      // submitted event's meta BEFORE the inclusion check) — it must be a verdict there as well.
      const evilProof = {
        event: { seq: 0, ts: "t", actor: "a", type: "note", payload: "p", meta: mkDag(48) },
        inclusion: { leafIndex: 0, treeSize: 1, path: [] },
      };
      let vp;
      expect(() => (vp = verifyEvent(evilProof, "0x" + "0".repeat(64)))).to.not.throw();
      expect(vp.ok).to.equal(false);
      expect(vp.reason).to.equal(REASONS.EVENT_BAD_META);
      // A legitimately LARGE (but tree-shaped, non-shared) meta well under the budget still passes.
      const wide = { rows: Array.from({ length: 2000 }, (_, i) => ({ i, k: "v" + i })) };
      expect(validateEvent({ ...full(), meta: wide }).ok).to.equal(true);
    });

    it("NEVER throws: every exported function survives a battery of hostile inputs", function () {
      const cyclic = {};
      cyclic.self = cyclic;
      // A meta that reuses ONE child twice per level: O(k) objects but ~2^k naive visits — the
      // shared-reference DAG the depth cap alone would NOT stop. Must be a NAMED verdict, not OOM.
      let dag = { leaf: 1 };
      for (let i = 0; i < 30; i++) dag = { a: dag, b: dag };
      const junk = [
        null, undefined, 0, -1, 1.5, NaN, Infinity, "", "x", "0x12", true, false,
        // Lone/unpaired UTF-16 surrogates: LEGAL JS strings with no UTF-8 encoding (ethers'
        // toUtf8Bytes throws INVALID_ARGUMENT on them). payloadHash/validateEvent/eventLeaf must
        // stay TOTAL on these, not leak the exception.
        "\uD800", "pre\uDC00post", "\uD834trail", "lead\uDBFF",
        [], [1, 2], {}, { a: 1 }, () => {}, Symbol("s"), 9n, cyclic,
        // Constructed events carrying hostile meta / payload (exercise the inner canonical/commit
        // paths, which the bare-junk cases above never reach through the object shape).
        { seq: 0, ts: "t", actor: "a", type: "note", payload: "p", meta: dag },
        { seq: 0, ts: "t", actor: "a", type: "note", payload: "\uD800" },
      ];
      const good = session(3);
      const goodHead = headOf(good);
      const goodProof = proveEvent(good, 1).proof;
      for (const j of junk) {
        const calls = [
          () => payloadHash(j),
          () => validateEvent(j),
          () => eventLeaf(j),
          () => redactEvent(j),
          () => validateSession(j),
          () => sessionHead(j),
          () => proveEvent(j, 0),
          () => proveEvent(good, j),
          () => verifyEvent(j, goodHead),
          () => verifyEvent(goodProof, j),
          () => proveGrowth(j, 1, 1),
          () => proveGrowth(good, j, j),
          () => verifyGrowth(j, j, j),
          () => verifyGrowth(goodHead, goodHead, j),
        ];
        for (const call of calls) {
          let out;
          expect(call, String(typeof j) + ":" + String(j && j.toString ? "obj" : j)).to.not.throw();
          out = call();
          // Every verdict-shaped result is a named verdict; generators may return null.
          if (out !== null && typeof out === "object" && "ok" in out && out.ok === false) {
            expect(out.reason).to.be.a("string");
          }
        }
      }
    });

    it("session-level: non-array and non-contiguous seq are NAMED, LOCATED rejects", function () {
      expect(validateSession("nope")).to.deep.include({ ok: false, reason: REASONS.SESSION_NOT_ARRAY });
      // gap
      const gap = session(4);
      gap[2] = { ...gap[2], seq: 3 };
      const vGap = validateSession(gap);
      expect(vGap).to.deep.include({ ok: false, reason: REASONS.SESSION_SEQ_NOT_CONTIGUOUS, index: 2 });
      // duplicate
      const dup = session(4);
      dup[3] = { ...dup[3], seq: 2 };
      expect(validateSession(dup)).to.deep.include({
        ok: false,
        reason: REASONS.SESSION_SEQ_NOT_CONTIGUOUS,
        index: 3,
      });
      // wrong start (seq must begin at 0 — it IS the tree position)
      const shifted = session(3).map((e) => ({ ...e, seq: e.seq + 1 }));
      expect(validateSession(shifted)).to.deep.include({
        ok: false,
        reason: REASONS.SESSION_SEQ_NOT_CONTIGUOUS,
        index: 0,
      });
      // an invalid EVENT is located too
      const bad = session(3);
      bad[1] = { ...bad[1], ts: 123 };
      const vBad = validateSession(bad);
      expect(vBad).to.deep.include({ ok: false, reason: REASONS.EVENT_BAD_TS, index: 1 });
      // ...and sessionHead surfaces the same located verdict instead of a root
      expect(sessionHead(bad)).to.deep.include({ ok: false, reason: REASONS.EVENT_BAD_TS, index: 1 });
    });
  });

  // =================================================================================================
  describe("(2b) redaction safety: full and redacted twins — IDENTICAL leaves, IDENTICAL heads (1..N)", function () {
    it("for every size 1..N: per-event leaves and the session head are identical after redaction", function () {
      for (let n = 1; n <= N; n++) {
        const fullSession = session(n);
        const redacted = fullSession.map(redactedTwin);
        for (let i = 0; i < n; i++) {
          const lf = eventLeaf(fullSession[i]);
          const lr = eventLeaf(redacted[i]);
          expect(lf, `leaf ${n}/${i}`).to.match(HEX32);
          expect(lr, `redacted leaf ${n}/${i}`).to.equal(lf);
        }
        const hf = headOf(fullSession);
        const hr = headOf(redacted);
        expect(hr.root, `head ${n}`).to.equal(hf.root);
        expect(hr.size).to.equal(hf.size);
        // Partial redaction (every other event) also preserves the head.
        const partial = fullSession.map((e, i) => (i % 2 === 0 ? redactedTwin(e) : e));
        expect(headOf(partial).root, `partial head ${n}`).to.equal(hf.root);
      }
    });

    it("redactEvent: drops the payload, carries the commitment, declares redacted:true, is idempotent", function () {
      const e = mkEvent(0);
      const twin = redactedTwin(e);
      expect(twin).to.not.have.property("payload");
      expect(twin.redacted).to.equal(true);
      expect(twin.payloadHash).to.equal(payloadHash(e.payload));
      expect(twin.seq).to.equal(e.seq);
      expect(twin.ts).to.equal(e.ts);
      expect(twin.actor).to.equal(e.actor);
      expect(twin.type).to.equal(e.type);
      // Idempotent: redacting the twin yields an equal twin.
      expect(redactedTwin(twin)).to.deep.equal(twin);
      // Invalid input propagates the named reject (never throws).
      const r = redactEvent({ ...e, type: "nope" });
      expect(r.ok).to.equal(false);
      expect(r.reason).to.equal(REASONS.EVENT_BAD_TYPE);
    });

    it("the twin's meta is a canonical DEEP COPY — mutating the original later cannot reach it", function () {
      const e = mkEvent(0); // i % 3 === 0 -> has meta
      const twin = redactedTwin(e);
      expect(twin.meta).to.deep.equal(e.meta);
      const leafBefore = eventLeaf(twin);
      e.meta.step = 999; // hostile late mutation of caller state
      expect(eventLeaf(twin)).to.equal(leafBefore);
      expect(twin.meta.step).to.equal(0);
    });

    it("meta KEY ORDER does not matter (canonicalized), but meta CONTENT does", function () {
      const a = { ...mkEvent(1), meta: { alpha: 1, beta: [2, 3] } };
      const b = { ...mkEvent(1), meta: { beta: [2, 3], alpha: 1 } };
      expect(eventLeaf(a)).to.equal(eventLeaf(b));
      const c = { ...mkEvent(1), meta: { alpha: 1, beta: [3, 2] } };
      expect(eventLeaf(c)).to.not.equal(eventLeaf(a));
      // absent meta and meta:null are DISTINCT canonical events
      expect(eventLeaf({ ...mkEvent(1), meta: null })).to.not.equal(eventLeaf(mkEvent(1)));
    });
  });

  // =================================================================================================
  describe("(2c) tamper detection: any edit changes the root or is rejected by name (1..N)", function () {
    it("ONE payload byte flipped -> different leaf, different root (every size, every position for n=9)", function () {
      for (let n = 1; n <= N; n++) {
        const s = session(n);
        const h = headOf(s);
        const k = n >> 1;
        const tampered = s.map((e, i) =>
          i === k ? { ...e, payload: flipChar(e.payload, e.payload.length >> 1) } : e
        );
        const ht = headOf(tampered);
        expect(ht.root, `flip ${n}@${k}`).to.not.equal(h.root);
      }
      // exhaustively at n=9: a flip at ANY position is detected
      const s9 = session(9);
      const h9 = headOf(s9);
      for (let i = 0; i < 9; i++) {
        const t = s9.map((e, j) => (j === i ? { ...e, payload: flipChar(e.payload, 0) } : e));
        expect(eventLeaf(t[i])).to.not.equal(eventLeaf(s9[i]));
        expect(headOf(t).root, `flip 9@${i}`).to.not.equal(h9.root);
      }
    });

    it("actor / type / ts / meta edits change the root; a seq edit is REJECTED by name", function () {
      const s = session(7);
      const h = headOf(s);
      const edits = [
        (e) => ({ ...e, actor: e.actor + "!" }),
        (e) => ({ ...e, type: e.type === "note" ? "prompt" : "note" }),
        (e) => ({ ...e, ts: e.ts.replace("12:00", "12:01") }),
      ];
      for (const [name, edit] of [["actor", edits[0]], ["type", edits[1]], ["ts", edits[2]]]) {
        const t = s.map((e, i) => (i === 3 ? edit(e) : e));
        expect(headOf(t).root, name).to.not.equal(h.root);
      }
      // meta edit (bound into the leaf as well)
      const tm = s.map((e, i) => (i === 3 ? { ...e, meta: { step: -1 } } : e));
      expect(headOf(tm).root).to.not.equal(h.root);
      // A lone seq edit cannot even produce a head: contiguity is broken -> NAMED, LOCATED reject.
      const ts = s.map((e, i) => (i === 3 ? { ...e, seq: 5 } : e));
      const v = sessionHead(ts);
      expect(v.ok).to.equal(false);
      expect(v.reason).to.equal(REASONS.SESSION_SEQ_NOT_CONTIGUOUS);
      expect(v.index).to.equal(3);
    });

    it("drop / reorder / insert: rejected by name as-is; root CHANGES even if the adversary renumbers", function () {
      const s = session(8);
      const h = headOf(s);

      // dropped middle event, seqs left alone -> named reject
      const dropped = s.slice(0, 4).concat(s.slice(5));
      expect(sessionHead(dropped)).to.include({ ok: false, reason: REASONS.SESSION_SEQ_NOT_CONTIGUOUS });
      // ...renumbered to cover the tracks -> valid session, DIFFERENT root
      expect(headOf(renumber(dropped)).root).to.not.equal(h.root);

      // dropped LAST event (still contiguous) -> different root
      expect(headOf(s.slice(0, 7)).root).to.not.equal(h.root);

      // reordered (swap 2 and 3), seqs left alone -> named reject
      const swapped = s.slice();
      [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
      expect(sessionHead(swapped)).to.include({ ok: false, reason: REASONS.SESSION_SEQ_NOT_CONTIGUOUS });
      // ...renumbered -> DIFFERENT root (position-bound tree: order IS meaning)
      expect(headOf(renumber(swapped)).root).to.not.equal(h.root);

      // inserted duplicate at position 4, renumbered -> DIFFERENT root
      const inserted = renumber(s.slice(0, 4).concat([s[4]], s.slice(4)));
      expect(headOf(inserted).root).to.not.equal(h.root);
    });
  });

  // =================================================================================================
  describe("(3) proveEvent -> verifyEvent: round-trips for every (size, index); forgeries rejected", function () {
    it("round-trips for EVERY (size 1..N, index) — full, redacted-disclosure, and redacted-session", function () {
      for (let n = 1; n <= N; n++) {
        const s = session(n);
        const head = headOf(s);
        const redacted = s.map(redactedTwin);
        for (let i = 0; i < n; i++) {
          const p = proveEvent(s, i);
          expect(p.ok, `prove ${n}/${i}`).to.equal(true);
          const v = verifyEvent(p.proof, head);
          expect(v, `verify ${n}/${i}`).to.deep.equal({ ok: true, seq: i, redacted: false });

          // Disclose the SAME event redacted (proof built from the redacted session) against the
          // SAME head — the redaction-safe leaf is what makes this hold.
          const pr = proveEvent(redacted, i);
          expect(pr.ok).to.equal(true);
          const vr = verifyEvent(pr.proof, head);
          expect(vr, `verify-redacted ${n}/${i}`).to.deep.equal({ ok: true, seq: i, redacted: true });

          // Redacting the disclosed event INSIDE a full proof also still verifies.
          const twinProof = { ...p.proof, event: redactedTwin(p.proof.event) };
          expect(verifyEvent(twinProof, head).ok, `twin-in-proof ${n}/${i}`).to.equal(true);
        }
      }
    });

    it("a fabricated or altered event is REJECTED (named verdicts)", function () {
      const s = session(6);
      const head = headOf(s);
      const p = proveEvent(s, 2).proof;

      // altered payload byte -> leaf mismatch -> EVENT_NOT_IN_HEAD
      const altered = { ...p, event: { ...p.event, payload: flipChar(p.event.payload, 1) } };
      expect(verifyEvent(altered, head)).to.deep.equal({ ok: false, reason: REASONS.EVENT_NOT_IN_HEAD });

      // altered ts / actor / type -> EVENT_NOT_IN_HEAD
      for (const patch of [{ ts: "1999-01-01T00:00:00Z" }, { actor: "agent:evil" }, { type: "note" }]) {
        const t = { ...p, event: { ...p.event, ...patch } };
        expect(verifyEvent(t, head), JSON.stringify(patch)).to.deep.equal({
          ok: false,
          reason: REASONS.EVENT_NOT_IN_HEAD,
        });
      }

      // altered seq -> the claimed position no longer matches the proof's tree position
      const seqLie = { ...p, event: { ...p.event, seq: 3 } };
      expect(verifyEvent(seqLie, head)).to.deep.equal({ ok: false, reason: REASONS.PROOF_SEQ_MISMATCH });

      // a redacted twin with a WRONG commitment -> EVENT_NOT_IN_HEAD (the commitment IS the payload)
      const twin = redactedTwin(p.event);
      const forgedTwin = { ...p, event: { ...twin, payloadHash: payloadHash("forged payload") } };
      expect(verifyEvent(forgedTwin, head)).to.deep.equal({
        ok: false,
        reason: REASONS.EVENT_NOT_IN_HEAD,
      });

      // an event that fails validation is rejected with ITS named reason, not verified
      const invalid = { ...p, event: { ...p.event, extra: 1 } };
      const vi = verifyEvent(invalid, head);
      expect(vi.ok).to.equal(false);
      expect(vi.reason).to.equal(REASONS.EVENT_UNKNOWN_FIELD);
    });

    it("a proof replayed against the WRONG head is REJECTED (different session, grown session, size lie)", function () {
      const n = 8;
      const s = session(n);
      const head = headOf(s);
      const p = proveEvent(s, 5).proof;

      // same-shape session with different content
      const other = headOf(session(n, "other-salt"));
      expect(verifyEvent(p, other)).to.deep.equal({ ok: false, reason: REASONS.EVENT_NOT_IN_HEAD });

      // the SAME session grown by one event: head binds size, replay rejected outright
      const grown = headOf(session(n + 1));
      expect(verifyEvent(p, grown)).to.deep.equal({ ok: false, reason: REASONS.EVENT_NOT_IN_HEAD });

      // a treeSize lie inside the proof is caught by the size-binding head
      const sizeLie = { ...p, inclusion: { ...p.inclusion, treeSize: n + 1 } };
      expect(verifyEvent(sizeLie, head)).to.deep.equal({ ok: false, reason: REASONS.EVENT_NOT_IN_HEAD });

      // bare-root form still verifies honestly, and still rejects the wrong root
      expect(verifyEvent(p, head.root).ok).to.equal(true);
      expect(verifyEvent(p, other.root).ok).to.equal(false);

      // malformed heads -> reject, never throw
      for (const badHead of [null, {}, { size: n }, { size: n, root: "0xnope" }, 42]) {
        const v = verifyEvent(p, badHead);
        expect(v.ok, JSON.stringify(badHead)).to.equal(false);
      }
    });

    it("a tampered inclusion path (flipped / truncated / extended element) is REJECTED", function () {
      const s = session(9);
      const head = headOf(s);
      const p = proveEvent(s, 4).proof;
      expect(p.inclusion.path.length).to.be.greaterThan(0);

      const flipped = {
        ...p,
        inclusion: { ...p.inclusion, path: [payloadHash("evil"), ...p.inclusion.path.slice(1)] },
      };
      expect(verifyEvent(flipped, head)).to.deep.equal({ ok: false, reason: REASONS.EVENT_NOT_IN_HEAD });

      const truncated = { ...p, inclusion: { ...p.inclusion, path: p.inclusion.path.slice(1) } };
      expect(verifyEvent(truncated, head)).to.deep.equal({ ok: false, reason: REASONS.EVENT_NOT_IN_HEAD });

      const extended = {
        ...p,
        inclusion: { ...p.inclusion, path: [...p.inclusion.path, payloadHash("pad")] },
      };
      expect(verifyEvent(extended, head)).to.deep.equal({ ok: false, reason: REASONS.EVENT_NOT_IN_HEAD });

      // malformed proof containers -> named reject, never a throw
      for (const bad of [null, [], "x", { event: s[4] }, { ...p, inclusion: null }, { ...p, inclusion: [] }]) {
        const v = verifyEvent(bad, head);
        expect(v.ok).to.equal(false);
      }
    });

    it("proveEvent: out-of-range / non-integer index and invalid sessions are NAMED rejects", function () {
      const s = session(3);
      for (const i of [-1, 3, 1.5, "1", null]) {
        const p = proveEvent(s, i);
        expect(p.ok, String(i)).to.equal(false);
        expect(p.reason).to.equal(REASONS.INDEX_OUT_OF_RANGE);
      }
      const bad = session(3);
      bad[0] = { ...bad[0], actor: "" };
      const p = proveEvent(bad, 0);
      expect(p.ok).to.equal(false);
      expect(p.reason).to.equal(REASONS.EVENT_BAD_ACTOR);
    });

    it("the disclosed event in a proof is a DEEP COPY — later caller mutation cannot corrupt it", function () {
      const s = session(3);
      const head = headOf(s);
      const p = proveEvent(s, 0).proof;
      s[0].payload = "mutated after proving";
      s[0].meta.step = 777;
      expect(verifyEvent(p, head).ok).to.equal(true);
    });
  });

  // =================================================================================================
  describe("(4) verifyGrowth: every (m <= n) prefix pair accepted; rewritten history REJECTED", function () {
    it("accepts every checkpoint pair (m in 1..n, n in 1..N), heads size-bound", function () {
      for (let n = 1; n <= N; n++) {
        const s = session(n);
        const later = headOf(s);
        for (let m = 1; m <= n; m++) {
          const earlier = headOf(s.slice(0, m));
          const g = proveGrowth(s, m, n);
          expect(g.ok, `prove ${m}<=${n}`).to.equal(true);
          expect(verifyGrowth(earlier, later, g.proof), `verify ${m}<=${n}`).to.deep.equal({ ok: true });
        }
        // secondSize defaults to the full session
        const gDefault = proveGrowth(s, Math.max(1, n >> 1));
        expect(gDefault.ok).to.equal(true);
        expect(verifyGrowth(headOf(s.slice(0, Math.max(1, n >> 1))), later, gDefault.proof).ok).to.equal(
          true
        );
      }
    });

    it("REJECTS a rewritten-history pair: an edited past event between checkpoint m and head n", function () {
      const n = 11;
      const original = session(n);
      for (let m = 1; m <= n; m++) {
        const earlierHonest = headOf(original.slice(0, m));
        // The operator rewrites event m-1 (BEFORE the checkpoint) after having issued the checkpoint.
        const rewritten = original.map((e, i) =>
          i === m - 1 ? { ...e, payload: flipChar(e.payload, 2) } : e
        );
        const laterRewritten = headOf(rewritten);
        const g = proveGrowth(rewritten, m, n);
        expect(g.ok).to.equal(true);
        // The rewritten log CANNOT prove append-only growth from the honest checkpoint.
        const v = verifyGrowth(earlierHonest, laterRewritten, g.proof);
        expect(v, `rewrite@${m - 1} vs checkpoint ${m}`).to.deep.equal({
          ok: false,
          reason: REASONS.GROWTH_NOT_APPEND_ONLY,
        });
      }
      // Control: rewriting an event AT OR AFTER the checkpoint does not involve the checkpoint's
      // prefix, so growth from the honest checkpoint still verifies (only the future changed).
      const m = 5;
      const laterEdit = original.map((e, i) => (i === m ? { ...e, payload: flipChar(e.payload, 2) } : e));
      const g2 = proveGrowth(laterEdit, m, n);
      expect(verifyGrowth(headOf(original.slice(0, m)), headOf(laterEdit), g2.proof)).to.deep.equal({
        ok: true,
      });
    });

    it("m === n is the trivial (equal-heads) case; size lies are caught by head binding", function () {
      const s = session(6);
      const head = headOf(s);
      const g = proveGrowth(s, 6, 6);
      expect(g.ok).to.equal(true);
      expect(g.proof.path).to.deep.equal([]);
      expect(verifyGrowth(head, head, g.proof)).to.deep.equal({ ok: true });

      // earlier head of the WRONG size (binding): m=4 proof presented with the size-3 head
      const g4 = proveGrowth(s, 4, 6).proof;
      const wrongSizeHead = headOf(s.slice(0, 3));
      expect(verifyGrowth(wrongSizeHead, head, g4)).to.deep.equal({
        ok: false,
        reason: REASONS.GROWTH_NOT_APPEND_ONLY,
      });
      // earlier head of the right size but from a DIFFERENT session
      const foreign = headOf(session(4, "foreign"));
      expect(verifyGrowth(foreign, head, g4)).to.deep.equal({
        ok: false,
        reason: REASONS.GROWTH_NOT_APPEND_ONLY,
      });
    });

    it("proveGrowth range checks and malformed growth proofs are NAMED rejects (never throw)", function () {
      const s = session(5);
      for (const [m, n] of [[0, 5], [-1, 5], [3, 2], [1, 6], [1.5, 5], ["1", 5]]) {
        const g = proveGrowth(s, m, n);
        expect(g.ok, `${m},${n}`).to.equal(false);
        expect(g.reason).to.equal(REASONS.GROWTH_RANGE);
      }
      const head5 = headOf(s);
      const head2 = headOf(s.slice(0, 2));
      const good = proveGrowth(s, 2, 5).proof;
      for (const bad of [
        null, [], "x", {},
        { ...good, path: "notarray" },
        { ...good, firstSize: "2" },
        { ...good, secondSize: null },
        { ...good, path: good.path.slice(1) },
      ]) {
        const v = verifyGrowth(head2, head5, bad);
        expect(v.ok, JSON.stringify(bad)).to.equal(false);
      }
    });
  });

  // =================================================================================================
  describe("(5) reuse VERBATIM: delegation equalities against cli/journal-log.js itself", function () {
    it("sessionHead(events) === journal-log treeHead over the event leaves (and EMPTY_ROOT when empty)", function () {
      for (const n of [0, 1, 2, 3, 5, 8, 13]) {
        const s = session(n);
        const h = sessionHead(s);
        expect(h.ok).to.equal(true);
        const direct = journalLog.treeHead(s.map((e) => eventLeaf(e)));
        expect(h.size, `size ${n}`).to.equal(direct.size);
        expect(h.root, `root ${n}`).to.equal(direct.root);
      }
      expect(sessionHead([]).root).to.equal(journalLog.EMPTY_ROOT);
    });

    it("proveEvent's inclusion is journal-log's inclusionProof (minus the re-derived leaf)", function () {
      const s = session(7);
      const leaves = s.map((e) => eventLeaf(e));
      for (let i = 0; i < 7; i++) {
        const ours = proveEvent(s, i).proof.inclusion;
        const theirs = journalLog.inclusionProof(leaves, i);
        expect(ours).to.deep.equal({
          leafIndex: theirs.leafIndex,
          treeSize: theirs.treeSize,
          path: theirs.path,
        });
        // the leaf journal-log would carry is exactly what verifyEvent re-derives
        expect(theirs.leaf).to.equal(eventLeaf(s[i]));
      }
    });

    it("proveGrowth's proof is journal-log's consistencyProof, verbatim", function () {
      const s = session(9);
      const leaves = s.map((e) => eventLeaf(e));
      for (let m = 1; m <= 9; m++) {
        expect(proveGrowth(s, m, 9).proof).to.deep.equal(journalLog.consistencyProof(leaves, m, 9));
      }
    });

    it("the leaf preimage is the documented domain-separated canonical encoding (recomputable)", function () {
      const e = { seq: 0, ts: "t", actor: "a", type: "note", payload: "hello" };
      const expected = hashBytes(
        toUtf8Bytes(
          JSON.stringify([LEAF_DOMAIN, 0, "t", "a", "note", payloadHash("hello"), null])
        )
      );
      expect(eventLeaf(e)).to.equal(expected);
      // and payloadHash is cli/hash.js hashBytes over the UTF-8 payload bytes, verbatim
      expect(payloadHash("hello")).to.equal(hashBytes(toUtf8Bytes("hello")));
    });
  });
});
