'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// disputes.js — Admin-driven dispute resolution.
//
// resolveDispute() is the single, server-authoritative entry point for closing
// a dispute. It never mutates wallet/escrow balances directly from client
// input — it either delegates to the existing, transactional escrow.js
// primitives (full_refund → refundEscrow, release_artisan → releaseEscrow),
// or, for a partial split, runs its own Firestore transaction following the
// exact same concurrency-safe pattern (re-read escrow status inside the
// transaction, reject if it has moved since the pre-check).
//
// DATA MODEL NOTE: there is currently no code path anywhere in the app that
// creates a "disputes" collection document — disputes exist only as booking
// documents with status === 'Disputed' (set directly today; raiseDispute()/
// freezeEscrowForDispute() exist but nothing calls them yet from the
// frontend). resolveDispute() therefore operates on the booking doc itself
// and finds its escrow via the bookingId join, matching the real, working
// admin-dashboard flow.
//
// AUTHORIZATION: admin only (isAdminAuth). Booking must still be 'Disputed'.
// ─────────────────────────────────────────────────────────────────────────────

const { FieldValue }       = require('firebase-admin/firestore');
const { refundEscrow, releaseEscrow } = require('./financial/escrow');
const { sendNotification, sendArtisanNotification } = require('./notifications');
const { FIRESTORE_DB_ID, ADMIN_EMAILS } = require('./config');
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
const fmt   = (n) => parseFloat(Number(n).toFixed(2));

async function isAdminAuth(auth) {
    if (!auth) return false;
    if (ADMIN_EMAILS.includes(auth.token?.email)) return true;
    const snap = await db().collection('admins').doc(auth.uid).get().catch(() => null);
    return snap?.exists && snap.data().userType === 'admin';
}

const VALID_RESOLUTIONS = new Set(['full_refund', 'release_artisan', 'partial_refund']);

/**
 * resolveDispute — admin closes an open dispute with one of three outcomes.
 *
 * @param {object} auth   Firebase auth context (must be an admin)
 * @param {object} data
 *   @param {string} data.bookingId       Firestore doc ID in "bookings" collection
 *                                        (status must currently be "Disputed")
 *   @param {'full_refund'|'release_artisan'|'partial_refund'} data.resolution
 *   @param {string} data.notes           Required admin resolution notes
 *   @param {number} [data.customerAmount] Required when resolution === 'partial_refund' —
 *                                         the portion (GHS) returned to the customer;
 *                                         the remainder (minus commission) goes to the artisan.
 */
