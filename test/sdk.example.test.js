"use strict";

// test/sdk.example.test.js — the committed, runnable CONSUMER example that exercises the SDK exactly as an
// EXTERNAL developer would (T-57.3): examples/sdk-verify.js.
//
// WHAT THIS PROVES (each acceptance clause is a test below)
//   (1) RUNS AS A CONSUMER WOULD: `node examples/sdk-verify.js` in a CHILD PROCESS exits 0 (a clean,
//       real-world invocation — not an in-process import that could hide a bad entrypoint) and prints BOTH
//       the free-tier ACCEPT -> REJECT -> diff sequence AND the paid, SIGNED + vendor-PINNED verify gate:
//       ACCEPT (our pinned vendor) -> REJECT (a genuine signature from the WRONG vendor) -> REJECT (a
//       tampered signature). That signed, address-pinned gate is the revenue-relevant embed (STRATEGY.md
//       P-9 / EPIC-58): a downstream service verifies IN-PROCESS that a packet was signed by OUR published
//       vendor address, with NO shell-out to the `vh` binary.
//   (2) THE PUBLIC SURFACE STANDS ALONE: a source-level grep asserts the example imports ONLY the package
//       BY NAME (`require("verifyhash")`), `ethers` (a DIRECT dependency of verifyhash, re-exported by the
//       SDK — used only to mint an EPHEMERAL throwaway signer standing in for a real out-of-band vendor
//       key), Node built-ins, and relative example files — and NEVER a deep `require(".../cli/core/...")`
//       (or any deep cli/* reach-in). If someone had to reach past the public API to make the example work,
//       that grep fails and the "public surface stands alone" claim is falsified.
//   (3) NO NETWORK / NO NON-CORE DEPENDENCY: the example's requires are exactly `verifyhash`, its own
//       DIRECT dependency `ethers`, and Node built-ins — no third-party non-core package and nothing that
//       could open a socket. `ethers` is CORE (it is declared in verifyhash's `dependencies`, resolvable,
//       and the SDK's signing path is built on it), so a consumer who installed verifyhash already has it.
//   (4) STRUCTURED RESULT: awaiting the example's `runExample` yields the same free-tier ACCEPT/REJECT
//       verdicts + a diff localized to the tampered file, AND the signed-gate verdicts (ACCEPT for our
//       pinned vendor, REJECT for the wrong vendor, REJECT for a tampered signature) — so the demo is
//       asserted on its DATA, not only its stdout.
//
// PURE / OFFLINE — no chain, no provider, no network, no REAL key. The only signing key is an EPHEMERAL,
// in-memory, TEST-ONLY Wallet.createRandom() (never persisted / funded / logged). The loop NEVER holds a
// real key. The child process only computes hashes and recovers PUBLIC addresses from signatures.

const { expect } = require("chai");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const EXAMPLE = path.join(REPO, "examples", "sdk-verify.js");
const EXAMPLE_README = path.join(REPO, "examples", "README.md");

