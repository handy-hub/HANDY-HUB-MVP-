/**
 * Knowing a booking ID must not grant access to it.
 *
 * The booking rebuild put booking IDs into URLs everywhere — tracking, review,
 * the artisan job screen, notification deep links. That is the right design,
 * but it changes the threat model: IDs are now visible, shareable, guessable
 * from a shoulder-glance, and present in browser history. The ONLY thing
 * standing between a leaked id and someone else's job details is Firestore's
 * read rule.
 *
 * These tests run against the emulator with the REAL firestore.rules, using
 * per-user authenticated contexts — not the Admin SDK, which bypasses rules and
 * would make every one of these pass for the wrong reason.
 */
'use strict';

require('../support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const { createRequire } = require('module');
const path = require('path');
const req  = createRequire(path.join(__dirname, '..', '..', 'functions', 'package.json'));

const { initializeTestEnvironment, assertFails, assertSucceeds } =
    require('@firebase/rules-unit-testing');
const { doc, getDoc, updateDoc, setDoc } = require('firebase/firestore');
const { readFileSync } = require('fs');

const DB_ID = 'ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6';

let passed = 0, failed = 0;
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; console.log(`  FAIL  ${name}\n          ${String(e.message).slice(0, 160)}`); }
}

async function main() {
    const env = await initializeTestEnvironment({
        projectId: 'lamax-authz-test',
        firestore: {
            rules: readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8'),
            host: '127.0.0.1',
            port: 8080,
        },
    });

    const CUST_A = 'authz_cust_a', CUST_B = 'authz_cust_b';
    const ART_A  = 'authz_art_a',  ART_B  = 'authz_art_b';
    const BOOKING = 'AUTHZ-BOOKING-1';

    // Seed with rules disabled — fixture setup, not the thing under test.
    await env.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await setDoc(doc(db, 'customers', CUST_A), { uid: CUST_A, userType: 'customer' });
        await setDoc(doc(db, 'customers', CUST_B), { uid: CUST_B, userType: 'customer' });
        await setDoc(doc(db, 'artisans',  ART_A),  { uid: ART_A, userType: 'artisan', verificationStatus: 'approved', status: 'active' });
        await setDoc(doc(db, 'artisans',  ART_B),  { uid: ART_B, userType: 'artisan', verificationStatus: 'approved', status: 'active' });
        await setDoc(doc(db, 'bookings', BOOKING), {
            customerId: CUST_A, artisanId: ART_A,
            serviceType: 'Plumbing', status: 'accepted', track: 'standard',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
    });

    const asCustA = env.authenticatedContext(CUST_A).firestore();
    const asCustB = env.authenticatedContext(CUST_B).firestore();
    const asArtA  = env.authenticatedContext(ART_A).firestore();
    const asArtB  = env.authenticatedContext(ART_B).firestore();
    const asAnon  = env.unauthenticatedContext().firestore();

    // ── The parties to the booking can read it ───────────────────────────────
    await t('the booking\'s own customer can read it', async () => {
        await assertSucceeds(getDoc(doc(asCustA, 'bookings', BOOKING)));
    });
    await t('the assigned artisan can read it', async () => {
        await assertSucceeds(getDoc(doc(asArtA, 'bookings', BOOKING)));
    });

    // ── Everyone else cannot, even knowing the exact id ──────────────────────
    await t('ANOTHER customer cannot read it, despite knowing the id', async () => {
        await assertFails(getDoc(doc(asCustB, 'bookings', BOOKING)));
    });
    await t('ANOTHER artisan cannot read it, despite knowing the id', async () => {
        await assertFails(getDoc(doc(asArtB, 'bookings', BOOKING)));
    });
    await t('a signed-out visitor cannot read it', async () => {
        await assertFails(getDoc(doc(asAnon, 'bookings', BOOKING)));
    });

    // ── Nor act on it ────────────────────────────────────────────────────────
    await t('another artisan cannot accept someone else\'s job', async () => {
        await assertFails(updateDoc(doc(asArtB, 'bookings', BOOKING), {
            status: 'accepted', acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }));
    });
    await t('another customer cannot cancel someone else\'s booking', async () => {
        await assertFails(updateDoc(doc(asCustB, 'bookings', BOOKING), {
            status: 'cancelled', cancellationReason: 'not mine', updatedAt: new Date().toISOString(),
        }));
    });
    await t('another artisan cannot advance the job to en_route', async () => {
        await assertFails(updateDoc(doc(asArtB, 'bookings', BOOKING), {
            status: 'en_route', enRouteAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }));
    });

    // ── A forged / non-existent id yields nothing ────────────────────────────
    await t('a forged booking id is DENIED, not merely empty', async () => {
        // The read rule tests resource.data.customerId, which does not exist on a
        // missing document — so the rule evaluates false and the read is refused.
        // That is stronger than returning an empty snapshot: it does not even
        // confirm whether a booking with that id exists.
        await assertFails(getDoc(doc(asCustA, 'bookings', 'HHB-DOES-NOT-EXIST-9999')));
    });

    // ── The customer still cannot write what only the server may ─────────────
    await t('the customer cannot mark their own booking completed early', async () => {
        // awaiting -> completed is the ONLY completion transition; from
        // `accepted` it must be refused.
        await assertFails(updateDoc(doc(asCustA, 'bookings', BOOKING), {
            status: 'completed', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }));
    });
    await t('the artisan cannot stamp quoteApproved themselves', async () => {
        await assertFails(updateDoc(doc(asArtA, 'bookings', BOOKING), {
            quoteApproved: true, updatedAt: new Date().toISOString(),
        }));
    });

    // ── `track` is server-only, and the whole lifecycle depends on it ────────
    // onBookingCreated stamps it. If a client could set it, a customer could
    // mint an inspection-track booking (callout fee, quote cycle, escrow flags)
    // without the server ever pricing it — which is exactly what
    // bookingHasNoSystemFields() exists to stop.
    const { addDoc, collection } = require('firebase/firestore');

    await t('a client CANNOT set track when creating a booking', async () => {
        await assertFails(addDoc(collection(asCustA, 'bookings'), {
            customerId: CUST_A, artisanId: ART_A, serviceType: 'Plumbing',
            status: 'pending', createdAt: new Date().toISOString(),
            track: 'inspection',                   // <- the forbidden field
        }));
    });

    await t('a client CANNOT add track to an existing booking', async () => {
        await assertFails(updateDoc(doc(asCustA, 'bookings', BOOKING), {
            track: 'inspection', updatedAt: new Date().toISOString(),
        }));
    });

    await t('the artisan cannot change track either', async () => {
        await assertFails(updateDoc(doc(asArtA, 'bookings', BOOKING), {
            track: 'emergency', updatedAt: new Date().toISOString(),
        }));
    });

    await t('a client cannot forge the paid-callout flag', async () => {
        await assertFails(updateDoc(doc(asCustA, 'bookings', BOOKING), {
            calloutPaid: true, updatedAt: new Date().toISOString(),
        }));
    });

    await env.cleanup();
    console.log(`\nbooking-authorization: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('AUTHZ TEST CRASHED:', e); process.exit(1); });
