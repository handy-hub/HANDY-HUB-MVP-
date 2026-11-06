/**
 * Firestore security rules — wallet tamper-resistance proof.
 *
 * WHY THIS EXISTS
 * Editing a wallet balance in the Firebase Console works, because the Console
 * authenticates as the project OWNER and admin credentials bypass rules by
 * design. That is not a vulnerability. The question that matters is whether a
 * CUSTOMER — someone holding nothing but their own login — can do the same from
 * the app, a script, or a raw REST call.
 *
 * These tests answer that question with a real rules engine rather than by
 * reading the rules and hoping. They run the actual firestore.rules file against
 * the Firestore emulator using genuine authenticated client contexts.
 *
 * Run:  npm run test:rules
 */

import './support/no-production.cjs';   // must stay the first statement (npm run lint:tests)
import {
    initializeTestEnvironment,
    assertFails,
    assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { setDoc, updateDoc, doc, getDoc, addDoc, collection, deleteDoc } from 'firebase/firestore';

const PROJECT_ID = 'lamax-rules-test';
const VICTIM  = 'customer_victim';
const ATTACKER = 'customer_attacker';

let testEnv;
let passed = 0, failed = 0;

async function it(name, fn) {
    try {
        await fn();
        console.log(`  PASS  ${name}`);
        passed++;
    } catch (err) {
        console.log(`  FAIL  ${name}`);
        console.log(`        ${err.message.split('\n')[0]}`);
        failed++;
    }
}

testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
        host: '127.0.0.1',
        port: 8080,
    },
});

/** Seed as admin (rules bypassed) — this is the "Console" equivalent. */
async function seed() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        for (const uid of [VICTIM, ATTACKER]) {
            await setDoc(doc(db, 'customers', uid), {
                name: 'Test Customer',
                email: `${uid}@example.com`,
                userType: 'customer',
                status: 'active',
                bookings: 0,
                spent: 0,
                walletBalance: 100,
                escrowBalance: 0,
            });
        }
    });
}

console.log('\nFIRESTORE RULES — wallet tamper resistance\n');
await testEnv.clearFirestore();
await seed();

const victimDb   = testEnv.authenticatedContext(VICTIM).firestore();
const attackerDb = testEnv.authenticatedContext(ATTACKER).firestore();
const anonDb     = testEnv.unauthenticatedContext().firestore();

console.log('A customer editing their OWN wallet');

await it('cannot raise their own walletBalance', async () => {
    await assertFails(updateDoc(doc(victimDb, 'customers', VICTIM), { walletBalance: 999999 }));
});

await it('cannot nudge walletBalance by even 1', async () => {
    await assertFails(updateDoc(doc(victimDb, 'customers', VICTIM), { walletBalance: 101 }));
});

await it('cannot change escrowBalance', async () => {
    await assertFails(updateDoc(doc(victimDb, 'customers', VICTIM), { escrowBalance: 5000 }));
});

await it('cannot change spent', async () => {
    // Must differ from the seeded value: writing an identical value produces an
    // empty diff, which hasOnly() trivially allows. That is a no-op write, not a
    // rule bypass — but it will silently "pass" a careless test.
    await assertFails(updateDoc(doc(victimDb, 'customers', VICTIM), { spent: 99999 }));
});

await it('cannot smuggle walletBalance alongside a legitimate field', async () => {
    // The classic bypass attempt: hide the money field in a valid-looking update.
    await assertFails(updateDoc(doc(victimDb, 'customers', VICTIM), {
        name: 'New Name',
        walletBalance: 50000,
    }));
});

await it('CAN still update genuinely safe profile fields', async () => {
    await assertSucceeds(updateDoc(doc(victimDb, 'customers', VICTIM), { name: 'Legit Name' }));
});

console.log('\nA customer attacking ANOTHER customer');

await it('cannot write another customer wallet', async () => {
    await assertFails(updateDoc(doc(attackerDb, 'customers', VICTIM), { walletBalance: 999999 }));
});

await it('cannot read another customer document', async () => {
    await assertFails(getDoc(doc(attackerDb, 'customers', VICTIM)));
});

console.log('\nForging the financial ledger');

