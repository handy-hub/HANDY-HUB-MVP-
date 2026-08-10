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
    const uid = auth.uid;

    // ── 1. Guard ─────────────────────────────────────────────────────────────
    const { deletable, blockers } = await checkAccountDeletable(auth);
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

module.exports = { requestAccountDeletion, checkAccountDeletable };
