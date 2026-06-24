"use strict";

// cli/evidence.js — the EVIDENCE PACKET command (T-30.3): a product-AGNOSTIC, license-gated,
// tamper-evident evidence packet built ENTIRELY on the extracted shared cores.
//
// THE PRODUCT (the SECOND vertical on the provenance core).
//   `vh evidence seal <dir>` walks a directory and binds the WHOLE file set into ONE content-addressed
//   `*.vhevidence.json` packet over the GENERIC `cli/core/packetseal.js` core. `vh evidence verify <p>`
//   RE-DERIVES the root from the bytes referenced and localizes any tamper to the exact file (MATCH /
//   CHANGED / MISSING / UNEXPECTED). It is product-agnostic: there is NO trust-reconcile vocabulary
//   (no verdict / role / period header) — the seal commits ONLY to (relPath, content) pairs. The seal
//   therefore reuses the seal core with NO header (the optional binding seam of packetseal stays unused).
//
// FREE vs PAID.
//   The FREE tier — an UNSIGNED baseline seal + verify over a free SAMPLE size — stays open so a buyer
//   can try before buying. The PAID surface is GATED behind a valid `--license <f> --vendor <addr>`,
//   verified OFFLINE via `cli/core/license.js` against a NEW, distinct EVIDENCE-PRODUCT entitlement table
//   (its OWN `kind`, NOT `trustledger-license` — a separate sellable product). The paid surface is:
//     * `evidence_signed`   — wrap the seal in a signed attestation (a vendor/operator vouches for it);
//     * `evidence_unlimited`— seal MORE than the free SAMPLE_LIMIT files in one packet.
//   The gate reuses the SAME verifyLicense / named-reject posture as the TrustLedger CLI.
//
// TRUST-BOUNDARIES (the one-liner the output LEADS with).
//   The seal proves TAMPER-EVIDENCE + OFFLINE-RECOMPUTE, NOT a trusted timestamp: "sealed at T" still
//   rides the human-owned signing/timestamp trust-root (STRATEGY.md P-3). The packet is an UNTRUSTED
//   transport container — verify RE-DERIVES the root from the bytes you hold, never the packet's own
//   stored hashes. A signed wrap proves WHO vouched, still not WHEN.
//
// PURE CORES + a THIN CLI. All hashing / root math / signing lives in the shared cores; this file is the
// product framing (the seal/license cfgs) plus the I/O-bearing CLI run functions.

const fs = require("fs");
const path = require("path");

const packetseal = require("./core/packetseal");
const coreLicense = require("./core/license");
const coreAttestation = require("./core/attestation");
const { listFiles, hashBytes } = require("./hash");

// Exit contract (shared with the rest of the family): 0 ok / 1 IO / 2 usage / 3 gate-fail (seal-build /
// verify REJECTED). Mirrors trustledger/cli.js's EXIT so every gate reads the same.
const EXIT = Object.freeze({ OK: 0, IO: 1, USAGE: 2, FAIL: 3 });

// ---------------------------------------------------------------------------
// THE EVIDENCE SEAL product framing — handed to cli/core/packetseal.js. A GENERIC product `kind`
// (no trust-reconcile vocabulary), NO header (the seal binds ONLY the file set). The core does ALL the
// hashing / root / per-file localization; this just names the product.
// ---------------------------------------------------------------------------

const SEAL_KIND = "vh.evidence-seal";
const SEAL_SCHEMA_VERSION = 1;
const SUPPORTED_SEAL_SCHEMA_VERSIONS = Object.freeze([1]);

// The free SAMPLE size: how many files an UNLICENSED packet may seal. Sealing more requires the
// `evidence_unlimited` paid entitlement (try-before-you-buy: a small packet is free).
const SAMPLE_LIMIT = 25;

// The TRUST-BOUNDARIES one-liner the output LEADS with — stated ONCE so the human + JSON paths agree and
// the caveat can never drift. It is the load-bearing honesty of the artifact.
const EVIDENCE_TRUST_NOTE =
  "This evidence seal is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp. Its Merkle " +
  "`root` commits to the full set of (relPath, content) pairs in the directory: any edit, rename, add, " +
  "or remove changes the root, and verify RE-DERIVES the root from the bytes you hold and LOCALIZES the " +
  "change to the exact file (MATCH / CHANGED / MISSING / UNEXPECTED). It does NOT prove WHEN the sealing " +
  'happened ("sealed at T" rides the human-owned signing/timestamp trust-root, STRATEGY.md P-3) and it ' +
  "is NOT a legal opinion. The packet is an UNTRUSTED transport container: verify never trusts the " +
  "packet's own stored hashes.";

