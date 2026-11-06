'use strict';
/**
 * tests/offer-refusal.test.cjs — when the server refuses an answer to a job
 * offer because the offer is gone, no screen hands the artisan a live button
 * again. (Audit FLOW-005, with the FLOW-003 tidy-up.)
 *
 * respondToJobOffer refuses a lapsed offer with HttpsError details.reason —
 * 'expired' (open but past expiresAtMs), 'closed' (expired/withdrawn/accepted,
 * or the booking moved on) or 'not_offered' (re-offered). performBookingAction
 * dropped the reason and regex-matched the message, and every artisan screen
 * then restored Accept (the dashboard as "Accept Job" on a card that said
 * "Accept"; jobs.html without its icon; job.html from a `finally`). Decline
 * stayed live too, and the server refuses that as well.
 *
 * Offers are seeded with the server's own buildOfferDoc (real job_offers
 * shapes, prematched included) and the clock is frozen per case.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const FN   = path.join(ROOT, 'functions');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const fake = require('./support/fake-firebase.cjs').install();
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'lamax-4fd82';
const fns       = require(path.join(FN, 'index.js'));
const jobOffers = require(path.join(FN, 'jobOffers.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

const stripEsm = (src) => src
    .replace(/^\s*import\s[^\n]*\n/gm, '')
    .replace(/^\s*export\s+async\s+function\s+/gm, 'async function ')
    .replace(/^\s*export\s+function\s+/gm, 'function ')
    .replace(/^\s*export\s+const\s+/gm, 'const ');
// eslint-disable-next-line no-new-func
const OFFERS = new Function(`${stripEsm(read('shared/js/domain/jobOffers.js'))}
return { offerState, formatTimeLeft, lapseOfferButtons, LAPSED_OFFER_ATTRS, LAPSED_OFFER_LABEL };`)();
// bookingActions imports bookingSchedule; evaluate the real one ahead of it.
// eslint-disable-next-line no-new-func
const ACTIONS = new Function(`${stripEsm(read('shared/js/domain/bookingSchedule.js'))}
${stripEsm(read('shared/js/domain/bookingActions.js'))}
return { performBookingAction, ACTION, RESULT, OFFER_GONE_REASONS };`)();

/** Run fn with Date.now() frozen at `ms` (the server reads Date.now() for expiry). */
async function at(ms, fn) {
    const real = Date.now;
    Date.now = () => ms;
    try { return await fn(); } finally { Date.now = real; }
}

const T0  = Date.parse('2026-10-28T09:00:00.000Z');
const EXP = T0 + 3 * 60 * 1000;
const BOOKING = { serviceType: 'plumbing', track: 'inspection', calloutFee: 60, customerFirstName: 'Ama', lat: 5.6037, lng: -0.187 };

/** A dispatched booking and the server's own offer document for it. */
function seed({ expiresAtMs = EXP, prematched = false, offerStatus, artisanId = 'a1', booking = {}, artisan = {} } = {}) {
    fake.db._reset();
    fake.db._set('bookings/b1', {
        customerId: 'c1', status: 'pending', currentArtisanId: 'a1', artisanId: null,
        dispatchStatus: 'dispatched', currentDispatchRound: 1, ...BOOKING, ...booking,
    });
    const offer = jobOffers.buildOfferDoc({ ...BOOKING, ...booking },
        prematched ? { bookingId: 'b1', artisanId, prematched: true }
                   : { bookingId: 'b1', artisanId, expiresAtMs, round: 1, distanceKm: 2.4 });
    if (offerStatus) offer.offerStatus = offerStatus;
    fake.db._set('job_offers/b1', offer);
    fake.db._set('artisans/a1', { userType: 'artisan', status: 'active', verificationStatus: 'approved', name: 'Kofi', ...artisan });
    return offer;
}

/** What the client receives: the router's HttpsError, as the Functions SDK surfaces it. */
async function serverAnswer(decision, { routed = true } = {}) {
    const req = { bookingId: 'b1', decision };
    try {
        return { ok: true, value: routed
            ? await fns.bookingActions({ auth: { uid: 'a1' }, data: { action: 'respondToJobOffer', payload: req } })
            : await fns.respondToJobOffer({ auth: { uid: 'a1' }, data: req }) };
    } catch (e) {
        return { ok: false, code: e.code, message: e.message, details: e.details ?? null };
    }
}

