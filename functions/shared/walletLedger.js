/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * CommonJS mirror of shared/js/domain/walletLedger.js, produced by
 * scripts/build-functions-shared.cjs so the Cloud Functions runtime (which
 * only receives the functions/ directory, and cannot import an ES module)
 * decides with exactly the same rules and the same numbers as the browser
 * (and, for appointments, firestore.rules).
 *
 * Edit the source module and re-run:  node scripts/build-functions-shared.cjs
 * `npm run lint` fails if this file has drifted from its source.
 */

'use strict';
/**
 * walletLedger.js — what each figure in an artisan's wallet MEANS, derived from
 * the records that are authoritative for it. (AR-13, 2026-10-20)
 *
 * WHY THIS EXISTS
 * ───────────────
 * The wallet's "Pending" read artisans/{id}.pendingBalance. Nothing ever
 * incremented that field; releaseEscrow only decremented it, clamped at zero,
 * so it was 0 for every artisan forever. "Withdrawn" read withdrawnTotal, which
 * counts a withdrawal from the moment it is requested — money still on its way
 * looked paid out. And the history showed withdrawal rows as written at the
 * time: four production payouts that failed and were refunded still read
 * "processing", because the implementation before 25e1818 never updated the row.
 *
 * Nothing here invents or adjusts a balance. Each figure is read from, or
 * summed over, records that the server writes transactionally:
 *
 *   available       artisans/{id}.availableBalance — credited by releaseEscrow /
 *                   a dispute settlement, debited when a withdrawal is reserved,
 *                   re-credited exactly once if it fails (functions/financial).
 *   pendingRelease  Σ artisanShare of escrow{artisanId == me, status 'held'} —
 *                   the customer's money held for this artisan's jobs, at the
 *                   share releaseEscrow will credit (after commission). It is
 *                   still the CUSTOMER's money until release; a cancellation
 *                   refunds it. Never added to available.
 *   inDispute       the same sum over status 'disputed' — an administrator
 *                   decides it; it may go either way.
 *   totalEarned     artisans/{id}.totalEarned — Σ of earning rows.
 *   inTransit       Σ amount of this artisan's payouts still open (reserved /
 *                   processing / unknown) — the payouts collection is the
 *                   authority on a withdrawal's status.
 *   paidOut         withdrawnTotal − inTransit — withdrawals that completed.
 *
 * All arithmetic is in whole pesewas. functions/shared/walletLedger.js is a
 * GENERATED mirror (scripts/build-functions-shared.cjs) used by the tests and
 * by scripts/reconcile-wallets.cjs, the read-only operator check.
 */

/** Payout statuses that mean "not finished" — functions/financial/transfers.js OPEN_STATUSES. */
const PAYOUT_OPEN_STATUSES = Object.freeze(['pending', 'reserved', 'processing', 'unknown']);

const toP = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const fromP = (p) => p / 100;

/** A withdrawal row's status, from its payout when the payout is known. */
function withdrawalStatus(row, payout) {
    if (payout && typeof payout.status === 'string') {
        if (payout.status === 'success') return 'successful';
        if (payout.status === 'failed' || payout.status === 'reversed') return 'failed';
        if (PAYOUT_OPEN_STATUSES.includes(payout.status)) return 'processing';
    }
    return (row && row.status) || 'processing';
}

/**
 * The figures the wallet shows.
 *
 * @param {{ artisan: object, escrows?: object[], payouts?: object[] }} input
 *        escrows — this artisan's escrow records (held / disputed); payouts —
 *        this artisan's payout records (any status).
 */
function deriveArtisanWallet({ artisan, escrows = [], payouts = [] } = {}) {
    const a = artisan || {};
    let heldP = 0, disputedP = 0, heldJobs = 0, inTransitP = 0;
    for (const e of escrows) {
        if (!e) continue;
        if (e.status === 'held')     { heldP += toP(e.artisanShare); heldJobs++; }
        if (e.status === 'disputed') disputedP += toP(e.artisanShare);
    }
    for (const p of payouts) {
        if (p && PAYOUT_OPEN_STATUSES.includes(p.status)) inTransitP += toP(p.amount);
    }
    const withdrawnP = toP(a.withdrawnTotal);
    const issues = [];
    let paidOut = fromP(withdrawnP - inTransitP);
    if (withdrawnP < inTransitP) {
        issues.push('withdrawn_total_below_in_transit');
        paidOut = null;
    }
    return {
        available:      fromP(toP(a.availableBalance)),
        pendingRelease: fromP(heldP),
        heldJobs,
        inDispute:      fromP(disputedP),
        totalEarned:    fromP(toP(a.totalEarned)),
        inTransit:      fromP(inTransitP),
        paidOut,
        issues,
    };
}

