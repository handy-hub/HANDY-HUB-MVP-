'use strict';
/**
 * tests/artisan-jobs-page.test.cjs — artisan Jobs screen findings from the
 * 28 Oct audit, held against the rebuilt screen (Phase 3).
 *
 *   STATE-001  The selected tab was lost on reload or return.
 *   FORM-001   The quote form disabled Send without saying why.
 *   UI-006     (jobs) The toast wrapped short messages onto 2–3 lines.
 *   RESP-001   (jobs) The tabs were cut off on narrow phones.
 *   FORM-002   (part 1) The quote form never showed the artisan's net earnings.
 *   IA-002     Card actions: "Dashboard" buttons, Navigate on closed jobs, no Cancel when quoted.
 *
 * Phase 3 rebuilt Jobs (artisan-app/jobs.html wiring, js/jobsScreen.js drawing,
 * shared/js/domain/artisanJobs.js placement). The quote form left Jobs for the
 * job screen's shared composer (one composer, not two); actions left the list
 * for the job screen. Each finding is checked where it now lives. The rendered
 * checks are tests/e2e/artisan_jobs.py and tests/e2e/offer_refusal.py (Jobs).
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const page   = read('artisan-app/jobs.html');
const screen = read('artisan-app/js/jobsScreen.js');
const plan   = read('artisan-app/js/jobScreen.js');
const composer = read('shared/js/ui/quoteComposer.js');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

/** The page's own URL-state code, run over a given location. */
function urlState(search) {
    const src = page.slice(page.indexOf('const LEGACY_TAB'), page.indexOf('keepInUrl();', page.indexOf('function keepInUrl')) + 'keepInUrl();'.length);
    const writes = [];
    const loc = { search, href: `https://a.example/artisan-app/jobs.html${search}` };
    // eslint-disable-next-line no-new-func
    const out = new Function('location', 'history', 'URL', 'URLSearchParams', 'JOB_VIEWS', 'HISTORY_FILTERS',
        `${src}; return { view: _view, filter: _filter };`)(
        loc, { state: null, replaceState: (_s, _t, url) => writes.push(String(url)) }, URL, URLSearchParams,
        ['current', 'upcoming', 'history'], ['all', 'completed', 'cancelled']);
    return { ...out, url: writes[writes.length - 1] };
}

