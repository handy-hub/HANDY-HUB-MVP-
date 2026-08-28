#!/usr/bin/env node
/**
 * check-invented-values.cjs — CI guard for the "invented value" defect class.
 *
 * WHY
 * ───
 * Three production defects were one pattern wearing three hats:
 *
 *   (state.total || last.total || 65)      → a GHS 65 receipt for a GHS 1 job
 *   rating: currentRating || 5             → a five-star review nobody wrote
 *   Number(a.rating || 0).toFixed(1)       → "0.0 ★" for an artisan with no reviews
 *
 * In each case a falsy-coalescing fallback substituted an invented value for
 * absent data and presented it to a user as fact. `||` is the hazard: it fires
 * on 0 and '' as well as null/undefined, so a legitimate zero and a missing
 * value are indistinguishable, and the fallback wins in both.
 *
 * WHAT THIS CAN SEE
 * ─────────────────
 * Source text. It flags `<money-ish identifier> || <number>` and a small set of
 * fabricated-status literals in the customer, artisan and admin apps.
 *
 * WHAT THIS CANNOT SEE  (stated plainly — do not mistake this for full cover)
 * ──────────────────────────────────────────────────────────────────────────
 *  • Runtime shape mismatches. The receipt's real cause was authInit.js reading
 *    flat fields off toRecord()'s { id, data } wrapper — every field resolved to
 *    undefined and fell to its default. No grep can see that; the code is
 *    well-formed. Only a browser-level integration test that seeds Firestore,
 *    loads the page and asserts on rendered pixels would catch it.
 *  • Whether a rendered fallback is reached in practice.
 *  • Values invented inside a Cloud Function.
 *
 * The harness has no browser-level integration layer. Closing that gap is
 * scoped in docs, not faked here: a unit test asserting on a mapper in
 * isolation would have passed against the broken code, because the mapper was
 * never the thing that was wrong.
 *
 * Run: node scripts/check-invented-values.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOTS = ['customer-app', 'artisan-app', 'admin-dashboard', 'shared/js'];
const SKIP_DIRS = new Set(['node_modules', 'build-customer-app', 'build-artisan-app', '.git']);
const EXT = new Set(['.js', '.html', '.cjs', '.mjs']);

// Identifiers whose value is money, a rating, or another user-meaningful figure.
const FIELD = '(?:total|price|amount|fee|calloutFee|jobQuote|balance|walletBalance|' +
              'escrowBalance|rating|earnings|payout|commission|refund|credit|due)';
const NUMERIC_FALLBACK = new RegExp(`${FIELD}\\s*\\|\\|\\s*(\\d+(?:\\.\\d+)?)`, 'i');

// Statuses that assert a financial outcome. Only flagged when hardcoded next to
// a fallback — a plain status string is normal.
const FAKE_STATUS = /\|\|\s*['"](?:Paid|Completed|Success|Successful|Settled|Refunded)['"]/i;

/**
 * Legitimate uses, each justified. Sorting by a rating needs a total order and
 * never reaches a screen; treating unrated as 0 there sorts them last, which is
 * correct. These are matched on the CONTENT of the line, not its number, so they
 * survive edits above them.
 */
const ALLOW = [
  /\.sort\(/,                      // comparators — ordering, never displayed
  /localeCompare/,
  /Math\.(?:max|min)\(/,           // clamping an already-resolved value
  /toFixed\(\d\)\s*\)?\s*[-+]/,    // arithmetic inside a comparator
];

let flagged = 0;
const hits = [];

function stripComments(src, isHtml) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  if (isHtml) out = out.replace(/<!--[\s\S]*?-->/g, '');
  return out.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!EXT.has(path.extname(e.name))) continue;
    scan(full);
  }
}

function scan(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const isHtml = file.endsWith('.html');
  const lines = stripComments(raw, isHtml).split('\n');

  lines.forEach((line, i) => {
    if (ALLOW.some(re => re.test(line))) return;

    const num = line.match(NUMERIC_FALLBACK);
    if (num && Number(num[1]) !== 0) {
      hits.push({ file, line: i + 1, kind: 'invented-number', text: line.trim().slice(0, 120) });
      flagged++;
      return;
    }
    // A `|| 0` on a money field is only safe if it cannot reach a display.
    // Flag when it is interpolated or assigned to text.
    if (num && Number(num[1]) === 0 && /textContent|innerHTML|`|\$\{/.test(line)) {
      hits.push({ file, line: i + 1, kind: 'zero-as-fact', text: line.trim().slice(0, 120) });
      flagged++;
      return;
    }
    if (FAKE_STATUS.test(line)) {
      hits.push({ file, line: i + 1, kind: 'invented-status', text: line.trim().slice(0, 120) });
      flagged++;
    }
  });
}

ROOTS.forEach(r => walk(path.join(__dirname, '..', r)));

if (flagged === 0) {
  console.log('✓ No invented money, rating, or payment-status fallbacks in user-visible code.');
  process.exit(0);
}

console.log(`\n✗ ${flagged} invented-value fallback(s) — absent data must render as absent:\n`);
for (const h of hits) {
  const rel = path.relative(path.join(__dirname, '..'), h.file).replace(/\\/g, '/');
  console.log(`  ${rel}:${h.line}  [${h.kind}]`);
  console.log(`    ${h.text}\n`);
}
console.log('Fix: return null for unresolved values and render an explicit absent');
console.log('state ("—", "Amount unavailable", "No reviews yet"). Never substitute a');
console.log('number. See shared/js/domain/bookingTruth.js for the projection contract.\n');
process.exit(1);
