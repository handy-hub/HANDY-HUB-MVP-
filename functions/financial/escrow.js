'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Escrow — hold, release, refund, and freeze funds for bookings.
//
// AUTHORIZATION MODEL
// ───────────────────
//   holdFundsForBooking  → verified caller must be the booking's customerId
//   releaseEscrow        → SERVER-ONLY. Never reachable with a caller identity.
//   refundEscrow         → SERVER-ONLY. Never reachable with a caller identity.
//   adminReleaseEscrow   → admin, job escrow, booking already 'completed'
//   adminRefundEscrow    → admin, job escrow, booking already 'cancelled'
//   freezeEscrowForDispute → admin only (parties dispute the BOOKING instead)
//
// WHY RELEASE AND REFUND ARE SERVER-ONLY
// ──────────────────────────────────────
// Money leaves escrow because the BOOKING reached a state that decides it, not
// because someone asked. Every legitimate movement already has a server owner:
//   completed              → onBookingStatusChanged releases   (bookings.js)
//   cancelled              → onBookingStatusChanged refunds    (bookings.js)
//   callout fee            → settleCallout                     (pricing.js)
//   expired                → runAutoRelease                    (escrowAutoRelease.js)
//   disputed               → resolveDispute, admin only        (disputes.js)
// These primitives used to accept "either party to the escrow" as authorization,
// with no look at the booking at all. That let an artisan release a customer's
// money to themselves before doing the work, and let a customer refund themselves
// after the work was done or in the middle of a dispute. Identity was checked;
// the lifecycle was not. The admin entry points below exist only to repair an
// escrow whose booking already reached a terminal state but whose trigger failed.
//
// All financial operations run inside Firestore transactions.
// ─────────────────────────────────────────────────────────────────────────────

const { FieldValue }    = require('firebase-admin/firestore');
const { COMMISSION_RATE, PROVIDER_NAMES } = require('./paystack');
const { sendNotification, sendArtisanNotification } = require('../notifications');
const { FIRESTORE_DB_ID, isAllowlistedAdmin, ESCROW_AUTO_RELEASE_DAYS } = require('../config');
const { randomBytes } = require('crypto');
const walletIntegrity = require('./walletIntegrity');

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
    if (isAllowlistedAdmin(auth.token)) return true;
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
 * @param {{ bookingId, customerId, artisanId, amount, callerAuth, kind? }} opts
 *   kind: 'job' (default — the main job escrow, lock = bookingId) or
 *         'callout' (inspection callout fee, lock = `${bookingId}_callout`).
 *   Distinct lock keys let one booking carry a callout escrow AND a job escrow
 *   without the idempotency mutexes colliding. They are never simultaneously
 *   'held' in the normal flow: callout settles at quote decision, before the
 *   job escrow is created.
 * @returns {{ escrowId: string, commission: number, artisanShare: number }}
 */
async function holdFundsForBooking({ bookingId, customerId, artisanId, amount, callerAuth, kind = 'job' }) {
    // ── Authorization ─────────────────────────────────────────────────────────
    // This is an identity check (who is the caller?), not a financial state check.
    // It is safe outside the transaction — even if two callers pass auth at the
    // same millisecond, the transaction lock prevents double deduction.
    //
    // callerAuth semantics:
    //   object    → client call: enforce customer/admin identity check
    //   null      → system call (Cloud Function with Admin SDK): auth bypassed — server-authoritative
    //   undefined → programming error: throw
    if (!['job', 'callout'].includes(kind)) {
        throw new Error(`Invalid escrow kind "${kind}". Must be 'job' or 'callout'.`);
    }
    if (callerAuth === undefined) {
        throw new Error('callerAuth is required. Pass the caller\'s Firebase auth context, or null for system (Cloud Function) calls.');
    }
    if (callerAuth !== null) {
        const callerIsAdmin = await isAdminAuth(callerAuth);
        if (!callerIsAdmin && callerAuth.uid !== customerId) {
            throw new Error('Unauthorized: you may only hold funds for your own bookings.');
        }
    }

    const plan = planHold({ bookingId, customerId, artisanId, amount, kind });

    // ── Atomic transaction ────────────────────────────────────────────────────
    // ALL reads happen before ANY writes (Firestore requirement).
    // The lock check and wallet deduction are one indivisible unit.
    const result = await db().runTransaction(async (txn) => {
        const reads = await readHold(txn, plan);
        return applyHold(txn, plan, reads);
    });

    // ── Post-transaction: notify customer ─────────────────────────────────────
    // Fire only for a fresh escrow. Idempotent re-calls must not re-notify.
    if (!result.idempotent) notifyHoldSecured(plan);

    return { escrowId: result.escrowId, commission: result.commission, artisanShare: result.artisanShare };
}

