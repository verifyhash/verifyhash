"use strict";

// cli/revocation.js — the THIN I/O shell for `vh revocation publish` + `vh revocation verify` (EPIC-51 /
// T-51.3). ALL crypto/validation lives in the PURE core (cli/core/revocation.js, T-51.1); this layer ONLY
// parses argv, reads/writes files, and renders. There is NO new crypto, NO new scheme, NO new dependency
// here — `cmdRevocation` is the publish/verify CLI surface over `buildRevocation` / `verifyRevocation`.
//
// WHAT THIS SHIPS
//   `vh revocation publish --address <a> --reason <r> (--key-env <VAR>|--key-file <p>) [--superseded-by <a>]
//        [--revoked-at <ISO>] [--out <p>] [--json]`
//     MINTS a signed producer KEY REVOCATION — a vendor SIGNS, with the SAME key it signs its evidence/
//     licenses/cards with, a self-describing container marking that key's OWN `vendorAddress` revoked as of
//     `revokedAt` for a bounded `reason` (and OPTIONALLY naming a `supersededBy` successor). The mint is
//     REFUSED (a clean usage error, BEFORE any --out write) when the provisioned key does NOT control
//     --address — a key revokes ITSELF; a third party cannot revoke a key it does not control. Default
//     prints the revocation + writes NOTHING; --out writes a caller-chosen path (never cwd).
//   `vh revocation verify <revocation> [--signer <0xaddr>] [--json]`
//     OFFLINE / key-free / network-free: RECOVERS the signer from a signed revocation, confirms the
//     signature backs the claimed signer AND that the recovered signer IS the revocation's own
//     vendorAddress (the load-bearing SELF-CONTROL check), OPTIONALLY pins --signer, and prints the
//     reason/revokedAt/supersededBy + per-check PASS/FAIL. A forged/tampered/wrong-key revocation, or a
//     wrong --signer, is a clean REJECTED — never a silent pass.
//
// THE LOAD-BEARING POSTURE — a SIGNED CLAIM, NOT a trusted timestamp without P-3.
//   A revocation proves the KEY-HOLDER SAID "revoked as of D"; the `revokedAt` instant is the holder's
//   self-asserted instant, NOT a trusted wall-clock timestamp (it rides the human-owned timestamp
//   trust-root, STRATEGY.md P-3). The publish/verify paths LEAD with that caveat verbatim (the standing
//   REVOCATION/SIGNED_REVOCATION trust note the core exports), so the human + JSON boundary can never drift.

const fs = require("fs");
const path = require("path");
const coreAttestation = require("./core/attestation");
const coreRevocation = require("./core/revocation");
const { isAddress } = require("ethers");

// Exit contract shared with the rest of the family: 0 ok/ACCEPTED / 1 IO / 2 usage / 3 gate-fail (verify
// REJECTED). Mirrors cli/identity.js's EXIT so every gate reads the same.
const EXIT = Object.freeze({ OK: 0, IO: 1, USAGE: 2, FAIL: 3 });

// Real "now" as a canonical ISO-8601 UTC instant — the publish default clock, isolated + injectable
// (io.nowISO) so the command stays deterministic under test. revokedAt defaults to this when omitted.
function nowISO() {
  return new Date().toISOString();
}

// Parse `revocation publish` argv. EXACTLY-ONE-of key sources is enforced downstream by loadSigningWallet
// (so neither/both error key-free); the parser only collects flags. A flag without its value, or an unknown
// flag, is a usage error (e.usage=true) — a typo never silently changes the revocation. `publish` takes NO
// positional arguments (the address rides --address) so a stray positional is a clean usage error.
function parsePublishArgs(argv) {
  const opts = {
    address: undefined,
    reason: undefined,
    supersededBy: undefined,
    revokedAt: undefined,
    keyEnv: undefined,
    keyFile: undefined,
    out: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (flag) => {
      const v = argv[++i];
      if (v === undefined) {
        const e = new Error(`${flag} requires a value`);
        e.usage = true;
        throw e;
      }
      return v;
    };
    switch (a) {
      case "--address":
        opts.address = need("--address");
        break;
      case "--reason":
        opts.reason = need("--reason");
        break;
      case "--superseded-by":
        opts.supersededBy = need("--superseded-by");
        break;
      case "--revoked-at":
        opts.revokedAt = need("--revoked-at");
        break;
      case "--key-env":
        opts.keyEnv = need("--key-env");
        break;
      case "--key-file":
        opts.keyFile = need("--key-file");
        break;
      case "--out":
        opts.out = need("--out");
        break;
      case "--json":
        opts.json = true;
        break;
      default: {
        const e = new Error(`unknown flag: ${a} (revocation publish takes no positional arguments)`);
        e.usage = true;
        throw e;
      }
    }
  }
  return opts;
}

