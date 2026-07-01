"use strict";

// test/sdk.example.signed.test.js — the committed, runnable SIGNED-VERIFY example (T-58.2):
// examples/sdk-verify-signed.js.
//
// WHAT THIS PROVES (each acceptance clause is a test below)
//   (1) RUNS AS A CONSUMER WOULD: `node examples/sdk-verify-signed.js` in a CHILD PROCESS exits 0 (a clean,
//       real-world invocation — not an in-process import that could hide a bad entrypoint) and prints an
//       ACCEPT (pinned to OUR vendor address) followed by REJECTs (a genuine signature from the WRONG
//       signer, a one-byte-tampered signature) AND — the paying-customer path — an ACCEPT/REJECT pair for
//       the STRICT on-disk BINDING gate: `verifySignedSealAttestation` bound to the actual RECEIVED files on
//       disk ACCEPTS the untouched deliverable and REJECTS one whose received bytes were corrupted, even
//       though the vendor signature over the ORIGINAL bytes is STILL genuine. That signed, address-pinned,
//       BYTES-BOUND gate is the revenue-relevant embed (STRATEGY.md P-9 / EPIC-58): a downstream service
//       verifies IN-PROCESS that a packet was signed by OUR vendor AND that the exact bytes it received are
//       the ones that were signed — with NO shell-out to the `vh` binary.
//   (2) THE VERIFY SURFACE STANDS ALONE: a source-level grep asserts the example imports ONLY the package
//       BY NAME (`require("verifyhash")`) and RELATIVE example files — NOTHING else. It has NO deep
//       `require(".../cli/...")` reach-in (the load-bearing check: the public API is enough), NO
//       `child_process` (the whole point is IN-PROCESS verify, not shelling out to `vh`), NO built-in
//       (`fs`/`os`/`path` disk plumbing is quarantined in the relative helper), and nothing network-y. If
//       someone had to reach past the public API — or shell out — to make the example work, that grep fails
//       and the "in-process public verify stands alone" claim is falsified.
//   (3) STRUCTURED RESULT: awaiting the example's `runExample` yields the ACCEPT verdict (our pinned
//       vendor), the wrong-signer REJECT (with the signature still GENUINE — only the pin failed), the
//       tampered-signature REJECT (signature no longer genuine), AND the on-disk binding pair — an ACCEPT
//       bound to the untouched received directory and a REJECT bound to a corrupted one whose vendor
//       signature is STILL genuine (only `manifestBindsAttestation` fails) — so the demo is asserted on its
//       DATA, not only its stdout. It also proves the example leaves NO temp dir behind in the repo tree.
//
// PURE / OFFLINE — no chain, no provider, no network, no REAL key. The only signing key is an EPHEMERAL,
// in-memory, TEST-ONLY Wallet.createRandom() minted inside the RELATIVE helper (never persisted / funded /
// logged). The loop NEVER holds a real key. The child process only computes hashes and recovers PUBLIC
// addresses from signatures.

const { expect } = require("chai");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const EXAMPLE = path.join(REPO, "examples", "sdk-verify-signed.js");
const EXAMPLE_HELPER = path.join(REPO, "examples", "lib", "ephemeral-publisher.js");
const EXAMPLE_README = path.join(REPO, "examples", "README.md");