await it('cannot fabricate a successful top-up row', async () => {
    await assertFails(addDoc(collection(victimDb, 'customers', VICTIM, 'transactions'), {
        type: 'topup', amount: 10000, status: 'successful',
    }));
});

await it('cannot write a topupIntent (the credit authority)', async () => {
    await assertFails(setDoc(doc(victimDb, 'topupIntents', 'FORGED-REF-0001'), {
        uid: VICTIM, amountPesewas: 5000000, status: 'successful', credited: true,
    }));
});

await it('cannot mark an existing intent as credited', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'topupIntents', 'REAL-REF-0001'), {
            uid: VICTIM, amountPesewas: 1000, status: 'pending', credited: false,
        });
    });
    await assertFails(updateDoc(doc(victimDb, 'topupIntents', 'REAL-REF-0001'), {
        status: 'successful', credited: true,
    }));
});

await it('cannot write a webhookLock to fake idempotency state', async () => {
    await assertFails(setDoc(doc(victimDb, 'webhookLocks', 'ANY-REF-0001'), { uid: VICTIM }));
});

console.log('\nCreating an account with money in it');

await it('cannot self-create a customer doc with a positive balance', async () => {
    const freshUid = 'customer_fresh';
    const freshDb  = testEnv.authenticatedContext(freshUid).firestore();
    await assertFails(setDoc(doc(freshDb, 'customers', freshUid), {
        name: 'Fresh', email: 'fresh@example.com', userType: 'customer',
        status: 'active', bookings: 0, spent: 0,
        walletBalance: 999999, escrowBalance: 0,
    }));
});

console.log('\nUnauthenticated access');

await it('anonymous cannot read a customer wallet', async () => {
    await assertFails(getDoc(doc(anonDb, 'customers', VICTIM)));
});

await it('anonymous cannot write a customer wallet', async () => {
    await assertFails(updateDoc(doc(anonDb, 'customers', VICTIM), { walletBalance: 1 }));
});

console.log('\nConfirming the balance never actually moved');

await it('victim wallet is still exactly 100 after every attack', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const snap = await getDoc(doc(ctx.firestore(), 'customers', VICTIM));
        const bal = snap.data().walletBalance;
        if (bal !== 100) throw new Error(`walletBalance moved to ${bal} — expected 100`);
    });
});

console.log('\nReview integrity (rating is a public trust signal)');

const ARTISAN  = 'artisan_reviewed';
const REVIEWED = 'HHB-RULES-REVIEW-1';

// A completed booking belonging to VICTIM, carried out by ARTISAN.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'artisans', ARTISAN), {
        name: 'Reviewed Artisan', status: 'active',
        verificationStatus: 'approved', rating: 0, reviewCount: null,
    });
    await setDoc(doc(db, 'bookings', REVIEWED), {
        customerId: VICTIM, artisanId: ARTISAN,
        status: 'completed', serviceType: 'Plumbing',
        createdAt: new Date().toISOString(),
    });
});

// victimDb / attackerDb are already declared above; only the artisan context is new.
const artisanDb  = testEnv.authenticatedContext(ARTISAN).firestore();

await it('the customer CAN review their own completed booking', async () => {
    await assertSucceeds(updateDoc(doc(victimDb, 'bookings', REVIEWED), {
        rating: 5, review: 'Excellent work', reviewedAt: 'now', updatedAt: 'now',
    }));
});

await it('the same booking cannot be reviewed twice', async () => {
    // Without this the booking would show one score while the artisan's public
    // average kept the first — the trigger correctly refuses to re-aggregate.
    await assertFails(updateDoc(doc(victimDb, 'bookings', REVIEWED), {
        rating: 1, review: 'Changed my mind', reviewedAt: 'now', updatedAt: 'now',
    }));
});

await it('an artisan cannot review their own job', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'bookings', 'HHB-SELF-REVIEW'), {
            customerId: VICTIM, artisanId: ARTISAN, status: 'completed',
            serviceType: 'Plumbing', createdAt: new Date().toISOString(),
        });
    });
    await assertFails(updateDoc(doc(artisanDb, 'bookings', 'HHB-SELF-REVIEW'), {
        rating: 5, review: 'I was great', reviewedAt: 'now', updatedAt: 'now',
    }));
});

