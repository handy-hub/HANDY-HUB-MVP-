'use strict';
/**
 * tests/artisan-jobs.test.cjs — the artisan's Jobs: where each booking belongs,
 * what its row says, how it ended, and the cancellation policy (Phase 3).
 *
 * Policy (decided 2026-11-06): Q4 — a booking, future or not, can be cancelled
 * until the quote is approved; Q5 — after approval, Support decides. The client
 * offers Cancel only where the server accepts it AND the policy allows it.
 * The consequences shown before confirming are the server's own behaviour,
 * pinned here to the code that enacts them.
 *
 * The real domain modules run; the clock is passed in.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const dom  = (f) => pathToFileURL(path.join(ROOT, 'shared', 'js', 'domain', f)).href;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

(async () => {
const jobs    = await import(dom('artisanJobs.js'));
const today   = await import(dom('artisanToday.js'));
const truth   = await import(dom('bookingTruth.js'));
const actions = await import(dom('bookingActions.js'));
const { groupJobs, filterHistory, jobRow, HISTORY_STATUSES, ACTIVE_STATUSES } = jobs;
const { artisanCanCancel, cancellationTerms } = actions;

const NOW = Date.UTC(2026, 10, 7, 10, 0, 0);
const DAY = 86_400_000;
const bk = (id, status, over = {}) => ({ id, artisanId: 'art_1', serviceType: 'plumbing', track: 'inspection', calloutFee: 60,
    calloutPaid: true, customerFirstName: 'Ama', address: '12 Ring Road', updatedAt: new Date(NOW - 60_000).toISOString(), status, ...over });

console.log('\n── Cancellation policy: Q4 until approval, Q5 after ──\n');

await t('inspection track: cancellable at every step up to the quote decision, never after approval', () => {
    for (const st of ['accepted', 'inspection_scheduled', 'en_route', 'in_progress', 'inspection_done', 'quoted']) {
        assert.strictEqual(artisanCanCancel({ track: 'inspection', status: st }), true, st);
        assert.strictEqual(artisanCanCancel({ track: 'inspection', status: st, quoteApproved: true }), false, `${st} approved`);
    }
});

await t('standard and emergency: accepted or quoted before approval; approved work goes to Support (Q5)', () => {
    for (const track of ['standard', 'emergency', undefined]) {
        assert.strictEqual(artisanCanCancel({ track, status: 'accepted' }), true, `${track} accepted`);
        assert.strictEqual(artisanCanCancel({ track, status: 'quoted' }), true, `${track} quoted`);
        assert.strictEqual(artisanCanCancel({ track, status: 'accepted', quoteApproved: true }), false, `${track} accepted, approved`);
        for (const st of ['en_route', 'in_progress', 'awaiting', 'disputed', 'completed', 'cancelled', 'pending']) {
            assert.strictEqual(artisanCanCancel({ track, status: st }), false, `${track} ${st}`);
        }
    }
});

await t('the client never offers more than the rules accept: off the inspection track only accepted / quoted', () => {
    const rules = read('firestore.rules');
    assert.match(rules, /incoming\(\)\.get\('cancelledBy', 'artisan'\) == 'artisan' &&\s*prev in \['accepted', 'quoted'\] && next == 'cancelled' &&\s*\(!\('track' in existing\(\)\) \|\| existing\(\)\.track != 'inspection'\)\)/,
        'the artisan cancel clause changed — re-check artisanCanCancel');
    for (const st of ACTIVE_STATUSES) {
        for (const quoteApproved of [false, true]) {
            if (artisanCanCancel({ track: 'standard', status: st, quoteApproved })) assert.ok(['accepted', 'quoted'].includes(st), st);
        }
    }
});

await t('a future booking can be cancelled (Q4: no cut-off) — booked days ahead, before approval', () => {
    const b = bk('f1', 'inspection_scheduled', { scheduledForMs: NOW + 5 * DAY });
    assert.strictEqual(cancellationTerms(b).route, 'cancel');
    const s = bk('f2', 'accepted', { track: 'standard', calloutPaid: false, scheduledForMs: NOW + 5 * DAY });
    assert.strictEqual(cancellationTerms(s).route, 'cancel');
});

console.log('\n── What cancelling does, stated before confirming ──\n');

await t('an inspection visit fee goes back to the customer, said plainly — and after the inspection too', () => {
    const before = cancellationTerms(bk('c1', 'inspection_scheduled'));
    assert.ok(before.consequences.includes('The visit fee goes back to the customer.'), before.consequences);
    const after = cancellationTerms(bk('c2', 'inspection_done'));
    assert.ok(after.consequences.some((c) => /including for the inspection you have already done/.test(c)), after.consequences);
    const unpaid = cancellationTerms(bk('c3', 'accepted', { calloutPaid: false }));
    assert.ok(!unpaid.consequences.some((c) => /visit fee/.test(c)), 'nothing paid, nothing to return');
});

await t('emergency fee and a held job payment are said to return to the customer', () => {
    const em = cancellationTerms({ track: 'emergency', status: 'accepted', calloutPaid: true });
    assert.ok(em.consequences.includes('The emergency fee goes back to the customer.'));
    const st = cancellationTerms({ track: 'standard', status: 'accepted', escrowId: 'e1' });
    assert.ok(st.consequences.includes('The payment held for this job goes back to the customer.'));
});

await t('every cancellation ends the booking, is told to the customer, and counts in the completion rate', () => {
    for (const b of [bk('x', 'accepted'), { track: 'standard', status: 'quoted' }]) {
        const c = cancellationTerms(b).consequences;
        assert.strictEqual(c[0], 'The customer is told, and the booking ends. It is not passed to anyone else.');
        assert.strictEqual(c[c.length - 1], 'It counts against the completion rate on your Performance screen.');
        assert.ok(!c.some((s) => /fee is charged|penalt|you will be charged|fine/i.test(s)), 'no fee or penalty exists, so none is claimed');
    }
});

await t('approved work and disputes go to Support, with the reason; closed bookings have nothing to end', () => {
    const appr = cancellationTerms({ track: 'standard', status: 'accepted', quoteApproved: true });
    assert.deepStrictEqual([appr.route, /approved your quote/.test(appr.why)], ['support', true]);
    const disp = cancellationTerms({ track: 'inspection', status: 'disputed' });
    assert.deepStrictEqual([disp.route, /in dispute/.test(disp.why)], ['support', true]);
    const enr = cancellationTerms({ track: 'emergency', status: 'en_route', calloutPaid: true });
    assert.strictEqual(enr.route, 'support', 'the rules will not undo travel off the inspection track');
    for (const st of ['completed', 'cancelled', 'resolved', 'pending', 'rejected']) {
        assert.strictEqual(cancellationTerms({ status: st }).route, 'none', st);
    }
});

await t('those statements are the server\'s behaviour (pinned to the code that enacts them)', () => {
    const pricing = read('functions/pricing.js'), bookings = read('functions/bookings.js'), dispatch = read('functions/dispatch.js');
    assert.match(pricing, /const settleTo = \(isCustomer && inspectionDelivered\) \? 'artisan' : 'customer';/, 'artisan cancel → callout to the customer');
    assert.match(pricing, /if \(preBooking\.quoteApproved\)\s+throw new Error\('The quote is already approved/, 'no inspection cancel after approval');
    assert.match(bookings, /if \(nextStatus === 'cancelled'\) \{\s*await _refundEscrowForBooking\(bookingId, after\);\s*await _settleCalloutOnCancellation\(bookingId, before, after\);/);
    assert.match(dispatch, /Guard: only dispatch if pending/, 'a cancelled booking is never re-offered');
    assert.match(read('shared/js/domain/performanceMetrics.js'), /else if \(status === 'cancelled' && b\.cancelledBy === 'artisan'\) cancelledByArtisan\+\+;/);
    assert.match(read('shared/js/domain/bookingActions.js'), /extra: \(opts\) => \(\{ cancellationReason: opts\.reason \|\| 'Cancelled', cancelledBy: opts\.actor \}\),/, 'the raw cancel names the artisan');
});

console.log('\n── How a booking ended, in words ──\n');

await t('who ended it: you, the customer, the system, or Fidus X support — never an admin address', () => {
    const C = truth.resolveClosure;
    assert.deepStrictEqual([C({ status: 'cancelled', cancelledBy: 'artisan' }).label, C({ status: 'cancelled', cancelledBy: 'artisan' }).sentence], ['Cancelled by you', null]);
    assert.strictEqual(C({ status: 'cancelled', cancelledBy: 'artisan', cancellationReason: 'Van broke down' }).sentence, 'Your reason: Van broke down');
    assert.strictEqual(C({ status: 'cancelled', cancelledBy: 'customer', cancellationReason: 'Fixed it myself' }).sentence, 'Their reason: Fixed it myself');
    assert.strictEqual(C({ status: 'cancelled', cancelledBy: 'customer', cancellationReason: 'quote_rejected_final' }).sentence, 'The customer declined your revised quote.');
    const admin = C({ status: 'cancelled', cancelledBy: 'admin:ops@fidusx.example' });
    assert.strictEqual(admin.label, 'Cancelled by Fidus X support');
    assert.ok(!JSON.stringify(admin).includes('ops@'), 'the administrator stays anonymous');
    assert.strictEqual(C({ status: 'cancelled', cancelledBy: 'system_escrow_failure', cancellationReason: 'Auto-cancelled: insufficient funds' }).sentence, 'The customer’s payment could not be processed.');
    assert.strictEqual(C({ status: 'cancelled' }).label, 'Cancelled', 'a legacy booking with no cancelledBy is not attributed to anyone');
    assert.strictEqual(C({ status: 'completed' }).label, 'Completed');
    assert.strictEqual(C({ status: 'resolved' }).label, 'Dispute resolved');
});

await t('every automatic closure the server writes reads as a sentence, never its label', () => {
    for (const label of ['quote_expired', 'no_quote_submitted', 'inspection_not_completed', 'callout_unpaid', 'inspection_started_stale']) {
        assert.match(read('functions/pricing.js'), new RegExp(`label: '${label}'`), `${label} is still a sweep`);
        const c = truth.resolveClosure({ status: 'cancelled', cancelledBy: 'system', cancellationReason: label });
        assert.strictEqual(c.label, 'Closed automatically');
        assert.ok(c.sentence && !c.sentence.includes('_'), `${label}: ${c.sentence}`);
    }
});

await t('the artisan journey uses it; the customer journey is unchanged (out of this phase)', () => {
    const b = { status: 'cancelled', cancelledBy: 'system', cancellationReason: 'quote_expired', track: 'inspection' };
    const a = truth.resolveJourney(b, 'artisan');
    assert.strictEqual(a.here, 'Closed automatically');
    assert.ok(!a.just.includes('quote_expired'), a.just);
    assert.strictEqual(truth.resolveJourney(b, 'customer').here, 'Request closed');
});

console.log('\n── Where each booking belongs (the same placement as Today) ──\n');

const live = [
    bk('ip', 'in_progress', { quoteApproved: true, updatedAt: new Date(NOW - 9e5).toISOString() }),
    bk('er', 'en_route'),
    bk('q', 'quoted', { jobQuote: 300 }),
    bk('aw', 'awaiting', { quoteApproved: true }),
    bk('dp', 'disputed', { quoteApproved: true }),
    bk('up2', 'inspection_scheduled', { scheduledForMs: NOW + 4 * DAY }),
    bk('up1', 'inspection_scheduled', { scheduledForMs: NOW + 2 * DAY }),
    bk('pay', 'accepted', { calloutPaid: false }),
];
const hist = [
    bk('done', 'completed', { quoteApproved: true, updatedAt: new Date(NOW - 2 * DAY).toISOString(), completedAt: new Date(NOW - 2 * DAY).toISOString() }),
    bk('cx', 'cancelled', { cancelledBy: 'customer', updatedAt: new Date(NOW - DAY).toISOString() }),
    bk('auto', 'cancelled', { cancelledBy: 'system', cancellationReason: 'callout_unpaid', updatedAt: new Date(NOW - 3 * DAY).toISOString() }),
];

await t('needs you · waiting · on hold · upcoming · history, each where Today would put it', () => {
    const g = groupJobs([...live, ...hist], NOW);
    assert.deepStrictEqual(g.needsYou.map((p) => p.booking.id), ['ip', 'er'], 'on site first, then travelling');
    assert.deepStrictEqual(g.waiting.map((p) => p.booking.id).sort(), ['aw', 'pay', 'q']);
    assert.deepStrictEqual(g.onHold.map((p) => p.booking.id), ['dp']);
    assert.deepStrictEqual(g.upcoming.map((p) => p.booking.id), ['up1', 'up2'], 'soonest first');
    assert.deepStrictEqual(g.history.map((p) => p.booking.id), ['cx', 'done', 'auto'], 'most recent first');
    assert.deepStrictEqual(g.counts, { current: 6, upcoming: 2 });
    // Today's own answer for the same bookings.
    const tdy = today.resolveToday({ artisan: { status: 'active', verificationStatus: 'approved', isAvailable: true }, bookings: live, nowMs: NOW });
    assert.deepStrictEqual(tdy.jobs.map((p) => p.booking.id), g.needsYou.map((p) => p.booking.id));
    assert.deepStrictEqual(tdy.upcoming.map((p) => p.booking.id), g.upcoming.map((p) => p.booking.id));
});

await t('a booking in both the live list and a history page is listed once', () => {
    const g = groupJobs([bk('d', 'completed'), bk('d', 'completed'), bk('x', 'en_route')], NOW);
    assert.strictEqual(g.history.length + g.needsYou.length, 2);
});

await t('history filters: completed, cancelled (anyone, or automatic), all', () => {
    const g = groupJobs(hist, NOW);
    assert.deepStrictEqual(filterHistory(g.history, 'completed').map((p) => p.booking.id), ['done']);
    assert.deepStrictEqual(filterHistory(g.history, 'cancelled').map((p) => p.booking.id), ['cx', 'auto']);
    assert.strictEqual(filterHistory(g.history, 'all').length, 3);
    assert.deepStrictEqual([...HISTORY_STATUSES], ['completed', 'cancelled', 'resolved']);
});

console.log('\n── What a row says ──\n');

await t('a live row: service, the disclosed name, status, appointment, where, and the next step', () => {
    const g = groupJobs(live, NOW);
    const er = jobRow(g.needsYou[1]);
    assert.deepStrictEqual([er.service, er.customer, er.status, er.next, er.where], ['Plumbing', 'Ama', 'On your way', 'Mark arrived', '12 Ring Road']);
    const up = jobRow(g.upcoming[0]);
    assert.ok(/^Mon|^Tue|^Wed|^Thu|^Fri|^Sat|^Sun/.test(up.when) || /Today|Tomorrow/.test(up.when), up.when);
    assert.strictEqual(up.next, null, 'a slot not yet open offers no step');
    const q = jobRow(g.waiting.find((p) => p.booking.id === 'q'));
    assert.deepStrictEqual([q.status, q.next], ['Quote sent', null]);
    assert.strictEqual(jobRow(g.onHold[0]).tone, 'bad');
});

await t('a history row: how it ended and when; never the address (removed 14 days after closing)', () => {
    const g = groupJobs(hist, NOW);
    const auto = jobRow(g.history.find((p) => p.booking.id === 'auto'));
    assert.deepStrictEqual([auto.status, auto.where, auto.next], ['Closed automatically', null, null]);
    assert.match(auto.detail, /did not pay the visit fee/);
    assert.ok(/\d{1,2} Nov 2026/.test(auto.when), auto.when);
    assert.strictEqual(jobRow(g.history.find((p) => p.booking.id === 'done')).tone, 'ok');
});

await t('incomplete optional data: no service, no name, no address, no dates — a row still reads', () => {
    const g = groupJobs([{ id: 'bare', status: 'accepted', track: 'standard' }, { id: 'old', status: 'cancelled' }], NOW);
    const r = jobRow([...g.needsYou, ...g.waiting][0]);
    assert.deepStrictEqual([r.service, r.customer, r.where, r.when], ['Job', null, null, null]);
    const h = jobRow(g.history[0]);
    assert.deepStrictEqual([h.status, h.when, h.detail], ['Cancelled', null, null]);
});

await t('an offer is not a job yet: before acceptance the row names nobody', () => {
    const offer = { id: 'o1', status: 'pending', offerStatus: 'open', customerFirstName: 'Ama', serviceType: 'plumbing', locationApproximate: true };
    assert.strictEqual(truth.resolveJobBrief(offer).customer.name, null);
    const row = jobRow({ booking: offer, place: 'yours', journey: truth.resolveJourney(offer, 'artisan'), schedule: { scheduled: false } });
    assert.strictEqual(row.customer, null, 'the row takes the name from the brief, never the document');
    assert.strictEqual(row.where, null, 'nor its position');
});

await t('the module is pure and has no lifecycle of its own', () => {
    const src = read('shared/js/domain/artisanJobs.js');
    assert.ok(!/document\.|window\.|firebase|localStorage/.test(src));
    assert.ok(!/status === '(accepted|en_route|in_progress|inspection_scheduled|quoted)'/.test(src), 'no status branch of its own');
    assert.match(src, /import \{ placeJob, byJobRank \} from '\.\/artisanToday\.js';/);
});

console.log(`\nartisan-jobs: ${passed} passed, ${failed} failed`);
if (failed) { for (const [n, e] of failures) console.log(`\n✗ ${n}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
