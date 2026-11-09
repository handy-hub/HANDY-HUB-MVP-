'use strict';
/**
 * tests/login-outage.test.cjs — LOGIN-001: an outage does not sign an artisan out.
 *
 * artisan-app/login.html, for a signed-in user, reads artisans/{uid} and, if
 * that read fails or finds nothing, asks the artisanAccount callable to
 * ensure a profile. Every failure of that call that was not a customer
 * account signed the user out — so with Firestore AND the callable
 * unreachable, a valid, signed-in artisan was signed out on the login page.
 *
 * The rule (FLOW-004): a network failure is never evidence about the account.
 * The session ends only on the server's own answer about the account — a
 * reason in HttpsError details (functions/artisanAccount.js accountError).
 * Role isolation is untouched: the server's 'customer_account' answer still
 * ends the session and sends the customer to the Customer app.
 *
 * Since Phase 5 the decision is artisan-app/js/entry.js routeEnsured (with the
 * refusal list in js/utils/artisanRoutes.js); the page only carries it out.
 * Here: the client's refusal list is exactly the server's ensure-path reasons;
 * the decision ends a session only on those; the page signs out in that branch
 * alone; the real callable (index.js wrapper, fake Firestore) refuses a customer
 * uid with the reason the client acts on. tests/e2e/login_outage.py replays the
 * outage in Chromium.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const fake = require('./support/fake-firebase.cjs').install();
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'lamax-4fd82';
const fns = require(path.join(ROOT, 'functions', 'index.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

const page = read('artisan-app/login.html');
const code = /<script type="module">([\s\S]*?)<\/script>/.exec(page)[1].replace(/^\s*\/\/.*$/gm, '');
const handler = code.slice(code.indexOf('authService.subscribeToAuthState(async (user) => {'));

/** The reasons ensureArtisanProfile can throw (the 'ensure' action). */
function serverEnsureReasons() {
    const src = read('functions/artisanAccount.js');
    const body = src.slice(src.indexOf('async function ensureArtisanProfile'), src.indexOf('\n}\n', src.indexOf('async function ensureArtisanProfile')));
    return [...body.matchAll(/accountError\('([a-z_]+)'/g)].map((m) => m[1]).sort();
}

async function callEnsure(auth) {
    try { return { ok: true, value: await fns.artisanAccount({ auth, data: { action: 'ensure' } }) }; }
    catch (e) { return { ok: false, code: e.code, message: e.message, details: e.details ?? null }; }
}

(async () => {
const routes = await import(pathToFileURL(path.join(ROOT, 'artisan-app', 'js', 'utils', 'artisanRoutes.js')).href);
const entry  = await import(pathToFileURL(path.join(ROOT, 'artisan-app', 'js', 'entry.js')).href);
const refusals = [...routes.ACCOUNT_REFUSALS];

console.log('\n── Only the server\'s answer about the account ends the session ──\n');

await t('the client\'s refusal list is exactly what the server\'s ensure path can say about an account', () => {
    const server = serverEnsureReasons();
    assert.deepStrictEqual(server, ['admin_account', 'customer_account', 'no_email', 'not_artisan', 'unauthenticated']);
    assert.deepStrictEqual([...refusals].sort(), server);
});

await t('the decision ends a session only on a listed reason — never on a failure with no reason', () => {
    for (const reason of refusals) {
        const step = entry.routeEnsured({ ok: false, reason, message: `refused: ${reason}` });
        assert.strictEqual(step.signOut, true, reason);
    }
    for (const acct of [{ ok: false }, { ok: false, reason: null, message: 'timeout' }, { ok: false, reason: 'something_new' }, null, undefined]) {
        const step = entry.routeEnsured(acct);
        assert.deepStrictEqual(step, { offline: true }, JSON.stringify(acct));
    }
    assert.deepStrictEqual(entry.routeEnsured({ ok: true, verificationStatus: 'approved' }), { go: 'dashboard.html' });
    assert.deepStrictEqual(entry.routeEnsured({ ok: true, verificationStatus: 'draft' }), { go: 'onboarding.html' });
});

await t('the page signs out in exactly one place: the decision\'s signOut branch', () => {
    assert.strictEqual((code.match(/signOut\(/g) || []).length, 1, 'one sign-out site on the page');
    const branch = handler.slice(handler.indexOf('if (step.signOut) {'), handler.indexOf('if (step.offline) {'));
    assert.match(branch, /await authService\.signOut\(\)/);
    const offline = handler.slice(handler.indexOf('if (step.offline) {'), handler.indexOf('location.replace(step.go);', handler.indexOf('if (step.offline) {')));
    assert.doesNotMatch(offline, /signOut/);
    assert.match(handler, /const step = routeEnsured\(await ensureArtisanAccount\(\)\);/);
});

await t('the offline state keeps the session and offers a retry, like the guard\'s', () => {
    assert.match(handler, /if \(step\.offline\) \{[\s\S]*?setNotice\('signin', 'warn', 'Can\\'t reach the server\. You\\'re still signed in — check your connection and try again\.',\s*\{ label: 'Try again', onClick: \(\) => location\.reload\(\) \}\);\s*return;/);
    // The guard's established wording for the same state.
    assert.match(read('artisan-app/js/utils/artisanAuthGuard.js'), /Can't reach the server[\s\S]{0,120}You're still signed in/);
});

console.log('\n── Role isolation holds: the server still refuses a customer ──\n');

await t('the real callable refuses a customer uid with details.reason "customer_account" — the reason that signs them out', async () => {
    fake.db._reset();
    fake.db._set('customers/c1', { userType: 'customer', email: 'ama@example.com' });
    const r = await callEnsure({ uid: 'c1', token: { email: 'ama@example.com', email_verified: true } });
    assert.deepStrictEqual([r.ok, r.code, r.details], [false, 'permission-denied', { reason: 'customer_account' }]);
    assert.ok(!fake.db._get('artisans/c1'), 'no artisan profile was created for a customer');
    const step = entry.routeEnsured({ ok: false, reason: r.details.reason, message: r.message });
    assert.deepStrictEqual([step.signOut, step.go], [true, '../customer-app/login.html']);
    assert.match(handler, /if \(step\.go\) setTimeout\(\(\) => location\.replace\(step\.go\), 1600\);/);
});

await t('an administrator is refused too (admin_account, a listed refusal)', async () => {
    fake.db._reset();
    fake.db._set('admins/ad1', { userType: 'admin', email: 'ops@example.com' });
    const r = await callEnsure({ uid: 'ad1', token: { email: 'ops@example.com' } });
    assert.deepStrictEqual(r.details, { reason: 'admin_account' });
    assert.ok(refusals.includes('admin_account'));
    assert.strictEqual(entry.routeEnsured({ ok: false, reason: 'admin_account', message: r.message }).signOut, true);
});

await t('a real artisan is answered "existing" (the route that works with Firestore down)', async () => {
    fake.db._reset();
    fake.db._set('artisans/a1', { userType: 'artisan', verificationStatus: 'approved', email: 'kofi@example.com' });
    const r = await callEnsure({ uid: 'a1', token: { email: 'kofi@example.com' } });
    assert.deepStrictEqual([r.ok, r.value.result, r.value.verificationStatus], [true, 'existing', 'approved']);
});

await t('a request that never reached the handler carries no reason — the client treats it as unreachable', async () => {
    const r = await (async () => { try { await fns.artisanAccount({ auth: null, data: { action: 'ensure' } }); } catch (e) { return e; } })();
    assert.strictEqual(r.code, 'unauthenticated');
    assert.ok(r.details == null || r.details.reason == null, 'no account reason');
    assert.deepStrictEqual(entry.routeEnsured({ ok: false, reason: null }), { offline: true });
});

console.log(`\nlogin-outage: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);

})();
