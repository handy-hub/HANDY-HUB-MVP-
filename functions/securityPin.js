'use strict';

/**
 * functions/securityPin.js — HandyHub Security PIN (account-level credential)
 *
 * The 4-digit Security PIN authorises financially sensitive customer actions
 * (wallet top-ups now; withdrawals and payout changes later). It is bound to
 * the authenticated Firebase UID — never to a phone number — and is NOT the
 * customer's Mobile Money PIN, a Paystack OTP, or the Firebase password.
 *
 * Storage model (two documents, different trust levels):
 *   customers/{uid}            — SAFE metadata only, readable by the owner:
 *                                securityPinConfigured / CreatedAt / UpdatedAt / Version.
 *                                Clients cannot write these (profile-update allowlist).
 *   payment_security/{uid}     — SENSITIVE material, Admin-SDK ONLY (rules: false):
 *                                pinHash, salt, algorithm, params, version,
 *                                failedAttempts, lockedUntil, lastVerifiedAt.
 *
 * Security properties (mirrors the emailOtp.js discipline):
 *   • scrypt (memory-hard, built into Node — no native deps) with a per-user
 *     16-byte random salt AND a server-side pepper from env secrets, so a
 *     Firestore leak alone cannot be brute-forced offline (10k keyspace).
 *   • crypto.timingSafeEqual — constant-time comparison.
 *   • The raw PIN, hash, salt, and pepper are NEVER logged or returned.
 *   • Escalating server-side lockout: 5 fails → 15 min, 10 → 1 h, 15 → 24 h.
 *   • verifySecurityPinForCharge is an INTERNAL helper for trusted operations
 *     (initiateTopupCharge etc.) — deliberately NOT exported as a callable,
 *     because a standalone verify endpoint would be a brute-force oracle.
 *   • Weak-PIN deny list at creation (repeats + trivial sequences).
 */

const crypto = require('crypto');
const { promisify } = require('util');
const { getFirestore } = require('firebase-admin/firestore');
const { HttpsError } = require('firebase-functions/v2/https');
const { FIRESTORE_DB_ID } = require('./config');

const scrypt = promisify(crypto.scrypt);

// ── Lazy singleton ────────────────────────────────────────────────────────────
let _db;
function db() {
    if (!_db) _db = getFirestore(FIRESTORE_DB_ID);
    return _db;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const COL_SECURITY = 'payment_security';
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };   // ~16 MiB — fits default maxmem
const KEYLEN = 64;
const PIN_RE = /^\d{4}$/;

// Trivial PINs an attacker tries first — rejected at creation.
const WEAK_PINS = new Set([
    '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
    '1234', '4321', '0123', '3210', '2580', '0852',
]);

// Escalating lockout: [failedAttempts threshold, lock duration ms]
const LOCK_TIERS = [
    [15, 24 * 60 * 60 * 1000],   // 15+ fails → 24 h
    [10, 60 * 60 * 1000],        // 10+ fails → 1 h
    [5, 15 * 60 * 1000],         // 5+ fails → 15 min
];

function nowIso() { return new Date().toISOString(); }

