# Key lifecycle: publish → pin → verify, and revoking a key (`vh revocation`)

Every sealed/signed artifact this family mints (an evidence seal, a signed license, a dataset/parcel
attestation, an identity card) is trusted because a vendor's signing **key** backs it. A key, though, has a
lifecycle: it is generated, **published** (so recipients learn its address), used to sign for as long as it
is good, and — eventually — **rotated, retired, or compromised**. Until now there was no first-class,
offline-verifiable way for a vendor to say "this key is **revoked** as of D", so every artifact the key ever
signed kept verifying as ACCEPTED forever, and a recipient had no way to ask "was this key still good when
**this** exhibit was sealed?". The producer **KEY REVOCATION** (`vh revocation publish` / `vh revocation
verify`) closes that gap, reusing the shared attestation core verbatim — **no new crypto, no new scheme, no
new dependency**.

This doc walks the whole **publish → pin → verify** key lifecycle and states the load-bearing boundary
**verbatim**.

## The honest boundary (stated verbatim)

The honest boundary, stated verbatim (the same words STRATEGY.md pins):

> a revocation is a SIGNED CLAIM by the key-holder (it proves the key-holder SAID "revoked as of D"); it is NOT a trusted wall-clock timestamp without P-3

So `--as-of` is **recipient-chosen evidence, not an oracle**: a revocation tells you what the key-holder
*declared*, and from *when they say*. It is **NOT** a legal opinion. Anchoring "revoked at a wall-clock
instant T anyone can trust" to a real, independently-trustworthy timestamp still rides the human-owned
signing/timestamp trust-root (needs-human, **STRATEGY.md P-3**) — exactly the same boundary the identity
card, the signed seal, and the signed attestation carry.

The publish/verify paths LEAD with this caveat verbatim — the standing `REVOCATION_TRUST_NOTE` /
`SIGNED_REVOCATION_TRUST_NOTE` the core exports, so the prose here can never drift from the code:

```
This is a verifyhash producer KEY REVOCATION: the holder of `vendorAddress`'s key SIGNED it, declaring that address REVOKED as of `revokedAt` for `reason` (optionally superseded by `supersededBy`). verify RE-DERIVES the signer from these exact bytes and REQUIRES it to equal `vendorAddress` — a key revokes ITSELF; a third party cannot revoke a key it does not control. It proves the KEY-HOLDER's SIGNED CLAIM ONLY: `revokedAt` is the holder's self-asserted instant, NOT a trusted TIMESTAMP (it rides the human-owned timestamp trust-root, STRATEGY.md P-3), and this is NOT a legal opinion.
```

## The lifecycle in three moves: publish → pin → verify

1. **Publish.** A vendor generates a keypair OUTSIDE the loop and publishes a signed
   [producer identity card](IDENTITY.md) (`vh identity publish`) binding their **`vendorAddress`** to the
   bounded claim set they attest. They sign their evidence/licenses/attestations with **that same key**.
2. **Pin.** A recipient (or a cold prospect) does the address-to-vendor trust step **ONCE** — `vh identity
   verify vendor.vhidentity.json --signer <addr-you-were-given>` → ACCEPTED — and then reuses that pinned
   `vendorAddress` across every later signed handoff (`vh evidence verify-signed <p> --signer <addr>`, etc.)
   with **no new out-of-band step**.
3. **Verify (and re-check the key is still good).** When that key is compromised, rotated, retired, or
   superseded, the vendor publishes a signed **revocation** of that same `vendorAddress`. Recipients pin it
   next to the identity card and pass it to any signed-verify command via **`--revocations <f>`**
   `[--as-of <ISO>]`. An exhibit signed under a key that was **revoked-before-as-of** then downgrades from
   ACCEPTED to **REVOKED**; an exhibit signed while the key was still good keeps its ACCEPTED verdict (with
   an informational "this key is revoked *now*" note) — the precise forensic value.

The whole point: **pin once, then keep believing the same vendorAddress** across every handoff — and a
revocation is how that pinned key is honestly *retired* when its day comes.

## Commands

```
vh revocation publish --address <0xaddr> --reason <reason> (--key-env <VAR> | --key-file <path>) [--superseded-by <0xaddr>] [--revoked-at <ISO>] [--out <p>] [--json]
vh revocation verify <revocation> [--signer <0xaddr>] [--json]
```

### `vh revocation publish` — mint the revocation

`publish` MINTS a signed `*.vhrevocation.json` revocation marking `--address` **REVOKED** as of
`--revoked-at` (default now) for `--reason`, OPTIONALLY naming a `--superseded-by` successor key. It signs
with a **HUMAN-provisioned key** (EXACTLY ONE of `--key-env` / `--key-file`, **read-used-discarded** via the
shared `loadSigningWallet` — the loop **NEVER** generates, persists, or logs a key, and the key never appears
in any output).

- **The load-bearing self-control invariant — a key revokes ITSELF.** `publish` mints **ONLY** when the provisioned key's address **EQUALS** `--address`.
  A key that does **NOT** control `--address` **hard-errors (exit 2) BEFORE writing anything** (never a
  mis-minted statement) — a **third party cannot revoke a key it does not control**, otherwise anyone could
  grief a vendor by "revoking" their key.
- **`--reason`** is one of the closed set `["compromised", "retired", "rotated", "superseded"]` (an out-of-set
  reason is a usage error): a small, fixed vocabulary a recipient can reason about — `compromised`/`retired`
  make the key's past signatures suspect, `rotated`/`superseded` simply move on to a new key.
- **`--superseded-by`** (optional) names the successor key the vendor moved to; absent, the revocation
  supersedes the key with nothing.
- **Filesystem hygiene.** Default **prints the revocation + writes NOTHING**; `--out <p>` writes ONLY to the
  caller-chosen path — **never silently to cwd**.
- The output **LEADS with the trust line**; `--json` carries the PUBLIC revocation summary (vendorAddress,
  signer, reason, revokedAt, supersededBy) + the artifact — and **never the key**.
- **Exit:** **0** ok / **2** usage (missing/invalid field, key-source error, key does not control
  `--address`) / **1** IO (`--out` write).

### `vh revocation verify` — check + pin the revocation

`verify <revocation>` is the **OFFLINE / key-free / network-free** read path. It RECOVERS the signer from the
embedded canonical revocation bytes + signature and:

1. confirms the signature **backs the claimed signer** (Check 1, always);
2. confirms the recovered signer **IS the revocation's own `vendorAddress`** (the load-bearing self-control
   check, always — a key revokes ITSELF);
3. OPTIONALLY pins it to an expected `--signer` (run only when given).

It prints the **reason / revokedAt / supersededBy** + per-check PASS/FAIL, and **LEADS with the trust line**.
A **forged / tampered / wrong-key** revocation (one whose signature does not recover to its own
`vendorAddress`), or a wrong `--signer`, is a clean **REJECTED** — **never a silent pass**.

- **Exit:** **0** ACCEPTED / **3** REJECTED / **2** usage / **1** IO.

## Worked example: publish a rotation → pin → verify

```
# The vendor rotates: they mint a signed revocation of their OLD key, naming the NEW one (offline, key read-used-discarded):
$ vh revocation publish --address 0x<old-vendor> --reason rotated \
    --superseded-by 0x<new-vendor> --key-env VENDOR_OLD_KEY --out ./old.vhrevocation.json
