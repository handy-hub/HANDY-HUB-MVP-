'use strict';

/**
 * tests/auth-signup.test.cjs — customer registration and Google sign-in.
 * (Beta report 2026-10-23: "neither Google sign-in nor creating an account works".)
 *
 * Run: node tests/auth-signup.test.cjs
 *
 *   GOOGLE (native app)  inside the Capacitor WebView the web flow cannot work:
 *            signInWithPopup has no window to open and the signInWithRedirect
 *            fallback is opened by Capacitor in the EXTERNAL browser, so the
 *            result never returns. In the native shell Google now goes through
 *            the native FxGoogleSignIn plugin and signInWithCredential, and
 *            never falls back to popup/redirect.
 *   ERRORS   the signup page showed error.message first — every FirebaseError
 *            has one — so customers saw "Firebase: Error (auth/…)". Copy is now
 *            chosen by code and names the code + support address otherwise.
 *   LIFECYCLE  account + profile: a failed profile write rolls the new account
 *            back (so a retry works); a returning user is never duplicated; an
 *            artisan UID never gets a customer profile; a later sign-in
 *            repairs an account whose profile is missing.
 *
 * The REAL modules run with the Firebase SDK and repositories stubbed.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

/** Load an ES module with its imports replaced by `deps`. */
function loadEsm(rel, deps, exportNames) {
    const src = read(rel)
        .replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*\n/gm, '')
        .replace(/^export\s+(async\s+)?function\s+/gm, '$1function ')
        .replace(/^export\s+const\s+/gm, 'const ');
    const names = Object.keys(deps);
    // eslint-disable-next-line no-new-func
    return new Function(...names, `${src}\nreturn { ${exportNames.join(', ')} };`)(...names.map((n) => deps[n]));
}

// ── firebaseAuthService with a stubbed SDK ───────────────────────────────────
function authServiceWith({ native = true, plugin = null } = {}) {
    const calls = [];
    const sdk = {
        createUserWithEmailAndPassword: async () => ({}), deleteUser: async () => {}, EmailAuthProvider: {},
        FacebookAuthProvider: class {}, getAdditionalUserInfo: () => ({ providerId: 'google.com', isNewUser: true }),
        getRedirectResult: async () => null,
        GoogleAuthProvider: Object.assign(class { addScope() {} }, { credential: (idToken) => ({ providerId: 'google.com', idToken }) }),
        onAuthStateChanged: () => {}, OAuthProvider: class { addScope() {} }, reauthenticateWithCredential: async () => {},
        reauthenticateWithPopup: async () => {}, reload: async () => {}, sendEmailVerification: async () => {},
        signInWithCredential: async (auth, cred) => { calls.push(['signInWithCredential', cred]); return { user: { uid: 'g1', email: 'a@gmail.com' } }; },
        signInWithEmailAndPassword: async () => ({}),
        signInWithPopup: async () => { calls.push(['signInWithPopup']); return { user: { uid: 'web' } }; },
        signInWithRedirect: async () => { calls.push(['signInWithRedirect']); },
        signOut: async () => {}, updatePassword: async () => {},
        firebaseAuth: { currentUser: null },
        isNativeShell: () => native,
    };
    global.window = { Capacitor: plugin ? { Plugins: { FxGoogleSignIn: plugin } } : { Plugins: {} } };
    const mod = loadEsm('shared/js/backend/providers/firebase/firebaseAuthService.js', sdk, ['createFirebaseAuthService']);
    return { svc: mod.createFirebaseAuthService(sdk.firebaseAuth), calls };
}

