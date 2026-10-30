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

console.log(`\nartisan-polish: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