This is a verifyhash producer KEY REVOCATION: …                                       # caveat first
published a signed key revocation for 0x<old-vendor> (signed by 0x<old-vendor>)
  reason:       rotated
  revokedAt:    2026-06-26T00:00:00.000Z
  supersededBy: 0x<new-vendor>
  written:      /abs/path/old.vhrevocation.json                                       # exit 0

# A recipient verifies the revocation itself — recover (always) + self-control (always) + pin (--signer):
$ vh revocation verify ./old.vhrevocation.json --signer 0x<old-vendor>
TRUST: This is a SIGNED verifyhash key-revocation container: …                        # caveat first
revocation:       ACCEPTED
  [PASS] signature recovers to the claimed signer
  [PASS] the recovered signer IS the revocation's vendorAddress (a key revokes ITSELF; …)
  [PASS] recovered signer matches the expected signer (0x<old-vendor>)
ACCEPTED: every requested check passed — the key-holder SIGNED this revocation of the address it controls.   # exit 0

# A THIRD-PARTY "revocation" (signed by some OTHER key) is a clean REJECTED — it can never grief a vendor:
$ vh revocation verify ./forged.vhrevocation.json
…
REJECTED: failed check(s): vendorAddressMatchesSigner.                                # exit 3
```

## Using a revocation as a recipient: `--revocations` on the verify commands

Running `vh revocation verify` **on its own** proves the revocation is **genuine** (signed by the key it
claims to revoke) — but proving a revocation is genuine is not the same as *acting* on it. To actually
downgrade an exhibit, a recipient passes the revocation to a **signed-verify** command:

```
# An evidence exhibit signed under a key that was revoked-BEFORE the as-of instant downgrades to REVOKED:
$ vh evidence verify-signed ./bundle/b.vhevidence.json --signer 0x<old-vendor> --dir ./bundle \
    --revocations ./old.vhrevocation.json --as-of 2026-07-01T00:00:00.000Z