// ── customerAuthService with fake repositories ───────────────────────────────
function lifecycle({ profileWriteFails = false, artisanUids = [], existingProfiles = {} } = {}) {
    const profiles = { ...existingProfiles };
    const authUsers = new Set();
    let current = null;
    const authRepository = {
        async signUpWithEmail(email) {
            if ([...authUsers].some((u) => u.email === email)) throw Object.assign(new Error('Firebase: Error (auth/email-already-in-use).'), { code: 'auth/email-already-in-use' });
            const user = { uid: `u_${authUsers.size + 1}`, email, displayName: '' };
            authUsers.add(user); current = user; return { user };
        },
        async signInWithEmail(email) { const u = [...authUsers].find((x) => x.email === email); current = u; return { user: u }; },
        async signInWithSocial() { const u = { uid: 'g_1', email: 'g@gmail.com', displayName: 'Ama G' }; current = u; return { user: u }; },
        async getRedirectResult() { return null; },
        extractSignInMetadata: () => ({ isNewUser: !profiles.g_1, providerName: 'Google' }),
        getCurrentUser: () => current,
        async deleteCurrentUser() { authUsers.delete(current); current = null; },
        async signOut() { current = null; },
    };
    let writes = 0;
    const customerRepository = {
        async getById(uid) { return profiles[uid] ? { exists: true, data: profiles[uid] } : { exists: false, data: null }; },
        async upsert(uid, data, opts) {
            writes++;
            if (profileWriteFails) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
            profiles[uid] = opts && opts.merge ? { ...(profiles[uid] || {}), ...data } : data;
        },
        async findByPhone() { return null; },
    };
    const artisanRepository = { async getById(uid) { return artisanUids.includes(uid) ? { exists: true, data: { userType: 'artisan' } } : { exists: false }; } };
    const { createCustomerAuthService } = loadEsm('shared/js/domain/services/customerAuthService.js', {}, ['createCustomerAuthService']);
    return { svc: createCustomerAuthService({ authRepository, customerRepository, artisanRepository }), profiles, authUsers, writes: () => writes, current: () => current };
}

const copy = loadEsm('shared/js/utils/authErrorCopy.js', { SUPPORT_CONTACTS: { email: 'info.fidusx101@gmail.com' } },
    ['signupErrorCopy', 'socialAuthErrorCopy']);