/**
 * Does the artisan's stored balance agree with their ledger?
 *
 *   earned     totalEarned      == Σ earning + tip rows
 *   withdrawn  withdrawnTotal   == Σ withdrawal rows whose payout did not fail
 *   available  availableBalance == totalEarned − withdrawnTotal
 *
 * Read-only: it reports, it never corrects. staleRows lists withdrawal rows
 * whose stored status disagrees with their payout's.
 *
 * @param {{ artisan, transactions, payouts }} input — payouts keyed by id, or an array with .id
 */
function reconcileArtisanWallet({ artisan, transactions = [], payouts = [] } = {}) {
    const a = artisan || {};
    const byId = new Map();
    for (const p of payouts) if (p && p.id) byId.set(p.id, p);
    let earnP = 0, wdP = 0;
    const staleRows = [];
    for (const t of transactions) {
        if (!t) continue;
        if (t.type === 'earning' || t.type === 'tip') earnP += toP(t.amount);
        if (t.type === 'withdrawal') {
            const payout = t.payoutId ? byId.get(t.payoutId) : null;
            const status = withdrawalStatus(t, payout);
            if (status !== 'failed') wdP += toP(t.amount);
            if (payout && t.status !== status) staleRows.push({ id: t.id || null, stored: t.status, actual: status });
        }
    }
    const checks = [
        { name: 'earned',    expected: fromP(earnP), actual: fromP(toP(a.totalEarned)) },
        { name: 'withdrawn', expected: fromP(wdP),   actual: fromP(toP(a.withdrawnTotal)) },
        { name: 'available', expected: fromP(toP(a.totalEarned) - toP(a.withdrawnTotal)), actual: fromP(toP(a.availableBalance)) },
    ].map((c) => ({ ...c, ok: toP(c.expected) === toP(c.actual) }));
    return { ok: checks.every((c) => c.ok), checks, staleRows };
}

// ── Customer wallet ──────────────────────────────────────────────────────────
//
// customers/{id}.walletBalance is a running total. On its own it proves
// nothing: anyone who can write the document (the Firebase console, a script
// with project credentials) can set it to any number, and before this check the
// server spent whatever it said. Every server path that moves it ALSO writes a
// row in customers/{id}/transactions in the same transaction, and clients can
// never write those rows (firestore.rules: create/update/delete false). So the
// ledger is the evidence, and the balance must equal it:
//
//   + topup       a Paystack-verified credit   (financial/wallets.js)
//   + refund      escrow returned              (escrow.js refundEscrow, disputes.js)
//   − escrow_hold money moved into escrow      (escrow.js applyHold)
//   − withdrawal  a payout, unless it FAILED   (transfers.js — a failed payout is
//                 re-credited on the balance and its row marked 'failed')
//   − tip         money given to an artisan     (tips.js)
//
// escrowBalance must equal Σ amount of this customer's escrow records still
// 'held' or 'disputed' — the escrow collection is the authority on held money.

/** Ledger row types that move a customer's wallet, and in which direction. */
const CUSTOMER_LEDGER_SIGN = Object.freeze({ topup: 1, refund: 1, escrow_hold: -1, withdrawal: -1, tip: -1 });
const SETTLED_ROW = new Set(['successful', 'completed']);

/**
 * What the ledger says the wallet holds, in pesewas. Rows that never settled
 * (a pending top-up, a failed withdrawal) do not count; unknown row types are
 * reported, never guessed at.
 *
 * @param {object[]} transactions  customers/{id}/transactions rows
 * @param {object[]} payouts       this customer's payouts (any status), for withdrawal rows
 */
function customerLedgerPesewas(transactions = [], payouts = []) {
    const byId = new Map();
    for (const p of payouts) if (p && p.id) byId.set(p.id, p);
    let p = 0;
    const unknownTypes = [];
    for (const t of transactions) {
        if (!t) continue;
        const sign = CUSTOMER_LEDGER_SIGN[t.type];
        if (!sign) { unknownTypes.push(t.type == null ? '(none)' : String(t.type)); continue; }
        if (t.type === 'withdrawal') {
            if (withdrawalStatus(t, t.payoutId ? byId.get(t.payoutId) : null) === 'failed') continue;
        } else if (!SETTLED_ROW.has(t.status)) {
            continue;
        }
        p += sign * toP(t.amount);
    }
    return { pesewas: p, unknownTypes: [...new Set(unknownTypes)] };
}

/**
 * Does the customer's stored wallet agree with its ledger and escrow?
 *
 *   wallet  walletBalance == Σ ledger rows (signed, settled)
 *   escrow  escrowBalance == Σ held / disputed escrow amounts
 *
 * Read-only: it reports, it never corrects.
 *
 * @param {{ customer, transactions, payouts, escrows }} input
 */
