'use strict';

/**
 * accountLifecycle.js — server-authoritative account deletion (CX-1).
 *
 * THE BUG THIS REPLACES
 * ─────────────────────
 * Deletion used to be a purely client-side Firebase Auth concern:
 *   reauthenticateWithCredential(password) → deleteUser(user)
 * …and nothing else. The Auth identity was destroyed immediately while:
 *   • `walletBalance` / `escrowBalance` stayed on customers/{uid} — real money,
 *     now unreachable and unrefundable because nobody can ever authenticate as
 *     that user again. Money silently disappeared.
 *   • held escrow on in-flight bookings lost the party who must confirm
 *     completion, stranding the artisan mid-job.
 *   • all PII (name, phone, email, address) persisted forever, despite the app
 *     advertising Ghana Data Protection Act compliance.
 * The client comment claimed a "backend cleanup job" would finish the work.
 * No such function existed anywhere in the codebase.
 *
 * THE MODEL NOW
 * ─────────────
 * Deletion is a guarded server-side lifecycle transaction:
 *   1. REFUSE while the user has outstanding money or obligations, with an
 *      actionable reason (withdraw your balance / finish your booking).
 *   2. Otherwise: anonymize the profile (PII erased, tombstoned for audit),
 *      write an immutable financialAudit record, and only THEN delete the Auth
 *      user — server-side, last, so a mid-way failure never orphans funds.
 *
 * Identity is still proven by the client re-authenticating with the password
 * immediately before calling this; the callable then verifies request.auth.uid.
 * The Admin SDK bypasses Firestore rules, so no rule changes are needed — and
 * clients still cannot set `deleted`/`deletedAt` themselves because those fields
 * are absent from isSafeCustomerProfileUpdate()'s allowlist.
 */

const { getAuth }    = require('firebase-admin/auth');
const { FieldValue } = require('firebase-admin/firestore');
const { FIRESTORE_DB_ID } = require('./config');

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

const nowIso = () => new Date().toISOString();

// A booking in any of these statuses is finished — it creates no further
// obligation for the customer. Everything else blocks deletion.
// Kept in sync with shared/js/domain/bookingStatusMeta.js by scripts/check-status-vocab.cjs.
const TERMINAL_BOOKING_STATUSES = ['completed', 'cancelled', 'rejected', 'unfulfilled'];

/**
 * Pre-flight check — can this account be deleted right now?
 * Exposed as its own callable so the UI can warn the user BEFORE they type their
 * password into a destructive modal.
 *
 * @returns {{ deletable: boolean, blockers: Array<{code,message,amount?}> }}
 */
async function checkAccountDeletable(auth) {
    if (await isArtisanAccount(auth.uid)) return checkArtisanClosable(auth);
    return checkCustomerDeletable(auth);
}

async function checkCustomerDeletable(auth) {
    const uid = auth.uid;
    const blockers = [];

    const snap = await db().collection('customers').doc(uid).get();
    const data = snap.exists ? snap.data() : {};

    const wallet = Number(data.walletBalance || 0);
    const escrow = Number(data.escrowBalance || 0);

    if (wallet > 0) {
        blockers.push({
            code: 'wallet_balance',
            amount: wallet,
            message: `You still have GHS ${wallet.toFixed(2)} in your wallet. Withdraw it before deleting your account.`,
        });
    }
    if (escrow > 0) {
        blockers.push({
            code: 'escrow_balance',
            amount: escrow,
            message: `GHS ${escrow.toFixed(2)} is held in escrow for a booking. It must be released or refunded first.`,
        });
    }

    // Active bookings. Query by customerId only (an existing index) and filter
    // terminal statuses in code — avoids a `not-in` query and its index.
    const bookings = await db().collection('bookings')
        .where('customerId', '==', uid)
        .limit(200)
        .get();

    const active = bookings.docs.filter(
        d => !TERMINAL_BOOKING_STATUSES.includes(String(d.data().status || '').toLowerCase())
    );
    if (active.length > 0) {
        blockers.push({
            code: 'active_bookings',
            amount: active.length,
            message: active.length === 1
                ? 'You have an active booking. Complete or cancel it before deleting your account.'
                : `You have ${active.length} active bookings. Complete or cancel them before deleting your account.`,
        });
    }

    return { deletable: blockers.length === 0, blockers };
}

/**
 * Delete the account. Refuses while any blocker stands.
 * Order is deliberate: Firestore teardown FIRST, Auth deletion LAST — if any step
 * fails, the user still has a working login and their money is still reachable.
 */
