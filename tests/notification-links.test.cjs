'use strict';
/**
 * tests/notification-links.test.cjs — a booking notification opens that booking,
 * and one cancellation tells each party exactly once (28 Oct audit).
 *
 *   ART-NOTIF-001  Every server-written actionUrl was a generic page, so a tap on
 *                  "Quote Approved!" opened dashboard.html and the artisan had to
 *                  find the job. notifications.js now gives a booking notification
 *                  its booking's screen: job.html?id= for the artisan, bookingHref()
 *                  (the customer's bookingRouter contract) for the customer. Every
 *                  link still fits SEC-001's same-app pattern.
 *   ART-NOTIF-003  cancelInspectionBooking, the timeout sweep and the final quote
 *                  rejection each notify, and onBookingStatusChanged's 'cancelled'
 *                  rule notified BOTH parties again. Each path now lists who it told
 *                  (cancelNotified, in the cancelling write) and the trigger tells
 *                  only the others: one notice per party, none left with zero.
 *
 * The REAL functions/*.js run against tests/support/fake-firebase.cjs.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const fake = require('./support/fake-firebase.cjs').install();
const ROOT = path.join(__dirname, '..');
const FN   = path.join(ROOT, 'functions');
const notifications = require(path.join(FN, 'notifications.js'));
const bookings      = require(path.join(FN, 'bookings.js'));
const pricing       = require(path.join(FN, 'pricing.js'));
const quotes        = require(path.join(FN, 'quotes.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

const ID   = 'HHB-261021-1646-2D18';   // a real booking id shape
const CUST = 'cust_nl_1';
const ART  = 'art_nl_1';

// SEC-001's pattern, as the browser holds it.
const safeSrc = fs.readFileSync(path.join(ROOT, 'shared/js/utils/safeAppUrl.js'), 'utf8');
const SAFE = new RegExp(safeSrc.match(/SAFE_APP_URL_PATTERN = \/(.+)\/;/)[1]);

(async () => {

console.log('\n── NOTIF-001 · every server-written link is a same-app page ──\n');

await t('the server checks links against the same pattern as safeAppUrl.js', () => {
    assert.strictEqual(notifications.SAFE_APP_URL.source, SAFE.source);
});

// Every `actionUrl:` literal and template under functions/ (and the rule table's
// customerActionUrl / artisanActionUrl, and the transfer config's url).
function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name === 'node_modules') return [];
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : (e.name.endsWith('.js') ? [p] : []);
    });
}
const LINK_RE = /\b(?:actionUrl|customerActionUrl|artisanActionUrl|url)\s*:\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
const found = [];
for (const file of walk(FN)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(LINK_RE)) {
        const raw = m[1].slice(1, -1);
        if (!/\.html/.test(raw)) continue;                 // not a page link (e.g. an API url)
        found.push({ file: path.relative(ROOT, file), raw, value: raw.replace(/\$\{[^}]*\}/g, ID) });
    }
}
await t(`every link literal and template fits the pattern (${found.length} found)`, () => {
    assert.ok(found.length >= 40, `only ${found.length} links found — the scan is broken`);
    const bad = found.filter((f) => !SAFE.test(f.value));
    assert.deepStrictEqual(bad, [], bad.map((b) => `${b.file}: ${b.raw}`).join('; '));
});

console.log('\n── NOTIF-001 · a booking notification opens the booking ──\n');

await t('artisan: a generic page becomes job.html?id= for the booking', () => {
    for (const given of ['dashboard.html', 'jobs.html', '', null, undefined]) {
        assert.strictEqual(notifications.bookingLink('artisan', given, ID), `job.html?id=${ID}`, String(given));
    }
});
await t('artisan: deliberate pages and booking-less notifications are left alone', () => {
    assert.strictEqual(notifications.bookingLink('artisan', 'wallet.html', ID), 'wallet.html');
    assert.strictEqual(notifications.bookingLink('artisan', 'onboarding.html', ID), 'onboarding.html');
    assert.strictEqual(notifications.bookingLink('artisan', 'dashboard.html', null), 'dashboard.html');
});
await t('customer: a generic page becomes the bookingRouter destination for its state', () => {
    const L = (b) => notifications.bookingLink('customer', 'booking.html', ID, b);
    assert.strictEqual(L({ status: 'quoted', track: 'inspection' }), `quote-approval.html?bookingId=${ID}`);
    assert.strictEqual(L({ status: 'accepted', track: 'inspection' }), `book-request.html?resume=${ID}`);
    assert.strictEqual(L({ status: 'en_route', track: 'inspection', quoteApproved: true }), `live-tracking.html?bookingId=${ID}`);
    assert.strictEqual(L({ status: 'cancelled', track: 'inspection' }), 'booking.html', 'terminal → the list, per the contract');
    assert.strictEqual(L(null), 'booking.html', 'booking unreadable → what the caller wrote');
    assert.strictEqual(notifications.bookingLink('customer', 'topup.html', ID, { status: 'quoted' }), 'topup.html');
});
await t('an encoded id still fits the pattern; a link that does not fit is never used', () => {
    const link = notifications.bookingLink('artisan', 'jobs.html', 'odd id/1');
    assert.strictEqual(link, 'job.html?id=odd%20id%2F1');
    assert.ok(SAFE.test(link));
});

function seedParties() {
    fake.db._reset(); fake.messaging._reset();
    fake.db._set(`customers/${CUST}`, { fcmToken: 'tok_c', fcmPlatform: 'web' });
    fake.db._set(`artisans/${ART}`, { status: 'active', verificationStatus: 'approved', fcmToken: 'tok_a', fcmPlatform: 'web' });
}
const notes = (uid) => fake.db._keys('customer_notifications/').map((k) => fake.db._get(k)).filter((n) => n.receiverId === uid);

await t('artisan end to end: the in-app record and the push carry job.html?id=, and metadata.bookingId', async () => {
    seedParties();
    // pricing/quotes pass bookingId at the TOP level — the audit's "empty metadata" rows.
    await notifications.sendArtisanNotification(ART, { type: 'Bookings', title: 'Quote Approved!', message: 'x', actionUrl: 'jobs.html', bookingId: ID });
    const [n] = notes(ART);
    assert.strictEqual(n.actionUrl, `job.html?id=${ID}`);
    assert.strictEqual(n.metadata.bookingId, ID);
    assert.strictEqual(fake.messaging.sent[0].data.actionUrl, `job.html?id=${ID}`);
});
await t('customer end to end: the in-app record and the push open the booking\'s screen', async () => {
    seedParties();
    fake.db._set(`bookings/${ID}`, { customerId: CUST, artisanId: ART, status: 'quoted', track: 'inspection' });
    await notifications.sendNotification(CUST, { type: 'Bookings', title: 'Your quote is ready', message: 'x', actionUrl: 'booking.html', metadata: { bookingId: ID } });
    const [n] = notes(CUST);
    assert.strictEqual(n.actionUrl, `quote-approval.html?bookingId=${ID}`);
    assert.strictEqual(fake.messaging.sent[0].data.actionUrl, `quote-approval.html?bookingId=${ID}`);
});

console.log('\n── NOTIF-003 · one cancellation, one notice per party ──\n');

/** Run the status trigger for the write a path just made (before → what is stored now). */
async function trigger(before) {
    const after = fake.db._get(`bookings/${ID}`);
    await bookings.onBookingStatusChanged({
        params: { bookingId: ID },
        data: { before: { data: () => before }, after: { data: () => after } },
    });
    return after;
}
function expectOneEach(label) {
    const c = notes(CUST), a = notes(ART);
    assert.strictEqual(c.length, 1, `${label}: customer got ${c.length} — ${c.map((n) => n.message).join(' | ')}`);
    assert.strictEqual(a.length, 1, `${label}: artisan got ${a.length} — ${a.map((n) => n.message).join(' | ')}`);
    for (const n of [...c, ...a]) assert.strictEqual(n.metadata.bookingId, ID, `${label}: notice without its booking`);
}
const inspection = (over = {}) => ({
    customerId: CUST, artisanId: ART, track: 'inspection', serviceType: 'Plumbing',
    status: 'accepted', calloutPaid: false, calloutFee: 60, ...over,
});