function cid() {
    return `PIN-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function pepper() {
    const p = process.env.PIN_PEPPER || '';
    if (!p || p.length < 32) {
        // Refuse to run half-configured — a pepperless hash of a 4-digit PIN is
        // trivially brute-forceable offline if Firestore ever leaks.
        console.error('[securityPin] PIN_PEPPER missing/short — service not configured.');
        throw new HttpsError('internal', 'Security PIN service is not available right now.');
    }
    return p;
}

async function hashPin(pin, saltHex) {
    const derived = await scrypt(`${pepper()}:${pin}`, Buffer.from(saltHex, 'hex'), KEYLEN, SCRYPT_PARAMS);
    return derived.toString('hex');
}

function constantTimeEqualHex(aHex, bHex) {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function lockDurationFor(failedAttempts) {
    for (const [threshold, ms] of LOCK_TIERS) {
        if (failedAttempts >= threshold) return ms;
    }
    return 0;
}

// Fire-and-forget immutable audit trail (financialAudit is update/delete: false).
function audit(type, userId, detail, correlationId) {
    db().collection('financialAudit').add({
        type,
        userId,
        detail: String(detail || '').slice(0, 300),
        correlationId,
        createdAt: nowIso(),
    }).catch(() => { /* audit must never block the operation */ });
}

// ─────────────────────────────────────────────────────────────────────────────
// setSecurityPin — create the account-level PIN (first-time setup)
//
// Called by: customer app (top-up first-run, Settings → Create Security PIN)
// Payload:   { pin } — 4-digit string; validated, hashed, never persisted raw.
// Returns:   { configured: true }
// Rejects:   already-exists when a PIN is configured (Change PIN is a separate,
//            current-PIN-gated flow in a later phase).
// Heals:     metadata says configured but the protected record is missing
//            (inconsistency is audited, then creation proceeds).
// ─────────────────────────────────────────────────────────────────────────────
async function setSecurityPin(auth, { pin } = {}) {
    const correlationId = cid();
    const uid = auth.uid;

    if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
        throw new HttpsError('invalid-argument', 'PIN must be exactly 4 digits.');
    }
    if (WEAK_PINS.has(pin)) {
        throw new HttpsError('invalid-argument', 'That PIN is too easy to guess. Choose a less predictable one.');
    }

    // Hash OUTSIDE the transaction — scrypt is deliberately slow.
    const salt = crypto.randomBytes(16).toString('hex');
    const pinHash = await hashPin(pin, salt);

    const secRef  = db().collection(COL_SECURITY).doc(uid);
    const custRef = db().collection('customers').doc(uid);
    const n = nowIso();

    let healed = false;
    await db().runTransaction(async (txn) => {
        const [secSnap, custSnap] = await Promise.all([txn.get(secRef), txn.get(custRef)]);

        if (!custSnap.exists) {
            throw new HttpsError('failed-precondition', 'Customer profile not found.');
        }
        if (secSnap.exists && secSnap.data().pinHash) {
            throw new HttpsError('already-exists', 'A Security PIN is already configured.');
        }
        // Inconsistency: metadata claims configured but no protected record.
        // Do not silently continue — record it, then heal by creating fresh.
        if (custSnap.data().securityPinConfigured === true && !secSnap.exists) {
            healed = true;
        }

        txn.set(secRef, {
            pinHash,
            salt,
            algorithm:      'scrypt',
            params:         { ...SCRYPT_PARAMS, keylen: KEYLEN },
            version:        1,
            failedAttempts: 0,
            lockedUntil:    null,
            lastVerifiedAt: null,
            lastResetAt:    null,
            createdAt:      n,
            updatedAt:      n,
        });
        txn.set(custRef, {
            securityPinConfigured: true,
            securityPinCreatedAt:  n,
            securityPinUpdatedAt:  n,
            securityPinVersion:    1,
            updatedAt:             n,
        }, { merge: true });
    });

    if (healed) {
        console.warn(`[securityPin][${correlationId}] Healed metadata/record inconsistency uid=${uid}`);
        audit('security_pin_inconsistency_healed', uid, 'metadata configured=true but protected record missing; recreated', correlationId);
    }
    console.log(`[securityPin][${correlationId}] PIN created uid=${uid}`);
    audit('security_pin_created', uid, 'account security PIN configured', correlationId);

    return { configured: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// verifySecurityPinForCharge — INTERNAL helper, not a callable.
//
// Trusted operations (initiateTopupCharge, withdrawals, payout changes) call
// this INSIDE their own authenticated flow, so PIN verification is never an
// isolated oracle. Enforces escalating lockout transactionally.
//
// Throws HttpsError with safe messages; resolves { ok: true } on success.
// ─────────────────────────────────────────────────────────────────────────────
async function verifySecurityPinForCharge(uid, pin) {
    const correlationId = cid();

    if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
        throw new HttpsError('invalid-argument', 'PIN must be exactly 4 digits.');
    }

    const secRef = db().collection(COL_SECURITY).doc(uid);
    const snap = await secRef.get();

    if (!snap.exists || !snap.data().pinHash) {
        audit('security_pin_missing_on_verify', uid, 'verification requested but no protected record', correlationId);
        throw new HttpsError('failed-precondition', 'Security PIN setup required.');
    }

    const rec = snap.data();
    const now = Date.now();

    if (rec.lockedUntil && new Date(rec.lockedUntil).getTime() > now) {
        throw new HttpsError('resource-exhausted', 'Too many attempts. Try again later.');
    }

    // Slow work outside the transaction.
    const submittedHash = await hashPin(pin, rec.salt);
    const isCorrect = constantTimeEqualHex(submittedHash, rec.pinHash);

    // Record the outcome transactionally so concurrent attempts can't bypass
    // the counter, then re-check lock state inside the transaction.
    const result = await db().runTransaction(async (txn) => {
        const s = await txn.get(secRef);
        if (!s.exists) return { ok: false, reason: 'missing' };
        const d = s.data();

        if (d.lockedUntil && new Date(d.lockedUntil).getTime() > Date.now()) {
            return { ok: false, reason: 'locked' };
        }

        if (isCorrect) {
            txn.update(secRef, {
                failedAttempts: 0,
                lockedUntil:    null,
                lastVerifiedAt: nowIso(),
                updatedAt:      nowIso(),
            });
            return { ok: true };
        }

        const fails = (d.failedAttempts || 0) + 1;
        const lockMs = lockDurationFor(fails);
        txn.update(secRef, {
            failedAttempts: fails,
            lockedUntil:    lockMs ? new Date(Date.now() + lockMs).toISOString() : null,
            updatedAt:      nowIso(),
        });
        return { ok: false, reason: lockMs ? 'now_locked' : 'wrong', fails };
    });

    if (result.ok) {
        console.log(`[securityPin][${correlationId}] PIN verified uid=${uid}`);
        return { ok: true };
    }
    if (result.reason === 'missing') {
        throw new HttpsError('failed-precondition', 'Security PIN setup required.');
    }
    if (result.reason === 'locked' || result.reason === 'now_locked') {
        if (result.reason === 'now_locked') {
            console.warn(`[securityPin][${correlationId}] Lockout engaged uid=${uid} fails=${result.fails}`);
            audit('security_pin_locked', uid, `lockout after ${result.fails} failed attempts`, correlationId);
        }
        throw new HttpsError('resource-exhausted', 'Too many attempts. Try again later.');
    }
    console.warn(`[securityPin][${correlationId}] Wrong PIN uid=${uid} fails=${result.fails}`);
    throw new HttpsError('permission-denied', 'Incorrect PIN.');
}

module.exports = { setSecurityPin, verifySecurityPinForCharge };
