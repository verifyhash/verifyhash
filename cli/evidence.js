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
// REUSE the SAME path-bound file-level diff core the dataset/verify family uses — `diffManifest` — so a
// rename surfaces as REMOVED+ADDED and a content edit as CHANGED (old→new), with NO new diff logic here.
const { diffManifest } = require("./receipt");

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
// `diffEvidence({ packetA, packetB })` — PURE, OFFLINE, packet-to-packet change report.
//
// WHY THIS EXISTS
//   `vh evidence verify` answers "do these bytes on disk still match this packet?". But a buyer (or a CI
//   pipeline) often holds TWO sealed evidence packets — version A and version B of the SAME file set —
//   and no directory at all, and wants to answer "what changed between A and B?" PURELY from the two
//   portable artifacts: NO directory, NO bytes re-read, NO provider, NO key, NO network. This is the
//   evidence-product mirror of `cli/dataset.js › runDatasetDiff` — it reuses the EXACT SAME diff core.
//
// HOW (no new diff/crypto logic — every primitive is reused VERBATIM)
//   Each input may be EITHER a parsed seal object OR a packet STRING; BOTH are validated through the
//   EXISTING strict `readSeal` FIRST (a corrupt/foreign/edited/wrong-`kind` packet is REJECTED before any
//   diff — never half-accepted). Each packet's `files[]` ({ relPath, contentHash, leaf }) is then mapped
//   into the `{ path, contentHash, leaf }` shape `cli/receipt.js › diffManifest` expects and diffed by
//   REUSING that core verbatim. A is the BASELINE ("recorded"), B is the COMPARISON ("current"): so
//   ADDED = in B not A, REMOVED = in A not B, CHANGED = same relPath with a different leaf (old→new
//   contentHash). A rename surfaces as REMOVED(old path) + ADDED(new path) — the relPath is bound into
//   the leaf — never as a single CHANGED.
//
//   The diff compares what each packet CLAIMS; it re-derives NOTHING from bytes (there is no directory).
//   To re-derive a root from bytes, run `vh evidence verify` against the live tree.
//
// AUTHORITATIVE VERDICT
//   The returned `identical` is `diff.identical` — the CHANGE SET (no ADDED/REMOVED/CHANGED), computed
//   from the per-file LEAVES — NOT root-string equality (mirrors `runDatasetDiff` exactly). So a packet
//   with a hand-edited `root` whose leaves are unchanged still reports `identical:true`: a hand-edited
//   `root` cannot flip the verdict. `rootA`/`rootB`/`rootsIdentical` remain DISPLAYED metadata only.

/**
 * Diff two evidence packets, PURELY and OFFLINE. Accepts EITHER two parsed seal objects OR two packet
 * strings (or a mix); validates BOTH through the EXISTING strict `readSeal` BEFORE any diff (a
 * corrupt/foreign/edited/wrong-kind packet is REJECTED, never half-accepted), then reuses
 * `cli/receipt.js › diffManifest` VERBATIM. Mutates NEITHER input. Order-independent and deterministic.
 *
 * @param {object} args
 * @param {object|string} args.packetA the BASELINE packet (the "from") — a seal object or a packet string
 * @param {object|string} args.packetB the COMPARISON packet (the "to") — a seal object or a packet string
 * @returns {{
 *   rootA: string, rootB: string, rootsIdentical: boolean, identical: boolean,
 *   added: Array<{path:string,contentHash:string}>,
 *   removed: Array<{path:string,contentHash:string}>,
 *   changed: Array<{path:string,oldContentHash:string,newContentHash:string}>,
 *   unchanged: Array<{path:string,contentHash:string}>,
 *   counts: { added: number, removed: number, changed: number, unchanged: number }
 * }}
 */
function diffEvidence(args) {
  if (args == null || typeof args !== "object" || Array.isArray(args)) {
    throw new packetseal.PacketSealError("diffEvidence requires { packetA, packetB }");
  }
  return diffEvidenceSeals(args.packetA, args.packetB);
}

/**
 * The `seal`-object (positional) overload of `diffEvidence`. Same contract: each of `packetA`/`packetB`
 * may be a parsed seal object OR a packet string, both are validated through the strict `readSeal`
 * first, and the change set is computed by reusing `diffManifest` verbatim with the AUTHORITATIVE,
 * change-set-driven `identical` (NOT root-string equality). PURE; mutates neither input.
 *
 * @param {object|string} packetA the BASELINE packet (a seal object or a packet string)
 * @param {object|string} packetB the COMPARISON packet (a seal object or a packet string)
 * @returns {object} see {@link diffEvidence}
 */
