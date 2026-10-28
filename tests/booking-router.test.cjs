/**
 * booking-router.test.cjs
 *
 * Pins THE routing contract: given a booking, which screen can actually act on
 * it? Every "take me to this booking" in the customer app resolves through
 * bookingHref(), so a wrong answer here strands a customer on a screen that
 * lacks the control their booking needs — which is exactly the F2 dead-end this
 * module was written to close (accepted + unpaid callout, with the only "pay"
 * control living inside book-request.html's live console).
 *
 * The rule these tests exist to enforce: EVERY destination that renders one
 * specific booking must carry that booking's id. live-tracking.html did not,
 * and resolved the ambiguity by sorting the customer's live bookings by
 * updatedAt and taking the first — so with two live jobs, tapping one could
 * open the other.
 */
'use strict';

require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const ROOT = path.join(__dirname, '..');

function loadRouter() {
    const src = fs.readFileSync(
        path.join(ROOT, 'shared', 'js', 'domain', 'bookingRouter.js'), 'utf8');
    const body = src
        .replace(/^\s*export\s+async\s+function\s+/gm, 'async function ')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
    // eslint-disable-next-line no-new-func
    return new Function(
        `${body}\nreturn { bookingHref, isResumableInspection, resumeSummary, notificationHref };`)();
}

const { bookingHref, isResumableInspection, resumeSummary, notificationHref } = loadRouter();

const failures = [];
let passed = 0;
function test(name, fn) {
    try { fn(); passed++; } catch (e) { failures.push([name, e]); }
}

const asyncTests = [];
function atest(name, fn) { asyncTests.push([name, fn]); }

const ID = 'HHB-260820-0332-58F1';
const ENC = encodeURIComponent(ID);
const insp = (extra) => ({ id: ID, track: 'inspection', ...extra });

// ── The id must survive the routing decision ─────────────────────────────────

test('every single-booking destination carries the booking id', () => {
    const cases = [
        insp({ status: 'pending' }),
        insp({ status: 'accepted', calloutPaid: false }),
        insp({ status: 'inspection_scheduled', calloutPaid: true }),
        insp({ status: 'inspection_done', calloutPaid: true }),
        insp({ status: 'quoted', calloutPaid: true }),
        insp({ status: 'en_route', calloutPaid: true, quoteApproved: true }),
        insp({ status: 'in_progress', calloutPaid: true, quoteApproved: true }),
        { id: ID, status: 'en_route' },                    // legacy track
        { id: ID, status: 'accepted' },                    // legacy track
    ];
    for (const b of cases) {
        const href = bookingHref(b);
        assert.ok(
            href.includes(ENC),
            `${b.status} (track=${b.track || 'legacy'}) routed to "${href}" with no booking id — ` +
            `the destination will have to guess which booking is meant`);
    }
});

test('live tracking is named, not inferred', () => {
    const href = bookingHref(insp({ status: 'en_route', quoteApproved: true }));
    assert.strictEqual(href, `live-tracking.html?bookingId=${ENC}`);
});

test('a legacy/emergency job in flight also names its booking', () => {
    assert.strictEqual(bookingHref({ id: ID, status: 'in_progress' }),
        `live-tracking.html?bookingId=${ENC}`);
});

// ── The routing table itself ─────────────────────────────────────────────────

test('the quote decision outranks the track — it is the most important action', () => {
    assert.strictEqual(bookingHref(insp({ status: 'quoted' })),
        `quote-approval.html?bookingId=${ENC}`);
    assert.strictEqual(bookingHref({ id: ID, status: 'quoted' }),
        `quote-approval.html?bookingId=${ENC}`,
        'a quoted legacy booking still routes to the decision');
});

test('accepted-but-unpaid reaches the console that owns the pay control', () => {
    // This is the F2 dead-end: before the router existed, nothing produced this
    // link and the booking stalled at `accepted` forever.
    assert.strictEqual(bookingHref(insp({ status: 'accepted', calloutPaid: false })),
        `book-request.html?resume=${ENC}`);
});

test('accepted means two different things and the router tells them apart', () => {
    const preCallout = insp({ status: 'accepted', calloutPaid: false });
    const postQuote  = insp({ status: 'accepted', quoteApproved: true });
    assert.notStrictEqual(bookingHref(preCallout), bookingHref(postQuote),
        'quoteApproved is the disambiguator — same status, opposite screens');
    assert.ok(bookingHref(postQuote).startsWith('live-tracking.html'));
});

test('terminal bookings go to the list, not to a live screen', () => {
    for (const status of ['completed', 'cancelled', 'rejected', 'unfulfilled']) {
        assert.strictEqual(bookingHref(insp({ status })), 'booking.html',
            `${status} must not open a tracking screen`);
    }
});