// ── Composable hold ───────────────────────────────────────────────────────────
//
// holdFundsForBooking runs a hold in a transaction of its own. A caller that
// must commit a hold TOGETHER with its own writes — approveJobQuote moves the
// booking to approved in the same commit as the money, so neither can exist
// without the other — uses the three steps directly:
//
//   const hold  = escrow.planHold({ bookingId, customerId, artisanId, amount });
//   await db.runTransaction(async (txn) => {
//       const holdReads = await escrow.readHold(txn, hold);   // with the caller's other reads
//       ...                                                    // all reads before any write
//       const held = escrow.applyHold(txn, hold, holdReads);   // throws → nothing commits
//       txn.update(bookingRef, { ..., escrowId: held.escrowId });
//   });
//   escrow.notifyHoldSecured(hold);                            // only when !held.idempotent
//
// Failures carry a machine-readable `reason` so callers can tell a short wallet
// (recoverable: top up and retry) from a conflicting lock (needs support).

/** An error a caller can branch on without parsing its message. */
function holdError(reason, message, extra = {}) {
    const err = new Error(message);
    err.reason = reason;
    Object.assign(err, extra);
    return err;
}

/**
 * Everything about a hold that does not depend on Firestore state: validated
 * amount, commission split and pre-allocated document references. References
 * are created locally (no network) and stay stable across transaction retries,
 * so the same escrow id is used however many times the transaction re-runs.
 */
function planHold({ bookingId, customerId, artisanId = null, amount, kind = 'job' }) {
    if (!['job', 'callout'].includes(kind)) {
        throw new Error(`Invalid escrow kind "${kind}". Must be 'job' or 'callout'.`);
    }
    if (!bookingId || !customerId) throw new Error('bookingId and customerId are required.');

    const amountNum    = fmt(amount);
    // `> 0` rather than `<= 0`: a NaN amount fails every comparison, and must not
    // pass this check by failing the opposite one.
    // Finite too: Infinity passes `> 0` and would plan a hold with an infinite
    // commission and a NaN artisan share.
    if (!(amountNum > 0) || !Number.isFinite(amountNum)) throw new Error('Amount must be greater than zero.');
    const commission   = fmt(amountNum * COMMISSION_RATE);
    const artisanShare = fmt(amountNum - commission);

    const firestore = db();
    return {
        bookingId, customerId, artisanId: artisanId ?? null, kind,
        amountNum, commission, artisanShare,
        at:          now(),
        lockRef:     firestore.collection('_escrow_locks')
                              .doc(kind === 'job' ? bookingId : `${bookingId}_${kind}`),
        escrowRef:   firestore.collection('escrow').doc(),
        auditRef:    firestore.collection('financialAudit').doc(),
        customerRef: firestore.collection('customers').doc(customerId),
    };
}

/** READ step. Run it with the caller's other reads, before any write. */
async function readHold(txn, plan) {
    const [lockSnap, customerSnap] = await Promise.all([
        txn.get(plan.lockRef),
        txn.get(plan.customerRef),
    ]);
    // What of the stored balance may be spent: only what the verified ledger
    // supports (walletIntegrity.js). Not needed for a replay of a hold that
    // already happened — that path moves no money.
    const spend = !lockSnap.exists && customerSnap.exists
        ? await walletIntegrity.readSpendable(txn, 'customer', plan.customerId, customerSnap.data().walletBalance)
        : null;
    return { lockSnap, customerSnap, spend };
}

