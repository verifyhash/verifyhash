#!/usr/bin/env node
"use strict";

// verifyhash CLI entrypoint.
//
// Implemented commands:
//   vh hash <path>             Print the keccak256 of a file, or the sorted-leaf Merkle root of a
//                              directory (matching ContributionRegistry.verifyLeaf).
//   vh anchor <path> [opts]    Submit a file/dir's content hash on-chain via anchor().
//   vh verify <path> [opts]    Recompute a file/dir's hash, read it back from the registry, and
//                              report MATCH / MISMATCH (a one-byte edit flips it to MISMATCH).
//   vh prove <file> [opts]     Prove a single file belongs to an anchored repo root: build its
//                              Merkle proof and have the on-chain verifyLeaf accept/reject it.

const { hashPath, hashGit } = require("./hash");
const { runAnchor } = require("./anchor");
const { runVerify } = require("./verify");
const { runProve } = require("./prove");
const { runVerifyProof } = require("./proof");
const { runClaim, runCommit, runReveal } = require("./claim");
const { runList } = require("./list");
const { runShow } = require("./show");
const { runLineage } = require("./lineage");
const { runReputation } = require("./reputation");
const {
  runDatasetBuild,
  runDatasetVerify,
  runDatasetDiff,
  runDatasetSummary,
  runDatasetReport,
  runDatasetProve,
  runDatasetVerifyProof,
  runDatasetAttest,
  runDatasetSign,
  runDatasetVerifyAttest,
  runDatasetCheck,
  runDatasetTimestampRequest,
  runDatasetTimestampWrap,
} = require("./dataset");
const {
  runParcelBuild,
  runParcelVerify,
  runParcelAttest,
  runParcelSign,
  runParcelVerifyAttest,
  runParcelTimestampRequest,
  runParcelTimestampWrap,
} = require("./parcel");

