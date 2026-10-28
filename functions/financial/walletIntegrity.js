'use strict';

/**
 * functions/financial/walletIntegrity.js — how much of a stored balance the
 * server may let its owner SPEND, read inside the spending transaction.
 *
 * A stored balance (customers/{id}.walletBalance, artisans/{id}.availableBalance)
 * is a running total. Security Rules stop clients writing it, but anything with
 * project credentials can (the Firebase console bypasses rules): on 2026-10-22 a
 * wallet was edited 3 → 300 in the console and GHS 110 of it was spent on
 * bookings, because every debit trusted the number. The ledger rows the server
 * writes beside every balance change are the evidence; this module reads them
 * and the records that back them, and the debit is limited to
 *
 *     spendable = max(0, min(stored balance, verified ledger))
 *
 * (rules: shared/js/domain/walletLedger.js verifiedCustomerPesewas /
 * verifiedArtisanPesewas). A legitimate wallet is unaffected — its stored
 * balance is its verified ledger.
 *
 * Every read goes through the caller's transaction, BEFORE any write. The
 * account document the debit updates is the serialisation point: two debits
 * cannot both pass on the same evidence, because the second one's commit fails
 * on the first one's write and re-runs, re-reading the ledger.
 *
 * When the stored balance is ahead of the evidence, an alert is recorded in
 * walletIntegrityAlerts/{kind_uid} (server-only — firestore.rules default deny)
 * for an operator. It is written outside the transaction, idempotently, so a
 * refused debit still leaves a trace.
 */

const { FIRESTORE_DB_ID } = require('../config');
const ledger = require('../shared/walletLedger');

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

const docs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

/**
 * A customer's ledger and the records that back its credit rows — webhook
 * locks for top-ups, escrows for refunds — read through `txn`.
 */
async function readCustomerEvidence(txn, uid) {
    const firestore = db();
    const [txSnap, payoutSnap] = await Promise.all([
        txn.get(firestore.collection('customers').doc(uid).collection('transactions')),
        txn.get(firestore.collection('payouts').where('userId', '==', uid)),
    ]);
    const transactions = docs(txSnap);
    const lockIds = new Set(), escrowIds = new Set();
    for (const t of transactions) {
        if (t.type === 'topup' && t.paystackRef) lockIds.add(t.paystackRef);
        if (t.type === 'refund' && t.escrowId) escrowIds.add(t.escrowId);
    }
    const lockList = [...lockIds], escrowList = [...escrowIds];
    const [lockSnaps, escrowSnaps] = await Promise.all([
        Promise.all(lockList.map((r) => txn.get(firestore.collection('webhookLocks').doc(r)))),
        Promise.all(escrowList.map((e) => txn.get(firestore.collection('escrow').doc(e)))),
    ]);
    const locks = new Map(), escrows = new Map();
    lockSnaps.forEach((s, i) => { if (s.exists) locks.set(lockList[i], s.data()); });
    escrowSnaps.forEach((s, i) => { if (s.exists) escrows.set(escrowList[i], s.data()); });
    return { customerId: uid, transactions, payouts: docs(payoutSnap), locks, escrows };
}

/**
 * The escrows, among those an artisan's earnings came from, whose funding is
 * proven by their customers' ledgers (walletLedger backedHoldEscrowIds). Only
 * escrows without fundingVerified need it — those made before applyHold
 * measured holds against the evidence — so this reads a fixed, shrinking set
 * of customers, never a growing one.
 */
async function readBackedLegacyEscrows(txn, escrows) {
    const customers = new Set();
    for (const e of escrows.values()) {
        if (e && e.fundingVerified !== true && e.customerId) customers.add(e.customerId);
    }
    const backed = new Set();
    for (const evidence of await Promise.all([...customers].map((c) => readCustomerEvidence(txn, c)))) {
        for (const id of ledger.backedHoldEscrowIds(evidence)) backed.add(id);
    }
    return backed;
}

