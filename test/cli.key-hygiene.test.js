"use strict";

// T-75.1 — key hygiene for the on-chain (tx-submitting) verbs: anchor / claim / commit / reveal /
// prove --anchor.
//
// THE INVARIANT UNDER TEST: private-key material must never be able to reach the process's
// stdout/stderr (and therefore shell scrollback, CI logs, or pasted bug reports). Before this fix,
// each verb did a raw `new ethers.Wallet(process.env.PRIVATE_KEY, provider)` and relayed
// `e.message` verbatim — and ethers' assertArgument errors serialize the offending VALUE into the
// message, so the extremely common `export PRIVATE_KEY=$(cat keyfile)` (trailing newline) echoed
// the FULL private key to stderr:
//   error: invalid BytesLike value (argument="value", value="0x…the whole key…\n", …)
//
// These tests spawn the REAL CLI binary (`node cli/vh.js <verb> …`) so they observe exactly what
// an operator's terminal/logs would capture. Every key used is EPHEMERAL by construction:
//   * the malformed key is a repeating `deadbeef` pattern of the WRONG length (30 bytes) — not a
//     usable key at all, and the repetition means ANY echo of >= 8 consecutive characters of it
//     must contain the marker "deadbeef";
//   * the well-formed key is hardhat's public dev-account #0 key (globally published test-only
//     material — never a real key).
//
// The "positive path" requirement is asserted at the NETWORK-EXIT BOUNDARY: the verbs run against
// a loopback address nothing listens on (http://127.0.0.1:1 — binding port 1 needs root, so it is
// reliably closed), so a clean key must carry execution all the way to the socket connect
// (ECONNREFUSED) — proving the trimmed key was accepted and the wallet built — with zero network
// dependence and zero key bytes in the output.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const VH = path.join(__dirname, "..", "cli", "vh.js");

// MALFORMED ephemeral key: 60 hex chars (30 bytes — invalid even after trimming) + the trailing
// newline of `export PRIVATE_KEY=$(cat keyfile)`. Pre-fix this exact shape leaked verbatim.
const MAL_KEY_BODY = "deadbeef".repeat(7) + "dead"; // 60 hex chars, marker-dense
const MALFORMED_KEY = "0x" + MAL_KEY_BODY + "\n";
const MAL_MARKER = "deadbeef"; // any >=8-char echo of the key body contains this

// Hardhat's well-known PUBLIC dev key #0 (ephemeral/test-only by definition).
const CLEAN_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CLEAN_MARKER = "ac0974bec39a17e36b"; // long enough that any echo of the key contains it

// Loopback port nothing can be listening on (binding port 1 requires root): connecting to it IS
// the network-exit boundary, and fails fast + deterministically with ECONNREFUSED. No real
// network is ever touched.
const DEAD_RPC = "http://127.0.0.1:1";
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3"; // well-formed address (never dialed)

/**
 * Spawn `node cli/vh.js <args…>` with a controlled environment: the ambient RPC/contract/key vars
 * are stripped (so a developer's shell can't redirect the verbs at a real endpoint) and
 * PRIVATE_KEY is set to exactly `key` (or left unset). Returns exit code + captured streams.
 */
function runVh(args, key) {
  const env = { ...process.env };
  delete env.VH_RPC_URL;
  delete env.AMOY_RPC_URL;
  delete env.VH_CONTRACT;
  delete env.VH_COMMITTER;
  delete env.PRIVATE_KEY;
  if (key !== undefined) env.PRIVATE_KEY = key;
  const res = spawnSync(process.execPath, [VH, ...args], {
    env,
    encoding: "utf8",
    timeout: 60000,
  });
  const stdout = res.stdout || "";
  const stderr = res.stderr || "";
  return { code: res.status, stdout, stderr, combined: stdout + stderr };
}

