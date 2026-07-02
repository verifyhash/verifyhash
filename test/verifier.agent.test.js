"use strict";

// test/verifier.agent.test.js — T-68.3: INDEPENDENT + ZERO-INSTALL verification of agent packets (the
// AgentTrace funnel leg, FREE surface only).
//
// WHAT THIS SUITE PROVES (the task's acceptance criteria):
//   (1) DISK == BYTES: the SAME `*.vhagent.json` packet driven through the disk path (`verifyArtifact`)
//       and the bytes path (`verifyArtifactFromBytes`) yields DEEP-EQUAL structured results + identical
//       exit codes for the whole fixture matrix: ACCEPT (unsigned), ACCEPT (signed + correct vendor
//       pin), REJECT tampered-payload NAMING THE SEQ, REJECT tampered-head, REJECT wrong-vendor,
//       ACCEPT redacted packet (identical head — redaction is not tamper), REJECT redacted packet whose
//       commitment was FORGED (naming the seq) — plus forged-signature, stolen-attestation
//       (head_not_bound) and stripped-signature-under-pin rejects for good measure.
//   (2) INDEPENDENCE CROSS-CHECK: on every matrix fixture the verifier's verdict AGREES with the
//       producer's `vh agent verify` (accept <-> accept, reject <-> reject, and the named seq matches)
//       — two implementations, one truth. A static guard proves the verifier engine imports NOTHING
//       from cli/ (the independent-surface requirement).
//   (3) DIST DISCIPLINE: two rebuilds are BYTE-IDENTICAL; the committed dist (JS bundles + HTML page +
//       sidecars + BUILD-PROVENANCE.json) equals a fresh rebuild; `--check` is green; the provenance
//       manifest re-pins EVERY target's bundle sha256 to the committed bytes; the six-token NO-NETWORK
//       test still passes over the WHOLE emitted HTML; and the vm-extracted engine block returns
//       verdicts BYTE-IDENTICAL to the in-tree bytes path for the built-in agent demo (ACCEPT, then a
//       one-byte tamper IN THE PAGE rejected naming the event seq).
//   (4) `scripts/site-release.js --check` is green after re-assembly (drift vs site/DEPLOYED.json is a
//       human deploy signal, never asserted here).
//   (5) ZERO-INSTALL: the committed standalone JS bundle verifies a dropped agent packet in a child
//       process (exit 0) and rejects a tampered copy (exit 3) with no producer stack.
//
// HONESTY: producer fixtures are minted with the REAL `vh agent` code (cli/agent.js buildPacket /
// serializePacket / the shared attestation core) — never hand-authored bytes — and every signing key is
// an EPHEMERAL in-process Wallet.createRandom() (TEST-ONLY; never a real key). No existing test
// expectation is edited.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");
const { spawnSync } = require("child_process");
const { Wallet } = require("ethers");

// The INDEPENDENT verifier under test.
const verifyvh = require("../verifier/verify-vh");
// The PRODUCER side — the oracle the cross-check runs against (allowed in the TEST, never in verifier/).
const agent = require("../cli/agent");
const coreAttestation = require("../cli/core/attestation");
const agentSession = require("../cli/core/agent-session");
// The dist builders (determinism + provenance re-pin checks).
const jsBuilder = require("../verifier/build-standalone");
const htmlBuilder = require("../verifier/build-standalone-html");

const REPO = path.join(__dirname, "..");
const VERIFIER_DIR = path.join(REPO, "verifier");
const DIST_VERIFY_JS = jsBuilder.OUT_PATH;
const DIST_HTML = htmlBuilder.OUT_PATH;
const DIST_PROVENANCE = jsBuilder.PROVENANCE_PATH;

const NETWORK_TOKENS = ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "import("];

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// A deterministic 5-event fixture session (every event type; one meta; unicode payloads).
function fixtureEvents() {
  return [
    { seq: 0, ts: "2026-07-02T10:00:00.000Z", actor: "user", type: "prompt", payload: "Plan the release — ünïcode ✓" },
    {
      seq: 1,
      ts: "2026-07-02T10:00:01.000Z",
      actor: "agent:assistant",
      type: "tool_call",
      payload: '{"tool":"bash","cmd":"npm test"}',
      meta: { step: 1, model: "fable-5" },
    },
    { seq: 2, ts: "2026-07-02T10:00:02.000Z", actor: "tool:bash", type: "tool_result", payload: "2278 passing" },
    { seq: 3, ts: "2026-07-02T10:00:03.000Z", actor: "agent:assistant", type: "note", payload: "suite green" },
    { seq: 4, ts: "2026-07-02T10:00:04.000Z", actor: "agent:assistant", type: "completion", payload: "Release is safe to tag." },
  ];
}

