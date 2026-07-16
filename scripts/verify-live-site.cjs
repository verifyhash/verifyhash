#!/usr/bin/env node
/**
 * Post-deploy live verification for verifyhash.com (the site publish set).
 *
 * READ-ONLY: issues plain HTTP GET requests against the live origin and
 * compares what is served against the committed public/ tree via
 * public/RELEASE-MANIFEST.json (schema vh-site-release-manifest@1).
 * It NEVER edits live content and NEVER touches the deploy pipeline —
 * a mismatch is reported as a finding (needs-human redeploy), not fixed
 * here.
 *
 * This is intentionally NOT wired into any test/gate suite: it depends
 * on the network and on a live deploy existing, which are not properties
 * of the source tree. Run it by hand after a deploy:
 *
 *     node scripts/verify-live-site.cjs                      # https://verifyhash.com
 *     node scripts/verify-live-site.cjs --base https://verifyhash.com
 *
 * Checks, for EVERY file in the manifest:
 *   1. live GET body sha256  ===  manifest sha256
 *   2. live GET body sha256  ===  on-disk public/<path> sha256
 *   3. for .html entries: live body contains EXACTLY ONE
 *      'data-goatcounter=' analytics snippet
 *
 * Exit code 0 = every file matched and every snippet count is 1;
 * exit code 1 = at least one mismatch/failure (each offender is named).
 *
 * Zero third-party dependencies: Node stdlib only (https, crypto, fs).
 * Modeled on einvoice/verify_live.py.
 */
'use strict';

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const MANIFEST = path.join(PUBLIC, 'RELEASE-MANIFEST.json');
const DEFAULT_BASE = 'https://verifyhash.com';
const TIMEOUT_MS = 20000;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** GET url; resolve {status, body(Buffer)} — or {status:null, error} on network failure. */
function get(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'vh-verify-live-site/1.0',
          'Cache-Control': 'no-cache',
          // identity: refuse transfer-encoding surprises; we want raw bytes
          'Accept-Encoding': 'identity',
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout after ' + TIMEOUT_MS + 'ms'));
    });
    req.on('error', (e) => resolve({ status: null, error: String(e) }));
  });
}

/** When live differs, describe how (length + first divergent offset) — diagnosis only, still a FAIL. */
function describeDiff(live, disk) {
  let i = 0;
  const n = Math.min(live.length, disk.length);
  while (i < n && live[i] === disk[i]) i++;
  const ctx = (b) =>
    b
      .slice(Math.max(0, i - 20), i + 40)
      .toString('utf8')
      .replace(/\n/g, '\\n');
  return (
    'live=' + live.length + 'B disk=' + disk.length + 'B, first divergence at byte ' + i +
    '; live[..]="' + ctx(live) + '" disk[..]="' + ctx(disk) + '"'
  );
}

async function main() {
  const argv = process.argv.slice(2);
  let base = DEFAULT_BASE;
  const bi = argv.indexOf('--base');
  if (bi !== -1 && argv[bi + 1]) base = argv[bi + 1].replace(/\/+$/, '');

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (manifest.schema !== 'vh-site-release-manifest@1') {
    console.error('unexpected manifest schema: ' + manifest.schema);
    return 1;
  }
  const files = manifest.files;
  console.log(
    'verify-live-site: ' + files.length + ' manifest entries vs ' + base
  );
  console.log('');

  const failures = [];
  const pad = (s, w) => (s + ' '.repeat(w)).slice(0, w);
  console.log(
    pad('RESULT', 8) + pad('MANIFEST', 10) + pad('DISK', 6) + pad('GC', 5) + 'PATH'
  );

  for (const entry of files) {
    const rel = entry.path;
    const url = base + '/' + rel;
    const diskPath = path.join(PUBLIC, rel);
    const probs = [];

    let disk = null;
    if (fs.existsSync(diskPath)) {
      disk = fs.readFileSync(diskPath);
    } else {
      probs.push('committed public/' + rel + ' is MISSING on disk');
    }

    const res = await get(url);
    let manifestOk = false;
    let diskOk = false;
    let gcMark = '-';

    if (res.status !== 200 || !res.body) {
      probs.push(
        'GET ' + url + ' -> ' + (res.status === null ? res.error : 'HTTP ' + res.status)
      );
    } else {
      const liveHash = sha256(res.body);
      manifestOk = liveHash === entry.sha256;
      if (!manifestOk) {
        probs.push(
          rel + ': live sha256 ' + liveHash + ' != manifest ' + entry.sha256 +
          (disk ? ' [' + describeDiff(res.body, disk) + ']' : '')
        );
      }
      if (disk) {
        diskOk = liveHash === sha256(disk);
        if (!diskOk && manifestOk) {
          // manifest matched live but disk drifted from manifest
          probs.push(rel + ': on-disk public/ bytes differ from live/manifest');
        }
      }
      if (rel.endsWith('.html')) {
        const count = (res.body.toString('utf8').match(/data-goatcounter=/g) || []).length;
        gcMark = String(count);
        if (count !== 1) {
          probs.push(
            rel + ': ' + count + " occurrences of 'data-goatcounter=' (expected exactly 1)"
          );
        }
      }
    }

    const ok = probs.length === 0;
    console.log(
      pad(ok ? 'PASS' : 'FAIL', 8) +
        pad(manifestOk ? 'match' : 'DIFF', 10) +
        pad(diskOk ? 'ok' : 'DIFF', 6) +
        pad(gcMark, 5) +
        rel
    );
    for (const p of probs) failures.push(p);
  }

  console.log('');
  if (failures.length) {
    console.log('RESULT: ' + failures.length + ' finding(s) — live deploy does NOT match the committed publish set:');
    for (const f of failures) console.log('  - ' + f);
    console.log('ACTION: needs-human redeploy — do NOT edit live content from here.');
    return 1;
  }
  console.log(
    'RESULT: PASS — all ' + files.length +
      ' live files byte-match the manifest and on-disk public/, and every .html page carries exactly one data-goatcounter= snippet.'
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('verify-live-site crashed: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  }
);