/** The client chain: the real server behind the client's pricingService, into performBookingAction. */
function clientPricing() {
    return {
        async respondToJobOffer(bookingId, decision) {
            const r = await serverAnswer(decision);
            if (r.ok) return r.value;
            // firebase-functions (client) prefixes the code and keeps message + details.
            throw Object.assign(new Error(r.message), { code: `functions/${r.code}`, details: r.details ?? undefined });
        },
    };
}
const db = { async getDocument(c, id) { const d = fake.db._get(`${c}/${id}`); return d ? { exists: true, data: d } : { exists: false }; } };
const answer = (action) => ACTIONS.performBookingAction(action, {
    bookingId: 'b1', actor: 'artisan', uid: 'a1', databaseService: db, pricingService: clientPricing() });

(async () => {

console.log('\n── The server says WHY, and the wrapper passes it on ──\n');

await t('an open offer past its deadline: reason "expired", for accept and decline, router = direct', async () => {
    for (const decision of ['accept', 'decline']) {
        seed();
        const routed = await at(EXP, () => serverAnswer(decision));
        const direct = await at(EXP, () => serverAnswer(decision, { routed: false }));
        assert.deepStrictEqual([routed.code, routed.details], ['failed-precondition', { reason: 'expired' }], decision);
        assert.deepStrictEqual(routed, direct, `${decision}: router and direct disagree`);
        assert.strictEqual(fake.db._get('bookings/b1').status, 'pending', 'nothing changed');
    }
});

await t('an offer the sweep already closed: reason "closed"', async () => {
    seed({ offerStatus: 'expired' });
    const r = await at(T0, () => serverAnswer('accept'));
    assert.deepStrictEqual([r.code, r.details], ['failed-precondition', { reason: 'closed' }]);
});

await t('a booking that moved on (cancelled by the customer): reason "closed"', async () => {
    seed({ booking: { status: 'cancelled' } });
    const r = await at(T0, () => serverAnswer('decline'));
    assert.deepStrictEqual(r.details, { reason: 'closed' });
});

await t('an offer re-offered to someone else: reason "not_offered" (permission-denied)', async () => {
    seed({ artisanId: 'a2' });
    const r = await at(T0, () => serverAnswer('accept'));
    assert.deepStrictEqual([r.code, r.details], ['permission-denied', { reason: 'not_offered' }]);
});

await t('a prematched offer has no deadline: answerable, and the server still decides', async () => {
    const offer = seed({ prematched: true });
    assert.strictEqual(offer.expiresAtMs, null);
    assert.deepStrictEqual(OFFERS.offerState(offer, T0 + 3_600_000), { expiresAtMs: null, secondsLeft: null, expired: false },
        'no client deadline is invented');
    const r = await at(T0 + 3_600_000, () => serverAnswer('accept'));
    assert.ok(r.ok, r.message);
});

await t('a prematched offer the server refuses (legacy responseDeadline past): reason "expired"', async () => {
    const offer = seed({ prematched: true, booking: { responseDeadline: new Date(EXP).toISOString() } });
    assert.strictEqual(OFFERS.offerState(offer, EXP).expired, false, 'the card itself shows no deadline');
    const r = await at(EXP, () => serverAnswer('accept'));
    assert.deepStrictEqual(r.details, { reason: 'expired' });
});

console.log('\n── performBookingAction reads the reason ──\n');

await t('expired / closed / not_offered from the real server → offerGone, code conflict, reason kept', async () => {
    const cases = [
        [() => seed(),                          EXP, 'expired'],
        [() => seed({ offerStatus: 'expired' }), T0,  'closed'],
        [() => seed({ artisanId: 'a2' }),        T0,  'not_offered'],
        [() => seed({ prematched: true, booking: { responseDeadline: new Date(EXP).toISOString() } }), EXP, 'expired'],
    ];
    for (const [setup, now, reason] of cases) {
        for (const action of [ACTIONS.ACTION.ACCEPT, ACTIONS.ACTION.DECLINE]) {
            setup();
            const res = await at(now, () => answer(action));
            assert.deepStrictEqual([res.ok, res.offerGone, res.reason, res.code], [false, true, reason, ACTIONS.RESULT.CONFLICT],
                `${action}/${reason}`);
            assert.ok(res.message && !/^internal$/i.test(res.message), 'a readable message');
        }
    }
});

await t('not_eligible is not "gone": offerGone false, code not_allowed', async () => {
    seed({ artisan: { verificationStatus: 'pending' } });
    const res = await at(T0, () => answer(ACTIONS.ACTION.ACCEPT));
    assert.deepStrictEqual([res.offerGone, res.reason, res.code], [false, 'not_eligible', ACTIONS.RESULT.NOT_ALLOWED]);
});

await t('the reason decides, not the message: other reasons and network faults are not "gone"', async () => {
    const run = (err) => ACTIONS.performBookingAction(ACTIONS.ACTION.ACCEPT, {
        bookingId: 'b1', actor: 'artisan', uid: 'a1', databaseService: db,
        pricingService: { respondToJobOffer: async () => { throw err; } } });
    assert.deepStrictEqual(ACTIONS.OFFER_GONE_REASONS, ['expired', 'closed', 'not_offered']);
    // A message that LOOKS like "gone" with a reason that is not: the reason wins.
    let r = await run(Object.assign(new Error('This request is no longer open.'), { details: { reason: 'invalid' } }));
    assert.deepStrictEqual([r.offerGone, r.code], [false, ACTIONS.RESULT.FAILED]);
    r = await run(Object.assign(new Error('unavailable'), { code: 'functions/unavailable' }));
    assert.deepStrictEqual([r.offerGone, r.reason, r.code], [false, null, ACTIONS.RESULT.FAILED]);
    r = await run(Object.assign(new Error('internal'), { code: 'functions/internal' }));
    assert.strictEqual(r.offerGone, false);
    // No reason at all (an older deployment): the message is the fallback.
    r = await run(new Error('This request has expired and has been offered to another professional.'));
    assert.deepStrictEqual([r.offerGone, r.reason, r.code], [true, null, ACTIONS.RESULT.CONFLICT]);
});

await t('success is unchanged: accept returns the booking, decline returns rejected', async () => {
    seed();
    let res = await at(T0, () => answer(ACTIONS.ACTION.ACCEPT));
    assert.deepStrictEqual([res.ok, res.code, res.to, res.booking.status], [true, 'ok', 'accepted', 'accepted']);
    seed();
    res = await at(T0, () => answer(ACTIONS.ACTION.DECLINE));
    assert.deepStrictEqual([res.ok, res.to], [true, 'rejected']);
});

console.log('\n── One lapsed look, never re-armed ──\n');

function fakeButton(text) {
    const attrs = { onclick: 'acceptJob("b1")' };
    return {
        textContent: text, disabled: false, onclick: () => {}, dataset: {}, style: {},
        removeAttribute(k) { delete attrs[k]; }, setAttribute(k, v) { attrs[k] = v; }, attrs,
    };
}

await t('lapseOfferButtons disables both answers, relabels them, drops the handlers', () => {
    const acc = fakeButton('Accepting…'), dec = fakeButton('Declining…');
    OFFERS.lapseOfferButtons(acc, dec);
    for (const b of [acc, dec]) {
        assert.strictEqual(b.disabled, true);
        assert.strictEqual(b.onclick, null);
        assert.ok(!('onclick' in b.attrs));
        assert.strictEqual(b.attrs['aria-disabled'], 'true');
        assert.deepStrictEqual([b.dataset.lapsed, b.style.opacity, b.style.cursor], ['true', '.5', 'default']);
    }
    assert.deepStrictEqual([acc.textContent, dec.textContent], [OFFERS.LAPSED_OFFER_LABEL, 'Decline']);
    assert.strictEqual(OFFERS.LAPSED_OFFER_LABEL, 'Expired');
    OFFERS.lapseOfferButtons(null, undefined);   // a card already gone is fine
});

await t('the markup form is the same look', () => {
    assert.match(OFFERS.LAPSED_OFFER_ATTRS, /^disabled aria-disabled="true" data-lapsed="true" style="opacity:\.5;cursor:default"$/);
});

const SCREENS = {
    dashboard: read('artisan-app/dashboard.html'),
    jobs:      read('artisan-app/jobs.html'),
    job:       read('artisan-app/job.html'),
};
const code = (s) => s.replace(/^\s*\/\/.*$/gm, '');

// Today (Phase 2) does not draw a lapsed offer at all: one that expired or that
// the server refused leaves the screen, with a sentence saying why, and Today
// moves to the next state. Jobs and the job screen keep the shared lapsed look.
const TODAY_VIEW   = read('artisan-app/js/today.js');
const TODAY_DOMAIN = read('shared/js/domain/artisanToday.js');

await t('Today never draws an offer that cannot be answered: expired and refused offers leave the screen', () => {
    const d = code(SCREENS.dashboard);
    assert.match(TODAY_DOMAIN, /const open = offers\.map\(\(o\) => offerView\(o, nowMs\)\)\.filter\(\(v\) => v\.answerable\)/, 'expired: not a candidate');
    assert.match(d, /offers:\s+_offers\.filter\(\(r\) => !_goneOffers\.has\(r\.id\)\)/, 'refused by the server: not a candidate');
    assert.match(d, /showToast\('That request expired and has been offered to another professional\.'\);/);
    assert.doesNotMatch(TODAY_VIEW, /LAPSED_OFFER_ATTRS|style="opacity/, 'no inline-styled lapsed buttons on the design system');
});

await t('every other screen draws a lapsed offer with the shared look on BOTH answers', () => {
    const d = code(SCREENS.dashboard), j = code(SCREENS.jobs), o = code(SCREENS.job);
    assert.match(j, /<button class="job-btn job-btn-accept" \$\{LAPSED_OFFER_ATTRS\}>\$\{LAPSED_OFFER_LABEL\}<\/button>\s*<button class="job-btn job-btn-decline" \$\{LAPSED_OFFER_ATTRS\}>Decline<\/button>/);
    assert.match(o, /<button class="jb-primary" \$\{LAPSED_OFFER_ATTRS\}>\$\{LAPSED_OFFER_LABEL\}<\/button>[\s\S]{0,120}<button class="jb-sec-btn danger" \$\{LAPSED_OFFER_ATTRS\}>Decline<\/button>/);
    // The private variants are gone: jobs' decline-styled "Expired", the dashboard's inline one.
    assert.doesNotMatch(j, /job-btn-decline" disabled style="opacity:\.55;cursor:default;">Expired/);
    assert.doesNotMatch(d, /class="btn-accept" disabled style="opacity:\.5;cursor:default">Expired/);
});

await t('a lapsed render covers both the clock and a server refusal, on every screen', () => {
    // Today: the clock through offerState (answerable), a refusal through _goneOffers — above.
    assert.match(code(SCREENS.jobs), /\(offer\.expired \|\| _goneOffers\.has\(b\.id\)\)/);
    assert.match(code(SCREENS.job), /if \(offer\.expired \|\| _offerGone\) \{/);
});

await t('Today: offerGone takes the offer off the screen for good, before anything is redrawn', () => {
    const d = code(SCREENS.dashboard);
    const fn = d.slice(d.indexOf('async function answerOffer'), d.indexOf('async function acceptJob'));
    const gone = fn.indexOf('if (res.offerGone) { _inFlight.delete(bookingId); markOfferGone(bookingId); return false; }');
    const finallyAt = fn.indexOf('} finally {');
    assert.ok(gone > 0 && gone < finallyAt, 'offerGone is handled before the finally redraws');
    assert.match(d, /function markOfferGone\(bookingId\) \{\s*_goneOffers\.add\(bookingId\);[\s\S]{0,60}paint\(\);/);
    // One answer per offer at a time: a second tap while the first is in flight does nothing.
    assert.match(fn, /if \(_inFlight\.has\(bookingId\)\) return false;\s*_inFlight\.set\(bookingId,/);
    assert.match(d, /async function declineJob\(bookingId\) \{\s*if \(_inFlight\.has\(bookingId\)\) return;/);
    assert.doesNotMatch(d, /Accept Job/, 'the restore label that did not match the card');
});

await t('jobs list: offerGone retires the card and returns BEFORE any button is restored; icon kept otherwise', () => {
    const j = code(SCREENS.jobs);
    const fn = j.slice(j.indexOf('async function runTransition'), j.indexOf('// The dashboard\'s rule') > 0 ? j.indexOf('const NEEDS_ONBOARDING') : undefined);
    const gone = fn.indexOf('if (res.offerGone) { markOfferGone(bookingId); return; }');
    const restore = fn.indexOf('btn.disabled = false');
    assert.ok(gone > 0 && gone < restore, 'offerGone is handled first');
    assert.match(fn, /const orig = btn \? btn\.innerHTML : '';/);
    assert.doesNotMatch(fn, /btn\.textContent = orig/, 'textContent dropped the Accept icon');
    assert.match(j, /lapseOfferButtons\(card\.querySelector\('\.job-btn-accept'\), card\.querySelector\('\.job-btn-decline'\)\)/);
});

await t('job screen: offerGone redraws it lapsed and the finally does not re-enable the button', () => {
    const o = code(SCREENS.job);
    const fn = o.slice(o.indexOf('async function run(spec)'), o.indexOf('function showMessage'));
    assert.match(fn, /if \(res\.offerGone\) \{\s*_offerGone = true;\s*giveBack = false;/);
    assert.match(fn, /finally \{\s*_busy = false;\s*if \(btn && giveBack\) \{ btn\.disabled = false;/);
});

await t('one countdown source: every screen ticks from offerState / formatTimeLeft, one ticker each, cleared on pagehide', () => {
    const d = code(SCREENS.dashboard), j = code(SCREENS.jobs), o = code(SCREENS.job);
    assert.doesNotMatch(d, /_startJobCountdown|_activeCountdowns|deadlineMillis - Date\.now\(\)/, 'the private countdown is gone');
    // Today: the ticker paints every countdown from its data-expires (offerState's
    // expiresAtMs) and hands back the lapsed ones; an answer in flight is left to the server.
    assert.match(d, /const lapsed = paintCountdowns\(dom\.main, Date\.now\(\)\);\s*for \(const id of lapsed\) \{\s*if \(_inFlight\.has\(id\)\) continue;/);
    assert.match(TODAY_VIEW, /const left = Math\.max\(0, Number\(el\.dataset\.expires\) - nowMs\);/);
    assert.match(TODAY_VIEW, /if \(v\) v\.textContent = formatTimeLeft\(Math\.floor\(left \/ 1000\)\);/);
    assert.match(d, /function startOfferTicker\(\) \{\s*if \(_offerTicker\) return;/);
    assert.strictEqual((d.match(/setInterval\(tickOfferCards/g) || []).length, 1);
    assert.match(d, /addEventListener\('pagehide', \(\) => \{[\s\S]{0,120}clearInterval\(_offerTicker\)/);
    assert.match(j, /const _offerTicker = setInterval\(/);
    assert.match(j, /addEventListener\('pagehide', \(\) => \{[\s\S]{0,120}clearInterval\(_offerTicker\)/);
    assert.match(o, /clearInterval\(_offerTick\); _offerTick = null;/);
    assert.match(o, /addEventListener\('pagehide'[^\n]*clearInterval\(_offerTick\)/);
});

await t('the countdown boundary is offerState\'s: open 1 ms before, lapsed AT expiresAtMs', () => {
    assert.strictEqual(OFFERS.offerState({ expiresAtMs: EXP }, EXP - 1).expired, false);
    assert.strictEqual(OFFERS.offerState({ expiresAtMs: EXP }, EXP).expired, true);
    assert.strictEqual(OFFERS.formatTimeLeft(OFFERS.offerState({ expiresAtMs: EXP }, EXP - 1).secondsLeft), '0s');
});

await t('jobs list: onboarding only on a LIVE profile that needs verification (the dashboard\'s rule)', () => {
    const j = code(SCREENS.jobs);
    assert.match(j, /function onboardingWarranted\(\) \{\s*return _profileLive && !!_currentArtisan &&/);
    assert.match(j, /const NEEDS_ONBOARDING = \['', 'draft', 'rejected', 're_verification_required'\];/);
    const accept = j.slice(j.indexOf('window.acceptJob'), j.indexOf('window.declineJob'));
    assert.match(accept, /if \(onboardingWarranted\(\)\) \{[^}]*onboarding\.html/);
    assert.doesNotMatch(accept, /if \(_currentArtisan && \[/, 'the old rule: a {} or cached profile went to onboarding');
    assert.match(j, /_profileLive = true;/);
});

console.log(`\noffer-refusal: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);

})();