/**
 * `vh revocation publish` — MINT a signed key revocation. PURE core + the only I/O being the OPTIONAL --out
 * write (the signing is offline/key-free in the sense that the loop holds no key; the human's key lives ONLY
 * inside the in-process Wallet loadSigningWallet builds and is discarded).
 *
 * The mint is REFUSED (a clean usage error, BEFORE any write) when the provisioned key's address != --address
 * — a key revokes ITSELF; a third party cannot revoke a key it does not control. The output LEADS with the
 * trust line. Default prints the revocation + writes NOTHING; --out writes a caller-chosen path (never cwd).
 *
 * Exit: 0 ok / 2 usage (missing/invalid field, key-source error, key does not control --address) / 1 IO.
 */
async function runRevocationPublish(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  // Required fields up front (a missing one is a clean usage error, never a confusing core throw).
  if (opts.address == null) {
    writeErr(
      "error: `vh revocation publish` requires --address <0xaddr> (the vendor address the key revokes — itself)\n"
    );
    return EXIT.USAGE;
  }
  if (opts.reason == null) {
    writeErr(
      `error: \`vh revocation publish\` requires --reason <reason> (one of ${JSON.stringify(coreRevocation.REVOCATION_REASON_SET)})\n`
    );
    return EXIT.USAGE;
  }

  // Validate the --address SHAPE up front so a malformed address is a usage error (2), never a runtime throw
  // mid-mint. buildRevocationPayload also normalizes/validates, but failing fast here gives the clean exit-2
  // the contract promises. (isAddress accepts checksummed/lowercase 0x-addresses.)
  if (!isAddress(opts.address)) {
    writeErr(`error: invalid --address: ${opts.address} (expected a 20-byte 0x-hex address)\n`);
    return EXIT.USAGE;
  }
  // Same up-front shape check for the OPTIONAL --superseded-by successor (when given).
  if (opts.supersededBy !== undefined && !isAddress(opts.supersededBy)) {
    writeErr(
      `error: invalid --superseded-by: ${opts.supersededBy} (expected a 20-byte 0x-hex successor address)\n`
    );
    return EXIT.USAGE;
  }

  // Resolve the HUMAN-supplied key into an in-process Wallet FIRST — neither/both sources, a missing env var,
  // an unreadable file, or a malformed/zero key HARD-ERRORS here with a KEY-FREE message (the SAME core +
  // posture as `vh evidence seal --sign` / `vh identity publish`). The loop NEVER holds/generates/persists/
  // logs a key.
  let wallet;
  try {
    ({ wallet } = coreAttestation.loadSigningWallet({ keyEnv: opts.keyEnv, keyFile: opts.keyFile }));
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // revokedAt defaults to the injectable clock (a real ISO instant at runtime; a pinned one in tests).
  const revokedAt = opts.revokedAt != null ? opts.revokedAt : (io.nowISO || nowISO)();

  // Build + sign + enforce the self-control invariant in the PURE core. A malformed field (out-of-set reason,
  // non-canonical date, malformed successor) OR the key NOT controlling --address throws RevocationError — a
  // usage error (2), BEFORE any --out write. The message never includes the key.
  let container;
  try {
    container = await coreRevocation.buildRevocation(
      {
        vendorAddress: opts.address,
        reason: opts.reason,
        revokedAt,
        ...(opts.supersededBy !== undefined ? { supersededBy: opts.supersededBy } : {}),
      },
      wallet
    );
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  const canonical = coreRevocation.serializeSignedRevocation(container);
  const payload = JSON.parse(container.attestation);
  // The PUBLIC vendor address — recovered from the signature, never the key. By the self-control invariant it
  // equals payload.vendorAddress; we recover it to PROVE that (and to print "signed by" from the signature).
  const signedBy = coreAttestation.recoverSigner(container);

  // Write to --out (caller-chosen path; NEVER cwd) or print to stdout (writes nothing).
  let outAbs = null;
  if (opts.out) {
    outAbs = path.resolve(opts.out);
    try {
      fs.writeFileSync(outAbs, canonical);
    } catch (e) {
      writeErr(`error: cannot write --out file ${opts.out}: ${e.message}\n`);
      return EXIT.IO;
    }
  }

  if (opts.json) {
    // ONLY public fields: the vendor ADDRESS (recovered), the revocation summary, the path — NEVER the key.
    // With no --out the canonical bytes ride in `container` so --json never drops the artifact (family parity).
    write(
      JSON.stringify(
        {
          published: true,
          note: coreRevocation.REVOCATION_TRUST_NOTE,
          kind: coreRevocation.SIGNED_REVOCATION_KIND,
          vendorAddress: payload.vendorAddress,
          signer: signedBy,
          reason: payload.reason,
          revokedAt: payload.revokedAt,
          supersededBy: Object.prototype.hasOwnProperty.call(payload, "supersededBy")
            ? payload.supersededBy
            : null,
          out: outAbs,
          container: outAbs ? null : canonical,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(coreRevocation.REVOCATION_TRUST_NOTE + "\n\n");
    write(`published a signed key revocation for ${payload.vendorAddress} (signed by ${signedBy})\n`);
    write(`  reason:       ${payload.reason}\n`);
    write(`  revokedAt:    ${payload.revokedAt}\n`);
    if (Object.prototype.hasOwnProperty.call(payload, "supersededBy")) {
      write(`  supersededBy: ${payload.supersededBy}\n`);
    }
    if (outAbs) {
      write(`  written:      ${outAbs}\n`);
    } else {
      // Default: print the revocation bytes so a publisher can eyeball/redirect them — still writes nothing.
      write(canonical);
    }
  }
  return EXIT.OK;
}

// Parse `revocation verify` argv. Takes exactly one positional <revocation> + OPTIONAL --signer/--json. A
// flag without its value, an unknown flag, or a second positional is a clean usage error.
function parseVerifyArgs(argv) {
  const opts = { revocation: undefined, signer: undefined, json: false, _positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (flag) => {
      const v = argv[++i];
      if (v === undefined) {
        const e = new Error(`${flag} requires a value`);
        e.usage = true;
        throw e;
      }
      return v;
    };
    switch (a) {
      case "--signer":
        opts.signer = need("--signer");
        break;
      case "--json":
        opts.json = true;
        break;
      default:
        if (a && a.startsWith("--")) {
          const e = new Error(`unknown flag: ${a}`);
          e.usage = true;
          throw e;
        }
        opts._positionals.push(a);
    }
  }
  if (opts._positionals.length > 1) {
    const e = new Error(
      `unexpected extra argument: ${opts._positionals[1]} (revocation verify takes exactly one <revocation>)`
    );
    e.usage = true;
    throw e;
  }
  opts.revocation = opts._positionals[0];
  return opts;
}

// The standing trust line the verify path LEADS with — reuses the SIGNED-revocation note verbatim (so the
// human + JSON caveats can NEVER drift). It is the load-bearing honesty of the read: an ACCEPT proves the
// KEY-HOLDER's SIGNED CLAIM, NOT a trusted timestamp (P-3), NOT a legal opinion.
const VERIFY_TRUST_NOTE = coreRevocation.SIGNED_REVOCATION_TRUST_NOTE;

// Render the human verify report. PURE. LEADS with the trust line, prints the verdict, the recovered/claimed/
// vendor address, the per-check PASS/FAIL (Check 1 + the SELF-CONTROL vendorAddress check ALWAYS; the
// --signer pin only when requested), then the revocation's reason/revokedAt/supersededBy. A REJECTED verdict
// NAMES the failing check(s).
function renderVerify(r, ctx) {
  const L = [];
  // TRUST FIRST.
  L.push("TRUST: " + VERIFY_TRUST_NOTE);
  L.push("");
  L.push(`# vh revocation verify — ${ctx.revocation}`);
  L.push(`revocation:       ${r.verdict}`);
  L.push(`scheme:           ${r.scheme}`);
  L.push(`vendorAddress:    ${r.vendorAddress}  (the address this key revokes — itself)`);
  L.push(`recovered signer: ${r.recoveredSigner}  (from the embedded canonical revocation bytes + signature)`);
  L.push(`claimed signer:   ${r.claimedSigner}  (the container's \`signer\` field)`);
  L.push(`reason:           ${r.reason}`);
  L.push(`revokedAt:        ${r.revokedAt}  (the holder's self-asserted instant — NOT a trusted timestamp without P-3)`);
  if (r.supersededBy) {
    L.push(`supersededBy:     ${r.supersededBy}`);
  }
  // Check 1 (ALWAYS): the signature recovers to the claimed signer.
  L.push(`  [${r.checks.signatureMatchesSigner ? "PASS" : "FAIL"}] signature recovers to the claimed signer`);
  // The load-bearing SELF-CONTROL check (ALWAYS): the recovered signer IS the revocation's own vendorAddress.
  L.push(
    `  [${r.checks.vendorAddressMatchesSigner ? "PASS" : "FAIL"}] the recovered signer IS the revocation's ` +
      "vendorAddress (a key revokes ITSELF; a third party cannot revoke a key it does not control)"
  );
  // Check 3 (only under --signer): the recovered signer equals the expected, out-of-band signer.
  if (r.checks.signerMatchesExpected === null) {
    L.push("  [skip] expected-signer pin: not requested (pass --signer <0xaddr> to pin the signer)");
  } else {
    L.push(
      `  [${r.checks.signerMatchesExpected ? "PASS" : "FAIL"}] recovered signer matches the expected ` +
        `signer (${r.expectedSigner})`
    );
  }
  if (r.accepted) {
    L.push(
      "ACCEPTED: every requested check passed — the key-holder SIGNED this revocation of the address it controls."
    );
  } else {
    L.push(`REJECTED: failed check(s): ${r.failedChecks.join(", ")}.`);
    if (r.failedChecks.includes("signatureMatchesSigner")) {
      L.push(
        "  forged/tampered: the signature does NOT recover to the claimed `signer` — this revocation is UNBACKED."
      );
    }
    if (r.failedChecks.includes("vendorAddressMatchesSigner")) {
      L.push(
        "  third-party: the recovered signer is NOT the revocation's vendorAddress — a key revokes ITSELF;"
      );
      L.push("  this revocation was NOT signed by the key it claims to revoke, so it never downgrades trust.");
    }
    if (r.failedChecks.includes("signerMatchesExpected")) {
      L.push(
        "  pin-mismatch: the signature is genuine but the signer is NOT the address you pinned with --signer."
      );
    }
  }
  L.push("");
  return L.join("\n");
}

/**
 * `vh revocation verify <revocation> [--signer <0xaddr>] [--json]` — OFFLINE / key-free / network-free.
 * RECOVERS the signer from a signed revocation and confirms (1) the signature backs the claimed signer,
 * (2) the recovered signer IS the revocation's own vendorAddress (the load-bearing self-control check), and
 * OPTIONALLY (3) pins it to an expected --signer. LEADS with the trust line; prints reason/revokedAt/
 * supersededBy + per-check PASS/FAIL. A forged/tampered/wrong-key revocation, or a wrong --signer, is a
 * clean REJECTED — NEVER a silent pass. Writes NOTHING. Exit: 0 ACCEPTED / 3 REJECTED / 2 usage / 1 IO.
 */
function runRevocationVerify(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.revocation) {
    writeErr("error: `vh revocation verify` requires a <revocation> (a signed key-revocation file path)\n");
    return EXIT.USAGE;
  }

  // Validate the --signer SHAPE up front (when given) so a malformed pin is a usage error (2), never a
  // runtime throw inside verifyRevocation (which normalizes via getAddress and would throw). OFFLINE.
  if (opts.signer !== undefined && opts.signer !== null) {
    if (!isAddress(opts.signer)) {
      writeErr(`error: invalid --signer address: ${opts.signer} (expected a 20-byte 0x-hex address)\n`);
      return EXIT.USAGE;
    }
  }

  // Read + STRICT-validate the container BEFORE any recovery — a malformed/edited/foreign container (or a
  // non-revocation file) hard-errors (exit 1), never half-accepted. A forged signature is NOT a parse error:
  // readRevocation proves the bytes are canonical; the recovery (the verdict) runs below in the PURE core.
  let container;
  try {
    const text = fs.readFileSync(path.resolve(opts.revocation), "utf8");
    container = coreRevocation.readRevocation(text);
  } catch (e) {
    writeErr(`error: cannot read signed key revocation ${opts.revocation}: ${e.message}\n`);
    return EXIT.IO;
  }

  // Run the PURE, OFFLINE verify. No I/O, no key, no network. A structurally-sound-but-forged/mismatched
  // revocation is a clean REJECTED verdict (not a throw); only a genuinely broken read would throw (above).
  let result;
  try {
    result = coreRevocation.verifyRevocation({ container, expectedSigner: opts.signer });
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  if (opts.json) {
    write(
      JSON.stringify(
        { ...result, revocation: opts.revocation, note: VERIFY_TRUST_NOTE },
        null,
        2
      ) + "\n"
    );
  } else {
    write(renderVerify(result, { revocation: opts.revocation }));
  }

  // Exit non-zero on REJECTED so a recipient's CI can gate (0 ACCEPTED / 3 REJECTED — the family's read contract).
  return result.accepted ? EXIT.OK : EXIT.FAIL;
}

function revocationUsage() {
  return [
    "vh revocation — publish + verify a producer KEY REVOCATION (a key declares ITSELF revoked as of a date)",
    "",
    "Usage:",
    "  vh revocation publish --address <0xaddr> --reason <reason> (--key-env <VAR> | --key-file <path>)",
    "        [--superseded-by <0xaddr>] [--revoked-at <ISO>] [--out <p>] [--json]",
    "  vh revocation verify <revocation> [--signer <0xaddr>] [--json]",
    "",
    "publish MINTS a signed revocation marking --address REVOKED as of --revoked-at (default now) for",
    "  --reason (one of " + JSON.stringify(coreRevocation.REVOCATION_REASON_SET) + "), optionally naming a",
    "  --superseded-by successor key. It signs with a HUMAN-provisioned key (EXACTLY ONE of --key-env/",
    "  --key-file, read-used-discarded; the loop sets/holds NO key) and MINTS ONLY when that key's address",
    "  EQUALS --address — a key revokes ITSELF; a third party cannot revoke a key it does not control (else",
    "  it hard-errors BEFORE writing). Default prints the revocation + writes NOTHING; --out writes to a",
    "  caller-chosen path (never cwd). Exit: 0 ok / 2 usage (missing/invalid field, key-source error, key",
    "  does not control --address) / 1 IO.",
    "verify is OFFLINE/key-free/network-free: it RECOVERS the signer, confirms the signature backs it AND that",
    "  the recovered signer IS the revocation's vendorAddress (a key revokes ITSELF), OPTIONALLY pins --signer,",
    "  and prints the reason/revokedAt/supersededBy + per-check PASS/FAIL. A forged/tampered/wrong-key",
    "  revocation, or a wrong --signer, is a clean REJECTED — never a silent pass. Exit: 0 ACCEPTED / 3",
    "  REJECTED / 2 usage / 1 IO.",
    "",
    "A revocation is a SIGNED CLAIM by the key-holder (it proves the key-holder SAID \"revoked as of D\"): the",
    "revokedAt instant is self-asserted, NOT a trusted TIMESTAMP without P-3, and this is NOT a legal opinion.",
    "Pin the revocation alongside your identity card; recipients pass it to any signed-verify command via",
    "--revocations <f> [--as-of <ISO>] to downgrade an exhibit signed under a key that was revoked-before-as-of.",
    "",
  ].join("\n");
}

/**
 * CLI dispatch: `vh revocation <publish|verify> ...`. An UNKNOWN subcommand is a USAGE error (2) — the loop
 * never silently accepts a typo'd subcommand. `-h`/`--help`/`help`/no-subcommand prints usage.
 */
async function cmdRevocation(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const [sub, ...rest] = argv;
  if (sub === "publish") {
    let opts;
    try {
      opts = parsePublishArgs(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    return runRevocationPublish(opts, io);
  }
  if (sub === "verify") {
    let opts;
    try {
      opts = parseVerifyArgs(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    return runRevocationVerify(opts, io);
  }
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    io.write ? io.write(revocationUsage()) : process.stdout.write(revocationUsage());
    return sub === undefined ? EXIT.USAGE : EXIT.OK;
  }
  writeErr(`error: unknown revocation subcommand: ${sub} (expected: publish, verify)\n`);
  return EXIT.USAGE;
}

module.exports = {
  EXIT,
  nowISO,
  VERIFY_TRUST_NOTE,
  parsePublishArgs,
  parseVerifyArgs,
  runRevocationPublish,
  runRevocationVerify,
  renderVerify,
  revocationUsage,
  cmdRevocation,
};
