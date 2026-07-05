#!/usr/bin/env node
"use strict";

// scripts/vendor-provenance.cjs — T-73.5 (EPIC-73, Lever 2): the VENDOR SELF-PROVENANCE packet
// builder. The provenance vendor's own package must carry the provenance it sells — an empty
// registry and an unpinned vendor identity is the "disqualifying irony" the review panel named.
//
// WHAT IT DOES (fully OFFLINE; node-core only; every crypto step is a SPAWN of the shipped CLIs)
//   1. `npm pack --pack-destination <tmpdir>` — pack THIS repo's working tree into the local
//      release tarball (no registry access; scripts disabled).
//   2. Compute the tarball's sha256 + sha512-SRI (node:crypto) and its keccak256 digest via the
//      shipped `vh hash`.
//   3. Mint a SELF-ISSUED evidence license with the CALLER-SUPPLIED key env via the shipped
//      `vh evidence license fulfill` (dogfood: the paid gate we sell is the paid gate we pass).
//   4. Assemble the evidence payload dir: the tarball + an IDENTITY.json statement naming the
//      vendor address derived from the caller's key, the package name/version from package.json,
//      the git commit packed, and both digests — stated EXPLICITLY as digests of THIS locally
//      packed tarball, NEVER asserted equal to the npm registry's artifact.
//   5. `vh evidence seal <payload> --sign` -> the SIGNED container, then write the container's
//      embedded canonical `attestation` bytes verbatim as the UNSIGNED `vh.evidence-seal` packet —
//      so BOTH artifacts commit to the ONE same root (byte-for-byte the signed-over bytes).
//      The UNSIGNED seal is the anchorable one: it is the only evidence kind in `vh
//      anchor-artifact`'s closed table (anchoring the signed container is an unknown-kind reject).
//   6. Self-check through the shipped verifiers (`vh evidence verify` on both artifacts,
//      `vh evidence verify-signed` pinned to the derived vendor address) — all offline.
//   7. PRINT (never run) the exact anchor command + the numbered HUMAN-STEP block.
//
// WHAT IT NEVER DOES (the boundary, exactly)
//   - It NEVER touches the network: no registry read, no RPC, no anchor. `npm pack` packs the
//     LOCAL tree; the anchor command is PRINTED for a human, never executed.
//   - It NEVER reads, prints, or persists key material: the caller supplies an ENV VAR NAME
//     (--key-env) and only that NAME is passed to the shipped CLIs, whose one read-used-discarded
//     path holds the key in-process. This script presence-checks the var and never reads its value.
//   - It NEVER claims the local tarball equals the npm registry's artifact. Confirming that is
//     HUMAN STEP 1 (network). The identity statement is SELF-asserted: the seal proves WHAT bytes
//     and WHO signed — never WHEN — and pins nothing until the vendor address is PUBLISHED on an
//     authoritative channel (HUMAN STEP 4). A later on-chain anchor of the UNSIGNED seal proves
//     existence no-later-than the anchoring block's timestamp (HUMAN STEP 3).
//
// USAGE
//   node scripts/vendor-provenance.cjs --key-env <VAR> --out <dir>
//     --key-env <VAR>  env var holding the vendor signing key (the CLIs read it; this script
//                      never does). Rehearse with a THROWAWAY key; re-run with the real vendor
//                      key as HUMAN STEP 2.
//     --out <dir>      output dir for the packet (created; must not already contain files).
//   Exit: 0 built + self-verified / 2 usage / 1 IO or a failed step.

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const VH = path.join(REPO, "cli", "vh.js");
const NODE = process.execPath;

const EXIT = Object.freeze({ OK: 0, IO: 1, USAGE: 2 });

// The live registry + public RPC the HUMAN anchors through (printed only — never dialed here).
const ANCHOR_CONTRACT = "0x77d8eF881D5aeEda64788968D13f9146fE1A609B";
const ANCHOR_RPC = "https://polygon-bor-rpc.publicnode.com";

