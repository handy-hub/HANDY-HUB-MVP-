#!/usr/bin/env node
'use strict';

/**
 * check-status-vocab.cjs — drift guard for the booking status vocabulary.
 *
 * The single source of truth is shared/js/domain/bookingStatusMeta.js
 * (BOOKING_STATUSES). Firestore Rules and Cloud Functions cannot import that ES
 * module, so they necessarily hardcode status strings. This check fails CI if
 * any status string used in firestore.rules or the Cloud Functions is NOT part
 * of the canonical vocabulary — catching the exact class of drift that let
 * inspection statuses and `disputed` fall out of sync across surfaces.
 *
 * It is intentionally a superset check (every status the backend references must
 * exist in the vocabulary), not equality — the vocabulary may legitimately
 * contain display-only groupings the backend never writes.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ── 1. Extract the canonical vocabulary from the SoT module ──────────────────
const metaSrc = read('shared/js/domain/bookingStatusMeta.js');
const vocabMatch = metaSrc.match(/export const BOOKING_STATUSES = \[([\s\S]*?)\];/);
if (!vocabMatch) {
  console.error('✗ Could not find BOOKING_STATUSES in bookingStatusMeta.js');
  process.exit(2);
}
const VOCAB = new Set(
  [...vocabMatch[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1])
);

// Tokens from OTHER collections' state machines (verification_requests, jobs,
// escrow, transactions) that share the `status` field name but are not booking
// statuses. Excluded to keep the check focused on the booking vocabulary.
const IGNORE = new Set([
  'Pending',            // legacy capitalised alias accepted at create time
  'active',             // artisan availability, not a booking status
  'approved', 'held', 'released', 'refunded', // escrow/verif states
  'topup', 'successful', 'failed', 'pending', // txn states share the word
  'pending_review', 'draft', 'submitted',     // verification_requests states
]);

// ── 2. Scan backend files for quoted status-like tokens near status fields ───
// We look specifically for the patterns the state machine uses so we don't flag
// every random string: `status`/`next`/`prev` comparisons and `in [...]` lists.
const TARGETS = [
  'firestore.rules',
  'functions/pricing.js',
  'functions/quotes.js',
  'functions/bookings.js',
  'functions/dispatch.js',
];

const STATUS_CTX = /(?:status|prevStatus|nextStatus|next|prev|revertTo|dispatchStatus)\b[^\n;{}]*?['"]([a-z_]{4,})['"]/g;

let violations = [];
for (const rel of TARGETS) {
  let src;
  try { src = read(rel); } catch { continue; }
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(STATUS_CTX)) {
      const tok = m[1];
      if (IGNORE.has(tok)) continue;
      // Only consider tokens that look like a booking status (contain an
      // underscore, or are one of the single-word statuses) to cut noise.
      const looksLikeStatus = tok.includes('_') || VOCAB.has(tok);
      if (!looksLikeStatus) continue;
      if (!VOCAB.has(tok)) {
        violations.push(`${rel}:${i + 1}  unknown booking status "${tok}"`);
      }
    }
  });
}

console.log(`Status-vocab check: ${VOCAB.size} canonical statuses; scanned ${TARGETS.length} backend files.`);
if (violations.length) {
  console.error(`\n✗ ${violations.length} status token(s) not in BOOKING_STATUSES:`);
  for (const v of violations) console.error('  ' + v);
  console.error('\nAdd the status to BOOKING_STATUSES (shared/js/domain/bookingStatusMeta.js) or fix the typo.');
  process.exit(1);
}
console.log('✓ All backend status tokens are in the canonical vocabulary.');
