'use strict';

/**
 * tests/support/walletEvidence.cjs — fund a test account the way production
 * does, so the money is SPENDABLE.
 *
 * Since 2026-10-22 the server spends only what an account's verified ledger
 * supports (functions/financial/walletIntegrity.js): a stored balance with no
 * evidence behind it is exactly what a console edit looks like. A fixture that
 * seeds `walletBalance: 500` therefore also needs the records a real top-up
 * leaves — a webhook ledger row and its webhookLocks entry — and an artisan's
 * `availableBalance` needs a released escrow and its earning row.
 *
 * Works with any fake that has `_set(path, data)`.
 */

/** A Paystack-verified top-up of `amountGHS` for customer `uid`. */
function fundCustomer(db, uid, amountGHS, ref = `TEST-TOPUP-${uid}-${Math.round(Number(amountGHS) * 100)}`) {
    if (!(Number(amountGHS) > 0)) return;
    db._set(`webhookLocks/${ref}`, { uid, paystackRef: ref, amountGHS: Number(amountGHS), creditedAt: '2026-10-01T00:00:00.000Z' });
    db._set(`customers/${uid}/transactions/fund_${ref}`, {
        type: 'topup', amount: Number(amountGHS), status: 'successful', source: 'webhook',
        paystackRef: ref, bookingId: null, createdAt: '2026-10-01T00:00:00.000Z',
    });
}

/**
 * Earnings of `amountGHS` for artisan `uid` from a released escrow — one made
 * by today's hold path, which marks it fundingVerified (escrow.js applyHold).
 */
function fundArtisan(db, uid, amountGHS, escrowId = `esc_fund_${uid}_${Math.round(Number(amountGHS) * 100)}`) {
    if (!(Number(amountGHS) > 0)) return;
    db._set(`escrow/${escrowId}`, {
        bookingId: `bk_${escrowId}`, customerId: 'fund_customer', artisanId: uid, kind: 'job',
        amount: Number(amountGHS), artisanShare: Number(amountGHS), commission: 0, status: 'released',
        fundingVerified: true, createdAt: '2026-10-01T00:00:00.000Z',
    });
    db._set(`artisans/${uid}/transactions/earn_${escrowId}`, {
        type: 'earning', amount: Number(amountGHS), escrowId, bookingId: `bk_${escrowId}`,
        status: 'completed', createdAt: '2026-10-01T00:00:00.000Z',
    });
}

module.exports = { fundCustomer, fundArtisan };
