'use strict';
/**
 * tests/offer-expiry.test.cjs — a job offer shows how long is left, and the
 * server — not the screen — decides when it is too late. (Audit FLOW-003.)
 *
 * Every artisan screen shows job_offers/{bookingId} documents, which carry
 * `expiresAtMs`. offerState() read only `responseDeadline` (a booking field), so
 * no countdown was ever shown and a lapsed offer stayed acceptable on screen
 * until the one-minute sweep closed it. The client now reads expiresAtMs; the
 * server checks expiry inside the accept transaction with its own clock.
 *
 * The clock is controlled by replacing Date.now for the duration of a case.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const FN   = path.join(ROOT, 'functions');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const fake = require('./support/fake-firebase.cjs').install();
const jobOffers = require(path.join(FN, 'jobOffers.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

function loadEsm(rel, names) {
    const src = read(rel)
        .replace(/^\s*import\s[^\n]*\n/gm, '')
        .replace(/^\s*export\s+async\s+function\s+/gm, 'async function ')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
    // eslint-disable-next-line no-new-func
    return new Function(`${src}\nreturn { ${names.join(', ')} };`)();
}
const OFFERS = loadEsm('shared/js/domain/jobOffers.js', ['offerDeadlineMs', 'offerState', 'formatTimeLeft']);

/** Run fn with Date.now() frozen at `ms`. */
async function at(ms, fn) {
    const real = Date.now;
    Date.now = () => ms;
    try { return await fn(); } finally { Date.now = real; }
}

const T0 = Date.parse('2026-10-28T09:00:00.000Z');
const EXP = T0 + 3 * 60 * 1000;   // the dispatcher's standard window (functions/dispatch.js STANDARD_TIMEOUT_S)

function seedOffer({ expiresAtMs = EXP, responseDeadline, offerStatus = 'open' } = {}) {
    fake.db._reset();
    fake.db._set('bookings/b1', {
        status: 'pending', currentArtisanId: 'a1', serviceType: 'plumbing',
        createdAt: new Date(T0 - 60_000).toISOString(),
        ...(responseDeadline !== undefined ? { responseDeadline } : {}),
    });
    fake.db._set('job_offers/b1', {
        bookingId: 'b1', artisanId: 'a1', offerStatus, status: 'pending', round: 1,
        ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    });
    fake.db._set('artisans/a1', { userType: 'artisan', status: 'active', verificationStatus: 'approved', name: 'Kofi' });
}
const accept  = () => jobOffers.respondToJobOffer({ uid: 'a1' }, { bookingId: 'b1', decision: 'accept' });
const decline = () => jobOffers.respondToJobOffer({ uid: 'a1' }, { bookingId: 'b1', decision: 'decline' });

