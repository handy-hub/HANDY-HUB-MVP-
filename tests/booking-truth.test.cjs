/**
 * booking-truth.test.cjs — regression suite for the transaction-integrity model.
 *
 * These tests exist because production shipped a "PAYMENT RECEIPT · Paid ·
 * GHS 65.00" for a GHS 1.00 job, on a booking ID invented from the clock, while
 * the ledger itself was correct. The failure was entirely in the projection from
 * the authoritative record to the screen — so that projection is what is tested
 * here, directly, with no mocks standing in for it.
 *
 * The two things under test are the only two pieces of logic allowed to decide
 * what a user is told about money:
 *   1. functions/quotes.js  → computeQuoteSettlement  (the ledger's formula)
 *   2. shared/js/domain/bookingTruth.js               (the screen's projection)
 *
 * They are tested together so a drift between "what the customer approves" and
 * "what is charged" fails CI rather than reaching a customer.
 *
 * Run: node tests/booking-truth.test.cjs
 */

'use strict';

require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

// ── Load the ESM domain module in CommonJS without a build step ──────────────
// bookingTruth.js is deliberately import-free so it can be evaluated anywhere;
// that property is what makes this direct load possible.
function loadBookingTruth() {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'shared', 'js', 'domain', 'bookingTruth.js'), 'utf8');
    const body = src
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
    const names = [
        'money', 'formatMoney', 'resolveBookingId', 'resolveArtisan', 'resolveCustomer',
        'initialsOf', 'resolveMoney', 'totalCharged', 'PAYMENT_STATE',
        'resolvePaymentState', 'paymentStateLabel', 'resolveReceipt',
        'LOAD_STATE', 'classifyLookup',
        'JOB_PHASE', 'resolveJobPhase', 'resolveArtisanCompensation',
        'distanceKm', 'formatDistance', 'resolveJobBrief',
        'JOURNEY_STAGES', 'resolveJourney', 'journeyStages', 'resolveQuoteDecision',
        'resolveRating', 'resolveReviewEligibility',
    ];
    // eslint-disable-next-line no-new-func
    return new Function(`${body}\nreturn {${names.join(',')}};`)();
}

const T = loadBookingTruth();
const { computeQuoteSettlement } = require('../functions/quotes.js');

/** Remove // and /* *\/ comments so source-grep assertions test code, not prose. */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '')
              .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ── Tiny harness ─────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
    try { fn(); pass++; }
    catch (err) { fail++; failures.push(`${name}\n    ${err.message}`); }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Shaped exactly as functions/pricing.js + quotes.js persist them.
const REAL_ID = 'HHB-260820-0332-58F1';

const baseInspection = {
    id: REAL_ID,
    track: 'inspection',
    status: 'inspection_done',
    customerId: 'cust_1',
    artisanId: 'art_1',
    artisanName: 'Kwame Mensah',
    serviceType: 'Plumbing',
    calloutFee: 1.00,
    calloutPaid: true,
};

const quoted = (jobQuote, extra = {}) => {
    const s = computeQuoteSettlement(baseInspection, jobQuote);
    return {
        ...baseInspection,
        status: 'quoted',
        jobQuote: s.jobQuote,
        labourCost: s.jobQuote,
        materialsCost: 0,
        calloutCreditPreview: s.calloutCredit,
        amountDuePreview: s.amountDue,
        ...extra,
    };
};

