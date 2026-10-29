/**
 * notification-rules.test.mjs — SEC-001 against the real firestore.rules.
 *
 * customer_notifications create: the shape is closed, and actionUrl may only
 * name a page in the same app. Every client writer must still pass
 * (notificationRepository.createNotification, chatRepository's message
 * notification, the admin support reply); forged links and extra keys must not.
 * Run: npm run test:notification-rules (emulator on 8080).
 */

import './support/no-production.cjs';   // must stay the first statement (npm run lint:tests)
import {
    initializeTestEnvironment,
    assertFails,
    assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { setDoc, addDoc, updateDoc, doc, collection } from 'firebase/firestore';

const PROJECT_ID = 'lamax-rules-test';
const A  = 'artisan_a';
const C1 = 'customer_1';
const SUPPORT = 'admin_support';
const NOW = '2026-10-28T09:00:00.000Z';

let passed = 0, failed = 0;
async function it(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (err) { console.log(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`); failed++; }
}

const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
await testEnv.clearFirestore();
await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();   // once per context: a second call re-applies emulator settings and throws
    await setDoc(doc(db, 'admins', SUPPORT), { userType: 'admin', email: 'help@example.com', role: 'support_admin' });
    await setDoc(doc(db, 'customer_notifications', 'N1'), {
        receiverId: A, senderId: C1, type: 'General', title: 't', message: 'm',
        isRead: false, readAt: null, actionUrl: null, metadata: {}, createdAt: NOW,
    });
});

const cust    = testEnv.authenticatedContext(C1).firestore();
const art     = testEnv.authenticatedContext(A).firestore();
const support = testEnv.authenticatedContext(SUPPORT).firestore();
const anon    = testEnv.unauthenticatedContext().firestore();
const inbox   = (db) => collection(db, 'customer_notifications');

// The shape notificationRepository.createNotification writes.
const repoShape = (over = {}) => ({
    receiverId: A, senderId: C1, type: 'Bookings', title: 'New Booking Request',
    message: 'You have a new booking request for Plumbing.', isRead: false, readAt: null,
    actionUrl: 'dashboard.html', metadata: { bookingId: 'HHB-260820-0332-58F1', customerId: C1 },
    createdAt: NOW, ...over,
});

// ── Legitimate writers ───────────────────────────────────────────────────────

await it('createNotification shape is accepted', async () => {
    await assertSucceeds(addDoc(inbox(cust), repoShape()));
});
await it('createNotification with no link (actionUrl null) is accepted', async () => {
    await assertSucceeds(addDoc(inbox(cust), repoShape({ actionUrl: null })));
});
await it('a link with a query is accepted', async () => {
    await assertSucceeds(addDoc(inbox(cust), repoShape({ actionUrl: 'job.html?id=HHB-260820-0332-58F1' })));
});
await it('chatRepository message notification is accepted (no readAt, Date createdAt)', async () => {
    // directChatId() = the two Firebase Auth uids (28 alphanumerics), sorted, joined by '_'.
    const chatId = ['Xq3vT9bLmN2pR7sK4wY8zA1cD5eF', 'g6Hj0KkLz2Mn4Pq8Rs1Tu3Vw5Xy7'].sort().join('_');
    await assertSucceeds(addDoc(inbox(cust), {
        receiverId: A, senderId: C1, type: 'Messages', title: 'New message from Ama',
        message: 'Are you on your way?', isRead: false,
        actionUrl: `messages.html?chatId=${chatId}`,
        metadata: { chatId, senderId: C1 }, createdAt: new Date(),
    }));
});
await it('the admin support reply notification is accepted', async () => {
    await assertSucceeds(addDoc(inbox(support), {
        receiverId: A, senderId: SUPPORT, type: 'System', title: 'Support replied to your request',
        message: 'There is a reply to your request about "Payments". Open Support to read it.',
        isRead: false, readAt: null, actionUrl: 'support.html', metadata: { ticketId: 'T-OPEN' }, createdAt: NOW,
    }));
});
await it('the admin support reply to a customer (no link) is accepted', async () => {
    await assertSucceeds(addDoc(inbox(support), {
        receiverId: C1, senderId: SUPPORT, type: 'System', title: 'Support replied to your request',
        message: 'Open Support to read it.', isRead: false, readAt: null, actionUrl: null,
        metadata: { ticketId: 'T-2' }, createdAt: NOW,
    }));
});

// ── Forged links ─────────────────────────────────────────────────────────────

const HOSTILE = [
    'javascript:alert(document.cookie)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'https://evil.example/login.html', '//evil.example/booking.html', '/\\evil.example',
    '../customer-app/booking.html', '/booking.html', "booking.html');alert(1);//",
    'x.html?a=" onmouseover="alert(1)', 'booking.html#x', 'booking.html?a=<b>',
    'a'.repeat(296) + '.html',
];
for (const url of HOSTILE) {
    await it(`refuses actionUrl ${JSON.stringify(url.length > 40 ? url.slice(0, 37) + '…' : url)}`, async () => {
        await assertFails(addDoc(inbox(cust), repoShape({ actionUrl: url })));
    });
}
await it('refuses a non-string actionUrl', async () => {
    await assertFails(addDoc(inbox(cust), repoShape({ actionUrl: { href: 'booking.html' } })));
    await assertFails(addDoc(inbox(cust), repoShape({ actionUrl: ['booking.html'] })));
});

// ── Closed shape ─────────────────────────────────────────────────────────────

await it('refuses extra keys (url, link, html, deepLink)', async () => {
    for (const k of ['url', 'link', 'html', 'deepLink']) {
        await assertFails(addDoc(inbox(cust), repoShape({ [k]: 'javascript:alert(1)' })));
    }
});
await it('refuses a pre-set readAt', async () => {
    await assertFails(addDoc(inbox(cust), repoShape({ readAt: NOW })));
});
await it('refuses non-map metadata', async () => {
    await assertFails(addDoc(inbox(cust), repoShape({ metadata: 'x' })));
});

// ── Unchanged behaviour ──────────────────────────────────────────────────────

await it('still refuses a forged sender and unauthenticated writes', async () => {
    await assertFails(addDoc(inbox(cust), repoShape({ senderId: SUPPORT })));
    await assertFails(addDoc(inbox(anon), repoShape({ senderId: null })));
});
await it('the receiver can still mark read; no one can rewrite the link', async () => {
    await assertSucceeds(updateDoc(doc(art, 'customer_notifications', 'N1'), { isRead: true, readAt: NOW }));
    await assertFails(updateDoc(doc(art, 'customer_notifications', 'N1'), { actionUrl: 'javascript:alert(1)' }));
});

console.log('\n' + '─'.repeat(52));
console.log(`  ${passed} passed, ${failed} failed`);
console.log('─'.repeat(52) + '\n');

await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);
