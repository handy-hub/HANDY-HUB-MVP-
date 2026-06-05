'use strict';

/**
 * functions/middleware/rateLimiter.js
 *
 * Firestore-backed, per-user sliding-window rate limiter for Cloud Functions.
 *
 * This is the authoritative enforcement layer — the frontend rateLimitService
 * is a UX convenience and can be bypassed. These checks cannot be bypassed.
 *
 * Collection : _rate_limits
 * Document ID: {userId}_{action}
 * Algorithm  : Sliding window using an array of request timestamps.
 *              Timestamps are stored as integers (Date.now() ms).
 *              Expired timestamps are pruned on every read.
 *
 * Usage in a Cloud Function:
 *
 *   const { checkRateLimit } = require('./middleware/rateLimiter');
 *
 *   exports.myFn = onCall({ region: '...' }, async (request) => {
 *     _requireAuth(request);
 *     await checkRateLimit(request.auth.uid, 'myFn');
 *     // ... rest of handler
 *   });
 *
 * If the user has exceeded the limit, checkRateLimit throws:
 *   HttpsError('resource-exhausted', '<human-readable message>')
 */

const { HttpsError } = require('firebase-functions/v2/https');
const { FIRESTORE_DB_ID } = require('../config');

// ── Per-action limits ──────────────────────────────────────────────────────────
// Keep windowMs in sync with the frontend ACTIONS config so both layers
// apply the same window length. The maxRequests here can be looser
// (the frontend is the UX guardrail; this is the hard stop).

const LIMITS = Object.freeze({
  processWithdrawal:        { maxRequests: 3,  windowMs:  60 * 60_000 },
  processArtisanWithdrawal: { maxRequests: 3,  windowMs:  60 * 60_000 },
  holdBookingFunds:         { maxRequests: 5,  windowMs:  60 * 60_000 },
  releaseEscrow:            { maxRequests: 5,  windowMs:  60 * 60_000 },
  refundBooking:            { maxRequests: 5,  windowMs:  60 * 60_000 },
  raiseDispute:             { maxRequests: 3,  windowMs:  24 * 60 * 60_000 },
});

// ── Firestore lazy init ────────────────────────────────────────────────────────

let _db = null;
function db() {
  if (!_db) {
    const { getFirestore } = require('firebase-admin/firestore');
    _db = getFirestore(FIRESTORE_DB_ID);
  }
  return _db;
}

const COLLECTION = '_rate_limits';

// ── Core ───────────────────────────────────────────────────────────────────────

/**
 * Atomically check and record a rate-limited action for the given user.
 *
 * @param {string} userId  Firebase Auth UID
 * @param {string} action  Key from the LIMITS registry above
 * @throws {HttpsError} 'resource-exhausted' if the user has exceeded their limit
 */
async function checkRateLimit(userId, action) {
  const config = LIMITS[action];
  if (!config) return; // no limit configured — allow

  const now         = Date.now();
  const windowStart = now - config.windowMs;

  // Firestore document IDs may not contain '/'.
  // Firebase UIDs are alphanumeric so the underscore separator is unambiguous.
  const docId = `${userId}_${action}`;
  const ref   = db().collection(COLLECTION).doc(docId);

  const result = await db().runTransaction(async (tx) => {
    const snap  = await tx.get(ref);
    const data  = snap.exists ? snap.data() : {};

    // Keep only timestamps inside the current window
    const valid = (data.timestamps || []).filter(ts => ts > windowStart);

    if (valid.length >= config.maxRequests) {
      const oldestTs = Math.min(...valid);
      const waitSec  = Math.ceil((oldestTs + config.windowMs - now) / 1_000);
      return { allowed: false, waitSec: Math.max(1, waitSec) };
    }

    // Record this request
    valid.push(now);
    tx.set(ref, {
      userId,
      action,
      timestamps: valid,
      updatedAt:  new Date().toISOString(),
    });

    return { allowed: true, remaining: config.maxRequests - valid.length };
  });

  if (!result.allowed) {
    const { waitSec } = result;
    const waitText = waitSec < 60
      ? `${waitSec} second${waitSec !== 1 ? 's' : ''}`
      : `${Math.ceil(waitSec / 60)} minute${Math.ceil(waitSec / 60) !== 1 ? 's' : ''}`;

    throw new HttpsError(
      'resource-exhausted',
      `Rate limit reached. Please wait ${waitText} before trying again.`,
    );
  }
}

module.exports = { checkRateLimit, LIMITS };
