/**
 * The money invariant, against the REAL trigger code.
 *
 * Two things are proven here and neither can be proven by a unit test:
 *
 *  1. Completing a booking releases its held escrow to the artisan — the server
 *     does it, not the client. This is why the client-side releaseEscrow() calls
 *     were deleted; if the trigger did NOT do this, that deletion would have
 *     stopped artisans being paid, and nothing short of running the trigger
 *     would have revealed it.
 *
 *  2. Completing TWICE does not pay twice. `releaseEscrow` re-reads the escrow
 *     inside runTransaction() and refuses anything not still `held`. Duplicate
 *     trigger executions are a fact of life on Cloud Functions (at-least-once
 *     delivery), so this is a load-bearing property, not a nicety.
 */
'use strict';

require('../support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const { createRequire } = require('module');
const path  = require('path');
const req   = createRequire(path.join(__dirname, '..', '..', 'functions', 'package.json'));
const admin = req('firebase-admin');

const PROJECT = 'lamax-4fd82';
const DB_ID   = 'ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
db.settings({ databaseId: DB_ID, ignoreUndefinedProperties: true });

const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const ok = (n, c, d = '') => {
    if (c) { passed++; console.log(`  PASS  ${n}${d ? '   ' + d : ''}`); }
    else   { failed++; console.log(`  FAIL  ${n}${d ? '   ' + d : ''}`); }
};

const RUN  = Date.now().toString(36);
const CUST = `esc_cust_${RUN}`;
const ART  = `esc_art_${RUN}`;
const BK   = `ESC-BOOKING-${RUN}`;
const ESC  = `ESC-RECORD-${RUN}`;

const AMOUNT   = 400;
const COMM_PCT = 0.15;
const COMMISSION    = AMOUNT * COMM_PCT;      // 60
const ARTISAN_SHARE = AMOUNT - COMMISSION;    // 340

async function main() {
    // A funded wallet. The first version of this test seeded walletBalance: 0
    // and pre-created the escrow by hand — so on `accepted` the REAL trigger
    // tried to hold funds, found none, and system-cancelled the booking with a
    // refund. That was the code behaving correctly against a bad fixture, and
    // it is exactly why the escrow below is now created by the hold path itself
    // rather than written by this test.
    await db.collection('customers').doc(CUST).set({
        uid: CUST, userType: 'customer', fullName: 'Escrow Customer',
        walletBalance: 1000, escrowBalance: 0, spent: 0, createdAt: now(), updatedAt: now(),
    });
    await db.collection('artisans').doc(ART).set({
        uid: ART, userType: 'artisan', fullName: 'Escrow Artisan',
        verificationStatus: 'approved', status: 'active',
        availableBalance: 0, pendingBalance: 0, totalEarned: 0,
        createdAt: now(), updatedAt: now(),
    });

    await db.collection('bookings').doc(BK).set({
        customerId: CUST, artisanId: ART, serviceType: 'Plumbing',
        status: 'pending', type: 'standard', track: 'standard',
        price: AMOUNT, total: AMOUNT,
        address: '5 Escrow Street', createdAt: now(), updatedAt: now(),
    });

    await sleep(2500);   // let onBookingCreated settle

    // Walk the booking to `awaiting` the way the artisan would.
    for (const [st, stamp] of [['accepted','acceptedAt'], ['en_route','enRouteAt'],
                               ['in_progress','arrivedAt'], ['awaiting','jobDoneAt']]) {
        // Acceptance assigns the artisan, as respondToJobOffer does (AR-06):
        // onBookingCreated turned the pre-set artisanId into an offer.
        const assign = st === 'accepted' ? { artisanId: ART } : {};
        await db.collection('bookings').doc(BK).update({ status: st, [stamp]: now(), updatedAt: now(), ...assign });
        await sleep(700);
    }

    const heldQ = await db.collection('escrow').where('bookingId', '==', BK).get();
    const held  = heldQ.empty ? null : heldQ.docs[0].data();
    ok('acceptance HELD escrow through the real server path',
       !!(held && held.status === 'held'), `escrow status=${held && held.status}`);

    const beforeArt = (await db.collection('artisans').doc(ART).get()).data();
    ok('artisan has not been paid before completion',
       Number(beforeArt.availableBalance || 0) === 0,
       `availableBalance=${beforeArt.availableBalance}`);

    // ── THE completion ───────────────────────────────────────────────────────
    await db.collection('bookings').doc(BK).update({
        status: 'completed', completedAt: now(), updatedAt: now(),
    });

    let esc = null;
    for (let i = 0; i < 40; i++) {
        const q = await db.collection('escrow').where('bookingId', '==', BK).get();
        esc = q.empty ? null : q.docs[0].data();
        if (esc && esc.status === 'released') break;
        await sleep(500);
    }
    ok('completion RELEASES the held escrow (server-side, no client call)',
       esc && esc.status === 'released', `escrow status=${esc && esc.status}`);

    await sleep(2500);
    const art = (await db.collection('artisans').doc(ART).get()).data();
    ok('artisan credited exactly the artisan share',
       Number(art.availableBalance || 0) === ARTISAN_SHARE,
       `availableBalance=${art.availableBalance} (expected ${ARTISAN_SHARE})`);
    ok('artisan totalEarned matches the share',
       Number(art.totalEarned || 0) === ARTISAN_SHARE,
       `totalEarned=${art.totalEarned}`);

    const cust = (await db.collection('customers').doc(CUST).get()).data();
    ok('customer escrowBalance drawn down to zero',
       Number(cust.escrowBalance || 0) === 0, `escrowBalance=${cust.escrowBalance}`);

    // ── IDEMPOTENCY: complete again, and again ──────────────────────────────
    // At-least-once delivery means the trigger genuinely can run twice.
    await db.collection('bookings').doc(BK).update({
        status: 'completed', completedAt: now(), updatedAt: now(), _forceRetrigger: 1,
    });
    await sleep(3000);
    await db.collection('bookings').doc(BK).update({
        status: 'completed', completedAt: now(), updatedAt: now(), _forceRetrigger: 2,
    });
    await sleep(4000);

    const art2 = (await db.collection('artisans').doc(ART).get()).data();
    ok('DOUBLE completion does not pay twice',
       Number(art2.availableBalance || 0) === ARTISAN_SHARE,
       `availableBalance=${art2.availableBalance} (must stay ${ARTISAN_SHARE})`);

    const q2 = await db.collection('escrow').where('bookingId', '==', BK).get();
    const esc2 = q2.empty ? null : q2.docs[0].data();
    ok('escrow stays released, not re-released',
       esc2 && esc2.status === 'released', `status=${esc2 && esc2.status}`);

    const comms = await db.collection('commissions').where('bookingId', '==', BK).get();
    ok('exactly ONE commission record for this booking',
       comms.size === 1, `${comms.size} commission record(s)`);

    const txns = await db.collection('artisans').doc(ART).collection('transactions').get();
    const earnings = txns.docs.map(d => d.data()).filter(t => t.type === 'earning');
    ok('exactly ONE earning transaction for the artisan',
       earnings.length === 1, `${earnings.length} earning transaction(s)`);

    console.log(`\nescrow-lifecycle: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('ESCROW TEST CRASHED:', e); process.exit(1); });
