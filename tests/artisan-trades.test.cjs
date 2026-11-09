'use strict';
/**
 * tests/artisan-trades.test.cjs — the trades an artisan can register under are
 * exactly the trades a customer can book, and every one of them reaches dispatch
 * (Phase 5, decision of 2026-11-09).
 *
 * Before: onboarding offered Tiling, Roofing, Moving, Landscaping and Security —
 * no customer can book any of them, so an artisan who chose one never received a
 * job — and no artisan trade matched the customers' Gardening, so a gardening
 * booking could never be dispatched. Run against the real code: the customer
 * catalogue, functions/artisanIndex.js (the index dispatch reads), the rule
 * functions/dispatch.js matches with, sign-up (functions/emailOtp.js) and
 * profile-change requests (functions/artisanAccount.js).
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { pathToFileURL } = require('url');

const fake = require('./support/fake-firebase.cjs').install();
const ROOT = path.join(__dirname, '..');
const FN   = path.join(ROOT, 'functions');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
const quiet = () => { const o = [console.log, console.error, console.warn]; console.log = console.error = console.warn = () => {}; return () => { [console.log, console.error, console.warn] = o; }; };

(async () => {
const T = await import(pathToFileURL(path.join(ROOT, 'shared', 'js', 'domain', 'artisanTrades.js')).href);
const { SERVICE_CATEGORIES } = await import(pathToFileURL(path.join(ROOT, 'shared', 'js', 'data', 'serviceCatalog.js')).href);
const mirror = require(path.join(FN, 'shared', 'artisanTrades.js'));
const index  = require(path.join(FN, 'artisanIndex.js'));
const otp    = require(path.join(FN, 'emailOtp.js'));
const acct   = require(path.join(FN, 'artisanAccount.js'));

// The match functions/dispatch.js applies: the first word of the booking's
// serviceType, lower-cased, contained in one of the artisan's indexed terms.
const dispatchSrc = read('functions/dispatch.js');
const keyword = (serviceType) => String(serviceType).split(/[\s,/]+/)[0].toLowerCase();
const skillsOf = (category) => index._buildIndexDoc('a1', { category, specialty: category }, 5.6, -0.19).skills || [];
const reaches = (category, serviceType) => skillsOf(category).some((s) => String(s).includes(keyword(serviceType)));
const LABELS = SERVICE_CATEGORIES.map((c) => c.categoryLabel);

console.log('\n── One list: the trades customers can book ──\n');

await t('the trades are exactly the customer catalogue\'s categories, in the server mirror too', () => {
    assert.deepStrictEqual([...T.ARTISAN_TRADES].sort(), [...LABELS].sort());
    assert.deepStrictEqual([...mirror.ARTISAN_TRADES], [...T.ARTISAN_TRADES]);
    assert.strictEqual(T.OTHER_TRADE, 'Other');
});

await t('dispatch\'s match rule is the one this test applies', () => {
    assert.match(dispatchSrc, /const keyword = serviceType\.split\(\/\[\\s,\/\]\+\/\)\[0\]\.toLowerCase\(\);/);
    assert.match(dispatchSrc, /!\(a\.skills \|\| \[\]\)\.some\(s => String\(s\)\.includes\(keyword\)\)\) return false;/);
    // A standard booking's serviceType is the catalogue label (functions/pricing.js via bookRequestPage.js).
    assert.match(read('customer-app/js/pages/bookRequestPage.js'), /serviceLabel: cat\.categoryLabel,/);
});

await t('every trade reaches the bookings for its own service, and only those', () => {
    for (const trade of T.ARTISAN_TRADES) {
        const reached = LABELS.filter((l) => reaches(trade, l));
        assert.deepStrictEqual(reached, [trade], `${trade} reaches ${reached.join(', ') || 'nothing'}`);
    }
});

await t('the trades the old forms offered that no customer can book are gone, and Gardening is matched', () => {
    for (const gone of ['Tiling', 'Roofing', 'Moving', 'Landscaping', 'Security', 'AC']) assert.ok(!T.ARTISAN_TRADES.includes(gone), gone);
    for (const old of ['Tiling', 'Roofing', 'Moving', 'Security']) assert.deepStrictEqual(LABELS.filter((l) => reaches(old, l)), [], `${old} never reached a booking`);
    assert.ok(reaches('Gardening', 'Gardening'));
    assert.ok(!reaches('Landscaping', 'Gardening'), 'the old onboarding value never matched gardening bookings');
});

await t('older stored values read as the trade they meant; ones with no bookable meaning are never guessed', () => {
    const cases = { 'ac_cooling': 'AC Repair', 'AC': 'AC Repair', 'ac-repair': 'AC Repair', 'electrical': 'Electrical', 'Plumbing': 'Plumbing',
                    'Landscaping': 'Gardening', 'Welding & Fabrication': 'Welding', 'Cleaning Services': 'Cleaning', ' painting ': 'Painting' };
    for (const [v, want] of Object.entries(cases)) assert.strictEqual(T.canonicalTrade(v), want, v);
    for (const v of ['Tiling', 'Roofing', 'Moving', 'Security', 'Other', '', null, undefined, 'plumbin']) assert.strictEqual(T.canonicalTrade(v), null, String(v));
    assert.deepStrictEqual([T.isArtisanTrade('AC Repair'), T.isArtisanTrade('ac repair'), T.isOtherTrade('other'), T.isOtherTrade('Other '), T.isOtherTrade('Others')], [true, false, true, true, false]);
});

console.log('\n── Sign-up stores the bookable trade (functions/emailOtp.js) ──\n');

async function signUp(payload) {
    fake.db._reset(); fake.auth.reset();
    const base = { name: 'Kofi Mensah', email: 'kofi@example.test', password: 'longenough1', phone: '0241234567' };
    const restore = quiet();
    try { return await otp.signUpArtisanDirect({ payload: { ...base, ...payload } }); }
    finally { restore(); }
}
const profile = () => {
    const k = fake.db._keys('artisans/').find((p) => p.split('/').length === 2);
    return k ? fake.db._get(k) : null;
};
const refusal = async (payload) => { try { await signUp(payload); return null; } catch (e) { return e; } };

await t('each bookable trade is accepted and stored as its label', async () => {
    for (const trade of T.ARTISAN_TRADES) {
        await signUp({ category: trade });
        assert.deepStrictEqual([profile().category, profile().specialty], [trade, trade], trade);
    }
});
await t('an older sign-up page\'s ids still work, stored as the trade they mean', async () => {
    await signUp({ category: 'ac_cooling' });
    assert.strictEqual(profile().category, 'AC Repair');
    await signUp({ category: 'electrical' });
    assert.strictEqual(profile().category, 'Electrical');
});
await t('"Other": the description goes to review, the artisan works under the closest bookable trade', async () => {
    await signUp({ category: 'Other', otherDesc: 'Solar inverter installation', otherBucket: 'Electrical' });
    assert.deepStrictEqual([profile().category, profile().requestedService], ['Electrical', 'Solar inverter installation']);
    assert.ok(fake.db._keys('service_requests/').length >= 1, 'queued for review');
});
await t('refused: a trade no customer can book, "Other" without a closest trade or a description', async () => {
    for (const category of ['Tiling', 'tiling', 'Roofing', 'Security', 'gardening-and-more', '']) {
        const e = await refusal({ category });
        assert.ok(e && e.code === 'invalid-argument', `${category}: ${e && e.message}`);
    }
    assert.strictEqual((await refusal({ category: 'Other', otherDesc: 'Roof repair', otherBucket: 'Roofing' })).message, 'Choose the listed trade closest to yours.');
    assert.strictEqual((await refusal({ category: 'Other', otherDesc: '', otherBucket: 'Carpentry' })).message, 'Describe your trade.');
    assert.strictEqual(fake.db._keys('artisans/').length, 0, 'nothing was created');
});

console.log('\n── Profile-change requests use the same list (functions/artisanAccount.js) ──\n');

await t('a change to a bookable trade is a request; an older value meaning the same trade is no change', () => {
    assert.deepStrictEqual(acct.validateProfileChange({ category: 'Plumbing' }, { category: 'Gardening', reason: 'I now work as a gardener.' }).requested, { category: 'Gardening' });
    assert.throws(() => acct.validateProfileChange({ category: 'AC' }, { category: 'AC Repair', reason: 'Same trade, new name.' }), /Nothing to change/);
    assert.throws(() => acct.validateProfileChange({ category: 'Plumbing' }, { category: 'Roofing', reason: 'I also fix roofs now.' }), /Choose one of the listed trades/);
    assert.deepStrictEqual([...acct.ARTISAN_TRADES], [...T.ARTISAN_TRADES]);
});

await t('the app\'s forms use the shared list (no copy of their own)', () => {
    assert.match(read('artisan-app/js/utils/artisanAccount.js'), /export \{ ARTISAN_TRADES \} from '\.\.\/\.\.\/\.\.\/shared\/js\/domain\/artisanTrades\.js';/);
    for (const f of ['artisan-app/js/utils/artisanAccount.js', 'functions/artisanAccount.js', 'functions/emailOtp.js']) {
        assert.doesNotMatch(read(f), /'Roofing'|'Landscaping'|'Moving'|'ac_cooling','tiling'/, f);
    }
});

console.log(`\nartisan-trades: ${passed} passed, ${failed} failed`);
if (failed) { for (const [n, e] of failures) console.log(`\n✗ ${n}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