function diffEvidenceSeals(packetA, packetB) {
  // STRICT reads FIRST: a corrupt/edited/foreign/wrong-kind packet is REJECTED here (readSeal throws a
  // PacketSealError), never half-accepted, BEFORE any diff is attempted. readSeal accepts EITHER a parsed
  // seal object OR a JSON string and validates structure + per-file leaf re-derivation. It returns the
  // SAME object reference for an object input, so we never mutate the caller's input below (we only READ
  // `.root`/`.files` and map into a fresh array). Both must be structurally sound to be diffed.
  const a = readSeal(packetA);
  const b = readSeal(packetB);

  const rootA = a.root;
  const rootB = b.root;
  // The two roots, recorded in the packets, are DISPLAYED metadata only. readSeal/validateSeal re-derives
  // every leaf == pathLeaf(relPath, contentHash) and the root over those leaves, so for a structurally
  // valid packet the root DOES summarize its leaves — but we still do NOT let root-string equality decide
  // the verdict (see `identical` below), so the policy is identical to `runDatasetDiff`: a hand-edited
  // `root` that survives validation cannot flip the change-set verdict.
  const rootsIdentical = rootA.toLowerCase() === rootB.toLowerCase();

  // Map each packet's `files` (relPath→path) into the shape diffManifest expects, then REUSE the SAME
  // diff core VERBATIM. A is the baseline ("recorded"), B is the comparison ("current"): so diffManifest's
  // ADDED = in B not A, REMOVED = in A not B, CHANGED = same relPath, different leaf (carrying old→new
  // contentHash). A rename is REMOVED(old path) + ADDED(new path) — the relPath is bound into the leaf.
  const aManifest = a.files.map((f) => ({
    path: f.relPath,
    contentHash: f.contentHash,
    leaf: f.leaf,
  }));
  const bManifest = b.files.map((f) => ({
    path: f.relPath,
    contentHash: f.contentHash,
    leaf: f.leaf,
  }));
  const diff = diffManifest(aManifest, bManifest);

  // AUTHORITATIVE verdict is the CHANGE SET, not root-string equality. diffManifest already returns
  // `identical` (true iff there is no ADDED / REMOVED / CHANGED) from the per-file LEAVES — the same data
  // the returned changeset is built from. Deriving the verdict from the changeset guarantees `identical`
  // and the body can never disagree: a packet with a hand-edited `root` (whose leaves are unchanged) still
  // reports `identical:true` with an empty changeset. rootA/rootB/rootsIdentical remain DISPLAYED metadata.
  const identical = diff.identical;

  const counts = {
    added: diff.added.length,
    removed: diff.removed.length,
    changed: diff.changed.length,
    unchanged: diff.unchanged.length,
  };

  return {
    rootA,
    rootB,
    rootsIdentical,
    identical,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    unchanged: diff.unchanged,
    counts,
  };
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

// The standing trust caveat the signed-verify path LEADS with — reuses EVIDENCE_TRUST_NOTE verbatim (so
// the caveats can NEVER drift) plus the signing-specific honesty: a valid signature proves WHO vouched,
// still NOT a timestamp (P-3) and NOT a legal opinion. Mirrors cli/dataset.js › VERIFY_ATTEST_TRUST_NOTE.
const VERIFY_SIGNED_SEAL_TRUST_NOTE =
  "A valid signature proves the HOLDER OF `signer`'s key vouched for THIS evidence seal (the embedded " +
  "root + the full set of (relPath, content) pairs). It does NOT by itself prove a trustworthy " +
  'TIMESTAMP: "sealed/vouched since a date T" still needs the human-owned signing/timestamp trust-root ' +
  "(needs-human, P-3). It is NOT a legal opinion. " +
  EVIDENCE_TRUST_NOTE;

/**
 * Verify (purely, OFFLINE) a SIGNED evidence-seal container — the STRICT, PURE signed-verify path that
 * MIRRORS `cli/dataset.js › verifySignedAttestation` EXACTLY. It recovers the signer from the embedded
 * canonical seal bytes + signature and confirms it equals the container's CLAIMED `signer` (Check 1 —
 * ALWAYS run); OPTIONALLY pins it to an EXPECTED signer (`expectedSigner` / the CLI `--signer` flag —
 * Check 2, run ONLY when present); and OPTIONALLY confirms the signature binds a holder's OWN directory
 * (`dir` / the CLI `--dir` flag) by recomputing the canonical UNSIGNED seal bytes from that directory via
 * the EXISTING build path (`serializeSeal(buildSeal(loadDirEntries(dir)))`) and requiring them
 * byte-identical to the embedded payload. The verdict is ACCEPTED only when EVERY requested check passes;
 * a forged/mismatched/tampered signature is a clean REJECTED — NEVER a silent pass.
 *
 * It is OFFLINE / key-free / network-free: it recovers a PUBLIC address from a signature, holds no private
 * key, and contacts nothing. It writes NOTHING and mutates NEITHER the container NOR the directory (the
 * `--dir` read is the ONLY I/O, and only when binding is requested). Throws only on an unrecoverable
 * signature when the scheme is unknown (defense-in-depth — validateSignedSeal already rejects one) or when
 * the supplied `--dir` cannot be read; a recovered address that simply doesn't match is a clean REJECTED.
 *
 * The returned shape is the SIBLING-PARITY verdict shape (byte-for-byte the fields `verifySignedAttestation`
 * returns, including the `manifestBindsAttestation`/`manifestChecked` field names so a future indexer/UI can
 * depend on ONE stable verdict shape across the product family).
 *
 * @param {object} params
 * @param {object} params.container        a validated signed-seal container (from validateSignedSeal/readPacket)
 * @param {string} [params.expectedSigner] OPTIONAL expected signer 0x-address (--signer); Check 2 runs when present
 * @param {string} [params.dir]            OPTIONAL directory to bind the signature to (--dir); binding runs when present
 * @returns {{
 *   verdict: "ACCEPTED"|"REJECTED",
 *   accepted: boolean,
 *   recoveredSigner: string,
 *   claimedSigner: string,
 *   scheme: string,
 *   checks: {
 *     signatureMatchesSigner: boolean,
 *     signerMatchesExpected: boolean|null,
 *     manifestBindsAttestation: boolean|null,
 *   },
 *   expectedSigner: string|null,
 *   manifestChecked: boolean,
 *   failedChecks: string[],
 * }}
 */
function verifySignedSealAttestation(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("verifySignedSealAttestation requires { container, [expectedSigner], [dir] }");
  }
  const { container, expectedSigner, dir } = params;

  // The ONLY evidence-specific step: the OPTIONAL --dir binding check recomputes the canonical UNSIGNED
  // seal bytes from the holder's OWN directory via the EXISTING build path (the SAME bytes `vh evidence
  // seal` embeds), then hands them to the GENERIC core as `expectedCanonical`. The core does the signer
  // recovery (Check 1, always), the OPTIONAL expected-signer pin (Check 2), and the byte-identity binding
  // comparison — all product-agnostic. We pass `container` straight through (no copy; the container is only
  // READ), so this never mutates the caller's input. The returned shape (incl. the field names) is
  // byte-for-byte what the dataset sibling returns.
  let expectedCanonical;
  if (dir !== undefined && dir !== null) {
    // Recompute the canonical seal bytes from the live directory — the SAME (relPath, content) walk + seal
    // build the seal path uses. A directory the holder cannot read is a genuine error (re-thrown), never a
    // silent "binding skipped" — the caller asked to bind to bytes that must exist.
    const dirAbs = path.resolve(dir);
    const entries = loadDirEntries(dirAbs);
    expectedCanonical = serializeSeal(buildSeal(entries));
  }
  // Route through the existing `verifySignedSeal` thin wrapper (which calls coreAttestation.
  // verifySignedAttestation) so this path stays the single, shared verify core — exactly mirroring how the
  // dataset sibling funnels through coreAttestation.verifySignedAttestation.
  return verifySignedSeal({ container, expectedSigner, expectedCanonical });
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
  // SIGNATURE section — only for a SIGNED packet. `verify` re-derives the content root; it does NOT pin the
  // signer (that is `verify-signed --signer`). But it MUST NOT report a CLAIMED signer as if trusted: it
  // recovers the signer from the bytes + signature and either REJECTS a forged signature or labels a
  // genuine one UNVERIFIED-for-pinning, pointing at `verify-signed`. (T-47.2 — close the silent claim.)
  const sig = ctx.sig;
  if (sig) {
    L.push("");
    if (sig.signatureMatchesSigner) {
      L.push(`signature:       UNVERIFIED — claimed signer ${sig.claimedSigner} is GENUINE (the signature`);
      L.push("                 recovers to it), but this command does NOT pin the signer to anyone you trust.");
      L.push(`                 Run \`vh evidence verify-signed ${ctx.packet} --signer <0xaddr>\` to PIN the signer`);
      L.push("                 (and --dir to bind the signature to YOUR bytes).");
    } else {
      L.push(`signature:       FORGED — REJECTED. The container CLAIMS signer ${sig.claimedSigner} but the`);
      L.push(`                 signature actually recovers to ${sig.recoveredSigner}. The \`signer\` label is`);
      L.push("                 UNBACKED. Run `vh evidence verify-signed` for the full per-check verdict.");
    }
  }
  L.push("");
  if (result.accepted && !(sig && !sig.signatureMatchesSigner)) {
    L.push("OK — every sealed file re-derives byte-for-byte and the root matches.");
    if (sig) {
      L.push("    (The content matches; the signature is GENUINE but UNVERIFIED-for-pinning — see above.)");
    }
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
    if (sig && !sig.signatureMatchesSigner) {
      L.push("  SIGNATURE  the signature is FORGED (recovers to a different address than claimed)");
    }
  }
  L.push("");
  return L.join("\n");
}