await it('a stranger cannot review someone else\'s booking', async () => {
    await assertFails(updateDoc(doc(attackerDb, 'bookings', 'HHB-SELF-REVIEW'), {
        rating: 5, review: 'Never used them', reviewedAt: 'now', updatedAt: 'now',
    }));
});

await it('a cancelled booking cannot be reviewed', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'bookings', 'HHB-CANCELLED'), {
            customerId: VICTIM, artisanId: ARTISAN, status: 'cancelled',
            serviceType: 'Plumbing', createdAt: new Date().toISOString(),
        });
    });
    await assertFails(updateDoc(doc(victimDb, 'bookings', 'HHB-CANCELLED'), {
        rating: 5, review: 'x', reviewedAt: 'now', updatedAt: 'now',
    }));
});

await it('an out-of-range rating is rejected', async () => {
    await assertFails(updateDoc(doc(victimDb, 'bookings', 'HHB-SELF-REVIEW'), {
        rating: 99, review: 'x', reviewedAt: 'now', updatedAt: 'now',
    }));
});

await it('a customer cannot pre-set ratingProcessed to suppress aggregation', async () => {
    await assertFails(updateDoc(doc(victimDb, 'bookings', 'HHB-SELF-REVIEW'), {
        rating: 5, ratingProcessed: true, reviewedAt: 'now', updatedAt: 'now',
    }));
});

await it('a customer cannot write the artisan aggregate directly', async () => {
    await assertFails(updateDoc(doc(victimDb, 'artisans', ARTISAN), {
        rating: 5, reviewCount: 999,
    }));
});

await it('an artisan cannot inflate their own aggregate', async () => {
    await assertFails(updateDoc(doc(artisanDb, 'artisans', ARTISAN), {
        rating: 5, reviewCount: 999,
    }));
});

console.log('\nArtisan acceptance is server-owned (AR-06, 2026-10-20)');

// An offered artisan is not the booking's artisanId until respondToJobOffer
// (functions/jobOffers.js) accepts for them, so the browser can neither accept
// nor decline by writing the booking — not even a legacy booking that already
// names them.
const ACC_ARTISAN = 'artisan_accepter';

await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'artisans', ACC_ARTISAN), {
        name: 'Accepting Artisan', status: 'active',
        verificationStatus: 'approved', rating: 0, reviewCount: 0,
    });
    for (const id of ['HHB-ACC-OK', 'HHB-ACC-OLDCLIENT']) {
        await setDoc(doc(db, 'bookings', id), {
            customerId: VICTIM, artisanId: ACC_ARTISAN,
            status: 'pending', serviceType: 'Plumbing',
            createdAt: new Date().toISOString(),
        });
    }
});

const accDb = testEnv.authenticatedContext(ACC_ARTISAN).firestore();

await it('an artisan client can NOT accept by writing the booking', async () => {
    const n = new Date().toISOString();
    await assertFails(updateDoc(doc(accDb, 'bookings', 'HHB-ACC-OK'), {
        status: 'accepted', acceptedAt: n, updatedAt: n,
    }));
});

await it('an artisan client sending artisanName is rejected too', async () => {
    const n = new Date().toISOString();
    await assertFails(updateDoc(doc(accDb, 'bookings', 'HHB-ACC-OLDCLIENT'), {
        status: 'accepted', acceptedAt: n, updatedAt: n, artisanName: 'Spoofed Name',
    }));
});

