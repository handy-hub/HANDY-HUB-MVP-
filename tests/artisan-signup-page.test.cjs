'use strict';
/**
 * tests/artisan-signup-page.test.cjs — artisan sign-up screen findings from the
 * 28 Oct audit, run against the page itself.
 *
 *   UI-007  A disabled "More options coming soon" button sat beside Google.
 *   IA-005  (part) A signed-in artisan could land on sign-up and start again.
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

console.log('\n── IA-005 · a signed-in visitor is sent to the router, not shown sign-up ──\n');

/** Run the page's own "already signed in" block with a stub auth service. */
function signedInBlock({ submitting = false, googleBusy = false } = {}) {
    const start = page.indexOf('/* ── Already signed in (audit IA-005)');
    const open  = page.indexOf('{\n', page.indexOf('*/', start));
    const src   = page.slice(open, page.indexOf('</script>', open));
    let cb = null; const went = [];
    const authService = { subscribeToAuthState: (f) => { cb = f; return () => {}; } };
    // eslint-disable-next-line no-new-func
    new Function('getAppContainer', 'submitting', 'googleBtn', 'window', src)(
        () => ({ services: { authService } }), submitting, { disabled: googleBusy },
        { location: { replace: (u) => went.push(u) } });
    return { answer: (user) => cb(user), went };
}

await t('signed out: sign-up stays', () => {
    const b = signedInBlock(); b.answer(null);
    assert.deepStrictEqual(b.went, []);
});
await t('already signed in on arrival: sent to login.html, which routes every account type', () => {
    const b = signedInBlock(); b.answer({ uid: 'a1' });
    assert.deepStrictEqual(b.went, ['login.html']);
});
await t('never during a sign-up: the form or Google signs the user in mid-flow and routes itself', () => {
    const f = signedInBlock({ submitting: true }); f.answer({ uid: 'a1' });
    const g = signedInBlock({ googleBusy: true }); g.answer({ uid: 'a1' });
    assert.deepStrictEqual(f.went, []);
    assert.deepStrictEqual(g.went, []);
});
await t('only the first auth answer counts', () => {
    const b = signedInBlock(); b.answer(null); b.answer({ uid: 'a1' });
    assert.deepStrictEqual(b.went, [], 'signing in later on this page is the page\'s own flow');
});

console.log(`\nartisan-signup-page: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
