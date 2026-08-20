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

console.log('\n' + '─'.repeat(52));
console.log(`  ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');

await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);
