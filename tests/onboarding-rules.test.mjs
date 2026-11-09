/**
 * The professional's application, against the real rules (Phase 5).
 *
 * Runs the EXACT writes artisan-app/js/onboarding.js builds — each step's
 * saved draft and the one-batch submission — through firestore.rules and
 * storage.rules in the emulators, as the artisan's own client. No hand-copied
 * shapes: if the module changes, these run the change.
 *
 * What it proves:
 *   · a new account's application is accepted in one batch, and lands whole;
 *   · without a verified email it is refused and NOTHING lands (atomic);
 *   · every step's draft is accepted; the identity record waits for a
 *     verified email, as the module says it does;
 *   · a rejected application can be sent again — the old request shape
 *     (status only) was refused, which is why the module names
 *     verificationStatus too;
 *   · an active artisan sent back for re-verification can resend without the
 *     page touching `status` — the old page wrote status 'pending', refused;
 *   · a second submission while under review, an approved account and a
 *     customer account are all refused (no duplicate, no self-approval);
 *   · the "Other" service request is create-once, which is why it is sent
 *     outside the batch;
 *   · documents are stored under their fixed names by their owner only.
 *
 * Run:  npm run test:onboarding-rules
 */

import './support/no-production.cjs';   // must stay the first statement (npm run lint:tests)
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, getDoc, setDoc, writeBatch } from 'firebase/firestore';
import { ref, uploadString } from 'firebase/storage';
import * as ob from '../artisan-app/js/onboarding.js';

const PROJECT_ID = 'lamax-rules-test';
const NOW = '2026-11-09T12:00:00.000Z';

let passed = 0, failed = 0;
async function it(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (err) { console.log(`  FAIL  ${name}\n        ${String(err && err.message).split('\n')[0]}`); failed++; }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
    storage:   { rules: readFileSync('storage.rules',   'utf8'), host: '127.0.0.1', port: 9199 },
});

/** The profile functions/emailOtp.js (signUpArtisanDirect) creates: no phone or email (CONTACT-001). */
const signupProfile = (uid, over = {}) => ({
    id: uid, uid, name: 'Kofi Boateng', fullName: 'Kofi Boateng', userType: 'artisan', status: 'pending',
    category: 'Plumbing', specialty: 'Plumbing', verificationStatus: 'draft', isOnline: false, isAvailable: false,
    rating: 0, reviewCount: 0, jobsCompleted: 0, availableBalance: 0, pendingBalance: 0, totalEarned: 0, withdrawnTotal: 0,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...over,
});
const values = (over = {}) => ({
    ...ob.emptyValues(),
    firstName: 'Kofi', lastName: 'Boateng', phone: '024 123 4567', gender: 'male', dob: '1990-04-12',
    address: '12 Example Street, Accra', gpsAddress: 'GA-123-4567', emergencyName: 'Ama', emergencyPhone: '0201112222',
    pin: { lat: 5.603716, lng: -0.186964, accuracy: 18, setAt: NOW },
    ghanaCard: 'GHA-123456789-0', trade: 'Plumbing', skills: ['Fix Leaking Pipe'],
    bio: 'Plumber in Accra for twelve years: leaks, toilets and water heaters.', experience: '12', radius: 10, days: ['Mon'],
    payProvider: 'mtn', payNumber: '0241111111', payName: 'Kofi Boateng', terms: true, ...over,
});
const DOC_URLS = { idFront: 'https://storage.example/f', idBack: 'https://storage.example/b' };

const client = (uid, verified = true) => testEnv.authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: verified }).firestore();
async function seed(writes) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        for (const [p, data] of Object.entries(writes)) await setDoc(doc(db, p), data);
    });
}
async function readBack(p) {
    let out = null;
    await testEnv.withSecurityRulesDisabled(async (ctx) => { const s = await getDoc(doc(ctx.firestore(), p)); out = s.exists() ? s.data() : null; });
    return out;
}
function commit(db, writes) {
    const b = writeBatch(db);
    for (const w of writes) b.set(doc(db, w.path, w.id), w.data, w.merge ? { merge: true } : {});
    return b.commit();
}
const submission = (uid, v = values()) => ob.submissionWrites({ uid, email: `${uid}@example.com`, v, docUrls: DOC_URLS, nowIso: NOW });

