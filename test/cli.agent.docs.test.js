"use strict";

// test/cli.agent.docs.test.js — the ANTI-DRIFT acceptance suite for the AgentTrace docs + the REAL
// ingest example (T-68.4).
//
// WHY THIS TEST EXISTS
//   docs/AGENTTRACE.md is the buyer-facing statement of what a `*.vhagent.json` packet PROVES and —
//   load-bearingly — what it does NOT. A boundary sentence that rots is an overclaim, and an ingest
//   example that rots sends an adopter at commands that no longer work. So this suite does NOT trust
//   the prose; it PROVES, against the REAL code and fixtures, that:
//     (a) the doc pins every boundary sentence: the four PROVES claims, the garbage-in disclaimer,
//         self-asserted `ts`, the no-trusted-timestamp / P-3 line — and carries the code's in-band
//         AGENT_TRUST_NOTE VERBATIM (the TRUST_NOTE discipline: the caveat travels in the packet, and
//         the doc quotes the exact wording the packet enforces);
//     (b) the free-vs-paid line names the REAL capability (`agent_signed`, from the code) and the
//         independent-verification pointers name artifacts that REALLY exist (verify-vh handles the
//         agent packet kind; the dist bundle + browser page are on disk);
//     (c) examples/agent-session/ is REAL: the committed transcript is a genuine OpenAI-chat-
//         completions-style `messages[]` + tool-calls JSONL export; map-transcript.js is dependency-
//         free (Node core only) and its MAPPING block honors the "~20-line mapping" claim; and the
//         documented end-to-end flow — map → seal → redact → verify → prove — runs VERBATIM against
//         the committed fixture (plus a tamper REJECT naming the seq, so the flow is evidentiary, not
//         a happy-path demo);
//     (d) the funnel pointers exist (README.md, docs/ADOPT.md, docs/PILOT.md's journeys list) and NO
//         P-3/P-5/P-6/P-7/P-8/P-9/P-11 human step in STRATEGY.md was deleted or relaxed — and the new
//         docs declare no needs-human item of their own.
//   Filesystem hygiene: every artifact the flow writes lands in a throwaway temp dir (cleaned up pass
//   or fail); the suite asserts the working directory is left untouched.

const { expect } = require("chai");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const agent = require("../cli/agent");
const agentSession = require("../cli/core/agent-session");
const evidencePlans = require("../cli/core/evidence-plans");

const REPO = path.resolve(__dirname, "..");
const DOC = path.join(REPO, "docs", "AGENTTRACE.md");
const README = path.join(REPO, "README.md");
const ADOPT = path.join(REPO, "docs", "ADOPT.md");
const PILOT = path.join(REPO, "docs", "PILOT.md");
const STRATEGY = path.join(REPO, "STRATEGY.md");
const EXAMPLE_DIR = path.join(REPO, "examples", "agent-session");
const EXAMPLE_README = path.join(EXAMPLE_DIR, "README.md");
const TRANSCRIPT = path.join(EXAMPLE_DIR, "transcript.openai.jsonl");
const MAP_JS = path.join(EXAMPLE_DIR, "map-transcript.js");
const VERIFY_VH = path.join(REPO, "verifier", "verify-vh.js");
const DIST_JS = path.join(REPO, "verifier", "dist", "verify-vh-standalone.js");
const DIST_HTML = path.join(REPO, "verifier", "dist", "verify-vh-standalone.html");

const doc = fs.readFileSync(DOC, "utf8");
const low = doc.toLowerCase();