await it('an artisan client can NOT decline by writing the booking', async () => {
    const n = new Date().toISOString();
    await assertFails(updateDoc(doc(accDb, 'bookings', 'HHB-ACC-OLDCLIENT'), {
        status: 'rejected', rejectedAt: n, updatedAt: n,
    }));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nAppointments: acceptance is not commencement');
// ─────────────────────────────────────────────────────────────────────────────
//
// A booking may carry an arrival window (scheduledForMs, epoch millis). Two
// invariants have to hold at the RULES layer, because the client cannot be
// trusted to hold them:
//
//   1. Neither party may write the appointment. A customer who could move
//      scheduledForMs into the past would unlock the gate below on their own
//      booking; an artisan who could write it could rewrite the slot they
//      committed to. Only the server (createInspectionBooking) sets it.
//   2. An artisan may not mark themselves en route before the window opens.
//      Accepting a Saturday appointment on Monday is a commitment, not a
//      starting gun — and before this gate existed, `accepted` flowed straight
//      into `en_route` with nothing to stop it.

const SCHED_ARTISAN = 'artisan_scheduled';
const HOUR = 3600000;

await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'artisans', SCHED_ARTISAN), {
        name: 'Scheduled Artisan', status: 'active',
        verificationStatus: 'approved', rating: 0, reviewCount: 0,
    });
    const common = {
        customerId: VICTIM, artisanId: SCHED_ARTISAN,
        serviceType: 'Plumbing', createdAt: new Date().toISOString(),
        quoteApproved: true,
    };
    // A week out — comfortably outside the 90-minute grace period.
    await setDoc(doc(db, 'bookings', 'HHB-SCHED-FUTURE'), {
        ...common, status: 'accepted',
        scheduledForMs: Date.now() + 7 * 24 * HOUR, scheduleWindowMins: 180,
    });
    // Starting in 20 minutes — inside the grace, so work may begin.
    await setDoc(doc(db, 'bookings', 'HHB-SCHED-NOW'), {
        ...common, status: 'accepted',
        scheduledForMs: Date.now() + 20 * 60000, scheduleWindowMins: 180,
    });
    // The inspection track reaches en_route by a DIFFERENT rules clause.
    await setDoc(doc(db, 'bookings', 'HHB-SCHED-INSP'), {
        ...common, status: 'inspection_scheduled', track: 'inspection',
        calloutPaid: true, quoteApproved: false,
        scheduledForMs: Date.now() + 7 * 24 * HOUR, scheduleWindowMins: 180,
    });
    // No appointment at all — must behave exactly as it always has.
    await setDoc(doc(db, 'bookings', 'HHB-SCHED-NONE'), { ...common, status: 'accepted' });
    // For the field-authority checks.
    await setDoc(doc(db, 'bookings', 'HHB-SCHED-FIELDS'), {
        ...common, status: 'pending',
        scheduledForMs: Date.now() + 7 * 24 * HOUR, scheduleWindowMins: 180,
    });
});

const schedArtDb = testEnv.authenticatedContext(SCHED_ARTISAN).firestore();

await it('artisan CANNOT go en route a week before the appointment', async () => {
    const n = new Date().toISOString();
    await assertFails(updateDoc(doc(schedArtDb, 'bookings', 'HHB-SCHED-FUTURE'), {
        status: 'en_route', enRouteAt: n, updatedAt: n,
    }));
});

await it('artisan CAN go en route once the window has opened', async () => {
    const n = new Date().toISOString();
    await assertSucceeds(updateDoc(doc(schedArtDb, 'bookings', 'HHB-SCHED-NOW'), {
        status: 'en_route', enRouteAt: n, updatedAt: n,
    }));
});

await it('the inspection-track en_route clause is gated too', async () => {
    // Both clauses must carry the gate; one without it is a hole.
    const n = new Date().toISOString();
    await assertFails(updateDoc(doc(schedArtDb, 'bookings', 'HHB-SCHED-INSP'), {
        status: 'en_route', enRouteAt: n, updatedAt: n,
    }));
});

await it('a booking with NO appointment is never gated (regression guard)', async () => {
    // Every booking written before appointments existed, and every emergency
    // booking, lands here. Absence must keep meaning "now".
    const n = new Date().toISOString();
    await assertSucceeds(updateDoc(doc(schedArtDb, 'bookings', 'HHB-SCHED-NONE'), {
        status: 'en_route', enRouteAt: n, updatedAt: n,
    }));
});

await it('artisan cannot move the appointment to unlock the gate', async () => {
    const n = new Date().toISOString();
    await assertFails(updateDoc(doc(schedArtDb, 'bookings', 'HHB-SCHED-FIELDS'), {
        scheduledForMs: Date.now() - HOUR, updatedAt: n,
    }));
});