// Mint an UNSIGNED packet text via the REAL producer path.
function mintUnsignedText(events) {
  const built = agent.buildPacket(events);
  expect(built.ok, `producer buildPacket: ${JSON.stringify(built)}`).to.equal(true);
  return agent.serializePacket(built.packet);
}

// Mint a SIGNED packet text: the producer's head payload wrapped by the SHARED attestation core with an
// ephemeral TEST-ONLY wallet (exactly what `vh agent seal --sign` produces after its license gate).
async function mintSignedText(events, wallet) {
  const built = agent.buildPacket(events);
  expect(built.ok).to.equal(true);
  const packet = built.packet;
  const headPayload = {
    kind: agent.AGENT_HEAD_KIND,
    schemaVersion: 1,
    note: agent.AGENT_TRUST_NOTE,
    head: { size: packet.head.size, root: packet.head.root },
  };
  packet.headAttestation = await coreAttestation.signAttestation(
    { attestation: headPayload, signer: wallet },
    agent.SIGNED_HEAD_CFG
  );
  return agent.serializePacket(packet);
}

// The REDACTED twin of `events` (seqs in `seqs` withheld behind their commitments), rebuilt exactly as
// `vh agent redact` does. Carries `headAttestation` verbatim when supplied.
function redactEvents(events, seqs) {
  const wanted = new Set(seqs);
  return events.map((e) => {
    if (!wanted.has(e.seq)) return e;
    const r = agentSession.redactEvent(e);
    expect(r.ok, `redactEvent(${e.seq})`).to.equal(true);
    return r.event;
  });
}

