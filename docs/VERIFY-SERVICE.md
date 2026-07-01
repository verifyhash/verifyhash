# verifyhash verify-service — the drop-in HTTP verify endpoint (`vh serve-verify`)

`vh serve-verify` stands the **verify** half of verifyhash up as a tiny, dependency-free HTTP service so a
CI pipeline or another microservice can **POST a seal and get an ACCEPT/REJECT** — the *"CI plugin that
imports rather than shells out"*. It is a **drop-in dependency**: boot it once, POST many seals, read the
JSON verdict, gate your build on the HTTP status. It reuses the **exact same** verify cores the `vh` CLI and
the `require("verifyhash")` SDK run (`verifySeal` / `verifySignedSeal`) — no fork, no second implementation.

This file is the **canonical reference** for the service's request schema, response fields, status mapping,
and trust boundary. It is **machine-checked**: `test/verify-service.example.test.js` byte-matches the request
`kind`s and response fields documented here against the live `cli/serve-verify.js › verifyRequest` core, so
this doc **cannot silently drift** from the code.

> **Booting it (a human deploy step).** The loop only BUILDS + locally TESTS. Exposing this service publicly
> (behind *your* nginx/Cloudflare, on *your* domain, with TLS) is an explicit **human** deploy step — see
> **STRATEGY.md P-9**. By default it binds **loopback** (`127.0.0.1`) and is never auto-deployed.

---

## Boot the service

```bash
vh serve-verify [--port <n>] [--host <h>] [--max-body <bytes>]
# default: 127.0.0.1:4180 — loopback only, verify-only, Node-core http (ZERO new dependency)
```

- `POST /verify`  → a JSON verdict on a CI-mappable status.
- `GET  /healthz` → `{ ok: true, ... }` (a liveness/readiness probe; holds no key, touches nothing).

The server is **verify-only**: it never signs, holds **no** private key, and writes **no** file.

---

## Request schema

Every request is a single JSON object with a `kind` field that selects one of the two verify paths. The
schema envelope version is **`vh.verify-request/1`** (the `schema` field of every response, below).

### `kind: "verify-seal"` — UNSIGNED tamper-evidence

```json
{
  "kind": "verify-seal",
  "seal": { "...": "a seal object OR its serialized JSON string" },
  "entries": [
    { "relPath": "dist/app.js", "content": "<encoded bytes>", "encoding": "base64" }
  ]
}
```

- `seal` — a seal **object** *or* its serialized JSON **string** (both accepted; strictly validated first).
- `entries[]` — the bytes to re-verify against the seal, each `{ relPath, content, encoding }` where
  `encoding` is one of **`utf8`**, **`base64`**, or **`hex`** (default `utf8`). The service **re-derives**
  the Merkle root from *these* bytes — never the seal's own stored hashes — so a one-byte tamper flips
  `ACCEPTED` → `REJECTED`.

### `kind: "verify-signed-seal"` — SIGNED / vendor-address-pinned

```json
{
  "kind": "verify-signed-seal",
  "container": { "...": "a signed-seal container OR its JSON string" },
  "expectedSigner": "0x<20-byte address>",
  "entries": [
    { "relPath": "dist/app.js", "content": "<encoded bytes>", "encoding": "base64" }
  ]
}
```

- `container` — a signed-seal **object** *or* its JSON **string** (strictly validated first).
- `expectedSigner` *(optional)* — a `0x` address the recovered signer must equal (the vendor **pin**). A
  genuine signature that recovers to a *different* address is a **REJECTED**, not an error.
- `entries[]` *(optional)* — when supplied, the canonical seal bytes are recomputed from these entries and
  required byte-identical to the signed payload (a set that does not match is a clean **REJECTED**).

---

## Response schema

### OK response (the request was evaluated)

```json
{
  "schema": "vh.verify-request/1",
  "service": "vh-serve-verify",
  "verdict": "ACCEPTED",
  "kind": "verify-seal",
  "detail": { "verdict": "ACCEPTED", "accepted": true, "...": "the core verdict, fields unchanged" }
}
```

- `schema` — the envelope version, always **`vh.verify-request/1`**.
- `service` — always **`vh-serve-verify`**.
- `verdict` — the top-level answer: **`ACCEPTED`** or **`REJECTED`** (copied verbatim from `detail.verdict`,
  never re-derived).