await it('customer cannot write or move the appointment either', async () => {
    const n = new Date().toISOString();
    await assertFails(updateDoc(doc(victimDb, 'bookings', 'HHB-SCHED-FIELDS'), {
        scheduledForMs: Date.now() - HOUR, updatedAt: n,
    }));
    await assertFails(updateDoc(doc(victimDb, 'bookings', 'HHB-SCHED-FIELDS'), {
        scheduleWindowMins: 9999, updatedAt: n,
    }));
});

await it('customer cannot fabricate an appointment on a NEW booking', async () => {
    // bookingHasNoSystemFields() must reject it at create, the same way it
    // rejects a fabricated inspection track.
    const n = new Date().toISOString();
    await assertFails(setDoc(doc(victimDb, 'bookings', 'HHB-SCHED-FORGED'), {
        customerId: VICTIM, artisanId: SCHED_ARTISAN, status: 'pending',
        serviceType: 'Plumbing', createdAt: n,
        scheduledForMs: Date.now() + 3 * HOUR,
    }));
});

await it('customer cannot clear the reminder flag to farm notifications', async () => {
    const n = new Date().toISOString();
    await assertFails(updateDoc(doc(victimDb, 'bookings', 'HHB-SCHED-FIELDS'), {
        scheduleReminderSentAt: null, updatedAt: n,
    }));
});

// ── Availability (audit FLOW-001/002, 2026-10-28) ────────────────────────────
// isAvailable/isOnline are the artisan's own switch; presence heartbeats no
// longer write them. Only an approved, active artisan may switch them ON.
console.log('\nARTISAN AVAILABILITY\n');

const AV_OK = 'artisan_av_ok', AV_PENDING = 'artisan_av_pending', AV_SUSP = 'artisan_av_susp';
await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const base = (id, extra) => ({ id, uid: id, name: 'Av ' + id, email: id + '@example.com', userType: 'artisan',
                                   isAvailable: false, isOnline: false, rating: 0, reviewCount: 0, ...extra });
    await setDoc(doc(db, 'artisans', AV_OK),      base(AV_OK,      { status: 'active',    verificationStatus: 'approved' }));
    await setDoc(doc(db, 'artisans', AV_PENDING), base(AV_PENDING, { status: 'pending',   verificationStatus: 'pending_review' }));
    await setDoc(doc(db, 'artisans', AV_SUSP),    base(AV_SUSP,    { status: 'suspended', verificationStatus: 'approved' }));
});
const avOk = testEnv.authenticatedContext(AV_OK).firestore();
const avPending = testEnv.authenticatedContext(AV_PENDING).firestore();
const avSusp = testEnv.authenticatedContext(AV_SUSP).firestore();
const avNow = () => new Date().toISOString();

await it('an approved, active artisan can go online', async () => {
    await assertSucceeds(updateDoc(doc(avOk, 'artisans', AV_OK), { isAvailable: true, isOnline: true, updatedAt: avNow() }));
});
await it('the same artisan can go offline again', async () => {
    await assertSucceeds(updateDoc(doc(avOk, 'artisans', AV_OK), { isAvailable: false, isOnline: false, updatedAt: avNow() }));
});
await it('an artisan under review can NOT go online', async () => {
    await assertFails(updateDoc(doc(avPending, 'artisans', AV_PENDING), { isAvailable: true, isOnline: true, updatedAt: avNow() }));
});
await it('...nor show as online through isOnline alone', async () => {
    await assertFails(updateDoc(doc(avPending, 'artisans', AV_PENDING), { isOnline: true, updatedAt: avNow() }));
});
await it('a suspended artisan can NOT go online', async () => {
    await assertFails(updateDoc(doc(avSusp, 'artisans', AV_SUSP), { isAvailable: true, isOnline: true, updatedAt: avNow() }));
});
await it('an ineligible artisan can still switch OFF', async () => {
    await assertSucceeds(updateDoc(doc(avPending, 'artisans', AV_PENDING), { isAvailable: false, isOnline: false, updatedAt: avNow() }));
});
await it('a presence heartbeat (timestamps only) needs no eligibility', async () => {
    const n = avNow();
    await assertSucceeds(updateDoc(doc(avPending, 'artisans', AV_PENDING), { lastHeartbeat: n, presenceUpdatedAt: n, lastActive: n, updatedAt: n }));
});

