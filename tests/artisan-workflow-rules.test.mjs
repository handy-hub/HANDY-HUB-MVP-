/**
 * artisan-workflow-rules.test.mjs — the booking transitions an artisan screen
 * offers, against the real firestore.rules on the emulator. (Phase 0 WF-01, WF-02.)
 *
 * tests/artisan-actions-consistency.test.cjs proves the screens offer only these
 * transitions; this file proves what the rules engine itself does with them, so
 * the two cannot drift apart unnoticed.
 *
 *   WF-02  An accepted emergency or standard job with no approved quote cannot
 *          go en route: the rules require quoteApproved. (Whether emergencies
 *          should travel before a quote is business decision Q1; this records
 *          the policy as it stands.)
 *   WF-01  An artisan never cancels inspection-track work by a direct write:
 *          cancelInspectionBooking is the only path, and it refuses approved work.
 *
 * Run:  npm run test:workflow-rules
 */

import './support/no-production.cjs';   // must stay the first statement (npm run lint:tests)
import {
    initializeTestEnvironment,
    assertFails,
    assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { setDoc, updateDoc, doc } from 'firebase/firestore';

const PROJECT_ID = 'lamax-rules-test';
const CUSTOMER   = 'wf_customer';
const ARTISAN    = 'wf_artisan';
const SUSPENDED  = 'wf_artisan_suspended';
const NOW        = '2026-11-05T12:00:00.000Z';

let passed = 0, failed = 0;
async function it(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (err) { console.log(`  FAIL  ${name}`); console.log(`        ${err.message.split('\n')[0]}`); failed++; }
}

const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
await testEnv.clearFirestore();

/** One booking per case, so no case depends on another's writes. */
const BOOKINGS = {
    em_accepted:        { track: 'emergency',  status: 'accepted' },
    em_accepted_quoted: { track: 'emergency',  status: 'accepted', quoteApproved: true },
    st_accepted:        { track: 'standard',   status: 'accepted' },
    st_accepted_quoted: { track: 'standard',   status: 'accepted', quoteApproved: true },
    st_future_slot:     { track: 'standard',   status: 'accepted', quoteApproved: true, scheduledForMs: Date.now() + 3 * 864e5 },
    in_scheduled:       { track: 'inspection', status: 'inspection_scheduled', calloutPaid: true },
    in_accepted:        { track: 'inspection', status: 'accepted' },
    in_approved:        { track: 'inspection', status: 'accepted', quoteApproved: true, calloutPaid: true },
    in_approved_wip:    { track: 'inspection', status: 'in_progress', quoteApproved: true, calloutPaid: true },
    em_cancel:          { track: 'emergency',  status: 'accepted' },
    em_en_route:        { track: 'emergency',  status: 'en_route', quoteApproved: true },
    em_arrive:          { track: 'emergency',  status: 'en_route', quoteApproved: true },
    em_wip:             { track: 'emergency',  status: 'in_progress', quoteApproved: true },
    em_skip:            { track: 'emergency',  status: 'accepted', quoteApproved: true },
    disputed:           { track: 'inspection', status: 'disputed', quoteApproved: true, calloutPaid: true },
    customer_travel:    { track: 'standard',   status: 'accepted', quoteApproved: true },
    suspended_travel:   { track: 'standard',   status: 'accepted', quoteApproved: true, artisanId: SUSPENDED },
};

await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'customers', CUSTOMER), { name: 'WF Customer', userType: 'customer', status: 'active', walletBalance: 0, escrowBalance: 0, spent: 0 });
    await setDoc(doc(db, 'artisans', ARTISAN),   { uid: ARTISAN,   userType: 'artisan', verificationStatus: 'approved', status: 'active' });
    await setDoc(doc(db, 'artisans', SUSPENDED), { uid: SUSPENDED, userType: 'artisan', verificationStatus: 'approved', status: 'suspended' });
    for (const [id, b] of Object.entries(BOOKINGS)) {
        await setDoc(doc(db, 'bookings', id), {
            customerId: CUSTOMER, artisanId: ARTISAN, serviceType: 'Plumbing', createdAt: NOW, ...b,
        });
    }
});

