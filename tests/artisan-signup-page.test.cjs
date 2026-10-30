'use strict';
/**
 * tests/artisan-signup-page.test.cjs — artisan sign-up screen findings from the
 * 28 Oct audit, run against the page itself.
 *
 *   UI-007  A disabled "More options coming soon" button sat beside Google.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const page = fs.readFileSync(path.join(__dirname, '..', 'artisan-app', 'signup.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

(async () => {
console.log('\n── UI-007 · no placeholder controls ──\n');

await t('the disabled "More" button is gone; Google is the one social option', () => {
    assert.ok(!/More options coming soon/.test(page));
    const row = page.slice(page.indexOf('<div class="as-social-row'), page.indexOf('</div>', page.indexOf('<div class="as-social-row')));
    assert.strictEqual((row.match(/<button/g) || []).length, 1);
    assert.match(row, /id="as-google-btn"/);
    assert.ok(!/\bdisabled\b/.test(row));
});

console.log(`\nartisan-signup-page: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
