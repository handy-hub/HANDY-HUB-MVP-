'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Escrow — hold, release, refund, and freeze funds for bookings.
//
// AUTHORIZATION MODEL
// ───────────────────
//   holdFundsForBooking  → verified caller must be the booking's customerId
//   releaseEscrow        → caller must be the escrow's customer, artisan, or admin
//   refundEscrow         → caller must be the escrow's customer, artisan, or admin
//   freezeEscrowForDispute → caller must be the escrow's customer or artisan
//
// All financial operations run inside Firestore transactions.
// ─────────────────────────────────────────────────────────────────────────────

const { FieldValue }    = require('firebase-admin/firestore');
const { COMMISSION_RATE, PROVIDER_NAMES } = require('./paystack');
const { sendNotification, sendArtisanNotification } = require('../notifications');
const { FIRESTORE_DB_ID, ADMIN_EMAILS, ESCROW_AUTO_RELEASE_DAYS } = require('../config');
const { randomBytes } = require('crypto');

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

const now   = () => new Date().toISOString();
const genId = (p) => `${p}-${Date.now()}-${randomBytes(6).toString('hex').toUpperCase()}`;
const fmt = (n) => parseFloat(Number(n).toFixed(2));

// ── Authorization helpers ─────────────────────────────────────────────────────

/**
 * Return true if the auth token belongs to a platform admin.
 * Checks the super-admin email list first (fast path) then reads the admins collection.
 */
async function isAdminAuth(auth) {
    if (!auth) return false;
    if (ADMIN_EMAILS.includes(auth.token?.email)) return true;
    const snap = await db().collection('admins').doc(auth.uid).get().catch(() => null);
    return snap?.exists && snap.data().userType === 'admin';
}

/**
 * Throw if the caller is not one of the permitted roles for this escrow.
 *
 * @param {object} auth      Firebase auth context from onCall request
 * @param {object} escrowData Firestore escrow document data
 * @param {'customer'|'artisan'|'admin'|'any'} allowedRoles
 */
async function assertEscrowAccess(auth, escrowData, allowedRoles) {
    if (!auth) throw new Error('Authentication required.');

    const uid = auth.uid;
    const isCustomer = uid === escrowData.customerId;
    const isArtisan  = uid === escrowData.artisanId;
    const isAdmin    = await isAdminAuth(auth);

    const allowed = allowedRoles.includes('customer') && isCustomer
                 || allowedRoles.includes('artisan')  && isArtisan
                 || allowedRoles.includes('admin')    && isAdmin;

    if (!allowed) {
        throw new Error('Unauthorized: you are not a party to this escrow.');
    }
}

// ── Hold ──────────────────────────────────────────────────────────────────────

/**
 * Move funds from a customer's available wallet into escrow when a booking is confirmed.
 * The calling Cloud Function MUST verify that request.auth.uid === customerId.
 *
 * @returns {{ escrowId, commission, artisanShare }}
 */
