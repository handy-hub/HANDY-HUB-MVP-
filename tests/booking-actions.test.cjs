/**
 * booking-actions.test.cjs
 *
 * Guards the single booking transition layer.
 *
 * The bug class this exists to prevent is not "the write failed" — it is "three
 * screens disagreed about the lifecycle and two of them were wrong". Before
 * this layer, artisan jobs.html sent a raw status write for an inspection-track
 * cancel that firestore.rules rejects, so that button could never work; only
 * bookings.html routed it to the Cloud Function. These tests pin the table
 * against the rules, and pin the behaviour that matters most in a two-sided
 * marketplace: what happens when the booking moved while you were looking at it.
 */
'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const ROOT = path.join(__dirname, '..');

function loadActions() {
    const src = fs.readFileSync(
        path.join(ROOT, 'shared', 'js', 'domain', 'bookingActions.js'), 'utf8');
    const body = src
        .replace(/^\s*export\s+async\s+function\s+/gm, 'async function ')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
    // eslint-disable-next-line no-new-func
    return new Function(`${body}\nreturn { performBookingAction, ACTION, RESULT };`)();
}

const { performBookingAction, ACTION, RESULT } = loadActions();

// ── Test doubles ─────────────────────────────────────────────────────────────
const CUST = 'cust_1';
const ART  = 'art_1';

function makeDb(booking, { failWrite = null, mutateOnRead = null } = {}) {
    let reads = 0;
    const writes = [];
    return {
        writes,
        get reads() { return reads; },
        async getDocument(col, id) {
            reads++;
            const b = mutateOnRead ? mutateOnRead(booking, reads) : booking;
            return b ? { exists: true, data: { ...b } } : { exists: false };
        },
        async updateDocument(col, id, payload) {
            if (failWrite) throw failWrite;
            writes.push(payload);
            Object.assign(booking, payload);
            return true;
        },
    };
}

const base = (over = {}) => ({
    customerId: CUST, artisanId: ART, status: 'pending',
    serviceType: 'Plumbing', ...over,
});

let passed = 0, failed = 0;
async function t(name, fn) {
    try { await fn(); passed++; }
    catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

(async () => {

// ── The happy paths, one per transition ──────────────────────────────────────
await t('accept: pending → accepted, with only the keys the rules allow', async () => {
    const b = base();
    const db = makeDb(b);
    const r = await performBookingAction(ACTION.ACCEPT, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.booking.status, 'accepted');
    assert.deepStrictEqual(
        Object.keys(db.writes[0]).sort(), ['acceptedAt', 'status', 'updatedAt']);
});

await t('accept does NOT write artisanName — the server stamps identity', async () => {
    const db = makeDb(base());
    await performBookingAction(ACTION.ACCEPT, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db });
    assert.ok(!('artisanName' in db.writes[0]),
        'a client-asserted artisan name is spoofable and incomplete');
});

await t('decline: pending → rejected', async () => {
    const db = makeDb(base());
    const r = await performBookingAction(ACTION.DECLINE, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db });
    assert.strictEqual(r.booking.status, 'rejected');
});

await t('job done: in_progress → awaiting', async () => {
    const db = makeDb(base({ status: 'in_progress' }));
    const r = await performBookingAction(ACTION.JOB_DONE, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db });
    assert.strictEqual(r.booking.status, 'awaiting');
    assert.ok('jobDoneAt' in db.writes[0]);
});

await t('confirm complete: awaiting → completed (customer)', async () => {
    const db = makeDb(base({ status: 'awaiting' }));
    const r = await performBookingAction(ACTION.CONFIRM_COMPLETE, {
        bookingId: 'B1', actor: 'customer', uid: CUST, databaseService: db });
    assert.strictEqual(r.booking.status, 'completed');
    assert.deepStrictEqual(
        Object.keys(db.writes[0]).sort(), ['completedAt', 'status', 'updatedAt']);
});

// ── en_route: the fork that the old code got wrong ───────────────────────────
await t('en_route from accepted REQUIRES an approved quote', async () => {
    const db = makeDb(base({ status: 'accepted', quoteApproved: false }));
    const r = await performBookingAction(ACTION.EN_ROUTE, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, RESULT.NOT_ALLOWED);
    assert.match(r.message, /quote/i);
    assert.strictEqual(db.writes.length, 0, 'must not write a rejected transition');
});

await t('en_route from accepted succeeds once the quote is approved', async () => {
    const db = makeDb(base({ status: 'accepted', quoteApproved: true }));
    const r = await performBookingAction(ACTION.EN_ROUTE, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db });
    assert.strictEqual(r.ok, true);
});

await t('en_route from inspection_scheduled needs NO quote — artisan travels first', async () => {
    const db = makeDb(base({ status: 'inspection_scheduled', track: 'inspection' }));
    const r = await performBookingAction(ACTION.EN_ROUTE, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db });
    assert.strictEqual(r.ok, true, 'the callout fee is already escrowed at this point');
});

// ── Authorization ────────────────────────────────────────────────────────────
await t('a stranger cannot act on someone else\'s booking', async () => {
    const db = makeDb(base());
    const r = await performBookingAction(ACTION.ACCEPT, {
        bookingId: 'B1', actor: 'artisan', uid: 'someone_else', databaseService: db });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, RESULT.NOT_ALLOWED);
    assert.strictEqual(db.writes.length, 0);
});

await t('the customer cannot accept their own booking', async () => {
    const db = makeDb(base());
    const r = await performBookingAction(ACTION.ACCEPT, {
        bookingId: 'B1', actor: 'customer', uid: CUST, databaseService: db });
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /other party/i);
});

