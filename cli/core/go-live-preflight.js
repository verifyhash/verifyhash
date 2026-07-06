"use strict";

// ---------------------------------------------------------------------------
// cli/core/go-live-preflight.js — the OFFLINE, dependency-free GO-LIVE CONFIG PREFLIGHT
// for `vh evidence go-live-preflight` (T-61.3).
//
// WHY THIS EXISTS
//   The evidence revenue chain is BUILT and green (webhook -> authenticate -> map price ->
//   fulfill -> sign -> deliver -> the `--sign` gate accepts it). The one thing that stays
//   HUMAN — and therefore the one thing a typo can silently break — is the operator's OWN
//   configuration: their real price->plan BINDING, their plan CATALOG, and their vendor
//   KEY. A single mistake there (a price bound to a plan that lacks the paid entitlement, a
//   duplicate/typo'd price, a webhook secret wired to the wrong env var) produces the worst
//   possible failure: the customer PAID, Stripe fired the webhook, but the delivered license
//   does NOT unlock the product — and nobody notices until a refund request.
//
//   This preflight turns that risk into an executable YES/NO. It drives the operator's REAL
//   binding + catalog + key end-to-end, offline, with a throwaway workspace, and reports —
//   per price — whether a paying customer would receive a license that PASSES the existing
//   `vh evidence seal --sign` gate. A config error is a NAMED, non-zero failure that NAMES
//   the offending price; a clean run is exit 0 ("every price delivers").
//
// WHAT IT PROVES (per price mapping in the binding)
//   1. RESOLVE ...... the price resolves to a catalog plan via the binding (never a silent
//                     default plan; an unmapped/duplicate/typo'd price is rejected up front
//                     by the SAME strict validator the live webhook uses, NAMING the price).
//   2. SECRET LEG ... (only with --secret-env, for Stripe prices) the operator's REAL webhook
//                     secret authenticates a correctly-signed synthetic event (fail-closed:
//                     a forged event is REJECTED) and the event parses to the same price.
//   3. FULFILL ...... the resolved order mints a signed license with the vendor KEY (the exact
//                     `fulfillEvidenceOrder` -> `buildLicense` path the live fulfiller uses).
//   4. GATE ......... the delivered license PASSES the existing paid gate — it is run through
//                     `vh evidence seal --sign` (which requires the `evidence_signed`
//                     entitlement). A plan that LACKS the paid entitlement is caught HERE
//                     (reported FAIL, never PASS) — the delivered license would not unlock
//                     the product the customer bought.
//
// THE PAID-ENTITLEMENT INVARIANT. Every purchasable evidence plan must deliver a license that
//   unlocks the product's paid surface, `vh evidence seal --sign`, which requires
//   `evidence_signed`. Every paid plan in the shipped DRAFT catalog includes it (the annual
//   plan adds `evidence_unlimited` on top). A price mapped to a plan without `evidence_signed`
//   means a paying customer gets a license that does not sign — exactly the silent failure this
//   preflight exists to catch.
//
// POSTURE — GUARDRAILS BAKED IN. It holds NO real key beyond the one the operator provisions
//   via --key-env/--key-file (read once through the SAME loadSigningWallet the paid gate uses,
//   held in memory, NEVER written to disk or logged); the webhook secret comes ONLY from
//   --secret-env and is used ONLY to HMAC-verify a synthetic event. It imports NONE of
//   http/https/net/dns, opens NO network, deploys NOTHING, takes NO payment, and writes ONLY a
//   throwaway workspace under the OS temp dir that it removes on exit (pass or fail). Exit
//   contract matches the family: 0 all-deliver / 2 config error / 3 a price would not deliver.
//
// NEGATIVE SELF-TEST HOOK. `opts.injectFault` (an INTERNAL option the CLI never sets) injects
//   a realistic fault into the secret leg so the preflight can demonstrate it is NOT a rubber
//   stamp: with `injectFault:"signature"` the first Stripe price's synthetic event is signed
//   with a corrupted signature, so the operator's real secret REJECTS it and the price is
//   reported FAIL (fail-closed). Unset (the normal case), it exercises the real thing.
// ---------------------------------------------------------------------------

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const coreAttestation = require("./attestation");
const evidencePlans = require("./evidence-plans");
const intake = require("./fulfill-intake");
const evidence = require("../evidence");

const EXIT = evidence.EXIT; // { OK:0, IO:1, USAGE:2, FAIL:3 } — one exit vocabulary for the family.

