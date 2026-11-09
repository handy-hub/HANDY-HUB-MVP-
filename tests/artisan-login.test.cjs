'use strict';
/**
 * tests/artisan-login.test.cjs — artisan sign-in screen findings from the
 * 28 Oct audit, run against the screen's own code.
 *
 *   AUTH-002  "Forgot password?" said "No account with that email", which told
 *             anyone whether an address belongs to a registered artisan.
 *   NAV-003   The back chevron always opened sign-up.
 *   AUTH-004  Messages stacked and contradicted each other; an empty password
 *             read "Incorrect email or password".
 *
 * Since Phase 5 the sign-in screen decides and words everything through
 * artisan-app/js/entry.js; these run that module and check the page's wiring.
 * The rendered behaviour is checked in tests/e2e/artisan_entry.py.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'artisan-app', 'login.html'), 'utf8').replace(/\r\n/g, '\n');
const script = /<script type="module">([\s\S]*?)<\/script>/.exec(page)[1];

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}
const fbErr = (code) => Object.assign(new Error(`Firebase: Error (${code}).`), { code });
/** The body of the handler registered with $(id).addEventListener(event, …). */
const handlerOf = (id, ev) => {
    const at = script.indexOf(`$('${id}').addEventListener('${ev}'`);
    assert.ok(at >= 0, `${id} ${ev} handler`);
    return script.slice(at, script.indexOf('\n});', at));
};

(async () => {
const E = await import(pathToFileURL(path.join(ROOT, 'artisan-app', 'js', 'entry.js')).href);

console.log('\n── AUTH-002 · password reset does not reveal who is registered ──\n');

await t('a registered and an unregistered email get exactly the same answer', () => {
    const known   = E.resetOutcome(null, 'kwame@example.com');
    const unknown = E.resetOutcome(fbErr('auth/user-not-found'), 'kwame@example.com');
    assert.deepStrictEqual(unknown, known, 'the same answer, account or not');
    assert.strictEqual(known.error, undefined);
    assert.match(known.success, /^If a Fidus X professional account uses kwame@example\.com, a reset link is on its way/);
    // The page shows exactly what the outcome says, and calls the shared auth service.
    const reset = handlerOf('reset-form', 'submit');
    assert.match(reset, /try \{ await authService\.sendPasswordResetEmail\(email\); outcome = resetOutcome\(null, email\); \}/);
    assert.match(reset, /catch \(err\) \{ outcome = resetOutcome\(err, email\); \}/);
});
await t('the screen never says an account does not exist, and a wrong password reads like an unknown email', () => {
    assert.ok(!/No account with that email|not registered|does not exist/i.test(page));
    const wrong = E.signInError(fbErr('auth/wrong-password'));
    for (const c of ['auth/user-not-found', 'auth/invalid-credential', 'auth/invalid-login-credentials']) {
        assert.strictEqual(E.signInError(fbErr(c)), wrong, c);
    }
});
await t('faults the user can act on are still reported, without Firebase internals', () => {
    assert.match(E.resetOutcome(fbErr('auth/invalid-email'), 'a@b').error, /valid email/);
    assert.match(E.resetOutcome(fbErr('auth/too-many-requests'), 'a@b.co').error, /Too many attempts/);
    assert.match(E.resetOutcome(fbErr('auth/network-request-failed'), 'a@b.co').error, /No connection/);
    const other = E.resetOutcome(fbErr('auth/internal-error'), 'a@b.co');
    assert.match(other.error, /could not send/i);
    for (const e of [other.error, E.resetOutcome(fbErr('auth/invalid-email'), 'x').error]) assert.ok(!/auth\/|Firebase/.test(e), e);
});

console.log('\n── NAV-003 · the back chevron is a real back ──\n');

await t('it goes back, never to sign-up, and is hidden until there is somewhere to go', () => {
    const tag = page.slice(page.indexOf('<button class="fx-iconbtn" type="button" id="entry-back"'), page.indexOf('</button>', page.indexOf('id="entry-back"')));
    assert.match(tag, /aria-label="Back"/);
    assert.match(tag, / hidden>/, 'hidden by default');
    assert.ok(!/signup\.html/.test(tag), 'never opens sign-up');
    assert.match(script, /if \(backAllowed\(\{ referrer: document\.referrer, origin: location\.origin, historyLength: history\.length \}\)\) \{\s*\$\('entry-back'\)\.hidden = false;\s*\$\('entry-back'\)\.addEventListener\('click', \(\) => history\.back\(\)\);/);
});
await t('shown after a page of this site; hidden for a fresh tab, no referrer, or another site', () => {
    const o = 'https://artisan.fidusx.app';
    assert.strictEqual(E.backAllowed({ referrer: `${o}/artisan-app/signup.html`, origin: o, historyLength: 2 }), true);
    assert.strictEqual(E.backAllowed({ referrer: '', origin: o, historyLength: 2 }), false);
    assert.strictEqual(E.backAllowed({ referrer: 'https://evil.example/x', origin: o, historyLength: 2 }), false);
    assert.strictEqual(E.backAllowed({ referrer: `${o}/x`, origin: o, historyLength: 1 }), false);
    assert.strictEqual(E.backAllowed({ referrer: 'not a url', origin: o, historyLength: 3 }), false);
});

console.log('\n── AUTH-004 · one message at a time, and the right one ──\n');

await t('a message replaces the one before it — never two at once', () => {
    const setNotice = script.slice(script.indexOf('function setNotice('), script.indexOf('function fieldError('));
    assert.match(setNotice, /const host = \$\(`\$\{view\}-notices`\);\s*host\.innerHTML = '';\s*if \(!text\) return;/);
    assert.strictEqual((setNotice.match(/host\.appendChild\(el\)/g) || []).length, 1);
});
await t('an empty password says "Enter your password", not "Incorrect email or password"', () => {
    assert.match(page, /<p class="fx-field__error" id="si-pw-err" hidden>Enter your password\.<\/p>/);
    const submit = handlerOf('signin-form', 'submit');
    assert.match(submit, /if \(!pw\)\s+\{ fieldError\(\$\('si-password'\), 'si-pw-err', true\); ok = false; \}/);
    assert.match(submit, /if \(!ok\) \{[^}]*return; \}/, 'nothing is sent when a field is missing');
});
await t('every action clears earlier messages first, and no message is Firebase\'s own text', () => {
    for (const [id, ev] of [['signin-form', 'submit'], ['si-google', 'click'], ['reset-form', 'submit']]) {
        const body = handlerOf(id, ev);
        assert.match(body, /setNotice\('(signin|reset)', null, ''\);/, `${id} clears first`);
    }
    assert.doesNotMatch(script, /err\.message|e\.message/, 'never shows an error\'s own message');
    assert.strictEqual(E.googleError(fbErr('auth/popup-closed-by-user')), null, 'closing the window says nothing');
    for (const c of ['auth/popup-blocked', 'auth/network-request-failed', 'auth/internal-error']) {
        assert.ok(!/Firebase: Error/.test(E.googleError(fbErr(c))), c);
    }
});

console.log(`\nartisan-login: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
