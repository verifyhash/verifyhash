"use strict";

// test/cli.agent-hook.test.js — T-73.4 acceptance: `vh-agent-hook`, zero-config Claude Code
// SessionEnd sealing over the shipped FREE `vh agent seal` path.
//
// What this suite PROVES (each acceptance bullet as an honest test, against the REAL binary):
//   (1) THE BIN + THE HAPPY PATH: package.json maps `vh-agent-hook` -> cli/agent-hook.js (shebanged,
//       executable); spawning it with a fixture SessionEnd hook event on stdin + the COMMITTED
//       Claude Code fixture transcript (REAL shapes: user/assistant message lines with tool_use +
//       tool_result blocks AND non-message lines) exits 0, writes
//       <cwd>/.vh-sessions/<session_id>.vhagent.json, and prints the `vh agent verify` one-liner on
//       stderr. The written packet then ACCEPTS under the real `vh agent verify` (exit 0), and a
//       one-byte payload flip REJECTS (exit 3) NAMING the seq.
//   (2) DRIFT TOLERANCE: unknown line kinds / unknown content blocks / malformed lines are
//       skipped-and-counted, never fatal — appending junk lines to the transcript yields the
//       BYTE-IDENTICAL packet. Malformed stdin, missing transcript_path, an unreadable
//       transcript_path, and an empty transcript each yield their DISTINCT named non-zero exit and
//       write NOTHING (out dir not even created).
//   (3) DETERMINISTIC OVERWRITE: a repeat run for the same session_id rewrites the packet to
//       byte-identical content, even over a corrupted file.
//   (4) POSTURE: VH_HOOK_OUT overrides the out dir; a traversal-shaped session_id is refused by
//       name; the hook's source re-implements no crypto (no ethers/js-sha3/crypto require — the
//       seal is the SHIPPED cli/agent.js path) and touches no network/child-process module; and
//       docs/AGENT-HOOK.md carries BOTH pinned boundary lines + the redact note VERBATIM from the
//       code's exported constants (anti-drift), plus the 3-line install pointing at SessionEnd.
//
// OFFLINE by construction (child processes get no network surface to call — the hook has none).
// Every artifact lands in throwaway temp dirs cleaned pass-or-fail; the repo working tree is
// asserted untouched.

const { expect } = require("chai");
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const hook = require("../cli/agent-hook");
const agent = require("../cli/agent");

const REPO = path.resolve(__dirname, "..");
const NODE = process.execPath;
const HOOK_BIN = path.join(REPO, "cli", "agent-hook.js");
const VH_BIN = path.join(REPO, "cli", "vh.js");
const TRANSCRIPT = path.join(REPO, "examples", "agent-session", "transcript.claude-code.jsonl");
const DOC = path.join(REPO, "docs", "AGENT-HOOK.md");
const SESSION_ID = "9f6c2b4e-7a31-4c8e-b5d2-0f1e3a7c9d24";

// Base env for every child: a stray VH_HOOK_OUT in the CI environment must not steer the default.
const { VH_HOOK_OUT: _dropped, ...BASE_ENV } = process.env;

/** Spawn the REAL binary with `stdinText` piped in, from `cwd`, with optional extra env. */
function runHook(stdinText, { cwd, env } = {}) {
  return spawnSync(NODE, [HOOK_BIN], {
    input: stdinText,
    cwd: cwd || REPO,
    env: { ...BASE_ENV, ...(env || {}) },
    encoding: "utf8",
  });
}

/** Run the real `vh agent verify` against a packet path. */
function vhAgentVerify(packetPath) {
  return spawnSync(NODE, [VH_BIN, "agent", "verify", packetPath], {
    cwd: REPO,
    env: process.env,
    encoding: "utf8",
  });
}

function hookEvent(overrides = {}) {
  return JSON.stringify({
    session_id: SESSION_ID,
    transcript_path: TRANSCRIPT,
    cwd: overrides.cwd,
    hook_event_name: "SessionEnd",
    reason: "exit",
    ...overrides,
  });
}

