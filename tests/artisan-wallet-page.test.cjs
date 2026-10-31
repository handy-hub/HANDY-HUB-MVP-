'use strict';
/**
 * tests/artisan-wallet-page.test.cjs — artisan wallet screen findings from the
 * 28 Oct audit, run against the page's own code.
 *
 *   UI-009  A wallet history row did not say which job paid.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const wallet = fs.readFileSync(path.join(__dirname, '..', 'artisan-app', 'wallet.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; failures.push([name, e]); console.log('  ✗ ' + name); }
}

(async () => {
console.log('\n── UI-009 · a wallet row names the job and links to it ──\n');

/** The page's own loader + title over a fake database. */
function txnNaming({ live = true, bookings = {} } = {}) {
    const src = wallet.slice(wallet.indexOf('const _txnBookings'), wallet.indexOf('function buildTxnHTML(t, isLast) {'));
    const reads = [];
    const databaseService = { getDocument: async (col, id) => { reads.push(id); return bookings[id] ? { exists: true, data: bookings[id] } : { exists: false }; } };
    const serviceLabel = (v) => (v ? String(v).charAt(0).toUpperCase() + String(v).slice(1) : null);
    let rendered = 0;
    // eslint-disable-next-line no-new-func
    const api = new Function('databaseService', 'serviceLabel', 'renderTxns', 'lastTxns', 'setLive',
        `${src}; setLive((v) => { _txnLive = v; }); return { loadTxnBookings, txnTitle };`)(
        databaseService, serviceLabel, () => { rendered++; }, [], (f) => f(live));
    return { ...api, reads, rendered: () => rendered };
}
const rec = (bookingId, extra = {}) => ({ id: `t_${bookingId}`, data: { type: 'earning', bookingId, description: 'Booking payment received', ...extra } });

await t('an earning row reads "Service · first name" once its booking is read', async () => {
    const n = txnNaming({ bookings: { B1: { serviceType: 'plumbing', customerFirstName: 'Ama' } } });
    await n.loadTxnBookings([rec('B1')]);
    assert.strictEqual(n.txnTitle(rec('B1').data), 'Plumbing · Ama');
});
await t('until then, or if unreadable, the row keeps its own description', async () => {
    const n = txnNaming({ bookings: {} });
    assert.strictEqual(n.txnTitle(rec('B9').data), 'Booking payment received');
    await n.loadTxnBookings([rec('B9')]);
    assert.strictEqual(n.txnTitle(rec('B9').data), 'Booking payment received');
    assert.strictEqual(n.txnTitle({ type: 'withdrawal', description: 'Withdrawal to MTN' }), 'Withdrawal to MTN');
});
await t('booking reads are bounded: live list only, once per booking, at most 20', async () => {
    const cached = txnNaming({ live: false });
    await cached.loadTxnBookings([rec('B1')]);
    assert.deepStrictEqual(cached.reads, [], 'never from the cached paint');
    const many = txnNaming();
    const recs = Array.from({ length: 30 }, (_, i) => rec(`B${i}`)).concat([rec('B0'), rec('B1')]);
    await many.loadTxnBookings(recs);
    await many.loadTxnBookings(recs);
    assert.strictEqual(many.reads.length, 20, 'capped and deduped');
});
await t('the row escapes its title and links the job; no money figure comes from the booking', () => {
    assert.match(wallet, /<p class="txn-title">\$\{esc\(txnTitle\(d\)\)\}<\/p>/);
    assert.match(wallet, /<a class="txn-ref" href="job\.html\?id=\$\{encodeURIComponent\(d\.bookingId\)\}">View job<\/a>/);
    const loader = wallet.slice(wallet.indexOf('async function loadTxnBookings'), wallet.indexOf('function txnTitle'));
    assert.ok(!/amount|artisanEarns|jobQuote|escrow/i.test(loader), 'the booking read is for names only');
});


console.log(`\nartisan-wallet-page: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
