/**
 * rateLimitService.js — Centralised frontend sliding-window rate limiter.
 *
 * Protects high-value actions: payments, bookings, auth.
 * This is the UX-layer defense. Cloud Functions enforce authoritative limits.
 *
 * Algorithm : Sliding window — array of request timestamps in localStorage
 * Backoff   : Exponential penalty applied after repeated violations
 * Scope     : Per-user (Firebase UID) or per-device (fingerprint) for pre-auth
 * Multi-tab : localStorage is shared across tabs — limits apply globally per browser
 */

import { showToast } from '../components/toast.js';

// ── Action registry ────────────────────────────────────────────────────────────
// Each entry defines the window size, max requests inside that window,
// and whether repeated violations escalate an exponential backoff.

/** @type {Record<string, { maxRequests: number, windowMs: number, backoff: boolean }>} */
export const ACTIONS = Object.freeze({
  // Financial — strictest limits (real money involved)
  WITHDRAWAL:          { maxRequests: 3,  windowMs:  60 * 60_000,       backoff: true  },
  ARTISAN_WITHDRAWAL:  { maxRequests: 3,  windowMs:  60 * 60_000,       backoff: true  },
  HOLD_BOOKING_FUNDS:  { maxRequests: 5,  windowMs:  60 * 60_000,       backoff: true  },
  RELEASE_ESCROW:      { maxRequests: 5,  windowMs:  60 * 60_000,       backoff: true  },
  TOPUP_INITIATION:    { maxRequests: 5,  windowMs:  60 * 60_000,       backoff: true  },

  // Booking — strict (each creates a Firestore document + dispatch)
  BOOKING_CREATE:      { maxRequests: 5,  windowMs:  60 * 60_000,       backoff: true  },
  EMERGENCY_BOOKING:   { maxRequests: 3,  windowMs:  30 * 60_000,       backoff: true  },
  REVIEW_SUBMIT:       { maxRequests: 10, windowMs:  24 * 60 * 60_000,  backoff: false },

  // Profile — moderate (Firestore write per update)
  PROFILE_UPDATE:      { maxRequests: 10, windowMs:  60 * 60_000,       backoff: false },

  // Auth — pre-login (Firebase enforces its own limits, this adds UX layer)
  LOGIN_ATTEMPT:       { maxRequests: 5,  windowMs:   5 * 60_000,       backoff: true  },
  SIGNUP_ATTEMPT:      { maxRequests: 3,  windowMs:  10 * 60_000,       backoff: true  },
});

// ── Backoff constants ──────────────────────────────────────────────────────────

const BACKOFF_BASE_MS    = 30_000;       // 30 s first penalty
const BACKOFF_MAX_MS     = 15 * 60_000;  // 15 min ceiling
const VIOLATION_RESET_MS = 60 * 60_000; // Auto-clear violations after 1 h of no new hits

// ── Storage key namespaces ─────────────────────────────────────────────────────

const RL_PREFIX = 'hh_rl_';   // sliding window timestamps
const BO_PREFIX = 'hh_bo_';   // backoff / violation state

// ── Device fingerprint for pre-auth callers ────────────────────────────────────
// Lightweight, no native APIs — hash of stable browser properties.
// Collisions are acceptable; this is supplementary to backend enforcement.

function _deviceId() {
  try {
    const raw = [
      navigator.userAgent,
      `${screen.width}x${screen.height}`,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      navigator.language,
    ].join('|');
    let h = 5381;
    for (let i = 0; i < raw.length; i++) h = ((h << 5) + h) ^ raw.charCodeAt(i);
    return (h >>> 0).toString(16);
  } catch {
    return 'anon';
  }
}

function _scope(userId) {
  return userId || _deviceId();
}

// ── localStorage helpers ───────────────────────────────────────────────────────

function _rlKey(action, userId) {
  return `${RL_PREFIX}${_scope(userId)}_${action}`;
}

function _boKey(action, userId) {
  return `${BO_PREFIX}${_scope(userId)}_${action}`;
}

function _readTs(key) {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function _writeTs(key, arr) {
  try {
    localStorage.setItem(key, JSON.stringify(arr));
  } catch {
    // Private mode or storage quota — silently skip. Backend is the hard limit.
  }
}

function _readBackoff(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw
      ? JSON.parse(raw)
      : { violations: 0, lockedUntil: 0, firstViolationAt: 0 };
  } catch {
    return { violations: 0, lockedUntil: 0, firstViolationAt: 0 };
  }
}

