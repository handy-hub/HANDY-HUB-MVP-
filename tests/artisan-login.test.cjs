'use strict';
/**
 * tests/artisan-login.test.cjs — artisan sign-in screen findings from the
 * 28 Oct audit, run against the page's own code.
 *
 *   AUTH-002  "Forgot password?" said "No account with that email", which told
 *             anyone whether an address belongs to a registered artisan.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const page = fs.readFileSync(path.join(__dirname, '..', 'artisan-app', 'login.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

/** The page's sendPasswordReset, wired to a stub Firebase and banner sink. */
function loadReset(firebaseResult) {
    const src = page.slice(page.indexOf('const RESET_SENT'), page.indexOf('window.togglePw'));
    const shown = { error: null, success: null, cleared: 0 };
    const win = {};
    const doc = { getElementById: () => ({ value: win.email || '' }) };
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'auth', 'sendPasswordResetEmail', 'clearBanners', 'showError', 'showSuccess', src)(
        win, doc, {},
        async () => { if (firebaseResult instanceof Error) throw firebaseResult; },
        () => { shown.cleared++; shown.error = null; shown.success = null; },
        (m) => { shown.error = m; },
        (m) => { shown.success = m; },
    );
    return { run: async (email) => { win.email = email; await win.sendPasswordReset(); return shown; } };
}
const fbErr = (code) => Object.assign(new Error(code), { code });

(async () => {
console.log('\n── AUTH-002 · password reset does not reveal who is registered ──\n');

await t('a registered and an unregistered email get exactly the same answer', async () => {
    const known   = await loadReset(null).run('kwame@example.com');
    const unknown = await loadReset(fbErr('auth/user-not-found')).run('kwame@example.com');
    assert.strictEqual(known.error, null);
    assert.strictEqual(unknown.error, null, 'no error for an unknown email');
    assert.strictEqual(unknown.success, known.success);
    assert.match(known.success, /^If an artisan account uses kwame@example\.com, a reset link is on its way/);
});
await t('the page never says an account does not exist', () => {
    assert.ok(!/No account with that email/i.test(page));
});
await t('faults the user can act on are still reported, without Firebase internals', async () => {
    assert.match((await loadReset(fbErr('auth/invalid-email')).run('a@b')).error, /valid email/);
    assert.match((await loadReset(fbErr('auth/too-many-requests')).run('a@b.co')).error, /Too many attempts/);
    const other = await loadReset(fbErr('auth/network-request-failed')).run('a@b.co');
    assert.match(other.error, /could not send/i);
    assert.ok(!/auth\//.test(other.error));
});

console.log(`\nartisan-login: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
