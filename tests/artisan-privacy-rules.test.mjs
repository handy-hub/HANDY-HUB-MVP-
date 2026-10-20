/**
 * Artisan private data — who can read an artisan's identity, payout and home
 * address. Runs the real firestore.rules AND storage.rules in the emulators.
 *
 * WHY THIS EXISTS
 * artisans/{id} is readable by every signed-in account, and anyone can open a
 * customer account. Onboarding used to put the Ghana Card number, TIN, date of
 * birth, residential address, Ghana Post GPS code, emergency contact and MoMo
 * payout account into that document, so every artisan's identity was one
 * getDocs() away from any stranger. Firestore rules cannot hide fields from a
 * reader, so the fix is structural: those fields live in
 * artisans/{id}/private/kyc and cannot be written to the public profile.
 *
 * These tests prove the boundary with genuine client contexts rather than by
 * reading the rules: strangers, customers and other artisans are refused; the
 * artisan and administrators keep exactly what they need; and the public
 * profile still serves discovery and booking.
 *
 * Run:  npm run test:privacy-rules
 */

import {
    initializeTestEnvironment,
    assertFails,
    assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
    setDoc, updateDoc, doc, getDoc, getDocs, collection, collectionGroup, query, where,
} from 'firebase/firestore';
import { ref, uploadString, getMetadata } from 'firebase/storage';

const PROJECT_ID = 'lamax-rules-test';
const ARTISAN_A  = 'artisan_a';
const ARTISAN_B  = 'artisan_b';
const CUSTOMER   = 'customer_c';
const ADMIN      = 'admin_d';                // admins/{uid} with userType 'admin'
const SUPER      = 'super_e';                // super-admin by email (Storage admin)
const SUPER_EMAIL = 'silas7korda@gmail.com'; // one of the rules' super-admin emails

const KYC = {
    artisanId:        ARTISAN_A,
    ghanaCardNumber:  'GHA-123456789-0',
    tin:              'C0012345678',
    dob:              '1990-04-12',
    address:          '12 Example Street, Accra',
    gpsAddress:       'GA-123-4567',
    emergencyContact: { name: 'Ama Mensah', phone: '0240000000' },
    payoutAccount:    { provider: 'mtn', phone: '0241111111', accountName: 'Kofi Boateng' },
    updatedAt:        '2026-10-19T10:00:00.000Z',
};

// The public profile exactly as functions/emailOtp.js (signUpArtisanDirect) writes it.
function signupProfile(uid) {
    return {
        id: uid, uid, name: 'Kofi Boateng', fullName: 'Kofi Boateng',
        email: `${uid}@example.com`, phone: '0201234567',
        userType: 'artisan', status: 'pending', category: 'plumbing', specialty: 'plumbing',
        verificationStatus: 'draft', emailVerified: true, isOnline: false, isAvailable: false,
        rating: 0, reviewCount: 0, jobsCompleted: 0, completionRate: 0, responseRate: 0,
        availableBalance: 0, pendingBalance: 0, totalEarned: 0, withdrawnTotal: 0, walletBalance: 0,
        createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    };
}

