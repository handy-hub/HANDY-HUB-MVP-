'use strict';
/**
 * tests/artisan-login.test.cjs — artisan sign-in screen findings from the
 * 28 Oct audit, run against the page's own code.
 *
 *   AUTH-002  "Forgot password?" said "No account with that email", which told
 *             anyone whether an address belongs to a registered artisan.
 *   NAV-003   The back chevron always opened sign-up.
 *   AUTH-004  Messages stacked and contradicted each other; an empty password
 *             read "Incorrect email or password".
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

console.log('\n── NAV-003 · the back chevron is a real back ──\n');

/** Run the page's inline back-button script for a given referrer. */
function backShown({ referrer, historyLength = 2, origin = 'https://artisan.fidusx.app' }) {
    const at = page.indexOf("<button id=\"login-back\"");
    const script = page.slice(page.indexOf('<script>', at) + 8, page.indexOf('</script>', at));
    const btn = { style: { display: 'none' } };
    // eslint-disable-next-line no-new-func
    new Function('document', 'location', 'history', 'URL', script)(
        { referrer, getElementById: () => btn }, { origin }, { length: historyLength }, URL);
    return btn.style.display === 'flex';
}

await t('it goes back, never to sign-up, and is hidden until there is somewhere to go', () => {
    const tag = page.slice(page.indexOf('<button id="login-back"'), page.indexOf('</button>', page.indexOf('<button id="login-back"')));
    assert.match(tag, /onclick="history\.back\(\)"/);
    assert.match(tag, /display:none;/);
    assert.match(tag, /aria-label="Back"/);
    assert.ok(!/signup\.html/.test(tag), 'no longer opens sign-up');
});
await t('shown after a page of this site; hidden for a fresh tab, no referrer, or another site', () => {
    assert.strictEqual(backShown({ referrer: 'https://artisan.fidusx.app/artisan-app/signup.html' }), true);
    assert.strictEqual(backShown({ referrer: '' }), false);
    assert.strictEqual(backShown({ referrer: 'https://evil.example/x' }), false);
    assert.strictEqual(backShown({ referrer: 'https://artisan.fidusx.app/x', historyLength: 1 }), false);
});

console.log('\n── AUTH-004 · one message at a time, and the right one ──\n');

/** The page's banner functions over a minimal DOM. */
function banners() {
    const el = (id) => ({ id, textContent: '', classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); } } });
    const dom = { 'error-banner': el('error-banner'), 'success-banner': el('success-banner'), 'offline-banner': el('offline-banner') };
    const src = page.slice(page.indexOf('function clearBanners()'), page.indexOf('</script>', page.indexOf('function clearBanners()')));
    // eslint-disable-next-line no-new-func
    const api = new Function('document', `${src}; return { clearBanners, showError, showSuccess };`)(
        { getElementById: (id) => dom[id], querySelectorAll: () => [] });
    const shown = (id) => dom[id].classList.contains('show');
    return { ...api, shown };
}

await t('an error replaces a success and a success replaces an error — never both', () => {
    const b = banners();
    b.showSuccess('sent');
    b.showError('failed');
    assert.strictEqual(b.shown('error-banner'), true);
    assert.strictEqual(b.shown('success-banner'), false);
    b.showSuccess('sent');
    assert.strictEqual(b.shown('error-banner'), false);
    assert.strictEqual(b.shown('success-banner'), true);
});
await t('an empty password says "Enter your password", not "Incorrect email or password"', () => {
    assert.match(page, /<p class="field-error" id="login-pw-err">Enter your password\.<\/p>/);
});
await t('every action clears earlier messages first, and Google errors carry no raw Firebase text', () => {
    for (const fn of ['window.handleLogin', 'window.handleGoogleLogin', 'window.sendPasswordReset']) {
        const body = page.slice(page.indexOf(`${fn} = async function() {`), page.indexOf('};', page.indexOf(`${fn} = async function() {`)));
        assert.match(body, /clearBanners\(\);/, `${fn} clears first`);
    }
    assert.ok(!/Google sign-in failed: '\+e\.message/.test(page));
});

console.log(`\nartisan-login: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