function usage() {
  return [
    "vh — verifyhash CLI",
    "",
    "Usage:",
    "  vh hash <path> [--git]     keccak256 of a file, or sorted-leaf Merkle root of a directory",
    "                             (--git [--ref <ref>]: hash ONLY the files git tracks at that commit)",
    "  vh anchor <path> [opts]    anchor a file/dir's content hash on-chain (FRONT-RUNNABLE)",
    "  vh claim <path> [opts]     front-running-resistant attribution via commit-reveal (one-shot)",
    "  vh commit <path> [opts]    commit-reveal step 1: commit + write a resumable claim receipt",
    "  vh reveal --receipt <p>    commit-reveal step 2: resume from a receipt and reveal",
    "  vh verify <path> [opts]    recompute the hash, read the registry, print MATCH / MISMATCH",
    "  vh prove <file> [opts]     Merkle-prove a file against an anchored repo root via verifyLeaf",
    "  vh verify-proof <p> [opts] independently verify a portable proof artifact (offline + on-chain)",
    "  vh list [opts]             enumerate the registry read-only (discovery + audit)",
    "  vh show <0xhash> [opts]    look up ONE record by content hash (no local content needed)",
    "  vh lineage <0xhash> [opts] walk the parent chain UP from a record to its lineage root (read-only)",
    "  vh reputation <addr> [opts] verifiable, on-chain-derived contribution score for one address (read-only)",
    "  vh dataset build <dir> --out <p>  tamper-evident dataset manifest (Merkle root + per-file leaves)",
    "  vh dataset verify <dir> --manifest <p>  re-derive the root + per-file diff vs a manifest (OFFLINE)",
    "  vh dataset diff <manifestA> <manifestB>  OFFLINE manifest-to-manifest change report (no tree/key/net)",
    "  vh dataset summary <manifest>   OFFLINE provenance/license roll-up over a manifest (no tree/key/net)",
    "  vh dataset check <manifest> --policy <p>  OFFLINE license/source policy gate (PASS/FAIL; CI-gateable)",
    "  vh dataset report <manifest> [--verify <dir>] [--policy <p>]  ONE deterministic evidence document (combined CI gate)",
    "  vh dataset attest <manifest> [--out <p>]  canonical UNSIGNED attestation payload (the signing-ready bytes)",
    "  vh dataset sign <manifest> --key-env <VAR>|--key-file <p> [--out <p>]  sign with YOUR key -> signed container (offline)",
    "  vh dataset verify-attest <signed> [--manifest <m>] [--signer <addr>]  OFFLINE verify a signed attestation (no key/net)",
    "  vh dataset timestamp-request <manifest>  emit the SHA-256 digest your RFC-3161 TSA stamps (no key/net)",
    "  vh dataset timestamp-wrap <manifest> --token <p>  wrap a TSA token -> verifiable timestamped container (no key/net)",
    "  vh dataset prove --file <p> --manifest <m>  prove ONE file was a member of the dataset (OFFLINE)",
    "  vh dataset verify-proof <proof>  fold a membership proof OFFLINE (no dataset, no key, no network)",
    "  vh parcel build <dir> --out <p>  tamper-evident DELIVERY receipt (root + per-file leaves + untrusted parcel meta)",
    "  vh parcel verify <dir> --manifest <p>  re-derive the root + per-file diff vs a parcel manifest (OFFLINE)",
    "  vh parcel attest <manifest> [--out <p>]  canonical UNSIGNED parcel-attestation payload (the signing-ready bytes)",
    "  vh parcel sign <manifest> --key-env <VAR>|--key-file <p> [--out <p>]  sign with YOUR key -> signed container (offline)",
    "  vh parcel verify-attest <signed> [--manifest <m>] [--signer <addr>]  OFFLINE verify a signed parcel attestation (no key/net)",
    "  vh parcel timestamp-request <manifest>  emit the SHA-256 digest your RFC-3161 TSA stamps (no key/net)",
    "  vh parcel timestamp-wrap <manifest> --token <p>  wrap a TSA token -> verifiable timestamped container (no key/net)",
    "",
    "hash options:",
    "  --git                      hash EXACTLY the files git tracks (ignores untracked junk like",
    "                             node_modules/, .env, build artifacts); <path> must be in a git repo",
    "  --ref <ref>                with --git: which commit's tracked set to hash (default HEAD)",
    "",
    "anchor options (one-shot; contributor = 'first anchorer', NOT proven authorship):",
    "  --uri <uri>                optional off-chain pointer stored with the hash (IPFS CID, URL)",
    "  --parent <0xhash>          record an immutable predecessor edge to an ALREADY-anchored hash",
    "                             (the lineage graph). Routes to anchorWithParent(); the parent must",
    "                             already exist or the tx reverts UnknownParent. Omit it for a root.",
    "                             A `parent` is only a CLAIMED predecessor: it proves neither content",
    "                             ancestry nor any transfer of the parent's authorship.",
    "  --git                      anchor EXACTLY the files git tracks (ignores untracked junk); records",
    "                             a `git` provenance hint (commit oid + scope) in the receipt",
    "  --ref <ref>                with --git: which commit's tracked set to anchor (default HEAD)",
    "  --receipt <path>           write an anchor receipt here (records a dir's per-file manifest",
    "                             so `vh verify <dir> --receipt <p>` can localize WHICH file changed)",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --dry-run                  print the tx that would be sent; needs no key, sends nothing",
    "  --i-understand-mainnet     allow anchoring on a non-testnet chainId (DANGER: real funds)",
    "",
    "claim options (commit-reveal one-shot; contributor = proven first claimant, authorBound = true):",
    "  --uri <uri>                optional off-chain pointer stored with the hash (IPFS CID, URL)",
    "  --parent <0xhash>          record an immutable predecessor edge to an ALREADY-anchored hash",
    "                             (routes the reveal leg to revealWithParent(); the parent must already",
    "                             exist or it reverts UnknownParent). Works on the one-shot `vh claim`",
    "                             AND on the resumable split: `vh commit --parent` persists the edge",
    "                             into the receipt (v4) and `vh reveal` then records it — no reveal flag.",
    "  --git                      claim EXACTLY the files git tracks (records a `git` provenance hint)",
    "  --ref <ref>                with --git: which commit's tracked set to claim (default HEAD)",
    "  --salt <0xhex>             reuse a 32-byte salt (default: a fresh random one)",
    "  --receipt <path>           persist a resumable claim receipt at this exact path (holds the SECRET",
    "                             salt). WITHOUT it the one-shot claim persists NOTHING — use `vh commit`",
    "                             for a durable, resumable receipt.",
    "  --receipt-dir <dir>        persist the receipt into this directory under its default file name",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --dry-run                  print the commit+reveal plan; needs no key, sends nothing",
    "  --i-understand-mainnet     allow claiming on a non-testnet chainId (DANGER: real funds)",
    "",
    "commit options (step 1 of a resumable claim; writes a receipt, then commits):",
    "  --uri <uri>                pointer recorded at reveal time (kept in the receipt until then)",
    "  --parent <0xhash>          persist a predecessor edge to an ALREADY-anchored hash into the receipt;",
    "                             the resumed `vh reveal` routes to revealWithParent() and records it (the",
    "                             commit() tx itself carries no parent — the edge is recorded at reveal time).",
    "                             A malformed/self-referential value hard-errors BEFORE any network call.",
    "  --git                      commit EXACTLY the files git tracks (records a `git` provenance hint)",
    "  --ref <ref>                with --git: which commit's tracked set to commit (default HEAD)",
    "  --salt <0xhex>             reuse a 32-byte salt (default: a fresh random one)",
    "  --receipt <path>           write the claim receipt (holds the SECRET salt) at this exact path;",
    "                             default <cwd>/<hashPrefix>.vhclaim.json — the EXACT file written is",
    "                             always named in the success output so you can see/relocate/delete it",
    "  --receipt-dir <dir>        write the receipt into this directory under its default file name",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --i-understand-mainnet     allow committing on a non-testnet chainId (DANGER: real funds)",
    "",
    "reveal options (step 2; resumes a prior commit from its receipt and reveals):",
    "  --receipt <path>           REQUIRED: the receipt file written by `vh commit`. If the receipt",
    "                             recorded a `--parent` it reveals via revealWithParent() (records the",
    "                             lineage edge); otherwise it uses the legacy reveal(). No --parent flag.",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --i-understand-mainnet     allow revealing on a non-testnet chainId (DANGER: real funds)",
    "",
    "verify options:",
    "  --git                      recompute the root over EXACTLY the files git tracks (ignores",
    "                             untracked junk); reproducible end-to-end against a fresh checkout",
    "  --ref <ref>                with --git: which commit's tracked set to verify (default HEAD)",
    "  --receipt <path>           UNTRUSTED hint: diff a dir against this receipt's manifest and print",
    "                             ADDED/REMOVED/CHANGED per file (verdict still = root vs on-chain)",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --skip-identity-check      DANGER: skip authenticating the contract is a real verifyhash registry",
    "                             (only for a KNOWN local/not-yet-deployed contract). The verdict is then",
    "                             only as trustworthy as the RPC you pointed at. NEVER the default.",
    "",
    "prove options:",
    "  --root <dir>               the repo root directory whose Merkle root <file> is proven against",
    "  --out <path>               write a self-contained, portable proof artifact here (works on the",
    "                             no-key --dry-run/build path); verify it later with `vh verify-proof`",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --anchor                   anchor the repo root first (needs PRIVATE_KEY), then prove",
    "  --i-understand-mainnet     allow --anchor on a non-testnet chainId (DANGER: real funds)",
    "  --dry-run                  build & print the proof only; needs no key and no network",
    "",
    "verify-proof options (read-only, NO key; needs only the artifact + an RPC URL — no repo):",
    "  <p>                        path to a proof artifact written by `vh prove --out <p>`",
    "  --contract <address>       ContributionRegistry address (or the artifact's recorded address)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --json                     emit a machine-readable JSON object instead of the human block",
    "  --skip-identity-check      DANGER: skip authenticating the contract + the artifact's chainId",
    "                             cross-check (only for a KNOWN local/not-yet-deployed contract). NEVER",
    "                             the default — the verdict is then only as trustworthy as the RPC.",
    "  Re-derives the leaf + re-folds the proof OFFLINE, then confirms the root is anchored on-chain.",
    "  Prints ACCEPTED only when the offline fold AND the on-chain checks all pass; else REJECTED /",
    "  NOT ANCHORED (non-zero exit). Proves SET-MEMBERSHIP in an anchored root, not authorship/uri.",
    "",
    "list options (read-only enumeration; provider only, never a signer/key):",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --contributor <address>    only records whose contributor is this address",
    "  --author-bound             only commit-reveal records (authorBound = proven first claimant)",
    "  --limit <n>                show at most n records (after --offset)",
    "  --offset <n>               skip the first n (filtered) records",
    "  --json                     emit a machine-readable JSON envelope { registry, records }",
    "  --skip-identity-check      DANGER: skip authenticating the contract is a real verifyhash registry",
    "                             (only for a KNOWN local/not-yet-deployed contract). NEVER the default.",
    "",
    "show options (read-only lookup by hash; provider only, never a signer/key):",
    "  <0xhash>                   a 32-byte (0x + 64 hex) content hash, e.g. from `vh list`",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --json                     emit a machine-readable JSON object instead of the human block",
    "  --skip-identity-check      DANGER: skip authenticating the contract is a real verifyhash registry",
    "                             (only for a KNOWN local/not-yet-deployed contract). NEVER the default.",
    "  NOTE: `show` proves only that the hash is on-chain; it does NOT re-derive content. To bind a",
    "        record to real bytes you must still run `vh verify <path>`. Exits non-zero if NOT ANCHORED.",
    "",
    "lineage options (read-only walk UP the parent chain; provider only, never a signer/key):",
    "  <0xhash>                   a 32-byte (0x + 64 hex) content hash to start the walk from",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --max-depth <n>            cap the walk at n ancestors (default 256); reaching the cap prints a",
    "                             clear note instead of looping forever on a pathological chain",
    "  --json                     emit a machine-readable ordered ancestor array instead of the human block",
    "  --skip-identity-check      DANGER: skip authenticating the contract is a real verifyhash registry",
    "                             (only for a KNOWN local/not-yet-deployed contract). NEVER the default.",
    "  Walks child -> parent -> ... to the lineage root, printing each ancestor (contentHash, contributor,",
    "  attribution, timestamp+ISO, blockNumber, uri). A `parent` is only the CHILD author's CLAIMED",
    "  predecessor: it proves neither content ancestry nor a transfer of authorship. Exits non-zero if the",
    "  start hash is NOT ANCHORED.",
    "",
    "reputation options (read-only score for ONE address; provider only, never a signer/key):",
    "  <addr>                     a 20-byte (0x + 40 hex) contributor address, e.g. from `vh list`",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --json                     emit a machine-readable JSON object instead of the human block",
    "  --skip-identity-check      DANGER: skip authenticating the contract is a real verifyhash registry",
    "                             (only for a KNOWN local/not-yet-deployed contract). NEVER the default.",
    "  Reports total records + authorBound vs anchor-only + lineage-root vs revision breakdowns + the",
    "  earliest/latest block & timestamp. The score is a TRANSPARENT, on-chain-DERIVED aggregate — NOT a",
    "  token, NOT transferable. An anchor-only count is WEAKER (a plain anchor() is front-runnable), so the",
    "  breakdown reports authorBound and anchor-only SEPARATELY. It does NOT validate record CONTENT (run",
    "  `vh verify` for that). Exits non-zero if the address has NO contributions.",
    "",
    "dataset build options (tamper-evident dataset manifest; offline, NO key, NO network):",
    "  <dir>                      the dataset directory to manifest (walked recursively)",
    "  --out <path>               REQUIRED: write the manifest JSON here (caller-chosen path; never cwd).",
    "                             The exact absolute file written is named in the success output.",
    "  --hints <path>             OPTIONAL: a JSON file { \"<relPath>\": { source, license } } of UNTRUSTED",
    "                             per-file provenance hints. They are recorded labeled as untrusted and are",
    "                             NOT bound into the Merkle root — editing them does not change the root.",
    "  --json                     emit a machine-readable { root, fileCount, out } object",
    "  Streams each file (a multi-GB dataset is hashed without loading all content into memory). The root",
    "  reuses the SAME path-bound Merkle convention as `vh hash <dir>` and the on-chain verifyLeaf — the",
    "  root commits to file NAMES and bytes, so any edit/rename/add/remove changes it.",
    "",
    "dataset verify options (OFFLINE re-derive + per-file diff; NO key, NO network):",
    "  <dir>                      the dataset directory to RE-DERIVE the root from (a fresh copy on disk)",
    "  --manifest <path>          REQUIRED: a manifest written by `vh dataset build` (an UNTRUSTED hint).",
    "  --json                     emit a machine-readable { status, recomputedRoot, manifestRoot, ... }",
    "  The AUTHORITATIVE verdict is recomputed-root vs manifest-root — recomputed from the bytes on disk,",
    "  so a hand-edited manifest root cannot fake a MATCH. Prints a precise per-file ADDED/REMOVED/CHANGED",
    "  (old->new contentHash) diff (the SAME diff core as `vh verify --receipt`) to localize WHICH file",
    "  diverged; a rename shows as REMOVED+ADDED (the root commits to file names). Exit 0 MATCH, 3 MISMATCH.",
    "",
    "dataset diff options (OFFLINE manifest-to-manifest change report; NO tree, NO key, NO network):",
    "  <manifestA>                REQUIRED: the BASELINE manifest (the 'from')",
    "  <manifestB>                REQUIRED: the COMPARISON manifest (the 'to')",
    "  --json                     emit { rootA, rootB, rootsIdentical, identical, added, removed, changed, unchanged, counts }",
    "  Reads BOTH via the strict readManifest (a corrupt/foreign manifest is rejected) and diffs them by",
    "  REUSING the SAME diff core as `vh dataset verify`. ADDED = in B not A, REMOVED = in A not B,",
    "  CHANGED = same relPath/different content (old->new). A rename shows as REMOVED+ADDED (the path is",
    "  bound into the leaf). Compares what each manifest CLAIMS — it does NOT re-derive content (use",
    "  `vh dataset verify` against the live tree for that). The verdict/exit code is the CHANGE SET",
    "  (`identical`), NOT root-string equality. Exit 0 IDENTICAL, 3 DIFFERENT.",
    "",
    "dataset summary options (OFFLINE provenance/license roll-up; NO tree, NO key, NO network):",
    "  <manifest>                 REQUIRED: a manifest written by `vh dataset build`",
    "  --json                     emit { root, fileCount, licenses, sources, filesWithLicenseHint, filesWithSourceHint }",
    "  Reads the manifest via the strict readManifest (a corrupt/foreign manifest is rejected) and rolls",
    "  up the TRUSTED file set: total fileCount, the root, and license + source histograms (count of",
    "  files per CLAIMED value; files with no hint grouped under '(no license hint)' / '(no source hint)').",
    "  The file SET (relPath + content) is bound into the root and trustworthy; the {source, license}",
    "  hints are UNTRUSTED, self-asserted metadata NOT bound into the root — this counts what the dataset",
    "  CLAIMS, it does NOT verify any license/source is correct. '(no license hint)' means the manifest",
    "  asserts nothing, NOT that the file is unlicensed. Exit 0; usage error 2; corrupt/missing manifest 1.",
    "",
    "dataset check options (OFFLINE license/source policy gate; NO tree, NO key, NO network):",
    "  <manifest>                 REQUIRED: a manifest written by `vh dataset build`",
    "  --policy <path>            REQUIRED: a versioned policy file. ALL rules OPTIONAL and combinable:",
    "                             allowLicenses (allowlist), denyLicenses (denylist), allowSources,",
    "                             denySources, requireLicense:true (every file MUST carry a license hint).",
    "  --json                     emit { verdict, fileCount, rulesEvaluated, violations:[{relPath,rule,value}] }",
    "  Reads the manifest AND policy strictly (a corrupt/foreign one is rejected) and evaluates the",
    "  manifest's TRUSTED file set against the policy in a PURE, deterministic function. Match semantics:",
    "  CASE-SENSITIVE EXACT string match on the hint value. A policy with NO rules trivially PASSes. The",
    "  {source, license} hints are UNTRUSTED, self-asserted metadata NOT bound into the root: a PASS means",
    "  the dataset's self-asserted hints satisfy this policy, NOT that the licenses are genuinely correct.",
    "  Violations are sorted by relPath then rule (byte-identical output across runs). A missing --policy",
    "  is a usage error. Exit 0 PASS, 3 FAIL; usage error 2; corrupt/missing manifest OR policy 1.",
    "",
    "dataset report options (ONE deterministic evidence document; OFFLINE; NO key, NO network):",
    "  <manifest>                 REQUIRED: a manifest written by `vh dataset build`",
    "  --verify <dir>             OPTIONAL: re-derive the root from this live tree (REUSES dataset verify)",
    "                             and embed the MATCH/MISMATCH verdict + per-file ADDED/REMOVED/CHANGED.",
    "                             Without it, the report states plainly that NO live-tree verify was done.",
    "  --policy <path>            OPTIONAL: evaluate the manifest against this policy (REUSES the SAME pure",
    "                             evaluator as `vh dataset check`) and embed a 'Policy compliance' section",
    "                             (verdict + rules evaluated + violating files: relPath/rule/value).",
    "  --out <path>               write the report to this explicit path (caller-chosen; never cwd); the",
    "                             exact file written is named. Without it the report prints to stdout.",
    "  --json                     emit { root, fileCount, licenses, sources, filesWithLicenseHint,",
    "                             filesWithSourceHint, verify?, policy? } instead of the Markdown document",
    "  Reads the manifest strictly (a corrupt/foreign manifest is rejected) and CONSOLIDATES the dataset",
    "  identity (root + fileCount), the provenance/license roll-up (the SAME aggregation as `vh dataset",
    "  summary`), and the standing trust caveats into ONE document. Default human output is DETERMINISTIC",
    "  Markdown (byte-identical across runs over the same manifest + policy). It LEADS with the trust",
    "  posture and does NOT overclaim: it is NOT a timestamp ('unaltered since date T' needs a human-signed",
    "  step), and a policy PASS attests the dataset's UNTRUSTED self-asserted hints satisfy the policy, NOT",
    "  that the licenses are genuinely correct.",
    "  Exit (the report is a COMBINED CI gate — non-zero if ANY embedded gate fails, 0 only when all pass):",
    "    with --verify: 0 MATCH / 3 MISMATCH; with --policy: 0 PASS / 3 FAIL; with BOTH: 3 if EITHER fails,",
    "    0 only when MATCH AND PASS; without either gate: 0 on a well-formed manifest. Usage error 2;",
    "    corrupt/missing manifest or policy (or bad --verify dir) 1.",
    "",
    "dataset attest options (canonical UNSIGNED attestation payload; OFFLINE; NO key, NO network):",
    "  <manifest>                 REQUIRED: a manifest written by `vh dataset build`",
    "  --out <path>               write the canonical payload to this explicit path (caller-chosen; never",
    "                             cwd); the exact file written is named. Without it, it prints to stdout.",
    "  --json                     emit the machine form — which IS the canonical, signable bytes",
    "  Reads the manifest strictly (a corrupt/foreign manifest is rejected) and emits a versioned,",
    "  strictly-validated, BYTE-DETERMINISTIC envelope committing to the dataset IDENTITY a signer signs:",
    "  the Merkle root, fileCount, and a canonical manifestDigest (keccak256 over a canonical serialization",
    "  of the committed file set — any edit to that set changes it). The envelope is marked `signed:false`",
    "  with a `signature:null` slot the human/timestamp step fills. This is the UNSIGNED payload: standing",
    "  up a real signing key / timestamp anchor is the human-owned trust-root (needs-human, P-3). Until a",
    "  signature is attached it proves only the same set-membership/identity the manifest already does —",
    "  NOT 'unaltered since date T'. Exit 0; usage error 2; corrupt/missing manifest 1.",
    "",
    "dataset sign options (sign the UNSIGNED attestation with YOUR key -> a signed container; OFFLINE; NO network):",
    "  <manifest>                 REQUIRED: a manifest written by `vh dataset build`",
    "  --key-env <VAR>            read the signing private key from process.env[VAR] (EXACTLY ONE key source)",
    "  --key-file <path>          read the signing private key from a file YOU created (EXACTLY ONE key source)",
    "  --out <path>               write the signed container here (caller-chosen; never cwd). Without it the",
    "                             signed bytes print to stdout. The signed container holds ONLY the PUBLIC",
    "                             signer address + signature — NEVER the key.",
    "  --json                     emit { signed, signer, scheme, out, kind, container, note } (public only; NO",
    "                             key). With NO --out, `container` carries the canonical signed bytes so --json",
    "                             never drops the artifact (parity with `attest --json`); with --out it is null.",
    "  Builds the UNSIGNED payload EXACTLY as `vh dataset attest` does (same canonical bytes), constructs an",
    "  in-process ethers Wallet from YOUR key, signs (eip191-personal-sign), and wraps it WITHOUT editing the",
    "  payload. The key is read, used, and discarded — NEVER generated, persisted, or logged; the success",
    "  line states 'signed by <0xaddr>' so you can confirm WHICH key signed. EXACTLY ONE of --key-env/",
    "  --key-file is required: neither, both, a missing env var, an unreadable file, or a malformed/zero key",
    "  HARD-ERRORS BEFORE any signing (the message never includes the key). The output is accepted by",
    "  `vh dataset verify-attest` unchanged. This signs the dataset IDENTITY with the key YOU supplied — it",
    "  is NOT a trusted TIMESTAMP ('the signer says so', not 'existed by date T'; P-3). The key must be one",
    "  YOU provisioned outside this tool. Exit 0; usage error 2 (no/both key source, unknown flag); runtime 1.",
    "",
    "dataset verify-attest options (OFFLINE verify a SIGNED attestation; NO tree, NO provider, NO key, NO network):",
    "  <signed>                   REQUIRED: a signed-attestation container (the wrapped, signed T-17.1 artifact)",
    "  --manifest <path>          OPTIONAL: bind the signature to YOUR dataset — recompute the canonical",
    "                             attestation bytes from this manifest and require them byte-identical to the",
    "                             signed payload (a binding mismatch REJECTS).",
    "  --signer <addr>            OPTIONAL: pin the EXPECTED publisher — require the RECOVERED signer to equal",
    "                             this address (so a buyer pins WHO must have signed, not just that someone did)",
    "  --json                     emit a machine verdict { verdict, recoveredSigner, expectedSigner, checks, ... }",
    "  Reads the container strictly (a malformed/edited/foreign one is rejected), recovers the signing address",
    "  from the embedded canonical bytes + signature per the declared scheme (eip191-personal-sign), and",
    "  confirms it equals the container's `signer`. With --signer it also pins the expected publisher; with",
    "  --manifest it also confirms the signature binds the dataset you hold. Prints ACCEPTED only when EVERY",
    "  requested check passes, else REJECTED naming which failed. A valid signature proves the key-holder",
    "  vouched for this dataset IDENTITY — NOT a timestamp ('unaltered since date T' still needs P-3) and NOT",
    "  that the license/source hints are correct. Exit 0 ACCEPTED, 3 REJECTED; usage error 2; corrupt input 1.",
    "",
    "dataset prove options (OFFLINE set-membership of ONE file; NO key, NO network):",
    "  --file <path>              REQUIRED: the single file to prove was a member of the dataset",
    "  --manifest <path>          REQUIRED: a manifest written by `vh dataset build`",
    "  --out <path>               write a self-contained proof artifact here (caller-chosen; never cwd).",
    "                             Verify it later with `vh dataset verify-proof <p>` — no dataset needed.",
    "  --json                     emit a machine-readable { member, contentHash, relPath, root, ... }",
    "  Matches the file by CONTENT against the manifest's committed leaves and builds the Merkle proof",
    "  folding its leaf to the manifest root (the SAME construction as `vh prove`). A fabricated/altered",
    "  file is a clear NON-member (no artifact written). Exit 0 MEMBER, 3 NOT A MEMBER. Proves",
    "  SET-MEMBERSHIP only — NOT 'unaltered since date T', authorship, or licensing (a human-signed step).",
    "",
    "dataset verify-proof options (PURELY OFFLINE; NO dataset copy, NO manifest, NO key, NO network):",
    "  <proof>                    path to a proof artifact written by `vh dataset prove --out <p>`",
    "  --json                     emit a machine-readable { status, leafMatches, foldsToRoot, ... }",
    "  Folds the leaf through the proof to the recorded root (reuses the SAME recompute as verify-proof).",
    "  Prints CONFIRMED only when the leaf re-derives AND folds to the root; else REJECTED (non-zero exit).",
    "  Proves SET-MEMBERSHIP in the recorded root, NOT that the root is anchored on-chain (`vh verify-proof`",
    "  does the on-chain leg) nor 'unaltered since date T'. Exit 0 CONFIRMED, 3 REJECTED.",
    "",
    "parcel build options (tamper-evident DELIVERY receipt; offline, NO key, NO network):",
    "  <dir>                      the delivered directory to manifest (walked recursively)",
    "  --out <path>               REQUIRED: where to write the parcel manifest (caller-chosen; never cwd)",
    "  --parcel-id <s>            OPTIONAL untrusted self-asserted parcel identifier (NOT bound into the root)",
    "  --sender <s>               OPTIONAL untrusted self-asserted sender (NOT bound into the root)",
    "  --recipient <s>            OPTIONAL untrusted self-asserted recipient (NOT bound into the root)",
    "  --hints <path>             OPTIONAL JSON of untrusted per-file {source,license} hints",
    "  --json                     emit { root, fileCount, out, parcel } instead of the human summary",
    "  Same Merkle root + per-file {relPath,contentHash,leaf} as a dataset manifest, PLUS an OPTIONAL,",
    "  UNTRUSTED `parcel` block (parcelId/sender/recipient) recorded as self-asserted metadata that is NOT",
    "  bound into the root. The receipt is NOT a trusted delivery timestamp — 'delivered ON date T' needs",
    "  the human-owned signing/timestamp trust-root (STRATEGY.md P-3). Exit 0; usage error 2; runtime 1.",
    "",
    "parcel verify options (OFFLINE re-derive + per-file diff; NO key, NO network):",
    "  <dir>                      the delivered directory to RE-DERIVE the root from (a fresh copy on disk)",
    "  --manifest <path>          REQUIRED: a manifest written by `vh parcel build` (an UNTRUSTED hint)",
    "  --json                     emit { status, recomputedRoot, manifestRoot, parcel, diff } as JSON",
    "  Re-derives the root from disk and prints MATCH/MISMATCH + a precise per-file ADDED/REMOVED/CHANGED",
    "  diff (the SAME diff core as `vh dataset verify`). The AUTHORITATIVE verdict is recomputed-root vs",
    "  manifest-root; the untrusted `parcel` block plays NO part in it. Exit 0 MATCH, 3 MISMATCH (mirrors",
    "  `vh dataset verify` so all verify gates share ONE exit contract); usage 2; corrupt/missing manifest 1.",
    "",
    "parcel attest options (canonical UNSIGNED parcel-attestation payload; OFFLINE; NO key, NO network):",
    "  <manifest>                 REQUIRED: a manifest written by `vh parcel build`",
    "  --out <path>               OPTIONAL: write the canonical bytes here (caller-chosen; never cwd)",
    "  --json                     emit the canonical machine form (which IS the same signable bytes)",
    "  Emits the deterministic, byte-canonical UNSIGNED attestation (root + fileCount + a canonical",
    "  manifestDigest over the delivered file SET) over the SAME core as `vh dataset attest`, with",
    "  `signed:false`. The UNTRUSTED `parcel` block is EXCLUDED. It is NOT a timestamp — attaching a real",
    "  signature is the human-owned signing/timestamp trust-root (STRATEGY.md P-3). Exit 0; usage 2; runtime 1.",
    "",
    "parcel sign options (sign the UNSIGNED parcel attestation with YOUR key -> a signed container; OFFLINE; NO network):",
    "  <manifest>                 REQUIRED: a manifest written by `vh parcel build`",
    "  --key-env <VAR>            read the signing private key from process.env[VAR] (EXACTLY ONE key source)",
    "  --key-file <path>          read the signing private key from a file YOU created (EXACTLY ONE key source)",
    "  --out <path>               write the signed container here (caller-chosen; never cwd). Without it the",
    "                             signed bytes print to stdout. The container holds ONLY the PUBLIC signer",
    "                             address + signature — NEVER the key.",
    "  --json                     emit { signed, signer, scheme, out, kind, container, note } (public only; NO",
    "                             key). With NO --out, `container` carries the canonical signed bytes so --json",
    "                             never drops the artifact (parity with `attest --json`); with --out it is null.",
    "  Builds the UNSIGNED payload EXACTLY as `vh parcel attest` does, constructs an in-process ethers Wallet",
    "  from YOUR key, signs (eip191-personal-sign), and wraps it WITHOUT editing the payload. The key is read,",
    "  used, and discarded — NEVER generated, persisted, or logged; 'signed by <0xaddr>' confirms WHICH key",
    "  signed. EXACTLY ONE of --key-env/--key-file is required: neither, both, a missing env var, an unreadable",
    "  file, or a malformed/zero key HARD-ERRORS BEFORE any signing (the message never includes the key). The",
    "  output is accepted by `vh parcel verify-attest` unchanged. This signs the parcel IDENTITY with the key",
    "  YOU supplied — it is NOT a trusted delivery TIMESTAMP ('the signer says so'; P-3). The key must be one",
    "  YOU provisioned outside this tool. Exit 0; usage error 2 (no/both key source, unknown flag); runtime 1.",
    "",
    "parcel verify-attest options (OFFLINE verify a SIGNED parcel attestation; NO tree, NO provider, NO key, NO network):",
    "  <signed>                   REQUIRED: a signed parcel-attestation container",
    "  --manifest <path>          OPTIONAL: bind the signature to YOUR parcel — recompute the canonical UNSIGNED",
    "                             bytes from this manifest and require them byte-identical to the signed payload",
    "  --signer <addr>            OPTIONAL: pin the expected SENDER (recovered signer must equal this address)",
    "  --json                     emit the machine-readable verdict (recovered signer + per-check booleans)",
    "  Recovers the signer over the SAME core as `vh dataset verify-attest`; the parcel signed-container kind",
    "  (verifyhash.parcel-attestation-signed) means a DATASET signed-container does NOT cross-verify. A valid",
    "  signature is NOT a delivery timestamp (STRATEGY.md P-3). Exit 0 ACCEPTED, 3 REJECTED; usage 2; runtime 1.",
    "",
  ].join("\n");
}