function capture() {
  const out = [];
  const err = [];
  return {
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("T-68.4: docs/AGENTTRACE.md + examples/agent-session/ — honest boundary + REAL ingest example", function () {
  this.timeout(60000);

  // -----------------------------------------------------------------------
  // (a) The boundary sentences — what a packet PROVES and what it does NOT.
  // -----------------------------------------------------------------------
  describe("(a) docs/AGENTTRACE.md pins the honest trust boundary", function () {
    it("ships the doc", function () {
      expect(fs.existsSync(DOC), "docs/AGENTTRACE.md must be shipped").to.equal(true);
    });

    it("states the four PROVES claims", function () {
      expect(low, "proves: log unaltered since seal").to.match(/unaltered since (it was )?seal/);
      expect(low, "proves: disclosed events verbatim as recorded").to.contain("verbatim as recorded");
      expect(low, "proves: append-only growth between checkpoint and head").to.match(
        /append-only growth between a checkpoint and the final head/
      );
      expect(low, "proves: redaction withholds, never silently alters").to.match(
        /redaction can only withhold[\s\S]{0,80}never silently alter/
      );
    });

    it("states garbage-in is OUT OF SCOPE (the log's fidelity to what the agent ACTUALLY did is never claimed)", function () {
      expect(low).to.match(
        /does not prove the log faithfully records what the agent actually did/
      );
      expect(low).to.contain("garbage-in is out of scope");
    });

    it("states `ts` is self-asserted and there is NO trusted 'existed at time T' without the P-3 trust-root", function () {
      expect(low, "`ts` fields are self-asserted").to.match(/`ts` fields are self-asserted/);
      expect(low, "not a trusted timestamp").to.contain("not a trusted timestamp");
      expect(low, 'no "existed at time T" claim').to.match(/existed at time t/);
      expect(doc, "the trusted-time upgrade rides the standing P-3 proposal").to.contain("P-3");
    });

    it("carries the code's in-band AGENT_TRUST_NOTE VERBATIM (the TRUST_NOTE discipline: doc == packet wording)", function () {
      // The exact string every packet/checkpoint/proof carries as `note` (and verify enforces).
      expect(doc, "docs/AGENTTRACE.md must quote AGENT_TRUST_NOTE byte-for-byte").to.contain(
        agent.AGENT_TRUST_NOTE
      );
      // Belt-and-braces: the note itself still says the load-bearing things this doc leans on.
      expect(agent.AGENT_TRUST_NOTE).to.contain("Garbage-in is out of scope");
      expect(agent.AGENT_TRUST_NOTE).to.contain("SELF-ASSERTED");
      expect(agent.AGENT_TRUST_NOTE).to.contain("NOT a trusted timestamp");
    });

    it("draws the free-vs-paid line with the REAL capability name (verify/prove/redact FREE; --sign gated by `agent_signed`)", function () {
      // The free verbs are named free…
      expect(low, "the FREE surface is stated").to.match(/free[\s\S]{0,200}verify/);
      for (const verb of ["verify", "redact", "prove", "checkpoint", "verify-growth"]) {
        expect(low, `the free surface names ${verb}`).to.contain(verb);
      }
      // …and the paid surface is --sign, gated by the capability the CODE actually declares.
      expect(evidencePlans.AGENT_SIGNED_CAPABILITY, "the DRAFT capability id").to.equal("agent_signed");
      expect(doc, "the doc names the real capability").to.contain(evidencePlans.AGENT_SIGNED_CAPABILITY);
      expect(low, "--sign is the paid surface").to.match(/paid[\s\S]{0,120}--sign/);
      expect(low, "the gate is fail-closed, never a silent downgrade").to.contain("never a silent downgrade");
    });

    it("points the buyer at INDEPENDENT verification surfaces that REALLY exist", function () {
      // The independent verifier really handles this artifact kind…
      const vv = fs.readFileSync(VERIFY_VH, "utf8");
      expect(agent.PACKET_KIND).to.equal("vh.agent-session-packet");
      expect(vv, "verifier/verify-vh.js must dispatch on the agent packet kind").to.contain(agent.PACKET_KIND);
      // …and the doc names it plus the two zero-install surfaces, which are committed on disk.
      expect(doc).to.contain("verifier/verify-vh.js");
      expect(doc).to.contain("verify-vh-standalone.js");
      expect(doc).to.contain("verify-vh-standalone.html");
      expect(fs.existsSync(DIST_JS), "the zero-install bundle must be committed").to.equal(true);
      expect(fs.existsSync(DIST_HTML), "the offline browser page must be committed").to.equal(true);
    });
  });

  // -----------------------------------------------------------------------
  // (b) The ingest example is REAL: a common third-party transcript shape + a
  //     dependency-free ~20-line mapping.
  // -----------------------------------------------------------------------
  describe("(b) examples/agent-session/ — the third-party transcript + the tiny mapper", function () {
    it("the committed transcript is a genuine OpenAI-chat-completions-style messages[] + tool-calls JSONL export", function () {
      const lines = fs
        .readFileSync(TRANSCRIPT, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "");
      expect(lines.length, "a realistic transcript, not a stub").to.be.greaterThan(5);
      const msgs = lines.map((l, i) => {
        try {
          return JSON.parse(l);
        } catch (e) {
          throw new Error(`transcript line ${i + 1} is not valid JSON: ${e.message}`);
        }
      });
      const ROLES = new Set(["system", "user", "assistant", "tool"]);
      for (const m of msgs) {
        expect(ROLES.has(m.role), `chat-completions role, got ${JSON.stringify(m.role)}`).to.equal(true);
      }
      // The shape really exercises tool use: an assistant tool_calls turn (OpenAI function-call
      // shape) and a role:"tool" result bound by tool_call_id.
      const call = msgs.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
      expect(call, "an assistant message with tool_calls[]").to.not.equal(undefined);
      expect(call.tool_calls[0]).to.have.property("id");
      expect(call.tool_calls[0]).to.have.nested.property("function.name");
      expect(call.tool_calls[0]).to.have.nested.property("function.arguments");
      const result = msgs.find((m) => m.role === "tool");
      expect(result, 'a role:"tool" result message').to.not.equal(undefined);
      expect(result).to.have.property("tool_call_id");
      // A PII-bearing tool result, so the documented redact step is motivated, not decorative.
      expect(
        msgs.some((m) => m.role === "tool" && String(m.content).includes("customer_email")),
        "a tool result carrying redactable PII"
      ).to.equal(true);
    });

    it("map-transcript.js is DEPENDENCY-FREE (Node core fs/path only — no producer stack, no crypto)", function () {
      const src = fs.readFileSync(MAP_JS, "utf8");
      const required = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      expect(required.length, "requires something (fs at least)").to.be.greaterThan(0);
      for (const r of required) {
        expect(["fs", "path"].includes(r), `only Node-core fs/path allowed, got require("${r}")`).to.equal(true);
      }
    });

    it("the MAPPING block honors the '~20-line mapping, not a platform migration' claim", function () {
      const src = fs.readFileSync(MAP_JS, "utf8");
      const begin = src.indexOf("// MAPPING BEGIN");
      const end = src.indexOf("// MAPPING END");
      expect(begin, "MAPPING BEGIN marker").to.be.greaterThan(-1);
      expect(end, "MAPPING END marker").to.be.greaterThan(begin);
      const body = src
        .slice(begin, end)
        .split("\n")
        .slice(1) // drop the BEGIN marker line itself
        .filter((l) => l.trim() !== "");
      expect(
        body.length,
        `the whole mapping must stay tiny (~20 lines; got ${body.length}) — that IS the adoption claim`
      ).to.be.at.most(25);
      // And the claim is actually made where an adopter reads it.
      expect(low, "docs/AGENTTRACE.md makes the ~20-line claim").to.contain("~20-line mapping");
      expect(fs.readFileSync(EXAMPLE_README, "utf8"), "the example README makes the claim too").to.contain(
        "~20-line mapping"
      );
    });
  });

  // -----------------------------------------------------------------------
  // (c) The documented end-to-end flow REALLY runs: map → seal → redact →
  //     verify → prove (+ a tamper REJECT naming the seq).
  // -----------------------------------------------------------------------
  describe("(c) the end-to-end flow: map → seal → redact → verify → prove", function () {
    let tmp;
    let cwdBefore;
    beforeEach(function () {
      cwdBefore = fs.readdirSync(process.cwd()).sort();
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vh-agent-docs-"));
    });
    afterEach(function () {
      if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
      // FILESYSTEM HYGIENE: nothing leaked into the working tree, pass or fail.
      expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
    });

    it("runs the whole documented journey against the committed fixture", async function () {
      // 1. MAP — the example's own CLI, as a child process, exactly as the README says.
      const eventsPath = path.join(tmp, "events.jsonl");
      execFileSync(process.execPath, [MAP_JS, "--out", eventsPath], {
        cwd: tmp,
        stdio: ["ignore", "pipe", "pipe"], // keep the mapper's stderr summary out of the test log
      });
      const events = fs
        .readFileSync(eventsPath, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l));
      const session = agentSession.validateSession(events);
      expect(session.ok, `mapped events must be a valid canonical session: ${JSON.stringify(session)}`).to.equal(true);
      expect(events.length, "every transcript turn mapped (calls + results + texts)").to.be.greaterThan(7);
      // The PII-bearing tool result the docs redact — located by content, not a hardcoded seq.
      const pii = events.find((e) => typeof e.payload === "string" && e.payload.includes("customer_email"));
      expect(pii, "the mapped session carries the PII tool_result").to.not.equal(undefined);
      expect(pii.type).to.equal("tool_result");

      // 2. SEAL (free, unsigned).
      const packetPath = path.join(tmp, "session.vhagent.json");
      let io = capture();
      const sealCode = await agent.runAgentSeal({ session: eventsPath, out: packetPath, json: true }, io);
      expect(sealCode, io.err()).to.equal(agent.EXIT.OK);
      const head = JSON.parse(io.out()).head;
      expect(head.size).to.equal(events.length);

      // 3. REDACT the PII payload behind its commitment.
      const redactedPath = path.join(tmp, "session.redacted.vhagent.json");
      io = capture();
      expect(
        agent.runAgentRedact({ packet: packetPath, seq: String(pii.seq), out: redactedPath, json: true }, io),
        io.err()
      ).to.equal(agent.EXIT.OK);

      // 4. VERIFY the redacted copy: ACCEPTED, withheld seq listed, head IDENTICAL (redaction != tamper),
      //    and the verdict rides the in-band trust note (the TRUST_NOTE discipline, machine-checked).
      io = capture();
      expect(agent.runAgentVerify({ packet: redactedPath, json: true }, io), io.err()).to.equal(agent.EXIT.OK);
      const verdict = JSON.parse(io.out());
      expect(verdict.accepted).to.equal(true);
      expect(verdict.withheld).to.deep.equal([pii.seq]);
      expect(verdict.head).to.deep.equal(head);
      expect(verdict.note).to.equal(agent.AGENT_TRUST_NOTE);
      // The withheld payload is really GONE from the redacted packet bytes.
      expect(fs.readFileSync(redactedPath, "utf8")).to.not.contain("customer_email");

      // 5. PROVE one FULL event from the REDACTED packet, then check the disclosure offline.
      const finalSeq = events.length - 1;
      const proofPath = path.join(tmp, "event.proof.json");
      io = capture();
      expect(
        agent.runAgentProve({ packet: redactedPath, seq: String(finalSeq), out: proofPath, json: true }, io),
        io.err()
      ).to.equal(agent.EXIT.OK);
      io = capture();
      expect(agent.runAgentVerifyProof({ proof: proofPath, json: true }, io), io.err()).to.equal(agent.EXIT.OK);
      let proofVerdict = JSON.parse(io.out());
      expect(proofVerdict.accepted).to.equal(true);
      expect(proofVerdict.seq).to.equal(finalSeq);
      expect(proofVerdict.redacted).to.equal(false);

      // …and the REDACTED event is provable too: disclosure without the payload still verifies.
      const redactedProofPath = path.join(tmp, "event.redacted.proof.json");
      io = capture();
      expect(
        agent.runAgentProve({ packet: redactedPath, seq: String(pii.seq), out: redactedProofPath, json: true }, io),
        io.err()
      ).to.equal(agent.EXIT.OK);
      io = capture();
      expect(agent.runAgentVerifyProof({ proof: redactedProofPath, json: true }, io), io.err()).to.equal(
        agent.EXIT.OK
      );
      proofVerdict = JSON.parse(io.out());
      expect(proofVerdict.accepted).to.equal(true);
      expect(proofVerdict.redacted).to.equal(true);

      // 6. The flow is evidentiary, not a happy path: ONE payload byte flipped → REJECT naming the seq.
      const tampered = JSON.parse(fs.readFileSync(redactedPath, "utf8"));
      const full = tampered.events.find((e) => e.redacted !== true);
      full.payload = full.payload.slice(0, -1) + (full.payload.endsWith("!") ? "?" : "!");
      const tamperedPath = path.join(tmp, "tampered.vhagent.json");
      fs.writeFileSync(tamperedPath, JSON.stringify(tampered) + "\n");
      io = capture();
      expect(agent.runAgentVerify({ packet: tamperedPath, json: true }, io)).to.equal(agent.EXIT.FAIL);
      const rejected = JSON.parse(io.out());
      expect(rejected.accepted).to.equal(false);
      expect(rejected.seq, "the REJECT names the offending event seq").to.equal(full.seq);
    });

    it("the mapper rejects a garbled transcript with a NAMED 1-based line (and writes nothing)", function () {
      const bad = path.join(tmp, "bad.jsonl");
      fs.writeFileSync(bad, '{"role":"user","content":"ok"}\nnot json at all\n');
      const out = path.join(tmp, "unused.jsonl");
      let failed = null;
      try {
        execFileSync(process.execPath, [MAP_JS, bad, "--out", out], {
          cwd: tmp,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        failed = e;
      }
      expect(failed, "a garbled transcript must be a hard error").to.not.equal(null);
      expect(failed.status).to.equal(1);
      expect(String(failed.stderr)).to.contain("line 2");
      expect(fs.existsSync(out), "no partial output on failure").to.equal(false);
    });
  });

  // -----------------------------------------------------------------------
  // (d) Funnel pointers + NO human step deleted or relaxed.
  // -----------------------------------------------------------------------
  describe("(d) pointers + the standing human gates", function () {
    it("README.md links docs/AGENTTRACE.md and the worked example", function () {
      const readme = fs.readFileSync(README, "utf8");
      expect(readme).to.match(/\]\(docs\/AGENTTRACE\.md\)/);
      expect(readme).to.match(/\]\(examples\/agent-session\/?\)/);
      expect(readme).to.contain("vh agent");
    });

    it("docs/ADOPT.md points at AGENTTRACE.md + the example", function () {
      const adopt = fs.readFileSync(ADOPT, "utf8");
      expect(adopt).to.match(/\]\(AGENTTRACE\.md\)/);
      expect(adopt).to.contain("examples/agent-session");
    });

    it("docs/PILOT.md's journeys list points at the AgentTrace journey honestly (rides the same core; not driven by the kit)", function () {
      const pilot = fs.readFileSync(PILOT, "utf8");
      const journeys = pilot.slice(pilot.indexOf("## 1. What you are evaluating"), pilot.indexOf("## 2."));
      expect(journeys).to.contain("AgentTrace");
      expect(journeys).to.match(/\]\(AGENTTRACE\.md\)/);
      // Honesty: the kit's script does not drive this journey, and the pointer says so.
      expect(journeys.toLowerCase()).to.match(/does not drive it|not driven by/);
    });

    it("no P-3/P-5/P-6/P-7/P-8/P-9/P-11 human step was deleted or relaxed", function () {
      const strategy = fs.readFileSync(STRATEGY, "utf8");
      const header = strategy.search(/##\s*Proposals — needs-human/);
      expect(header, "the needs-human proposals section exists").to.be.greaterThan(-1);
      const proposals = strategy.slice(header);
      for (const id of ["P-3", "P-5", "P-6", "P-7", "P-8", "P-9", "P-11"]) {
        const start = proposals.indexOf(`- **${id} (`);
        expect(start, `${id} proposal block still exists`).to.be.greaterThan(-1);
        const next = proposals.slice(start + 4).search(/\n- \*\*P-\d+ \(/);
        const block = next === -1 ? proposals.slice(start) : proposals.slice(start, start + 4 + next);
        expect(block, `${id} still carries its needs-human status (not relaxed)`).to.match(
          /\*Status:\s*needs-human/
        );
      }
    });

    it("the new docs declare NO needs-human item of their own (this task adds no human gate)", function () {
      for (const [name, p] of [
        ["docs/AGENTTRACE.md", DOC],
        ["examples/agent-session/README.md", EXAMPLE_README],
      ]) {
        expect(fs.readFileSync(p, "utf8"), `${name} must not declare a needs-human proposal`).to.not.match(
          /\*Status:\s*needs-human/
        );
      }
    });
  });
});