await t('the artisan cannot confirm completion on the customer\'s behalf', async () => {
    const db = makeDb(base({ status: 'awaiting' }));
    const r = await performBookingAction(ACTION.CONFIRM_COMPLETE, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(db.writes.length, 0);
});

await t('an artisan may not cancel a pending booking, but a customer may', async () => {
    const a = makeDb(base({ status: 'pending' }));
    const ra = await performBookingAction(ACTION.CANCEL, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: a });
    assert.strictEqual(ra.ok, false, 'artisans decline pending work, they do not cancel it');

    const c = makeDb(base({ status: 'pending' }));
    const rc = await performBookingAction(ACTION.CANCEL, {
        bookingId: 'B1', actor: 'customer', uid: CUST, databaseService: c });
    assert.strictEqual(rc.ok, true);
});

// ── Invalid and duplicate transitions ────────────────────────────────────────
await t('duplicate accept is refused and explained, not retried', async () => {
    const db = makeDb(base({ status: 'accepted' }));
    const r = await performBookingAction(ACTION.ACCEPT, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, RESULT.CONFLICT);
    assert.match(r.message, /no longer available/i);
});

await t('acting on a cancelled booking says it was cancelled', async () => {
    const db = makeDb(base({ status: 'cancelled' }));
    const r = await performBookingAction(ACTION.ACCEPT, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db });
    assert.match(r.message, /cancelled/i);
});

await t('the artisan is told plainly when they already declined', async () => {
    const db = makeDb(base({ status: 'rejected' }));
    const r = await performBookingAction(ACTION.ACCEPT, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db });
    assert.match(r.message, /already declined/i);
});

await t('the customer is told the pro declined — not that they declined', async () => {
    const db = makeDb(base({ status: 'rejected' }));
    const r = await performBookingAction(ACTION.CANCEL, {
        bookingId: 'B1', actor: 'customer', uid: CUST, databaseService: db });
    assert.match(r.message, /professional declined/i);
});

await t('skipping a stage (pending → awaiting) is refused', async () => {
    const db = makeDb(base({ status: 'pending' }));
    const r = await performBookingAction(ACTION.JOB_DONE, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(db.writes.length, 0);
});

await t('a missing booking is reported as missing, not as a failure', async () => {
    const db = makeDb(null);
    const r = await performBookingAction(ACTION.ACCEPT, {
        bookingId: 'GONE', actor: 'artisan', uid: ART, databaseService: db });
    assert.strictEqual(r.code, RESULT.NOT_FOUND);
});

// ── The two-surfaces race, which is the real-world case ──────────────────────
await t('when the other surface wins the race, the loser gets a CONFLICT with fresh state', async () => {
    // The booking reads as pending (the card is stale), but the write is
    // rejected by rules because another surface accepted first; the re-read
    // then shows the truth.
    const b = base({ status: 'pending' });
    const db = makeDb(b, {
        failWrite: Object.assign(new Error('PERMISSION_DENIED: insufficient permissions'), {}),
        mutateOnRead: (bk, n) => (n === 1 ? bk : { ...bk, status: 'accepted' }),
    });
    const r = await performBookingAction(ACTION.ACCEPT, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, RESULT.CONFLICT, 'a lost race is a conflict, not a generic failure');
    assert.strictEqual(r.booking.status, 'accepted', 'the caller gets the REAL state back');
});

await t('a genuine write failure stays a failure and changes nothing', async () => {
    const db = makeDb(base(), { failWrite: new Error('network unavailable') });
    const r = await performBookingAction(ACTION.ACCEPT, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db });
    assert.strictEqual(r.code, RESULT.FAILED);
    assert.match(r.message, /connection/i);
});

// ── Inspection-track cancel MUST be server-owned ─────────────────────────────
await t('inspection-track cancel goes to the Cloud Function, never a raw write', async () => {
    const db = makeDb(base({ status: 'accepted', track: 'inspection' }));
    let called = null;
    const r = await performBookingAction(ACTION.CANCEL, {
        bookingId: 'B1', actor: 'customer', uid: CUST, databaseService: db,
        reason: 'changed my mind',
        pricingService: { cancelInspectionBooking: async (id, why) => { called = { id, why }; } },
    });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(called, { id: 'B1', why: 'changed my mind' });
    assert.strictEqual(db.writes.length, 0,
        'a raw status write here is rejected by rules and skips callout settlement');
});

await t('a non-inspection cancel writes directly and carries the reason', async () => {
    const db = makeDb(base({ status: 'accepted' }));
    const r = await performBookingAction(ACTION.CANCEL, {
        bookingId: 'B1', actor: 'customer', uid: CUST, databaseService: db, reason: 'no longer needed' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(db.writes[0].cancellationReason, 'no longer needed');
});

await t('inspection cancel with no pricing service fails loudly rather than writing raw', async () => {
    const db = makeDb(base({ status: 'accepted', track: 'inspection' }));
    const r = await performBookingAction(ACTION.CANCEL, {
        bookingId: 'B1', actor: 'customer', uid: CUST, databaseService: db });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(db.writes.length, 0);
});

// ── The caller must always be able to route from the result ──────────────────
await t('every successful action returns the authoritative booking', async () => {
    const db = makeDb(base({ status: 'en_route' }));
    const r = await performBookingAction(ACTION.START, {
        bookingId: 'B1', actor: 'artisan', uid: ART, databaseService: db });
    assert.ok(r.booking && r.booking.status === 'in_progress');
    assert.strictEqual(r.from, 'en_route');
    assert.strictEqual(r.to, 'in_progress');
});

console.log(`booking-actions: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
})();
