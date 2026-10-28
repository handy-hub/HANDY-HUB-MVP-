'use strict';

/**
 * tests/dispatch-rescue.test.cjs — a booking always reaches dispatch, and
 * dispatch never runs twice for one booking.
 *
 * Run: node tests/dispatch-rescue.test.cjs
 *
 *   • A pending booking that onBookingCreated never reached (a deploy gap, an
 *     outage, a crash before its first round) used to sit at "finding a
 *     professional" forever: the every-minute sweep only looked at offers that
 *     had expired. The sweep now replays the creation step for it.
 *   • The trigger and the sweep can race, and Firestore delivers an event at
 *     least once. Both go through one transactional claim, so exactly one
 *     dispatch round starts — and a re-delivered event can no longer reset an
 *     accepted booking to 'searching' and dispatch it again.
 *
 * The REAL functions/dispatch.js runs against tests/support/fake-firebase.cjs.
 */

const assert = require('assert');
const path   = require('path');
const { createRequire } = require('module');

const fake = require('./support/fake-firebase.cjs').install();
const ROOT = path.join(__dirname, '..');
const FN   = path.join(ROOT, 'functions');
const { geohashForLocation } = createRequire(path.join(FN, 'package.json'))('geofire-common');

const dispatch  = require(path.join(FN, 'dispatch.js'));
const jobOffers = require(path.join(FN, 'jobOffers.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const P   = { lat: 5.603716, lng: -0.186964 };
const MIN = 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function seedArtisans(ids = ['a1']) {
    for (const id of ids) {
        fake.db._set(`artisan_index/${id}`, {
            artisanId: id, geohash: geohashForLocation([P.lat, P.lng]), lat: P.lat, lng: P.lng,
            skills: ['plumbing'], isAvailable: true, isOnline: true, status: 'active', verificationStatus: 'approved',
            rating: 4.5, workRadius: 20, name: id,
        });
        fake.db._set(`artisans/${id}`, { userType: 'artisan', status: 'active', verificationStatus: 'approved', name: id });
    }
}
const booking = (over = {}) => ({
    customerId: 'cust1', customerFirstName: 'Ama', serviceType: 'plumbing', track: 'standard', type: 'standard',
    status: 'pending', artisanId: null, lat: P.lat + 0.01, lng: P.lng + 0.01,
    createdAt: ago(5 * MIN), updatedAt: ago(5 * MIN), ...over,
});
function reset() { fake.db._reset(); fake.messaging._reset(); }
const bk     = (id) => fake.db._get(`bookings/${id}`);
const offer  = (id) => fake.db._get(`job_offers/${id}`);
const notifs = (to) => fake.db._keys('customer_notifications/')
    .map((k) => fake.db._get(k)).filter((n) => n.receiverId === to);

(async () => {
console.log('\n── A booking dispatch never started is rescued by the sweep ──\n');

await t('a pending booking the trigger never reached is dispatched by the next tick', async () => {
    reset(); seedArtisans();
    fake.db._set('bookings/b1', booking());
    await dispatch.checkExpiredDispatches();
    const b = bk('b1');
    assert.deepStrictEqual([b.dispatchStatus, b.currentArtisanId, b.currentDispatchRound], ['dispatched', 'a1', 1]);
    assert.strictEqual(b.artisanId, null, 'offered, not assigned');
    assert.deepStrictEqual([offer('b1').artisanId, offer('b1').offerStatus], ['a1', 'open']);
    assert.strictEqual(notifs('a1').length, 1, 'the artisan is told once');
});

await t('a booking the trigger never stamped also gets its track', async () => {
    reset(); seedArtisans();
    const { track, ...noTrack } = booking();
    fake.db._set('bookings/b1', noTrack);
    await dispatch.checkExpiredDispatches();
    assert.strictEqual(bk('b1').track, 'standard');
    assert.strictEqual(bk('b1').dispatchStatus, 'dispatched');
});

await t('a booking younger than two minutes is left for the trigger', async () => {
    reset(); seedArtisans();
    fake.db._set('bookings/b1', booking({ createdAt: ago(30 * 1000), updatedAt: ago(30 * 1000) }));
    await dispatch.checkExpiredDispatches();
    assert.strictEqual(bk('b1').dispatchStatus, undefined);
    assert.strictEqual(fake.db._has('job_offers/b1'), false);
});

await t('an immediate request older than an hour is not offered to anyone — its search is over', async () => {
    reset(); seedArtisans();
    fake.db._set('bookings/b1', booking({ createdAt: ago(2 * 60 * MIN), updatedAt: ago(2 * 60 * MIN) }));
    await dispatch.checkExpiredDispatches();
    assert.strictEqual(notifs('a1').length, 0, 'no artisan is sent a stale request');
    assert.deepStrictEqual([bk('b1').status, bk('b1').unfulfillReason], ['unfulfilled', 'search_timeout']);
});

await t('a booked appointment still ahead is rescued however long ago it was made', async () => {
    reset(); seedArtisans();
    const tomorrow = Date.now() + 24 * 60 * MIN;
    fake.db._set('bookings/b1', booking({ createdAt: ago(3 * 60 * MIN), updatedAt: ago(3 * 60 * MIN),
        scheduledForMs: tomorrow, scheduledFor: new Date(tomorrow).toISOString(), scheduleWindowMins: 120 }));
    await dispatch.checkExpiredDispatches();
    assert.strictEqual(bk('b1').dispatchStatus, 'dispatched');
});

await t('an appointment already past is not rescued — it is closed', async () => {
    reset(); seedArtisans();
    const earlier = Date.now() - 30 * MIN;
    fake.db._set('bookings/b1', booking({ createdAt: ago(3 * 60 * MIN), scheduledForMs: earlier, scheduleWindowMins: 120 }));
    await dispatch.checkExpiredDispatches();
    assert.strictEqual(notifs('a1').length, 0);
    assert.deepStrictEqual([bk('b1').status, bk('b1').unfulfillReason], ['unfulfilled', 'search_timeout']);
});

await t('a customer-chosen request is rescued as an OFFER to that artisan — never open-dispatched', async () => {
    reset(); seedArtisans(['a1', 'a2']);
    fake.db._set('bookings/b1', booking({ requestedArtisanId: 'a2' }));
    await dispatch.checkExpiredDispatches();
    const b = bk('b1');
    assert.deepStrictEqual([b.currentArtisanId, b.artisanId, b.dispatchStatus], ['a2', null, undefined]);
    assert.deepStrictEqual([offer('b1').artisanId, offer('b1').prematched], ['a2', true]);
    assert.strictEqual(notifs('a1').length, 0, 'nobody else is offered the customer\'s job');
});

await t('with nobody available the customer gets the honest answer, not an endless search', async () => {
    reset();
    fake.db._set('bookings/b1', booking());
    await dispatch.checkExpiredDispatches();
    assert.deepStrictEqual([bk('b1').status, bk('b1').unfulfillReason], ['unfulfilled', 'no_candidates']);
    assert.strictEqual(notifs('cust1').length, 1);
});

await t('a search stalled between rounds is resumed; one still settling is not', async () => {
    reset(); seedArtisans();
    fake.db._set('bookings/b1', booking({ dispatchStatus: 'searching', currentDispatchRound: 1,
        artisanCandidates: ['gone'], updatedAt: ago(5 * MIN) }));
    fake.db._set('bookings/b2', booking({ dispatchStatus: 'searching', currentDispatchRound: 1,
        artisanCandidates: ['gone'], updatedAt: ago(20 * 1000) }));
    await dispatch.checkExpiredDispatches();
    assert.deepStrictEqual([bk('b1').dispatchStatus, bk('b1').currentDispatchRound], ['dispatched', 2]);
    assert.strictEqual(bk('b2').dispatchStatus, 'searching');
});

await t('bookings already moving are not touched by the rescue', async () => {
    reset(); seedArtisans();
    fake.db._set('bookings/open', booking({ dispatchStatus: 'dispatched', currentArtisanId: 'a1',
        currentDispatchRound: 1, responseDeadline: fake.Timestamp.fromMillis(Date.now() + 2 * MIN) }));
    fake.db._set('bookings/pm', booking({ requestedArtisanId: 'a1', currentArtisanId: 'a1' }));
    fake.db._set('bookings/acc', booking({ status: 'accepted', artisanId: 'a1' }));
    const before = JSON.stringify(['open', 'pm', 'acc'].map(bk));
    const r = await dispatch.rescueStalledBookings();
    assert.strictEqual(r.rescued, 0);
    assert.strictEqual(JSON.stringify(['open', 'pm', 'acc'].map(bk)), before);
});

await t('one tick rescues at most 25; the rest follow on the next', async () => {
    reset();
    for (let i = 0; i < 30; i++) fake.db._set(`bookings/m${String(i).padStart(2, '0')}`, booking({ createdAt: ago((5 + i) * 1000 + 3 * MIN) }));
    assert.strictEqual((await dispatch.rescueStalledBookings()).rescued, 25);
    assert.strictEqual((await dispatch.rescueStalledBookings()).rescued, 5);
    assert.strictEqual((await dispatch.rescueStalledBookings()).rescued, 0);
});

console.log('\n── Dispatch never runs twice for one booking ──\n');

await t('the claim succeeds once', async () => {
    reset();
    fake.db._set('bookings/b1', booking());
    assert.strictEqual(await dispatch.claimForDispatch('b1'), true);
    assert.strictEqual(await dispatch.claimForDispatch('b1'), false);
    assert.strictEqual(bk('b1').dispatchStatus, 'searching');
});

await t('the trigger and the sweep racing start exactly one round', async () => {
    reset(); seedArtisans(['a1', 'a2']);
    const data = booking();
    fake.db._set('bookings/b1', data);
    await Promise.all([
        dispatch.onBookingCreated({ params: { bookingId: 'b1' }, data: { data: () => data } }),
        dispatch.rescueStalledBookings(),
        dispatch.processNewBooking('b1', data),
    ]);
    const b = bk('b1');
    assert.strictEqual(b.currentDispatchRound, 1);
    assert.strictEqual(b.artisanCandidates.length, 1);
    assert.strictEqual(notifs('a1').length + notifs('a2').length, 1, 'one artisan, told once');
});

await t('a re-delivered creation event cannot re-dispatch an ACCEPTED booking', async () => {
    // The old trigger reset dispatchStatus to 'searching' unconditionally, and
    // dispatchRound let any 'searching' booking through — so a duplicate event
    // nulled the accepted artisan and offered the job to someone else.
    reset(); seedArtisans(['a1', 'a2']);
    const data = booking();
    fake.db._set('bookings/b1', data);
    await dispatch.onBookingCreated({ params: { bookingId: 'b1' }, data: { data: () => data } });
    await jobOffers.respondToJobOffer({ uid: bk('b1').currentArtisanId }, { bookingId: 'b1', decision: 'accept' });
    const accepted = bk('b1');
    await dispatch.onBookingCreated({ params: { bookingId: 'b1' }, data: { data: () => data } });
    assert.deepStrictEqual(bk('b1'), accepted, 'the accepted booking is unchanged');
    assert.strictEqual(accepted.artisanId, accepted.currentArtisanId);
});

await t('a re-delivered event during an open offer starts no second round', async () => {
    reset(); seedArtisans(['a1', 'a2']);
    const data = booking();
    fake.db._set('bookings/b1', data);
    await dispatch.onBookingCreated({ params: { bookingId: 'b1' }, data: { data: () => data } });
    const first = offer('b1');
    await dispatch.onBookingCreated({ params: { bookingId: 'b1' }, data: { data: () => data } });
    assert.strictEqual(bk('b1').currentDispatchRound, 1);
    assert.deepStrictEqual(offer('b1'), first, 'the open offer is not reissued');
    assert.strictEqual(notifs('a1').length + notifs('a2').length, 1);
});

await t('a re-delivered event does not reopen a customer-chosen offer', async () => {
    reset(); seedArtisans();
    const data = booking({ requestedArtisanId: 'a1' });
    fake.db._set('bookings/b1', data);
    await dispatch.onBookingCreated({ params: { bookingId: 'b1' }, data: { data: () => data } });
    const first = offer('b1');
    await dispatch.onBookingCreated({ params: { bookingId: 'b1' }, data: { data: () => data } });
    assert.deepStrictEqual(offer('b1'), first);
});

await t('dispatchRound refuses a cancelled booking even if it reads "searching"', async () => {
    reset(); seedArtisans();
    fake.db._set('bookings/b1', booking({ status: 'cancelled', dispatchStatus: 'searching' }));
    const r = await dispatch.dispatchRound('b1');
    assert.strictEqual(r.skipped, 'status_cancelled');
    assert.strictEqual(fake.db._has('job_offers/b1'), false);
});

await t('dispatchRound never open-dispatches a customer-chosen request', async () => {
    reset(); seedArtisans(['a1', 'a2']);
    fake.db._set('bookings/b1', booking({ requestedArtisanId: 'a2' }));
    const r = await dispatch.dispatchRound('b1');
    assert.ok(r.skipped, JSON.stringify(r));
    assert.strictEqual(fake.db._has('job_offers/b1'), false);
});

await t('an expired offer still moves to the next artisan (expiry pass unchanged)', async () => {
    reset(); seedArtisans(['a1', 'a2']);
    const data = booking();
    fake.db._set('bookings/b1', data);
    await dispatch.onBookingCreated({ params: { bookingId: 'b1' }, data: { data: () => data } });
    const firstArtisan = bk('b1').currentArtisanId;
    fake.db._set('bookings/b1', { ...bk('b1'), responseDeadline: fake.Timestamp.fromMillis(Date.now() - 1000) });
    await dispatch.checkExpiredDispatches();
    const b = bk('b1');
    assert.deepStrictEqual([b.dispatchStatus, b.currentDispatchRound], ['dispatched', 2]);
    assert.notStrictEqual(b.currentArtisanId, firstArtisan);
});

console.log('\n── A search has a deadline (no more "searching for 1879 minutes") ──\n');

const offerOf = (id) => fake.db._has(`job_offers/${id}`) ? fake.db._get(`job_offers/${id}`) : null;

await t('the 2026-10-23 case: a request never dispatched, 44 hours old, is closed and the customer told', async () => {
    reset(); seedArtisans();
    fake.db._set('bookings/old', booking({ createdAt: ago(2664 * MIN), updatedAt: ago(2664 * MIN), track: 'inspection' }));
    await dispatch.checkExpiredDispatches();
    const b = bk('old');
    assert.deepStrictEqual([b.status, b.dispatchStatus, b.unfulfillReason], ['unfulfilled', 'unfulfilled', 'search_timeout']);
    assert.ok(b.searchEndedAt, 'when it ended is recorded');
    assert.strictEqual(offerOf('old'), null, 'no offer document is invented for a request that never had one');
    const n = notifs('cust1');
    assert.strictEqual(n.length, 1);
    assert.match(n[0].message, /within an hour/);
    assert.match(n[0].message, /Nothing was charged/);
});

await t('an immediate request inside its hour keeps searching', async () => {
    reset(); seedArtisans();
    fake.db._set('bookings/b1', booking({ createdAt: ago(59 * MIN), updatedAt: ago(10 * 1000),
        dispatchStatus: 'dispatched', currentArtisanId: 'a1', currentDispatchRound: 3,
        responseDeadline: fake.Timestamp.fromMillis(Date.now() + 2 * MIN) }));
    await dispatch.expireStaleSearches();
    assert.strictEqual(bk('b1').status, 'pending');
});

await t('at the deadline an open offer is WITHDRAWN (not counted against the artisan) and the request closed', async () => {
    reset(); seedArtisans();
    fake.db._set('bookings/b1', booking({ createdAt: ago(61 * MIN), dispatchStatus: 'dispatched', currentArtisanId: 'a1',
        currentDispatchRound: 9, responseDeadline: fake.Timestamp.fromMillis(Date.now() + MIN) }));
    fake.db._set('job_offers/b1', jobOffers.buildOfferDoc(booking(), { bookingId: 'b1', artisanId: 'a1', expiresAtMs: Date.now() + MIN, round: 9 }));
    await dispatch.expireStaleSearches();
    assert.strictEqual(offerOf('b1').offerStatus, 'withdrawn');
    const ev = fake.db._keys('offer_events/').map((k) => fake.db._get(k));
    assert.deepStrictEqual(ev.map((e) => e.outcome), ['withdrawn']);
    assert.strictEqual(bk('b1').status, 'unfulfilled');
});

await t('a customer-chosen request (an offer with no expiry) also ends after the hour', async () => {
    reset(); seedArtisans();
    const data = booking({ requestedArtisanId: 'a1', createdAt: ago(90 * MIN) });
    fake.db._set('bookings/b1', data);
    await dispatch.processNewBooking('b1', data);                     // opens the no-deadline offer
    assert.strictEqual(offerOf('b1').expiresAtMs, null);
    await dispatch.expireStaleSearches();
    assert.deepStrictEqual([bk('b1').status, offerOf('b1').offerStatus], ['unfulfilled', 'withdrawn']);
});

await t('money already held (a paid emergency callout) is refunded when the search ends', async () => {
    reset(); seedArtisans();
    fake.db._set('customers/cust1', { walletBalance: 20, escrowBalance: 0, name: 'Ama' });
    require('./support/walletEvidence.cjs').fundCustomer(fake.db, 'cust1', 20);
    fake.db._set('bookings/em', booking({ type: 'emergency', track: 'emergency', requestedArtisanId: 'a1', currentArtisanId: 'a1',
        createdAt: ago(70 * MIN) }));
    const escrow = require(path.join(FN, 'financial', 'escrow.js'));
    await escrow.holdFundsForBooking({ bookingId: 'em', customerId: 'cust1', artisanId: 'a1', amount: 20, callerAuth: null, kind: 'callout' });
    assert.deepStrictEqual([fake.db._get('customers/cust1').walletBalance, fake.db._get('customers/cust1').escrowBalance], [0, 20]);
    await dispatch.expireStaleSearches();
    assert.strictEqual(bk('em').status, 'unfulfilled');
    assert.deepStrictEqual([fake.db._get('customers/cust1').walletBalance, fake.db._get('customers/cust1').escrowBalance], [20, 0]);
    assert.ok(notifs('cust1').some((x) => /has been refunded/.test(x.message)));
    assert.strictEqual(bk('em').calloutSettled, 'refunded', 'the booking records it for the customer\'s screens');

});

await t('a booked appointment keeps searching until it starts, however long ago it was made', async () => {
    reset(); seedArtisans();
    const later = Date.now() + 5 * 60 * MIN;
    fake.db._set('bookings/s1', booking({ createdAt: ago(48 * 60 * MIN), scheduledForMs: later, scheduleWindowMins: 120,
        dispatchStatus: 'dispatched', currentArtisanId: 'a1', responseDeadline: fake.Timestamp.fromMillis(Date.now() + MIN) }));
    await dispatch.expireStaleSearches();
    assert.strictEqual(bk('s1').status, 'pending');
    await dispatch.expireStaleSearches(later + 1);                    // the appointment has started
    assert.deepStrictEqual([bk('s1').status, bk('s1').unfulfillReason], ['unfulfilled', 'search_timeout']);
    assert.match(notifs('cust1').pop().message, /before it was due to start/);
});

await t('accepted, cancelled and completed bookings are never touched', async () => {
    reset();
    for (const st of ['accepted', 'cancelled', 'completed', 'in_progress']) {
        fake.db._set(`bookings/${st}`, booking({ status: st, createdAt: ago(5 * 60 * MIN) }));
    }
    const before = JSON.stringify(['accepted', 'cancelled', 'completed', 'in_progress'].map(bk));
    await dispatch.expireStaleSearches();
    assert.strictEqual(JSON.stringify(['accepted', 'cancelled', 'completed', 'in_progress'].map(bk)), before);
});

await t('running the sweep twice closes once and notifies once', async () => {
    reset();
    fake.db._set('bookings/old', booking({ createdAt: ago(3 * 60 * MIN) }));
    await dispatch.expireStaleSearches();
    await dispatch.expireStaleSearches();
    assert.strictEqual(notifs('cust1').length, 1);
});

await t('the deadline is one shared rule (client copy and server agree)', () => {
    const sched = require(path.join(FN, 'shared', 'bookingSchedule.js'));
    const created = Date.parse('2026-10-21T16:46:00Z');
    assert.strictEqual(sched.searchDeadlineMs({ createdAt: '2026-10-21T16:46:00.000Z' }), created + sched.SEARCH_WINDOW_MS);
    assert.strictEqual(sched.searchDeadlineMs({ createdAt: 'garbage' }), null, 'no creation time: left alone, never closed on a guess');
    assert.strictEqual(dispatch.RESCUE_WINDOW_MS, sched.SEARCH_WINDOW_MS, 'rescue and expiry use the same window');
});

console.log(`\ndispatch-rescue: ${passed} passed, ${failed} failed`);
if (failed) {
    for (const [n, e] of failures) console.error(`\n✗ ${n}\n${e.stack}`);
    process.exit(1);
}
})();
