# VerifyHash challenge — try to fool the verifier (60 seconds, zero install)

You were handed a **sealed packet**: a folder of files (`sample-packet/`) plus a tiny
JSON **seal** (`seal.vhevidence.json`) that commits to the exact bytes of every file in it.

The claim we want you to *test*, not trust:

> Change **one byte** anywhere in the packet and an independent, offline verifier will
> **reject** it and tell you **which file** you changed — without ever trusting the
> seal's own stored hashes.

No `npm install`. No build. No account. No network. You need only **`node` (>= 18)** on your PATH.

---

## 1. Verify the packet as-is (it should PASS)

```sh
./run.sh
```

Expected: `RESULT: VERIFIED (exit 0).` The verifier re-derived the keccak Merkle root from
the bytes on disk and it matched the sealed root.

(Equivalent direct call, if you prefer:)

```sh
node ../verifier/dist/verify-vh-standalone.js seal.vhevidence.json --dir sample-packet
echo "exit: $?"   # 0 = verified
```

---

## 2. Tamper ONE byte (now it should FAIL — and point at you)

Open **`sample-packet/ledger.csv`** and change a single character — flip a `0` to a `1`
in any amount, add a stray space, anything at all. Save it. Then:

```sh
./run.sh
```

Expected: `RESULT: REJECTED (exit 3).` and a line like:

```
CHANGED    ledger.csv: sealed 0x... != on-disk 0x...
```

The verifier **localized** the tamper to the exact file. Try it on `README.txt` or
`manifest.json` instead — same result, different filename.

What this offline verifier checks, precisely — it verifies **exactly what the seal
references**, the named `(path, content)` set:

- **Edit any byte** in a referenced file → `CHANGED` (exit 3), and you're told which file.
- **Rename or delete** a referenced file → `MISSING` (exit 3): the seal still expects that
  path, and the bytes are no longer there under it.
- **Dropping an unreferenced extra file** next to the packet (e.g. `sample-packet/extra.txt`)
  is **not** flagged by this standalone verifier — it checks the files the seal *names*, and
  an unnamed file is simply not one of them, so the verdict stays `VERIFIED` (exit 0). (The
  full producer tool, `vh evidence verify`, additionally re-walks the directory and reports
  such extras as `UNEXPECTED`; the zero-install verifier deliberately does less — it trusts
  no directory listing, only the seal's own named set.)

So the seal commits to the bytes of every file it names — change, rename, or remove any one
and it's caught — but it does not, by itself, forbid extra unnamed files sitting beside the
packet.

---

## 3. Put it back (re-verify)

```sh
git checkout challenge/sample-packet      # if you cloned the repo
# ...or just undo your one-byte edit by hand, then:
./run.sh                                   # VERIFIED again (exit 0)
```

---

## Why this is hard to fake

- The verifier (`verifier/dist/verify-vh-standalone.js`) is **one self-contained file**,
  zero third-party dependencies, **read-only**, and opens **no network**. You can read it
  in one sitting.
- It **re-derives** the keccak256 Merkle root from the bytes *you* hold — it does **not**
  trust the hashes stored inside the seal. So you cannot make a tampered packet pass by
  editing the seal too: change the bytes and the recomputed root simply won't match.
- Exit codes are a stable contract: **0** verified · **3** rejected (tamper found) ·
  **2** usage · **1** IO.

This is the free tier. Sealing **your own** folders (also zero-install) uses
`verifier/dist/seal-vh-standalone.js`; signed attestations and unlimited file counts are
the paid surface (`vh evidence seal`). Same verifier, same offline guarantee.
