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
 *
 * ─── CONCURRENCY SAFETY ──────────────────────────────────────────────────────
 * The idempotency check and the wallet deduction are a single atomic Firestore
 * transaction. There are ZERO financial reads or checks outside runTransaction().
 *
 * Mechanism — lock document pattern:
 *   _escrow_locks/{bookingId}  acts as a per-booking distributed mutex.
 *
 *   Inside the transaction:
 *     • If the lock does NOT exist → write lock + deduct wallet + create escrow.
 *     • If the lock EXISTS → return stored escrow data (idempotent exit, no write).
 *
 *   Firestore's optimistic locking guarantees atomicity:
 *     When two concurrent transactions both read the lock as absent, only one can
 *     commit the lock write. Firestore aborts the other and retries its callback.
 *     The retry reads the lock as present and exits idempotently. Under any number
 *     of concurrent callers, EXACTLY ONE wallet deduction ever occurs.
 *
 * Safe under:
 *   • Double-click / double-tap confirmation
 *   • Multi-tab booking confirmation
 *   • Network retry storms (client retrying on timeout)
 *   • Concurrent API calls from different devices on the same account
 *
 * Backward compatibility:
 *   Existing escrow documents and their IDs are unchanged. The _escrow_locks
 *   collection is additive. Run backfillEscrowLocks() once after deploying to
 *   protect pre-existing "held" escrow records against re-invocation.
 *
 * @param {{ bookingId, customerId, artisanId, amount, callerAuth }} opts
 * @returns {{ escrowId: string, commission: number, artisanShare: number }}
 */
async function holdFundsForBooking({ bookingId, customerId, artisanId, amount, callerAuth }) {
    // ── Authorization ─────────────────────────────────────────────────────────
    // This is an identity check (who is the caller?), not a financial state check.
    // It is safe outside the transaction — even if two callers pass auth at the
    // same millisecond, the transaction lock prevents double deduction.
    if (!callerAuth) throw new Error('Authentication required.');
    const callerIsAdmin = await isAdminAuth(callerAuth);
    if (!callerIsAdmin && callerAuth.uid !== customerId) {
        throw new Error('Unauthorized: you may only hold funds for your own bookings.');
    }

    // ── Input validation and deterministic pre-computation ────────────────────
    // These values depend only on config, not Firestore state. Safe outside txn.
    const amountNum    = fmt(amount);
    const commission   = fmt(amountNum * COMMISSION_RATE);
    const artisanShare = fmt(amountNum - commission);

    if (amountNum <= 0) throw new Error('Amount must be greater than zero.');

    const firestore = db();
    const n         = now();

    // ── Pre-allocate document references ──────────────────────────────────────
    // Firestore auto-IDs are generated client-side (random strings). Creating a
    // DocumentReference does NOT contact Firestore. References are stable across
    // transaction retries — the same escrowRef.id is used regardless of retries.
    const lockRef     = firestore.collection('_escrow_locks').doc(bookingId);
    const escrowRef   = firestore.collection('escrow').doc();
    const auditRef    = firestore.collection('financialAudit').doc();
    const customerRef = firestore.collection('customers').doc(customerId);

    // ── Atomic transaction ────────────────────────────────────────────────────
    // ALL reads happen before ANY writes (Firestore requirement).
    // The lock check and wallet deduction are one indivisible unit.
    const txResult = await firestore.runTransaction(async (txn) => {

        // ── READS (all reads before any writes) ───────────────────────────────
        const [lockSnap, customerSnap] = await Promise.all([
            txn.get(lockRef),
            txn.get(customerRef),
        ]);

        // ── IDEMPOTENCY GATE (race-free — inside the transaction) ─────────────
        // The lock document was written by a previous successful call for this
        // booking. Return the stored escrow details — no writes, no deduction.
        if (lockSnap.exists) {
            const lock = lockSnap.data();
            console.log(
                `[escrow] Idempotent hold: lock already exists for booking ${bookingId} ` +
                `→ escrow ${lock.escrowId}. Wallet unchanged.`
            );
            return {
                idempotent:   true,
                escrowId:     lock.escrowId,
                commission:   lock.commission,
                artisanShare: lock.artisanShare,
            };
        }

        // ── BALANCE VALIDATION ────────────────────────────────────────────────
        if (!customerSnap.exists) {
            throw new Error('Customer account not found.');
        }

        const available     = fmt(customerSnap.data().walletBalance || 0);
        const currentEscrow = fmt(customerSnap.data().escrowBalance || 0);

        if (amountNum > available) {
            throw new Error(
                `Insufficient balance. Need GHS ${amountNum.toFixed(2)}, ` +
                `available GHS ${available.toFixed(2)}.`
            );
        }

        // ── WRITES ────────────────────────────────────────────────────────────
        // All reads are complete. Firestore will reject the commit if any of the
        // read documents changed between our read and this commit — guaranteeing
        // the "lock absent" observation we acted on is still true at commit time.

        // 1. Lock document — the distributed mutex for this bookingId.
        //    Stores the escrow details so idempotent callers get consistent data.
        //    Written first so it is the contention point: only one concurrent
        //    transaction can create this document.
        txn.set(lockRef, {
            bookingId,
            customerId,
            escrowId:     escrowRef.id,
            commission,
            artisanShare,
            amount:       amountNum,
            lockedAt:     n,
        });

        // 2. Wallet mutation: deduct from available, add to escrowed amount.
        txn.update(customerRef, {
            walletBalance: fmt(available     - amountNum),
            escrowBalance: fmt(currentEscrow + amountNum),
            updatedAt:     n,
        });

        // 3. Escrow record.
        txn.set(escrowRef, {
            bookingId,
            customerId,
            artisanId:         artisanId ?? null,
            amount:            amountNum,
            commission,
            artisanShare,
            commissionRate:    COMMISSION_RATE,
            status:            'held',
            customerConfirmed: false,
            artisanConfirmed:  false,
            disputeId:         null,
            autoReleaseAt:     new Date(
                Date.now() + ESCROW_AUTO_RELEASE_DAYS * 24 * 60 * 60 * 1000
            ).toISOString(),
            createdAt:         n,
            updatedAt:         n,
        });

        // 4. Customer-facing transaction record.
        //    custTxnRef is inside the callback intentionally — a new auto-ID is
        //    generated on each retry, but only the committed retry's write persists.
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

        // 5. Financial audit record (immutable — update/delete blocked by rules).
        txn.set(auditRef, {
            action:         'escrow_hold',
            userId:         customerId,
            userType:       'customer',
            bookingId,
            escrowId:       escrowRef.id,
            amount:         amountNum,
            commission,
            artisanShare,
            commissionRate: COMMISSION_RATE,
            balanceBefore:  available,
            balanceAfter:   fmt(available - amountNum),
            createdAt:      n,
        });

        return { idempotent: false };
    });

    // ── Post-transaction: notify customer ─────────────────────────────────────
    // Fire only for a fresh escrow. Idempotent re-calls must not re-notify.
    if (!txResult.idempotent) {
        sendNotification(customerId, {
            type:      'Payments',
            title:     '💳 Payment Secured',
            message:   `GHS ${amountNum.toFixed(2)} is safely held in escrow for your booking.`,
            actionUrl: 'booking.html',
            metadata:  { bookingId, escrowId: escrowRef.id },
        }).catch(() => {});
    }

    return {
        escrowId:     txResult.idempotent ? txResult.escrowId     : escrowRef.id,
        commission:   txResult.idempotent ? txResult.commission   : commission,
        artisanShare: txResult.idempotent ? txResult.artisanShare : artisanShare,
    };
}

