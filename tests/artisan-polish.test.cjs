'use strict';
/**
 * tests/artisan-polish.test.cjs — the 28 Oct audit's artisan Lows (polish
 * batch). Source-level; each section names its audit ID.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

// IA-004 was "the selected period's figures sat among lifetime figures with no
// label". Phase 4 replaced Performance with Reputation, which has no period
// selector: every figure's window is fixed by the rule behind it, so each one
// states its own window instead. Earned (money) moved to Earnings.
console.log('\n── IA-004 · reputation: every figure says which period it covers ──\n');

t('each figure names its window: rating (all reviews), response (90 days), completion (all, or the latest N), recent (30 days)', () => {
    const src = read('artisan-app/js/reputationScreen.js');
    assert.match(src, /`From \$\{plural\(r\.count, 'review'\)\}\. Counts in matching\.`/);
    assert.match(src, /answered before they expired, in the last \$\{s\.windowDays\} days\./);
    assert.match(src, / From your latest \$\{m\.scope\.read\} finished jobs\./);
    assert.match(src, /row\(`Jobs completed, last \$\{a\.days\} days`/);
});

t('no period selector that could apply one window to figures measured over another; no money on Reputation', () => {
    const page = read('artisan-app/reputation.html'), screen = read('artisan-app/js/reputationScreen.js');
    assert.doesNotMatch(page + screen, /PERIOD_LABEL|period-btn|setPeriod|This week|This month/);
    assert.doesNotMatch(page + screen, /totalEarned|availableBalance|formatGHS|GHS /, 'money belongs on Earnings');
});

console.log('\n── UI-006 · the artisan toast stays on screen ──\n');

// The two legacy stylesheets this guarded (css/dashboard.css, css/onboarding.css)
// were removed in Phase 6: every artisan screen now shows the design system's
// toast (js/fx/toast.js, .fx-toast in css/app.css). The same property is held
// there: a long message wraps inside the screen's gutter and is never clipped.
/** The declarations of a rule in css/app.css. */
function appRule(selector) {
    const css = read('artisan-app/css/app.css');
    const at = css.indexOf(`\n${selector} {`);
    assert.ok(at >= 0, `app.css: no ${selector} rule`);
    return css.slice(at, css.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '');
}
t('the artisan toast wraps within the gutter, never nowrap, and cannot leave the screen', () => {
    const host = appRule('.fx-toasts'), toast = appRule('.fx-toast'), text = appRule('.fx-toast__text');
    assert.match(host, /position:\s*fixed;\s*left:\s*0;\s*right:\s*0/, 'the host spans the screen');
    assert.match(host, /padding:\s*0 var\(--fx-gutter\)/, 'and keeps the gutter');
    assert.doesNotMatch(toast + text, /white-space:\s*nowrap/, 'nowrap runs a long message off-screen');
    assert.match(toast, /width:\s*100%;\s*max-width:\s*var\(--fx-shell-max\)/);
    assert.match(text, /flex:\s*1;\s*min-width:\s*0/, 'the text may shrink and wrap');
    for (const gone of ['artisan-app/css/dashboard.css', 'artisan-app/css/onboarding.css'])
        assert.ok(!fs.existsSync(path.join(__dirname, '..', gone)), `${gone} is gone`);
});

t('the shared toast (toast.js) is untouched: it already wraps inside its gutter', () => {
    const js = read('shared/js/components/toast.js');
    assert.match(js, /width: min\(92vw, 400px\);/);
});

console.log('\n── UI-010 · trades named by serviceLabel; stars filled to the rating ──\n');

