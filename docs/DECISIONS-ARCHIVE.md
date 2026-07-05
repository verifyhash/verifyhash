# verifyhash — Decisions archive (curated out of STRATEGY.md)

Superseded `## Decisions` entries relocated here BYTE-FOR-BYTE by the Decider when STRATEGY.md
needed headroom under its standing size budget (`test/strategy.archive.test.js` pins the live file
under 80KB; `scripts/archive-direction.cjs` deliberately does NOT own `## Decisions`, so this file
is curated by hand — newest-first, full text preserved, a one-line summary + pointer stays live in
STRATEGY.md). Nothing here is deleted or reworded when archived.

## Decisions (archived)

- **2026-07-01 — T-63.1 stale `BLOCKED` → RECONCILED to `TODO`/verify-only (chose reconcile + fix the UNRELATED doc-hygiene regression, NOT re-author the core — the T-46.1 / T-61.1 pattern).**
  - **Problem.** T-63.1 (the pure ORDERED RFC-6962 / Certificate-Transparency-style Merkle-log core `cli/journal-log.js` — `treeHead`/`inclusionProof`/`verifyInclusion`/`consistencyProof`/`verifyConsistency`, reusing `cli/hash.js hashBytes` VERBATIM with `0x00` leaf / `0x01` node domain separation and NO sorting) was tagged `BLOCKED` "auto-build failed after 3 attempts: the targeted `test/journal-log.core.test.js` passes 33/33 but the FULL suite went RED." The fork: (a) reconcile + diagnose/fix the full-suite regression, or (b) re-author the core.
  - **Chosen.** (a) reconcile. I re-ran the targeted suite (`npx hardhat test test/journal-log.core.test.js` → 33/33) and the FULL suite; the 16 failures are ALL in `test/strategy.archive.test.js` (T-56.2) and `test/strategy.size-guard.test.js` (T-56.3) — the STRATEGY.md doc-size guard — and NONE touch `journal-log.js`. Root cause: the Strategist appended TWO `## Direction` entries (the 2026-07-01 (f)/(g) EPIC-62/63 notes) WITHOUT running the standing archiver, so the working tree carried 3 live `## Direction` entries (over the max of 2) and the frozen no-loss fixtures went stale — the exact re-bloat condition `scripts/archive-direction.cjs` + the per-run fixture refresh exist to self-heal. The committed HEAD STRATEGY.md passes the guard (1 live entry, 75528 bytes); the RED is purely the un-landed doc-hygiene the failed build skipped, entirely ORTHOGONAL to the Merkle-log core.
  - **Why not re-author (b).** A broken core could not produce a green 33/33 that round-trips generate→verify over every `(size,index)` and every `(m≤n)` pair, demonstrates position-preservation vs the sorted-pair `cli/hash.js buildTree`, catches a rewritten past journal entry (no bridging proof exists), and passes the static purity guard (no `fs`/`http`/`net`/`dns`, no key). Re-authoring a correct, tested, PURE core to "fix" a STRATEGY.md doc-size failure would regress a green leg for zero value — the 3 prior "failures" are a status/harness artifact (the build produced the files but the run's landing hygiene never ran), exactly as with T-46.1 and T-61.1.
  - **Action.** Performed the SAME doc-hygiene every task landing does (the failed build skipped it): ran `scripts/archive-direction.cjs` (healed `## Direction` back to 1 live entry, relocating the older entries BYTE-FOR-BYTE into `docs/STRATEGY-ARCHIVE.md`) and regenerated the two frozen fixtures (`test/fixtures/strategy-direction-original.json`, `strategy-logsections-original.json`) to the new set — after which the full `npx hardhat test` suite is green. Flipped BACKLOG T-63.1 `BLOCKED`→`TODO`, replaced the "auto-build failed" note with a dated reconcile note, and rewrote acceptance as 6 concrete VERIFY-ONLY checks (5 exports + `EMPTY_ROOT`; purity grep; position-preservation vs the sorted tree; inclusion accept/reject; consistency accept/reject; targeted 33/33 AND full suite green) — flip to `VERIFIED` once they hold. No change to `journal-log.js`. This unblocks T-63.2 (the `vh journal tree-head`/`prove-inclusion`/`prove-consistency`/`check-proof` surface) and T-63.3 (docs). Test command unchanged: `npx hardhat test`.

- **2026-07-01 — T-61.1 stale `BLOCKED` → RECONCILED to `TODO`/verify-only (chose reconcile, not a 4th auto-build — the T-46.1 pattern, repeated).**
  - **Problem.** T-61.1 (`scripts/go-live-check.js` — the executable, offline, dependency-free go-live-readiness
    proof: seal→independent-verify, license issue→verify→fail-closed-gate, fulfill→deliver→gate-accept, all on
    fixtures with ephemeral `Wallet.createRandom()` keys, no network/deploy/funds) was tagged `BLOCKED`
    "auto-build failed after 3 attempts", yet it is pure engineering, fully in-guardrails, and every dependency
    (EPIC-30 `seal`/`verify`, EPIC-37 + evidence-plans `fulfill`/`fulfillEvidenceOrder`, the independent verifier)
    is shipped & green. It is the SOLE blocker for T-61.2 and the whole EPIC-61 value-ceiling intervention. The
    fork: retry the auto-build (and split the one large script into per-leg tasks), OR reconcile the status the
    way T-46.1 was — verify whether the artifact already exists rather than re-author it.
  - **Chosen.** Reconcile. The artifact ALREADY EXISTS in the tree and is complete: `scripts/go-live-check.js`
    (exports `{ main, HUMAN_STEPS, LEGS, PLAN_ID }`, node-core + this repo's own `cli/vh.js`/`verifier/verify-vh.js`/
    `cli/evidence.js` + `ethers` `Wallet` only — no new dependency), `test/go-live-check.test.js` (12 tests), and
    the `package.json` `go-live` wiring. I ran it directly (`node scripts/go-live-check.js` → exit 0; all three
    legs PASS; the verbatim 4-step `HUMAN_STEPS` + revenue-integrity boundary printed LAST) and its full acceptance
    suite under the real runner (`npx hardhat test test/go-live-check.test.js` → 12 passing): the POSITIVE run,
    the THREE negative self-tests (`GO_LIVE_INJECT_FAULT=seal|gate|fulfill` each exit non-zero, name the broken
    leg, never a false `ALL LEGS PASS`), the guardrail greps (keys only from `Wallet.createRandom()` via
    `--key-env`; no `http`/`https`/`net`/`dns`; no real-key path), the hygiene checks (throwaway `vh-golive-*`
    workspace removed on exit; repo top-level listing unchanged), and the `npm run go-live` wiring. It holds NO
    real key, opens NO network, deploys NOTHING, takes NO payment, and cleans up its workspace.
  - **Why not a 4th auto-build (nor a per-leg split).** The acceptance is demonstrably met and the artifact is
    sound — a broken T-61.1 could not produce a green 12-test suite that drives every leg end-to-end. Re-authoring
    (or splitting) a working, tested proof risks regressing a green leg for zero value; the 3 prior "failures" are
    a status/harness artifact (the build produced the files but the run didn't record success), exactly as with
    T-46.1. The split rationale in the fork prompt was a hypothesis about WHY a 3-attempt failure happened — but
    the file that exists is a single, coherent, passing script, so the premise (too large to land in one shot) is
    moot. The cheaper, correct move is to gate on re-confirming the existing artifact, not to rebuild it.
  - **Action.** BACKLOG T-61.1 flipped `BLOCKED`→`TODO`; the "auto-build failed" note replaced by a dated reconcile
    note; acceptance rewritten as 6 concrete VERIFY-ONLY checks (exports present & no new dependency; positive run
    exits 0 with all 3 legs PASS + verbatim HUMAN_STEPS last; the 3 fault-injection negatives; guardrail greps;
    workspace-cleanup + unchanged checkout; `npm run go-live` wiring + full `npx hardhat test` green) — flip to
    `VERIFIED` once they hold. No code change. This unblocks T-61.2 (the single decision-ready `docs/GO-LIVE.md`
    "first dollar" page that CITES this proof). Test command unchanged: `npx hardhat test`.

- **2026-06-25 — T-46.1 stale `BLOCKED` → RECONCILED to `TODO`/verify-only (chose reconcile, not a 4th auto-build).**
  - **Problem.** T-46.1 (the pure `diffEvidence` core for `vh evidence diff`) was tagged `BLOCKED`
    "auto-build failed after 3 attempts", yet its deliverables already exist and its two dependents
    (T-46.2, T-46.3) are already `VERIFIED`. The fork: re-attempt a 4th auto-build, or reconcile the
    status to reflect reality?
  - **Chosen.** Reconcile. `cli/evidence.js` already exports `diffEvidence({packetA,packetB})` and its
    positional overload `diffEvidenceSeals` — both validate EACH input through the existing strict
    `readSeal` BEFORE any diff (corrupt/foreign/wrong-kind packet rejected, never half-accepted), map
    `files[]`→`{path,contentHash,leaf}`, and reuse `require("./receipt").diffManifest` VERBATIM with the
    authoritative `identical` driven by the change set (`diff.identical`), not root-string equality — so a
    hand-edited `root` cannot flip the verdict and a rename surfaces as REMOVED+ADDED. `test/cli.evidence.diff.test.js`
    has 9 tests; I re-ran the file (9 passing) and the FULL suite (`npx hardhat test`, 2278 passing).
  - **Why not a 4th auto-build.** The acceptance criteria are demonstrably met and the artifact is sound.
    Re-authoring a working, tested, reused-by-VERIFIED-dependents function risks regressing a green leg for
    no value — the 3 prior "failures" were a status/harness artifact, not a real engineering gap (a broken
    T-46.1 would make the VERIFIED T-46.2/T-46.3 impossible). The cheaper, correct move is to gate on
    re-confirming the existing artifact, not to rebuild it.
  - **Action.** BACKLOG T-46.1 flipped `BLOCKED`→`TODO` with the "auto-build failed" note replaced by a
    dated reconcile note; acceptance rewritten as 6 concrete VERIFY-ONLY checks (exports present, strict
    `readSeal` preflight on both inputs, `diffManifest` reused verbatim, change-set-driven `identical` a
    hand-edited root cannot flip, the test file green, and `seal`/`verify` + P-lines unchanged) — flip to
    `VERIFIED` once those hold. No code change. Test command unchanged: `npx hardhat test`.