…
revocation check (as of 2026-07-01T00:00:00.000Z):
  [REVOKED] the signing key (0x<old-vendor>) was REVOKED as of 2026-06-26T00:00:00.000Z (reason: rotated), superseded by 0x<new-vendor> — at or before the as-of instant. This artifact is NOT trustworthy as of 2026-07-01T00:00:00.000Z.
REJECTED: …                                                                            # exit 3
```

The same `--revocations <f>` / `--as-of <ISO>` flags work on `vh evidence verify-signed`,
`vh dataset verify-attest`, `vh parcel verify-attest`, and `vh identity verify`. The
[`cli/core/trust-asof.js`](../cli/core/trust-asof.js) recipient core enforces the **strongest possible
non-loosening invariant**: with **NO `--revocations` supplied, every existing verify command behaves
byte-for-byte as today** — a revocation can ONLY turn an ACCEPTED into a REVOKED, never the reverse, and a
**forged / tampered / third-party** revocation is **IGNORED with a warning**, never trusted to downgrade.

## Boundary: the independent verifier (`verify-vh`) is NOT yet revocation-aware

The `--revocations` / `--as-of` downgrade above lives **only in the producer stack** (`vh ... verify-signed`,
which depends on `ethers`). The standalone independent verifier —
[`verifier/`](../verifier/) (`verify-vh.js` + `dist/verify-vh-standalone.js`), the deliverable that lets a
counterparty recompute **without installing the producer's stack** — has **zero revocation awareness today**:
it has no `--revocations`/`--as-of` flag and does not consult revocations at all. So a key the producer has
**publicly, cryptographically revoked** still pins as a clean ACCEPTED under `verify-vh`, while the producer's
own `vh ... verify-signed --revocations <f> --as-of <T>` returns **REVOKED** on the identical inputs. A
counterparty who must account for a possibly-revoked (compromised/rotated) key therefore has to run that one
producer-stack command for now. Bringing `--revocations [--as-of]` to `verify-vh` — an offline EIP-191
recovery of the revocation plus the same non-loosening as-of comparison the producer stack uses — is a
tracked, **first-class follow-up** (STRATEGY.md, EPIC-51 verifier-parity item). This boundary is stated the
same way in [`docs/INDEPENDENT-VERIFICATION.md`](INDEPENDENT-VERIFICATION.md) §3 and
[`verifier/README.md`](../verifier/README.md) §4 so the independent-verification promise never silently
overstates its coverage.

## See also

- [`docs/IDENTITY.md`](IDENTITY.md) — the producer identity card (the **publish** + **pin** moves above).
- [`docs/EVIDENCE.md`](EVIDENCE.md) — the recipient `verify-signed … --revocations` step in context.
- [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md) — what each artifact proves and does not.
- **STRATEGY.md P-7 step 1** — where the evidence-product vendor key is generated, pinned, and (now)
  honestly retired via a revocation.
