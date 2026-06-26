# The 60-second challenge — verify a real sealed packet, then try to fool it

> **Audience: a cold prospect who owes us nothing.** No account. No `npm install`. No repo build.
> No key. No network. No sales call. You need only **`node` (>= 18)** on your PATH. This folder is the
> **zero-install, zero-trust entry point** to verifyhash: in under a minute you VERIFY a real, pre-sealed
> packet on your own machine, then TAMPER one byte and watch an independent, offline verifier REJECT it
> and name the file you changed — **trusting no server, no producer software, and not us.**

The whole pitch is one testable claim. Don't trust it — *test* it:

> Change **one byte** anywhere in the packet and an independent, offline verifier will **reject** it and
> tell you **which file** you changed — without ever trusting the seal's own stored hashes.

If that holds on *your* machine, against a verifier you can read in one sitting, you have all the
evidence you need that the seal is real. That is the point of starting here.

---

## What's in this folder

| file | what it is |
|------|------------|
| `sample-packet/` | a tiny real packet: `README.txt`, `ledger.csv`, `manifest.json` |
| `seal.vhevidence.json` | the **seal** — a small JSON that commits to the exact bytes of every file in the packet |
| `run.sh` | the one command you run (it drives the committed standalone verifier) |
| `TAMPER-ME.md` | the step-by-step tamper walkthrough |

The verifier itself is **not** in this folder — `run.sh` *references* the committed, single-file,
zero-dependency standalone verifier at [`../verifier/dist/verify-vh-standalone.js`](../verifier/dist/verify-vh-standalone.js).
Nothing here forks its logic; you run the same audited file documented for every counterparty.

---

## Do it now (three commands)

```sh
# 1. VERIFY the packet as shipped — it should PASS (exit 0).
./run.sh

# 2. TAMPER one byte: edit any character in sample-packet/ledger.csv, save, then:
./run.sh                 # now REJECTED (exit 3) — and it NAMES ledger.csv

# 3. PUT IT BACK and re-verify.
git checkout sample-packet   # or undo your one-byte edit by hand
./run.sh                     # VERIFIED again (exit 0)
```

The verifier **re-derives** the keccak-256 Merkle root from the bytes *you* hold and compares it to the
sealed root. It does **not** trust the hashes stored inside the seal, so you cannot make a tampered packet
pass by editing the seal too — change the bytes and the recomputed root simply won't match. The exact
walkthrough, the structural cases (rename → `MISSING`, delete → `MISSING`, an unreferenced extra file is
**not** flagged because the verifier checks only the seal's named `(path, content)` set), and the stable
exit-code contract (**0** verified · **3** rejected · **2** usage · **1** IO) are in
[`TAMPER-ME.md`](TAMPER-ME.md).

---

## What this proves — and what it does NOT (read before you rely on it)

Be precise about what a green verdict buys you. Whether you run the one-file bundle or the split tree,
the seal proves **tamper-evidence + signer-pin**, NOT a trusted "sealed at T" (that still requires
**P-3** — see [`../docs/INDEPENDENT-VERIFICATION.md`](../docs/INDEPENDENT-VERIFICATION.md) §3).

Two honest narrowings apply to **this challenge specifically**, because it is the **FREE, UNSIGNED**
path:

- **The sample seal is UNSIGNED, so there is no signer to pin here.** The challenge proves the
  **tamper-evidence + offline-recompute** half — *these are exactly those files, independently
  re-derivable by anyone*. The **signer-pin** half (an EIP-191 signature you check with `--vendor`) is
  the PAID upgrade — see the funnel below.
- **It is NOT a trusted "sealed at T."** A seal says *these are the bytes*, not *when*. An independent
  time anchor rides the human-owned signing/timestamp trust-root (proposal **P-3** in
  [`../STRATEGY.md`](../STRATEGY.md)), and a green verdict is **not** a legal or accounting opinion.

This is the same trust boundary every verifyhash seal carries — stated once, verbatim, so the cold-start
demo never over-promises.

---

## From the free challenge to the paid product (the funnel)

This challenge is the **free verify** end. There is a matching **free produce** end, and a **paid**
upgrade — all on the *same* verifier, *same* offline guarantee:

1. **Free verify** (you just did it): `node ../verifier/dist/verify-vh-standalone.js <seal> --dir <pkt>`
   — anyone may verify any seal forever, offline, at zero cost.
2. **Free produce** (the round-trip): seal up to **25** of your *own* files with the matching single-file
   sealer [`../verifier/dist/seal-vh-standalone.js`](../verifier/dist/seal-vh-standalone.js) — no
   install, no key, no account — hand the `.vhevidence.json` to a counterparty, and they verify it with
   step 1. Its bytes are byte-for-byte identical to the producer tool's seal over the same folder, so a
   free seal is the **same** artifact the paid tool wraps — not a toy.
3. **Paid produce** (the upgrade): **SIGNING** (an EIP-191 signer-pin a recipient checks with `--vendor`)
   and **UNLIMITED** sealing are the paid surface — `vh evidence seal --sign` / the `evidence_unlimited`
   entitlement (`--license`), through the full producer CLI. The free loop is the funnel; the paid
   upgrade adds *who signed it* and *no file cap*.

The deeper specification of the verifier you just ran — the exact bytes verified, the
no-network/no-back-edge posture, and how its independence is proven mechanically — is in
[`../docs/INDEPENDENT-VERIFICATION.md`](../docs/INDEPENDENT-VERIFICATION.md); the counterparty quickstart
is [`../verifier/README.md`](../verifier/README.md).