let passed = 0, failed = 0;
async function it(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (err) { console.log(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`); failed++; }
}

const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
    storage:   { rules: readFileSync('storage.rules',   'utf8'), host: '127.0.0.1', port: 9199 },
});

async function seed() {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await setDoc(doc(db, 'artisans', ARTISAN_A), signupProfile(ARTISAN_A));
        await setDoc(doc(db, 'artisans', ARTISAN_B), signupProfile(ARTISAN_B));
        await setDoc(doc(db, 'artisans', ARTISAN_A, 'private', 'kyc'), KYC);
        await setDoc(doc(db, 'artisans', ARTISAN_B, 'private', 'kyc'), { ...KYC, artisanId: ARTISAN_B });
        await setDoc(doc(db, 'customers', CUSTOMER), {
            name: 'Customer', email: 'c@example.com', userType: 'customer', status: 'active',
            walletBalance: 0, escrowBalance: 0, spent: 0, bookings: 0,
        });
        await setDoc(doc(db, 'admins', ADMIN), { userType: 'admin', email: 'ops@example.com' });

        const st = ctx.storage();
        await uploadString(ref(st, `artisans/${ARTISAN_A}/documents/idFront.jpg`), 'JPEG', 'raw', { contentType: 'image/jpeg' });
        await uploadString(ref(st, `artisans/${ARTISAN_A}/profile/photo.jpg`),     'JPEG', 'raw', { contentType: 'image/jpeg' });
    });
}

await seed();

// A context's firestore()/storage() may only be created once — a second call
// re-applies settings to a started instance and throws. Create each handle
// once and reuse it, as tests/firestore-rules.test.mjs does.
function client(ctx) {
    const fs = ctx.firestore();
    const st = ctx.storage();
    return { firestore: () => fs, storage: () => st };
}
function newArtisan(uid) {
    return client(testEnv.authenticatedContext(uid, { email: `${uid}@example.com` }));
}

const anon     = client(testEnv.unauthenticatedContext());
const customer = client(testEnv.authenticatedContext(CUSTOMER, { email: 'c@example.com' }));
const artisanA = newArtisan(ARTISAN_A);
const artisanB = newArtisan(ARTISAN_B);
const admin    = client(testEnv.authenticatedContext(ADMIN, { email: 'ops@example.com' }));
const superAdm = client(testEnv.authenticatedContext(SUPER, { email: SUPER_EMAIL }));

const privA = (ctx) => doc(ctx.firestore(), 'artisans', ARTISAN_A, 'private', 'kyc');
const pubA  = (ctx) => doc(ctx.firestore(), 'artisans', ARTISAN_A);

console.log('\nARTISAN PRIVACY — Firestore: who can read the private record\n');

await it('an unauthenticated visitor cannot read an artisan\'s private record', async () => {
    await assertFails(getDoc(privA(anon)));
});
await it('a signed-in customer cannot read an artisan\'s private record', async () => {
    await assertFails(getDoc(privA(customer)));
});
await it('a customer cannot list an artisan\'s private subcollection', async () => {
    await assertFails(getDocs(collection(customer.firestore(), 'artisans', ARTISAN_A, 'private')));
});
await it('a customer cannot sweep every artisan\'s private record with a collection-group query', async () => {
    await assertFails(getDocs(collectionGroup(customer.firestore(), 'private')));
});
await it('another artisan cannot read artisan A\'s private record', async () => {
    await assertFails(getDoc(privA(artisanB)));
});
await it('the artisan can read their own private record', async () => {
    await assertSucceeds(getDoc(privA(artisanA)));
});
await it('an administrator can read an artisan\'s private record (verification)', async () => {
    await assertSucceeds(getDoc(privA(admin)));
});

console.log('\nARTISAN PRIVACY — Firestore: who can write the private record\n');

await it('another artisan cannot overwrite artisan A\'s payout account', async () => {
    await assertFails(updateDoc(privA(artisanB), {
        payoutAccount: { provider: 'mtn', phone: '0249999999', accountName: 'Attacker' },
    }));
});
await it('a customer cannot write an artisan\'s private record', async () => {
    await assertFails(updateDoc(privA(customer), { tin: 'X' }));
});
await it('an administrator cannot write the private record directly', async () => {
    await assertFails(updateDoc(privA(admin), { ghanaCardNumber: 'GHA-000000000-0' }));
});
await it('the artisan can update their own private record (resubmission)', async () => {
    await assertSucceeds(setDoc(privA(artisanA), {
        artisanId: ARTISAN_A, tin: 'C0099999999', updatedAt: new Date().toISOString(),
    }, { merge: true }));
});
await it('the artisan cannot smuggle verification state into the private record', async () => {
    await assertFails(setDoc(privA(artisanA), { verificationStatus: 'approved' }, { merge: true }));
    await assertFails(setDoc(privA(artisanA), { trustScore: 100 }, { merge: true }));
});
await it('the artisan cannot write any document other than private/kyc', async () => {
    await assertFails(setDoc(doc(artisanA.firestore(), 'artisans', ARTISAN_A, 'private', 'extra'),
        { artisanId: ARTISAN_A, tin: 'X' }));
});
await it('the artisan cannot attribute the record to someone else', async () => {
    await assertFails(setDoc(privA(artisanA), { artisanId: ARTISAN_B }, { merge: true }));
});
await it('a malformed payout account is rejected', async () => {
    await assertFails(setDoc(privA(artisanA), {
        artisanId: ARTISAN_A, payoutAccount: { provider: 'mtn', phone: '024', pin: '1234' },
    }, { merge: true }));
});
await it('a customer cannot create a private record under their own uid (not an artisan)', async () => {
    await assertFails(setDoc(doc(customer.firestore(), 'artisans', CUSTOMER, 'private', 'kyc'),
        { artisanId: CUSTOMER, tin: 'X' }));
});

console.log('\nARTISAN PRIVACY — Firestore: the public profile cannot carry private data\n');

for (const [field, value] of [
    ['ghanaCardNumber', 'GHA-123456789-0'], ['tin', 'C0012345678'], ['dob', '1990-04-12'],
    ['address', '12 Example Street'], ['gpsAddress', 'GA-123-4567'],
    ['emergencyContact', { name: 'X', phone: '024' }],
    ['payoutAccount', { provider: 'mtn', phone: '024', accountName: 'X' }],
    ['momoPhone', '0241111111'],
]) {
    await it(`the artisan cannot write ${field} into the public profile`, async () => {
        await assertFails(updateDoc(pubA(artisanA), { [field]: value, updatedAt: new Date().toISOString() }));
    });
}

await it('a new artisan profile cannot be created with a Ghana Card number in it', async () => {
    const uid = 'artisan_new';
    const ctx = newArtisan(uid);
    await assertFails(setDoc(doc(ctx.firestore(), 'artisans', uid),
        { ...signupProfile(uid), ghanaCardNumber: 'GHA-123456789-0' }));
});

await it('a new artisan profile without private data can still be created', async () => {
    const uid = 'artisan_new2';
    const ctx = newArtisan(uid);
    await assertSucceeds(setDoc(doc(ctx.firestore(), 'artisans', uid), signupProfile(uid)));
});

console.log('\nARTISAN PRIVACY — Firestore: discovery, booking and self-service still work\n');

await it('a customer can still read the public profile (discovery)', async () => {
    const snap = await assertSucceeds(getDoc(pubA(customer)));
    if (snap.data().ghanaCardNumber !== undefined) throw new Error('public profile still carries a Ghana Card number');
});
await it('a customer can still query artisans by category (browse)', async () => {
    await assertSucceeds(getDocs(query(collection(customer.firestore(), 'artisans'),
        where('category', '==', 'plumbing'))));
});
await it('an unauthenticated visitor still cannot read public profiles (unchanged)', async () => {
    await assertFails(getDoc(pubA(anon)));
});
await it('the artisan can still toggle availability and update their bio', async () => {
    await assertSucceeds(updateDoc(pubA(artisanA), {
        isAvailable: true, bio: 'Licensed plumber', updatedAt: new Date().toISOString(),
    }));
});
await it('the artisan can still publish their presence location', async () => {
    await assertSucceeds(updateDoc(pubA(artisanA), {
        currentLat: 5.6037, currentLng: -0.187, lastLocationUpdate: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }));
});
await it('a legacy profile still holding KYC fields does not block unrelated edits', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await updateDoc(doc(ctx.firestore(), 'artisans', ARTISAN_B), { ghanaCardNumber: 'GHA-LEGACY-0' });
    });
    await assertSucceeds(updateDoc(doc(artisanB.firestore(), 'artisans', ARTISAN_B), {
        isAvailable: true, updatedAt: new Date().toISOString(),
    }));
});
await it('the onboarding private write (exact shape) is accepted', async () => {
    const uid = 'artisan_onboard';
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'artisans', uid), signupProfile(uid));
    });
    const ctx = newArtisan(uid);
    await assertSucceeds(setDoc(doc(ctx.firestore(), 'artisans', uid, 'private', 'kyc'), {
        artisanId: uid, ghanaCardNumber: 'GHA-123456789-0', tin: null, dob: '1990-04-12',
        address: '12 Example Street', gpsAddress: 'GA-123-4567',
        emergencyContact: { name: 'Ama', phone: '0240000000' },
        payoutAccount: { provider: 'mtn', phone: '0241111111', accountName: 'Kofi' },
        updatedAt: new Date().toISOString(),
    }, { merge: true }));
});

await it('the onboarding public-profile write (exact shape, incl. locationSetAt) is accepted', async () => {
    // Mirrors artisan-app/onboarding.html step 2b exactly, including the work-
    // location timestamp and an "Other" trade description. From 44aae2f
    // (2026-08-20) until this fix, `locationSetAt` was missing from
    // isSafeArtisanProfileUpdate(), so EVERY onboarding submission was denied.
    const uid = 'artisan_onboard';
    const ctx = newArtisan(uid);
    const n = new Date().toISOString();
    await assertSucceeds(setDoc(doc(ctx.firestore(), 'artisans', uid), {
        id: uid, name: 'Kofi Boateng', email: `${uid}@example.com`, userType: 'artisan', status: 'pending',
        phone: '0201234567', gender: 'male',
        lat: 5.6037, lng: -0.187, locationSetAt: n,
        category: 'plumbing', specialty: 'plumbing', skills: ['leaks'],
        requestedService: 'Borehole pump repair',
        bio: 'Plumber', yearsExperience: 5, workRadius: 10, baseRate: 50,
        availability: ['mon'], isAvailable: false,
        verificationStatus: 'pending_review', createdAt: n, updatedAt: n,
    }, { merge: true }));
});

await it('the onboarding fix does not let an artisan promote their own status', async () => {
    const ctx = newArtisan('artisan_onboard');
    await assertFails(setDoc(doc(ctx.firestore(), 'artisans', 'artisan_onboard'),
        { status: 'active', updatedAt: new Date().toISOString() }, { merge: true }));
});

console.log('\nARTISAN PRIVACY — Firestore: the payout account is frozen once approved\n');

// Withdrawals pay only the account on file (functions/financial/transfers.js),
// so after approval, changing it must be a re-verification, not a self-edit.
const APPROVED = 'artisan_approved';
await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();   // one handle per context (see client())
    await setDoc(doc(db, 'artisans', APPROVED),
        { ...signupProfile(APPROVED), verificationStatus: 'approved', status: 'active' });
    await setDoc(doc(db, 'artisans', ARTISAN_A, 'private', 'security'),
        { securityPinConfigured: true, securityPinVersion: 1 });
});
const approved = newArtisan(APPROVED);
const privApproved = () => doc(approved.firestore(), 'artisans', APPROVED, 'private', 'kyc');

await it('an approved artisan cannot CREATE a private record naming a payout account', async () => {
    await assertFails(setDoc(privApproved(), {
        artisanId: APPROVED, payoutAccount: { provider: 'mtn', phone: '0249999999', accountName: 'Attacker' },
    }));
});
await it('an approved artisan can still create a private record without payout fields', async () => {
    await assertSucceeds(setDoc(privApproved(), { artisanId: APPROVED, tin: 'C0012345678' }));
});
await it('an approved artisan cannot CHANGE their payout account', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'artisans', APPROVED, 'private', 'kyc'), {
            artisanId: APPROVED, payoutAccount: { provider: 'mtn', phone: '0241111111', accountName: 'Kofi' },
        });
    });
    await assertFails(setDoc(privApproved(), {
        payoutAccount: { provider: 'mtn', phone: '0249999999', accountName: 'Attacker' },
    }, { merge: true }));
    await assertFails(setDoc(privApproved(), { momoPhone: '0249999999' }, { merge: true }));
});
await it('an approved artisan can still update non-payout private fields', async () => {
    await assertSucceeds(setDoc(privApproved(), { artisanId: APPROVED, tin: 'C0099999999' }, { merge: true }));
});
await it('an artisan who is not yet approved may still correct their payout account', async () => {
    await assertSucceeds(setDoc(privA(artisanA), {
        artisanId: ARTISAN_A, payoutAccount: { provider: 'telecel', phone: '0201234567', accountName: 'Kofi B' },
    }, { merge: true }));
});

console.log('\nARTISAN PRIVACY — Firestore: PIN metadata is server-written\n');

const secA = (ctx) => doc(ctx.firestore(), 'artisans', ARTISAN_A, 'private', 'security');
await it('the artisan can read their own PIN status', async () => {
    await assertSucceeds(getDoc(secA(artisanA)));
});
await it('the artisan cannot write their PIN status (e.g. claim a PIN is set)', async () => {
    await assertFails(setDoc(secA(artisanA), { securityPinConfigured: false }));
});
await it('a customer cannot read an artisan\'s PIN status', async () => {
    await assertFails(getDoc(secA(customer)));
});

console.log('\nARTISAN PRIVACY — Storage: identity documents\n');

const kycFile = (ctx) => ref(ctx.storage(), `artisans/${ARTISAN_A}/documents/idFront.jpg`);

await it('an unauthenticated visitor cannot read an artisan\'s Ghana Card scan', async () => {
    await assertFails(getMetadata(kycFile(anon)));
});
await it('a signed-in customer cannot read an artisan\'s Ghana Card scan', async () => {
    await assertFails(getMetadata(kycFile(customer)));
});
await it('another artisan cannot read artisan A\'s Ghana Card scan', async () => {
    await assertFails(getMetadata(kycFile(artisanB)));
});
await it('another artisan cannot upload into artisan A\'s document folder', async () => {
    await assertFails(uploadString(ref(artisanB.storage(), `artisans/${ARTISAN_A}/documents/idBack.jpg`),
        'JPEG', 'raw', { contentType: 'image/jpeg' }));
});
await it('the artisan can read and upload their own identity documents', async () => {
    await assertSucceeds(getMetadata(kycFile(artisanA)));
    await assertSucceeds(uploadString(ref(artisanA.storage(), `artisans/${ARTISAN_A}/documents/idBack.jpg`),
        'JPEG', 'raw', { contentType: 'image/jpeg' }));
});
await it('a super-administrator can read identity documents (verification)', async () => {
    await assertSucceeds(getMetadata(kycFile(superAdm)));
});
await it('a customer can still read an artisan\'s public profile photo', async () => {
    await assertSucceeds(getMetadata(ref(customer.storage(), `artisans/${ARTISAN_A}/profile/photo.jpg`)));
});
console.log('\nPUSH TOKEN — the device a job offer is sent to (AR-04)\n');

await it('an artisan can save their own push token with its platform', async () => {
    const n = new Date().toISOString();
    await assertSucceeds(updateDoc(pubA(artisanA), {
        fcmToken: 'tok-web-1', fcmPlatform: 'web', fcmTokenUpdatedAt: n, updatedAt: n,
    }));
});
await it('another artisan cannot redirect artisan A\'s job alerts to their own device', async () => {
    await assertFails(updateDoc(pubA(artisanB), { fcmToken: 'tok-attacker', fcmPlatform: 'web' }));
});
await it('a customer cannot write an artisan\'s push token', async () => {
    await assertFails(updateDoc(pubA(customer), { fcmToken: 'tok-customer' }));
});
await it('a push-token write cannot carry a protected field with it', async () => {
    await assertFails(updateDoc(pubA(artisanA), { fcmToken: 'tok-web-2', fcmPlatform: 'web', rating: 5 }));
});

console.log('\n' + '─'.repeat(52));
console.log(`  ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');

await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);
