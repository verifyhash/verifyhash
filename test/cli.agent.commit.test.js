"use strict";

// `vh agent commit-claim` / `vh agent verify-commit` (T-69.2) — the CLI verbs over the PURE
// commit-claim core (cli/core/agent-commit.js, T-69.1). Both FREE, read-only, key-less.
//
// What these prove (the T-69.2 acceptance criteria, each as an honest test):
//   (a) commit-claim: derives the oid via cli/git.js resolveCommit and the tracked-set root via
//       cli/hash.js hashGit (BOTH reused verbatim — asserted by re-deriving with those exact
//       functions and comparing), and emits ONE canonical JSONL event line that the agent-session
//       core validates unchanged and that seals into a verifying packet; `--ts` is self-asserted
//       (verbatim when given, the injected clock otherwise); a missing/unknown ref or a
//       not-a-work-tree --repo surfaces the EXISTING named git errors at exit 1 — never a stack
//       trace; usage mistakes are exit 2; with no --out, stdout is EXACTLY the one line (so
//       `>> session.jsonl` appends cleanly) and the trust note rides stderr.
//   (b) verify-commit: FIRST re-runs the FULL existing packet verification (a tampered payload —
//       or a failed vendor pin: unsigned-but-pinned, wrong vendor — is `packet-invalid` even when
//       the claim itself would match, proving the ordering), THEN re-derives oid + root from the
//       auditor's OWN clone and ACCEPTs only if a DISCLOSED claim matches; REJECT names the failed
//       check: packet-invalid / no-disclosed-claim / oid-mismatch / root-mismatch (root-mismatch
//       instructs "check out the claimed commit in a CLEAN tree" — a dirty checkout is an HONEST
//       mismatch); redacting any OTHER event leaves the claim checkable (redaction-safety), while
//       redacting the CLAIM is no-disclosed-claim. Exit 0 ACCEPTED / 3 REJECTED / 2 usage / 1 IO.
//   (c) CLI hygiene: every write lands under a throwaway temp dir at an explicit --out (never
//       cwd); the working tree is left CLEAN; usage lines exist in `vh agent` help and `vh` help.
//
// The one signing key used (for the signed-packet vendor-pin leg) is an EPHEMERAL in-process
// Wallet.createRandom() (TEST-ONLY, never a real key); the license window uses an injected `now`.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { Wallet } = require("ethers");

const agent = require("../cli/agent");
const agentCommit = require("../cli/core/agent-commit");
const agentSession = require("../cli/core/agent-session");
const coreLicense = require("../cli/core/license");
const git = require("../cli/git");
const { hashGit } = require("../cli/hash");

const NOW = new Date("2026-07-03T12:00:00.000Z");
const ISSUED = "2026-06-01T00:00:00.000Z";
const EXPIRES = "2027-06-01T00:00:00.000Z";

// Throwaway git repos isolated from the host's global git config (deterministic on any machine).
const GIT_ID = [
  "-c", "user.name=verifyhash-test",
  "-c", "user.email=test@verifyhash.invalid",
  "-c", "commit.gpgsign=false",
  "-c", "init.defaultBranch=main",
];