/**
 * @param {object} txn   Firestore transaction (reads only)
 * @param {'customer'|'artisan'} kind
 * @param {string} uid
 * @param {number} storedGHS the balance as read in this transaction
 * @returns {Promise<{ storedP: number, verifiedP: number, spendableP: number, unverified: object[] }>}
 */
async function readSpendable(txn, kind, uid, storedGHS) {
    const firestore = db();
    const coll = kind === 'customer' ? 'customers' : 'artisans';
    const [txSnap, payoutSnap] = await Promise.all([
        txn.get(firestore.collection(coll).doc(uid).collection('transactions')),
        txn.get(firestore.collection('payouts').where('userId', '==', uid)),
    ]);
    const transactions = docs(txSnap);
    const payouts = docs(payoutSnap);

    // The records that back credit rows: webhook locks for top-ups, escrows for
    // refunds and earnings. Read in the same transaction.
    // and tips/{bookingId} for an artisan's tip rows (functions/tips.js).
    const lockIds = new Set(), escrowIds = new Set(), tipIds = new Set();
    for (const t of transactions) {
        if (kind === 'customer' && t.type === 'topup' && t.paystackRef) lockIds.add(t.paystackRef);
        if ((t.type === 'refund' || t.type === 'earning') && t.escrowId) escrowIds.add(t.escrowId);
        if (kind === 'artisan' && t.type === 'tip' && t.bookingId) tipIds.add(t.bookingId);
    }
    const lockList = [...lockIds], escrowList = [...escrowIds], tipList = [...tipIds];
    const [lockSnaps, escrowSnaps, tipSnaps] = await Promise.all([
        Promise.all(lockList.map((r) => txn.get(firestore.collection('webhookLocks').doc(r)))),
        Promise.all(escrowList.map((e) => txn.get(firestore.collection('escrow').doc(e)))),
        Promise.all(tipList.map((b) => txn.get(firestore.collection('tips').doc(b)))),
    ]);
    const locks = new Map(), escrows = new Map(), tips = new Map();
    lockSnaps.forEach((s, i) => { if (s.exists) locks.set(lockList[i], s.data()); });
    escrowSnaps.forEach((s, i) => { if (s.exists) escrows.set(escrowList[i], s.data()); });
    tipSnaps.forEach((s, i) => { if (s.exists) tips.set(tipList[i], s.data()); });

    // An artisan's earning counts only if the escrow it came from was paid for
    // with verified money (walletLedger escrowFundingProven).
    const backedEscrows = kind === 'artisan' ? await readBackedLegacyEscrows(txn, escrows) : null;

    const v = kind === 'customer'
        ? ledger.verifiedCustomerPesewas({ customerId: uid, transactions, payouts, locks, escrows })
        : ledger.verifiedArtisanPesewas({ artisanId: uid, transactions, payouts, escrows, tips, backedEscrows });
    const storedP = Math.round(Number(storedGHS || 0) * 100);
    const spendableP = ledger.spendablePesewas(storedGHS, v.pesewas);

    if (storedP > v.pesewas) {
        // Fire-and-forget, idempotent: one alert document per account.
        firestore.collection('walletIntegrityAlerts').doc(`${kind}_${uid}`).set({
            kind, uid,
            storedPesewas:   storedP,
            verifiedPesewas: v.pesewas,
            unverifiedRows:  v.unverified.slice(0, 50),
            lastSeenAt:      new Date().toISOString(),
        }, { merge: true }).catch((e) => console.error(`[walletIntegrity] alert write failed: ${e.message}`));
        console.error(`[walletIntegrity] ${kind} ${uid}: stored ${storedP} p exceeds verified ledger ${v.pesewas} p — spending limited to ${spendableP} p.`);
    }
    return { storedP, verifiedP: v.pesewas, spendableP, unverified: v.unverified };
}

module.exports = { readSpendable };