console.log('\nONBOARDING — the module\'s own writes against firestore.rules\n');

await testEnv.clearFirestore();

await it('a new account (draft, verified email): the application is accepted in one batch', async () => {
    const uid = 'ob_new';
    await seed({ [`artisans/${uid}`]: signupProfile(uid) });
    await assertSucceeds(commit(client(uid), submission(uid)));
    const p = await readBack(`artisans/${uid}`);
    assert(p.verificationStatus === 'pending_review' && p.status === 'pending' && p.isAvailable === false, `profile ${JSON.stringify([p.verificationStatus, p.status, p.isAvailable])}`);
    assert(!('phone' in p) && !('email' in p) && !('ghanaCardNumber' in p), 'nothing private on the public profile');
    assert(p.createdAt === '2026-11-01T00:00:00.000Z', 'the account\'s creation date is kept');
    const r = await readBack(`verification_requests/${uid}`);
    assert(r && r.status === 'pending_review' && r.verificationStatus === 'pending_review' && r.documents.idFront, 'the request landed');
    assert((await readBack(`artisans/${uid}/private/kyc`)).payoutAccount.phone === '0241111111', 'identity and payout landed');
    assert((await readBack(`artisans/${uid}/private/location`)).lat === 5.603716, 'the precise pin landed privately');
});

await it('an unverified email: refused, and nothing lands (the batch is atomic)', async () => {
    const uid = 'ob_unverified';
    await seed({ [`artisans/${uid}`]: signupProfile(uid) });
    await assertFails(commit(client(uid, false), submission(uid)));
    assert((await readBack(`artisans/${uid}`)).verificationStatus === 'draft', 'the profile is still a draft');
    for (const p of [`verification_requests/${uid}`, `artisans/${uid}/private/kyc`, `artisans/${uid}/private/contact`, `artisans/${uid}/private/location`])
        assert((await readBack(p)) === null, `${p} landed without the rest`);
});

await it('the old page\'s way — the same documents one at a time — could leave "under review" with no request', async () => {
    // What the batch replaces: write by write, the profile is accepted and the
    // request refused, so the account says it is under review and no reviewer
    // has anything to review. (Here: a request already decided — a stale tab.)
    const uid = 'ob_partial';
    await seed({ [`artisans/${uid}`]: signupProfile(uid), [`verification_requests/${uid}`]: { artisanId: uid, status: 'approved', verificationStatus: 'approved' } });
    const writes = submission(uid);
    const db = client(uid);
    await assertSucceeds(setDoc(doc(db, 'artisans', uid), writes.find((w) => w.path === 'artisans').data, { merge: true }));
    await assertFails(setDoc(doc(db, 'verification_requests', uid), writes.find((w) => w.path === 'verification_requests').data, { merge: true }));
    // The batch refuses the whole thing instead.
    const uid2 = 'ob_partial_batch';
    await seed({ [`artisans/${uid2}`]: signupProfile(uid2), [`verification_requests/${uid2}`]: { artisanId: uid2, status: 'approved', verificationStatus: 'approved' } });
    await assertFails(commit(client(uid2), submission(uid2)));
    assert((await readBack(`artisans/${uid2}`)).verificationStatus === 'draft', 'the profile did not move without its request');
});