describe("cli/agent-hook T-73.4: `vh-agent-hook` — zero-config SessionEnd sealing", function () {
  this.timeout(60000);

  let tmpDirs;
  let repoCwdBefore;
  beforeEach(function () {
    tmpDirs = [];
    repoCwdBefore = fs.readdirSync(REPO).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing leaked into the repo working tree.
    expect(fs.readdirSync(REPO).sort()).to.deep.equal(repoCwdBefore);
  });
  function tmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-agent-hook-"));
    tmpDirs.push(d);
    return d;
  }
  function packetPathIn(dir, sid = SESSION_ID) {
    return path.join(dir, ".vh-sessions", `${sid}.vhagent.json`);
  }

  // -------------------------------------------------------------------------------------------------
  // (1) bin map + the committed fixture are what the acceptance says they are.
  // -------------------------------------------------------------------------------------------------

  describe("the bin + the committed fixture", function () {
    it("package.json maps bin `vh-agent-hook` -> cli/agent-hook.js, shebanged and executable", function () {
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
      expect(pkg.bin["vh-agent-hook"]).to.equal("cli/agent-hook.js");
      expect(fs.existsSync(HOOK_BIN)).to.equal(true);
      const firstLine = fs.readFileSync(HOOK_BIN, "utf8").split("\n")[0];
      expect(firstLine).to.equal("#!/usr/bin/env node");
      // committed executable (mode +x), like the vh bin (npm preserves the bit for `bin` targets)
      expect(fs.statSync(HOOK_BIN).mode & 0o100, "cli/agent-hook.js must be committed executable").to.not.equal(0);
    });

    it("the committed transcript carries REAL Claude Code shapes: tool_use + tool_result blocks and >=1 non-message line", function () {
      const lines = fs
        .readFileSync(TRANSCRIPT, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l));
      const kinds = lines.map((l) => l.type);
      expect(kinds).to.include("user");
      expect(kinds).to.include("assistant");
      // >=1 NON-message line kind (summary / file-history-snapshot)
      expect(kinds.filter((k) => k !== "user" && k !== "assistant").length).to.be.at.least(1);
      const blocks = [];
      for (const l of lines) {
        if ((l.type === "user" || l.type === "assistant") && Array.isArray(l.message?.content)) {
          for (const b of l.message.content) blocks.push(b.type);
        }
      }
      expect(blocks).to.include("tool_use");
      expect(blocks).to.include("tool_result");
      // Claude Code message-line envelope fields are genuinely present (real shapes, not a toy)
      const msgLine = lines.find((l) => l.type === "assistant");
      for (const k of ["uuid", "timestamp", "sessionId", "cwd", "version"]) {
        expect(msgLine, `assistant line must carry ${k}`).to.have.property(k);
      }
    });
  });

  // -------------------------------------------------------------------------------------------------
  // (2) happy path: seal -> packet written -> real `vh agent verify` ACCEPTS; one-byte flip REJECTS.
  // -------------------------------------------------------------------------------------------------

  describe("seal -> verify ACCEPT -> tamper REJECT", function () {
    it("exits 0, writes <cwd>/.vh-sessions/<session_id>.vhagent.json, prints the verify one-liner on stderr", function () {
      const dir = tmp();
      const r = runHook(hookEvent({ cwd: dir }), { cwd: tmp() /* hook process cwd is NOT the event cwd */ });
      expect(r.status, r.stderr).to.equal(hook.EXIT.OK);
      const packet = packetPathIn(dir);
      expect(fs.existsSync(packet), "the packet must land under the EVENT cwd, not the process cwd").to.equal(true);
      expect(r.stderr).to.include(`vh agent verify ${packet}`);
      expect(r.stdout, "a SessionEnd hook must not pollute stdout").to.equal("");
      // the stderr receipt counts the skipped non-message lines + unmapped (thinking) block
      expect(r.stderr).to.match(/skipped 2 non-message line\(s\), 1 unmapped block\(s\), 0 malformed line\(s\)/);
      // stderr also carries the pinned boundary lines
      expect(r.stderr).to.include(hook.BOUNDARY_INTACT_LINE);
      expect(r.stderr).to.include(hook.BOUNDARY_TIMESTAMP_LINE);

      // the packet is a REAL shipped-schema packet with all four mapped event types
      const obj = JSON.parse(fs.readFileSync(packet, "utf8"));
      expect(obj.kind).to.equal(agent.PACKET_KIND);
      const types = obj.events.map((e) => e.type);
      for (const t of ["prompt", "completion", "tool_call", "tool_result"]) expect(types).to.include(t);
      expect(obj.counts.events).to.equal(8);
      expect(obj.counts.redacted).to.equal(0);
      // ts is carried verbatim from the transcript (self-asserted), seq contiguous from 0
      obj.events.forEach((e, i) => expect(e.seq).to.equal(i));
      expect(obj.events[0].ts).to.equal("2026-07-01T09:12:03.481Z");

      // the REAL `vh agent verify` ACCEPTS with exit 0
      const v = vhAgentVerify(packet);
      expect(v.status, v.stderr + v.stdout).to.equal(0);
      expect(v.stdout).to.include("ACCEPTED");
    });

    it("a one-byte payload flip REJECTS under `vh agent verify` with exit 3, NAMING the seq", function () {
      const dir = tmp();
      expect(runHook(hookEvent({ cwd: dir })).status).to.equal(hook.EXIT.OK);
      const packet = packetPathIn(dir);
      const obj = JSON.parse(fs.readFileSync(packet, "utf8"));
      // flip ONE byte in one full payload (seq 3: the first tool_result)
      const seq = 3;
      const p = obj.events[seq].payload;
      obj.events[seq].payload = (p[0] === "X" ? "Y" : "X") + p.slice(1);
      fs.writeFileSync(packet, JSON.stringify(obj) + "\n");
      const v = vhAgentVerify(packet);
      expect(v.status).to.equal(3);
      expect(v.stdout).to.include("REJECTED");
      expect(v.stdout).to.include(`seq ${seq}`);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // (3) drift tolerance + the DISTINCT named failure exits (each writing NOTHING).
  // -------------------------------------------------------------------------------------------------

  describe("drift tolerance", function () {
    it("appending unknown-kind and malformed lines to the transcript yields the BYTE-IDENTICAL packet", function () {
      const clean = tmp();
      expect(runHook(hookEvent({ cwd: clean })).status).to.equal(hook.EXIT.OK);
      const cleanBytes = fs.readFileSync(packetPathIn(clean), "utf8");

      const drifted = tmp();
      const driftedTranscript = path.join(drifted, "t.jsonl");
      fs.writeFileSync(
        driftedTranscript,
        fs.readFileSync(TRANSCRIPT, "utf8") +
          '{"type":"a-future-line-kind-vh-never-saw","data":{"x":1}}\n' +
          '{"type":"queued-command","prompt":"later"}\n' +
          "this line is not JSON at all — a crash-truncated tail{{{\n"
      );
      const r = runHook(hookEvent({ cwd: drifted, transcript_path: driftedTranscript }));
      expect(r.status, "unknown/malformed lines must be skipped-and-counted, never fatal").to.equal(hook.EXIT.OK);
      expect(r.stderr).to.match(/skipped 4 non-message line\(s\), 1 unmapped block\(s\), 1 malformed line\(s\)/);
      expect(fs.readFileSync(packetPathIn(drifted), "utf8")).to.equal(cleanBytes);
    });
  });

  describe("DISTINCT named non-zero exits, each writing NOTHING", function () {
    function expectNothingWritten(dir) {
      expect(fs.existsSync(path.join(dir, ".vh-sessions")), "no out dir may be created on failure").to.equal(false);
      expect(fs.readdirSync(dir), "the failure path must write NOTHING").to.deep.equal([]);
    }

    it("malformed stdin -> BAD_HOOK_EVENT (2), nothing written", function () {
      const dir = tmp();
      const r = runHook("this is not JSON {{{", { cwd: dir });
      expect(r.status).to.equal(hook.EXIT.BAD_HOOK_EVENT);
      expect(r.stderr).to.include("BAD_HOOK_EVENT");
      expectNothingWritten(dir);
    });

    it("a non-object hook event -> BAD_HOOK_EVENT (2), nothing written", function () {
      const dir = tmp();
      const r = runHook('["an","array"]', { cwd: dir });
      expect(r.status).to.equal(hook.EXIT.BAD_HOOK_EVENT);
      expect(r.stderr).to.include("BAD_HOOK_EVENT");
      expectNothingWritten(dir);
    });

    it("a traversal-shaped session_id -> BAD_HOOK_EVENT (2), nothing written anywhere", function () {
      const dir = tmp();
      const r = runHook(hookEvent({ cwd: dir, session_id: "../escape" }), { cwd: dir });
      expect(r.status).to.equal(hook.EXIT.BAD_HOOK_EVENT);
      expect(r.stderr).to.include("BAD_HOOK_EVENT");
      expectNothingWritten(dir);
    });

    it("missing transcript_path -> TRANSCRIPT_UNREADABLE (3), DISTINCT from malformed stdin, nothing written", function () {
      const dir = tmp();
      const r = runHook(JSON.stringify({ session_id: SESSION_ID, cwd: dir, hook_event_name: "SessionEnd" }), { cwd: dir });
      expect(r.status).to.equal(hook.EXIT.TRANSCRIPT_UNREADABLE);
      expect(r.status).to.not.equal(hook.EXIT.BAD_HOOK_EVENT);
      expect(r.stderr).to.include("TRANSCRIPT_UNREADABLE");
      expectNothingWritten(dir);
    });

    it("an unreadable (nonexistent) transcript_path -> TRANSCRIPT_UNREADABLE (3), nothing written", function () {
      const dir = tmp();
      const r = runHook(hookEvent({ cwd: dir, transcript_path: path.join(dir, "no-such-transcript.jsonl") }));
      expect(r.status).to.equal(hook.EXIT.TRANSCRIPT_UNREADABLE);
      expect(r.stderr).to.include("TRANSCRIPT_UNREADABLE");
      expectNothingWritten(dir);
    });

    it("an empty transcript -> EMPTY_TRANSCRIPT (4), DISTINCT from both, nothing written", function () {
      const dir = tmp();
      const empty = path.join(dir, "empty.jsonl");
      fs.writeFileSync(empty, "");
      const r = runHook(hookEvent({ cwd: dir, transcript_path: empty }));
      expect(r.status).to.equal(hook.EXIT.EMPTY_TRANSCRIPT);
      expect(r.stderr).to.include("EMPTY_TRANSCRIPT");
      expect(new Set([hook.EXIT.BAD_HOOK_EVENT, hook.EXIT.TRANSCRIPT_UNREADABLE, hook.EXIT.EMPTY_TRANSCRIPT]).size, "the three named exits are DISTINCT").to.equal(3);
      fs.rmSync(empty);
      expectNothingWritten(dir);
    });

    it("a transcript with ONLY unmappable lines -> EMPTY_TRANSCRIPT (4), skips counted, nothing written", function () {
      const dir = tmp();
      const t = path.join(dir, "only-junk.jsonl");
      fs.writeFileSync(t, '{"type":"summary","summary":"nothing sealed","leafUuid":"x"}\nnot json\n');
      const r = runHook(hookEvent({ cwd: dir, transcript_path: t }));
      expect(r.status).to.equal(hook.EXIT.EMPTY_TRANSCRIPT);
      expect(r.stderr).to.match(/skipped 1 non-message line\(s\), 0 unmapped block\(s\), 1 malformed line\(s\)/);
      fs.rmSync(t);
      expectNothingWritten(dir);
    });
  });

  describe("WRITE_FAILED — the write-contract failure a pipeline depends on (pinned)", function () {
    it("VH_HOOK_OUT pointing at an EXISTING FILE -> WRITE_FAILED (6); the packet is never written and the file is untouched", function () {
      const dir = tmp();
      const notADir = path.join(dir, "not-a-dir");
      fs.writeFileSync(notADir, "i am a file, not a directory\n");
      // VH_HOOK_OUT resolves to an existing regular file -> mkdirSync throws -> WRITE_FAILED, DISTINCT
      // from the seal/read/event failures so a pipeline can branch on it.
      const r = runHook(hookEvent({ cwd: dir }), { env: { VH_HOOK_OUT: notADir } });
      expect(r.status, r.stderr).to.equal(hook.EXIT.WRITE_FAILED);
      expect(r.stderr).to.include("WRITE_FAILED");
      expect(r.status).to.not.equal(hook.EXIT.OK);
      // the pre-existing file is untouched and no packet appeared beneath it
      expect(fs.readFileSync(notADir, "utf8")).to.equal("i am a file, not a directory\n");
      expect(fs.existsSync(path.join(notADir, `${SESSION_ID}.vhagent.json`))).to.equal(false);
      // and the default dir was NOT created as a fallback
      expect(fs.existsSync(path.join(dir, ".vh-sessions"))).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // (4) deterministic overwrite + VH_HOOK_OUT.
  // -------------------------------------------------------------------------------------------------

  describe("deterministic overwrite + VH_HOOK_OUT", function () {
    it("a repeat run for the same session_id deterministically overwrites (even a corrupted packet)", function () {
      const dir = tmp();
      expect(runHook(hookEvent({ cwd: dir })).status).to.equal(hook.EXIT.OK);
      const packet = packetPathIn(dir);
      const first = fs.readFileSync(packet, "utf8");
      // corrupt the packet on disk, then re-run: the hook restores the canonical bytes
      fs.writeFileSync(packet, "corrupted garbage\n");
      expect(runHook(hookEvent({ cwd: dir })).status).to.equal(hook.EXIT.OK);
      expect(fs.readFileSync(packet, "utf8")).to.equal(first);
    });

    it("VH_HOOK_OUT (relative) resolves against the EVENT cwd; (absolute) is used as-is", function () {
      const dir = tmp();
      const r1 = runHook(hookEvent({ cwd: dir }), { env: { VH_HOOK_OUT: "sealed-sessions" } });
      expect(r1.status, r1.stderr).to.equal(hook.EXIT.OK);
      const rel = path.join(dir, "sealed-sessions", `${SESSION_ID}.vhagent.json`);
      expect(fs.existsSync(rel)).to.equal(true);
      expect(fs.existsSync(path.join(dir, ".vh-sessions")), "the default dir must NOT also appear").to.equal(false);

      const absDir = path.join(tmp(), "abs-out");
      const r2 = runHook(hookEvent({ cwd: dir }), { env: { VH_HOOK_OUT: absDir } });
      expect(r2.status, r2.stderr).to.equal(hook.EXIT.OK);
      const abs = path.join(absDir, `${SESSION_ID}.vhagent.json`);
      expect(fs.existsSync(abs)).to.equal(true);
      // and both spellings sealed the identical bytes
      expect(fs.readFileSync(abs, "utf8")).to.equal(fs.readFileSync(rel, "utf8"));
    });
  });

  // -------------------------------------------------------------------------------------------------
  // (4b) working-tree hygiene: the zero-config default dir self-ignores, so a routine `git add -A`
  //      can NEVER commit a secret-bearing packet (packets embed VERBATIM prompts/code/tool output).
  // -------------------------------------------------------------------------------------------------

  describe("working-tree hygiene (the default dir self-ignores)", function () {
    it("the first seal drops a self-ignoring .gitignore (containing `*`) in .vh-sessions/", function () {
      const dir = tmp();
      expect(runHook(hookEvent({ cwd: dir })).status).to.equal(hook.EXIT.OK);
      const gi = path.join(dir, ".vh-sessions", ".gitignore");
      expect(fs.existsSync(gi), "the default out dir must carry a self-ignoring .gitignore").to.equal(true);
      expect(fs.readFileSync(gi, "utf8").split(/\r?\n/)).to.include("*");
    });

    it("a real `git add -A` in the event cwd stages ordinary files but NEVER the secret-bearing packet", function () {
      const gitOk = spawnSync("git", ["--version"], { encoding: "utf8" });
      if (gitOk.error || gitOk.status !== 0) return this.skip(); // no git in this environment
      const dir = tmp();
      expect(spawnSync("git", ["init", "-q", dir], { encoding: "utf8" }).status).to.equal(0);
      fs.writeFileSync(path.join(dir, "tracked.txt"), "hello\n"); // an ordinary file alongside
      expect(runHook(hookEvent({ cwd: dir })).status).to.equal(hook.EXIT.OK);
      // the packet really does embed the fixture's verbatim source/prompt (the thing we must not leak)
      expect(fs.readFileSync(packetPathIn(dir), "utf8")).to.include("date formatting test");

      expect(spawnSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8" }).status).to.equal(0);
      const staged = spawnSync("git", ["-C", dir, "diff", "--cached", "--name-only"], { encoding: "utf8" }).stdout;
      expect(staged, "`git add -A` must still stage ordinary files").to.include("tracked.txt");
      expect(staged, "but must NEVER stage a .vh-sessions packet").to.not.match(/\.vh-sessions/);
      const status = spawnSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }).stdout;
      expect(status, "`git status` stays clean of .vh-sessions").to.not.include(".vh-sessions");
    });

    it("a custom VH_HOOK_OUT is the operator's to manage: NO self-ignore is written there", function () {
      const dir = tmp();
      expect(runHook(hookEvent({ cwd: dir }), { env: { VH_HOOK_OUT: "custom-out" } }).status).to.equal(hook.EXIT.OK);
      expect(fs.existsSync(path.join(dir, "custom-out", `${SESSION_ID}.vhagent.json`))).to.equal(true);
      expect(fs.existsSync(path.join(dir, "custom-out", ".gitignore")), "self-ignore is default-dir-only").to.equal(false);
    });

    it("does not clobber an operator's pre-existing .gitignore in the default dir", function () {
      const dir = tmp();
      const vhDir = path.join(dir, ".vh-sessions");
      fs.mkdirSync(vhDir, { recursive: true });
      fs.writeFileSync(path.join(vhDir, ".gitignore"), "# mine — keep\n");
      expect(runHook(hookEvent({ cwd: dir })).status).to.equal(hook.EXIT.OK);
      expect(fs.readFileSync(path.join(vhDir, ".gitignore"), "utf8")).to.equal("# mine — keep\n");
    });
  });

  // -------------------------------------------------------------------------------------------------
  // (4c) run-by-hand ergonomics: --help, the interactive-stdin hint, and the stdin idle timeout — an
  //      operator poking at the install must get guidance, never a silent hang.
  // -------------------------------------------------------------------------------------------------

  describe("run-by-hand ergonomics", function () {
    it("`--help` prints usage on stderr, exits OK, keeps stdout clean, and writes nothing", function () {
      const dir = tmp();
      const r = spawnSync(NODE, [HOOK_BIN, "--help"], { cwd: dir, env: BASE_ENV, encoding: "utf8" });
      expect(r.status).to.equal(hook.EXIT.OK);
      expect(r.stdout, "a hook keeps stdout clean, even for --help").to.equal("");
      expect(r.stderr).to.include("vh-agent-hook");
      expect(r.stderr).to.include("SessionEnd");
      expect(r.stderr).to.include("VH_HOOK_OUT");
      expect(fs.readdirSync(dir), "--help writes nothing to the filesystem").to.deep.equal([]);
    });

    it("interactive stdin (a TTY, no event piped) -> BAD_HOOK_EVENT with a helpful hint, not a hang", async function () {
      let err = "";
      const code = await hook.runHook({ argv: [], stdinIsTTY: true, env: {}, writeErr: (s) => { err += s; } });
      expect(code).to.equal(hook.EXIT.BAD_HOOK_EVENT);
      expect(err).to.include("BAD_HOOK_EVENT");
      expect(err.toLowerCase()).to.include("terminal");
      expect(err).to.include("--help");
    });

    it("a stdin that never delivers an event times out -> BAD_HOOK_EVENT (bounded, no infinite hang), nothing written", function (done) {
      const dir = tmp();
      const child = spawn(NODE, [HOOK_BIN], {
        cwd: dir,
        env: { ...BASE_ENV, VH_HOOK_STDIN_TIMEOUT_MS: "250" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.stdin.on("error", () => {}); // ignore EPIPE if the child tears down its end first
      child.on("close", (code) => {
        try {
          expect(code).to.equal(hook.EXIT.BAD_HOOK_EVENT);
          expect(err.toLowerCase()).to.include("stdin");
          expect(fs.existsSync(path.join(dir, ".vh-sessions")), "a timed-out read writes nothing").to.equal(false);
          done();
        } catch (e) {
          done(e);
        }
      });
      // deliberately never write to nor end child.stdin — the idle timeout must fire.
    });
  });

  // -------------------------------------------------------------------------------------------------
  // (5) posture: thin mapper over the SHIPPED seal — no re-implemented crypto, no key/license/network.
  // -------------------------------------------------------------------------------------------------

  describe("posture (statically pinned)", function () {
    const src = fs.readFileSync(HOOK_BIN, "utf8");

    it("requires ONLY Node core fs/path + the shipped cli/agent.js seal path — no crypto, no network, no child_process", function () {
      const required = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      expect(required.sort()).to.deep.equal(["./agent", "fs", "path"].sort());
      // belt-and-braces: none of the forbidden surfaces appear at all
      for (const banned of ["ethers", "js-sha3", '"crypto"', "'crypto'", "http", "https", '"net"', "'net'", "child_process", "keccak"]) {
        expect(src, `cli/agent-hook.js must not reference ${banned}`).to.not.include(banned);
      }
    });

    it("uses the SHIPPED free UNSIGNED seal: buildPacket/serializePacket from cli/agent.js, never the paid --sign/license/key surface", function () {
      expect(src).to.include("buildPacket");
      expect(src).to.include("serializePacket");
      for (const banned of [
        "gateAgentPaid",
        "coreLicense",
        "readLicense",
        "verifyLicense",
        "keyEnv",
        "keyFile",
        "signAttestation",
        "loadSigningWallet",
        "headAttestation",
        "--sign",
      ]) {
        expect(src, `the hook must not touch the paid surface (${banned})`).to.not.include(banned);
      }
    });

    it("the exported named-exit table is total and the codes are distinct", function () {
      const codes = Object.values(hook.EXIT);
      expect(new Set(codes).size).to.equal(codes.length);
      expect(hook.EXIT.OK).to.equal(0);
      for (const [name, code] of Object.entries(hook.EXIT)) {
        if (name !== "OK") expect(code, `${name} must be non-zero`).to.be.greaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------------------------------
  // (6) docs/AGENT-HOOK.md — the 3-line install + BOTH pinned boundary lines VERBATIM.
  // -------------------------------------------------------------------------------------------------

  describe("docs/AGENT-HOOK.md (anti-drift)", function () {
    const doc = fs.readFileSync(DOC, "utf8");

    it("carries BOTH pinned boundary lines + the redact note VERBATIM from the code", function () {
      expect(hook.BOUNDARY_INTACT_LINE).to.equal(
        "The seal proves the log is INTACT since seal, NOT that the agent behaved well."
      );
      expect(hook.BOUNDARY_TIMESTAMP_LINE).to.equal("NOT a trusted timestamp — ts fields are self-asserted.");
      expect(doc).to.include(hook.BOUNDARY_INTACT_LINE);
      expect(doc).to.include(hook.BOUNDARY_TIMESTAMP_LINE);
      // the redact-before-sharing note (payloads embed verbatim)
      expect(doc).to.include("vh agent redact");
      expect(doc.toLowerCase()).to.include("payloads embed verbatim");
    });

    it("documents the 3-line install (SessionEnd hook registration), the default out dir, and VH_HOOK_OUT", function () {
      expect(doc).to.include("SessionEnd");
      expect(doc).to.include("vh-agent-hook");
      expect(doc).to.include(".vh-sessions/");
      expect(doc).to.include("VH_HOOK_OUT");
      expect(doc).to.include("3-line install");
      expect(doc).to.include("npm install -g verifyhash");
      // and the named exit contract is documented for every named exit
      for (const name of Object.keys(hook.EXIT)) expect(doc, `doc must name exit ${name}`).to.include(name);
    });
  });
});
