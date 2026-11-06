'use strict';
/**
 * artisan-actions-consistency.test.cjs — an artisan screen never offers a
 * booking action the backend refuses. (Phase 0 WF-01, WF-02.)
 *
 * WF-01: "Cancel job" was offered on approved inspection work; the server's
 *   cancelInspectionBooking refuses every artisan cancellation once a quote is
 *   approved. artisanCanCancel() is now the one answer, proven here against the
 *   REAL function on the fake Firestore harness.
 * WF-02: "Mark en route" was offered on accepted emergency/standard jobs with no
 *   approved quote; firestore.rules (accepted → en_route needs quoteApproved)
 *   refused it. The journey, the allowed-actions list and the screens now offer
 *   the quote first. The rules themselves are exercised by
 *   tests/artisan-workflow-rules.test.mjs.
 * Q1 (decision, 2026-11-06): a PAID emergency sets out without a quote and is
 *   priced on site; "done" waits for the approved quote. RULES_ALLOW below
 *   states the rules as they now are, and the projections are held to them.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const fake   = require('./support/fake-firebase.cjs').install();

const ROOT = path.join(__dirname, '..');
const pricing = require(path.join(ROOT, 'functions', 'pricing.js'));

function stripEsm(src) {
    return src
        .replace(/^\s*import\s[^\n]*\n/gm, '')
        .replace(/^\s*export\s+async\s+function\s+/gm, 'async function ')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
}
const domain = (f) => stripEsm(fs.readFileSync(path.join(ROOT, 'shared', 'js', 'domain', f), 'utf8'));
// eslint-disable-next-line no-new-func
const { artisanCanCancel } = new Function(`${domain('bookingSchedule.js')}\n${domain('bookingActions.js')}\nreturn { artisanCanCancel };`)();
// eslint-disable-next-line no-new-func
const { needsQuoteBeforeTravel, needsQuoteOnSite, quotesOnSite, getAllowedActions } = new Function(`${domain('bookingStatusMeta.js')}\nreturn { needsQuoteBeforeTravel, needsQuoteOnSite, quotesOnSite, getAllowedActions };`)();
// eslint-disable-next-line no-new-func
const { resolveJourney, emergencyPricedOnSite } = new Function(`${domain('bookingTruth.js')}\nreturn { resolveJourney, emergencyPricedOnSite };`)();
const quotes = require(path.join(ROOT, 'functions', 'quotes.js'));
const page = (f) => fs.readFileSync(path.join(ROOT, 'artisan-app', f), 'utf8');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

const STATUSES = ['pending', 'accepted', 'inspection_scheduled', 'en_route', 'in_progress', 'inspection_done', 'quoted', 'awaiting', 'completed', 'cancelled'];

/**
 * The client transitions firestore.rules grants an artisan (isValidBookingUpdate),
 * as op → predicate. Off this list, the write is refused. Line references are to
 * firestore.rules at the time of writing.
 */
const RULES_ALLOW = {
    // accepted → en_route needs an approved quote, or a paid emergency (Q1);
    // inspection_scheduled → en_route needs neither.
    enRoute:  (b) => (b.status === 'accepted' && (b.quoteApproved === true || (b.track === 'emergency' && b.calloutPaid === true)))
                     || b.status === 'inspection_scheduled',
    arrived:  (b) => b.status === 'en_route',
    // in_progress → awaiting; an emergency needs its approved quote first (Q1).
    markDone: (b) => b.status === 'in_progress' && (b.track !== 'emergency' || b.quoteApproved === true),
    // Function-backed steps, as their callables gate them:
    completeInspection: (b) => b.track === 'inspection' && b.status === 'in_progress' && b.quoteApproved !== true,     // pricing.js completeInspection
    submitQuote: (b) => quotes.quotableStatuses(b).includes(b.status) && b.quoteApproved !== true,                     // quotes.js, the real rule
};

