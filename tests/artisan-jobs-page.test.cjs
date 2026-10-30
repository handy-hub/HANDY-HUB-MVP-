'use strict';
/**
 * tests/artisan-jobs-page.test.cjs — artisan Jobs screen findings from the
 * 28 Oct audit, run against the page's own code.
 *
 *   STATE-001  The selected tab was lost on reload or return.
 *   FORM-001   The quote form disabled Send without saying why.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const page = fs.readFileSync(path.join(__dirname, '..', 'artisan-app', 'jobs.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

(async () => {
console.log('\n── STATE-001 · the Jobs tab survives a reload or a return ──\n');

const requestedTab = (search) => {
    const src = page.slice(page.indexOf('const JOB_TABS'), page.indexOf('})();', page.indexOf('const REQUESTED_TAB')) + 5);
    // eslint-disable-next-line no-new-func
    return new Function('location', 'URLSearchParams', `${src}; return REQUESTED_TAB;`)({ search }, URLSearchParams);
};

await t('?tab= names the tab to open; anything else is ignored', () => {
    assert.strictEqual(requestedTab('?tab=completed'), 'completed');
    assert.strictEqual(requestedTab('?tab=active&quote=HHB-1'), 'active');
    assert.strictEqual(requestedTab('?tab=bogus'), null);
    assert.strictEqual(requestedTab(''), null);
});

await t('switching tab writes ?tab= with replaceState, keeping other parameters', () => {
    const src = page.slice(page.indexOf('window.switchJobTab = function(tab, btn) {'), page.indexOf('};', page.indexOf('window.switchJobTab = function(tab, btn) {')) + 2);
    const el = () => ({ classList: { add() {}, remove() {} }, setAttribute() {} });
    const writes = [];
    const win = {};
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'location', 'history', 'URL', '_loadEscrows', src.replace('_tab = tab;', ''))(
        win,
        { querySelectorAll: () => [el()], getElementById: () => el() },
        { href: 'https://a.example/artisan-app/jobs.html?quote=HHB-9' },
        { state: null, replaceState: (_s, _t, url) => writes.push(String(url)) },
        URL, () => {});
    win.switchJobTab('completed', el());
    assert.deepStrictEqual(writes, ['https://a.example/artisan-app/jobs.html?quote=HHB-9&tab=completed']);
});

await t('the one-time auto-tab yields to a tab the URL already names', () => {
    const block = page.slice(page.indexOf('if (!_autoTabDone) {'), page.indexOf('openQuoteFromDeepLink();'));
    assert.match(block, /const target = REQUESTED_TAB \? REQUESTED_TAB\s*: pending\.length \? 'pending'/);
});

console.log('\n── FORM-001 · the quote form says why Send is off ──\n');

const { validateQuoteInput } = require(path.join(__dirname, '..', 'functions', 'shared', 'quoteMoney.js'));

/** The page's own readQuoteInput + recalcQuote over a stub DOM. */
function quoteSheet() {
    const els = {};
    const el = (id) => (els[id] = els[id] || { id, value: '', textContent: '', disabled: false });
    for (const id of ['qs-labour', 'qs-note', 'qs-s-labour', 'qs-s-mats', 'qs-s-total', 'qs-submit', 'qs-msg']) el(id);
    const src = page.slice(page.indexOf('function readQuoteInput() {'), page.indexOf('window.recalcQuote = recalcQuote;'));
    // eslint-disable-next-line no-new-func
    const recalc = new Function('document', 'validateQuoteInput', '_needsMaterials', `${src}; return recalcQuote;`)(
        { getElementById: (id) => el(id), querySelectorAll: () => [] }, validateQuoteInput, false);
    return { set: (v) => { els['qs-labour'].value = v; recalc(); }, msg: () => els['qs-msg'].textContent, off: () => els['qs-submit'].disabled };
}

await t('an untouched form says nothing, though Send is off', () => {
    const q = quoteSheet(); q.set('');
    assert.strictEqual(q.off(), true);
    assert.strictEqual(q.msg(), '');
});
await t('an invalid amount says why, in the validator\'s own words', () => {
    const q = quoteSheet(); q.set('0');
    assert.strictEqual(q.off(), true);
    assert.strictEqual(q.msg(), 'Labour cost must be greater than 0.');
    q.set('abc');
    assert.ok(q.msg().length > 0, 'a non-number is explained too');
});
await t('a valid quote clears the reason and enables Send', () => {
    const q = quoteSheet(); q.set('0'); q.set('150');
    assert.strictEqual(q.off(), false);
    assert.strictEqual(q.msg(), '');
});
await t('the sheet has a polite live region above Send', () => {
    assert.match(page, /<p id="qs-msg" class="qs-msg" role="status" aria-live="polite"><\/p>\s*<button id="qs-submit"/);
});
await t('job.html\'s composer (shared/js/ui/quoteComposer.js) does the same', () => {
    const c = fs.readFileSync(path.join(__dirname, '..', 'shared', 'js', 'ui', 'quoteComposer.js'), 'utf8');
    assert.match(c, /<p id="qc-msg" class="qc-msg" role="status" aria-live="polite"><\/p>\s*<button type="button" id="qc-submit"/);
    const recalc = c.slice(c.indexOf('function recalc() {'), c.indexOf('function setMaterials('));
    assert.match(recalc, /\$\('qc-msg'\)\.textContent = \(!checked\.ok && touched\) \? checked\.message : '';/);
});

console.log(`\nartisan-jobs-page: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