// ── Push token (AR-04, 2026-10-20) ───────────────────────────────────────────
// pushNotificationService saves the device token with its platform, which picks
// the message shape the server sends. If the rules refused this write, push
// would stay dead with nothing but a console warning to show for it.
console.log('\nPUSH TOKEN\n');

await it('a customer can save their own push token with its platform', async () => {
    const n = new Date().toISOString();
    await assertSucceeds(updateDoc(doc(victimDb, 'customers', VICTIM), {
        fcmToken: 'tok-web-1', fcmPlatform: 'web', fcmTokenUpdatedAt: n, updatedAt: n,
    }));
});

await it('nobody can redirect another customer\'s notifications to their own device', async () => {
    await assertFails(updateDoc(doc(attackerDb, 'customers', VICTIM), { fcmToken: 'tok-attacker', fcmPlatform: 'web' }));
});

await it('a push-token write cannot carry a wallet change with it', async () => {
    await assertFails(updateDoc(doc(victimDb, 'customers', VICTIM), {
        fcmToken: 'tok-web-2', fcmPlatform: 'web', walletBalance: 999999,
    }));
});

console.log('\nCHATS — the customer\'s first name (MSG-001): set at creation only\n');

// A thread is one customer and one artisan under the pair's id
// (chatRepository.directChatId), so each case below uses its own artisan and
// gets its own thread, as it would in the app.
const CHAT_ARTISANS = ['artisan_chat_1', 'artisan_chat_2', 'artisan_chat_3', 'artisan_chat_4',
                       'artisan_chat_5', 'artisan_chat_6', 'artisan_chat_7', 'artisan_chat_8'];
const [A1, A2, A3, A4, A5, A6, A7, A8] = CHAT_ARTISANS;
const OTHER_CUSTOMER = 'customer_chat_other';
const pairId = (a, b) => [a, b].sort().join('_');
const dbOf = (uid) => testEnv.authenticatedContext(uid).firestore();
const chatDoc = (artisan, over = {}) => ({
    participants: [VICTIM, artisan], bookingId: null, lastMessage: '', lastSenderId: null,
    lastMessageAt: '2026-10-30T10:00:00.000Z', unreadCount: { [VICTIM]: 0, [artisan]: 0 },
    createdAt: '2026-10-30T10:00:00.000Z', ...over,
});
await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const a of CHAT_ARTISANS) {
        await setDoc(doc(db, 'artisans', a), { uid: a, userType: 'artisan', status: 'active', verificationStatus: 'approved', name: a });
    }
    await setDoc(doc(db, 'customers', OTHER_CUSTOMER), { name: 'Other', userType: 'customer', status: 'active', walletBalance: 0, escrowBalance: 0, spent: 0 });
    await setDoc(doc(db, 'bookings', 'bk_chat_pair'),    { customerId: VICTIM, artisanId: A6, status: 'accepted', track: 'inspection' });
    await setDoc(doc(db, 'bookings', 'bk_chat_offered'), { customerId: VICTIM, artisanId: null, currentArtisanId: A8, status: 'pending', track: 'inspection' });
    await setDoc(doc(db, 'bookings', 'bk_chat_other'),   { customerId: OTHER_CUSTOMER, artisanId: A7, status: 'accepted', track: 'inspection' });
    await setDoc(doc(db, 'bookings', 'bk_chat_later'),   { customerId: VICTIM, artisanId: A2, status: 'accepted', track: 'inspection' });
});

