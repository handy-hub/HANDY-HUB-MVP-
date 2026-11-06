'use strict';

/**
 * tests/marketplace-integrity.test.cjs — callout settlement, quote money,
 * verified profiles and performance metrics. (2026-10-19 artisan audit)
 *
 * Run: node tests/marketplace-integrity.test.cjs
 * (The Firestore-rules half — verified-field locks, review fields, offer
 *  events, cancellation attribution — is tests/privacy-access-rules.test.mjs.)
 *
 *   AR-07  an emergency callout fee settles at the lifecycle transition it
 *          belongs to (completion, cancellation, dispute resolution), once,
 *          by one rule — not via the 7-day stuck-escrow sweep.
 *   AR-08  no malformed, unbounded or imprecise amount can become a quote; a
 *          malformed STORED quote is withdrawn, never approved, rejected or
 *          expired into paying the callout.
 *   AR-10  verified name and trade change only through an administrator's
 *          review; dispatch matches only verified trade terms.
 *   AR-12  response rate has one definition over deduplicated offer events;
 *          dispatch ranks on measured data, neutral where there is none.
 *
 * The REAL functions/*.js modules (and the real escrow.js money movements)
 * run against tests/support/fake-firebase.cjs.
 */

require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { createRequire } = require('module');

const fake = require('./support/fake-firebase.cjs').install();
const ROOT = path.join(__dirname, '..');
const FN   = path.join(ROOT, 'functions');
const fnRequire = createRequire(path.join(FN, 'package.json'));
const { geohashForLocation } = fnRequire('geofire-common');

const escrow       = require(path.join(FN, 'financial', 'escrow.js'));
const pricing      = require(path.join(FN, 'pricing.js'));
const bookings     = require(path.join(FN, 'bookings.js'));
const quotes       = require(path.join(FN, 'quotes.js'));
const disputes     = require(path.join(FN, 'disputes.js'));
const autoRelease  = require(path.join(FN, 'financial', 'escrowAutoRelease.js'));
const dispatch     = require(path.join(FN, 'dispatch.js'));
const jobOffers    = require(path.join(FN, 'jobOffers.js'));
const artisanIndex = require(path.join(FN, 'artisanIndex.js'));
const account      = require(path.join(FN, 'artisanAccount.js'));
const quoteMoney   = require(path.join(FN, 'shared', 'quoteMoney.js'));
const metrics      = require(path.join(FN, 'shared', 'performanceMetrics.js'));
const { COMMISSION_RATE, ADMIN_EMAILS } = require(path.join(FN, 'config.js'));

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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PAST = new Date(Date.now() - 86400000).toISOString();

// ── Fixtures ──────────────────────────────────────────────────────────────────
const CUST = 'cust_m1', ART = 'art_m1', BK = 'bk_m1', ESC = 'esc_callout_m1';
const FEE = 80;
const SHARE = +(FEE * (1 - COMMISSION_RATE)).toFixed(2);

/** A paid emergency booking whose callout is held in escrow (real escrow shape). */
function seedEmergency({ status = 'accepted', over = {}, escrowOver = {} } = {}) {
    fake.db._reset();
    fake.messaging._reset();
    fake.db._set(`customers/${CUST}`, { walletBalance: 500, escrowBalance: FEE, spent: 0 });
    fake.db._set(`artisans/${ART}`, { userType: 'artisan', status: 'active', verificationStatus: 'approved',
                                      availableBalance: 0, pendingBalance: 0, totalEarned: 0 });
    fake.db._set(`escrow/${ESC}`, {
        bookingId: BK, customerId: CUST, artisanId: ART, kind: 'callout', status: 'held', amount: FEE,
        commission: +(FEE * COMMISSION_RATE).toFixed(2), artisanShare: SHARE, commissionRate: COMMISSION_RATE,
        autoReleaseAt: new Date(Date.now() + 7 * 86400000).toISOString(), ...escrowOver,
    });
    fake.db._set(`_escrow_locks/${BK}_callout`, { bookingId: BK, customerId: CUST, kind: 'callout', escrowId: ESC, amount: FEE });
    fake.db._set(`bookings/${BK}`, {
        customerId: CUST, artisanId: ART, track: 'emergency', type: 'emergency', isEmergency: true,
        status, price: 0, calloutFee: FEE, calloutPaid: true, calloutEscrowId: ESC, ...over,
    });
}
const bk   = () => fake.db._get(`bookings/${BK}`);
const esc  = () => fake.db._get(`escrow/${ESC}`);
const art  = () => fake.db._get(`artisans/${ART}`);
const cust = () => fake.db._get(`customers/${CUST}`);

async function transition(from, to, over = {}) {
    const beforeDoc = { ...bk(), status: from };
    const afterDoc  = { ...bk(), status: to, ...over };
    fake.db._set(`bookings/${BK}`, afterDoc);
    await bookings.onBookingStatusChanged({
        params: { bookingId: BK },
        data: { before: { data: () => beforeDoc }, after: { data: () => afterDoc } },
    });
}
const ADMIN_AUTH = { uid: 'adm_m1', token: { email: ADMIN_EMAILS[0], email_verified: true } };

