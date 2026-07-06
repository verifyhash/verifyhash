"use strict";

// `vh agent` (T-68.2) — the CLI surface over the PURE agent-session core (T-68.1), with the paid
// `--sign` surface gated by the EXISTING license mechanism keyed to the DRAFT `agent_signed`
// capability.
//
// What these prove (the T-68.2 acceptance criteria, each as an honest test):
//   (1) END-TO-END fixture flow: seal → verify ACCEPT; ONE payload byte tampered → REJECT NAMING the
//       event seq; redact → verify ACCEPT + the withheld seqs listed (head/root UNCHANGED);
//       prove/verify-proof ACCEPT for a disclosed event and REJECT a forged one; checkpoint → append
//       more events → verify-growth ACCEPT, and a REWRITTEN PAST → REJECT.
//   (2) FAIL-CLOSED license gate with the SAME named-refusal shape the evidence gate emits:
//       --sign with no license → usage-refused; a VALID license that does not CARRY `agent_signed`
//       (e.g. an evidence license) → refused NAMING the capability; a wrong-issuer license → refused
//       naming wrong_issuer; an expired one → refused naming expired. With a valid ephemeral
//       Wallet.createRandom() license (TEST-ONLY, never a real key) the seal signs, and the signed
//       packet verifies under the correct --vendor pin / REJECTS a wrong pin / REJECTS a pinned but
//       UNSIGNED packet (a stripped signature never passes). Redacting a SIGNED packet keeps the
//       head signature valid (the signature wraps the redaction-safe HEAD).
//   (3) STRICT ADDITIVITY: the evidence product's closed entitlement set, license cfg, and bundled
//       DRAFT plan catalog are byte-unchanged; the agent cfg is a strict SUPERSET under the SAME
//       license kind; the DRAFT capability sets NO price.
//   (4) HOSTILE packets (non-JSON, foreign kind, `..`-shaped smuggled fields, oversized, seq-gapped)
//       are NAMED-rejected with a non-zero exit — never thrown.
//   (5) CLI hygiene: exit-code/--json contract mirrors the family; every write lands under a
//       throwaway temp dir at an explicit --out (never cwd); the working tree is left CLEAN.
//
// Every signing key is an EPHEMERAL in-process Wallet.createRandom() (TEST-ONLY). The license
// window check is dated with an injected `now` so verdicts are deterministic.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

const agent = require("../cli/agent");
const coreLicense = require("../cli/core/license");
const evidence = require("../cli/evidence");
const evidencePlans = require("../cli/core/evidence-plans");

const NOW = new Date("2026-07-02T12:00:00.000Z");
const ISSUED = "2026-06-01T00:00:00.000Z";
const EXPIRES = "2027-06-01T00:00:00.000Z";

function capture(extra = {}) {
  const out = [];
  const err = [];
  return Object.assign(
    {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      now: NOW,
      out: () => out.join(""),
      err: () => err.join(""),
    },
    extra
  );
}

// A deterministic 6-event fixture session covering every event type, meta, and unicode payloads.
function fixtureEvents(n = 6, salt = "") {
  const types = ["prompt", "completion", "tool_call", "tool_result", "note"];
  const events = [];
  for (let i = 0; i < n; i++) {
    const e = {
      seq: i,
      ts: `2026-07-02T09:00:${String(i).padStart(2, "0")}.000Z`,
      actor: i % 2 === 0 ? "agent:assistant" : "tool:bash",
      type: types[i % types.length],
      payload: JSON.stringify({ i, salt, text: `payload #${i} — ünïcode ✓` }),
    };
    if (i % 3 === 0) e.meta = { step: i, model: "fable-5" };
    events.push(e);
  }
  return events;
}

function writeSession(dir, events, name = "session.jsonl") {
  const p = path.join(dir, name);
  fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
}

// Mint an ephemeral-key license carrying `entitlements` under the AGENT license framing (the SAME
// `vh-evidence-license` kind, table extended by `agent_signed`). Returns { file, vendor, wallet }.
async function mintLicense(dir, entitlements, wallet, window = {}) {
  const w = wallet || Wallet.createRandom();
  const container = await coreLicense.buildLicense(
    {
      licenseId: "AG-TEST-1",
      customer: "ACME Agents Co",
      plan: "agent-draft",
      entitlements,
      issuedAt: window.issuedAt || ISSUED,
      expiresAt: window.expiresAt || EXPIRES,
    },
    w,
    agent.AGENT_LICENSE_CFG
  );
  const file = path.join(dir, `license-${entitlements.join("_")}.json`);
  fs.writeFileSync(file, JSON.stringify(container) + "\n");
  return { file, vendor: w.address, wallet: w };
}