describe("examples/sdk-verify-signed.js — runnable SIGNED-VERIFY example (T-58.2)", function () {
  // The example only hashes a handful of tiny in-memory buffers + recovers addresses; bounded for slow CI.
  this.timeout(60000);

  // -------------------------------------------------------------------------
  // (1) RUNS in a CHILD PROCESS, exits 0, and prints ACCEPT then REJECT (wrong-signer AND tamper).
  // -------------------------------------------------------------------------
  describe("runs as an external consumer would — child process, exit 0, ACCEPT then REJECT (wrong-signer / tamper)", function () {
    let stdout;

    before(function () {
      // Run EXACTLY as a developer would: `node examples/sdk-verify-signed.js`. execFileSync throws on a
      // non-zero exit, so a clean return here already asserts exit 0. We capture stdout to assert the order.
      stdout = execFileSync("node", [EXAMPLE], { cwd: REPO, encoding: "utf8" });
    });

    it("exits 0 (execFileSync returned without throwing)", function () {
      // If the child had exited non-zero, `before` would have thrown and this suite would error out.
      expect(stdout).to.be.a("string").and.not.equal("");
    });

    it("prints the ACCEPT step (pinned to OUR vendor address -> ACCEPTED)", function () {
      expect(stdout).to.match(/verifySignedSeal \(pinned to OUR vendor address\): ACCEPTED/);
    });

    it("prints the WRONG-signer REJECT step (a GENUINE signature that does not match our pin -> REJECTED)", function () {
      // The bytes + signature are genuine; only the PIN fails. This is the check a paying integrator needs:
      // "signed by someone, but not by US" must REJECT — and the signature must still be genuine.
      expect(stdout).to.match(/verifySignedSeal \(pinned to a DIFFERENT vendor address\): REJECTED/);
      expect(stdout).to.match(/signatureGenuine=true/);
    });

    it("prints the TAMPER REJECT step (recovered signer != claimed -> REJECTED)", function () {
      expect(stdout).to.match(/verifySignedSeal \(one hex char of the signature flipped\): REJECTED/);
      // The tampered case is a DIFFERENT reason than the wrong-signer case: here the signature is NOT genuine.
      expect(stdout).to.match(/one hex char of the signature flipped\): REJECTED\s+\(signatureGenuine=false/);
    });

    it("prints the on-disk BIND ACCEPT step ([4a]: bound to the untouched received files -> ACCEPTED, bytes bind)", function () {
      // The paying-customer gate: verifySignedSealAttestation bound to the actual received directory. ACCEPTED
      // only when our vendor signed it AND the on-disk bytes match what was signed.
      expect(stdout).to.match(
        /verifySignedSealAttestation \(pinned \+ BOUND to the received files on disk\): ACCEPTED/
      );
      expect(stdout).to.match(/pinned \+ BOUND to the received files on disk\): ACCEPTED[\s\S]*?bytesOnDiskBind=true/);
    });

    it("prints the on-disk CONTENT-TAMPER REJECT step ([4b]: a received file corrupted -> REJECTED, only binding fails)", function () {
      // The highest-value rejection: the vendor signature over the ORIGINAL bytes is STILL genuine and the pin
      // STILL matches — only the on-disk bytes drifted, so manifestBindsAttestation=false. The signature-only
      // path could not catch this; the on-disk binding does.
      expect(stdout).to.match(/verifySignedSealAttestation \(one received file corrupted on disk\): REJECTED/);
      expect(stdout).to.match(
        /one received file corrupted on disk\): REJECTED\s+\(signatureGenuine=true, pinMatched=true, bytesOnDiskBind=false/
      );
    });

    it("the ACCEPT line PRECEDES the REJECT lines, and the on-disk BIND gate ([4]) comes LAST (the gate escalates in value)", function () {
      const acceptIdx = stdout.indexOf("pinned to OUR vendor address): ACCEPTED");
      const wrongSignerIdx = stdout.indexOf("pinned to a DIFFERENT vendor address): REJECTED");
      const tamperedIdx = stdout.indexOf("one hex char of the signature flipped): REJECTED");
      const boundAcceptIdx = stdout.indexOf("BOUND to the received files on disk): ACCEPTED");
      const boundTamperIdx = stdout.indexOf("one received file corrupted on disk): REJECTED");
      expect(acceptIdx, "ACCEPT not printed").to.be.greaterThan(-1);
      expect(wrongSignerIdx, "wrong-signer REJECT not printed").to.be.greaterThan(-1);
      expect(tamperedIdx, "tampered REJECT not printed").to.be.greaterThan(-1);
      expect(boundAcceptIdx, "on-disk BIND ACCEPT not printed").to.be.greaterThan(-1);
      expect(boundTamperIdx, "on-disk content-tamper REJECT not printed").to.be.greaterThan(-1);
      // ACCEPT first, then the signature-only REJECTs, then the higher-value on-disk BINDING gate LAST.
      expect(acceptIdx).to.be.lessThan(wrongSignerIdx);
      expect(acceptIdx).to.be.lessThan(tamperedIdx);
      expect(wrongSignerIdx).to.be.lessThan(tamperedIdx);
      expect(tamperedIdx).to.be.lessThan(boundAcceptIdx);
      expect(boundAcceptIdx).to.be.lessThan(boundTamperIdx);
    });

    it("leads with the standing TRUST NOTE so it never overclaims (signature != timestamp / legal opinion)", function () {
      expect(stdout).to.include("TRUST NOTE");
      expect(stdout).to.match(/proves\s+WHO vouched/);
      expect(stdout).to.match(/trusted timestamp/);
      expect(stdout.toLowerCase()).to.match(/not a legal opinion|is not a legal opinion/);
    });

    it("ends with a PASS summary naming the ACCEPT + all REJECT reasons incl. the on-disk binding gate", function () {
      expect(stdout).to.match(/RESULT: PASS/);
      expect(stdout).to.match(/wrong signer/);
      expect(stdout).to.match(/tampered signature/);
      // The paying-customer gate is named too: bound to the received files on disk, and the content-tamper case.
      expect(stdout).to.match(/received files on disk/);
      expect(stdout).to.match(/corrupted on disk/);
    });
  });

  // -------------------------------------------------------------------------
  // (2) THE VERIFY SURFACE STANDS ALONE — grep the source: ONLY `require("verifyhash")` + relative example
  //     files; NO deep `require(".../cli/...")`, NO `child_process`, NO network.
  // -------------------------------------------------------------------------
  describe("in-process public verify stands alone — source grep of the example's imports", function () {
    let src; // comment-stripped source: we grep CODE, not prose (comments legitimately name anti-patterns)
    let rawSrc;
    let requireArgs;

    before(function () {
      rawSrc = fs.readFileSync(EXAMPLE, "utf8");
      // Strip block comments (/* ... */) and line comments (// ...) so the grep sees only executable code.
      // The example's comments deliberately NAME the forbidden `cli/...` / `child_process` patterns to teach
      // them; that prose must not trip a grep meant to catch a real deep import / shell-out in CODE.
      src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      // Collect the literal argument of every `require("...")` / `require('...')` in the CODE.
      requireArgs = [];
      const re = /require\(\s*(["'])([^"']+)\1\s*\)/g;
      let m;
      while ((m = re.exec(src)) !== null) requireArgs.push(m[2]);
    });

    it("imports the package BY NAME through its public entrypoint (require(\"verifyhash\"))", function () {
      expect(requireArgs, "example must require the public package by name").to.include("verifyhash");
    });

    it("imports ONLY the package BY NAME + RELATIVE example files — NOTHING else (no ethers, no third-party, no built-in)", function () {
      // The acceptance is strict for THIS example: the buyer's verify path stands on ONLY `verifyhash` + its
      // own relative example files. Publisher-side key handling (ethers) is quarantined in the relative
      // helper, so it never appears as an import HERE.
      for (const arg of requireArgs) {
        const isPackageByName = arg === "verifyhash";
        const isRelative = arg.startsWith("./") || arg.startsWith("../");
        expect(
          isPackageByName || isRelative,
          `example require("${arg}") is neither the public package by name nor a relative example file`
        ).to.equal(true);
      }
    });

    it("does NOT deep-import ANY cli/* internal (the load-bearing check: the public API is enough)", function () {
      // The acceptance's exact anti-pattern: a deep `require(".../cli/...")` reach-in. Assert NONE — in the
      // require args AND anywhere in the code.
      expect(src, "example must not deep-import cli/*").to.not.match(/require\([^)]*\/cli\//);
      for (const arg of requireArgs) {
        expect(arg, `example require("${arg}") reaches into cli/*`).to.not.match(/(^|\/)cli\//);
      }
    });

    it("does NOT use child_process (the whole point is IN-PROCESS verify, not shelling out to `vh`)", function () {
      // No require of child_process (bare or node:-prefixed) and no bare-word use in the code.
      expect(src, "example must not require child_process").to.not.match(
        /require\(\s*["'](?:node:)?child_process["']\s*\)/
      );
      expect(src, "example must not reference child_process at all").to.not.match(/child_process/);
      for (const arg of requireArgs) {
        expect(arg, `example require("${arg}") pulls in child_process`).to.not.match(/child_process/);
      }
    });

    it("does NOT require ANY Node built-in — the on-disk plumbing (fs/os/path) is quarantined in the relative helper", function () {
      // The example runs the on-disk BINDING gate (verifySignedSealAttestation with a real dir), but the
      // "receive to disk / corrupt a file / clean up" plumbing lives in the RELATIVE helper. So the example
      // itself must still import ONLY the public package + relative files — no fs/os/path/child_process,
      // bare or node:-prefixed. This is the load-bearing "public verify stands alone" invariant.
      for (const arg of requireArgs) {
        expect(
          /^(?:node:)?(?:fs|os|path|child_process|http|https|net|dns|tls|dgram|crypto|url|util|stream|events|zlib|readline|process)$/.test(
            arg
          ),
          `example require("${arg}") pulls in a Node built-in; quarantine it in the relative helper`
        ).to.equal(false);
      }
    });

    it("does NOTHING network-y (no http/https/net/dns/fetch/socket in the source)", function () {
      expect(src, "example must not use the network").to.not.match(
        /\brequire\(\s*["'](?:node:)?(?:https?|net|dns|tls|dgram)["']\s*\)/
      );
      expect(src, "example must not fetch()").to.not.match(/\bfetch\s*\(/);
    });

    it("the relative helper it pulls in is itself an example file (not a reach into cli/*)", function () {
      // Every relative require must resolve INSIDE examples/ — never a "../cli/..." reach-up disguised as
      // relative. Confirm the helper the example depends on exists and lives under examples/.
      for (const arg of requireArgs) {
        if (!arg.startsWith(".")) continue;
        expect(arg, `relative require("${arg}") reaches into cli/*`).to.not.match(/(^|\/)cli\//);
      }
      expect(fs.existsSync(EXAMPLE_HELPER), "examples/lib/ephemeral-publisher.js helper must exist").to.equal(true);
      expect(EXAMPLE_HELPER.startsWith(path.join(REPO, "examples"))).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // (3) STRUCTURED RESULT — importing runExample yields the ACCEPT + both REJECT verdicts, so the demo is
  //     asserted on its DATA, not just its stdout.
  // -------------------------------------------------------------------------
  describe("importable runExample returns the ACCEPT + wrong-signer + tamper verdicts", function () {
    let result;

    before(async function () {
      const { runExample } = require("../examples/sdk-verify-signed");
      result = await runExample(() => {}); // silent sink — we assert on the returned structure
    });

    it("ACCEPT for our pinned vendor", function () {
      expect(result.acceptVerdict).to.equal("ACCEPTED");
      // The pinned vendor address is a real 0x-address (the value a consumer publishes / hard-codes).
      expect(result.vendorAddress).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(result.apiVersion).to.equal(require("../package.json").version);
    });

    it("REJECT for the WRONG signer — the signature is still GENUINE, only the PIN failed", function () {
      expect(result.wrongSignerVerdict).to.equal("REJECTED");
      expect(result.wrongSignerSignatureGenuine).to.equal(true);
      expect(result.wrongSignerPinMatched).to.equal(false);
    });

    it("REJECT for a one-byte-TAMPERED signature — the signature is NO LONGER genuine", function () {
      expect(result.tamperedVerdict).to.equal("REJECTED");
      expect(result.tamperedSignatureGenuine).to.equal(false);
    });

    it("ACCEPT bound to the UNTOUCHED received files on disk — our vendor AND the on-disk bytes bind ([4a])", function () {
      // The paying-customer gate: verifySignedSealAttestation over the actual received directory. ACCEPTED
      // only when the vendor pin AND the on-disk byte-identity both hold.
      expect(result.boundAcceptVerdict).to.equal("ACCEPTED");
      expect(result.boundAcceptBinds).to.equal(true);
    });

    it("REJECT bound to a CORRUPTED received directory — the vendor signature is STILL genuine; only binding fails ([4b])", function () {
      // The highest-value case: the vendor signature over the ORIGINAL bytes is genuine and the pin matches;
      // only the on-disk bytes drifted, so manifestBindsAttestation=false. This is what the signature-only
      // path [1]-[3] cannot catch, and the reason a paying integrator embeds the on-disk binding gate.
      expect(result.boundTamperVerdict).to.equal("REJECTED");
      expect(result.boundTamperBinds).to.equal(false);
      expect(result.boundTamperSignatureGenuine).to.equal(true);
      expect(result.boundTamperPinMatched).to.equal(true);
    });

    it("verification did NOT mutate the received packet (verify only READS it)", function () {
      expect(result.packetUnchanged).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // (3b) NO REPO POLLUTION — the on-disk binding gate writes the received deliverable to a throwaway OS temp
  //      dir and cleans it up; it must NEVER scatter files into the repo working tree.
  // -------------------------------------------------------------------------
  describe("the on-disk binding gate leaves NO temp dir in the repo tree", function () {
    it("running the example does not create any vh-sdk-signed-example-* dir under the repo", function () {
      // Snapshot the examples/ tree before + after a fresh child run; assert no leftover temp artifact.
      const before = new Set(fs.readdirSync(path.join(REPO, "examples")));
      execFileSync("node", [EXAMPLE], { cwd: REPO, encoding: "utf8" });
      const after = fs.readdirSync(path.join(REPO, "examples"));
      for (const name of after) {
        expect(before.has(name), `example left a new entry in examples/: ${name}`).to.equal(true);
        expect(name, "example must not create a temp received-deliverable dir in the repo").to.not.match(
          /vh-sdk-signed-example-/
        );
      }
      // And the repo root is untouched too (the temp dir lives under os.tmpdir(), not the repo).
      const rootEntries = fs.readdirSync(REPO);
      for (const name of rootEntries) {
        expect(name, "example must not create a temp dir in the repo root").to.not.match(/vh-sdk-signed-example-/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // (4) DOC — examples/README.md documents this example + names its test (so the doc can't silently rot).
  // -------------------------------------------------------------------------
  describe("examples/README.md documents the signed-verify example", function () {
    let readme;

    before(function () {
      readme = fs.readFileSync(EXAMPLE_README, "utf8");
    });

    it("names the runnable command and the entrypoint", function () {
      expect(readme).to.include("node examples/sdk-verify-signed.js");
      expect(readme).to.include('require("verifyhash")');
    });

    it("references this test (the example is test-gated, cannot rot)", function () {
      expect(readme).to.include("test/sdk.example.signed.test.js");
    });
  });
});