/**
 * Parse `hash` argv into { path, git, ref }. Takes exactly one positional <path>. `--git` scopes the
 * hash to git-tracked files; `--ref <ref>` selects which commit's tracked set (only with `--git`).
 * Throws on unknown/incomplete flags, a duplicate path, or `--ref` without `--git` (parser parity
 * with the other commands) so a typo never silently changes what gets hashed.
 */
function parseHashArgs(argv) {
  const opts = { path: undefined, git: false, ref: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--git":
        opts.git = true;
        break;
      case "--ref":
        opts.ref = argv[++i];
        if (opts.ref === undefined) throw new Error("--ref requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.path !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.path = a;
    }
  }
  // --ref is meaningful only when scoping to git-tracked files; flag it rather than silently ignore.
  if (opts.ref !== undefined && !opts.git) {
    throw new Error("--ref requires --git (it selects which commit's tracked files to hash)");
  }
  return opts;
}

function cmdHash(argv) {
  let opts;
  try {
    opts = parseHashArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.path) {
    process.stderr.write("error: `vh hash` requires a <path>\n\n" + usage());
    return 2;
  }

  // --git: hash EXACTLY the files git tracks (no filesystem walk, no untracked junk). Errors clearly
  // on a non-git dir / unknown ref / zero tracked files — it never silently falls back to the walk.
  if (opts.git) {
    let result;
    try {
      result = hashGit(opts.path, { ref: opts.ref });
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    // Print the root, then the resolved commit oid as a `# commit <oid>` comment so the snapshot is
    // SELF-DESCRIBING: an operator running `--git --ref some-branch` can see WHICH commit produced
    // this root (the whole point of a commit-pinned, reproducible snapshot). The comment leads with
    // `#` so a downstream consumer of the line-oriented `<leaf>  <path>` body can skip it trivially,
    // and the root stays on line 1 — the human shape is otherwise byte-identical to the dir output.
    process.stdout.write(result.root + "\n");
    process.stdout.write(`# commit ${result.commit}\n`);
    for (const { path: p, leaf } of result.leaves) {
      process.stdout.write(`${leaf}  ${p}\n`);
    }
    return 0;
  }

  let result;
  try {
    result = hashPath(opts.path);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  if (result.kind === "file") {
    process.stdout.write(result.root + "\n");
  } else {
    // Directory: print the root, then each file's path-bound leaf (what verifyLeaf consumes) for
    // transparency. The root commits to file NAMES and content, so the leaf binds the path.
    process.stdout.write(result.root + "\n");
    for (const { path: p, leaf } of result.leaves) {
      process.stdout.write(`${leaf}  ${p}\n`);
    }
  }
  return 0;
}

/**
 * Parse `anchor` argv into { path, uri, contract, rpc, dryRun, iUnderstandMainnet }.
 * Throws on unknown/incomplete flags so a typo never silently turns into a real submission.
 */
function parseAnchorArgs(argv) {
  const opts = {
    path: undefined,
    uri: undefined,
    parent: undefined,
    receipt: undefined,
    contract: undefined,
    rpc: undefined,
    git: false,
    ref: undefined,
    dryRun: false,
    iUnderstandMainnet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--i-understand-mainnet":
        opts.iUnderstandMainnet = true;
        break;
      case "--git":
        opts.git = true;
        break;
      case "--ref":
        opts.ref = argv[++i];
        if (opts.ref === undefined) throw new Error("--ref requires a value");
        break;
      case "--uri":
        opts.uri = argv[++i];
        if (opts.uri === undefined) throw new Error("--uri requires a value");
        break;
      case "--parent":
        opts.parent = argv[++i];
        if (opts.parent === undefined) throw new Error("--parent requires a value");
        break;
      case "--receipt":
        opts.receipt = argv[++i];
        if (opts.receipt === undefined) throw new Error("--receipt requires a value");
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.path !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.path = a;
    }
  }
  // --ref is meaningful only when scoping to git-tracked files (parser parity with `vh hash`).
  if (opts.ref !== undefined && !opts.git) {
    throw new Error("--ref requires --git (it selects which commit's tracked files to anchor)");
  }
  return opts;
}

async function cmdAnchor(argv) {
  let opts;
  try {
    opts = parseAnchorArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.path) {
    process.stderr.write("error: `vh anchor` requires a <path>\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");
  const contractAddress = opts.contract || process.env.VH_CONTRACT;

  // For a dry run we never construct a signer/provider: it must work with no key and no network.
  if (opts.dryRun) {
    try {
      await runAnchor({
        path: opts.path,
        uri: opts.uri,
        parent: opts.parent,
        git: opts.git,
        ref: opts.ref,
        contractAddress,
        receiptPath: opts.receipt,
        dryRun: true,
        ethers,
      });
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    return 0;
  }

  // Real submission: build provider + signer from env/flags.
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL " +
        "(or use --dry-run to preview without a network)\n"
    );
    return 1;
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    process.stderr.write(
      "error: no PRIVATE_KEY in the environment; cannot sign. Use --dry-run to preview.\n"
    );
    return 1;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(pk, provider);
    await runAnchor({
      path: opts.path,
      uri: opts.uri,
      parent: opts.parent,
      git: opts.git,
      ref: opts.ref,
      contractAddress,
      receiptPath: opts.receipt,
      iUnderstandMainnet: opts.iUnderstandMainnet,
      provider,
      signer,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * Parse `claim`/`commit` argv into { path, uri, salt, receipt, contract, rpc, dryRun,
 * iUnderstandMainnet }. Throws on unknown/incomplete flags so a typo never silently turns into a
 * real submission. Both `vh claim` and `vh commit` take the same flags (commit ignores --dry-run).
 */
function parseClaimArgs(argv) {
  const opts = {
    path: undefined,
    uri: undefined,
    parent: undefined,
    salt: undefined,
    receipt: undefined,
    receiptDir: undefined,
    contract: undefined,
    rpc: undefined,
    git: false,
    ref: undefined,
    dryRun: false,
    iUnderstandMainnet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--i-understand-mainnet":
        opts.iUnderstandMainnet = true;
        break;
      case "--git":
        opts.git = true;
        break;
      case "--ref":
        opts.ref = argv[++i];
        if (opts.ref === undefined) throw new Error("--ref requires a value");
        break;
      case "--uri":
        opts.uri = argv[++i];
        if (opts.uri === undefined) throw new Error("--uri requires a value");
        break;
      case "--parent":
        opts.parent = argv[++i];
        if (opts.parent === undefined) throw new Error("--parent requires a value");
        break;
      case "--salt":
        opts.salt = argv[++i];
        if (opts.salt === undefined) throw new Error("--salt requires a value");
        break;
      case "--receipt":
        opts.receipt = argv[++i];
        if (opts.receipt === undefined) throw new Error("--receipt requires a value");
        break;
      case "--receipt-dir":
        opts.receiptDir = argv[++i];
        if (opts.receiptDir === undefined) throw new Error("--receipt-dir requires a value");
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.path !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.path = a;
    }
  }
  // --ref is meaningful only when scoping to git-tracked files (parser parity with `vh hash`).
  if (opts.ref !== undefined && !opts.git) {
    throw new Error("--ref requires --git (it selects which commit's tracked files to claim)");
  }
  // --receipt picks the exact file; --receipt-dir picks the folder. Asking for both is ambiguous, so
  // hard-error rather than silently honor one (a fat-fingered combination must not pick a surprise path).
  if (opts.receipt !== undefined && opts.receiptDir !== undefined) {
    throw new Error("--receipt and --receipt-dir are mutually exclusive; pass at most one");
  }
  return opts;
}

/**
 * Parse `reveal` argv into { receipt, rpc, iUnderstandMainnet }. `--receipt <path>` is required and
 * carries everything reveal needs; there is no <path> positional. Throws on unknown/incomplete flags.
 */
function parseRevealArgs(argv) {
  const opts = { receipt: undefined, rpc: undefined, iUnderstandMainnet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--i-understand-mainnet":
        opts.iUnderstandMainnet = true;
        break;
      case "--receipt":
        opts.receipt = argv[++i];
        if (opts.receipt === undefined) throw new Error("--receipt requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        throw new Error(`unexpected extra argument: ${a}`);
    }
  }
  return opts;
}

async function cmdClaim(argv) {
  let opts;
  try {
    opts = parseClaimArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.path) {
    process.stderr.write("error: `vh claim` requires a <path>\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");
  const contractAddress = opts.contract || process.env.VH_CONTRACT;

  // Dry run: build the commit-reveal plan with no key and no network. We still need a committer
  // address to compute the (sender-bound) commitment; allow VH_COMMITTER for previewing.
  if (opts.dryRun) {
    try {
      await runClaim({
        path: opts.path,
        uri: opts.uri,
        parent: opts.parent,
        salt: opts.salt,
        git: opts.git,
        ref: opts.ref,
        committer: process.env.VH_COMMITTER,
        contractAddress,
        dryRun: true,
        ethers,
      });
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    return 0;
  }

  // Real submission: build provider + signer from env/flags.
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL " +
        "(or use --dry-run to preview without a network)\n"
    );
    return 1;
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    process.stderr.write(
      "error: no PRIVATE_KEY in the environment; cannot sign. Use --dry-run to preview.\n"
    );
    return 1;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(pk, provider);
    await runClaim({
      path: opts.path,
      uri: opts.uri,
      parent: opts.parent,
      salt: opts.salt,
      git: opts.git,
      ref: opts.ref,
      receiptPath: opts.receipt,
      receiptDir: opts.receiptDir,
      contractAddress,
      iUnderstandMainnet: opts.iUnderstandMainnet,
      provider,
      signer,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

async function cmdCommit(argv) {
  let opts;
  try {
    opts = parseClaimArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.path) {
    process.stderr.write("error: `vh commit` requires a <path>\n\n" + usage());
    return 2;
  }
  // `commit` has no dry-run: it intentionally sends a real tx and writes a receipt. A typo'd
  // --dry-run should not silently no-op into nothing useful.
  if (opts.dryRun) {
    process.stderr.write(
      "error: `vh commit` has no --dry-run; use `vh claim --dry-run` to preview the plan\n"
    );
    return 2;
  }
  // The lineage edge (B-10.1) belongs on the REVEAL leg (revealWithParent), and the resumable receipt
  // schema (v4) now persists `parent` so a resumed `vh reveal` can record it. We thread `opts.parent`
  // into runCommit, which validates it up front via the SAME normalizeParent as `vh anchor --parent`:
  // a malformed/self-referential value hard-errors BEFORE any network call (a typo never silently
  // drops the edge), surfacing through the catch below with exit 1.

  const ethers = require("ethers");
  const contractAddress = opts.contract || process.env.VH_CONTRACT;
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL\n"
    );
    return 1;
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    process.stderr.write(
      "error: no PRIVATE_KEY in the environment; cannot sign the commit.\n"
    );
    return 1;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(pk, provider);
    await runCommit({
      path: opts.path,
      uri: opts.uri,
      salt: opts.salt,
      parent: opts.parent, // B-10.1: persisted into the v4 receipt so `vh reveal` records the edge
      git: opts.git,
      ref: opts.ref,
      receiptPath: opts.receipt,
      receiptDir: opts.receiptDir,
      contractAddress,
      iUnderstandMainnet: opts.iUnderstandMainnet,
      provider,
      signer,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

async function cmdReveal(argv) {
  let opts;
  try {
    opts = parseRevealArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.receipt) {
    process.stderr.write("error: `vh reveal` requires --receipt <path>\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL\n"
    );
    return 1;
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    process.stderr.write(
      "error: no PRIVATE_KEY in the environment; cannot sign the reveal.\n"
    );
    return 1;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(pk, provider);
    await runReveal({
      receiptPath: opts.receipt,
      iUnderstandMainnet: opts.iUnderstandMainnet,
      provider,
      signer,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * Parse `verify` argv into { path, contract, rpc }.
 * Throws on unknown/incomplete flags so a typo is never silently ignored.
 */
function parseVerifyArgs(argv) {
  const opts = {
    path: undefined,
    contract: undefined,
    rpc: undefined,
    receipt: undefined,
    git: false,
    ref: undefined,
    skipIdentityCheck: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--skip-identity-check":
        opts.skipIdentityCheck = true;
        break;
      case "--git":
        opts.git = true;
        break;
      case "--ref":
        opts.ref = argv[++i];
        if (opts.ref === undefined) throw new Error("--ref requires a value");
        break;
      case "--receipt":
        opts.receipt = argv[++i];
        if (opts.receipt === undefined) throw new Error("--receipt requires a value");
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.path !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.path = a;
    }
  }
  // --ref is meaningful only when scoping to git-tracked files (parser parity with `vh hash`).
  if (opts.ref !== undefined && !opts.git) {
    throw new Error("--ref requires --git (it selects which commit's tracked files to verify)");
  }
  return opts;
}

async function cmdVerify(argv) {
  let opts;
  try {
    opts = parseVerifyArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.path) {
    process.stderr.write("error: `vh verify` requires a <path>\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");
  const contractAddress = opts.contract || process.env.VH_CONTRACT;
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL\n"
    );
    return 1;
  }

  let result;
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    result = await runVerify({
      path: opts.path,
      git: opts.git,
      ref: opts.ref,
      contractAddress,
      receiptPath: opts.receipt,
      skipIdentityCheck: opts.skipIdentityCheck,
      provider,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero on a tamper/MISMATCH so scripts and CI can branch on it.
  return result.status === "MATCH" ? 0 : 3;
}

/**
 * Parse `prove` argv into { file, root, contract, rpc, anchor, iUnderstandMainnet, dryRun }.
 * Throws on unknown/incomplete flags so a typo is never silently ignored.
 */
function parseProveArgs(argv) {
  const opts = {
    file: undefined,
    root: undefined,
    out: undefined,
    contract: undefined,
    rpc: undefined,
    anchor: false,
    iUnderstandMainnet: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--anchor":
        opts.anchor = true;
        break;
      case "--i-understand-mainnet":
        opts.iUnderstandMainnet = true;
        break;
      case "--root":
        opts.root = argv[++i];
        if (opts.root === undefined) throw new Error("--root requires a value");
        break;
      case "--out":
        opts.out = argv[++i];
        if (opts.out === undefined) throw new Error("--out requires a value");
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.file !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.file = a;
    }
  }
  return opts;
}

async function cmdProve(argv) {
  let opts;
  try {
    opts = parseProveArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.file) {
    process.stderr.write("error: `vh prove` requires a <file>\n\n" + usage());
    return 2;
  }
  if (!opts.root) {
    process.stderr.write("error: `vh prove` requires --root <dir> (the repo root)\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");

  // Dry run: only builds & prints the proof (and writes the --out artifact if asked). No key, no
  // network — must work entirely offline. This is the no-key build path for `--out`.
  if (opts.dryRun) {
    try {
      await runProve({ file: opts.file, rootDir: opts.root, out: opts.out, dryRun: true, ethers });
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    return 0;
  }

  const contractAddress = opts.contract || process.env.VH_CONTRACT;
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL " +
        "(or use --dry-run to build the proof without a network)\n"
    );
    return 1;
  }

  let result;
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    // Only the --anchor path needs to sign; verifying a proof is read-only.
    let signer;
    if (opts.anchor) {
      const pk = process.env.PRIVATE_KEY;
      if (!pk) {
        process.stderr.write(
          "error: --anchor needs a PRIVATE_KEY in the environment to submit the root\n"
        );
        return 1;
      }
      signer = new ethers.Wallet(pk, provider);
    }
    result = await runProve({
      file: opts.file,
      rootDir: opts.root,
      out: opts.out,
      contractAddress,
      provider,
      signer,
      anchorFirst: opts.anchor,
      iUnderstandMainnet: opts.iUnderstandMainnet,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero when the on-chain verifyLeaf rejects the proof (tampered / not in the snapshot),
  // so scripts and CI can branch on it.
  return result.accepted ? 0 : 3;
}

/**
 * Parse `verify-proof` argv into { artifact, contract, rpc, json }. Takes exactly one positional
 * <p> (the artifact path). Throws on unknown/incomplete flags or a duplicate/missing positional so a
 * typo never silently verifies the wrong file (parser parity with the other commands).
 */
function parseVerifyProofArgs(argv) {
  const opts = {
    artifact: undefined,
    contract: undefined,
    rpc: undefined,
    json: false,
    skipIdentityCheck: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--skip-identity-check":
        opts.skipIdentityCheck = true;
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.artifact !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.artifact = a;
    }
  }
  return opts;
}

async function cmdVerifyProof(argv) {
  let opts;
  try {
    opts = parseVerifyProofArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.artifact) {
    process.stderr.write("error: `vh verify-proof` requires a <p> (proof artifact path)\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");
  const contractAddress = opts.contract || process.env.VH_CONTRACT;
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL " +
        "(verify-proof confirms the root is anchored on-chain)\n"
    );
    return 1;
  }

  let result;
  try {
    // Read-only: provider only — `vh verify-proof` NEVER constructs a signer or touches a key.
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    result = await runVerifyProof({
      artifactPath: opts.artifact,
      contractAddress,
      provider,
      json: opts.json,
      skipIdentityCheck: opts.skipIdentityCheck,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit 0 ONLY on ACCEPTED. A NOT ANCHORED root is exit 4 (mirrors `vh show`'s NOT ANCHORED), a
  // REJECTED proof is exit 3 (mirrors `vh verify`/`vh prove`), so scripts/CI can branch on each.
  if (result.status === "ACCEPTED") return 0;
  if (result.status === "NOT_ANCHORED") return 4;
  return 3;
}

/**
 * Parse `list` argv into { contract, rpc, contributor, authorBound, limit, offset, json }.
 * `list` takes NO positional argument (it enumerates the whole registry). Throws on unknown or
 * incomplete flags so a typo never silently returns a wrong/empty list (parser parity with the
 * other commands). `--limit`/`--offset` must be non-negative integers.
 */
function parseListArgs(argv) {
  const opts = {
    contract: undefined,
    rpc: undefined,
    contributor: undefined,
    authorBound: false,
    limit: undefined,
    offset: undefined,
    json: false,
    skipIdentityCheck: false,
  };
  // Parse a flag value as a non-negative integer, hard-erroring on anything else.
  const intArg = (flag, raw) => {
    if (raw === undefined) throw new Error(`${flag} requires a value`);
    if (!/^\d+$/.test(raw)) throw new Error(`${flag} requires a non-negative integer, got: ${raw}`);
    return Number(raw);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--author-bound":
        opts.authorBound = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--skip-identity-check":
        opts.skipIdentityCheck = true;
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      case "--contributor":
        opts.contributor = argv[++i];
        if (opts.contributor === undefined) throw new Error("--contributor requires a value");
        break;
      case "--limit":
        opts.limit = intArg("--limit", argv[++i]);
        break;
      case "--offset":
        opts.offset = intArg("--offset", argv[++i]);
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        throw new Error(`unexpected argument: ${a} (vh list takes no positional path)`);
    }
  }
  return opts;
}

async function cmdList(argv) {
  let opts;
  try {
    opts = parseListArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }

  const ethers = require("ethers");
  const contractAddress = opts.contract || process.env.VH_CONTRACT;
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL\n"
    );
    return 1;
  }

  try {
    // Read-only: provider only — `vh list` NEVER constructs a signer or touches a key.
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    await runList({
      contractAddress,
      provider,
      filters: {
        contributor: opts.contributor,
        authorBound: opts.authorBound,
        limit: opts.limit,
        offset: opts.offset,
      },
      json: opts.json,
      skipIdentityCheck: opts.skipIdentityCheck,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * Parse `show` argv into { hash, contract, rpc, json }. Takes exactly one positional <0xhash>.
 * Throws on unknown/incomplete flags or a duplicate/missing hash so a typo never silently looks up
 * the wrong thing. The hash VALUE is shape-validated later (in runShow) so the same usage-grade error
 * fires whether the hash came from the CLI or a programmatic caller.
 */
function parseShowArgs(argv) {
  const opts = {
    hash: undefined,
    contract: undefined,
    rpc: undefined,
    json: false,
    skipIdentityCheck: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--skip-identity-check":
        opts.skipIdentityCheck = true;
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.hash !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.hash = a;
    }
  }
  return opts;
}

async function cmdShow(argv) {
  let opts;
  try {
    opts = parseShowArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.hash) {
    process.stderr.write("error: `vh show` requires a <0xhash>\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");

  // Validate the hash shape BEFORE building a provider or reading any env/network — a malformed/short
  // hash must hard-error with usage and never hit the network. We re-use runShow's normalizer (via a
  // dry, provider-less throw) by checking the shape here directly so the error precedes the RPC check.
  const { normalizeContentHash } = require("./show");
  try {
    normalizeContentHash(opts.hash, ethers);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }

  const contractAddress = opts.contract || process.env.VH_CONTRACT;
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL\n"
    );
    return 1;
  }

  let result;
  try {
    // Read-only: provider only — `vh show` NEVER constructs a signer or touches a key.
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    result = await runShow({
      contentHash: opts.hash,
      contractAddress,
      provider,
      json: opts.json,
      skipIdentityCheck: opts.skipIdentityCheck,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero when the hash has no record so scripts/CI can branch on "NOT ANCHORED".
  return result.status === "ANCHORED" ? 0 : 4;
}

/**
 * Parse `lineage` argv into { hash, contract, rpc, json, maxDepth }. Takes exactly one positional
 * <0xhash>. Throws on unknown/incomplete flags or a duplicate/missing hash so a typo never silently
 * walks the wrong thing (parser parity with `vh show`). The hash VALUE is shape-validated in runLineage
 * so the same usage-grade error fires whether the hash came from the CLI or a programmatic caller.
 * `--max-depth` must be a positive integer.
 */
function parseLineageArgs(argv) {
  const opts = {
    hash: undefined,
    contract: undefined,
    rpc: undefined,
    json: false,
    maxDepth: undefined,
    skipIdentityCheck: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--skip-identity-check":
        opts.skipIdentityCheck = true;
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      case "--max-depth": {
        const raw = argv[++i];
        if (raw === undefined) throw new Error("--max-depth requires a value");
        // A positive-integer cap; reject a zero/negative/non-integer here so a typo never silently
        // changes how far the walk goes. (runLineage re-validates via normalizeMaxDepth for the
        // programmatic path; this keeps the CLI usage error early and consistent.)
        if (!/^\d+$/.test(raw) || Number(raw) < 1) {
          throw new Error(`--max-depth requires a positive integer, got: ${raw}`);
        }
        opts.maxDepth = Number(raw);
        break;
      }
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.hash !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.hash = a;
    }
  }
  return opts;
}

async function cmdLineage(argv) {
  let opts;
  try {
    opts = parseLineageArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.hash) {
    process.stderr.write("error: `vh lineage` requires a <0xhash>\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");

  // Validate the hash shape BEFORE building a provider or reading any env/network — a malformed/short
  // hash must hard-error with usage (exit 2) and never hit the network (parser parity with `vh show`).
  const { normalizeContentHash } = require("./show");
  try {
    normalizeContentHash(opts.hash, ethers);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }

  const contractAddress = opts.contract || process.env.VH_CONTRACT;
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL\n"
    );
    return 1;
  }

  let result;
  try {
    // Read-only: provider only — `vh lineage` NEVER constructs a signer or touches a key.
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    result = await runLineage({
      contentHash: opts.hash,
      contractAddress,
      provider,
      maxDepth: opts.maxDepth,
      json: opts.json,
      skipIdentityCheck: opts.skipIdentityCheck,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero when the START hash has no record so scripts/CI can branch on "NOT ANCHORED" — the
  // same exit-4 contract `vh show` uses for a NOT ANCHORED hash, so the two read commands agree.
  return result.status === "WALKED" ? 0 : 4;
}

/**
 * Parse `reputation` argv into { addr, contract, rpc, json, skipIdentityCheck }. Takes exactly one
 * positional <addr>. Throws on unknown/incomplete flags or a duplicate/missing addr so a typo never
 * silently scores the wrong (or no) address (parser parity with `vh show`/`vh lineage`). The addr VALUE
 * is shape-validated in runReputation so the same usage-grade error fires whether the addr came from
 * the CLI or a programmatic caller.
 */
function parseReputationArgs(argv) {
  const opts = {
    addr: undefined,
    contract: undefined,
    rpc: undefined,
    json: false,
    skipIdentityCheck: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--skip-identity-check":
        opts.skipIdentityCheck = true;
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.addr !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.addr = a;
    }
  }
  return opts;
}

async function cmdReputation(argv) {
  let opts;
  try {
    opts = parseReputationArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.addr) {
    process.stderr.write("error: `vh reputation` requires an <addr>\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");

  // Validate the address shape BEFORE building a provider or reading any env/network — a malformed
  // address must hard-error with usage (exit 2) and never hit the network (parser parity with
  // `vh show`/`vh lineage`, which validate the hash shape first).
  if (!ethers.isAddress(opts.addr)) {
    process.stderr.write(
      `error: invalid address: ${opts.addr} (expected a 20-byte 0x-hex address)\n\n` + usage()
    );
    return 2;
  }

  const contractAddress = opts.contract || process.env.VH_CONTRACT;
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL\n"
    );
    return 1;
  }

  let result;
  try {
    // Read-only: provider only — `vh reputation` NEVER constructs a signer or touches a key.
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    result = await runReputation({
      address: opts.addr,
      contractAddress,
      provider,
      json: opts.json,
      skipIdentityCheck: opts.skipIdentityCheck,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero when the address has NO contributions so scripts/CI can branch on "no contributions"
  // — the same not-found exit-4 contract `vh show`/`vh lineage` use, so the read commands agree.
  return result.total === 0 ? 4 : 0;
}

/**
 * Parse `dataset build` argv into { dir, out, hints, json }. Takes exactly one positional <dir> and a
 * REQUIRED --out. Throws on unknown/incomplete flags or a duplicate/missing positional so a typo never
 * silently manifests the wrong tree or writes to a surprise path (parser parity with the other commands).
 */
function parseDatasetBuildArgs(argv) {
  const opts = { dir: undefined, out: undefined, hints: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--out":
        opts.out = argv[++i];
        if (opts.out === undefined) throw new Error("--out requires a value");
        break;
      case "--hints":
        opts.hints = argv[++i];
        if (opts.hints === undefined) throw new Error("--hints requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.dir !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.dir = a;
    }
  }
  return opts;
}

/**
 * Parse `dataset verify` argv into { dir, manifest, json }. Takes exactly one positional <dir> and a
 * REQUIRED --manifest. Throws on unknown/incomplete flags or a duplicate/missing positional so a typo
 * never silently verifies the wrong tree or against a surprise manifest (parser parity with the others).
 */
function parseDatasetVerifyArgs(argv) {
  const opts = { dir: undefined, manifest: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--manifest":
        opts.manifest = argv[++i];
        if (opts.manifest === undefined) throw new Error("--manifest requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.dir !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.dir = a;
    }
  }
  return opts;
}

/**
 * Parse `dataset diff` argv into { manifestA, manifestB, json }. Takes EXACTLY two positional manifest
 * paths and an optional --json. Throws on a missing/third positional or an unknown flag, so a typo
 * never silently diffs the wrong pair (parser parity with the other dataset subcommands).
 */
function parseDatasetDiffArgs(argv) {
  const opts = { manifestA: undefined, manifestB: undefined, json: false };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        positionals.push(a);
    }
  }
  if (positionals.length > 2) {
    throw new Error(
      `unexpected extra argument: ${positionals[2]} (vh dataset diff takes exactly two manifests)`
    );
  }
  opts.manifestA = positionals[0];
  opts.manifestB = positionals[1];
  return opts;
}

/**
 * Parse `dataset summary` argv into { manifest, json }. Takes EXACTLY one positional manifest path and an
 * optional --json. Throws on a missing/extra positional or an unknown flag, so a typo never silently
 * summarizes the wrong (or no) manifest (parser parity with the other dataset subcommands).
 */
function parseDatasetSummaryArgs(argv) {
  const opts = { manifest: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.manifest !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.manifest = a;
    }
  }
  return opts;
}

/**
 * Parse `dataset check` argv into { manifest, policy, json }. Takes EXACTLY one positional manifest path,
 * a REQUIRED --policy <p>, and an optional --json. Throws on a missing/extra positional or an unknown/
 * incomplete flag, so a typo never silently checks the wrong (or no) manifest against a surprise policy
 * (parser parity with the other dataset subcommands). A missing --policy is enforced in cmdDatasetCheck.
 */
function parseDatasetCheckArgs(argv) {
  const opts = { manifest: undefined, policy: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--policy":
        opts.policy = argv[++i];
        if (opts.policy === undefined) throw new Error("--policy requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.manifest !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.manifest = a;
    }
  }
  return opts;
}

/**
 * Parse `dataset report` argv into { manifest, verifyDir, policy, out, json }. Takes EXACTLY one
 * positional manifest path, an optional --verify <dir>, an optional --policy <p>, an optional --out <p>,
 * and an optional --json. Throws on a missing/extra positional or an unknown/incomplete flag, so a typo
 * never silently reports the wrong (or no) manifest, verifies a surprise tree, or checks a surprise
 * policy (parser parity with the other dataset subcommands).
 */
function parseDatasetReportArgs(argv) {
  const opts = { manifest: undefined, verifyDir: undefined, policy: undefined, out: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--verify":
        opts.verifyDir = argv[++i];
        if (opts.verifyDir === undefined) throw new Error("--verify requires a value");
        break;
      case "--policy":
        opts.policy = argv[++i];
        if (opts.policy === undefined) throw new Error("--policy requires a value");
        break;
      case "--out":
        opts.out = argv[++i];
        if (opts.out === undefined) throw new Error("--out requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.manifest !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.manifest = a;
    }
  }
  return opts;
}

/**
 * Parse `dataset attest` argv into { manifest, out, json }. Takes EXACTLY one positional manifest path,
 * an optional --out <p>, and an optional --json. Throws on a missing/extra positional or an unknown/
 * incomplete flag, so a typo never silently attests the wrong (or no) manifest or writes to a surprise
 * path (parser parity with the other dataset subcommands).
 */
function parseDatasetAttestArgs(argv) {
  const opts = { manifest: undefined, out: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--out":
        opts.out = argv[++i];
        if (opts.out === undefined) throw new Error("--out requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.manifest !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.manifest = a;
    }
  }
  return opts;
}

/**
 * Parse `dataset sign`/`parcel sign` argv into { manifest, keyEnv, keyFile, out, json }. Takes EXACTLY one
 * positional manifest path, EXACTLY ONE of --key-env <VAR> / --key-file <path>, an optional --out <p>, and
 * an optional --json. Throws on a missing/extra positional or an unknown/incomplete flag (parser parity with
 * the other dataset/parcel subcommands). The neither/both key-source check is the value layer's job
 * (loadSigningWallet), so the SAME error is produced whether the command is run via the CLI or programmatically.
 */
function parseSignArgs(argv) {
  const opts = { manifest: undefined, keyEnv: undefined, keyFile: undefined, out: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--key-env":
        opts.keyEnv = argv[++i];
        if (opts.keyEnv === undefined) throw new Error("--key-env requires a value");
        break;
      case "--key-file":
        opts.keyFile = argv[++i];
        if (opts.keyFile === undefined) throw new Error("--key-file requires a value");
        break;
      case "--out":
        opts.out = argv[++i];
        if (opts.out === undefined) throw new Error("--out requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.manifest !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.manifest = a;
    }
  }
  return opts;
}

/**
 * Parse `dataset verify-attest` argv into { signed, manifest, signer, json }. Takes EXACTLY one positional
 * <signed> container path, an optional --manifest <m>, an optional --signer <addr>, and an optional --json.
 * Throws on a missing/extra positional or an unknown/incomplete flag, so a typo never silently verifies the
 * wrong (or no) container, binds a surprise manifest, or pins a surprise signer (parser parity with the
 * other dataset subcommands).
 */
function parseDatasetVerifyAttestArgs(argv) {
  const opts = { signed: undefined, manifest: undefined, signer: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--manifest":
        opts.manifest = argv[++i];
        if (opts.manifest === undefined) throw new Error("--manifest requires a value");
        break;
      case "--signer":
        opts.signer = argv[++i];
        if (opts.signer === undefined) throw new Error("--signer requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.signed !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.signed = a;
    }
  }
  return opts;
}

/**
 * Parse `dataset prove` argv into { file, manifest, out, json }. Takes NO positional (the file is the
 * REQUIRED --file flag, the manifest the REQUIRED --manifest flag), so a stray positional hard-errors —
 * a typo never silently proves the wrong file or writes to a surprise path (parser parity with the others).
 */
function parseDatasetProveArgs(argv) {
  const opts = { file: undefined, manifest: undefined, out: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--file":
        opts.file = argv[++i];
        if (opts.file === undefined) throw new Error("--file requires a value");
        break;
      case "--manifest":
        opts.manifest = argv[++i];
        if (opts.manifest === undefined) throw new Error("--manifest requires a value");
        break;
      case "--out":
        opts.out = argv[++i];
        if (opts.out === undefined) throw new Error("--out requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        throw new Error(`unexpected argument: ${a} (vh dataset prove takes --file/--manifest, no positional)`);
    }
  }
  return opts;
}

/**
 * Parse `dataset verify-proof` argv into { artifact, json }. Takes exactly one positional <proof> (the
 * artifact path). Throws on unknown/incomplete flags or a duplicate/missing positional (parser parity).
 */
function parseDatasetVerifyProofArgs(argv) {
  const opts = { artifact: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.artifact !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.artifact = a;
    }
  }
  return opts;
}

/**
 * Parse `dataset timestamp-request`/`parcel timestamp-request` argv into { manifest, out, json }. Takes
 * EXACTLY one positional manifest path, an optional --out <p>, and an optional --json. Throws on a
 * missing/extra positional or an unknown/incomplete flag (parser parity with `attest`).
 */
function parseTimestampRequestArgs(argv) {
  const opts = { manifest: undefined, out: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--out":
        opts.out = argv[++i];
        if (opts.out === undefined) throw new Error("--out requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.manifest !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.manifest = a;
    }
  }
  return opts;
}

/**
 * Parse `dataset timestamp-wrap`/`parcel timestamp-wrap` argv into { manifest, token, out, json }. Takes
 * EXACTLY one positional manifest path, a REQUIRED --token <path|base64>, an optional --out <p>, and an
 * optional --json. Throws on a missing/extra positional or an unknown/incomplete flag (parser parity).
 */
function parseTimestampWrapArgs(argv) {
  const opts = { manifest: undefined, token: undefined, out: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--token":
        opts.token = argv[++i];
        if (opts.token === undefined) throw new Error("--token requires a value");
        break;
      case "--out":
        opts.out = argv[++i];
        if (opts.out === undefined) throw new Error("--out requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.manifest !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.manifest = a;
    }
  }
  return opts;
}

/**
 * Parse `parcel build` argv into { dir, out, parcelId, sender, recipient, hints, json }. Takes exactly one
 * positional <dir>, a REQUIRED --out, and OPTIONAL untrusted parcel-metadata flags. Throws on unknown/
 * incomplete flags or a duplicate/missing positional so a typo never silently builds the wrong tree
 * (parser parity with the dataset subcommands).
 */
function parseParcelBuildArgs(argv) {
  const opts = {
    dir: undefined,
    out: undefined,
    parcelId: undefined,
    sender: undefined,
    recipient: undefined,
    hints: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--out":
        opts.out = argv[++i];
        if (opts.out === undefined) throw new Error("--out requires a value");
        break;
      case "--parcel-id":
        opts.parcelId = argv[++i];
        if (opts.parcelId === undefined) throw new Error("--parcel-id requires a value");
        break;
      case "--sender":
        opts.sender = argv[++i];
        if (opts.sender === undefined) throw new Error("--sender requires a value");
        break;
      case "--recipient":
        opts.recipient = argv[++i];
        if (opts.recipient === undefined) throw new Error("--recipient requires a value");
        break;
      case "--hints":
        opts.hints = argv[++i];
        if (opts.hints === undefined) throw new Error("--hints requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.dir !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.dir = a;
    }
  }
  return opts;
}

/**
 * Parse `parcel verify` argv into { dir, manifest, json }. Takes exactly one positional <dir> and a
 * REQUIRED --manifest. Throws on unknown/incomplete flags or a duplicate/missing positional so a typo
 * never silently verifies the wrong tree or against a surprise manifest (parser parity).
 */
function parseParcelVerifyArgs(argv) {
  const opts = { dir: undefined, manifest: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--manifest":
        opts.manifest = argv[++i];
        if (opts.manifest === undefined) throw new Error("--manifest requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.dir !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.dir = a;
    }
  }
  return opts;
}

/**
 * Parse `parcel attest` argv into { manifest, out, json }. Takes EXACTLY one positional manifest path, an
 * optional --out <p>, and an optional --json. Throws on a missing/extra positional or an unknown/incomplete
 * flag (parser parity with `dataset attest`).
 */
function parseParcelAttestArgs(argv) {
  const opts = { manifest: undefined, out: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--out":
        opts.out = argv[++i];
        if (opts.out === undefined) throw new Error("--out requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.manifest !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.manifest = a;
    }
  }
  return opts;
}

/**
 * Parse `parcel verify-attest` argv into { signed, manifest, signer, json }. Takes EXACTLY one positional
 * <signed> container path, an optional --manifest <m>, an optional --signer <addr>, and an optional --json.
 * Throws on a missing/extra positional or an unknown/incomplete flag (parser parity with `dataset
 * verify-attest`).
 */
function parseParcelVerifyAttestArgs(argv) {
  const opts = { signed: undefined, manifest: undefined, signer: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--manifest":
        opts.manifest = argv[++i];
        if (opts.manifest === undefined) throw new Error("--manifest requires a value");
        break;
      case "--signer":
        opts.signer = argv[++i];
        if (opts.signer === undefined) throw new Error("--signer requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.signed !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.signed = a;
    }
  }
  return opts;
}

function cmdDataset(argv) {
  const [sub, ...rest] = argv;
  if (sub === "verify") {
    return cmdDatasetVerify(rest);
  }
  if (sub === "diff") {
    return cmdDatasetDiff(rest);
  }
  if (sub === "summary") {
    return cmdDatasetSummary(rest);
  }
  if (sub === "check") {
    return cmdDatasetCheck(rest);
  }
  if (sub === "report") {
    return cmdDatasetReport(rest);
  }
  if (sub === "attest") {
    return cmdDatasetAttest(rest);
  }
  if (sub === "sign") {
    return cmdDatasetSign(rest);
  }
  if (sub === "verify-attest") {
    return cmdDatasetVerifyAttest(rest);
  }
  if (sub === "timestamp-request") {
    return cmdDatasetTimestampRequest(rest);
  }
  if (sub === "timestamp-wrap") {
    return cmdDatasetTimestampWrap(rest);
  }
  if (sub === "prove") {
    return cmdDatasetProve(rest);
  }
  if (sub === "verify-proof") {
    return cmdDatasetVerifyProof(rest);
  }
  if (sub !== "build") {
    process.stderr.write(
      `error: unknown dataset subcommand: ${sub === undefined ? "(none)" : sub} ` +
        `(expected: build | verify | diff | summary | check | report | attest | sign | verify-attest | timestamp-request | timestamp-wrap | prove | verify-proof)\n\n` + usage()
    );
    return 2;
  }

  let opts;
  try {
    opts = parseDatasetBuildArgs(rest);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.dir) {
    process.stderr.write("error: `vh dataset build` requires a <dir>\n\n" + usage());
    return 2;
  }
  if (!opts.out) {
    process.stderr.write("error: `vh dataset build` requires --out <path>\n\n" + usage());
    return 2;
  }

  // Optional untrusted hints: read + parse the JSON file BEFORE walking the tree so a malformed hints
  // file hard-errors early (and never half-writes a manifest). dataset.js validates that every hinted
  // path exists in the tree.
  let hints;
  if (opts.hints !== undefined) {
    const fs = require("fs");
    let raw;
    try {
      raw = fs.readFileSync(opts.hints, "utf8");
    } catch (e) {
      process.stderr.write(`error: cannot read --hints file ${opts.hints}: ${e.message}\n`);
      return 1;
    }
    try {
      hints = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`error: --hints file ${opts.hints} is not valid JSON: ${e.message}\n`);
      return 1;
    }
  }

  try {
    runDatasetBuild({ dir: opts.dir, out: opts.out, hints, json: opts.json });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * `vh dataset verify <dir> --manifest <p>` — re-derive the dataset root from a FRESH copy on disk and
 * compare it to the manifest's (UNTRUSTED) recorded root, plus a precise per-file diff. OFFLINE: no
 * provider, no key, no network. Exit 0 on MATCH, 3 on MISMATCH (so scripts/CI can branch like
 * `vh verify`), 2 on a usage error, 1 on a runtime error (missing/corrupt manifest, bad dir).
 */
function cmdDatasetVerify(argv) {
  let opts;
  try {
    opts = parseDatasetVerifyArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.dir) {
    process.stderr.write("error: `vh dataset verify` requires a <dir>\n\n" + usage());
    return 2;
  }
  if (!opts.manifest) {
    process.stderr.write("error: `vh dataset verify` requires --manifest <path>\n\n" + usage());
    return 2;
  }

  let result;
  try {
    result = runDatasetVerify({ dir: opts.dir, manifest: opts.manifest, json: opts.json });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero on a tamper/MISMATCH so scripts and CI can branch on it (mirrors `vh verify`).
  return result.status === "MATCH" ? 0 : 3;
}

/**
 * `vh dataset diff <manifestA> <manifestB> [--json]` — OFFLINE manifest-to-manifest change report.
 * Reads BOTH manifests strictly and reuses the SAME diff core as `vh dataset verify`. PURELY OFFLINE:
 * no tree, no provider, no key, no network. Exit 0 when the manifests are IDENTICAL, 3 when they
 * DIFFER (so CI can branch — "fail the pipeline if the training set changed"), 2 on a usage error, 1
 * on a runtime error (missing/corrupt manifest).
 */
function cmdDatasetDiff(argv) {
  let opts;
  try {
    opts = parseDatasetDiffArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.manifestA || !opts.manifestB) {
    process.stderr.write(
      "error: `vh dataset diff` requires exactly two manifest paths <manifestA> <manifestB>\n\n" +
        usage()
    );
    return 2;
  }

  let result;
  try {
    result = runDatasetDiff({
      manifestA: opts.manifestA,
      manifestB: opts.manifestB,
      json: opts.json,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero when the manifests DIFFER so CI can branch (mirrors the dataset family's MISMATCH).
  // The verdict is the CHANGE SET (`identical`), not raw root-string equality, so the exit code can
  // never disagree with the printed/JSON changeset — a hand-edited `root` whose leaves are unchanged
  // still exits 0 (IDENTICAL), matching its empty changeset.
  return result.identical ? 0 : 3;
}

/**
 * `vh dataset summary <manifest> [--json]` — OFFLINE provenance/license roll-up over a manifest. Reads
 * the manifest strictly and aggregates the (UNTRUSTED) per-file {source, license} hints into histograms,
 * leading with the trust caveat that this counts CLAIMS, not verified facts. PURELY OFFLINE: no tree, no
 * provider, no key, no network. Exit 0 on success, 2 on a usage error, 1 on a runtime error (missing or
 * corrupt manifest).
 */
function cmdDatasetSummary(argv) {
  let opts;
  try {
    opts = parseDatasetSummaryArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.manifest) {
    process.stderr.write("error: `vh dataset summary` requires a <manifest>\n\n" + usage());
    return 2;
  }

  try {
    runDatasetSummary({ manifest: opts.manifest, json: opts.json });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * `vh dataset check <manifest> --policy <p> [--json]` — OFFLINE license/source policy gate. Reads the
 * manifest AND policy strictly (a corrupt/foreign one is rejected) and evaluates the manifest's TRUSTED
 * file set against the policy in a PURE, deterministic function. PURELY OFFLINE: no tree, no provider, no
 * key, no network. Exit 0 PASS, 3 FAIL (mirrors the dataset family's data-divergence convention so all
 * dataset gates use the same 0/3 contract), 2 on a usage error (missing/extra positional, missing
 * --policy, unknown flag), 1 on a runtime error (missing/corrupt manifest OR policy). A missing --policy
 * is a usage error (2), NOT a silent PASS.
 */
function cmdDatasetCheck(argv) {
  let opts;
  try {
    opts = parseDatasetCheckArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.manifest) {
    process.stderr.write("error: `vh dataset check` requires a <manifest>\n\n" + usage());
    return 2;
  }
  // A missing --policy is a USAGE error (2), never a silent PASS: a gate with no policy must not pass.
  if (!opts.policy) {
    process.stderr.write("error: `vh dataset check` requires --policy <path>\n\n" + usage());
    return 2;
  }

  let result;
  try {
    result = runDatasetCheck({ manifest: opts.manifest, policy: opts.policy, json: opts.json });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero on FAIL so CI can gate (mirrors the dataset family's 0/3 data-divergence convention).
  return result.verdict === "PASS" ? 0 : 3;
}

/**
 * `vh dataset report <manifest> [--verify <dir>] [--policy <p>] [--json] [--out <p>]` — ONE
 * self-contained, deterministic evidence document. Reads the manifest strictly, consolidates the dataset
 * identity + the provenance/license roll-up (REUSES the SAME aggregation as `vh dataset summary`) + the
 * trust caveats, OPTIONALLY embeds a live-tree verification verdict (REUSES `runDatasetVerify`), and
 * OPTIONALLY embeds a Policy compliance verdict (REUSES the SAME pure `evaluatePolicy` as `vh dataset
 * check` — the report verdict can never diverge from `vh dataset check`'s). PURELY OFFLINE for the
 * manifest-only path (no tree/provider/key/network); `--verify` adds an offline live-tree re-derive.
 *
 * EXIT CODES — the report is a COMBINED CI gate (non-zero whenever ANY embedded gate fails, 0 only when
 * all pass):
 *   - WITH --verify: 0 on MATCH, 3 on MISMATCH (mirrors `vh dataset verify`).
 *   - WITH --policy: 0 on PASS, 3 on FAIL (mirrors `vh dataset check`).
 *   - WITH BOTH:     3 if EITHER the verify is MISMATCH OR the policy is FAIL; 0 only when MATCH AND PASS.
 *   - WITHOUT either gate: 0 on a well-formed manifest.
 *   - 2 on a usage error; 1 on a runtime error (missing/corrupt manifest or policy, or a bad --verify dir).
 */
function cmdDatasetReport(argv) {
  let opts;
  try {
    opts = parseDatasetReportArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.manifest) {
    process.stderr.write("error: `vh dataset report` requires a <manifest>\n\n" + usage());
    return 2;
  }

  let result;
  try {
    result = runDatasetReport({
      manifest: opts.manifest,
      verifyDir: opts.verifyDir,
      policy: opts.policy,
      out: opts.out,
      json: opts.json,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // COMBINED gate: the report is non-zero whenever ANY embedded gate fails, and 0 only when all pass.
  //   --verify  => fail on MISMATCH (mirrors `vh dataset verify`).
  //   --policy  => fail on FAIL     (mirrors `vh dataset check`).
  // With BOTH, either failure yields exit 3; with NEITHER, a well-formed manifest is exit 0.
  if (result.verifyStatus === "MISMATCH" || result.policyVerdict === "FAIL") return 3;
  return 0;
}

/**
 * `vh dataset attest <manifest> [--out <p>] [--json]` — emit the canonical, byte-deterministic UNSIGNED
 * attestation payload the human signing/timestamp trust-root (P-3) will sign. Reads the manifest
 * strictly and commits to the dataset identity (root + fileCount + canonical manifestDigest) plus the
 * standing trust caveat, with explicit `signed:false`/`signature:null` markers. PURELY OFFLINE: no tree,
 * no provider, no key, no network. Exit 0 on success, 2 on a usage error, 1 on a runtime error
 * (missing/corrupt manifest).
 */
function cmdDatasetAttest(argv) {
  let opts;
  try {
    opts = parseDatasetAttestArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.manifest) {
    process.stderr.write("error: `vh dataset attest` requires a <manifest>\n\n" + usage());
    return 2;
  }

  try {
    runDatasetAttest({ manifest: opts.manifest, out: opts.out, json: opts.json });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * `vh dataset sign <manifest> --key-env <VAR> | --key-file <path> [--out <p>] [--json]` — sign the UNSIGNED
 * dataset attestation with a HUMAN-supplied key and emit the SIGNED container. The key is read, used to
 * build an in-process ethers Wallet, used to sign, and discarded — NEVER generated, persisted, or logged;
 * success/`--json` output prints ONLY the PUBLIC signer address, the output path, and the scheme. PURELY
 * OFFLINE (EIP-191 personal_sign; no provider, no network). The output is accepted by `vh dataset
 * verify-attest` unchanged.
 *
 * EXIT CODES: 0 success; 2 on a usage error (missing/extra positional, unknown/incomplete flag, NEITHER or
 * BOTH of --key-env/--key-file — the source must be unambiguous BEFORE we touch a key); 1 on a runtime
 * error (a missing env var, an unreadable key file, a malformed/zero key, or a corrupt/missing manifest).
 * No error message ever includes the key material.
 */
async function cmdDatasetSign(argv) {
  let opts;
  try {
    opts = parseSignArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.manifest) {
    process.stderr.write("error: `vh dataset sign` requires a <manifest>\n\n" + usage());
    return 2;
  }
  // The key SOURCE must be unambiguous — EXACTLY ONE of --key-env/--key-file — and that is a USAGE error
  // (exit 2), checked BEFORE any key is read. (A present-but-bad key value is a RUNTIME error, exit 1,
  // surfaced from runDatasetSign's loadSigningWallet below — never echoing the key.)
  const hasEnv = opts.keyEnv !== undefined;
  const hasFile = opts.keyFile !== undefined;
  if (!hasEnv && !hasFile) {
    process.stderr.write(
      "error: `vh dataset sign` requires EXACTLY ONE signing-key source: --key-env <VAR> or " +
        "--key-file <path>\n\n" + usage()
    );
    return 2;
  }
  if (hasEnv && hasFile) {
    process.stderr.write(
      "error: --key-env and --key-file are mutually exclusive; pass EXACTLY ONE signing-key source\n\n" +
        usage()
    );
    return 2;
  }

  try {
    await runDatasetSign({
      manifest: opts.manifest,
      keyEnv: opts.keyEnv,
      keyFile: opts.keyFile,
      out: opts.out,
      json: opts.json,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * `vh dataset verify-attest <signed> [--manifest <m>] [--signer <addr>] [--json]` — OFFLINE verify a
 * SIGNED attestation container. Reads the container strictly, recovers the signer from the embedded
 * canonical bytes + signature, and confirms it equals the container's `signer`; with --signer it pins the
 * expected publisher; with --manifest it confirms the signature binds the buyer's own dataset. PURELY
 * OFFLINE: no tree, no provider, no key, no network. Exit 0 ACCEPTED, 3 REJECTED (mirrors the dataset
 * family's 0/3 data-divergence convention so a buyer's CI can gate), 2 on a usage error (missing/extra
 * positional, unknown flag, malformed --signer), 1 on a runtime error (missing/corrupt container or manifest).
 */
function cmdDatasetVerifyAttest(argv) {
  let opts;
  try {
    opts = parseDatasetVerifyAttestArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.signed) {
    process.stderr.write(
      "error: `vh dataset verify-attest` requires a <signed> (signed attestation container path)\n\n" +
        usage()
    );
    return 2;
  }
  // Validate the --signer address SHAPE up front (when given) so a malformed expected publisher is a
  // usage error (2), never a runtime throw mid-verify (parser parity with `vh show`/`vh reputation`,
  // which validate the address/hash shape before doing any work). PURELY OFFLINE — no network here either.
  if (opts.signer !== undefined) {
    const ethers = require("ethers");
    if (!ethers.isAddress(opts.signer)) {
      process.stderr.write(
        `error: invalid --signer address: ${opts.signer} (expected a 20-byte 0x-hex address)\n\n` +
          usage()
      );
      return 2;
    }
  }

  let result;
  try {
    result = runDatasetVerifyAttest({
      signed: opts.signed,
      manifest: opts.manifest,
      signer: opts.signer,
      json: opts.json,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero on REJECTED so a buyer's CI can gate (mirrors the dataset family's 0/3 convention).
  return result.accepted ? 0 : 3;
}

/**
 * `vh dataset timestamp-request <manifest> [--out <p>] [--json]` — emit the SHA-256 digest of the canonical
 * UNSIGNED attestation bytes (the messageImprint a human submits to their RFC-3161 TSA), plus a recipe for
 * producing the token. PURELY OFFLINE: NO key, NO network. Exit 0 success, 2 usage error, 1 runtime error.
 */
function cmdDatasetTimestampRequest(argv) {
  let opts;
  try {
    opts = parseTimestampRequestArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.manifest) {
    process.stderr.write("error: `vh dataset timestamp-request` requires a <manifest>\n\n" + usage());
    return 2;
  }
  try {
    runDatasetTimestampRequest({ manifest: opts.manifest, out: opts.out, json: opts.json });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * `vh dataset timestamp-wrap <manifest> --token <path|base64> [--out <p>] [--json]` — wrap the RFC-3161
 * token the human obtained from their TSA into a verifiable `*-attestation-timestamped` container, binding
 * it to the re-derived canonical SHA-256 digest. ERRORS CLEARLY (exit 1) if the token does not bind the
 * digest. PURELY OFFLINE: NO key, NO network. Exit 0 success, 2 usage error (missing manifest/--token,
 * unknown/incomplete flag), 1 runtime error (corrupt manifest, unparseable/non-binding token).
 */
function cmdDatasetTimestampWrap(argv) {
  let opts;
  try {
    opts = parseTimestampWrapArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.manifest) {
    process.stderr.write("error: `vh dataset timestamp-wrap` requires a <manifest>\n\n" + usage());
    return 2;
  }
  if (!opts.token) {
    process.stderr.write(
      "error: `vh dataset timestamp-wrap` requires --token <path|base64> (the RFC-3161 token from your TSA)\n\n" +
        usage()
    );
    return 2;
  }
  try {
    runDatasetTimestampWrap({
      manifest: opts.manifest,
      token: opts.token,
      out: opts.out,
      json: opts.json,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * `vh dataset prove --file <p> --manifest <m> [--out <p>] [--json]` — build an OFFLINE set-membership
 * proof that ONE file was a member of the manifest's dataset. NO key, NO network. Exit 0 on MEMBER, 3
 * on NOT A MEMBER (so scripts/CI can branch), 2 on a usage error, 1 on a runtime error.
 */
function cmdDatasetProve(argv) {
  let opts;
  try {
    opts = parseDatasetProveArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.file) {
    process.stderr.write("error: `vh dataset prove` requires --file <path>\n\n" + usage());
    return 2;
  }
  if (!opts.manifest) {
    process.stderr.write("error: `vh dataset prove` requires --manifest <path>\n\n" + usage());
    return 2;
  }

  let result;
  try {
    result = runDatasetProve({
      file: opts.file,
      manifest: opts.manifest,
      out: opts.out,
      json: opts.json,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero when the file is NOT a member so scripts/CI can branch (mirrors `vh verify`/MISMATCH).
  return result.member ? 0 : 3;
}

/**
 * `vh dataset verify-proof <proof> [--json]` — fold a membership proof artifact PURELY OFFLINE (no
 * dataset, no manifest, no key, no network). Exit 0 on CONFIRMED, 3 on REJECTED (mirrors `vh verify`),
 * 2 on a usage error, 1 on a runtime error (missing/corrupt artifact).
 */
function cmdDatasetVerifyProof(argv) {
  let opts;
  try {
    opts = parseDatasetVerifyProofArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.artifact) {
    process.stderr.write(
      "error: `vh dataset verify-proof` requires a <proof> (artifact path)\n\n" + usage()
    );
    return 2;
  }

  let result;
  try {
    result = runDatasetVerifyProof({ artifact: opts.artifact, json: opts.json });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero on REJECTED so scripts/CI can branch (mirrors `vh verify`/MISMATCH).
  return result.status === "CONFIRMED" ? 0 : 3;
}

/**
 * `vh parcel <subcommand>` — ProofParcel: tamper-evident B2B data-DELIVERY receipts over the shared
 * provenance core. Dispatches build/verify; an unknown/missing subcommand hard-errors with usage (exit 2,
 * parser parity with `vh dataset`).
 */
function cmdParcel(argv) {
  const [sub, ...rest] = argv;
  if (sub === "verify") {
    return cmdParcelVerify(rest);
  }
  if (sub === "attest") {
    return cmdParcelAttest(rest);
  }
  if (sub === "sign") {
    return cmdParcelSign(rest);
  }
  if (sub === "verify-attest") {
    return cmdParcelVerifyAttest(rest);
  }
  if (sub === "timestamp-request") {
    return cmdParcelTimestampRequest(rest);
  }
  if (sub === "timestamp-wrap") {
    return cmdParcelTimestampWrap(rest);
  }
  if (sub !== "build") {
    process.stderr.write(
      `error: unknown parcel subcommand: ${sub === undefined ? "(none)" : sub} ` +
        `(expected: build | verify | attest | sign | verify-attest | timestamp-request | timestamp-wrap)\n\n` + usage()
    );
    return 2;
  }

  let opts;
  try {
    opts = parseParcelBuildArgs(rest);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.dir) {
    process.stderr.write("error: `vh parcel build` requires a <dir>\n\n" + usage());
    return 2;
  }
  if (!opts.out) {
    process.stderr.write("error: `vh parcel build` requires --out <path>\n\n" + usage());
    return 2;
  }

  // Optional untrusted per-file hints: read + parse the JSON file BEFORE walking the tree so a malformed
  // hints file hard-errors early (and never half-writes a manifest). parcel.js validates every hinted
  // path exists in the tree.
  let hints;
  if (opts.hints !== undefined) {
    const fs = require("fs");
    let raw;
    try {
      raw = fs.readFileSync(opts.hints, "utf8");
    } catch (e) {
      process.stderr.write(`error: cannot read --hints file ${opts.hints}: ${e.message}\n`);
      return 1;
    }
    try {
      hints = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`error: --hints file ${opts.hints} is not valid JSON: ${e.message}\n`);
      return 1;
    }
  }

  // Assemble the OPTIONAL, UNTRUSTED parcel block from the dedicated flags (omitting absent fields so an
  // empty block never litters the manifest). runParcelBuild records it as self-asserted metadata only.
  const parcel = {};
  if (opts.parcelId !== undefined) parcel.parcelId = opts.parcelId;
  if (opts.sender !== undefined) parcel.sender = opts.sender;
  if (opts.recipient !== undefined) parcel.recipient = opts.recipient;

  try {
    runParcelBuild({
      dir: opts.dir,
      out: opts.out,
      hints,
      parcel: Object.keys(parcel).length > 0 ? parcel : undefined,
      json: opts.json,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * `vh parcel verify <dir> --manifest <p>` — re-derive the parcel root from a FRESH copy on disk and
 * compare it to the manifest's (UNTRUSTED) recorded root, plus a precise per-file diff. OFFLINE: no
 * provider, no key, no network. Exit 0 on MATCH, 3 on MISMATCH (mirrors `vh dataset verify` so all verify
 * gates share ONE exit contract), 2 on a usage error, 1 on a runtime error (missing/corrupt/foreign
 * manifest, bad dir).
 */
function cmdParcelVerify(argv) {
  let opts;
  try {
    opts = parseParcelVerifyArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.dir) {
    process.stderr.write("error: `vh parcel verify` requires a <dir>\n\n" + usage());
    return 2;
  }
  if (!opts.manifest) {
    process.stderr.write("error: `vh parcel verify` requires --manifest <path>\n\n" + usage());
    return 2;
  }

  let result;
  try {
    result = runParcelVerify({ dir: opts.dir, manifest: opts.manifest, json: opts.json });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero on a tamper/MISMATCH so scripts and CI can branch on it (mirrors `vh dataset verify`).
  return result.status === "MATCH" ? 0 : 3;
}

/**
 * `vh parcel attest <manifest> [--out <p>] [--json]` — emit the canonical, byte-deterministic UNSIGNED
 * parcel-attestation payload a human signing/timestamp trust-root (P-3) will sign. Reads the parcel
 * manifest strictly and commits to the parcel identity (root + fileCount + canonical manifestDigest) plus
 * the standing trust caveat, with explicit `signed:false`/`signature:null` markers. PURELY OFFLINE: no
 * tree, no provider, no key, no network. Exit 0 on success, 2 on a usage error, 1 on a runtime error.
 */
function cmdParcelAttest(argv) {
  let opts;
  try {
    opts = parseParcelAttestArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.manifest) {
    process.stderr.write("error: `vh parcel attest` requires a <manifest>\n\n" + usage());
    return 2;
  }
  try {
    runParcelAttest({ manifest: opts.manifest, out: opts.out, json: opts.json });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * `vh parcel sign <manifest> --key-env <VAR> | --key-file <path> [--out <p>] [--json]` — sign the UNSIGNED
 * parcel attestation with a HUMAN-supplied key and emit the SIGNED container (the THIN parcel parallel to
 * `vh dataset sign`). The key is read, used to build an in-process ethers Wallet, used to sign, and
 * discarded — NEVER generated, persisted, or logged; output prints ONLY the PUBLIC signer address, the
 * output path, and the scheme. PURELY OFFLINE. The output is accepted by `vh parcel verify-attest` unchanged.
 *
 * EXIT CODES: 0 success; 2 on a usage error (missing/extra positional, unknown/incomplete flag, NEITHER or
 * BOTH of --key-env/--key-file); 1 on a runtime error (missing env var, unreadable key file, malformed/zero
 * key, corrupt/missing manifest). No error message ever includes the key material.
 */
async function cmdParcelSign(argv) {
  let opts;
  try {
    opts = parseSignArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.manifest) {
    process.stderr.write("error: `vh parcel sign` requires a <manifest>\n\n" + usage());
    return 2;
  }
  const hasEnv = opts.keyEnv !== undefined;
  const hasFile = opts.keyFile !== undefined;
  if (!hasEnv && !hasFile) {
    process.stderr.write(
      "error: `vh parcel sign` requires EXACTLY ONE signing-key source: --key-env <VAR> or " +
        "--key-file <path>\n\n" + usage()
    );
    return 2;
  }
  if (hasEnv && hasFile) {
    process.stderr.write(
      "error: --key-env and --key-file are mutually exclusive; pass EXACTLY ONE signing-key source\n\n" +
        usage()
    );
    return 2;
  }

  try {
    await runParcelSign({
      manifest: opts.manifest,
      keyEnv: opts.keyEnv,
      keyFile: opts.keyFile,
      out: opts.out,
      json: opts.json,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * `vh parcel verify-attest <signed> [--manifest <m>] [--signer <addr>] [--json]` — OFFLINE verify a SIGNED
 * parcel-attestation container. Reads the container strictly, recovers the signer from the embedded
 * canonical bytes + signature, and confirms it equals the container's `signer`; with --signer it pins the
 * expected sender; with --manifest it confirms the signature binds the recipient's own parcel. PURELY
 * OFFLINE: no tree, no provider, no key, no network. Exit 0 ACCEPTED, 3 REJECTED (mirrors the family's 0/3
 * convention so a recipient's CI can gate), 2 on a usage error, 1 on a runtime error.
 */
function cmdParcelVerifyAttest(argv) {
  let opts;
  try {
    opts = parseParcelVerifyAttestArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.signed) {
    process.stderr.write(
      "error: `vh parcel verify-attest` requires a <signed> (signed attestation container path)\n\n" +
        usage()
    );
    return 2;
  }
  // Validate the --signer address SHAPE up front (when given) so a malformed expected sender is a usage
  // error (2), never a runtime throw mid-verify. PURELY OFFLINE — no network here either.
  if (opts.signer !== undefined) {
    const ethers = require("ethers");
    if (!ethers.isAddress(opts.signer)) {
      process.stderr.write(
        `error: invalid --signer address: ${opts.signer} (expected a 20-byte 0x-hex address)\n\n` +
          usage()
      );
      return 2;
    }
  }

  let result;
  try {
    result = runParcelVerifyAttest({
      signed: opts.signed,
      manifest: opts.manifest,
      signer: opts.signer,
      json: opts.json,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero on REJECTED so a recipient's CI can gate (mirrors the family's 0/3 convention).
  return result.accepted ? 0 : 3;
}

/**
 * `vh parcel timestamp-request <manifest> [--out <p>] [--json]` — emit the SHA-256 digest of the canonical
 * UNSIGNED parcel-attestation bytes (the messageImprint a human submits to their RFC-3161 TSA), plus a
 * recipe. PURELY OFFLINE: NO key, NO network. Exit 0 success, 2 usage error, 1 runtime error.
 */
function cmdParcelTimestampRequest(argv) {
  let opts;
  try {
    opts = parseTimestampRequestArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.manifest) {
    process.stderr.write("error: `vh parcel timestamp-request` requires a <manifest>\n\n" + usage());
    return 2;
  }
  try {
    runParcelTimestampRequest({ manifest: opts.manifest, out: opts.out, json: opts.json });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * `vh parcel timestamp-wrap <manifest> --token <path|base64> [--out <p>] [--json]` — wrap the RFC-3161 token
 * the human obtained from their TSA into a verifiable `parcel-attestation-timestamped` container, binding it
 * to the re-derived canonical SHA-256 digest. ERRORS CLEARLY (exit 1) if the token does not bind the digest.
 * PURELY OFFLINE: NO key, NO network. Exit 0 success, 2 usage error, 1 runtime error.
 */
function cmdParcelTimestampWrap(argv) {
  let opts;
  try {
    opts = parseTimestampWrapArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.manifest) {
    process.stderr.write("error: `vh parcel timestamp-wrap` requires a <manifest>\n\n" + usage());
    return 2;
  }
  if (!opts.token) {
    process.stderr.write(
      "error: `vh parcel timestamp-wrap` requires --token <path|base64> (the RFC-3161 token from your TSA)\n\n" +
        usage()
    );
    return 2;
  }
  try {
    runParcelTimestampWrap({
      manifest: opts.manifest,
      token: opts.token,
      out: opts.out,
      json: opts.json,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "hash":
      return cmdHash(rest);
    case "anchor":
      return cmdAnchor(rest);
    case "claim":
      return cmdClaim(rest);
    case "commit":
      return cmdCommit(rest);
    case "reveal":
      return cmdReveal(rest);
    case "verify":
      return cmdVerify(rest);
    case "prove":
      return cmdProve(rest);
    case "verify-proof":
      return cmdVerifyProof(rest);
    case "list":
      return cmdList(rest);
    case "show":
      return cmdShow(rest);
    case "lineage":
      return cmdLineage(rest);
    case "reputation":
      return cmdReputation(rest);
    case "dataset":
      return cmdDataset(rest);
    case "parcel":
      return cmdParcel(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(usage());
      return 0;
    default:
      process.stderr.write(`error: unknown command: ${cmd}\n\n` + usage());
      return 2;
  }
}

if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2))).then((code) => process.exit(code));
}

module.exports = {
  main,
  cmdHash,
  cmdAnchor,
  cmdClaim,
  cmdCommit,
  cmdReveal,
  cmdVerify,
  cmdProve,
  cmdVerifyProof,
  cmdList,
  cmdShow,
  cmdLineage,
  cmdReputation,
  cmdDataset,
  cmdDatasetVerify,
  cmdDatasetDiff,
  cmdDatasetSummary,
  cmdDatasetCheck,
  cmdDatasetReport,
  cmdDatasetAttest,
  cmdDatasetSign,
  cmdDatasetVerifyAttest,
  cmdDatasetProve,
  cmdDatasetVerifyProof,
  cmdParcel,
  cmdParcelVerify,
  cmdParcelAttest,
  cmdParcelSign,
  cmdParcelVerifyAttest,
  parseParcelBuildArgs,
  parseParcelVerifyArgs,
  parseParcelAttestArgs,
  parseParcelVerifyAttestArgs,
  parseSignArgs,
  parseDatasetBuildArgs,
  parseDatasetVerifyArgs,
  parseDatasetDiffArgs,
  parseDatasetSummaryArgs,
  parseDatasetCheckArgs,
  parseDatasetReportArgs,
  parseDatasetAttestArgs,
  parseDatasetVerifyAttestArgs,
  parseDatasetProveArgs,
  parseDatasetVerifyProofArgs,
  parseHashArgs,
  parseAnchorArgs,
  parseClaimArgs,
  parseRevealArgs,
  parseVerifyArgs,
  parseProveArgs,
  parseVerifyProofArgs,
  parseListArgs,
  parseShowArgs,
  parseLineageArgs,
  parseReputationArgs,
  usage,
};
