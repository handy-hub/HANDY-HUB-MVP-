/**
 * tests/earnings-reputation-rules.test.mjs — every read the Earnings and
 * Reputation screens make is allowed for the artisan it belongs to and refused
 * to anyone else; and no client can write the records those screens show.
 * (Phase 4, Part C: permission errors.)
 *
 * Run: npm run test:earnings-rules   (Firestore emulator only — no functions)
 *
 * The queries are the screens' own, built the way the client builds them:
 *   walletRepository.subscribeToArtisanWallet   escrow artisanId == me, status in [held, disputed]
 *                                               payouts userId == me, limit 200
 *   walletRepository.getRecentArtisanEscrow     escrow artisanId == me, createdAt desc, limit 20
 *   walletRepository.subscribeToArtisanTransactions / getArtisanLedger
 *                                               artisans/{me}/transactions, createdAt desc
 *   wallet.html loadPayoutSetup                 artisans/{me}/private/kyc, /security
 *   reputationScreen.reputationQuery            bookings artisanId == me, status in [...], updatedAt desc, 200
 */

import './support/no-production.cjs';   // must stay the first statement (npm run lint:tests)
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { setDoc, updateDoc, deleteDoc, doc, getDoc, getDocs, collection, query, where, orderBy, limit } from 'firebase/firestore';

const PROJECT_ID = 'lamax-rules-test';
const A = 'art_earn', A2 = 'art_other', C = 'cust_earn';
const NOW = '2026-11-07T10:00:00.000Z';