await it('every step\'s draft is accepted with a verified email, and changes no state', async () => {
    const uid = 'ob_drafts';
    await seed({ [`artisans/${uid}`]: signupProfile(uid) });
    const db = client(uid);
    for (const step of ['you', 'identity', 'work', 'payout']) {
        const { writes, held } = ob.draftWrites(step, { uid, email: `${uid}@example.com`, v: values(), emailVerified: true, nowIso: NOW });
        assert(!held && writes.length, `${step} has writes`);
        for (const w of writes) await assertSucceeds(setDoc(doc(db, w.path, w.id), w.data, { merge: true }));
    }
    const p = await readBack(`artisans/${uid}`);
    assert(p.verificationStatus === 'draft' && p.status === 'pending', 'still a draft');
    assert((await readBack(`verification_requests/${uid}`)) === null, 'no request until it is sent');
    const k = await readBack(`artisans/${uid}/private/kyc`);
    assert(k.ghanaCardNumber === 'GHA-123456789-0' && k.payoutAccount.provider === 'mtn' && k.dob === '1990-04-12', 'the identity record is resumable');
});

await it('unverified: "About you" and "Your work" are saved; the identity record is held, and the rules agree it must be', async () => {
    const uid = 'ob_drafts_unverified';
    await seed({ [`artisans/${uid}`]: signupProfile(uid) });
    const db = client(uid, false);
    for (const step of ['you', 'work']) {
        const { writes } = ob.draftWrites(step, { uid, email: `${uid}@example.com`, v: values(), emailVerified: false, nowIso: NOW });
        for (const w of writes) await assertSucceeds(setDoc(doc(db, w.path, w.id), w.data, { merge: true }));
    }
    const held = ob.draftWrites('identity', { uid, v: values(), emailVerified: false, nowIso: NOW });
    assert(held.held && held.writes.length === 0, 'the module holds it');
    const would = ob.draftWrites('identity', { uid, v: values(), emailVerified: true, nowIso: NOW }).writes[0];
    await assertFails(setDoc(doc(db, would.path, would.id), would.data, { merge: true }));
});

await it('rejected: the application can be sent again; the old request shape (status only) is refused', async () => {
    const uid = 'ob_rejected';
    await seed({
        [`artisans/${uid}`]: signupProfile(uid, { verificationStatus: 'rejected', isVerified: false, rejectionReason: 'The card photo is blurred.' }),
        [`verification_requests/${uid}`]: { artisanId: uid, name: 'Kofi Boateng', status: 'rejected', verificationStatus: 'rejected',
            rejectionReason: 'The card photo is blurred.', rejectedBy: 'reviewer@example.com', documents: { idFront: 'old-f', idBack: 'old-b' } },
        [`artisans/${uid}/private/kyc`]: { artisanId: uid, ghanaCardNumber: 'GHA-123456789-0', updatedAt: NOW },
    });
    const writes = submission(uid);
    const oldShape = writes.map((w) => (w.path !== 'verification_requests' ? w
        : { ...w, data: Object.fromEntries(Object.entries(w.data).filter(([k]) => k !== 'verificationStatus')) }));
    await assertFails(commit(client(uid), oldShape));
    await assertSucceeds(commit(client(uid), writes));
    const r = await readBack(`verification_requests/${uid}`);
    assert(r.status === 'pending_review' && r.verificationStatus === 'pending_review', 'sent again for review');
    assert(r.documents.idFront === DOC_URLS.idFront, 'the new documents replace the old');
});

await it('re-verification of an ACTIVE artisan: accepted, and status stays active (the old page\'s status write is refused)', async () => {
    const uid = 'ob_reverify';
    await seed({
        [`artisans/${uid}`]: signupProfile(uid, { status: 'active', verificationStatus: 're_verification_required' }),
        [`verification_requests/${uid}`]: { artisanId: uid, status: 're_verification_required', verificationStatus: 're_verification_required', infoRequestNotes: 'Add the back of the card.' },
        [`artisans/${uid}/private/kyc`]: { artisanId: uid, ghanaCardNumber: 'GHA-123456789-0', payoutAccount: { provider: 'mtn', phone: '0240000000', accountName: 'Kofi' }, updatedAt: NOW },
    });
    const writes = submission(uid);
    const withStatus = writes.map((w) => (w.path === 'artisans' ? { ...w, data: { ...w.data, status: 'pending' } } : w));
    await assertFails(commit(client(uid), withStatus));
    await assertSucceeds(commit(client(uid), writes));
    const p = await readBack(`artisans/${uid}`);
    assert(p.status === 'active' && p.verificationStatus === 'pending_review', JSON.stringify([p.status, p.verificationStatus]));
});