describe("cli: key hygiene on the tx-submitting verbs (T-75.1)", function () {
  // Each case spawns a fresh node process (~0.5s each incl. ethers load); give the suite room.
  this.timeout(120000);

  let dir; // fixture root: a real file to anchor/claim/commit/prove
  let file;
  let receiptDir;
  let missingReceipt;

  before(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-keyhyg-"));
    file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "key hygiene fixture content\n");
    receiptDir = path.join(dir, "receipts");
    missingReceipt = path.join(dir, "no-such-receipt.vhclaim.json");
  });

  after(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Every verb that turns PRIVATE_KEY into an on-chain signer, with argv that parses cleanly so
  // execution genuinely reaches the key-loading stage (the pre-fix leak point).
  const VERBS = [
    { name: "anchor", argv: () => ["anchor", file, "--contract", CONTRACT, "--rpc", DEAD_RPC] },
    {
      name: "claim",
      argv: () => ["claim", file, "--contract", CONTRACT, "--rpc", DEAD_RPC, "--receipt-dir", receiptDir],
    },
    {
      name: "commit",
      argv: () => ["commit", file, "--contract", CONTRACT, "--rpc", DEAD_RPC, "--receipt-dir", receiptDir],
    },
    { name: "reveal", argv: () => ["reveal", "--receipt", missingReceipt, "--rpc", DEAD_RPC] },
    {
      name: "prove --anchor",
      argv: () => ["prove", file, "--root", dir, "--anchor", "--contract", CONTRACT, "--rpc", DEAD_RPC],
    },
  ];

  describe("a malformed PRIVATE_KEY is rejected without echoing ANY key bytes", function () {
    // Pre-fix, every one of these printed `invalid BytesLike value (…, value="0xdeadbeef…\n", …)`
    // — the full key on stderr — so each assertion set FAILS on the pre-fix code.
    for (const verb of VERBS) {
      it(`vh ${verb.name}: exit 1, source-only message, zero key bytes in stdout+stderr`, function () {
        const r = runVh(verb.argv(), MALFORMED_KEY);

        // A runtime (not usage) failure…
        expect(r.code, `exit code for vh ${verb.name}\n--- output ---\n${r.combined}`).to.equal(1);

        // …that carries NONE of the key bytes: not the 0x form, not the trimmed body, not any
        // >=8-char fragment (the repeating marker makes fragments detectable).
        expect(r.combined, "output must not contain the raw key").to.not.include(MALFORMED_KEY);
        expect(r.combined, "output must not contain the trimmed key body").to.not.include(MAL_KEY_BODY);
        expect(r.combined, "output must not contain ANY >=8-char fragment of the key").to.not.include(
          MAL_MARKER
        );

        // …and names ONLY the source, with the loader's fixed, value-free message.
        expect(r.stderr).to.match(/env:PRIVATE_KEY/);
        expect(r.stderr).to.match(/not a valid private key/i);

        // ethers' value-echoing message shape must never surface verbatim.
        expect(r.stderr).to.not.match(/invalid BytesLike/i);
        expect(r.stderr).to.not.match(/\bvalue="/);
      });
    }
  });

  describe("a clean ephemeral key still WORKS: execution reaches the network-exit boundary", function () {
    // The `$(cat keyfile)` scenario: a VALID key with a trailing newline must be trimmed and
    // accepted (not rejected, not leaked), carrying each verb to the socket connect.
    for (const verb of VERBS.filter((v) => v.name !== "reveal")) {
      it(`vh ${verb.name}: clean key + trailing newline is trimmed, accepted, and dials the RPC`, function () {
        const r = runVh(verb.argv(), CLEAN_KEY + "\n");

        // The failure is the CLOSED LOOPBACK PORT — i.e. we got past key loading and wallet
        // construction all the way to the network-exit boundary.
        expect(r.code, `exit code for vh ${verb.name}\n--- output ---\n${r.combined}`).to.equal(1);
        expect(r.stderr).to.match(/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|connect|network/i);

        // No key complaint, no key bytes.
        expect(r.stderr).to.not.match(/private key|PRIVATE_KEY/i);
        expect(r.combined).to.not.include(CLEAN_MARKER);
      });
    }

    it("vh anchor: the exact clean key (no newline) behaves identically (positive control)", function () {
      const r = runVh(["anchor", file, "--contract", CONTRACT, "--rpc", DEAD_RPC], CLEAN_KEY);
      expect(r.code).to.equal(1);
      expect(r.stderr).to.match(/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|connect|network/i);
      expect(r.stderr).to.not.match(/private key|PRIVATE_KEY/i);
      expect(r.combined).to.not.include(CLEAN_MARKER);
    });

    it("vh reveal: a clean key gets PAST the signer stage (the failure names the receipt, not the key)", function () {
      // reveal validates its receipt AFTER the signer is built, so a missing receipt with a clean
      // key proves the key was trimmed + accepted; the error must name the receipt path only.
      const r = runVh(["reveal", "--receipt", missingReceipt, "--rpc", DEAD_RPC], CLEAN_KEY + "\n");
      expect(r.code).to.equal(1);
      expect(r.stderr).to.include(missingReceipt);
      expect(r.stderr).to.not.match(/private key|PRIVATE_KEY/i);
      expect(r.combined).to.not.include(CLEAN_MARKER);
    });
  });

  describe("scrubSigningError: value-echoing ethers messages are replaced wholesale", function () {
    const { scrubSigningError } = require("../cli/vh");

    it("replaces the BytesLike value-echo shape with a fixed, value-free string", function () {
      const leaky = new Error(
        `invalid BytesLike value (argument="value", value="0x${MAL_KEY_BODY}\\n", ` +
          `code=INVALID_ARGUMENT, version=6.17.0)`
      );
      const safe = scrubSigningError(leaky);
      expect(safe).to.not.include(MAL_MARKER);
      expect(safe).to.not.include("value=");
      expect(safe).to.match(/withheld/i); // the fixed string says WHY the detail is missing
      expect(safe).to.match(/PRIVATE_KEY/); // …and what to check (the source, never the value)
    });

    it("replaces ANY INVALID_ARGUMENT message with an embedded value= payload", function () {
      const leaky = new Error(
        'invalid private key (argument="privateKey", value="[ REDACTED ]", code=INVALID_ARGUMENT, version=6.17.0)'
      );
      expect(scrubSigningError(leaky)).to.not.include("value=");
    });

    it("passes network errors and revert reasons through untouched (failures stay diagnosable)", function () {
      const net = "connect ECONNREFUSED 127.0.0.1:1";
      expect(scrubSigningError(new Error(net))).to.equal(net);
      const revert = "execution reverted (unknown custom error)";
      expect(scrubSigningError(new Error(revert))).to.equal(revert);
    });

    it("tolerates non-Error throwables", function () {
      expect(scrubSigningError("plain string failure")).to.equal("plain string failure");
    });
  });

  describe("source ratchet: no raw Wallet-from-env construction can come back", function () {
    it("cli/vh.js never constructs `new ethers.Wallet(` directly (all signers go through the loader)", function () {
      const src = fs.readFileSync(VH, "utf8");
      // Comments in the file mention the forbidden pattern with the full
      // `new ethers.Wallet(process.env.PRIVATE_KEY)` spelling; actual constructions in the
      // pre-fix code were all `new ethers.Wallet(pk, provider)`. Ban that code shape outright.
      expect(src).to.not.match(/new ethers\.Wallet\(pk/);
      // And the env var is read in exactly ONE place: the hardened loadEnvSigner guard.
      const reads = src.match(/process\.env\.PRIVATE_KEY(?![A-Za-z0-9_])/g) || [];
      const codeReads = src
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .filter((l) => /process\.env\.PRIVATE_KEY(?![A-Za-z0-9_])/.test(l));
      expect(reads.length).to.be.at.least(1);
      expect(codeReads, "PRIVATE_KEY must be read only inside loadEnvSigner").to.have.length(1);
      expect(codeReads[0]).to.include('(process.env.PRIVATE_KEY || "").trim()');
    });
  });
});
