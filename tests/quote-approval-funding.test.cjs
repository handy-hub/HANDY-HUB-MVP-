'use strict';

/**
 * tests/quote-approval-funding.test.cjs — a quote is approved only together
 * with the money that pays for it.
 *
 * Run: node tests/quote-approval-funding.test.cjs
 *
 * WHAT THIS PROTECTS (AR-02, 2026-10-19 artisan audit)
 * ────────────────────────────────────────────────────
 * approveJobQuote moved the booking to accepted + quoteApproved in one
 * transaction and held the escrow in ANOTHER. When the hold failed (a short
 * wallet, a conflicting lock) the booking stayed approved with nothing held:
 * the artisan's card offered "Mark En Route", firestore.rules allowed it, and
 * the customer's retry failed with "booking is accepted". Nothing reconciled
 * it — the auto-cancel for a failed hold only covered pending → accepted.
 *
 * The approval and the hold now commit in ONE Firestore transaction (the hold
 * is wallet → escrow, entirely inside Firestore — no payment provider is
 * involved). Covered here:
 *   • success: booking approved, escrowId on it, lock + escrow + wallet moved
 *     in the same commit, callout credit released, artisan told truthfully
 *   • a short wallet: refused with reason insufficient_balance and figures,
 *     NOTHING written, artisan not told to proceed — and a top-up then works
 *   • retries and concurrent approvals: exactly one hold, every caller answered
 *   • a conflicting lock, an unavailable artisan, an invalid or changed quote:
 *     refused, nothing moved
 *   • a quote fully covered by the visit fee: approved with no hold
 *   • the legacy "approved but unfunded" state is never reported as success
 *   • the invariant: approved ⇔ funded, after any sequence of the above
 *   • the callable passes the reason through, and the customer copy reads it
 *
 * The REAL functions/quotes.js, pricing.js and financial/escrow.js run against
 * an in-memory Firestore (tests/support/fake-firebase.cjs).
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const fake = require('./support/fake-firebase.cjs').install();
const ROOT   = path.join(__dirname, '..');
const quotes = require(path.join(ROOT, 'functions', 'quotes.js'));
const { COMMISSION_RATE } = require(path.join(ROOT, 'functions', 'config.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
async function rejects(fn, re) {
    try { await fn(); }
    catch (e) {
        if (re && !re.test(e.message)) throw new Error(`wrong refusal: "${e.message}"`);
        return e;
    }
    throw new Error('expected a refusal, got success');
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const CUSTOMER = 'cust_fund_1';
const ARTISAN  = 'art_fund_1';
const ID       = 'bk_fund_1';
const AUTH     = { uid: CUSTOMER };
const CALLOUT  = 60;
const QUOTE    = 300;
const DUE      = QUOTE - CALLOUT;          // 240 — the callout fee is credited

function seed({ wallet = 1000, quote = QUOTE, track = 'inspection', artisanStatus = 'active', over = {} } = {}) {
    fake.db._reset();
    fake.messaging._reset();
    fake.db._set(`customers/${CUSTOMER}`, { walletBalance: wallet, escrowBalance: track === 'inspection' ? CALLOUT : 0, spent: 0 });
    fake.db._set(`artisans/${ARTISAN}`, { status: artisanStatus, verificationStatus: 'approved', availableBalance: 0, totalEarned: 0 });
    if (track === 'inspection') {
        fake.db._set('escrow/esc_callout', {
            bookingId: ID, customerId: CUSTOMER, artisanId: ARTISAN, kind: 'callout', status: 'held',
            amount: CALLOUT, commission: CALLOUT * COMMISSION_RATE, artisanShare: CALLOUT * (1 - COMMISSION_RATE),
        });
        fake.db._set(`_escrow_locks/${ID}_callout`, { bookingId: ID, customerId: CUSTOMER, kind: 'callout', escrowId: 'esc_callout', amount: CALLOUT });
    }
    fake.db._set(`bookings/${ID}`, {
        customerId: CUSTOMER, artisanId: ARTISAN, track, status: 'quoted', jobQuote: quote,
        ...(track === 'inspection' ? { calloutPaid: true, calloutFee: CALLOUT, calloutEscrowId: 'esc_callout' } : {}),
        ...over,
    });
}
const booking  = () => fake.db._get(`bookings/${ID}`);
const customer = () => fake.db._get(`customers/${CUSTOMER}`);
const jobLock  = () => fake.db._get(`_escrow_locks/${ID}`);
const jobEscrows = () => fake.db._keys('escrow/').map((k) => fake.db._get(k)).filter((e) => e.kind === 'job');
const notesFor = (uid, re) => fake.db._keys('customer_notifications/').map((k) => fake.db._get(k))
    .filter((n) => n.receiverId === uid && (!re || re.test(`${n.title} ${n.message}`)));

/** Approved ⇔ funded: the one property AR-02 is about. */
function assertFundingInvariant(label = '') {
    const b = booking();
    const lock = jobLock();
    if (b.quoteApproved === true) {
        const due = Number(b.escrowHeldAmount || 0);
        if (due > 0) {
            assert.ok(lock, `${label}: approved with GHS ${due} due but no job lock`);
            assert.strictEqual(Number(lock.amount), due, `${label}: lock amount`);
            assert.strictEqual(b.escrowId, lock.escrowId, `${label}: booking.escrowId must name the hold`);
            const esc = fake.db._get(`escrow/${lock.escrowId}`);
            assert.ok(esc && esc.status === 'held' && Number(esc.amount) === due, `${label}: escrow must be held for ${due}`);
        }
    } else {
        assert.ok(!lock, `${label}: a job lock exists for an unapproved booking`);
        assert.strictEqual(jobEscrows().length, 0, `${label}: job escrow without approval`);
    }
}

