/**
 * Do the Firestore triggers actually fire — on the NAMED database?
 *
 * This is the question CLAUDE.md §4 exists because of: a trigger that omits
 * `database: FIRESTORE_DB_ID` deploys successfully and then never fires,
 * silently, forever. There has never been a way to check that locally.
 *
 * Every assertion here writes through the Admin SDK and then waits for the REAL
 * function code to react. Nothing is stubbed and no expected output is written
 * by hand — if a trigger is mis-wired, the wait times out and the test fails.
 */
'use strict';

const { createRequire } = require('module');
const path  = require('path');
const req   = createRequire(path.join(__dirname, '..', '..', 'functions', 'package.json'));
const admin = req('firebase-admin');

const PROJECT = 'lamax-4fd82';
const DB_ID   = 'ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
db.settings({ databaseId: DB_ID, ignoreUndefinedProperties: true });

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}${detail ? '   ' + detail : ''}`); }
    else      { failed++; console.log(`  FAIL  ${name}${detail ? '   ' + detail : ''}`); }
}

/** Poll a booking until `pred` holds or we give up. Returns the doc data. */
async function waitFor(id, pred, ms = 15000, label = '') {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < ms) {
        const s = await db.collection('bookings').doc(id).get();
        last = s.exists ? s.data() : null;
        if (last && pred(last)) return last;
        await sleep(500);
    }
    console.log(`      (timed out waiting for ${label || 'condition'}; last status=${last && last.status}, track=${last && last.track})`);
    return last;
}

async function main() {
    const CUST = 'trig_customer';
    const ART  = 'trig_artisan';

    // Unique ids per run. The emulator keeps data between runs, and
    // onDocumentCreated does NOT fire when .set() lands on a document that
    // already exists — so reusing fixed ids makes the second run silently
    // report the create trigger as broken.
    const RUN = Date.now().toString(36);

    await db.collection('customers').doc(CUST).set({
        uid: CUST, userType: 'customer', fullName: 'Trigger Test',
        walletBalance: 1000, escrowBalance: 0, spent: 0, createdAt: now(), updatedAt: now(),
    });
    await db.collection('artisans').doc(ART).set({
        uid: ART, userType: 'artisan', fullName: 'Trigger Artisan',
        verificationStatus: 'approved', status: 'active',
        availableBalance: 0, pendingBalance: 0, totalEarned: 0,
        lat: 5.60, lng: -0.187, isOnline: true, createdAt: now(), updatedAt: now(),
    });

    // ── 1. onBookingCreated stamps `track` on the named database ─────────────
    const emId = `TRIG-EMERGENCY-${RUN}`;
    await db.collection('bookings').doc(emId).set({
        customerId: CUST, artisanId: ART,          // pre-matched: skips dispatch
        serviceType: 'Electrical', status: 'pending',
        type: 'emergency', isEmergency: true,
        address: '1 Test Road', createdAt: now(), updatedAt: now(),
    });
    const em = await waitFor(emId, b => !!b.track, 15000, 'track stamp (emergency)');
    ok('onBookingCreated FIRES on the named database', !!(em && em.track),
       em && em.track ? `track=${em.track}` : 'no track stamped — trigger did not run');
    ok('emergency booking is stamped track=emergency', em && em.track === 'emergency',
       `got ${em && em.track}`);

    // ── 2. a standard booking gets the standard track ────────────────────────
    const stId = `TRIG-STANDARD-${RUN}`;
    await db.collection('bookings').doc(stId).set({
        customerId: CUST, artisanId: ART,
        serviceType: 'Plumbing', status: 'pending', type: 'standard',
        address: '2 Test Road', createdAt: now(), updatedAt: now(),
    });
    const st = await waitFor(stId, b => !!b.track, 15000, 'track stamp (standard)');
    ok('standard booking is stamped track=standard', st && st.track === 'standard',
       `got ${st && st.track}`);

    // ── 3. onBookingStatusChanged reacts to a transition ─────────────────────
    // accepted -> notifications are written by the status trigger. We assert on
    // the notification because it is the trigger's own observable output.
    await db.collection('bookings').doc(stId).update({
        status: 'accepted', acceptedAt: now(), updatedAt: now(),
    });
    let notifs = [];
    for (let i = 0; i < 30; i++) {
        // functions/notifications.js writes to `customer_notifications`,
        // keyed on `receiverId` — not a generic `notifications/userId`.
        const q = await db.collection('customer_notifications')
            .where('receiverId', '==', CUST).get().catch(() => null);
        notifs = (q ? q.docs.map(d => d.data()) : [])
            .filter(n => n.metadata && n.metadata.bookingId === stId);
        if (notifs.length) break;
        await sleep(500);
    }
    ok('onBookingStatusChanged FIRES and writes a notification',
       notifs.length > 0, `${notifs.length} notification(s) for the customer`);

    const withBooking = notifs.filter(n => n.metadata && n.metadata.bookingId);
    ok('notification carries metadata.bookingId (deep-link input)',
       withBooking.length > 0,
       withBooking.length ? `bookingId=${withBooking[0].metadata.bookingId}` : 'none carried an id');

    // ── 4. completion path: does the trigger release escrow? ─────────────────
    // No escrow exists for this booking (no money ever held), so the trigger
    // should complete WITHOUT inventing a release. Asserting the honest
    // behaviour: booking reaches completed and nothing fabricates a payment.
    await db.collection('bookings').doc(stId).update({
        status: 'en_route', enRouteAt: now(), updatedAt: now() });
    await sleep(800);
    await db.collection('bookings').doc(stId).update({
        status: 'in_progress', arrivedAt: now(), updatedAt: now() });
    await sleep(800);
    await db.collection('bookings').doc(stId).update({
        status: 'awaiting', jobDoneAt: now(), updatedAt: now() });
    await sleep(800);
    await db.collection('bookings').doc(stId).update({
        status: 'completed', completedAt: now(), updatedAt: now() });

    const done = await waitFor(stId, b => b.status === 'completed', 10000, 'completed');
    ok('booking reaches completed', done && done.status === 'completed');

    await sleep(4000);
    const art = (await db.collection('artisans').doc(ART).get()).data();
    ok('no escrow existed, so no earnings were fabricated',
       Number(art.totalEarned || 0) === 0,
       `artisan totalEarned=${art.totalEarned || 0}`);

    const jobsDone = Number(art.jobsCompleted || 0);
    ok('artisan jobsCompleted incremented by the trigger', jobsDone >= 1,
       `jobsCompleted=${jobsDone}`);

    console.log(`\ntriggers: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TRIGGER TEST CRASHED:', e); process.exit(1); });
