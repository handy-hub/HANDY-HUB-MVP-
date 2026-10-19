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

console.log('\nArtisan acceptance (outage guard after artisanName was locked)');

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

await it('CURRENT artisan client CAN accept a pending booking', async () => {
    // Exactly the payload artisan-app/jobs.html sends today.
    const n = new Date().toISOString();
    await assertSucceeds(updateDoc(doc(accDb, 'bookings', 'HHB-ACC-OK'), {
        status: 'accepted', acceptedAt: n, updatedAt: n,
    }));
});

await it('OLD artisan client (sending artisanName) is now rejected', async () => {
    // Confirms the ordering hazard was real: had rules shipped before the app,
    // every acceptance in production would have failed.
    const n = new Date().toISOString();
    await assertFails(updateDoc(doc(accDb, 'bookings', 'HHB-ACC-OLDCLIENT'), {
        status: 'accepted', acceptedAt: n, updatedAt: n, artisanName: 'Spoofed Name',
    }));
});

await it('artisan CAN still decline a pending booking', async () => {
    const n = new Date().toISOString();
    await assertSucceeds(updateDoc(doc(accDb, 'bookings', 'HHB-ACC-OLDCLIENT'), {
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


console.log('\n' + '─'.repeat(52));
console.log(`  ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');

await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);