async function resolveDispute(auth, { bookingId, resolution, notes, customerAmount } = {}) {
    if (!(await isAdminAuth(auth))) throw new Error('Unauthorized: admin access only.');
    if (!bookingId)  throw new Error('"bookingId" is required.');
    if (!notes)      throw new Error('"notes" is required to resolve a dispute.');
    if (!VALID_RESOLUTIONS.has(resolution)) {
        throw new Error(`"resolution" must be one of: ${[...VALID_RESOLUTIONS].join(', ')}.`);
    }

    const firestore  = db();
    const bookingRef = firestore.collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) throw new Error(`Booking not found: ${bookingId}`);
    const booking = bookingSnap.data();

    // ── Re-validate state: only an actively disputed booking can be resolved ──
    if (_str(booking.status) !== 'disputed') {
        throw new Error(`This booking is not currently disputed (status: "${booking.status}").`);
    }

    // Find the JOB escrow record for this booking — held or disputed. Kind is
    // filtered in code (legacy escrow docs predate the field → treated as 'job')
    // so a stuck callout escrow can never be mistaken for the disputed job
    // payment (F5 — same invariant as _findHeldEscrow). In practice a callout is
    // always settled before a dispute is possible, but this stays defensive.
    const escrowQuery = await firestore.collection('escrow')
        .where('bookingId', '==', bookingId)
        .where('status', 'in', ['held', 'disputed'])
        .limit(5)
        .get();
    const escrowDoc = escrowQuery.docs.find(d => (d.data().kind || 'job') === 'job');
    if (!escrowDoc) {
        throw new Error('No held/disputed escrow record found for this booking — cannot resolve financially.');
    }
    const escrowId = escrowDoc.id;

    const customerId = booking.customerId;
    const artisanId  = booking.artisanId;
    const adminEmail = auth.token?.email || auth.uid;

    if (resolution === 'full_refund') {
        await refundEscrow(escrowId, {
            reason:     `Dispute resolved (admin): ${notes}`,
            refundedBy: adminEmail,
            callerAuth: null, // server-authoritative — admin already verified above
        });
    } else if (resolution === 'release_artisan') {
        await releaseEscrow(escrowId, {
            releasedBy: adminEmail,
            callerAuth: null,
        });
    } else {
        // partial_refund — split funds between customer wallet and artisan earnings.
        // Not covered by refundEscrow/releaseEscrow (both are all-or-nothing), so this
        // runs its own transaction using the identical concurrency-safe pattern:
        // re-read escrow status INSIDE the transaction and abort if it has moved.
        await _partialRefund(firestore, escrowId, { customerAmount, notes, adminEmail });
    }

    // ── Close the booking's dispute state ──────────────────────────────────────
    await bookingRef.update({
        status:          'resolved',
        resolution,
        resolutionNotes: notes,
        resolvedAt:       FieldValue.serverTimestamp(),
        resolvedBy:       adminEmail,
        updatedAt:        now(),
    });

    await firestore.collection('dispute_logs').add({
        bookingId,
        escrowId,
        resolution,
        notes,
        adminEmail,
        adminUid:  auth.uid,
        timestamp: FieldValue.serverTimestamp(),
    }).catch(err => console.error('[dispute-log] write error:', err.message));

    const resultMsgCustomer = {
        full_refund:      'Your dispute has been resolved. The booking amount has been refunded to your wallet.',
        release_artisan:  'Your dispute has been resolved. Payment has been released to the artisan.',
        partial_refund:   'Your dispute has been resolved with a partial settlement.',
    }[resolution];
    const resultMsgArtisan = {
        full_refund:      'A booking dispute has been resolved. The customer has been refunded in full.',
        release_artisan:  'A booking dispute has been resolved in your favor. Payment has been processed.',
        partial_refund:   'A booking dispute has been resolved with a partial settlement.',
    }[resolution];

    if (customerId) {
        sendNotification(customerId, {
            type: 'System', title: 'Dispute Resolved', message: resultMsgCustomer,
            actionUrl: 'booking.html', metadata: { bookingId, escrowId },
        }).catch(() => {});
    }
    if (artisanId) {
        sendArtisanNotification(artisanId, {
            type: 'System', title: 'Dispute Resolved', message: resultMsgArtisan,
            actionUrl: 'jobs.html', metadata: { bookingId, escrowId },
        }).catch(() => {});
    }

    return { resolved: true, bookingId, resolution };
}

function _str(v) { return (v == null ? '' : String(v)).toLowerCase().trim(); }

