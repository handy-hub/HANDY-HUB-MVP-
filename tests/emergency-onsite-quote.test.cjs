'use strict';
/**
 * tests/emergency-onsite-quote.test.cjs — a paid emergency is priced on site
 * (decision Q1, 2026-11-06).
 *
 * The artisan sets out as soon as the emergency fee is held, marks arrival,
 * then quotes. The quote flow assumed quotes come before travel: approval set
 * the booking back to 'accepted' ("you may now set out") and a rejection
 * reverted to 'accepted'. A quote sent on site now returns the booking to
 * in_progress, approved or not; the standard and inspection tracks are unchanged.
 *
 * The emergency fee follows the existing rule (pricing.calloutDecision): it is
 * the artisan's once they arrived, so a rejected or expired on-site quote pays
 * the visit; no new entitlement is introduced here.
 *
 * The REAL functions/quotes.js, pricing.js and financial/escrow.js run against
 * an in-memory Firestore (tests/support/fake-firebase.cjs).
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const path   = require('path');
const { fundCustomer } = require('./support/walletEvidence.cjs');

const fake    = require('./support/fake-firebase.cjs').install();
const ROOT    = path.join(__dirname, '..');
const quotes  = require(path.join(ROOT, 'functions', 'quotes.js'));
const pricing = require(path.join(ROOT, 'functions', 'pricing.js'));

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

const CUSTOMER = 'cust_em_1';
const ARTISAN  = 'art_em_1';
const ID       = 'bk_em_1';
const FEE      = 90;
const ARRIVED  = '2026-11-06T09:30:00.000Z';

function seed({ track = 'emergency', status = 'in_progress', wallet = 1000, over = {} } = {}) {
    fake.db._reset();
    fake.messaging._reset();
    fake.db._set(`customers/${CUSTOMER}`, { walletBalance: wallet, escrowBalance: track === 'emergency' ? FEE : 0, spent: 0 });
    fundCustomer(fake.db, CUSTOMER, wallet);
    fake.db._set(`artisans/${ARTISAN}`, { status: 'active', verificationStatus: 'approved', availableBalance: 0, totalEarned: 0 });
    fake.db._set(`bookings/${ID}`, {
        customerId: CUSTOMER, artisanId: ARTISAN, track, status, serviceType: 'Electrical',
        ...(track === 'emergency' ? { calloutPaid: true, calloutFee: FEE, calloutEscrowId: 'esc_fee' } : {}),
        ...(status === 'in_progress' ? { arrivedAt: ARRIVED } : {}),
        quoteRevisionCount: 0,
        ...over,
    });
}
const booking = () => fake.db._get(`bookings/${ID}`);
const notesFor = (uid, re) => fake.db._keys('customer_notifications/').map((k) => fake.db._get(k))
    .filter((n) => n.receiverId === uid && (!re || re.test(`${n.title} ${n.message}`)));
const ART = { uid: ARTISAN };
const CUS = { uid: CUSTOMER };

(async () => {
console.log('\n── Where a quote may be sent from ──\n');

await t('a paid emergency quotes on site: in_progress → quoted, remembering where it came from', async () => {
    seed();
    await quotes.submitJobQuote(ART, { bookingId: ID, labourCost: 250 });
    const b = booking();
    assert.strictEqual(b.status, 'quoted');
    assert.strictEqual(b.quotedFrom, 'in_progress');
    assert.strictEqual(b.jobQuote, 250);
});
await t('not while still travelling: en_route is refused', async () => {
    seed({ status: 'en_route', over: { arrivedAt: undefined } });
    await rejects(() => quotes.submitJobQuote(ART, { bookingId: ID, labourCost: 250 }), /booking is en_route/);
    assert.strictEqual(booking().status, 'en_route');
});
await t('the standard track still quotes only from accepted', async () => {
    seed({ track: 'standard', status: 'in_progress' });
    await rejects(() => quotes.submitJobQuote(ART, { bookingId: ID, labourCost: 250 }), /booking is in_progress/);
    seed({ track: 'standard', status: 'accepted' });
    await quotes.submitJobQuote(ART, { bookingId: ID, labourCost: 250 });
    assert.strictEqual(booking().quotedFrom, 'accepted');
});
await t('the server rule and the helper agree, per track', () => {
    assert.deepStrictEqual(quotes.quotableStatuses({ track: 'inspection' }), ['inspection_done']);
    assert.deepStrictEqual(quotes.quotableStatuses({ track: 'emergency' }), ['accepted', 'in_progress']);
    assert.deepStrictEqual(quotes.quotableStatuses({ track: 'standard' }), ['accepted']);
    assert.deepStrictEqual(quotes.quotableStatuses({}), ['accepted']);
});

console.log('\n── The customer\'s decision returns the booking to the site ──\n');

await t('approval holds the full quote and returns to in_progress: the work starts', async () => {
    seed();
    await quotes.submitJobQuote(ART, { bookingId: ID, labourCost: 250 });
    const res = await quotes.approveJobQuote(CUS, { bookingId: ID });
    const b = booking();
    assert.strictEqual(b.status, 'in_progress');
    assert.strictEqual(b.quoteApproved, true);
    assert.strictEqual(res.escrowAmount, 250, 'the emergency fee is not a credit against the work');
    assert.strictEqual(b.escrowHeldAmount, 250);
    assert.ok(b.escrowId, 'the work is funded');
    assert.match(notesFor(ARTISAN, /Quote Approved/)[0].message, /You can start the work\.$/);
});
await t('a quote sent before travel still approves to accepted, "head to the job"', async () => {
    seed({ track: 'standard', status: 'accepted' });
    await quotes.submitJobQuote(ART, { bookingId: ID, labourCost: 250 });
    await quotes.approveJobQuote(CUS, { bookingId: ID });
    assert.strictEqual(booking().status, 'accepted');
    assert.match(notesFor(ARTISAN, /Quote Approved/)[0].message, /You can now head to the job\.$/);
});
await t('a first rejection returns to in_progress for one revision, quote cleared', async () => {
    seed();
    await quotes.submitJobQuote(ART, { bookingId: ID, labourCost: 250 });
    await quotes.rejectJobQuote(CUS, { bookingId: ID, reason: 'Too high' });
    const b = booking();
    assert.strictEqual(b.status, 'in_progress');
    assert.strictEqual(b.quoteRevisionCount, 1);
    assert.strictEqual(b.jobQuote, undefined);
    // …and the revision can be sent from where the artisan is.
    await quotes.submitJobQuote(ART, { bookingId: ID, labourCost: 200 });
    assert.strictEqual(booking().status, 'quoted');
});
await t('a voided on-site quote also returns to in_progress', () => {
    const p = quotes.voidQuotePatch({ track: 'emergency', quotedFrom: 'in_progress' }, []);
    assert.strictEqual(p.status, 'in_progress');
    assert.strictEqual(quotes.voidQuotePatch({ track: 'emergency', quotedFrom: 'accepted' }, []).status, 'accepted');
    assert.strictEqual(quotes.voidQuotePatch({ track: 'inspection', quotedFrom: 'inspection_done' }, []).status, 'inspection_done');
});

console.log('\n── The emergency fee pays for the visit (existing rule, unchanged) ──\n');

await t('a final rejection on site closes the booking; the fee is the artisan\'s (arrived)', async () => {
    seed({ over: { quoteRevisionCount: 1 } });
    await quotes.submitJobQuote(ART, { bookingId: ID, labourCost: 250 });
    await quotes.rejectJobQuote(CUS, { bookingId: ID });
    const b = booking();
    assert.strictEqual(b.status, 'cancelled');
    // The status trigger settles the fee through calloutDecision.
    assert.deepStrictEqual(pricing.calloutDecision(b, { priorStatus: 'quoted' }).to, 'artisan');
});
await t('an unpaid emergency quoted before travel is still refunded on cancellation', () => {
    const b = { track: 'emergency', status: 'cancelled', calloutPaid: true, calloutEscrowId: 'e', quotedFrom: 'accepted' };
    assert.strictEqual(pricing.calloutDecision(b, { priorStatus: 'quoted' }).to, 'customer');
});

console.log('\n── An expired quote says what happened to the money ──\n');

await t('per track, matching calloutDecision', () => {
    const insp = pricing.quoteExpiredMessages({ track: 'inspection' });
    assert.match(insp.customerMsg, /callout fee covers the completed inspection/);
    const onsite = pricing.quoteExpiredMessages({ track: 'emergency', calloutPaid: true, arrivedAt: ARRIVED });
    assert.match(onsite.customerMsg, /emergency fee covers the visit/);
    assert.match(onsite.artisanMsg, /emergency fee is being released to you/);
    const before = pricing.quoteExpiredMessages({ track: 'emergency', calloutPaid: true });
    assert.match(before.customerMsg, /returned to your wallet/);
    const std = pricing.quoteExpiredMessages({ track: 'standard' });
    assert.match(std.customerMsg, /Nothing was charged for the work/);
    assert.ok(!/inspection/.test(std.customerMsg + onsite.customerMsg + before.customerMsg), 'no inspection wording off the inspection track');
});

console.log(`\nemergency-onsite-quote: ${passed} passed, ${failed} failed`);
if (failed) { for (const [name, e] of failures) console.log(`\n✗ ${name}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