await it('a participant creates a chat carrying the customer\'s first name', async () => {
    await assertSucceeds(setDoc(doc(victimDb, 'chats', pairId(VICTIM, A1)), chatDoc(A1, { customerFirstName: 'Ama' })));
    await assertSucceeds(setDoc(doc(dbOf(A2), 'chats', pairId(VICTIM, A2)), chatDoc(A2, { customerFirstName: 'Ama' })));
});
await it('a chat without the name is still created (existing behaviour)', async () => {
    await assertSucceeds(setDoc(doc(victimDb, 'chats', pairId(VICTIM, A3)), chatDoc(A3)));
});
await it('the name must be a string of 1–40 characters', async () => {
    const id = pairId(VICTIM, A4);
    await assertFails(setDoc(doc(victimDb, 'chats', id), chatDoc(A4, { customerFirstName: 'A'.repeat(41) })));
    await assertFails(setDoc(doc(victimDb, 'chats', id), chatDoc(A4, { customerFirstName: '' })));
    await assertFails(setDoc(doc(victimDb, 'chats', id), chatDoc(A4, { customerFirstName: 42 })));
    await assertSucceeds(setDoc(doc(victimDb, 'chats', id), chatDoc(A4, { customerFirstName: 'A'.repeat(40) })));
});
await it('a non-participant cannot create a chat carrying it', async () => {
    await assertFails(setDoc(doc(attackerDb, 'chats', pairId(VICTIM, A5)), chatDoc(A5, { customerFirstName: 'Ama' })));
});
await it('neither participant can change it afterwards (it is immutable)', async () => {
    const named = pairId(VICTIM, A1), unnamed = pairId(VICTIM, A3);
    await assertFails(updateDoc(doc(victimDb, 'chats', named), { customerFirstName: 'Kofi' }));
    await assertFails(updateDoc(doc(dbOf(A1), 'chats', named), { customerFirstName: 'Kofi' }));
    await assertFails(updateDoc(doc(victimDb, 'chats', unnamed), { customerFirstName: 'Ama' }), 'not added later either');
    await assertFails(updateDoc(doc(dbOf(A3), 'chats', unnamed), { customerFirstName: 'Ama' }));
});
await it('the inbox-preview updates a message makes still work', async () => {
    await assertSucceeds(updateDoc(doc(dbOf(A1), 'chats', pairId(VICTIM, A1)), {
        lastMessage: 'On my way', lastSenderId: A1, lastMessageAt: '2026-10-30T10:05:00.000Z',
    }));
});

console.log('\nCHATS — who a thread can be between (Phase 0 PS-01)\n');

await it('a customer may still message an artisan before booking (the enquiry flow is kept)', async () => {
    await assertSucceeds(setDoc(doc(victimDb, 'chats', pairId(VICTIM, A5)), chatDoc(A5)));
});
await it('a thread cannot include a third person', async () => {
    await assertFails(setDoc(doc(victimDb, 'chats', pairId(VICTIM, A6)), { ...chatDoc(A6), participants: [VICTIM, A6, A7] }));
    await assertFails(setDoc(doc(victimDb, 'chats', 'group_thread'), { ...chatDoc(A6), participants: [VICTIM, A6, A7] }));
});
await it('a customer cannot open a thread with another customer, nor an artisan with another artisan', async () => {
    await assertFails(setDoc(doc(victimDb, 'chats', pairId(VICTIM, OTHER_CUSTOMER)), { ...chatDoc(A6), participants: [VICTIM, OTHER_CUSTOMER] }));
    await assertFails(setDoc(doc(dbOf(A6), 'chats', pairId(A6, A7)), { ...chatDoc(A6), participants: [A6, A7] }));
});
await it('a thread must live at its pair id', async () => {
    await assertFails(setDoc(doc(victimDb, 'chats', 'chat_made_up_id'), chatDoc(A6)));
    await assertFails(setDoc(doc(victimDb, 'chats', pairId(VICTIM, A7)), chatDoc(A6)), 'another pair\'s id');
});
await it('a thread may be linked at creation to the pair\'s own booking, never to someone else\'s', async () => {
    await assertFails(setDoc(doc(victimDb, 'chats', pairId(VICTIM, A6)), chatDoc(A6, { bookingId: 'bk_chat_other' })));
    await assertFails(setDoc(doc(victimDb, 'chats', pairId(VICTIM, A6)), chatDoc(A6, { bookingId: 'bk_chat_offered' })), 'offered to another artisan');
    await assertSucceeds(setDoc(doc(dbOf(A6), 'chats', pairId(VICTIM, A6)), chatDoc(A6, { bookingId: 'bk_chat_pair' })));
});
await it('a booking still being offered links to the artisan it is offered to (customer-app opens that thread)', async () => {
    await assertSucceeds(setDoc(doc(victimDb, 'chats', pairId(VICTIM, A8)), chatDoc(A8, { bookingId: 'bk_chat_offered' })));
});
await it('a booking linked later must also be the pair\'s own', async () => {
    const enquiry = pairId(VICTIM, A5);
    await assertFails(updateDoc(doc(victimDb, 'chats', enquiry), { bookingId: 'bk_chat_other' }));
    await assertFails(updateDoc(doc(victimDb, 'chats', enquiry), { bookingId: 'bk_chat_pair' }), 'that booking is with another artisan');
    await assertFails(updateDoc(doc(dbOf(A5), 'chats', enquiry), { bookingId: 'bk_chat_pair' }));
    // The same two people booking later still attaches (getOrCreateDirectChat).
    await assertSucceeds(updateDoc(doc(victimDb, 'chats', pairId(VICTIM, A2)), { bookingId: 'bk_chat_later' }));
});
await it('a message is capped at 4 000 characters, and only a participant posts', async () => {
    const thread = pairId(VICTIM, A1);
    const msg = (text, sender) => ({ senderId: sender, text, attachment: null, isRead: false, createdAt: '2026-10-30T10:06:00.000Z' });
    await assertSucceeds(setDoc(doc(victimDb, 'chats', thread, 'messages', 'm_ok'), msg('x'.repeat(4000), VICTIM)));
    await assertFails(setDoc(doc(victimDb, 'chats', thread, 'messages', 'm_long'), msg('x'.repeat(4001), VICTIM)));
    await assertFails(setDoc(doc(attackerDb, 'chats', thread, 'messages', 'm_stranger'), msg('hello', ATTACKER)));
    await assertFails(setDoc(doc(dbOf(A1), 'chats', thread, 'messages', 'm_spoof'), msg('hello', VICTIM)), 'not in another person\'s name');
});