(async () => {
console.log('\n── AR-07 · one rule decides who a held callout belongs to ──\n');

await t('calloutDecision: every state on both tracks', () => {
    const d = (b, ctx) => pricing.calloutDecision({ calloutPaid: true, calloutEscrowId: 'e', ...b }, ctx);
    const em = (status, extra = {}, ctx = {}) => d({ track: 'emergency', status, ...extra }, ctx);
    assert.strictEqual(em('completed', {}, { event: 'completed' }).to, 'artisan');
    for (const s of ['accepted', 'quoted', 'en_route', 'cancelled']) {
        assert.strictEqual(em(s).to, 'customer', `emergency ${s}: no visit yet → customer`);
    }
    assert.strictEqual(em('cancelled', {}, { priorStatus: 'in_progress' }).to, 'artisan', 'cancelled after arrival');
    assert.strictEqual(em('cancelled', { arrivedAt: PAST }).to, 'artisan', 'arrivedAt is the evidence');
    assert.strictEqual(em('cancelled', {}, { priorStatus: 'quoted' }).to, 'customer', 'an emergency quote is not a visit');
    assert.strictEqual(em('awaiting').to, 'artisan');
    assert.deepStrictEqual([em('disputed').hold, em('disputed').to], [true, null]);
    const ins = (status, extra = {}, ctx = {}) => d({ track: 'inspection', status, ...extra }, ctx);
    assert.strictEqual(ins('cancelled', {}, { priorStatus: 'inspection_done' }).to, 'artisan');
    assert.strictEqual(ins('cancelled', {}, { priorStatus: 'inspection_scheduled' }).to, 'customer');
    assert.strictEqual(ins('cancelled', { inspectionDoneAt: PAST }).to, 'artisan');
    assert.strictEqual(ins('disputed').hold, true);
    assert.strictEqual(d({ track: 'emergency', status: 'resolved', resolution: 'full_refund' }).to, 'customer');
    assert.strictEqual(d({ track: 'emergency', status: 'resolved', resolution: 'release_artisan' }).to, 'artisan');
    assert.strictEqual(d({ track: 'emergency', status: 'resolved', resolution: 'partial_refund' }).hold, true);
    assert.strictEqual(d({ track: 'emergency', status: 'resolved', resolution: 'partial_refund', calloutResolution: 'artisan' }).to, 'artisan');
    assert.strictEqual(pricing.calloutDecision({ calloutPaid: false, calloutEscrowId: 'e' }).to, null, 'unpaid: nothing');
    assert.strictEqual(pricing.calloutDecision({ calloutPaid: true, calloutEscrowId: 'e', calloutSettled: 'released' }).to, null);
});

await t('an emergency job COMPLETING releases its callout now — artisan paid once, commission kept', async () => {
    seedEmergency({ status: 'awaiting', over: { arrivedAt: PAST } });
    await transition('awaiting', 'completed');
    assert.strictEqual(esc().status, 'released');
    assert.strictEqual(bk().calloutSettled, 'released');
    assert.strictEqual(art().availableBalance, SHARE, 'artisan receives the share, not the gross fee');
    assert.strictEqual(cust().escrowBalance, 0);
    assert.notStrictEqual(esc().autoReleaseAt, undefined);   // not the sweep's doing
});

await t('a re-delivered completion event never pays twice', async () => {
    seedEmergency({ status: 'awaiting', over: { arrivedAt: PAST } });
    await transition('awaiting', 'completed');
    // at-least-once delivery: the identical event again, with the stale before/after
    await bookings.onBookingStatusChanged({
        params: { bookingId: BK },
        data: { before: { data: () => ({ ...bk(), status: 'awaiting', calloutSettled: undefined }) },
                after:  { data: () => ({ ...bk(), status: 'completed', calloutSettled: undefined }) } },
    });
    assert.strictEqual(art().availableBalance, SHARE);
    assert.strictEqual(esc().status, 'released');
});

await t('a customer cancelling before the artisan sets out is refunded', async () => {
    for (const from of ['accepted', 'quoted']) {
        seedEmergency({ status: from });
        await transition(from, 'cancelled');
        assert.strictEqual(esc().status, 'refunded', from);
        assert.strictEqual(bk().calloutSettled, 'refunded', from);
        assert.strictEqual(art().availableBalance, 0, `${from}: the artisan earned nothing`);
        assert.strictEqual(cust().walletBalance, 500 + FEE, from);
    }
});

await t('a cancellation AFTER arrival (admin) pays the artisan for the visit', async () => {
    seedEmergency({ status: 'in_progress', over: { arrivedAt: PAST } });
    await transition('in_progress', 'cancelled');
    assert.strictEqual(esc().status, 'released');
    assert.strictEqual(art().availableBalance, SHARE);
});

await t('a disputed booking is never settled by the trigger or the sweep', async () => {
    seedEmergency({ status: 'in_progress', over: { arrivedAt: PAST }, escrowOver: { autoReleaseAt: PAST } });
    await transition('in_progress', 'disputed');
    assert.strictEqual(esc().status, 'held');
    await autoRelease.runAutoRelease();
    assert.strictEqual(esc().status, 'held', 'the 7-day sweep used to refund this without anyone looking');
    assert.strictEqual(cust().walletBalance, 500);
});

await t('resolveDispute settles a callout-only booking (was unresolvable)', async () => {
    for (const [resolution, to] of [['full_refund', 'refunded'], ['release_artisan', 'released']]) {
        seedEmergency({ status: 'disputed', over: { arrivedAt: PAST } });
        await disputes.resolveDispute(ADMIN_AUTH, { bookingId: BK, resolution, notes: 'reviewed' });
        assert.strictEqual(esc().status, to, resolution);
        assert.strictEqual(bk().status, 'resolved');
        assert.strictEqual(bk().calloutResolution, to === 'released' ? 'artisan' : 'customer');
    }
    seedEmergency({ status: 'disputed' });
    await rejects(() => disputes.resolveDispute(ADMIN_AUTH, { bookingId: BK, resolution: 'partial_refund', notes: 'x', customerAmount: 10 }),
        /settled whole/);
    assert.strictEqual(esc().status, 'held', 'a refused resolution moves nothing');
});

await t('a partial resolution with a held callout must say where the callout goes', async () => {
    seedEmergency({ status: 'disputed', over: { arrivedAt: PAST } });
    fake.db._set('escrow/esc_job_m1', { bookingId: BK, customerId: CUST, artisanId: ART, kind: 'job', status: 'held', amount: 200,
        commission: 30, artisanShare: 170, commissionRate: COMMISSION_RATE });
    fake.db._set(`customers/${CUST}`, { walletBalance: 500, escrowBalance: FEE + 200, spent: 0 });
    await rejects(() => disputes.resolveDispute(ADMIN_AUTH, { bookingId: BK, resolution: 'partial_refund', notes: 'split', customerAmount: 50 }),
        /callout fee/);
    assert.strictEqual(fake.db._get('escrow/esc_job_m1').status, 'held', 'validated before any money moves');
    await rejects(() => disputes.resolveDispute(ADMIN_AUTH, { bookingId: BK, resolution: 'partial_refund', notes: 'x', customerAmount: 50, calloutTo: 'nobody' }),
        /calloutTo/);
    await disputes.resolveDispute(ADMIN_AUTH, { bookingId: BK, resolution: 'partial_refund', notes: 'split', customerAmount: 50, calloutTo: 'artisan' });
    assert.strictEqual(esc().status, 'released');
    assert.strictEqual(bk().calloutResolution, 'artisan');
});

await t('a failed settlement is flagged and the hourly retry completes it exactly once', async () => {
    seedEmergency({ status: 'awaiting', over: { arrivedAt: PAST } });
    const real = escrow.releaseEscrow;
    escrow.releaseEscrow = async () => { throw new Error('UNAVAILABLE: deadline exceeded'); };
    try { await transition('awaiting', 'completed'); } finally { escrow.releaseEscrow = real; }
    assert.strictEqual(esc().status, 'held');
    assert.strictEqual(bk().calloutSettlePending, 'artisan');
    await pricing.checkBookingTimeouts();
    assert.strictEqual(esc().status, 'released');
    assert.strictEqual(bk().calloutSettlePending, undefined);
    await pricing.checkBookingTimeouts();
    assert.strictEqual(art().availableBalance, SHARE, 'retried once, paid once');
});

await t('a hold that never got stamped on the booking is still settled by the sweep', async () => {
    // payEmergencyCallout writes calloutPaid AFTER the hold; that write failed.
    seedEmergency({ status: 'completed', over: { calloutPaid: false, calloutEscrowId: null }, escrowOver: { autoReleaseAt: PAST } });
    await autoRelease.runAutoRelease();
    assert.strictEqual(esc().status, 'released', 'used to stay held forever while reported as settled');
    assert.strictEqual(art().availableBalance, SHARE);
});

await t('completion and the sweep racing each other settle once', async () => {
    seedEmergency({ status: 'awaiting', over: { arrivedAt: PAST }, escrowOver: { autoReleaseAt: PAST } });
    fake.db._set(`bookings/${BK}`, { ...bk(), status: 'completed' });
    await Promise.all([
        bookings.onBookingStatusChanged({ params: { bookingId: BK },
            data: { before: { data: () => ({ ...bk(), status: 'awaiting' }) }, after: { data: () => bk() } } }),
        autoRelease.runAutoRelease(),
    ]);
    assert.strictEqual(art().availableBalance, SHARE);
    assert.strictEqual(esc().status, 'released');
});

await t('an unpaid emergency completes with nothing to settle', async () => {
    seedEmergency({ status: 'awaiting', over: { calloutPaid: false, calloutEscrowId: null } });
    fake.db._set(`escrow/${ESC}`, { ...esc(), status: 'refunded' });
    await transition('awaiting', 'completed');
    assert.strictEqual(art().availableBalance, 0);
});

await t('an inspection callout already credited at approval is not paid again on completion', async () => {
    seedEmergency({ status: 'awaiting', over: { track: 'inspection', calloutSettled: 'released', quoteApproved: true } });
    fake.db._set(`escrow/${ESC}`, { ...esc(), status: 'released' });
    await transition('awaiting', 'completed');
    assert.strictEqual(art().availableBalance, 0, 'the trigger did not touch an already-settled callout');
});

console.log('\n── AR-08 · every amount in a quote is validated, in pesewas ──\n');

const V = (input) => quoteMoney.validateQuoteInput(input, { maxQuoteGHS: 10000 });
await t('malformed amounts are refused, never coerced', () => {
    for (const bad of [NaN, Infinity, -Infinity, -1, 0, 'abc', '12abc', '1e3', '0x10', '', null, undefined, {}, [], true, '-5', ' ', '1,000']) {
        assert.strictEqual(V({ labourCost: bad }).ok, false, `labour ${String(bad)} must be refused`);
    }
    assert.strictEqual(V({ labourCost: 100.001 }).ok, false, 'three decimals are not a price');
    assert.strictEqual(V({ labourCost: 100, materials: 'pipes' }).ok, false, 'materials must be a list');
    assert.strictEqual(V({ labourCost: 100, materials: [{ name: 'Pipe', qty: 'two', unitPrice: 5 }] }).ok, false);
    assert.strictEqual(V({ labourCost: 100, materials: [{ name: '', qty: 1, unitPrice: 5 }] }).ok, false);
    assert.strictEqual(V({ labourCost: 100, materials: [{ name: 'Pipe', qty: 1, unitPrice: NaN }] }).ok, false);
    assert.strictEqual(V({ labourCost: 100, note: { evil: 1 } }).ok, false, 'a non-text note');
});

await t('limits: per field, per line, line count, quantity and the TOTAL', () => {
    assert.strictEqual(V({ labourCost: 10000 }).ok, true, 'the ceiling itself is allowed');
    assert.strictEqual(V({ labourCost: 10000.01 }).ok, false);
    const line = (qty, unitPrice) => ({ labourCost: 1, materials: [{ name: 'Item', qty, unitPrice }] });
    assert.strictEqual(V(line(1001, 1)).ok, false, 'quantity cap');
    assert.strictEqual(V(line(1, 10000.01)).ok, false, 'unit price cap');
    assert.strictEqual(V(line(1000, 10.01)).ok, false, 'line total cap');
    const big = V({ labourCost: 6000, materials: [{ name: 'Tank', qty: 1, unitPrice: 5000 }] });
    assert.strictEqual(big.ok, false, 'labour within cap + materials within cap can still exceed the total cap');
    assert.match(big.message, /total/);
    const many = { labourCost: 1, materials: Array.from({ length: 31 }, (_, i) => ({ name: `M${i}`, qty: 1, unitPrice: 1 })) };
    assert.strictEqual(V(many).ok, false, 'at most 30 lines');
});

await t('rounding is exact and half-up to the pesewa; numeric strings are read exactly', () => {
    const q = (materials) => V({ labourCost: '0.10', materials }).quote;
    assert.strictEqual(V({ labourCost: 0.1, materials: [{ name: 'a', qty: 1, unitPrice: 0.2 }] }).quote.jobQuote, 0.3);
    assert.strictEqual(q([{ name: 'a', qty: 3, unitPrice: '33.33' }]).materialsCost, 99.99);
    assert.strictEqual(q([{ name: 'a', qty: 2.5, unitPrice: 10.01 }]).materialsCost, 25.03, '25.025 → 25.03');
    const r = V({ labourCost: '150.50', materials: [{ name: 'Tap', qty: '2', unitPrice: '12.25' }] });
    assert.deepStrictEqual([r.quote.labourCost, r.quote.materialsCost, r.quote.jobQuote], [150.5, 24.5, 175]);
    assert.strictEqual(r.quote.materials[0].total, 24.5);
});

function seedQuoting({ track = 'inspection', status = track === 'inspection' ? 'inspection_done' : 'accepted', over = {} } = {}) {
    seedEmergency({ status, over: { track, ...over } });
}
await t('submitJobQuote refuses a malformed quote and leaves the booking untouched', async () => {
    seedQuoting();
    const before = JSON.stringify(bk());
    for (const payload of [
        { labourCost: 'abc' }, { labourCost: 100, materials: [{ name: 'x', qty: 'NaN', unitPrice: 1 }] },
        { labourCost: 100, materials: [{ name: 'x', qty: 1e9, unitPrice: 9999 }] }, { labourCost: 9000, materials: [{ name: 'y', qty: 1, unitPrice: 2000 }] },
    ]) {
        const e = await rejects(() => quotes.submitJobQuote({ uid: ART }, { bookingId: BK, ...payload }));
        assert.strictEqual(e.reason, 'invalid_quote');
        assert.ok(Array.isArray(e.fields) && e.fields.length, 'the failing field is named');
    }
    assert.strictEqual(JSON.stringify(bk()), before, 'nothing was written');
});

await t('a valid quote is stored with exact totals', async () => {
    seedQuoting();
    await quotes.submitJobQuote({ uid: ART }, { bookingId: BK, labourCost: '120.50',
        materials: [{ name: 'Valve', qty: 2, unitPrice: 14.99 }], note: '  ok  ' });
    const b = bk();
    assert.deepStrictEqual([b.status, b.labourCost, b.materialsCost, b.jobQuote, b.quoteNote], ['quoted', 120.5, 29.98, 150.48, 'ok']);
    assert.ok(quoteMoney.checkStoredQuote(b).ok);
});

const NAN_QUOTE = { status: 'quoted', jobQuote: NaN, labourCost: 100, materialsCost: NaN, materials: [{ name: 'x', qty: NaN, unitPrice: 5, total: NaN }],
                    quoteSubmittedAt: new Date(Date.now() - 49 * 3600000).toISOString(), inspectionDoneAt: new Date(Date.now() - 60 * 3600000).toISOString() };
await t('checkStoredQuote catches NaN, over-limit and inconsistent legacy quotes', () => {
    assert.strictEqual(quoteMoney.checkStoredQuote(NAN_QUOTE).ok, false);
    assert.strictEqual(quoteMoney.checkStoredQuote({ jobQuote: 20000 }).ok, false);
    assert.strictEqual(quoteMoney.checkStoredQuote({ jobQuote: 100, labourCost: 60, materialsCost: 30 }).ok, false, 'parts ≠ total');
    assert.strictEqual(quoteMoney.checkStoredQuote({ jobQuote: 90, labourCost: 60, materialsCost: 30 }).ok, true);
    assert.strictEqual(quoteMoney.checkStoredQuote({ jobQuote: 300 }).ok, true, 'a legacy total-only quote is fine');
});

await t('REJECTING a malformed stored quote withdraws it: no revision used, no callout paid', async () => {
    for (const revisions of [0, 1]) {   // 1 = this would have been the FINAL rejection
        seedQuoting({ over: { ...NAN_QUOTE, quoteRevisionCount: revisions, inspectionDoneAt: PAST } });
        const r = await quotes.rejectJobQuote({ uid: CUST }, { bookingId: BK });
        assert.strictEqual(r.voided, true);
        const b = bk();
        assert.strictEqual(b.status, 'inspection_done', 'back to where the artisan quotes from');
        assert.strictEqual(b.quoteRevisionCount, revisions, 'no revision consumed');
        assert.strictEqual(esc().status, 'held', 'the callout was NOT released to the artisan');
        assert.strictEqual(b.jobQuote, undefined);
    }
});

await t('an EXPIRED malformed quote is withdrawn, not settled; the artisan gets a fresh 24 h', async () => {
    seedQuoting({ over: { ...NAN_QUOTE } });
    await pricing.checkBookingTimeouts();
    assert.strictEqual(bk().status, 'inspection_done');
    assert.strictEqual(esc().status, 'held', 'expiry used to cancel and pay the callout for an unapprovable quote');
    await pricing.checkBookingTimeouts();   // the no-quote sweep must not fire on the fresh void
    assert.strictEqual(bk().status, 'inspection_done');
    assert.strictEqual(esc().status, 'held');
});

await t('a VALID expired quote still follows the agreed rule (callout to the artisan)', async () => {
    seedQuoting({ over: { status: 'quoted', jobQuote: 300, labourCost: 300, quoteSubmittedAt: NAN_QUOTE.quoteSubmittedAt, inspectionDoneAt: PAST } });
    await pricing.checkBookingTimeouts();
    assert.strictEqual(bk().status, 'cancelled');
    assert.strictEqual(esc().status, 'released');
});

await t('the quote composer uses the shared validator, not parseFloat(...) || 0 (Phase 3: one composer)', () => {
    assert.ok(!/validateQuoteInput|submitJobQuote/.test(read('artisan-app/jobs.html')), 'a second composer is back on Jobs');
    for (const rel of ['shared/js/ui/quoteComposer.js']) {
        const src = read(rel);
        assert.match(src, /validateQuoteInput\(/, rel);
        assert.ok(!/parseFloat\([^)]*\)\s*\|\|\s*0/.test(src.slice(src.indexOf('validateQuoteInput'))), `${rel} still coerces`);
    }
});

console.log('\n── AR-10 · verified name and trade change only through review ──\n');

function seedArtisan(over = {}) {
    fake.db._reset();
    fake.db._set(`artisans/${ART}`, { userType: 'artisan', status: 'active', verificationStatus: 'approved',
        name: 'Kofi Boateng', fullName: 'Kofi Boateng', category: 'Plumbing', specialty: 'Plumber', skills: ['leaks'], ...over });
    fake.db._set(`verification_requests/${ART}`, { artisanId: ART, name: 'Kofi Boateng', category: 'Plumbing', status: 'approved' });
}
const AA = { uid: ART, token: { email: 'kofi@example.com' } };

await t('an approved artisan REQUESTS a change; nothing on the profile moves until review', async () => {
    seedArtisan();
    const r = await account.requestProfileChange(AA, { name: 'Kofi A. Boateng', category: 'Electrical', reason: 'Name misspelt; now certified electrician' });
    assert.deepStrictEqual(r.fields.sort(), ['category', 'name']);
    assert.strictEqual(art().name, 'Kofi Boateng');
    assert.strictEqual(art().category, 'Plumbing');
    assert.deepStrictEqual(art().pendingProfileChange.fields.sort(), ['category', 'name']);
    const req = fake.db._get(`profile_change_requests/${ART}`);
    assert.deepStrictEqual([req.status, req.current.category, req.requested.category], ['pending', 'Plumbing', 'Electrical']);
    await rejects(() => account.requestProfileChange(AA, { name: 'Other Name', reason: 'another try here' }), /already have a change/);
});

await t('requests are validated, and only an approved artisan needs one', async () => {
    seedArtisan();
    await rejects(() => account.requestProfileChange(AA, { category: 'Astronaut', reason: 'new career path' }), /listed trades/);
    await rejects(() => account.requestProfileChange(AA, { name: 'K', reason: 'too short a name' }), /full name/);
    await rejects(() => account.requestProfileChange(AA, { name: 'Kofi Boateng', reason: 'same as before' }), /Nothing to change/);
    await rejects(() => account.requestProfileChange(AA, { name: 'Kofi Mensah', reason: 'short' }), /why/);
    for (const [vs, re] of [['draft', /edit these details directly/], ['rejected', /edit these details directly/],
                            ['pending_review', /being reviewed/], ['suspended', /being reviewed/]]) {
        seedArtisan({ verificationStatus: vs });
        await rejects(() => account.requestProfileChange(AA, { name: 'Kofi Mensah', reason: 'legal name change' }), re);
    }
});

await t('an administrator approves: profile, verification record and log updated together', async () => {
    seedArtisan();
    await account.requestProfileChange(AA, { name: 'Kofi A. Boateng', category: 'electrical', reason: 'Certified electrician now' });
    await rejects(() => account.reviewProfileChange({ uid: ART, token: {} }, { artisanId: ART, decision: 'approve' }), /Unauthorized|Admin/);
    await account.reviewProfileChange(ADMIN_AUTH, { artisanId: ART, decision: 'approve', notes: 'certificate seen' });
    const a = art();
    assert.deepStrictEqual([a.name, a.fullName, a.category, a.pendingProfileChange], ['Kofi A. Boateng', 'Kofi A. Boateng', 'Electrical', null]);
    assert.strictEqual(a.lastProfileChange.status, 'approved');
    assert.strictEqual(fake.db._get(`verification_requests/${ART}`).category, 'Electrical');
    assert.strictEqual(fake.db._get(`profile_change_requests/${ART}`).status, 'approved');
    assert.ok(fake.db._keys('verification_logs/').some((k) => fake.db._get(k).action === 'profile_change_approved'));
    await rejects(() => account.reviewProfileChange(ADMIN_AUTH, { artisanId: ART, decision: 'approve' }), /no longer pending/);
});

await t('a rejection needs a reason and leaves the verified details as they were', async () => {
    seedArtisan();
    await account.requestProfileChange(AA, { category: 'Electrical', reason: 'I do electrical too' });
    await rejects(() => account.reviewProfileChange(ADMIN_AUTH, { artisanId: ART, decision: 'reject' }), /reason/);
    await account.reviewProfileChange(ADMIN_AUTH, { artisanId: ART, decision: 'reject', notes: 'No electrical certificate' });
    assert.strictEqual(art().category, 'Plumbing');
    assert.deepStrictEqual([art().lastProfileChange.status, art().lastProfileChange.notes], ['rejected', 'No electrical certificate']);
    await account.requestProfileChange(AA, { category: 'Electrical', reason: 'Certificate now attached' });
    await account.cancelProfileChange(AA);
    assert.strictEqual(fake.db._get(`profile_change_requests/${ART}`).status, 'withdrawn');
    assert.strictEqual(art().pendingProfileChange, null);
});

await t('the callable routes every action, and refuses unknown ones', async () => {
    seedArtisan({ verificationStatus: 'draft' });
    await rejects(() => account.handleArtisanAccount(AA, { action: 'approveMyself' }), /Unknown action/);
    fake.db._reset();
    const r = await account.handleArtisanAccount({ uid: 'new1', token: { email: 'n@example.com', email_verified: true } }, {});
    assert.strictEqual(r.result, 'created', 'no action = ensure (the sign-in path)');
});

await t('dispatch matches VERIFIED trade terms only — a free skill is not a trade', () => {
    const skills = artisanIndex._buildSkills({ category: 'Plumbing', specialty: 'Plumber', skills: ['wiring', 'electrical'] });
    assert.ok(skills.includes('plumbing') && skills.includes('pipe'));
    assert.ok(!skills.includes('electrical') && !skills.includes('wiring'));
});

await t('an approved plumber with an "electrical" skill is not offered an electrical job', async () => {
    fake.db._reset();
    const P = { lat: 5.6037, lng: -0.187 };
    const doc = artisanIndex._buildIndexDoc(ART, { category: 'Plumbing', specialty: 'Plumber', skills: ['electrical'],
        isAvailable: true, status: 'active', verificationStatus: 'approved', name: 'Kofi' }, P.lat, P.lng);
    fake.db._set(`artisan_index/${ART}`, { ...doc, updatedAt: PAST });
    // Requests made just now: one made a day ago is past its search deadline,
    // and dispatchRound would refuse it for that reason instead of the trade.
    const JUST_NOW = new Date(Date.now() - 60 * 1000).toISOString();
    fake.db._set('bookings/bk_el', { customerId: CUST, status: 'pending', serviceType: 'Electrical', lat: 5.61, lng: -0.18, createdAt: JUST_NOW });
    const el = await dispatch.dispatchRound('bk_el');
    assert.ok(el.unfulfilled, `refused for the trade, not skipped: ${JSON.stringify(el)}`);
    assert.strictEqual(fake.db._has('job_offers/bk_el'), false);
    fake.db._set('bookings/bk_pl', { customerId: CUST, status: 'pending', serviceType: 'Plumbing', lat: 5.61, lng: -0.18, createdAt: JUST_NOW });
    await dispatch.dispatchRound('bk_pl');
    assert.strictEqual(fake.db._get('job_offers/bk_pl').artisanId, ART, 'and "Plumbing" (capitalised) still matches');
});

await t('the profile page cannot write verified details once they are locked', () => {
    const src = read('artisan-app/profile.html');
    assert.match(src, /if \(!locked\) \{\s*updates\.name/);
    assert.match(src, /requestProfileChange\(change\)/);
    const ob = read('artisan-app/onboarding.html');
    assert.ok(!/trustScore:\s*50/.test(ob), 'onboarding no longer writes the reviewer\'s fields');
});

console.log('\n── AR-12 · response rate: one definition, deduplicated events ──\n');

const NOW = Date.parse('2026-10-20T12:00:00Z');
const ev = (i, outcome, daysAgo = 1, extra = {}) => ({ id: `b${i}_1_${ART}`, artisanId: ART, outcome,
    closedAt: new Date(NOW - daysAgo * 86400000).toISOString(), ...extra });

await t('responded / (responded + missed); declines count; withdrawn and unknown excluded', () => {
    const s = metrics.computeResponseStats([ev(1, 'accepted'), ev(2, 'declined'), ev(3, 'expired'), ev(4, 'accepted'),
        ev(5, 'declined'), ev(6, 'withdrawn'), ev(7, 'mystery')], { nowMs: NOW });
    assert.deepStrictEqual([s.responded, s.missed, s.excluded, s.counted, s.rate, s.sufficient], [4, 1, 2, 5, 0.8, true]);
});

await t('below the minimum there is no rate — never a figure built on one offer', () => {
    const s = metrics.computeResponseStats([ev(1, 'expired')], { nowMs: NOW });
    assert.deepStrictEqual([s.rate, s.sufficient, s.counted], [null, false, 1]);
    assert.strictEqual(metrics.computeResponseStats([], { nowMs: NOW }).rate, null);
});

await t('duplicates collapse; offers outside the 90-day window do not count', () => {
    const dup = ev(1, 'expired');
    const s = metrics.computeResponseStats([dup, dup, { ...dup }, ev(2, 'accepted', 91), ev(3, 'accepted', 89),
        ev(4, 'accepted'), ev(5, 'accepted'), ev(6, 'accepted'), ev(7, 'accepted', 0, { closedAt: 'garbage' })], { nowMs: NOW });
    assert.deepStrictEqual([s.missed, s.responded, s.counted, s.rate], [1, 4, 5, 0.8]);
});

function seedOffer({ round = 1, expiresAtMs = Date.now() + 60000 } = {}) {
    fake.db._reset();
    fake.db._set(`artisans/${ART}`, { userType: 'artisan', status: 'active', verificationStatus: 'approved' });
    fake.db._set(`bookings/${BK}`, { customerId: CUST, status: 'pending', currentArtisanId: ART, artisanId: null,
        dispatchStatus: 'dispatched', currentDispatchRound: round, responseDeadline: { seconds: 0 }, serviceType: 'plumbing' });
    fake.db._set(`job_offers/${BK}`, jobOffers.buildOfferDoc({ serviceType: 'plumbing' }, { bookingId: BK, artisanId: ART, expiresAtMs, round }));
}
const events = () => fake.db._keys('offer_events/').map((k) => ({ id: k.split('/')[1], ...fake.db._get(k) }));

await t('declining writes one deterministic event and refreshes the artisan\'s stats', async () => {
    seedOffer();
    await jobOffers.respondToJobOffer({ uid: ART }, { bookingId: BK, decision: 'decline' });
    const e = events();
    assert.strictEqual(e.length, 1);
    assert.deepStrictEqual([e[0].id, e[0].outcome, e[0].artisanId], [`${BK}_1_${ART}`, 'declined', ART]);
    assert.ok(e[0].responseMs >= 0);
    assert.deepStrictEqual([art().responseStats.counted, art().responseStats.rate, art().responseRate], [1, null, null]);
});

await t('an expired offer writes an "expired" event for the artisan who let it lapse', async () => {
    seedOffer();
    await dispatch.checkExpiredDispatches();
    const e = events();
    assert.strictEqual(e.length, 1);
    assert.strictEqual(e[0].outcome, 'expired');
    assert.strictEqual(art().responseStats.missed, 1);
});

await t('a late "withdrawn" cannot overwrite an outcome, and withdrawn offers are not counted', async () => {
    seedOffer();
    await jobOffers.respondToJobOffer({ uid: ART }, { bookingId: BK, decision: 'accept' });
    await jobOffers.closeOffer(null, BK, 'withdrawn');
    assert.strictEqual(fake.db._get(`job_offers/${BK}`).offerStatus, 'accepted');
    assert.strictEqual(events()[0].outcome, 'accepted');
    seedOffer();
    await jobOffers.closeOffer(null, BK, 'withdrawn');
    assert.strictEqual(events()[0].outcome, 'withdrawn');
    assert.strictEqual(metrics.computeResponseStats(events()).counted, 0);
});

await t('five answered offers make a rate; the index carries it, and null until then', async () => {
    seedOffer();
    for (let i = 0; i < 5; i++) {
        fake.db._set(`offer_events/x${i}_1_${ART}`, { artisanId: ART, outcome: i < 4 ? 'accepted' : 'expired', closedAt: new Date().toISOString() });
    }
    await jobOffers.refreshResponseStats(ART);
    assert.deepStrictEqual([art().responseStats.sufficient, art().responseRate], [true, 0.8]);
    assert.strictEqual(artisanIndex._buildIndexDoc(ART, art(), 5.6, -0.19).responseRate, 0.8);
    assert.strictEqual(artisanIndex._buildIndexDoc(ART, { responseStats: { sufficient: false, rate: null } }, 5.6, -0.19).responseRate, null);
    assert.strictEqual(artisanIndex._buildIndexDoc(ART, {}, 5.6, -0.19).completionRate, null, 'not measured — never 0.8 again');
});

console.log('\n── AR-12 · dispatch ranks on measured data, neutral where there is none ──\n');

await t('unknown inputs are neutral and the same for everyone', () => {
    const a = metrics.scoreCandidate({ id: 'a', _distKm: 2 });
    const b = metrics.scoreCandidate({ id: 'b', _distKm: 2, rating: 0, reviewCount: 0, responseRate: null });
    assert.strictEqual(a.score, b.score);
    assert.strictEqual(a.parts.rating.measured, false);
    assert.strictEqual(a.parts.response.measured, false);
});

await t('rating counts only from 3 reviews; response rate counts when measured', () => {
    const two   = metrics.scoreCandidate({ rating: 1, reviewCount: 2 });
    const three = metrics.scoreCandidate({ rating: 1, reviewCount: 3 });
    assert.strictEqual(two.parts.rating.value, 4, 'one bad early review no longer sinks a new artisan');
    assert.strictEqual(three.parts.rating.value, 1);
    const responsive = metrics.scoreCandidate({ responseRate: 1 });
    const ignoring   = metrics.scoreCandidate({ responseRate: 0.2 });
    assert.ok(responsive.score > ignoring.score);
    assert.strictEqual(metrics.scoreCandidate({ responseRate: 7 }).parts.response.measured, false, 'out-of-range is not data');
});

await t('distance and being online still decide between equals; ties are stable', () => {
    const ranked = metrics.rankCandidates([
        { id: 'far', _distKm: 9 }, { id: 'near', _distKm: 1 }, { id: 'online-far', _distKm: 9, isOnline: true },
        { id: 'b-tie', _distKm: 3 }, { id: 'a-tie', _distKm: 3 },
    ]).map((a) => a.id);
    assert.deepStrictEqual(ranked, ['online-far', 'near', 'a-tie', 'b-tie', 'far']);
});

await t('completion rate counts only the artisan\'s own cancellations', () => {
    const b = (status, cancelledBy) => ({ status, cancelledBy });
    const s = metrics.computeCompletionStats([b('completed'), b('completed'), b('completed'), b('completed'),
        b('cancelled', 'artisan'), b('cancelled', 'customer'), b('cancelled', 'system'), b('cancelled'), b('accepted')]);
    assert.deepStrictEqual([s.completed, s.cancelledByArtisan, s.ended, s.rate], [4, 1, 5, 0.8]);
    assert.strictEqual(metrics.computeCompletionStats([b('completed')]).rate, null);
});

await t('the performance page shows unavailable states and no false promises', () => {
    const src = read('artisan-app/performance.html');
    assert.match(src, /responseStats/);
    assert.ok(!/_artisan\.responseRate/.test(src), 'no longer reads a field nothing writes');
    assert.ok(!/unlock priority job dispatch/i.test(src), 'level does not change dispatch');
    assert.ok(!/higher ratings unlock/i.test(src));
    assert.match(src, /m\.value === null \? '—'/);
});

console.log(`\nmarketplace-integrity: ${passed} passed, ${failed} failed`);
if (failed) { for (const [name, e] of failures) console.log(`\n✗ ${name}\n${e.stack}`); process.exit(1); }
})();