const SEAL_CFG = Object.freeze({
  kind: SEAL_KIND,
  schemaVersion: SEAL_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_SEAL_SCHEMA_VERSIONS,
  note: EVIDENCE_TRUST_NOTE,
  label: "evidence seal",
  // NO header: a product-agnostic, file-only seal (the optional packetseal binding seam stays unused).
});

// ---------------------------------------------------------------------------
// THE EVIDENCE LICENSE product framing — handed to cli/core/license.js. A NEW, DISTINCT product `kind`
// (`vh-evidence-license`), NOT `trustledger-license`: a separate sellable product with its OWN closed
// entitlement table. The license core does ALL the crypto via the shared attestation envelope.
// ---------------------------------------------------------------------------

const LICENSE_KIND = "vh-evidence-license";
const LICENSE_SCHEMA_VERSION = 1;
const SUPPORTED_LICENSE_SCHEMA_VERSIONS = Object.freeze([1]);

// THE CLOSED ENTITLEMENT TABLE for the EVIDENCE product. Disjoint from TrustLedger's. An unknown flag is
// a hard build error in the core (never silently honored).
const ENTITLEMENTS = Object.freeze({
  evidence_signed:
    "Wrap an evidence seal in a signed attestation (a vendor/operator vouches for the sealed packet).",
  evidence_unlimited:
    `Seal more than the free sample size (${SAMPLE_LIMIT} files) in one evidence packet.`,
});

const LICENSE_TRUST_NOTE =
  "This verifyhash EVIDENCE license is a SIGNED entitlement token, verified OFFLINE by re-deriving the " +
  "signer from these exact bytes and pinning it to the evidence-product vendor key. A valid verdict " +
  "proves the vendor signed THESE entitlements for THIS customer within [issuedAt, expiresAt]; it is an " +
  "UNTRUSTED transport container (verifyLicense never trusts the file's own claims), it is NOT a trusted " +
  "timestamp (issuedAt/expiresAt are self-asserted and ride the vendor key custody, STRATEGY.md P-3), " +
  "and it is NOT the legal subscription agreement (which governs). It gates the evidence product's PAID " +
  "surface; it never replaces the contract.";

const SIGNED_LICENSE_KIND = "vh-evidence-license-signed";
const SIGNED_LICENSE_SCHEMA_VERSION = 1;
const SUPPORTED_SIGNED_LICENSE_SCHEMA_VERSIONS = Object.freeze([1]);

const SIGNED_LICENSE_TRUST_NOTE =
  "This is a SIGNED verifyhash EVIDENCE license container: it WRAPS (never edits) the EXACT canonical " +
  "license bytes in `attestation` and attaches a detached EIP-191 signature. verifyLicense RE-DERIVES " +
  "the signer from those bytes and pins it to the vendor key — it never trusts the file's own claims. " +
  "Every caveat of the embedded license applies. " +
  LICENSE_TRUST_NOTE;

// A dedicated error type so callers/tests catch ONE evidence-license error.
class EvidenceLicenseError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvidenceLicenseError";
  }
}

const LICENSE_CFG = Object.freeze({
  // unsigned license payload framing
  kind: LICENSE_KIND,
  schemaVersion: LICENSE_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_LICENSE_SCHEMA_VERSIONS,
  note: LICENSE_TRUST_NOTE,
  entitlements: ENTITLEMENTS,
  // signed-container framing
  signedKind: SIGNED_LICENSE_KIND,
  signedSchemaVersion: SIGNED_LICENSE_SCHEMA_VERSION,
  supportedSignedSchemaVersions: SUPPORTED_SIGNED_LICENSE_SCHEMA_VERSIONS,
  signedNote: SIGNED_LICENSE_TRUST_NOTE,
  signedLabel: "signed verifyhash evidence license",
  ErrorClass: EvidenceLicenseError,
});

