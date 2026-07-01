#!/usr/bin/env node
"use strict";

// examples/verify-service-client.js — a runnable, DEPENDENCY-FREE CLIENT that treats the `vh serve-verify`
// HTTP endpoint as a DROP-IN dependency (T-59.3).
//
// THE POINT
//   The `vh serve-verify` service (T-59.2) is the "CI plugin that IMPORTS rather than shells out" — a CI
//   pipeline or another microservice POSTs a seal to a booted verifier and gets a signed-JSON ACCEPT/REJECT
//   over HTTP, without ever calling the `vh` binary per-artifact. This file is the smallest honest CLIENT of
//   that endpoint: it boots the service, POSTs a CLEAN seal (200 ACCEPTED), POSTs a ONE-BYTE-TAMPERED seal
//   (422 REJECTED), prints an `ACCEPT` then a `REJECT`, tears the server down, and exits 0. A CI system can
//   copy this ~120 lines to gate a build on "did the verify service ACCEPT our sealed artifact?".
//
// WHAT IT IMPORTS (asserted by test/verify-service.example.test.js — a grep proves this is the WHOLE list)
//   * `require("verifyhash")`  — the SINGLE public entrypoint (index.js, via package "exports"). Used to
//                                BUILD + serialize the seal payload the client POSTs. No deep `cli/…` reach-in.
//   * the `vh serve-verify` COMMAND — spawned as a child process via the package's own declared `bin.vh`
//                                path (read from verifyhash's package.json — NOT a hard-coded `cli/…` path).
//                                This is "the command", not a module import: the client shells out ONCE to
//                                BOOT the service, then talks to it purely over HTTP.
//   * Node built-ins ONLY (`http`, `child_process`, `path`) — NO third-party dependency, NO `ethers`, and
//                                nothing that is not shipped with Node itself.
//   There is NO other require: not a deep `cli/…` internal, not a non-core npm package. The client depends
//   on the PUBLIC package + the PUBLIC command + Node — exactly what an external CI integrator has.
//
// TRUST BOUNDARY (the client will not let you overclaim)
//   A 200 ACCEPTED means "these exact bytes re-derive the sealed Merkle root" (tamper-evidence). It is NOT a
//   trusted timestamp and NOT a legal opinion (STRATEGY.md P-3; docs/VERIFY-SERVICE.md). The service is
//   VERIFY-ONLY: it never signs, holds no key, writes nothing, and binds loopback (127.0.0.1) by default.
//
// RUN IT
//   node examples/verify-service-client.js     # prints an ACCEPT then a REJECT, exits 0
//
// It is test-gated by test/verify-service.example.test.js on every `npx hardhat test`, so it can never rot.

// The public package entrypoint — resolved BY NAME through package.json "exports" (Node's self-reference
// makes this identical to what an npm installer sees). We use it ONLY to BUILD + serialize the seal payload.
const vh = require("verifyhash");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

// Resolve the `vh serve-verify` COMMAND from the package's OWN declared `bin.vh`, not a hard-coded cli/ path.
// require.resolve("verifyhash/package.json") is allowed by the "exports" map; from it we read the bin entry
// the package itself declares. So the client boots exactly the command an installer would put on the PATH.
function resolveVhBin() {
  const pkgPath = require.resolve("verifyhash/package.json");
  const pkg = require(pkgPath);
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin && pkg.bin.vh;
  if (!binRel) throw new Error("verifyhash package.json does not declare a `vh` bin");
  return path.join(path.dirname(pkgPath), binRel);
}

// A tiny, in-memory { relPath, bytes } file set — the shape buildSeal accepts. No disk, no directory: a CI
// client seals bytes it already holds (a build artifact, an upload) and asks the service to verify them.
const ENTRIES = [
  { relPath: "dist/app.js", bytes: Buffer.from("console.log('build 1');\n") },
  { relPath: "dist/app.css", bytes: Buffer.from("body{margin:0}\n") },
  { relPath: "README.md", bytes: Buffer.from("# release\n") },
];

// Encode an in-memory entry list into the service's transport shape: { relPath, content, encoding }. base64
// is used so ANY bytes round-trip through JSON unharmed (the service re-derives the root from these bytes).
function toWireEntries(entries) {
  return entries.map((e) => ({
    relPath: e.relPath,
    content: Buffer.from(e.bytes).toString("base64"),
    encoding: "base64",
  }));
}

// Boot `vh serve-verify --port 0 --host 127.0.0.1` (ephemeral loopback port) as a child process and parse
// the real bound port out of its startup banner ("listening on http://127.0.0.1:<port>/"). Resolves once the
// server announces it is listening. The child is returned so the caller can kill it on exit.
function bootService() {
  return new Promise((resolve, reject) => {
    const bin = resolveVhBin();
    const child = spawn("node", [bin, "serve-verify", "--port", "0", "--host", "127.0.0.1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let banner = "";
    let settled = false;
    const onData = (chunk) => {
      banner += chunk.toString("utf8");
      const m = banner.match(/listening on http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m && !settled) {
        settled = true;
        resolve({ child, port: Number(m[1]) });
      }
    };
    child.stdout.on("data", onData);
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`vh serve-verify exited before listening (code ${code}); output:\n${banner}`));
      }
    });
  });
}

