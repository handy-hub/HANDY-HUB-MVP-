/**
 * Who may read and write what — location, offers, customer contact, artisan
 * applications and support requests. Runs the real firestore.rules in the
 * emulator with genuine client contexts. (2026-10-19 artisan audit)
 *
 *   AR-03  the public artisan profile carries ~1 km and nothing live; the
 *          precise fix is private; a job's live position opens only to that
 *          job's two parties, only while the job is under way.
 *   AR-06  an offered artisan reads the offer summary, never the booking; the
 *          offer closes to them once declined or expired; the customer's phone
 *          opens to the assigned artisan for the committed, funded stretch of
 *          the job only; nobody but the server can accept for an artisan.
 *   AR-09  KYC, the verification request and "submit for review" need a
 *          verified email.
 *   AR-11  support tickets are the owner's and support staff's alone, in an
 *          honest shape, and the thread is an append-only record.
 *
 * The server half (dispatch, respondToJobOffer, ensureArtisanProfile,
 * approveArtisan) is tests/privacy-access.test.cjs.
 *
 * Run:  npm run test:access-rules
 */

import './support/no-production.cjs';   // must stay the first statement (npm run lint:tests)
import {
    initializeTestEnvironment,
    assertFails,
    assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
    setDoc, updateDoc, doc, getDoc, getDocs, addDoc, collection, query, where, limit,
} from 'firebase/firestore';

const PROJECT_ID = 'lamax-rules-test';
const A  = 'artisan_a';           // approved, the job's artisan
const B  = 'artisan_b';           // approved, a different artisan
const U  = 'artisan_unverified';  // a new applicant
const C1 = 'customer_1';          // the booking's customer
const C2 = 'customer_2';          // someone else's customer
const ADMIN   = 'admin_plain';    // admin, no support role
const SUPPORT = 'admin_support';  // admin with the support_admin role

const NOW = '2026-10-20T09:00:00.000Z';
const PRECISE = { lat: 5.603716, lng: -0.186964 };