// Phase 4: reviews are drawn by artisan-app/js/reputationScreen.js (reviews.html forwards there).
t('reviews: the stars fill each star to the rating\'s fraction and read out the number', () => {
    const dom = read('shared/js/domain/artisanReputation.js');
    const screen = read('artisan-app/js/reputationScreen.js');
    const fillsSrc = /export function starFills\(rating\) \{[\s\S]*?\n\}/.exec(dom);
    const starSrc  = /const STAR = '[^\n]*';/.exec(screen);
    const htmlSrc  = /export function starsHtml\(rating\) \{[\s\S]*?\n\}/.exec(screen);
    assert.ok(fillsSrc && starSrc && htmlSrc, 'starFills(), STAR, starsHtml()');
    // eslint-disable-next-line no-new-func
    const stars = new Function(`${fillsSrc[0].replace('export ', '')}\n${starSrc[0]}\n${htmlSrc[0].replace('export ', '')}\nreturn starsHtml;`)();
    const fills = (r) => [...stars(r).matchAll(/fx-rep__star-fill" style="width:(\d+)%"/g)].map((m) => Number(m[1]));
    assert.deepStrictEqual(fills(4.4), [100, 100, 100, 100, 40]);
    assert.deepStrictEqual(fills(4.5), [100, 100, 100, 100, 50]);
    assert.deepStrictEqual(fills(5),   [100, 100, 100, 100, 100]);
    assert.deepStrictEqual(fills(0),   [0, 0, 0, 0, 0]);
    assert.deepStrictEqual(fills(7),   [100, 100, 100, 100, 100], 'clamped');
    assert.match(stars(4.4), /role="img" aria-label="4\.4 out of 5 stars"/);
    assert.doesNotMatch(screen, /Math\.round\(rating\)/, 'no rounded stars');
});

t('reviews and profile name the trade with serviceLabel', () => {
    const reviews = read('artisan-app/js/reputationScreen.js');
    assert.match(reviews, /import \{ serviceLabel \} from '\.\.\/\.\.\/shared\/js\/domain\/bookingTruth\.js';/);
    assert.match(reviews, /const who = \[v\.customer, serviceLabel\(v\.service\)\]\.filter\(Boolean\)\.join\(' · '\) \|\| 'Customer';/);
    const profile = read('artisan-app/profile.html');
    // Profile also imports resolveRating from the same module (Phase 0 IX-02).
    assert.match(profile, /import \{ serviceLabel(?:, \w+)* \}\s+from '\.\.\/shared\/js\/domain\/bookingTruth\.js';/);
    assert.match(profile, /const trade = serviceLabel\(d\.category\) \|\| '', spec = serviceLabel\(d\.specialty\) \|\| '';/);
});

t('serviceLabel: stored ids become labels, typed text is kept', () => {
    const src = read('shared/js/domain/bookingTruth.js');
    const block = src.slice(src.indexOf('function text(v)'), src.indexOf('const norm ='))
        .replace(/^export /gm, '');
    // eslint-disable-next-line no-new-func
    const serviceLabel = new Function(`${block}\nreturn serviceLabel;`)();
    assert.strictEqual(serviceLabel('plumbing'), 'Plumbing');
    assert.strictEqual(serviceLabel('ac-repair'), 'AC Repair');
    assert.strictEqual(serviceLabel('ac'), 'AC Repair');
    assert.strictEqual(serviceLabel('Borehole pump repair'), 'Borehole pump repair');
    assert.strictEqual(serviceLabel(''), null);
});

console.log('\n── NOTIF-005 · lapsed offer alerts; a delete control a finger can reach ──\n');

t('an offer alert past its deadline is drawn lapsed with the shared label', () => {
    const html = read('artisan-app/notifications.html');
    assert.match(html, /import \{ offerState, LAPSED_OFFER_LABEL \}\s+from '\.\.\/shared\/js\/domain\/jobOffers\.js';/);
    assert.match(html, /const lapsed = n\.expiresAtMs != null && offerState\(\{ expiresAtMs: n\.expiresAtMs \}\)\.expired;/);
    assert.match(html, /\$\{lapsed \? `<span class="notif-lapsed">\$\{LAPSED_OFFER_LABEL\}<\/span>` : ''\}/);
    // The deadline reaches the row: cacheable() keeps metadata.expiresAtMs, as a number.
    assert.match(html, /expiresAtMs: offerState\(\{ expiresAtMs: n\.metadata\?\.expiresAtMs \}\)\.expiresAtMs,/);
});

t('one lapse timer, re-armed per render and cleared on pagehide', () => {
    const html = read('artisan-app/notifications.html');
    assert.match(html, /listEl\.innerHTML = html;\s*scheduleLapse\(notifications\);/);
    assert.match(html, /function scheduleLapse\(notifications\) \{\s*clearTimeout\(_lapseTimer\); _lapseTimer = null;/);
    assert.match(html, /addEventListener\('pagehide', \(\) => \{ _unsub\?\.\(\); clearTimeout\(_lapseTimer\); \}\);/);
});

t('delete: a 44px target, always shown where there is no hover, focusable by keyboard', () => {
    // Phase 5: Notifications is on the design system. The delete control is the
    // system's icon button (a 44 px target, --fx-hit) and is ALWAYS shown — not
    // revealed on hover — so touch, keyboard and pointer users all find it. Its
    // name says which notification it deletes. Measured in tests/e2e/artisan_account.py.
    const html = read('artisan-app/notifications.html');
    assert.match(html, /<button class="fx-iconbtn notif-delete-btn" type="button" data-delete="\$\{escHtml\(n\.id\)\}" aria-label="Delete: \$\{escHtml\(n\.title\)\}">/);
    const css = read('artisan-app/css/app.css');
    assert.match(/\.fx-iconbtn \{([^}]*)\}/.exec(css)[1], /width: var\(--fx-hit\); height: var\(--fx-hit\);|min-width: var\(--fx-hit\)/);
    const own = read('artisan-app/css/fx/notifications.css');
    assert.doesNotMatch(own, /notif-delete-btn[^{]*\{[^}]*(display: none|opacity: 0)/, 'never hidden until hover');
});

console.log('\n── NET-001 · notifications offline with nothing cached ──\n');

t('a failed first load says it could not load (with Try again), never "No notifications yet"', () => {
    // Phase 5: on the design system, shown and hidden with the hidden attribute.
    const html = read('artisan-app/notifications.html');
    assert.match(html, /<div class="fx-ntf__state" id="notif-error" role="alert" hidden>\s*<p class="fx-ntf__state-title">Couldn't load your notifications<\/p>[\s\S]*?id="notif-retry">Try again<\/button>/);
    assert.match(html, /getElementById\('notif-retry'\)\.addEventListener\('click', \(\) => location\.reload\(\)\);/);
    const onErr = /onError: \(_err, \{ hasContent \}\) => \{([\s\S]*?)\n  \},/.exec(html)[1];
    assert.match(onErr, /if \(hasContent\) return;/, 'cached content is kept');
    assert.match(onErr, /emptyEl\.hidden   = true;/);
    assert.match(onErr, /errorEl\.hidden   = false;/);
    assert.match(html, /function render\(notifications\) \{\s*loadingEl\.hidden = true;\s*errorEl\.hidden = true;/,
        'a list that arrives later clears the error');
});

console.log(`\nartisan-polish: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
