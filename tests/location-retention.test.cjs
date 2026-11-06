'use strict';
/**
 * tests/location-retention.test.cjs — an artisan keeps a customer's exact
 * location for 14 days after the booking closes, then loses it (decision Q6,
 * 2026-11-06; Phase 0 PS-02).
 *
 * The artisan reads the booking document, and rules cannot hide single fields,
 * so the location moves: address, lat, lng and notes go to
 * bookings/{id}/private/location (customer and admins only — the rules side is
 * in tests/firestore-rules.test.mjs) and leave the booking. The job record
 * stays. Appointment reminders no longer carry the address.
 *
 * The REAL functions/locationRetention.js, bookings.js, pricing.js and
 * contactPrivacy.js run against an in-memory Firestore.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const fake = require('./support/fake-firebase.cjs').install();
const ROOT = path.join(__dirname, '..');
const FN   = path.join(ROOT, 'functions');
const retention  = require(path.join(FN, 'locationRetention.js'));
const bookings   = require(path.join(FN, 'bookings.js'));
const pricing    = require(path.join(FN, 'pricing.js'));
const contactMig = require(path.join(FN, 'contactPrivacy.js'));
const { getFirestore } = require('firebase-admin/firestore');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

const DAY = 24 * 3600_000;
const BK = 'bk_loc_1';
const LOC = { address: '14 Lagos Avenue, East Legon', lat: 5.636612, lng: -0.161834, notes: 'Cream gate opposite the Shell station' };
const RECORD = { customerId: 'cust_loc', artisanId: 'art_loc', serviceType: 'Plumbing', description: 'Leaking pipe', jobQuote: 300, track: 'inspection' };

function seedBooking(over = {}) {
    fake.db._reset();
    fake.messaging._reset();
    fake.db._set(`bookings/${BK}`, { ...RECORD, ...LOC, status: 'completed', completedAt: new Date().toISOString(), ...over });
}
const bk   = () => fake.db._get(`bookings/${BK}`);
const priv = () => fake.db._get(`bookings/${BK}/private/location`);

(async () => {
console.log('\n── The clock starts when the booking closes ──\n');

await t('closing a booking an artisan worked on stamps 14 days', async () => {
    for (const status of ['completed', 'cancelled', 'resolved']) {
        seedBooking({ status });
        const now = Date.now();
        assert.strictEqual(await retention.stampRetention(BK, { status: 'in_progress' }, bk(), now), true, status);
        assert.strictEqual(bk().locationRetainUntilMs, now + 14 * DAY, status);
    }
});
await t('nothing to stamp: still open, already closed, no artisan, or no location', async () => {
    seedBooking({ status: 'in_progress' });
    assert.strictEqual(await retention.stampRetention(BK, { status: 'en_route' }, bk()), false, 'open');
    seedBooking();
    assert.strictEqual(await retention.stampRetention(BK, { status: 'cancelled' }, bk()), false, 'closed before');
    seedBooking({ artisanId: null });
    assert.strictEqual(await retention.stampRetention(BK, { status: 'pending' }, bk()), false, 'no artisan ever saw it');
    seedBooking({ address: '', lat: null, lng: null, notes: '' });
    assert.strictEqual(await retention.stampRetention(BK, { status: 'in_progress' }, bk()), false, 'no location');
    assert.strictEqual(bk().locationRetainUntilMs, undefined);
});
await t('the real status trigger stamps it on completion', async () => {
    seedBooking({ status: 'awaiting', completedAt: undefined });
    const before = { ...bk() };
    const after  = { ...bk(), status: 'completed' };
    fake.db._set(`bookings/${BK}`, after);
    await bookings.onBookingStatusChanged({
        params: { bookingId: BK },
        data: { before: { data: () => before }, after: { data: () => after } },
    });
    const until = bk().locationRetainUntilMs;
    assert.ok(until > Date.now() + 13.9 * DAY && until <= Date.now() + 14 * DAY, String(until));
});

console.log('\n── After 14 days the location leaves the booking ──\n');

await t('before the 14 days are up, nothing moves', async () => {
    seedBooking({ locationRetainUntilMs: Date.now() + DAY });
    const r = await retention.moveExpiredLocations();
    assert.strictEqual(r.moved, 0);
    assert.strictEqual(bk().address, LOC.address);
    assert.strictEqual(priv(), undefined);
});
await t('then address, GPS and notes move to the customer\'s private record; the job record stays', async () => {
    seedBooking({ locationRetainUntilMs: Date.now() - 1000 });
    const r = await retention.moveExpiredLocations();
    assert.strictEqual(r.moved, 1);
    const b = bk();
    for (const f of ['address', 'lat', 'lng', 'notes']) assert.strictEqual(b[f], undefined, `${f} left the booking`);
    assert.ok(b.locationRemovedAt, 'when it was removed');
    assert.strictEqual(b.locationRetainUntilMs, undefined, 'the clock is done');
    for (const f of ['serviceType', 'description', 'jobQuote', 'customerId', 'artisanId', 'status']) {
        assert.deepStrictEqual(b[f], { ...RECORD, status: 'completed' }[f], `${f} kept`);
    }
    const p = priv();
    assert.strictEqual(p.address, LOC.address);
    assert.strictEqual(p.lat, LOC.lat);
    assert.strictEqual(p.lng, LOC.lng);
    assert.strictEqual(p.notes, LOC.notes);
    assert.strictEqual(p.customerId, RECORD.customerId);
});
await t('moving twice changes nothing; an existing private copy is never overwritten', async () => {
    seedBooking({ locationRetainUntilMs: Date.now() - 1000 });
    fake.db._set(`bookings/${BK}/private/location`, { address: 'Customer-corrected address' });
    await retention.moveExpiredLocations();
    const first = priv();
    assert.strictEqual(first.address, 'Customer-corrected address');
    assert.strictEqual(first.lat, LOC.lat, 'gaps are filled');
    const again = await retention.moveExpiredLocations();
    assert.strictEqual(again.moved, 0);
    assert.deepStrictEqual(priv(), first);
});
await t('a booking reopened since it was stamped keeps its location, and its clock is cleared', async () => {
    seedBooking({ status: 'disputed', locationRetainUntilMs: Date.now() - 1000 });
    const r = await retention.moveExpiredLocations();
    assert.strictEqual(r.reopened, 1);
    assert.strictEqual(bk().address, LOC.address);
    assert.strictEqual(bk().locationRetainUntilMs, undefined);
});
await t('the hourly sweep runs it (checkBookingTimeouts)', async () => {
    seedBooking({ locationRetainUntilMs: Date.now() - 1000 });
    await pricing.checkBookingTimeouts();
    assert.strictEqual(bk().address, undefined);
    assert.ok(priv());
});

console.log('\n── Bookings closed before this, and old reminders ──\n');

await t('the privacy migration reports them in a dry run and writes nothing', async () => {
    seedBooking({ completedAt: new Date(Date.now() - 30 * DAY).toISOString() });
    fake.db._set('customer_notifications/n1', { receiverId: 'art_loc', title: 'Appointment coming up',
        message: 'You committed to a Plumbing visit for today. Address: 14 Lagos Avenue, East Legon' });
    const r = await contactMig.migrateContactPrivacy({ mode: 'dry-run' });
    assert.strictEqual(r.bookingLocations.closedWithLocation, 1);
    assert.strictEqual(r.bookingLocations.dueNow, 1);
    assert.strictEqual(r.bookingLocations.reminders, 1);
    assert.deepStrictEqual(r.bookingLocations.ids, [BK]);
    assert.ok(!JSON.stringify(r).includes('Lagos'), 'the report carries ids and counts, never the address');
    assert.strictEqual(bk().locationRetainUntilMs, undefined);
    assert.match(fake.db._get('customer_notifications/n1').message, /Address:/);
});
await t('run for real, it stamps closed + 14 days and cleans the reminder; the sweep then moves it', async () => {
    const closed = Date.now() - 30 * DAY;
    seedBooking({ completedAt: new Date(closed).toISOString() });
    fake.db._set('customer_notifications/n1', { receiverId: 'art_loc', title: 'Appointment coming up',
        message: 'You committed to a Plumbing visit for today. Address: 14 Lagos Avenue, East Legon' });
    await contactMig.migrateContactPrivacy({ mode: 'copy' });
    assert.strictEqual(bk().locationRetainUntilMs, closed + 14 * DAY);
    assert.strictEqual(fake.db._get('customer_notifications/n1').message, 'You committed to a Plumbing visit for today.');
    await retention.moveExpiredLocations();
    assert.strictEqual(bk().address, undefined);
});

await t('appointment reminders no longer carry the address', async () => {
    fake.db._reset();
    fake.db._set('bookings/bk_rem', { ...RECORD, ...LOC, status: 'inspection_scheduled', artisanId: 'art_loc',
        scheduledForMs: Date.now() + 3600_000, scheduleWindowMins: 120 });
    await pricing.sendAppointmentReminders(getFirestore().collection('bookings'));
    const notes = fake.db._keys('customer_notifications/').map((k) => fake.db._get(k)).filter((n) => n.receiverId === 'art_loc');
    assert.strictEqual(notes.length, 1);
    assert.ok(!notes[0].message.includes('Lagos'), notes[0].message);
    assert.match(notes[0].message, /Open the job for the address\.$/);
});

console.log('\n── What the artisan and admins see ──\n');

await t('the artisan\'s job record says the address was removed, and why; nothing is guessed', () => {
    const src = fs.readFileSync(path.join(ROOT, 'shared', 'js', 'domain', 'bookingTruth.js'), 'utf8')
        .replace(/^\s*import\s[^\n]*\n/gm, '')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
    // eslint-disable-next-line no-new-func
    const { resolveJobBrief } = new Function(`${src}\nreturn { resolveJobBrief };`)();
    const brief = resolveJobBrief({ ...RECORD, status: 'completed', locationRemovedAt: '2026-11-20T00:00:00.000Z' });
    assert.strictEqual(brief.location.precision, 'removed');
    assert.strictEqual(brief.location.address, null);
    assert.strictEqual(brief.location.mapUrl, null);
    assert.match(brief.location.note, /removed 14 days after the job ended/);
    // Phase 2: the job screen's drawing lives in artisan-app/js/jobScreen.js.
    const job = fs.readFileSync(path.join(ROOT, 'artisan-app', 'js', 'jobScreen.js'), 'utf8');
    assert.match(job, /loc\.precision === 'removed' \? `<p class="fx-body fx-ink-3">\$\{esc\(loc\.note\)\}<\/p>`/);
});
await t('admins still see it, from the private record', () => {
    const admin = fs.readFileSync(path.join(ROOT, 'admin-dashboard', 'bookings.html'), 'utf8');
    assert.match(admin, /if\(b\.locationRemovedAt\) getDoc\(doc\(db,'bookings',b\.id,'private','location'\)\)/);
});

console.log(`\nlocation-retention: ${passed} passed, ${failed} failed`);
if (failed) { for (const [name, e] of failures) console.log(`\n✗ ${name}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