- `kind` — the request kind that was dispatched.
- `detail` — the **unchanged** core verdict from `verifySeal` / `verifySignedSeal`. Its fields are the same
  contract the CLI and SDK already ship (e.g. `accepted`, `rootMatches`, `counts`, `changed` for a seal;
  `recoveredSigner`, `checks`, `failedChecks` for a signed container).

### ERROR response (the request could **not** be evaluated)

```json
{
  "schema": "vh.verify-request/1",
  "service": "vh-serve-verify",
  "verdict": "ERROR",
  "code": "ERR_UNKNOWN_KIND",
  "message": "a human-readable, non-sensitive reason"
}
```

An `ERROR` is **fail-closed**: a malformed / oversized / unknown request is **never** a silent `ACCEPTED`.
`verdict` is **`ERROR`**, `code` is a stable machine-readable string, and `message` is a human reason. The
stable error `code`s are: `ERR_BODY_NOT_OBJECT`, `ERR_BODY_TOO_LARGE`, `ERR_UNKNOWN_KIND`,
`ERR_MISSING_SEAL`, `ERR_BAD_SEAL`, `ERR_BAD_ENTRIES`, `ERR_MISSING_CONTAINER`, `ERR_BAD_CONTAINER`,
`ERR_BAD_EXPECTED_SIGNER`, `ERR_INTERNAL`.

---

## Status mapping (CI-mappable — gate on the code alone)

| Verdict / condition                          | HTTP status | Meaning for a CI gate                          |
| -------------------------------------------- | ----------- | ---------------------------------------------- |
| `ACCEPTED`                                   | **200**     | the seal/container verified → **pass**         |
| `REJECTED`                                   | **422**     | well-formed request that did NOT verify → fail |
| `ERROR` (malformed / unknown request)        | **400**     | the request itself is bad → fail               |
| body over `--max-body`                       | **413**     | payload too large → fail                       |
| wrong path / wrong method                    | **404/405** | routing error → fail                           |

A build should gate on **HTTP 200** exactly: anything else is a non-pass. The shipped
[`verifier/ci/verify-service.generic.sh`](../verifier/ci/verify-service.generic.sh) and
[`verifier/ci/verify-service.github-actions.yml`](../verifier/ci/verify-service.github-actions.yml) do
exactly this (curl POST → map the HTTP status to a non-zero exit on anything but 200).

---

## Trust boundary (the service will not let you overclaim)

A **200 ACCEPTED** for a seal means **tamper-evidence**: *these exact bytes re-derive the sealed Merkle
root.* A valid **signature** (`verify-signed-seal`) additionally proves **who vouched** — the holder of the
pinned address's key — for those bytes. Neither of these:

- is a **trusted timestamp** ("sealed / signed since date *T*") — that rides the **human-owned** signing /
  timestamp / anchor trust-root (`needs-human`; **STRATEGY.md P-3**);
- is a **legal opinion**.

The service is **verify-only**: it never signs, holds **no** private key, and writes **no** file. It binds
**loopback** (`127.0.0.1`) by default; exposing it publicly is a **human** deploy step (your nginx /
Cloudflare / domain / TLS) — **never** auto-deployed. See [`docs/TRUST-BOUNDARIES.md`](./TRUST-BOUNDARIES.md).

---

## Drop it into your pipeline

- **Any shell CI** (GitLab, CircleCI, Jenkins, Makefile): boot the service, then run
  [`verifier/ci/verify-service.generic.sh`](../verifier/ci/verify-service.generic.sh) with
  `VH_VERIFY_URL` + `VH_REQUEST` (the path to a prepared request-body JSON).
- **GitHub Actions**: copy
  [`verifier/ci/verify-service.github-actions.yml`](../verifier/ci/verify-service.github-actions.yml) — it
  boots `vh serve-verify`, builds a request body with the SDK, POSTs it, and fails the job on anything but
  200.
- **A tiny dependency-free client**: [`examples/verify-service-client.js`](../examples/verify-service-client.js)
  boots the service, POSTs a clean seal (ACCEPT) then a tampered one (REJECT), and exits 0 — copy it as your
  in-process integration. It imports **only** `require("verifyhash")`, the `vh` command, and Node built-ins.

This doc, the example, and the CI scripts are all test-gated by `test/verify-service.example.test.js` on
every `npx hardhat test`, so they can never silently rot.