// ─────────────────────────────────────────────────────────────────────────────
// _partialRefund — split escrow funds between customer wallet and artisan
// earnings. Follows the same "re-read status inside the transaction" pattern
// as releaseEscrow/refundEscrow in financial/escrow.js so concurrent admin
// double-clicks cannot double-pay.
// ─────────────────────────────────────────────────────────────────────────────
async function _partialRefund(firestore, escrowId, { customerAmount, notes, adminEmail }) {
    const amt = fmt(customerAmount);
    if (!(amt > 0)) throw new Error('"customerAmount" must be a positive number for a partial refund.');

    const escrowRef = firestore.collection('escrow').doc(escrowId);
    const preSnap    = await escrowRef.get();
    if (!preSnap.exists) throw new Error('Escrow record not found.');
    if (!['held', 'disputed'].includes(preSnap.data().status)) {
        throw new Error(`Cannot partially refund escrow with status "${preSnap.data().status}".`);
    }
    if (amt > preSnap.data().amount) {
        throw new Error('customerAmount cannot exceed the total escrowed amount.');
    }

    const n = now();

    await firestore.runTransaction(async (txn) => {
        const escrowSnap = await txn.get(escrowRef);
        if (!escrowSnap.exists || !['held', 'disputed'].includes(escrowSnap.data().status)) {
            throw new Error(
                `Cannot partially refund escrow: status is "${escrowSnap.data()?.status}" ` +
                '(expected "held" or "disputed"). Concurrent operation prevented.'
            );
        }
        const escrow = escrowSnap.data();
        const { customerId, bookingId, amount, commissionRate } = escrow;
        const remainder    = fmt(Math.max(0, amount - amt));
        const commission   = fmt(remainder * (commissionRate ?? 0));
        const artisanShare = fmt(remainder - commission);

        // Resolve artisanId — may need the booking doc if escrow predates dispatch.
        let artisanId = escrow.artisanId;
        if (!artisanId && bookingId) {
            const bookingSnap = await txn.get(firestore.collection('bookings').doc(bookingId));
            if (bookingSnap.exists) artisanId = bookingSnap.data().artisanId || null;
        }

        const customerRef = firestore.collection('customers').doc(customerId);
        const customerSnap = await txn.get(customerRef);
        const custWallet = fmt(customerSnap.data()?.walletBalance || 0);
        const custEscrow = fmt(customerSnap.data()?.escrowBalance || 0);

        txn.update(escrowRef, {
            status:         'refunded',
            resolutionType: 'partial',
            customerAmount: amt,
            artisanAmount:  artisanShare,
            commission,
            refundedBy:     adminEmail,
            refundReason:   `Dispute partial settlement: ${notes}`,
            refundedAt:     n,
            updatedAt:      n,
        });

        txn.update(customerRef, {
            walletBalance: fmt(custWallet + amt),
            escrowBalance: fmt(Math.max(0, custEscrow - amount)),
            updatedAt:     n,
        });

        const custTxnRef = customerRef.collection('transactions').doc();
        txn.set(custTxnRef, {
            type: 'refund', amount: amt, bookingId: bookingId || null, escrowId,
            description: `Partial dispute settlement: ${notes}`,
            status: 'completed', ref: genId('REF'), createdAt: n,
        });

        if (artisanId && artisanShare > 0) {
            const artisanRef  = firestore.collection('artisans').doc(artisanId);
            const artisanSnap = await txn.get(artisanRef);
            const artAvail    = fmt(artisanSnap.exists ? artisanSnap.data().availableBalance || 0 : 0);
            const artTotal    = fmt(artisanSnap.exists ? artisanSnap.data().totalEarned      || 0 : 0);

            txn.set(artisanRef, {
                availableBalance: fmt(artAvail + artisanShare),
                totalEarned:      fmt(artTotal + artisanShare),
                updatedAt:        n,
            }, { merge: true });

            const artTxnRef = artisanRef.collection('transactions').doc();
            txn.set(artTxnRef, {
                type: 'earning', amount: artisanShare, commission, totalAmount: remainder,
                commissionRate: commissionRate ?? 0, bookingId, escrowId,
                description: `Partial dispute settlement: ${notes}`,
                status: 'completed', ref: genId('ERN'), createdAt: n,
            });
        }

        const platformRef = firestore.collection('platform').doc('earnings');
        txn.set(platformRef, {
            totalCommissions:    FieldValue.increment(commission),
            totalArtisanPayouts: FieldValue.increment(artisanShare),
            updatedAt:           n,
        }, { merge: true });

        const auditRef = firestore.collection('financialAudit').doc();
        txn.set(auditRef, {
            action: 'dispute_partial_refund', escrowId, bookingId, artisanId, customerId,
            customerAmount: amt, artisanAmount: artisanShare, commission,
            resolvedBy: adminEmail, createdAt: n,
        });
    });
}

module.exports = { resolveDispute };