let passed = 0, failed = 0;
async function it(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (err) { console.log(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`); failed++; }
}

const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});

const artisanDoc = (uid) => ({ id: uid, uid, name: 'Kofi', userType: 'artisan', status: 'active', verificationStatus: 'approved',
    availableBalance: 85, totalEarned: 85, withdrawnTotal: 0, rating: 4.5, reviewCount: 3, jobsCompleted: 4, bio: 'Plumber' });

await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'customers', C), { id: C, uid: C, userType: 'customer', status: 'active', walletBalance: 0, escrowBalance: 0, spent: 0 });
    for (const a of [A, A2]) {
        await setDoc(doc(db, 'artisans', a), artisanDoc(a));
        await setDoc(doc(db, 'artisans', a, 'transactions', `t_${a}`), { type: 'earning', amount: 85, commission: 15, totalAmount: 100, createdAt: NOW });
        await setDoc(doc(db, 'artisans', a, 'private', 'kyc'), { payoutAccount: { provider: 'mtn', phone: '0241234567', accountName: 'Kofi' } });
        await setDoc(doc(db, 'artisans', a, 'private', 'security'), { securityPinConfigured: true });
        await setDoc(doc(db, 'escrow', `e_held_${a}`), { artisanId: a, customerId: C, bookingId: `b_${a}`, status: 'held', amount: 100, commission: 15, artisanShare: 85, createdAt: NOW });
        await setDoc(doc(db, 'escrow', `e_ref_${a}`), { artisanId: a, customerId: C, bookingId: `b2_${a}`, status: 'refunded', amount: 60, refundedBy: 'ops@x.test', createdAt: NOW });
        await setDoc(doc(db, 'payouts', `p_${a}`), { userId: a, userType: 'artisan', ref: 'AW-1', amount: 40, status: 'success', phone: '0241234567', createdAt: NOW });
        await setDoc(doc(db, 'bookings', `b_${a}`), { artisanId: a, customerId: C, status: 'completed', rating: 5, review: 'Good', updatedAt: NOW, createdAt: NOW });
    }
});

const as = (uid) => testEnv.authenticatedContext(uid).firestore();
const anon = () => testEnv.unauthenticatedContext().firestore();
const qHeld = (db, uid) => query(collection(db, 'escrow'), where('artisanId', '==', uid), where('status', 'in', ['held', 'disputed']));
const qRecent = (db, uid) => query(collection(db, 'escrow'), where('artisanId', '==', uid), orderBy('createdAt', 'desc'), limit(20));
const qPayouts = (db, uid) => query(collection(db, 'payouts'), where('userId', '==', uid), limit(200));
const qLedger = (db, uid) => query(collection(db, 'artisans', uid, 'transactions'), orderBy('createdAt', 'desc'), limit(1000));
const qRep = (db, uid) => query(collection(db, 'bookings'), where('artisanId', '==', uid), where('status', 'in', ['completed', 'cancelled', 'resolved']),
    orderBy('updatedAt', 'desc'), limit(200));

console.log('\n── The artisan reads every record the two screens show ──\n');
await it('escrow held/disputed for me (the wallet listener)', () => assertSucceeds(getDocs(qHeld(as(A), A))));
await it('my recent job payments in any state (returned to customers)', () => assertSucceeds(getDocs(qRecent(as(A), A))));
await it('my payouts', () => assertSucceeds(getDocs(qPayouts(as(A), A))));
await it('my whole ledger, newest first (Check / Show older)', () => assertSucceeds(getDocs(qLedger(as(A), A))));
await it('my payout account and PIN status (display only)', async () => {
    await assertSucceeds(getDoc(doc(as(A), 'artisans', A, 'private', 'kyc')));
    await assertSucceeds(getDoc(doc(as(A), 'artisans', A, 'private', 'security')));
});
await it('my finished bookings with their reviews (Reputation)', () => assertSucceeds(getDocs(qRep(as(A), A))));
await it('my profile: balances and reputation fields', () => assertSucceeds(getDoc(doc(as(A), 'artisans', A))));

console.log('\n── Nobody else reads them ──\n');
await it('another artisan cannot list my escrow, payouts, ledger or bookings', async () => {
    const db = as(A2);
    await assertFails(getDocs(qHeld(db, A)));
    await assertFails(getDocs(qRecent(db, A)));
    await assertFails(getDocs(qPayouts(db, A)));
    await assertFails(getDocs(qLedger(db, A)));
    await assertFails(getDocs(qRep(db, A)));
});
await it('another artisan cannot read my payout account or PIN status', async () => {
    await assertFails(getDoc(doc(as(A2), 'artisans', A, 'private', 'kyc')));
    await assertFails(getDoc(doc(as(A2), 'artisans', A, 'private', 'security')));
});
await it('an unscoped query (all held escrow, all payouts) is refused even to an artisan', async () => {
    await assertFails(getDocs(query(collection(as(A), 'escrow'), where('status', '==', 'held'))));
    await assertFails(getDocs(query(collection(as(A), 'payouts'), limit(5))));
});
await it('the paying customer reads the escrow, but not the artisan\'s ledger or payouts', async () => {
    await assertSucceeds(getDoc(doc(as(C), 'escrow', `e_held_${A}`)));
    await assertFails(getDocs(qLedger(as(C), A)));
    await assertFails(getDocs(qPayouts(as(C), A)));
});
await it('signed out: nothing', async () => {
    await assertFails(getDocs(qPayouts(anon(), A)));
    await assertFails(getDocs(qLedger(anon(), A)));
    await assertFails(getDoc(doc(anon(), 'escrow', `e_held_${A}`)));
});

console.log('\n── No client writes what these screens show ──\n');
await it('the artisan cannot write a ledger row, a payout or an escrow', async () => {
    const db = as(A);
    await assertFails(setDoc(doc(db, 'artisans', A, 'transactions', 'forged'), { type: 'earning', amount: 1000, createdAt: NOW }));
    await assertFails(updateDoc(doc(db, 'artisans', A, 'transactions', `t_${A}`), { amount: 1000 }));
    await assertFails(deleteDoc(doc(db, 'artisans', A, 'transactions', `t_${A}`)));
    await assertFails(setDoc(doc(db, 'payouts', 'forged'), { userId: A, amount: 10, status: 'success' }));
    await assertFails(updateDoc(doc(db, 'payouts', `p_${A}`), { status: 'failed' }));
    await assertFails(updateDoc(doc(db, 'escrow', `e_held_${A}`), { status: 'released' }));
});
await it('the artisan can edit their profile, but not one balance or reputation figure on it', async () => {
    const db = as(A);
    await assertSucceeds(updateDoc(doc(db, 'artisans', A), { bio: 'Plumber, 10 years' }));   // the control: the path is open
    // Each value differs from the stored one: rules judge the keys a write CHANGES,
    // so re-writing a field's current value is (correctly) no change at all.
    for (const [k, v] of [['availableBalance', 9999], ['totalEarned', 9999], ['withdrawnTotal', 50], ['rating', 5], ['reviewCount', 99], ['jobsCompleted', 500]]) {
        try { await assertFails(updateDoc(doc(db, 'artisans', A), { [k]: v })); }
        catch (e) { throw new Error(`${k} could be written: ${e.message}`); }
    }
});
await it('the artisan cannot write the server\'s security record (PIN status)', () =>
    assertFails(setDoc(doc(as(A), 'artisans', A, 'private', 'security'), { securityPinConfigured: false })));

await testEnv.cleanup();
console.log(`\nearnings-reputation-rules: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
