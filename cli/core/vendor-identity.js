"use strict";

// cli/core/vendor-identity.js — the ONE committed CANONICAL VENDOR IDENTITY for the verifyhash product
// family, plus the pure resolution rule every paid entitlement gate shares (T-75.3).
//
// WHY THIS EXISTS
//   The paid surfaces (`vh evidence seal --sign` / `evidence_unlimited`, `vh agent seal --sign`, …) are
//   unlocked by a signed `*.vhlicense.json`. Verifying that license against a CALLER-SUPPLIED `--vendor`
//   address is no gate at all: anyone can mint a license with their own key and pass their own address,
//   unlocking the paid surface for free (a revenue-only leak — NOT impersonation: their seals are still
//   signed by their own key). The fix is to pin gate-side license verification to a CANONICAL vendor
//   identity that is a COMMITTED constant, not an argv value. This module is that constant's single
//   home, so the evidence and agent gates (and any future product gate) can never drift apart.
//
// THE PUBLISHED IDENTITY
//   `VERIFYHASH_VENDOR_ADDRESS` is the published verifyhash vendor identity — the address whose key
//   mints real customer licenses (the owner-held vendor key; see STRATEGY.md "First-dollar config" and
//   the signed identity card at identity/verifyhash-evidence.vhidentity.json, whose signature recovers
//   to this exact address). The private key NEVER lives in this repo; only the PUBLIC address is
//   committed here.
//
// SELF-HOSTING — an honest boundary, not DRM (docs/LICENSING.md "Paid-gate vendor pinning").
//   The source is Apache-2.0: an operator running their OWN instance legitimately sets their OWN
//   canonical vendor identity — by editing this constant in their fork, by exporting the
//   `VH_CANONICAL_VENDOR` environment variable (the config channel a spawned CLI can use), or
//   programmatically via the run functions' `io.canonicalVendor` seam (what `go-live-preflight` uses to
//   validate an operator's OWN key end-to-end, and what tests use for ephemeral keys). Doing so makes it
//   THEIR instance: their licenses unlock only a build pinned to THEIR identity, and their artifacts no
//   longer verify against the published verifyhash identity. What the pin closes is the SHIPPED DEFAULT
//   free-riding the hosted vendor — a self-minted license no longer unlocks the stock build.
//
// PURE. `resolveCanonicalVendor` reads NOTHING ambient — the caller passes the override and the env
// object explicitly — so the same inputs always resolve to the same identity.

// The published verifyhash vendor identity (PUBLIC address only — never a key).
const VERIFYHASH_VENDOR_ADDRESS = "0x7cb4d3DC6C52996B6386473Bfb32f898263412f7";

// The operator config channel: a self-hosted instance exports THIS env var with its own vendor address.
const CANONICAL_VENDOR_ENV = "VH_CANONICAL_VENDOR";

/**
 * resolveCanonicalVendor({ override, env }) — PURE. Resolve the canonical vendor identity a paid gate
 * pins license verification to, in strict precedence order:
 *   1. `override`  — a programmatic embedder's identity (the run functions' `io.canonicalVendor` seam;
 *                    never reachable from argv);
 *   2. `env[CANONICAL_VENDOR_ENV]` — the self-hosted operator's configured identity;
 *   3. `VERIFYHASH_VENDOR_ADDRESS` — the committed, published default.
 * Returns the UNVALIDATED string; the gate validates it via coreLicense.resolveVendorPin so a garbage
 * configured address is a NAMED error at the gate, never a silent unlock.
 *
 * @param {object} [opts] { override?: string, env?: object (e.g. process.env) }
 * @returns {string} the canonical vendor identity to pin
 */
function resolveCanonicalVendor(opts) {
  const o = opts == null ? {} : opts;
  if (o.override != null && String(o.override).trim() !== "") return String(o.override).trim();
  const env = o.env == null ? {} : o.env;
  const fromEnv = env[CANONICAL_VENDOR_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return VERIFYHASH_VENDOR_ADDRESS;
}

module.exports = {
  VERIFYHASH_VENDOR_ADDRESS,
  CANONICAL_VENDOR_ENV,
  resolveCanonicalVendor,
};