(async () => {

console.log('\n── The screen reads the offer\'s own deadline ──\n');

await t('a job_offers document (expiresAtMs) gives a countdown', () => {
    const st = OFFERS.offerState({ expiresAtMs: EXP }, T0);
    assert.deepStrictEqual(st, { expiresAtMs: EXP, secondsLeft: 180, expired: false });
    assert.strictEqual(OFFERS.formatTimeLeft(st.secondsLeft), '3:00');
});

await t('time left comes from the deadline, not from when the screen opened', () => {
    // A screen opened 2 minutes into the window shows 1:00, not a fresh 3:00.
    assert.strictEqual(OFFERS.offerState({ expiresAtMs: EXP }, T0 + 120_000).secondsLeft, 60);
});

await t('a cached copy (plain {seconds}) and a legacy booking (responseDeadline) still work', () => {
    assert.strictEqual(OFFERS.offerState({ expiresAtMs: { seconds: EXP / 1000 } }, T0).secondsLeft, 180);
    assert.strictEqual(OFFERS.offerState({ responseDeadline: new Date(EXP).toISOString() }, T0).secondsLeft, 180);
});

await t('expiresAtMs wins over a disagreeing responseDeadline', () => {
    assert.strictEqual(OFFERS.offerState({ expiresAtMs: EXP, responseDeadline: EXP + 600_000 }, T0).expiresAtMs, EXP);
});

await t('one millisecond before the deadline it is open; at the deadline it is expired', () => {
    assert.strictEqual(OFFERS.offerState({ expiresAtMs: EXP }, EXP - 1).expired, false);
    assert.strictEqual(OFFERS.offerState({ expiresAtMs: EXP }, EXP).expired, true);
    assert.strictEqual(OFFERS.offerState({ expiresAtMs: EXP }, EXP + 60_000).secondsLeft, 0);
});

await t('a missing or invalid deadline shows no countdown and is not called expired (the server decides)', () => {
    for (const bad of [{}, { expiresAtMs: null }, { expiresAtMs: 'soon' }, { expiresAtMs: NaN }, { expiresAtMs: -5 }]) {
        assert.deepStrictEqual(OFFERS.offerState(bad, T0), { expiresAtMs: null, secondsLeft: null, expired: false });
    }
});

console.log('\n── The server decides, with its own clock ──\n');

await t('accepting one millisecond before the deadline succeeds', async () => {
    seedOffer();
    const r = await at(EXP - 1, accept);
    assert.strictEqual(r.status, 'accepted');
    assert.strictEqual(fake.db._get('bookings/b1').artisanId, 'a1');
});

await t('accepting AT the deadline is refused, and nothing changes', async () => {
    seedOffer();
    await at(EXP, () => assert.rejects(accept(), /expired/));
    assert.strictEqual(fake.db._get('bookings/b1').status, 'pending');
    assert.ok(!fake.db._get('bookings/b1').artisanId);
    assert.strictEqual(fake.db._get('job_offers/b1').offerStatus, 'open', 'the sweep owns closing it');
});

await t('a screen left open: accepting long after the deadline is refused', async () => {
    seedOffer();
    await at(EXP + 10 * 60_000, () => assert.rejects(accept(), /expired/));
});

await t('declining after the deadline is refused too (the offer has moved on)', async () => {
    seedOffer();
    await at(EXP + 1, () => assert.rejects(decline(), /expired/));
});

await t('once the sweep has closed the offer, a stale screen is told it expired', async () => {
    seedOffer({ offerStatus: 'expired' });
    await at(T0, () => assert.rejects(accept(), /expired and has been offered to another professional/));
});

await t('a legacy offer without expiresAtMs falls back to the booking\'s responseDeadline', async () => {
    const ts = { toMillis: () => EXP };   // a Firestore Timestamp
    seedOffer({ expiresAtMs: undefined, responseDeadline: ts });
    await at(EXP + 1, () => assert.rejects(accept(), /expired/));
    seedOffer({ expiresAtMs: undefined, responseDeadline: ts });
    const r = await at(EXP - 1, accept);
    assert.strictEqual(r.status, 'accepted');
});

await t('two accepts racing (double tap, two tabs): exactly one wins', async () => {
    seedOffer();
    const results = await at(T0, () => Promise.allSettled([accept(), accept()]));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const no = results.filter((r) => r.status === 'rejected');
    assert.strictEqual(ok.length, 1, 'one acceptance');
    assert.strictEqual(no.length, 1, 'the other is refused');
    assert.match(String(no[0].reason && no[0].reason.message), /no longer open/);
    assert.strictEqual(fake.db._get('job_offers/b1').offerStatus, 'accepted');
});

await t('accept then a delayed decline from a stale screen: the decline is refused', async () => {
    seedOffer();
    await at(T0, accept);
    await at(T0 + 1000, () => assert.rejects(decline(), /no longer open/));
    assert.strictEqual(fake.db._get('bookings/b1').status, 'accepted');
});

console.log('\n── Every screen that shows an offer counts it down and retires it ──\n');

await t('Today, jobs list and job screen all derive the countdown from offerState', () => {
    const dash = read('artisan-app/dashboard.html');
    const view = read('artisan-app/js/today.js');
    const domain = read('shared/js/domain/artisanToday.js');
    const jobs = read('artisan-app/jobs.html');
    const job  = read('artisan-app/job.html');
    // FLOW-005: one ticker reading the offer's expiresAtMs (no per-card arithmetic).
    // Today (Phase 2): offerView takes expiresAtMs from offerState; the screen
    // writes it to data-expires and the one ticker counts down from it with
    // offerState's boundary (lapsed at now >= expiresAtMs, whole seconds floored).
    assert.ok(/const st = offerState\(o, nowMs\);/.test(domain) && /expiresAtMs: st\.expiresAtMs,/.test(domain) &&
              /answerable: !st\.expired,/.test(domain), 'Today: offerView');
    assert.ok(/data-expires="\$\{c\.expiresAtMs\}"/.test(view) && /formatTimeLeft\(Math\.floor\(left \/ 1000\)\)/.test(view) &&
              /if \(left === 0\) \{/.test(view), 'Today: the countdown');
    assert.ok(/const lapsed = paintCountdowns\(dom\.main, Date\.now\(\)\);/.test(dash), 'Today: the ticker');
    // Jobs (Phase 3): the same offerView; its rows count down from data-expires on one ticker.
    const jobsView = read('artisan-app/js/jobsScreen.js');
    assert.ok(/const open = offers\.map\(\(o\) => offerView\(o, nowMs\)\)\.filter\(\(v\) => v\.answerable\)/.test(jobsView) &&
              /data-expires="\$\{v\.countdown\.expiresAtMs\}"/.test(jobsView) && /formatTimeLeft\(Math\.floor\(left \/ 1000\)\)/.test(jobsView) &&
              /if \(tickOffers\(dom\.list, Date\.now\(\)\)\.length\) paint\(true\);/.test(jobs), 'jobs');
    // The job screen (Phase 2): offerView's countdown (offerState) drawn by
    // jobScreen.js; job.html's one ticker repaints it and redraws at expiry.
    const jobView = read('artisan-app/js/jobScreen.js');
    assert.ok(/const offer = offerView\(b, nowMs\);/.test(jobView) && /const lapsed = !offer\.answerable \|\| offerGone;/.test(jobView) &&
              /This request has expired/.test(jobView), 'job: plan');
    assert.ok(/tickOffer\(/.test(job) && /const ranOut = paintCountdown\(dom\.body, Date\.now\(\)\);/.test(job) &&
              /if \(ranOut \|\| offerState\(offer\)\.expired\)/.test(job), 'job: ticker');
});

console.log(`\noffer-expiry: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