function _writeBackoff(key, state) {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

// ── Backoff escalation ─────────────────────────────────────────────────────────

function _escalate(boKey, now) {
  const s = _readBackoff(boKey);
  const violations = s.violations + 1;
  const penalty = Math.min(
    BACKOFF_BASE_MS * Math.pow(2, violations - 1),
    BACKOFF_MAX_MS,
  );
  _writeBackoff(boKey, {
    violations,
    lockedUntil:      now + penalty,
    firstViolationAt: s.firstViolationAt || now,
  });
}

// ── Core API ───────────────────────────────────────────────────────────────────

/**
 * Check whether the action is within its rate limit right now.
 * Does NOT consume a slot — call record() after the action succeeds.
 *
 * @param {string}      action   Key from ACTIONS (e.g. 'BOOKING_CREATE')
 * @param {string|null} [userId] Firebase UID — falls back to device fingerprint
 * @returns {{ allowed: boolean, waitMs: number, remaining: number }}
 */
export function check(action, userId = null) {
  const config = ACTIONS[action];
  if (!config) return { allowed: true, waitMs: 0, remaining: 999 };

  const now = Date.now();

  // ── Exponential backoff lock ─────────────────────────────────────────────
  if (config.backoff) {
    const boKey = _boKey(action, userId);
    const bo    = _readBackoff(boKey);

    // Auto-reset stale violation state after the reset window
    if (
      bo.violations > 0 &&
      bo.firstViolationAt > 0 &&
      now - bo.firstViolationAt > VIOLATION_RESET_MS &&
      now > bo.lockedUntil
    ) {
      _writeBackoff(boKey, { violations: 0, lockedUntil: 0, firstViolationAt: 0 });
    } else if (now < bo.lockedUntil) {
      return { allowed: false, waitMs: bo.lockedUntil - now, remaining: 0 };
    }
  }

  // ── Sliding window ───────────────────────────────────────────────────────
  const rlKey       = _rlKey(action, userId);
  const windowStart = now - config.windowMs;
  const valid       = _readTs(rlKey).filter(ts => ts > windowStart);

  if (valid.length >= config.maxRequests) {
    const oldestTs = Math.min(...valid);
    const waitMs   = Math.max(1_000, (oldestTs + config.windowMs) - now);

    // Escalate to backoff for actions that support it
    if (config.backoff) _escalate(_boKey(action, userId), now);

    return { allowed: false, waitMs, remaining: 0 };
  }

  return { allowed: true, waitMs: 0, remaining: config.maxRequests - valid.length };
}

/**
 * Record a submitted action (consumes one slot in the sliding window).
 * Call AFTER the action has been sent, not before.
 *
 * @param {string}      action
 * @param {string|null} [userId]
 */
export function record(action, userId = null) {
  const config = ACTIONS[action];
  if (!config) return;

  const rlKey       = _rlKey(action, userId);
  const now         = Date.now();
  const windowStart = now - config.windowMs;
  const valid       = _readTs(rlKey).filter(ts => ts > windowStart);
  valid.push(now);
  _writeTs(rlKey, valid);
}

/**
 * Atomically check + record if allowed.
 * Preferred over separate check() / record() calls.
 *
 * @param {string}      action
 * @param {string|null} [userId]
 * @returns {{ allowed: boolean, waitMs: number, remaining: number }}
 */
export function checkAndRecord(action, userId = null) {
  const result = check(action, userId);
  if (result.allowed) record(action, userId);
  return result;
}

/**
 * Clear all rate-limit state for an action.
 * Intended for admin override flows or automated tests.
 */
export function reset(action, userId = null) {
  try {
    localStorage.removeItem(_rlKey(action, userId));
    localStorage.removeItem(_boKey(action, userId));
  } catch {
    /* ignore */
  }
}

// ── UX helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert milliseconds into a user-readable wait string.
 * Examples: "45 seconds", "2 minutes", "1 min 30 sec"
 */
export function formatWait(ms) {
  const totalSec = Math.ceil(ms / 1_000);
  if (totalSec < 60) return `${totalSec} second${totalSec !== 1 ? 's' : ''}`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (secs === 0) return `${mins} minute${mins !== 1 ? 's' : ''}`;
  return `${mins} min ${secs} sec`;
}

/**
 * Show a user-friendly rate-limit toast. Does not expose internal limits or
 * action names — only shows the wait time and a friendly explanation.
 *
 * @param {number} waitMs                                  Time until the action is available again
 * @param {'payment'|'booking'|'auth'|'general'} [context] Determines the message wording
 */
export function showRateLimitToast(waitMs, context = 'general') {
  const wait = formatWait(waitMs);
  const messages = {
    payment: `Too many payment requests. Please wait ${wait} before trying again.`,
    booking: `Too many booking requests. Please wait ${wait} before trying again.`,
    auth:    `Too many attempts. Please wait ${wait} before trying again.`,
    general: `You're going too fast. Please wait ${wait} before trying again.`,
  };
  const msg = messages[context] ?? messages.general;
  // Keep toast visible for at least 5 s but never longer than 10 s
  showToast(msg, 'error', { dismissMs: Math.max(5_000, Math.min(waitMs, 10_000)) });
}