describe("verifier agent packets (T-68.3): independent + zero-install verification", function () {
  this.timeout(240000);

  let tmpDirs;
  let cwdBefore;
  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-agent-verifier-"));
    tmpDirs.push(d);
    return d;
  }

  function capture() {
    const out = [];
    const err = [];
    return { write: (s) => out.push(s), writeErr: (s) => err.push(s), out: () => out.join(""), err: () => err.join("") };
  }

  // THE EQUIVALENCE ORACLE (criterion 1): the same packet text through the DISK path and the BYTES path
  // must be DEEP-EQUAL (same label, so the results match field-for-field) with identical exit codes.
  function assertPathsAgree(packetText, vendor) {
    const dir = mkTmp();
    const packetPath = path.join(dir, "session.vhagent.json");
    fs.writeFileSync(packetPath, packetText);
    const disk = verifyvh.verifyArtifact({ artifact: packetPath, vendor });
    const bytes = verifyvh.verifyArtifactFromBytes({
      artifactText: packetText,
      files: {},
      vendor,
      artifactName: packetPath,
    });
    expect(bytes.error, "bytes path returned a verdict, not an input error").to.equal(null);
    expect(bytes.code, "exit codes agree").to.equal(disk.code);
    expect(bytes.result, "structured results are DEEP-EQUAL").to.deep.equal(disk.result);
    expect(bytes.ok).to.equal(disk.result.accepted);
    return { result: disk.result, code: disk.code, packetPath };
  }

  // THE INDEPENDENCE CROSS-CHECK (criterion 2): the producer's `vh agent verify` must AGREE with the
  // independent verifier's verdict on the same packet file (accept <-> accept, reject <-> reject).
  async function assertProducerAgrees(packetPath, vendor, verifierResult) {
    const io = capture();
    const argv = ["verify", packetPath, "--json"];
    if (vendor) argv.push("--vendor", vendor);
    const code = await agent.cmdAgent(argv, io);
    const producer = JSON.parse(io.out());
    expect(
      producer.accepted,
      `producer (${producer.reason}) and verifier (${verifierResult.reason}) agree on ${path.basename(packetPath)}`
    ).to.equal(verifierResult.accepted);
    expect(code === 0).to.equal(verifierResult.accepted);
    return producer;
  }

  // ============================================================================================
  // (1) + (2): the fixture matrix — disk==bytes deep-equal AND producer/verifier agreement.
  // ============================================================================================
  describe("(1)+(2) the fixture matrix: disk==bytes deep-equal, and `vh agent verify` agrees", function () {
    it("ACCEPT: an UNSIGNED packet (exit 0) — the FREE funnel surface", async function () {
      const text = mintUnsignedText(fixtureEvents());
      const { result, code, packetPath } = assertPathsAgree(text, undefined);
      expect(code).to.equal(verifyvh.EXIT.OK);
      expect(result.verdict).to.equal("OK");
      expect(result.kind).to.equal(verifyvh.KINDS.AGENT_PACKET);
      expect(result.signed).to.equal(false);
      expect(result.rootMatches).to.equal(true);
      expect(result.agent.counts).to.deep.equal({ events: 5, full: 5, redacted: 0 });
      expect(result.agent.withheld).to.deep.equal([]);
      await assertProducerAgrees(packetPath, undefined, result);
    });

    it("ACCEPT: a SIGNED packet under the CORRECT vendor pin (signer genuinely recovered; exit 0)", async function () {
      const w = Wallet.createRandom();
      const vendor = w.address.toLowerCase();
      const text = await mintSignedText(fixtureEvents(), w);
      const { result, code, packetPath } = assertPathsAgree(text, vendor);
      expect(code).to.equal(verifyvh.EXIT.OK);
      expect(result.signed).to.equal(true);
      expect(result.signatureOk).to.equal(true);
      expect(result.recoveredSigner).to.equal(vendor);
      expect(result.signerMatchesVendor).to.equal(true);
      const producer = await assertProducerAgrees(packetPath, w.address, result);
      expect(producer.signature.recoveredSigner).to.equal(result.recoveredSigner);
    });

    it("REJECT tampered-payload: one byte changed in a FULL event's payload — NAMES the seq (exit 3)", async function () {
      const text = mintUnsignedText(fixtureEvents());
      expect(text.split("2278 passing").length, "tamper target unique").to.equal(2);
      const tampered = text.replace("2278 passing", "2279 passing");
      const { result, code, packetPath } = assertPathsAgree(tampered, undefined);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(result.reason).to.equal("CHANGED");
      expect(result.agent.seq, "the offending seq is NAMED").to.equal(2);
      expect(result.agent.reason).to.equal("EVENT_PAYLOAD_HASH_MISMATCH");
      expect(result.changed).to.have.length(1);
      expect(result.changed[0].relPath).to.equal("events[2]");
      const producer = await assertProducerAgrees(packetPath, undefined, result);
      expect(producer.seq, "producer names the SAME seq").to.equal(2);
    });

    it("REJECT tampered-head: a one-nibble edit of head.root -> root_mismatch (exit 3)", async function () {
      const obj = JSON.parse(mintUnsignedText(fixtureEvents()));
      const r = obj.head.root;
      obj.head.root = r.slice(0, 10) + (r[10] === "a" ? "b" : "a") + r.slice(11);
      const tampered = JSON.stringify(obj) + "\n";
      const { result, code, packetPath } = assertPathsAgree(tampered, undefined);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(result.reason).to.equal("root_mismatch");
      expect(result.rootMatches).to.equal(false);
      expect(result.recomputedRoot).to.not.equal(result.sealedRoot);
      expect(result.agent.reason).to.equal("HEAD_MISMATCH");
      const producer = await assertProducerAgrees(packetPath, undefined, result);
      expect(producer.reason).to.equal("HEAD_MISMATCH");
    });

    it("REJECT wrong-vendor: a sound signature pinned to the WRONG address -> wrong_issuer (exit 3)", async function () {
      const w = Wallet.createRandom();
      const text = await mintSignedText(fixtureEvents(), w);
      const wrongVendor = "0x" + "11".repeat(20);
      const { result, code, packetPath } = assertPathsAgree(text, wrongVendor);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(result.reason).to.equal("wrong_issuer");
      expect(result.signatureOk).to.equal(true);
      expect(result.signerMatchesVendor).to.equal(false);
      expect(result.agent.reason).to.equal("WRONG_VENDOR");
      const producer = await assertProducerAgrees(packetPath, wrongVendor, result);
      expect(producer.reason).to.equal("WRONG_VENDOR");
    });

    it("ACCEPT a REDACTED packet: withheld payloads behind commitments, IDENTICAL head, the SAME signature still valid (exit 0)", async function () {
      const w = Wallet.createRandom();
      const vendor = w.address.toLowerCase();
      const events = fixtureEvents();
      const fullText = await mintSignedText(events, w);
      const fullObj = JSON.parse(fullText);
      // Redact seqs 1 and 2 exactly as `vh agent redact --seq 1,2` does; carry the attestation verbatim.
      const rebuilt = agent.buildPacket(redactEvents(events, [1, 2]));
      expect(rebuilt.ok).to.equal(true);
      expect(rebuilt.packet.head, "redaction changed NEITHER the size NOR the root").to.deep.equal(fullObj.head);
      rebuilt.packet.headAttestation = fullObj.headAttestation;
      const redactedText = agent.serializePacket(rebuilt.packet);

      const { result, code, packetPath } = assertPathsAgree(redactedText, vendor);
      expect(code).to.equal(verifyvh.EXIT.OK);
      expect(result.verdict).to.equal("OK");
      expect(result.signed).to.equal(true);
      expect(result.signerMatchesVendor, "ONE signature stays valid for the redacted copy").to.equal(true);
      expect(result.agent.withheld).to.deep.equal([1, 2]);
      expect(result.agent.counts).to.deep.equal({ events: 5, full: 3, redacted: 2 });
      expect(result.recomputedRoot, "identical head as the full packet").to.equal(fullObj.head.root);
      await assertProducerAgrees(packetPath, w.address, result);
    });

    it("REJECT a redacted packet whose COMMITMENT was FORGED — names the seq on BOTH implementations (exit 3)", async function () {
      const events = fixtureEvents();
      const rebuilt = agent.buildPacket(redactEvents(events, [1]));
      expect(rebuilt.ok).to.equal(true);
      const obj = JSON.parse(agent.serializePacket(rebuilt.packet));
      expect(obj.events[1].redacted).to.equal(true);
      obj.events[1].payloadHash = "0x" + "ab".repeat(32); // the forged commitment (leaves untouched)
      const forged = JSON.stringify(obj) + "\n";
      const { result, code, packetPath } = assertPathsAgree(forged, undefined);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(result.reason).to.equal("CHANGED");
      expect(result.agent.seq, "the forged redacted commitment is localized to its seq").to.equal(1);
      expect(result.agent.reason).to.equal("EVENT_LEAF_MISMATCH");
      expect(result.changed[0].relPath).to.equal("events[1]");
      const producer = await assertProducerAgrees(packetPath, undefined, result);
      expect(producer.reason).to.equal("EVENT_LEAF_MISMATCH");
      expect(producer.seq).to.equal(1);
    });

    it("REJECT forged signature (bad_signature), stolen attestation (head_not_bound), and a --vendor pin on an UNSIGNED packet — all agree with the producer", async function () {
      const w = Wallet.createRandom();
      const vendor = w.address.toLowerCase();
      const signedText = await mintSignedText(fixtureEvents(), w);

      // (a) forged signature: flip one hex nibble inside r.
      const forged = JSON.parse(signedText);
      const sig = forged.headAttestation.signature.signature;
      forged.headAttestation.signature.signature = sig.slice(0, 20) + (sig[20] === "a" ? "b" : "a") + sig.slice(21);
      const forgedText = JSON.stringify(forged) + "\n";
      let out = assertPathsAgree(forgedText, vendor);
      expect(out.code).to.equal(verifyvh.EXIT.REJECTED);
      expect(out.result.reason).to.equal("bad_signature");
      await assertProducerAgrees(out.packetPath, w.address, out.result);

      // (b) a signature PASTED from a different session: recovers fine, binds the WRONG head.
      const other = agent.buildPacket([
        { seq: 0, ts: "2026-07-02T11:00:00.000Z", actor: "user", type: "prompt", payload: "another session" },
      ]);
      expect(other.ok).to.equal(true);
      other.packet.headAttestation = JSON.parse(signedText).headAttestation;
      const stolenText = agent.serializePacket(other.packet);
      out = assertPathsAgree(stolenText, vendor);
      expect(out.code).to.equal(verifyvh.EXIT.REJECTED);
      expect(out.result.reason).to.equal("head_not_bound");
      expect(out.result.agent.reason).to.equal("HEAD_NOT_BOUND");
      const producerStolen = await assertProducerAgrees(out.packetPath, w.address, out.result);
      expect(producerStolen.reason).to.equal("HEAD_NOT_BOUND");

      // (c) fail-closed pin: an UNSIGNED packet under --vendor never passes (a stripped signature).
      const unsignedText = mintUnsignedText(fixtureEvents());
      out = assertPathsAgree(unsignedText, vendor);
      expect(out.code).to.equal(verifyvh.EXIT.REJECTED);
      expect(out.result.reason).to.equal("unsigned_cannot_pin_vendor");
      const producerStripped = await assertProducerAgrees(out.packetPath, w.address, out.result);
      expect(producerStripped.reason).to.equal("NOT_SIGNED");
    });

    // REGRESSION (the T-68.3 rework defect): a FULL event whose payload carries an UNPAIRED LOW
    // surrogate is a GENUINE, sealable packet — the producer's commitment (ethers toUtf8Bytes) encodes
    // U+DC00..U+DFFF as its literal 3-byte form (ed b0 80 …), it does NOT throw. The free verifier's
    // UTF-8 encoder previously FALSELY REJECTED this class (EVENT_BAD_PAYLOAD), breaking byte-exact
    // agreement with the producer on the customer-facing funnel leg. This proves both directions:
    //   (accept) a lone-LOW payload seals + verifies + agrees, disk==bytes; and
    //   (fail-closed) a lone-HIGH surrogate has NO UTF-8 encoding (ethers throws), so the producer
    //   won't even seal it, and a hand-crafted packet carrying one is REJECTED (EVENT_BAD_PAYLOAD,
    //   naming the seq) on BOTH implementations — never a false-accept.
    it("ACCEPT a FULL event whose payload has an UNPAIRED LOW surrogate — the producer's exact commitment; disk==bytes; producer agrees (regression)", async function () {
      const lowPayload = "log tail: \udc00 (truncated UTF-16 tool_result)"; // legal JS string, no throw
      const events = [
        { seq: 0, ts: "2026-07-02T10:00:00.000Z", actor: "tool:bash", type: "tool_result", payload: lowPayload },
        { seq: 1, ts: "2026-07-02T10:00:01.000Z", actor: "agent:assistant", type: "note", payload: "clean unicode ✓" },
      ];
      const text = mintUnsignedText(events);
      // The packet carries the GENUINE producer commitment (ethers 3-byte encoding of the lone low surrogate),
      // not a substituted/errored one — the free verifier must recompute the identical value and ACCEPT.
      const obj = JSON.parse(text);
      expect(obj.events[0].payloadHash).to.equal(agentSession.payloadHash(lowPayload));
      const { result, code, packetPath } = assertPathsAgree(text, undefined);
      expect(code).to.equal(verifyvh.EXIT.OK);
      expect(result.verdict).to.equal("OK");
      expect(result.agent.counts).to.deep.equal({ events: 2, full: 2, redacted: 0 });
      await assertProducerAgrees(packetPath, undefined, result);

      // Fail-closed: a lone HIGH surrogate has no UTF-8 encoding (ethers THROWS) — the producer refuses
      // to seal it, so this class can never slip a false-accept past the free verifier.
      expect(agentSession.payloadHash("high \ud800 end"), "lone HIGH commitment is undefined").to.equal(null);
      const highBuilt = agent.buildPacket([
        { seq: 0, ts: "2026-07-02T10:00:00.000Z", actor: "user", type: "prompt", payload: "high \ud800 end" },
      ]);
      expect(highBuilt.ok, "producer will NOT seal a lone-high-surrogate payload").to.equal(false);
      // A hand-crafted packet carrying a lone-high payload REJECTS identically on both implementations.
      const craft = JSON.parse(
        mintUnsignedText([{ seq: 0, ts: "2026-07-02T10:00:00.000Z", actor: "user", type: "prompt", payload: "ok" }])
      );
      craft.events[0] = { ...craft.events[0], payload: "high \ud800 end" };
      const craftText = JSON.stringify(craft) + "\n";
      const rejected = assertPathsAgree(craftText, undefined);
      expect(rejected.code).to.equal(verifyvh.EXIT.REJECTED);
      expect(rejected.result.agent.reason).to.equal("EVENT_BAD_PAYLOAD");
      expect(rejected.result.agent.seq).to.equal(0);
      const producer = await assertProducerAgrees(rejected.packetPath, undefined, rejected.result);
      expect(producer.reason).to.equal("EVENT_BAD_PAYLOAD");
      expect(producer.seq).to.equal(0);
    });

    it("a STRUCTURALLY invalid packet (drifted trust note) is the same IO class (exit 1) on verifier AND producer", async function () {
      const obj = JSON.parse(mintUnsignedText(fixtureEvents()));
      obj.note = "a drifted note";
      const text = JSON.stringify(obj) + "\n";
      const dir = mkTmp();
      const p = path.join(dir, "drifted.vhagent.json");
      fs.writeFileSync(p, text);
      // Disk path: a named IOError (exit-1 class), never a stack.
      expect(() => verifyvh.verifyArtifact({ artifact: p })).to.throw(verifyvh.IOError, /trust note/);
      // Bytes path: the SAME named IO rejection, structured.
      const bytes = verifyvh.verifyArtifactFromBytes({ artifactText: text, files: {}, artifactName: p });
      expect(bytes.ok).to.equal(false);
      expect(bytes.code).to.equal(verifyvh.EXIT.IO);
      expect(bytes.error.name).to.equal("IOError");
      // Producer: exit 1 (invalid artifact), agreeing on the class.
      const io = capture();
      const code = await agent.cmdAgent(["verify", p, "--json"], io);
      expect(code).to.equal(1);
    });

    it("STATIC INDEPENDENCE GUARD: verifier/verify-vh.js + its libs import NOTHING from cli/ (the producer stack)", function () {
      const files = [
        path.join(VERIFIER_DIR, "verify-vh.js"),
        ...fs
          .readdirSync(path.join(VERIFIER_DIR, "lib"))
          .filter((f) => f.endsWith(".js"))
          .map((f) => path.join(VERIFIER_DIR, "lib", f)),
      ];
      for (const f of files) {
        const specs = [...fs.readFileSync(f, "utf8").matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
        for (const spec of specs) {
          expect(spec, `${path.relative(REPO, f)} must not reach into cli/ (got require(${JSON.stringify(spec)}))`).to.not.match(
            /(^|\/)cli(\/|$)|\.\.\//
          );
        }
      }
    });
  });

  // ============================================================================================
  // The SHIPPED demo fixture: genuine producer output, one tool_call payload redacted.
  // ============================================================================================
  describe("the inlined DEMO agent packet (DEMO_AGENT_*)", function () {
    it("is a GENUINE producer packet: `vh agent verify`-shape ACCEPTED with exactly seq 1 (the tool_call) withheld", function () {
      const obj = agent.validatePacketShape(JSON.parse(verifyvh.DEMO_AGENT_PACKET_TEXT));
      const v = agent.verifyPacket(obj);
      expect(v.accepted, JSON.stringify(v)).to.equal(true);
      expect(v.withheld).to.deep.equal([1]);
      expect(obj.events[1].type).to.equal("tool_call");
      expect(obj.events[1].redacted).to.equal(true);
      expect("payload" in obj.events[1]).to.equal(false);
    });

    it("ACCEPTs on both verifier paths, and the one-byte TAMPER pair rejects NAMING seq DEMO_AGENT_TAMPER_SEQ", function () {
      const { result, code } = assertPathsAgree(verifyvh.DEMO_AGENT_PACKET_TEXT, undefined);
      expect(code).to.equal(verifyvh.EXIT.OK);
      expect(result.agent.withheld).to.deep.equal([1]);
      // The tamper FROM-substring occurs EXACTLY once, so the page's one-byte edit is deterministic.
      expect(verifyvh.DEMO_AGENT_PACKET_TEXT.split(verifyvh.DEMO_AGENT_TAMPER_FROM).length).to.equal(2);
      const tampered = verifyvh.DEMO_AGENT_PACKET_TEXT.replace(
        verifyvh.DEMO_AGENT_TAMPER_FROM,
        verifyvh.DEMO_AGENT_TAMPER_TO
      );
      const rejected = assertPathsAgree(tampered, undefined);
      expect(rejected.code).to.equal(verifyvh.EXIT.REJECTED);
      expect(rejected.result.reason).to.equal("CHANGED");
      expect(rejected.result.agent.seq).to.equal(verifyvh.DEMO_AGENT_TAMPER_SEQ);
      expect(rejected.result.changed[0].relPath).to.equal(`events[${verifyvh.DEMO_AGENT_TAMPER_SEQ}]`);
    });
  });

  // ============================================================================================
  // (3) DIST DISCIPLINE: determinism, committed == rebuilt, --check, provenance re-pins, the
  //     six-token no-network test, and the vm-extracted agent demo byte-identity.
  // ============================================================================================
  describe("(3) rebuilt dist: deterministic, committed, re-pinned; the page's agent demo is byte-identical", function () {
    it("two rebuilds are BYTE-IDENTICAL for every target (JS verify/seal bundles + the HTML page + provenance)", function () {
      expect(jsBuilder.buildBundle()).to.equal(jsBuilder.buildBundle());
      expect(jsBuilder.buildSealBundle()).to.equal(jsBuilder.buildSealBundle());
      expect(htmlBuilder.buildHtml()).to.equal(htmlBuilder.buildHtml());
      expect(jsBuilder.buildProvenanceText()).to.equal(jsBuilder.buildProvenanceText());
    });

    it("the COMMITTED dist matches a fresh rebuild byte-for-byte (stale dist FAILS here)", function () {
      const stale = " is STALE — re-run the builders and commit";
      expect(fs.readFileSync(DIST_VERIFY_JS, "utf8"), "verify bundle" + stale).to.equal(jsBuilder.buildBundle());
      expect(fs.readFileSync(jsBuilder.SEAL_OUT_PATH, "utf8"), "seal bundle" + stale).to.equal(jsBuilder.buildSealBundle());
      expect(fs.readFileSync(DIST_HTML, "utf8"), "html page" + stale).to.equal(htmlBuilder.buildHtml());
      expect(fs.readFileSync(DIST_PROVENANCE, "utf8"), "provenance" + stale).to.equal(jsBuilder.buildProvenanceText());
    });

    it("`node verifier/build-standalone.js --check` is green (every bundle + sidecar + manifest reproduces)", function () {
      const res = spawnSync(process.execPath, [path.join(VERIFIER_DIR, "build-standalone.js"), "--check"], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
      });
      expect(res.status, res.stdout + res.stderr).to.equal(0);
      expect(res.stdout).to.not.match(/MISMATCH/);
      expect(res.stdout).to.match(/ALL MATCH/);
    });

    it("BUILD-PROVENANCE.json RE-PINS every target: each bundleSha256 equals the committed bundle's real sha256", function () {
      const prov = JSON.parse(fs.readFileSync(DIST_PROVENANCE, "utf8"));
      expect(Object.keys(prov.targets)).to.deep.equal(["verify", "seal", htmlBuilder.HTML_TARGET_NAME]);
      const committed = {
        verify: fs.readFileSync(DIST_VERIFY_JS),
        seal: fs.readFileSync(jsBuilder.SEAL_OUT_PATH),
        [htmlBuilder.HTML_TARGET_NAME]: fs.readFileSync(DIST_HTML),
      };
      for (const [name, target] of Object.entries(prov.targets)) {
        expect(target.bundleSha256, `${name} re-pinned to the committed bytes`).to.equal(sha256Hex(committed[name]));
        expect(target.bundleBytes).to.equal(committed[name].length);
      }
      // The verify-vh.js source pin covers the new agent engine (the whole audited file is pinned).
      const vvSha = sha256Hex(
        Buffer.from(fs.readFileSync(path.join(VERIFIER_DIR, "verify-vh.js"), "utf8").replace(/\r\n/g, "\n").replace(/^#![^\n]*\n/, ""), "utf8")
      );
      const pin = prov.targets.verify.modules.find((m) => m.sourceFile === "verifier/verify-vh.js");
      expect(pin.sourceSha256).to.equal(vvSha);
    });

    it("the six-token NO-NETWORK test still passes over the WHOLE emitted HTML (committed + fresh)", function () {
      for (const html of [fs.readFileSync(DIST_HTML, "utf8"), htmlBuilder.buildHtml()]) {
        for (const tok of NETWORK_TOKENS) {
          expect(html.includes(tok), `forbidden token ${JSON.stringify(tok)}`).to.equal(false);
        }
      }
    });

    it("the page carries the agent-demo surfaces (load / editor / tamper / restore controls)", function () {
      const html = fs.readFileSync(DIST_HTML, "utf8");
      for (const id of ["load-agent-sample", "agent-editor", "agent-verify", "agent-tamper", "agent-restore", "agent-verdict"]) {
        expect(html).to.contain(`id="${id}"`);
      }
      expect(html).to.contain("vhagent.json");
    });

    it("the vm-extracted engine block returns AGENT-DEMO verdicts BYTE-IDENTICAL to the in-tree bytes path: click ACCEPT, one-byte tamper IN THE PAGE rejects naming the seq", function () {
      const html = fs.readFileSync(DIST_HTML, "utf8");
      const begin = html.indexOf(htmlBuilder.ENGINE_BEGIN_MARKER);
      const end = html.indexOf(htmlBuilder.ENGINE_END_MARKER);
      expect(begin).to.be.greaterThan(-1);
      expect(end).to.be.greaterThan(begin);
      const ctx = {};
      vm.createContext(ctx);
      vm.runInNewContext(html.slice(begin, end), ctx, { filename: "verify-vh-standalone-engine.js" });

      // The embedded fixture IS the verifier's shipped demo packet, verbatim (anti-drift pin).
      const fx = JSON.parse(vm.runInContext("JSON.stringify(VerifyVhStandalone.challenge.fixture)", ctx));
      expect(fx.AGENT_PACKET_NAME).to.equal(verifyvh.DEMO_AGENT_PACKET_NAME);
      expect(fx.AGENT_PACKET_TEXT).to.equal(verifyvh.DEMO_AGENT_PACKET_TEXT);
      expect(fx.AGENT_TAMPER_SEQ).to.equal(verifyvh.DEMO_AGENT_TAMPER_SEQ);
      expect(fx.AGENT_TAMPER_FROM).to.equal(verifyvh.DEMO_AGENT_TAMPER_FROM);
      expect(fx.AGENT_TAMPER_TO).to.equal(verifyvh.DEMO_AGENT_TAMPER_TO);

      const parsed = JSON.parse(vm.runInContext("JSON.stringify(VerifyVhStandalone.challenge.runAgentChallenge())", ctx));
      // GENUINE: byte-identical to the in-tree bytes path over the SAME shipped demo packet.
      const wantGenuine = JSON.stringify(
        verifyvh.verifyArtifactFromBytes({
          artifactText: verifyvh.DEMO_AGENT_PACKET_TEXT,
          files: {},
          artifactName: verifyvh.DEMO_AGENT_PACKET_NAME,
        })
      );
      expect(JSON.stringify(parsed.genuine), "vm agent-demo verdict bytes == in-tree bytes path").to.equal(wantGenuine);
      expect(parsed.genuine.ok).to.equal(true);
      expect(parsed.genuine.result.agent.withheld).to.deep.equal([1]);
      // TAMPERED (in the page): byte-identical to the in-tree bytes path over the tampered text,
      // a clean REJECT that NAMES the event seq.
      const wantTampered = JSON.stringify(
        verifyvh.verifyArtifactFromBytes({
          artifactText: verifyvh.DEMO_AGENT_PACKET_TEXT.replace(verifyvh.DEMO_AGENT_TAMPER_FROM, verifyvh.DEMO_AGENT_TAMPER_TO),
          files: {},
          artifactName: verifyvh.DEMO_AGENT_PACKET_NAME,
        })
      );
      expect(JSON.stringify(parsed.tampered)).to.equal(wantTampered);
      expect(parsed.tampered.ok).to.equal(false);
      expect(parsed.tampered.code).to.equal(verifyvh.EXIT.REJECTED);
      expect(parsed.tampered.result.reason).to.equal("CHANGED");
      expect(parsed.tampered.result.agent.seq).to.equal(verifyvh.DEMO_AGENT_TAMPER_SEQ);
      expect(parsed.tamperSeq).to.equal(verifyvh.DEMO_AGENT_TAMPER_SEQ);
    });
  });

  // ============================================================================================
  // (4) site-release --check green after re-assembly (drift vs DEPLOYED.json is a human signal).
  // ============================================================================================
  describe("(4) site release re-assembly", function () {
    it("`node scripts/site-release.js --check` is green (the committed manifest + webroot match the sources)", function () {
      const res = spawnSync(process.execPath, [path.join(REPO, "scripts", "site-release.js"), "--check"], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
      });
      expect(res.status, res.stdout + res.stderr).to.equal(0);
      expect(res.stdout + res.stderr).to.match(/--check: OK/);
    });
  });

  // ============================================================================================
  // (5) ZERO-INSTALL: the committed standalone JS bundle verifies agent packets in a child process.
  // ============================================================================================
  describe("(5) zero-install: the committed standalone bundle verifies a dropped *.vhagent.json", function () {
    it("ACCEPTs the demo agent packet (exit 0) and REJECTs a one-byte tamper naming the seq (exit 3) — no producer stack", function () {
      const dir = mkTmp();
      const bundle = path.join(dir, "verify-vh-standalone.js");
      fs.copyFileSync(DIST_VERIFY_JS, bundle); // run the SHIPPED artifact from an empty dir (no node_modules)
      const good = path.join(dir, "demo-session.vhagent.json");
      fs.writeFileSync(good, verifyvh.DEMO_AGENT_PACKET_TEXT);
      const bad = path.join(dir, "tampered.vhagent.json");
      fs.writeFileSync(
        bad,
        verifyvh.DEMO_AGENT_PACKET_TEXT.replace(verifyvh.DEMO_AGENT_TAMPER_FROM, verifyvh.DEMO_AGENT_TAMPER_TO)
      );

      const ok = spawnSync(process.execPath, [bundle, good, "--json"], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
      });
      expect(ok.status, ok.stdout + ok.stderr).to.equal(0);
      const okVerdict = JSON.parse(ok.stdout);
      expect(okVerdict.accepted).to.equal(true);
      expect(okVerdict.kind).to.equal("vh.agent-session-packet");
      expect(okVerdict.agent.withheld).to.deep.equal([1]);

      const rej = spawnSync(process.execPath, [bundle, bad, "--json"], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
      });
      expect(rej.status, rej.stdout + rej.stderr).to.equal(3);
      const rejVerdict = JSON.parse(rej.stdout);
      expect(rejVerdict.reason).to.equal("CHANGED");
      expect(rejVerdict.agent.seq).to.equal(verifyvh.DEMO_AGENT_TAMPER_SEQ);

      // The HUMAN rendering names the seq too (the counterparty-facing line).
      const human = spawnSync(process.execPath, [bundle, bad], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
      });
      expect(human.status).to.equal(3);
      expect(human.stdout).to.match(/first offending event seq: 0/);
    });
  });
});