let passed = 0, failed = 0;
async function it(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (err) { console.log(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`); failed++; }
}

const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});

function profile(uid, over = {}) {
    return {
        // No email: since CONTACT-001 a public profile carries no contact fields.
        id: uid, uid, name: 'Kofi Boateng', fullName: 'Kofi Boateng',
        userType: 'artisan', status: 'active', verificationStatus: 'approved', category: 'plumbing',
        isOnline: false, isAvailable: true, rating: 0, reviewCount: 0,
        availableBalance: 0, pendingBalance: 0, totalEarned: 0, withdrawnTotal: 0,
        lat: 5.6, lng: -0.19, geohash: 's0rk3',
        createdAt: NOW, updatedAt: NOW, ...over,
    };
}
const booking = (status, over = {}) => ({
    customerId: C1, artisanId: A, status, type: 'standard', serviceType: 'plumbing',
    address: '12 Ring Road East, Osu', notes: 'Gate code 4471', lat: 5.621234, lng: -0.173456,
    createdAt: NOW, updatedAt: NOW, ...over,
});

const STATES = ['pending', 'accepted', 'inspection_scheduled', 'en_route', 'in_progress',
                'inspection_done', 'quoted', 'awaiting', 'completed', 'cancelled', 'rejected', 'disputed'];
const CONTACT_OPEN = ['accepted', 'inspection_scheduled', 'en_route', 'in_progress',
                      'inspection_done', 'quoted', 'awaiting'];
const LIVE_OPEN = ['en_route', 'in_progress'];

await testEnv.clearFirestore();
await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'artisans', A), profile(A));
    await setDoc(doc(db, 'artisans', B), profile(B));
    await setDoc(doc(db, 'artisans', U), profile(U, { status: 'pending', verificationStatus: 'draft', isAvailable: false }));
    await setDoc(doc(db, 'artisans', A, 'private', 'location'), { ...PRECISE, accuracy: 6, source: 'browser_gps', updatedAt: NOW });
    for (const c of [C1, C2]) {
        await setDoc(doc(db, 'customers', c), {
            name: 'Customer', email: `${c}@example.com`, userType: 'customer', status: 'active',
            walletBalance: 0, escrowBalance: 0, spent: 0, bookings: 0,
        });
    }
    await setDoc(doc(db, 'admins', ADMIN),   { userType: 'admin', email: 'ops@example.com' });
    await setDoc(doc(db, 'admins', SUPPORT), { userType: 'admin', email: 'help@example.com', role: 'support_admin' });
    await setDoc(doc(db, 'artisan_index', A), { artisanId: A, ...PRECISE });

    for (const s of STATES) {
        await setDoc(doc(db, 'bookings', `BK-${s}`), booking(s));
        await setDoc(doc(db, 'bookings', `BK-${s}`, 'private', 'contact'), { bookingId: `BK-${s}`, customerId: C1, customerPhone: '+233241111111' });
        await setDoc(doc(db, 'bookings', `BK-${s}`, 'private', 'artisanContact'), { bookingId: `BK-${s}`, artisanId: A, artisanPhone: '+233209999999' });
        await setDoc(doc(db, 'bookings', `BK-${s}`, 'live', 'artisan'), { artisanId: A, ...PRECISE, accuracy: 6, updatedAt: NOW });
    }
    for (const [id, paid] of [['BK-INSP-UNPAID', false], ['BK-INSP-PAID', true]]) {
        await setDoc(doc(db, 'bookings', id), booking('accepted', { track: 'inspection', calloutPaid: paid }));
        await setDoc(doc(db, 'bookings', id, 'private', 'contact'), { bookingId: id, customerId: C1, customerPhone: '+233241111111' });
        await setDoc(doc(db, 'bookings', id, 'private', 'artisanContact'), { bookingId: id, artisanId: A, artisanPhone: '+233209999999' });
    }

    // An open offer to A: the booking does not name A until A accepts.
    await setDoc(doc(db, 'bookings', 'BK-OFFER'), booking('pending', { artisanId: null, currentArtisanId: A }));
    await setDoc(doc(db, 'bookings', 'BK-OFFER', 'private', 'contact'), { bookingId: 'BK-OFFER', customerId: C1, customerPhone: '+233241111111' });
    const offer = (status) => ({ bookingId: 'x', artisanId: A, offerStatus: status, status: 'pending',
        serviceType: 'plumbing', description: 'Leaking pipe', lat: 5.62, lng: -0.17, locationApproximate: true,
        distanceKm: 2.3, expiresAtMs: Date.now() + 60000, offeredAt: NOW });
    await setDoc(doc(db, 'job_offers', 'BK-OFFER'),    offer('open'));
    await setDoc(doc(db, 'job_offers', 'BK-DECLINED'), offer('declined'));
    await setDoc(doc(db, 'job_offers', 'BK-EXPIRED'),  offer('expired'));
    await setDoc(doc(db, 'job_offers', 'BK-TAKEN'),    offer('accepted'));

    const ticket = (status) => ({ userId: A, userName: 'Kofi', userEmail: `${A}@example.com`, role: 'artisan',
        subject: 'payment', message: 'My withdrawal has not arrived since Monday.', status, createdAt: NOW, updatedAt: NOW });
    await setDoc(doc(db, 'support_tickets', 'T-OPEN'),     ticket('open'));
    await setDoc(doc(db, 'support_tickets', 'T-ANSWERED'), ticket('answered'));
    await setDoc(doc(db, 'support_tickets', 'T-CLOSED'),   ticket('closed'));
    await setDoc(doc(db, 'support_tickets', 'T-OPEN', 'messages', 'm1'), { authorId: A, authorRole: 'user', body: 'Any news?', createdAt: NOW });
});

// One firestore() handle per context (a second call throws).
const ctx = (uid, token) => (uid ? testEnv.authenticatedContext(uid, token) : testEnv.unauthenticatedContext()).firestore();
const verified = (uid) => ({ email: `${uid}@example.com`, email_verified: true });
const anon = ctx(null);
const a  = ctx(A, verified(A));
const b  = ctx(B, verified(B));
const c1 = ctx(C1, verified(C1));
const c2 = ctx(C2, verified(C2));
const admin   = ctx(ADMIN,   { email: 'ops@example.com',  email_verified: true });
const support = ctx(SUPPORT, { email: 'help@example.com', email_verified: true });
const uNo  = ctx(U, { email: `${U}@example.com`, email_verified: false });
const uYes = testEnv.authenticatedContext(U, verified(U)).firestore();

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nAR-03 · the public profile is ~1 km, nothing live\n');

await it('an artisan cannot publish a precise position on their profile', async () => {
    await assertFails(updateDoc(doc(a, 'artisans', A), { ...PRECISE, updatedAt: NOW }));
    await assertFails(updateDoc(doc(a, 'artisans', A), { latitude: PRECISE.lat, longitude: PRECISE.lng, updatedAt: NOW }));
});
await it('an artisan cannot publish live coordinates or a fine geohash', async () => {
    await assertFails(updateDoc(doc(a, 'artisans', A), { currentLat: PRECISE.lat, currentLng: PRECISE.lng, updatedAt: NOW }));
    await assertFails(updateDoc(doc(a, 'artisans', A), { locationAccuracy: 6, updatedAt: NOW }));
    await assertFails(updateDoc(doc(a, 'artisans', A), { geohash: 's0rk3w5q2', updatedAt: NOW }));
});
await it('the presence write (coarse, live fields cleared) is accepted', async () => {
    await assertSucceeds(updateDoc(doc(a, 'artisans', A), {
        lat: 5.6, lng: -0.19, latitude: 5.6, longitude: -0.19, geohash: 's0rk3',
        currentLat: null, currentLng: null, locationAccuracy: null,
        isOnline: true, lastActive: NOW, updatedAt: NOW,
    }));
});
await it('a new profile cannot be created with a precise position', async () => {
    const n = ctx('artisan_new', verified('artisan_new'));
    await assertFails(setDoc(doc(n, 'artisans', 'artisan_new'),
        profile('artisan_new', { status: 'pending', verificationStatus: 'draft', ...PRECISE })));
    await assertSucceeds(setDoc(doc(n, 'artisans', 'artisan_new'),
        profile('artisan_new', { status: 'pending', verificationStatus: 'draft' })));
});
await it('the precise fix is readable by the artisan and admins only', async () => {
    const p = (db) => getDoc(doc(db, 'artisans', A, 'private', 'location'));
    await assertSucceeds(p(a));
    await assertSucceeds(p(admin));
    await assertFails(p(b));
    await assertFails(p(c1));
    await assertFails(p(anon));
});
await it('the artisan maintains their own precise fix, in the strict shape', async () => {
    const r = (db, uid = A) => doc(db, 'artisans', uid, 'private', 'location');
    await assertSucceeds(setDoc(r(a), { ...PRECISE, accuracy: 9, source: 'browser_gps', updatedAt: NOW }, { merge: true }));
    await assertFails(setDoc(r(a), { ...PRECISE, address: '12 Ring Road' }, { merge: true }));
    await assertFails(setDoc(r(b), { ...PRECISE, updatedAt: NOW }));
    await assertFails(setDoc(r(c1, C1), { ...PRECISE, updatedAt: NOW }), 'a customer is not an artisan');
});
await it('the dispatch index is server-only', async () => {
    await assertFails(getDoc(doc(c1, 'artisan_index', A)));
    await assertFails(getDoc(doc(a, 'artisan_index', A)));
    await assertFails(setDoc(doc(a, 'artisan_index', A), { artisanId: A, lat: 0, lng: 0 }));
});

console.log('\nAR-03 · a job\'s live position, by booking state\n');

for (const s of STATES) {
    const open = LIVE_OPEN.includes(s);
    await it(`${s}: live position ${open ? 'readable by the customer and the artisan only' : 'readable by nobody but admins'}`, async () => {
        const live = (db) => getDoc(doc(db, 'bookings', `BK-${s}`, 'live', 'artisan'));
        if (open) { await assertSucceeds(live(c1)); await assertSucceeds(live(a)); }
        else      { await assertFails(live(c1));    await assertFails(live(a)); }
        await assertFails(live(c2));
        await assertFails(live(b));
        await assertSucceeds(live(admin));
    });
}
await it('only the booking\'s artisan writes the live position, only while under way', async () => {
    const w = (db, s) => setDoc(doc(db, 'bookings', `BK-${s}`, 'live', 'artisan'),
        { artisanId: A, ...PRECISE, accuracy: 5, updatedAt: NOW });
    await assertSucceeds(w(a, 'en_route'));
    await assertSucceeds(w(a, 'in_progress'));
    await assertFails(w(a, 'accepted'));
    await assertFails(w(a, 'completed'));
    await assertFails(w(b, 'en_route'));
    await assertFails(w(c1, 'en_route'));
    await assertFails(setDoc(doc(a, 'bookings', 'BK-en_route', 'live', 'artisan'),
        { artisanId: A, ...PRECISE, updatedAt: NOW, address: 'x' }), 'strict shape');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nAR-06 · an offer is a summary; the booking stays closed until acceptance\n');

await it('the offered artisan reads their open offer; nobody else does', async () => {
    const o = (db) => getDoc(doc(db, 'job_offers', 'BK-OFFER'));
    await assertSucceeds(o(a));
    await assertFails(o(b));
    await assertFails(o(c1));
    await assertFails(o(anon));
    await assertSucceeds(o(admin));
});
await it('the dashboard query (my open offers) is allowed; a broader one is not', async () => {
    await assertSucceeds(getDocs(query(collection(a, 'job_offers'),
        where('artisanId', '==', A), where('offerStatus', '==', 'open'), limit(5))));
    await assertFails(getDocs(query(collection(a, 'job_offers'), where('artisanId', '==', A))));
    await assertFails(getDocs(collection(b, 'job_offers')));
});
await it('a declined, expired or accepted offer closes to the artisan', async () => {
    for (const id of ['BK-DECLINED', 'BK-EXPIRED', 'BK-TAKEN']) {
        await assertFails(getDoc(doc(a, 'job_offers', id)));
    }
});
await it('nobody can write an offer from a client — accepting is respondToJobOffer\'s decision', async () => {
    await assertFails(updateDoc(doc(a, 'job_offers', 'BK-OFFER'), { offerStatus: 'accepted' }));
    await assertFails(updateDoc(doc(a, 'job_offers', 'BK-DECLINED'), { offerStatus: 'open' }));
    await assertFails(setDoc(doc(b, 'job_offers', 'BK-NEW'), { artisanId: B, offerStatus: 'open' }));
});
await it('an offered artisan cannot read the booking, its address, or its contact', async () => {
    await assertFails(getDoc(doc(a, 'bookings', 'BK-OFFER')));
    await assertFails(getDoc(doc(a, 'bookings', 'BK-OFFER', 'private', 'contact')));
    await assertFails(getDocs(query(collection(a, 'bookings'), where('currentArtisanId', '==', A))));
});
await it('an offered artisan cannot accept or claim the booking from the browser', async () => {
    await assertFails(updateDoc(doc(a, 'bookings', 'BK-OFFER'), { status: 'accepted', acceptedAt: NOW, updatedAt: NOW }));
    await assertFails(updateDoc(doc(a, 'bookings', 'BK-OFFER'), { artisanId: A, updatedAt: NOW }));
});
await it('the booking\'s own artisan reads their job list (artisanId == me)', async () => {
    await assertSucceeds(getDocs(query(collection(a, 'bookings'), where('artisanId', '==', A))));
    await assertFails(getDocs(query(collection(b, 'bookings'), where('artisanId', '==', A))));
});

console.log('\nAR-06 · a customer names an artisan; only the server assigns one\n');

const newBooking = (over = {}) => ({
    customerId: C1, status: 'pending', type: 'standard', serviceType: 'plumbing',
    address: '12 Ring Road East', createdAt: NOW, updatedAt: NOW, ...over,
});
await it('a customer cannot create a booking that names its artisanId', async () => {
    await assertFails(setDoc(doc(c1, 'bookings', 'BK-N1'), newBooking({ artisanId: A })));
    await assertFails(setDoc(doc(c1, 'bookings', 'BK-N2'), newBooking({ requestedArtisanId: A, currentArtisanId: A })));
});
await it('a standard booking names the requested artisan; an emergency may not', async () => {
    await assertSucceeds(setDoc(doc(c1, 'bookings', 'BK-N3'), newBooking({ requestedArtisanId: A, artisanId: null })));
    await assertFails(setDoc(doc(c1, 'bookings', 'BK-N4'), newBooking()));
    await assertSucceeds(setDoc(doc(c1, 'bookings', 'BK-N5'), newBooking({ type: 'emergency', bookingType: 'emergency', artisanId: null })));
});
await it('a requested artisan cannot read the new booking before accepting', async () => {
    await assertFails(getDoc(doc(a, 'bookings', 'BK-N3')));
});

console.log('\nAR-06 · the customer\'s phone, by booking state\n');

for (const s of STATES) {
    const open = CONTACT_OPEN.includes(s);
    await it(`${s}: the assigned artisan ${open ? 'CAN' : 'can NOT'} read the phone; strangers never`, async () => {
        const c = (db) => getDoc(doc(db, 'bookings', `BK-${s}`, 'private', 'contact'));
        if (open) await assertSucceeds(c(a)); else await assertFails(c(a));
        await assertSucceeds(c(c1));
        await assertFails(c(c2));
        await assertFails(c(b));
        await assertSucceeds(c(admin));
    });
}
await it('an inspection the customer has not funded keeps the phone closed', async () => {
    await assertFails(getDoc(doc(a, 'bookings', 'BK-INSP-UNPAID', 'private', 'contact')));
    await assertSucceeds(getDoc(doc(a, 'bookings', 'BK-INSP-PAID', 'private', 'contact')));
});
await it('nobody writes the contact record from a client', async () => {
    await assertFails(setDoc(doc(c1, 'bookings', 'BK-accepted', 'private', 'contact'), { customerPhone: '+233200000000' }, { merge: true }));
    await assertFails(setDoc(doc(a, 'bookings', 'BK-accepted', 'private', 'contact'), { customerPhone: '+233200000000' }, { merge: true }));
    await assertFails(getDoc(doc(a, 'bookings', 'BK-accepted', 'private', 'other')), 'only the contact doc is defined');
});
await it('another customer cannot read someone else\'s booking', async () => {
    await assertFails(getDoc(doc(c2, 'bookings', 'BK-accepted')));
    await assertFails(getDoc(doc(b, 'bookings', 'BK-accepted')));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nAR-09 · applying needs a verified email\n');

const kyc = { artisanId: U, ghanaCardNumber: 'GHA-123456789-0', updatedAt: NOW };
await it('an unverified account cannot write KYC; a verified one can', async () => {
    await assertFails(setDoc(doc(uNo, 'artisans', U, 'private', 'kyc'), kyc));
    await assertSucceeds(setDoc(doc(uYes, 'artisans', U, 'private', 'kyc'), kyc));
    await assertFails(setDoc(doc(uNo, 'artisans', U, 'private', 'kyc'), { ...kyc, tin: 'C001' }, { merge: true }));
});
await it('an unverified account cannot open a verification request', async () => {
    const r = { artisanId: U, status: 'pending_review', submittedAt: NOW };
    await assertFails(setDoc(doc(uNo, 'verification_requests', U), r));
    await assertSucceeds(setDoc(doc(uYes, 'verification_requests', U), r));
    await assertFails(updateDoc(doc(uNo, 'verification_requests', U), { bio: 'x', updatedAt: NOW }));
});
await it('an unverified account may save a draft but not submit it for review', async () => {
    await assertSucceeds(updateDoc(doc(uNo, 'artisans', U), { bio: 'Plumber', verificationStatus: 'draft', updatedAt: NOW }));
    await assertFails(updateDoc(doc(uNo, 'artisans', U), { verificationStatus: 'pending_review', updatedAt: NOW }));
    await assertSucceeds(updateDoc(doc(uYes, 'artisans', U), { verificationStatus: 'pending_review', updatedAt: NOW }));
});
await it('no client may approve an artisan, verified or not', async () => {
    await assertFails(updateDoc(doc(uYes, 'artisans', U), { verificationStatus: 'approved', updatedAt: NOW }));
    await assertFails(updateDoc(doc(uYes, 'artisans', U), { status: 'active', updatedAt: NOW }));
    await assertFails(updateDoc(doc(admin, 'artisans', U), { verificationStatus: 'approved', updatedAt: NOW }));
});
await it('a profile cannot be CREATED active or approved', async () => {
    const id = 'artisan_selfmade';
    const n = ctx(id, verified(id));
    await assertFails(setDoc(doc(n, 'artisans', id), profile(id)), 'active + approved');
    await assertFails(setDoc(doc(n, 'artisans', id), profile(id, { status: 'active', verificationStatus: 'draft' })));
    await assertFails(setDoc(doc(n, 'artisans', id), profile(id, { status: 'pending', verificationStatus: 'approved' })));
    await assertSucceeds(setDoc(doc(n, 'artisans', id), profile(id, { status: 'pending', verificationStatus: 'draft' })));
});
await it('an unverified account cannot create a profile already in review', async () => {
    const id = 'artisan_selfmade2';
    await assertFails(setDoc(doc(ctx(id, { email: `${id}@example.com`, email_verified: false }), 'artisans', id),
        profile(id, { status: 'pending', verificationStatus: 'pending_review' })));
});
await it('an approved artisan cannot step out of approval to unfreeze their payout account', async () => {
    // The chain this closes: approved → draft (payout freeze lifts) → new
    // payout account → approved again, with status 'active' throughout.
    await assertFails(updateDoc(doc(a, 'artisans', A), { verificationStatus: 'draft', updatedAt: NOW }));
    await assertFails(updateDoc(doc(a, 'artisans', A), { verificationStatus: 'pending_review', updatedAt: NOW }));
    await assertFails(setDoc(doc(a, 'artisans', A, 'private', 'kyc'),
        { artisanId: A, payoutAccount: { provider: 'mtn', phone: '0249999999', accountName: 'Someone Else' } }, { merge: true }));
});
await it('a re-verification request can be answered, not dismissed', async () => {
    const id = 'artisan_reverify';
    await testEnv.withSecurityRulesDisabled((x) =>
        setDoc(doc(x.firestore(), 'artisans', id), profile(id, { verificationStatus: 're_verification_required' })));
    const r = ctx(id, verified(id));
    await assertFails(updateDoc(doc(r, 'artisans', id), { verificationStatus: 'approved', updatedAt: NOW }));
    await assertSucceeds(updateDoc(doc(r, 'artisans', id), { verificationStatus: 'pending_review', updatedAt: NOW }));
});
await it('suspended and banned verification states are not the artisan\'s to change', async () => {
    for (const v of ['suspended', 'banned', 'rejected']) {
        const id = `artisan_${v}`;
        await testEnv.withSecurityRulesDisabled((x) =>
            setDoc(doc(x.firestore(), 'artisans', id), profile(id, { verificationStatus: v, status: v === 'rejected' ? 'pending' : v })));
        const r = ctx(id, verified(id));
        await assertFails(updateDoc(doc(r, 'artisans', id), { verificationStatus: 'approved', updatedAt: NOW }));
        if (v === 'rejected') await assertSucceeds(updateDoc(doc(r, 'artisans', id), { verificationStatus: 'pending_review', updatedAt: NOW }));
        else await assertFails(updateDoc(doc(r, 'artisans', id), { verificationStatus: 'draft', updatedAt: NOW }));
    }
});
await it('a customer account cannot also become an artisan', async () => {
    await assertFails(setDoc(doc(c1, 'artisans', C1), profile(C1, { status: 'pending', verificationStatus: 'draft' })));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nAR-11 · support tickets\n');

const ticket = (over = {}) => ({
    userId: A, userName: 'Kofi', userEmail: `${A}@example.com`, role: 'artisan', subject: 'payment',
    message: 'My withdrawal has not arrived since Monday.', status: 'open', createdAt: NOW, updatedAt: NOW, ...over,
});
await it('the artisan support page\'s ticket is accepted', async () => {
    await assertSucceeds(addDoc(collection(a, 'support_tickets'), ticket()));
});
await it('a customer files a customer ticket; neither side can claim the other role', async () => {
    await assertSucceeds(addDoc(collection(c1, 'support_tickets'), ticket({ userId: C1, role: 'customer' })));
    await assertFails(addDoc(collection(c1, 'support_tickets'), ticket({ userId: C1, role: 'artisan' })));
    await assertFails(addDoc(collection(a, 'support_tickets'), ticket({ role: 'customer' })));
});
await it('a ticket cannot be forged, pre-answered, padded or malformed', async () => {
    await assertFails(addDoc(collection(b, 'support_tickets'), ticket()), 'another user\'s uid');
    await assertFails(addDoc(collection(a, 'support_tickets'), ticket({ status: 'answered' })));
    await assertFails(addDoc(collection(a, 'support_tickets'), ticket({ message: 'help' })));
    await assertFails(addDoc(collection(a, 'support_tickets'), ticket({ message: 'x'.repeat(2001) })));
    await assertFails(addDoc(collection(a, 'support_tickets'), ticket({ subject: 'refund-me' })));
    await assertFails(addDoc(collection(a, 'support_tickets'), ticket({ priority: 'urgent' })));
    await assertFails(addDoc(collection(anon, 'support_tickets'), ticket()));
});
await it('a ticket is read by its owner and support staff only', async () => {
    const r = (db) => getDoc(doc(db, 'support_tickets', 'T-OPEN'));
    await assertSucceeds(r(a));
    await assertSucceeds(r(support));
    await assertFails(r(b));
    await assertFails(r(c1));
    await assertFails(r(admin), 'an admin without the support role');
});
await it('the owner lists their own tickets; nobody lists everyone\'s but support', async () => {
    await assertSucceeds(getDocs(query(collection(a, 'support_tickets'), where('userId', '==', A))));
    await assertFails(getDocs(collection(a, 'support_tickets')));
    await assertSucceeds(getDocs(collection(support, 'support_tickets')));
});
await it('the owner reopens with a follow-up, but cannot answer or close, or touch a closed ticket', async () => {
    const reopen = { status: 'open', lastReplyAt: NOW, lastReplyBy: 'user', updatedAt: NOW };
    await assertSucceeds(updateDoc(doc(a, 'support_tickets', 'T-ANSWERED'), reopen));
    await assertFails(updateDoc(doc(a, 'support_tickets', 'T-OPEN'), { status: 'answered', updatedAt: NOW }));
    await assertFails(updateDoc(doc(a, 'support_tickets', 'T-OPEN'), { ...reopen, lastReplyBy: 'support' }));
    await assertFails(updateDoc(doc(a, 'support_tickets', 'T-OPEN'), { ...reopen, message: 'rewritten history' }));
    await assertFails(updateDoc(doc(a, 'support_tickets', 'T-CLOSED'), reopen));
    await assertFails(updateDoc(doc(b, 'support_tickets', 'T-OPEN'), reopen));
});
await it('support staff answer and close, without rewriting the request', async () => {
    await assertSucceeds(updateDoc(doc(support, 'support_tickets', 'T-OPEN'),
        { status: 'answered', lastReplyAt: NOW, lastReplyBy: 'support', updatedAt: NOW }));
    await assertFails(updateDoc(doc(support, 'support_tickets', 'T-OPEN'), { message: 'edited', updatedAt: NOW }));
    await assertFails(updateDoc(doc(admin, 'support_tickets', 'T-OPEN'), { status: 'closed', updatedAt: NOW }));
});
await it('the thread: owner writes as user, support as support, strangers nothing', async () => {
    const m = (db, id, role, uid) => addDoc(collection(db, 'support_tickets', id, 'messages'),
        { authorId: uid, authorRole: role, body: 'Following up on this.', createdAt: NOW });
    await assertSucceeds(m(a, 'T-OPEN', 'user', A));
    await assertFails(m(a, 'T-OPEN', 'support', A), 'an owner cannot speak as support');
    await assertFails(m(a, 'T-CLOSED', 'user', A), 'not on a closed ticket');
    await assertFails(m(b, 'T-OPEN', 'user', B));
    await assertSucceeds(m(support, 'T-OPEN', 'support', SUPPORT));
    await assertFails(m(admin, 'T-OPEN', 'support', ADMIN));
    await assertSucceeds(getDocs(collection(a, 'support_tickets', 'T-OPEN', 'messages')));
    await assertFails(getDocs(collection(b, 'support_tickets', 'T-OPEN', 'messages')));
});
await it('a message is a record: never edited or deleted', async () => {
    await assertFails(updateDoc(doc(a, 'support_tickets', 'T-OPEN', 'messages', 'm1'), { body: 'changed' }));
    await assertFails(updateDoc(doc(support, 'support_tickets', 'T-OPEN', 'messages', 'm1'), { body: 'changed' }));
});
await it('support can tell the user a reply is waiting (the admin page\'s notification)', async () => {
    await assertSucceeds(addDoc(collection(support, 'customer_notifications'), {
        receiverId: A, senderId: SUPPORT, type: 'System', title: 'Support replied to your request',
        message: 'There is a reply to your request about "Payments". Open Support to read it.',
        isRead: false, readAt: null, actionUrl: 'support.html', metadata: { ticketId: 'T-OPEN' }, createdAt: NOW,
    }));
});

console.log('\nCONTACT-001 · the ARTISAN\'s phone, by booking state (the same window in reverse)\n');

for (const s of STATES) {
    const open = CONTACT_OPEN.includes(s);
    await it(`${s}: the booking's customer ${open ? 'CAN' : 'can NOT'} read the artisan's phone; the artisan always; strangers never`, async () => {
        const c = (db) => getDoc(doc(db, 'bookings', `BK-${s}`, 'private', 'artisanContact'));
        if (open) await assertSucceeds(c(c1)); else await assertFails(c(c1));
        await assertSucceeds(c(a));
        await assertFails(c(c2));
        await assertFails(c(b));
        await assertSucceeds(c(admin));
    });
}
await it('an inspection the customer has not funded keeps the artisan\'s phone closed too', async () => {
    await assertFails(getDoc(doc(c1, 'bookings', 'BK-INSP-UNPAID', 'private', 'artisanContact')));
    await assertSucceeds(getDoc(doc(c1, 'bookings', 'BK-INSP-PAID', 'private', 'artisanContact')));
});
await it('nobody writes the artisan-contact record from a client', async () => {
    await assertFails(setDoc(doc(a, 'bookings', 'BK-accepted', 'private', 'artisanContact'), { artisanPhone: '+233200000000' }, { merge: true }));
    await assertFails(setDoc(doc(c1, 'bookings', 'BK-accepted', 'private', 'artisanContact'), { artisanPhone: '+233200000000' }, { merge: true }));
});
await it('a new booking cannot carry a copy of the artisan\'s phone', async () => {
    await assertFails(setDoc(doc(c1, 'bookings', 'BK-P1'), newBooking({ requestedArtisanId: A, artisanId: null, proPhone: '0241234567' })));
    await assertFails(setDoc(doc(c1, 'bookings', 'BK-P2'), newBooking({ requestedArtisanId: A, artisanId: null, artisanPhone: '0241234567' })));
    await assertFails(setDoc(doc(c1, 'bookings', 'BK-P3'), newBooking({ type: 'emergency', bookingType: 'emergency', artisanId: null,
        artisan: { id: A, name: 'Kofi', phone: '0241234567' } })));
    await assertFails(setDoc(doc(c1, 'bookings', 'BK-P4'), newBooking({ type: 'emergency', bookingType: 'emergency', artisanId: null,
        professional: { id: A, name: 'Kofi', phone: 'tel:0241234567' } })));
    // The same summaries without the phone are still accepted.
    await assertSucceeds(setDoc(doc(c1, 'bookings', 'BK-P5'), newBooking({ type: 'emergency', bookingType: 'emergency', artisanId: null,
        artisan: { id: A, name: 'Kofi' }, professional: { id: A, name: 'Kofi' } })));
});

console.log('\n' + '─'.repeat(52));
console.log(`  ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');

await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);
