'use strict';
/**
 * tests/artisan-today.test.cjs — what the artisan's Today screen shows, and how
 * an offer reads (Phase 2, shared/js/domain/artisanToday.js).
 *
 * Today shows one operational state: an answerable offer, else a job that needs
 * the artisan, else availability. Offers keep arriving mid-job (decision Q3,
 * 2026-11-06), so an offer outranks the job and carries it along.
 *
 * An offer is read from server fields only: the countdown from expiresAtMs (and
 * its whole from offeredAt), the visit fee as the server wrote it, the distance
 * the server measured. Never the customer's name, address or position — even
 * when the offer document carries them.
 *
 * The real domain modules run here; the clock is passed in, never read.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const path   = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const dom  = (f) => pathToFileURL(path.join(ROOT, 'shared', 'js', 'domain', f)).href;

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

(async () => {
const today   = await import(dom('artisanToday.js'));
const truth   = await import(dom('bookingTruth.js'));
const sched   = await import(dom('bookingSchedule.js'));
const { offerView, offerKind, resolveToday, placeJob, TODAY_MODE, OFFER_KIND } = today;

const NOW = Date.UTC(2026, 10, 6, 10, 0, 0);          // 10:00 in Accra (UTC+0)
const ts  = (ms) => ({ seconds: Math.floor(ms / 1000), nanoseconds: 0 });   // a cached Timestamp
const HOUR = 3600e3, DAY = 24 * HOUR;

const ARTISAN = { userType: 'artisan', status: 'active', verificationStatus: 'approved', isAvailable: true };

// A job_offers/{bookingId} document as functions/jobOffers.js buildOfferDoc writes it.
function offer(over = {}) {
    return {
        id: 'bk_1', bookingId: 'bk_1', artisanId: 'art_1', offerStatus: 'open', status: 'pending',
        serviceType: 'plumbing', description: 'Kitchen tap leaking under the sink',
        photos: [], track: 'inspection', calloutFee: 50, travelFee: 0,
        customerFirstName: 'Ama',                 // on the document by earlier design
        lat: 5.61, lng: -0.19, locationApproximate: true,
        distanceKm: 2.34, round: 1, prematched: false,
        offeredAt: ts(NOW - 60e3), expiresAtMs: NOW + 120e3,
        ...over,
    };
}

console.log('\n── offerView: the countdown is the server\'s ──\n');

await t('secondsLeft from expiresAtMs; the bar\'s whole from offeredAt → expiresAtMs', () => {
    const v = offerView(offer(), NOW);
    assert.strictEqual(v.countdown.expiresAtMs, NOW + 120e3);
    assert.strictEqual(v.countdown.secondsLeft, 120);
    assert.strictEqual(v.countdown.totalMs, 180e3, 'a 180 s standard window');
    assert.strictEqual(v.answerable, true);
});

await t('no offeredAt → no invented whole (totalMs null), the deadline still shown', () => {
    const v = offerView(offer({ offeredAt: undefined }), NOW);
    assert.strictEqual(v.countdown.totalMs, null);
    assert.strictEqual(v.countdown.secondsLeft, 120);
});

await t('at the deadline the offer is not answerable', () => {
    assert.strictEqual(offerView(offer({ expiresAtMs: NOW }), NOW).answerable, false);
    assert.strictEqual(offerView(offer({ expiresAtMs: NOW - 1 }), NOW).countdown.secondsLeft, 0);
});

await t('a customer-chosen offer has no deadline and shows no countdown', () => {
    const v = offerView(offer({ prematched: true, expiresAtMs: null }), NOW);
    assert.strictEqual(v.countdown, null);
    assert.strictEqual(v.chosenByCustomer, true);
    assert.strictEqual(v.answerable, true);
    assert.strictEqual(v.heading, 'A customer chose you');
});

await t('a legacy offer without expiresAtMs falls back to responseDeadline (offerState)', () => {
    const v = offerView(offer({ expiresAtMs: undefined, responseDeadline: new Date(NOW + 30e3).toISOString() }), NOW);
    assert.strictEqual(v.countdown.secondsLeft, 30);
});

console.log('\n── offerView: type, timing, money, distance ──\n');

await t('emergency is recognised from track, isEmergency, type or bookingType', () => {
    for (const f of [{ track: 'emergency' }, { isEmergency: true }, { type: 'Emergency' }, { bookingType: 'emergency' }]) {
        assert.strictEqual(offerKind(offer(f)), OFFER_KIND.EMERGENCY, JSON.stringify(f));
    }
    const v = offerView(offer({ track: 'emergency', expiresAtMs: NOW + 65e3, offeredAt: ts(NOW) }), NOW);
    assert.strictEqual(v.when, 'Now');
    assert.strictEqual(v.heading, 'Emergency request');
    assert.strictEqual(v.countdown.totalMs, 65e3);
});

await t('a scheduled offer names the slot and the commitment accepting makes', () => {
    const start = NOW + DAY;                                  // tomorrow 10:00
    const o = offer({ scheduledForMs: start, scheduleWindowMins: 180, expiresAtMs: NOW + 1200e3 });
    const v = offerView(o, NOW);
    assert.strictEqual(v.kind, OFFER_KIND.SCHEDULED);
    const label = sched.resolveSchedule(o, NOW).label;
    assert.ok(/^Tomorrow, /.test(label), label);
    assert.strictEqual(v.when, label);
    assert.strictEqual(v.commitment, `Accepting commits you to arriving ${label}.`);
    assert.strictEqual(v.heading, 'Booking request');
});

await t('an unscheduled standard offer reads "As soon as possible", no commitment line', () => {
    const v = offerView(offer(), NOW);
    assert.strictEqual(v.kind, OFFER_KIND.STANDARD);
    assert.strictEqual(v.when, 'As soon as possible');
    assert.strictEqual(v.commitment, null);
    assert.strictEqual(v.heading, 'New job request');
});

await t('the visit fee is the server\'s calloutFee, formatted, and nothing is derived from it', () => {
    const v = offerView(offer({ calloutFee: 50 }), NOW);
    assert.strictEqual(v.visitFee, truth.formatMoney(50));
    for (const k of Object.keys(v)) assert.ok(!/net|earn|receive|commission|payout|cut/i.test(k), `no entitlement field: ${k}`);
    assert.strictEqual(offerView(offer({ calloutFee: 0 }), NOW).visitFee, null, 'no fee is not "GHS 0.00"');
    assert.strictEqual(offerView(offer({ calloutFee: undefined }), NOW).visitFee, null);
    assert.strictEqual(offerView(offer({ jobQuote: 300 }), NOW).jobPrice, truth.formatMoney(300), 'a price on the request, as written');
    assert.strictEqual(offerView(offer({ jobQuote: 0 }), NOW).jobPrice, null);
});

await t('distance comes from the server\'s distanceKm; missing is omitted, never 0', () => {
    assert.strictEqual(offerView(offer({ distanceKm: 2.34 }), NOW).distance, '2.3 km away');
    assert.strictEqual(offerView(offer({ distanceKm: 0.04 }), NOW).distance, 'under 100 m away');
    assert.strictEqual(offerView(offer({ distanceKm: null }), NOW).distance, null);
    assert.strictEqual(offerView(offer({ distanceKm: undefined }), NOW).distance, null);
});

await t('service label from the catalogue id; photos only real URLs', () => {
    const v = offerView(offer({ serviceType: 'ac-repair', photos: ['https://res.example/a.jpg', 'javascript:x', 42] }), NOW);
    assert.strictEqual(v.service, 'AC Repair');
    assert.deepStrictEqual(v.photos, ['https://res.example/a.jpg']);
});

console.log('\n── offerView: nothing that identifies the customer ──\n');

await t('no name, address or position reaches the view, even when the document has them', () => {
    const o = offer({ customerFirstName: 'Ama', address: '12 Ring Road', lat: 5.6123, lng: -0.1871, customerId: 'cust_9' });
    const json = JSON.stringify(offerView(o, NOW));
    for (const leak of ['Ama', 'Ring Road', '5.61', '-0.18', '-0.19', 'cust_9']) {
        assert.ok(!json.includes(leak), `the offer view leaks "${leak}": ${json}`);
    }
});

console.log('\n── placeJob: yours / waiting / upcoming / closed ──\n');

const booking = (over = {}) => ({ id: 'bk_9', artisanId: 'art_1', track: 'inspection', calloutFee: 50, ...over });

await t('needs the artisan → yours, with the action resolveJourney offers', () => {
    const cases = [
        [booking({ status: 'inspection_scheduled', calloutPaid: true }),               'enRoute'],
        [booking({ status: 'en_route', calloutPaid: true }),                           'arrived'],
        [booking({ status: 'in_progress', calloutPaid: true }),                        'completeInspection'],
        [booking({ status: 'inspection_done', calloutPaid: true }),                    'submitQuote'],
        [booking({ status: 'accepted', track: 'standard' }),                           'submitQuote'],
        [booking({ status: 'accepted', track: 'emergency', calloutPaid: true }),       'enRoute'],
        [booking({ status: 'in_progress', track: 'emergency', calloutPaid: true }),    'submitQuote'],
        [booking({ status: 'in_progress', quoteApproved: true, calloutPaid: true }),   'markDone'],
    ];
    for (const [b, op] of cases) {
        const p = placeJob(b, NOW);
        assert.strictEqual(p.place, 'yours', `${b.track}/${b.status}`);
        assert.strictEqual(p.journey.action.op, op, `${b.track}/${b.status}`);
    }
});

await t('waiting on the customer → waiting (no action): visit fee, quote, confirmation, dispute', () => {
    for (const b of [
        booking({ status: 'accepted', calloutPaid: false }),
        booking({ status: 'quoted', calloutPaid: true }),
        booking({ status: 'awaiting', quoteApproved: true }),
        booking({ status: 'disputed', quoteApproved: true }),
    ]) {
        const p = placeJob(b, NOW);
        assert.strictEqual(p.place, 'waiting', b.status);
        assert.strictEqual(p.journey.action, null, b.status);
    }
});

await t('a booked slot not yet open → upcoming, never an action the rules refuse', () => {
    const b = booking({ status: 'inspection_scheduled', calloutPaid: true, scheduledForMs: NOW + 2 * DAY, scheduleWindowMins: 180 });
    const p = placeJob(b, NOW);
    assert.strictEqual(p.place, 'upcoming');
    assert.strictEqual(p.journey.action, null);
    assert.strictEqual(sched.canStartWork(b, NOW).allowed, false);
});

await t('the same slot once due → yours (Mark en route)', () => {
    const b = booking({ status: 'inspection_scheduled', calloutPaid: true, scheduledForMs: NOW + 10 * 60e3, scheduleWindowMins: 180 });
    assert.strictEqual(sched.canStartWork(b, NOW).allowed, true);
    const p = placeJob(b, NOW);
    assert.strictEqual(p.place, 'yours');
    assert.strictEqual(p.journey.action.op, 'enRoute');
});

await t('closed bookings are placed "closed" and appear in no list', () => {
    for (const status of ['completed', 'cancelled', 'rejected', 'unfulfilled', 'resolved']) {
        assert.strictEqual(placeJob(booking({ status }), NOW).place, 'closed', status);
        const s = resolveToday({ artisan: ARTISAN, bookings: [booking({ status })], nowMs: NOW });
        assert.strictEqual(s.jobs.length + s.waiting.length + s.upcoming.length, 0, status);
    }
});

console.log('\n── resolveToday: one state, in priority order ──\n');

const enRoute = booking({ id: 'bk_er', status: 'en_route', calloutPaid: true });
const working = booking({ id: 'bk_ip', status: 'in_progress', quoteApproved: true, calloutPaid: true });
const quoteDue = booking({ id: 'bk_q', status: 'accepted', track: 'standard' });

await t('no profile yet → unknown', () => {
    assert.strictEqual(resolveToday({ artisan: null, offers: [offer()], nowMs: NOW }).mode, TODAY_MODE.UNKNOWN);
});

await t('an answerable offer outranks a job in progress, and carries it (Q3)', () => {
    const s = resolveToday({ artisan: ARTISAN, offers: [offer()], bookings: [enRoute], nowMs: NOW });
    assert.strictEqual(s.mode, TODAY_MODE.OFFER);
    assert.strictEqual(s.offer.id, 'bk_1');
    assert.strictEqual(s.alsoOnJob.booking.id, 'bk_er');
});

await t('an expired offer does not take the screen', () => {
    const s = resolveToday({ artisan: ARTISAN, offers: [offer({ expiresAtMs: NOW - 1 })], bookings: [enRoute], nowMs: NOW });
    assert.strictEqual(s.mode, TODAY_MODE.JOB);
});

await t('several offers: the one expiring soonest first; a customer-chosen one after timed ones', () => {
    const s = resolveToday({ artisan: ARTISAN, nowMs: NOW, offers: [
        offer({ id: 'a', bookingId: 'a', prematched: true, expiresAtMs: null }),
        offer({ id: 'b', bookingId: 'b', expiresAtMs: NOW + 150e3 }),
        offer({ id: 'c', bookingId: 'c', expiresAtMs: NOW + 40e3 }),
        offer({ id: 'd', bookingId: 'd', expiresAtMs: NOW - 5e3 }),
    ] });
    assert.strictEqual(s.offer.id, 'c');
    assert.strictEqual(s.moreOffers, 2, 'b and a, not the expired d');
});

await t('an offline artisan still sees an open offer (the server\'s accept does not require online)', () => {
    const s = resolveToday({ artisan: { ...ARTISAN, isAvailable: false }, offers: [offer()], nowMs: NOW });
    assert.strictEqual(s.mode, TODAY_MODE.OFFER);
    assert.strictEqual(s.available, false);
});

await t('the job that needs the artisan most: on site › travelling › quote to send', () => {
    const s = resolveToday({ artisan: ARTISAN, bookings: [quoteDue, enRoute, working], nowMs: NOW });
    assert.strictEqual(s.mode, TODAY_MODE.JOB);
    assert.deepStrictEqual(s.jobs.map((p) => p.booking.id), ['bk_ip', 'bk_er', 'bk_q']);
    assert.strictEqual(s.job.booking.id, 'bk_ip');
});

await t('waiting and upcoming jobs are listed but never take the screen', () => {
    const waiting  = booking({ id: 'w', status: 'quoted', calloutPaid: true });
    const upcoming = booking({ id: 'u', status: 'inspection_scheduled', calloutPaid: true, scheduledForMs: NOW + 3 * DAY });
    const later    = booking({ id: 'u2', status: 'inspection_scheduled', calloutPaid: true, scheduledForMs: NOW + 5 * DAY });
    const s = resolveToday({ artisan: ARTISAN, bookings: [later, waiting, upcoming], nowMs: NOW });
    assert.strictEqual(s.mode, TODAY_MODE.ONLINE);
    assert.deepStrictEqual(s.waiting.map((p) => p.booking.id), ['w']);
    assert.deepStrictEqual(s.upcoming.map((p) => p.booking.id), ['u', 'u2'], 'soonest first');
});

await t('nothing to do: online or offline from the stored choice, strictly', () => {
    assert.strictEqual(resolveToday({ artisan: ARTISAN, nowMs: NOW }).mode, TODAY_MODE.ONLINE);
    assert.strictEqual(resolveToday({ artisan: { ...ARTISAN, isAvailable: false }, nowMs: NOW }).mode, TODAY_MODE.OFFLINE);
    assert.strictEqual(resolveToday({ artisan: { ...ARTISAN, isAvailable: 'true' }, nowMs: NOW }).mode, TODAY_MODE.OFFLINE);
    assert.strictEqual(resolveToday({ artisan: { ...ARTISAN, isAvailable: undefined }, nowMs: NOW }).mode, TODAY_MODE.OFFLINE);
});

await t('an account that cannot go online is locked, with availability.js\'s reason', () => {
    for (const [over, reason] of [
        [{ verificationStatus: 'pending_review' }, 'under_review'],
        [{ verificationStatus: 'unverified' },     'unverified'],
        [{ status: 'suspended' },                  'suspended'],
    ]) {
        const s = resolveToday({ artisan: { ...ARTISAN, ...over }, offers: [offer()], nowMs: NOW });
        assert.strictEqual(s.mode, TODAY_MODE.LOCKED, reason);
        assert.strictEqual(s.blocker.reason, reason);
    }
});

await t('a locked account with a job already under way still sees the job', () => {
    const s = resolveToday({ artisan: { ...ARTISAN, status: 'suspended' }, bookings: [enRoute], nowMs: NOW });
    assert.strictEqual(s.mode, TODAY_MODE.JOB);
    assert.strictEqual(s.blocker.reason, 'suspended');
});

await t('the module is pure: no DOM, Firebase or clock reads', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'shared', 'js', 'domain', 'artisanToday.js'), 'utf8');
    assert.ok(!/document\.|window\.|firebase|getFirestore|localStorage/.test(src));
    // Date.now only as a default argument; every function takes nowMs.
    const calls = src.match(/Date\.now\(\)/g) || [];
    const defaults = src.match(/nowMs = Date\.now\(\)/g) || [];
    assert.strictEqual(calls.length, defaults.length, 'Date.now() only as a default for nowMs');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
    for (const [n, e] of failures) console.log(`\n✗ ${n}\n${e.stack}`);
    process.exit(1);
}
})();
