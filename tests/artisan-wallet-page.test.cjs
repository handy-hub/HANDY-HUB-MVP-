'use strict';
/**
 * tests/artisan-wallet-page.test.cjs — artisan wallet screen findings from the
 * 28 Oct audit, run against the screen's own code.
 *
 *   UI-009  A wallet history row did not say which job paid.
 *   (tips)  A tip received showed as "− GHS x", a debit.
 *
 * Since Phase 4 the Earnings screen (wallet.html) draws through
 * artisan-app/js/earningsScreen.js and describes rows with
 * shared/js/domain/artisanEarnings.js ledgerRow; these run those modules.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const wallet = fs.readFileSync(path.join(ROOT, 'artisan-app', 'wallet.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; failures.push([name, e]); console.log('  ✗ ' + name); }
}

(async () => {
const S = await import(pathToFileURL(path.join(ROOT, 'artisan-app', 'js', 'earningsScreen.js')).href);
const { ledgerRow } = await import(pathToFileURL(path.join(ROOT, 'shared', 'js', 'domain', 'artisanEarnings.js')).href);

console.log('\n── UI-009 · a wallet row names the job and links to it ──\n');

/** The screen's own booking-name loader over a fake database. */
function naming({ live = true, bookings = {} } = {}) {
    const reads = [];
    let changed = 0;
    const serviceLabel = (v) => (v ? String(v).charAt(0).toUpperCase() + String(v).slice(1) : null);
    const names = S.createBookingNames({
        getDocument: async (col, id) => { assert.strictEqual(col, 'bookings'); reads.push(id); return bookings[id] ? { exists: true, data: bookings[id] } : { exists: false }; },
        serviceLabel, max: 20, onChange: () => { changed++; },
    });
    names.setLive(live);
    return { names, reads, changed: () => changed };
}
const earning = (bookingId, extra = {}) => ({ id: `t_${bookingId}`, type: 'earning', bookingId, amount: 85, commission: 15, totalAmount: 100,
                                              commissionRate: 0.15, description: 'Booking payment received', ...extra });
const titleOf = (names, t) => S.activityRows([t], [], names)[0].title;

await t('an earning row reads "Job payment · Service · first name" once its booking is read', async () => {
    const n = naming({ bookings: { B1: { serviceType: 'plumbing', customerFirstName: 'Ama' } } });
    await n.names.load(['B1']);
    assert.strictEqual(n.names.label('B1'), 'Plumbing · Ama');
    assert.strictEqual(titleOf(n.names, earning('B1')), 'Job payment · Plumbing · Ama');
    assert.strictEqual(n.changed(), 1, 'the screen is redrawn once the name is known');
});
await t('until then, or if unreadable, the row keeps its own words', async () => {
    const n = naming({ bookings: {} });
    assert.strictEqual(titleOf(n.names, earning('B9')), 'Job payment');
    await n.names.load(['B9']);
    assert.strictEqual(titleOf(n.names, earning('B9')), 'Job payment');
    assert.strictEqual(titleOf(n.names, { id: 'w', type: 'withdrawal', amount: 50, provider: 'mtn', phone: '0241234567' }), 'Withdrawal to MTN MoMo 024 ••• 4567');
});
await t('booking reads are bounded: live data only, once per booking, at most 20', async () => {
    const cached = naming({ live: false });
    await cached.names.load(['B1']);
    assert.deepStrictEqual(cached.reads, [], 'never from the cached paint');
    const many = naming();
    const ids = Array.from({ length: 30 }, (_, i) => `B${i}`).concat(['B0', 'B1']);
    await many.names.load(ids);
    await many.names.load(ids);
    assert.strictEqual(many.reads.length, 20, 'capped and deduped');
    assert.strictEqual(new Set(many.reads).size, 20);
    // The page turns the reads on only from LIVE data, never from a cached paint.
    assert.match(wallet, /createBookingNames\(\{[\s\S]*?serviceLabel, max: 20,/);
    assert.strictEqual([...wallet.matchAll(/names\.setLive\(true\)/g)].length, 2);
    assert.match(wallet, /if \(!fromCache\) \{ S\.liveFromServer = fromServer; S\.txnsFailed = false; names\.setLive\(true\); \}/);
    assert.match(wallet, /if \(!res\.fromCache\) \{ names\.setLive\(true\); names\.load\(bookingIdsToName\(\)\); \}/);
});
await t('the row escapes its title and links the job; no money figure comes from the booking', async () => {
    const r = ledgerRow({ id: 'x', type: 'other-kind', description: '<img src=x onerror=alert(1)>', amount: 1 });
    assert.ok(!S.activityRowHtml(r).includes('<img'), 'escaped');
    const job = ledgerRow(earning('B 1'));
    assert.match(S.detailHtml(job), /<a class="fx-btn fx-btn--secondary fx-btn--block" href="job\.html\?id=B%201">Open the job<\/a>/);
    const loader = S.createBookingNames.toString();
    assert.ok(!/amount|artisanEarns|jobQuote|escrow|commission/i.test(loader), 'the booking read is for names only');
});


console.log('\n── A tip is money IN (display) ──\n');

await t('a tip row reads "+ GHS x" as money in, like an earning', () => {
    const tip = S.activityRowHtml(ledgerRow({ id: 'tp', type: 'tip', amount: 10, bookingId: 'B1', status: 'completed' }));
    assert.match(tip, /fx-earn__amt--in">\+ GHS 10\.00/);
    const job = S.activityRowHtml(ledgerRow(earning('B1')));
    assert.match(job, /fx-earn__amt--in">\+ GHS 85\.00/);
});
await t('a withdrawal is still money out', () => {
    const w = S.activityRowHtml(ledgerRow({ id: 'w', type: 'withdrawal', amount: 50, status: 'completed' }));
    assert.match(w, /fx-earn__amt--out">− GHS 50\.00/);
});

console.log(`\nartisan-wallet-page: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
