'use strict';

/**
 * functions/tips.js — a customer tips the professional who did their job.
 *
 * The review page has always offered GHS 5 / 10 / 20 / custom, but nothing
 * behind the buttons moved money: the choice was a variable that was never
 * sent anywhere. A tip is a wallet-to-wallet transfer, so it is done here, on
 * the server, in ONE transaction:
 *
 *   customer  walletBalance − amount   + ledger row  type 'tip'   (debit)
 *   artisan   availableBalance + amount, totalEarned + amount
 *                                      + ledger row  type 'tip'   (credit)
 *   tips/{bookingId}   the record both ledger rows are verified against
 *   financialAudit     who, what, when
 *
 * Rules of the tip (the client cannot change any of them):
 *   • only the booking's own customer, only for a COMPLETED booking with an
 *     assigned professional — the tip goes to booking.artisanId, never to an id
 *     the request names;
 *   • a positive amount in whole pesewas, at least GHS 1, from money the
 *     verified ledger supports (walletIntegrity.js) — a console-raised balance
 *     cannot be tipped away;
 *   • ONE tip per booking. A repeat of the same amount (a double tap, a retry
 *     after a timeout) returns the tip already made; a different amount is
 *     refused. Concurrent requests serialise on tips/{bookingId}.
 *   • the professional receives all of it: no commission is taken on a tip.
 *
 * No new deployed function: this is an action of the bookingActions router
 * (functions/index.js), because the region's CPU quota is spent (CLAUDE.md §4).
 */

const { FIRESTORE_DB_ID } = require('./config');
const walletIntegrity = require('./financial/walletIntegrity');
const { sendArtisanNotification } = require('./notifications');
const { randomBytes } = require('crypto');

const MIN_TIP_GHS = 1;

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

const toP  = (v) => Math.round(Number(v) * 100);
const fmt  = (p) => p / 100;
const nowIso = () => new Date().toISOString();

/** An error the callable maps to a code; `reason` lets the page branch. */
function tipError(reason, message, extra = {}) {
    return Object.assign(new Error(message), { reason, ...extra });
}

/**
 * @param {{ uid: string }} auth
 * @param {{ bookingId: string, amount: number }} data
 * @returns {Promise<{ tipped: true, amount: number, bookingId: string, duplicate: boolean }>}
 */
