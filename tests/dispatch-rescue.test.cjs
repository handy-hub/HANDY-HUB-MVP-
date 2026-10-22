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

await t('an immediate request older than an hour is stale — not offered to anyone', async () => {
    reset(); seedArtisans();
    fake.db._set('bookings/b1', booking({ createdAt: ago(2 * 60 * MIN), updatedAt: ago(2 * 60 * MIN) }));
    await dispatch.checkExpiredDispatches();
    assert.strictEqual(bk('b1').dispatchStatus, undefined);
    assert.strictEqual(notifs('a1').length, 0);
});

await t('a booked appointment still ahead is rescued however long ago it was made', async () => {
    reset(); seedArtisans();
    const tomorrow = Date.now() + 24 * 60 * MIN;
    fake.db._set('bookings/b1', booking({ createdAt: ago(3 * 60 * MIN), updatedAt: ago(3 * 60 * MIN),
        scheduledForMs: tomorrow, scheduledFor: new Date(tomorrow).toISOString(), scheduleWindowMins: 120 }));
    await dispatch.checkExpiredDispatches();
    assert.strictEqual(bk('b1').dispatchStatus, 'dispatched');
});

await t('an appointment already past is not rescued', async () => {
    reset(); seedArtisans();
    const earlier = Date.now() - 30 * MIN;
    fake.db._set('bookings/b1', booking({ createdAt: ago(3 * 60 * MIN), scheduledForMs: earlier, scheduleWindowMins: 120 }));
    await dispatch.checkExpiredDispatches();
    assert.strictEqual(bk('b1').dispatchStatus, undefined);
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

console.log(`\ndispatch-rescue: ${passed} passed, ${failed} failed`);
if (failed) {
    for (const [n, e] of failures) console.error(`\n✗ ${n}\n${e.stack}`);
    process.exit(1);
}
})();
