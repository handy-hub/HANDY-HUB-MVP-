'use strict';

/**
 * config.js — Shared configuration for all Cloud Functions.
 *
 * Centralises values that appear in multiple modules so there is a single
 * source of truth. When migrating to a different database or payment provider,
 * only this file needs to change.
 *
 * Runtime values (secrets) come from environment variables set with:
 *   firebase functions:secrets:set PAYSTACK_SECRET_KEY
 *   firebase functions:config:set handyhub.commission_rate=0.15
 *
 * Build-time values are constants below.
 */

// ── Firestore ─────────────────────────────────────────────────────────────────
/** Custom Firestore database ID (not the default '(default)'). */
const FIRESTORE_DB_ID = 'ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6';

// ── Admin access ──────────────────────────────────────────────────────────────
/**
 * Super-admin email whitelist.
 * Keep in sync with:
 *   - firestore.rules  (isSuperAdminEmail function)
 *   - shared/js/config/appConfig.js (SUPER_ADMIN_EMAILS)
 *   - admin-dashboard/js/auth-guard.js (SUPER_ADMIN_EMAILS)
 */
const ADMIN_EMAILS = [
    'silas7korda@gmail.com',
    'clasceth4traders@gmail.com',
    'paakumisam@gmail.com',
];

// ── Business rules ────────────────────────────────────────────────────────────
/** Platform commission rate. Also settable via COMMISSION_RATE env var. */
const COMMISSION_RATE = parseFloat(process.env.COMMISSION_RATE || '0.15');

/** Minimum withdrawal amount in GHS. Also settable via MIN_WITHDRAWAL env var. */
const MIN_WITHDRAWAL = parseFloat(process.env.MIN_WITHDRAWAL || '5');

/** Auto-release escrow after N days if neither party disputes. */
const ESCROW_AUTO_RELEASE_DAYS = 7;

// ── Paystack ──────────────────────────────────────────────────────────────────
const PAYSTACK_BASE = 'https://api.paystack.co';

module.exports = {
    FIRESTORE_DB_ID,
    ADMIN_EMAILS,
    COMMISSION_RATE,
    MIN_WITHDRAWAL,
    ESCROW_AUTO_RELEASE_DAYS,
    PAYSTACK_BASE,
};