// The paid entitlement every purchasable plan must deliver (see THE PAID-ENTITLEMENT INVARIANT).
const REQUIRED_PAID_ENTITLEMENT = "evidence_signed";

// The one-line honest posture, stated ONCE so human + JSON output agree and can never drift.
const PREFLIGHT_TRUST_NOTE =
  "A go-live preflight drives your REAL price->plan binding, plan catalog, and vendor key end-to-end " +
  "OFFLINE (no network, no deploy, no funds) and reports whether every price delivers a license that " +
  "PASSES the existing `vh evidence seal --sign` gate. It is NOT a legal/compliance sign-off and " +
  "publishes NOTHING; going live (real key custody, real webhook secret, deploy) stays a HUMAN step. " +
  "A license is an ACCESS credential for delivered software value — NOT a token/coin/NFT, not tradeable.";

// A fixed WRONG secret used ONLY to prove the operator's secret path is fail-closed (a forged event must
// be rejected). It is NOT a key and signs NOTHING of value — it is a throwaway HMAC label.
const _FAIL_CLOSED_PROBE_SECRET = "vh-preflight-fail-closed-probe-secret";

// ---------------------------------------------------------------------------------------------------
// Synthetic-event helpers (Stripe-shaped). Used ONLY to exercise the operator's real secret + parse
// path; nothing here is written to disk or sent anywhere.
// ---------------------------------------------------------------------------------------------------

// A minimal, real-shaped `checkout.session.completed` body carrying exactly the fields the intake parser
// reads: customer, the (expanded) subscription's single item price, and its billing-cycle end.
function _synthCheckoutEvent(priceId, customer, periodEndSec) {
  return JSON.stringify({
    type: "checkout.session.completed",
    data: {
      object: {
        customer,
        subscription: {
          items: {
            object: "list",
            data: [{ price: { id: priceId }, current_period_end: periodEndSec }],
          },
        },
      },
    },
  });
}

// A Stripe-compatible signature header `t=<unix>,v1=<hmac_sha256_hex>` over `${t}.${rawBody}`.
function _stripeSignatureHeader(rawBody, secret, tSec) {
  const v1 = crypto.createHmac("sha256", secret).update(`${tSec}.${rawBody}`, "utf8").digest("hex");
  return `t=${tSec},v1=${v1}`;
}

// Corrupt a v1 hex signature (flip its first hex digit) so verification MUST reject it — the injected
// fault for the negative self-test.
function _corruptSignatureHeader(header) {
  return header.replace(/v1=([0-9a-f])/, (_m, c) => `v1=${c === "0" ? "1" : "0"}`);
}

// ---------------------------------------------------------------------------------------------------
// Argument parsing. EXACTLY-ONE-of key sources is enforced downstream by loadSigningWallet; the parser
// only collects flags (mirrors the rest of the evidence CLI).
// ---------------------------------------------------------------------------------------------------

