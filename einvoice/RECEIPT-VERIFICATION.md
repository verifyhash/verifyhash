# Verifying a conformance receipt (recompute-and-compare)

A conformance receipt is the small JSON document `einvoice receipt <invoice.xml>`
emits — see [`einvoice/receipt.py`](einvoice/receipt.py) for how it is built. Its
tamper-evidence is not a signature: the integrity check IS a
recompute-and-compare of the receipt body's SHA-256.

There are two ways to run that check, and they check the **same** thing:

- **One command, if you have the tool** — `einvoice receipt --verify
  <receipt.json>` re-hashes the receipt body with the exact canonicalizer that
  produced it and compares to the stored `content_sha256`. See
  [The one-command check](#the-one-command-check-einvoice-receipt---verify) below.
- **Zero-trust, in any language** — because the check is just SHA-256 over a
  canonical JSON body, any consumer can reproduce it with only a SHA-256
  implementation and a JSON canonicalizer, without installing einvoice or
  trusting whoever produced the receipt. See [The check](#the-check) below.

## The document

```json
{"content_sha256":"<hex>","receipt":{ ...body... }}
```

The `receipt` object (the "body") carries `format`, `tool` (`name` + `version`),
`profile`, `well_formed`, `verdict`, `input_sha256`, `failed_fatal_rules`, and —
only when a caller passed one — `issued_at`. `content_sha256` is the lowercase
hex SHA-256 of the **canonical** body:

```
canonical_json(body) = json.dumps(body, sort_keys=True, separators=(",", ":"))
```

i.e. keys sorted, no insignificant whitespace, UTF-8 encoded. The canonical form
is what makes the receipt byte-stable and independently reproducible.

## The one-command check (`einvoice receipt --verify`)

If you have the tool installed, the whole check is one command:

```
$ einvoice receipt --verify receipt.json
VERIFIED: receipt.json
  content_sha256 = 6459697e0a75de9454eeac449a0c79f5a172945470fa6e1db4dbf49e6699b391
$ echo $?
0
```

It reads the receipt document, re-hashes the canonical body with the **exact
same** `canonical_json` + `_sha256_hex` that `einvoice receipt` used to build it
(one canonicalizer, no drift), and compares to the stored `content_sha256`. It
validates nothing and touches no verdict — it only re-hashes bytes already in
the receipt.

Exit codes (all from the existing [EXIT-CODES.md](EXIT-CODES.md) taxonomy — no
new code is minted):

| Outcome | stdout | Exit |
|---------|--------|------|
| Hash matches — **VERIFIED** | `VERIFIED: <path>` + the `content_sha256` | `0` |
| Hash mismatch — **TAMPERED** (a body field was altered, or `content_sha256` itself corrupted) | `TAMPERED: <path>` + the recomputed vs stored hash | `1` |
| Not a readable receipt — non-JSON / garbage / truncated file, valid JSON that is not a receipt (missing `receipt` / `content_sha256`), or a nonexistent / unreadable path | `error: …` on **stderr**, no traceback | `2` |

A `TAMPERED` result on stdout prints both the recomputed and the stored hash, so
you can see exactly which side moved:

```
$ einvoice receipt --verify tampered.json
TAMPERED: tampered.json
  recomputed = 1f78c76d6f9c29c2499e742f86967ddf4e925249bc4acb7e5ab4bd9c967c5e9c
  stored     = 6459697e0a75de9454eeac449a0c79f5a172945470fa6e1db4dbf49e6699b391
$ echo $?
1
```

`--verify` is valid only for the `receipt` subcommand; passing it to `validate`
is a usage error (exit `2`). This path is pinned end-to-end by
[`test_receipt_verify.py`](test_receipt_verify.py), which drives the real CLI
against a clean receipt, every tamper class below, and each malformed-file case.

**Its honest limit is exactly the recompute-and-compare limit** described under
[What it catches](#what-it-catches--and-its-honest-limit): a single
self-contained document cannot detect a *coordinated* body-and-hash rewrite. The
one-command check is a convenience over the manual recipe, not a stronger
guarantee — for a zero-trust check that does not run our binary, use the recipe
below.

## Verify a supplied receipt in CI

A common shape: a party hands you a conformance receipt alongside an invoice —
a supplier, a customer, an upstream service — and you want your pipeline to
**fail the build** if that receipt has been altered in transit or at rest. That
is one command, safe to drop into any CI step:

```
einvoice receipt --verify receipt.json
```

Exit status is the whole contract, straight from the
[EXIT-CODES.md](EXIT-CODES.md) taxonomy — nothing to parse for the pass/fail
decision:

- `0` — **VERIFIED**: the receipt body re-hashes to its stored `content_sha256`.
- `1` — **TAMPERED**: a body field was altered (or `content_sha256` itself was
  corrupted); the recomputed and stored hashes are both printed so you can see
  which side moved.
- `2` — **unreadable / not a receipt**: non-JSON, truncated, a JSON document
  missing `receipt` / `content_sha256`, or a path that does not exist. This is a
  *usage* failure, distinct from a tamper.

Because the check is pure exit-code, a shell gate needs no branching — `einvoice
receipt --verify receipt.json` on its own line fails the step on exit 1 or 2. If
you want to branch on the outcome programmatically (e.g. treat "unreadable"
differently from "tampered"), add `--json` and read `verdict` /
`match` from the single sorted-keys object it prints on stdout:

```
$ einvoice receipt --verify --json receipt.json
{"content_sha256":"…","match":true,"recomputed":"…","stored":"…","verdict":"VERIFIED"}
```

Honest limit: this proves the receipt is *internally* consistent — its body
matches its own stored hash. It does **not** prove the receipt is the one the
issuer really produced; a party who rewrote the body *and* recomputed
`content_sha256` over the forgery passes this check. To defend against that,
anchor `content_sha256` against an independently held value, or re-run
validation on the original input bytes yourself — see
[What it catches — and its honest limit](#what-it-catches--and-its-honest-limit).
And if you would rather not run our binary at all in CI, the
[zero-trust recompute-and-compare](#the-check) below is the same check in ~4
lines of any language's standard library.

## The check

Prefer not to run our binary — or working in another language? The check is
small enough to reproduce anywhere, and this is the **zero-trust alternative**
for consumers who won't (or can't) install einvoice:

```
recompute = sha256( canonical_json(doc["receipt"]) ).hexdigest()
intact    = (recompute == doc["content_sha256"])
```

That is the whole verification. Worked example in Python (standard library only,
no einvoice install needed):

```python
import hashlib, json
doc = json.load(open("receipt.json"))
canon = json.dumps(doc["receipt"], sort_keys=True, separators=(",", ":"))
recompute = hashlib.sha256(canon.encode("utf-8")).hexdigest()
assert recompute == doc["content_sha256"], "receipt body has been tampered with"
```

Any language works: canonicalize the body with sorted keys and compact
separators, SHA-256 it, compare to the stored `content_sha256`.

## What it catches — and its honest limit

`content_sha256` is a digest of the **body only**; the outer field is **not part
of its own hashed pre-image**, so it does not self-cover. Despite that:

- Mutating **any** body field (flip `verdict`, edit `input_sha256`, drop or
  alter an entry in `failed_fatal_rules`, change `tool.version` / `tool.name` /
  `profile` / `format`, flip `well_formed`, add / remove / alter `issued_at`)
  changes the canonical body, so `recompute` no longer matches — **rejected**.
- Corrupting `content_sha256` **itself** is also caught, precisely because the
  comparison target is that field: the body is untouched, so `recompute` still
  equals the receipt's true hash, which no longer equals the corrupted stored
  value — **rejected**.

The one tamper a single self-contained document cannot detect is a
**coordinated body-and-hash rewrite**: an attacker who edits the body *and*
recomputes `content_sha256` over the forged body produces an internally
consistent — but forged — receipt that recompute-verifies clean. This is the
defining property of a self-contained digest, not a defect. Closing it requires
an **external anchor**: compare `content_sha256` against an independently held /
published value, or reproduce the body yourself by re-running validation on the
original input bytes (the receipt records `input_sha256` so you can confirm you
have those exact bytes) and check the body matches.

## The `format` version marker (`/N`) and its drift guard

The body's `format` field — `einvoice-conformance-receipt/N` — is the receipt's
**structure version**, deliberately separate from `tool.version` (the validator
package version). `tool.version` moves whenever the *engine* changes; `format`
moves only when the receipt's *canonical shape* changes. The trailing integer
`N` is what a consumer keys on to know how to read an older receipt: it is a
promise that "a receipt stamped `/N` has exactly this set of fields, in these
nested positions".

That promise is only worth anything if the marker is bumped whenever the shape
actually changes. So a **canonical-structure change requires a version bump**:
if you add, remove, or rename a receipt field (top-level or nested — e.g. a new
key inside each `failed_fatal_rules` entry), you MUST increment the suffix
(`/1` → `/2`) in `RECEIPT_FORMAT` (`einvoice/receipt.py`). A value change alone
(a different hash, a different rule id, a flipped verdict) is **not** a
structural change and must **not** bump `N`.

This is enforced mechanically, not by convention.
[`test_receipt_version.py`](test_receipt_version.py) freezes the exact set of
key paths a `build_receipt` document emits, keyed by the integer parsed out of
`RECEIPT_FORMAT`. If the shape drifts without a matching bump, the marker still
claims the old `N` while the shape no longer matches it, and the test fails with
an instruction to bump `RECEIPT_FORMAT` and register the new shape. Regenerating
the golden receipts for an intentional structural change therefore cannot be
done silently — the version guard makes the bump non-optional.

Every claim above is exercised adversarially by
[`test_receipt_tamper.py`](test_receipt_tamper.py), which mutates each field and
region of a golden receipt in a table-driven loop and asserts recompute-and-
compare rejects every one, plus the coordinated-rewrite limit; the receipt's
behavioural properties (determinism, honest pass, `content_sha256 = f(body)`)
are pinned by [`test_receipt.py`](test_receipt.py) and the committed golden
receipts in [`test_golden_snapshot.py`](test_golden_snapshot.py). The binding
between the `format` version marker and the receipt's canonical shape is guarded
by [`test_receipt_version.py`](test_receipt_version.py).
