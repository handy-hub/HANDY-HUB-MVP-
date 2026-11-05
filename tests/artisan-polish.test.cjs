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

console.log('\n── IA-004 · performance: period figures apart from lifetime figures ──\n');

t('two labelled groups: the selected period, then lifetime', () => {
    const html = read('artisan-app/performance.html');
    const content = html.slice(html.indexOf('id="pf-content"'));
    const period = content.indexOf('id="pf-period-label"');
    const grid   = content.indexOf('id="pf-score-grid"');
    const life   = content.indexOf('<p class="pf-group-label">Lifetime</p>');
    const lgrid  = content.indexOf('id="pf-lifetime-grid"');
    assert.ok(period > 0 && period < grid && grid < life && life < lgrid, 'label, period grid, lifetime label, lifetime grid');
});

t('period tiles follow the period; lifetime tiles never do', () => {
    const html = read('artisan-app/performance.html');
    const periodTiles = /getElementById\('pf-score-grid'\)\.innerHTML = \[([\s\S]*?)\]\.map\(card\)/.exec(html)[1];
    const lifeTiles   = /getElementById\('pf-lifetime-grid'\)\.innerHTML = \[([\s\S]*?)\]\.map\(card\)/.exec(html)[1];
    assert.deepStrictEqual([...periodTiles.matchAll(/label:'([^']+)'/g)].map((m) => m[1]), ['Jobs Done', 'Avg Rating']);
    assert.deepStrictEqual([...lifeTiles.matchAll(/label:'([^']+)'/g)].map((m) => m[1]), ['Earned', 'Total Jobs']);
    assert.match(periodTiles, /value:jobs,/);
    assert.match(periodTiles, /periodRating/);
    assert.match(lifeTiles, /value:earned,/);
    assert.match(lifeTiles, /value:allJobs,/);
    assert.match(html, /getElementById\('pf-period-label'\)\.textContent = PERIOD_LABEL\[_period\]/);
    assert.match(html, /const PERIOD_LABEL = \{ week: 'This week', month: 'This month', year: 'This year', all: 'All time' \};/);
});

console.log('\n── UI-006 · the artisan toast stays on screen ──\n');

/** The declarations of the `.toast {` rule in a stylesheet. */
function toastRule(file) {
    const css = read(file);
    const at = css.search(/^\.toast \{/m);
    assert.ok(at >= 0, `${file}: no .toast rule`);
    return css.slice(at, css.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '');
}

for (const file of ['artisan-app/css/dashboard.css', 'artisan-app/css/onboarding.css']) {
    t(`${file}: one line when it fits, wraps within a 16px gutter, never nowrap`, () => {
        const rule = toastRule(file);
        assert.doesNotMatch(rule, /white-space:\s*nowrap/, 'nowrap runs a long message off-screen');
        assert.match(rule, /width:\s*max-content/);
        assert.match(rule, /max-width:\s*calc\(100vw - 32px\)/);
        assert.match(rule, /box-sizing:\s*border-box/, 'the padding stays inside the cap');
        assert.match(rule, /text-align:\s*center/);
    });
}

t('the shared toast (toast.js) is untouched: it already wraps inside its gutter', () => {
    const js = read('shared/js/components/toast.js');
    assert.match(js, /width: min\(92vw, 400px\);/);
});

console.log('\n── UI-010 · trades named by serviceLabel; stars filled to the rating ──\n');

t('reviews: stars() fills each star to the rating\'s fraction and reads out the number', () => {
    const html = read('artisan-app/reviews.html');
    const src = /function stars\(rating, size = 14\) \{[\s\S]*?\n\}/.exec(html);
    assert.ok(src, 'stars()');
    // eslint-disable-next-line no-new-func
    const stars = new Function(`${src[0]}\nreturn stars;`)();
    const fills = (r) => [...stars(r).matchAll(/rv-star-fill" style="width:(\d+)%"/g)].map((m) => Number(m[1]));
    assert.deepStrictEqual(fills(4.4), [100, 100, 100, 100, 40]);
    assert.deepStrictEqual(fills(4.5), [100, 100, 100, 100, 50]);
    assert.deepStrictEqual(fills(5),   [100, 100, 100, 100, 100]);
    assert.deepStrictEqual(fills(0),   [0, 0, 0, 0, 0]);
    assert.deepStrictEqual(fills(7),   [100, 100, 100, 100, 100], 'clamped');
    assert.match(stars(4.4), /role="img" aria-label="4\.4 out of 5 stars"/);
    assert.doesNotMatch(html, /Math\.round\(rating\)/, 'the rounded stars are gone');
});

t('reviews and profile name the trade with serviceLabel', () => {
    const reviews = read('artisan-app/reviews.html');
    assert.match(reviews, /import \{ serviceLabel \}\s+from '\.\.\/shared\/js\/domain\/bookingTruth\.js';/);
    assert.match(reviews, /esc\(serviceLabel\(d\.serviceType \|\| d\.service\) \|\| 'Service'\)/);
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
    const html = read('artisan-app/notifications.html');
    const rule = /\.notif-delete-btn \{([^}]*)\}/.exec(html)[1];
    assert.match(rule, /width: 44px; height: 44px;/);
    assert.doesNotMatch(rule, /display: none/, 'display:none takes it out of the tab order');
    assert.match(html, /@media \(hover: none\) \{\s*\.notif-delete-btn \{ opacity: 1; \}/);
    assert.match(html, /\.notif-item:hover \.notif-delete-btn, \.notif-delete-btn:focus-visible \{ opacity: 1; \}/);
});

console.log('\n── NET-001 · notifications offline with nothing cached ──\n');

t('a failed first load says it could not load (with Try again), never "No notifications yet"', () => {
    const html = read('artisan-app/notifications.html');
    assert.match(html, /<div class="notif-empty" id="notif-error" role="alert" style="display:none;">\s*<p class="notif-empty-title">Couldn't load your notifications<\/p>[\s\S]*?onclick="location\.reload\(\)">Try again<\/button>/);
    const onErr = /onError: \(_err, \{ hasContent \}\) => \{([\s\S]*?)\n  \},/.exec(html)[1];
    assert.match(onErr, /if \(hasContent\) return;/, 'cached content is kept');
    assert.match(onErr, /emptyEl\.style\.display   = 'none';/);
    assert.match(onErr, /getElementById\('notif-error'\)\.style\.display = 'block';/);
    assert.match(html, /function render\(notifications\) \{\s*loadingEl\.style\.display = 'none';\s*document\.getElementById\('notif-error'\)\.style\.display = 'none';/,
        'a list that arrives later clears the error');
});

console.log(`\nartisan-polish: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