// Read a packet that may be a BARE seal OR a signed-seal container. Returns { seal, signed, container }.
// For a signed container it returns the validated CONTAINER (so `verify` can run the signature check —
// `validateSignedSeal` proves the bytes are CANONICAL but NOT that the signature recovers to the claimed
// `signer`, so the recovery must happen at the call site, never here). It does NOT return a `signer` field:
// the CLAIMED signer is not trustworthy until the signature is recovered (T-47.2 — close the silent claim).
function readPacket(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new packetseal.PacketSealError(`evidence packet is not valid JSON: ${e.message}`);
  }
  if (obj && obj.kind === SIGNED_SEAL_KIND) {
    validateSignedSeal(obj); // strict; rejects a tampered/foreign signed container (but NOT a forged sig)
    const seal = readSeal(obj.attestation); // the embedded canonical seal bytes
    return { seal, signed: true, container: obj };
  }
  return { seal: readSeal(obj), signed: false, container: null };
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

  // CLOSE THE SILENT CLAIM (T-47.2). For a SIGNED packet, `validateSignedSeal` proved the bytes are
  // canonical but NOT that the signature recovers to the CLAIMED `signer`. So we recover the signer here
  // (Check 1 of the verify-signed verdict, ALWAYS run, key-free/offline) and HONESTLY report it:
  //   * a FORGED signature (recovers to a DIFFERENT address than claimed) is a clean REJECTED — never a
  //     silent pass that reports the claimed signer as if trusted;
  //   * a GENUINE signature is labelled UNVERIFIED-for-pinning (the signer is real but NOT pinned to anyone
  //     the caller trusts) and points at `vh evidence verify-signed` for the full pin/bind verdict.
  // `verify` never PINS the signer (no --signer here) — pinning + binding is the `verify-signed` command.
  let sig = null;
  if (parsed.signed) {
    const sv = verifySignedSeal({ container: parsed.container }); // recovers signer; no pin, no binding
    sig = {
      signed: true,
      signatureMatchesSigner: sv.checks.signatureMatchesSigner,
      recoveredSigner: sv.recoveredSigner,
      claimedSigner: sv.claimedSigner,
      scheme: sv.scheme,
    };
  }

  // A forged signature flips the overall verdict to REJECTED even when the content matches: the packet's
  // own `signer` label is unbacked, so the artifact as a whole must NOT report OK. Content failures still
  // reject as before; the two are independent and either alone is sufficient to REJECT.
  const accepted = result.accepted && !(sig && !sig.signatureMatchesSigner);
  const code = accepted ? EXIT.OK : EXIT.FAIL;
  if (opts.json) {
    write(
      JSON.stringify(
        {
          ...result,
          // Overall accepted/verdict accounts for BOTH content re-derivation AND (for a signed packet) the
          // signature-recovers-to-claimed-signer check. `contentVerdict`/`contentAccepted` preserve the
          // pure seal-content result a machine reader may still want separately.
          accepted,
          verdict: accepted ? "ACCEPTED" : "REJECTED",
          contentAccepted: result.accepted,
          contentVerdict: result.verdict,
          packet: opts.packet,
          dir: baseDir,
          signed: parsed.signed,
          // The recovered + claimed signer + whether the signature is GENUINE; null for an unsigned packet.
          // We NEVER expose a bare `signer` that conflates "claimed" with "trusted" (T-47.2).
          signature: sig
            ? {
                signatureMatchesSigner: sig.signatureMatchesSigner,
                recoveredSigner: sig.recoveredSigner,
                claimedSigner: sig.claimedSigner,
                scheme: sig.scheme,
                // The signer is GENUINE-but-UNVERIFIED-for-pinning here; verify-signed pins/binds it.
                pinned: false,
                hint: "run `vh evidence verify-signed <packet> --signer <addr> [--dir <d>]` to pin + bind",
              }
            : null,
          note: EVIDENCE_TRUST_NOTE,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(renderVerify(result, { packet: opts.packet, sig }));
  }
  return code;
}

// ---------------------------------------------------------------------------
// `vh evidence verify-signed <signed> [--dir <d>] [--signer <addr>] [--json]` — the OFFLINE, key-free,
// network-free signed-verify CLI over the PURE `verifySignedSealAttestation` core (T-47.1). It is the
// command that ACTUALLY CHECKS a signed packet's signature (the closing of the silent claim `vh evidence
// verify` leaves open): it recovers the signer from the embedded canonical bytes + signature (Check 1,
// ALWAYS), OPTIONALLY pins it to an expected `--signer` (Check 2), and OPTIONALLY binds it to the holder's
// OWN `--dir` bytes (Check 3). Leads with the trust caveat; prints per-check PASS/FAIL/skip. The verdict is
// ACCEPTED only when EVERY REQUESTED check passes; a forged/mismatched/tampered/wrong-key signature is a
// clean REJECTED — NEVER a silent pass. Writes NOTHING (the --dir read is the only I/O). Exit: 0 ACCEPTED /
// 3 REJECTED / 2 usage / 1 IO (mirrors `vh dataset verify-attest`).
// ---------------------------------------------------------------------------

function parseVerifySignedArgs(argv) {
  const opts = { signed: undefined, dir: undefined, signer: undefined, json: false, _positionals: [] };
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
      case "--dir":
        opts.dir = need("--dir");
        break;
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
      `unexpected extra argument: ${opts._positionals[1]} (evidence verify-signed takes exactly one <signed>)`
    );
    e.usage = true;
    throw e;
  }
  opts.signed = opts._positionals[0];
  return opts;
}