describe("examples/sdk-verify.js — runnable SDK CONSUMER example (T-57.3)", function () {
  // The example only hashes a handful of tiny in-memory buffers; generous but bounded for slow CI.
  this.timeout(60000);

  // -------------------------------------------------------------------------
  // (1) RUNS in a CHILD PROCESS, exits 0, and prints the ACCEPT -> REJECT -> diff sequence.
  // -------------------------------------------------------------------------
  describe("runs as an external consumer would — child process, exit 0, ACCEPT -> REJECT -> diff (+ signed gate)", function () {
    let stdout;

    before(function () {
      // Run EXACTLY as a developer would: `node examples/sdk-verify.js`. execFileSync throws on a non-zero
      // exit, so a clean return here already asserts exit 0. We capture stdout to assert the sequence.
      stdout = execFileSync("node", [EXAMPLE], { cwd: REPO, encoding: "utf8" });
    });

    it("exits 0 (execFileSync returned without throwing)", function () {
      // If the child had exited non-zero, `before` would have thrown and this suite would error out.
      expect(stdout).to.be.a("string").and.not.equal("");
    });

    it("prints the ACCEPT step (untouched bytes verify ACCEPTED)", function () {
      expect(stdout).to.match(/verifySeal \(untouched bytes\): ACCEPTED/);
    });

    it("prints the REJECT step (a one-byte tamper verifies REJECTED)", function () {
      expect(stdout).to.match(/verifySeal \(one byte flipped[^)]*\): REJECTED/);
    });

    it("prints the DIFF localized to the tampered file (CHANGED data/b.txt, expected vs actual)", function () {
      expect(stdout).to.match(/diff: 1 changed, 0 missing, 0 unexpected, 2 matched/);
      expect(stdout).to.include("CHANGED data/b.txt");
      expect(stdout).to.match(/expected 0x[0-9a-f]{64}/);
      expect(stdout).to.match(/actual\s+0x[0-9a-f]{64}/);
    });

    it("the ACCEPT line PRECEDES the REJECT line (the sequence is in order)", function () {
      const acceptIdx = stdout.indexOf("ACCEPTED");
      const rejectIdx = stdout.indexOf("REJECTED");
      expect(acceptIdx, "ACCEPTED not printed").to.be.greaterThan(-1);
      expect(rejectIdx, "REJECTED not printed").to.be.greaterThan(-1);
      expect(acceptIdx).to.be.lessThan(rejectIdx);
    });

    // --- ACT 2: the SIGNED + vendor-PINNED verify gate (the paid, revenue-relevant embed) ---------------

    it("prints the SIGNED-gate ACCEPT step (pinned to OUR vendor address -> ACCEPTED)", function () {
      // The publisher signed the seal, and verifySignedSeal PINNED to that vendor address ACCEPTS.
      expect(stdout).to.match(/verifySignedSeal \(pinned to OUR vendor address\): ACCEPTED/);
    });

    it("prints the WRONG-vendor REJECT step (a GENUINE signature that does not match our pin -> REJECTED)", function () {
      // The bytes + signature are genuine; only the PIN fails. This is the check a paying integrator needs:
      // "signed by someone, but not by US" must REJECT.
      expect(stdout).to.match(/verifySignedSeal \(pinned to a DIFFERENT vendor address\): REJECTED/);
      expect(stdout).to.match(/signatureGenuine=true/);
    });

    it("prints the tampered-signature REJECT step (recovered signer != claimed -> REJECTED)", function () {
      expect(stdout).to.match(/verifySignedSeal \(one hex char of the signature flipped\): REJECTED/);
    });

    it("the signed ACCEPT precedes BOTH signed REJECTs (the paid-gate sequence is in order)", function () {
      const signedAcceptIdx = stdout.indexOf("pinned to OUR vendor address): ACCEPTED");
      const wrongVendorIdx = stdout.indexOf("pinned to a DIFFERENT vendor address): REJECTED");
      const tamperedSigIdx = stdout.indexOf("one hex char of the signature flipped): REJECTED");
      expect(signedAcceptIdx, "signed ACCEPT not printed").to.be.greaterThan(-1);
      expect(wrongVendorIdx, "wrong-vendor REJECT not printed").to.be.greaterThan(-1);
      expect(tamperedSigIdx, "tampered-signature REJECT not printed").to.be.greaterThan(-1);
      expect(signedAcceptIdx).to.be.lessThan(wrongVendorIdx);
      expect(wrongVendorIdx).to.be.lessThan(tamperedSigIdx);
    });

    it("names both acts so a reader sees free-tier vs paid-embed (Act 1 UNSIGNED, Act 2 SIGNED + pinned)", function () {
      expect(stdout).to.match(/ACT 1: UNSIGNED tamper-evidence/);
      expect(stdout).to.match(/ACT 2: SIGNED \+ vendor-PINNED verify gate/);
      const act1Idx = stdout.indexOf("ACT 1");
      const act2Idx = stdout.indexOf("ACT 2");
      expect(act1Idx).to.be.greaterThan(-1);
      expect(act2Idx).to.be.greaterThan(act1Idx);
    });

    it("leads with the standing TRUST NOTE so it never overclaims (signature != timestamp / legal opinion)", function () {
      expect(stdout).to.include("TRUST NOTE");
      expect(stdout).to.match(/TAMPER-EVIDENCE/);
      // The signed act must not let a valid signature be read as a trusted timestamp.
      expect(stdout).to.match(/proves\s+WHO vouched/);
      expect(stdout).to.match(/trusted timestamp/);
      expect(stdout.toLowerCase()).to.match(/not a legal opinion|neither is a legal opinion/);
    });

    it("ends with a PASS summary that names BOTH acts", function () {
      expect(stdout).to.match(/RESULT: PASS/);
      // The summary must reflect the full signed gate, not just the unsigned tamper case.
      expect(stdout).to.match(/wrong vendor/);
    });
  });

  // -------------------------------------------------------------------------
  // (2) THE PUBLIC SURFACE STANDS ALONE — grep the source: only `require("verifyhash")` + relative example
  //     files, and NO deep `require(".../cli/core/...")` (or any deep cli/* reach-in).
  // -------------------------------------------------------------------------
  describe("public surface stands alone — source grep of the example's imports", function () {
    let src; // comment-stripped source: we grep CODE, not prose (comments legitimately name anti-patterns)
    let rawSrc;
    let requireArgs;

    before(function () {
      rawSrc = fs.readFileSync(EXAMPLE, "utf8");
      // Strip block comments (/* ... */) and line comments (// ...) so the grep sees only executable code.
      // The example's comments deliberately NAME the forbidden `require(".../cli/core/...")` pattern to
      // teach it; that prose must not trip a grep that is meant to catch a real deep import in CODE.
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

    it("its only non-builtin imports are the package BY NAME + `ethers` (verifyhash's OWN dependency)", function () {
      // Prove the example did NOT smuggle in some third-party helper: every bare (non-relative) specifier is
      // either the package by name, verifyhash's declared dependency `ethers`, or a Node built-in.
      const KNOWN_BUILTINS = new Set([
        "fs", "path", "os", "crypto", "util", "assert", "buffer", "stream", "events", "url", "process",
      ]);
      // `ethers` must be a REAL, declared dependency of verifyhash (not a random package this example added).
      const vhPkg = require("../package.json");
      expect(vhPkg.dependencies, "ethers must be a declared dependency of verifyhash").to.have.property("ethers");
      for (const arg of requireArgs) {
        if (arg.startsWith(".")) continue; // relative example file
        const allowed =
          arg === "verifyhash" ||
          arg === "ethers" ||
          KNOWN_BUILTINS.has(arg) ||
          arg.startsWith("node:");
        expect(allowed, `example require("${arg}") is not the package, its own dep ethers, or a built-in`).to.equal(true);
      }
    });

    it("does NOT deep-import cli/core/* (the load-bearing check: the public API is enough)", function () {
      // The acceptance's exact anti-pattern: a deep `require(".../cli/core/...")` reach-in. Assert NONE.
      expect(src, "example must not deep-import cli/core/*").to.not.match(/require\([^)]*cli\/core\//);
      for (const arg of requireArgs) {
        expect(arg, `example require("${arg}") reaches into cli/core/*`).to.not.match(/cli\/core\//);
      }
    });

    it("does NOT deep-import ANY cli/* internal (only the stable public surface + relative example files)", function () {
      for (const arg of requireArgs) {
        // Allowed: the package by name, Node built-ins, and RELATIVE example files ("./" or "../").
        const isPackageByName = arg === "verifyhash";
        const isRelative = arg.startsWith("./") || arg.startsWith("../");
        const isBuiltin = !arg.startsWith(".") && !arg.includes("/"); // e.g. "fs", "path", "crypto"
        expect(
          isPackageByName || isRelative || isBuiltin,
          `example require("${arg}") is not the public package, a Node built-in, or a relative example file`
        ).to.equal(true);
        // And explicitly: no relative reach-up into cli/* (a "../cli/..." would still be a deep internal).
        if (isRelative) {
          expect(arg, `relative require("${arg}") reaches into cli/*`).to.not.match(/(^|\/)cli\//);
        }
      }
    });

    it("uses NO non-core dependency (only the package, its OWN dep `ethers`, or a Node built-in)", function () {
      // No THIRD-PARTY non-core package (nothing that could pull a network client or a heavyweight dep). A
      // bare specifier that is NOT "verifyhash", NOT verifyhash's declared dependency `ethers`, and NOT a
      // known Node built-in would be a genuine non-core dependency. `ethers` is CORE: it is declared in
      // verifyhash's `dependencies` and the SDK's signing path is built on it, so a consumer who installed
      // verifyhash already has it — it is not an extra install the example smuggled in.
      const vhPkg = require("../package.json");
      expect(vhPkg.dependencies, "ethers must be a declared verifyhash dependency").to.have.property("ethers");
      const CORE_SPECIFIERS = new Set(["verifyhash", "ethers"]);
      const KNOWN_BUILTINS = new Set([
        "fs", "path", "os", "crypto", "util", "assert", "buffer", "stream", "events", "url", "process",
      ]);
      for (const arg of requireArgs) {
        if (CORE_SPECIFIERS.has(arg)) continue; // the package + its own declared dependency
        if (arg.startsWith(".")) continue; // relative example file
        expect(
          KNOWN_BUILTINS.has(arg) || arg.startsWith("node:"),
          `example require("${arg}") is a non-core dependency`
        ).to.equal(true);
      }
    });

    it("does NOTHING network-y (no http/https/net/dns/fetch/socket in the source)", function () {
      expect(src, "example must not use the network").to.not.match(
        /\brequire\(\s*["'](?:node:)?(?:https?|net|dns|tls|dgram)["']\s*\)/
      );
      expect(src, "example must not fetch()").to.not.match(/\bfetch\s*\(/);
    });
  });

  // -------------------------------------------------------------------------
  // (3) STRUCTURED RESULT — importing runExample yields the ACCEPT/REJECT verdicts + a localized diff, so
  //     the demo is asserted on its DATA, not just its stdout.
  // -------------------------------------------------------------------------
  describe("importable runExample returns BOTH the free-tier and the signed-gate verdicts", function () {
    let result;

    before(async function () {
      const { runExample } = require("../examples/sdk-verify");
      result = await runExample(() => {}); // silent sink — we assert on the returned structure
    });

    it("Act 1 (unsigned): ACCEPTED then REJECTED with the diff localized to the tampered file", function () {
      expect(result.acceptVerdict).to.equal("ACCEPTED");
      expect(result.rejectVerdict).to.equal("REJECTED");
      expect(result.changed).to.deep.equal(["data/b.txt"]);
      expect(result.counts).to.include({ changed: 1, missing: 0, unexpected: 0, matched: 2 });
      expect(result.rootRoundTrips).to.equal(true);
      expect(result.readBackAccepts).to.equal(true);
      expect(result.apiVersion).to.equal(require("../package.json").version);
    });

    it("Act 2 (signed + pinned): ACCEPT for our vendor, REJECT for the wrong vendor, REJECT for a tampered sig", function () {
      // The revenue-relevant embed: pinning to OUR published vendor address ACCEPTS.
      expect(result.signedAcceptVerdict).to.equal("ACCEPTED");
      // A GENUINE signature that recovers to a DIFFERENT vendor REJECTS — and the signature is still valid,
      // only the PIN failed (the exact security property a paying integrator's gate must enforce).
      expect(result.wrongVendorVerdict).to.equal("REJECTED");
      expect(result.wrongVendorSignatureGenuine).to.equal(true);
      expect(result.wrongVendorPinMatched).to.equal(false);
      // A one-byte-tampered signature REJECTS even under the correct vendor pin.
      expect(result.tamperedSignatureVerdict).to.equal("REJECTED");
      // The pinned vendor address is a real 0x-address (the value a consumer publishes / hard-codes).
      expect(result.vendorAddress).to.match(/^0x[0-9a-fA-F]{40}$/);
    });
  });

  // -------------------------------------------------------------------------
  // (4) DOC — examples/README.md documents this example + names its test (so the doc can't silently rot).
  // -------------------------------------------------------------------------
  describe("examples/README.md documents the SDK consumer example", function () {
    let readme;

    before(function () {
      readme = fs.readFileSync(EXAMPLE_README, "utf8");
    });

    it("names the runnable command and the entrypoint", function () {
      expect(readme).to.include("node examples/sdk-verify.js");
      expect(readme).to.include('require("verifyhash")');
    });

    it("references this test (the example is test-gated, cannot rot)", function () {
      expect(readme).to.include("test/sdk.example.test.js");
    });
  });
});
