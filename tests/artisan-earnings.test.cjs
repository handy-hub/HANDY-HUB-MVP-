'use strict';
/**
 * tests/artisan-earnings.test.cjs — every figure on the artisan's Earnings
 * screen agrees with the records the server writes (Phase 4).
 *
 * The money is moved by the REAL server code on the in-memory Firestore:
 * escrow.holdFundsForBooking / releaseEscrow (functions/financial/escrow.js),
 * tips.js, transfers.finalizePayout (the webhook / reconciler path). A
 * withdrawal reservation is written exactly as transfers.executeWithdrawal's
 * transaction writes it (the same fixture the payout tests use). Then the
 * resulting artisan profile, escrow, payout and ledger records are handed to
 * the screen's model (shared/js/domain/artisanEarnings.js) — and each figure,
 * label and reconciliation result is checked against those records.
 *
 * Insufficient balance, duplicate requests, the PIN, an unknown Paystack
 * outcome and the verified-ledger refusal are the server's and are proven by
 * tests/payout-integrity.test.cjs and tests/wallet-integrity.test.cjs; this file
 * proves the screen states what those leave behind.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const path   = require('path');
const { pathToFileURL } = require('url');
const { fundCustomer } = require('./support/walletEvidence.cjs');

const fake = require('./support/fake-firebase.cjs').install();
const ROOT = path.join(__dirname, '..');
const FN   = path.join(ROOT, 'functions');
const escrow    = require(path.join(FN, 'financial', 'escrow.js'));
const transfers = require(path.join(FN, 'financial', 'transfers.js'));
const tips      = require(path.join(FN, 'tips.js'));
const { COMMISSION_RATE } = require(path.join(FN, 'config.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
const quiet = () => { const o = [console.log, console.error, console.warn]; console.log = console.error = console.warn = () => {}; return () => { [console.log, console.error, console.warn] = o; }; };

const CUST = 'cust_e1', ART = 'art_e1';
function seed({ wallet = 1000 } = {}) {
    fake.db._reset(); fake.messaging._reset();
    fake.db._set(`customers/${CUST}`, { walletBalance: wallet, escrowBalance: 0, spent: 0, name: 'Ama' });
    fundCustomer(fake.db, CUST, wallet);
    fake.db._set(`artisans/${ART}`, { userType: 'artisan', status: 'active', verificationStatus: 'approved',
        name: 'Kofi', availableBalance: 0, totalEarned: 0, withdrawnTotal: 0 });
}
const art = () => fake.db._get(`artisans/${ART}`);
const rows = (prefix) => fake.db._keys(prefix).filter((k) => k.split('/').length === prefix.split('/').length)
    .map((k) => ({ id: k.split('/').pop(), ...fake.db._get(k) }));
const records = () => ({
    artisan: art(),
    escrows: rows('escrow/').filter((e) => e.artisanId === ART && ['held', 'disputed'].includes(e.status)),
    payouts: rows('payouts/').filter((p) => p.userId === ART),
    transactions: rows(`artisans/${ART}/transactions/`),
});
async function book(id, amount) {
    fake.db._set(`bookings/${id}`, { customerId: CUST, artisanId: ART, status: 'accepted', price: amount });
    const { escrowId } = await escrow.holdFundsForBooking({ bookingId: id, customerId: CUST, artisanId: ART, amount, callerAuth: null });
    return escrowId;
}
/** A withdrawal reservation, exactly as transfers.executeWithdrawal's transaction writes it. */
function reserveWithdrawal(id, amount, status = 'reserved') {
    const a = art();
    fake.db._set(`artisans/${ART}`, { ...a, availableBalance: +(a.availableBalance - amount).toFixed(2),
        withdrawnTotal: +((a.withdrawnTotal || 0) + amount).toFixed(2) });
    fake.db._set(`payouts/${id}`, { userId: ART, userType: 'artisan', requestId: id, ref: `AW-${id}`, amount,
        amountPesewas: Math.round(amount * 100), provider: 'mtn', phone: '0241234567', status, refundedAt: null,
        createdAt: new Date(Date.now() + Number(id.replace(/\D/g, '') || 0)).toISOString() });
    fake.db._set(`artisans/${ART}/transactions/payout_${id}`, { type: 'withdrawal', amount, status: 'processing',
        ref: `AW-${id}`, payoutId: id, provider: 'mtn', phone: '0241234567', createdAt: new Date().toISOString() });
}
const p = (v) => Math.round(v * 100);