async function requestAccountDeletion(auth) {
    if (await isArtisanAccount(auth.uid)) return requestArtisanClosure(auth);
    const uid = auth.uid;

    // ── 1. Guard ─────────────────────────────────────────────────────────────
    const { deletable, blockers } = await checkCustomerDeletable(auth);
    if (!deletable) {
        const err = new Error(blockers.map(b => b.message).join(' '));
        err.blockers = blockers;
        throw err;
    }

    const customerRef = db().collection('customers').doc(uid);

    // ── 2. Re-verify inside a transaction, then anonymize ────────────────────
    // The pre-flight read above is not authoritative — a Paystack webhook could
    // credit the wallet in the gap. Re-check the balances atomically so we can
    // never erase an account that just received money.
    await db().runTransaction(async (txn) => {
        const snap = await txn.get(customerRef);
        const d    = snap.exists ? snap.data() : {};

        const wallet = Number(d.walletBalance || 0);
        const escrow = Number(d.escrowBalance || 0);
        if (wallet > 0 || escrow > 0) {
            throw new Error(
                'Your balance changed while the deletion was being processed. ' +
                'Please refresh and try again.'
            );
        }

        // Anonymize rather than hard-delete: bookings, reviews, and financial audit
        // records legitimately reference this uid, and blowing the doc away would
        // leave dangling references across the marketplace. PII is erased; the
        // shell remains as a tombstone.
        txn.set(customerRef, {
            deleted:       true,
            deletedAt:     nowIso(),
            name:          'Deleted user',
            email:         FieldValue.delete(),
            phone:         FieldValue.delete(),
            location:      FieldValue.delete(),
            address:       FieldValue.delete(),
            bio:           FieldValue.delete(),
            profileImageId:      FieldValue.delete(),
            profileImageVersion: FieldValue.delete(),
            fcmToken:      FieldValue.delete(),   // stop all push delivery
            savedProfessionals:  FieldValue.delete(),
            savedServices:       FieldValue.delete(),
            recentSearches:      FieldValue.delete(),
            walletBalance: 0,
            escrowBalance: 0,
            updatedAt:     nowIso(),
        }, { merge: true });
    });

    // ── 3. Immutable audit tombstone ─────────────────────────────────────────
    await db().collection('financialAudit').add({
        action:    'account_deleted',
        userId:    uid,
        userType:  'customer',
        amount:    0,
        note:      'Account deleted by user. Balances verified zero; PII erased.',
        createdAt: nowIso(),
    }).catch(err => console.error('[account] audit write failed:', err.message));

    // ── 4. Delete the Auth identity LAST ─────────────────────────────────────
    // Revokes every session. If this throws, the Firestore profile is already
    // anonymized and carries no money — the user simply retains a dead login,
    // which is recoverable, whereas the reverse order orphans funds forever.
    await getAuth().deleteUser(uid);

    console.log(`[account] Deleted customer ${uid} (balances zero, PII erased).`);
    return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// ARTISAN account closure (AR-15, 2026-10-20)
//
// The two callables above were customer-only: for an artisan they checked a
// customers/{uid} document that does not exist, found no blockers, and would
// have deleted the login while the artisan's earnings, held escrow and live
// jobs remained. The artisan app also had no way to ask.
//
// What closing an artisan account does, and deliberately does not do:
//   REFUSES while money or work is outstanding — an available balance (withdraw
//   it), a withdrawal still in flight, escrow held or disputed for their jobs,
//   a booking not yet finished, a job request still open to them.
//   REQUIRES a sign-in within the last 5 minutes (the app re-authenticates
//   immediately before calling), checked here from the token's auth_time — not
//   trusted to the client.
//   ERASES the public profile's personal data (name, contact details, photo,
//   bio, location, push token, search keywords), the precise private position
//   and the dispatch index entry, so they disappear from search and dispatch.
//   KEEPS every financial and audit record — transactions, payouts, escrow,
//   commissions, financialAudit, verification_logs — and the bookings, reviews
//   and chats, which are also the customers' records.
//   KEEPS the identity evidence (artisans/{id}/private/kyc, the verification
//   request and the uploaded ID documents), readable by administrators only,
//   marked with the closure date. It underpins payouts already made; how long
//   it must be kept is a legal decision this code does not make, and no purge
//   exists yet (see docs/ARTISAN_ACCOUNT_CLOSURE.md).
//   DELETES the Auth identity LAST, as for customers.
// ─────────────────────────────────────────────────────────────────────────────
const RECENT_AUTH_SECONDS = 5 * 60;
const PAYOUT_OPEN = ['pending', 'reserved', 'processing', 'unknown'];   // financial/transfers.js OPEN_STATUSES
// A resolved dispute is finished too (functions/disputes.js sets it).
const ARTISAN_FINISHED = [...TERMINAL_BOOKING_STATUSES, 'resolved'];

async function isArtisanAccount(uid) {
    const [a, c] = await Promise.all([
        db().collection('artisans').doc(uid).get(),
        db().collection('customers').doc(uid).get(),
    ]);
    return a.exists && a.data().userType === 'artisan' && !c.exists;
}

function closureError(message, blockers = [], reason = 'blocked') {
    const err = new Error(message);
    err.blockers = blockers;
    err.reason = reason;
    return err;
}

async function checkArtisanClosable(auth) {
    const uid = auth.uid;
    const blockers = [];
    const snap = await db().collection('artisans').doc(uid).get();
    const a = snap.exists ? snap.data() : {};
    if (a.deleted) return { deletable: false, blockers: [{ code: 'already_closed', message: 'This account is already closed.' }], role: 'artisan' };

    const available = Number(a.availableBalance || 0);
    if (available > 0) {
        blockers.push({ code: 'available_balance', amount: available,
            message: `You have GHS ${available.toFixed(2)} available. Withdraw it before closing your account.` });
    }
    const [payouts, escrows, bookings, offers] = await Promise.all([
        db().collection('payouts').where('userId', '==', uid).where('status', 'in', PAYOUT_OPEN).limit(20).get(),
        db().collection('escrow').where('artisanId', '==', uid).where('status', 'in', ['held', 'disputed']).limit(50).get(),
        db().collection('bookings').where('artisanId', '==', uid).limit(300).get(),
        db().collection('job_offers').where('artisanId', '==', uid).where('offerStatus', '==', 'open').limit(20).get(),
    ]);
    if (!payouts.empty) {
        blockers.push({ code: 'withdrawal_in_flight', amount: payouts.size,
            message: 'A withdrawal is still on its way to you. Wait until it completes.' });
    }
    if (!escrows.empty) {
        blockers.push({ code: 'escrow_held', amount: escrows.size,
            message: 'Payment is still held for a job of yours (or in a dispute). It must be released or refunded first.' });
    }
    const active = bookings.docs.filter((d) => !ARTISAN_FINISHED.includes(String(d.data().status || '').toLowerCase()));
    if (active.length) {
        blockers.push({ code: 'active_bookings', amount: active.length,
            message: active.length === 1 ? 'You have a job that is not finished.' : `You have ${active.length} jobs that are not finished.` });
    }
    if (!offers.empty) {
        blockers.push({ code: 'open_offers', amount: offers.size,
            message: 'A job request is waiting for your answer. Accept or decline it first.' });
    }
    return { deletable: blockers.length === 0, blockers, role: 'artisan' };
}

async function requestArtisanClosure(auth) {
    const uid = auth.uid;
    const authTime = Number(auth.token && auth.token.auth_time);
    if (!Number.isFinite(authTime) || Date.now() / 1000 - authTime > RECENT_AUTH_SECONDS) {
        throw closureError('Please confirm it is you — sign in again — and then close your account.', [], 'reauth_required');
    }

    const { deletable, blockers } = await checkArtisanClosable(auth);
    if (!deletable) throw closureError(blockers.map((b) => b.message).join(' '), blockers);

    const artisanRef = db().collection('artisans').doc(uid);
    const n = nowIso();
    await db().runTransaction(async (txn) => {
        const snap = await txn.get(artisanRef);
        const a = snap.exists ? snap.data() : {};
        // Money can arrive between the check and now (an escrow released by a
        // customer's confirmation): re-check the balance atomically.
        if (Number(a.availableBalance || 0) > 0) {
            throw closureError('Your balance changed while the account was being closed. Please withdraw it and try again.',
                [{ code: 'available_balance', amount: Number(a.availableBalance) }]);
        }
        const erase = FieldValue.delete();
        txn.set(artisanRef, {
            deleted: true, deletedAt: n, accountClosed: true,
            status: 'closed', isAvailable: false, isOnline: false,
            name: 'Former professional', fullName: erase, email: erase, phone: erase,
            bio: erase, profileImage: erase, profileImageId: erase, profileImageVersion: erase,
            fcmToken: erase, fcmPlatform: erase, fcmTokenUpdatedAt: erase,
            location: erase, lat: erase, lng: erase, latitude: erase, longitude: erase, geohash: erase,
            currentLat: erase, currentLng: erase, locationAccuracy: erase,
            searchKeywords: erase, skills: erase, notificationPreferences: erase,
            pendingProfileChange: erase,
            updatedAt: n,
        }, { merge: true });
        txn.delete(artisanRef.collection('private').doc('location'));
        txn.delete(db().collection('artisan_index').doc(uid));
        // Identity evidence is kept for administrators, flagged with the
        // closure; nothing in it is erased here (see header).
        txn.set(artisanRef.collection('private').doc('kyc'), { accountClosedAt: n }, { merge: true });
    });

    await db().collection('financialAudit').add({
        action: 'account_closed', userId: uid, userType: 'artisan', amount: 0,
        note: 'Artisan closed their account. Balance zero, no open payout, escrow or job; profile PII erased; ' +
              'financial, audit and identity-evidence records retained.',
        createdAt: n,
    }).catch((err) => console.error('[account] audit write failed:', err.message));

    await getAuth().deleteUser(uid);
    console.log(`[account] Closed artisan ${uid} (no money or work outstanding; PII erased; records retained).`);
    return { success: true, role: 'artisan' };
}

module.exports = { requestAccountDeletion, checkAccountDeletable, checkArtisanClosable, RECENT_AUTH_SECONDS };
