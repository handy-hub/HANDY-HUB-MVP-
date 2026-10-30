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

console.log(`\nartisan-polish: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