function runGit(cwd, args) {
  return execFileSync("git", [...GIT_ID, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

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

// A small, valid fixture session of `n` events (seqs 0..n-1) — the log the claim line appends to.
function fixtureEvents(n) {
  const types = ["prompt", "completion", "tool_call", "tool_result", "note"];
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push({
      seq: i,
      ts: `2026-07-03T09:00:${String(i).padStart(2, "0")}.000Z`,
      actor: i % 2 === 0 ? "agent:assistant" : "tool:bash",
      type: types[i % types.length],
      payload: JSON.stringify({ i, text: `payload #${i} — ünïcode ✓` }),
    });
  }
  return events;
}

describe("cli/agent T-69.2: `vh agent commit-claim` / `vh agent verify-commit`", function () {
  this.timeout(30000);

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
  function tmp(prefix = "vh-agent-commit-test-") {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  }

  // A git repo with `files` committed. realpath'd so macOS /tmp symlinks don't skew scopes/paths.
  function makeRepo(files) {
    const dir = fs.realpathSync(tmp("vh-agent-commit-repo-"));
    runGit(dir, ["init", "-q"]);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    runGit(dir, ["add", "-A"]);
    runGit(dir, ["commit", "-q", "-m", "initial"]);
    return dir;
  }

  const REPO_FILES = {
    "README.md": "# project\n",
    "src/index.js": "module.exports = 42;\n",
    "src/util/helper.js": "exports.h = () => 1;\n",
  };

  // Emit a claim line via the CLI (--json) and return the parsed envelope.
  async function emitClaim(repo, seq, extra = []) {
    const io = capture();
    const code = await agent.cmdAgent(
      ["commit-claim", "--repo", repo, "--seq", String(seq), "--json", ...extra],
      io
    );
    expect(code, io.err()).to.equal(0);
    return JSON.parse(io.out());
  }

  // Producer flow: n fixture events + the claim line at seq n, sealed to an explicit --out path.
  // Returns { packetPath, sessionPath, claimSeq, claimJson }.
  async function sealSessionWithClaim(repo, artifactsDir, n = 5, sealExtra = []) {
    const claimJson = await emitClaim(repo, n);
    const sessionPath = path.join(artifactsDir, "session.jsonl");
    fs.writeFileSync(
      sessionPath,
      fixtureEvents(n).map((e) => JSON.stringify(e)).join("\n") + "\n" + claimJson.artifact
    );
    const packetPath = path.join(artifactsDir, "session.vhagent.json");
    const io = capture();
    const code = await agent.cmdAgent(["seal", sessionPath, "--out", packetPath, ...sealExtra], io);
    expect(code, io.err()).to.equal(0);
    return { packetPath, sessionPath, claimSeq: n, claimJson };
  }

  // =========================================================================
  // (a) commit-claim — the producer emits ONE canonical JSONL claim line.
  // =========================================================================

  describe("commit-claim (producer, FREE, key-less)", function () {
    it("derives the oid via resolveCommit + the root via hashGit (reused verbatim) and emits the canonical claim event", async function () {
      const repo = makeRepo(REPO_FILES);
      // The independent re-derivation with the EXACT reused functions:
      const expectedOid = git.resolveCommit(repo, "HEAD");
      const expectedRoot = hashGit(repo, {}).root;

      const j = await emitClaim(repo, 3);
      expect(j.ok).to.equal(true);
      expect(j.kind).to.equal(agentCommit.CLAIM_KIND);
      expect(j.note).to.equal(agent.COMMIT_CLAIM_TRUST_NOTE);
      expect(j.commit).to.equal(expectedOid);
      expect(j.gitRoot).to.equal(expectedRoot);
      expect(j.scope).to.equal(null); // vantage point IS the repo root => no scope hint
      expect(j.seq).to.equal(3);
      expect(j.ts).to.equal(NOW.toISOString()); // default ts: the injected clock, self-asserted
      expect(j.actor).to.equal(agentCommit.DEFAULT_ACTOR);
      expect(j.out).to.equal(null);

      // The line is ONE canonical JSONL event: newline-terminated, single line, and the EVENT the
      // agent-session core accepts unchanged; its payload parses back to the exact claim.
      expect(j.artifact.endsWith("\n")).to.equal(true);
      expect(j.artifact.trim().split("\n")).to.have.lengthOf(1);
      const event = JSON.parse(j.artifact);
      expect(event).to.deep.equal(j.event);
      const ev = agentSession.validateEvent(event);
      expect(ev.ok).to.equal(true);
      expect(ev.redacted).to.equal(false);
      expect(event.type).to.equal(agentCommit.CLAIM_EVENT_TYPE);
      const parsed = agentCommit.parseCommitClaim(event.payload);
      expect(parsed.ok).to.equal(true);
      expect(parsed.claim).to.deep.equal(j.claim);
      expect(parsed.claim.commit).to.equal(expectedOid);
      expect(parsed.claim.gitRoot).to.equal(expectedRoot);
    });

    it("with no --out, stdout is EXACTLY the one appendable JSONL line; the trust note rides stderr", async function () {
      const repo = makeRepo(REPO_FILES);
      const io = capture();
      const code = await agent.cmdAgent(["commit-claim", "--repo", repo, "--seq", "0"], io);
      expect(code, io.err()).to.equal(0);
      // stdout: exactly one line, valid JSON, nothing else — `>> session.jsonl` stays clean.
      expect(io.out().endsWith("\n")).to.equal(true);
      expect(io.out().trim().split("\n")).to.have.lengthOf(1);
      const event = JSON.parse(io.out());
      expect(agentSession.validateEvent(event).ok).to.equal(true);
      // stderr: the trust note (containment, not causation) + summary — informational only.
      expect(io.err()).to.include("CONTAINMENT, NOT CAUSATION");
      expect(io.err()).to.include("commit-claim event (seq 0)");
    });

    it("--ts/--actor pass through VERBATIM (self-asserted); --out writes ONLY the line at the explicit path", async function () {
      const repo = makeRepo(REPO_FILES);
      const dir = tmp();
      const outPath = path.join(dir, "claim.jsonl");
      const j = await emitClaim(repo, 7, [
        "--ts", "2020-01-01T00:00:00Z",
        "--actor", "agent:builder",
        "--out", outPath,
      ]);
      expect(j.ts).to.equal("2020-01-01T00:00:00Z");
      expect(j.event.ts).to.equal("2020-01-01T00:00:00Z");
      expect(j.event.actor).to.equal("agent:builder");
      expect(j.out).to.equal(outPath);
      expect(j.artifact).to.equal(null); // family parity: --out set => artifact rides the file
      const written = fs.readFileSync(outPath, "utf8");
      expect(written).to.equal(JSON.stringify(j.event) + "\n");
    });

    it("--repo pointed INSIDE a subtree records the vantage-point `scope` hint (unverified)", async function () {
      const repo = makeRepo(REPO_FILES);
      const j = await emitClaim(path.join(repo, "src", "util"), 0);
      expect(j.scope).to.equal("src/util");
      expect(j.claim.scope).to.equal("src/util");
      // The enumeration is whole-repo regardless of vantage point: same root + oid as repo-root.
      expect(j.gitRoot).to.equal(hashGit(repo, {}).root);
      expect(j.commit).to.equal(git.resolveCommit(repo, "HEAD"));
    });

    it("the emitted line appends to a session that SEALS and VERIFIES (end-to-end producer flow)", async function () {
      const repo = makeRepo(REPO_FILES);
      const dir = tmp();
      const { packetPath, claimSeq } = await sealSessionWithClaim(repo, dir, 4);
      const io = capture();
      expect(await agent.cmdAgent(["verify", packetPath, "--json"], io), io.err()).to.equal(0);
      const v = JSON.parse(io.out());
      expect(v.accepted).to.equal(true);
      expect(v.head.size).to.equal(claimSeq + 1);
    });

    it("a non-work-tree --repo and an unknown --ref surface the EXISTING named git errors at exit 1 — never a stack trace", async function () {
      const plain = tmp(); // not a git repo
      const io1 = capture();
      expect(await agent.cmdAgent(["commit-claim", "--repo", plain, "--seq", "0"], io1)).to.equal(1);
      expect(io1.err()).to.include("not a git repository");
      expect(io1.err()).to.not.match(/\n\s+at /); // no stack trace
      expect(io1.out()).to.equal(""); // nothing appendable was emitted

      const repo = makeRepo(REPO_FILES);
      const io2 = capture();
      expect(
        await agent.cmdAgent(["commit-claim", "--repo", repo, "--ref", "no-such-branch", "--seq", "0"], io2)
      ).to.equal(1);
      expect(io2.err()).to.include("unknown git ref: no-such-branch");
      expect(io2.err()).to.not.match(/\n\s+at /);
    });

    it("usage mistakes are exit 2 with a named error: missing --repo/--seq, garbage --seq, unknown flag, stray positional", async function () {
      const repo = makeRepo(REPO_FILES);
      const cases = [
        [["commit-claim", "--seq", "0"], "requires --repo"],
        [["commit-claim", "--repo", repo], "requires --seq"],
        [["commit-claim", "--repo", repo, "--seq", "x"], "--seq must be a single non-negative integer"],
        [["commit-claim", "--repo", repo, "--seq", "1,2"], "--seq must be a single non-negative integer"],
        [["commit-claim", "--repo", repo, "--seq", "-1"], "--seq must be a single non-negative integer"],
        [["commit-claim", "--repo", repo, "--seq", "0", "--bogus"], "unknown flag"],
        [["commit-claim", "--repo", repo, "--seq", "0", "stray"], "unexpected extra argument"],
      ];
      for (const [args, msg] of cases) {
        const io = capture();
        expect(await agent.cmdAgent(args, io), args.join(" ")).to.equal(2);
        expect(io.err(), args.join(" ")).to.include(msg);
      }
    });
  });

  // =========================================================================
  // (b) verify-commit — the auditor re-derives everything from their OWN clone.
  // =========================================================================

  describe("verify-commit (auditor, FREE, read-only, key-less)", function () {
    it("ACCEPTs (exit 0) when the packet verifies AND a disclosed claim matches the re-derived facts", async function () {
      const repo = makeRepo(REPO_FILES);
      const dir = tmp();
      const { packetPath, claimSeq } = await sealSessionWithClaim(repo, dir, 5);

      const io = capture();
      const code = await agent.cmdAgent(["verify-commit", packetPath, "--repo", repo, "--json"], io);
      expect(code, io.err()).to.equal(0);
      const r = JSON.parse(io.out());
      expect(r.verdict).to.equal("ACCEPTED");
      expect(r.accepted).to.equal(true);
      expect(r.reason).to.equal(null);
      expect(r.note).to.equal(agent.COMMIT_CLAIM_TRUST_NOTE);
      // The facts are the AUDITOR'S OWN re-derivation, present in the stable JSON contract:
      expect(r.expected).to.deep.equal({
        commit: git.resolveCommit(repo, "HEAD"),
        gitRoot: hashGit(repo, {}).root,
      });
      expect(r.matched.seq).to.equal(claimSeq);
      expect(r.matched.claim.commit).to.equal(r.expected.commit);
      expect(r.matched.claim.gitRoot).to.equal(r.expected.gitRoot);
      expect(r.claims).to.deep.equal([{ seq: claimSeq, claim: r.matched.claim }]);
      expect(r.head.size).to.equal(claimSeq + 1);
      expect(r.signed).to.equal(false);
      expect(r.repo).to.equal(repo);
      expect(r.ref).to.equal("HEAD");

      // Human mode agrees and leads with the trust note.
      const io2 = capture();
      expect(await agent.cmdAgent(["verify-commit", packetPath, "--repo", repo], io2)).to.equal(0);
      expect(io2.out().startsWith(agent.COMMIT_CLAIM_TRUST_NOTE)).to.equal(true);
      expect(io2.out()).to.include("ACCEPTED");
      expect(io2.out()).to.include(`seq ${claimSeq}`);
    });

    it("redacting every OTHER event leaves the claim checkable — still ACCEPTED (redaction-safety)", async function () {
      const repo = makeRepo(REPO_FILES);
      const dir = tmp();
      const { packetPath, claimSeq } = await sealSessionWithClaim(repo, dir, 5);
      const redacted = path.join(dir, "redacted.vhagent.json");
      const io1 = capture();
      expect(
        await agent.cmdAgent(["redact", packetPath, "--seq", "0,1,2,3,4", "--out", redacted], io1),
        io1.err()
      ).to.equal(0);

      const io2 = capture();
      expect(await agent.cmdAgent(["verify-commit", redacted, "--repo", repo, "--json"], io2)).to.equal(0);
      const r = JSON.parse(io2.out());
      expect(r.verdict).to.equal("ACCEPTED");
      expect(r.matched.seq).to.equal(claimSeq);
      expect(r.counts.redacted).to.equal(5);
    });

    it("redacting the CLAIM itself (or sealing a claim-free session) REJECTs no-disclosed-claim (exit 3)", async function () {
      const repo = makeRepo(REPO_FILES);
      const dir = tmp();
      const { packetPath, claimSeq } = await sealSessionWithClaim(repo, dir, 5);

      // Redact the claim: its payload bytes are withheld => not disclosable.
      const redacted = path.join(dir, "claim-redacted.vhagent.json");
      const io1 = capture();
      expect(
        await agent.cmdAgent(["redact", packetPath, "--seq", String(claimSeq), "--out", redacted], io1),
        io1.err()
      ).to.equal(0);
      const io2 = capture();
      expect(await agent.cmdAgent(["verify-commit", redacted, "--repo", repo, "--json"], io2)).to.equal(3);
      const r2 = JSON.parse(io2.out());
      expect(r2.verdict).to.equal("REJECTED");
      expect(r2.reason).to.equal("no-disclosed-claim");
      expect(r2.detail).to.include("REDACTED claim is not disclosable");
      expect(r2.matched).to.equal(null);

      // A session with no claim at all: same named reject.
      const sess = path.join(dir, "plain.jsonl");
      fs.writeFileSync(sess, fixtureEvents(3).map((e) => JSON.stringify(e)).join("\n") + "\n");
      const plainPacket = path.join(dir, "plain.vhagent.json");
      const io3 = capture();
      expect(await agent.cmdAgent(["seal", sess, "--out", plainPacket], io3), io3.err()).to.equal(0);
      const io4 = capture();
      expect(await agent.cmdAgent(["verify-commit", plainPacket, "--repo", repo, "--json"], io4)).to.equal(3);
      expect(JSON.parse(io4.out()).reason).to.equal("no-disclosed-claim");
    });

    it("a TAMPERED packet never reaches the claim check: packet-invalid naming the underlying reject (exit 3)", async function () {
      const repo = makeRepo(REPO_FILES);
      const dir = tmp();
      const { packetPath } = await sealSessionWithClaim(repo, dir, 5);

      // Tamper ONE payload byte of a NON-claim event — the claim itself still matches the repo,
      // so an implementation that checked the claim first would wrongly ACCEPT.
      const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
      packet.events[0].payload = packet.events[0].payload + "X";
      const tampered = path.join(dir, "tampered.vhagent.json");
      fs.writeFileSync(tampered, JSON.stringify(packet) + "\n");

      const io = capture();
      expect(await agent.cmdAgent(["verify-commit", tampered, "--repo", repo, "--json"], io)).to.equal(3);
      const r = JSON.parse(io.out());
      expect(r.verdict).to.equal("REJECTED");
      expect(r.reason).to.equal("packet-invalid");
      expect(r.packetReason).to.equal("EVENT_PAYLOAD_HASH_MISMATCH");
      expect(r.packetSeq).to.equal(0);
      expect(r.detail).to.include("EVENT_PAYLOAD_HASH_MISMATCH");
      expect(r.matched).to.equal(null);
      expect(r.expected).to.equal(null); // rejected BEFORE any git fact was derived
    });

    it("the vendor pin is handled by the EXISTING verify path: unsigned+pinned and wrong-vendor are packet-invalid; the correct pin ACCEPTs", async function () {
      const repo = makeRepo(REPO_FILES);
      const dir = tmp();

      // Unsigned packet + --vendor: fail-closed NOT_SIGNED (a stripped signature never passes).
      const { packetPath } = await sealSessionWithClaim(repo, dir, 4);
      const stranger = Wallet.createRandom();
      const io1 = capture();
      expect(
        await agent.cmdAgent(
          ["verify-commit", packetPath, "--repo", repo, "--vendor", stranger.address, "--json"],
          io1
        )
      ).to.equal(3);
      const r1 = JSON.parse(io1.out());
      expect(r1.reason).to.equal("packet-invalid");
      expect(r1.packetReason).to.equal("NOT_SIGNED");

      // A SIGNED packet (ephemeral TEST-ONLY key + a license carrying `agent_signed`).
      const vendorWallet = Wallet.createRandom();
      const container = await coreLicense.buildLicense(
        {
          licenseId: "AG-T69-1",
          customer: "ACME Agents Co",
          plan: "agent-draft",
          entitlements: [agent.AGENT_SIGNED_CAPABILITY],
          issuedAt: ISSUED,
          expiresAt: EXPIRES,
        },
        vendorWallet,
        agent.AGENT_LICENSE_CFG
      );
      const licenseFile = path.join(dir, "license.json");
      fs.writeFileSync(licenseFile, JSON.stringify(container) + "\n");
      const keyFile = path.join(dir, "key.txt");
      fs.writeFileSync(keyFile, vendorWallet.privateKey + "\n");

      const signedDir = tmp();
      const { packetPath: signedPacket } = await sealSessionWithClaim(repo, signedDir, 4, [
        "--sign",
        "--key-file", keyFile,
        "--license", licenseFile,
        "--vendor", vendorWallet.address,
      ]);

      // Correct pin: packet verifies AND the claim matches => ACCEPTED, signer pinned.
      const io2 = capture();
      expect(
        await agent.cmdAgent(
          ["verify-commit", signedPacket, "--repo", repo, "--vendor", vendorWallet.address, "--json"],
          io2
        ),
        io2.err()
      ).to.equal(0);
      const r2 = JSON.parse(io2.out());
      expect(r2.verdict).to.equal("ACCEPTED");
      expect(r2.signed).to.equal(true);
      expect(r2.signature.signerMatchesVendor).to.equal(true);

      // Wrong pin: packet-invalid (WRONG_VENDOR) — the claim is never consulted.
      const io3 = capture();
      expect(
        await agent.cmdAgent(
          ["verify-commit", signedPacket, "--repo", repo, "--vendor", stranger.address, "--json"],
          io3
        )
      ).to.equal(3);
      const r3 = JSON.parse(io3.out());
      expect(r3.reason).to.equal("packet-invalid");
      expect(r3.packetReason).to.equal("WRONG_VENDOR");
    });

    it("oid-mismatch when the clone resolves to a DIFFERENT commit; checking out the claimed commit restores ACCEPT", async function () {
      const repo = makeRepo(REPO_FILES);
      const dir = tmp();
      const { packetPath } = await sealSessionWithClaim(repo, dir, 4);
      const claimedOid = git.resolveCommit(repo, "HEAD");

      // History moves on: a second commit changes both the oid and the work-tree bytes.
      fs.writeFileSync(path.join(repo, "src", "index.js"), "module.exports = 43;\n");
      runGit(repo, ["add", "-A"]);
      runGit(repo, ["commit", "-q", "-m", "second"]);

      const io1 = capture();
      expect(await agent.cmdAgent(["verify-commit", packetPath, "--repo", repo, "--json"], io1)).to.equal(3);
      const r1 = JSON.parse(io1.out());
      expect(r1.verdict).to.equal("REJECTED");
      expect(r1.reason).to.equal("oid-mismatch");
      expect(r1.detail).to.include(claimedOid);
      expect(r1.detail).to.include(git.resolveCommit(repo, "HEAD"));

      // The auditor follows the instruction: check out the CLAIMED commit (clean tree) => ACCEPT.
      runGit(repo, ["checkout", "-q", claimedOid]);
      const io2 = capture();
      expect(await agent.cmdAgent(["verify-commit", packetPath, "--repo", repo, "--json"], io2), io2.err()).to.equal(0);
      expect(JSON.parse(io2.out()).verdict).to.equal("ACCEPTED");
    });

    it("root-mismatch on a DIRTY checkout of the right commit — an HONEST mismatch naming the clean-tree fix", async function () {
      const repo = makeRepo(REPO_FILES);
      const dir = tmp();
      const { packetPath } = await sealSessionWithClaim(repo, dir, 4);

      // Dirty ONE tracked file WITHOUT committing: same oid, different work-tree bytes.
      fs.writeFileSync(path.join(repo, "README.md"), "# tampered work tree\n");
      const io1 = capture();
      expect(await agent.cmdAgent(["verify-commit", packetPath, "--repo", repo, "--json"], io1)).to.equal(3);
      const r1 = JSON.parse(io1.out());
      expect(r1.verdict).to.equal("REJECTED");
      expect(r1.reason).to.equal("root-mismatch");
      expect(r1.detail).to.include("CLEAN tree");
      expect(r1.detail).to.include("HONEST mismatch");

      // Restoring the clean checkout restores ACCEPT.
      runGit(repo, ["checkout", "--", "."]);
      const io2 = capture();
      expect(await agent.cmdAgent(["verify-commit", packetPath, "--repo", repo, "--json"], io2), io2.err()).to.equal(0);
      expect(JSON.parse(io2.out()).verdict).to.equal("ACCEPTED");
    });

    it("usage (exit 2) and IO (exit 1) mistakes are named: missing packet/--repo, bad --vendor, unreadable packet, non-repo", async function () {
      const repo = makeRepo(REPO_FILES);
      const dir = tmp();
      const { packetPath } = await sealSessionWithClaim(repo, dir, 3);

      const usageCases = [
        [["verify-commit", "--repo", repo], "requires a <packet>"],
        [["verify-commit", packetPath], "requires --repo"],
        [["verify-commit", packetPath, "--repo", repo, "--vendor", "nonsense"], "--vendor must be a valid 0x-address"],
        [["verify-commit", packetPath, "--repo", repo, "extra"], "unexpected extra argument"],
      ];
      for (const [args, msg] of usageCases) {
        const io = capture();
        expect(await agent.cmdAgent(args, io), args.join(" ")).to.equal(2);
        expect(io.err(), args.join(" ")).to.include(msg);
      }

      // Unreadable / missing packet file: IO.
      const io1 = capture();
      expect(
        await agent.cmdAgent(["verify-commit", path.join(dir, "nope.json"), "--repo", repo], io1)
      ).to.equal(1);
      expect(io1.err()).to.include("invalid agent-session packet");

      // A verifying packet but the auditor's --repo is not a work tree: the EXISTING named git
      // error at exit 1, never a stack trace.
      const plain = tmp();
      const io2 = capture();
      expect(await agent.cmdAgent(["verify-commit", packetPath, "--repo", plain], io2)).to.equal(1);
      expect(io2.err()).to.include("not a git repository");
      expect(io2.err()).to.not.match(/\n\s+at /);
    });
  });

  // =========================================================================
  // (c) Help/usage lines — the documented surface names both verbs.
  // =========================================================================

  describe("usage lines", function () {
    it("`vh agent` help names both verbs, their reject names, and the free/key-less posture", function () {
      const u = agent.agentUsage();
      expect(u).to.include("vh agent commit-claim --repo <dir> [--ref <ref=HEAD>] --seq <n>");
      expect(u).to.include("vh agent verify-commit <packet> --repo <dir>");
      for (const named of ["packet-invalid", "no-disclosed-claim", "oid-mismatch", "root-mismatch"]) {
        expect(u).to.include(named);
      }
      expect(u).to.include("CONTAINMENT, not causation");
    });

    it("`vh` top-level usage names both verbs (cli/vh.js)", function () {
      const src = fs.readFileSync(path.join(__dirname, "..", "cli", "vh.js"), "utf8");
      expect(src).to.include("vh agent commit-claim --repo <dir>");
      expect(src).to.include("vh agent verify-commit <packet> --repo <dir>");
    });
  });
});
