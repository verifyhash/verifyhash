# Vendor self-provenance — `scripts/vendor-provenance.cjs`

verifyhash sells provenance. Until this packet exists **published and anchored**, the vendor's own
release has none: the registry holds no record of our own tarball, and no authoritative channel
pins which signing address speaks for the vendor. A provenance vendor whose own package carries no
provenance is a disqualifying irony — this builder closes it with the **same shipped tools we sell**,
and states plainly what each artifact does and does **not** prove.

## What the builder does (fully offline)

```
node scripts/vendor-provenance.cjs --key-env <VAR> --out <dir>
```

1. `npm pack` of the **local working tree** into a temp dir (no registry access; scripts disabled).
2. Computes the tarball's **sha256**, **sha512-SRI**, and **keccak256** (via `vh hash` — the same
   digest the registry would anchor for a raw file).
3. Mints a **self-issued** evidence license with the caller's key via `vh evidence license fulfill`
   — dogfood: the paid gate we sell is the paid gate we pass.
4. Assembles the payload dir: the tarball plus an `IDENTITY.json` statement naming the vendor
   address derived from the caller-supplied key, the package name/version from `package.json`, the
   git commit packed, and all three digests.
5. Seals the payload with `vh evidence seal --sign` and emits **both** artifacts:
   - `vendor-provenance.vhevidence.json` — the **UNSIGNED** `vh.evidence-seal` packet. This is the
     **anchorable** one: it is the only evidence kind in `vh anchor-artifact`'s closed table.
   - `vendor-provenance.signed.vhevidence.json` — the **SIGNED** container wrapping the exact same
     canonical seal bytes (one root, one signed-over payload). Handing the signed container to
     `vh anchor-artifact` is an **unknown-kind reject (exit 3)** — anchor the unsigned seal.
6. Self-verifies everything through the shipped verifiers (`vh evidence verify` on both artifacts,
   `vh evidence verify-signed` pinned to the derived address), then **prints** — never runs — the
   exact anchor command and the numbered human steps.

The script is node-core plus spawned `vh` CLIs. It never dials any endpoint, never anchors, never
reads the key's value itself (only the env var **name** is passed to the CLIs' read-used-discarded
key path), and never persists key material.

## The boundary — what each artifact proves, exactly

- **The seal proves WHAT and (signed) WHO — never WHEN.** The evidence seal's Merkle root commits
  to the exact `(relPath, content)` pairs in the payload: the tarball bytes and the identity
  statement. The signed container adds a detached EIP-191 signature, so a verifier can recover
  **which key** vouched for those bytes. Neither artifact proves *when* anything happened —
  "sealed at T" rides the human-owned trust root (STRATEGY.md P-3), exactly as the in-band trust
  note says.
- **A later anchor proves existence no-later-than block time.** Anchoring the unsigned seal's root
  in the ContributionRegistry binds it to a block whose timestamp **upper-bounds** the packet's
  existence: it existed no later than that block. It does not prove authorship, and a default
  (non-`--author-bound`) record names the first broadcaster, not necessarily the author.
- **The identity statement is SELF-asserted.** `IDENTITY.json` is the vendor address talking about
  itself. Sealing and signing it makes the claim tamper-evident — it does not make it true to an
  outsider. **Pinning is only real once the address is published on an authoritative channel**
  (README / verifyhash.com) that buyers already trust for other reasons; until then, any key could
  have produced an identical self-signed packet.
- **The digests are of THIS locally packed tarball — never asserted equal to the npm registry's.**
  The script packs the local tree and says so. Whether the published artifact on npm has the same
  bytes is a **network question the script refuses to answer**; confirming it is human step 1
  below, and the identity statement carries the same scope language in-band.

## The human steps (the script prints these; it performs none of them)

1. **Confirm the local tarball vs the published artifact** (network, human-only):
   `npm view verifyhash dist.integrity` and compare against the run's printed sha512-SRI. On a
   mismatch, re-pack from the **published tag** (check it out, re-run the builder) — the script
   never claims registry equality.
2. **Re-run with the real vendor key** (`--key-env <REAL_VENDOR_KEY_ENV>`). Rehearsals use a
   throwaway key; the packet that gets published must be signed by the key the vendor actually
   controls.
3. **Anchor the UNSIGNED seal** with the printed command (mainnet write; gas is the caller's own):

   ```
   vh anchor-artifact <out>/vendor-provenance.vhevidence.json \
     --contract 0x77d8eF881D5aeEda64788968D13f9146fE1A609B \
     --rpc https://polygon-bor-rpc.publicnode.com \
     --key-env <REAL_VENDOR_KEY_ENV> \
     --out <out>/vendor-provenance.anchored-receipt.json \
     --i-understand-mainnet
   ```

4. **Publish the vendor address + the SIGNED packet** on an authoritative channel (README /
   verifyhash.com). This is the step that turns a self-asserted identity into a pinned one.

## Verifying the packet (anyone, offline)

```
vh evidence verify vendor-provenance.vhevidence.json --dir payload
vh evidence verify-signed vendor-provenance.signed.vhevidence.json --dir payload --signer <published-vendor-address>
```

After anchoring: `vh verify-anchored <receipt> vendor-provenance.vhevidence.json` (offline), or add
`--rpc`/`--contract` to re-check the chain facts against the live registry.

Tested end-to-end in `test/vendor-provenance.test.js` with an ephemeral throwaway key — including
executing the emitted anchor command against an unreachable loopback RPC to prove the copy-paste
survives flag parsing and closed-table validation, failing only at the network.