function reconcileCustomerWallet({ customer, transactions = [], payouts = [], escrows = [] } = {}) {
    const c = customer || {};
    const ledger = customerLedgerPesewas(transactions, payouts);
    let heldP = 0;
    for (const e of escrows) if (e && (e.status === 'held' || e.status === 'disputed')) heldP += toP(e.amount);
    const checks = [
        { name: 'wallet', expected: fromP(ledger.pesewas), actual: fromP(toP(c.walletBalance)) },
        { name: 'escrow', expected: fromP(heldP),          actual: fromP(toP(c.escrowBalance)) },
    ].map((x) => ({ ...x, ok: toP(x.expected) === toP(x.actual), difference: fromP(toP(x.actual) - toP(x.expected)) }));
    return { ok: checks.every((x) => x.ok) && ledger.unknownTypes.length === 0, checks, unknownTypes: ledger.unknownTypes };
}

// ── What may be SPENT ────────────────────────────────────────────────────────
//
// A ledger row is evidence only if it can be traced to the event that justifies
// it. Production (2026-10-22) held 21 legacy "topup / successful" rows with no
// Paystack reference and no source — GHS 33,705 of credits nothing ever paid —
// written before clients were locked out of the ledger. And a balance edited in
// the console (3 → 300) had no row at all. So the server spends only what the
// VERIFIED ledger supports:
//
//   + topup    only with source 'webhook', a paystackRef, and the server-only
//              webhookLocks/{ref} written in the same transaction as the credit,
//              for this customer and this amount — counted once per reference
//   + refund   only for an escrow of this customer that really was refunded,
//              never more in total than that escrow held
//   − every escrow_hold, and every withdrawal that did not fail (debits always
//     count: an unprovable debit can only make the figure smaller)
//
// spendable = max(0, min(stored balance, verified ledger)). A legitimate wallet
// is unaffected (its stored balance IS its verified ledger); a balance raised by
// any path other than the server's money code cannot be spent or withdrawn.

/**
 * @param {{ customerId: string, transactions: object[], payouts?: object[],
 *           locks?: Map<string, object>, escrows?: Map<string, object> }} input
 *        locks: webhookLocks by paystackRef; escrows: escrow docs by id (refunded rows)
 * @returns {{ pesewas: number, unverified: { id: string|null, type: string, reason: string }[] }}
 */
function verifiedCustomerPesewas({ customerId, transactions = [], payouts = [], locks = new Map(), escrows = new Map() } = {}) {
    const byId = new Map();
    for (const p of payouts) if (p && p.id) byId.set(p.id, p);
    const seenRefs = new Set();
    const refundedP = new Map();      // escrowId → pesewas already counted
    const unverified = [];
    let p = 0;
    for (const t of transactions) {
        if (!t) continue;
        const id = t.id || null;
        if (t.type === 'escrow_hold' || t.type === 'tip') { if (SETTLED_ROW.has(t.status)) p -= toP(t.amount); continue; }
        if (t.type === 'withdrawal') {
            if (withdrawalStatus(t, t.payoutId ? byId.get(t.payoutId) : null) !== 'failed') p -= toP(t.amount);
            continue;
        }
        if (t.type === 'topup') {
            if (!SETTLED_ROW.has(t.status)) continue;
            const lock = t.paystackRef ? locks.get(t.paystackRef) : null;
            const reason = t.source !== 'webhook' || !t.paystackRef ? 'no_provider_reference'
                         : !lock ? 'no_webhook_lock'
                         : lock.uid !== customerId ? 'lock_other_account'
                         : toP(lock.amountGHS) !== toP(t.amount) ? 'lock_amount_mismatch'
                         : seenRefs.has(t.paystackRef) ? 'duplicate_reference'
                         : null;
            if (reason) { unverified.push({ id, type: 'topup', reason }); continue; }
            seenRefs.add(t.paystackRef);
            p += toP(t.amount);
            continue;
        }
        if (t.type === 'refund') {
            if (!SETTLED_ROW.has(t.status)) continue;
            const e = t.escrowId ? escrows.get(t.escrowId) : null;
            const already = t.escrowId ? (refundedP.get(t.escrowId) || 0) : 0;
            const reason = !e ? 'no_escrow'
                         : e.customerId !== customerId ? 'escrow_other_account'
                         : e.status !== 'refunded' ? 'escrow_not_refunded'
                         : already + toP(t.amount) > toP(e.amount) ? 'refund_exceeds_escrow'
                         : null;
            if (reason) { unverified.push({ id, type: 'refund', reason }); continue; }
            refundedP.set(t.escrowId, already + toP(t.amount));
            p += toP(t.amount);
            continue;
        }
        unverified.push({ id, type: t.type == null ? '(none)' : String(t.type), reason: 'unknown_type' });
    }
    return { pesewas: p, unverified };
}