// The self-issued license plan (bundled catalog): the smallest plan carrying `evidence_signed`.
const PLAN_ID = "evidence-signed-monthly";

const USAGE = "usage: node scripts/vendor-provenance.cjs --key-env <VAR> --out <dir>\n";

function fail(msg, code) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

/** Spawn a command; on nonzero exit, fail(1) naming the step (never echoing env values). */
function run(step, cmd, args, opts) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", ...opts });
  if (r.error) fail(`${step}: ${r.error.message}`, EXIT.IO);
  if (r.status !== 0) {
    fail(`${step} failed (exit ${r.status}):\n${(r.stderr || r.stdout || "").trim()}`, EXIT.IO);
  }
  return r;
}

/** Spawn the shipped vh CLI (the ONLY way this script does crypto). */
function vh(step, args) {
  return run(step, NODE, [VH, ...args]);
}

function parseArgs(argv) {
  const opts = { keyEnv: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined || String(v).startsWith("--")) {
        fail(`${a} requires a value\n${USAGE}`, EXIT.USAGE);
      }
      return v;
    };
    switch (a) {
      case "--key-env": opts.keyEnv = need(); break;
      case "--out": opts.out = need(); break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(EXIT.OK);
        break;
      default:
        fail(`unknown argument: ${a}\n${USAGE}`, EXIT.USAGE);
    }
  }
  if (!opts.keyEnv) fail(`--key-env <VAR> is required\n${USAGE}`, EXIT.USAGE);
  if (!opts.out) fail(`--out <dir> is required\n${USAGE}`, EXIT.USAGE);
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Presence-check ONLY — the key VALUE is never read into this process's variables.
  if (!Object.prototype.hasOwnProperty.call(process.env, opts.keyEnv) || process.env[opts.keyEnv] === "") {
    fail(`the --key-env variable ${opts.keyEnv} is not set (this script never reads its value; the shipped CLIs do)`, EXIT.IO);
  }

  const outDir = path.resolve(opts.out);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    fail(`--out dir ${outDir} already contains files; refusing to mix a packet into it`, EXIT.IO);
  }
  const payloadDir = path.join(outDir, "payload");
  fs.mkdirSync(payloadDir, { recursive: true });

  // ---- package + git facts (all local; git never talks to a remote here) ----
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  const gitCommit = run("git rev-parse HEAD", "git", ["rev-parse", "HEAD"]).stdout.trim();
  const gitDirty = run("git status --porcelain", "git", ["status", "--porcelain"]).stdout.trim() !== "";

  // ---- 1. pack the LOCAL tree (no registry access; lifecycle scripts disabled) ----
  const packDest = fs.mkdtempSync(path.join(os.tmpdir(), "vh-vendor-pack-"));
  const packEnv = { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false", NO_UPDATE_NOTIFIER: "1" };
  const packOut = run(
    "npm pack (local tree; offline)",
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", packDest],
    { env: packEnv }
  ).stdout.trim();
  const tarballName = packOut.split("\n").filter(Boolean).pop();
  const tarballTmp = path.join(packDest, tarballName);
  if (!fs.existsSync(tarballTmp)) fail(`npm pack reported ${tarballName} but it was not written`, EXIT.IO);

  // ---- 2. digests of THIS locally packed tarball (sha256/sha512-SRI here; keccak via `vh hash`) ----
  const tarBytes = fs.readFileSync(tarballTmp);
  const sha256 = crypto.createHash("sha256").update(tarBytes).digest("hex");
  const sha512Sri = "sha512-" + crypto.createHash("sha512").update(tarBytes).digest("base64");
  const hashOut = vh("vh hash <tarball>", ["hash", tarballTmp]).stdout;
  const keccakMatch = hashOut.match(/0x[0-9a-f]{64}/);
  if (!keccakMatch) fail("`vh hash` printed no keccak digest", EXIT.IO);
  const keccak256 = keccakMatch[0];

  // ---- 3. self-issued license (dogfood: the paid `evidence_signed` gate we sell) ----
  const licensePath = path.join(outDir, "vendor-license.vhevidence-license.json");
  const fulfillOut = vh("vh evidence license fulfill", [
    "evidence", "license", "fulfill",
    "--plan", PLAN_ID,
    "--customer", `${pkg.name} vendor (self-issued vendor provenance)`,
    "--key-env", opts.keyEnv,
    "--out", licensePath,
    "--json",
  ]).stdout;
  // The vendor address DERIVED from the caller-supplied key — recovered from the license
  // signature by the shipped CLI, never computed here (this script holds no key material).
  const vendorAddress = JSON.parse(fulfillOut).vendor;
  if (!/^0x[0-9a-f]{40}$/.test(vendorAddress)) fail("fulfill did not report a vendor address", EXIT.IO);

  // ---- 4. the payload dir: tarball + the SELF-ASSERTED identity statement ----
  fs.copyFileSync(tarballTmp, path.join(payloadDir, tarballName));
  const identity = {
    kind: "vh.vendor-provenance-identity",
    schemaVersion: 1,
    statement:
      `The vendor signing address ${vendorAddress} self-asserts: it packed and sealed the ` +
      `${pkg.name}@${pkg.version} release tarball named below from the git commit named below. ` +
      "This statement is SELF-ASSERTED identity, not proof: the enclosing evidence seal proves " +
      "WHAT bytes were sealed and (once signed) WHO signed the packet — never WHEN. A later " +
      "on-chain anchor of the UNSIGNED seal proves the packet existed no-later-than the anchoring " +
      "block's timestamp. This address pins nothing until it is PUBLISHED on an authoritative " +
      "channel (README / verifyhash.com); publication is a human step outside this packet.",
    vendorAddress,
    package: { name: pkg.name, version: pkg.version },
    git: { commit: gitCommit, dirtyWorkingTree: gitDirty },
    tarball: {
      file: tarballName,
      sha256,
      sha512Sri,
      keccak256,
      scope:
        "These are digests of THIS LOCALLY PACKED tarball (npm pack of the working tree at the " +
        "commit above) ONLY. They are NOT asserted to equal the npm registry's published artifact. " +
        "Confirming registry equality requires the network (`npm view " + pkg.name + " dist.integrity` " +
        "vs sha512Sri above) and is a HUMAN step; on mismatch, re-pack from the published tag.",
    },
  };
  fs.writeFileSync(path.join(payloadDir, "IDENTITY.json"), JSON.stringify(identity, null, 2) + "\n");

  // ---- 5. seal: ONE signing pass -> the SIGNED container; its embedded canonical `attestation`
  //         bytes ARE the UNSIGNED `vh.evidence-seal` packet (same root, byte-for-byte) ----
  const signedPath = path.join(outDir, "vendor-provenance.signed.vhevidence.json");
  const unsignedPath = path.join(outDir, "vendor-provenance.vhevidence.json");
  vh("vh evidence seal --sign", [
    "evidence", "seal", payloadDir,
    "--sign",
    "--key-env", opts.keyEnv,
    "--license", licensePath,
    "--vendor", vendorAddress,
    "--out", signedPath,
  ]);
  const signedContainer = JSON.parse(fs.readFileSync(signedPath, "utf8"));
  if (typeof signedContainer.attestation !== "string") {
    fail("signed container carries no embedded canonical attestation string", EXIT.IO);
  }
  fs.writeFileSync(unsignedPath, signedContainer.attestation);
  const unsignedSeal = JSON.parse(signedContainer.attestation);
  if (unsignedSeal.kind !== "vh.evidence-seal" || unsignedSeal.root !== JSON.parse(fs.readFileSync(unsignedPath, "utf8")).root) {
    fail("unsigned seal extraction did not round-trip", EXIT.IO);
  }

  // ---- 6. self-check through the SHIPPED verifiers (all offline, key-free) ----
  vh("self-check: vh evidence verify (unsigned seal)", ["evidence", "verify", unsignedPath, "--dir", payloadDir]);
  vh("self-check: vh evidence verify (signed container)", ["evidence", "verify", signedPath, "--dir", payloadDir]);
  vh("self-check: vh evidence verify-signed --signer", [
    "evidence", "verify-signed", signedPath, "--dir", payloadDir, "--signer", vendorAddress,
  ]);

  // ---- 7. report + the PRINTED-ONLY anchor command + the numbered HUMAN-STEP block ----
  const receiptPath = path.join(outDir, "vendor-provenance.anchored-receipt.json");
  const anchorCmd =
    `vh anchor-artifact ${unsignedPath} --contract ${ANCHOR_CONTRACT} --rpc ${ANCHOR_RPC} ` +
    `--key-env ${opts.keyEnv} --out ${receiptPath} --i-understand-mainnet`;

  const w = (s) => process.stdout.write(s);
  w("vendor self-provenance packet built + self-verified (all offline; nothing anchored, nothing published)\n\n");
  w(`  package:        ${pkg.name}@${pkg.version}\n`);
  w(`  git commit:     ${gitCommit}${gitDirty ? " (DIRTY working tree — the pack is of the tree, not the commit)" : ""}\n`);
  w(`  vendor address: ${vendorAddress} (derived from --key-env ${opts.keyEnv}; SELF-asserted until published)\n`);
  w(`  tarball:        ${tarballName} (LOCALLY packed — not asserted equal to the npm registry's artifact)\n`);
  w(`    sha256:       ${sha256}\n`);
  w(`    sha512-SRI:   ${sha512Sri}\n`);
  w(`    keccak256:    ${keccak256} (vh hash)\n`);
  w(`  payload dir:    ${payloadDir}\n`);
  w(`  UNSIGNED seal:  ${unsignedPath} (kind vh.evidence-seal — the ANCHORABLE artifact)\n`);
  w(`  SIGNED packet:  ${signedPath} (kind vh.evidence-seal-signed — same root; NOT anchorable: unknown-kind to anchor-artifact)\n`);
  w(`  license:        ${licensePath} (self-issued via vh evidence license fulfill — dogfood)\n\n`);
  w("ANCHOR COMMAND (printed only — this script NEVER anchors, spends, or dials any endpoint):\n");
  w(`  ${anchorCmd}\n\n`);
  w("HUMAN STEPS (in order; the script did NONE of these):\n");
  w(`  1. Confirm the LOCAL tarball digest against the PUBLISHED artifact (network, human-only):\n`);
  w(`       npm view ${pkg.name} dist.integrity\n`);
  w(`     and compare it to this run's sha512-SRI above. On mismatch, re-pack from the published\n`);
  w(`     tag (git checkout the released tag, re-run this script) — this script never claims\n`);
  w(`     registry equality; it only ever states digests of the tarball it packed locally.\n`);
  w(`  2. Re-run this script with the REAL vendor key (this run's key is whatever ${opts.keyEnv} held):\n`);
  w(`       node scripts/vendor-provenance.cjs --key-env <REAL_VENDOR_KEY_ENV> --out <fresh-dir>\n`);
  w(`  3. Anchor the UNSIGNED seal (gas is yours; mainnet write — hence --i-understand-mainnet):\n`);
  w(`       ${anchorCmd}\n`);
  w(`  4. Publish the vendor address + the SIGNED packet on an authoritative channel\n`);
  w(`     (README / verifyhash.com). The identity statement is SELF-asserted: pinning is only\n`);
  w(`     real once the address is published where buyers already look.\n`);
  process.exit(EXIT.OK);
}

main();
