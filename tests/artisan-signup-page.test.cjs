'use strict';
/**
 * tests/artisan-signup-page.test.cjs — artisan sign-up screen findings from the
 * 28 Oct audit, run against the page itself.
 *
 *   UI-007  A disabled "More options coming soon" button sat beside Google.
 *   IA-005  (part) A signed-in artisan could land on sign-up and start again.
 *   FORM-003  Sign-up validated late, through native alert() boxes.
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

console.log('\n── FORM-003 · sign-up says what is missing, in the page ──\n');

/** The page's own validation block over stub inputs. */
function signupForm(values = {}) {
    const mk = (id, extra = {}) => ({
        id, value: '', checked: false, attrs: {}, listeners: {},
        setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        fire(type) { (this.listeners[type] || []).forEach((fn) => fn()); }, ...extra,
    });
    const els = {
        'as-name': mk('as-name'), 'as-email': mk('as-email'), 'as-category': mk('as-category'),
        'as-pass': mk('as-pass'), 'as-terms': mk('as-terms'), 'as-other-desc': mk('as-other-desc'),
        'as-other-bucket': mk('as-other-bucket'),
        'as-form-msg': { textContent: '' }, 'as-form-err': { textContent: '' },
    };
    Object.assign(els['as-name'], { value: values.name ?? '' });
    Object.assign(els['as-email'], { value: values.email ?? '' });
    Object.assign(els['as-category'], { value: values.category ?? '' });
    Object.assign(els['as-pass'], { value: values.password ?? '' });
    Object.assign(els['as-terms'], { checked: !!values.terms });
    const submitBtn = { disabled: true };
    const start = page.indexOf('/* ── What is still missing (audit FORM-003)');
    const end   = page.indexOf('[nameInp, emailInp, pwInput, termsChk].forEach(el => {');
    // eslint-disable-next-line no-new-func
    const api = new Function('document', 'submitBtn', 'pwInput', 'termsChk', 'nameInp', 'emailInp', 'catInp',
        `${page.slice(start, end)}; return { checkReady, signupProblems, showFormError };`)(
        { getElementById: (id) => els[id] }, submitBtn, els['as-pass'], els['as-terms'], els['as-name'], els['as-email'], els['as-category']);
    return { ...api, els, submitBtn };
}

await t('an untouched form says nothing, though Create Account is off', () => {
    const f = signupForm(); f.checkReady();
    assert.strictEqual(f.submitBtn.disabled, true);
    assert.strictEqual(f.els['as-form-msg'].textContent, '');
});
await t('a touched field that is wrong says why, and is marked invalid', () => {
    const f = signupForm({ name: 'Kwame', email: 'kwame' });
    f.els['as-email'].fire('blur');
    assert.strictEqual(f.els['as-form-msg'].textContent, 'Enter a valid email address.');
    assert.strictEqual(f.els['as-email'].attrs['aria-invalid'], 'true');
    f.els['as-email'].value = 'kwame@example.com';
    f.checkReady();
    assert.strictEqual(f.els['as-form-msg'].textContent, '', 'fixed → the reason clears (other problems are untouched)');
    assert.ok(!('aria-invalid' in f.els['as-email'].attrs));
});
await t('the rules themselves are unchanged: same "ready" verdict as before', () => {
    const oldReady = (v) => v.name.trim().length > 0 && v.email.includes('@') && v.category !== '' && v.password.length >= 8 && v.terms;
    const names = ['', 'Kwame'], emails = ['', 'k', 'k@x.co'], cats = ['', 'plumbing'], pws = ['', 'short', 'longenough1'], terms = [false, true];
    for (const name of names) for (const email of emails) for (const category of cats) for (const password of pws) for (const term of terms) {
        const v = { name, email, category, password, terms: term };
        const f = signupForm(v); f.checkReady();
        assert.strictEqual(!f.submitBtn.disabled, oldReady(v), JSON.stringify(v));
    }
});
await t('sign-up and Google errors are shown in the page, never alert()', () => {
    const code = page.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.ok(!/(^|[^.\w])alert\(/m.test(code), 'an alert() is still called');
    assert.match(page, /<p id="as-form-err" class="as-form-err" role="alert"><\/p>/);
    assert.match(page, /<p id="as-form-msg" class="as-form-msg" role="status" aria-live="polite"><\/p>/);
    const f = signupForm(); f.showFormError('That email is already registered. Try signing in instead.');
    assert.strictEqual(f.els['as-form-err'].textContent, 'That email is already registered. Try signing in instead.');
});

console.log(`\nartisan-signup-page: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