await t('customer cancels an inspection: the artisan is told by the callable, the customer by the trigger', async () => {
    seedParties();
    const before = inspection();
    fake.db._set(`bookings/${ID}`, before);
    await pricing.cancelInspectionBooking({ uid: CUST }, { bookingId: ID });
    const after = await trigger(before);
    assert.deepStrictEqual(after.cancelNotified, ['artisan']);
    expectOneEach('customer cancel');
    assert.match(notes(ART)[0].message, /customer cancelled the inspection/i, 'the specific copy, not the generic one');
});

await t('artisan cancels an inspection: the customer is told by the callable, the artisan by the trigger', async () => {
    seedParties();
    const before = inspection();
    fake.db._set(`bookings/${ID}`, before);
    await pricing.cancelInspectionBooking({ uid: ART }, { bookingId: ID });
    const after = await trigger(before);
    assert.deepStrictEqual(after.cancelNotified, ['customer']);
    expectOneEach('artisan cancel');
    assert.match(notes(CUST)[0].message, /artisan cancelled your inspection/i);
});

await t('cancelling before any artisan is assigned: the customer is still told once', async () => {
    seedParties();
    const before = inspection({ artisanId: null, status: 'pending' });
    fake.db._set(`bookings/${ID}`, before);
    await pricing.cancelInspectionBooking({ uid: CUST }, { bookingId: ID });
    const after = await trigger(before);
    assert.deepStrictEqual(after.cancelNotified, []);
    assert.strictEqual(notes(CUST).length, 1);
    assert.strictEqual(notes(ART).length, 0);
});

