# verify-vh — sealed-artifact merge gate (GitHub Action)

A composite GitHub Action that **fails your build the instant a sealed verifyhash artifact is tampered,
forged, or signed by the wrong key.** It installs ONLY the standalone, offline `verify-vh` verifier
(`js-sha3` — no ethers, no hardhat, no network) and runs it over your release artifact(s).

**What a green check means depends on `vendor:`:**

- With **`vendor:` set** — a green check means *"every sealed artifact still matches the bytes the key
  you pinned signed."* An artifact signed by any other key is **REJECTED** (exit 3).
- With **`vendor:` omitted** — a green check means **tamper-evidence ONLY**: the bytes match the seal,
  but it does **NOT** prove **WHO** signed. See the security warning below before omitting `vendor:`.

> ⚠️ **Pin `vendor:` for any SIGNED release.** A signed artifact gated **without** `vendor:` is accepted
> as long as its signature recovers to the signer the packet **self-asserts** — so an attacker who
> re-signs a tampered release with **their own key** passes this gate. `vendor:` is what makes the green
> check mean "signed by the producer **I** pinned" rather than "signed by **whoever** built this packet."
> Leave `vendor:` empty **only** for genuinely unsigned evidence seals (where there is no signer to pin).

Adoption is **one line**:

```yaml
# .github/workflows/verify-vh.yml
name: verify-vh merge gate
on: [push, pull_request]
jobs:
  verify-vh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: verifyhash/verifyhash/verifier/action@73ec69746ea6c9d1b357bfaa8874971e29016c2d
        with:
          vendor: "0xYOUR_PRODUCER_SIGNER_ADDRESS"   # the key that must have signed (omit to check tamper only)
          manifest: "release.manifest"               # OR set `artifacts:` instead
```

> The `uses:` line is pre-pinned to this repository's real slug (`verifyhash/verifyhash`) and a full
> 40-hex commit SHA reachable from `main` — it works exactly as pasted. Supply-chain hygiene: re-pin
> `@<sha>` to a commit SHA **you** have audited and trust (keep the full-SHA form; a mutable ref like
> `@main` can change under you). GitHub fetches this action's own tree when you reference it with
> `uses:`, and the action resolves the bundled `verifier/` via `${{ github.action_path }}` at run time
> (it does NOT run from your `$GITHUB_WORKSPACE`). So you do **not** need to vendor `verifier/` into your
> repo — your `actions/checkout` brings only your artifacts, not the verifier.

## Inputs

| input          | required | default                     | what it is |
|----------------|----------|-----------------------------|------------|
| `vendor`       | no       | `""`                        | The producer's signer address (`0x` + 20 bytes), obtained out-of-band, that **every signed artifact must verify against**. When set, an artifact signed by any other key is **REJECTED** (exit 3). Leave empty to verify tamper-evidence only (e.g. an unsigned evidence seal). **⚠️ Leaving this empty on a SIGNED artifact accepts an attacker-re-signed release — pin it for any signed release** (see warning above). |
| `manifest`     | no       | `""`                        | Path to a release manifest (newline list or JSON array of artifact paths, each entry may carry its own `--vendor`/`--dir`) that gates the **whole release in one invocation**. Set this **OR** `artifacts`. |
| `artifacts`    | no       | `""`                        | Space-separated artifact path(s) when no `manifest` is given (e.g. `"dist/a.vhevidence.json dist/b.vhseal"`). Set this **OR** `manifest`. |
| `dir`          | no       | `""`                        | Directory holding the files the artifact(s) reference (the sealed packet). Defaults to each artifact's own directory (sibling resolution). |
| `verify-vh`    | no       | _(action's bundled tree)_   | Path to the standalone `verify-vh.js` (advanced/testing override). Defaults to the verifier tree **bundled with this action**, resolved at run time via `${{ github.action_path }}` — so you do **not** vendor `verifier/` into your repo. |
| `node-version` | no       | `"20"`                      | Node.js version to set up for the verifier (`>= 18`). |

## Exit-code contract (the job status is meaningful)

The action propagates `verify-vh`'s own exit code, so any non-zero verdict fails the job and **blocks the merge**:

| exit | meaning      | gate result |
|------|--------------|-------------|
| `0`  | OK           | every artifact verified — allow the merge |
| `3`  | REJECTED     | an artifact was tampered/forged/wrong-issuer — **block** (the report names which) |
| `2`  | USAGE        | misconfiguration (no `manifest`/`artifacts`, bad flag/address) |
| `1`  | IO           | an artifact or the manifest could not be read — never reported as "passed" |

## Single source of truth — no drift

The verifier-invocation the gate step runs is **byte-identical** to the one shipped in
[`verifier/ci/verify-vh.generic.sh`](../ci/verify-vh.generic.sh) (the portable shell gate for any CI).
A test (`test/verifier.action.test.js`) parses this `action.yml`, extracts the gate `run:` block, runs
it over the committed sample sealed packet (asserting exit `0`) and over a one-byte-tampered copy
(asserting exit `3`), and asserts that invocation has not drifted from `verify-vh.generic.sh`. So this
Action, the generic shell gate, and the GitHub Actions YAML example all run the **same** gate.

## What it installs (and what it does NOT)

The install step runs `npm ci --omit=dev || npm install --omit=dev` inside `verifier/`, whose
`package.json` declares exactly one runtime dependency — `js-sha3`. It pulls **no** `ethers`, **no**
`hardhat`, **no** `@nomicfoundation`, and opens no network beyond the registry fetch. The verifier is
read-only: it holds no key and writes nothing.

## Related

- [`verifier/ci/verify-vh.generic.sh`](../ci/verify-vh.generic.sh) — the same gate as a portable `set -e` shell snippet (GitLab CI / Makefile / git hook / cron box), configured by `VH_*` env vars.
- [`verifier/ci/verify-vh.github-actions.yml`](../ci/verify-vh.github-actions.yml) — a hand-rolled GitHub Actions **workflow** example (this Action is the one-line replacement for it).
- [`verifier/README.md`](../README.md) — the standalone verifier itself: how to vendor or `npm install` just this tree and audit it in an afternoon.