const artisanDb   = testEnv.authenticatedContext(ARTISAN).firestore();
const suspendedDb = testEnv.authenticatedContext(SUSPENDED).firestore();
const customerDb  = testEnv.authenticatedContext(CUSTOMER).firestore();
const write = (db, id, data) => updateDoc(doc(db, 'bookings', id), { ...data, updatedAt: NOW });
const enRoute = { status: 'en_route', enRouteAt: NOW };
const cancel  = { status: 'cancelled', cancellationReason: 'Cancelled', cancelledBy: 'artisan' };

console.log('\nWF-02 — travel waits for an approved quote off the inspection track\n');

await it('an accepted emergency job with no approved quote cannot go en route', async () => {
    await assertFails(write(artisanDb, 'em_accepted', enRoute));
});
await it('nor can an accepted standard job', async () => {
    await assertFails(write(artisanDb, 'st_accepted', enRoute));
});
await it('once the quote is approved, the artisan goes en route', async () => {
    await assertSucceeds(write(artisanDb, 'em_accepted_quoted', enRoute));
    await assertSucceeds(write(artisanDb, 'st_accepted_quoted', enRoute));
});
await it('a booked slot days away cannot be travelled to yet (the dashboard shows it, not offers it)', async () => {
    await assertFails(write(artisanDb, 'st_future_slot', enRoute));
});
await it('the inspection visit needs no quote: inspection_scheduled → en_route', async () => {
    await assertSucceeds(write(artisanDb, 'in_scheduled', enRoute));
});
await it('an inspection booking still awaiting its callout payment cannot go en route', async () => {
    await assertFails(write(artisanDb, 'in_accepted', enRoute));
});

console.log('\nWF-01 — cancelling inspection work is the server\'s call\n');

await it('an artisan cannot cancel approved inspection work by a direct write', async () => {
    await assertFails(write(artisanDb, 'in_approved', cancel));
    await assertFails(write(artisanDb, 'in_approved_wip', cancel));
});
await it('nor unapproved inspection work: cancelInspectionBooking settles the callout', async () => {
    await assertFails(write(artisanDb, 'in_accepted', cancel));
});
await it('off the inspection track an artisan cancels an accepted job directly', async () => {
    await assertSucceeds(write(artisanDb, 'em_cancel', cancel));
});
await it('but not once travelling (artisanCanCancel offers it only for accepted or quoted)', async () => {
    await assertFails(write(artisanDb, 'em_en_route', cancel));
});

console.log('\nThe rest of the journey, one step at a time\n');

await it('en_route → in_progress, then in_progress → awaiting', async () => {
    await assertSucceeds(write(artisanDb, 'em_arrive', { status: 'in_progress', arrivedAt: NOW }));
    await assertSucceeds(write(artisanDb, 'em_wip', { status: 'awaiting', jobDoneAt: NOW }));
});
await it('no step can be skipped: accepted → awaiting is refused', async () => {
    await assertFails(write(artisanDb, 'em_skip', { status: 'awaiting', jobDoneAt: NOW }));
    await assertFails(write(artisanDb, 'em_skip', { status: 'in_progress', arrivedAt: NOW }));
});
await it('a disputed booking cannot be moved by the artisan (the screens offer no action)', async () => {
    await assertFails(write(artisanDb, 'disputed', { status: 'in_progress', arrivedAt: NOW }));
    await assertFails(write(artisanDb, 'disputed', { status: 'awaiting', jobDoneAt: NOW }));
    await assertFails(write(artisanDb, 'disputed', cancel));
});
await it('the customer cannot mark the artisan en route', async () => {
    await assertFails(write(customerDb, 'customer_travel', enRoute));
});
await it('a suspended artisan cannot advance a job', async () => {
    await assertFails(write(suspendedDb, 'suspended_travel', enRoute));
});

console.log('\n' + '─'.repeat(52));
console.log(`  ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');

await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);