// Thin license adapters bound to the evidence CFG (so callers/tests need no cfg).
function buildLicense(params, signer) {
  return coreLicense.buildLicense(params, signer, LICENSE_CFG);
}
function readLicense(input) {
  return coreLicense.readLicense(input, LICENSE_CFG);
}
function verifyLicense(container, opts) {
  if (opts == null || typeof opts !== "object" || Array.isArray(opts)) {
    throw new EvidenceLicenseError("verifyLicense requires an options object { now, vendorAddress }");
  }
  return coreLicense.verifyLicense(container, {
    now: opts.now,
    vendorAddress: opts.vendorAddress,
    cfg: LICENSE_CFG,
  });
}
function hasEntitlement(verdict, flag) {
  return coreLicense.hasEntitlement(verdict, flag);
}

// ---------------------------------------------------------------------------
// THE SEAL build / validate / verify — thin wrappers binding SEAL_CFG to the GENERIC packetseal core.
// ---------------------------------------------------------------------------

/** Build a bare evidence seal from a flat { relPath, bytes } entry list. PURE. */
function buildSeal(entries) {
  return packetseal.buildSeal({ files: { entries } }, SEAL_CFG);
}

/** STRICT structural + root re-derivation validation. Throws PacketSealError on the first problem. */
function validateSeal(obj) {
  return packetseal.validateSeal(obj, SEAL_CFG);
}

/** Serialize a validated seal to canonical, byte-deterministic bytes (newline-terminated). */
function serializeSeal(seal) {
  validateSeal(seal);
  const canonical = {
    kind: seal.kind,
    schemaVersion: seal.schemaVersion,
    note: seal.note,
    root: seal.root,
    fileCount: seal.fileCount,
    files: seal.files.map((e) => ({
      relPath: e.relPath,
      contentHash: e.contentHash,
      leaf: e.leaf,
    })),
  };
  return JSON.stringify(canonical) + "\n";
}

/** Parse + strictly validate a seal (JSON string or object). A parse error is a PacketSealError. */
function readSeal(input) {
  let obj;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new packetseal.PacketSealError(`evidence seal is not valid JSON: ${e.message}`);
    }
  } else if (input != null && typeof input === "object" && !Array.isArray(input)) {
    obj = input;
  } else {
    throw new packetseal.PacketSealError("readSeal requires a JSON string or a seal object");
  }
  validateSeal(obj);
  return obj;
}

/** The AUTHORITATIVE, PURE verify — recompute per-file + root from the supplied { relPath, bytes } set. */
function verifySeal(seal, entries) {
  return packetseal.verifySeal(seal, { entries }, SEAL_CFG);
}

// ---------------------------------------------------------------------------
// SIGNED-attestation WRAP (the PAID `evidence_signed` surface). The seal's CANONICAL bytes become the
// attestation payload — the SAME shared signing path the rest of the family uses (no new scheme).
// ---------------------------------------------------------------------------

const SIGNED_SEAL_KIND = "vh.evidence-seal-signed";
const SIGNED_SEAL_SCHEMA_VERSION = 1;
const SUPPORTED_SIGNED_SEAL_SCHEMA_VERSIONS = Object.freeze([1]);

const SIGNED_SEAL_TRUST_NOTE =
  "This is a SIGNED evidence-seal container: it WRAPS (never edits) the EXACT canonical seal bytes in " +
  "`attestation` and attaches a detached EIP-191 signature. It asserts the holder of the `signer` key " +
  "vouched for THIS sealed packet (the embedded root) at signing time. It does NOT prove a timestamp " +
  '(no "sealed since T" — still the human trust-root P-3) and is NOT a legal opinion. Every caveat of ' +
  "the embedded seal applies. " +
  EVIDENCE_TRUST_NOTE;

const SIGNED_SEAL_CFG = Object.freeze({
  kind: SIGNED_SEAL_KIND,
  schemaVersion: SIGNED_SEAL_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_SIGNED_SEAL_SCHEMA_VERSIONS,
  note: SIGNED_SEAL_TRUST_NOTE,
  label: "signed evidence seal",
  validateUnsigned: validateSeal,
  serializeUnsigned: serializeSeal,
});

/** Sign a validated seal with a caller-supplied ethers signer-like object and WRAP it. */
async function signSealWith(seal, signer) {
  return coreAttestation.signAttestation({ attestation: seal, signer }, SIGNED_SEAL_CFG);
}

/** Strictly validate a parsed SIGNED-seal container. */
function validateSignedSeal(obj) {
  return coreAttestation.validateSignedAttestation(obj, SIGNED_SEAL_CFG);
}

/** Verify a SIGNED-seal container OFFLINE (recover the signer; optionally pin/bind). */
function verifySignedSeal(params) {
  return coreAttestation.verifySignedAttestation(params);
}

