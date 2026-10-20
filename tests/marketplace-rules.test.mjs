/**
 * Verified claims, review records, offer events and cancellation attribution —
 * the Firestore-rules half of tests/marketplace-integrity.test.cjs. Runs the
 * real firestore.rules in the emulator with genuine client contexts.
 *
 *   AR-10  name, trade and identity documents are fixed while an application
 *          is under review or decided; the reviewer's fields are the
 *          reviewer's; a change request is server-written.
 *   AR-12  offer events are the artisan's to read and nobody's to write; a
 *          cancellation can only name its real author.
 *
 * Run:  npm run test:marketplace-rules
 */

import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { setDoc, updateDoc, doc, getDoc, getDocs, collection, query, where } from 'firebase/firestore';

const PROJECT_ID = 'lamax-rules-test';
const NOW = '2026-10-20T09:00:00.000Z';
const A = 'artisan_approved', B = 'artisan_other', C1 = 'customer_1';
const STATES = { draft: 'artisan_draft', pending_review: 'artisan_review', rejected: 'artisan_rejected',
                 re_verification_required: 'artisan_reverify', suspended: 'artisan_suspended' };
const ADMIN = 'admin_plain';

let passed = 0, failed = 0;
async function it(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (err) { console.log(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`); failed++; }
}

const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});

const profile = (uid, over = {}) => ({
    id: uid, uid, name: 'Kofi Boateng', fullName: 'Kofi Boateng', email: `${uid}@example.com`,
    userType: 'artisan', status: 'active', verificationStatus: 'approved', category: 'Plumbing',
    specialty: 'Plumber', requestedService: null, bio: 'Plumber', isOnline: false, isAvailable: true,
    rating: 0, reviewCount: 0, availableBalance: 0, pendingBalance: 0, totalEarned: 0, withdrawnTotal: 0,
    createdAt: NOW, updatedAt: NOW, ...over,
});

await testEnv.clearFirestore();
await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'artisans', A), profile(A));
    await setDoc(doc(db, 'artisans', B), profile(B));
    for (const [vs, uid] of Object.entries(STATES)) {
        await setDoc(doc(db, 'artisans', uid), profile(uid, { verificationStatus: vs, status: vs === 'suspended' ? 'suspended' : 'pending' }));
        await setDoc(doc(db, 'verification_requests', uid), { artisanId: uid, name: 'Kofi Boateng', status: vs, submittedAt: NOW,
            rejectionReason: vs === 'rejected' ? 'Ghana Card photo is blurry' : null });
    }
    await setDoc(doc(db, 'verification_requests', A), { artisanId: A, name: 'Kofi Boateng', status: 'approved', submittedAt: NOW });
    await setDoc(doc(db, 'artisans', A, 'private', 'kyc'), { artisanId: A, ghanaCardNumber: 'GHA-123456789-0', address: '1 Old Road', updatedAt: NOW });
    await setDoc(doc(db, 'artisans', STATES.draft, 'private', 'kyc'), { artisanId: STATES.draft, ghanaCardNumber: 'GHA-000000000-1', updatedAt: NOW });
    await setDoc(doc(db, 'customers', C1), { name: 'C', email: 'c@example.com', userType: 'customer', status: 'active',
        walletBalance: 0, escrowBalance: 0, spent: 0, bookings: 0 });
    await setDoc(doc(db, 'admins', ADMIN), { userType: 'admin', email: 'ops@example.com' });
    await setDoc(doc(db, 'profile_change_requests', A), { artisanId: A, status: 'pending', fields: ['name'],
        requested: { name: 'Kofi A. Boateng' }, current: { name: 'Kofi Boateng' }, reason: 'misspelt', createdAt: NOW });
    await setDoc(doc(db, 'offer_events', `bk1_1_${A}`), { artisanId: A, bookingId: 'bk1', outcome: 'declined', closedAt: NOW });
    await setDoc(doc(db, 'offer_events', `bk2_1_${B}`), { artisanId: B, bookingId: 'bk2', outcome: 'expired', closedAt: NOW });
    for (const id of ['BK-C', 'BK-A1', 'BK-A2', 'BK-C2']) {
        await setDoc(doc(db, 'bookings', id), { customerId: C1, artisanId: A, status: 'accepted', type: 'standard',
            serviceType: 'plumbing', createdAt: NOW, updatedAt: NOW });
    }
});

const ctx = (uid, token = {}) => testEnv.authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: true, ...token }).firestore();
const a = ctx(A), b = ctx(B), c1 = ctx(C1), admin = ctx(ADMIN, { email: 'ops@example.com' });
const st = Object.fromEntries(Object.entries(STATES).map(([vs, uid]) => [vs, ctx(uid)]));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nAR-10 · verified claims are fixed once submitted\n');

await it('an approved artisan cannot rename themselves or change trade directly', async () => {
    const pub = doc(a, 'artisans', A);
    for (const patch of [{ name: 'Someone Else' }, { fullName: 'Someone Else' }, { category: 'Electrical' },
                         { specialty: 'Electrician' }, { requestedService: 'Solar installs' }]) {
        await assertFails(updateDoc(pub, { ...patch, updatedAt: NOW }));
    }
});
await it('an approved artisan still edits the rest of the profile freely', async () => {
    await assertSucceeds(updateDoc(doc(a, 'artisans', A), { bio: 'Twenty years of plumbing', baseRate: 80, updatedAt: NOW }));
    await assertSucceeds(updateDoc(doc(a, 'artisans', A), { name: 'Kofi Boateng', bio: 'Same name, new bio', updatedAt: NOW }),
        'writing the SAME verified value is not a change');
});
await it('claims are fixed under review and while suspended; editable in draft, rejected and re-verification', async () => {
    for (const vs of ['pending_review', 'suspended']) {
        await assertFails(updateDoc(doc(st[vs], 'artisans', STATES[vs]), { name: 'New Name', updatedAt: NOW }));
    }
    for (const vs of ['draft', 'rejected', 're_verification_required']) {
        await assertSucceeds(updateDoc(doc(st[vs], 'artisans', STATES[vs]), { name: 'Corrected Name', category: 'Electrical', updatedAt: NOW }));
    }
});
await it('nobody can fake a change request, a review outcome or a performance figure on the profile', async () => {
    for (const patch of [{ pendingProfileChange: null }, { lastProfileChange: { status: 'approved' } },
                         { responseStats: { rate: 1, sufficient: true } }, { responseRate: 1 }, { completionRate: 1 }]) {
        await assertFails(updateDoc(doc(a, 'artisans', A), { ...patch, updatedAt: NOW }));
    }
});
await it('identity documents are fixed for an approved artisan; the address is not', async () => {
    const kyc = doc(a, 'artisans', A, 'private', 'kyc');
    for (const f of ['ghanaCardNumber', 'tin', 'dob', 'dateOfBirth', 'businessRegNumber']) {
        await assertFails(setDoc(kyc, { [f]: 'CHANGED-0001', updatedAt: NOW }, { merge: true }), f);
    }
    await assertSucceeds(setDoc(kyc, { address: '2 New Road', updatedAt: NOW }, { merge: true }));
    await assertSucceeds(setDoc(doc(st.draft, 'artisans', STATES.draft, 'private', 'kyc'),
        { ghanaCardNumber: 'GHA-000000000-2', updatedAt: NOW }, { merge: true }), 'a draft can still correct it');
});

console.log('\nAR-10 · the verification record and the reviewer\'s fields\n');

await it('an applicant cannot create their request with reviewer fields', async () => {
    const id = 'artisan_fresh';
    await testEnv.withSecurityRulesDisabled((x) => setDoc(doc(x.firestore(), 'artisans', id), profile(id, { verificationStatus: 'draft', status: 'pending' })));
    const f = ctx(id);
    for (const k of ['trustScore', 'reviewedBy', 'reviewedAt', 'rejectionReason', 'adminNotes']) {
        await assertFails(setDoc(doc(f, 'verification_requests', id), { artisanId: id, status: 'pending_review', submittedAt: NOW, [k]: k === 'trustScore' ? 100 : null }), k);
    }
    await assertSucceeds(setDoc(doc(f, 'verification_requests', id), { artisanId: id, status: 'pending_review', submittedAt: NOW }));
});
await it('an applicant cannot touch their request while it is reviewed or decided', async () => {
    await assertFails(updateDoc(doc(st.pending_review, 'verification_requests', STATES.pending_review), { name: 'Switched', updatedAt: NOW }));
    await assertFails(updateDoc(doc(a, 'verification_requests', A), { category: 'Electrical', updatedAt: NOW }));
});
await it('a rejected applicant resubmits without erasing the reviewer\'s reason', async () => {
    const r = doc(st.rejected, 'verification_requests', STATES.rejected);
    await assertFails(setDoc(r, { rejectionReason: null, status: 'pending_review', submittedAt: NOW }, { merge: true }));
    await assertFails(setDoc(r, { adminNotes: 'all fine', status: 'pending_review', submittedAt: NOW }, { merge: true }));
    await assertSucceeds(setDoc(r, { artisanId: STATES.rejected, name: 'Kofi Boateng', status: 'pending_review', submittedAt: NOW }, { merge: true }));
    let after = null;
    await testEnv.withSecurityRulesDisabled(async (x) => { after = (await getDoc(doc(x.firestore(), 'verification_requests', STATES.rejected))).data(); });
    if (after.rejectionReason !== 'Ghana Card photo is blurry') throw new Error('the reason was erased');
});
await it('a profile change request is the artisan\'s to read and nobody\'s to write', async () => {
    await assertSucceeds(getDoc(doc(a, 'profile_change_requests', A)));
    await assertSucceeds(getDoc(doc(admin, 'profile_change_requests', A)));
    await assertFails(getDoc(doc(b, 'profile_change_requests', A)));
    await assertFails(getDoc(doc(c1, 'profile_change_requests', A)));
    await assertFails(updateDoc(doc(a, 'profile_change_requests', A), { status: 'approved' }));
    await assertFails(setDoc(doc(b, 'profile_change_requests', B), { artisanId: B, status: 'approved', requested: { category: 'Electrical' } }));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nAR-12 · offer events and cancellation attribution\n');

await it('an artisan reads their own offer events, and only theirs', async () => {
    await assertSucceeds(getDoc(doc(a, 'offer_events', `bk1_1_${A}`)));
    await assertSucceeds(getDocs(query(collection(a, 'offer_events'), where('artisanId', '==', A))));
    await assertFails(getDoc(doc(a, 'offer_events', `bk2_1_${B}`)));
    await assertFails(getDocs(collection(a, 'offer_events')));
    await assertFails(getDoc(doc(c1, 'offer_events', `bk1_1_${A}`)));
});
await it('nobody writes an offer event from a client — not even to improve their own rate', async () => {
    await assertFails(setDoc(doc(a, 'offer_events', `bk9_1_${A}`), { artisanId: A, outcome: 'accepted', closedAt: NOW }));
    await assertFails(updateDoc(doc(a, 'offer_events', `bk1_1_${A}`), { outcome: 'accepted' }));
});
// updatedAt must CHANGE — the booking state machine requires it in the diff.
const cancel = (db, id, by) => updateDoc(doc(db, 'bookings', id),
    { status: 'cancelled', updatedAt: new Date().toISOString(), cancellationReason: 'Changed plans', ...(by ? { cancelledBy: by } : {}) });
await it('a customer cannot record their cancellation as the artisan\'s', async () => {
    await assertFails(cancel(c1, 'BK-C', 'artisan'));
});
await it('a customer records their own cancellation', async () => {
    await assertSucceeds(cancel(c1, 'BK-C', 'customer'));
});
await it('an artisan cannot record their cancellation as the customer\'s', async () => {
    await assertFails(cancel(a, 'BK-A1', 'customer'));
});
await it('an artisan records their own cancellation', async () => {
    await assertSucceeds(cancel(a, 'BK-A1', 'artisan'));
});
await it('attribution stays optional for clients that do not send it', async () => {
    await assertSucceeds(cancel(c1, 'BK-C2', null));
});

console.log('\n' + '─'.repeat(52));
console.log(`  ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');
await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);
