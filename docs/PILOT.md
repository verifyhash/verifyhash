# The verifyhash Pilot — a buyer-facing runbook

This is the runbook a prospective **design partner** (and their security team) follows to run the
verifyhash pilot kit, see the two sellable journeys work end to end, and understand — precisely — what
each artifact **proves**, what it **does not**, and **where they independently verify it**. It is
written so a **non-author** can follow it without reading the source, and so a partner can explain it
to a colleague.

Nothing in this pilot touches a real key, a timestamp authority, an RPC endpoint, or any network. It
runs **offline** and writes **only** to a throwaway workspace.

---

## 1. What you are evaluating

verifyhash turns "a set of files, byte-for-byte unaltered, and who vouched for them" into a
**tamper-evident, independently-verifiable artifact**. The pilot drives the **two** journeys we sell:

- **Evidence packets** — seal a folder of compliance / audit / incident / hand-off files into one
  `*.vhevidence.json`, hand it to a counterparty, and let them confirm offline that it is exactly the
  set you sealed (and who signed it).
- **TrustLedger reconciliation seals** — reconcile a bank statement, a ledger export, and a rent roll
  into a dated audit packet, then seal it so an examiner can confirm **byte-for-byte** that this is the
  exact packet the tool produced.

Both ride the **same** provenance core and the **same** independent verifier, so confidence in one
transfers to the other.

---

## 2. Run the kit (zero setup)

From a checkout of the repository (run `npm install` once):

```bash
node pilot/run-pilot.js
```

You should see two labelled sections — `VERTICAL A — EVIDENCE` and `VERTICAL B — RECONCILE` — each
listing `[PASS]` checks, then a single final line:

```
VERDICT: PASS — N/N checks passed (evidence + reconcile).
```

The process exits **0** on an all-PASS run (CI-gateable). It writes its artifacts to a fresh OS temp
directory; set `PILOT_OUT=<dir>` to choose where, or `PILOT_KEEP=1` to keep the workspace so you can
open the produced files. It **never** writes into the repository, and the committed sample inputs are
**read-only** — the tamper step always hits a throwaway copy.

### Run it on YOUR OWN folder (the question every partner asks first)

The default run above seals the committed sample. To watch the **exact same** journey — license-gated
`--sign` → independent `verify-vh` ACCEPT → TAMPER → REJECT — run against **your own** evidence folder,
point the evidence vertical at it in **one command**:

```bash
node pilot/run-pilot.js --evidence-dir /path/to/your/folder
# …or, equivalently, via the environment:
PILOT_EVIDENCE_DIR=/path/to/your/folder node pilot/run-pilot.js
```

**The kit does NOT modify your files.** It **copies** your folder into the throwaway workspace and seals,
verifies, and tampers **only the copy**; your originals are **read-only** and are never written, renamed,
or deleted (their bytes and mtimes are unchanged after the run — this is asserted by the test suite). If
the folder is **missing, empty, or unreadable**, the kit **hard-errors with a clear message before it
seals anything** — never a misleading PASS over no data. On a valid folder you get the same single
`VERDICT: PASS` line, computed on *your* data.

Folder size doesn't matter: the demo mints an **ephemeral, throwaway** license that grants the full paid
evidence surface (`evidence_signed` + `evidence_unlimited`), so a realistic evidence/audit folder with
dozens of files runs to the same all-PASS verdict — you are never gated by the free-sample size in the
pilot. (In production, sealing more than the free sample is the paid tier; here the demo license simply
unlocks it for you so you can watch the whole journey on your real data.)

