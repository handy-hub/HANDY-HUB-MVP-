'use strict';

/**
 * tests/wallet-integrity.test.cjs — a booking can only be paid with money the
 * verified ledger accounts for. (financial-security audit, 2026-10-22)
 *
 * Run: node tests/wallet-integrity.test.cjs
 *
 * On 2026-10-22 a customer wallet was edited 3 → 300 in the Firebase console
 * (which bypasses Security Rules) and two bookings were paid from it: every
 * debit trusted customers/{id}.walletBalance. Now each hold reads the
 * customer's ledger inside its transaction and spends at most
 *   max(0, min(stored balance, verified ledger))
 * (functions/financial/walletIntegrity.js, shared/js/domain/walletLedger.js).
 *
 * The REAL functions/financial/{escrow,wallets}.js run against
 * tests/support/fake-firebase.cjs. Withdrawals: tests/payout-integrity.test.cjs.
 * Client writes: tests/financial-rules.test.mjs (emulator).
 */

require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const path   = require('path');

const fake = require('./support/fake-firebase.cjs').install();
const { fundCustomer } = require('./support/walletEvidence.cjs');
const FN = path.join(__dirname, '..', 'functions');
const escrow  = require(path.join(FN, 'financial', 'escrow.js'));
const wallets = require(path.join(FN, 'financial', 'wallets.js'));
const ledger  = require(path.join(FN, 'shared', 'walletLedger.js'));
const tips    = require(path.join(FN, 'tips.js'));
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'lamax-4fd82';

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const quiet = () => { const o = [console.log, console.error, console.warn]; console.log = console.error = console.warn = () => {}; return () => { [console.log, console.error, console.warn] = o; }; };

const C = 'cust_w', A = 'art_w';
const cust = () => fake.db._get(`customers/${C}`);
const holds = () => fake.db._keys('escrow/').map((k) => fake.db._get(k)).filter((e) => e.customerId === C);
let n = 0;
const hold = (amount, bookingId = `BK-${++n}`) => escrow.holdFundsForBooking({ bookingId, customerId: C, artisanId: A, amount, callerAuth: null });

/** A customer whose GHS `real` came from a verified top-up, then optionally edited to `stored`. */
function seed({ real = 3, stored = real } = {}) {
    fake.db._reset(); fake.messaging._reset();
    fake.db._set(`customers/${C}`, { walletBalance: stored, escrowBalance: 0, spent: 0, name: 'Ama' });
    fundCustomer(fake.db, C, real, 'REF-REAL');
}
const sumInvariant = () => {
    // walletBalance + escrowBalance never exceeds the verified money that came in.
    const c = cust();
    return Math.round((Number(c.walletBalance) + Number(c.escrowBalance)) * 100);
};

