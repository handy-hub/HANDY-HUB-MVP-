'use strict';
/**
 * tests/artisan-wallet-nav.test.cjs — two artisan-app fixes from the 28 Oct audit.
 *
 *   FIN-003  The withdraw sheet greyed out Confirm with no reason for GHS 2 (below
 *            the minimum) or GHS 600 (above the balance), and enabled it for
 *            GHS 50.555 — a sub-pesewa amount. It now says why, and refuses
 *            more than 2 decimals. The server re-checks all of it.
 *   NAV-004  The Notifications page lit up the Jobs tab.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

// ── FIN-003: run the withdraw sheet's own withdrawProblem() ─────────────────
// Since Phase 4 it lives in shared/js/domain/artisanEarnings.js (the page
// imports it); this runs that module, with the app's real money format.
const wallet = read('artisan-app/wallet.html');
(async () => {
const { pathToFileURL } = require('url');
const { withdrawProblem } = await import(pathToFileURL(path.join(ROOT, 'shared', 'js', 'domain', 'artisanEarnings.js')).href);
const problem = (raw) => withdrawProblem(raw, { available: 527, min: 5 });

console.log('\n── FIN-003 · the withdraw sheet says why ──\n');

t('a valid amount has no problem', () => {
    for (const ok of ['5', '50', '50.5', '50.55', '527', '527.00']) assert.strictEqual(problem(ok), '', ok);
});
t('below the minimum is named', () => {
    assert.strictEqual(problem('2'), 'The minimum withdrawal is GHS 5.00.');
});
t('above the balance is named, with the balance', () => {
    assert.strictEqual(problem('600'), 'That is more than you can withdraw (GHS 527.00).');
});
t('more than 2 decimals is refused, not rounded', () => {
    assert.strictEqual(problem('50.555'), 'Use at most 2 decimal places (pesewas).');
});
t('nothing typed is not an error (the button is simply off)', () => {
    assert.strictEqual(problem(''), '');
});
t('zero or negative asks for a real amount', () => {
    assert.match(problem('0'), /Enter an amount/);
    assert.match(problem('-5'), /Enter an amount/);
});
t('the sheet shows the reason and Confirm re-checks it', () => {
    assert.match(wallet, /import \{[^}]*\bwithdrawProblem\b[^}]*\} from '\.\.\/shared\/js\/domain\/artisanEarnings\.js'/);
    assert.match(wallet, /id="wd-amount-msg" aria-live="polite"/);
    assert.match(wallet, /const problem = _m \? withdrawProblem\(raw, \{ available: _m\.wallet\.available, min: MIN_WITHDRAWAL \}\) : '';\s+wd\.msg\.textContent = problem;/);
    assert.match(wallet, /if \(!_gate\.can \|\| !String\(raw\)\.trim\(\) \|\| withdrawProblem\(raw, \{ available: _m\.wallet\.available, min: MIN_WITHDRAWAL \}\)\) return;/);
    assert.match(wallet, /const MIN_WITHDRAWAL = PLATFORM_CONFIG\.minWithdrawalGHS;/);
});

// ── NAV-004: each screen names its own tab ───────────────────────────────────
// Until Phase 6 a route map in artisanFloatingNav.js chose the tab for screens
// that did not draw their own bar. Every screen now draws its own, so the map
// is read from where it is decided: each page's renderTabbar call.
console.log('\n── NAV-004 · the bottom nav highlights where you are ──\n');

const ROUTE_MAP = {};
for (const f of fs.readdirSync(path.join(ROOT, 'artisan-app')).filter((n) => n.endsWith('.html'))) {
    const m = /renderTabbar\(document\.getElementById\('tabbar'\), \{ current: '([a-z]+)'/.exec(read(`artisan-app/${f}`));
    if (m) ROUTE_MAP[f] = m[1];
}
// The four tabs (design decision 02), as the tab bar itself defines them.
const controls = read('artisan-app/js/fx/controls.js');
const TABS = [...controls.matchAll(/\{ id: '([a-z]+)',\s+label: '[A-Za-z]+',/g)].map((m) => m[1]);

t('the tab bar is the four tabs: Today, Jobs, Earnings, Account', () => {
    assert.deepStrictEqual(TABS, ['today', 'jobs', 'earnings', 'account']);
});
t('Notifications sits under Today (it is opened from the Today header bell)', () => {
    assert.strictEqual(ROUTE_MAP['notifications.html'], 'today');
});
t('the wallet lights Earnings, and the job screens light Jobs', () => {
    assert.strictEqual(ROUTE_MAP['wallet.html'], 'earnings');
    for (const p of ['jobs.html', 'messages.html']) assert.strictEqual(ROUTE_MAP[p], 'jobs', p);
    // A single job is a pushed screen: Back and its one action, no tab bar.
    assert.ok(!('job.html' in ROUTE_MAP) && !/fx-tabbar/.test(read('artisan-app/job.html')), 'job.html has no tab bar');
});
t('one source of truth: the heartbeat script holds no route map and draws no bar', () => {
    const nav = read('artisan-app/js/artisanFloatingNav.js');
    assert.ok(!/ROUTE_MAP|renderTabbar|fx-tabbar|createElement\('(nav|div|link)'\)/.test(nav.replace(/\/\*[\s\S]*?\*\//g, '')));
    assert.ok(!fs.existsSync(path.join(ROOT, 'artisan-app/css/fx/legacy-shell.css')), 'the legacy shell stylesheet is gone with the last legacy screen');
    assert.deepStrictEqual(Object.keys(ROUTE_MAP).sort(),
        ['dashboard.html', 'jobs.html', 'messages.html', 'notifications.html', 'profile.html', 'reputation.html', 'settings.html', 'support.html', 'wallet.html']);
});
t('every mapped page lights a tab that exists', () => {
    for (const [page, tab] of Object.entries(ROUTE_MAP)) assert.ok(TABS.includes(tab), `${page} → ${tab}`);
});

console.log(`\nartisan-wallet-nav: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.message}`);
process.exit(failed ? 1 : 0);
})();