(async () => {
console.log('\n── Google inside the native app: native picker, never popup/redirect ──\n');

await t('native shell + plugin → the Google ID token signs in with signInWithCredential', async () => {
    const { svc, calls } = authServiceWith({ plugin: { signIn: async () => ({ idToken: 'ID.TOKEN.1', email: 'a@gmail.com' }) } });
    const r = await svc.signInWithSocial('Google', { mode: 'popup' });
    assert.strictEqual(r.user.uid, 'g1');
    assert.deepStrictEqual(calls, [['signInWithCredential', { providerId: 'google.com', idToken: 'ID.TOKEN.1' }]]);
});

await t('it never falls back to the popup or redirect inside the WebView (they strand the user in Chrome)', async () => {
    for (const mode of ['popup', 'redirect']) {
        const { svc, calls } = authServiceWith({ plugin: { signIn: async () => { throw Object.assign(new Error('x'), { code: 'failed' }); } } });
        await assert.rejects(() => svc.signInWithSocial('Google', { mode }));
        assert.ok(!calls.some(([n]) => n === 'signInWithPopup' || n === 'signInWithRedirect'), mode);
    }
});

for (const [native, code] of [['cancelled', 'auth/popup-closed-by-user'], ['no_account', 'auth/no-google-account'],
    ['not_configured', 'auth/native-google-not-configured'], ['something_else', 'auth/native-google-failed']]) {
    await t(`native "${native}" → ${code}`, async () => {
        const { svc } = authServiceWith({ plugin: { signIn: async () => { throw Object.assign(new Error('native says no'), { code: native }); } } });
        await assert.rejects(() => svc.signInWithSocial('Google'), (e) => e.code === code);
    });
}

await t('an installed app without the native plugin explains it, instead of opening Chrome', async () => {
    const { svc, calls } = authServiceWith({ plugin: null });
    await assert.rejects(() => svc.signInWithSocial('Google'), (e) => e.code === 'auth/native-google-unavailable');
    assert.strictEqual(calls.length, 0);
});

await t('an empty native answer is a failure, not a sign-in', async () => {
    const { svc } = authServiceWith({ plugin: { signIn: async () => ({}) } });
    await assert.rejects(() => svc.signInWithSocial('Google'), (e) => e.code === 'auth/native-google-failed');
});

await t('on the web (not native) Google still uses the popup, exactly as before', async () => {
    const { svc, calls } = authServiceWith({ native: false });
    await svc.signInWithSocial('Google', { mode: 'popup' });
    assert.deepStrictEqual(calls.map(([n]) => n), ['signInWithPopup']);
});

console.log('\n── Registration lifecycle: account, profile, retry ──\n');

await t('email sign-up creates the account AND the customer profile', async () => {
    const L = lifecycle();
    const r = await L.svc.signUpWithEmail({ fullName: 'Ama', email: 'Ama@Example.com', phone: '0241234567', location: 'Accra', password: 'Passw0rd!' });
    const p = L.profiles[r.user.uid];
    assert.deepStrictEqual([p.userType, p.status, p.email, p.name, p.bookings, p.spent], ['customer', 'active', 'ama@example.com', 'Ama', 0, 0]);
    assert.ok(!('walletBalance' in p), 'no balance on a client-written profile (rules require zero/absent)');
});

await t('if the profile write fails, the new account is rolled back — so retrying works', async () => {
    const L = lifecycle({ profileWriteFails: true });
    await assert.rejects(() => L.svc.signUpWithEmail({ fullName: 'Ama', email: 'a@x.com', password: 'Passw0rd!' }), (e) => e.code === 'permission-denied');
    assert.strictEqual(L.authUsers.size, 0, 'no orphan Auth account left behind');
    const ok = lifecycle();
    await ok.svc.signUpWithEmail({ fullName: 'Ama', email: 'a@x.com', password: 'Passw0rd!' });
});

await t('an account whose profile is missing is repaired at sign-in, not duplicated', async () => {
    const L = lifecycle();
    await L.svc.signUpWithEmail({ fullName: 'Ama', email: 'a@x.com', password: 'Passw0rd!' });
    const uid = [...L.authUsers][0].uid;
    delete L.profiles[uid];                                      // e.g. the 2026-08-17 orphan
    await L.svc.signInWithIdentifier({ identifier: 'a@x.com', password: 'Passw0rd!' });
    assert.strictEqual(L.profiles[uid].userType, 'customer');
    assert.strictEqual(Object.keys(L.profiles).length, 1);
});

await t('Google: a new user gets a profile; a returning user keeps theirs (merged, never overwritten)', async () => {
    const fresh = lifecycle();
    const r = await fresh.svc.startSocialSignup('Google', {});
    assert.deepStrictEqual([r.profile.userType, fresh.profiles.g_1.name], ['customer', 'Ama G']);
    const back = lifecycle({ existingProfiles: { g_1: { name: 'Ama Owusu', phone: '0201112222', bookings: 3, spent: 0, status: 'active', userType: 'customer', email: 'g@gmail.com', createdAt: '2026-08-01T00:00:00.000Z' } } });
    await back.svc.startSocialLogin('Google');
    assert.deepStrictEqual([back.profiles.g_1.name, back.profiles.g_1.phone, back.profiles.g_1.bookings, back.profiles.g_1.createdAt],
        ['Ama Owusu', '0201112222', 3, '2026-08-01T00:00:00.000Z']);
});

await t('an artisan account is never given a customer profile, and is signed out', async () => {
    const L = lifecycle({ artisanUids: ['g_1'] });
    await assert.rejects(() => L.svc.startSocialLogin('Google'), (e) => e.code === 'auth/wrong-app-role');
    assert.strictEqual(L.profiles.g_1, undefined);
    assert.strictEqual(L.current(), null);
});

console.log('\n── What the customer is told ──\n');

await t('the signup page shows copy chosen by code — never the raw SDK message', () => {
    const src = read('shared/js/ui/customer/signupPageController.js');
    assert.ok(!/error\?\.message\s*\|\|\s*signupErrorMessage/.test(src), 'raw message no longer wins');
    assert.match(src, /showToast\(signupErrorMessage\(error\), "error"\)/);
    assert.match(src, /signupErrorCopy/);
    assert.match(read('customer-app/js/pages/loginPage.js'), /socialAuthErrorCopy/);
});

await t('already-registered, offline and unknown errors are actionable', () => {
    assert.match(copy.signupErrorCopy({ code: 'auth/email-already-in-use', message: 'Firebase: Error (auth/email-already-in-use).' }), /Log in instead/);
    assert.match(copy.signupErrorCopy({ code: 'auth/network-request-failed' }), /No connection/);
    // A weak connection during the profile write (seen in the E2E run): the way forward is named.
    assert.match(copy.signupErrorCopy({ code: 'unavailable' }), /just log in/);
    const unknown = copy.signupErrorCopy({ code: 'auth/internal-error' });
    assert.match(unknown, /auth\/internal-error/);
    assert.match(unknown, /info\.fidusx101@gmail\.com/);
    assert.ok(!/Firebase: Error/.test(copy.signupErrorCopy({ code: 'auth/whatever', message: 'Firebase: Error (auth/whatever).' })));
});

await t('Google: cancelled, no account, not configured, old app and existing password account each say what to do', () => {
    assert.match(copy.socialAuthErrorCopy({ code: 'auth/popup-closed-by-user' }, 'Google'), /cancelled/);
    assert.match(copy.socialAuthErrorCopy({ code: 'auth/no-google-account' }, 'Google'), /Add one in Settings/);
    assert.match(copy.socialAuthErrorCopy({ code: 'auth/native-google-not-configured' }, 'Google'), /use email/);
    assert.match(copy.socialAuthErrorCopy({ code: 'auth/native-google-unavailable' }, 'Google'), /latest version/);
    assert.match(copy.socialAuthErrorCopy({ code: 'auth/account-exists-with-different-credential' }, 'Google'), /email and password/);
});

console.log('\n── Support address and the native build ──\n');

await t('support is info.fidusx101@gmail.com, from the one config, on the help and privacy pages', () => {
    assert.match(read('shared/js/config/supportConfig.js'), /email:\s*'info\.fidusx101@gmail\.com'/);
    const help = read('customer-app/settings-help.html');
    assert.match(help, /SUPPORT_CONTACTS\.email/);
    assert.ok(!/handyhub\.(com|app)/.test(help));
    assert.ok(!/handyhub\.(com|app)/.test(read('customer-app/settings-privacy-policy.html')));
});

await t('the Android app registers the native Google plugin with Credential Manager, using the web client from google-services', () => {
    const main = read('android/app/src/main/java/com/handyhub/customer/MainActivity.java');
    assert.match(main, /registerPlugin\(GoogleSignInPlugin\.class\);\s*\n\s*super\.onCreate/);
    const plugin = read('android/app/src/main/java/com/handyhub/customer/GoogleSignInPlugin.java');
    assert.match(plugin, /@CapacitorPlugin\(name = "FxGoogleSignIn"\)/);
    assert.match(plugin, /R\.string\.default_web_client_id/);
    assert.ok(!/apps\.googleusercontent\.com/.test(plugin), 'no client id hardcoded');
    const gradle = read('android/app/build.gradle');
    for (const dep of ['androidx.credentials:credentials:', 'androidx.credentials:credentials-play-services-auth:', 'com.google.android.libraries.identity.googleid:googleid:']) {
        assert.ok(gradle.includes(dep), dep);
    }
});

console.log(`\nauth-signup: ${passed} passed, ${failed} failed`);
if (failed) { for (const [n, e] of failures) console.error(`\n✗ ${n}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