async function tipArtisan(auth, { bookingId, amount } = {}) {
    if (!auth || !auth.uid) throw tipError('unauthenticated', 'Sign in to send a tip.');
    if (typeof bookingId !== 'string' || !bookingId || bookingId.length > 128 || bookingId.includes('/')) {
        throw tipError('invalid', 'Which booking is this tip for?');
    }
    const n = Number(amount);
    // Whole pesewas only: 12.345 is not an amount anyone can be charged.
    if (!Number.isFinite(n) || n <= 0 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
        throw tipError('invalid', 'Enter a tip amount in cedis and pesewas.');
    }
    const amountP = Math.round(n * 100);
    if (amountP < MIN_TIP_GHS * 100) throw tipError('invalid', `The smallest tip is GHS ${MIN_TIP_GHS}.`);

    const uid = auth.uid;
    const firestore   = db();
    const tipRef      = firestore.collection('tips').doc(bookingId);
    const bookingRef  = firestore.collection('bookings').doc(bookingId);
    const customerRef = firestore.collection('customers').doc(uid);
    const ref = `TIP-${randomBytes(6).toString('hex').toUpperCase()}`;

    const result = await firestore.runTransaction(async (txn) => {
        const [tipSnap, bookingSnap, customerSnap] = await Promise.all([
            txn.get(tipRef), txn.get(bookingRef), txn.get(customerRef),
        ]);

        // ── One tip per booking ──────────────────────────────────────────────
        if (tipSnap.exists) {
            const t = tipSnap.data();
            if (t.customerId === uid && toP(t.amount) === amountP) {
                return { duplicate: true, artisanId: t.artisanId };
            }
            throw tipError('already_tipped', 'You have already sent a tip for this booking.');
        }

        // ── The booking decides who is tipped, and whether a tip is possible ─
        if (!bookingSnap.exists) throw tipError('not_found', 'Booking not found.');
        const b = bookingSnap.data();
        if (b.customerId !== uid) throw tipError('not_yours', 'You can only tip on your own bookings.');
        if (String(b.status || '').toLowerCase() !== 'completed') {
            throw tipError('not_completed', 'You can tip once the job is completed.');
        }
        const artisanId = b.artisanId || null;
        if (!artisanId) throw tipError('no_artisan', 'This booking has no professional to tip.');
        if (artisanId === uid) throw tipError('not_yours', 'You cannot tip yourself.');
        if (!customerSnap.exists) throw tipError('no_wallet', 'Your wallet was not found.');

        const artisanRef  = firestore.collection('artisans').doc(artisanId);
        const artisanSnap = await txn.get(artisanRef);
        if (!artisanSnap.exists) throw tipError('no_artisan', 'This professional\'s account was not found.');

        // ── Only verified money can be given away ────────────────────────────
        const c = customerSnap.data();
        const storedP = toP(c.walletBalance || 0);
        const spend = await walletIntegrity.readSpendable(txn, 'customer', uid, c.walletBalance);
        if (amountP > storedP) {
            throw tipError('insufficient_balance',
                `Your wallet has GHS ${fmt(storedP).toFixed(2)}. Top up to send this tip.`,
                { needed: fmt(amountP), available: fmt(storedP) });
        }
        if (amountP > spend.spendableP) {
            throw tipError('balance_unverified',
                'Part of your wallet balance could not be matched to your payment history, so it ' +
                'cannot be used yet. Contact support — no money has been taken.');
        }

        // ── Writes (all reads are done) ──────────────────────────────────────
        const a = artisanSnap.data();
        const at = nowIso();
        txn.set(tipRef, {
            bookingId, customerId: uid, artisanId, amount: fmt(amountP), amountPesewas: amountP,
            commission: 0, status: 'paid', ref, createdAt: at,
        });
        txn.update(customerRef, { walletBalance: fmt(storedP - amountP), updatedAt: at });
        txn.set(customerRef.collection('transactions').doc(`tip_${bookingId}`), {
            type: 'tip', amount: fmt(amountP), bookingId, artisanId,
            description: 'Tip for your professional', status: 'completed', ref, createdAt: at,
        });
        txn.set(artisanRef, {
            availableBalance: fmt(toP(a.availableBalance || 0) + amountP),
            totalEarned:      fmt(toP(a.totalEarned || 0) + amountP),
            updatedAt:        at,
        }, { merge: true });
        txn.set(artisanRef.collection('transactions').doc(`tip_${bookingId}`), {
            type: 'tip', amount: fmt(amountP), bookingId, customerId: uid,
            description: 'Tip from your customer', status: 'completed', ref, createdAt: at,
        });
        txn.set(firestore.collection('financialAudit').doc(), {
            action: 'tip', userId: uid, userType: 'customer', artisanId, bookingId,
            amount: fmt(amountP), balanceBefore: fmt(storedP), balanceAfter: fmt(storedP - amountP),
            ref, createdAt: at,
        });
        return { duplicate: false, artisanId };
    });

    if (!result.duplicate) {
        sendArtisanNotification(result.artisanId, {
            type: 'Payments', title: 'You received a tip',
            message: `Your customer sent you a GHS ${fmt(amountP).toFixed(2)} tip. It is in your wallet.`,
            actionUrl: 'wallet.html', metadata: { bookingId },
        }).catch(() => {});
    }
    return { tipped: true, amount: fmt(amountP), bookingId, duplicate: result.duplicate };
}

module.exports = { tipArtisan, MIN_TIP_GHS };