(async () => {
console.log('\n── The incident: a wallet edited 3 → 300 cannot pay for bookings ──\n');

await t('a GHS 60 booking from a console-raised balance is refused, and nothing moves', async () => {
    seed({ real: 3, stored: 300 });
    const restore = quiet();
    const err = await hold(60).catch((e) => e); restore();
    assert.ok(err instanceof Error, 'expected a refusal');
    assert.strictEqual(err.reason, 'balance_unverified');
    assert.strictEqual(err.available, 3, 'only the verified GHS 3 is spendable');
    assert.deepStrictEqual([cust().walletBalance, cust().escrowBalance, holds().length], [300, 0, 0]);
});

await t('the genuine GHS 3 is still spendable — a real customer is not locked out', async () => {
    seed({ real: 3, stored: 300 });
    const restore = quiet();
    await hold(3); restore();
    assert.strictEqual(holds().length, 1);
    assert.strictEqual(cust().walletBalance, 297);
});

await t('the operator is told: an integrity alert names the account and both figures', async () => {
    seed({ real: 3, stored: 300 });
    const restore = quiet(); await hold(60).catch(() => {}); restore();
    await new Promise((r) => setTimeout(r, 10));
    const a = fake.db._get(`walletIntegrityAlerts/customer_${C}`);
    assert.ok(a, 'alert written');
    assert.deepStrictEqual([a.storedPesewas, a.verifiedPesewas], [30000, 300]);
});

await t('a legitimate wallet is unaffected: stored == verified, every pesewa spendable', async () => {
    seed({ real: 120 });
    await hold(120);
    assert.deepStrictEqual([cust().walletBalance, cust().escrowBalance], [0, 120]);
});

console.log('\n── Only real top-ups count ──\n');

await t('a real webhook credit is spendable; replaying it credits once and adds nothing spendable', async () => {
    fake.db._reset();
    fake.db._set(`customers/${C}`, { walletBalance: 0, escrowBalance: 0, name: 'Ama' });
    const restore = quiet();
    const a = await wallets.creditWalletFromCharge({ uid: C, amountGHS: 50, paystackRef: 'PSK-1' });
    const b = await wallets.creditWalletFromCharge({ uid: C, amountGHS: 50, paystackRef: 'PSK-1' });
    restore();
    assert.deepStrictEqual([a.credited, b.duplicate, cust().walletBalance], [true, true, 50]);
    await hold(50);
    const err = await hold(0.01).catch((e) => e);
    assert.strictEqual(err.reason, 'insufficient_balance');
});

for (const [label, row, lock] of [
    ['a legacy row with no provider reference (the GHS 32,805 kind)', { source: undefined, paystackRef: undefined }, null],
    ['a "webhook" row whose reference has no webhook lock',            { paystackRef: 'NOLOCK' }, null],
    ['a row whose lock belongs to another customer',                   { paystackRef: 'OTHER' }, { uid: 'someone_else', amountGHS: 200 }],
    ['a row claiming more than its lock records',                      { paystackRef: 'SMALL' }, { uid: C, amountGHS: 2 }],
]) {
    await t(`${label} is not spendable`, async () => {
        seed({ real: 3, stored: 203 });
        if (lock) fake.db._set(`webhookLocks/${row.paystackRef}`, { paystackRef: row.paystackRef, ...lock });
        fake.db._set(`customers/${C}/transactions/legacy`, {
            type: 'topup', amount: 200, status: 'successful', source: 'webhook', ...row });
        const restore = quiet(); const err = await hold(100).catch((e) => e); restore();
        assert.strictEqual(err.reason, 'balance_unverified');
        assert.strictEqual(holds().length, 0);
    });
}

await t('one Paystack reference counts once, even if two rows quote it', async () => {
    seed({ real: 100, stored: 200 });
    fake.db._set(`customers/${C}/transactions/dup`, { ...fake.db._get(`customers/${C}/transactions/fund_REF-REAL`) });
    const restore = quiet(); const err = await hold(150).catch((e) => e); restore();
    assert.strictEqual(err.reason, 'balance_unverified');
    await hold(100);
});

console.log('\n── Refunds count only when the escrow really was refunded ──\n');

await t('hold → refund → spend again: a real refund is spendable money', async () => {
    seed({ real: 80 });
    const { escrowId } = await hold(80, 'BK-R');
    const restore = quiet(); await escrow.refundEscrow(escrowId, { reason: 'Booking cancelled' }); restore();
    assert.deepStrictEqual([cust().walletBalance, cust().escrowBalance], [80, 0]);
    await hold(80, 'BK-R2');
    assert.strictEqual(cust().walletBalance, 0);
});

await t('a forged refund row (escrow still held) is not spendable', async () => {
    seed({ real: 50 });
    const { escrowId } = await hold(50, 'BK-F');
    fake.db._set(`customers/${C}`, { ...cust(), walletBalance: 50 });       // as if refunded
    fake.db._set(`customers/${C}/transactions/fakeref`, { type: 'refund', amount: 50, status: 'completed', escrowId });
    const restore = quiet(); const err = await hold(50, 'BK-F2').catch((e) => e); restore();
    assert.strictEqual(err.reason, 'balance_unverified');
});

await t('escrow cannot be released twice, or refunded after release', async () => {
    seed({ real: 40 });
    fake.db._set(`artisans/${A}`, { availableBalance: 0, totalEarned: 0 });
    const { escrowId } = await hold(40, 'BK-X');
    const restore = quiet();
    await escrow.releaseEscrow(escrowId, { releasedBy: 'test' });
    const again = await escrow.releaseEscrow(escrowId, { releasedBy: 'test' }).catch((e) => e);
    const refund = await escrow.refundEscrow(escrowId, {}).catch((e) => e);
    restore();
    assert.ok(again instanceof Error && refund instanceof Error);
    assert.strictEqual(fake.db._get(`artisans/${A}`).availableBalance, 34);
    assert.deepStrictEqual([cust().walletBalance, cust().escrowBalance], [0, 0]);
});

console.log('\n── Concurrency, replays and malformed amounts ──\n');

await t('concurrent bookings cannot spend the same verified money twice', async () => {
    seed({ real: 100 });
    const r = await Promise.allSettled([hold(70), hold(70), hold(70)]);
    assert.strictEqual(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.deepStrictEqual([cust().walletBalance, cust().escrowBalance], [30, 70]);
    assert.strictEqual(sumInvariant(), 10000);
});

await t('repeating the same booking payment holds once', async () => {
    seed({ real: 100 });
    const a = await hold(40, 'BK-SAME'); const b = await hold(40, 'BK-SAME');
    assert.strictEqual(a.escrowId, b.escrowId);
    assert.deepStrictEqual([cust().walletBalance, holds().length], [60, 1]);
});

await t('zero, negative, NaN and non-numeric amounts are refused before anything is read', async () => {
    seed({ real: 100 });
    for (const bad of [0, -5, NaN, 'abc', null, undefined, Infinity]) {
        await assert.rejects(() => hold(bad), /greater than zero|Amount/, String(bad));
    }
    assert.strictEqual(holds().length, 0);
});

await t('a hold that skipped the integrity read is refused (no caller can bypass it)', async () => {
    seed({ real: 100 });
    const plan = escrow.planHold({ bookingId: 'BK-RAW', customerId: C, artisanId: A, amount: 10 });
    await assert.rejects(() => fake.db.runTransaction(async (txn) => {
        const { lockSnap, customerSnap } = await escrow.readHold(txn, plan);
        return escrow.applyHold(txn, plan, { lockSnap, customerSnap });          // no `spend`
    }), (e) => e.reason === 'integrity_unchecked');
    assert.strictEqual(holds().length, 0);
});

console.log('\n── The rules, as pure functions ──\n');

await t('spendable is never negative and never above the stored balance', () => {
    assert.strictEqual(ledger.spendablePesewas(190, -12300), 0);     // the incident account today
    assert.strictEqual(ledger.spendablePesewas(300, 300), 300);
    assert.strictEqual(ledger.spendablePesewas(5, 9000), 500);       // ledger ahead: stored wins
});

await t('reconcileCustomerWallet: a clean wallet passes; the 3 → 300 edit is reported with its difference', () => {
    const transactions = [{ type: 'topup', amount: 3, status: 'successful' }];
    assert.strictEqual(ledger.reconcileCustomerWallet({ customer: { walletBalance: 3, escrowBalance: 0 }, transactions }).ok, true);
    const r = ledger.reconcileCustomerWallet({ customer: { walletBalance: 300, escrowBalance: 0 }, transactions });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.checks.find((x) => x.name === 'wallet').difference, 297);
});

await t('verified ledger: holds and withdrawals always count; a failed withdrawal does not', () => {
    const v = ledger.verifiedCustomerPesewas({
        customerId: C,
        transactions: [
            { type: 'topup', amount: 100, status: 'successful', source: 'webhook', paystackRef: 'R' },
            { type: 'escrow_hold', amount: 30, status: 'completed' },
            { type: 'withdrawal', amount: 20, status: 'processing', payoutId: 'P1' },
            { type: 'withdrawal', amount: 10, status: 'processing', payoutId: 'P2' },
        ],
        payouts: [{ id: 'P1', status: 'success' }, { id: 'P2', status: 'failed' }],
        locks: new Map([['R', { uid: C, amountGHS: 100 }]]),
    });
    assert.deepStrictEqual([v.pesewas, v.unverified.length], [5000, 0]);
});

console.log('\n── Tipping: real money, once, from verified funds ──\n');

const BK = 'BK-TIP';
const AUTH = { uid: C };
const art = () => fake.db._get(`artisans/${A}`);
function seedTip({ real = 50, stored = real, status = 'completed', artisanId = A } = {}) {
    seed({ real, stored });
    fake.db._set(`artisans/${A}`, { availableBalance: 0, totalEarned: 0, withdrawnTotal: 0, name: 'Kofi' });
    fake.db._set(`bookings/${BK}`, { customerId: C, artisanId, status, serviceType: 'plumbing' });
}
const tipRefusal = async (data, auth = AUTH) => {
    const restore = quiet(); const e = await tips.tipArtisan(auth, data).catch((x) => x); restore();
    assert.ok(e instanceof Error, 'expected a refusal'); return e;
};

await t('a GHS 10 tip leaves the customer\'s wallet and lands, whole, in the professional\'s', async () => {
    seedTip({ real: 50 });
    const r = await tips.tipArtisan(AUTH, { bookingId: BK, amount: 10 });
    assert.deepStrictEqual([r.tipped, r.amount, r.duplicate], [true, 10, false]);
    assert.strictEqual(cust().walletBalance, 40);
    assert.deepStrictEqual([art().availableBalance, art().totalEarned], [10, 10], 'no commission on a tip');
    const tip = fake.db._get(`tips/${BK}`);
    assert.deepStrictEqual([tip.customerId, tip.artisanId, tip.amount, tip.status, tip.commission], [C, A, 10, 'paid', 0]);
    assert.strictEqual(fake.db._get(`customers/${C}/transactions/tip_${BK}`).type, 'tip');
    assert.strictEqual(fake.db._get(`artisans/${A}/transactions/tip_${BK}`).amount, 10);
    assert.ok(fake.db._keys('financialAudit/').some((k) => fake.db._get(k).action === 'tip'), 'audited');
});

await t('a double tap or retry tips once; concurrent requests tip once', async () => {
    seedTip({ real: 50 });
    await Promise.all([tips.tipArtisan(AUTH, { bookingId: BK, amount: 10 }), tips.tipArtisan(AUTH, { bookingId: BK, amount: 10 })]);
    const again = await tips.tipArtisan(AUTH, { bookingId: BK, amount: 10 });
    assert.strictEqual(again.duplicate, true);
    assert.deepStrictEqual([cust().walletBalance, art().availableBalance], [40, 10]);
});

await t('one tip per booking: a second, different tip is refused', async () => {
    seedTip({ real: 50 });
    await tips.tipArtisan(AUTH, { bookingId: BK, amount: 10 });
    const e = await tipRefusal({ bookingId: BK, amount: 5 });
    assert.strictEqual(e.reason, 'already_tipped');
    assert.strictEqual(cust().walletBalance, 40);
});

await t('only on the customer\'s own, completed booking — and only to its professional', async () => {
    seedTip({ real: 50, status: 'in_progress' });
    assert.strictEqual((await tipRefusal({ bookingId: BK, amount: 5 })).reason, 'not_completed');
    seedTip({ real: 50 });
    assert.strictEqual((await tipRefusal({ bookingId: BK, amount: 5 }, { uid: 'someone_else' })).reason, 'not_yours');
    seedTip({ real: 50, artisanId: null });
    assert.strictEqual((await tipRefusal({ bookingId: BK, amount: 5 })).reason, 'no_artisan');
    seedTip({ real: 50 });
    await tips.tipArtisan(AUTH, { bookingId: BK, amount: 5, artisanId: 'attacker' });     // ignored field
    assert.strictEqual(fake.db._get(`tips/${BK}`).artisanId, A, 'the booking decides who is tipped');
    assert.strictEqual(fake.db._get('artisans/attacker'), undefined);
});

await t('more than the wallet holds is refused, and nothing moves', async () => {
    seedTip({ real: 5 });
    const e = await tipRefusal({ bookingId: BK, amount: 10 });
    assert.strictEqual(e.reason, 'insufficient_balance');
    assert.deepStrictEqual([cust().walletBalance, art().availableBalance, fake.db._has(`tips/${BK}`)], [5, 0, false]);
});

await t('a console-raised balance cannot be tipped away (3 → 300)', async () => {
    seedTip({ real: 3, stored: 300 });
    assert.strictEqual((await tipRefusal({ bookingId: BK, amount: 100 })).reason, 'balance_unverified');
    assert.strictEqual(art().availableBalance, 0);
});

await t('zero, negative, below GHS 1, fractional pesewas, NaN and Infinity are refused', async () => {
    seedTip({ real: 50 });
    for (const bad of [0, -5, 0.5, 1.234, NaN, 'abc', null, Infinity]) {
        assert.strictEqual((await tipRefusal({ bookingId: BK, amount: bad })).reason, 'invalid', String(bad));
    }
    assert.strictEqual(cust().walletBalance, 50);
});

await t('the professional can withdraw a real tip; a forged tip row is not withdrawable', () => {
    const rows = [{ type: 'tip', amount: 10, bookingId: BK, status: 'completed' }];
    const ok = ledger.verifiedArtisanPesewas({ artisanId: A, transactions: rows,
        tips: new Map([[BK, { artisanId: A, amount: 10, status: 'paid' }]]) });
    assert.strictEqual(ok.pesewas, 1000);
    const forged = ledger.verifiedArtisanPesewas({ artisanId: A, transactions: rows, tips: new Map() });
    assert.deepStrictEqual([forged.pesewas, forged.unverified[0].reason], [0, 'no_tip_record']);
    const other = ledger.verifiedArtisanPesewas({ artisanId: A, transactions: rows,
        tips: new Map([[BK, { artisanId: 'someone', amount: 10, status: 'paid' }]]) });
    assert.strictEqual(other.pesewas, 0);
});

await t('after a tip both wallets still reconcile with their ledgers', async () => {
    seedTip({ real: 50 });
    await tips.tipArtisan(AUTH, { bookingId: BK, amount: 10 });
    const rows = (p) => fake.db._keys(p).map((k) => ({ id: k.split('/').pop(), ...fake.db._get(k) }));
    const c = ledger.reconcileCustomerWallet({ customer: cust(), transactions: rows(`customers/${C}/transactions/`) });
    const a = ledger.reconcileArtisanWallet({ artisan: art(), transactions: rows(`artisans/${A}/transactions/`) });
    assert.deepStrictEqual([c.ok, a.ok], [true, true]);
});

await t('the router reaches it: bookingActions { action: "tipArtisan" }', async () => {
    seedTip({ real: 50 });
    const restore = quiet();
    const index = require(path.join(FN, 'index.js'));
    restore();
    const r = await index.bookingActions({ auth: { uid: C, token: {} }, data: { action: 'tipArtisan', payload: { bookingId: BK, amount: 20 } } });
    assert.deepStrictEqual([r.tipped, cust().walletBalance], [true, 30]);
    const e = await index.bookingActions({ auth: null, data: { action: 'tipArtisan', payload: { bookingId: BK, amount: 20 } } }).catch((x) => x);
    assert.strictEqual(e.code, 'unauthenticated');
    const low = await index.bookingActions({ auth: { uid: C, token: {} }, data: { action: 'tipArtisan', payload: { bookingId: BK, amount: 5 } } }).catch((x) => x);
    assert.deepStrictEqual([low.code, low.details.reason], ['failed-precondition', 'already_tipped']);
});

console.log('\n── An earning is only as real as the money that funded its escrow ──\n');

// The console-edited wallet funded two escrows that were then released: the
// artisan's GHS 93.50 was backed by real escrows of money that never came in.
// (walletLedger backedHoldEscrowIds / escrowFundingProven)
const FUNDER = 'cust_funder';
const lockFor = (ref, amountGHS) => new Map([[ref, { uid: FUNDER, paystackRef: ref, amountGHS }]]);
const topupRow = (amount, at, ref = 'REF-F') => ({ id: `tp_${at}`, type: 'topup', amount, status: 'successful', source: 'webhook', paystackRef: ref, createdAt: at });
const holdRow  = (amount, escrowId, at) => ({ id: `h_${escrowId}`, type: 'escrow_hold', amount, status: 'completed', escrowId, createdAt: at });
const released = (share, extra = {}) => ({ customerId: FUNDER, status: 'released', artisanShare: share, ...extra });
const earnRow  = (amount, escrowId) => ({ id: `e_${escrowId}`, type: 'earning', amount, escrowId, status: 'completed' });

await t('a hold the verified balance covered is backed; holds after a console edit are not (the incident)', () => {
    const rows = [
        topupRow(6, '2026-08-18T00:00:00Z'),
        holdRow(5, 'esc_aug', '2026-08-18T00:10:00Z'),
        holdRow(60, 'esc_60', '2026-10-22T16:40:00Z'),         // verified before: 1
        holdRow(50, 'esc_50', '2026-10-22T16:44:00Z'),         // verified before: −59
    ];
    const backed = ledger.backedHoldEscrowIds({ customerId: FUNDER, transactions: rows, locks: lockFor('REF-F', 6) });
    assert.deepStrictEqual([...backed], ['esc_aug']);
});

await t('holds are judged in time order, whatever order the rows arrive in', () => {
    const rows = [
        holdRow(50, 'esc_second', '2026-09-03T00:00:00Z'),
        holdRow(60, 'esc_first',  '2026-09-02T00:00:00Z'),
        topupRow(100, '2026-09-01T00:00:00Z'),
    ];
    const backed = ledger.backedHoldEscrowIds({ customerId: FUNDER, transactions: rows, locks: lockFor('REF-F', 100) });
    assert.deepStrictEqual([...backed], ['esc_first'], 'the first GHS 60 is covered; only 40 remains for the 50');
});

await t('a hold covered only in part is not proven; an unverified top-up covers nothing', () => {
    const partial = ledger.backedHoldEscrowIds({ customerId: FUNDER, locks: lockFor('REF-F', 30),
        transactions: [topupRow(30, '2026-09-01T00:00:00Z'), holdRow(50, 'esc_p', '2026-09-02T00:00:00Z')] });
    assert.strictEqual(partial.size, 0);
    const legacy = { id: 'old', type: 'topup', amount: 900, status: 'successful', createdAt: '2026-05-01T00:00:00Z' };   // no source, no ref
    const none = ledger.backedHoldEscrowIds({ customerId: FUNDER, transactions: [legacy, holdRow(50, 'esc_l', '2026-09-02T00:00:00Z')] });
    assert.strictEqual(none.size, 0);
});

await t('artisan earnings count only from proven escrows; unmarked escrows fail closed', () => {
    const escrows = new Map([
        ['esc_aug', released(4.25)], ['esc_60', released(51)], ['esc_50', released(42.5)],
        ['esc_new', released(17, { fundingVerified: true })],
    ]);
    const transactions = [earnRow(4.25, 'esc_aug'), earnRow(51, 'esc_60'), earnRow(42.5, 'esc_50'), earnRow(17, 'esc_new')];
    const proven = ledger.verifiedArtisanPesewas({ artisanId: A, transactions, escrows, backedEscrows: new Set(['esc_aug']) });
    assert.strictEqual(proven.pesewas, 425 + 1700);
    assert.deepStrictEqual(proven.unverified.map((u) => [u.id, u.reason]),
        [['e_esc_60', 'escrow_funding_unverified'], ['e_esc_50', 'escrow_funding_unverified']]);
    // No replay supplied: only the escrow applyHold marked counts.
    assert.strictEqual(ledger.verifiedArtisanPesewas({ artisanId: A, transactions, escrows }).pesewas, 1700);
});

await t('every escrow today\'s hold path creates is marked fundingVerified', async () => {
    seed({ real: 50 });
    await hold(20);
    const [e] = holds();
    assert.strictEqual(e.fundingVerified, true);
});

console.log('\n── "Spent" is what actually went to professionals ──\n');

await t('spent = paid into escrow − refunded − still held + tips (never the dead counter)', () => {
    const rows = [
        { type: 'topup', amount: 500, status: 'successful' },
        { type: 'escrow_hold', amount: 126, status: 'completed' },     // released
        { type: 'escrow_hold', amount: 80, status: 'completed' },      // refunded
        { type: 'refund', amount: 80, status: 'completed' },
        { type: 'escrow_hold', amount: 40, status: 'completed' },      // still held
        { type: 'escrow_hold', amount: 50, status: 'completed' },      // partial dispute: 20 back
        { type: 'refund', amount: 20, status: 'completed' },
        { type: 'tip', amount: 10, status: 'completed' },
        { type: 'withdrawal', amount: 30, status: 'processing' },      // not spending
    ];
    assert.strictEqual(ledger.customerSpentPesewas({ transactions: rows, escrowBalance: 40 }), (126 + 30 + 10) * 100);
    assert.strictEqual(ledger.customerSpentPesewas({ transactions: [], escrowBalance: 0 }), 0);
    assert.strictEqual(ledger.customerSpentPesewas({ transactions: [{ type: 'escrow_hold', amount: 5, status: 'completed' }], escrowBalance: 5 }), 0);
});

await t('the profile shows the derived figure, not customers.spent', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'customer-app', 'js', 'pages', 'profilePage.js'), 'utf8');
    assert.match(src, /customerSpentPesewas\(/);
    assert.ok(!/data\.spent/.test(src), 'the dead counter is no longer read');
});

console.log(`\nwallet-integrity: ${passed} passed, ${failed} failed`);
if (failed) { for (const [nm, e] of failures) console.error(`\n✗ ${nm}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