(async () => {
const E = await import(pathToFileURL(path.join(ROOT, 'shared', 'js', 'domain', 'artisanEarnings.js')).href);
const restore = quiet();

console.log('\n── Every figure from its record, after real releases, a tip and payouts ──\n');

// Jobs at prices whose 15% does not divide evenly, so rounding is exercised.
seed();
const e1 = await book('bk_1', 100);
const e2 = await book('bk_2', 54.99);
const e3 = await book('bk_3', 33.33);
await book('bk_held', 80);                              // stays held: pending release
await escrow.releaseEscrow(e1, { releasedBy: 'test', callerAuth: null });
await escrow.releaseEscrow(e2, { releasedBy: 'test', callerAuth: null });
await escrow.releaseEscrow(e3, { releasedBy: 'test', callerAuth: null });
fake.db._set(`bookings/bk_1`, { customerId: CUST, artisanId: ART, status: 'completed', price: 100 });
const tipped = await tips.tipArtisan({ uid: CUST }, { bookingId: 'bk_1', amount: 10 });
reserveWithdrawal('p1', 40);   await transfers.finalizePayout('p1', transfers.STATUS.SUCCESS, { source: 'test' });
reserveWithdrawal('p2', 25);   await transfers.finalizePayout('p2', transfers.STATUS.FAILED, { source: 'test', reason: 'rejected at initiation' });
reserveWithdrawal('p3', 15);                            // still reserved: on its way
reserveWithdrawal('p4', 5, 'unknown');                  // Paystack's outcome not known yet
restore();
const R = records();
const m = E.earningsModel({ ...R, ledgerComplete: true });

await t('available, held, on its way, paid out, earned — each equal to its record', () => {
    const a = R.artisan;
    assert.strictEqual(p(m.wallet.available), p(a.availableBalance), 'available = artisans.availableBalance');
    assert.strictEqual(p(m.wallet.totalEarned), p(a.totalEarned), 'earned = artisans.totalEarned');
    const held = R.escrows.filter((e) => e.status === 'held');
    assert.strictEqual(p(m.wallet.pendingRelease), held.reduce((s, e) => s + p(e.artisanShare), 0), 'held = Σ artisanShare of held escrow');
    assert.strictEqual(p(m.wallet.inTransit), p(15) + p(5), 'on its way = the open payouts (reserved + unknown)');
    assert.strictEqual(p(m.wallet.paidOut), p(40), 'paid out = the payout Paystack confirmed; the failed one is not counted');
    assert.deepStrictEqual(m.held.map((h) => h.bookingId), ['bk_held']);
});

await t('the fee: gross, platform fee and what you received, from the earning rows the server wrote', () => {
    const earn = R.transactions.filter((t) => t.type === 'earning');
    assert.strictEqual(m.summary.earnings, 3);
    assert.strictEqual(p(m.summary.gross), p(100) + p(54.99) + p(33.33));
    assert.strictEqual(p(m.summary.fee), earn.reduce((s, t) => s + p(t.commission), 0));
    assert.strictEqual(p(m.summary.net), earn.reduce((s, t) => s + p(t.amount), 0));
    assert.strictEqual(p(m.summary.gross) - p(m.summary.fee), p(m.summary.net), 'gross − fee = net, to the pesewa');
    assert.deepStrictEqual(m.summary.mismatches, [], 'every row adds up');
    assert.deepStrictEqual(m.summary.rates, [COMMISSION_RATE]);
    // The net the artisan sees per job is the server's artisanShare, never price × (1 − rate) recomputed.
    for (const t of earn) {
        const e = fake.db._get(`escrow/${t.escrowId}`);
        assert.strictEqual(p(t.amount), p(e.artisanShare), `${t.bookingId}: the row's net is the escrow's share`);
    }
});

await t('earned to date = Σ earnings + tips (the ledger); reconciliation agrees with every stored total', () => {
    assert.strictEqual(tipped.tipped, true, 'the tip went through the real tips path');
    assert.deepStrictEqual([m.summary.tips, p(m.summary.tipsTotal)], [1, p(10)], 'the tip row tips.js wrote');
    assert.strictEqual(p(m.wallet.totalEarned), p(m.summary.net) + p(m.summary.tipsTotal));
    assert.ok(m.reconciliation && m.reconciliation.ok, JSON.stringify(m.reconciliation && m.reconciliation.checks));
    assert.deepStrictEqual(m.issues, []);
});

await t('payouts read as the payouts collection records them', () => {
    const byRef = Object.fromEntries(m.payouts.map((x) => [x.ref, x]));
    assert.deepStrictEqual(['AW-p1', 'AW-p2', 'AW-p3', 'AW-p4'].map((r) => byRef[r].label),
        ['Paid out', 'Failed · balance restored', 'Requested', 'Being confirmed with the provider']);
    assert.deepStrictEqual([byRef['AW-p1'].open, byRef['AW-p3'].open, byRef['AW-p4'].open], [false, true, true]);
    assert.strictEqual(byRef['AW-p2'].restored, true, 'refundedAt recorded by finalizePayout');
    assert.strictEqual(byRef['AW-p1'].phone, '024 ••• 4567', 'never the whole number');
});

await t('ledger rows: a withdrawal takes its payout\'s state, never the copy written when it was requested', () => {
    const payoutsById = new Map(R.payouts.map((x) => [x.id, x]));
    const rowsOut = R.transactions.map((t) => E.ledgerRow(t, { payoutsById }));
    const w = Object.fromEntries(rowsOut.filter((r) => r.kind === 'withdrawal').map((r) => [r.ref, r]));
    assert.deepStrictEqual([w['AW-p1'].status, w['AW-p2'].status, w['AW-p3'].status], ['Paid out', 'Failed · balance restored', 'Requested']);
    assert.strictEqual(w['AW-p1'].title, 'Withdrawal to MTN MoMo 024 ••• 4567');
    const job = rowsOut.find((r) => r.kind === 'earning' && r.bookingId === 'bk_2');
    // 54.99 × 15% = 8.2485 → the server's fee is 8.25 and the share the remainder, 46.74.
    assert.deepStrictEqual([p(job.gross), p(job.fee), p(job.amount)], [5499, 825, 4674]);
    assert.strictEqual(p(job.gross) - p(job.fee), p(job.amount));
    assert.strictEqual(job.rate, COMMISSION_RATE);
});

console.log('\n── Inconsistencies are shown, never hidden ──\n');

await t('a balance raised outside the money paths (a console edit) is reported, with both figures', () => {
    const tampered = { ...R, artisan: { ...R.artisan, availableBalance: R.artisan.availableBalance + 50 } };
    const t2 = E.earningsModel({ ...tampered, ledgerComplete: true });
    assert.strictEqual(t2.reconciliation.ok, false);
    assert.ok(t2.issues.some((s) => /available balance \(GHS [\d,.]+\) does not match your records \(GHS [\d,.]+\)/.test(s)), t2.issues);
});

await t('a partial ledger makes no claim either way', () => {
    const part = E.earningsModel({ ...R, transactions: R.transactions.slice(0, 2), ledgerComplete: false });
    assert.strictEqual(part.reconciliation, null);
    assert.deepStrictEqual(part.issues, []);
});

await t('an earning row whose fee and amount do not add up to its price is flagged', () => {
    const bad = E.earningsSummary([{ type: 'earning', amount: 85, commission: 10, totalAmount: 100, commissionRate: 0.15 }]);
    assert.strictEqual(bad.mismatches.length, 1);
});

await t('a fee rate that changed between jobs is noticed (each row keeps the rate it was charged at)', () => {
    const s = E.earningsSummary([{ type: 'earning', amount: 85, commission: 15, totalAmount: 100, commissionRate: 0.15 },
                                 { type: 'earning', amount: 90, commission: 10, totalAmount: 100, commissionRate: 0.10 }]);
    assert.deepStrictEqual([s.feeChanged, s.rates], [true, [0.1, 0.15]]);
});

await t('a paid-out total the records cannot confirm is said, not shown as a number', () => {
    const odd = E.earningsModel({ artisan: { withdrawnTotal: 1 }, payouts: [{ status: 'reserved', amount: 5 }] });
    assert.strictEqual(odd.wallet.paidOut, null);
    assert.ok(odd.issues.includes('Your paid-out total could not be confirmed from your payout records.'));
});

await t('an unknown ledger row type is shown as recorded and flagged, never counted', () => {
    const r = E.ledgerRow({ id: 'x', type: 'adjustment', amount: 10, description: 'Manual' });
    assert.deepStrictEqual([r.kind, r.unknownType, r.sign], ['other', 'adjustment', '']);
    assert.strictEqual(E.earningsSummary([{ type: 'adjustment', amount: 10 }]).net, 0);
});

await t('a new artisan: every figure is zero from the records, and nothing is invented', () => {
    const z = E.earningsModel({ artisan: { availableBalance: 0, totalEarned: 0, withdrawnTotal: 0 }, ledgerComplete: true });
    assert.deepStrictEqual([z.wallet.available, z.wallet.pendingRelease, z.wallet.paidOut, z.summary.earnings, z.payouts.length], [0, 0, 0, 0, 0]);
    assert.strictEqual(z.reconciliation.ok, true);
});

console.log('\n── Job payments, as their escrow records say ──\n');

await t('held, released, returned to the customer, in dispute: each label and figure from its escrow', async () => {
    seed();
    const r1 = await book('bk_rel', 100);
    const r2 = await book('bk_ref', 60);
    const r3 = await book('bk_dis', 40);
    const r4 = await book('bk_hold', 20);
    const restoreQ = quiet();
    await escrow.releaseEscrow(r1, { releasedBy: 'test', callerAuth: null });
    await escrow.refundEscrow(r2, { reason: 'Booking cancelled', refundedBy: 'support@example.test', callerAuth: null });
    await escrow.freezeEscrowForDispute(r3, { disputeId: 'd1', raisedBy: CUST, callerAuth: null });
    restoreQ();
    const v = Object.fromEntries([r1, r2, r3, r4].map((id) => [id, E.escrowView({ id, ...fake.db._get(`escrow/${id}`) })]));
    assert.deepStrictEqual([v[r1].label, v[r1].toYou, v[r1].open], ['Paid to your balance', 85, false]);
    assert.deepStrictEqual([v[r2].label, v[r2].toYou, v[r2].toCustomer, v[r2].open], ['Returned to the customer', 0, 60, false]);
    assert.deepStrictEqual([v[r3].label, v[r3].open], ['In dispute · Fidus X support is reviewing', true]);
    assert.deepStrictEqual([v[r4].label, v[r4].share, v[r4].gross, v[r4].fee, v[r4].open], ['Held until the customer confirms', 17, 20, 3, true]);
    // Support's notes on a refund (who, why) are not part of what the artisan is shown.
    assert.ok(!JSON.stringify(v[r2]).includes('support@example.test'));
    assert.ok(!JSON.stringify(v[r2]).includes('Booking cancelled'));
    // Held and disputed are exactly what the wallet counts as pending and in dispute.
    const w = E.earningsModel({ artisan: art(), escrows: rows('escrow/').filter((e) => ['held', 'disputed'].includes(e.status)) }).wallet;
    assert.deepStrictEqual([p(w.pendingRelease), p(w.inDispute)], [p(v[r4].share), p(v[r3].share)]);
});

await t('a dispute settled in part says what reached each side (disputes.js partial)', () => {
    const v = E.escrowView({ id: 'e', status: 'refunded', resolutionType: 'partial', amount: 100, artisanShare: 85,
                             artisanAmount: 42.5, customerAmount: 50, commission: 7.5, refundedBy: 'admin@x', refundReason: 'notes' });
    assert.deepStrictEqual([v.label, v.toYou, v.toCustomer], ['Dispute settled by Fidus X support', 42.5, 50]);
    assert.ok(!JSON.stringify(v).includes('admin@x') && !JSON.stringify(v).includes('notes'));
});

console.log('\n── When the ledger is the whole ledger ──\n');

const page = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `r${from + i}`, type: 'earning', amount: 1,
    createdAt: new Date(Date.UTC(2026, 10, 1) - (from + i) * 60000).toISOString() }));