const approved = (jobQuote, extra = {}) => {
    const b = quoted(jobQuote);
    const s = computeQuoteSettlement(baseInspection, jobQuote);
    return {
        ...b,
        status: 'accepted',
        quoteApproved: true,
        calloutCredit: s.calloutCredit,
        escrowHeldAmount: s.amountDue,
        ...extra,
    };
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE SETTLEMENT FORMULA — quote vs credit, all three relationships
// ═════════════════════════════════════════════════════════════════════════════

test('settlement: quote GREATER than callout credit charges the difference', () => {
    const s = computeQuoteSettlement(baseInspection, 250);
    assert.strictEqual(s.jobQuote, 250);
    assert.strictEqual(s.calloutCredit, 1.00);
    assert.strictEqual(s.amountDue, 249.00);
});

test('settlement: quote EQUAL to callout credit charges nothing further', () => {
    const s = computeQuoteSettlement(baseInspection, 1.00);
    assert.strictEqual(s.calloutCredit, 1.00);
    assert.strictEqual(s.amountDue, 0, 'this is the exact production case that read "Approve & Pay GHS 1.00"');
});

test('settlement: quote LESS than callout credit never goes negative', () => {
    const s = computeQuoteSettlement({ ...baseInspection, calloutFee: 50 }, 20);
    assert.strictEqual(s.calloutCredit, 50);
    assert.strictEqual(s.amountDue, 0, 'surplus credit must not become a negative charge');
});

test('settlement: an UNPAID callout is not a credit', () => {
    const s = computeQuoteSettlement({ ...baseInspection, calloutPaid: false }, 100);
    assert.strictEqual(s.calloutCredit, 0);
    assert.strictEqual(s.amountDue, 100);
});

test('settlement: non-inspection track has no callout credit', () => {
    const s = computeQuoteSettlement({ ...baseInspection, track: 'standard' }, 100);
    assert.strictEqual(s.calloutCredit, 0);
    assert.strictEqual(s.amountDue, 100);
});

test('settlement: rounds to 2dp, no float drift', () => {
    const s = computeQuoteSettlement({ ...baseInspection, calloutFee: 10.10 }, 30.30);
    assert.strictEqual(s.amountDue, 20.20);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. PREVIEW == SETTLED — what the customer approves is what is charged
// ═════════════════════════════════════════════════════════════════════════════

test('preview shown at quote time equals the amount settled at approval', () => {
    for (const q of [0.5, 1, 1.01, 25, 249.99, 1000]) {
        const beforeApproval = T.resolveMoney(quoted(q));
        const afterApproval  = T.resolveMoney(approved(q));
        assert.strictEqual(beforeApproval.amountDue, afterApproval.amountDue,
            `amount due drifted between preview and settlement at quote ${q}`);
        assert.strictEqual(beforeApproval.calloutCredit, afterApproval.calloutCredit,
            `credit drifted between preview and settlement at quote ${q}`);
    }
});

test('amount due is null — never 0 — when the server supplied no settlement', () => {
    const b = { ...baseInspection, status: 'quoted', jobQuote: 100 };  // no preview fields
    const m = T.resolveMoney(b);
    assert.strictEqual(m.amountDue, null,
        'an unknown amount must be unresolved, not silently zero');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. NEVER INVENT MONEY
// ═════════════════════════════════════════════════════════════════════════════

test('money() distinguishes absent from zero', () => {
    assert.strictEqual(T.money(undefined), null);
    assert.strictEqual(T.money(null), null);
    assert.strictEqual(T.money(''), null);
    assert.strictEqual(T.money('abc'), null);
    assert.strictEqual(T.money(0), 0);
    assert.strictEqual(T.money('12.5'), 12.5);
});

test('formatMoney renders unresolved as a dash, never as a number', () => {
    assert.strictEqual(T.formatMoney(null), '—');
    assert.strictEqual(T.formatMoney(undefined), '—');
    assert.strictEqual(T.formatMoney(0), 'GHS 0.00');
    assert.strictEqual(T.formatMoney(1), 'GHS 1.00');
});

test('the literal 65 fallback is gone from the receipt path', () => {
    const r = T.resolveReceipt({ ...baseInspection, status: 'completed' }, REAL_ID);
    assert.notStrictEqual(r.totalCharged, 65);
    assert.strictEqual(r.totalCharged, 1.00, 'callout only — no quote was ever raised');
});

test('review.html no longer contains the hardcoded 65 fallback', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'customer-app', 'review.html'), 'utf8');
    assert.ok(!/last\.total\s*\|\|\s*65/.test(src), 'the `|| 65` money fallback is back');
    assert.ok(!/'HHB-'\s*\+\s*String\(now/.test(src), 'the clock-built booking ID is back');
});

test('totalCharged is null when a paid component is unknown', () => {
    const b = { ...baseInspection, calloutPaid: true, calloutFee: null, status: 'completed' };
    assert.strictEqual(T.totalCharged(b), null,
        'a partially known total is a false total');
});

test('totalCharged never double-counts the credited callout fee', () => {
    // Quote 250, callout 1.00 already paid → customer parted with 1.00 + 249.00.
    assert.strictEqual(T.totalCharged(approved(250)), 250.00);
    // Quote fully covered by credit → customer parted with the callout only.
    assert.strictEqual(T.totalCharged(approved(1.00)), 1.00);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. BOOKING IDENTITY
// ═════════════════════════════════════════════════════════════════════════════

test('booking id comes from the record, never generated', () => {
    assert.strictEqual(T.resolveBookingId({ id: REAL_ID }), REAL_ID);
    assert.strictEqual(T.resolveBookingId({ bookingId: REAL_ID }), REAL_ID);
    assert.strictEqual(T.resolveBookingId({}, REAL_ID), REAL_ID, 'falls back to the id it was loaded by');
    assert.strictEqual(T.resolveBookingId({}), null, 'no id available → null, not a synthesised one');
    assert.strictEqual(T.resolveBookingId(null), null);
});

test('receipt reports the SAME id it was loaded by', () => {
    const r = T.resolveReceipt({ ...baseInspection, status: 'completed' }, REAL_ID);
    assert.strictEqual(r.bookingId, REAL_ID);
    assert.ok(!/^HHB-\d{6}-\d{4}$/.test(r.bookingId) || r.bookingId === REAL_ID);
});

test('receipt is unresolved when there is no booking at all', () => {
    const r = T.resolveReceipt(null, null);
    assert.strictEqual(r.resolved, false);
    assert.strictEqual(r.reason, 'no-booking');
    assert.strictEqual(r.bookingId, null);
});

test('receipt is unresolved when the booking is missing but an id was supplied', () => {
    const r = T.resolveReceipt(null, REAL_ID);
    assert.strictEqual(r.resolved, false, 'a missing record must not render a receipt');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. PARTY IDENTITY
// ═════════════════════════════════════════════════════════════════════════════

test('one artisan identity across every surface', () => {
    const a = T.resolveArtisan(baseInspection);
    assert.strictEqual(a.name, 'Kwame Mensah');
    assert.strictEqual(a.isAssigned, true);
    assert.strictEqual(a.id, 'art_1');
    assert.strictEqual(T.initialsOf(a.name), 'KM');
});

test('placeholder names persisted by older code are NOT treated as identities', () => {
    for (const junk of ['Professional', 'Artisan', 'Your Artisan', 'customer', 'Unknown']) {
        const a = T.resolveArtisan({ ...baseInspection, artisanName: junk });
        assert.strictEqual(a.name, null,
            `"${junk}" must not be reported as a real name`);
        assert.strictEqual(T.initialsOf(junk), null);
    }
});

test('a dispatch CANDIDATE is not an assignment', () => {
    const a = T.resolveArtisan({
        status: 'dispatched', currentArtisanId: 'art_9', currentArtisanName: 'Ama Owusu',
    });
    assert.strictEqual(a.isAssigned, false, 'nobody has accepted yet');
    assert.strictEqual(a.name, 'Ama Owusu');
});

test('no artisan yet resolves to null, not to a generic name', () => {
    const a = T.resolveArtisan({ status: 'pending' });
    assert.strictEqual(a.id, null);
    assert.strictEqual(a.name, null);
    assert.strictEqual(a.isAssigned, false);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. PAYMENT STATE — no speculative "Paid"
// ═════════════════════════════════════════════════════════════════════════════

test('payment state is UNRESOLVED for a missing record', () => {
    assert.strictEqual(T.resolvePaymentState(null), T.PAYMENT_STATE.UNRESOLVED);
    assert.strictEqual(T.paymentStateLabel(T.resolvePaymentState(null)), 'Not available');
});

test('an unpaid callout is AWAITING, not paid', () => {
    const s = T.resolvePaymentState({ ...baseInspection, calloutPaid: false, status: 'accepted' });
    assert.strictEqual(s, T.PAYMENT_STATE.AWAITING);
});

test('escrow held reads as held, not as paid out', () => {
    const b = approved(250, { escrowId: 'esc_1' });
    const s = T.resolvePaymentState(b, { status: 'held' });
    assert.strictEqual(s, T.PAYMENT_STATE.HELD);
    assert.strictEqual(T.paymentStateLabel(s), 'Held in escrow');
});

test('released escrow reads as paid out', () => {
    const b = approved(250, { escrowId: 'esc_1', status: 'completed' });
    assert.strictEqual(T.resolvePaymentState(b, { status: 'released' }), T.PAYMENT_STATE.RELEASED);
});

test('COMPLETED alone never implies the money moved', () => {
    // The client writes status:'completed' when the customer confirms; the
    // escrow release is a separate server call that can fail. If it did, the
    // escrow doc still says 'held' and the receipt must not claim a payout.
    const b = approved(250, { escrowId: 'esc_1', status: 'completed' });
    assert.strictEqual(T.resolvePaymentState(b, { status: 'held' }), T.PAYMENT_STATE.HELD,
        'completion must not be mistaken for settlement');
    assert.strictEqual(T.resolvePaymentState(b, null), T.PAYMENT_STATE.UNRESOLVED,
        'without the escrow document we know nothing about the payout');
});

test('a frozen (disputed) escrow still reads as held, never as paid', () => {
    const b = approved(250, { escrowId: 'esc_1' });
    assert.strictEqual(T.resolvePaymentState(b, { status: 'frozen' }), T.PAYMENT_STATE.HELD);
});

test('refund is only reported when the ledger says refunded', () => {
    const b = approved(250, { escrowId: 'esc_1' });
    assert.strictEqual(T.resolvePaymentState(b, { status: 'refunded' }), T.PAYMENT_STATE.REFUNDED);
    // A cancelled booking with no refund recorded must NOT claim a refund.
    const cancelled = T.resolvePaymentState({ ...baseInspection, status: 'cancelled' });
    assert.notStrictEqual(cancelled, T.PAYMENT_STATE.REFUNDED);
});

test('a refunded callout is reported from calloutSettled', () => {
    const b = { ...baseInspection, calloutPaid: true, calloutSettled: 'refunded' };
    assert.strictEqual(T.resolvePaymentState(b), T.PAYMENT_STATE.REFUNDED);
});

test('fully credited quote reports NONE_DUE rather than an unpaid balance', () => {
    const s = T.resolvePaymentState(approved(1.00));
    assert.strictEqual(s, T.PAYMENT_STATE.NONE_DUE);
    assert.strictEqual(T.paymentStateLabel(s), 'No further payment due');
});

test('fully credited quote whose callout was settled reads as paid out', () => {
    const b = approved(1.00, { calloutSettled: 'released' });
    assert.strictEqual(T.resolvePaymentState(b), T.PAYMENT_STATE.RELEASED);
});

test('approved but unknown funding is UNRESOLVED, never assumed settled', () => {
    const b = { ...baseInspection, quoteApproved: true, jobQuote: 100 };  // no escrowHeldAmount
    assert.strictEqual(T.resolvePaymentState(b), T.PAYMENT_STATE.UNRESOLVED);
});

test('escrowStatus is NOT a booking field — it must never be relied on', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'shared', 'js', 'domain', 'bookingTruth.js'), 'utf8');
    assert.ok(!/b\.escrowStatus/.test(src),
        'booking.escrowStatus does not exist; escrow state lives on escrow/{escrowId}');
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. LOAD STATE — "not loaded yet" is never "does not exist"
// ═════════════════════════════════════════════════════════════════════════════

test('no snapshot yet is LOADING, not NOT_FOUND', () => {
    assert.strictEqual(T.classifyLookup({ snapshotReceived: false }), T.LOAD_STATE.LOADING);
    assert.strictEqual(T.classifyLookup({}), T.LOAD_STATE.LOADING);
});

test('an authoritative empty answer is NOT_FOUND', () => {
    assert.strictEqual(
        T.classifyLookup({ snapshotReceived: true, exists: false }), T.LOAD_STATE.NOT_FOUND);
});

test('an error is ERROR, never NOT_FOUND', () => {
    assert.strictEqual(
        T.classifyLookup({ snapshotReceived: true, exists: false, error: new Error('offline') }),
        T.LOAD_STATE.ERROR,
        'a network failure must not be reported as "you have no booking"');
});

test('a resolved booking is FOUND', () => {
    assert.strictEqual(
        T.classifyLookup({ snapshotReceived: true, exists: true }), T.LOAD_STATE.FOUND);
});

test('live-tracking no longer gates its empty state on localStorage', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'customer-app', 'live-tracking.html'), 'utf8');
    assert.ok(!/_trkNoActiveBooking\s*=\s*notTrackable/.test(src),
        'the localStorage pre-gate is back');
    assert.ok(/showBookingLoadingState/.test(src),
        'the explicit loading state is missing');
});

test('book-request opens on a neutral boot view, not the request form', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'customer-app', 'book-request.html'), 'utf8');
    assert.ok(/id="view-boot"/.test(src), 'the boot view is missing');
    assert.ok(/<section class="br-view" id="view-request" hidden>/.test(src),
        'the request form must not be the default painted view — it flashes on ?resume=');
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. RECEIPT SEMANTICS — components stay distinct
// ═════════════════════════════════════════════════════════════════════════════

test('receipt itemises callout, quote, credit and additional amount separately', () => {
    const r = T.resolveReceipt(approved(250, { status: 'completed', escrowId: 'esc_1' }), REAL_ID, { status: 'released' });
    const byKey = Object.fromEntries(r.lines.map(l => [l.key, l.amount]));
    assert.strictEqual(byKey.callout, 1.00);
    assert.strictEqual(byKey.quote, 250);
    assert.strictEqual(byKey.credit, -1.00, 'credit is shown as a deduction');
    assert.strictEqual(byKey.due, 249.00);
    assert.strictEqual(r.totalCharged, 250.00);
});

test('receipt for a fully credited job shows zero additional, total = callout', () => {
    const r = T.resolveReceipt(approved(1.00, { status: 'completed', calloutSettled: 'released' }), REAL_ID);
    const byKey = Object.fromEntries(r.lines.map(l => [l.key, l.amount]));
    assert.strictEqual(byKey.due, 0);
    assert.strictEqual(r.totalCharged, 1.00);
    assert.strictEqual(r.artisan.name, 'Kwame Mensah');
    assert.strictEqual(r.service, 'Plumbing');
    assert.strictEqual(r.bookingId, REAL_ID);
});

test('receipt distinguishes settled from merely resolvable', () => {
    const live = T.resolveReceipt(approved(250, { status: 'in_progress' }), REAL_ID);
    assert.strictEqual(live.resolved, true);
    assert.strictEqual(live.settled, false, 'an in-flight job is not a receipt');
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. MARKETPLACE HANDOFF — the customer's information must reach the artisan
// ═════════════════════════════════════════════════════════════════════════════

const LONG_PROBLEM =
    'The kitchen tap has been dripping for a week and the cabinet below is getting wet. ' +
    'I have put a bowl underneath but the chipboard is already swelling at the back corner, ' +
    'and there is a smell of damp. The stopcock under the sink is stiff and I could not close it.';

const full = {
    ...baseInspection,
    status: 'pending',
    artisanId: 'art_1',
    customerFirstName: 'Ama',
    customerPhone: '+233201234567',
    description: LONG_PROBLEM,
    address: '12 Patrice Lumumba Road, Airport Residential Area, Accra',
    lat: 5.6108, lng: -0.1821,
    photos: ['https://res.cloudinary.com/x/a.jpg', 'https://res.cloudinary.com/x/b.jpg'],
    calloutPaid: false,
};

test('handoff: the problem description reaches the artisan IN FULL', () => {
    const j = T.resolveJobBrief(full);
    assert.strictEqual(j.problem, LONG_PROBLEM);
    assert.ok(j.problem.length > 200, 'the description must not be truncated in the data');
    assert.ok(j.problem.includes('stopcock'), 'the end of the description survived');
});

test('handoff: a missing description is explicit, not a blank', () => {
    assert.strictEqual(T.resolveJobBrief({ ...full, description: '' }).problem, null);
});

test('handoff: the customer is named, not labelled "Customer"', () => {
    assert.strictEqual(T.resolveJobBrief(full).customer.name, 'Ama');
    assert.strictEqual(T.resolveJobBrief({ ...full, customerFirstName: null }).customer.name, null);
});

test('handoff: photos reach the artisan — 0, 1 and many', () => {
    assert.strictEqual(T.resolveJobBrief({ ...full, photos: [] }).photoCount, 0);
    assert.strictEqual(T.resolveJobBrief({ ...full, photos: [full.photos[0]] }).photoCount, 1);
    assert.strictEqual(T.resolveJobBrief(full).photoCount, 2);
    assert.deepStrictEqual(T.resolveJobBrief(full).photos, full.photos);
});

test('handoff: malformed photo entries are dropped, not rendered', () => {
    const j = T.resolveJobBrief({ ...full, photos: ['not-a-url', null, 42, 'https://ok/x.jpg'] });
    assert.deepStrictEqual(j.photos, ['https://ok/x.jpg']);
});

test('handoff: the FULL address reaches the artisan', () => {
    const j = T.resolveJobBrief(full);
    assert.strictEqual(j.location.address, full.address);
    assert.ok(j.location.address.length > 28, 'the 28-char truncation is gone');
});

test('handoff: navigation targets the CUSTOMER coordinates', () => {
    const j = T.resolveJobBrief(full, { originLat: 5.6037, originLng: -0.1870 });
    assert.ok(j.location.mapUrl.indexOf('destination=5.6108,-0.1821') !== -1,
        'must navigate to the booking location, not the artisan position');
    assert.strictEqual(j.location.precision, 'gps');
});

test('handoff: no GPS falls back to the address, never to a city centre', () => {
    const j = T.resolveJobBrief({ ...full, lat: null, lng: null });
    assert.strictEqual(j.location.hasCoords, false);
    assert.strictEqual(j.location.precision, 'address-only');
    assert.ok(j.location.mapUrl.indexOf('maps/search') !== -1, 'address query, not coordinates');
    assert.ok(j.location.mapUrl.indexOf('5.6037') === -1, 'no fabricated Accra centre');
});

test('handoff: no location at all yields no navigation affordance', () => {
    const j = T.resolveJobBrief({ ...full, lat: null, lng: null, address: '' });
    assert.strictEqual(j.location.mapUrl, null);
    assert.strictEqual(j.location.precision, 'none');
});

test('handoff: 0,0 coordinates are rejected as a fix', () => {
    assert.strictEqual(T.resolveJobBrief({ ...full, lat: 0, lng: 0 }).location.hasCoords, false);
});

// ── Compensation: the "GHS 0" bug ────────────────────────────────────────────

test('compensation: an unquoted inspection shows the CALLOUT fee, never 0', () => {
    const c = T.resolveArtisanCompensation(full);
    assert.strictEqual(c.amount, 1.00, 'the old chain jobQuote||total||price||0 produced 0 here');
    assert.ok(/callout/i.test(c.label));
    assert.strictEqual(c.conditional, true, 'not yet funded by the customer');
});

test('compensation: a paid callout is no longer conditional', () => {
    const c = T.resolveArtisanCompensation({ ...full, calloutPaid: true });
    assert.strictEqual(c.conditional, false);
    assert.ok(/secured/i.test(c.note));
});

test('compensation: once quoted, earnings are net of commission', () => {
    const c = T.resolveArtisanCompensation(approved(250, { artisanEarns: 212.5, commissionRate: 0.15 }));
    assert.strictEqual(c.gross, 250);
    assert.strictEqual(c.amount, 212.5);
    assert.strictEqual(c.conditional, false);
});

test('compensation: an unapproved quote is flagged conditional', () => {
    const c = T.resolveArtisanCompensation(quoted(250, { artisanEarns: 212.5 }));
    assert.strictEqual(c.conditional, true);
    assert.ok(/if the customer approves/i.test(c.note));
});

test('compensation: unknown is null, never zero', () => {
    const c = T.resolveArtisanCompensation({ status: 'pending' });
    assert.strictEqual(c.amount, null);
    assert.notStrictEqual(c.amount, 0);
});

// ── Distance: never fabricate proximity ──────────────────────────────────────

test('distance: omitted when the artisan has no position', () => {
    const j = T.resolveJobBrief(full);
    assert.strictEqual(j.distanceKm, null);
    assert.strictEqual(T.formatDistance(j.distanceKm), null, 'no "0.0 km"');
});

test('distance: computed from real coordinates', () => {
    const j = T.resolveJobBrief(full, { originLat: 5.6037, originLng: -0.1870 });
    assert.ok(j.distanceKm > 0.5 && j.distanceKm < 3, 'expected ~1km, got ' + j.distanceKm);
});

test('distance: sub-100 m is described, not rounded to a bare 0.0 km', () => {
    assert.strictEqual(T.formatDistance(0.02), 'under 100 m away');
    assert.strictEqual(T.formatDistance(0), 'under 100 m away');
    assert.strictEqual(T.formatDistance(null), null);
});

test('distance: null island coordinates never produce a distance', () => {
    assert.strictEqual(T.distanceKm(0, 0, 5.6, -0.18), null);
});

// ── Phase: inspection cycle vs work cycle ────────────────────────────────────

test('phase: the two cycles are distinguishable on identical statuses', () => {
    const insp = { ...full, status: 'en_route', calloutPaid: true, quoteApproved: false };
    const work = { ...full, status: 'en_route', calloutPaid: true, quoteApproved: true };
    assert.strictEqual(T.resolveJobPhase(insp), T.JOB_PHASE.INSPECTION);
    assert.strictEqual(T.resolveJobPhase(work), T.JOB_PHASE.WORK);
    assert.strictEqual(T.resolveJobBrief(insp).cycle, 'Inspection');
    assert.strictEqual(T.resolveJobBrief(work).cycle, 'Work',
        'after approval the artisan must see a NEW cycle, not a repeat of the old one');
});

test('phase: accepted-but-unpaid is its own waiting state', () => {
    assert.strictEqual(
        T.resolveJobPhase({ ...full, status: 'accepted', calloutPaid: false }),
        T.JOB_PHASE.AWAITING_CALLOUT);
});

test('phase: inspection done means quote needed', () => {
    assert.strictEqual(
        T.resolveJobPhase({ ...full, status: 'inspection_done', calloutPaid: true }),
        T.JOB_PHASE.QUOTING);
});

test('phase: a submitted quote is awaiting approval, not quotable again', () => {
    assert.strictEqual(
        T.resolveJobPhase({ ...full, status: 'quoted', calloutPaid: true }),
        T.JOB_PHASE.AWAITING_QUOTE);
});

// ── Privacy ──────────────────────────────────────────────────────────────────

test('privacy: the phone is withheld until the artisan has committed', () => {
    assert.strictEqual(T.resolveJobBrief(full).customer.phone, null,
        'a dispatched candidate who has not accepted gets no phone number');
    assert.strictEqual(
        T.resolveJobBrief({ ...full, status: 'accepted', calloutPaid: false }).customer.phone, null);
    assert.strictEqual(
        T.resolveJobBrief({ ...full, status: 'en_route', calloutPaid: true }).customer.phone,
        '+233201234567', 'an artisan on the way can reach the customer');
});

test('privacy: only the first name is carried, never a full name', () => {
    const j = T.resolveJobBrief({ ...full, customerFirstName: 'Ama', customerFullName: 'Ama Serwaa Boateng' });
    assert.strictEqual(j.customer.name, 'Ama');
});

test('identity: a dispatched OFFER is not yet an assignment', () => {
    const offered = { ...full, status: 'dispatched', artisanId: 'art_1', artisanName: 'Kwame Mensah' };
    assert.strictEqual(T.resolveArtisan(offered).isAssigned, false);
    assert.strictEqual(T.resolveArtisan({ ...offered, status: 'accepted' }).isAssigned, true);
});

test('handoff: the brief carries the same booking id as the record', () => {
    assert.strictEqual(T.resolveJobBrief(full).bookingId, REAL_ID);
});

test('handoff: the artisan job card no longer hardcodes a zero amount', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'artisan-app', 'jobs.html'), 'utf8');
    assert.ok(src.indexOf('b.jobQuote || b.total || b.price || 0') === -1,
        'the compensation chain that produced "GHS 0" is back');
    assert.ok(src.indexOf('b.address.slice(0, 28)') === -1,
        'the 28-character address truncation is back');
    assert.ok(src.indexOf('resolveJobBrief') !== -1,
        'the job card must consume the shared information contract');
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. THE JOURNEY — where am I, what just happened, what happens next
// ═════════════════════════════════════════════════════════════════════════════

const named = { ...full, artisanName: 'Kwame Mensah', status: 'accepted' };

test('journey: every live state answers all three questions', () => {
    const states = [
        { ...full, status: 'pending' },
        { ...named, status: 'accepted', calloutPaid: false },
        { ...named, status: 'inspection_scheduled', calloutPaid: true },
        { ...named, status: 'en_route', calloutPaid: true },
        { ...named, status: 'inspection_done', calloutPaid: true },
        { ...named, status: 'quoted', calloutPaid: true, jobQuote: 250 },
        { ...named, status: 'en_route', calloutPaid: true, quoteApproved: true, jobQuote: 250 },
        { ...named, status: 'awaiting', calloutPaid: true, quoteApproved: true, jobQuote: 250 },
    ];
    for (const audience of ['customer', 'artisan']) {
        for (const b of states) {
            const j = T.resolveJourney(b, audience);
            assert.ok(j.here && j.here.length > 3, `no "where am I" for ${audience}/${b.status}`);
            assert.ok(j.just && j.just.length > 3, `no "what happened" for ${audience}/${b.status}`);
            assert.ok(j.next && j.next.length > 3, `no "what next" for ${audience}/${b.status}`);
        }
    }
});

test('journey: exactly one primary action, never a list', () => {
    const b = { ...named, status: 'awaiting', calloutPaid: true, quoteApproved: true, jobQuote: 250 };
    const j = T.resolveJourney(b, 'customer');
    assert.ok(j.action, 'the customer must have something to do here');
    assert.strictEqual(typeof j.action.label, 'string');
    assert.ok(!Array.isArray(j.action), 'action must be a single action');
});

test('journey: waiting states offer no action rather than a dead button', () => {
    const artisanWaiting = T.resolveJourney(
        { ...named, status: 'quoted', calloutPaid: true, jobQuote: 250 }, 'artisan');
    assert.strictEqual(artisanWaiting.action, null);
    assert.strictEqual(artisanWaiting.tone, 'waiting');

    const customerWaiting = T.resolveJourney(
        { ...named, status: 'inspection_done', calloutPaid: true }, 'customer');
    assert.strictEqual(customerWaiting.action, null);
});

test('journey: the two sides describe the SAME moment differently but agree on stage', () => {
    const b = { ...named, status: 'quoted', calloutPaid: true, jobQuote: 250 };
    const c = T.resolveJourney(b, 'customer');
    const a = T.resolveJourney(b, 'artisan');
    assert.strictEqual(c.stageIndex, a.stageIndex, 'both sides must be at the same point');
    assert.notStrictEqual(c.here, a.here, 'but each sees their own side of it');
    assert.ok(/your quote is ready/i.test(c.here));
    assert.ok(/quote sent/i.test(a.here));
});

test('journey: actions are state-appropriate and never stale', () => {
    const payFee = T.resolveJourney({ ...named, status: 'accepted', calloutPaid: false }, 'customer');
    assert.ok(/pay visit fee/i.test(payFee.action.label));
    assert.ok(payFee.action.label.includes('GHS'), 'the amount is named on the button');

    const confirm = T.resolveJourney(
        { ...named, status: 'awaiting', calloutPaid: true, quoteApproved: true }, 'customer');
    assert.ok(/confirm/i.test(confirm.action.label));
    assert.ok(/releases the payment/i.test(confirm.next), 'the consequence is stated, not hidden');
});

test('journey: no generic "Continue" anywhere', () => {
    for (const st of ['pending', 'accepted', 'inspection_scheduled', 'en_route',
                      'inspection_done', 'quoted', 'awaiting', 'completed']) {
        for (const aud of ['customer', 'artisan']) {
            const j = T.resolveJourney({ ...named, status: st, calloutPaid: true }, aud);
            if (j.action) {
                assert.ok(!/^(continue|next|ok|submit)$/i.test(j.action.label.trim()),
                    `ambiguous CTA "${j.action.label}" at ${aud}/${st}`);
            }
        }
    }
});

test('journey: a fully credited quote says so instead of naming a payment', () => {
    const b = { ...named, status: 'quoted', calloutPaid: true, calloutFee: 250,
                jobQuote: 250, amountDuePreview: 0, calloutCreditPreview: 250 };
    const j = T.resolveJourney(b, 'customer');
    assert.ok(/covers it in full/i.test(j.next));
});

test('journey: dead ends are explained, not left as a stage', () => {
    const cancelled = T.resolveJourney({ ...named, status: 'cancelled' }, 'customer');
    assert.strictEqual(cancelled.terminal, true);
    assert.ok(/closed/i.test(cancelled.here));
    assert.ok(cancelled.action, 'a dead end still offers a way forward');

    const unfulfilled = T.resolveJourney({ ...named, status: 'unfulfilled' }, 'customer');
    assert.ok(/no professional available/i.test(unfulfilled.here));
    assert.ok(/nothing was charged/i.test(unfulfilled.just), 'money reassurance is explicit');
});

test('journey: a refunded cancellation says where the money went', () => {
    const j = T.resolveJourney(
        { ...named, status: 'cancelled', calloutPaid: true, calloutSettled: 'refunded' }, 'customer');
    assert.ok(/refunded to your wallet/i.test(j.just));
});

test('journey stages: six stages, one current, past done, future todo', () => {
    const st = T.journeyStages({ ...named, status: 'quoted', calloutPaid: true, jobQuote: 250 }, 'customer');
    assert.strictEqual(st.length, 6);
    assert.strictEqual(st.filter(s => s.state === 'current').length, 1);
    const cur = st.findIndex(s => s.state === 'current');
    assert.ok(st.slice(0, cur).every(s => s.state === 'done'));
    assert.ok(st.slice(cur + 1).every(s => s.state === 'todo'));
});

test('journey stages: a completed booking has no current stage left', () => {
    const st = T.journeyStages({ ...named, status: 'completed' }, 'customer');
    assert.strictEqual(st.filter(s => s.state === 'current').length, 0);
    assert.ok(st.every(s => s.state === 'done'));
});

// The rail is now rendered (customer-app/js/pages/bookRequestPage.js), so a
// wrong stage is a lie in the customer's face rather than an unused value.
// These walk the whole inspection lifecycle one status at a time.
const railAt = (b) => T.journeyStages(b, 'customer').findIndex(s => s.state === 'current');

test('journey rail: the inspection lifecycle advances one stage at a time', () => {
    const insp = { ...baseInspection };
    const steps = [
        ['dispatching',          { ...insp, status: 'dispatching', calloutPaid: false }, 0],
        ['accepted (unpaid)',    { ...insp, status: 'accepted', calloutPaid: false },    1],
        ['inspection_scheduled', { ...insp, status: 'inspection_scheduled' },            2],
        ['en_route (inspect)',   { ...insp, status: 'en_route' },                        2],
        ['inspection_done',      { ...insp, status: 'inspection_done' },                 3],
        ['quoted',               { ...insp, status: 'quoted', jobQuote: 250 },           3],
        ['approved, working',    { ...insp, status: 'in_progress', jobQuote: 250, quoteApproved: true }, 4],
    ];
    for (const [label, booking, expected] of steps) {
        assert.strictEqual(railAt(booking), expected, `${label} should sit at stage ${expected}`);
    }
});

test('journey rail: an inspection status with no track field is never reported as Work', () => {
    // `track` is one field written by one Cloud Function. If it is ever absent,
    // the phase fallthrough used to report WORK — telling a customer whose
    // professional has not yet visited that the job was underway, with the rail
    // five stages ahead of the truth.
    for (const status of ['inspection_scheduled', 'inspection_done']) {
        const { track, ...noTrack } = { ...baseInspection, status };
        assert.notStrictEqual(T.resolveJobPhase(noTrack), T.JOB_PHASE.WORK,
            `${status} without a track field must not read as work in progress`);
        assert.ok(railAt(noTrack) < 4, `${status} must not jump the rail to Work`);
    }
});

test('journey: the artisan never sees a quote action once the quote is in', () => {
    const j = T.resolveJourney({ ...named, status: 'quoted', calloutPaid: true, jobQuote: 250 }, 'artisan');
    assert.ok(!j.action, 'a submitted quote must not offer to quote again');
});

// ── Manufactured urgency and encoding ────────────────────────────────────────

test('the countdown on the no-payment fee screen is gone', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'customer-app', 'js', 'pages', 'bookRequestPage.js'), 'utf8');
    assert.ok(src.indexOf('Fee locked for') === -1,
        'the countdown is back on a screen that takes no payment');
});

test('the customer-chosen professional is passed to pricing, not discarded', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'customer-app', 'js', 'pages', 'bookRequestPage.js'), 'utf8');
    assert.ok(src.indexOf('artisanId: S.artisanId') !== -1,
        'the chosen professional must reach getPricingQuote');
    assert.ok(src.indexOf("sessionStorage.getItem('hh_selected_artisan')") !== -1,
        'the selection must be read before it is cleared');
});

