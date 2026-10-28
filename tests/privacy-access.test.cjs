'use strict';

/**
 * tests/privacy-access.test.cjs — who may see what, enforced where it counts.
 *
 * Run: node tests/privacy-access.test.cjs
 * (The Firestore-rules half of the same promises runs against the emulator:
 *  npm run test:access-rules → tests/privacy-access-rules.test.mjs.)
 *
 * WHAT THIS PROTECTS (2026-10-19 artisan audit)
 *   AR-03  an artisan's precise position must not be public: the profile keeps
 *          ~1 km; dispatch keeps precision through the server-only index; the
 *          live map comes from the booking, not the profile.
 *   AR-06  an artisan who is only OFFERED a job sees a summary (job_offers),
 *          never the customer's address, position, notes or phone; acceptance is
 *          the server's decision, and the phone lives off the booking.
 *   AR-09  one path from "signed in" to "artisan account", no duplicates, no
 *          customer/admin crossover, and no approval without a verified email.
 *   AR-11  support requests are created honestly and handled somewhere.
 *
 * The REAL functions/*.js modules run against tests/support/fake-firebase.cjs;
 * the shared ESM domain modules are evaluated directly.
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

const jobOffers      = require(path.join(FN, 'jobOffers.js'));
const dispatch       = require(path.join(FN, 'dispatch.js'));
const artisanIndex   = require(path.join(FN, 'artisanIndex.js'));
const contactPrivacy = require(path.join(FN, 'contactPrivacy.js'));
const artisanAccount = require(path.join(FN, 'artisanAccount.js'));
const verification   = require(path.join(FN, 'artisanVerification.js'));
const pricing        = require(path.join(FN, 'pricing.js'));

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

function esm(rel, names, extra = []) {
    const strip = (src) => src
        .replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*\n/gm, '')
        .replace(/^\s*export\s+async\s+function\s+/gm, 'async function ')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
    const body = [...extra, rel].map((r) => strip(fs.readFileSync(path.join(ROOT, r), 'utf8'))).join('\n');
    // eslint-disable-next-line no-new-func
    return new Function(`${body}\nreturn { ${names.join(', ')} };`)();
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LOC   = esm('shared/js/domain/locationPrivacy.js', ['coarseCoord', 'publicLocation', 'isCoarse', 'PUBLIC_GEOHASH_LENGTH']);
const REPO  = esm('shared/js/data/repositories/artisanRepository.js', ['createArtisanRepository'],
                  ['shared/js/domain/locationPrivacy.js']);
const TRUTH = esm('shared/js/domain/bookingTruth.js', ['resolveJobBrief']);
const TICK  = esm('shared/js/domain/supportTickets.js', ['validateTicket', 'validateReply', 'TICKET_TOPICS', 'ticketStatusLabel']);

// Accra, precise, and a booking ~2 km away.
const P   = { lat: 5.603716, lng: -0.186964 };
const BK  = { lat: 5.621234, lng: -0.173456 };

(async () => {
console.log('\n── AR-03 · the public profile carries ~1 km, the server keeps precision ──\n');

await t('coarseCoord rounds to 0.01°; the public geohash is at most 5 characters', () => {
    assert.strictEqual(LOC.coarseCoord(5.603716), 5.6);
    assert.strictEqual(LOC.coarseCoord(-0.186964), -0.19);
    assert.strictEqual(LOC.coarseCoord(null), null);
    const pub = LOC.publicLocation(P.lat, P.lng, (la, ln) => geohashForLocation([la, ln]));
    assert.deepStrictEqual([pub.lat, pub.lng, pub.latitude, pub.longitude], [5.6, -0.19, 5.6, -0.19]);
    assert.ok(pub.geohash.length <= LOC.PUBLIC_GEOHASH_LENGTH);
    assert.ok(LOC.isCoarse(pub.lat) && !LOC.isCoarse(P.lat));
});

function recordingDb() {
    const calls = [];
    return {
        calls,
        async getDocument() { return { exists: false }; },
        async setDocument(col, id, data, opts) { calls.push({ op: 'set', col, id, data, opts }); },
        async updateDocument(col, id, data) { calls.push({ op: 'update', col, id, data }); },
    };
}

await t('presence writes the precise fix to private/location FIRST, then only coarse public fields', async () => {
    const db = recordingDb();
    const repo = REPO.createArtisanRepository({ databaseService: db });
    await repo.updatePresenceAndLocation('a1', { isOnline: true, latitude: P.lat, longitude: P.lng, accuracy: 8, source: 'browser_gps' });
    assert.deepStrictEqual(db.calls.map((c) => `${c.op}:${c.col}/${c.id}`), ['set:artisans/a1/private/location', 'update:artisans/a1']);
    assert.deepStrictEqual(db.calls[0].data.lat, P.lat);
    const pub = db.calls[1].data;
    assert.strictEqual(pub.lat, 5.6);
    assert.strictEqual(pub.lng, -0.19);
    assert.strictEqual(pub.currentLat, null);
    assert.strictEqual(pub.currentLng, null);
    assert.strictEqual(pub.locationAccuracy, null);
    assert.ok(!pub.geohash || pub.geohash.length <= 5);
    for (const v of [pub.lat, pub.lng, pub.latitude, pub.longitude]) assert.ok(LOC.isCoarse(v), `${v} is not coarse`);
});

await t('a heartbeat with no fix writes no position at all', async () => {
    const db = recordingDb();
    await REPO.createArtisanRepository({ databaseService: db }).updatePresenceAndLocation('a1', { isOnline: true });
    assert.strictEqual(db.calls.length, 1);
    assert.ok(!('lat' in db.calls[0].data) && !('currentLat' in db.calls[0].data));
});

await t('onboarding writes the work pin precise-private and coarse-public', () => {
    const src = read('artisan-app/onboarding.html');
    assert.match(src, /setDocument\(`artisans\/\$\{uid\}\/private`, 'location', \{\s*lat:\s+_workLocation\.lat/);
    assert.match(src, /lat:\s+coarseCoord\(_workLocation\.lat\)/);
    assert.match(src, /lng:\s+coarseCoord\(_workLocation\.lng\)/);
});

await t('the dispatch index takes the PRECISE private position, falling back to the public one', async () => {
    fake.db._reset();
    fake.db._set('artisans/a1/private/location', { lat: P.lat, lng: P.lng });
    assert.deepStrictEqual(await artisanIndex._positionFor('a1', { lat: 5.6, lng: -0.19 }), P);
    assert.deepStrictEqual(await artisanIndex._positionFor('a2', { lat: 5.6, lng: -0.19 }), { lat: 5.6, lng: -0.19 });
    assert.strictEqual(await artisanIndex._positionFor('a3', {}), null);
});

await t('the live map reads the booking-scoped position, never the artisan profile', () => {
    const lt = read('customer-app/live-tracking.html');
    assert.match(lt, /subscribeToDocument\(\s*`bookings\/\$\{_bookingId\}\/live`, 'artisan'/);
    assert.ok(!/d\.currentLat/.test(lt), 'live-tracking must not read currentLat from the profile');
    const ps = read('shared/js/services/presenceService.js');
    assert.match(ps, /setDocument\(`bookings\/\$\{id\}\/live`, 'artisan'/);
    assert.match(ps, /op: 'in', value: \['en_route', 'in_progress'\]/);
});

await t('the migration reports, copies, then strips — and its report carries no values', async () => {
    fake.db._reset();
    fake.db._set('artisans/a1', { userType: 'artisan', lat: P.lat, lng: P.lng, currentLat: P.lat, currentLng: P.lng, geohash: 's0rk3w5q2', locationAccuracy: 7 });
    fake.db._set('artisans/a2', { userType: 'artisan', lat: 5.6, lng: -0.19 });        // already coarse
    fake.db._set('bookings/b1', { customerId: 'c1', customerPhone: '+233241234567', status: 'completed' });
    fake.db._set('bookings/b2', { customerId: 'c2', status: 'pending' });

    const dry = await contactPrivacy.migrateContactPrivacy({ mode: 'dry-run' });
    assert.deepStrictEqual([dry.artisans.exposed, dry.bookings.exposed], [1, 1]);
    assert.strictEqual(fake.db._has('artisans/a1/private/location'), false, 'dry-run writes nothing');
    assert.ok(!JSON.stringify(dry).includes('+233') && !JSON.stringify(dry).includes('5.6037'), 'no values in the report');

    await contactPrivacy.migrateContactPrivacy({ mode: 'copy' });
    assert.deepStrictEqual(fake.db._get('artisans/a1/private/location').lat, P.lat);
    assert.strictEqual(fake.db._get('artisans/a1').currentLat, P.lat, 'copy does not strip');
    assert.strictEqual(fake.db._get('bookings/b1/private/contact').customerPhone, '+233241234567');

    const strip = await contactPrivacy.migrateContactPrivacy({ mode: 'strip' });
    const a1 = fake.db._get('artisans/a1');
    assert.deepStrictEqual([a1.lat, a1.lng, a1.currentLat, a1.currentLng, a1.locationAccuracy, a1.geohash],
                           [5.6, -0.19, null, null, null, 's0rk3']);
    assert.strictEqual(fake.db._get('bookings/b1').customerPhone, undefined);
    assert.strictEqual(fake.db._get('bookings/b1/private/contact').customerPhone, '+233241234567', 'nothing lost');
    assert.strictEqual(strip.artisans.stripped, 1);
    const again = await contactPrivacy.migrateContactPrivacy({ mode: 'strip' });
    assert.deepStrictEqual([again.artisans.exposed, again.bookings.exposed], [0, 0], 'safe to repeat');
});

console.log('\n── AR-06 · an offer is a summary; the booking opens on acceptance ──\n');

const SENSITIVE = ['address', 'notes', 'customerPhone', 'customerId', 'gpsAddress'];
const fullBooking = () => ({
    customerId: 'cust1', customerFirstName: 'Ama', customerPhone: '+233241111111',
    address: '12 Ring Road East, Osu', notes: 'Gate code 4471', description: 'Leaking pipe under the kitchen sink',
    photos: ['https://res.cloudinary.com/x/a.jpg'], serviceType: 'plumbing', track: 'standard', type: 'standard',
    // Made a few minutes ago: an immediate request is only searched for an hour
    // (bookingSchedule searchDeadlineMs), and dispatchRound refuses one past it.
    status: 'pending', lat: BK.lat, lng: BK.lng, calloutFee: 60, createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
});

await t('the offer summary carries what a decision needs and none of the customer\'s details', () => {
    const o = jobOffers.buildOfferDoc(fullBooking(), { bookingId: 'b1', artisanId: 'a1', expiresAtMs: 123, distanceKm: 2.345 });
    for (const k of SENSITIVE) assert.ok(!(k in o), `${k} must not be in an offer`);
    assert.deepStrictEqual([o.lat, o.lng], [5.62, -0.17], 'coordinates are ~1 km only');
    assert.strictEqual(o.locationApproximate, true);
    assert.strictEqual(o.distanceKm, 2.3);
    assert.strictEqual(o.description, 'Leaking pipe under the kitchen sink');
    assert.strictEqual(o.customerFirstName, 'Ama');
    assert.deepStrictEqual([o.offerStatus, o.status, o.artisanId, o.expiresAtMs], ['open', 'pending', 'a1', 123]);
});

await t('the job brief of an offer says where roughly, without an address or navigation', () => {
    const o = jobOffers.buildOfferDoc(fullBooking(), { bookingId: 'b1', artisanId: 'a1', distanceKm: 2.3 });
    const brief = TRUTH.resolveJobBrief(o);
    assert.strictEqual(brief.location.precision, 'approximate');
    assert.strictEqual(brief.location.address, null);
    assert.strictEqual(brief.location.mapUrl, null);
    assert.strictEqual(brief.distanceKm, 2.3);
    assert.strictEqual(brief.customer.phone, null);
});

function seedDispatchable() {
    fake.db._reset();
    fake.db._set('bookings/b1', fullBooking());
    fake.db._set('artisan_index/a1', {
        artisanId: 'a1', geohash: geohashForLocation([P.lat, P.lng]), lat: P.lat, lng: P.lng,
        skills: ['plumbing'], isAvailable: true, isOnline: true, status: 'active', verificationStatus: 'approved',
        rating: 4.5, workRadius: 20, name: 'Kofi',
    });
    fake.db._set('artisans/a1', { userType: 'artisan', status: 'active', verificationStatus: 'approved', name: 'Kofi' });
    fake.db._set('artisans/a2', { userType: 'artisan', status: 'active', verificationStatus: 'approved', name: 'Yaw' });
}

await t('a dispatch round opens an offer and does NOT make the candidate the booking\'s artisan', async () => {
    seedDispatchable();
    await dispatch.dispatchRound('b1');
    const b = fake.db._get('bookings/b1');
    assert.strictEqual(b.artisanId, null, 'artisanId is what grants the booking — not on offer');
    assert.strictEqual(b.currentArtisanId, 'a1');
    const o = fake.db._get('job_offers/b1');
    assert.strictEqual(o.artisanId, 'a1');
    assert.strictEqual(o.offerStatus, 'open');
    assert.ok(o.expiresAtMs > Date.now());
    for (const k of SENSITIVE) assert.ok(!(k in o), `${k} leaked into the offer`);
});

await t('accepting is the server\'s decision: it sets artisanId and closes the offer', async () => {
    seedDispatchable();
    await dispatch.dispatchRound('b1');
    const r = await jobOffers.respondToJobOffer({ uid: 'a1' }, { bookingId: 'b1', decision: 'accept' });
    assert.strictEqual(r.status, 'accepted');
    const b = fake.db._get('bookings/b1');
    assert.deepStrictEqual([b.status, b.artisanId], ['accepted', 'a1']);
    assert.strictEqual(fake.db._get('job_offers/b1').offerStatus, 'accepted');
});

await t('another artisan cannot take an offer that is not theirs', async () => {
    seedDispatchable();
    await dispatch.dispatchRound('b1');
    const e = await rejects(() => jobOffers.respondToJobOffer({ uid: 'a2' }, { bookingId: 'b1', decision: 'accept' }), /not offered to you/);
    assert.strictEqual(e.reason, 'not_offered');
    assert.strictEqual(fake.db._get('bookings/b1').artisanId, null);
});

await t('an expired offer cannot be accepted, even before the sweep closes it', async () => {
    seedDispatchable();
    await dispatch.dispatchRound('b1');
    fake.db._set('job_offers/b1', { ...fake.db._get('job_offers/b1'), expiresAtMs: Date.now() - 1000 });
    const e = await rejects(() => jobOffers.respondToJobOffer({ uid: 'a1' }, { bookingId: 'b1', decision: 'accept' }), /expired/);
    assert.strictEqual(e.reason, 'expired');
    assert.strictEqual(fake.db._get('bookings/b1').status, 'pending');
});

await t('declining closes the offer and leaves the booking without that artisan', async () => {
    seedDispatchable();
    await dispatch.dispatchRound('b1');
    await jobOffers.respondToJobOffer({ uid: 'a1' }, { bookingId: 'b1', decision: 'decline' });
    assert.strictEqual(fake.db._get('job_offers/b1').offerStatus, 'declined');
    const b = fake.db._get('bookings/b1');
    assert.strictEqual(b.status, 'rejected');
    assert.strictEqual(b.artisanId, null);
    await rejects(() => jobOffers.respondToJobOffer({ uid: 'a1' }, { bookingId: 'b1', decision: 'accept' }), /no longer open/);
});

await t('an unapproved artisan may decline but not accept', async () => {
    seedDispatchable();
    await dispatch.dispatchRound('b1');
    fake.db._set('artisans/a1', { userType: 'artisan', status: 'pending', verificationStatus: 'pending_review' });
    const e = await rejects(() => jobOffers.respondToJobOffer({ uid: 'a1' }, { bookingId: 'b1', decision: 'accept' }), /verification/);
    assert.strictEqual(e.reason, 'not_eligible');
    await jobOffers.respondToJobOffer({ uid: 'a1' }, { bookingId: 'b1', decision: 'decline' });
});

await t('a customer cancelling during the offer withdraws it', async () => {
    seedDispatchable();
    await dispatch.dispatchRound('b1');
    await dispatch.handleDispatchEvent({ status: 'pending' }, { status: 'cancelled' }, 'b1');
    assert.strictEqual(fake.db._get('job_offers/b1').offerStatus, 'withdrawn');
});

await t('a customer-chosen artisan is OFFERED the job too — no artisanId on creation', async () => {
    fake.db._reset();
    const data = { ...fullBooking(), type: 'emergency', isEmergency: true, artisanId: null, requestedArtisanId: 'a1', calloutFee: 90 };
    fake.db._set('bookings/b9', data);
    await dispatch.onBookingCreated({ params: { bookingId: 'b9' }, data: { data: () => data } });
    const o = fake.db._get('job_offers/b9');
    assert.strictEqual(o.artisanId, 'a1');
    assert.strictEqual(o.prematched, true);
    assert.strictEqual(o.expiresAtMs, null, 'a customer-chosen request waits for that artisan');
    assert.strictEqual(fake.db._get('bookings/b9').artisanId, null);
    assert.strictEqual(fake.db._get('bookings/b9').currentArtisanId, 'a1');
});

await t('a LEGACY booking that names its artisan is converted to an offer, not re-dispatched', async () => {
    // An old cached client (or rules and functions deployed apart) can still
    // write artisanId on a pending booking. It must stay with the customer's
    // chosen artisan — and stop being readable to them until they accept.
    seedDispatchable();
    const data = { ...fullBooking(), artisanId: 'a2' };
    fake.db._set('bookings/b1', data);
    await dispatch.onBookingCreated({ params: { bookingId: 'b1' }, data: { data: () => data } });
    const b = fake.db._get('bookings/b1');
    assert.deepStrictEqual([b.artisanId, b.requestedArtisanId, b.currentArtisanId], [null, 'a2', 'a2']);
    assert.strictEqual(b.dispatchStatus, undefined, 'not handed to open dispatch');
    const o = fake.db._get('job_offers/b1');
    assert.deepStrictEqual([o.artisanId, o.prematched, o.offerStatus], ['a2', true, 'open']);
    for (const k of SENSITIVE) assert.ok(!(k in o), `${k} leaked into the offer`);
    await jobOffers.respondToJobOffer({ uid: 'a2' }, { bookingId: 'b1', decision: 'accept' });
    assert.strictEqual(fake.db._get('bookings/b1').artisanId, 'a2');
});

await t('a booking already answered by the time the trigger runs is left alone', async () => {
    fake.db._reset();
    const data = { ...fullBooking(), artisanId: 'a2' };
    fake.db._set('bookings/b1', { ...data, status: 'accepted' });
    await dispatch.onBookingCreated({ params: { bookingId: 'b1' }, data: { data: () => data } });
    assert.strictEqual(fake.db._get('bookings/b1').artisanId, 'a2');
    assert.strictEqual(fake.db._has('job_offers/b1'), false);
});

await t('an inspection booking keeps the customer\'s phone OFF the booking', async () => {
    fake.db._reset();
    fake.db._set('customers/cust1', { fullName: 'Ama Owusu', phone: '+233241111111' });
    fake.db._set('pricing_quotes/q1', {
        customerId: 'cust1', used: false, expiresAt: new Date(Date.now() + 600000).toISOString(),
        category: 'plumbing', calloutFee: 60, travelFee: 10, inspectionFee: 50, travelEstimated: false,
        lat: BK.lat, lng: BK.lng, artisanId: 'a1',
    });
    const r = await pricing.createInspectionBooking({ uid: 'cust1' }, {
        quoteToken: 'q1', address: '12 Ring Road East, Osu', description: 'Leaking pipe under the sink',
    });
    const b = fake.db._get(`bookings/${r.bookingId}`);
    assert.strictEqual(b.customerPhone, undefined, 'the booking must not carry the phone');
    assert.strictEqual(b.artisanId, null);
    assert.strictEqual(b.requestedArtisanId, 'a1');
    assert.strictEqual(fake.db._get(`bookings/${r.bookingId}/private/contact`).customerPhone, '+233241111111');
});

await t('the artisan screens read offers from job_offers and the phone from private/contact', () => {
    const dash = read('artisan-app/dashboard.html');
    assert.match(dash, /'job_offers',\s*\[\{ field: 'artisanId', op: '==', value: uid \}, \{ field: 'offerStatus', op: '==', value: 'open' \}\]/);
    const jobs = read('artisan-app/jobs.html');
    assert.match(jobs, /'job_offers',/);
    assert.match(jobs, /getDocument\(`bookings\/\$\{j\.id\}\/private`, 'contact'\)/);
    const job = read('artisan-app/job.html');
    assert.match(job, /subscribeToDocument\('job_offers', BOOKING_ID/);
    assert.match(job, /getDocument\(`bookings\/\$\{BOOKING_ID\}\/private`, 'contact'\)/);
    assert.match(read('customer-app/book-emergency.html'), /artisanId: null, requestedArtisanId: artisanId/);
});

console.log('\n── AR-09 · one path to an artisan account; approval needs a verified email ──\n');

const token = (over = {}) => ({ email: 'kwame@example.com', name: 'Kwame Mensah', email_verified: true, ...over });

await t('a first sign-in creates exactly one unapproved artisan profile', async () => {
    fake.db._reset();
    const r = await artisanAccount.ensureArtisanProfile({ uid: 'u1', token: token() });
    assert.deepStrictEqual([r.result, r.verificationStatus, r.emailVerified], ['created', 'draft', true]);
    const a = fake.db._get('artisans/u1');
    assert.deepStrictEqual([a.userType, a.status, a.verificationStatus, a.isAvailable], ['artisan', 'pending', 'draft', false]);
});

await t('repeat and concurrent attempts never duplicate or overwrite the profile', async () => {
    fake.db._reset();
    const rs = await Promise.all([1, 2, 3].map(() => artisanAccount.ensureArtisanProfile({ uid: 'u1', token: token() })));
    assert.strictEqual(rs.filter((r) => r.result === 'created').length, 1);
    fake.db._set('artisans/u1', { ...fake.db._get('artisans/u1'), verificationStatus: 'pending_review', bio: 'kept' });
    const again = await artisanAccount.ensureArtisanProfile({ uid: 'u1', token: token() });
    assert.deepStrictEqual([again.result, again.verificationStatus], ['existing', 'pending_review']);
    assert.strictEqual(fake.db._get('artisans/u1').bio, 'kept');
});

await t('a customer account and an admin account are refused — role isolation', async () => {
    fake.db._reset();
    fake.db._set('customers/u2', { userType: 'customer' });
    const c = await rejects(() => artisanAccount.ensureArtisanProfile({ uid: 'u2', token: token() }), /customer account/);
    assert.strictEqual(c.reason, 'customer_account');
    fake.db._set('admins/u3', { userType: 'admin' });
    const a = await rejects(() => artisanAccount.ensureArtisanProfile({ uid: 'u3', token: token() }), /Administrator/);
    assert.strictEqual(a.reason, 'admin_account');
    assert.strictEqual(fake.db._has('artisans/u2') || fake.db._has('artisans/u3'), false);
    await rejects(() => artisanAccount.ensureArtisanProfile({ uid: 'u4', token: token({ email: '' }) }), /no email/i);
});

await t('an admin cannot approve an artisan whose email is unverified', async () => {
    fake.db._reset(); fake.auth.reset();
    fake.db._set('admins/adm1', { userType: 'admin', status: 'active' });
    fake.db._set('artisans/u1', { userType: 'artisan', name: 'Kwame', verificationStatus: 'pending_review', status: 'pending' });
    fake.db._set('verification_requests/u1', { artisanId: 'u1', status: 'pending_review' });
    fake.auth.setUser('u1', { emailVerified: false });
    await rejects(() => verification.approveArtisan({ uid: 'adm1', token: {} }, { artisanId: 'u1' }), /not verified their email/);
    assert.strictEqual(fake.db._get('artisans/u1').verificationStatus, 'pending_review');
    fake.auth.setUser('u1', { emailVerified: true });
    await verification.approveArtisan({ uid: 'adm1', token: {} }, { artisanId: 'u1' });
    assert.strictEqual(fake.db._get('artisans/u1').verificationStatus, 'approved');
});

await t('login has one sign-up path, and every entry point creates profiles through the server', () => {
    const login = read('artisan-app/login.html');
    for (const gone of ['handleRegister', 'panel-register', 'createUserWithEmailAndPassword', 'switchTab(']) {
        assert.ok(!login.includes(gone), `login.html still has ${gone}`);
    }
    assert.match(login, /href="signup\.html"/);
    assert.match(login, /ensureArtisanAccount\(\)/);
    const signup = read('artisan-app/signup.html');
    assert.match(signup, /ensureArtisanAccount\(\)/);
    assert.ok(!/setDocument\('artisans', user\.uid/.test(signup), 'signup must not create profiles in the browser');
    assert.match(signup, /authService\.signInWithEmail\(email, password\)/);
    assert.match(signup, /sendEmailVerification/);
    const guard = read('artisan-app/js/utils/artisanAuthGuard.js');
    assert.match(guard, /showOverlay\('setup'\)/);
    assert.match(guard, /ensureArtisanAccount\(\)/);
    const ob = read('artisan-app/onboarding.html');
    assert.match(ob, /if \(!\(await ensureVerifiedEmail\(\)\)\) return;/);
});

console.log('\n── AR-11 · support requests are real and handled ──\n');

await t('a request needs a known topic and 20–2000 characters', () => {
    assert.strictEqual(TICK.validateTicket({ subject: 'payment', message: 'My withdrawal has not arrived yet since Monday.' }).ok, true);
    assert.strictEqual(TICK.validateTicket({ subject: 'nonsense', message: 'x'.repeat(30) }).ok, false);
    assert.strictEqual(TICK.validateTicket({ subject: 'payment', message: 'too short' }).ok, false);
    assert.strictEqual(TICK.validateTicket({ subject: 'payment', message: 'x'.repeat(2001) }).ok, false);
    assert.strictEqual(TICK.validateReply('').ok, false);
    assert.strictEqual(TICK.validateReply('Thanks').ok, true);
});

await t('the support page saves the request BEFORE acknowledging it, and promises nothing unstaffed', () => {
    const sp = read('artisan-app/support.html');
    assert.ok(sp.indexOf("addDocument('support_tickets'") < sp.indexOf("title:      'Support request received'"),
        'the acknowledgement must follow a successful write');
    // What the artisan can see — comments explaining the old promise don't count.
    const copy = sp.replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const fake of ['233000000000', 'support@handyhub', 'under 2 hours', 'within 2 hours', '8am–6pm']) {
        assert.ok(!copy.includes(fake), `support.html still says "${fake}"`);
    }
    assert.match(sp, /SUPPORT_CONTACTS/);
    const cfg = read('shared/js/config/supportConfig.js');
    // The email was confirmed by the owner on 2026-10-23; the rest still are not.
    assert.match(cfg, /email:\s+'info\.fidusx101@gmail\.com'/);
    assert.match(cfg, /phone:\s+null/);
    assert.match(cfg, /whatsapp:\s+null/);
});

await t('requests have a home in the admin dashboard', () => {
    const adm = read('admin-dashboard/support.html');
    assert.match(adm, /onSnapshot\(collection\(db, 'support_tickets'\)/);
    assert.match(adm, /authorRole: 'support'/);
    assert.match(adm, /collection\(db, 'customer_notifications'\)/);
    for (const page of ['index.html', 'disputes.html', 'artisans.html']) {
        assert.match(read(`admin-dashboard/${page}`), /href="support\.html"/, `${page} has no Support link`);
    }
});

console.log(`\nprivacy-access: ${passed} passed, ${failed} failed`);
if (failed) { for (const [name, e] of failures) console.log(`\n✗ ${name}\n${e.stack}`); process.exit(1); }
})();