/**
 * The artisan equivalent: earnings only from a real escrow (released, or a
 * partial dispute settlement), counted once per escrow and never above the
 * share it carried; tips only with their tips/{bookingId} record (server-only,
 * written in the same transaction as the tip) naming this artisan and this
 * amount; minus every withdrawal that did not fail.
 *
 * @param {{ artisanId?: string, transactions: object[], payouts?: object[],
 *           escrows?: Map<string, object>, tips?: Map<string, object> }} input
 */
function verifiedArtisanPesewas({ artisanId = null, transactions = [], payouts = [], escrows = new Map(), tips = new Map() } = {}) {
    const byId = new Map();
    for (const p of payouts) if (p && p.id) byId.set(p.id, p);
    const earnedP = new Map();
    const tipsSeen = new Set();
    const unverified = [];
    let p = 0;
    for (const t of transactions) {
        if (!t) continue;
        const id = t.id || null;
        if (t.type === 'withdrawal') {
            if (withdrawalStatus(t, t.payoutId ? byId.get(t.payoutId) : null) !== 'failed') p -= toP(t.amount);
            continue;
        }
        if (t.type === 'tip') {
            const tip = t.bookingId ? tips.get(t.bookingId) : null;
            const reason = !tip ? 'no_tip_record'
                         : tip.status !== 'paid' ? 'tip_not_paid'
                         : artisanId && tip.artisanId !== artisanId ? 'tip_other_account'
                         : toP(tip.amount) !== toP(t.amount) ? 'tip_amount_mismatch'
                         : tipsSeen.has(t.bookingId) ? 'duplicate_tip'
                         : null;
            if (reason) { unverified.push({ id, type: 'tip', reason }); continue; }
            tipsSeen.add(t.bookingId);
            p += toP(t.amount);
            continue;
        }
        if (t.type !== 'earning') { unverified.push({ id, type: String(t.type), reason: 'unknown_type' }); continue; }
        const e = t.escrowId ? escrows.get(t.escrowId) : null;
        const cap = !e ? 0
                  : e.status === 'released' ? toP(e.artisanShare)
                  : e.status === 'refunded' && e.resolutionType === 'partial' ? toP(e.artisanAmount)
                  : 0;
        const already = t.escrowId ? (earnedP.get(t.escrowId) || 0) : 0;
        const reason = !e ? 'no_escrow'
                     : cap === 0 ? 'escrow_not_paid_out'
                     : already + toP(t.amount) > cap ? 'earning_exceeds_escrow'
                     : null;
        if (reason) { unverified.push({ id, type: 'earning', reason }); continue; }
        earnedP.set(t.escrowId, already + toP(t.amount));
        p += toP(t.amount);
    }
    return { pesewas: p, unverified };
}

/** Pesewas the server may let this account spend now. */
function spendablePesewas(storedGHS, verifiedP) {
    return Math.max(0, Math.min(toP(storedGHS), verifiedP));
}

// ── What a customer has SPENT ────────────────────────────────────────────────
//
// customers/{id}.spent was a counter nothing ever incremented, so every profile
// read "GHS 0". Spent is derived instead, from the ledger the server writes:
//
//   spent = Σ escrow_hold − Σ refund − escrowBalance (still held) + Σ tip
//
// i.e. money that has actually gone to professionals: paid into escrow and not
// returned or still waiting, plus tips. Top-ups and withdrawals are not
// spending. Never negative.
//
// @param {{ transactions: object[], escrowBalance?: number }} input
function customerSpentPesewas({ transactions = [], escrowBalance = 0 } = {}) {
    let p = 0;
    for (const t of transactions) {
        if (!t || !SETTLED_ROW.has(t.status)) continue;
        if (t.type === 'escrow_hold' || t.type === 'tip') p += toP(t.amount);
        else if (t.type === 'refund') p -= toP(t.amount);
    }
    return Math.max(0, p - toP(escrowBalance));
}

// ── CommonJS surface ─────────────────────────────────────────────────────────
module.exports = {
    withdrawalStatus,
    deriveArtisanWallet,
    reconcileArtisanWallet,
    customerLedgerPesewas,
    reconcileCustomerWallet,
    verifiedCustomerPesewas,
    verifiedArtisanPesewas,
    spendablePesewas,
    customerSpentPesewas,
    PAYOUT_OPEN_STATUSES,
    CUSTOMER_LEDGER_SIGN,
};