test('no double-encoded UTF-8 remains in USER-VISIBLE copy', () => {
    // Scoped to rendered markup. Comments and CSS/JS blocks are stripped first:
    // some decorative box-drawing separators inside HTML comments are still
    // double-encoded and are deliberately out of scope — they render nothing.
    // What must be clean is every string a customer or artisan can actually read.
    const RUN = new RegExp('[\\u00C2-\\u00EF][\\u0080-\\u00FF\\u20AC\\u2018\\u2019\\u201C\\u201D\\u2013\\u2014\\u2026\\u2122]');
    const bad = [];

    function visible(src) {
        return src
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<script[\s\S]*?<\/script>/gi, '');
    }

    function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules') continue;
            const f = path.join(dir, e.name);
            if (e.isDirectory()) { walk(f); continue; }
            if (!/\.html$/.test(e.name)) continue;
            if (RUN.test(visible(fs.readFileSync(f, 'utf8')))) {
                bad.push(path.relative(path.join(__dirname, '..'), f));
            }
        }
    }
    walk(path.join(__dirname, '..', 'customer-app'));
    walk(path.join(__dirname, '..', 'artisan-app'));

    assert.deepStrictEqual(bad, [], 'double-encoded UTF-8 is visible to users again');
});

test('the primary CTAs specifically are clean', () => {
    // The three strings the original audit caught on screen.
    const login = fs.readFileSync(path.join(__dirname, '..', 'customer-app', 'login.html'), 'utf8');
    const book  = fs.readFileSync(path.join(__dirname, '..', 'customer-app', 'book-request.html'), 'utf8');
    assert.ok(login.indexOf('→') !== -1, 'the login arrow should be a real arrow');
    assert.ok(book.indexOf('·') !== -1, 'the photo label should use a real middle dot');
    assert.ok(book.indexOf('—') !== -1, 'the fee copy should use a real em dash');
    // Comments and style blocks are excluded: a decorative separator inside a
    // CSS comment is still double-encoded and renders nothing. What must be
    // clean is the copy on screen.
    const strip = (src) => src
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '');
    for (const src of [login, book]) {
        const v = strip(src);
        assert.ok(v.indexOf('â€') === -1 && v.indexOf('Ã¢') === -1,
            'mojibake markers are back in a primary screen');
    }
});

