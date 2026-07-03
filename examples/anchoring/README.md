# examples/anchoring — a real anchored receipt you can verify offline, right now

Two committed files:

- [`sample-seal.vhevidence.json`](sample-seal.vhevidence.json) — a small, real evidence packet
  (`vh.evidence-seal`, two files under `report/`).
- [`anchored-receipt.local.json`](anchored-receipt.local.json) — the canonical
  `vh-anchored-receipt@1` container a real `vh anchor-artifact --author-bound` run produced for that
  packet against a **LOCAL** in-memory hardhat chain (chainId `31337`, the registry deployed
  in-process, a well-known pre-funded dev key — never a real key).

Verify the binding **offline** — no chain, no key, no network — from the repo root:

```bash
node cli/vh.js verify-anchored examples/anchoring/anchored-receipt.local.json examples/anchoring/sample-seal.vhevidence.json
```

Expected: `ACCEPTED (offline binding check)`, exit `0` — the receipt's digest is **recomputed** from
the packet bytes through the packet's own validator, never trusted from either file. Change one byte
of either file and re-run: a **named** reject, exit `3`.

**The honest boundary, up front.** A receipt from a LOCAL dev chain proves MECHANISM only and is worth NOTHING publicly until a human deploys the registry (STRATEGY.md P-2). The receipt's `chain` facts (tx, block, contributor) are real facts about an **ephemeral throwaway chain** that no longer exists — which is exactly why the offline check stops at the binding and prints the chain facts as the *anchorer's claim*. On a public, pinned deployment the same command plus `--rpc <url> --contract <addr>` re-checks every chain fact against the chain itself.

Full spec, trust boundary, and the worked live flow: [`docs/ANCHORING.md`](../../docs/ANCHORING.md).