function parseGoLivePreflightArgs(argv) {
  const opts = {
    binding: undefined, // REQUIRED: the operator's price->plan binding JSON
    catalog: undefined, // OPTIONAL: plan catalog (default = bundled DRAFT baseline)
    secretEnv: undefined, // OPTIONAL: env var holding the webhook signing secret
    keyEnv: undefined, // vendor key source (EXACTLY ONE of key-env/key-file)
    keyFile: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined || String(v).startsWith("--")) {
        const e = new Error(`${a} requires a value`);
        e.usage = true;
        throw e;
      }
      return v;
    };
    switch (a) {
      case "--binding": opts.binding = need(); break;
      case "--catalog": opts.catalog = need(); break;
      case "--secret-env": opts.secretEnv = need(); break;
      case "--key-env": opts.keyEnv = need(); break;
      case "--key-file": opts.keyFile = need(); break;
      case "--json": opts.json = true; break;
      default: {
        const e = new Error(`unknown flag: ${a}`);
        e.usage = true;
        throw e;
      }
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------------
// The per-price fulfillment+gate leg. Returns a result record { provider, priceId, plan, ok, steps[],
// reason? }. NEVER throws for an ordinary config/delivery failure — it records `ok:false` with a NAMED
// reason so the driver can surface EVERY offending price. `ws` is the throwaway workspace; `ctx` carries
// the loaded catalog/binding/wallet/secret + the injected clock + the fault hook.
// ---------------------------------------------------------------------------------------------------

async function _preflightPrice(mapping, index, ctx, ws) {
  const { provider, priceId, planId } = mapping;
  const label = `${provider}:${priceId}`;
  const steps = [];
  const fail = (reason) => ({ provider, priceId, plan: planId, ok: false, steps, reason });

  // (1) RESOLVE — the price must resolve to the catalog plan via the binding (exercises the SAME resolver
  //     the live webhook uses; a mismatch is a bug, never a silent default).
  let resolved;
  try {
    resolved = intake.resolveEvidencePlanId(ctx.binding, provider, priceId);
  } catch (e) {
    return fail(`price ${label} does not resolve to any plan: ${e.message}`);
  }
  if (resolved !== planId) {
    return fail(`price ${label} resolved to plan '${resolved}' but the mapping declares '${planId}' (ambiguous binding)`);
  }
  steps.push(`resolved plan '${resolved}' via the price binding`);

  // Build the fulfillment ORDER. With --secret-env on a Stripe price we drive the FULL real intake path
  // (authenticate the operator's secret, fail-closed, then parse+normalize the event); otherwise we build
  // the order directly from the resolved plan.
  const periodEndSec = ctx.issuedSec + 30 * 86400; // a real 30-day window (paidThrough > issuedAt)
  const customer = `go-live-preflight (price ${priceId})`;
  let order;

  if (ctx.secret != null && provider === intake.STRIPE_PROVIDER) {
    const rawBody = _synthCheckoutEvent(priceId, customer, periodEndSec);
    let header = _stripeSignatureHeader(rawBody, ctx.secret, ctx.issuedSec);
    // Negative self-test: corrupt the FIRST Stripe price's signature so the real secret must reject it.
    if (ctx.injectFault === "signature" && !ctx.faultUsed) {
      ctx.faultUsed = true;
      header = _corruptSignatureHeader(header);
    }
    // (2a) AUTHENTICATE with the operator's REAL secret — a rejected signature is a NAMED fail-closed FAIL.
    const sig = intake.verifyProviderSignature(rawBody, header, ctx.secret, { nowSec: ctx.issuedSec });
    if (!sig.ok) {
      return fail(
        `price ${label} FAILED the webhook secret path (${ctx.secretEnv}): the synthesized event's ` +
          `signature was rejected (${sig.reason}) — a real paid event would be refused (fail-closed), ` +
          `delivering NO license`
      );
    }
    // (2b) FAIL-CLOSED PROOF — a forged signature (a wrong secret) MUST be rejected; if it authenticates,
    //      the secret path is broken.
    const forged = intake.verifyProviderSignature(
      rawBody,
      _stripeSignatureHeader(rawBody, _FAIL_CLOSED_PROBE_SECRET, ctx.issuedSec),
      ctx.secret,
      { nowSec: ctx.issuedSec }
    );
    if (forged.ok) {
      return fail(`price ${label} secret path is NOT fail-closed: a FORGED event authenticated against ${ctx.secretEnv}`);
    }
    // (2c) PARSE + NORMALIZE the authenticated event through the real intake seams.
    let event;
    try {
      event = intake.parseEvidenceEvent(rawBody, { binding: ctx.binding });
    } catch (e) {
      return fail(`price ${label} authenticated but FAILED to parse: ${e.message}`);
    }
    if (event.priceId !== priceId) {
      return fail(`price ${label} parsed to a different price '${event.priceId}'`);
    }
    try {
      order = intake.normalizeEvidenceEvent(event, ctx.binding, { issuedAt: ctx.issuedAt });
    } catch (e) {
      return fail(`price ${label} could not normalize: ${e.message}`);
    }
    steps.push(`secret path (${ctx.secretEnv}) AUTHENTICATED a signed event and REJECTED a forged one (fail-closed)`);
  } else {
    order = { plan: planId, customer, issuedAt: ctx.issuedAt, paidThrough: new Date(periodEndSec * 1000).toISOString() };
    if (ctx.secret != null) {
      steps.push(`signature leg skipped (non-Stripe provider '${provider}'); the fulfillment path was still validated`);
    }
  }

  // (3) FULFILL + MINT — the exact order->license-params->signed-license path the live fulfiller uses. The
  //     key lives ONLY inside ctx.wallet; the written license carries only PUBLIC bytes (signature + signer
  //     address).
  let params;
  let canonical;
  try {
    params = evidencePlans.fulfillEvidenceOrder(order, ctx.catalog);
    const container = await evidence.buildLicense(params, ctx.wallet);
    canonical = evidence.serializeSignedLicense(container);
  } catch (e) {
    return fail(`price ${label} could not fulfill/sign a license: ${e.message}`);
  }
  const licPath = path.join(ws, `license-${index}.vhevidence-license.json`);
  try {
    fs.writeFileSync(licPath, canonical);
  } catch (e) {
    return fail(`price ${label} could not write its license to the workspace: ${e.message}`);
  }
  steps.push(`minted a signed license (plan '${params.plan}', entitlements ${params.entitlements.join("+")})`);

  // (4) GATE — run the delivered license through the EXISTING paid gate: `vh evidence seal --sign`
  //     requires `evidence_signed`. A plan that LACKS the paid entitlement is caught HERE (FAIL, never
  //     PASS). We drive the real command in-process, capturing its output so it never leaks to our stdout.
  //     The gate pins license verification to the CANONICAL vendor identity (T-75.3); this preflight
  //     validates the OPERATOR'S OWN instance end-to-end, so the operator's key IS that instance's
  //     canonical identity — declared via the programmatic `io.canonicalVendor` seam (the exact
  //     self-hosting hook docs/LICENSING.md documents), never by re-pinning through `--vendor`.
  let capturedErr = "";
  const sealOut = path.join(ws, `seal-${index}.vhevidence.json`);
  let gateCode;
  try {
    gateCode = await evidence.runEvidenceSeal(
      {
        dir: ctx.dataDir,
        sign: true,
        license: licPath,
        vendor: ctx.wallet.address,
        keyEnv: ctx.keyEnv,
        keyFile: ctx.keyFile,
        out: sealOut,
      },
      {
        write: () => {},
        writeErr: (s) => { capturedErr += s; },
        now: ctx.today,
        canonicalVendor: ctx.wallet.address,
      }
    );
  } catch (e) {
    return fail(`price ${label} crashed the paid gate: ${e && e.message ? e.message : String(e)}`);
  }
  if (gateCode !== EXIT.OK) {
    const detail = capturedErr.trim().split("\n").filter(Boolean).slice(-1)[0] || `gate exit ${gateCode}`;
    return fail(
      `price ${label} delivered a license the paid \`vh evidence seal --sign\` gate REJECTED for plan ` +
        `'${planId}' (needs '${REQUIRED_PAID_ENTITLEMENT}'): ${detail}`
    );
  }
  steps.push(`delivered license PASSED the paid \`vh evidence seal --sign\` gate ('${REQUIRED_PAID_ENTITLEMENT}')`);

  return { provider, priceId, plan: planId, ok: true, steps };
}

// ---------------------------------------------------------------------------------------------------
// runGoLivePreflight(opts, io) — validate the operator's config, then drive every price end-to-end in a
// throwaway workspace. Resolves to a NUMBER exit code: 0 all-deliver / 2 config error / 3 a price would
// not deliver. `io` is injectable (write/writeErr sinks + a `now` Date + a `nowISO`) so the command is
// deterministic under test. The workspace is ALWAYS removed (pass or fail).
// ---------------------------------------------------------------------------------------------------

async function runGoLivePreflight(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const today = io.now instanceof Date ? io.now : new Date();
  const issuedAt = today.toISOString();
  const issuedSec = Math.floor(today.getTime() / 1000);

  // ---- required flags (a clear, key-free message per missing one) ----------
  if (opts.binding == null) {
    writeErr("error: `vh evidence go-live-preflight` requires --binding <file> (your price->plan binding)\n");
    return EXIT.USAGE;
  }

  // ---- the plan catalog (bundled DRAFT by default) -------------------------
  const catalogPath = opts.catalog != null ? path.resolve(opts.catalog) : evidence.BUNDLED_EVIDENCE_CATALOG;
  let catalog;
  try {
    catalog = evidencePlans.validateEvidencePlanCatalog(JSON.parse(fs.readFileSync(catalogPath, "utf8")));
  } catch (e) {
    writeErr(`error: cannot load evidence plan catalog ${catalogPath}: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // ---- the price binding (validated against the catalog: an UNMAPPED / duplicate / typo'd price is a
  //      NAMED reject here, NEVER a silent default plan) ----------------------
  const bindingPath = path.resolve(opts.binding);
  let binding;
  try {
    binding = intake.validateEvidencePriceBinding(JSON.parse(fs.readFileSync(bindingPath, "utf8")), catalog);
  } catch (e) {
    writeErr(`error: cannot load --binding ${opts.binding}: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // ---- the webhook secret (OPTIONAL; from --secret-env only — name the VAR, never the value) ----
  let secret = null;
  if (opts.secretEnv != null) {
    secret = process.env[opts.secretEnv];
    if (secret === undefined || secret === "") {
      writeErr(`error: environment variable ${opts.secretEnv} is not set (or empty); it must hold the webhook signing secret\n`);
      return EXIT.USAGE;
    }
  }

  // ---- the VENDOR key (EXACTLY ONE of --key-env/--key-file; read-used-held-in-memory, never persisted) ----
  let wallet;
  try {
    ({ wallet } = coreAttestation.loadSigningWallet({ keyEnv: opts.keyEnv, keyFile: opts.keyFile }));
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // ---- the throwaway workspace + a tiny data folder the gate seals ----------
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "vh-golive-preflight-"));
  const dataDir = path.join(ws, "data");
  const results = [];
  let code = EXIT.OK;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "sample.txt"), "go-live preflight sample payload\n");

    const ctx = {
      catalog,
      binding,
      wallet,
      keyEnv: opts.keyEnv,
      keyFile: opts.keyFile,
      secret,
      secretEnv: opts.secretEnv,
      today,
      issuedAt,
      issuedSec,
      dataDir,
      injectFault: opts.injectFault || null,
      faultUsed: false,
    };

    // Drive every price mapping in the (validated, deterministically-sorted) binding.
    for (let i = 0; i < binding.mappings.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await _preflightPrice(binding.mappings[i], i, ctx, ws);
      results.push(r);
      if (!r.ok) code = EXIT.FAIL;
    }
  } catch (e) {
    // An unexpected workspace/IO error (never leaks the key/secret).
    writeErr(`error: go-live preflight could not run: ${e && e.message ? e.message : String(e)}\n`);
    code = EXIT.IO;
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  // ---- emit the verdict ----------------------------------------------------
  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: code === EXIT.OK,
          note: PREFLIGHT_TRUST_NOTE,
          catalog: catalogPath,
          binding: bindingPath,
          secretExercised: secret != null,
          requiredEntitlement: REQUIRED_PAID_ENTITLEMENT,
          priceCount: results.length,
          passed,
          failed,
          results: results.map((r) => ({
            provider: r.provider,
            priceId: r.priceId,
            plan: r.plan,
            ok: r.ok,
            ...(r.ok ? { steps: r.steps } : { reason: r.reason }),
          })),
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(PREFLIGHT_TRUST_NOTE + "\n\n");
    write("verifyhash — GO-LIVE CONFIG PREFLIGHT (offline; no network; no deploy)\n");
    write(`  catalog: ${catalogPath}\n`);
    write(`  binding: ${bindingPath}  (${results.length} price mapping${results.length === 1 ? "" : "s"})\n`);
    write(
      `  secret:  ${secret != null ? `exercising the real webhook secret path (--secret-env ${opts.secretEnv})` : "not exercised (pass --secret-env to test it)"}\n\n`
    );
    for (const r of results) {
      write(`PRICE ${r.provider}:${r.priceId}  ->  plan ${r.plan}  ...  ${r.ok ? "PASS" : "FAIL"}\n`);
      if (r.ok) {
        for (const s of r.steps) write(`        - ${s}\n`);
      } else {
        write(`        - ${r.reason}\n`);
      }
    }
    write("\n");
    if (code === EXIT.OK) {
      write(`ALL ${results.length} price${results.length === 1 ? "" : "s"} deliver a license that PASSES the paid gate — the binding is go-live-ready.\n`);
    } else if (code === EXIT.FAIL) {
      write(`PREFLIGHT FAILED: ${failed} of ${results.length} price(s) would NOT deliver a working license — fix the NAMED price(s) before going live.\n`);
    }
  }
  return code;
}

// ---------------------------------------------------------------------------------------------------
// cmdGoLivePreflight(argv, io) — parse argv, then run. Resolves to a NUMBER exit code (2 on a bad flag).
// ---------------------------------------------------------------------------------------------------

function cmdGoLivePreflight(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  let opts;
  try {
    opts = parseGoLivePreflightArgs(argv);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return Promise.resolve(EXIT.USAGE);
  }
  return runGoLivePreflight(opts, io);
}

module.exports = {
  EXIT,
  REQUIRED_PAID_ENTITLEMENT,
  PREFLIGHT_TRUST_NOTE,
  parseGoLivePreflightArgs,
  runGoLivePreflight,
  cmdGoLivePreflight,
};