// Render the human verify-signed report. PURE. LEADS with the signing trust caveat (the SAME standing note
// the dataset sibling leads with — reuses EVIDENCE_TRUST_NOTE verbatim so the caveats never drift), then the
// verdict, the recovered/claimed/expected signer, and each requested check with PASS/FAIL (or [skip] when an
// optional check was not requested). A REJECTED verdict NAMES which check(s) failed.
function renderVerifySigned(r, ctx) {
  const L = [];
  // TRUST caveat FIRST: a valid signature proves WHO vouched, NOT a timestamp (P-3), NOT a legal opinion.
  L.push("TRUST: " + VERIFY_SIGNED_SEAL_TRUST_NOTE);
  L.push("");
  L.push(`# vh evidence verify-signed — ${ctx.signed}`);
  L.push(`verify-signed:    ${r.verdict}`);
  L.push(`scheme:           ${r.scheme}`);
  L.push(`recovered signer: ${r.recoveredSigner}  (from the embedded canonical seal bytes + signature)`);
  L.push(`claimed signer:   ${r.claimedSigner}  (the container's \`signer\` field)`);
  // Check 1 (ALWAYS): the signature recovers to the claimed signer.
  L.push(
    `  [${r.checks.signatureMatchesSigner ? "PASS" : "FAIL"}] signature recovers to the claimed signer`
  );
  // Check 2 (only under --signer): the recovered signer equals the expected signer.
  if (r.checks.signerMatchesExpected === null) {
    L.push("  [skip] expected-signer pin: not requested (pass --signer <0xaddr> to pin the signer)");
  } else {
    L.push(
      `  [${r.checks.signerMatchesExpected ? "PASS" : "FAIL"}] recovered signer matches the expected ` +
        `signer (${r.expectedSigner})`
    );
  }
  // Check 3 (only under --dir): the signature binds the holder's OWN directory bytes.
  if (r.checks.manifestBindsAttestation === null) {
    L.push(
      "  [skip] directory binding: not requested (pass --dir <d> to bind the signature to YOUR bytes)"
    );
  } else {
    L.push(
      `  [${r.checks.manifestBindsAttestation ? "PASS" : "FAIL"}] the signature binds YOUR directory ` +
        "(its canonical seal bytes are byte-identical to the signed payload)"
    );
  }
  if (r.accepted) {
    L.push("ACCEPTED: every requested check passed.");
  } else {
    L.push(`REJECTED: failed check(s): ${r.failedChecks.join(", ")}.`);
    if (r.failedChecks.includes("signatureMatchesSigner")) {
      L.push(
        "  forged-signature: the signature does NOT recover to the claimed `signer` — the signer label is"
      );
      L.push("  UNBACKED (a forged/tampered/wrong-key signature), NOT a packet you can trust.");
    }
    if (r.failedChecks.includes("manifestBindsAttestation")) {
      L.push(
        "  binding-mismatch: the signed payload does NOT match YOUR directory — the signature vouches for a"
      );
      L.push("  DIFFERENT file set than the one you hold.");
    }
  }
  L.push("");
  return L.join("\n");
}