(async () => {
console.log('\n── WF-01 · Cancel matches the server, every status ──\n');

await t('inspection track: artisanCanCancel agrees with the real cancelInspectionBooking for every status, approved or not', async () => {
    const mismatches = [];
    for (const status of STATUSES) {
        for (const quoteApproved of [false, true]) {
            fake.db._reset();
            fake.db._set('bookings/b', { customerId: 'c1', artisanId: 'art', track: 'inspection', status, quoteApproved, calloutPaid: false, calloutFee: 54 });
            let serverAllows;
            try { await pricing.cancelInspectionBooking({ uid: 'art' }, { bookingId: 'b' }); serverAllows = true; }
            catch (_) { serverAllows = false; }
            // `pending` is excluded on purpose: an offered artisan is not yet the booking's.
            const expected = status === 'pending' ? false : serverAllows;
            const got = artisanCanCancel({ track: 'inspection', status, quoteApproved });
            if (got !== expected) mismatches.push(`${status}/approved=${quoteApproved}: client ${got}, server ${serverAllows}`);
        }
    }
    assert.deepStrictEqual(mismatches, []);
});

await t('the server refuses an artisan cancelling approved inspection work, and the client never offers it', async () => {
    fake.db._reset();
    fake.db._set('bookings/b', { customerId: 'c1', artisanId: 'art', track: 'inspection', status: 'accepted', quoteApproved: true, calloutPaid: true });
    await assert.rejects(pricing.cancelInspectionBooking({ uid: 'art' }, { bookingId: 'b' }), /already approved/);
    assert.strictEqual(artisanCanCancel({ track: 'inspection', status: 'accepted', quoteApproved: true }), false);
});

await t('off the inspection track: Cancel only from accepted or quoted (the artisan clause in firestore.rules)', () => {
    for (const track of ['emergency', 'standard', undefined]) {
        for (const status of STATUSES) {
            assert.strictEqual(artisanCanCancel({ track, status }), ['accepted', 'quoted'].includes(status), `${track}/${status}`);
        }
    }
});

console.log('\n── WF-02 · the next step is one the rules accept ──\n');

const FIXTURES = [];
for (const track of ['inspection', 'emergency', 'standard']) {
    for (const status of ['accepted', 'inspection_scheduled', 'en_route', 'in_progress', 'inspection_done', 'disputed', 'something_new']) {
        for (const quoteApproved of [false, true]) {
            if (track !== 'inspection' && ['inspection_scheduled', 'inspection_done'].includes(status)) continue;
            for (const calloutPaid of [true, false]) {
                FIXTURES.push({ id: 'B', track, status, quoteApproved, calloutPaid });
            }
        }
    }
}

await t('resolveJourney(artisan) never offers a client transition the rules refuse', () => {
    const bad = [];
    for (const b of FIXTURES) {
        const op = resolveJourney(b, 'artisan').action?.op;
        if (RULES_ALLOW[op] && !RULES_ALLOW[op](b)) bad.push(`${b.track}/${b.status}/approved=${b.quoteApproved} → ${op}`);
    }
    assert.deepStrictEqual(bad, []);
});

await t('a disputed booking offers neither side an action', () => {
    for (const track of ['inspection', 'emergency']) {
        for (const quoteApproved of [false, true]) {
            const b = { id: 'B', track, status: 'disputed', quoteApproved, calloutPaid: true };
            assert.strictEqual(resolveJourney(b, 'artisan').action, null, `${track}/${quoteApproved}`);
            assert.strictEqual(resolveJourney(b, 'customer').action, null, `${track}/${quoteApproved}`);
        }
    }
});

await t('getAllowedActions(artisan) never offers a client transition the rules refuse', () => {
    const map = { en_route: 'enRoute', arrived: 'arrived', job_done: 'markDone' };
    const bad = [];
    for (const b of FIXTURES) {
        for (const a of getAllowedActions(b, 'artisan')) {
            const op = map[a.id];
            if (op && !a.disabled && !RULES_ALLOW[op](b)) bad.push(`${b.track}/${b.status}/approved=${b.quoteApproved} → ${a.id}`);
        }
    }
    assert.deepStrictEqual(bad, []);
});

await t('an accepted standard job, or an unpaid emergency, asks for the quote before travel, on every projection', () => {
    for (const b of [{ id: 'B', track: 'standard', status: 'accepted', calloutPaid: true },
                     { id: 'B', track: 'emergency', status: 'accepted', calloutPaid: false }]) {
        const label = `${b.track}/paid=${b.calloutPaid}`;
        assert.strictEqual(needsQuoteBeforeTravel(b), true, label);
        assert.strictEqual(resolveJourney(b, 'artisan').action.op, 'submitQuote', label);
        assert.ok(getAllowedActions(b, 'artisan').some((a) => a.id === 'submit_quote'), label);
        // Once approved, travel is the step again.
        const ok = { ...b, quoteApproved: true };
        assert.strictEqual(needsQuoteBeforeTravel(ok), false);
        assert.strictEqual(resolveJourney(ok, 'artisan').action.op, 'enRoute');
    }
    assert.strictEqual(needsQuoteBeforeTravel({ track: 'inspection', status: 'accepted' }), false, 'the inspection track quotes after its visit');
});

await t('Q1: a paid emergency sets out unpriced, quotes on site, and is done only once approved', () => {
    const b = { id: 'B', track: 'emergency', calloutPaid: true };
    const at = (status, extra = {}) => ({ ...b, status, ...extra });
    // Accepted: set out now.
    assert.strictEqual(needsQuoteBeforeTravel(at('accepted')), false);
    assert.strictEqual(resolveJourney(at('accepted'), 'artisan').action.op, 'enRoute');
    assert.ok(getAllowedActions(at('accepted'), 'artisan').some((a) => a.id === 'en_route'));
    // On the way: arrive.
    assert.strictEqual(resolveJourney(at('en_route'), 'artisan').action.op, 'arrived');
    // On site: the quote, never "done".
    assert.strictEqual(needsQuoteOnSite(at('in_progress')), true);
    assert.strictEqual(resolveJourney(at('in_progress'), 'artisan').action.op, 'submitQuote');
    const onsite = getAllowedActions(at('in_progress'), 'artisan').map((a) => a.id);
    assert.ok(onsite.includes('submit_quote') && !onsite.includes('job_done'), onsite.join());
    // Approved on site: now "done".
    const approved = at('in_progress', { quoteApproved: true });
    assert.strictEqual(needsQuoteOnSite(approved), false);
    assert.strictEqual(resolveJourney(approved, 'artisan').action.op, 'markDone');
    // The customer is never told a quote was approved before there is one.
    assert.doesNotMatch(resolveJourney(at('en_route'), 'customer').just, /approved the quote/);
});

await t('Q1: the two copies of the on-site rule agree (bookingStatusMeta, bookingTruth)', () => {
    for (const b of FIXTURES) {
        assert.strictEqual(emergencyPricedOnSite(b), quotesOnSite(b), `${b.track}/${b.status}/approved=${b.quoteApproved}/paid=${b.calloutPaid}`);
    }
});

console.log('\n── The screens use the shared answers ──\n');

await t('job.html: Cancel or "Get help" from artisanCanCancel; the quote first where travel needs one', () => {
    const src = page('job.html');
    assert.match(src, /import \{ performBookingAction, ACTION, artisanCanCancel \}/);
    assert.match(src, /const cancelOrHelp = \(\) => artisanCanCancel\(b\)/);
    assert.ok(!/secondary:\s*\[\{ label:'Cancel job'/.test(src), 'a bare Cancel offer remains');
    assert.match(src, /if \(needsQuoteBeforeTravel\(b\)\) \{[\s\S]{0,300}mountQuote: true/);
    assert.match(src, /if \(needsQuoteOnSite\(b\)\) \{[\s\S]{0,300}mountQuote: true/, 'on site, the composer is the step (Q1)');
    assert.match(src, /spec\.action === 'support'\)\s*\{ location\.href = `support\.html\?bookingId=\$\{encodeURIComponent\(BOOKING_ID\)\}`/);
});

await t('dashboard.html: Submit Quote before travel; a booked slot is shown, not offered', () => {
    const src = page('dashboard.html');
    assert.match(src, /status === 'accepted' && needsQuoteBeforeTravel\(d\)/);
    assert.match(src, /status === 'in_progress' && needsQuoteOnSite\(d\)/, 'on site, Submit Quote replaces Mark Job Done (Q1)');
    assert.match(page('jobs.html'), /if \(needsQuoteBeforeTravel\(b\) \|\| needsQuoteOnSite\(b\)\)/, 'jobs list: the same two answers');
    assert.match(src, /status === 'accepted' && resolveSchedule\(d\)\.scheduled && !resolveSchedule\(d\)\.isDue/);
});

await t('support.html: a booking reference from the job screen is validated before it is pre-filled', () => {
    const src = page('support.html');
    assert.match(src, /\/\^\[A-Za-z0-9_-\]\{4,64\}\$\/\.test\(ref\)/);
    assert.match(src, /message\.value = `About booking \$\{ref\}: `/);
});

console.log(`\nartisan-actions-consistency: ${passed} passed, ${failed} failed`);
if (failed) { for (const [n, e] of failures) console.error(`\n✗ ${n}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
