'use strict';
/**
 * tests/escrow-work-hold.test.cjs — the 7-day escrow timer never refunds work
 * that is under way (decision Q2, 2026-11-06).
 *
 * runAutoRelease refunded a held job payment 7 days after the hold unless the
 * booking was awaiting or completed, so a job still en route or in progress
 * lost its payment while the artisan worked (Phase 0 WF-03). Now the payment
 * stays held, support is alerted once (admin_notifications + financialAudit),
 * and the escrow is re-checked a day later. No money moves while it is held.
 * Every other route is unchanged, and is held here too.
 *
 * The REAL functions/financial/escrowAutoRelease.js and escrow.js run against
 * an in-memory Firestore (tests/support/fake-firebase.cjs).
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const path   = require('path');

const fake = require('./support/fake-firebase.cjs').install();
const FN   = path.join(__dirname, '..', 'functions');
const autoRelease = require(path.join(FN, 'financial', 'escrowAutoRelease.js'));
const { COMMISSION_RATE } = require(path.join(FN, 'config.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

const CUST = 'cust_wh1', ART = 'art_wh1', BK = 'bk_wh1', ESC = 'esc_job_wh1';
const AMOUNT = 300;
const PAST = new Date(Date.now() - 3600_000).toISOString();

function seed(status, { escrowOver = {}, track = 'standard' } = {}) {
    fake.db._reset();
    fake.messaging._reset();
    fake.db._set(`customers/${CUST}`, { walletBalance: 200, escrowBalance: AMOUNT, spent: 0 });
    fake.db._set(`artisans/${ART}`, { userType: 'artisan', status: 'active', verificationStatus: 'approved',
                                      availableBalance: 0, pendingBalance: 0, totalEarned: 0 });
    fake.db._set(`escrow/${ESC}`, {
        bookingId: BK, customerId: CUST, artisanId: ART, kind: 'job', status: 'held', amount: AMOUNT,
        commission: +(AMOUNT * COMMISSION_RATE).toFixed(2), artisanShare: +(AMOUNT * (1 - COMMISSION_RATE)).toFixed(2),
        commissionRate: COMMISSION_RATE, autoReleaseAt: PAST, ...escrowOver,
    });
    fake.db._set(`_escrow_locks/${BK}`, { bookingId: BK, customerId: CUST, kind: 'job', escrowId: ESC, amount: AMOUNT });
    fake.db._set(`bookings/${BK}`, { customerId: CUST, artisanId: ART, track, status, quoteApproved: true, jobQuote: AMOUNT, escrowId: ESC });
}
const esc    = () => fake.db._get(`escrow/${ESC}`);
const cust   = () => fake.db._get(`customers/${CUST}`);
const alerts = () => fake.db._keys('admin_notifications/').map((k) => fake.db._get(k)).filter((n) => n.type === 'escrow_work_hold');
const audits = () => fake.db._keys('financialAudit/').map((k) => fake.db._get(k)).filter((n) => n.action === 'escrow_work_hold');

(async () => {
console.log('\n── Work under way: held, never refunded by the timer ──\n');

for (const status of ['en_route', 'in_progress']) {
    await t(`${status} after 7 days: the payment stays held, support is alerted, no money moves`, async () => {
        seed(status);
        const before = { ...cust() };
        const res = await autoRelease.runAutoRelease();
        assert.strictEqual(esc().status, 'held');
        assert.strictEqual(res.stats.heldWorkUnderWay, 1);
        assert.strictEqual(res.stats.refunded, 0);
        assert.strictEqual(cust().walletBalance, before.walletBalance, 'no refund');
        assert.strictEqual(cust().escrowBalance, before.escrowBalance);
        // Looked at again a day later, so it does not sit in every run.
        const next = Date.parse(esc().autoReleaseAt);
        assert.ok(next > Date.now() + 23 * 3600_000 && next <= Date.now() + 24 * 3600_000 + 5000, esc().autoReleaseAt);
        assert.strictEqual(esc().workHoldCount, 1);
        assert.strictEqual(esc().needsAttention, true, 'badged on the admin Finance page');
        assert.strictEqual(alerts().length, 1);
        assert.match(alerts()[0].message, new RegExp(`Booking ${BK} is still en route or in progress`));
        assert.strictEqual(audits().length, 1);
    });
}

await t('the next run before the re-check leaves it alone; a later one holds again without a second alert', async () => {
    seed('in_progress');
    await autoRelease.runAutoRelease();
    const again = await autoRelease.runAutoRelease();
    assert.strictEqual(again.stats.queried, 0, 'not expired again until the re-check');
    fake.db._set(`escrow/${ESC}`, { ...esc(), autoReleaseAt: PAST });       // a day has passed
    await autoRelease.runAutoRelease();
    assert.strictEqual(esc().status, 'held');
    assert.strictEqual(esc().workHoldCount, 2);
    assert.strictEqual(alerts().length, 1, 'support is told once');
});

await t('once the job is marked done, the next check releases it to the artisan', async () => {
    seed('in_progress');
    await autoRelease.runAutoRelease();
    fake.db._set(`bookings/${BK}`, { ...fake.db._get(`bookings/${BK}`), status: 'awaiting' });
    fake.db._set(`escrow/${ESC}`, { ...esc(), autoReleaseAt: PAST });
    const res = await autoRelease.runAutoRelease();
    assert.strictEqual(res.stats.released, 1);
    assert.strictEqual(esc().status, 'released');
});

await t('support sees it: the admin Finance page badges a held escrow that needs attention', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'admin-dashboard', 'finance.html'), 'utf8');
    assert.match(src, /d\.status === 'held' && d\.needsAttention \? '<span class="badge attention"/);
});

console.log('\n── Every other route is unchanged ──\n');

await t('awaiting or completed: released to the artisan', async () => {
    for (const status of ['awaiting', 'completed']) {
        seed(status);
        await autoRelease.runAutoRelease();
        assert.strictEqual(esc().status, 'released', status);
    }
});
await t('accepted (never started) or cancelled: refunded to the customer', async () => {
    for (const status of ['accepted', 'cancelled']) {
        seed(status);
        await autoRelease.runAutoRelease();
        assert.strictEqual(esc().status, 'refunded', status);
        assert.strictEqual(alerts().length, 0, status);
    }
});
await t('disputed: held for resolveDispute, with no work-hold alert', async () => {
    seed('disputed');
    const res = await autoRelease.runAutoRelease();
    assert.strictEqual(esc().status, 'held');
    assert.strictEqual(res.stats.heldForDispute, 1);
    assert.strictEqual(alerts().length, 0);
});
await t('no artisan on the booking: refunded, as before', async () => {
    seed('in_progress', { escrowOver: { artisanId: null } });
    fake.db._set(`bookings/${BK}`, { ...fake.db._get(`bookings/${BK}`), artisanId: null });
    await autoRelease.runAutoRelease();
    assert.strictEqual(esc().status, 'refunded');
});

console.log(`\nescrow-work-hold: ${passed} passed, ${failed} failed`);
if (failed) { for (const [name, e] of failures) console.log(`\n✗ ${name}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
