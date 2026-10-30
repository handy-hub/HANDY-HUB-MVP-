'use strict';
/**
 * tests/artisan-dashboard-page.test.cjs — artisan dashboard findings from the
 * 28 Oct audit, checked against the page itself.
 *
 *   FUNC-001  The "This Week" selector under Your Performance did nothing.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const page = read('artisan-app/dashboard.html');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

/** The header link of a dashboard section, by its title. */
function sectionLink(title) {
    const at = page.indexOf(`<span class="section-title">${title}</span>`);
    assert.ok(at > -1, `section "${title}" not found`);
    const end = page.indexOf('</div>', at);
    const m = page.slice(at, end).match(/<a href="([^"]+)" class="view-all-link">\s*([^<]+?)\s*</);
    return m ? { href: m[1], text: m[2] } : null;
}

(async () => {
console.log('\n── FUNC-001 · no dead controls under Your Performance ──\n');

await t('the dead "This Week" selector is gone; a link goes to Performance', () => {
    assert.ok(!/id="perf-period-btn"/.test(page));
    assert.ok(!/>\s*This Week\s*</.test(page));
    assert.deepStrictEqual(sectionLink('Your Performance'), { href: 'performance.html', text: 'See Performance' });
    assert.ok(fs.existsSync(path.join(ROOT, 'artisan-app', 'performance.html')));
});

console.log(`\nartisan-dashboard-page: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