test('validation is inline and preserves the customer input', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'customer-app', 'js', 'pages', 'bookRequestPage.js'), 'utf8');
    assert.ok(src.indexOf('setFieldError') !== -1, 'inline field errors are missing');
    assert.ok(src.indexOf('aria-invalid') !== -1, 'errors must be announced to assistive tech');
    // Nothing in validation may clear the fields.
    assert.ok(!/validateRequest[\s\S]{0,900}\.value\s*=\s*''/.test(src),
        'validation must never wipe what the customer typed');
});

test('quote decision: the first decline asks for a revision, not the end', () => {
    const d = T.resolveQuoteDecision({ quoteRevisionCount: 0 });
    assert.strictEqual(d.canRevise, true);
    assert.ok(/different price/i.test(d.label), 'must not read as terminal');
    assert.ok(!/reject/i.test(d.label), '"Reject" hid the revision the backend allows');
    assert.ok(/one revised quote/i.test(d.body));
});

test('quote decision: the second decline says it ends the job and what it costs', () => {
    const d = T.resolveQuoteDecision({ quoteRevisionCount: 1 });
    assert.strictEqual(d.canRevise, false);
    assert.ok(/decline/i.test(d.label));
    assert.ok(/ends the job/i.test(d.body), 'the consequence must be stated up front');
    assert.ok(/visit fee pays/i.test(d.body), 'and where the money goes');
});