// ---------------------------------------------------------------------------
// I/O HELPERS — the only filesystem-touching code. Walk a directory into the flat { relPath, bytes }
// entry list the seal core consumes, REUSING cli/hash.js's listFiles (the SAME path-bound enumeration
// `vh hash <dir>` / `vh dataset build` use — no new walk).
// ---------------------------------------------------------------------------

/**
 * Load a directory into a sorted [{ relPath, bytes }] list. relPath is POSIX-normalized + relative to
 * `dirAbs` (the SAME convention the manifest core records), so the seal travels with the directory. PURE
 * except for the file reads.
 */
function loadDirEntries(dirAbs) {
  const files = listFiles(dirAbs); // recursive; skips sockets/fifos/symlinks (no stable hash)
  const entries = files.map((abs) => {
    const rel = path.relative(dirAbs, abs).split(path.sep).join("/");
    return { relPath: rel, bytes: fs.readFileSync(abs) };
  });
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return entries;
}

// ---------------------------------------------------------------------------
// `vh evidence seal <dir> [--out <p>] [--license <f> --vendor <addr>]`
//
// Walks <dir>, builds the *.vhevidence.json seal, and either prints it (default; writes NOTHING) or
// writes it to --out. NEVER writes to cwd without --out. The PAID surface (signed wrap, or sealing more
// than the free SAMPLE_LIMIT) is GATED behind a valid --license/--vendor verified OFFLINE. The output
// LEADS with the TRUST-BOUNDARIES one-liner. Exit: 0 ok / 3 seal-build-error / 2 usage / 1 IO.
// ---------------------------------------------------------------------------

function parseSealArgs(argv) {
  const opts = {
    dir: undefined,
    out: undefined,
    license: undefined,
    vendor: undefined,
    sign: false,
    keyEnv: undefined,
    keyFile: undefined,
    json: false,
    _positionals: [],
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
      case "--out":
        opts.out = need("--out");
        break;
      case "--license":
        opts.license = need("--license");
        break;
      case "--vendor":
        opts.vendor = need("--vendor");
        break;
      case "--sign":
        opts.sign = true;
        break;
      case "--key-env":
        opts.keyEnv = need("--key-env");
        break;
      case "--key-file":
        opts.keyFile = need("--key-file");
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
      `unexpected extra argument: ${opts._positionals[1]} (evidence seal takes exactly one <dir>)`
    );
    e.usage = true;
    throw e;
  }
  opts.dir = opts._positionals[0];
  return opts;
}

// The license GATE for the paid evidence surfaces. Returns { ok, code?, verdict? }: a clean { ok:true }
// when NO paid surface is requested (FREE tier, no license needed), else REQUIRES a VALID, vendor-pinned
// license carrying the matching entitlement and reports the precise verifyLicense reason on reject. The
// reject NEVER silently downgrades to a free run. `now` dates the window check.
function gatePaid(opts, requested, now, writeErr) {
  if (requested.length === 0) {
    return { ok: true, verdict: null }; // FREE tier
  }
  const featureList = requested.map((r) => r.label).join(" and ");

  const hasLicense = opts.license != null;
  const hasVendor = opts.vendor != null;
  if (!hasLicense && !hasVendor) {
    writeErr(
      `error: ${featureList} ${requested.length > 1 ? "are" : "is"} a PAID surface and ` +
        "requires a license; pass --license <file> --vendor <0xaddr>. " +
        `The FREE tier — an unsigned baseline seal of up to ${SAMPLE_LIMIT} files + verify — needs no license.\n`
    );
    return { ok: false, code: EXIT.USAGE };
  }
  if (hasLicense !== hasVendor) {
    writeErr(
      "error: --license and --vendor must be supplied together (a license file is verified by " +
        "pinning it to the vendor key); pass BOTH --license <file> --vendor <0xaddr>\n"
    );
    return { ok: false, code: EXIT.USAGE };
  }

  // Read the license OFFLINE (an unreadable/garbled file is a usage error; there is no key in a license).
  let container;
  try {
    const text = fs.readFileSync(path.resolve(opts.license), "utf8");
    container = readLicense(text);
  } catch (e) {
    writeErr(`error: cannot read --license file ${opts.license}: ${e.message}\n`);
    return { ok: false, code: EXIT.USAGE };
  }

  // Verify OFFLINE against the pinned vendor. A malformed --vendor is thrown by verifyLicense.
  let verdict;
  try {
    verdict = verifyLicense(container, { now, vendorAddress: opts.vendor });
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return { ok: false, code: EXIT.USAGE };
  }
  if (!verdict.valid) {
    writeErr(
      `error: ${featureList} requires a VALID license, but the supplied license is ` +
        `${verdict.reason} (recovered ${verdict.recoveredSigner || "(unrecoverable)"}, ` +
        `pinned to ${verdict.vendorAddress}).\n`
    );
    return { ok: false, code: EXIT.FAIL };
  }

  // The license is valid — require it to actually CARRY each requested entitlement.
  for (const r of requested) {
    if (!hasEntitlement(verdict, r.entitlement)) {
      writeErr(
        `error: the supplied license is valid but does NOT include the "${r.entitlement}" ` +
          `entitlement needed for ${r.label}; it grants only ${JSON.stringify(verdict.entitlements)}.\n`
      );
      return { ok: false, code: EXIT.FAIL };
    }
  }
  return { ok: true, verdict };
}