> Operator quick reference (knobs, file map, how it can't rot):
> [`pilot/README.md`](../pilot/README.md).

---

## 3. What each artifact proves — and where you independently verify it

The pilot produces three kinds of artifact. For each, here is the claim it carries and **how a partner
checks it themselves, without trusting us**.

### 3a. The evidence packet (`*.vhevidence.json`)

- **What it proves.** This exact set of files, byte-for-byte. The packet is a content-addressed
  keccak Merkle root over `(relPath, content)` pairs, optionally wrapped in an EIP-191 signature that
  binds **who** vouched (the operator key).
- **Where you verify it independently.** Run the standalone verifier on the bytes you were handed:

  ```bash
  node verifier/verify-vh.js --dir <evidence-folder> --vendor <0xOperatorAddress> <packet>.vhevidence.json
  ```

  Exit **0** = the folder matches the packet and the signature recovers to the address you pinned;
  exit **3** = REJECTED, and the output **localizes** which file CHANGED / MISSING / UNEXPECTED. The
  verifier is in its own [`verifier/`](../verifier/) tree with near-zero dependencies (`js-sha3`
  only — **no** `ethers`, **no** `hardhat`), so you are not installing our producer stack to check our
  claim. See [`verifier/README.md`](../verifier/README.md) and
  [`INDEPENDENT-VERIFICATION.md`](INDEPENDENT-VERIFICATION.md).

### 3b. The TrustLedger reconciliation seal

- **What it proves.** The three balances tied out to a single PASS/FAIL on a stated date, and the
  sealed packet (sources + every emitted file + the verdict/role header) is byte-for-byte the packet
  the tool produced — any edit, rename, add, or removed input REJECTS.
- **Where you verify it independently.** The **same** verifier re-derives the keccak root from the
  source bytes you hold:

  ```bash
  node verifier/verify-vh.js --dir <reconcile-folder> <reconciliation-...-seal>.json
  ```

  Exit **0** = the root re-derives from the bytes on disk; exit **3** = REJECTED, localized to the
  changed source. (The pilot's reconciliation seal is **unsigned**, so you do not pin `--vendor` for
  it — an unsigned artifact cannot be signer-pinned.)

### 3c. The licence (`*.vhlicense.json`)

- **What it proves.** It is the **access credential** that unlocks the paid surface (`evidence
  seal --sign`, `reconcile --seal`). It is signed by the vendor key and verified offline; a wrong,
  expired, or under-entitled licence is a **hard refuse**, never a silent downgrade. The pilot proves
  this gate is **real** by showing the paid surface refused with **no** licence and refused again with
  a licence pinned to the **wrong** vendor.
- **What it is NOT.** Not a token, not tradeable, not an appreciating asset. Income is a subscription
  / licence for delivered software value — the credential is just the key to the door.

---

## 4. Wire it into your pipeline (this is how the pilot lives in your release process)

A pilot you run once is a demo; a pilot that **lives in your CI** is a dependency. The same independent
`verify-vh` you ran by hand in §3 drops into your build as a **merge gate**: the moment a sealed
artifact is tampered, forged, or signed by the wrong key, the build goes **red** and the merge is
**blocked**. You do not install our producer stack to do this — the gate runs the standalone verifier
(`js-sha3` only, **no** `ethers`, **no** `hardhat`).

We ship the snippet so this is **one paste**, not a project. A non-author wires it in like so:

1. Copy [`../verifier/ci/verify-vh.generic.sh`](../verifier/ci/verify-vh.generic.sh) into your repo (a
   portable `set -e` shell gate for GitLab CI, CircleCI, Jenkins, a Makefile recipe, or a git hook), or
   drop [`../verifier/ci/verify-vh.github-actions.yml`](../verifier/ci/verify-vh.github-actions.yml) at
   `.github/workflows/verify-vh.yml` for GitHub Actions.
2. Add **three lines** to the pipeline step that runs it — the producer address you pin out-of-band, the
   artifact(s) or release manifest, and the call:

   ```bash
   export VH_VENDOR=0xYOUR_PRODUCERS_SIGNER_ADDRESS     # pinned out-of-band
   export VH_MANIFEST=release.manifest                  # or VH_ARTIFACTS="dist/packet.vhevidence.json"
   ./verifier/ci/verify-vh.generic.sh                   # exit 0 = green/merge; non-zero = red/blocked
   ```

3. Read the gate: a **green** check *means* every sealed artifact still matches the bytes the producer
   signed (exit `0`). A **red** gate *means* a `3` (REJECTED — a sealed byte changed / wrong signer,
   localized to the offending artifact and file), a `2` (usage error), or a `1` (an artifact could not
   even be read) — and your merge is **blocked** until it is resolved. A non-zero verdict never slips
   through as a silent pass.

**The boundary stays explicit even in CI: verification is FREE, sealing is PAID.** The gate above — and
every `verify-vh` invocation — costs nothing and needs no licence; anyone may verify forever, offline.
The licence (§3c) gates only the **paid sealing surface** (`evidence seal --sign`, `reconcile --seal`)
on the **producer** side. So your pipeline can gate on our proofs without buying anything; what your
counterparty pays for is the right to **produce** sealed artifacts, not your right to **check** them.

The shipped snippets are **examples the loop never runs**, but their exact gate command is mechanically
tested ([`../test/verifier.ci-snippet.test.js`](../test/verifier.ci-snippet.test.js)): it must exit `0`
on a good release and `3` on a tampered one, so the snippet you copy is known-good, not aspirational.
The deeper spec is in [`../verifier/README.md`](../verifier/README.md) §2b and
[`INDEPENDENT-VERIFICATION.md`](INDEPENDENT-VERIFICATION.md) §4b.

> **And that is where the pilot ends:** not at "it worked once on a demo," but wired into your release
> process, failing your build the day someone hands you a seal that no longer matches its bytes.

---

## 5. The honest trust boundary (read this before you rely on anything)

The pilot is deliberately conservative about what it claims:

- **It proves tamper-evidence + offline-recompute + signer-pin.** "These are exactly those files" and
  "this address vouched for them" — both checkable by you, offline, with the independent verifier.
- **It does NOT prove a trusted timestamp.** There is **no trusted "sealed on date T" without P-3.**
  A trustworthy "existed by date T" requires a **human-owned trust-root** — a self-managed signing
  key, an independent RFC-3161 timestamp authority, or an on-chain anchor — which is **P-3** in
  [`STRATEGY.md`](../STRATEGY.md). The pilot uses **ephemeral throwaway keys only**, so it asserts
  nothing about *when*; any date you see in a licence window or report is self-asserted input, not an
  independent attestation.
- **It is NOT a legal or compliance opinion.** The evidence packet makes no domain claim beyond
  tamper-evidence; for TrustLedger, a PASS does **not** imply legal compliance (that meaning is
  CPA/counsel-reviewed — P-5).
- **The pilot ends at the explicit human handoff** and overclaims nothing. The handoff (provision a
  real key / TSA, choose a price, run the partner) is the human go-to-market ask, consolidated as
  **P-8** below.

This boundary is not a footnote — it is the product. We sell verifiable *tamper-evidence and
provenance*, and we are explicit that *trusted time* is a separate, human-owned upgrade.

---

## 6. The single go-to-market ask (P-8)

Everything above is **built, tested, and green**. The one thing the loop cannot do — and the one thing
a human must — is **land a design partner and run a pilot**. That precondition was scattered across
four proposals (P-3 trust-root, P-5 TrustLedger legal/CPA/design-partner, P-6 TrustLedger licence
delivery + pricing, P-7 evidence vertical go-to-market). It is now **consolidated into one
decision-ready ask, P-8**, in [`STRATEGY.md`](../STRATEGY.md) → *Proposals — needs-human*, whose
**deliverable is this very kit**. Read P-8 to see the precise human steps and how running this pilot
de-risks all four gates at once.

---

## 7. Why this is trustworthy to run

- **Offline + no key + no network.** No real private key is ever created, held, persisted, read, or
  echoed; every key in the run is an in-process `Wallet.createRandom()`. No socket is opened.
- **Read-only of your inputs.** Whether you run the canned sample or `--evidence-dir <your folder>`, the
  source is read-only; the kit copies it and every seal/tamper hits the copy. Your originals are never
  written, renamed, or deleted. And even on your own data the boundary is unchanged: the seal proves
  **tamper-evidence + signer-pin**, NOT a trusted "sealed at T" (that still requires **P-3**).
- **Cannot silently rot.** The journey is gated by
  [`test/pilot.evidence.test.js`](../test/pilot.evidence.test.js) +
  [`test/pilot.reconcile.test.js`](../test/pilot.reconcile.test.js), and this runbook's claims are
  gated by [`test/pilot.docs.test.js`](../test/pilot.docs.test.js), all under the project's unchanged
  `npx hardhat test`. If the behaviour or the claims drift, the suite fails.
