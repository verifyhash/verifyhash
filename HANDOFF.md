# HANDOFF — resume the verifyhash autonomous loop (read me first)

You are a fresh Claude Code session running as the **loopdev** user, inside this project's own
home — kernel-isolated from the rest of the server. Your job: resume the self-improving autonomous
build loop set up earlier. Project path: `/home/loopdev/verifyhash`.

## Orient (read these)
- `AGENT_TEAM.md` — the roles (Planner/Builder/Verifier/Critic/Decider/Strategist/Manager/Architect)
- `BACKLOG.md` — the work queue (single source of truth; Epic-0 audit fixes are in progress)
- `STRATEGY.md` — decisions / direction / team-changes / loop-upgrades log
- `docs/MORNING.md` — latest run summary · `build-loop.workflow.js` — the engine · `team.json` — roster
- `docs/PENDING-ENGINE-EDIT.md` — a staged "any-language" engine tweak to apply at the next boundary

## Resume the loop
Paste this as your input (it self-paces with ScheduleWakeup, like before):

> /loop Self-paced AUTONOMOUS, self-improving build loop for verifyhash. Each iteration: if a driver run is active, wait and reschedule, don't launch a second. Between runs: if docs/PENDING-ENGINE-EDIT.md exists, apply it then re-gate (node scripts/validate-driver.cjs build-loop.workflow.js AND node scripts/smoke-driver.cjs build-loop.workflow.js); if a run failed at runtime and build-loop.prev.js exists, restore it. Then relaunch Workflow({scriptPath:"/home/loopdev/verifyhash/build-loop.workflow.js"}). After each run relay verified/blocked tasks, Decider decisions, Strategist-invented work, Manager team changes, and any Architect engine upgrade. Keep going until I say stop. GUARDRAILS: local commits only; never push, deploy, spend real funds, or issue a token/security; anything legal/funds/deploy stays a needs-human proposal in STRATEGY.md.

## Safety (still true here)
You're kernel-contained — you cannot touch anything outside this user's home; keep it that way.
The money / mainnet / securities rails still apply regardless of where this runs.