function runEvidenceVerifySigned(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.signed) {
    writeErr("error: `vh evidence verify-signed` requires a <signed> (signed evidence packet path)\n");
    return EXIT.USAGE;
  }

  // Validate the --signer address SHAPE up front (when given) so a malformed expected signer is a usage
  // error (2), never a runtime throw mid-verify. PURELY OFFLINE — no network here either.
  if (opts.signer !== undefined && opts.signer !== null) {
    let isAddress;
    try {
      ({ isAddress } = require("ethers"));
    } catch (_) {
      isAddress = null;
    }
    if (isAddress && !isAddress(opts.signer)) {
      writeErr(
        `error: invalid --signer address: ${opts.signer} (expected a 20-byte 0x-hex address)\n`
      );
      return EXIT.USAGE;
    }
  }

  // Read + STRICT-validate the signed container BEFORE any recovery — a malformed/edited/foreign container
  // (or a BARE unsigned seal handed here) hard-errors (exit 1), never half-accepted. A forged signature is
  // NOT a parse error: validateSignedSeal proves the bytes are canonical; the recovery (the verdict) runs
  // below in the PURE core.
  let container;
  try {
    const text = fs.readFileSync(path.resolve(opts.signed), "utf8");
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new packetseal.PacketSealError(`signed evidence packet is not valid JSON: ${e.message}`);
    }
    if (!obj || obj.kind !== SIGNED_SEAL_KIND) {
      throw new packetseal.PacketSealError(
        `not a signed evidence packet (kind ${JSON.stringify(obj && obj.kind)}; expected ` +
          `${JSON.stringify(SIGNED_SEAL_KIND)}). \`verify-signed\` checks a SIGNED packet; for a bare seal ` +
          "use `vh evidence verify`."
      );
    }
    container = validateSignedSeal(obj); // strict; rejects a tampered/foreign signed container
  } catch (e) {
    writeErr(`error: cannot read signed evidence packet ${opts.signed}: ${e.message}\n`);
    return EXIT.IO;
  }

  // Run the PURE, OFFLINE verify. The ONLY I/O is the optional --dir read (inside the core), and only when
  // binding is requested. An unreadable --dir is a genuine IO error (1), never a silently-skipped binding.
  let result;
  try {
    result = verifySignedSealAttestation({
      container,
      expectedSigner: opts.signer,
      dir: opts.dir,
    });
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ...result,
          signed: opts.signed,
          dir: opts.dir != null ? path.resolve(opts.dir) : null,
          note: VERIFY_SIGNED_SEAL_TRUST_NOTE,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(renderVerifySigned(result, { signed: opts.signed }));
  }

  // Exit non-zero on REJECTED so a buyer's CI can gate (mirrors the family's 0 ACCEPTED / 3 REJECTED).
  return result.accepted ? EXIT.OK : EXIT.FAIL;
}

