/**
 * booking-tracks.test.cjs
 *
 * The two tracks, pinned side by side.
 *
 * HandyHub runs two booking lifecycles over ONE status field:
 *
 *   inspection — server-created. Callout fee → inspection visit → quote →
 *                customer approves → work. `accepted` means "pay your visit fee".
 *   emergency  — customer picks an artisan and an amount up front. Escrow is
 *                held through the SAME holdBookingFunds path, but there is no
 *                inspection, no callout and no quote. `accepted` means
 *                "your professional is coming".
 *
 * Same word, two meanings. That ambiguity is the reason `track` exists, and the
 * reason it is stamped SERVER-SIDE (functions/dispatch.js onBookingCreated) —
 * firestore.rules forbids the client from writing it, so it cannot be trusted
 * from the client and must not be inferred from symptoms downstream.
 *
 * These tests exist so that "the same status means different things on
 * different tracks" is a checked property rather than a comment.
 */
'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const ROOT = path.join(__dirname, '..');

function loadTruth() {
    const src = fs.readFileSync(path.join(ROOT, 'shared', 'js', 'domain', 'bookingTruth.js'), 'utf8');
    const body = src
        .replace(/^\s*export\s+async\s+function\s+/gm, 'async function ')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
    // eslint-disable-next-line no-new-func
    return new Function(`${body}\nreturn { resolveJobPhase, JOB_PHASE };`)();
}
function loadRouter() {
    const src = fs.readFileSync(path.join(ROOT, 'shared', 'js', 'domain', 'bookingRouter.js'), 'utf8');
    const body = src
        .replace(/^\s*export\s+async\s+function\s+/gm, 'async function ')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
    // eslint-disable-next-line no-new-func
    return new Function(`${body}\nreturn { bookingHref };`)();
}

const { resolveJobPhase, JOB_PHASE } = loadTruth();
const { bookingHref } = loadRouter();

let passed = 0, failed = 0;
function t(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const insp = (over) => ({ id: 'B1', track: 'inspection', ...over });
const emer = (over) => ({ id: 'B1', track: 'emergency',  ...over });

// ── The status that means two different things ──────────────────────────────
t('accepted on INSPECTION with the callout unpaid = "pay your visit fee"', () => {
    assert.strictEqual(
        resolveJobPhase(insp({ status: 'accepted', calloutPaid: false })),
        JOB_PHASE.AWAITING_CALLOUT);
});

t('accepted on EMERGENCY = the work is on — no callout exists', () => {
    assert.strictEqual(
        resolveJobPhase(emer({ status: 'accepted' })),
        JOB_PHASE.WORK,
        'an emergency booking has no visit fee to wait for');
});

t('in_progress on INSPECTION (pre-quote) is the INSPECTION visit', () => {
    assert.strictEqual(
        resolveJobPhase(insp({ status: 'in_progress', calloutPaid: true })),
        JOB_PHASE.INSPECTION);
});

t('in_progress on EMERGENCY is the WORK visit', () => {
    assert.strictEqual(
        resolveJobPhase(emer({ status: 'in_progress' })),
        JOB_PHASE.WORK);
});

// ── The failure this guards: an untracked booking claiming work is underway ──
t('a booking with NO track does not claim to be mid-inspection', () => {
    // Falls through to WORK. That is the documented behaviour and precisely why
    // dispatch.js now stamps `track` on create — this test states the risk.
    assert.strictEqual(resolveJobPhase({ id: 'B1', status: 'accepted' }), JOB_PHASE.WORK);
});

t('inspection-only statuses infer their own track even when it is missing', () => {
    // payCalloutFee / completeInspection produce these and refuse to run off the
    // inspection track, so inferring here cannot be wrong where it fires.
    assert.strictEqual(resolveJobPhase({ id: 'B1', status: 'inspection_scheduled' }), JOB_PHASE.INSPECTION);
    assert.strictEqual(resolveJobPhase({ id: 'B1', status: 'inspection_done' }),      JOB_PHASE.QUOTING);
});

// ── Routing must differ per track for the same status ───────────────────────
t('accepted INSPECTION routes to the console to pay the callout', () => {
    const href = bookingHref(insp({ status: 'accepted', quoteApproved: false }));
    assert.ok(href.startsWith('book-request.html?resume='), `got ${href}`);
    assert.ok(href.includes('B1'), 'destination must carry the booking id');
});

t('accepted EMERGENCY routes to live tracking, with its id', () => {
    const href = bookingHref(emer({ status: 'accepted' }));
    assert.ok(href.startsWith('live-tracking.html'), `got ${href}`);
    assert.ok(href.includes('B1'), 'destination must carry the booking id');
});

t('en_route carries the id on BOTH tracks', () => {
    for (const b of [insp({ status: 'en_route', quoteApproved: true }), emer({ status: 'en_route' })]) {
        const href = bookingHref(b);
        assert.ok(href.includes('B1'), `${b.track}: ${href} lost the id`);
    }
});

// ── Terminal states stay terminal on both tracks ────────────────────────────
t('terminal states resolve to CLOSED regardless of track', () => {
    for (const st of ['completed', 'cancelled', 'rejected', 'unfulfilled']) {
        assert.strictEqual(resolveJobPhase(insp({ status: st })), JOB_PHASE.CLOSED, `inspection/${st}`);
        assert.strictEqual(resolveJobPhase(emer({ status: st })), JOB_PHASE.CLOSED, `emergency/${st}`);
    }
});

t('terminal bookings route to the list, not the progress rail', () => {
    for (const st of ['completed', 'cancelled', 'rejected']) {
        assert.strictEqual(bookingHref(emer({ status: st })), 'booking.html', `emergency/${st}`);
    }
});

// ── The quote sub-cycle belongs to the inspection track alone ───────────────
t('emergency never enters the quote sub-cycle', () => {
    // It has no inspection to quote against. If a quoted emergency booking ever
    // appears it is a data fault, and AWAITING_QUOTE would be the honest read —
    // but nothing in the emergency flow can produce it.
    assert.notStrictEqual(resolveJobPhase(emer({ status: 'accepted' })), JOB_PHASE.QUOTING);
    assert.notStrictEqual(resolveJobPhase(emer({ status: 'in_progress' })), JOB_PHASE.QUOTING);
});

console.log(`booking-tracks: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
