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
export const PAYOUT_OPEN_STATUSES = Object.freeze(['pending', 'reserved', 'processing', 'unknown']);

const toP = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const fromP = (p) => p / 100;

/** A withdrawal row's status, from its payout when the payout is known. */
export function withdrawalStatus(row, payout) {
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
export function deriveArtisanWallet({ artisan, escrows = [], payouts = [] } = {}) {
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
 *   earned     totalEarned      == Σ earning rows
 *   withdrawn  withdrawnTotal   == Σ withdrawal rows whose payout did not fail
 *   available  availableBalance == totalEarned − withdrawnTotal
 *
 * Read-only: it reports, it never corrects. staleRows lists withdrawal rows
 * whose stored status disagrees with their payout's.
 *
 * @param {{ artisan, transactions, payouts }} input — payouts keyed by id, or an array with .id
 */
export function reconcileArtisanWallet({ artisan, transactions = [], payouts = [] } = {}) {
    const a = artisan || {};
    const byId = new Map();
    for (const p of payouts) if (p && p.id) byId.set(p.id, p);
    let earnP = 0, wdP = 0;
    const staleRows = [];
    for (const t of transactions) {
        if (!t) continue;
        if (t.type === 'earning') earnP += toP(t.amount);
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
