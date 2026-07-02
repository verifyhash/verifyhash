"use strict";

// trustledger/lib/policy-bundled-loader.js — the policy module's SOLE impure seam (T-65.1).
//
// WHY THIS FILE EXISTS
//   trustledger/policy.js is pure (readPolicy/validatePolicy/applyPolicy: no clock, no I/O, no hidden
//   state) EXCEPT for one convenience: loading the bundled per-state fixture policies from disk so
//   `vh trust reconcile --state <code>` can resolve a code without a file path. That filesystem code —
//   and ONLY that code — lives here, behind one clearly-named module boundary, so:
//     * the browser bundle (EPIC-65) can shim/replace THIS ONE FILE (e.g. with the fixture JSON inlined)
//       and ship policy.js's pure path byte-for-byte unchanged;
//     * a static purity scan of the browser path (test/trustledger.browser-core.test.js) can allow
//       exactly one fs-requiring module — this one — and fail if fs/http/net/etc. creep in anywhere else.
//   policy.js requires this module LAZILY (inside bundledPolicies(), never at module top level), so merely
//   loading policy.js executes no fs/path require at all.
//
// RAW I/O ONLY — NO POLICY LOGIC
//   Validation, sorting, error naming (PolicyError), and the {code,file,policy} entry shape all stay in
//   policy.js, so this module cannot drift from the schema: it reads directory names and file text from
//   the package's OWN bundled fixtures directory (never a caller path) and nothing more. Errors are thrown
//   RAW; policy.js wraps them into the same named PolicyErrors it always threw — zero behavior change.

const fs = require("fs");
const path = require("path");

// The package's own bundled fixtures directory. Same absolute path as the historical
// policy.js constant (trustledger/fixtures/policy) — this file just lives one level down.
const BUNDLED_DIR = path.join(__dirname, "..", "fixtures", "policy");

// List the bundled policy fixture FILENAMES (the "*.json" basenames, unsorted — policy.js
// sorts them so ordering stays that module's documented, deterministic concern). Throws raw.
function listBundledPolicyNames() {
  return fs.readdirSync(BUNDLED_DIR).filter((n) => n.endsWith(".json"));
}

// Read ONE bundled policy fixture by basename, returning { full, text } where `full` is the
// absolute path (policy.js reports it in each entry) and `text` is the raw UTF-8 file text
// (policy.js validates it). Throws raw.
function readBundledPolicyFile(name) {
  const full = path.join(BUNDLED_DIR, name);
  return { full, text: fs.readFileSync(full, "utf8") };
}

module.exports = { BUNDLED_DIR, listBundledPolicyNames, readBundledPolicyFile };