(async () => {
console.log('\n── A funded approval ──\n');

await t('approval and hold commit together: status, escrowId, lock, escrow, wallet', async () => {
    seed();
    const res = await quotes.approveJobQuote(AUTH, { bookingId: ID });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.idempotent, false);
    assert.strictEqual(res.escrowAmount, DUE);
    const b = booking();
    assert.strictEqual(b.status, 'accepted');
    assert.strictEqual(b.quoteApproved, true);
    assert.strictEqual(b.escrowHeldAmount, DUE);
    assert.strictEqual(b.calloutCredit, CALLOUT);
    assert.strictEqual(b.escrowId, res.escrowId);
    assert.strictEqual(customer().walletBalance, 1000 - DUE);
    assertFundingInvariant('success');
});

await t('the callout credit is released to the artisan after the commit', async () => {
    seed();
    await quotes.approveJobQuote(AUTH, { bookingId: ID });
    assert.strictEqual(fake.db._get('escrow/esc_callout').status, 'released');
    assert.strictEqual(booking().calloutSettled, 'released');
});

await t('the artisan is told to proceed only with the money held, and both are told', async () => {
    seed();
    await quotes.approveJobQuote(AUTH, { bookingId: ID });
    assert.strictEqual(notesFor(ARTISAN, /Quote Approved/).length, 1);
    assert.match(notesFor(ARTISAN, /Quote Approved/)[0].message, /secured in escrow/);
    assert.strictEqual(notesFor(CUSTOMER, /Payment Secured/).length, 1);
});

console.log('\n── A short wallet ──\n');

await t('refused with reason insufficient_balance and the figures; NOTHING is written', async () => {
    seed({ wallet: 100 });
    const before = JSON.stringify([booking(), customer(), fake.db._get('escrow/esc_callout')]);
    const err = await rejects(() => quotes.approveJobQuote(AUTH, { bookingId: ID }), /insufficient balance/i);
    assert.strictEqual(err.reason, 'insufficient_balance');
    assert.strictEqual(err.needed, DUE);
    assert.strictEqual(err.available, 100);
    assert.strictEqual(JSON.stringify([booking(), customer(), fake.db._get('escrow/esc_callout')]), before);
    assert.strictEqual(booking().status, 'quoted');
    assertFundingInvariant('short wallet');
});

await t('the artisan is NOT told to proceed when the payment failed', async () => {
    seed({ wallet: 100 });
    await rejects(() => quotes.approveJobQuote(AUTH, { bookingId: ID }));
    assert.strictEqual(notesFor(ARTISAN, /Quote Approved/).length, 0);
});

await t('recoverable: after a top-up the same approval succeeds', async () => {
    seed({ wallet: 100 });
    await rejects(() => quotes.approveJobQuote(AUTH, { bookingId: ID }));
    fake.db._set(`customers/${CUSTOMER}`, { ...customer(), walletBalance: 500 });
    const res = await quotes.approveJobQuote(AUTH, { bookingId: ID });
    assert.strictEqual(res.idempotent, false);
    assert.strictEqual(customer().walletBalance, 500 - DUE);
    assertFundingInvariant('after top-up');
});

console.log('\n── Retries and concurrency ──\n');

await t('a retry after success is answered, never charged twice', async () => {
    seed();
    const first  = await quotes.approveJobQuote(AUTH, { bookingId: ID });
    const second = await quotes.approveJobQuote(AUTH, { bookingId: ID });
    assert.strictEqual(second.success, true);
    assert.strictEqual(second.idempotent, true);
    assert.strictEqual(second.escrowId, first.escrowId);
    assert.strictEqual(customer().walletBalance, 1000 - DUE);
    assert.strictEqual(jobEscrows().length, 1);
    assert.strictEqual(notesFor(ARTISAN, /Quote Approved/).length, 1, 'no second artisan notification');
});

await t('five concurrent approvals (double taps, tabs) make exactly one hold', async () => {
    seed();
    const results = await Promise.all(Array.from({ length: 5 }, () => quotes.approveJobQuote(AUTH, { bookingId: ID })));
    assert.ok(results.every((r) => r.success));
    assert.strictEqual(results.filter((r) => !r.idempotent).length, 1, 'exactly one fresh approval');
    assert.strictEqual(new Set(results.map((r) => r.escrowId)).size, 1);
    assert.strictEqual(jobEscrows().length, 1);
    assert.strictEqual(customer().walletBalance, 1000 - DUE);
    assertFundingInvariant('concurrent');
});

await t('concurrent approvals on a short wallet: all refused, nothing moved', async () => {
    seed({ wallet: 100 });
    const settled = await Promise.allSettled(Array.from({ length: 3 }, () => quotes.approveJobQuote(AUTH, { bookingId: ID })));
    assert.ok(settled.every((s) => s.status === 'rejected' && s.reason.reason === 'insufficient_balance'));
    assert.strictEqual(customer().walletBalance, 100);
    assertFundingInvariant('concurrent short');
});

console.log('\n── Every other refusal moves nothing ──\n');

await t('a lock that does not match this payment is a conflict, not a payment', async () => {
    seed();
    fake.db._set(`_escrow_locks/${ID}`, { bookingId: ID, customerId: CUSTOMER, kind: 'job', escrowId: 'esc_attack', amount: 0.01 });
    const err = await rejects(() => quotes.approveJobQuote(AUTH, { bookingId: ID }), /escrow conflict/i);
    assert.strictEqual(err.reason, 'escrow_conflict');
    assert.strictEqual(booking().status, 'quoted');
    assert.strictEqual(customer().walletBalance, 1000);
});

await t('an artisan who is no longer active blocks the approval before any money moves', async () => {
    seed({ artisanStatus: 'suspended' });
    const err = await rejects(() => quotes.approveJobQuote(AUTH, { bookingId: ID }), /no longer available/i);
    assert.strictEqual(err.reason, 'artisan_unavailable');
    assert.strictEqual(customer().walletBalance, 1000);
    assertFundingInvariant('artisan unavailable');
});

await t('an invalid quote (NaN, zero) is refused — and withdrawn for correction, no money moved', async () => {
    // AR-08: an unpriceable stored quote is voided (back to the quoting state,
    // no revision used) rather than left for a rejection or expiry to settle.
    for (const quote of [NaN, 0, -5, 'abc']) {
        seed({ quote });
        const e = await rejects(() => quotes.approveJobQuote(AUTH, { bookingId: ID }), /invalid amounts/i);
        assert.strictEqual(e.reason, 'quote_invalid');
        assert.strictEqual(customer().walletBalance, 1000);
        const b = fake.db._get(`bookings/${ID}`);
        assert.notStrictEqual(b.status, 'quoted', `quote ${quote} must be withdrawn`);
        assert.strictEqual(b.jobQuote, undefined);
        assert.strictEqual(b.quoteVoidReason, 'invalid_amounts');
        assert.strictEqual(Number(b.quoteRevisionCount || 0), 0, 'no revision used up');
        assertFundingInvariant(`quote ${quote}`);
    }
});

await t('a quote that changes between planning and commit is refused, not mis-charged', async () => {
    seed();
    const orig = fake.db.runTransaction;
    fake.db.runTransaction = function (fn) {
        fake.db.runTransaction = orig;                       // only the next transaction
        fake.db._set(`bookings/${ID}`, { ...booking(), jobQuote: 500 });
        return orig.call(this, fn);
    };
    const err = await rejects(() => quotes.approveJobQuote(AUTH, { bookingId: ID }), /quote changed/i);
    assert.strictEqual(err.reason, 'quote_changed');
    assert.strictEqual(customer().walletBalance, 1000);
    assertFundingInvariant('quote changed');
});

await t('only the booking\'s customer can approve', async () => {
    seed();
    await rejects(() => quotes.approveJobQuote({ uid: 'intruder' }, { bookingId: ID }), /not authorised/i);
    assert.strictEqual(booking().status, 'quoted');
});

await t('a cancelled booking cannot be approved', async () => {
    seed({ over: { status: 'cancelled' } });
    await rejects(() => quotes.approveJobQuote(AUTH, { bookingId: ID }), /booking is cancelled/);
    assert.strictEqual(customer().walletBalance, 1000);
});

console.log('\n── Fully credited, and the legacy state ──\n');

await t('a quote covered by the visit fee is approved with no hold', async () => {
    seed({ quote: 50, wallet: 0 });
    const res = await quotes.approveJobQuote(AUTH, { bookingId: ID });
    assert.strictEqual(res.escrowAmount, 0);
    assert.strictEqual(booking().quoteApproved, true);
    assert.strictEqual(booking().escrowHeldAmount, 0);
    assert.strictEqual(booking().escrowId, undefined);
    assert.strictEqual(jobEscrows().length, 0);
    assert.match(notesFor(ARTISAN, /Quote Approved/)[0].message, /covered by the visit fee/);
});

await t('the standard track (no callout) holds the full quote', async () => {
    seed({ track: 'standard', over: { status: 'quoted' } });
    const res = await quotes.approveJobQuote(AUTH, { bookingId: ID });
    assert.strictEqual(res.escrowAmount, QUOTE);
    assert.strictEqual(customer().walletBalance, 1000 - QUOTE);
    assertFundingInvariant('standard');
});

await t('a booking approved WITHOUT its money (pre-fix legacy) is never reported as success', async () => {
    seed({ over: { status: 'accepted', quoteApproved: true, escrowHeldAmount: DUE } });
    const err = await rejects(() => quotes.approveJobQuote(AUTH, { bookingId: ID }), /no payment is secured/i);
    assert.strictEqual(err.reason, 'funding_missing');
});

await t('the invariant holds across a mixed sequence of refusals, top-ups and retries', async () => {
    seed({ wallet: 50 });
    const steps = [
        () => quotes.approveJobQuote(AUTH, { bookingId: ID }),               // short
        () => fake.db._set(`customers/${CUSTOMER}`, { ...customer(), walletBalance: 239.99 }),
        () => quotes.approveJobQuote(AUTH, { bookingId: ID }),               // still short by 0.01
        () => fake.db._set(`customers/${CUSTOMER}`, { ...customer(), walletBalance: 240 }),
        () => Promise.all([quotes.approveJobQuote(AUTH, { bookingId: ID }), quotes.approveJobQuote(AUTH, { bookingId: ID })]),
        () => quotes.approveJobQuote(AUTH, { bookingId: ID }),               // replay
    ];
    for (const [i, step] of steps.entries()) {
        await Promise.resolve().then(step).catch(() => {});
        assertFundingInvariant(`step ${i}`);
    }
    assert.strictEqual(customer().walletBalance, 0);
    assert.strictEqual(jobEscrows().length, 1);
});

console.log('\n── The reason reaches the customer ──\n');

await t('the callable passes reason and figures through as HttpsError details', async () => {
    const index = require(path.join(ROOT, 'functions', 'index.js'));
    seed({ wallet: 100 });
    let err;
    try { await index.approveJobQuote({ auth: { uid: CUSTOMER }, data: { bookingId: ID } }); }
    catch (e) { err = e; }
    assert.ok(err, 'expected the callable to refuse');
    assert.strictEqual(err.code, 'failed-precondition');
    assert.deepStrictEqual(err.details, { reason: 'insufficient_balance', needed: DUE, available: 100 });
});

await t('describeApprovalFailure: short wallet → top-up with the shortfall; transport failure → check first', () => {
    const src = fs.readFileSync(path.join(ROOT, 'shared', 'js', 'domain', 'bookingTruth.js'), 'utf8')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
    // eslint-disable-next-line no-new-func
    const { describeApprovalFailure } = new Function(`${src}\nreturn { describeApprovalFailure };`)();
    const short = describeApprovalFailure({ code: 'functions/failed-precondition', message: 'Insufficient balance.',
        details: { reason: 'insufficient_balance', needed: 240, available: 100 } });
    assert.strictEqual(short.topUp, true);
    assert.strictEqual(short.shortfall, 140);
    assert.match(short.message, /GHS 140\.00 short.*nothing has been charged/i);
    const lost = describeApprovalFailure({ code: 'functions/deadline-exceeded', message: 'deadline-exceeded' });
    assert.strictEqual(lost.topUp, false);
    assert.match(lost.message, /check my bookings before retrying/i);
    const refused = describeApprovalFailure({ code: 'functions/failed-precondition', message: 'Quote cannot be approved — booking is cancelled.' });
    assert.strictEqual(refused.message, 'Quote cannot be approved — booking is cancelled.');
});

await t('both approval screens read the failure through describeApprovalFailure', () => {
    for (const f of ['customer-app/quote-approval.html', 'customer-app/js/quoteModalService.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        assert.match(src, /describeApprovalFailure\(err\)/, f);
    }
});

console.log(`\nquote-approval-funding: ${passed} passed, ${failed} failed`);
if (failed) { for (const [name, e] of failures) console.log(`\n✗ ${name}\n${e.stack}`); process.exit(1); }
})();
