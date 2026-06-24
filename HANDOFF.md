# HANDOFF — resume the verifyhash autonomous loop (read me first)

You are a fresh Claude Code session running as **loopdev**, inside this project's own home —
kernel-isolated from the rest of the server. Your job: resume the self-improving autonomous
build loop. Project path: `/home/loopdev/verifyhash`. Last updated: 2026-06-24.

## Orient (read these)
- `AGENT_TEAM.md` — roles (Planner/Builder/Verifier/Critic/Decider/Strategist/Manager/Architect)
- `BACKLOG.md` — work queue (single source of truth) · `STRATEGY.md` — decisions/direction/team/loop-upgrades log
- `docs/MORNING.md` — latest run summary · `team.json` — roster (5 reviewers, 4 builder profiles)
- `build-loop.workflow.js` — the engine (currently upgrade **#14**, the tiered build) · `build-loop.prev.js` — prior engine (rollback)
- `docs/USAGE-BUDGET.json` — the **spend governor** (see below) · `scripts/validate-driver.cjs` + `scripts/smoke-driver.cjs` — the two self-upgrade gates
- Memory dir (loads each session): `loop-spend-governor`, `pending-engine-efficiency-swap`, `loop-mandate-breadth-and-crypto-line`

## Current operational state
- **Engine #14 is live** (tiered): mechanical agents run cheaper models (roster/block/commit→haiku, preflight/plan/reporter→sonnet); build/verify/review/decide/strategize/manager/architect/gatekeeper stay Opus; the Verifier always runs the FULL test suite (the pinned correctness gate). Reversible via `build-loop.prev.js`.
- **Spend governor** (`docs/USAGE-BUDGET.json`), enforced by the supervisor at each relaunch boundary (NOT the engine): 2h cooldown between runs, 120M-tokens/week ceiling, **pause-and-wait at cap**. After each run: reconcile its `subagent_tokens` into `spentTokens`, append to `runs[]`, set `lastRunEndEpoch/Iso`; reset the window if past `windowResetIso`.
- **Products built** (all local commits, nothing deployed): verifyhash provenance core + `vh` CLI; shared cores (license/packetseal/attestation/manifest/rfc3161); income products DataLedger, ProofParcel, TrustLedger (+web UI +licensing); the standalone zero-dep **independent verifier** (`verifier/`, incl. single-file zero-install build + CI merge-gate); the design-partner **pilot kit** (`pilot/`).
- **Pending, awaiting USER greenlight (do NOT auto-start)**: the audit's 5 engine-quality fixes — see memory `pending-engine-efficiency-swap` (min()→median usefulness aggregation, driver-writes-METRICS, archive/slice big docs, dissenter-only rework re-score).

## Resume the loop
Paste this as your input (self-paces with ScheduleWakeup):

> /loop Self-paced AUTONOMOUS, self-improving build loop for verifyhash. Each iteration: if a driver run is active, wait and reschedule, don't launch a second. STALL WATCH: if the active run's newest journal write is >10min old AND no completion notification AND status running, TaskStop it, wip-commit any in-flight work, proceed to the between-run window. BUDGET GOVERNOR: when a run completes, reconcile its subagent_tokens into docs/USAGE-BUDGET.json (spentTokens += tokens; append to runs[]; set lastRunEndEpoch/Iso); if now>windowResetIso reset the window; then if spentTokens>=ceilingTokens PAUSE (report + long heartbeat only); else if (now-lastRunEnd)<cooldownSeconds schedule a wakeup for the remaining cooldown (cap 3600s/hop) and DON'T launch yet; else proceed. Between runs: if docs/PENDING-ENGINE-EDIT.md exists, apply it then re-gate (node scripts/validate-driver.cjs build-loop.workflow.js AND node scripts/smoke-driver.cjs build-loop.workflow.js); if a run failed at runtime and build-loop.prev.js exists, restore it. Then relaunch Workflow({scriptPath:"/home/loopdev/verifyhash/build-loop.workflow.js"}). After each run relay verified/blocked tasks, Decider decisions, Strategist-invented work, Manager team changes, and any Architect engine upgrade. Keep going until I say stop. GUARDRAILS: local commits only; never push, deploy, spend real funds, or issue a token/security; anything legal/funds/deploy stays a needs-human proposal in STRATEGY.md.

## Safety (still true here)
Kernel-contained — never touch anything outside this user's home (esp. protect `/home/prerender-service`).
Money / mainnet / securities rails apply regardless: no token/coin/security, no real funds, no deploy, no push — those stay needs-human proposals in STRATEGY.md. The one hard product line: no token/coin-for-revenue. Crypto-as-domain is fine.