// ---------------------------------------------------------------------------
// `vh evidence diff <packetA> <packetB> [--json]` — read-only, FREE, key-free, OFFLINE change report
// between TWO already-sealed evidence packets. The CLI surface over the PURE `diffEvidenceSeals` core
// (T-46.1). It re-derives NOTHING from bytes (there is no directory) — it compares what each packet
// CLAIMS — and writes NOTHING (a diff produces no sealed artifact, so it needs NO license and never
// gates). A is the BASELINE ("recorded"), B is the COMPARISON ("current"): ADDED = in B not A,
// REMOVED = in A not B, CHANGED = same relPath/different content (old→new); a rename surfaces as
// REMOVED+ADDED. The verdict (and exit code + headline) is the CHANGE SET (`identical`), NOT root-string
// equality. Exit: 0 IDENTICAL / 3 DIFFERENT / 2 usage / 1 IO (mirrors `vh dataset diff`).
// ---------------------------------------------------------------------------

function parseDiffArgs(argv) {
  const opts = { packetA: undefined, packetB: undefined, json: false, _positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
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
  if (opts._positionals.length > 2) {
    const e = new Error(
      `unexpected extra argument: ${opts._positionals[2]} (evidence diff takes exactly two <packet>s)`
    );
    e.usage = true;
    throw e;
  }
  opts.packetA = opts._positionals[0];
  opts.packetB = opts._positionals[1];
  return opts;
}

// Render the human diff report. PURE. LEADS with the CLAIMS-not-content TRUST line (a diff compares what
// each packet CLAIMS — it does NOT re-derive content), prints a deterministic IDENTICAL/DIFFERENT
// headline, the per-file ADDED/REMOVED/CHANGED block, and a count line driven by the change set. The
// headline is driven by `result.identical` — the CHANGE SET, not root-string equality — so it can never
// contradict the per-file body or the exit code. The two recorded roots are DISPLAYED metadata only.
function renderDiff(result, ctx) {
  const L = [];
  // TRUST FIRST: a diff compares what each packet CLAIMS; it does not re-derive content (no directory).
  L.push(
    "TRUST: this compares what each evidence packet CLAIMS — it does NOT re-derive content (there is " +
      "no directory). " +
      EVIDENCE_TRUST_NOTE
  );
  L.push("       (run `vh evidence verify <packet> --dir <d>` against the live tree to re-derive a root from bytes).");
  L.push("");
  L.push(`# vh evidence diff — ${ctx.packetA} -> ${ctx.packetB}`);
  L.push(`packet A root: ${result.rootA}`);
  L.push(`packet B root: ${result.rootB}`);
  if (result.identical) {
    L.push(
      "files: IDENTICAL — the two packets commit to the SAME set of (relPath, content) pairs " +
        "(no ADDED / REMOVED / CHANGED)."
    );
    L.push(`+0 / -0 / ~0 / ${result.counts.unchanged} unchanged`);
    // In the evidence product readSeal RE-DERIVES the root over the leaves, so a structurally-valid pair
    // can NEVER reach here with mismatched roots but identical leaves — a tampered root is rejected
    // outright before the diff. The roots therefore always agree with the change set on this path; we
    // surface no "hand-edited root" note (unlike the dataset diff) because that state is unreachable.
    L.push("");
    return L.join("\n");
  }
  L.push(
    "files: DIFFERENT — the packets commit to different (relPath, content) sets. Per-file changes (A->B). " +
      "A rename surfaces as REMOVED(old path) + ADDED(new path) — the path is bound into the leaf — " +
      "NOT as two unrelated edits."
  );
  L.push(
    `+${result.counts.added} / -${result.counts.removed} / ~${result.counts.changed} / ` +
      `${result.counts.unchanged} unchanged`
  );
  for (const c of result.changed) {
    L.push(`  CHANGED  ${c.path}`);
    L.push(`             old: ${c.oldContentHash}`);
    L.push(`             new: ${c.newContentHash}`);
  }
  for (const a of result.added) {
    L.push(`  ADDED    ${a.path}  (${a.contentHash})   in B, not in A`);
  }
  for (const rm of result.removed) {
    L.push(`  REMOVED  ${rm.path}  (${rm.contentHash})   in A, not in B`);
  }
  L.push("");
  return L.join("\n");
}

function runEvidenceDiff(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.packetA || !opts.packetB) {
    writeErr("error: `vh evidence diff` requires exactly two packet paths <packetA> <packetB>\n");
    return EXIT.USAGE;
  }

  // Read BOTH packet files (the only I/O — a diff writes NOTHING). A missing/unreadable file is an IO
  // error (exit 1). We pass the raw bytes through the strict diff core, which re-validates structure +
  // root re-derivation and REJECTS a corrupt/foreign/wrong-kind/hand-edited packet before any diff.
  let textA;
  try {
    textA = fs.readFileSync(path.resolve(opts.packetA), "utf8");
  } catch (e) {
    writeErr(`error: cannot read evidence packet ${opts.packetA}: ${e.message}\n`);
    return EXIT.IO;
  }
  let textB;
  try {
    textB = fs.readFileSync(path.resolve(opts.packetB), "utf8");
  } catch (e) {
    writeErr(`error: cannot read evidence packet ${opts.packetB}: ${e.message}\n`);
    return EXIT.IO;
  }

  let result;
  try {
    result = diffEvidenceSeals(textA, textB);
  } catch (e) {
    // A corrupt/foreign/wrong-kind/hand-edited packet (PacketSealError from readSeal) is a runtime/IO
    // error (exit 1), never a half-accepted diff — exactly like `vh dataset diff`'s corrupt-manifest path.
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          identical: result.identical,
          rootA: result.rootA,
          rootB: result.rootB,
          rootsIdentical: result.rootsIdentical,
          added: result.added,
          removed: result.removed,
          changed: result.changed,
          unchanged: result.unchanged,
          counts: result.counts,
          packetA: opts.packetA,
          packetB: opts.packetB,
          note: EVIDENCE_TRUST_NOTE,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(renderDiff(result, { packetA: opts.packetA, packetB: opts.packetB }));
  }

  // Exit non-zero when the packets DIFFER so CI can branch (mirrors the family's MISMATCH/DIFFERENT).
  // The verdict is the CHANGE SET (`identical`), not root-string equality, so the exit code can never
  // disagree with the printed/JSON changeset.
  return result.identical ? EXIT.OK : EXIT.FAIL;
}

