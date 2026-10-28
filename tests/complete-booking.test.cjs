/**
 * complete-booking.test.cjs
 *
 * Guards the ONE client path for "the customer confirms the work is done".
 *
 * Two invariants matter here and neither is visible by reading the screen:
 *
 *  1. The write shape must match what firestore.rules permits. The customer's
 *     awaiting → completed clause is `keys.hasOnly(['status','completedAt',
 *     'updatedAt'])`. One extra field and every completion in production is
 *     rejected — with the failure surfacing as a generic error long after the
 *     code review that added the field.
 *
 *  2. No client-side escrow release. `onBookingStatusChanged` releases the held
 *     escrow on this exact transition, transactionally, with a 6-hourly
 *     auto-release backstop. Both customer screens used to ALSO call
 *     releaseEscrow() directly — a second settlement path that raced the
 *     trigger, lost the transaction, and threw into a swallowed catch on every
 *     completion. CLAUDE.md §2 forbids a second path for money that has one.
 */
'use strict';

require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const ROOT = path.join(__dirname, '..');

// ── Load the ESM domain module in CommonJS without a build step ──────────────
function loadCompleteBooking() {
    const src = fs.readFileSync(
        path.join(ROOT, 'shared', 'js', 'domain', 'completeBooking.js'), 'utf8');
    const body = src
        .replace(/^\s*export\s+async\s+function\s+/gm, 'async function ')
        .replace(/^\s*export\s+function\s+/gm, 'function ');
    // eslint-disable-next-line no-new-func
    return new Function(`${body}\nreturn { confirmBookingComplete, receiptHref };`)();
}

const { confirmBookingComplete, receiptHref } = loadCompleteBooking();

// ── Tiny harness ─────────────────────────────────────────────────────────────
const failures = [];
let passed = 0;
function test(name, fn) {
    try { const r = fn(); if (r && typeof r.then === 'function') return r.then(
        () => { passed++; },
        (e) => { failures.push([name, e]); });
        passed++;
    } catch (e) { failures.push([name, e]); }
}

/** Records what was written without touching Firestore. */
function fakeDb(behaviour = 'ok') {
    const calls = [];
    return {
        calls,
        async updateDocument(collection, id, fields) {
            calls.push({ collection, id, fields });
            if (behaviour === 'reject') throw new Error('PERMISSION_DENIED');
            return { success: true };
        },
    };
}

const run = async () => {

await test('the write is exactly the three fields the rules allow', async () => {
    const db = fakeDb();
    await confirmBookingComplete({ bookingId: 'HHB-1', databaseService: db });

    assert.strictEqual(db.calls.length, 1, 'exactly one write');
    const { collection, id, fields } = db.calls[0];
    assert.strictEqual(collection, 'bookings');
    assert.strictEqual(id, 'HHB-1');
    assert.deepStrictEqual(
        Object.keys(fields).sort(),
        ['completedAt', 'status', 'updatedAt'],
        'firestore.rules uses hasOnly() — an extra key rejects the whole write');
    assert.strictEqual(fields.status, 'completed');
});

await test('completedAt and updatedAt are ISO strings, as every other write on this document is', async () => {
    const db = fakeDb();
    await confirmBookingComplete({ bookingId: 'HHB-2', databaseService: db });
    const { fields } = db.calls[0];
    for (const k of ['completedAt', 'updatedAt']) {
        assert.match(fields[k], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, `${k} must be an ISO string`);
    }
});

await test('a rejected write propagates — the caller must not navigate', async () => {
    const db = fakeDb('reject');
    await assert.rejects(
        () => confirmBookingComplete({ bookingId: 'HHB-3', databaseService: db }),
        /PERMISSION_DENIED/,
        'swallowing this is how a customer reaches a receipt for a job that never completed');
});

await test('a missing booking id is refused before any write', async () => {
    const db = fakeDb();
    await assert.rejects(() => confirmBookingComplete({ bookingId: null, databaseService: db }));
    assert.strictEqual(db.calls.length, 0, 'nothing may be written without an id');
});

await test('the receipt link always carries the booking id', () => {
    assert.strictEqual(receiptHref('HHB-260820-0332-58F1'),
        'review.html?bookingId=HHB-260820-0332-58F1');
    assert.strictEqual(receiptHref('a b&c'), 'review.html?bookingId=a%20b%26c',
        'ids must be encoded, not concatenated');
    assert.strictEqual(receiptHref(null), 'review.html');
});

// ── Source-level invariant: no second settlement path ────────────────────────
const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

await test('no customer screen releases escrow from the client', () => {
    for (const rel of ['customer-app/booking.html', 'customer-app/live-tracking.html']) {
        const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        assert.ok(!/releaseEscrow\s*\(/.test(code),
            `${rel} calls releaseEscrow() from the client. onBookingStatusChanged ` +
            `already releases on this transition — a second path races it and loses.`);
    }
});

await test('completion goes through the shared path on both screens', () => {
    for (const rel of ['customer-app/booking.html', 'customer-app/live-tracking.html']) {
        const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        assert.ok(/confirmBookingComplete/.test(code),
            `${rel} must complete bookings through shared/js/domain/completeBooking.js`);
    }
});

await test('live tracking awaits the write that triggers payment', () => {
    const code = fs.readFileSync(path.join(ROOT, 'customer-app/live-tracking.html'), 'utf8');
    const fn = code.slice(code.indexOf('async function confirmCompletion'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.ok(/await confirmBookingComplete/.test(body),
        'the status write IS the payment instruction — fire-and-forget strands the artisan');
});

// ── Report ───────────────────────────────────────────────────────────────────
if (failures.length) {
    console.error('');
    for (const [name, err] of failures) {
        console.error(`  FAIL  ${name}`);
        console.error(`        ${err.message.split('\n')[0]}`);
    }
}
console.log(`\ncomplete-booking: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

};

run();