await t('the live page is the whole ledger only when the SERVER returned fewer rows than it asks for', () => {
    assert.strictEqual(E.mergeLedger({ live: page(59), liveFromServer: true }).complete, true);
    assert.strictEqual(E.mergeLedger({ live: page(E.LIVE_LEDGER_ROWS), liveFromServer: true }).complete, false, 'exactly the limit: there may be more');
    assert.strictEqual(E.mergeLedger({ live: page(3), liveFromServer: false }).complete, false, 'a cached answer proves nothing');
});
await t('a full read under its limit completes it; at the limit it is said to be too many to check', () => {
    const live = page(60);
    assert.deepStrictEqual(E.mergeLedger({ live, liveFromServer: true, full: page(150) }).complete, true);
    const many = E.mergeLedger({ live, liveFromServer: true, full: page(E.LEDGER_CHECK_LIMIT) });
    assert.deepStrictEqual([many.complete, many.tooMany], [false, true]);
});
await t('the live rows win over the full read by id, and a row written since is included', () => {
    const full = [{ id: 'w1', type: 'withdrawal', status: 'processing', createdAt: '2026-11-01T10:00:00.000Z' }];
    const live = [{ id: 'w1', type: 'withdrawal', status: 'failed', createdAt: '2026-11-01T10:00:00.000Z' },
                  { id: 'n1', type: 'earning', createdAt: '2026-11-02T10:00:00.000Z' }];
    const m = E.mergeLedger({ live, liveFromServer: true, full });
    assert.deepStrictEqual(m.rows.map((r) => [r.id, r.status || null]), [['n1', null], ['w1', 'failed']]);
});
await t('the merged ledger reconciles exactly when the server\'s figures do (the record set from the top)', () => {
    const merged = E.mergeLedger({ live: R.transactions.slice(0, 2), liveFromServer: true, full: R.transactions });
    assert.strictEqual(E.earningsModel({ ...R, transactions: merged.rows, ledgerComplete: merged.complete }).reconciliation.ok, true);
});

