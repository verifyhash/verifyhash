"use strict";

// test/verifier.action.test.js — the ANTI-ROT acceptance suite for the shipped composite GitHub Action
// that wraps the standalone offline verify-vh into a SINGLE adoption line (T-55.1).
//
// WHY THIS TEST EXISTS
//   verifyhash ships a marketplace-shaped composite Action at verifier/action/action.yml so a consumer
//   adopts the merge gate in ONE line — `uses: <owner>/<repo>/verifier/action@<ref>` with `vendor:` and
//   (`manifest:` | `artifacts:`) inputs. An Action whose gate DRIFTS from the verifier's real behaviour
//   is worse than none: it gives a partner false confidence. So this suite does NOT re-implement the
//   gate. It:
//     * PARSES action.yml and asserts it is a VALID composite action (runs.using: "composite", declared
//       inputs.vendor + inputs.manifest/inputs.artifacts WITH descriptions, ordered runs.steps);
//     * EXTRACTS the gate `run:` block from the shipped YAML and EXECUTES it VERBATIM (substituting the
//       declared inputs as the env vars the step maps them to) over the COMMITTED sample sealed packet
//       (challenge/sample-packet/ + challenge/seal.vhevidence.json) — asserting exit 0;
//     * runs the SAME shipped block over a ONE-BYTE-TAMPERED copy of that packet — asserting exit 3;
//     * asserts the gate's verifier-invocation command is BYTE-IDENTICAL to the one in
//       verifier/ci/verify-vh.generic.sh (the single source of truth — no drift).
//
//   Mostly no keys, no funds, no network: the committed sample packet is an UNSIGNED evidence seal, so
//   the gate runs WITHOUT a vendor (tamper-evidence only). Two regression suites go further to LOCK two
//   posture properties the review panel flagged as make-or-break for an ADOPTION surface:
//     * PATH RESOLUTION (VerifierIndependence): a published composite action's `run:` steps execute with
//       the CONSUMER's $GITHUB_WORKSPACE as cwd, NOT the action's own checkout. The action must locate
//       its OWN bundled verifier tree via ${{ github.action_path }}, or the advertised one-line adoption
//       fails ("Cannot find module") in any consumer repo that has no verifier/ tree of its own. We
//       SIMULATE a consumer workspace (a temp cwd with NO verifier/) and prove the gate still runs.
//     * SIGNED + NO-VENDOR over-trust (TrustIntegrity): with `vendor:` omitted, a SIGNED artifact is
//       accepted on its OWN self-claimed signer — so an attacker who re-signs a tampered release with
//       their own key passes a vendor-less gate. We build a real signed packet under an EPHEMERAL
//       ATTACKER key and PIN that behavior (exit 0 + the in-band "no --vendor pin" note), and prove a
//       pin to the legitimate producer would REJECT it (exit 3). The dangerous default is now covered,
//       so any drift toward looking-verified-without-a-pin is caught.
//   Ephemeral keys are Wallet.createRandom() (TEST-ONLY — never a real key/real funds). All fixtures land
//   under throwaway temp dirs cleaned in afterEach; the shipped files are read-only.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const yaml = require("js-yaml");
const { Wallet } = require("ethers");

// The REAL producer signing path (exactly what `vh evidence seal --sign` runs) — used ONLY to build a
// genuine signed packet under an ephemeral ATTACKER key for the over-trust regression below.
const evidence = require("../cli/evidence");

const REPO = path.resolve(__dirname, "..");
const ACTION_YML = path.join(REPO, "verifier", "action", "action.yml");
const ACTION_README = path.join(REPO, "verifier", "action", "README.md");
const GENERIC_SH = path.join(REPO, "verifier", "ci", "verify-vh.generic.sh");
const VERIFY_VH = path.join(REPO, "verifier", "verify-vh.js");
// The action's own directory (verifier/action/). A published composite action resolves its bundled
// verifier tree via ${{ github.action_path }} == this directory; ${{ github.action_path }}/.. == verifier/.
const ACTION_PATH = path.join(REPO, "verifier", "action");
// What the action.yml's `VERIFY_VH: ${{ format('{0}/../verify-vh.js', github.action_path) }}` resolves to.
const ACTION_RESOLVED_VERIFY_VH = path.join(ACTION_PATH, "..", "verify-vh.js");

