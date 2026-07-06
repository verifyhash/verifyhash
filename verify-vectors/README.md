# verifyhash evidence-seal — frozen cross-implementation conformance vectors

These are the **canonical, language-agnostic conformance vectors** for the verifyhash
evidence-seal verifier (`vh.evidence-seal-signed` packets produced by `vh evidence seal --sign`).
They are **frozen**: any implementation of the verifier — the shipped Node CLI, a Go
re-implementation, a Rust one, an in-browser one — MUST reproduce the exact
`expectedVerdict` / `expectedExit` for every case, byte-for-byte inputs held constant.
This is the reusable trust artifact: a new implementation is only "a verifyhash verifier"
once it passes every vector here.

Ground truth was sealed with the real product CLI and the product vendor key
(issuer `0x7cb4d3dc6c52996b6386473bfb32f898263412f7`) — no hand-authored packets.

## Layout

```
vectors/
  vectors.json                 # the vector index (array of cases + the verdict/exit contract)
  SHA256SUMS                   # integrity manifest over every frozen byte
  cases/<name>/
    packet.vhevidence.json     # the signed evidence-seal packet (the SEALED ground truth)
    files/                     # the directory a consumer verifies the packet against
```

## Vector format (`vectors.json`)

Top-level object with a `cases[]` array. Each case:

| field              | meaning                                                                                 |
|--------------------|-----------------------------------------------------------------------------------------|
| `name`             | stable case id (also the directory name under `cases/`)                                  |
| `packetRelPath`    | path to the signed packet, relative to this `vectors/` dir                               |
| `filesDirRelPath`  | path to the directory of files to verify the packet against, relative to `vectors/`      |
| `vendor`           | the issuer address the **consumer pins** (the `--signer` to expect)                      |
| `expectedVerdict`  | `ACCEPT` or `REJECT`                                                                     |
| `expectedExit`     | `0` (ACCEPT) or `3` (REJECT) — the shared 0/3 verify contract                            |
| `reason`           | the reject class: `ok` / `changed` / `missing` / `unexpected` / `wrong_issuer`           |
| `failedCheck`      | the canonical check that fails (`manifestBindsAttestation` or `signerMatchesExpected`)   |
| `localizedAs`      | what `vh evidence verify` reports per-file (CHANGED / MISSING / …), for auditor context  |
| `note`             | prose on what the case pins                                                              |
| `_root`, `_signer`, `_fileCount` | informational frozen ground-truth digests — **not** verifier inputs        |

## The canonical verification procedure (what an implementation must reproduce)

A **full** verify of a signed evidence-seal packet is a single decision:

> **ACCEPT** iff (1) the EIP-191 signature is authentic over the sealed head, **and**
> (2) the recovered signer equals the pinned `vendor`, **and** (3) a rebuild of the seal
> from a **full scan of `filesDirRelPath`** binds byte-for-byte to the sealed payload.
> Anything else is **REJECT**.

The shipped reference command that computes exactly this:

```
node cli/vh.js evidence verify-signed <packetRelPath> --dir <filesDirRelPath> --signer <vendor>
```

Exit `0` = ACCEPT, `3` = REJECT, `2` = usage, `1` = IO.

Two nuances every conformant verifier must honor (both are pinned by a vector):

- **`wrong-vendor`** — the bytes and packet are 100% genuine; only the *pinned issuer*
  differs. Content binding passes but the issuer pin fails → REJECT (`wrong_issuer`).
  A verifier that checks only the bytes and not the signer is **wrong**.
- **`extra-file`** — an injected file the seal never committed sits next to the genuine
  set. The canonical gate rebinds against the **whole directory**, so the extra file
  breaks the bind → REJECT (`unexpected`). Note `vh evidence verify` *alone* re-derives
  only the packet-**named** files and would ACCEPT; a conformant full verifier MUST bind
  against the entire directory, not just the named subset.

## Integrity — how a consumer regenerates / checks these vectors

- **Check the frozen bytes:** from `vectors/`, run `sha256sum -c SHA256SUMS`. Every case
  file, the packet(s), and `vectors.json` are pinned; any drift is a mismatch.
- **Regenerate ground truth:** the Merkle `root` in each packet is a deterministic function
  of the `(relPath, content)` set, so re-running
  `vh evidence seal cases/<name>/files --sign …` reproduces the exact `_root` recorded in
  `vectors.json` — recompute it and compare (no key needed to check the root; only the
  signature wrap needs the vendor key).