/**
 * DECIDE + WRITE step. Stages the hold's writes on `txn`, or returns the stored
 * hold for a genuine replay, or throws (and the caller's transaction commits
 * nothing). Never touches Firestore outside the transaction.
 *
 * @returns {{ idempotent: boolean, escrowId: string, commission: number, artisanShare: number }}
 */
function applyHold(txn, plan, { lockSnap, customerSnap, spend }) {
    const { bookingId, customerId, artisanId, kind, amountNum, commission, artisanShare, at: n } = plan;

    // ── IDEMPOTENCY GATE (race-free — inside the transaction) ─────────────────
    // The lock document was written by a previous successful hold for this
    // booking. Return the stored escrow details — no writes, no deduction.
    if (lockSnap.exists) {
        const lock = lockSnap.data();

        // ── A lock that does not describe THIS payment is not a replay ────────
        // The lock is keyed only by booking (and kind), so before this check
        // any earlier hold for the booking — whatever its amount, whoever
        // paid it — was accepted as "already secured". A customer could
        // pre-lock their own booking with GHS 0.01 through the old
        // holdBookingFunds callable, then approve a GHS 500 quote: this path
        // returned the 0.01 escrow, the artisan was told payment was secured,
        // and completion paid them 0.01. A genuine retry carries the same
        // payer and the same amount; anything else is a conflict and must
        // stop the payment, not silently stand in for it.
        if (lock.customerId !== customerId || fmt(lock.amount) !== amountNum) {
            console.error(
                `[escrow] Lock conflict for booking ${bookingId} (${kind}): lock escrow ` +
                `${lock.escrowId} amount=${lock.amount} does not match requested ` +
                `amount=${amountNum}. Refusing to treat it as paid.`
            );
            throw holdError('escrow_conflict',
                'Escrow conflict: this booking already has a payment hold that does not ' +
                'match this payment. Contact support — no money has been taken.');
        }

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

    // ── BALANCE VALIDATION ────────────────────────────────────────────────────
    if (!customerSnap.exists) {
        throw holdError('customer_missing', 'Customer account not found.');
    }

    const available     = fmt(customerSnap.data().walletBalance || 0);
    const currentEscrow = fmt(customerSnap.data().escrowBalance || 0);

    // ── The balance must be backed by the ledger ──────────────────────────────
    // readHold measured it in this transaction. A hold without that measurement
    // is a caller that skipped readHold — refuse rather than trust the number.
    if (!spend || !Number.isInteger(spend.spendableP)) {
        throw holdError('integrity_unchecked', 'Payment could not be verified. Please try again.');
    }
    const amountP = Math.round(amountNum * 100);
    if (amountP > spend.spendableP && amountNum <= available) {
        // The stored balance would cover it, the evidence does not: money that
        // no top-up, refund or payment record accounts for is never spent.
        throw holdError('balance_unverified',
            'Part of your wallet balance could not be matched to your payment history, so it ' +
            'cannot be used yet. Contact support — no money has been taken.',
            { needed: amountNum, available: spend.spendableP / 100 });
    }

    if (amountNum > available) {
        throw holdError('insufficient_balance',
            `Insufficient balance. Need GHS ${amountNum.toFixed(2)}, ` +
            `available GHS ${available.toFixed(2)}.`,
            { needed: amountNum, available });
    }

    // ── WRITES ────────────────────────────────────────────────────────────────
    // All reads are complete. Firestore will reject the commit if any of the
    // read documents changed between our read and this commit — guaranteeing
    // the "lock absent" observation we acted on is still true at commit time.

    // 1. Lock document — the distributed mutex for this bookingId.
    //    Stores the escrow details so idempotent callers get consistent data.
    //    Written first so it is the contention point: only one concurrent
    //    transaction can create this document.
    txn.set(plan.lockRef, {
        bookingId,
        customerId,
        kind,
        escrowId:     plan.escrowRef.id,
        commission,
        artisanShare,
        amount:       amountNum,
        lockedAt:     n,
    });

    // 2. Wallet mutation: deduct from available, add to escrowed amount.
    txn.update(plan.customerRef, {
        walletBalance: fmt(available     - amountNum),
        escrowBalance: fmt(currentEscrow + amountNum),
        updatedAt:     n,
    });

    // 3. Escrow record.
    txn.set(plan.escrowRef, {
        bookingId,
        customerId,
        artisanId:         artisanId ?? null,
        kind,
        amount:            amountNum,
        commission,
        artisanShare,
        commissionRate:    COMMISSION_RATE,
        status:            'held',
        customerConfirmed: false,
        artisanConfirmed:  false,
        disputeId:         null,
        // The hold above was measured against the verified ledger in this
        // transaction (readHold → walletIntegrity), so this escrow is backed
        // by real money. An artisan's earning from an escrow without this
        // mark must be proven by replaying the customer's ledger
        // (walletLedger escrowFundingProven) before it can be withdrawn.
        fundingVerified:   true,
        autoReleaseAt:     new Date(
            Date.now() + ESCROW_AUTO_RELEASE_DAYS * 24 * 60 * 60 * 1000
        ).toISOString(),
        createdAt:         n,
        updatedAt:         n,
    });

    // 4. Customer-facing transaction record.
    //    A new auto-ID is generated on each retry, but only the committed
    //    retry's write persists.
    const custTxnRef = plan.customerRef.collection('transactions').doc();
    txn.set(custTxnRef, {
        type:        'escrow_hold',
        amount:      amountNum,
        bookingId,
        escrowId:    plan.escrowRef.id,
        description: kind === 'callout'
            ? 'Callout fee secured for inspection visit'
            : 'Payment secured for booking',
        status:      'completed',
        ref:         genId('ESC'),
        createdAt:   n,
    });

    // 5. Financial audit record (immutable — update/delete blocked by rules).
    txn.set(plan.auditRef, {
        action:         'escrow_hold',
        userId:         customerId,
        userType:       'customer',
        kind,
        bookingId,
        escrowId:       plan.escrowRef.id,
        amount:         amountNum,
        commission,
        artisanShare,
        commissionRate: COMMISSION_RATE,
        balanceBefore:  available,
        balanceAfter:   fmt(available - amountNum),
        createdAt:      n,
    });

    return { idempotent: false, escrowId: plan.escrowRef.id, commission, artisanShare };
}

/** Tell the customer a fresh hold succeeded. Never for an idempotent replay. */
function notifyHoldSecured(plan) {
    sendNotification(plan.customerId, {
        type:      'Payments',
        title:     'Payment Secured',
        message:   `GHS ${plan.amountNum.toFixed(2)} is safely held in escrow for your booking.`,
        actionUrl: 'booking.html',
        metadata:  { bookingId: plan.bookingId, escrowId: plan.escrowRef.id },
    }).catch(() => {});
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
 * Refuse any call that carries a caller identity. Release and refund are
 * decided by booking state in trusted server code (see AUTHORIZATION MODEL);
 * a caller's identity is never a reason for money to move, so a primitive that
 * receives one is being reached from a path that skipped the lifecycle check.
 */
function _assertServerOnly(callerAuth, op) {
    if (callerAuth) {
        throw new Error(
            `Unauthorized: ${op} is server-only. Money leaves escrow when the booking ` +
            'is completed, cancelled or resolved — not on request.'
        );
    }
}

/**
 * Release escrow after booking completion.
 *
 * SERVER-ONLY. Callers: onBookingStatusChanged (→ completed), settleCallout,
 * runAutoRelease, resolveDispute and adminReleaseEscrow — each of which has
 * already decided, from the booking, that the artisan is owed this money.
 *
 * @param {string} escrowId
 * @param {{ releasedBy: string, callerAuth?: null }} opts
 */
async function releaseEscrow(escrowId, { releasedBy = 'system', callerAuth } = {}) {
    _assertServerOnly(callerAuth, 'releaseEscrow');

    const firestore  = db();
    const escrowRef  = firestore.collection('escrow').doc(escrowId);
    const escrowSnap = await escrowRef.get();

    if (!escrowSnap.exists) throw new Error('Escrow record not found.');
    const escrow = escrowSnap.data();
    if (escrow.status !== 'held') throw new Error(`Cannot release escrow with status "${escrow.status}".`);

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
        const artTotal   = fmt(artisanSnap.exists ? artisanSnap.data().totalEarned      || 0 : 0);

        txn.update(escrowRef, { status: 'released', releasedBy, releasedAt: n, updatedAt: n });

        txn.update(customerRef, {
            escrowBalance: fmt(Math.max(0, custEscrow - amount)),
            updatedAt:     n,
        });

        // pendingBalance is no longer written (AR-13): nothing ever incremented
        // it, so this decrement — clamped at zero — only ever wrote 0. Money
        // pending release is derived from the held escrow records themselves
        // (shared/js/domain/walletLedger.js), which cannot drift from the hold.
        txn.set(artisanRef, {
            availableBalance: fmt(artAvail + artisanShare),
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
        title:     'Payment Received',
        message:   `GHS ${artisanShare.toFixed(2)} has been credited to your wallet for completing a booking.`,
        actionUrl: 'wallet.html',
        metadata:  { bookingId, escrowId },
    }).catch(() => {});

    sendNotification(customerId, {
        type:      'Bookings',
        title:     'Booking Completed',
        message:   `Your booking is complete and payment has been released to the artisan.`,
        actionUrl: 'booking.html',
        metadata:  { bookingId, escrowId },
    }).catch(() => {});
}

// ── Refund ────────────────────────────────────────────────────────────────────

/**
 * Refund escrow back to the customer (booking cancelled or admin-resolved dispute).
 *
 * SERVER-ONLY. Callers: onBookingStatusChanged (→ cancelled), settleCallout,
 * runAutoRelease, resolveDispute and adminRefundEscrow. 'disputed' escrow is
 * refundable here only because resolveDispute (admin) reaches it.
 */
async function refundEscrow(escrowId, { reason = 'Booking cancelled', refundedBy = 'system', callerAuth } = {}) {
    _assertServerOnly(callerAuth, 'refundEscrow');

    const firestore  = db();
    const escrowRef  = firestore.collection('escrow').doc(escrowId);
    const escrowSnap = await escrowRef.get();

    if (!escrowSnap.exists) throw new Error('Escrow record not found.');
    const escrow = escrowSnap.data();

    if (!['held', 'disputed'].includes(escrow.status)) {
        throw new Error(`Cannot refund escrow with status "${escrow.status}".`);
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
        title:     'Refund Issued',
        message:   `GHS ${amount.toFixed(2)} has been refunded to your wallet. Reason: ${reason}.`,
        actionUrl: 'transaction-history.html',
        metadata:  { bookingId: bookingId || null, escrowId },
    }).catch(() => {});
}

// ── Admin repair: settle an escrow whose booking already decided the outcome ──

// The booking state that must already hold before an admin may move the money.
// Only terminal states qualify: they are the states in which the trigger itself
// would have moved it, so the admin is completing a decision the lifecycle has
// already made, never making a new one. An active booking is cancelled through
// cancelBookingAsAdmin (the trigger then refunds); a disputed one is closed
// through resolveDispute.
const ADMIN_SETTLEMENT_STATE = { release: 'completed', refund: 'cancelled' };

async function _loadAdminSettlement(auth, escrowId, action) {
    if (!(await isAdminAuth(auth))) {
        throw new Error('Unauthorized: only an administrator can settle escrow manually.');
    }
    if (!escrowId || typeof escrowId !== 'string') throw new Error('escrowId is required.');

    const escrowSnap = await db().collection('escrow').doc(escrowId).get();
    if (!escrowSnap.exists) throw new Error('Escrow record not found.');
    const escrow = escrowSnap.data();

    // Callout fees have their own fairness rule and a single settlement path.
    if ((escrow.kind || 'job') !== 'job') {
        throw new Error('Callout escrow is settled only through settleCallout, never manually.');
    }
    if (escrow.status !== 'held') {
        throw new Error(
            `Cannot ${action} escrow with status "${escrow.status}". ` +
            'Disputed escrow is closed through resolveDispute.'
        );
    }
    if (!escrow.bookingId) throw new Error('Escrow has no booking to settle against.');

    const bookingSnap = await db().collection('bookings').doc(escrow.bookingId).get();
    if (!bookingSnap.exists) throw new Error('Booking not found for this escrow.');
    const booking = bookingSnap.data();

    const status   = String(booking.status || '').toLowerCase().trim();
    const required = ADMIN_SETTLEMENT_STATE[action];
    if (status !== required) {
        throw new Error(
            `Cannot ${action} escrow: booking is "${booking.status}", must be "${required}".`
        );
    }
    if ((booking.customerId || booking.userId) !== escrow.customerId) {
        throw new Error('Escrow and booking disagree about the customer — refusing to settle.');
    }
    if (action === 'release' && escrow.artisanId && booking.artisanId &&
        escrow.artisanId !== booking.artisanId) {
        throw new Error('Escrow and booking disagree about the artisan — refusing to release.');
    }
    return escrow;
}

function _adminLabel(auth) {
    return `admin:${auth.token?.email || auth.uid}`;
}

/** Admin repair: release a held job escrow whose booking is already 'completed'. */
async function adminReleaseEscrow(auth, escrowId) {
    await _loadAdminSettlement(auth, escrowId, 'release');
    await releaseEscrow(escrowId, { releasedBy: _adminLabel(auth), callerAuth: null });
}

/** Admin repair: refund a held job escrow whose booking is already 'cancelled'. */
async function adminRefundEscrow(auth, escrowId, reason) {
    await _loadAdminSettlement(auth, escrowId, 'refund');
    await refundEscrow(escrowId, {
        reason:     reason || 'Booking cancelled',
        refundedBy: _adminLabel(auth),
        callerAuth: null,
    });
}

// ── Dispute ───────────────────────────────────────────────────────────────────

/**
 * Freeze escrow funds when a dispute is raised.
 * Authorization: admin only.
 *
 * A party raises a dispute by moving the BOOKING to 'disputed' (firestore.rules),
 * which is what resolveDispute acts on. Letting a party also freeze the escrow
 * directly created a state nothing could close: the escrow 'disputed' while the
 * booking was not, so resolveDispute refused it, completion could not release
 * it, and the scheduler no longer saw it.
 */
async function freezeEscrowForDispute(escrowId, { disputeId, raisedBy, callerAuth } = {}) {
    const firestore = db();
    const escrowRef = firestore.collection('escrow').doc(escrowId);
    const snap      = await escrowRef.get();

    if (!snap.exists) throw new Error('Escrow not found.');
    if (snap.data().status !== 'held') {
        throw new Error(`Only "held" escrow can be disputed (current: "${snap.data().status}").`);
    }

    // ── Authorization: admin only (see above) ─────────────────────────────────
    // (assertEscrowAccess is async so it must run outside the transaction)
    if (callerAuth) {
        await assertEscrowAccess(callerAuth, snap.data(), ['admin']);
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
    // Composable hold — for a caller that must commit a hold together with its
    // own writes in one transaction (approveJobQuote).
    planHold,
    readHold,
    applyHold,
    notifyHoldSecured,
    releaseEscrow,
    refundEscrow,
    adminReleaseEscrow,
    adminRefundEscrow,
    freezeEscrowForDispute,
    backfillEscrowLocks,
    isAdminAuth,
};