async function runEvidenceSeal(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const now = io.now || new Date();

  if (!opts.dir) {
    writeErr("error: `vh evidence seal` requires a <dir>\n");
    return EXIT.USAGE;
  }

  // Walk the directory (the only read I/O). A missing/unreadable dir or a non-directory is an IO error.
  const dirAbs = path.resolve(opts.dir);
  let stat;
  try {
    stat = fs.statSync(dirAbs);
  } catch (e) {
    writeErr(`error: cannot read directory ${opts.dir}: ${e.message}\n`);
    return EXIT.IO;
  }
  if (!stat.isDirectory()) {
    writeErr(`error: ${opts.dir} is not a directory\n`);
    return EXIT.IO;
  }
  let entries;
  try {
    entries = loadDirEntries(dirAbs);
  } catch (e) {
    writeErr(`error: cannot read directory ${opts.dir}: ${e.message}\n`);
    return EXIT.IO;
  }
  if (entries.length === 0) {
    writeErr(`error: ${opts.dir} contains no files to seal\n`);
    return EXIT.FAIL;
  }

  // Decide which paid surfaces this invocation requests. Sealing more than the free sample requires
  // `evidence_unlimited`; --sign requires `evidence_signed`. Both are gated OFFLINE before any work.
  const requested = [];
  if (opts.sign) {
    requested.push({ entitlement: "evidence_signed", label: "the signed-attestation wrap (--sign)" });
  }
  if (entries.length > SAMPLE_LIMIT) {
    requested.push({
      entitlement: "evidence_unlimited",
      label: `sealing more than the free sample size (${SAMPLE_LIMIT} files; this dir has ${entries.length})`,
    });
  }
  const gate = gatePaid(opts, requested, now, writeErr);
  if (!gate.ok) return gate.code;

  // Build the bare seal over the GENERIC core. A build error (e.g. a duplicate path) is a 3, never a crash.
  let seal;
  try {
    seal = buildSeal(entries);
  } catch (e) {
    writeErr(`error: cannot build evidence seal: ${e.message}\n`);
    return EXIT.FAIL;
  }

  // Optionally WRAP in a signed attestation (the paid `evidence_signed` surface, already gated above).
  // The key is read, used, and discarded inside loadSigningWallet — NEVER persisted or logged.
  let artifactStr;
  let signedBy = null;
  if (opts.sign) {
    let wallet;
    try {
      ({ wallet } = coreAttestation.loadSigningWallet({ keyEnv: opts.keyEnv, keyFile: opts.keyFile }));
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    let container;
    try {
      container = await signSealWith(seal, wallet);
    } catch (e) {
      writeErr(`error: cannot sign evidence seal: ${e.message}\n`);
      return EXIT.FAIL;
    }
    signedBy = coreAttestation.recoverSigner(container);
    artifactStr = coreAttestation.serializeSignedAttestation(container, SIGNED_SEAL_CFG);
  } else {
    artifactStr = serializeSeal(seal);
  }

  // Write to --out (caller-chosen path; NEVER cwd) or print to stdout (writes nothing).
  let outAbs = null;
  if (opts.out) {
    outAbs = path.resolve(opts.out);
    try {
      fs.writeFileSync(outAbs, artifactStr);
    } catch (e) {
      writeErr(`error: cannot write --out file ${opts.out}: ${e.message}\n`);
      return EXIT.IO;
    }
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          note: EVIDENCE_TRUST_NOTE,
          kind: signedBy ? SIGNED_SEAL_KIND : SEAL_KIND,
          root: seal.root,
          fileCount: seal.fileCount,
          signed: !!signedBy,
          signer: signedBy,
          out: outAbs,
          // With NO --out the artifact rides in `artifact` so --json never drops it (parity with the family).
          artifact: outAbs ? null : artifactStr,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(EVIDENCE_TRUST_NOTE + "\n\n");
    write(
      `sealed ${seal.fileCount} file${seal.fileCount === 1 ? "" : "s"} ` +
        `into ${signedBy ? "a SIGNED evidence packet" : "an evidence packet"} — root ${seal.root}\n`
    );
    if (signedBy) write(`  signed by:    ${signedBy}\n`);
    if (outAbs) {
      write(`  written:      ${outAbs}\n`);
    } else {
      // Default: print the seal bytes so a buyer can eyeball/redirect them — still writes nothing.
      write(artifactStr);
    }
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// `vh evidence verify <p>` — read-only, NO key. RE-DERIVES the root from the bytes referenced and reports
// OK / which file CHANGED/MISSING/UNEXPECTED. Files resolve relative to --dir (if given) else the packet
// file's own directory (the packet stores relPaths relative to where its <dir> was sealed). Exit: 0 OK /
// 3 REJECTED / 2 usage / 1 IO. Exactly the offline-recompute posture of `vh verify-seal`/`verify-proof`.
// ---------------------------------------------------------------------------

function parseVerifyArgs(argv) {
  const opts = { packet: undefined, dir: undefined, json: false, _positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dir": {
        const v = argv[++i];
        if (v === undefined) {
          const e = new Error("--dir requires a value");
          e.usage = true;
          throw e;
        }
        opts.dir = v;
        break;
      }
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
      `unexpected extra argument: ${opts._positionals[1]} (evidence verify takes exactly one <packet>)`
    );
    e.usage = true;
    throw e;
  }
  opts.packet = opts._positionals[0];
  return opts;
}

// Render the human verify report. PURE.
function renderVerify(result, ctx) {
  const L = [];
  L.push(EVIDENCE_TRUST_NOTE);
  L.push("");
  L.push(`# vh evidence verify — ${ctx.packet}`);
  L.push(`sealed root:     ${result.sealedRoot}`);
  L.push(`recomputed root: ${result.recomputedRoot || "(none)"}`);
  L.push(`root matches:    ${result.rootMatches ? "yes" : "NO"}`);
  L.push(
    `files: ${result.counts.matched} matched, ${result.counts.changed} changed, ` +
      `${result.counts.missing} missing, ${result.counts.unexpected} unexpected`
  );
  L.push("");
  if (result.accepted) {
    L.push("OK — every sealed file re-derives byte-for-byte and the root matches.");
  } else {
    L.push("REJECTED — the files do NOT match the packet:");
    for (const c of result.changed) {
      L.push(`  CHANGED    ${c.relPath}: sealed ${c.expectedContentHash} != on-disk ${c.actualContentHash}`);
    }
    for (const m of result.missing) {
      L.push(`  MISSING    ${m.relPath}: sealed but not found on disk`);
    }
    for (const u of result.unexpected) {
      L.push(`  UNEXPECTED ${u.relPath}: on disk but not named in the packet`);
    }
    if (
      !result.rootMatches &&
      result.changed.length === 0 &&
      result.missing.length === 0 &&
      result.unexpected.length === 0
    ) {
      L.push("  ROOT       the recomputed root does not equal the sealed root");
    }
  }
  L.push("");
  return L.join("\n");
}

// Read a packet that may be a BARE seal OR a signed-seal container. Returns { seal, signed, signer }.
function readPacket(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new packetseal.PacketSealError(`evidence packet is not valid JSON: ${e.message}`);
  }
  if (obj && obj.kind === SIGNED_SEAL_KIND) {
    validateSignedSeal(obj); // strict; rejects a tampered/foreign signed container
    const seal = readSeal(obj.attestation); // the embedded canonical seal bytes
    return { seal, signed: true, signer: obj.signature ? obj.signature.signer : null };
  }
  return { seal: readSeal(obj), signed: false, signer: null };
}