// License window for the signed-packet fixture (dated with an injected `now` so it is deterministic).
const ISSUED = "2026-06-01T00:00:00.000Z";
const EXPIRES = "2027-06-01T00:00:00.000Z";
const NOW = new Date("2026-06-24T00:00:00.000Z");

// The committed sample sealed packet the buyer-facing 60-second challenge ships (an UNSIGNED evidence
// seal over a 3-file packet). This is the real fixture the acceptance criteria name.
const SAMPLE_SEAL = path.join(REPO, "challenge", "seal.vhevidence.json");
const SAMPLE_PACKET = path.join(REPO, "challenge", "sample-packet");

describe("verify-vh composite GitHub Action (T-55.1)", function () {
  // verify-vh is fast, but give the suite headroom for the bash spawns.
  this.timeout(20000);

  let tmpDirs;
  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-action-"));
    tmpDirs.push(d);
    return d;
  }

  // Parse the shipped action.yml once.
  function loadAction() {
    const src = fs.readFileSync(ACTION_YML, "utf8");
    return { src, doc: yaml.load(src) };
  }

  // The gate step is the LAST composite step; pull its `run:` body. js-yaml already dedents block
  // scalars for us, so `runs.steps[last].run` is the gate script the Action executes verbatim.
  function gateStep(doc) {
    const steps = doc.runs.steps;
    const step = steps[steps.length - 1];
    expect(step, "the gate must be the last composite step").to.be.an("object");
    expect(step.run, "the gate step must carry a `run:` block").to.be.a("string");
    return step;
  }

  // Run a bash SCRIPT STRING with env overrides; capture exit + stdio (never throw on non-zero). `cwd`
  // defaults to REPO; pass a fresh temp dir to SIMULATE a consumer workspace (no verifier/ in it) and so
  // prove the gate resolves its bundled verify-vh through ${{ github.action_path }}, not the cwd.
  function runScript(script, env, cwd) {
    const dir = mkTmp();
    const file = path.join(dir, "gate.sh");
    fs.writeFileSync(file, script);
    try {
      const stdout = execFileSync("bash", [file], {
        cwd: cwd || REPO,
        env: { ...process.env, ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "" };
    } catch (e) {
      return {
        code: typeof e.status === "number" ? e.status : 1,
        stdout: e.stdout ? e.stdout.toString() : "",
        stderr: e.stderr ? e.stderr.toString() : "",
      };
    }
  }

  // Copy the committed sample sealed packet (seal + its packet dir as a sibling) into a fresh temp dir,
  // so a tamper test never mutates the committed fixture. Returns the seal path and packet dir.
  function copySamplePacket() {
    const root = mkTmp();
    const sealPath = path.join(root, "seal.vhevidence.json");
    const packetDir = path.join(root, "sample-packet");
    fs.mkdirSync(packetDir);
    fs.copyFileSync(SAMPLE_SEAL, sealPath);
    for (const f of fs.readdirSync(SAMPLE_PACKET)) {
      fs.copyFileSync(path.join(SAMPLE_PACKET, f), path.join(packetDir, f));
    }
    return { sealPath, packetDir };
  }

  // Map the Action's declared inputs to the env vars its gate step binds them to (the `env:` block on
  // the step). Executing the gate `run:` with this env == executing the Action with those inputs.
  function gateEnv({ vendor, manifest, artifacts, dir, verifyVh }) {
    return {
      VERIFY_VH: verifyVh || VERIFY_VH,
      VH_VENDOR: vendor || "",
      VH_MANIFEST: manifest || "",
      VH_ARTIFACTS: artifacts || "",
      VH_DIR: dir || "",
    };
  }

  // Capture a producer CLI run's stdio (the I/O shape evidence.runEvidenceSeal writes to).
  function cap() {
    let out = "";
    let err = "";
    return { io: { write: (s) => (out += s), writeErr: (s) => (err += s) }, out: () => out };
  }

  // Build a REAL, SIGNED evidence packet via the producer CLI (`evidence.runEvidenceSeal --sign`), signed
  // by a freshly-generated ATTACKER wallet — and minted under that SAME attacker key's own license, so it
  // is a fully self-consistent container that self-asserts the attacker as its signer (exactly the
  // re-signed-tampered-release an over-trusting gate must NOT silently accept). Returns the packet path,
  // its data dir, the attacker address, and a DIFFERENT (legitimate-producer) address to pin against.
  async function makeAttackerSignedPacket() {
    const root = mkTmp();
    const dir = path.join(root, "data");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "release.bin"), Buffer.from([1, 2, 3, 4, 5]));
    fs.writeFileSync(path.join(dir, "notes.txt"), "attacker's re-signed release");

    // The attacker controls BOTH the license issuer and the signing key (their own key, end to end).
    const attacker = Wallet.createRandom();
    const license = await evidence.buildLicense(
      {
        licenseId: "EV-ATTACKER-1",
        customer: "Attacker Inc",
        plan: "pro",
        entitlements: ["evidence_signed"],
        issuedAt: ISSUED,
        expiresAt: EXPIRES,
      },
      attacker
    );
    const licFile = path.join(root, "attacker.vhlicense.json");
    fs.writeFileSync(licFile, JSON.stringify(license) + "\n");

    const keyEnv = "VH_ACTION_ATTACKER_KEY_" + Math.random().toString(36).slice(2);
    process.env[keyEnv] = attacker.privateKey;
    const packetPath = path.join(root, "release.vhevidence.json");
    const c = cap();
    let code;
    try {
      code = await evidence.runEvidenceSeal(
        { dir, out: packetPath, sign: true, keyEnv, license: licFile, vendor: attacker.address, now: NOW },
        { ...c.io, now: NOW }
      );
    } finally {
      delete process.env[keyEnv];
    }
    expect(code, `producer evidence CLI failed: ${c.out()}`).to.equal(0);
    const container = JSON.parse(fs.readFileSync(packetPath, "utf8"));
    expect(container.kind, "the fixture must be a SIGNED evidence packet").to.equal("vh.evidence-seal-signed");

    // A legitimate-producer address the consumer SHOULD have pinned (distinct from the attacker's).
    const legit = Wallet.createRandom().address;
    expect(legit.toLowerCase()).to.not.equal(attacker.address.toLowerCase());

    return { packetPath, dir, attacker: attacker.address, legit };
  }

  // ===============================================================================================
  // 1. action.yml is a VALID, marketplace-shaped composite action.
  // ===============================================================================================
  describe("action.yml is a valid composite action", function () {
    it("is shipped and parses as YAML", function () {
      expect(fs.existsSync(ACTION_YML), "action.yml must be shipped at verifier/action/").to.equal(true);
      const { doc } = loadAction();
      expect(doc, "action.yml must parse to a mapping").to.be.an("object");
      expect(doc.name, "a marketplace action declares a name").to.be.a("string").and.not.empty;
      expect(doc.description, "a marketplace action declares a description").to.be.a("string").and.not.empty;
    });

    it('declares runs.using: "composite"', function () {
      const { doc } = loadAction();
      expect(doc.runs, "action.yml must declare a `runs` block").to.be.an("object");
      expect(doc.runs.using).to.equal("composite");
    });

    it("declares inputs.vendor + inputs.manifest + inputs.artifacts, each WITH a description", function () {
      const { doc } = loadAction();
      expect(doc.inputs, "action.yml must declare `inputs`").to.be.an("object");
      for (const name of ["vendor", "manifest", "artifacts"]) {
        expect(doc.inputs[name], `input ${name} must be declared`).to.be.an("object");
        expect(doc.inputs[name].description, `input ${name} must have a description`)
          .to.be.a("string").and.not.empty;
      }
      // The adoption line in the BACKLOG/README is `vendor:` + (`manifest:` | `artifacts:`): both ways
      // to name the artifact(s) must exist so the consumer can gate a whole release OR a path list.
      expect(doc.inputs.manifest.description.toLowerCase()).to.match(/manifest|release/);
      expect(doc.inputs.artifacts.description.toLowerCase()).to.match(/artifact/);
    });

    it("has an ordered runs.steps: setup-node, then install (js-sha3 only), then the gate", function () {
      const { doc } = loadAction();
      expect(doc.runs.steps, "runs.steps must be an array").to.be.an("array").with.length.greaterThan(1);

      // Setup Node precedes everything (the verifier needs node >= 18).
      const setup = doc.runs.steps.find((s) => typeof s.uses === "string" && /actions\/setup-node/.test(s.uses));
      expect(setup, "an actions/setup-node step is required").to.be.an("object");

      // An install step installs ONLY the standalone verifier tree (which declares js-sha3 alone) and
      // NEVER the producer stack.
      const install = doc.runs.steps.find(
        (s) => typeof s.run === "string" && /npm (ci|install)/.test(s.run)
      );
      expect(install, "an npm install step for the standalone verifier is required").to.be.an("object");
      // PATH RESOLUTION (VerifierIndependence): the install MUST run in the action's OWN bundled tree,
      // resolved via ${{ github.action_path }} — NOT a bare `verifier` that resolves against the
      // consumer's $GITHUB_WORKSPACE (where no verifier/ exists, so `npm ci` would fail outright).
      expect(install["working-directory"], "install must target the action's bundled tree via github.action_path")
        .to.contain("github.action_path");
      expect(install["working-directory"]).to.not.equal("verifier");
      expect(install.run).to.not.match(/\b(ethers|hardhat|@nomicfoundation)\b/);

      // The gate is the LAST step and runs node over the standalone verify-vh — never the producer stack.
      const gate = doc.runs.steps[doc.runs.steps.length - 1];
      expect(gate.run).to.contain("verify-vh.js");
      expect(gate.run).to.match(/node "\$VERIFY_VH"/);
      expect(gate.run).to.not.match(/\b(ethers|hardhat|@nomicfoundation)\b/);
      // PATH RESOLUTION (VerifierIndependence): the gate's VERIFY_VH default MUST be resolved against
      // ${{ github.action_path }} (the action's own tree) — NOT a workspace-relative literal like
      // `./verifier/verify-vh.js`, which would point at the consumer's repo and throw "Cannot find module".
      expect(gate.env, "the gate step must declare an env block").to.be.an("object");
      expect(gate.env.VERIFY_VH, "VERIFY_VH must be resolved via github.action_path")
        .to.contain("github.action_path");

      // Cross-check: the verifier package the install step installs truly declares ONLY js-sha3.
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "verifier", "package.json"), "utf8"));
      expect(Object.keys(pkg.dependencies || {})).to.deep.equal(["js-sha3"]);
    });

    it("every composite step that runs a script declares shell: bash (a real composite-action requirement)", function () {
      const { doc } = loadAction();
      for (const s of doc.runs.steps) {
        if (typeof s.run === "string") {
          expect(s.shell, "a composite `run:` step must declare a shell").to.equal("bash");
        }
      }
    });
  });

  // ===============================================================================================
  // 2. NO DRIFT — the gate's verifier-invocation is BYTE-IDENTICAL to verify-vh.generic.sh.
  // ===============================================================================================
  describe("the gate command is the single source of truth (no drift vs verify-vh.generic.sh)", function () {
    // The load-bearing "gate command" is the verifier invocation + exit-code passthrough block. It is
    // what actually decides pass/fail, so it is what must NOT drift between the shipped surfaces.
    const GATE_COMMAND = ['set +e', 'node "$VERIFY_VH" "$@"', "code=$?", "set -e"].join("\n");

    it("verify-vh.generic.sh contains the canonical gate command verbatim", function () {
      const generic = fs.readFileSync(GENERIC_SH, "utf8");
      expect(generic).to.contain(GATE_COMMAND);
    });

    it("the Action's gate `run:` block contains the SAME gate command, byte-identical", function () {
      const { doc } = loadAction();
      const gate = gateStep(doc);
      // js-yaml has already dedented the block scalar, so the run body holds the gate command verbatim.
      expect(gate.run).to.contain(GATE_COMMAND);

      // Stronger: the exact substring in the Action equals the exact substring in generic.sh (byte-wise).
      const generic = fs.readFileSync(GENERIC_SH, "utf8");
      const inAction = gate.run.slice(gate.run.indexOf(GATE_COMMAND), gate.run.indexOf(GATE_COMMAND) + GATE_COMMAND.length);
      const inGeneric = generic.slice(generic.indexOf(GATE_COMMAND), generic.indexOf(GATE_COMMAND) + GATE_COMMAND.length);
      expect(inAction).to.equal(inGeneric);
    });

    it("the Action and generic.sh build the verify-vh arg list identically (manifest|artifacts + dir)", function () {
      const { doc } = loadAction();
      const gate = gateStep(doc).run;
      const generic = fs.readFileSync(GENERIC_SH, "utf8");
      // The shared, drift-prone arg-assembly lines must appear verbatim in both.
      for (const line of [
        'set -- --manifest "$VH_MANIFEST"',
        "set -- $VH_ARTIFACTS",
        'set -- "$@" --dir "$VH_DIR"',
      ]) {
        expect(generic, `generic.sh must contain: ${line}`).to.contain(line);
        expect(gate, `action gate must contain: ${line}`).to.contain(line);
      }
    });
  });

  // ===============================================================================================
  // 3. EXECUTE the shipped gate `run:` block over the COMMITTED sample sealed packet.
  // ===============================================================================================
  describe("the shipped gate `run:` block, executed verbatim over the committed sample packet", function () {
    it("EXITS 0 on the clean committed packet (gate passes -> merge allowed)", function () {
      const { doc } = loadAction();
      const gate = gateStep(doc).run;
      const { sealPath, packetDir } = copySamplePacket();
      const r = runScript(
        gate,
        gateEnv({ artifacts: sealPath, dir: packetDir }) // no vendor: the sample seal is unsigned (tamper-evidence only).
      );
      expect(r.code, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).to.equal(0);
      expect(r.stdout).to.match(/OK — the artifact verifies\./);
    });

    it("EXITS 3 when ONE byte of the sealed packet is tampered (gate fails -> merge blocked)", function () {
      const { doc } = loadAction();
      const gate = gateStep(doc).run;
      const { sealPath, packetDir } = copySamplePacket();
      // Flip exactly one byte of a sealed file.
      const ledger = path.join(packetDir, "ledger.csv");
      const bytes = fs.readFileSync(ledger);
      bytes[0] = bytes[0] ^ 0x01; // toggle the lowest bit of the first byte — a single-byte change.
      fs.writeFileSync(ledger, bytes);

      const r = runScript(gate, gateEnv({ artifacts: sealPath, dir: packetDir }));
      expect(r.code, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).to.equal(3);
      // The verifier localizes the tamper to the exact file the byte changed in.
      expect(r.stdout).to.contain("ledger.csv");
      // And the wrapper announces the block on stderr (the same message-shape as generic.sh).
      expect(r.stderr).to.match(/FAILED \(exit 3\) — blocking the merge\./);
    });

    it("a vendor pin on the UNSIGNED sample packet REJECTS (exit 3) — never a silent pass", function () {
      // The marketplace `vendor:` input is real: pinning a signer on an unsigned artifact must fail
      // (there is no signature to recover a signer from), exactly as verify-vh's contract requires.
      const { doc } = loadAction();
      const gate = gateStep(doc).run;
      const { sealPath, packetDir } = copySamplePacket();
      const r = runScript(
        gate,
        gateEnv({ artifacts: sealPath, dir: packetDir, vendor: "0x0000000000000000000000000000000000000000" })
      );
      expect(r.code).to.equal(3);
    });

    it("neither manifest nor artifacts set is a usage error (exit 2) — never a silent pass", function () {
      const { doc } = loadAction();
      const gate = gateStep(doc).run;
      const r = runScript(gate, gateEnv({}));
      expect(r.code).to.equal(2);
      expect(r.stderr).to.match(/set 'manifest' or 'artifacts'/);
    });
  });

  // ===============================================================================================
  // 3b. PATH RESOLUTION (VerifierIndependence) — the one-line adoption only works if the action locates
  //     its OWN bundled verifier tree. A published composite action's `run:` steps execute with the
  //     CONSUMER's $GITHUB_WORKSPACE as cwd, NOT the action's checkout, so we run the gate from a fresh
  //     temp dir that has NO verifier/ in it (a simulated consumer repo) and prove it still verifies.
  // ===============================================================================================
  describe("the action locates its own bundled verifier from a consumer workspace (no vendoring)", function () {
    // Resolve VERIFY_VH exactly as the action.yml `${{ format('{0}/../verify-vh.js', github.action_path) }}`
    // expression does (github.action_path == verifier/action/), so this exercises the SAME path the action
    // hands its gate — but from a cwd with no verifier/ tree, the way a real consumer repo runs it.
    function consumerEnv(extra) {
      return gateEnv({ ...extra, verifyVh: ACTION_RESOLVED_VERIFY_VH });
    }

    it("the action-path-resolved VERIFY_VH points at the shipped verifier (sanity: it exists)", function () {
      expect(fs.existsSync(ACTION_RESOLVED_VERIFY_VH), "github.action_path/../verify-vh.js must be the bundled verifier")
        .to.equal(true);
      // It is the SAME file the rest of the suite drives directly — no second copy to drift.
      expect(fs.realpathSync(ACTION_RESOLVED_VERIFY_VH)).to.equal(fs.realpathSync(VERIFY_VH));
    });

    it("EXITS 0 on the clean packet when run from a consumer workspace with NO verifier/ in cwd", function () {
      const { doc } = loadAction();
      const gate = gateStep(doc).run;
      const { sealPath, packetDir } = copySamplePacket();
      // A fresh cwd that does NOT contain verifier/ — a workspace-relative ./verifier/verify-vh.js would
      // throw "Cannot find module" here; the github.action_path resolution must save it.
      const consumerCwd = mkTmp();
      expect(fs.existsSync(path.join(consumerCwd, "verifier"))).to.equal(false);

      const r = runScript(gate, consumerEnv({ artifacts: sealPath, dir: packetDir }), consumerCwd);
      expect(r.code, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).to.equal(0);
      expect(r.stdout).to.match(/OK — the artifact verifies\./);
    });

    it("a WORKSPACE-relative ./verifier/verify-vh.js would FAIL from that same cwd (the bug being prevented)", function () {
      // This pins WHY the github.action_path resolution is load-bearing: the OLD workspace-relative default
      // cannot find the verifier from a consumer cwd, so the green check would never even run. (We assert
      // the failure mode directly so a regression back to a relative default is caught by a green->red flip.)
      const { doc } = loadAction();
      const gate = gateStep(doc).run;
      const { sealPath, packetDir } = copySamplePacket();
      const consumerCwd = mkTmp();
      const r = runScript(
        gate,
        gateEnv({ artifacts: sealPath, dir: packetDir, verifyVh: "./verifier/verify-vh.js" }),
        consumerCwd
      );
      expect(r.code, "a workspace-relative verifier path must NOT silently pass").to.not.equal(0);
      expect(r.code).to.not.equal(3); // it is a module-not-found crash, not a verifier verdict.
    });
  });

  // ===============================================================================================
  // 3c. SIGNED + NO-VENDOR over-trust (TrustIntegrity) — LOCK the dangerous default so it cannot drift.
  //     With `vendor:` omitted, a SIGNED artifact is accepted on its OWN self-claimed signer. An attacker
  //     who re-signs a tampered release with their OWN key therefore passes a vendor-less gate. We pin the
  //     CURRENT behavior (exit 0 + the in-band "no --vendor pin" note) and prove a legitimate-producer pin
  //     would REJECT the same packet (exit 3) — so the posture is locked and any drift toward
  //     looking-verified-without-a-pin (or a relaxation of the pin's REJECT) is caught.
  // ===============================================================================================
  describe("signed artifact + NO vendor is accepted on its self-claimed signer (over-trust, pinned)", function () {
    it("EXITS 0 with NO vendor on an ATTACKER-signed packet — and prints the explicit no-pin note", async function () {
      const { doc } = loadAction();
      const gate = gateStep(doc).run;
      const { packetPath, dir } = await makeAttackerSignedPacket();

      // No vendor pinned: the gate accepts the attacker's self-signed packet (exit 0). This is verify-vh's
      // documented no-pin behavior — but on the ADOPTION surface it is the silent-over-trust footgun, so
      // we lock it here. The in-band note is the ONLY in-output signal that no signer was pinned.
      const r = runScript(gate, gateEnv({ artifacts: packetPath, dir }));
      expect(r.code, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).to.equal(0);
      expect(r.stdout).to.match(/OK — the artifact verifies\./);
      expect(
        r.stdout,
        "the no-pin note must be present so the log discloses no signer was pinned"
      ).to.contain("no --vendor pin");
    });

    it("EXITS 3 when the SAME packet is pinned to the legitimate producer (wrong_issuer)", async function () {
      const { doc } = loadAction();
      const gate = gateStep(doc).run;
      const { packetPath, dir, legit } = await makeAttackerSignedPacket();

      // Pinning the producer the consumer SHOULD trust rejects the attacker's re-signed packet — proving
      // the `vendor:` pin is exactly what turns "signed by whoever" into "signed by the producer I pinned".
      const r = runScript(gate, gateEnv({ artifacts: packetPath, dir, vendor: legit }));
      expect(r.code, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).to.equal(3);
      expect(r.stderr).to.match(/FAILED \(exit 3\) — blocking the merge\./);
    });

    it("EXITS 0 when pinned to the attacker's OWN key — pinning the wrong key does not save you", async function () {
      // A pin only protects you if it is the RIGHT key. Pinning the attacker's own (self-asserted) signer
      // re-passes — underscoring that `vendor:` must be obtained OUT-OF-BAND, not read off the packet.
      const { doc } = loadAction();
      const gate = gateStep(doc).run;
      const { packetPath, dir, attacker } = await makeAttackerSignedPacket();
      const r = runScript(gate, gateEnv({ artifacts: packetPath, dir, vendor: attacker }));
      expect(r.code, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).to.equal(0);
    });
  });

  // ===============================================================================================
  // 3d. The headline guarantee in action.yml + README is CONDITIONED on `vendor:` (honest posture).
  //     The bare "every sealed artifact matches the bytes the producer signed" claim is NOT backed by a
  //     vendor-less green check — so the shipped surfaces must condition that guarantee on `vendor:` and
  //     warn that gating a SIGNED artifact without it accepts an attacker-re-signed release.
  // ===============================================================================================
  describe("the headline is conditioned on `vendor:` + warns about signed/no-vendor over-trust", function () {
    it("action.yml description does NOT make the unconditional producer-signed claim", function () {
      const { doc } = loadAction();
      // The old headline "every sealed artifact still matches the bytes the producer signed" must not stand
      // unconditioned — it must be tied to a pinned vendor (any wording), never imply WHO without a pin.
      const desc = doc.description;
      expect(
        /every sealed artifact still matches the bytes the producer signed/.test(desc),
        "the unconditional producer-signed headline must be reworded to depend on `vendor:`"
      ).to.equal(false);
      // The vendor input's description must warn about the signed + no-vendor over-trust.
      const vdesc = doc.inputs.vendor.description.toLowerCase();
      expect(vdesc).to.match(/attacker|own key|re-?sign/);
    });

    it("README warns that gating a SIGNED artifact WITHOUT vendor accepts an attacker-re-signed release", function () {
      const md = fs.readFileSync(ACTION_README, "utf8");
      // The guarantee must be conditioned on `vendor:` (mentions both the set and omitted cases).
      expect(md.toLowerCase()).to.match(/with[^\n]*vendor[^\n]*set/);
      expect(md.toLowerCase()).to.match(/tamper-evidence only|does not prove who|not prove who/);
      // And it must carry the explicit attacker-re-sign warning so a consumer cannot miss the footgun.
      expect(md.toLowerCase()).to.match(/attacker.*(re-?sign|own key)|(re-?sign|own key).*attacker/);
    });
  });

  // ===============================================================================================
  // 4. The README documents the one-line adoption + the no-drift guarantee.
  // ===============================================================================================
  describe("verifier/action/README.md documents the adoption line", function () {
    it("ships and shows the `uses:` adoption line + names the no-drift source of truth", function () {
      expect(fs.existsSync(ACTION_README)).to.equal(true);
      const md = fs.readFileSync(ACTION_README, "utf8");
      expect(md).to.match(/uses:\s*<owner>\/<repo>\/verifier\/action@<ref>/);
      expect(md).to.contain("vendor:");
      expect(md).to.match(/manifest:|artifacts:/);
      // It must point at the single source of truth so the docs cannot silently diverge from the gate.
      expect(md).to.contain("verify-vh.generic.sh");
    });
  });
});
