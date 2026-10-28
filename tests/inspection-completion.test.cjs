'use strict';

/**
 * tests/inspection-completion.test.cjs — an inspection is completed only after
 * the artisan has arrived, and never ahead of the booked slot.
 *
 * Run: node tests/inspection-completion.test.cjs
 *
 * WHAT THIS PROTECTS (AR-01, 2026-10-19 artisan audit)
 * ────────────────────────────────────────────────────
 * completeInspection accepted a booking still at inspection_scheduled: no
 * setting out, no arrival, no check of the appointment. Completing the
 * inspection is what lets the callout fee reach the artisan (quote approval,
 * final rejection, quote expiry and a customer cancellation all release it
 * afterwards), so an artisan could collect the fee for a visit that never
 * happened — and the artisan app offered "Complete Inspection" as the primary
 * button before the artisan had set out. In the work phase (quote approved,
 * in_progress) the same call could also move a booking BACK to inspection_done.
 *
 * Covered here:
 *   • the server refuses every state before a recorded arrival, before the
 *     booked window, without arrival evidence, after quote approval, and for
 *     anyone but the assigned artisan — and refusal changes nothing
 *   • the legitimate path (set out → arrived → complete) still works, moves no
 *     money, and cannot be completed twice
 *   • without completion there is no route to a quote, so no route to the fee
 *   • the shared domain rule (artisanInspectionStep / getAllowedActions /
 *     resolveJourney) offers exactly one step at a time, in the server's order
 *   • the artisan screens draw the domain rule instead of their own copy
 *
 * The REAL functions/pricing.js and quotes.js run against an in-memory
 * Firestore (tests/support/fake-firebase.cjs). No network, no emulator.
 */

require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const fake = require('./support/fake-firebase.cjs').install();
const ROOT = path.join(__dirname, '..');
const pricing = require(path.join(ROOT, 'functions', 'pricing.js'));
const quotes  = require(path.join(ROOT, 'functions', 'quotes.js'));

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

// ── Domain modules (ESM, import-free) loaded without a build step ─────────────
function loadEsm(file, names) {
    const src = fs.readFileSync(path.join(ROOT, 'shared', 'js', 'domain', file), 'utf8')
        .replace(/^\s*import\s[^\n]*\n/gm, '')
        .replace(/^\s*export\s+async\s+function\s+/gm, 'async function ')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
    // eslint-disable-next-line no-new-func
    return new Function(`${src}\nreturn { ${names.join(', ')} };`)();
}
const META  = loadEsm('bookingStatusMeta.js', ['artisanInspectionStep', 'getAllowedActions']);
const SCHED = loadEsm('bookingSchedule.js', ['resolveSchedule']);
const TRUTH = loadEsm('bookingTruth.js', ['resolveJourney']);

// ── Fixtures ──────────────────────────────────────────────────────────────────
const ARTISAN  = 'art_insp_1';
const CUSTOMER = 'cust_insp_1';
const ID       = 'bk_insp_1';
const HOUR     = 3600 * 1000;

function seed(over = {}) {
    fake.db._reset();
    fake.db._set(`customers/${CUSTOMER}`, { walletBalance: 200, escrowBalance: 60 });
    fake.db._set(`escrow/esc_callout_1`, { bookingId: ID, kind: 'callout', status: 'held', amount: 60 });
    fake.db._set(`bookings/${ID}`, {
        customerId: CUSTOMER, artisanId: ARTISAN, track: 'inspection',
        status: 'in_progress', calloutPaid: true, calloutFee: 60, calloutEscrowId: 'esc_callout_1',
        enRouteAt: new Date(Date.now() - HOUR).toISOString(),
        arrivedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        ...over,
    });
}
const booking = () => fake.db._get(`bookings/${ID}`);
const AUTH = { uid: ARTISAN };
const moneySnapshot = () => JSON.stringify([fake.db._get(`customers/${CUSTOMER}`), fake.db._get('escrow/esc_callout_1')]);

// A slot three days out, and one that is open now.
const future = () => ({ scheduledForMs: Date.now() + 3 * 24 * HOUR, scheduleWindowMins: 180 });
const openNow = () => ({ scheduledForMs: Date.now() - 30 * 60 * 1000, scheduleWindowMins: 180 });