// POST a request body to the verify service and resolve { status, json }. Pure Node `http` — no fetch, no
// third-party client. A CI integrator drops exactly this into their pipeline.
function postVerify(port, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/verify",
        headers: { "content-type": "application/json", "content-length": payload.length },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch (_) {
            /* leave null so the caller fails loudly */
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

// The demo. Returns a structured result so a test can assert on DATA, not only stdout.
async function runExample(out = console.log) {
  const log = (line = "") => out(line);

  log("verifyhash verify-service client — boot the endpoint, POST a CLEAN seal, POST a TAMPERED seal.");
  log(`using verifyhash public API v${vh.apiVersion} (require("verifyhash") + the vh command + Node http).`);
  log("");
  log("TRUST NOTE: a 200 ACCEPTED means these exact bytes re-derive the sealed root (tamper-evidence);");
  log("it is NOT a trusted timestamp and NOT a legal opinion. The service is verify-only (P-3).");
  log("");

  // Build + serialize the seal the client will ask the service to verify. This is the PUBLIC SDK path.
  const seal = vh.buildSeal(ENTRIES);
  const sealJson = vh.serializeSeal(seal);
  log(`[build] sealed ${seal.fileCount} files; Merkle root = ${seal.root}`);

  const { child, port } = await bootService();
  log(`[boot ] vh serve-verify is listening on http://127.0.0.1:${port}/ (ephemeral, loopback-only).`);

  let acceptStatus, acceptVerdict, rejectStatus, rejectVerdict;
  try {
    // --- (1) CLEAN seal + the ORIGINAL bytes -> 200 ACCEPTED. -----------------------------------------
    const cleanReq = {
      kind: "verify-seal",
      seal: sealJson,
      entries: toWireEntries(ENTRIES),
    };
    const clean = await postVerify(port, cleanReq);
    acceptStatus = clean.status;
    acceptVerdict = clean.json && clean.json.verdict;
    log(`[POST ] clean seal + original bytes -> HTTP ${acceptStatus} ${acceptVerdict}`);
    if (acceptStatus !== 200 || acceptVerdict !== "ACCEPTED") {
      throw new Error(`expected 200 ACCEPTED for the clean seal, got ${acceptStatus} ${acceptVerdict}`);
    }
    log("ACCEPT: the verify service confirmed the sealed bytes match — a CI gate PASSES here.");

    // --- (2) SAME seal, but ONE byte of ONE file flipped -> 422 REJECTED. -----------------------------
    // Flip "build 1" -> "build 2" in dist/app.js. Every other file is byte-identical. The service
    // RE-DERIVES the root from these bytes, so the one-byte tamper flips ACCEPTED -> REJECTED.
    const tampered = ENTRIES.map((e) =>
      e.relPath === "dist/app.js" ? { relPath: e.relPath, bytes: Buffer.from("console.log('build 2');\n") } : e
    );
    const tamperedReq = {
      kind: "verify-seal",
      seal: sealJson, // the SAME seal — only the supplied bytes changed
      entries: toWireEntries(tampered),
    };
    const bad = await postVerify(port, tamperedReq);
    rejectStatus = bad.status;
    rejectVerdict = bad.json && bad.json.verdict;
    log(`[POST ] same seal + one byte flipped -> HTTP ${rejectStatus} ${rejectVerdict}`);
    if (rejectStatus !== 422 || rejectVerdict !== "REJECTED") {
      throw new Error(`expected 422 REJECTED for the tampered bytes, got ${rejectStatus} ${rejectVerdict}`);
    }
    // Surface the localized change the REJECT verdict is built from (which relPath the service flagged).
    const changed = bad.json && bad.json.detail && bad.json.detail.changed;
    if (Array.isArray(changed)) {
      for (const c of changed) log(`         CHANGED ${c.relPath}`);
    }
    log("REJECT: the verify service caught the tamper — a CI gate FAILS the build here.");
  } finally {
    // ALWAYS tear the service down (pass or fail) so no socket leaks past the client's run.
    child.kill("SIGTERM");
  }

  log("");
  log("RESULT: PASS — booted vh serve-verify, ACCEPT (clean seal, 200) then REJECT (one-byte tamper, 422).");

  return {
    apiVersion: vh.apiVersion,
    root: seal.root,
    fileCount: seal.fileCount,
    acceptStatus,
    acceptVerdict,
    rejectStatus,
    rejectVerdict,
  };
}

// Run when invoked directly (`node examples/verify-service-client.js`); export for the test harness.
if (require.main === module) {
  runExample()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`verify-service-client example FAILED: ${err && err.message ? err.message : err}`);
      process.exit(1);
    });
}

module.exports = { runExample, ENTRIES, toWireEntries };
