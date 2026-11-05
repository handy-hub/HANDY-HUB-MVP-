'use strict';
/**
 * tests/artisan-jobs-page.test.cjs — artisan Jobs screen findings from the
 * 28 Oct audit, run against the page's own code.
 *
 *   STATE-001  The selected tab was lost on reload or return.
 *   FORM-001   The quote form disabled Send without saying why.
 *   UI-006     (jobs) The toast wrapped short messages onto 2–3 lines.
 *   RESP-001   (jobs) The tabs were cut off on narrow phones.
 *   FORM-002   (part 1) The quote form never showed the artisan's net earnings.
 *   IA-002     Card actions: "Dashboard" buttons, Navigate on closed jobs, no Cancel when quoted.
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

const { validateQuoteInput, artisanEarningsPreview } = require(path.join(__dirname, '..', 'functions', 'shared', 'quoteMoney.js'));
// The display rate, read from the real config (an ES module) without a loader.
const PLATFORM_CONFIG = { commissionRate: Number(fs.readFileSync(path.join(__dirname, '..', 'shared', 'js', 'config', 'appConfig.js'), 'utf8')
    .match(/commissionRate:\s*([0-9.]+)/)[1]) };

/** The page's own readQuoteInput + recalcQuote over a stub DOM. */
function quoteSheet() {
    const els = {};
    const el = (id) => (els[id] = els[id] || { id, value: '', textContent: '', disabled: false });
    for (const id of ['qs-labour', 'qs-note', 'qs-s-labour', 'qs-s-mats', 'qs-s-total', 'qs-submit', 'qs-msg', 'qs-s-net', 'qs-net-label']) el(id);
    const src = page.slice(page.indexOf('function readQuoteInput() {'), page.indexOf('window.recalcQuote = recalcQuote;'));
    // eslint-disable-next-line no-new-func
    const recalc = new Function('document', 'validateQuoteInput', 'artisanEarningsPreview', 'PLATFORM_CONFIG', '_needsMaterials', `${src}; return recalcQuote;`)(
        { getElementById: (id) => el(id), querySelectorAll: () => [] }, validateQuoteInput, artisanEarningsPreview, PLATFORM_CONFIG, false);
    return { set: (v) => { els['qs-labour'].value = v; recalc(); }, msg: () => els['qs-msg'].textContent, off: () => els['qs-submit'].disabled,
             net: () => els['qs-s-net'].textContent, netLabel: () => els['qs-net-label'].textContent };
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

console.log('\n── UI-006 (jobs) · the toast is one readable pill ──\n');

await t('the toast sizes to its text, within the 16px gutters, centred', () => {
    const rule = (page.match(/\.jobs-toast \{[^}]*\}/) || [''])[0];
    assert.match(rule, /width: max-content;/);
    assert.match(rule, /max-width: calc\(100vw - 32px\);/);
    assert.match(rule, /text-align: center;/);
    assert.match(rule, /left: 50%; transform: translateX\(-50%\);/, 'still centred');
    assert.match(rule, /border-radius: var\(--ds-r-pill\);/, 'still a pill');
});

console.log('\n── RESP-001 · the tabs wrap instead of hiding off-screen ──\n');

await t('the Jobs tabs wrap when they do not fit, never scroll unseen', () => {
    assert.match(page, /\.jobs-header \.ui-tabs \{ flex-wrap: wrap; overflow-x: visible; row-gap: var\(--ds-2\); \}/);
});

console.log('\n── FORM-002 (part 1) · the quote form shows what the artisan takes home ──\n');

await t('a valid quote shows the net after commission; an invalid one shows a dash', () => {
    const q = quoteSheet();
    q.set('150');
    assert.strictEqual(q.net(), '127.50', 'GHS 150 at 15% commission');
    assert.strictEqual(q.netLabel(), 'You receive after 15% commission');
    q.set('0');
    assert.strictEqual(q.net(), '—');
});
await t('the rate comes from PLATFORM_CONFIG, never a literal in the page', () => {
    const recalc = page.slice(page.indexOf('function recalcQuote() {'), page.indexOf('window.recalcQuote = recalcQuote;'));
    assert.match(recalc, /artisanEarningsPreview\(q\.jobQuote, PLATFORM_CONFIG\.commissionRate\)/);
    assert.ok(!/0\.15|15%/.test(recalc), 'no hard-coded rate');
});
await t("job.html's composer shows the same line, from the same helper and config", () => {
    const c = fs.readFileSync(path.join(__dirname, '..', 'shared', 'js', 'ui', 'quoteComposer.js'), 'utf8');
    assert.match(c, /You receive after \$\{Math\.round\(PLATFORM_CONFIG\.commissionRate \* 100\)\}% commission/);
    assert.match(c, /artisanEarningsPreview\(q\.jobQuote, PLATFORM_CONFIG\.commissionRate\)/);
    assert.match(c, /import \{ PLATFORM_CONFIG \} from '\.\.\/config\/appConfig\.js';/);
});

console.log('\n── IA-002 · job card actions match what the artisan can do ──\n');

const cardSrc = page.slice(page.indexOf('// Card actions (audit IA-002).'), page.indexOf('// ── Problem description'));

await t('no card sends the artisan to the dashboard; the secondary action opens THIS job', () => {
    assert.ok(!/dashboard\.html/.test(cardSrc), 'a card still links to the dashboard');
    assert.match(cardSrc, /const openBtn\s+= `<a class="job-btn job-btn-outline" href="job\.html\?id=\$\{encodeURIComponent\(b\.id\)\}">Open job<\/a>`;/);
});
await t('Cancel is offered exactly where the transition layer lets an artisan cancel', () => {
    // The transition layer's answer for an artisan is artisanCanCancel(): the
    // client-write list (accepted, quoted) off the inspection track, and
    // cancelInspectionBooking's pre-approval states on it. The card used the bare
    // list, which offered Cancel on approved inspection work the server refuses
    // (Phase 0 WF-01). tests/artisan-actions-consistency.test.cjs proves the
    // function against the real function code and the rules.
    const actions = fs.readFileSync(path.join(__dirname, '..', 'shared', 'js', 'domain', 'bookingActions.js'), 'utf8');
    assert.match(actions, /export function artisanCanCancel\(booking\)/);
    assert.match(cardSrc, /const cancelBtn = isActive && artisanCanCancel\(b\)/);
    assert.match(page, /import \{ performBookingAction, ACTION, artisanCanCancel \} from '\.\.\/shared\/js\/domain\/bookingActions\.js';/);
    assert.match(page, /window\.cancelJob = async function\(bookingId, btn\) \{\s*await runTransition\(ACTION\.CANCEL, bookingId, btn,/);
    assert.match(cardSrc, /if \(cancelBtn\) actionsHtml \+= cancelBtn;/);
});
await t('Navigate is shown only for jobs that are still open', () => {
    assert.match(page, /\$\{brief\.location\.mapUrl && \(isPending \|\| isActive\)\s*\? `<a class="job-linkbtn job-linkbtn--strong"/);
});

console.log(`\nartisan-jobs-page: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