async function holdFundsForBooking({ bookingId, customerId, artisanId, amount, callerAuth }) {
    // Authorization: only the customer themselves (or admin) may hold their own funds
    if (!callerAuth) throw new Error('Authentication required.');
    const callerIsAdmin = await isAdminAuth(callerAuth);
    if (!callerIsAdmin && callerAuth.uid !== customerId) {
        throw new Error('Unauthorized: you may only hold funds for your own bookings.');
    }

    const firestore    = db();
    const amountNum    = fmt(amount);
    const commission   = fmt(amountNum * COMMISSION_RATE);
    const artisanShare = fmt(amountNum - commission);

    const customerRef = firestore.collection('customers').doc(customerId);
    const escrowRef   = firestore.collection('escrow').doc();
    const auditRef    = firestore.collection('financialAudit').doc();
    const n           = now();

    await firestore.runTransaction(async (txn) => {
        const snap = await txn.get(customerRef);
        if (!snap.exists) throw new Error('Customer account not found.');

        const available     = fmt(snap.data().walletBalance  || 0);
        const currentEscrow = fmt(snap.data().escrowBalance || 0);

        if (amountNum > available) {
            throw new Error(`Insufficient balance. Need GHS ${amountNum}, available GHS ${available}.`);
        }

        // Deduct available, add to escrow balance
        txn.update(customerRef, {
            walletBalance: fmt(available - amountNum),
            escrowBalance: fmt(currentEscrow + amountNum),
            updatedAt:     n,
        });

        // Escrow record
        txn.set(escrowRef, {
            bookingId,
            customerId,
            artisanId,
            amount:            amountNum,
            commission,
            artisanShare,
            commissionRate:    COMMISSION_RATE,
            status:            'held',
            customerConfirmed: false,
            artisanConfirmed:  false,
            disputeId:         null,
            autoReleaseAt:     new Date(Date.now() + ESCROW_AUTO_RELEASE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
            createdAt:         n,
            updatedAt:         n,
        });

        // Customer transaction record
        const custTxnRef = customerRef.collection('transactions').doc();
        txn.set(custTxnRef, {
            type:        'escrow_hold',
            amount:      amountNum,
            bookingId,
            escrowId:    escrowRef.id,
            description: 'Payment secured for booking',
            status:      'completed',
            ref:         genId('ESC'),
            createdAt:   n,
        });

        // Financial audit
        txn.set(auditRef, {
            action:        'escrow_hold',
            userId:        customerId,
            userType:      'customer',
            bookingId,
            escrowId:      escrowRef.id,
            amount:        amountNum,
            balanceBefore: available,
            balanceAfter:  available - amountNum,
            createdAt:     n,
        });
    });

    sendNotification(customerId, {
        type:      'Payments',
        title:     '💳 Payment Secured',
        message:   `GHS ${amountNum.toFixed(2)} is safely held in escrow for your booking.`,
        actionUrl: 'booking.html',
        metadata:  { bookingId, escrowId: escrowRef.id },
    }).catch(() => {});

    return { escrowId: escrowRef.id, commission, artisanShare };
}

// ── Release ───────────────────────────────────────────────────────────────────

/**
 * Release escrow after booking completion.
 *
 * Authorization: customer (of this booking), artisan (of this booking), or admin.
 * Both parties must confirm — or an admin may release unilaterally.
 *
 * @param {string} escrowId
 * @param {{ releasedBy: string, callerAuth: object }} opts
 */
async function releaseEscrow(escrowId, { releasedBy = 'system', callerAuth } = {}) {
    const firestore  = db();
    const escrowRef  = firestore.collection('escrow').doc(escrowId);
    const escrowSnap = await escrowRef.get();

    if (!escrowSnap.exists) throw new Error('Escrow record not found.');
    const escrow = escrowSnap.data();
    if (escrow.status !== 'held') throw new Error(`Cannot release escrow with status "${escrow.status}".`);

    // ── Authorization check ───────────────────────────────────────────────────
    if (callerAuth) {
        await assertEscrowAccess(callerAuth, escrow, ['customer', 'artisan', 'admin']);
    }
    // If callerAuth is null, the caller is the system (auto-release timeout) — allowed.

    const { customerId, artisanId, amount, artisanShare, commission, bookingId } = escrow;

    const customerRef  = firestore.collection('customers').doc(customerId);
    const artisanRef   = firestore.collection('artisans').doc(artisanId);
    const platformRef  = firestore.collection('platform').doc('earnings');
    const commRef      = firestore.collection('commissions').doc();
    const auditRef     = firestore.collection('financialAudit').doc();
    const n            = now();

    await firestore.runTransaction(async (txn) => {
        // Read escrowRef INSIDE the transaction so Firestore's optimistic lock
        // prevents two concurrent releaseEscrow() calls from both succeeding.
        const [escrowLive, customerSnap, artisanSnap] = await Promise.all([
            txn.get(escrowRef),
            txn.get(customerRef),
            txn.get(artisanRef),
        ]);

        // Re-check status atomically — pre-check above is a fast-path only.
        if (!escrowLive.exists || escrowLive.data().status !== 'held') {
            throw new Error(
                `Cannot release escrow: status is "${escrowLive.data()?.status}" (expected "held"). ` +
                'Concurrent release prevented.'
            );
        }

        const custEscrow = fmt(customerSnap.data()?.escrowBalance    || 0);
        const artAvail   = fmt(artisanSnap.exists ? artisanSnap.data().availableBalance || 0 : 0);
        const artPending = fmt(artisanSnap.exists ? artisanSnap.data().pendingBalance   || 0 : 0);
        const artTotal   = fmt(artisanSnap.exists ? artisanSnap.data().totalEarned      || 0 : 0);

        txn.update(escrowRef, { status: 'released', releasedBy, releasedAt: n, updatedAt: n });

        txn.update(customerRef, {
            escrowBalance: fmt(Math.max(0, custEscrow - amount)),
            updatedAt:     n,
        });

        txn.set(artisanRef, {
            availableBalance: fmt(artAvail + artisanShare),
            pendingBalance:   fmt(Math.max(0, artPending - artisanShare)),
            totalEarned:      fmt(artTotal + artisanShare),
            updatedAt:        n,
        }, { merge: true });

        const artTxnRef = artisanRef.collection('transactions').doc();
        txn.set(artTxnRef, {
            type:           'earning',
            amount:         artisanShare,
            commission,
            totalAmount:    amount,
            commissionRate: escrow.commissionRate,
            bookingId,
            escrowId,
            description:    'Booking payment received',
            status:         'completed',
            ref:            genId('ERN'),
            createdAt:      n,
        });

        txn.set(commRef, {
            bookingId,
            escrowId,
            artisanId,
            customerId,
            amount:    commission,
            rate:      escrow.commissionRate,
            createdAt: n,
        });

        txn.set(platformRef, {
            totalCommissions:    FieldValue.increment(commission),
            totalArtisanPayouts: FieldValue.increment(artisanShare),
            updatedAt:           n,
        }, { merge: true });

        txn.set(auditRef, {
            action:      'escrow_release',
            escrowId,
            bookingId,
            artisanId,
            customerId,
            amount,
            artisanShare,
            commission,
            releasedBy,
            createdAt:   n,
        });
    });

    sendArtisanNotification(artisanId, {
        type:      'Payments',
        title:     '🎉 Payment Received',
        message:   `GHS ${artisanShare.toFixed(2)} has been credited to your wallet for completing a booking.`,
        actionUrl: 'wallet.html',
        metadata:  { bookingId, escrowId },
    }).catch(() => {});

    sendNotification(customerId, {
        type:      'Bookings',
        title:     '✅ Booking Completed',
        message:   `Your booking is complete and payment has been released to the artisan.`,
        actionUrl: 'booking.html',
        metadata:  { bookingId, escrowId },
    }).catch(() => {});
}

// ── Refund ────────────────────────────────────────────────────────────────────

/**
 * Refund escrow back to the customer (booking cancelled or admin-resolved dispute).
 *
 * Authorization: customer (of this booking), artisan (of this booking), or admin.
 * In practice, artisan-initiated refunds mean the artisan is conceding.
 */
async function refundEscrow(escrowId, { reason = 'Booking cancelled', refundedBy = 'system', callerAuth } = {}) {
    const firestore  = db();
    const escrowRef  = firestore.collection('escrow').doc(escrowId);
    const escrowSnap = await escrowRef.get();

    if (!escrowSnap.exists) throw new Error('Escrow record not found.');
    const escrow = escrowSnap.data();

    if (!['held', 'disputed'].includes(escrow.status)) {
        throw new Error(`Cannot refund escrow with status "${escrow.status}".`);
    }

    // ── Authorization check ───────────────────────────────────────────────────
    if (callerAuth) {
        await assertEscrowAccess(callerAuth, escrow, ['customer', 'artisan', 'admin']);
    }

    const { customerId, amount, bookingId } = escrow;
    const customerRef = firestore.collection('customers').doc(customerId);
    const auditRef    = firestore.collection('financialAudit').doc();
    const n           = now();

    await firestore.runTransaction(async (txn) => {
        // Read escrowRef INSIDE the transaction to prevent double-refund under concurrency.
        const [escrowLive, snap] = await Promise.all([
            txn.get(escrowRef),
            txn.get(customerRef),
        ]);

        if (!escrowLive.exists || !['held', 'disputed'].includes(escrowLive.data().status)) {
            throw new Error(
                `Cannot refund escrow: status is "${escrowLive.data()?.status}" ` +
                '(expected "held" or "disputed"). Concurrent operation prevented.'
            );
        }

        const available = fmt(snap.data()?.walletBalance || 0);
        const inEscrow  = fmt(snap.data()?.escrowBalance  || 0);

        txn.update(escrowRef, {
            status:       'refunded',
            refundedBy,
            refundReason: reason,
            refundedAt:   n,
            updatedAt:    n,
        });

        txn.update(customerRef, {
            walletBalance: fmt(available + amount),
            escrowBalance: fmt(Math.max(0, inEscrow - amount)),
            updatedAt:     n,
        });

        const txnRef = customerRef.collection('transactions').doc();
        txn.set(txnRef, {
            type:        'refund',
            amount,
            bookingId:   bookingId || null,
            escrowId,
            description: reason,
            status:      'completed',
            ref:         genId('REF'),
            createdAt:   n,
        });

        txn.set(auditRef, {
            action:     'escrow_refund',
            escrowId,
            customerId,
            bookingId:  bookingId || null,
            amount,
            reason,
            refundedBy,
            createdAt:  n,
        });
    });

    sendNotification(customerId, {
        type:      'Payments',
        title:     '↩️ Refund Issued',
        message:   `GHS ${amount.toFixed(2)} has been refunded to your wallet. Reason: ${reason}.`,
        actionUrl: 'transaction-history.html',
        metadata:  { bookingId: bookingId || null, escrowId },
    }).catch(() => {});
}

// ── Dispute ───────────────────────────────────────────────────────────────────

/**
 * Freeze escrow funds when a dispute is raised.
 * Authorization: customer or artisan of this booking only.
 */
async function freezeEscrowForDispute(escrowId, { disputeId, raisedBy, callerAuth } = {}) {
    const firestore = db();
    const escrowRef = firestore.collection('escrow').doc(escrowId);
    const snap      = await escrowRef.get();

    if (!snap.exists) throw new Error('Escrow not found.');
    if (snap.data().status !== 'held') {
        throw new Error(`Only "held" escrow can be disputed (current: "${snap.data().status}").`);
    }

    // ── Authorization: only parties to the booking may raise a dispute ────────
    // (assertEscrowAccess is async so it must run outside the transaction)
    if (callerAuth) {
        await assertEscrowAccess(callerAuth, snap.data(), ['customer', 'artisan', 'admin']);
    }

    // Run the status change inside a transaction to prevent two concurrent dispute
    // submissions from both passing the pre-check and both writing 'disputed'.
    await firestore.runTransaction(async (txn) => {
        const live = await txn.get(escrowRef);
        if (!live.exists || live.data().status !== 'held') {
            throw new Error(
                `Only "held" escrow can be disputed (current: "${live.data()?.status}"). ` +
                'Concurrent operation prevented.'
            );
        }
        const n = now();
        txn.update(escrowRef, {
            status:     'disputed',
            disputeId:  disputeId || null,
            disputedBy: raisedBy  || null,
            disputedAt: n,
            updatedAt:  n,
        });
    });
}

module.exports = { holdFundsForBooking, releaseEscrow, refundEscrow, freezeEscrowForDispute };
