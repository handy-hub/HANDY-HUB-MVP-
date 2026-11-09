'use strict';
/**
 * tests/artisan-signup-page.test.cjs — artisan sign-up screen findings from the
 * 28 Oct audit, run against the page itself.
 *
 *   UI-007  A disabled "More options coming soon" button sat beside Google.
 *   IA-005  (part) A signed-in artisan could land on sign-up and start again.
 *   FORM-003  Sign-up validated late, through native alert() boxes.
 *
 * Since Phase 5 the form's checks are artisan-app/js/entry.js signupProblems;
 * here they are held against the SERVER's own (functions/emailOtp.js, run on
 * the in-memory Firestore): the form refuses exactly what the server refuses.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { pathToFileURL } = require('url');

const fake = require('./support/fake-firebase.cjs').install();
const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'artisan-app', 'signup.html'), 'utf8').replace(/\r\n/g, '\n');
const otp  = require(path.join(ROOT, 'functions', 'emailOtp.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

(async () => {
const E = await import(pathToFileURL(path.join(ROOT, 'artisan-app', 'js', 'entry.js')).href);

console.log('\n── UI-007 · no placeholder controls ──\n');

await t('the disabled "More" button is gone; Google is the one other way in, and it works', () => {
    assert.ok(!/More options coming soon/.test(page));
    const buttons = [...page.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    const social = buttons.filter((b) => /google/i.test(b));
    assert.strictEqual(social.length, 1);
    assert.match(social[0], /id="su-google"/);
    assert.ok(!/\bdisabled\b/.test(social[0]));
    assert.match(page, /\$\('su-google'\)\.addEventListener\('click', async \(\) => \{/);
});

console.log('\n── IA-005 · a signed-in visitor is sent to the router, not shown sign-up ──\n');

/** Run the page's own "already signed in" block with a stub auth service. */
function signedInBlock({ submitting = false, google = false } = {}) {
    const start = page.indexOf('/* ── Already signed in (audit IA-005)');
    const open  = page.indexOf('{\n', page.indexOf('*/', start));
    const src   = page.slice(open, page.indexOf('</script>', open));
    let cb = null; const went = [];
    const authService = { subscribeToAuthState: (f) => { cb = f; return () => {}; } };
    // eslint-disable-next-line no-new-func
    new Function('authService', '_submitting', '_google', 'window', src)(
        authService, submitting, google, { location: { replace: (u) => went.push(u) } });
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
    const g = signedInBlock({ google: true }); g.answer({ uid: 'a1' });
    assert.deepStrictEqual(f.went, []);
    assert.deepStrictEqual(g.went, []);
});
await t('only the first auth answer counts', () => {
    const b = signedInBlock(); b.answer(null); b.answer({ uid: 'a1' });
    assert.deepStrictEqual(b.went, [], 'signing in later on this page is the page\'s own flow');
});

console.log('\n── FORM-003 · sign-up says what is wrong, in the page ──\n');

await t('an untouched form says nothing; a field speaks once it was left, or the form was sent', () => {
    assert.ok(Object.keys(E.signupProblems({})).length > 0, 'an empty form has problems…');
    assert.match(page, /const msg = \(_sent \|\| touched\.has\(key\)\) \? \(problems\[key\] \|\| ''\) : '';/, '…shown only once touched or sent');
    assert.match(page, /el\.addEventListener\(el\.type === 'checkbox' \|\| el\.tagName === 'SELECT' \? 'change' : 'blur', \(\) => \{ touched\.add\(key\); showProblems\(\); \}\);/);
});
await t('a wrong field says why and is marked invalid; fixed, the reason clears', () => {
    const base = { name: 'Kwame Mensah', email: 'kwame', trade: 'Plumbing', password: 'longenough1', terms: true };
    assert.deepStrictEqual(E.signupProblems(base), { email: 'Enter a valid email address.' });
    assert.deepStrictEqual(E.signupProblems({ ...base, email: 'kwame@example.com' }), {});
    assert.match(page, /\$\(id\)\.setAttribute\('aria-invalid', msg \? 'true' : 'false'\);\s*\$\(`\$\{id\}-err`\)\.textContent = msg;\s*\$\(`\$\{id\}-err`\)\.hidden = !msg;/);
    // Every field has its own error line, tied to the field for screen readers.
    for (const id of ['su-name', 'su-email', 'su-phone', 'su-trade', 'su-other-desc', 'su-other-bucket', 'su-password', 'su-terms']) {
        assert.match(page, new RegExp(`id="${id}"[^>]*aria-describedby="[^"]*${id}-err`), id);
        assert.match(page, new RegExp(`<p class="fx-field__error" id="${id}-err" hidden></p>`), `${id}-err`);
    }
});
await t('the form refuses exactly what the server refuses (functions/emailOtp.js), besides the terms box', async () => {
    const names = ['', 'K', 'Kwame Mensah'], emails = ['kwame', 'kwame@example.com'],
          phones = ['', '0241234567', '+233 24 123 4567', '12345'], pws = ['short', 'longenough1'];
    const trades = [['Plumbing'], ['AC Repair'], ['Tiling'], [''], ['Other', 'Solar inverter installation', 'Electrical'], ['Other', '', 'Electrical'], ['Other', 'Roof repair', 'Roofing']];
    let n = 0;
    for (const name of names) for (const email of emails) for (const phone of phones) for (const password of pws) for (const [trade, otherDesc, otherBucket] of trades) {
        const v = { name, email, phone, trade, otherDesc, otherBucket, password, terms: true };
        const clientOk = Object.keys(E.signupProblems(v)).length === 0;
        fake.db._reset(); fake.auth.reset();
        const quiet = console.log; console.log = () => {};
        let serverOk = true;
        // What the server is asked to accept: the typed phone, normalised as the
        // form would send it (+233 24… → 23324…), or as typed when it is not one.
        const payload = { ...E.signupPayload(v), phone: E.normalisePhone(v.phone) || String(v.phone).trim() };
        try { await otp.signUpArtisanDirect({ payload }); }
        catch (e) { serverOk = false; if (e.code !== 'invalid-argument') throw e; }
        finally { console.log = quiet; }
        assert.strictEqual(clientOk, serverOk, JSON.stringify(v));
        n++;
    }
    assert.ok(n > 300, `${n} combinations`);
    assert.ok(Object.keys(E.signupProblems({ name: 'Kwame Mensah', email: 'k@x.co', trade: 'Plumbing', password: 'longenough1', terms: false })).includes('terms'));
});
await t('sign-up and Google errors are shown in the page, never alert() and never Firebase\'s own text', () => {
    const code = page.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.ok(!/(^|[^.\w])alert\(/m.test(code), 'an alert() is still called');
    assert.match(page, /<div class="fx-entry__notices fx-stack" id="signup-notices"><\/div>/);
    assert.match(code, /el\.setAttribute\('role', tone === 'bad' \? 'alert' : 'status'\);/);
    assert.doesNotMatch(code, /err\.message|e\.message/);
    assert.strictEqual(E.signUpError({ code: 'functions/already-exists', message: 'x' }),
        'This email already has a Fidus X account. Sign in instead — if you used Google, choose Continue with Google.');
    assert.strictEqual(E.signUpError({ code: 'functions/invalid-argument', message: 'Invalid Ghana phone number.' }), 'Invalid Ghana phone number.');
    assert.ok(!/Firebase/.test(E.signUpError({ code: 'functions/internal', message: 'Firebase: Error (functions/internal).' })));
});

console.log(`\nartisan-signup-page: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
