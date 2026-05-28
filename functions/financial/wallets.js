'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Wallet — server-side wallet credit logic.
// Called by the Paystack webhook after a verified charge.success event.
//
// IDEMPOTENCY: The entire idempotency check + credit runs inside a single
// Firestore transaction, eliminating the race condition where two concurrent
// webhook deliveries could both pass the "not yet credited" check and then
// both credit the wallet.
//
// Strategy:
//   We use a dedicated "idempotency lock" document (paystackRef as ID) in
//   a `webhookLocks` subcollection.  The Firestore transaction:
//     1. Reads the lock document.
//     2. If it already exists → already credited, return early.
//     3. If absent → write the lock, credit the wallet, record the transaction.
//   Because reads and writes are atomic inside runTransaction, no two
//   concurrent invocations can both pass step 2.
// ─────────────────────────────────────────────────────────────────────────────

const { FIRESTORE_DB_ID } = require('../config');
const { randomBytes }     = require('crypto');

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

const now   = () => new Date().toISOString();
// 6 random bytes → 12 hex chars — collision-safe for all realistic transaction volumes
const genId = (p) => `${p}-${Date.now()}-${randomBytes(6).toString('hex').toUpperCase()}`;
const fmt = (n) => parseFloat(Number(n).toFixed(2));

/**
 * Credit a customer wallet after a verified Paystack charge.
 *
 * Safe to call multiple times for the same reference (fully idempotent).
 * The idempotency check and wallet credit are inside a single Firestore
 * transaction — no double-credit race is possible.
 *
 * @param {object} params
 * @param {string} params.uid         Firebase user UID from metadata
 * @param {number} params.amountGHS   Amount in GHS (already verified against Paystack API)
 * @param {string} params.paystackRef Paystack transaction reference
 * @param {string} [params.provider]  mtn | telecel | airteltigo
 * @param {string} [params.phone]     MoMo phone number
 * @param {string} [params.email]     Customer email
 *
 * @returns {{ credited: boolean, duplicate?: boolean }}
 */
async function creditWalletFromCharge({ uid, amountGHS, paystackRef, provider, phone, email }) {
    const firestore   = db();
    const customerRef = firestore.collection('customers').doc(uid);
    const n           = now();
    const amount      = fmt(amountGHS);

    // ── Idempotency lock document ────────────────────────────────────────────
    // Key: the Paystack reference — unique per charge.
    // We store this at a top-level collection so any future batch queries work.
    const lockRef = firestore.collection('webhookLocks').doc(paystackRef);

    let alreadyCredited = false;
    let txnRef          = null;

    try {
        await firestore.runTransaction(async (txn) => {
            // ── Step 1: Check idempotency lock (inside transaction) ──────────
            const lockSnap = await txn.get(lockRef);
            if (lockSnap.exists) {
                alreadyCredited = true;
                return; // abort the transaction body — no writes
            }

            // ── Step 2: Read current wallet balance (inside transaction) ─────
            const customerSnap = await txn.get(customerRef);
            const prevBal      = fmt(customerSnap.exists ? customerSnap.data().walletBalance || 0 : 0);
            const newBal       = fmt(prevBal + amount);

            // ── Step 3: Write idempotency lock ────────────────────────────────
            txn.set(lockRef, {
                uid,
                paystackRef,
                amountGHS:   amount,
                creditedAt:  n,
            });

            // ── Step 4: Credit wallet ─────────────────────────────────────────
            txn.set(customerRef, { walletBalance: newBal, updatedAt: n }, { merge: true });

            // ── Step 5: Check for existing pending transaction to upgrade ─────
            // NOTE: We cannot do a collection query inside a Firestore transaction.
            // Instead we look up by predictable doc structure (handled below, outside txn).
            // The lock above is the authoritative idempotency guard.

            // ── Step 6: Create transaction record ─────────────────────────────
            const newTxnRef = customerRef.collection('transactions').doc();
            txnRef = newTxnRef.id;
            txn.set(newTxnRef, {
                type:        'topup',
                amount,
                provider:    provider || null,
                phone:       phone    || null,
                email:       email    || null,
                description: `Wallet top-up via ${provider || 'Paystack'}`,
                status:      'successful',
                ref:         genId('TP'),
                paystackRef,
                bookingId:   null,
                source:      'webhook',
                createdAt:   n,
            });

            // ── Step 7: Audit log ─────────────────────────────────────────────
            const auditDocRef = firestore.collection('financialAudit').doc();
            txn.set(auditDocRef, {
                action:        'wallet_credit',
                userId:        uid,
                userType:      'customer',
                amount,
                balanceBefore: prevBal,
                balanceAfter:  newBal,
                paystackRef,
                source:        'webhook',
                createdAt:     n,
            });
        });
    } catch (txnErr) {
        // Firestore transactions retry on contention — if it ultimately fails, rethrow
        // so the webhook handler logs the error. Paystack will retry the webhook.
        console.error(`[wallet] Transaction failed for ref "${paystackRef}":`, txnErr.message);
        throw txnErr;
    }

    if (alreadyCredited) {
        console.log(`[wallet] Ref "${paystackRef}" already credited (uid: ${uid}) — skipped (idempotent).`);
        return { credited: false, duplicate: true };
    }

    // ── Post-transaction: mark any pre-existing "pending" client record as upgraded ──
    // This is cosmetic — the actual credit happened in the transaction above.
    // We do this outside the transaction because Firestore doesn't allow collection
    // group queries inside transactions.
    try {
        const pendingQuery = await customerRef
            .collection('transactions')
            .where('paystackRef', '==', paystackRef)
            .where('status', '==', 'pending')
            .limit(1)
            .get();

        if (!pendingQuery.empty) {
            await pendingQuery.docs[0].ref.update({
                status:    'successful',
                source:    'webhook',
                updatedAt: n,
                note:      'upgraded from pending; credit was recorded atomically',
            });
        }
    } catch (cleanupErr) {
        // Non-critical: only a cosmetic update
        console.warn(`[wallet] Could not upgrade pending tx for ref "${paystackRef}":`, cleanupErr.message);
    }

    console.log(`[wallet] Wallet credited: uid=${uid} +GHS ${amount} ref=${paystackRef}`);
    return { credited: true };
}

module.exports = { creditWalletFromCharge };
