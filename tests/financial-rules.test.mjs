/**
 * tests/financial-rules.test.mjs — no client, of any role, can create or move
 * money by writing Firestore directly. (financial-security audit, 2026-10-22)
 *
 * Run: npm run test:financial-rules   (Firestore emulator)
 *
 * Every attempt below is a write a browser could make with the public Firebase
 * config and its own signed-in token. Authoritative financial records are
 * written by Cloud Functions through the Admin SDK, which Security Rules do not
 * govern — so for clients the answer must be "no" everywhere, including for
 * administrators: the admin dashboard only READS money records.
 *
 * What rules cannot stop is a write with project credentials (the Firebase
 * console, a service account). That is what happened on 2026-10-22 (3 → 300),
 * and it is answered server-side: functions/financial/walletIntegrity.js spends
 * only what the verified ledger supports (tests/wallet-integrity.test.cjs).
 */

import './support/no-production.cjs';   // must stay the first statement (npm run lint:tests)
import {
    initializeTestEnvironment,
    assertFails,
    assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
    setDoc, updateDoc, deleteDoc, doc, getDoc, getDocs, collection, query, where,
} from 'firebase/firestore';

const PROJECT_ID = 'lamax-rules-test';
const C  = 'cust_money';         // a customer with GHS 3
const C2 = 'cust_other';
const NEW = 'cust_new';          // signed in, no customer document yet
const A  = 'art_money';          // an approved artisan
const ADM = 'adm_plain';         // admins/{uid} admin (not super)
const SUP = 'sup_verified';      // allowlisted, verified email
const NOW = '2026-10-22T12:00:00.000Z';