(async () => {
console.log('\n── STATE-001 · Jobs reopens where the artisan left it ──\n');

await t('?view= and ?filter= name the view; anything else lands on Current', () => {
    assert.deepStrictEqual([urlState('?view=history&filter=cancelled').view, urlState('?view=history&filter=cancelled').filter], ['history', 'cancelled']);
    assert.strictEqual(urlState('?view=upcoming').view, 'upcoming');
    assert.deepStrictEqual([urlState('?view=bogus&filter=x').view, urlState('?view=bogus&filter=x').filter], ['current', 'all']);
    assert.strictEqual(urlState('').view, 'current');
});

await t('old ?tab= links still land on the matching view, and the URL is rewritten to the new form', () => {
    const c = urlState('?tab=completed');
    assert.deepStrictEqual([c.view, c.filter], ['history', 'completed']);
    assert.strictEqual(c.url, 'https://a.example/artisan-app/jobs.html?view=history&filter=completed');
    assert.strictEqual(urlState('?tab=pending').view, 'current');
    assert.strictEqual(urlState('?tab=cancelled').filter, 'cancelled');
});

await t('switching view or filter writes it back with replaceState; Back restores the scroll', () => {
    assert.match(page, /_view = b\.dataset\.view;\s*keepInUrl\(\);/);
    assert.match(page, /_filter = b\.dataset\.filter;\s*keepInUrl\(\);/);
    assert.match(page, /rememberScroll\(\{ name: 'jobs\.html' \}\);/);
});

await t('?id= and ?quote= open that job\'s own screen, before anything loads', () => {
    assert.match(page, /var one = q\.get\('id'\) \|\| q\.get\('quote'\);\s*if \(one\) \{ window\.__jobsLeaving = true; location\.replace\('job\.html\?id=' \+ encodeURIComponent\(one\)\); \}/);
    assert.match(page, /if \(window\.__jobsLeaving\) await new Promise\(\(\) => \{\}\);/);
});

console.log('\n── FORM-001 / FORM-002 · one quote composer, on the job screen ──\n');

await t('Jobs carries no quote form; the job screen mounts the shared composer inline', () => {
    assert.ok(!/qs-sheet|submitJobQuote|validateQuoteInput|artisanEarningsPreview/.test(page), 'a second composer is on Jobs');
    assert.match(read('artisan-app/job.html'), /mountQuoteComposer\(\{/);
    assert.match(plan, /mountQuote: op === 'submitQuote',/);
});

await t('the composer says why Send is off, in the validator\'s own words, in a polite live region', () => {
    assert.match(composer, /<p id="qc-msg" class="qc-msg" role="status" aria-live="polite"><\/p>\s*<button type="button" id="qc-submit"/);
    assert.match(composer, /\$\('qc-msg'\)\.textContent = \(!checked\.ok && touched\) \? checked\.message : '';/);
});

await t('the composer shows the net after commission, from the shared helper and PLATFORM_CONFIG', () => {
    assert.match(composer, /You receive after \$\{Math\.round\(PLATFORM_CONFIG\.commissionRate \* 100\)\}% commission/);
    assert.match(composer, /artisanEarningsPreview\(q\.jobQuote, PLATFORM_CONFIG\.commissionRate\)/);
    assert.match(composer, /import \{ PLATFORM_CONFIG \} from '\.\.\/config\/appConfig\.js';/);
});

console.log('\n── UI-006 / RESP-001 · readable messages, nothing cut off ──\n');

await t('messages are the design system\'s notices (no page-local toast)', () => {
    assert.ok(!/jobs-toast|function showToast/.test(page), 'a page-local toast is back');
    assert.match(page, /el\.className = 'fx-notice fx-notice--warn';/);
});

await t('the views are a segmented control that shares the width, never a sideways scroll', () => {
    assert.match(page, /<div class="fx-seg" role="group" aria-label="Show" id="jobs-views">/);
    assert.match(read('artisan-app/css/app.css'), /\.fx-seg \{\s*display: grid; grid-auto-flow: column; grid-auto-columns: minmax\(0, 1fr\);/);
    // 360 / 390 / 768 px and 200% text, rendered: tests/e2e/artisan_jobs.py.
});

console.log('\n── IA-002 · every row opens its job; actions live there ──\n');

await t('no row sends the artisan to the dashboard; every row opens THIS job', () => {
    assert.ok(!/dashboard\.html/.test(screen), 'a row links to the dashboard');
    assert.match(screen, /const jobHref = \(id\) => `job\.html\?id=\$\{encodeURIComponent\(id\)\}`;/);
    assert.match(screen, /<a class="fx-row fx-jobs__row" href="\$\{jobHref\(r\.id\)\}"/);
});

await t('Cancel is offered on the job screen exactly where artisanCanCancel allows (Q4/Q5), with its consequences', () => {
    assert.ok(!/cancelJob|ACTION\.CANCEL/.test(page + screen), 'the list cancels');
    assert.match(plan, /const help = artisanCanCancel\(b\)\s*\? \{ act: 'cancel', label: 'Cancel job', danger: true \}\s*: \{ act: 'help', label: 'Get help with this job' \};/);
    assert.match(read('artisan-app/job.html'), /list: cancellationTerms\(b\)\.consequences \|\| \[\]/);
});

await t('Navigate is shown only for jobs that are still open (the job screen; the list has none)', () => {
    assert.ok(!/google\.com\/maps|mapUrl/.test(screen + page), 'the list links to Maps');
    assert.match(plan, /\$\{withContact \? nav : ''\}/, 'closed jobs show no Maps link');
});

console.log('\n── Reads: shared, bounded, and nothing the rules withhold ──\n');

await t('the live lists are Today\'s own (one definition, one cache entry)', () => {
    for (const f of ['artisan-app/jobs.html', 'artisan-app/dashboard.html']) {
        assert.match(read(f), /databaseService\.subscribeToCollection\(\.\.\.activeQuery\(uid\), liveList\(onData\), onError\)/, f);
        assert.match(read(f), /key: ACTIVE_LIST\.key/, f);
    }
});

await t('history is paged (20 at a time, newest first), one request per filter at a time', async () => {
    const { pathToFileURL } = require('url');
    const lists = await import(pathToFileURL(path.join(ROOT, 'artisan-app', 'js', 'artisanLists.js')).href);
    const [coll, cond, opts] = lists.historyQuery('u1', { after: '2026-11-01T00:00:00.000Z' });
    assert.strictEqual(coll, 'bookings');
    assert.deepStrictEqual(cond, [{ field: 'artisanId', op: '==', value: 'u1' }, { field: 'status', op: 'in', value: ['completed', 'cancelled', 'resolved'] }]);
    assert.deepStrictEqual(opts, { orderBy: { field: 'updatedAt', direction: 'desc' }, limit: 20, startAfter: '2026-11-01T00:00:00.000Z' });
    assert.match(page, /if \(!uid \|\| p\.busy \|\| p\.done\) return;\s*\/\/ one request at a time per filter/);
    // The (artisanId, status, updatedAt desc) composite index serves it.
    const idx = JSON.parse(read('firestore.indexes.json')).indexes.find((i) => i.collectionGroup === 'bookings' &&
        i.fields.map((f) => f.fieldPath).join() === 'artisanId,status,updatedAt');
    assert.ok(idx && idx.fields[2].order === 'DESCENDING', 'the index the history query needs');
});

await t('Jobs never reads the customer\'s contact or an escrow: rows show neither', () => {
    assert.ok(!/private`, 'contact'|getDocument\('escrow'/.test(page));
});

console.log(`\nartisan-jobs-page: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