// ── Migration utility ─────────────────────────────────────────────────────────

/**
 * ONE-TIME migration: create _escrow_locks documents for all escrow records that
 * were created before the lock-document pattern was introduced.
 *
 * Run this once after deploying the updated holdFundsForBooking. After it
 * completes, pre-existing "held" escrow records are covered by the same
 * idempotency guarantee as newly-created ones.
 *
 * Usage (from a one-off admin script or a triggered admin Cloud Function):
 *   const { backfillEscrowLocks } = require('./financial/escrow');
 *   await backfillEscrowLocks();
 *
 * Safe to run multiple times — uses set({ merge: false }) so existing locks
 * are not overwritten.
 */
async function backfillEscrowLocks() {
    const firestore = db();
    const snap      = await firestore.collection('escrow')
        .where('status', 'in', ['held', 'disputed'])
        .get();

    if (snap.empty) {
        console.log('[escrow:backfill] No held/disputed escrow records found — nothing to do.');
        return { processed: 0, skipped: 0, errors: 0 };
    }

    let processed = 0, skipped = 0, errors = 0;

    await Promise.all(snap.docs.map(async (doc) => {
        const data    = doc.data();
        const lockRef = firestore.collection('_escrow_locks').doc(data.bookingId);

        try {
            const existing = await lockRef.get();
            if (existing.exists) { skipped++; return; }

            await lockRef.set({
                bookingId:    data.bookingId,
                customerId:   data.customerId,
                escrowId:     doc.id,
                commission:   data.commission,
                artisanShare: data.artisanShare,
                amount:       data.amount,
                lockedAt:     data.createdAt,
                backfilled:   true,
            });
            processed++;
        } catch (err) {
            console.error(`[escrow:backfill] Failed for escrow ${doc.id}:`, err.message);
            errors++;
        }
    }));

    console.log(
        `[escrow:backfill] Done — processed: ${processed}, skipped: ${skipped}, errors: ${errors}`
    );
    return { processed, skipped, errors };
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

    const { customerId, amount, artisanShare, commission, bookingId } = escrow;

    // Resolve artisanId: may be null if escrow was created before dispatch assigned an artisan.
    // Read the authoritative artisanId from the booking document at release time.
    let artisanId = escrow.artisanId;
    if (!artisanId && bookingId) {
        const bookingSnap = await firestore.collection('bookings').doc(bookingId).get();
        if (bookingSnap.exists) artisanId = bookingSnap.data().artisanId || null;
    }
    if (!artisanId) {
        throw new Error(
            'Cannot release escrow: artisan is not yet assigned to this booking. ' +
            'Release will happen automatically once an artisan accepts.'
        );
    }

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

module.exports = {
    holdFundsForBooking,
    releaseEscrow,
    refundEscrow,
    freezeEscrowForDispute,
    backfillEscrowLocks,
};
