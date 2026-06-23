# Pending engine edit — apply at the next run boundary (no driver running)

User direction (2026-06-23): the **product** is not bound to any language; the loop may choose or migrate
stacks as it sees fit. (The engine/orchestration stays JS.)

Apply to `/root/verifyhash/build-loop.workflow.js`, then re-gate, then commit:

1. **Add a STACK LATITUDE clause to the `VISION` constant** (after the GOAL paragraph, before HARD GUARDRAILS):

   > STACK LATITUDE: You are NOT bound to any language or framework. Choose the best tool for each task
   > (Solidity, JS/TS, Rust, Python, Go, a different chain, etc.) and you MAY migrate the project's stack
   > when it clearly serves the goal — provided the change keeps an automated test/verify gate working: a
   > Builder must leave a green test suite and the Verifier must be able to run it. When you change stacks,
   > document the migration (and the new test command) in STRATEGY.md under "## Direction".

2. **Generalize the hardcoded test command** in `builderPrompt` and `verifierPrompt`: replace the literal
   `npx hardhat test` references with "the project's test command (currently `npx hardhat test`; if the
   stack has changed, the correct command for it, as recorded in STRATEGY.md)".

3. **Do NOT change the gates.** `validate-driver.cjs` / `smoke-driver.cjs` validate the JS *engine*, not the
   product — they stay as-is regardless of product language.

4. **Re-gate before going live:** `node scripts/validate-driver.cjs build-loop.workflow.js` AND
   `node scripts/smoke-driver.cjs build-loop.workflow.js`. If BOTH pass → `git commit` locally. If EITHER
   fails → revert the edit (`git checkout -- build-loop.workflow.js`) and keep the current engine.

5. Delete this file once applied.