describe("cli/agent T-68.2: `vh agent` — seal/verify/redact/prove/verify-proof/checkpoint/verify-growth", function () {
  this.timeout(20000);

  let tmpDirs;
  let cwdBefore;
  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing the commands did leaked into the working tree.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function tmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-agent-test-"));
    tmpDirs.push(d);
    return d;
  }

  // =========================================================================
  // (1) END-TO-END fixture flow.
  // =========================================================================

  describe("end-to-end fixture flow (unsigned, FREE surface)", function () {
    it("seal → verify ACCEPTs; the output leads with the trust note; head/counts are stable", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());
      const packetPath = path.join(dir, "session.vhagent.json");

      const io1 = capture();
      const c1 = await agent.cmdAgent(["seal", sess, "--out", packetPath, "--json"], io1);
      expect(c1, io1.err()).to.equal(0);
      const sealed = JSON.parse(io1.out());
      expect(sealed.ok).to.equal(true);
      expect(sealed.kind).to.equal(agent.PACKET_KIND);
      expect(sealed.note).to.equal(agent.AGENT_TRUST_NOTE);
      expect(sealed.head.size).to.equal(6);
      expect(sealed.head.root).to.match(/^0x[0-9a-f]{64}$/);
      expect(sealed.counts).to.deep.equal({ events: 6, full: 6, redacted: 0 });
      expect(sealed.signed).to.equal(false);
      expect(sealed.out).to.equal(packetPath);

      // The written packet is strictly-valid, kind-disjoint, and carries the in-band trust note.
      const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
      expect(packet.kind).to.equal("vh.agent-session-packet");
      expect(packet.note).to.equal(agent.AGENT_TRUST_NOTE);
      expect(packet.leaves).to.have.length(6);

      const io2 = capture();
      const c2 = await agent.cmdAgent(["verify", packetPath, "--json"], io2);
      expect(c2, io2.err()).to.equal(0);
      const v = JSON.parse(io2.out());
      expect(v.verdict).to.equal("ACCEPTED");
      expect(v.accepted).to.equal(true);
      expect(v.head).to.deep.equal(sealed.head);
      expect(v.withheld).to.deep.equal([]);
      expect(v.signed).to.equal(false);
      expect(v.note).to.equal(agent.AGENT_TRUST_NOTE);

      // Human output leads with the trust note.
      const io3 = capture();
      const c3 = await agent.cmdAgent(["verify", packetPath], io3);
      expect(c3).to.equal(0);
      expect(io3.out().startsWith(agent.AGENT_TRUST_NOTE)).to.equal(true);
      expect(io3.out()).to.include("ACCEPTED");
    });

    it("ONE payload byte tampered → REJECT NAMING the event seq (exit 3)", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());
      const packetPath = path.join(dir, "p.vhagent.json");
      await agent.cmdAgent(["seal", sess, "--out", packetPath], capture());

      const obj = JSON.parse(fs.readFileSync(packetPath, "utf8"));
      // Flip exactly one byte of event 2's payload.
      obj.events[2].payload = obj.events[2].payload.replace("payload", "paYload");
      const tampered = path.join(dir, "tampered.vhagent.json");
      fs.writeFileSync(tampered, JSON.stringify(obj) + "\n");

      const io = capture();
      const code = await agent.cmdAgent(["verify", tampered, "--json"], io);
      expect(code).to.equal(3);
      const v = JSON.parse(io.out());
      expect(v.verdict).to.equal("REJECTED");
      expect(v.reason).to.equal("EVENT_PAYLOAD_HASH_MISMATCH");
      expect(v.seq).to.equal(2);

      // The human path names the seq too.
      const ioH = capture();
      expect(await agent.cmdAgent(["verify", tampered], ioH)).to.equal(3);
      expect(ioH.out()).to.include("REJECTED");
      expect(ioH.out()).to.include("event seq 2");
    });

    it("a bound-field tamper (ts) and a stored-leaf tamper are both LOCALIZED to their seq; an edited head is HEAD_MISMATCH", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());
      const packetPath = path.join(dir, "p.vhagent.json");
      await agent.cmdAgent(["seal", sess, "--out", packetPath], capture());
      const base = () => JSON.parse(fs.readFileSync(packetPath, "utf8"));

      // (a) ts edit — the leaf recompute no longer matches the stored expectation at seq 4.
      const a = base();
      a.events[4].ts = "1999-01-01T00:00:00.000Z";
      const pa = path.join(dir, "a.json");
      fs.writeFileSync(pa, JSON.stringify(a) + "\n");
      const ioA = capture();
      expect(await agent.cmdAgent(["verify", pa, "--json"], ioA)).to.equal(3);
      const va = JSON.parse(ioA.out());
      expect(va.reason).to.equal("EVENT_LEAF_MISMATCH");
      expect(va.seq).to.equal(4);

      // (b) stored leaf edit at seq 1 (event untouched) — same localized reject.
      const b = base();
      b.leaves[1] = "0x" + "ab".repeat(32);
      const pb = path.join(dir, "b.json");
      fs.writeFileSync(pb, JSON.stringify(b) + "\n");
      const ioB = capture();
      expect(await agent.cmdAgent(["verify", pb, "--json"], ioB)).to.equal(3);
      const vb = JSON.parse(ioB.out());
      expect(vb.reason).to.equal("EVENT_LEAF_MISMATCH");
      expect(vb.seq).to.equal(1);

      // (c) declared head root edited — the recomputed root exposes it.
      const c = base();
      c.head.root = "0x" + "cd".repeat(32);
      const pc = path.join(dir, "c.json");
      fs.writeFileSync(pc, JSON.stringify(c) + "\n");
      const ioC = capture();
      expect(await agent.cmdAgent(["verify", pc, "--json"], ioC)).to.equal(3);
      expect(JSON.parse(ioC.out()).reason).to.equal("HEAD_MISMATCH");
    });

    it("redact → verify ACCEPTs, lists EXACTLY the withheld seqs, and the head/root is UNCHANGED", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());
      const packetPath = path.join(dir, "p.vhagent.json");
      await agent.cmdAgent(["seal", sess, "--out", packetPath], capture());
      const original = JSON.parse(fs.readFileSync(packetPath, "utf8"));

      const redactedPath = path.join(dir, "redacted.vhagent.json");
      const io1 = capture();
      const c1 = await agent.cmdAgent(
        ["redact", packetPath, "--seq", "1,3", "--out", redactedPath, "--json"],
        io1
      );
      expect(c1, io1.err()).to.equal(0);
      const r = JSON.parse(io1.out());
      expect(r.withheld).to.deep.equal([1, 3]);
      expect(r.head).to.deep.equal(original.head); // redaction-safety: leaves + root unchanged
      expect(r.counts).to.deep.equal({ events: 6, full: 4, redacted: 2 });

      const redacted = JSON.parse(fs.readFileSync(redactedPath, "utf8"));
      expect(redacted.leaves).to.deep.equal(original.leaves);
      expect(redacted.events[1].payload).to.equal(undefined); // the payload is GONE, not masked
      expect(redacted.events[1].redacted).to.equal(true);
      expect(redacted.events[1].payloadHash).to.equal(original.events[1].payloadHash);

      const io2 = capture();
      const c2 = await agent.cmdAgent(["verify", redactedPath, "--json"], io2);
      expect(c2, io2.err()).to.equal(0);
      const v = JSON.parse(io2.out());
      expect(v.verdict).to.equal("ACCEPTED");
      expect(v.withheld).to.deep.equal([1, 3]);
      expect(v.head).to.deep.equal(original.head);

      // The human path lists the withheld seqs.
      const io3 = capture();
      await agent.cmdAgent(["verify", redactedPath], io3);
      expect(io3.out()).to.include("seqs 1, 3");
    });

    it("redact refuses a tampered packet and an out-of-range --seq; never launders", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());
      const packetPath = path.join(dir, "p.vhagent.json");
      await agent.cmdAgent(["seal", sess, "--out", packetPath], capture());

      const obj = JSON.parse(fs.readFileSync(packetPath, "utf8"));
      obj.events[0].payload += "!";
      const tampered = path.join(dir, "t.json");
      fs.writeFileSync(tampered, JSON.stringify(obj) + "\n");
      const io1 = capture();
      expect(await agent.cmdAgent(["redact", tampered, "--seq", "0", "--out", path.join(dir, "x.json")], io1)).to.equal(3);
      expect(io1.err()).to.include("refusing to redact");
      expect(io1.err()).to.include("EVENT_PAYLOAD_HASH_MISMATCH");

      const io2 = capture();
      expect(await agent.cmdAgent(["redact", packetPath, "--seq", "99", "--out", path.join(dir, "y.json")], io2)).to.equal(3);
      expect(io2.err()).to.include("--seq 99 is out of range");
    });

    it("prove → verify-proof ACCEPTs (with and without --root pin); a forged event or wrong --root REJECTs", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());
      const packetPath = path.join(dir, "p.vhagent.json");
      await agent.cmdAgent(["seal", sess, "--out", packetPath], capture());
      const head = JSON.parse(fs.readFileSync(packetPath, "utf8")).head;

      const proofPath = path.join(dir, "e4.proof.json");
      const io1 = capture();
      const c1 = await agent.cmdAgent(["prove", packetPath, "--seq", "4", "--out", proofPath, "--json"], io1);
      expect(c1, io1.err()).to.equal(0);
      expect(JSON.parse(io1.out()).seq).to.equal(4);

      // ACCEPT: unpinned and pinned to the true root.
      const io2 = capture();
      expect(await agent.cmdAgent(["verify-proof", proofPath, "--json"], io2)).to.equal(0);
      const v2 = JSON.parse(io2.out());
      expect(v2.verdict).to.equal("ACCEPTED");
      expect(v2.seq).to.equal(4);
      const io3 = capture();
      expect(await agent.cmdAgent(["verify-proof", proofPath, "--root", head.root, "--json"], io3)).to.equal(0);

      // REJECT: a FORGED disclosed event (payload edited) — the commitment cross-check names it.
      const forged1 = JSON.parse(fs.readFileSync(proofPath, "utf8"));
      forged1.proof.event.payload = forged1.proof.event.payload.replace("#4", "#9");
      const f1 = path.join(dir, "forged1.json");
      fs.writeFileSync(f1, JSON.stringify(forged1) + "\n");
      const io4 = capture();
      expect(await agent.cmdAgent(["verify-proof", f1, "--json"], io4)).to.equal(3);
      expect(JSON.parse(io4.out()).reason).to.equal("EVENT_PAYLOAD_HASH_MISMATCH");

      // REJECT: a CONSISTENTLY forged event (bound field edited, commitment recomputes) is simply
      // NOT IN THE HEAD — the Merkle path exposes it.
      const forged2 = JSON.parse(fs.readFileSync(proofPath, "utf8"));
      forged2.proof.event.ts = "1999-01-01T00:00:00.000Z";
      const f2 = path.join(dir, "forged2.json");
      fs.writeFileSync(f2, JSON.stringify(forged2) + "\n");
      const io5 = capture();
      expect(await agent.cmdAgent(["verify-proof", f2, "--json"], io5)).to.equal(3);
      expect(JSON.parse(io5.out()).reason).to.equal("EVENT_NOT_IN_HEAD");

      // REJECT: a wrong --root pin (the proof's self-asserted head is not the one you trust).
      const io6 = capture();
      expect(
        await agent.cmdAgent(["verify-proof", proofPath, "--root", "0x" + "ef".repeat(32), "--json"], io6)
      ).to.equal(3);
      expect(JSON.parse(io6.out()).reason).to.equal("ROOT_MISMATCH");
    });

    it("a REDACTED event can be disclosed by proof (payload withheld, inclusion still proven)", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());
      const packetPath = path.join(dir, "p.vhagent.json");
      await agent.cmdAgent(["seal", sess, "--out", packetPath], capture());
      const redactedPath = path.join(dir, "r.vhagent.json");
      await agent.cmdAgent(["redact", packetPath, "--seq", "3", "--out", redactedPath], capture());

      const proofPath = path.join(dir, "e3.proof.json");
      const io1 = capture();
      expect(await agent.cmdAgent(["prove", redactedPath, "--seq", "3", "--out", proofPath, "--json"], io1)).to.equal(0);
      expect(JSON.parse(io1.out()).redacted).to.equal(true);

      const io2 = capture();
      expect(await agent.cmdAgent(["verify-proof", proofPath, "--json"], io2)).to.equal(0);
      const v = JSON.parse(io2.out());
      expect(v.verdict).to.equal("ACCEPTED");
      expect(v.redacted).to.equal(true);
      expect(v.event.payload).to.equal(undefined);
    });

    it("checkpoint → append more events → verify-growth ACCEPTs; a REWRITTEN PAST REJECTs", async function () {
      const dir = tmp();
      const five = fixtureEvents(5);
      const sess5 = writeSession(dir, five, "s5.jsonl");
      const cpPath = path.join(dir, "cp5.json");
      const io1 = capture();
      const c1 = await agent.cmdAgent(["checkpoint", sess5, "--out", cpPath, "--json"], io1);
      expect(c1, io1.err()).to.equal(0);
      const cp = JSON.parse(io1.out());
      expect(cp.kind).to.equal(agent.CHECKPOINT_KIND);
      expect(cp.head.size).to.equal(5);

      // Append 3 more events, seal the grown session.
      const eight = fixtureEvents(8);
      const sess8 = writeSession(dir, eight, "s8.jsonl");
      const p8 = path.join(dir, "p8.vhagent.json");
      await agent.cmdAgent(["seal", sess8, "--out", p8], capture());

      const io2 = capture();
      expect(await agent.cmdAgent(["verify-growth", cpPath, p8, "--json"], io2)).to.equal(0);
      expect(JSON.parse(io2.out()).verdict).to.equal("ACCEPTED");

      // Growth also holds against a REDACTED later packet (leaves are redaction-safe).
      const r8 = path.join(dir, "r8.vhagent.json");
      await agent.cmdAgent(["redact", p8, "--seq", "0,6", "--out", r8], capture());
      const io3 = capture();
      expect(await agent.cmdAgent(["verify-growth", cpPath, r8, "--json"], io3)).to.equal(0);

      // REWRITTEN PAST: event 2 (before the checkpoint) altered in the later session.
      const rewritten = fixtureEvents(8).map((e) => ({ ...e }));
      rewritten[2].payload = JSON.stringify({ REWRITTEN: true });
      const sessBad = writeSession(dir, rewritten, "bad.jsonl");
      const pBad = path.join(dir, "pbad.vhagent.json");
      await agent.cmdAgent(["seal", sessBad, "--out", pBad], capture());
      const io4 = capture();
      expect(await agent.cmdAgent(["verify-growth", cpPath, pBad, "--json"], io4)).to.equal(3);
      expect(JSON.parse(io4.out()).reason).to.equal("GROWTH_NOT_APPEND_ONLY");

      // History SHRANK: the earlier head is larger than the later packet.
      const p5 = path.join(dir, "p5.vhagent.json");
      await agent.cmdAgent(["seal", sess5, "--out", p5], capture());
      const cp8 = path.join(dir, "cp8.json");
      await agent.cmdAgent(["checkpoint", sess8, "--out", cp8], capture());
      const io5 = capture();
      expect(await agent.cmdAgent(["verify-growth", cp8, p5, "--json"], io5)).to.equal(3);
      expect(JSON.parse(io5.out()).reason).to.equal("GROWTH_RANGE");

      // Same-size growth (m == n) is the identity extension; a PACKET also works as <earlier>.
      const io6 = capture();
      expect(await agent.cmdAgent(["verify-growth", p8, p8, "--json"], io6)).to.equal(0);

      // The EMPTY (pre-first-event) checkpoint is trivially extended by anything.
      const sess0 = path.join(dir, "s0.jsonl");
      fs.writeFileSync(sess0, "");
      const cp0 = path.join(dir, "cp0.json");
      await agent.cmdAgent(["checkpoint", sess0, "--out", cp0], capture());
      const io7 = capture();
      expect(await agent.cmdAgent(["verify-growth", cp0, p8, "--json"], io7)).to.equal(0);
    });
  });

  // =========================================================================
  // (2) The FAIL-CLOSED license gate + the signed head attestation.
  // =========================================================================

  describe("--sign: the paid `agent_signed` surface (fail-closed, evidence-gate refusal shape)", function () {
    const KEY_ENV = "VH_TEST_AGENT_SIGNING_KEY";
    afterEach(function () {
      delete process.env[KEY_ENV];
    });

    it("--sign with NO license is REFUSED (usage) with the evidence gate's named-refusal shape", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());
      const io = capture();
      const code = await agent.cmdAgent(["seal", sess, "--sign"], io);
      expect(code).to.equal(2);
      // The SAME shape the evidence gate emits: "<feature> is a PAID surface and requires a
      // license; pass --license <file>." plus the canonical-pin pointer + the free-tier pointer.
      expect(io.err()).to.match(
        /error: .* is a PAID surface and requires a license; pass --license <file>\./
      );
      expect(io.err()).to.include("CANONICAL vendor identity");
      expect(io.err()).to.include("the signed head attestation (--sign)");
      expect(io.err()).to.include("The FREE tier");
    });

    it("T-75.3: --vendor can NOT re-pin the gate; --license alone is verified against the CANONICAL identity", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());

      // (a) The SELF-MINT attack: a self-minted license + a --vendor naming the attacker's own key is a
      //     NAMED usage refusal — the caller-supplied pin never re-pins the gate.
      const attacker = Wallet.createRandom();
      const selfMinted = await mintLicense(dir, ["agent_signed"], attacker);
      const io1 = capture();
      const c1 = await agent.cmdAgent(
        ["seal", sess, "--sign", "--license", selfMinted.file, "--vendor", attacker.address],
        io1
      );
      expect(c1).to.equal(2);
      expect(io1.err()).to.include("does not match the canonical vendor identity");
      expect(io1.err()).to.include("cannot re-pin an entitlement gate");

      // (b) --license ALONE is complete usage: it verifies against the canonical identity (here, the
      //     committed published identity, so the self-minted license is the named wrong_issuer reject).
      const io2 = capture();
      const c2 = await agent.cmdAgent(["seal", sess, "--sign", "--license", selfMinted.file], io2);
      expect(c2).to.equal(3);
      expect(io2.err()).to.match(/requires a VALID license, but the supplied license is wrong_issuer/);
    });

    it("a VALID license that does NOT carry `agent_signed` (an evidence-only license) is REFUSED naming the capability — never silently downgraded", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());
      const { file, vendor } = await mintLicense(dir, ["evidence_signed", "evidence_unlimited"]);
      // The ephemeral vendor is THIS run's canonical identity (programmatic seam; --vendor asserts it).
      const io = capture({ canonicalVendor: vendor });
      const code = await agent.cmdAgent(["seal", sess, "--sign", "--license", file, "--vendor", vendor], io);
      expect(code).to.equal(3);
      expect(io.err()).to.include('does NOT include the "agent_signed" entitlement');
      expect(io.err()).to.include('"evidence_signed"'); // names what it DOES grant
      expect(io.out()).to.equal(""); // nothing sealed, nothing printed — fail-closed
    });

    it("a wrong-issuer license and an expired license are REFUSED naming the verifyLicense reason", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());

      const vendor = Wallet.createRandom();
      const other = await mintLicense(dir, ["agent_signed"], Wallet.createRandom());
      const io1 = capture({ canonicalVendor: vendor.address });
      const c1 = await agent.cmdAgent(
        ["seal", sess, "--sign", "--license", other.file, "--vendor", vendor.address],
        io1
      );
      expect(c1).to.equal(3);
      expect(io1.err()).to.match(/requires a VALID license, but the supplied license is wrong_issuer/);

      const expired = await mintLicense(dir, ["agent_signed"], vendor, {
        issuedAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2025-02-01T00:00:00.000Z",
      });
      const io2 = capture({ canonicalVendor: vendor.address });
      const c2 = await agent.cmdAgent(
        ["seal", sess, "--sign", "--license", expired.file, "--vendor", vendor.address],
        io2
      );
      expect(c2).to.equal(3);
      expect(io2.err()).to.match(/requires a VALID license, but the supplied license is expired/);
    });

    it("with a VALID `agent_signed` license the seal SIGNS; verify pins the correct --vendor and REJECTS a wrong pin or a stripped signature", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());
      const vendorW = Wallet.createRandom();
      const { file } = await mintLicense(dir, ["agent_signed"], vendorW);
      process.env[KEY_ENV] = vendorW.privateKey;

      const packetPath = path.join(dir, "signed.vhagent.json");
      const io1 = capture({ canonicalVendor: vendorW.address });
      const c1 = await agent.cmdAgent(
        ["seal", sess, "--sign", "--license", file, "--vendor", vendorW.address, "--key-env", KEY_ENV, "--out", packetPath, "--json"],
        io1
      );
      expect(c1, io1.err()).to.equal(0);
      const sealed = JSON.parse(io1.out());
      expect(sealed.signed).to.equal(true);
      expect(sealed.signer).to.equal(vendorW.address.toLowerCase());

      // The packet carries the head attestation (kind-disjoint signed-head container).
      const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
      expect(packet.headAttestation.kind).to.equal(agent.SIGNED_HEAD_KIND);
      expect(JSON.parse(packet.headAttestation.attestation).head).to.deep.equal(packet.head);

      // ACCEPT under the correct --vendor pin (checksummed input accepted, compared canonically).
      const io2 = capture();
      const c2 = await agent.cmdAgent(["verify", packetPath, "--vendor", vendorW.address, "--json"], io2);
      expect(c2, io2.err()).to.equal(0);
      const v2 = JSON.parse(io2.out());
      expect(v2.verdict).to.equal("ACCEPTED");
      expect(v2.signature.signerMatchesVendor).to.equal(true);
      expect(v2.signature.recoveredSigner).to.equal(vendorW.address.toLowerCase());

      // REJECT under a WRONG pin.
      const io3 = capture();
      const c3 = await agent.cmdAgent(
        ["verify", packetPath, "--vendor", Wallet.createRandom().address, "--json"],
        io3
      );
      expect(c3).to.equal(3);
      expect(JSON.parse(io3.out()).reason).to.equal("WRONG_VENDOR");

      // REJECT a pinned verify of an UNSIGNED packet (a stripped signature never passes).
      const unsignedPath = path.join(dir, "unsigned.vhagent.json");
      await agent.cmdAgent(["seal", sess, "--out", unsignedPath], capture());
      const io4 = capture();
      const c4 = await agent.cmdAgent(["verify", unsignedPath, "--vendor", vendorW.address, "--json"], io4);
      expect(c4).to.equal(3);
      expect(JSON.parse(io4.out()).reason).to.equal("NOT_SIGNED");

      // REJECT a signature pasted from a DIFFERENT session (the head is not bound to these events).
      const otherSess = writeSession(dir, fixtureEvents(6, "other"), "other.jsonl");
      const otherPath = path.join(dir, "other.vhagent.json");
      await agent.cmdAgent(["seal", otherSess, "--out", otherPath], capture());
      const stolen = JSON.parse(fs.readFileSync(otherPath, "utf8"));
      stolen.headAttestation = packet.headAttestation;
      const stolenPath = path.join(dir, "stolen.vhagent.json");
      fs.writeFileSync(stolenPath, JSON.stringify(stolen) + "\n");
      const io5 = capture();
      const c5 = await agent.cmdAgent(["verify", stolenPath, "--json"], io5);
      expect(c5).to.equal(3);
      expect(JSON.parse(io5.out()).reason).to.equal("HEAD_NOT_BOUND");
    });

    it("redacting a SIGNED packet keeps the head signature VALID under the vendor pin (the signature wraps the redaction-safe HEAD)", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());
      const vendorW = Wallet.createRandom();
      const { file } = await mintLicense(dir, ["agent_signed"], vendorW);
      process.env[KEY_ENV] = vendorW.privateKey;

      const packetPath = path.join(dir, "signed.vhagent.json");
      await agent.cmdAgent(
        ["seal", sess, "--sign", "--license", file, "--vendor", vendorW.address, "--key-env", KEY_ENV, "--out", packetPath],
        capture({ canonicalVendor: vendorW.address })
      );
      const redactedPath = path.join(dir, "signed-redacted.vhagent.json");
      const io1 = capture();
      expect(await agent.cmdAgent(["redact", packetPath, "--seq", "2,5", "--out", redactedPath], io1), io1.err()).to.equal(0);

      const io2 = capture();
      const c2 = await agent.cmdAgent(["verify", redactedPath, "--vendor", vendorW.address, "--json"], io2);
      expect(c2, io2.err()).to.equal(0);
      const v = JSON.parse(io2.out());
      expect(v.verdict).to.equal("ACCEPTED");
      expect(v.withheld).to.deep.equal([2, 5]);
      expect(v.signature.signerMatchesVendor).to.equal(true);
    });
  });

  // =========================================================================
  // (3) STRICT ADDITIVITY of the catalog/capability change.
  // =========================================================================

  describe("additivity: the DRAFT `agent_signed` capability changes NOTHING existing", function () {
    it("the EVIDENCE closed set, license cfg, and bundled DRAFT catalog are untouched", function () {
      // The evidence catalog's closed set stays EXACTLY the evidence pair (also pinned by
      // cli.evidence.plans.test.js — this is the cross-product guard).
      expect([...evidencePlans.ALLOWED_ENTITLEMENT_FLAGS]).to.deep.equal([
        "evidence_signed",
        "evidence_unlimited",
      ]);
      // The evidence LICENSE cfg does NOT know `agent_signed` (its gate/fulfiller are unchanged).
      expect(Object.keys(evidence.LICENSE_CFG.entitlements).sort()).to.deep.equal([
        "evidence_signed",
        "evidence_unlimited",
      ]);
      // The bundled DRAFT plan catalog is still schema-valid and mentions NO agent capability.
      const catalogText = fs.readFileSync(evidence.BUNDLED_EVIDENCE_CATALOG, "utf8");
      expect(catalogText).to.not.include("agent_signed");
      const catalog = evidencePlans.validateEvidencePlanCatalog(JSON.parse(catalogText));
      expect(catalog.plans.length).to.be.greaterThan(0);
    });

    it("the AGENT cfg is a strict SUPERSET under the SAME license kind (mechanism reused verbatim), and the capability is priceless-DRAFT", function () {
      expect(agent.AGENT_LICENSE_CFG.kind).to.equal(evidence.LICENSE_CFG.kind);
      expect(agent.AGENT_LICENSE_CFG.signedKind).to.equal(evidence.LICENSE_CFG.signedKind);
      expect(agent.AGENT_LICENSE_CFG.note).to.equal(evidence.LICENSE_CFG.note);
      expect(coreLicense.entitlementFlags(agent.AGENT_LICENSE_CFG)).to.deep.equal([
        "agent_signed",
        "evidence_signed",
        "evidence_unlimited",
      ]);
      // The capability table is the DRAFT declaration in the plans module — flag + honest meaning,
      // NO price anywhere (pricing stays the human P-7 step).
      expect(Object.keys(evidencePlans.AGENT_CAPABILITIES)).to.deep.equal(["agent_signed"]);
      expect(evidencePlans.AGENT_CAPABILITIES.agent_signed).to.include("DRAFT");
      expect(evidencePlans.AGENT_CAPABILITIES.agent_signed).to.include("no price set");
      expect(JSON.stringify(evidencePlans.AGENT_CAPABILITIES)).to.not.match(/\$|price:\s*\d|usd|eur/i);
      expect(Object.isFrozen(evidencePlans.AGENT_CAPABILITIES)).to.equal(true);
    });

    it("an AGENT license (carrying agent_signed) still verifies as the SAME signed-license container kind an operator already mints", async function () {
      const dir = tmp();
      const w = Wallet.createRandom();
      const { file } = await mintLicense(dir, ["agent_signed", "evidence_signed"], w);
      const container = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(container.kind).to.equal(evidence.LICENSE_CFG.signedKind); // same wire kind — no new artifact type
      const verdict = coreLicense.verifyLicense(container, {
        now: NOW,
        vendorAddress: w.address,
        cfg: agent.AGENT_LICENSE_CFG,
      });
      expect(verdict.valid).to.equal(true);
      expect(coreLicense.hasEntitlement(verdict, "agent_signed")).to.equal(true);
    });
  });

  // =========================================================================
  // (4) HOSTILE packets — NAMED rejects, never a throw.
  // =========================================================================

  describe("hostile inputs are NAMED-rejected (never thrown)", function () {
    it("non-JSON, foreign-kind, unknown/`..`-shaped-field, and OVERSIZED packets", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());
      const packetPath = path.join(dir, "p.vhagent.json");
      await agent.cmdAgent(["seal", sess, "--out", packetPath], capture());

      // (a) non-JSON.
      const nj = path.join(dir, "notjson.vhagent.json");
      fs.writeFileSync(nj, "{ this is not json");
      const io1 = capture();
      expect(await agent.cmdAgent(["verify", nj], io1)).to.equal(1);
      expect(io1.err()).to.include("is not valid JSON");

      // (b) a FOREIGN kind (an evidence seal is NOT an agent packet — kind-disjoint).
      const fk = path.join(dir, "foreign.json");
      fs.writeFileSync(fk, JSON.stringify({ kind: "vh.evidence-seal", schemaVersion: 1 }) + "\n");
      const io2 = capture();
      expect(await agent.cmdAgent(["verify", fk], io2)).to.equal(1);
      expect(io2.err()).to.include("not an agent-session packet");
      expect(io2.err()).to.include("vh.evidence-seal");

      // (c) a smuggled `..`/absolute-path-shaped top-level field is rejected BY NAME (nothing in a
      // packet is ever interpreted as a filesystem path).
      for (const hostileKey of ["../../etc/passwd", "/etc/passwd"]) {
        const obj = JSON.parse(fs.readFileSync(packetPath, "utf8"));
        obj[hostileKey] = "boom";
        const hf = path.join(dir, "hostile.json");
        fs.writeFileSync(hf, JSON.stringify(obj) + "\n");
        const io3 = capture();
        expect(await agent.cmdAgent(["verify", hf], io3)).to.equal(1);
        expect(io3.err()).to.include("unknown field");
        expect(io3.err()).to.include(hostileKey);
      }

      // (d) OVERSIZED: refused by the byte cap BEFORE being read into memory (a sparse file keeps
      // the test cheap; only stat().size matters).
      const big = path.join(dir, "big.vhagent.json");
      fs.writeFileSync(big, "");
      fs.truncateSync(big, agent.MAX_INPUT_BYTES + 1);
      const io4 = capture();
      expect(await agent.cmdAgent(["verify", big], io4)).to.equal(1);
      expect(io4.err()).to.include("OVERSIZED");
      expect(io4.err()).to.include(String(agent.MAX_INPUT_BYTES));
    });

    it("a seq-gapped session and a drifted trust note are rejected by name; a missing file is a clean IO error", async function () {
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());
      const packetPath = path.join(dir, "p.vhagent.json");
      await agent.cmdAgent(["seal", sess, "--out", packetPath], capture());

      // seq gap INSIDE a packet: located verdict naming the position.
      const obj = JSON.parse(fs.readFileSync(packetPath, "utf8"));
      obj.events[3].seq = 7;
      const gapped = path.join(dir, "gapped.json");
      fs.writeFileSync(gapped, JSON.stringify(obj) + "\n");
      const io1 = capture();
      expect(await agent.cmdAgent(["verify", gapped, "--json"], io1)).to.equal(3);
      const v1 = JSON.parse(io1.out());
      expect(v1.reason).to.equal("SESSION_SEQ_NOT_CONTIGUOUS");
      expect(v1.seq).to.equal(3);

      // A drifted in-band trust note is a NAMED reject (the caveat must not be quietly rewritten).
      const noteObj = JSON.parse(fs.readFileSync(packetPath, "utf8"));
      noteObj.note = "trust me";
      const drifted = path.join(dir, "drifted.json");
      fs.writeFileSync(drifted, JSON.stringify(noteObj) + "\n");
      const io2 = capture();
      expect(await agent.cmdAgent(["verify", drifted], io2)).to.equal(1);
      expect(io2.err()).to.include("must be the standing trust note");

      // Missing file.
      const io3 = capture();
      expect(await agent.cmdAgent(["verify", path.join(dir, "nope.json")], io3)).to.equal(1);
      expect(io3.err()).to.include("cannot read");

      // A hostile SESSION file: a non-JSON line is named with its 1-based line number.
      const badSess = path.join(dir, "bad.jsonl");
      fs.writeFileSync(badSess, JSON.stringify(fixtureEvents(1)[0]) + "\n{nope\n");
      const io4 = capture();
      expect(await agent.cmdAgent(["seal", badSess], io4)).to.equal(1);
      expect(io4.err()).to.include("line 2 is not valid JSON");
    });
  });

  // =========================================================================
  // (5) CLI contract + wiring.
  // =========================================================================

  describe("CLI contract + `vh` wiring", function () {
    it("usage/exit contract: unknown subcommand and missing args are usage errors; help prints the surface", async function () {
      const io1 = capture();
      expect(await agent.cmdAgent(["frobnicate"], io1)).to.equal(2);
      expect(io1.err()).to.include("unknown agent subcommand");

      for (const args of [["seal"], ["verify"], ["redact"], ["prove"], ["verify-proof"], ["checkpoint"], ["verify-growth"]]) {
        const io = capture();
        expect(await agent.cmdAgent(args, io), args.join(" ")).to.equal(2);
        expect(io.err()).to.include("error:");
      }

      const ioHelp = capture();
      expect(await agent.cmdAgent(["help"], ioHelp)).to.equal(0);
      expect(ioHelp.out()).to.include("vh agent seal");
      expect(ioHelp.out()).to.include("agent_signed");

      const ioBare = capture();
      expect(await agent.cmdAgent([], ioBare)).to.equal(2);

      // Unknown flags are usage errors, not silently ignored.
      const dir = tmp();
      const sess = writeSession(dir, fixtureEvents());
      const ioFlag = capture();
      expect(await agent.cmdAgent(["seal", sess, "--frob"], ioFlag)).to.equal(2);
      expect(ioFlag.err()).to.include("unknown flag: --frob");
    });

    it("seal/checkpoint/prove/redact with NO --out print the artifact and write NOTHING", async function () {
      const dir = tmp();
      const before = fs.readdirSync(dir).sort();
      const sess = writeSession(dir, fixtureEvents());
      const io = capture();
      expect(await agent.cmdAgent(["seal", sess], io)).to.equal(0);
      // The artifact rides on stdout (after the trust note) and nothing new hit the directory.
      const printed = io.out();
      const artifactLine = printed.slice(printed.indexOf('{"kind"'));
      const packet = JSON.parse(artifactLine);
      expect(packet.kind).to.equal(agent.PACKET_KIND);
      expect(fs.readdirSync(dir).sort()).to.deep.equal([...before, "session.jsonl"].sort());
    });

    it("`vh agent` is wired into cli/vh.js (dispatch + usage + export)", function () {
      const vh = require("../cli/vh");
      expect(vh.cmdAgent).to.equal(agent.cmdAgent);
      expect(vh.usage()).to.include("vh agent seal <session.jsonl>");
      expect(vh.usage()).to.include("vh agent verify <packet>");
    });
  });
});