console.log('\nBOOKINGS — the customer\'s location 14 days after the job (decision Q6)\n');

// functions/locationRetention.js moves address/lat/lng/notes to
// bookings/{id}/private/location 14 days after a booking closes.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'bookings', 'bk_loc_closed'), {
        customerId: VICTIM, artisanId: A1, status: 'completed', track: 'inspection', serviceType: 'Plumbing',
        locationRemovedAt: '2026-11-20T00:00:00.000Z',
    });
    await setDoc(doc(db, 'bookings', 'bk_loc_closed', 'private', 'location'), {
        bookingId: 'bk_loc_closed', customerId: VICTIM, address: '14 Example Street', lat: 5.6366, lng: -0.1618,
    });
});
const locDoc = (db) => doc(db, 'bookings', 'bk_loc_closed', 'private', 'location');

await it('the customer reads their own location record', async () => {
    await assertSucceeds(getDoc(locDoc(victimDb)));
});
await it('the booking\'s artisan cannot: their access ended with the move', async () => {
    await assertFails(getDoc(locDoc(dbOf(A1))));
});
await it('nor can anyone else', async () => {
    await assertFails(getDoc(locDoc(attackerDb)));
    await assertFails(getDoc(locDoc(anonDb)));
});
await it('no client writes it, not even the customer', async () => {
    await assertFails(setDoc(locDoc(victimDb), { address: 'Somewhere else' }));
    await assertFails(setDoc(locDoc(dbOf(A1)), { address: 'Somewhere else' }));
});
await it('no client can stop or reset the clock on the booking', async () => {
    const at = '2026-11-21T00:00:00.000Z';
    await assertSucceeds(updateDoc(doc(dbOf(A1), 'bookings', 'bk_loc_closed'), { artisanNotes: 'ok', updatedAt: at }));
    await assertFails(updateDoc(doc(dbOf(A1), 'bookings', 'bk_loc_closed'), { artisanNotes: 'x', updatedAt: at, locationRetainUntilMs: 9e15 }));
    await assertFails(updateDoc(doc(dbOf(A1), 'bookings', 'bk_loc_closed'), { artisanNotes: 'x', updatedAt: at, locationRemovedAt: null }));
});

console.log('\n' + '─'.repeat(52));
console.log(`  ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');

await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);