(async () => {
console.log('\n── The server refuses completion before a recorded arrival ──\n');

for (const [status, re] of [
    ['inspection_scheduled', /set out and mark yourself arrived/i],
    ['en_route',             /mark yourself arrived/i],
]) {
    await t(`refused from ${status}, and the booking is untouched`, async () => {
        seed({ status, arrivedAt: undefined });
        const before = JSON.stringify(booking());
        await rejects(() => pricing.completeInspection(AUTH, { bookingId: ID }), re);
        assert.strictEqual(JSON.stringify(booking()), before);
    });
}

await t('refused in_progress with no arrival recorded', async () => {
    seed({ arrivedAt: undefined });
    await rejects(() => pricing.completeInspection(AUTH, { bookingId: ID }), /arrival was not recorded/i);
    assert.strictEqual(booking().status, 'in_progress');
});

await t('refused ahead of the booked slot, even with an arrival stamp', async () => {
    seed(future());
    await rejects(() => pricing.completeInspection(AUTH, { bookingId: ID }), /booked for|set out from/i);
    assert.strictEqual(booking().status, 'in_progress');
});

await t('refused while the callout fee is unpaid', async () => {
    seed({ calloutPaid: false });
    await rejects(() => pricing.completeInspection(AUTH, { bookingId: ID }), /callout fee has not been paid/i);
});

await t('refused in the WORK phase — an approved job cannot be moved back to inspection_done', async () => {
    seed({ quoteApproved: true, jobQuote: 300 });
    await rejects(() => pricing.completeInspection(AUTH, { bookingId: ID }), /already complete/i);
    assert.strictEqual(booking().status, 'in_progress');
    assert.strictEqual(booking().quoteApproved, true);
});

await t('refused for anyone but the assigned artisan', async () => {
    seed();
    await rejects(() => pricing.completeInspection({ uid: 'someone_else' }, { bookingId: ID }), /not authorised/i);
    assert.strictEqual(booking().status, 'in_progress');
});

await t('refused on the emergency track', async () => {
    seed({ track: 'emergency' });
    await rejects(() => pricing.completeInspection(AUTH, { bookingId: ID }), /does not use the inspection flow/i);
});

await t('a cancellation that commits first wins: completion is then refused', async () => {
    seed();
    fake.db._set(`bookings/${ID}`, { ...booking(), status: 'cancelled', cancelledBy: 'customer' });
    await rejects(() => pricing.completeInspection(AUTH, { bookingId: ID }), /booking is cancelled/i);
    assert.strictEqual(booking().status, 'cancelled');
});

console.log('\n── The legitimate visit still completes ──\n');

await t('in_progress with an arrival → inspection_done, findings kept, NO money moves', async () => {
    seed();
    const money = moneySnapshot();
    const res = await pricing.completeInspection(AUTH, { bookingId: ID, findings: 'Corroded valve under the sink.' });
    assert.strictEqual(res.success, true);
    const b = booking();
    assert.strictEqual(b.status, 'inspection_done');
    assert.ok(b.inspectionDoneAt);
    assert.strictEqual(b.inspectionFindings, 'Corroded valve under the sink.');
    assert.strictEqual(moneySnapshot(), money, 'wallet and callout escrow must be unchanged');
});

await t('a scheduled visit completes once its window is open', async () => {
    seed(openNow());
    await pricing.completeInspection(AUTH, { bookingId: ID });
    assert.strictEqual(booking().status, 'inspection_done');
});

await t('a second completion is refused and changes nothing', async () => {
    seed();
    await pricing.completeInspection(AUTH, { bookingId: ID });
    const after = JSON.stringify(booking());
    await rejects(() => pricing.completeInspection(AUTH, { bookingId: ID }), /inspection_done/);
    assert.strictEqual(JSON.stringify(booking()), after);
});

await t('without completion there is no quote — and so no route to the callout fee', async () => {
    seed({ status: 'inspection_scheduled', arrivedAt: undefined });
    await rejects(() => quotes.submitJobQuote(AUTH, { bookingId: ID, labourCost: 200 }), /booking is inspection_scheduled/);
    await rejects(() => pricing.completeInspection(AUTH, { bookingId: ID }), /arrived/);
    assert.strictEqual(booking().status, 'inspection_scheduled');
});

await t('inspectionCompletionBlocker agrees with completeInspection for every status', () => {
    const now = Date.now();
    for (const status of ['pending', 'accepted', 'inspection_scheduled', 'en_route', 'in_progress',
                          'inspection_done', 'quoted', 'awaiting', 'completed', 'cancelled']) {
        const b = { track: 'inspection', calloutPaid: true, status, arrivedAt: new Date(now).toISOString() };
        const blocked = pricing.inspectionCompletionBlocker(b, now);
        assert.strictEqual(blocked === null, status === 'in_progress', `${status}: ${blocked}`);
    }
});

console.log('\n── The domain offers one step at a time, in the server\'s order ──\n');

const insp = (over) => Object.assign({ track: 'inspection', calloutPaid: true }, over);

await t('callout unpaid → wait; nothing actionable', () => {
    const s = META.artisanInspectionStep(insp({ status: 'accepted', calloutPaid: false }));
    assert.deepStrictEqual([s.id, !!s.blocked], ['await_callout', true]);
});

await t('inspection_scheduled → "Mark En Route" once due, the appointment before then — never "Complete"', () => {
    const b = insp({ status: 'inspection_scheduled', ...future() });
    const early = META.artisanInspectionStep(b, { schedule: SCHED.resolveSchedule(b) });
    assert.deepStrictEqual([early.id, !!early.blocked], ['scheduled', true]);
    const now = insp({ status: 'inspection_scheduled', ...openNow() });
    assert.strictEqual(META.artisanInspectionStep(now, { schedule: SCHED.resolveSchedule(now) }).id, 'en_route');
});

await t('en_route → "Mark Arrived" (arriving is never clock-gated)', () => {
    const b = insp({ status: 'en_route', ...future() });
    assert.strictEqual(META.artisanInspectionStep(b, { schedule: SCHED.resolveSchedule(b) }).id, 'arrived');
});

await t('in_progress → "Complete Inspection"; inspection_done → quote; quoted → wait', () => {
    assert.strictEqual(META.artisanInspectionStep(insp({ status: 'in_progress' })).id, 'complete_inspection');
    assert.strictEqual(META.artisanInspectionStep(insp({ status: 'inspection_done' })).id, 'submit_quote');
    assert.strictEqual(META.artisanInspectionStep(insp({ status: 'quoted' })).id, 'await_decision');
});

await t('off the inspection track, or once the quote is approved, it steps aside', () => {
    assert.strictEqual(META.artisanInspectionStep({ track: 'standard', status: 'en_route' }), null);
    assert.strictEqual(META.artisanInspectionStep(insp({ status: 'in_progress', quoteApproved: true })), null);
});

await t('getAllowedActions offers "Complete Inspection" ONLY at in_progress', () => {
    for (const status of ['accepted', 'inspection_scheduled', 'en_route', 'in_progress', 'inspection_done', 'quoted']) {
        const ids = META.getAllowedActions(insp({ status }), 'artisan').map((a) => a.id);
        assert.strictEqual(ids.includes('complete_inspection'), status === 'in_progress', `${status}: ${ids}`);
    }
    const enRoute = META.getAllowedActions(insp({ status: 'en_route' }), 'artisan').map((a) => a.id);
    assert.ok(enRoute.includes('arrived'), 'en_route must offer Mark Arrived');
});

await t('the artisan journey copy names the arrival step', () => {
    const en = TRUTH.resolveJourney(insp({ status: 'en_route' }), 'artisan');
    assert.strictEqual(en.action && en.action.op, 'arrived');
    const ip = TRUTH.resolveJourney(insp({ status: 'in_progress' }), 'artisan');
    assert.strictEqual(ip.action && ip.action.op, 'completeInspection');
});

console.log('\n── The artisan screens draw the domain rule ──\n');

await t('jobs.html and dashboard.html take inspection steps from artisanInspectionStep', () => {
    for (const page of ['jobs.html', 'dashboard.html']) {
        const src = fs.readFileSync(path.join(ROOT, 'artisan-app', page), 'utf8');
        assert.match(src, /import \{[^}]*artisanInspectionStep[^}]*\}\s*from '\.\.\/shared\/js\/domain\/bookingStatusMeta\.js'/, page);
        assert.match(src, /artisanInspectionStep\(/, page);
    }
    const jobs = fs.readFileSync(path.join(ROOT, 'artisan-app', 'jobs.html'), 'utf8');
    assert.strictEqual((jobs.match(/onclick="completeInspectionJob\(/g) || []).length, 1,
        'jobs.html must render Complete Inspection from exactly one (step-driven) branch');
    const dash = fs.readFileSync(path.join(ROOT, 'artisan-app', 'dashboard.html'), 'utf8');
    assert.strictEqual((dash.match(/onclick="completeInspectionAction\(/g) || []).length, 1,
        'dashboard.html must render Complete Inspection from exactly one (step-driven) branch');
});

console.log(`\ninspection-completion: ${passed} passed, ${failed} failed`);
if (failed) { for (const [name, e] of failures) console.log(`\n✗ ${name}\n${e.stack}`); process.exit(1); }
})();