test('a booking with no id falls back to the list rather than a broken link', () => {
    assert.strictEqual(bookingHref({ status: 'en_route' }), 'booking.html');
    assert.strictEqual(bookingHref(null), 'booking.html');
});

test('ids are encoded, never concatenated raw', () => {
    const href = bookingHref({ id: 'a b&c=d', track: 'inspection', status: 'quoted' });
    assert.ok(href.includes('a%20b%26c%3Dd'), `got "${href}"`);
    assert.ok(!href.includes('a b&c=d'));
});

// ── The dashboard resume nudge ───────────────────────────────────────────────

test('resumable covers the whole pre-execution inspection journey', () => {
    for (const status of ['pending', 'dispatching', 'accepted', 'inspection_scheduled',
                          'inspection_done', 'quoted']) {
        assert.ok(isResumableInspection(insp({ status })), `${status} should be resumable`);
    }
});

test('resumable excludes terminal states and post-approval execution', () => {
    assert.ok(!isResumableInspection(insp({ status: 'completed' })));
    assert.ok(!isResumableInspection(insp({ status: 'cancelled' })));
    assert.ok(!isResumableInspection(insp({ status: 'en_route', quoteApproved: true })),
        'once the quote is approved this belongs to tracking, not a resume nudge');
    assert.ok(!isResumableInspection({ id: ID, status: 'accepted' }),
        'legacy-track bookings are not inspection resumes');
});

test('the resume summary names the action, urgently where money is waiting', () => {
    const unpaid = resumeSummary(insp({ status: 'accepted', calloutPaid: false }));
    assert.ok(/pay/i.test(unpaid.cta), 'must say pay');
    assert.strictEqual(unpaid.urgent, true);

    const quoted = resumeSummary(insp({ status: 'quoted' }));
    assert.ok(/quote/i.test(quoted.cta));
    assert.strictEqual(quoted.urgent, true);

    const searching = resumeSummary(insp({ status: 'pending', serviceType: 'Plumbing' }));
    assert.strictEqual(searching.urgent, false, 'waiting on the artisan is not urgent for us');
    assert.ok(/plumbing/i.test(searching.label));
});

// ── Notification taps ────────────────────────────────────────────────────────
//
// The backend writes metadata.bookingId on every booking notification but sets
// actionUrl to a generic page. These pin the behaviour that reads the id.

const notif = (extra = {}) => ({
    actionUrl: 'booking.html',
    metadata:  { bookingId: ID },
    ...extra,
});
const found  = (data) => async () => ({ exists: true, data });
const missing = async () => ({ exists: false });

atest('a booking notification lands on the screen that can act on the booking', async () => {
    const href = await notificationHref(
        notif(), found({ track: 'inspection', status: 'quoted' }));
    assert.strictEqual(href, `quote-approval.html?bookingId=${ENC}`,
        'a "your quote is ready" tap must open the quote, not the bookings list');
});

atest('an accepted-but-unpaid notification reaches the pay control', async () => {
    const href = await notificationHref(
        notif(), found({ track: 'inspection', status: 'accepted', calloutPaid: false }));
    assert.strictEqual(href, `book-request.html?resume=${ENC}`);
});

atest('a notification with no bookingId keeps its own actionUrl', async () => {
    const href = await notificationHref(
        { actionUrl: 'topup.html', metadata: {} }, found({ status: 'quoted' }));
    assert.strictEqual(href, 'topup.html');
});

atest('an unreadable booking falls back rather than stranding the tap', async () => {
    assert.strictEqual(await notificationHref(notif(), missing), 'booking.html');
    assert.strictEqual(
        await notificationHref(notif(), async () => { throw new Error('offline'); }),
        'booking.html');
});

atest('a slow read gives up and uses the fallback instead of hanging', async () => {
    const slow = () => new Promise((r) => setTimeout(() => r({ exists: true, data: { status: 'quoted' } }), 200));
    const started = Date.now();
    const href = await notificationHref(notif(), slow, { timeoutMs: 40 });
    assert.strictEqual(href, 'booking.html');
    assert.ok(Date.now() - started < 180, 'must not wait for the slow read');
});

atest('nothing to navigate to yields null, not a bogus page', async () => {
    assert.strictEqual(await notificationHref({ metadata: {} }, found({})), null);
});

// ── Report ───────────────────────────────────────────────────────────────────
const finish = () => {
if (failures.length) {
    console.error('');
    for (const [name, err] of failures) {
        console.error(`  FAIL  ${name}`);
        console.error(`        ${err.message.split('\n')[0]}`);
    }
}
console.log(`\nbooking-router: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
};

(async () => {
    for (const [name, fn] of asyncTests) {
        try { await fn(); passed++; } catch (e) { failures.push([name, e]); }
    }
    finish();
})();
