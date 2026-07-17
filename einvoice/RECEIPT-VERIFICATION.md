# Verifying a conformance receipt (recompute-and-compare)

A conformance receipt is the small JSON document `einvoice receipt <invoice.xml>`
emits — see [`einvoice/receipt.py`](einvoice/receipt.py) for how it is built. Its
tamper-evidence is not a signature and there is **no `verify-receipt`
subcommand**: the integrity check IS a recompute-and-compare that any consumer
can run with only a SHA-256 implementation and a JSON canonicalizer.

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

## The check

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

Every claim above is exercised adversarially by
[`test_receipt_tamper.py`](test_receipt_tamper.py), which mutates each field and
region of a golden receipt in a table-driven loop and asserts recompute-and-
compare rejects every one, plus the coordinated-rewrite limit; the receipt's
behavioural properties (determinism, honest pass, `content_sha256 = f(body)`)
are pinned by [`test_receipt.py`](test_receipt.py) and the committed golden
receipts in [`test_golden_snapshot.py`](test_golden_snapshot.py).