await it('under review: sending again is refused (no duplicate submission)', async () => {
    const uid = 'ob_twice';
    await seed({ [`artisans/${uid}`]: signupProfile(uid) });
    await assertSucceeds(commit(client(uid), submission(uid)));
    await assertFails(commit(client(uid), submission(uid)));
    await assertFails(commit(client(uid), submission(uid, values({ firstName: 'Kwame' }))));
});

await it('approved: a submission is refused, and the module never asks for approval', async () => {
    const uid = 'ob_approved';
    await seed({
        [`artisans/${uid}`]: signupProfile(uid, { status: 'active', verificationStatus: 'approved', isVerified: true }),
        [`verification_requests/${uid}`]: { artisanId: uid, status: 'approved', verificationStatus: 'approved' },
    });
    await assertFails(commit(client(uid), submission(uid)));
    const writes = submission('x');
    assert(!JSON.stringify(writes).includes('approved') && !JSON.stringify(writes).includes('isVerified'), 'no write names approval');
});

await it('a customer account cannot send an artisan application (role isolation)', async () => {
    const uid = 'ob_customer';
    await seed({ [`customers/${uid}`]: { id: uid, userType: 'customer', name: 'Ama' } });
    await assertFails(commit(client(uid), submission(uid)));
});

await it('"Other": the service request is created once and never updated by the artisan — so it stays outside the batch', async () => {
    const uid = 'ob_other';
    await seed({ [`artisans/${uid}`]: signupProfile(uid) });
    const v = values({ trade: 'Other', otherDesc: 'Solar inverter installation', otherBucket: 'Electrical' });
    await assertSucceeds(commit(client(uid), ob.submissionWrites({ uid, email: `${uid}@example.com`, v, docUrls: DOC_URLS, nowIso: NOW })));
    const sr = ob.serviceRequestWrite({ uid, v, nowIso: NOW });
    await assertSucceeds(setDoc(doc(client(uid), sr.path, sr.id), sr.data));
    await assertFails(setDoc(doc(client(uid), sr.path, sr.id), sr.data));
    const p = await readBack(`artisans/${uid}`);
    assert(p.category === 'Electrical' && p.requestedService === 'Solar inverter installation', 'dispatch trade + description');
});

console.log('\nONBOARDING — documents under their fixed names (storage.rules)\n');

const storage = (uid) => testEnv.authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: true }).storage();
await it('the owner stores a Ghana Card photo or PDF under its fixed name', async () => {
    await assertSucceeds(uploadString(ref(storage('ob_files'), ob.docPath('ob_files', 'idFront')), 'x', 'raw', { contentType: 'image/jpeg' }));
    await assertSucceeds(uploadString(ref(storage('ob_files'), ob.docPath('ob_files', 'cert')), 'x', 'raw', { contentType: 'application/pdf' }));
});
await it('another account cannot store into it; a non-image, non-PDF file is refused', async () => {
    await assertFails(uploadString(ref(storage('ob_other_artisan'), ob.docPath('ob_files', 'idBack')), 'x', 'raw', { contentType: 'image/jpeg' }));
    await assertFails(uploadString(ref(storage('ob_files'), ob.docPath('ob_files', 'idBack')), 'x', 'raw', { contentType: 'text/html' }));
});

console.log('\n' + '─'.repeat(52));
console.log(`  ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');
await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);