let passed = 0, failed = 0;
async function it(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (err) { console.log(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`); failed++; }
}

const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});

const customerDoc = (uid, over = {}) => ({
    id: uid, uid, name: 'Ama Owusu', email: `${uid}@example.com`, userType: 'customer', status: 'active',
    bookings: 0, spent: 0, walletBalance: 3, escrowBalance: 0, ...over,
});

await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'customers', C), customerDoc(C));
    await setDoc(doc(db, 'customers', C2), customerDoc(C2, { walletBalance: 50 }));
    await setDoc(doc(db, 'customers', C, 'transactions', 'tx1'), {
        type: 'topup', amount: 3, status: 'successful', source: 'webhook', paystackRef: 'REF1', createdAt: NOW });
    await setDoc(doc(db, 'webhookLocks', 'REF1'), { uid: C, paystackRef: 'REF1', amountGHS: 3, creditedAt: NOW });
    await setDoc(doc(db, 'topupIntents', 'REF2'), { uid: C, status: 'pending', amountGHS: 10, createdAt: NOW });
    await setDoc(doc(db, 'escrow', 'E1'), { bookingId: 'B1', customerId: C, artisanId: A, amount: 2, artisanShare: 1.7,
        commission: 0.3, status: 'held', createdAt: NOW });
    await setDoc(doc(db, 'payouts', 'P1'), { userId: C, userType: 'customer', amount: 1, status: 'processing', createdAt: NOW });
    await setDoc(doc(db, 'artisans', A), {
        id: A, uid: A, name: 'Kofi', email: `${A}@example.com`, userType: 'artisan', status: 'active',
        verificationStatus: 'approved', availableBalance: 10, totalEarned: 10, withdrawnTotal: 0, category: 'plumbing',
    });
    await setDoc(doc(db, 'artisans', A, 'transactions', 'e1'), { type: 'earning', amount: 10, escrowId: 'E0', status: 'completed', createdAt: NOW });
    await setDoc(doc(db, 'transferRecipients', A), { userId: A, recipientCode: 'RCP_real', createdAt: NOW });
    await setDoc(doc(db, 'admins', ADM), { id: ADM, name: 'Ops', email: 'ops@example.com', userType: 'admin', role: 'operations_admin', status: 'active' });
    await setDoc(doc(db, 'platform', 'earnings'), { totalCommissions: 1, totalArtisanPayouts: 9 });
    await setDoc(doc(db, 'tips', 'B1'), { bookingId: 'B1', customerId: C, artisanId: A, amount: 2, status: 'paid', createdAt: NOW });
});

const ctx = (uid, token) => testEnv.authenticatedContext(uid, token).firestore();
const v = (uid) => ({ email: `${uid}@example.com`, email_verified: true });
const cust  = ctx(C, v(C));
const fresh = ctx(NEW, v(NEW));
const art   = ctx(A, v(A));
const adm   = ctx(ADM, { email: 'ops@example.com', email_verified: true });
const sup   = ctx(SUP, { email: 'silas7korda@gmail.com', email_verified: true });

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nCUSTOMER · cannot change what they have\n');

await it('cannot raise their wallet (3 → 300) with an update', async () => {
    await assertFails(updateDoc(doc(cust, 'customers', C), { walletBalance: 300 }));
});
await it('cannot raise it with a merge-set either', async () => {
    await assertFails(setDoc(doc(cust, 'customers', C), { walletBalance: 300 }, { merge: true }));
});
await it('cannot slip the balance in beside an allowed profile field', async () => {
    await assertFails(updateDoc(doc(cust, 'customers', C), { name: 'Ama', walletBalance: 300 }));
});
await it('cannot move money between wallet and escrow, or reset "spent"', async () => {
    // Values that DIFFER from the stored ones: a write that changes nothing is
    // not a change, and rules rightly allow it.
    await assertFails(updateDoc(doc(cust, 'customers', C), { escrowBalance: 2 }));
    await assertFails(updateDoc(doc(cust, 'customers', C), { walletBalance: 5, escrowBalance: 0 }));
    await assertFails(updateDoc(doc(cust, 'customers', C), { spent: 99 }));
});
await it('cannot delete their document to start again', async () => {
    await assertFails(deleteDoc(doc(cust, 'customers', C)));
});
await it('a new account cannot be created with money in it', async () => {
    await assertFails(setDoc(doc(fresh, 'customers', NEW), customerDoc(NEW, { walletBalance: 300 })));
    await assertFails(setDoc(doc(fresh, 'customers', NEW), customerDoc(NEW, { walletBalance: 0, escrowBalance: 50 })));
});
await it('…and can be created empty (the legitimate signup still works)', async () => {
    await assertSucceeds(setDoc(doc(fresh, 'customers', NEW), customerDoc(NEW, { walletBalance: 0 })));
});
await it('cannot write another customer\'s wallet', async () => {
    await assertFails(updateDoc(doc(cust, 'customers', C2), { walletBalance: 0 }));
});

console.log('\nCUSTOMER · cannot forge the evidence\n');

await it('cannot add a "successful top-up" row to their ledger', async () => {
    await assertFails(setDoc(doc(cust, 'customers', C, 'transactions', 'fake'), {
        type: 'topup', amount: 297, status: 'successful', source: 'webhook', paystackRef: 'FAKE', createdAt: NOW }));
});
await it('cannot change, or delete, a ledger row', async () => {
    await assertFails(updateDoc(doc(cust, 'customers', C, 'transactions', 'tx1'), { amount: 300 }));
    await assertFails(deleteDoc(doc(cust, 'customers', C, 'transactions', 'tx1')));
});
await it('cannot create the webhook lock that backs a top-up', async () => {
    await assertFails(setDoc(doc(cust, 'webhookLocks', 'FAKE'), { uid: C, paystackRef: 'FAKE', amountGHS: 297 }));
});
await it('cannot mark their own pending top-up as paid', async () => {
    await assertFails(updateDoc(doc(cust, 'topupIntents', 'REF2'), { status: 'successful', credited: true }));
    await assertFails(setDoc(doc(cust, 'topupIntents', 'NEWREF'), { uid: C, status: 'successful', credited: true, amountGHS: 297 }));
});
await it('cannot touch escrow: release it, refund it, or create a lock', async () => {
    await assertFails(updateDoc(doc(cust, 'escrow', 'E1'), { status: 'refunded' }));
    await assertFails(setDoc(doc(cust, 'escrow', 'E9'), { customerId: C, amount: 1, status: 'held' }));
    await assertFails(setDoc(doc(cust, '_escrow_locks', 'B9'), { customerId: C, amount: 0.01 }));
});
await it('cannot create or settle a payout', async () => {
    await assertFails(setDoc(doc(cust, 'payouts', 'P9'), { userId: C, userType: 'customer', amount: 300, status: 'success' }));
    await assertFails(updateDoc(doc(cust, 'payouts', 'P1'), { status: 'failed' }));
});
await it('cannot write the audit trail, platform totals, commissions or integrity alerts', async () => {
    await assertFails(setDoc(doc(cust, 'financialAudit', 'x'), { action: 'wallet_credit', userId: C, amount: 297 }));
    await assertFails(setDoc(doc(cust, 'platform', 'earnings'), { totalCommissions: 0 }, { merge: true }));
    await assertFails(setDoc(doc(cust, 'commissions', 'x'), { amount: 1 }));
    await assertFails(setDoc(doc(cust, 'walletIntegrityAlerts', `customer_${C}`), { resolved: true }));
    await assertFails(getDoc(doc(cust, 'walletIntegrityAlerts', `customer_${C}`)));
});
await it('still reads their own wallet, ledger, top-up and payouts', async () => {
    await assertSucceeds(getDoc(doc(cust, 'customers', C)));
    await assertSucceeds(getDocs(collection(cust, 'customers', C, 'transactions')));
    await assertSucceeds(getDoc(doc(cust, 'topupIntents', 'REF2')));
    await assertSucceeds(getDocs(query(collection(cust, 'payouts'), where('userId', '==', C))));
});

console.log('\nARTISAN · cannot forge earnings or redirect payouts\n');

await it('cannot raise their available balance, earnings or reset withdrawn', async () => {
    await assertFails(updateDoc(doc(art, 'artisans', A), { availableBalance: 1000 }));
    await assertFails(updateDoc(doc(art, 'artisans', A), { totalEarned: 1000 }));
    await assertFails(updateDoc(doc(art, 'artisans', A), { withdrawnTotal: -5, availableBalance: 15 }));
});
await it('cannot add an earning row', async () => {
    await assertFails(setDoc(doc(art, 'artisans', A, 'transactions', 'fake'), {
        type: 'earning', amount: 990, escrowId: 'E1', status: 'completed', createdAt: NOW }));
});
await it('cannot change where their payouts go (the Paystack recipient)', async () => {
    await assertFails(updateDoc(doc(art, 'transferRecipients', A), { recipientCode: 'RCP_attacker' }));
});
await it('cannot release escrow held for their job', async () => {
    await assertFails(updateDoc(doc(art, 'escrow', 'E1'), { status: 'released' }));
});
await it('still reads their own ledger and recipient', async () => {
    await assertSucceeds(getDocs(collection(art, 'artisans', A, 'transactions')));
    await assertSucceeds(getDoc(doc(art, 'transferRecipients', A)));
});

console.log('\nTIPS · made by the server, read by both parties\n');

await it('a customer cannot record a tip they did not pay, or change one', async () => {
    await assertFails(setDoc(doc(cust, 'tips', 'B2'), { bookingId: 'B2', customerId: C, artisanId: A, amount: 100, status: 'paid' }));
    await assertFails(updateDoc(doc(cust, 'tips', 'B1'), { amount: 0.01 }));
});
await it('an artisan cannot write a tip record or a tip ledger row', async () => {
    await assertFails(setDoc(doc(art, 'tips', 'B3'), { bookingId: 'B3', customerId: C2, artisanId: A, amount: 500, status: 'paid' }));
    await assertFails(setDoc(doc(art, 'artisans', A, 'transactions', 'tip_B3'), { type: 'tip', amount: 500, bookingId: 'B3', status: 'completed' }));
});
await it('both parties can read their tip; nobody else can', async () => {
    await assertSucceeds(getDoc(doc(cust, 'tips', 'B1')));
    await assertSucceeds(getDoc(doc(art, 'tips', 'B1')));
    await assertFails(getDoc(doc(ctx(C2, v(C2)), 'tips', 'B1')));
});

console.log('\nADMINISTRATORS · read money records, never write them from a browser\n');

for (const [who, db] of [['an operations admin', adm], ['a verified super-admin', sup]]) {
    await it(`${who} cannot set a customer's wallet`, async () => {
        await assertFails(updateDoc(doc(db, 'customers', C), { walletBalance: 300 }));
    });
    await it(`${who} cannot write ledger rows for a customer or an artisan`, async () => {
        await assertFails(setDoc(doc(db, 'customers', C, 'transactions', 'adm'), { type: 'topup', amount: 297, status: 'successful' }));
        await assertFails(setDoc(doc(db, 'artisans', A, 'transactions', 'adm'), { type: 'earning', amount: 990, status: 'completed' }));
    });
    await it(`${who} cannot create, settle or delete a payout`, async () => {
        await assertFails(setDoc(doc(db, 'payouts', 'PA'), { userId: A, userType: 'artisan', amount: 990, status: 'success' }));
        await assertFails(updateDoc(doc(db, 'payouts', 'P1'), { status: 'success' }));
        await assertFails(deleteDoc(doc(db, 'payouts', 'P1')));
    });
    await it(`${who} cannot redirect a payout recipient`, async () => {
        await assertFails(updateDoc(doc(db, 'transferRecipients', A), { recipientCode: 'RCP_attacker' }));
    });
    await it(`${who} cannot write commissions, platform totals or the audit trail`, async () => {
        await assertFails(setDoc(doc(db, 'commissions', 'c1'), { amount: 1 }));
        await assertFails(setDoc(doc(db, 'platform', 'earnings'), { totalCommissions: 0 }, { merge: true }));
        await assertFails(setDoc(doc(db, 'financialAudit', 'a1'), { action: 'escrow_release', amount: 1 }));
    });
    await it(`${who} cannot move escrow`, async () => {
        await assertFails(updateDoc(doc(db, 'escrow', 'E1'), { status: 'released' }));
    });
}
await it('the finance pages still read payouts, commissions and platform totals', async () => {
    await assertSucceeds(getDoc(doc(adm, 'platform', 'earnings')));
    await assertSucceeds(getDocs(collection(adm, 'payouts')));
    await assertSucceeds(getDocs(collection(adm, 'commissions')));
    await assertSucceeds(getDocs(collection(adm, 'financialAudit')));
});

console.log('\n' + '─'.repeat(52));
console.log(`  ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');
await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);