console.log('\n── Withdraw opens only on live figures and an account on file ──\n');

await t('withdrawGate: cached figures, no account, below the minimum — each said in words', () => {
    const acct = { provider: 'mtn', phone: '0241234567' };
    assert.deepStrictEqual(E.withdrawGate({ live: false, account: acct, available: 100, min: 5 }), { can: false, reason: 'Checking your balance with Fidus X…' });
    assert.strictEqual(E.withdrawGate({ live: true, account: undefined, available: 100, min: 5 }).reason, 'Loading your payout account…');
    const none = E.withdrawGate({ live: true, account: null, available: 100, min: 5 });
    assert.deepStrictEqual([none.can, none.support], [false, true]);
    assert.strictEqual(E.withdrawGate({ live: true, account: acct, available: 4.99, min: 5 }).reason, 'You can withdraw once you have GHS 5.00 available.');
    assert.deepStrictEqual(E.withdrawGate({ live: true, account: acct, available: 5, min: 5 }), { can: true, reason: '' });
});
await t('withdrawProblem compares in pesewas (0.1 + 0.2 style sums do not slip through)', () => {
    assert.strictEqual(E.withdrawProblem('0.30', { available: 0.1 + 0.2, min: 0.3 }), '');
    assert.strictEqual(E.withdrawProblem('46.75', { available: 46.74, min: 5 }), 'That is more than you can withdraw (GHS 46.74).');
});

console.log(`\nartisan-earnings: ${passed} passed, ${failed} failed`);
if (failed) { for (const [n, e] of failures) console.log(`\n✗ ${n}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
