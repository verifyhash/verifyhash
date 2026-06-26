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

### Evaluate it with ZERO install first (the 10-second no-clone path)

Before you check out the repo at all, you can drive the **whole** evidence journey — seal → hand-off →
verify — from **two self-contained files**, with **no clone, no `npm install`, no account, no key** on
either side. Save [`../verifier/dist/seal-vh-standalone.js`](../verifier/dist/seal-vh-standalone.js) and
[`../verifier/dist/verify-vh-standalone.js`](../verifier/dist/verify-vh-standalone.js) (each depends on
nothing but Node core), then:

```bash
# 1. Seal up to 25 of YOUR OWN files into one tamper-evident packet:
node seal-vh-standalone.js /path/to/your/folder -o packet.vhevidence.json    # exit 0 = sealed

# 2. Hand packet.vhevidence.json + the folder to a counterparty; they run the FREE verifier:
node verify-vh-standalone.js packet.vhevidence.json --dir /path/to/your/folder   # 0 = verifies, 3 = REJECTED
```

That is the same organic loop a real counterparty would run, on your own data, before any sales call. The
free seal proves **tamper-evidence + offline-recompute** — and **NOT** a trusted "sealed at T" (that still
requires **P-3** — see §5). The free seal is **UNSIGNED** and **capped at 25 files**; **SIGNING** (so a
counterparty can pin you with `--vendor`) and **UNLIMITED** sealing are the PAID upgrade —
`vh evidence seal --sign` / the `evidence_unlimited` entitlement. Full round-trip in
[`../verifier/README.md`](../verifier/README.md) §0a and
[`INDEPENDENT-VERIFICATION.md`](INDEPENDENT-VERIFICATION.md) §0a. The `node pilot/run-pilot.js` kit above
is the deeper, license-gated evaluation; this zero-install loop is the fastest first taste.

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
  claim. **Zero-install option:** for a counterparty who was handed only a packet, save the single
  self-contained file [`verifier/dist/verify-vh-standalone.js`](../verifier/dist/verify-vh-standalone.js)
  (optionally check its published `verify-vh-standalone.js.sha256`) and run
  `node verify-vh-standalone.js <packet> --vendor <0xOperator>` — no clone, no `npm install`, no account;
  it is byte-for-byte the same verifier and proves the same **tamper-evidence + signer-pin**, NOT a
  trusted "sealed at T" (that still requires **P-3**). See [`verifier/README.md`](../verifier/README.md)
  §0 and [`INDEPENDENT-VERIFICATION.md`](INDEPENDENT-VERIFICATION.md) §0.
- **And confirm the VERIFIER itself rejects what it should** — run the adversarial conformance corpus
  (`node challenge/corpus/run-corpus.js`, exit 0 = every poisoned input REJECTED by every shipped
  verifier) in place of trusting our claim; it proves REJECT of every *enumerated* tamper class (NOT the
  absence of unknown ones, and a REJECT is tamper-evidence NOT a trusted timestamp without **P-3**). See
  [`CONFORMANCE.md`](CONFORMANCE.md).

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

- **And confirm the GATE itself is correct — run this in place of trusting our disclaimer.** A seal proves
  the packet is byte-for-byte unaltered; it does **not** tell you whether a **FAIL really means out of
  trust**. To confirm the reconciliation **gate** is correct — that it FAILs the canonical trust-account
  frauds and PASSes their benign twins — run the committed **correctness corpus**, one read-only command,
  no setup:

  ```bash
  vh trust corpus            # exit 0 = CORPUS OK (every scenario matches); exit 3 = CORPUS DRIFT
  ```

  It drives a committed library of out-of-trust scenarios (an un-segregated security deposit, a
  sub-ledger out of balance, a negative individual ledger, an owner over-draw, a bank-short mismatch, a
  broken roll-forward) **and** their benign near-twins through the **same** engine path the real
  `reconcile` exit uses, and prints a per-scenario table (control, expected vs **actual** verdict,
  `OK`/`MISMATCH`) plus the trust-law **principle** under each row. This is what a CPA or broker **runs**
  to confirm the gate is correct **in place of trusting our disclaimer** (see
  [`TRUSTLEDGER.md`](TRUSTLEDGER.md) › *The correctness corpus*). It **confirms the gate's behaviour** —
  it does **NOT** certify a jurisdiction or constitute legal advice; for TrustLedger a PASS does **not**
  imply legal compliance, the broker remains the responsible legal custodian, and that meaning stays
  CPA/counsel-reviewed under **P-5** (§5).

### 3c. The licence (`*.vhlicense.json`)

- **What it proves.** It is the **access credential** that unlocks the paid surface (`evidence
  seal --sign`, `reconcile --seal`). It is signed by the vendor key and verified offline; a wrong,
  expired, or under-entitled licence is a **hard refuse**, never a silent downgrade. The pilot proves
  this gate is **real** by showing the paid surface refused with **no** licence and refused again with
  a licence pinned to the **wrong** vendor.
- **What it is NOT.** Not a token, not tradeable, not an appreciating asset. Income is a subscription
  / licence for delivered software value — the credential is just the key to the door.

### 3d. The pilot result certificate — your SHAREABLE deliverable (`--certificate`)

When you run the pilot on your own folder (§2), the terminal `VERDICT: PASS` is the proof *on your
machine*. To turn "the demo passed on my machine" into a **forwardable, tamper-evident record** your
security and procurement teams can check for themselves, add one flag and the kit seals the run into a
portable `*.vhevidence.json` **certificate**:

```bash
node pilot/run-pilot.js --evidence-dir /path/to/your/folder --certificate ./pilot-result.vhevidence.json
```

This writes two things alongside each other — the certificate `pilot-result.vhevidence.json` and its
companion `pilot-result.files/` directory (the sealed result bytes). **Forward both together.** Anyone
you hand them to verifies the certificate **independently**, with **no clone, no `npm install`, no
account, no key**, using the zero-install single-file verifier
[`../verifier/dist/verify-vh-standalone.js`](../verifier/dist/verify-vh-standalone.js):

```bash
# they save verify-vh-standalone.js, then run it on the bytes you forwarded:
node verify-vh-standalone.js --dir ./pilot-result.files ./pilot-result.vhevidence.json   # exit 0 = ACCEPT, 3 = REJECT
```

Exit **0** = the certificate's keccak root re-derives from the bytes on disk — the result record is
exactly what the pilot produced; exit **3** = REJECTED, localized to the byte that changed. The kit
prints the precise verify command (and, for a signed certificate, the operator address to pin with
`--vendor`) after the verdict line. That is what turns a one-off demo into a record your team can carry
into a procurement review and confirm without trusting you — or us.

**Then READ the verdict out of the bytes you just verified — the certificate is a self-contained
procurement record, not just a checksum.** The whole point of a forwardable certificate is that the
reviewer who confirmed exit `0` does **not** then have to take a sales claim about *what the run checked*
on faith: the **machine-readable result record** — `verdict`, the `passed`/`total` counts, and the full
**labelled checklist** of every gate the pilot exercised — lives **inside** `pilot-result.files/pilot-result.json`,
which is the **exact byte stream the keccak root commits to**. So once verify-vh ACCEPTs, the contents of
that file are *part of what was proven unaltered*. Read the headline with one Node-only line (no extra
install, no `jq` needed):

```bash
# the same file the certificate's root commits to — its contents are part of what you just verified:
node -e 'const r=require("./pilot-result.files/pilot-result.json"); console.log(r.verdict+" — "+r.passed+"/"+r.total+" checks; evidenceSource="+r.evidenceSource)'
# → PASS — 24/24 checks; evidenceSource=partner

# and read the FULL labelled checklist of what was actually exercised (open it, or list the labels):
node -e 'require("./pilot-result.files/pilot-result.json").checks.forEach(c=>console.log((c.ok?"[PASS] ":"[FAIL] ")+c.label))'
```

`evidenceSource` reads `partner` when the pilot ran on the partner's **own** folder (§2) and `canned` on
the committed sample — so a procurement reviewer can see at a glance whether the forwarded certificate was
produced on real data or the demo set, **from the verified bytes themselves**. (`jq -r '.verdict' pilot-result.files/pilot-result.json`
works identically if your reviewer prefers it.) This is the leverage of the certificate over a bare
PASS/FAIL screenshot: the verdict, the counts, and the precise list of checks are a tamper-evident,
forwardable **artifact** a security/procurement team reads and re-confirms on its own — the screenshot is
not.

**The HONEST boundary (read this before you forward it).** The certificate proves WHAT the pilot run
checked and that the result bytes are unaltered — it is tamper-evidence over the run record, NOT a
trusted "the pilot ran at time T" without P-3, and NOT a legal/compliance verdict. The pilot signs
with **ephemeral throwaway keys only**, so any date inside the record is self-asserted input, not an
independent attestation of *when* — a trusted "ran at time T" still requires the human-owned trust-root
of **P-3** (§5). And it is tamper-evidence over a run record, not an opinion: it makes no legal or
compliance claim (for TrustLedger a PASS does not imply legal compliance — that meaning stays
CPA/counsel-reviewed under **P-5**, §5).

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

### The pilot success contract (the measured WTP instrument)

A pilot that ends at "the partner liked it" leaves the money question — **"is this worth paying for ON MY
data?"** — to a relational hunch. The TrustLedger pilot's success contract is therefore a **measured**
one, run on the partner's **own already-closed period**: **`vh trust value-proof`**. The partner runs a
month they **already reconciled by hand and signed off**, and the command compares the **same** reconcile
gate against that manual close and prints **one of three outcomes**, exit-coded so the pilot can read the
result without interpretation:

```bash
vh trust value-proof <bank> <ledger> <rentroll> --period <label>
#   exit 3 = out_of_trust_missed — the dollars the gate caught that the manual close LET THROUGH (the WTP case)
#   exit 4 = data_gap_only      — fix-my-data-and-re-run; NOT (yet) evidence the money is gone
#   exit 0 = clean_confirmed    — a signed, independent confirmation of a clean trust account
```

Every count and dollar figure is read **verbatim** off the period's reconciliation — the **same**
numbers `vh trust reconcile --json` shows — so the value-proof is the **same** verdict path the paying
broker's licensed gate runs, not a narrower one. The deeper spec is in
[`TRUSTLEDGER.md`](TRUSTLEDGER.md) › *The value-proof*. This is the **measured** form of P-5 #3's
two-month WTP validation: it turns "their willingness to keep using it is the WTP signal" into a dollar
figure a broker reads on **their own** month.

> **The value-proof COMPARES the gate to the manual close — it does NOT certify a jurisdiction or
> constitute legal advice.** It quantifies what the gate found that the broker's manual close did not; it
> does not certify that any state's trust-fund rules are satisfied and is not legal/accounting/audit
> advice. The standing TrustLedger pilot posture is unchanged: a **PASS does not imply legal compliance**,
> the broker remains the **responsible legal custodian**, and that meaning stays CPA/counsel-reviewed
> under **P-5**.

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