test('quote decision: the promised revision is no longer contradicted by the UI', () => {
    const modal = fs.readFileSync(
        path.join(__dirname, '..', 'customer-app', 'js', 'quoteModalService.js'), 'utf8');
    const page = fs.readFileSync(
        path.join(__dirname, '..', 'customer-app', 'quote-approval.html'), 'utf8');
    for (const src of [modal, page]) {
        assert.ok(src.indexOf('resolveQuoteDecision') !== -1,
            'decline wording must follow the single-revision rule');
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// REPUTATION — "no reviews yet" is not "zero stars"
// ═════════════════════════════════════════════════════════════════════════════

test('rating: an artisan with no reviews is never shown a score', () => {
    // The exact production document: 7 jobs completed, never reviewed.
    const r = T.resolveRating({ rating: 0, reviewCount: null, jobsCompleted: 7 });
    assert.strictEqual(r.hasReviews, false);
    assert.strictEqual(r.rating, null, 'must be unresolved, never 0');
    assert.strictEqual(r.reviewCount, 0, 'null reviewCount normalises to 0');
    assert.ok(/no reviews/i.test(r.label));
    assert.ok(!/0\.0/.test(r.label), '"0.0" reads as seven one-star customers');
});

test('rating: reviewCount 0 behaves the same as null', () => {
    const a = T.resolveRating({ rating: 0, reviewCount: 0 });
    const b = T.resolveRating({ rating: 0, reviewCount: null });
    assert.strictEqual(a.hasReviews, b.hasReviews);
    assert.strictEqual(a.rating, b.rating);
});

test('rating: a real average renders with its count', () => {
    const r = T.resolveRating({ rating: 4.75, reviewCount: 27 });
    assert.strictEqual(r.hasReviews, true);
    assert.strictEqual(r.rating, 4.8);
    assert.strictEqual(r.short, '4.8');
    assert.ok(/27 reviews/.test(r.label));
});

test('rating: singular wording for exactly one review', () => {
    assert.ok(/1 review\)/.test(T.resolveRating({ rating: 5, reviewCount: 1 }).label));
});

test('rating: reviews present but score unusable is unresolved, not zero', () => {
    const r = T.resolveRating({ rating: null, reviewCount: 3 });
    assert.strictEqual(r.hasReviews, false);
    assert.strictEqual(r.rating, null);
    assert.strictEqual(r.reviewCount, 3);
});

test('rating: no surface renders a bare 0.0 for an unrated artisan', () => {
    const files = [
        ['customer-app', 'js', 'nearbyPros.js'],
        ['customer-app', 'artisan-profile.html'],
        ['customer-app', 'saved.html'],
        ['customer-app', 'book-emergency.html'],
    ];
    for (const parts of files) {
        const src = stripComments(fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8'));
        assert.ok(!/rating\s*!=\s*null\s*\?\s*Number\(/.test(src),
            `${parts.join('/')} still gates a score on the rating value, not reviewCount`);
        assert.ok(!/Number\(\s*a\.rating\s*\|\|\s*0\s*\)\.toFixed\(1\)/.test(src),
            `${parts.join('/')} still renders 0.0 for an unrated artisan`);
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// REVIEW ELIGIBILITY — mirrors the Firestore rule exactly
// ═════════════════════════════════════════════════════════════════════════════

const done = { customerId: 'c1', artisanId: 'a1', status: 'completed' };

test('review: the customer of a completed, unreviewed booking may review', () => {
    assert.strictEqual(T.resolveReviewEligibility(done, 'c1').canReview, true);
});

test('review: a different customer may not review someone else\'s booking', () => {
    const e = T.resolveReviewEligibility(done, 'someone_else');
    assert.strictEqual(e.canReview, false);
    assert.strictEqual(e.reason, 'not_customer');
});

test('review: the artisan may not review their own job', () => {
    const e = T.resolveReviewEligibility(done, 'a1');
    assert.strictEqual(e.canReview, false, 'self-review would be rating fraud');
    assert.strictEqual(e.reason, 'not_customer');
});

test('review: ineligible booking statuses are refused', () => {
    for (const status of ['cancelled', 'unfulfilled', 'pending', 'quoted', 'awaiting']) {
        const e = T.resolveReviewEligibility({ ...done, status }, 'c1');
        assert.strictEqual(e.canReview, false, `${status} must not be reviewable`);
        assert.strictEqual(e.reason, 'not_completed');
    }
});

test('review: a booking already carrying a rating cannot be reviewed again', () => {
    const e = T.resolveReviewEligibility({ ...done, rating: 4 }, 'c1');
    assert.strictEqual(e.canReview, false);
    assert.strictEqual(e.reason, 'already_reviewed');
});

test('review: the rules enforce one review per booking server-side', () => {
    const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
    assert.ok(rules.indexOf("!('rating' in existing())") !== -1,
        'without this a customer could rewrite their score while the aggregate kept the first');
    assert.ok(/'ratingProcessed'/.test(rules),
        'the aggregation idempotency flag must be server-only');
});

test('review: submission never invents a rating and never fakes success', () => {
    // Scan CODE only: the file documents the old bug in a comment, and a source
    // grep that cannot tell the two apart would forbid describing what was fixed.
    const src = stripComments(
        fs.readFileSync(path.join(__dirname, '..', 'customer-app', 'review.html'), 'utf8'));
    assert.ok(!/currentRating\s*\|\|\s*5/.test(src),
        'submitting with no star selected must not send a 5-star review');
    assert.ok(/await\s+window\._persistReviewToFirestore/.test(src),
        'the write must be awaited before success is shown');
    assert.ok(!/Fire-and-forget[\s\S]{0,80}success overlay is shown regardless/.test(src),
        'success must follow backend confirmation');
});

// ═════════════════════════════════════════════════════════════════════════════
// FIN-002 — money wording follows the escrow outcome, never the phase alone
// ═════════════════════════════════════════════════════════════════════════════
// Audit 28 Oct 2026: a cancelled inspection read "GHS 60.00 · Secured in escrow
// for this visit" after the fee was refunded; a completed job read "Approved
// and secured in escrow" after it was paid out.
{
    const ESC = 'esc_fin002';
    const job = (status) => approved(250, { escrowId: ESC, artisanEarns: 212.5, commissionRate: 0.15, status });
    // Escrow documents exactly as the server writes them. Nothing else writes
    // escrow/{id}: firestore.rules deny every client write.
    const AT = '2026-10-28T12:00:00.000Z';
    const HOLD = {                                   // functions/financial/escrow.js:355-370 (hold)
        bookingId: REAL_ID, customerId: 'cust_1', artisanId: 'art_1', kind: 'job',
        amount: 249, commission: 37.35, artisanShare: 211.65, commissionRate: 0.15,
        status: 'held', customerConfirmed: false, artisanConfirmed: false, disputeId: null,
    };
    const ESCROWS = {
        held:     HOLD,
        released: { ...HOLD, status: 'released', releasedBy: 'system', releasedAt: AT, updatedAt: AT },     // escrow.js:574
        refunded: { ...HOLD, status: 'refunded', refundedBy: 'system', refundReason: 'Booking cancelled',   // escrow.js:698-704
                    refundedAt: AT, updatedAt: AT },
        partial:  { ...HOLD, status: 'refunded', resolutionType: 'partial', customerAmount: 125,           // disputes.js:255-265
                    artisanAmount: 106.25, commission: 18.75, refundedBy: 'ops@example.com',
                    refundReason: 'Dispute partial settlement: half done', refundedAt: AT, updatedAt: AT },
        disputed: { ...HOLD, status: 'disputed', disputeId: 'dsp_1', disputedBy: 'cust_1',                 // escrow.js:857-863
                    disputedAt: AT, updatedAt: AT },
        missing:  null,                              // not loaded, unreadable, or still pending
    };
    const OPEN = ['accepted', 'en_route', 'in_progress', 'awaiting'];
    const ALL  = [...OPEN, 'completed', 'cancelled', 'disputed'];
    const MOVED = ['released', 'refunded', 'partial'];

    test('FIN-002 payment state: a partial dispute split and a disputed escrow are named', () => {
        assert.strictEqual(T.resolvePaymentState(job('completed'), ESCROWS.partial), T.PAYMENT_STATE.PARTIAL);
        assert.strictEqual(T.paymentStateLabel(T.PAYMENT_STATE.PARTIAL), 'Partly refunded');
        assert.strictEqual(T.resolvePaymentState(job('disputed'), ESCROWS.disputed), T.PAYMENT_STATE.DISPUTED);
        assert.strictEqual(T.paymentStateLabel(T.PAYMENT_STATE.DISPUTED), 'On hold (dispute)');
        assert.strictEqual(T.resolvePaymentState(job('completed'), ESCROWS.refunded), T.PAYMENT_STATE.REFUNDED,
            'a whole refund is still a whole refund');
    });

    // Every escrow outcome × every status, for an approved quote.
    for (const [name, escrow] of Object.entries(ESCROWS)) {
        for (const status of ALL) {
            test(`FIN-002 approved quote · escrow ${name} · status ${status}`, () => {
                const c = T.resolveArtisanCompensation(job(status), escrow);
                const where = `${name}/${status}: ${c.amount} "${c.note}"`;
                assert.ok(typeof c.note === 'string' && c.note.length > 0, where);
                if (MOVED.includes(name)) {
                    assert.ok(!/secured/i.test(c.note), `money that moved is never "secured" — ${where}`);
                    assert.strictEqual(c.conditional, false, where);
                }
                if (name === 'released') {
                    assert.strictEqual(c.amount, 212.5, where);
                    assert.strictEqual(c.note, 'Paid to your wallet.', where);
                    assert.strictEqual(c.outcome, T.PAYMENT_STATE.RELEASED);
                }
                if (name === 'refunded') {
                    assert.strictEqual(c.amount, 0, where);
                    assert.match(c.note, /^No payment: .*refunded to the customer/, where);
                    assert.strictEqual(c.outcome, T.PAYMENT_STATE.REFUNDED);
                }
                if (name === 'partial') {
                    assert.strictEqual(c.amount, 106.25, `the server's artisanAmount — ${where}`);
                    assert.match(c.note, /dispute/i, where);
                    assert.match(c.note, /GHS 106\.25 was paid to your wallet/, where);
                }
                if (name === 'disputed') {
                    assert.strictEqual(c.conditional, true, where);
                    assert.match(c.note, /dispute/i, where);
                    assert.ok(!/secured|paid to your wallet/i.test(c.note), where);
                }
                if (name === 'held' || name === 'missing') {
                    if (OPEN.includes(status)) {
                        // quoteApproved is stamped with the hold: an open approved job is funded.
                        assert.strictEqual(c.note, 'Approved and secured in escrow.', where);
                        assert.strictEqual(c.conditional, false, where);
                    } else {
                        assert.ok(!/secured|paid to your wallet|was released|released to/i.test(c.note),
                            `a closed or disputed job claims neither "secured" nor "paid" — ${where}`);
                        assert.strictEqual(c.conditional, true, where);
                        assert.strictEqual(c.amount, 212.5, 'the figure stays, marked conditional');
                    }
                }
            });
        }
    }

    test('FIN-002 approved quote: a completed job whose escrow is still held says so', () => {
        const c = T.resolveArtisanCompensation(job('completed'), ESCROWS.held);
        assert.match(c.note, /held in escrow until the release completes/i);
    });

    test('FIN-002 approved quote: a completed job with the escrow not loaded points to the wallet', () => {
        const c = T.resolveArtisanCompensation(job('completed'), null);
        assert.match(c.note, /customer confirmed the job/i);
        assert.match(c.note, /wallet shows the payment once it is released/i);
        assert.strictEqual(c.outcome, T.PAYMENT_STATE.UNRESOLVED);
    });

    // The callout fee: paid? × settled? × status.
    const insp = (status, extra = {}) => ({ ...baseInspection, calloutFee: 60, status, ...extra });
    const CALLOUT = {
        unpaid:   { calloutPaid: false },
        held:     { calloutPaid: true },
        released: { calloutPaid: true, calloutSettled: 'released' },
        refunded: { calloutPaid: true, calloutSettled: 'refunded' },
    };
    const C_OPEN = ['accepted', 'inspection_scheduled', 'en_route', 'in_progress', 'inspection_done'];
    const C_ALL  = [...C_OPEN, 'completed', 'cancelled', 'rejected', 'unfulfilled', 'disputed'];
    for (const [name, fields] of Object.entries(CALLOUT)) {
        for (const status of C_ALL) {
            test(`FIN-002 callout · ${name} · status ${status}`, () => {
                const c = T.resolveArtisanCompensation(insp(status, fields));
                const where = `${name}/${status}: ${c.amount} "${c.note}"`;
                assert.strictEqual(c.label, 'Callout / inspection fee', where);
                const closed = ['completed', 'cancelled', 'rejected', 'unfulfilled'].includes(status);
                if (name === 'released') {
                    assert.strictEqual(c.amount, 60, where);
                    assert.strictEqual(c.note, 'Paid to your wallet.', where);
                    assert.strictEqual(c.conditional, false, where);
                }
                if (name === 'refunded') {
                    assert.strictEqual(c.amount, 0, where);
                    assert.strictEqual(c.note, 'No payment: the callout fee was refunded to the customer.', where);
                    assert.strictEqual(c.conditional, false, where);
                }
                if (name === 'unpaid') {
                    if (closed) {
                        assert.strictEqual(c.amount, 0, where);
                        assert.match(c.note, /closed before the callout fee was paid/, where);
                    } else {
                        assert.strictEqual(c.conditional, true, where);
                        assert.match(c.note, /^Payable once the customer funds it/, where);
                    }
                }
                if (name === 'held') {
                    if (C_OPEN.includes(status)) {
                        assert.match(c.note, /^Secured in escrow for this visit/, where);
                        assert.strictEqual(c.conditional, false, where);
                    } else {
                        assert.ok(!/secured|paid to your wallet/i.test(c.note), where);
                        assert.strictEqual(c.conditional, true, where);
                    }
                }
                if (name !== 'held' || !C_OPEN.includes(status)) {
                    assert.ok(!/^Secured/.test(c.note), `"secured" only while the visit is live and funded — ${where}`);
                }
            });
        }
    }

    test('FIN-002 the audit case: cancelled inspection, callout refunded', () => {
        const c = T.resolveArtisanCompensation(insp('cancelled', CALLOUT.refunded));
        assert.strictEqual(T.formatMoney(c.amount), 'GHS 0.00');
        assert.strictEqual(c.note, 'No payment: the callout fee was refunded to the customer.');
    });

    test('FIN-002 a closed job\'s unapproved quote earns nothing: the callout outcome speaks', () => {
        const b = { ...quoted(250, { artisanEarns: 212.5 }), calloutFee: 60, calloutPaid: true,
                    calloutSettled: 'released', status: 'cancelled' };
        const c = T.resolveArtisanCompensation(b);
        assert.strictEqual(c.label, 'Callout / inspection fee');
        assert.strictEqual(c.note, 'Paid to your wallet.');
        const open = T.resolveArtisanCompensation({ ...b, status: 'quoted', calloutSettled: undefined });
        assert.match(open.note, /if the customer approves/i, 'an open quote is still conditional');
    });

    // The same outcomes, as the CUSTOMER reads them (receipt label + closing line).
    const CUSTOMER_EXPECT = {
        held:     { label: 'Held in escrow',   line: /^You confirmed the work.$/ },
        released: { label: 'Paid out',         line: /payment was released to Kwame Mensah/ },
        refunded: { label: 'Refunded',         line: /Your payment was refunded to your wallet/ },
        partial:  { label: 'Partly refunded',  line: /part of your payment was refunded to your wallet/ },
        disputed: { label: 'On hold (dispute)', line: /on hold while a dispute is reviewed/ },
        missing:  { label: 'Not available',    line: /^You confirmed the work.$/ },
    };
    const ARTISAN_EXPECT = {
        held:     /^The customer confirmed the job.$/,
        released: /Your payment was released to your wallet/,
        refunded: /The payment was refunded to the customer/,
        partial:  /part of the payment was refunded to the customer/,
        disputed: /on hold while a dispute is reviewed/,
        missing:  /^The customer confirmed the job.$/,
    };
    for (const [name, escrow] of Object.entries(ESCROWS)) {
        test(`FIN-002 customer · escrow ${name}: receipt label and closing line`, () => {
            const b = { ...job('completed'), artisanName: 'Kwame Mensah' };
            assert.strictEqual(T.resolveReceipt(b, REAL_ID, escrow).paymentLabel, CUSTOMER_EXPECT[name].label);
            const j = T.resolveJourney(b, 'customer', { escrow });
            assert.match(j.just, CUSTOMER_EXPECT[name].line, j.just);
            if (name !== 'released') assert.ok(!/released/i.test(j.just), `no release claimed — ${j.just}`);
        });
        test(`FIN-002 artisan · escrow ${name}: closing line`, () => {
            const b = { ...job('completed'), artisanName: 'Kwame Mensah' };
            const j = T.resolveJourney(b, 'artisan', { escrow });
            assert.match(j.just, ARTISAN_EXPECT[name], j.just);
            assert.ok(!/your wallet/i.test(j.just) || name === 'released', `only a release reaches the artisan's wallet — ${j.just}`);
        });
    }

    test('FIN-002 the job brief carries the escrow through to compensation', () => {
        const brief = T.resolveJobBrief(job('completed'), { escrow: ESCROWS.released });
        assert.strictEqual(brief.compensation.note, 'Paid to your wallet.');
        assert.notStrictEqual(T.resolveJobBrief(job('completed')).compensation.note, 'Paid to your wallet.',
            'without the escrow document it cannot claim the payout');
    });

    // ── The journey's closing lines ──────────────────────────────────────────
    const done = { ...job('completed'), artisanName: 'Kwame Mensah' };
    test('FIN-002 journey: "payment was released" only when the escrow says so', () => {
        const unknown = T.resolveJourney(done, 'customer');
        assert.ok(!/released|refunded/i.test(unknown.just), unknown.just);
        assert.match(unknown.just, /^You confirmed the work\.$/);
        assert.match(T.resolveJourney(done, 'customer', { escrow: ESCROWS.released }).just, /payment was released to Kwame Mensah/);
        assert.match(T.resolveJourney(done, 'customer', { escrow: ESCROWS.refunded }).just, /refunded to your wallet/);
        assert.match(T.resolveJourney(done, 'customer', { escrow: ESCROWS.partial }).just, /part of your payment was refunded/);
        assert.match(T.resolveJourney(done, 'customer', { escrow: ESCROWS.disputed }).just, /on hold while a dispute/);
        assert.match(T.resolveJourney(done, 'artisan', { escrow: ESCROWS.released }).just, /Your payment was released to your wallet/);
        assert.match(T.resolveJourney(done, 'artisan').just, /^The customer confirmed the job\.$/);
    });

    test('FIN-002 journey: a dead end speaks to its own audience', () => {
        const b = { ...named, status: 'cancelled', calloutPaid: true, calloutSettled: 'refunded' };
        assert.match(T.resolveJourney(b, 'customer').just, /Your callout fee was refunded to your wallet/);
        const art = T.resolveJourney(b, 'artisan').just;
        assert.match(art, /The callout fee was refunded to the customer/);
        assert.ok(!/your wallet/i.test(art), 'the artisan is not told the refund went to THEIR wallet');
        assert.match(T.resolveJourney({ ...b, calloutSettled: 'released' }, 'artisan').just, /paid to your wallet/);
    });

    test('FIN-002 journey: a cancellation reason and the money are both said', () => {
        const j = T.resolveJourney({ ...named, status: 'cancelled', cancellationReason: 'Customer cancelled.',
                                     calloutPaid: true, calloutSettled: 'refunded' }, 'customer');
        assert.strictEqual(j.just, 'Customer cancelled. Your callout fee was refunded to your wallet.');
    });

    test('FIN-002 journey: a cancelled job whose escrow was refunded says so', () => {
        const j = T.resolveJourney({ ...done, status: 'cancelled' }, 'customer', { escrow: ESCROWS.refunded });
        assert.match(j.just, /Your payment was refunded to your wallet/);
    });

    test('FIN-002 journey: an unfulfilled request with a paid, unsettled callout is not "nothing charged"', () => {
        const j = T.resolveJourney({ ...named, status: 'unfulfilled', calloutPaid: true }, 'customer');
        assert.ok(!/nothing was charged/i.test(j.just), j.just);
        assert.match(j.just, /being returned to your wallet/);
    });

    // ── The screens pass the escrow document in ──────────────────────────────
    const jobHtml  = fs.readFileSync(path.join(__dirname, '..', 'artisan-app', 'job.html'), 'utf8');
    const jobsHtml = fs.readFileSync(path.join(__dirname, '..', 'artisan-app', 'jobs.html'), 'utf8');
    test('FIN-002 job.html watches the job escrow and gives it to the brief', () => {
        assert.match(jobHtml, /subscribeToDocument\('escrow', id,/);
        assert.match(jobHtml, /escrow: b\.escrowId && b\.escrowId === _escrowId \? _escrow : null/);
        assert.match(jobHtml, /_escrowUnsub\?\.\(\);/);
    });
    test('FIN-002 jobs.html reads closed jobs\' escrows and gives them to each card', () => {
        assert.match(jobsHtml, /getDocument\('escrow', j\.escrowId\)/);
        assert.match(jobsHtml, /escrow: \(b\.escrowId && _escrows\.get\(b\.escrowId\)\) \|\| null/);
    });
    test('FIN-002 jobs.html bounds the reads: live list only, the tab on screen, a cap', () => {
        const fn = jobsHtml.slice(jobsHtml.indexOf('async function _loadEscrows()'), jobsHtml.indexOf('async function _loadContacts()'));
        assert.match(fn, /if \(!_bookingsLive\) return;/, 'never from the cached paint');
        assert.match(fn, /bkGroup\(j\) === TAB_GROUP\[_tab\]/, 'only the tab on screen');
        assert.match(fn, /\.slice\(0, ESCROW_READS_PER_TAB\)/);
        assert.match(fn, /if \(_escrows\.has\(j\.escrowId\)\) continue;/, 'once per escrow');
        assert.match(jobsHtml, /const ESCROW_READS_PER_TAB = 20;/);
        assert.match(jobsHtml, /if \(!fromCache\) _bookingsLive = true;/);
        assert.match(jobsHtml, /_tab = tab;\s*_loadEscrows\(\);/, 'switching tab reads that tab');
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// FIN-002 follow-up — a RESOLVED dispute is closed, and its money is the escrow's
// ═════════════════════════════════════════════════════════════════════════════
// resolveDispute writes booking.status = 'resolved' for every outcome
// (functions/disputes.js:158-166). Nothing on the client knew the status: the
// artisan's Jobs list put it under Pending, never read its escrow, and printed
// "GHS 170.00 · Approved and secured in escrow" for a partial settlement that
// paid the artisan GHS 85 (handy-hub-mvp-70, browser check of 76dfc9c).
{
    const META = (() => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'js', 'domain', 'bookingStatusMeta.js'), 'utf8')
            .replace(/^\s*export\s+function\s+/gm, 'function ')
            .replace(/^\s*export\s+const\s+/gm, 'const ');
        // eslint-disable-next-line no-new-func
        return new Function(`${src}\nreturn { BOOKING_STATUSES, TAB_STATUSES, describe };`)();
    })();

    const AT = '2026-10-29T10:00:00.000Z';
    const HOLD = {
        bookingId: REAL_ID, customerId: 'cust_1', artisanId: 'art_1', kind: 'job',
        amount: 200, commission: 30, artisanShare: 170, commissionRate: 0.15, status: 'held',
    };
    // The escrow each resolution leaves behind, as the server writes it.
    const BY_RESOLUTION = {
        release_artisan: { ...HOLD, status: 'released', releasedBy: 'system', releasedAt: AT, updatedAt: AT },           // escrow.js:574
        full_refund:     { ...HOLD, status: 'refunded', refundedBy: 'ops@example.com', refundReason: 'Dispute resolved (admin): x',
                           refundedAt: AT, updatedAt: AT },                                                               // escrow.js:698-704
        partial_refund:  { ...HOLD, status: 'refunded', resolutionType: 'partial', customerAmount: 100, artisanAmount: 85,
                           commission: 15, refundedBy: 'ops@example.com', refundReason: 'Dispute partial settlement: x',
                           refundedAt: AT, updatedAt: AT },                                                               // disputes.js:255-265
    };
    // The booking as resolveDispute leaves it (disputes.js:158-166).
    const resolvedJob = (resolution) => approved(200, {
        escrowId: 'esc_res', artisanEarns: 170, commissionRate: 0.15, artisanName: 'Kwame Mensah',
        status: 'resolved', resolution, resolutionNotes: 'x', resolvedAt: AT, resolvedBy: 'ops@example.com',
    });

    test('resolved: the status is in the vocabulary and closed for both apps', () => {
        assert.ok(META.BOOKING_STATUSES.includes('resolved'));
        assert.ok(META.TAB_STATUSES.completed.includes('resolved'), 'customer and admin tabs use TAB_STATUSES');
        for (const audience of ['artisan', 'customer']) {
            const d = META.describe({ status: 'resolved' }, audience);
            assert.strictEqual(d.group, 'completed', `${audience}: not the Pending tab`);
            assert.strictEqual(d.label, 'Resolved', audience);
            assert.strictEqual(d.isTerminal, true, audience);
            assert.strictEqual(d.cancellable, false, audience);
            assert.ok(!/secured|paid|credited/i.test(d.description), `${audience}: the label claims no money — ${d.description}`);
        }
    });

    test('resolved: the job phase is closed', () => {
        assert.strictEqual(T.resolveJobPhase(resolvedJob('partial_refund')), T.JOB_PHASE.CLOSED);
    });

    test('resolved: the reported case — partial split, artisan paid GHS 85', () => {
        const c = T.resolveArtisanCompensation(resolvedJob('partial_refund'), BY_RESOLUTION.partial_refund);
        assert.strictEqual(c.amount, 85);
        assert.match(c.note, /GHS 85\.00 was paid to your wallet/);
        assert.ok(!/secured/i.test(c.note));
    });

    test('resolved: with its escrow not yet read, it is never "secured in escrow"', () => {
        const c = T.resolveArtisanCompensation(resolvedJob('partial_refund'), null);
        assert.ok(!/secured|paid to your wallet/i.test(c.note), c.note);
        assert.strictEqual(c.conditional, true);
    });

    for (const [resolution, escrow] of Object.entries(BY_RESOLUTION)) {
        test(`resolved · ${resolution}: artisan compensation, customer receipt and both closing lines`, () => {
            const b = resolvedJob(resolution);
            const c = T.resolveArtisanCompensation(b, escrow);
            assert.ok(!/secured/i.test(c.note), c.note);
            assert.strictEqual(c.conditional, false);
            const cust = T.resolveJourney(b, 'customer', { escrow });
            const art  = T.resolveJourney(b, 'artisan', { escrow });
            assert.strictEqual(cust.here, 'Dispute resolved');
            assert.ok(!/You confirmed the work/.test(cust.just), 'the customer did not confirm a resolved job');
            assert.ok(!/customer confirmed the job/i.test(art.just), art.just);
            const label = T.resolveReceipt(b, REAL_ID, escrow).paymentLabel;
            if (resolution === 'release_artisan') {
                assert.strictEqual(c.amount, 170);
                assert.strictEqual(c.note, 'Paid to your wallet.');
                assert.match(cust.just, /payment was released to Kwame Mensah/);
                assert.match(art.just, /Your payment was released to your wallet/);
                assert.strictEqual(label, 'Paid out');
            }
            if (resolution === 'full_refund') {
                assert.strictEqual(c.amount, 0);
                assert.match(c.note, /refunded to the customer/);
                assert.match(cust.just, /Your payment was refunded to your wallet/);
                assert.match(art.just, /The payment was refunded to the customer/);
                assert.strictEqual(label, 'Refunded');
            }
            if (resolution === 'partial_refund') {
                assert.strictEqual(c.amount, 85);
                assert.match(cust.just, /part of your payment was refunded to your wallet/);
                assert.match(art.just, /part of the payment was refunded to the customer/);
                assert.strictEqual(label, 'Partly refunded');
            }
        });
    }

    test('resolved with the escrow unread: the closing line names the resolution, not the money', () => {
        const j = T.resolveJourney(resolvedJob('release_artisan'), 'customer');
        assert.strictEqual(j.just, 'Our team resolved the dispute on this booking.');
        assert.strictEqual(T.resolveJourney(resolvedJob('release_artisan'), 'artisan').just,
            'Our team resolved the dispute on this job.');
    });

    test('resolved: jobs.html reads its escrow (it is in the Completed group the reads cover)', () => {
        const jobsHtml = fs.readFileSync(path.join(__dirname, '..', 'artisan-app', 'jobs.html'), 'utf8');
        assert.match(jobsHtml, /const bkGroup = \(booking\) => describeStatus\(booking, 'artisan'\)\.group;/);
        assert.match(jobsHtml, /\['completed', 'cancelled'\]\.includes\(bkGroup\(j\)\)/);
        assert.strictEqual(META.describe({ status: 'resolved' }, 'artisan').group, 'completed');
    });
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\nbooking-truth: ${pass} passed, ${fail} failed`);
if (fail) {
    console.error('\nFailures:\n  - ' + failures.join('\n  - ') + '\n');
    process.exit(1);
}