function runEvidenceVerify(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.packet) {
    writeErr("error: `vh evidence verify` requires a <packet>\n");
    return EXIT.USAGE;
  }

  // Load + STRICT-validate the packet BEFORE any referenced file is read — a malformed/missing packet
  // hard-errors (exit 1), never half-accepted nor treated as "everything changed".
  const packetPath = path.resolve(opts.packet);
  let text;
  try {
    text = fs.readFileSync(packetPath, "utf8");
  } catch (e) {
    writeErr(`error: cannot read evidence packet ${opts.packet}: ${e.message}\n`);
    return EXIT.IO;
  }
  let parsed;
  try {
    parsed = readPacket(text);
  } catch (e) {
    writeErr(`error: invalid evidence packet ${opts.packet}: ${e.message}\n`);
    return EXIT.IO;
  }
  const seal = parsed.seal;

  // Resolve referenced files relative to --dir (if given) else the packet file's own directory. A file
  // the packet NAMES but that is absent must NOT abort — it is a MISSING finding verify localizes.
  const baseDir = opts.dir != null ? path.resolve(opts.dir) : path.dirname(packetPath);
  const entries = [];
  for (const f of seal.files) {
    const abs = path.resolve(baseDir, f.relPath);
    let bytes;
    try {
      bytes = fs.readFileSync(abs);
    } catch (_) {
      continue; // absent -> verifySeal reports MISSING
    }
    entries.push({ relPath: f.relPath, bytes });
  }

  let result;
  try {
    result = verifySeal(seal, entries);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  const code = result.accepted ? EXIT.OK : EXIT.FAIL;
  if (opts.json) {
    write(
      JSON.stringify(
        {
          ...result,
          packet: opts.packet,
          dir: baseDir,
          signed: parsed.signed,
          signer: parsed.signer,
          note: EVIDENCE_TRUST_NOTE,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(renderVerify(result, { packet: opts.packet }));
  }
  return code;
}

// ---------------------------------------------------------------------------
// CLI dispatch: `vh evidence <seal|verify> ...`.
// ---------------------------------------------------------------------------

async function cmdEvidence(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const [sub, ...rest] = argv;
  if (sub === "seal") {
    let opts;
    try {
      opts = parseSealArgs(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    return runEvidenceSeal(opts, io);
  }
  if (sub === "verify") {
    let opts;
    try {
      opts = parseVerifyArgs(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    return runEvidenceVerify(opts, io);
  }
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    io.write
      ? io.write(evidenceUsage())
      : process.stdout.write(evidenceUsage());
    return sub === undefined ? EXIT.USAGE : EXIT.OK;
  }
  writeErr(`error: unknown evidence subcommand: ${sub} (expected: seal, verify)\n`);
  return EXIT.USAGE;
}

function evidenceUsage() {
  return [
    "vh evidence — product-agnostic, license-gated, tamper-evident evidence packets",
    "",
    "Usage:",
    "  vh evidence seal <dir> [--out <p>] [--license <f> --vendor <0xaddr>] [--sign] [--json]",
    "  vh evidence verify <p> [--dir <d>] [--json]",
    "",
    "The seal proves TAMPER-EVIDENCE + OFFLINE-RECOMPUTE, NOT a trusted timestamp (\"sealed at T\" rides P-3).",
    "FREE: an unsigned baseline seal of up to " + SAMPLE_LIMIT + " files + verify (try before buying).",
    "PAID (require --license + --vendor): --sign (signed-attestation wrap) and sealing > " + SAMPLE_LIMIT + " files.",
    "",
  ].join("\n");
}

module.exports = {
  EXIT,
  SAMPLE_LIMIT,
  // seal product
  SEAL_KIND,
  SEAL_SCHEMA_VERSION,
  EVIDENCE_TRUST_NOTE,
  SEAL_CFG,
  buildSeal,
  validateSeal,
  serializeSeal,
  readSeal,
  verifySeal,
  loadDirEntries,
  // signed wrap
  SIGNED_SEAL_KIND,
  SIGNED_SEAL_CFG,
  signSealWith,
  validateSignedSeal,
  verifySignedSeal,
  // license product
  LICENSE_KIND,
  LICENSE_CFG,
  ENTITLEMENTS,
  EvidenceLicenseError,
  buildLicense,
  readLicense,
  verifyLicense,
  hasEntitlement,
  // CLI
  parseSealArgs,
  parseVerifyArgs,
  runEvidenceSeal,
  runEvidenceVerify,
  cmdEvidence,
  evidenceUsage,
};