await t('the timeout sweep closes a booking: it tells both, the trigger tells nobody again', async () => {
    seedParties();
    const old = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const before = inspection({ status: 'accepted', acceptedAt: old });   // callout_unpaid sweep
    fake.db._set(`bookings/${ID}`, before);
    await pricing.checkBookingTimeouts();
    const after = await trigger(before);
    assert.strictEqual(after.status, 'cancelled', 'the sweep claimed it');
    assert.deepStrictEqual(after.cancelNotified, ['customer', 'artisan']);
    expectOneEach('sweep');
    assert.match(notes(CUST)[0].title, /Booking Closed/);
});

await t('the final quote rejection: the artisan is told by the callable, the customer by the trigger', async () => {
    seedParties();
    const before = { customerId: CUST, artisanId: ART, track: 'standard', serviceType: 'Plumbing',
                     status: 'quoted', jobQuote: 300, quoteRevisionCount: 1 };
    fake.db._set(`bookings/${ID}`, before);
    const res = await quotes.rejectJobQuote({ uid: CUST }, { bookingId: ID, reason: 'too much' });
    assert.strictEqual(res.final, true);
    const after = await trigger(before);
    assert.deepStrictEqual(after.cancelNotified, ['artisan']);
    expectOneEach('final rejection');
    assert.match(notes(ART)[0].title, /Quote Declined/);
});

await t('an admin or client cancellation (no path notice): the trigger tells both, once', async () => {
    seedParties();
    const before = inspection({ status: 'pending' });
    fake.db._set(`bookings/${ID}`, { ...before, status: 'cancelled', cancelledBy: 'customer' });
    await trigger(before);
    expectOneEach('client cancel');
});

await t('a cancelNotified already on the booking (not written by the cancel) silences nobody', async () => {
    seedParties();
    const before = inspection({ status: 'pending', cancelNotified: ['customer', 'artisan'] });
    fake.db._set(`bookings/${ID}`, { ...before, status: 'cancelled', cancelledBy: 'customer' });
    await trigger(before);
    expectOneEach('planted marker');
});

await t('the cancellation notices open the booking (job.html?id= for the artisan)', async () => {
    seedParties();
    const before = inspection();
    fake.db._set(`bookings/${ID}`, before);
    await pricing.cancelInspectionBooking({ uid: CUST }, { bookingId: ID });
    await trigger(before);
    assert.strictEqual(notes(ART)[0].actionUrl, `job.html?id=${ID}`);
    assert.strictEqual(notes(CUST)[0].actionUrl, 'booking.html', 'a cancelled booking opens the list, per bookingRouter');
});

console.log(`\nnotification-links: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