// ---------------------------------------------------------------------------
// CLI dispatch: `vh evidence <seal|verify|diff> ...`.
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
  if (sub === "verify-signed") {
    let opts;
    try {
      opts = parseVerifySignedArgs(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    return runEvidenceVerifySigned(opts, io);
  }
  if (sub === "diff") {
    let opts;
    try {
      opts = parseDiffArgs(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    return runEvidenceDiff(opts, io);
  }
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    io.write
      ? io.write(evidenceUsage())
      : process.stdout.write(evidenceUsage());
    return sub === undefined ? EXIT.USAGE : EXIT.OK;
  }
  writeErr(
    `error: unknown evidence subcommand: ${sub} (expected: seal, verify, verify-signed, diff)\n`
  );
  return EXIT.USAGE;
}

function evidenceUsage() {
  return [
    "vh evidence — product-agnostic, license-gated, tamper-evident evidence packets",
    "",
    "Usage:",
    "  vh evidence seal <dir> [--out <p>] [--license <f> --vendor <0xaddr>] [--sign] [--json]",
    "  vh evidence verify <p> [--dir <d>] [--json]",
    "  vh evidence verify-signed <signed> [--dir <d>] [--signer <0xaddr>] [--json]",
    "  vh evidence diff <packetA> <packetB> [--json]",
    "",
    "The seal proves TAMPER-EVIDENCE + OFFLINE-RECOMPUTE, NOT a trusted timestamp (\"sealed at T\" rides P-3).",
    "FREE: an unsigned baseline seal of up to " + SAMPLE_LIMIT + " files + verify + verify-signed + diff (try before buying).",
    "PAID (require --license + --vendor): --sign (signed-attestation wrap) and sealing > " + SAMPLE_LIMIT + " files.",
    "verify-signed is OFFLINE/key-free/network-free: it RECOVERS the signer + (--signer) pins it + (--dir) binds the bytes.",
    "  A forged/tampered/wrong-key signature is a clean REJECTED — never a silent pass. Exit 0 ACCEPTED / 3 REJECTED / 2 usage / 1 IO.",
    "verify on a SIGNED packet no longer trusts the claimed signer: it REJECTS a forged signature OR labels a genuine one",
    "  UNVERIFIED-for-pinning and points at `verify-signed`.",
    "diff is read-only/FREE/key-free/OFFLINE: it compares what TWO packets CLAIM and writes nothing.",
    "Exit: diff 0 IDENTICAL / 3 DIFFERENT / 2 usage / 1 IO.",
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
  diffEvidence,
  diffEvidenceSeals,
  loadDirEntries,
  // signed wrap
  SIGNED_SEAL_KIND,
  SIGNED_SEAL_CFG,
  signSealWith,
  validateSignedSeal,
  verifySignedSeal,
  verifySignedSealAttestation,
  VERIFY_SIGNED_SEAL_TRUST_NOTE,
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
  parseVerifySignedArgs,
  parseDiffArgs,
  runEvidenceSeal,
  runEvidenceVerify,
  runEvidenceVerifySigned,
  runEvidenceDiff,
  renderVerify,
  renderVerifySigned,
  renderDiff,
  cmdEvidence,
  evidenceUsage,
};
